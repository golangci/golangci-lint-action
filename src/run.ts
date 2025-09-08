import * as core from "@actions/core"
import * as github from "@actions/github"
import { exec, ExecOptionsWithStringEncoding } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { promisify } from "util"

import { restoreCache, saveCache } from "./cache"
import { install } from "./install"
import { fetchPatch, isOnlyNewIssues } from "./patch"

const execShellCommand = promisify(exec)

type Env = {
  binPath: string
  patchPath: string
}

async function prepareEnv(): Promise<Env> {
  const startedAt = Date.now()

  // Prepare cache, lint and go in parallel.
  await restoreCache()

  const binPath = await install()
  const patchPath = await fetchPatch()

  core.info(`Prepared env in ${Date.now() - startedAt}ms`)

  return { binPath, patchPath }
}

type ExecRes = {
  stdout: string
  stderr: string
}

const printOutput = (res: ExecRes): void => {
  if (res.stdout) {
    core.info(res.stdout)
  }
  if (res.stderr) {
    core.info(res.stderr)
  }
}

async function runLint(binPath: string, patchPath: string): Promise<void> {
  const debug = core.getInput(`debug`)
  if (debug.split(`,`).includes(`cache`)) {
    const res = await execShellCommand(`${binPath} cache status`)
    printOutput(res)
  }

  const userArgs = core.getInput(`args`)
  const addedArgs: string[] = []

  const userArgsList = userArgs
    .trim()
    .split(/\s+/)
    .filter((arg) => arg.startsWith(`-`))
    .map((arg) => arg.replace(/^-+/, ``))
    .map((arg) => arg.split(/=(.*)/, 2))
    .map<[string, string]>(([key, value]) => [key.toLowerCase(), value ?? ""])

  const userArgsMap = new Map<string, string>(userArgsList)
  const userArgNames = new Set<string>(userArgsList.map(([key]) => key))

  const problemMatchers = core.getBooleanInput(`problem-matchers`)

  if (problemMatchers) {
    const matchersPath = path.join(__dirname, "../..", "problem-matchers.json")
    if (fs.existsSync(matchersPath)) {
      // Adds problem matchers.
      // https://github.com/actions/setup-go/blob/cdcb36043654635271a94b9a6d1392de5bb323a7/src/main.ts#L81-L83
      core.info(`##[add-matcher]${matchersPath}`)
    }
  }

  if (isOnlyNewIssues()) {
    if (
      userArgNames.has(`new`) ||
      userArgNames.has(`new-from-rev`) ||
      userArgNames.has(`new-from-patch`) ||
      userArgNames.has(`new-from-merge-base`)
    ) {
      throw new Error(`please, don't specify manually --new* args when requesting only new issues`)
    }

    const ctx = github.context

    core.info(`only new issues on ${ctx.eventName}: ${patchPath}`)

    switch (ctx.eventName) {
      case `pull_request`:
      case `pull_request_target`:
      case `push`:
        if (patchPath) {
          addedArgs.push(`--new-from-patch=${patchPath}`)

          // Override config values.
          addedArgs.push(`--new=false`)
          addedArgs.push(`--new-from-rev=`)
          addedArgs.push(`--new-from-merge-base=`)
        }
        break
      case `merge_group`:
        addedArgs.push(`--new-from-rev=${ctx.payload.merge_group.base_sha}`)

        // Override config values.
        addedArgs.push(`--new=false`)
        addedArgs.push(`--new-from-patch=`)
        addedArgs.push(`--new-from-merge-base=`)
        break
      default:
        break
    }
  }

  const cmdArgs: ExecOptionsWithStringEncoding = {}

  const workingDirectory = core.getInput(`working-directory`)
  if (workingDirectory) {
    if (!fs.existsSync(workingDirectory) || !fs.lstatSync(workingDirectory).isDirectory()) {
      throw new Error(`working-directory (${workingDirectory}) was not a path`)
    }

    if (!userArgNames.has(`path-prefix`) && !userArgNames.has(`path-mode`)) {
      addedArgs.push(`--path-mode=abs`)
    }

    cmdArgs.cwd = path.resolve(workingDirectory)
  }

  await runVerify(binPath, userArgsMap, cmdArgs)

  const cmd = `${binPath} run ${addedArgs.join(` `)} ${userArgs}`.trimEnd()

  core.info(`Running [${cmd}] in [${cmdArgs.cwd || process.cwd()}] ...`)

  const startedAt = Date.now()
  try {
    const res = await execShellCommand(cmd, cmdArgs)
    printOutput(res)
    core.info(`golangci-lint found no issues`)
  } catch (exc) {
    // This logging passes issues to GitHub annotations but comments can be more convenient for some users.
    printOutput(exc)

    if (exc.code === 1) {
      core.setFailed(`issues found`)
    } else {
      core.setFailed(`golangci-lint exit with code ${exc.code}`)
    }
  }

  core.info(`Ran golangci-lint in ${Date.now() - startedAt}ms`)
}

async function runVerify(binPath: string, userArgsMap: Map<string, string>, cmdArgs: ExecOptionsWithStringEncoding): Promise<void> {
  const verify = core.getBooleanInput(`verify`, { required: true })
  if (!verify) {
    return
  }

  const cfgPath = await getConfigPath(binPath, userArgsMap, cmdArgs)
  if (!cfgPath) {
    return
  }

  let cmdVerify = `${binPath} config verify`
  if (userArgsMap.get("config")) {
    cmdVerify += ` --config=${userArgsMap.get("config")}`
  }

  core.info(`Running [${cmdVerify}] in [${cmdArgs.cwd || process.cwd()}] ...`)

  const res = await execShellCommand(cmdVerify, cmdArgs)
  printOutput(res)
}

async function getConfigPath(binPath: string, userArgsMap: Map<string, string>, cmdArgs: ExecOptionsWithStringEncoding): Promise<string> {
  let cmdConfigPath = `${binPath} config path`
  if (userArgsMap.get("config")) {
    cmdConfigPath += ` --config=${userArgsMap.get("config")}`
  }

  core.info(`Running [${cmdConfigPath}] in [${cmdArgs.cwd || process.cwd()}] ...`)

  try {
    const resPath = await execShellCommand(cmdConfigPath, cmdArgs)
    return resPath.stderr.trim()
  } catch {
    return ``
  }
}

export async function run(): Promise<void> {
  try {
    const { binPath, patchPath } = await core.group(`prepare environment`, prepareEnv)
    core.addPath(path.dirname(binPath))
    await core.group(`run golangci-lint`, () => runLint(binPath, patchPath))
  } catch (error) {
    core.error(`Failed to run: ${error}, ${error.stack}`)
    core.setFailed(error.message)
  }
}

export async function postRun(): Promise<void> {
  try {
    await saveCache()
  } catch (error) {
    core.error(`Failed to post-run: ${error}, ${error.stack}`)
    core.setFailed(error.message)
  }
}

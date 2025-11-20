import * as core from "@actions/core"
import * as github from "@actions/github"
import { exec, ExecOptionsWithStringEncoding } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { promisify } from "util"

import { restoreCache, saveCache } from "./cache"
import { install } from "./install"
import { fetchPatch, isOnlyNewIssues } from "./patch"
import * as plugins from "./plugins"

const execCommand = promisify(exec)

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

async function runLint(binPath: string): Promise<void> {
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
    const patchPath = await fetchPatch()

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

  return execCommand(cmd, cmdArgs)
    .then(printOutput)
    .then(() => core.info(`golangci-lint found no issues`))
    .catch((exc) => {
      // This logging passes issues to GitHub annotations.
      printOutput(exc)

      if (exc.code === 1) {
        core.setFailed(`issues found`)
      } else {
        core.setFailed(`golangci-lint exit with code ${exc.code}`)
      }
    })
    .finally(() => core.info(`Ran golangci-lint in ${Date.now() - startedAt}ms`))
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

  await execCommand(cmdVerify, cmdArgs).then(printOutput)
}

async function getConfigPath(binPath: string, userArgsMap: Map<string, string>, cmdArgs: ExecOptionsWithStringEncoding): Promise<string> {
  let cmdConfigPath = `${binPath} config path`
  if (userArgsMap.get("config")) {
    cmdConfigPath += ` --config=${userArgsMap.get("config")}`
  }

  core.info(`Running [${cmdConfigPath}] in [${cmdArgs.cwd || process.cwd()}] ...`)

  try {
    const resPath = await execCommand(cmdConfigPath, cmdArgs)
    return resPath.stderr.trim()
  } catch {
    return ``
  }
}

async function debugAction(binPath: string) {
  const flags = core.getInput(`debug`).split(`,`)

  if (flags.includes(`clean`)) {
    const cmd = `${binPath} cache clean`

    core.info(`Running [${cmd}] ...`)

    await execCommand(cmd).then(printOutput)
  }

  if (flags.includes(`cache`)) {
    const cmd = `${binPath} cache status`

    core.info(`Running [${cmd}] ...`)

    await execCommand(cmd).then(printOutput)
  }
}

export async function run(): Promise<void> {
  try {
    await core.group(`Restore cache`, restoreCache)

    const binPath = await core.group(`Install`, () => install().then(plugins.install))

    core.addPath(path.dirname(binPath))

    if (core.getInput(`debug`)) {
      await core.group(`Debug`, () => debugAction(binPath))
    }

    const installOnly = core.getBooleanInput(`install-only`, { required: true })
    if (installOnly) {
      return
    }

    await core.group(`run golangci-lint`, () => runLint(binPath))
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

import * as core from "@actions/core"
import * as github from "@actions/github"
import { exec, ExecOptions } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { dir } from "tmp"
import { promisify } from "util"

import { restoreCache, saveCache } from "./cache"
import { installLint } from "./install"
import { findLintVersion } from "./version"

const execShellCommand = promisify(exec)
const writeFile = promisify(fs.writeFile)
const createTempDir = promisify(dir)

async function prepareLint(): Promise<string> {
  const versionConfig = await findLintVersion()
  return await installLint(versionConfig)
}

async function fetchPatch(): Promise<string> {
  const onlyNewIssues = core.getInput(`only-new-issues`, { required: true }).trim()
  if (onlyNewIssues !== `false` && onlyNewIssues !== `true`) {
    throw new Error(`invalid value of "only-new-issues": "${onlyNewIssues}", expected "true" or "false"`)
  }
  if (onlyNewIssues === `false`) {
    return ``
  }

  const ctx = github.context
  if (ctx.eventName !== `pull_request`) {
    core.info(`Not fetching patch for showing only new issues because it's not a pull request context: event name is ${ctx.eventName}`)
    return ``
  }
  const pull = ctx.payload.pull_request
  if (!pull) {
    core.warning(`No pull request in context`)
    return ``
  }
  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))
  let patch: string
  try {
    const patchResp = await octokit.rest.pulls.get({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      [`pull_number`]: pull.number,
      mediaType: {
        format: `diff`,
      },
    })

    if (patchResp.status !== 200) {
      core.warning(`failed to fetch pull request patch: response status is ${patchResp.status}`)
      return `` // don't fail the action, but analyze without patch
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patch = patchResp.data as any
  } catch (err) {
    console.warn(`failed to fetch pull request patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }

  try {
    const tempDir = await createTempDir()
    const patchPath = path.join(tempDir, "pull.patch")
    core.info(`Writing patch to ${patchPath}`)
    await writeFile(patchPath, patch)
    return patchPath
  } catch (err) {
    console.warn(`failed to save pull request patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }
}

type Env = {
  lintPath: string
  patchPath: string
}

async function prepareEnv(): Promise<Env> {
  const startedAt = Date.now()

  // Prepare cache, lint and go in parallel.
  const restoreCachePromise = restoreCache()
  const prepareLintPromise = prepareLint()
  const patchPromise = fetchPatch()

  const lintPath = await prepareLintPromise
  await restoreCachePromise
  const patchPath = await patchPromise

  core.info(`Prepared env in ${Date.now() - startedAt}ms`)
  return { lintPath, patchPath }
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

async function runLint(lintPath: string, patchPath: string): Promise<void> {
  const debug = core.getInput(`debug`)
  if (debug.split(`,`).includes(`cache`)) {
    const res = await execShellCommand(`${lintPath} cache status`)
    printOutput(res)
  }

  const userArgs = core.getInput(`args`)
  const allowExtraOutFormatArgs = core.getInput(`allow-extra-out-format-args`)
  const addedArgs: string[] = []

  const userArgNames = new Set<string>(
    userArgs
      .trim()
      .split(/\s+/)
      .map((arg) => arg.split(`=`)[0])
      .filter((arg) => arg.startsWith(`-`))
      .map((arg) => arg.replace(/^-+/, ``))
  )
  if (userArgNames.has(`out-format`) && !allowExtraOutFormatArgs) {
    throw new Error(`please, don't change out-format for golangci-lint: it can be broken in a
      future version (set 'allow-extra-out-format-args' input to true to override)`)
  }
  addedArgs.push(`--out-format=github-actions`)

  if (patchPath) {
    if (userArgNames.has(`new`) || userArgNames.has(`new-from-rev`) || userArgNames.has(`new-from-patch`)) {
      throw new Error(`please, don't specify manually --new* args when requesting only new issues`)
    }
    addedArgs.push(`--new-from-patch=${patchPath}`)

    // Override config values.
    addedArgs.push(`--new=false`)
    addedArgs.push(`--new-from-rev=`)
  }

  const workingDirectory = core.getInput(`working-directory`)
  const cmdArgs: ExecOptions = {}
  if (workingDirectory) {
    if (patchPath) {
      // TODO: make them compatible
      throw new Error(`options working-directory and only-new-issues aren't compatible`)
    }
    if (!fs.existsSync(workingDirectory) || !fs.lstatSync(workingDirectory).isDirectory()) {
      throw new Error(`working-directory (${workingDirectory}) was not a path`)
    }
    if (!userArgNames.has(`path-prefix`)) {
      addedArgs.push(`--path-prefix=${workingDirectory}`)
    }
    cmdArgs.cwd = path.resolve(workingDirectory)
  }

  const cmd = `${lintPath} run ${addedArgs.join(` `)} ${userArgs}`.trimRight()
  core.info(`Running [${cmd}] in [${cmdArgs.cwd || ``}] ...`)
  const startedAt = Date.now()
  try {
    const res = await execShellCommand(cmd, cmdArgs)
    printOutput(res)
    core.info(`golangci-lint found no issues`)
  } catch (exc) {
    // This logging passes issues to GitHub annotations but comments can be more convenient for some users.
    // TODO: support reviewdog or leaving comments by GitHub API.
    printOutput(exc)

    if (exc.code === 1) {
      core.setFailed(`issues found`)
    } else {
      core.setFailed(`golangci-lint exit with code ${exc.code}`)
    }
  }

  core.info(`Ran golangci-lint in ${Date.now() - startedAt}ms`)
}

export async function run(): Promise<void> {
  try {
    const { lintPath, patchPath } = await core.group(`prepare environment`, prepareEnv)
    core.addPath(path.dirname(lintPath))
    await core.group(`run golangci-lint`, () => runLint(lintPath, patchPath))
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

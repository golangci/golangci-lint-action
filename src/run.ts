import * as core from "@actions/core"
import * as github from "@actions/github"
import { Context } from "@actions/github/lib/context"
import { exec, ExecOptions } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { dir } from "tmp"
import { promisify } from "util"
import which from "which"

import { restoreCache, saveCache } from "./cache"
import { installLint, InstallMode } from "./install"
import { alterDiffPatch } from "./utils/diffUtils"
import { findLintVersion } from "./version"

const execShellCommand = promisify(exec)
const writeFile = promisify(fs.writeFile)
const createTempDir = promisify(dir)

function isOnlyNewIssues(): boolean {
  return core.getBooleanInput(`only-new-issues`, { required: true })
}

async function prepareLint(): Promise<string> {
  const mode = core.getInput("install-mode").toLowerCase()

  if (mode === InstallMode.None) {
    const bin = await which("golangci-lint", { nothrow: true })
    if (!bin) {
      throw new Error("golangci-lint binary not found in the PATH")
    }
    return bin
  }

  const versionConfig = await findLintVersion(<InstallMode>mode)

  return await installLint(versionConfig, <InstallMode>mode)
}

async function fetchPatch(): Promise<string> {
  if (!isOnlyNewIssues()) {
    return ``
  }

  const ctx = github.context

  switch (ctx.eventName) {
    case `pull_request`:
    case `pull_request_target`:
      return await fetchPullRequestPatch(ctx)
    case `push`:
      return await fetchPushPatch(ctx)
    case `merge_group`:
      return ``
    default:
      core.info(`Not fetching patch for showing only new issues because it's not a pull request context: event name is ${ctx.eventName}`)
      return ``
  }
}

async function fetchPullRequestPatch(ctx: Context): Promise<string> {
  const pr = ctx.payload.pull_request
  if (!pr) {
    core.warning(`No pull request in context`)
    return ``
  }

  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))

  let patch: string
  try {
    const patchResp = await octokit.rest.pulls.get({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      [`pull_number`]: pr.number,
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
    await writeFile(patchPath, alterDiffPatch(patch))
    return patchPath
  } catch (err) {
    console.warn(`failed to save pull request patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }
}

async function fetchPushPatch(ctx: Context): Promise<string> {
  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))

  let patch: string
  try {
    const patchResp = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      basehead: `${ctx.payload.before}...${ctx.payload.after}`,
      mediaType: {
        format: `diff`,
      },
    })

    if (patchResp.status !== 200) {
      core.warning(`failed to fetch push patch: response status is ${patchResp.status}`)
      return `` // don't fail the action, but analyze without patch
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patch = patchResp.data as any
  } catch (err) {
    console.warn(`failed to fetch push patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }

  try {
    const tempDir = await createTempDir()
    const patchPath = path.join(tempDir, "push.patch")
    core.info(`Writing patch to ${patchPath}`)
    await writeFile(patchPath, alterDiffPatch(patch))
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
  await restoreCache()

  const lintPath = await prepareLint()
  const patchPath = await fetchPatch()

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

  let userArgs = core.getInput(`args`)
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

  const formats = (userArgsMap.get("out-format") || "")
    .trim()
    .split(",")
    .filter((f) => f.length > 0)
    .filter((f) => !f.startsWith(`github-actions`)) // Removes `github-actions` format.
    .join(",")

  if (formats) {
    // Adds formats but without `github-actions` format.
    addedArgs.push(`--out-format=${formats}`)
  }

  // Removes `--out-format` from the user flags because it's already inside `addedArgs`.
  userArgs = userArgs.replace(/--out-format=\S*/gi, "").trim()

  if (isOnlyNewIssues()) {
    if (userArgNames.has(`new`) || userArgNames.has(`new-from-rev`) || userArgNames.has(`new-from-patch`)) {
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
        }
        break
      case `merge_group`:
        addedArgs.push(`--new-from-rev=${ctx.payload.merge_group.base_sha}`)

        // Override config values.
        addedArgs.push(`--new=false`)
        addedArgs.push(`--new-from-patch=`)
        break
      default:
        break
    }
  }

  const cmdArgs: ExecOptions = {}

  const workingDirectory = core.getInput(`working-directory`)
  if (workingDirectory) {
    if (!fs.existsSync(workingDirectory) || !fs.lstatSync(workingDirectory).isDirectory()) {
      throw new Error(`working-directory (${workingDirectory}) was not a path`)
    }
    if (!userArgNames.has(`path-prefix`)) {
      addedArgs.push(`--path-prefix=${workingDirectory}`)
    }
    cmdArgs.cwd = path.resolve(workingDirectory)
  }

  const cmd = `${lintPath} run ${addedArgs.join(` `)} ${userArgs}`.trimEnd()

  core.info(`Running [${cmd}] in [${cmdArgs.cwd || process.cwd()}] ...`)

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

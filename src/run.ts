import * as core from "@actions/core"
import { exec, ExecOptions } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { promisify } from "util"

import { restoreCache, saveCache } from "./cache"
import { installGo, installLint } from "./install"
import { findLintVersion } from "./version"

const execShellCommand = promisify(exec)

async function prepareLint(): Promise<string> {
  const versionConfig = await findLintVersion()
  return await installLint(versionConfig)
}

async function prepareEnv(): Promise<string> {
  const startedAt = Date.now()

  // Prepare cache, lint and go in parallel.
  const restoreCachePromise = restoreCache()
  const prepareLintPromise = prepareLint()
  const installGoPromise = installGo()

  const lintPath = await prepareLintPromise
  await installGoPromise
  await restoreCachePromise

  core.info(`Prepared env in ${Date.now() - startedAt}ms`)
  return lintPath
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

async function runLint(lintPath: string): Promise<void> {
  const debug = core.getInput(`debug`)
  if (debug.split(`,`).includes(`cache`)) {
    const res = await execShellCommand(`${lintPath} cache status`)
    printOutput(res)
  }

  const args = core.getInput(`args`)
  if (args.includes(`-out-format`)) {
    throw new Error(`please, don't change out-format for golangci-lint: it can be broken in a future`)
  }

  const workingDirectory = core.getInput(`working-directory`)
  const cmdArgs: ExecOptions = {}
  if (workingDirectory != ``) {
    if (!fs.existsSync(workingDirectory) || !fs.lstatSync(workingDirectory).isDirectory()) {
      throw new Error(`working-directory (${workingDirectory}) was not a path`)
    }

    cmdArgs.cwd = path.resolve(workingDirectory)
  }

  const cmd = `${lintPath} run --out-format=github-actions ${args}`.trimRight()
  core.info(`Running [${cmd}] in [${cmdArgs.cwd}] ...`)
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
    const lintPath = await core.group(`prepare environment`, prepareEnv)
    await core.group(`run golangci-lint`, () => runLint(lintPath))
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

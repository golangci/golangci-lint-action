import * as core from "@actions/core"
import * as github from "@actions/github"
import style from "ansi-styles"
import { exec, ExecOptions } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { dir } from "tmp"
import { inspect, promisify } from "util"
import { v4 as uuidv4 } from "uuid"

import { restoreCache, saveCache } from "./cache"
import { Env as EnvKey } from "./constants"
import { installGo, installLint } from "./install"
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
    const patchResp = await octokit.pulls.get({
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
  checkRunIdent: CheckRunIdent
}

type CheckRunIdent = {
  runId: number
  runName: string
  checkRunId: number
  checkSuiteId?: number
  checkRunSearchToken?: string
}

type CheckRun = {
  id: number
  status: string
  name: string
  output: {
    title: string | null
    summary: string | null
    text: string | null
    annotations_count: number | null
  }
}

async function fetchCheckSuiteId(runId: number): Promise<number> {
  let currentCheckSuiteId = -1
  if (runId > 0) {
    try {
      const { data: currentRun } = await github
        .getOctokit(core.getInput(`github-token`, { required: true }))
        .actions.getWorkflowRun({
          ...github.context.repo,
          run_id: runId,
        })
        .catch((e: string) => {
          throw `Unable to fetch Workflow Run: ${e}`
        })

      if (!currentRun) {
        throw `Unexpected error: No run returned`
      }

      if (currentRun.conclusion) {
        throw `Unexpected error: Expected Check Suite with no conclusion, got: ` + inspect(currentRun)
      }

      // The GitHub API it's self does present the `check_suite_id` property, but it is not documented or present returned object's `type`
      currentCheckSuiteId = parseInt(currentRun.check_suite_url.substr(1 + currentRun.check_suite_url.lastIndexOf(`/`))) ?? -1
      // The following SHOULD work, but alas
      // currentCheckSuiteId = currentRun.check_suite_id
      if (currentCheckSuiteId <= 0) {
        throw `Error extracting Check Suite ID from: ${currentRun.check_suite_url}`
      }
    } catch (e) {
      core.info(`::error::Error Fetching Current Run (${runId}): ${e}`)
    }
  }
  return currentCheckSuiteId
}

async function fetchCheckSuiteRuns(checkSuiteId: number, name?: string): Promise<CheckRun[]> {
  let checkSuiteRuns: CheckRun[] = []
  if (checkSuiteId > 0) {
    try {
      checkSuiteRuns = (
        await github
          .getOctokit(core.getInput(`github-token`, { required: true }))
          .checks.listForSuite({
            ...github.context.repo,
            check_suite_id: checkSuiteId,
          })
          .catch((e: string) => {
            throw `Unable to fetch Check Suite Runs List: ${e}`
          })
      ).data.check_runs.filter((run) => run.status === `in_progress`)

      if (checkSuiteRuns.length > 0 && name) {
        const _checkSuiteRuns = checkSuiteRuns.filter(
          (run) => run.name.indexOf(name) === 0 && (run.name.length === name.length || run.name[name.length] === ` `)
        )
        checkSuiteRuns = _checkSuiteRuns.length ? _checkSuiteRuns : checkSuiteRuns
      }

      if (checkSuiteRuns.length === 0) {
        throw `Check Suite returned 0 runs`
      }
    } catch (e) {
      core.info(`::error::Error Fetching Check Suite Runs (${checkSuiteId}): ${e}`)
    }
  }
  return checkSuiteRuns
}

async function prepareCheckRunIdent(runId?: number, runName?: string): Promise<CheckRunIdent> {
  const checkRunIdent: CheckRunIdent = {
    runId: runId ?? github.context.runId,
    runName: runName ?? github.context.job,
    checkRunId: -1,
  }

  if (process.env.GITHUB_ACTIONS === `true` && checkRunIdent.runId > 0) {
    core.info(`Resolving current GitHub Check Run ${checkRunIdent.runId}`)
    try {
      const checkSuiteId = await fetchCheckSuiteId(checkRunIdent.runId)
      if (checkSuiteId < 0) {
        throw `Unable to resolve Check Suite ID`
      }

      const checkSuiteRuns = await fetchCheckSuiteRuns(checkSuiteId, checkRunIdent.runName)
      if (checkSuiteRuns.length < 1) {
        throw `Unable to resolve Check Suite children`
      }

      checkRunIdent.checkSuiteId = checkSuiteId

      if (checkSuiteRuns.length === 1) {
        checkRunIdent.checkRunId = checkSuiteRuns[0].id
      } else {
        checkRunIdent.checkRunSearchToken = uuidv4()
        core.info(
          `::warning::[golangci-lint-action] Tagging Current GitHub CheckRun ${checkRunIdent.runId}<${checkRunIdent.checkRunSearchToken}>`
        )
      }
    } catch (e) {
      core.info(`::error::Error resolving Run (${checkRunIdent.runId}): ${e}`)
    }
  } else {
    core.info(`Not in GitHub Action Context, Skipping Check Run Resolution`)
  }

  return checkRunIdent
}

async function resolveCheckRunId(checkRunIdent: CheckRunIdent): Promise<number> {
  let checkRunId = checkRunIdent.checkRunId

  if (checkRunIdent.runId > 0) {
    if (checkRunId <= 0) {
      try {
        const checkSuiteId = checkRunIdent?.checkSuiteId ?? -1
        if (checkSuiteId <= 0) {
          throw `No Check Suite ID`
        }

        const checkRunSearchToken = checkRunIdent?.checkRunSearchToken ?? ``
        if (!checkRunSearchToken) {
          throw `No Check Run Search Token`
        }

        const checkSuiteRuns = (await fetchCheckSuiteRuns(checkSuiteId, checkRunIdent.runName)).filter(
          (run) => run.output.annotations_count
        )
        if (checkSuiteRuns.length < 1) {
          throw `Unable to resolve Check Suite children`
        }

        core.info(`resolveCheckRunId() Found ${checkSuiteRuns.length} Jobs:\n` + inspect(checkSuiteRuns))

        core.info(`Resolving current Check Run in Check Suite (${checkSuiteId})`)

        for (const run of checkSuiteRuns) {
          try {
            const { data: annotations } = await github
              .getOctokit(core.getInput(`github-token`, { required: true }))
              .checks.listAnnotations({
                ...github.context.repo,
                check_run_id: run.id,
              })

            core.info(`resolveCheckRunId() Found ${annotations.length} Annotations for Check Run '${run.id}':\n` + inspect(annotations))

            if (
              annotations.findIndex((annotation) => {
                core.info(`resolveCheckRunId() Looking for Search Token (${checkRunSearchToken}) in message: ${annotation.message}`)
                return annotation.message.indexOf(checkRunSearchToken) >= 0
              }) !== -1
            ) {
              core.info(`resolveCheckRunId() Found Search Token (${checkRunSearchToken}) in Check Run ${run.id}`)
              checkRunId = run.id
              break
            }
          } catch (e) {
            core.info(`resolveCheckRunId() Error Fetching Check Run (${run.id}): ${e}`)
          }
        }
      } catch (e) {
        core.info(`::error::Unable to resolve Check Run ID: ${e}`)
      }
    }
  } else {
    core.info(`Not in GitHub Action Context, Skipping Check Run Resolution`)
  }

  return checkRunId
}

async function prepareEnv(): Promise<Env> {
  const startedAt = Date.now()

  const checkRunPromise = (async () => {
    let checkRunIdent: CheckRunIdent | undefined
    try {
      checkRunIdent = JSON.parse(core.getState(EnvKey.CheckRunIdent))
    } catch (e) {
      checkRunIdent = undefined
    }
    if (!checkRunIdent) {
      core.saveState(EnvKey.CheckRunIdent, JSON.stringify((checkRunIdent = await prepareCheckRunIdent())))
    }

    return checkRunIdent
  })()

  const prepareLintPromise = (async () => {
    let lintPath = core.getState(EnvKey.LintPath)
    if (!lintPath) {
      core.saveState(EnvKey.LintPath, (lintPath = await prepareLint()))
    }
    return lintPath
  })()

  const patchPromise = (async () => {
    let patchPath = core.getState(EnvKey.PatchPath)
    if (!patchPath) {
      core.saveState(EnvKey.PatchPath, (patchPath = await fetchPatch()))
    }
    return patchPath
  })()

  // Prepare cache, lint and go in parallel.
  const restoreCachePromise = restoreCache()
  const installGoPromise = installGo()

  const lintPath = await prepareLintPromise
  const patchPath = await patchPromise
  const checkRunIdent = await checkRunPromise
  await installGoPromise
  await restoreCachePromise

  core.info(`Prepared env in ${Date.now() - startedAt}ms`)

  return { lintPath, patchPath, checkRunIdent }
}

type ExecRes = {
  stdout: string
  stderr: string
}

enum LintSeverity {
  notice,
  warning,
  failure,
}

type LintSeverityStrings = keyof typeof LintSeverity

type LintIssue = {
  Text: string
  FromLinter: string
  Severity: LintSeverityStrings
  SourceLines: string[]
  Pos: {
    Filename: string
    Line: number
    Column: number
  }
  LineRange?: {
    From: number
    To: number
  }
  Replacement: {
    NeedOnlyDelete: boolean
    NewLines: string[] | null
    Inline: {
      StartCol: number
      Length: number
      NewString: string
    } | null
  } | null
}

type UnfilteredLintIssue =
  | LintIssue
  | {
      Severity: string
    }

type LintOutput = {
  Issues: LintIssue[]
  Report: {
    Warnings?: {
      Tag?: string
      Text: string
    }[]
    Linters?: {
      Enabled: boolean
      Name: string
    }[]
    Error?: string
  }
}

type GithubAnnotation = {
  path: string
  start_line: number
  end_line: number
  start_column?: number
  end_column?: number
  annotation_level: LintSeverityStrings
  title: string
  message: string
  raw_details?: string
}

type SeverityMap = {
  [key: string]: LintSeverityStrings
}

const DefaultFailureSeverity = LintSeverity.notice

const parseOutput = (json: string): LintOutput => {
  const severityMap: SeverityMap = {
    info: `notice`,
    notice: `notice`,
    minor: `warning`,
    warning: `warning`,
    error: `failure`,
    major: `failure`,
    critical: `failure`,
    blocker: `failure`,
    failure: `failure`,
  }
  const lintOutput = JSON.parse(json)
  if (!lintOutput.Report) {
    throw `golangci-lint returned invalid json`
  }
  if (lintOutput.Issues.length) {
    lintOutput.Issues = lintOutput.Issues.filter((issue: UnfilteredLintIssue) => issue.Severity !== `ignore`).map(
      (issue: UnfilteredLintIssue): LintIssue => {
        issue.Severity = ((Severity: string): LintSeverityStrings => {
          return severityMap[`${Severity}`] ? severityMap[`${Severity}`] : `failure`
        })(issue.Severity.toLowerCase())
        return issue as LintIssue
      }
    )
  }
  return lintOutput as LintOutput
}

const logLintIssues = (issues: LintIssue[]): void => {
  issues.forEach((issue: LintIssue): void => {
    core.info(
      ((issue: LintIssue): string => {
        switch (issue.Severity) {
          case `warning`:
            return `${style.yellow.open}${style.bold.open}Lint Warning:${style.bold.close}${style.yellow.close}`
          case `notice`:
            return `${style.cyan.open}${style.bold.open}Lint Notice:${style.bold.close}${style.cyan.close}`
          default:
            return `${style.red.open}${style.bold.open}Lint Error:${style.bold.close}${style.red.close}`
        }
      })(issue) +
        ` ` +
        `${issue.Pos.Filename}:${issue.Pos.Line}` +
        ((issue: LintIssue): string => {
          if (issue.LineRange !== undefined) {
            return `-${issue.LineRange.To}`
          } else if (issue.Pos.Column) {
            return `:${issue.Pos.Column}`
          } else {
            return ``
          }
        })(issue) +
        ` - ${issue.Text} (${issue.FromLinter})`
    )
  })
}

const annotationFromIssue = (issue: LintIssue): GithubAnnotation => {
  const annotation: GithubAnnotation = {
    path: issue.Pos.Filename,
    start_line: issue.Pos.Line,
    end_line: issue.Pos.Line,
    title: issue.FromLinter,
    message: issue.Text,
    annotation_level: issue.Severity,
  }

  if (issue.LineRange !== undefined) {
    annotation.end_line = issue.LineRange.To
  } else if (issue.Pos.Column) {
    annotation.start_column = issue.Pos.Column
    annotation.end_column = issue.Pos.Column
  }

  if (issue.Replacement !== null) {
    let replacement = ``
    if (issue.Replacement.Inline) {
      replacement =
        issue.SourceLines[0].slice(0, issue.Replacement.Inline.StartCol) +
        issue.Replacement.Inline.NewString +
        issue.SourceLines[0].slice(issue.Replacement.Inline.StartCol + issue.Replacement.Inline.Length)
    } else if (issue.Replacement.NewLines) {
      replacement = issue.Replacement.NewLines.join("\n")
    }
    annotation.raw_details = "```suggestion\n" + replacement + "\n```"
  }

  return annotation
}

async function annotateLintIssues(issues: LintIssue[], checkRunId: number): Promise<boolean> {
  if (checkRunId >= 0 || !issues.length) {
    return false
  }
  const chunkSize = 50
  const issueCounts = {
    notice: 0,
    warning: 0,
    failure: 0,
  }

  try {
    const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))
    const title = `GolangCI-Lint`
    for (let i = 0; i < Math.ceil(issues.length / chunkSize); i++) {
      octokit.checks
        .update({
          ...github.context.repo,
          check_run_id: checkRunId,
          output: {
            title: title,
            annotations: issues.slice(i * chunkSize, i * chunkSize + chunkSize).map((issue: LintIssue) => {
              ++issueCounts[issue.Severity]
              return annotationFromIssue(issue)
            }),
            summary: `There are {issueCounts.failure} failures, {issueCounts.wairning} warnings, and {issueCounts.notice} notices.`,
          },
        })
        .catch((e) => {
          throw `Error patching Check Run Data (annotations): ${e}`
        })
    }
  } catch (e) {
    core.info(`::error::Error Annotating Lint Issues: ${e}`)
    return false
  }

  return true
}

const printOutput = (res: ExecRes): void => {
  if (res.stdout) {
    core.info(res.stdout)
  }
  if (res.stderr) {
    core.info(res.stderr)
  }
}

async function processLintOutput(res: ExecRes, checkRunId: number): Promise<LintIssue[]> {
  let lintIssues: LintIssue[] = []
  if (res.stdout) {
    try {
      // This object contains other information, such as errors and the active linters
      // TODO: Should we do something with that data?
      ;({ Issues: lintIssues } = parseOutput(res.stdout))

      if (lintIssues.length) {
        if (
          !(await (async (eventName: string): Promise<boolean> => {
            // We can only Annotate (or Comment) on Push or Pull Request
            switch (eventName) {
              case `pull_request`:
              // TODO: When we are ready to handle these as Comments, instead of Annotations, we would place that logic here
              /* falls through */
              case `push`:
                return await annotateLintIssues(lintIssues, checkRunId)
              default:
                // At this time, other events are not supported
                return false
            }
          })(github.context.eventName))
        ) {
          core.info(`::add-matcher::matchers-golangci-lint-action.json`)
        }

        // Log Issues at the end to allow failed GitHub Actions above to set the Problem Matcher
        logLintIssues(lintIssues)
      }
    } catch (e) {
      core.setFailed(`Error processing golangci-lint output: ${e}`)
    }
  }

  if (res.stderr) {
    core.info(res.stderr)
  }

  return lintIssues
}

async function runLint(lintPath: string, patchPath: string, checkRunId: number): Promise<void> {
  const debug = core.getInput(`debug`)
  if (debug.split(`,`).includes(`cache`)) {
    const res = await execShellCommand(`${lintPath} cache status`)
    printOutput(res)
  }

  const failureSeverity = ((userFailureSeverity: string): LintSeverity => {
    if (userFailureSeverity) {
      if (Object.values(LintSeverity).indexOf(userFailureSeverity) != -1) {
        return Object.values(LintSeverity).indexOf(userFailureSeverity)
      } else {
        core.info(
          `::warning::failure-severity must be one of (${Object.keys(LintSeverity).join(
            " | "
          )}). "${userFailureSeverity}" not supported, using default (${LintSeverity[DefaultFailureSeverity]})`
        )
      }
    }
    return DefaultFailureSeverity
  })(core.getInput(`failure-severity`).toLowerCase())

  const userArgs = core.getInput(`args`)
  const addedArgs: string[] = []

  const userArgNames = new Set<string>()
  userArgs
    .split(/\s/)
    .map((arg) => arg.split(`=`)[0])
    .filter((arg) => arg.startsWith(`-`))
    .forEach((arg) => {
      userArgNames.add(arg.replace(`-`, ``))
    })

  if (userArgNames.has(`out-format`)) {
    throw new Error(`please, don't change out-format for golangci-lint: it can be broken in a future`)
  }
  addedArgs.push(`--out-format=json`)

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
  let exit_code = 0
  try {
    const res = await execShellCommand(cmd, cmdArgs)
    processLintOutput(res, checkRunId)
  } catch (exc) {
    // This logging passes issues to GitHub annotations but comments can be more convenient for some users.
    // TODO: support reviewdog or leaving comments by GitHub API.
    const issuesPromise = processLintOutput(exc, checkRunId)
    if (exc.code !== 1 || (await issuesPromise).findIndex((issue: LintIssue) => LintSeverity[issue.Severity] >= failureSeverity) != -1) {
      exit_code = exc.code
    }
  } finally {
    if (exit_code === 0) {
      core.info(`golangci-lint found no blocking issues`)
    } else if (exit_code === 1) {
      core.setFailed(`issues found`)
    } else {
      core.setFailed(`golangci-lint exit with code ${exit_code}`)
    }
  }

  core.info(`Ran golangci-lint in ${Date.now() - startedAt}ms`)
}

export async function setup(): Promise<void> {
  try {
    await core.group(`pre-prepare environment`, prepareEnv)
  } catch (error) {
    core.error(`Failed to pre-prepare: ${error}, ${error.stack}`)
    core.setFailed(error.message)
  }
}

export async function run(): Promise<void> {
  try {
    const { lintPath, patchPath, checkRunIdent } = await core.group(`prepare environment`, prepareEnv)
    core.addPath(path.dirname(lintPath))
    let checkRunId: number
    try {
      checkRunId = await resolveCheckRunId(checkRunIdent)
    } catch (e) {
      core.info(`::error::Error Resolving Check Run ID: ${e}`)
      checkRunId = -1
    }
    await core.group(`run golangci-lint`, () => runLint(lintPath, patchPath, checkRunId))
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

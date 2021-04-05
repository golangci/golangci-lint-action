import * as core from "@actions/core"
import * as github from "@actions/github"
import style from "ansi-styles"
import { exec, ExecOptions } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { dir } from "tmp"
import { promisify } from "util"
import { v4 as uuidv4 } from "uuid"

import { restoreCache, saveCache } from "./cache"
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
  checkRunId: number
}

async function prepareEnv(): Promise<Env> {
  const startedAt = Date.now()

  // Resolve Check Run ID
  const resolveCheckRunIdPromise = resolveCheckRunId()

  // Prepare cache, lint and go in parallel.
  const restoreCachePromise = restoreCache()
  const prepareLintPromise = prepareLint()
  const installGoPromise = installGo()
  const patchPromise = fetchPatch()

  const lintPath = await prepareLintPromise
  await installGoPromise
  await restoreCachePromise
  const patchPath = await patchPromise
  const checkRunId = await resolveCheckRunIdPromise

  core.info(`Prepared env in ${Date.now() - startedAt}ms`)
  return { lintPath, patchPath, checkRunId }
}

type ExecRes = {
  stdout: string
  stderr: string
  code?: number
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

type CheckRun = {
  id: number
  node_id: string
  head_sha: string
  external_id: string
  url: string
  html_url: string
  details_url: string
  status: string
  conclusion: string | null
  started_at: string
  completed_at: string | null
  output: {
    title: string | null
    summary: string | null
    text: string | null
    annotations_count: number
    annotations_url: string
  }
  name: string
  check_suite: {
    id: number
  }
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
        const Severity = issue.Severity.toLowerCase()
        issue.Severity = severityMap[`${Severity}`] ? severityMap[`${Severity}`] : `failure`
        return issue as LintIssue
      }
    )
  }
  return lintOutput as LintOutput
}

const logLintIssues = (issues: LintIssue[]): void => {
  issues.forEach((issue: LintIssue): void => {
    let header = `${style.red.open}${style.bold.open}Lint Error:${style.bold.close}${style.red.close}`
    if (issue.Severity === `warning`) {
      header = `${style.yellow.open}${style.bold.open}Lint Warning:${style.bold.close}${style.yellow.close}`
    } else if (issue.Severity === `notice`) {
      header = `${style.cyan.open}${style.bold.open}Lint Notice:${style.bold.close}${style.cyan.close}`
    }

    let pos = `${issue.Pos.Filename}:${issue.Pos.Line}`
    if (issue.LineRange !== undefined) {
      pos += `-${issue.LineRange.To}`
    } else if (issue.Pos.Column) {
      pos += `:${issue.Pos.Column}`
    }

    core.info(`${header} ${pos} - ${issue.Text} (${issue.FromLinter})`)
  })
}

async function resolveCheckRunId(): Promise<number> {
  let checkRunId = -1

  if (process.env.GITHUB_ACTIONS === `true`) {
    try {
      const searchToken = uuidv4()
      core.info(`::warning::Resolving GitHub CheckRunID (${searchToken})`)

      const ctx = github.context
      const ref = ctx.payload.after ?? ctx.sha

      const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))
      const { data: checkRunsResponse } = await octokit.checks
        .listForRef({
          ...ctx.repo,
          ref,
          status: `in_progress`,
          filter: `latest`,
        })
        .catch((e: string) => {
          throw `Unable to fetch Check Run List: ${e}`
        })

      if (checkRunsResponse.check_runs.length > 0) {
        let checkRuns: CheckRun[] = checkRunsResponse.check_runs
        if (checkRuns.length > 1) {
          checkRuns = checkRuns.filter((run) => run.name.includes(ctx.job)) ?? checkRuns
        }
        if (checkRuns.length > 1) {
          checkRuns = checkRuns.filter((run) => run.output.annotations_count > 0) ?? checkRuns
        }
        if (checkRuns.length > 1) {
          for (const run of checkRuns) {
            try {
              if (
                (
                  await octokit.checks.listAnnotations({
                    ...ctx.repo,
                    check_run_id: run.id,
                  })
                ).data.findIndex((annotation: { message: string }) => annotation.message.includes(searchToken)) !== -1
              ) {
                checkRunId = run.id
                break
              }
            } catch (e) {
              core.info(`::debug::Error Fetching CheckRun ${run.id}: ${e}`)
            }
          }
        } else if (checkRuns[0]) {
          checkRunId = checkRuns[0].id
          core.info(`Current Check Run is: ${checkRunId}`)
        } else {
          throw `Unable to resolve GitHub Check Run`
        }
      } else {
        throw `Fetching octokit.checks.listForRef(${ref}) returned no results`
      }
    } catch (e) {
      core.info(`::error::Error resolving GitHub Check Run: ${e}`)
    }
  } else {
    core.info(`::debug::Not in GitHub Action Context, Skipping Check Run Resolution`)
  }

  return checkRunId
}

async function annotateLintIssues(issues: LintIssue[], checkRunId: number): Promise<void> {
  if (checkRunId === -1 || !issues.length) {
    return
  }

  const chunkSize = 50
  const issueCounts = {
    notice: 0,
    warning: 0,
    failure: 0,
  }

  const ctx = github.context
  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))

  const githubAnnotations: GithubAnnotation[] = issues.map(
    (issue: LintIssue): GithubAnnotation => {
      // If/when we transition to comments, we would build the request structure here
      const annotation: GithubAnnotation = {
        path: issue.Pos.Filename,
        start_line: issue.Pos.Line,
        end_line: issue.Pos.Line,
        title: issue.FromLinter,
        message: issue.Text,
        annotation_level: issue.Severity,
      }

      issueCounts[issue.Severity]++

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

      return annotation as GithubAnnotation
    }
  )
  const title = `GolangCI-Lint`
  const summary = `There are {issueCounts.failure} failures, {issueCounts.wairning} warnings, and {issueCounts.notice} notices.`
  Array.from({ length: Math.ceil(githubAnnotations.length / chunkSize) }, (v, i) =>
    githubAnnotations.slice(i * chunkSize, i * chunkSize + chunkSize)
  ).forEach((annotations: GithubAnnotation[]): void => {
    octokit.checks
      .update({
        ...ctx.repo,
        check_run_id: checkRunId,
        output: {
          title,
          summary,
          annotations,
        },
      })
      .catch((e) => {
        throw `Error patching Check Run Data (annotations): ${e}`
      })
  })
}

const hasFailingIssues = (issues: LintIssue[]): boolean => {
  // If the user input is not a valid Severity Level, this will be -1, and any issue will fail
  const userFailureSeverity = core.getInput(`failure-severity`).toLowerCase()
  let failureSeverity = DefaultFailureSeverity
  if (userFailureSeverity) {
    failureSeverity = Object.values(LintSeverity).indexOf(userFailureSeverity)
  }
  if (failureSeverity < 0) {
    core.info(
      `::warning::failure-severity must be one of (${Object.keys(LintSeverity).join(
        " | "
      )}). "${userFailureSeverity}" not supported, using default (${LintSeverity[DefaultFailureSeverity]})`
    )
    failureSeverity = DefaultFailureSeverity
  }
  if (issues.length) {
    if (failureSeverity <= 0) {
      return true
    }
    for (const issue of issues) {
      if (failureSeverity <= LintSeverity[issue.Severity]) {
        return true
      }
    }
  }
  return false
}

const printOutput = (res: ExecRes): void => {
  if (res.stdout) {
    core.info(res.stdout)
  }
  if (res.stderr) {
    core.info(res.stderr)
  }
}

async function printLintOutput(res: ExecRes, checkRunId: number): Promise<void> {
  let lintOutput: LintOutput | undefined
  const exit_code = res.code ?? 0
  try {
    if (res.stdout) {
      try {
        // This object contains other information, such as errors and the active linters
        // TODO: Should we do something with that data?
        lintOutput = parseOutput(res.stdout)

        if (lintOutput.Issues.length) {
          logLintIssues(lintOutput.Issues)

          // We can only Annotate (or Comment) on Push or Pull Request
          switch (github.context.eventName) {
            case `pull_request`:
            // TODO: When we are ready to handle these as Comments, instead of Annotations, we would place that logic here
            /* falls through */
            case `push`:
              await annotateLintIssues(lintOutput.Issues, checkRunId)
              break
            default:
              // At this time, other events are not supported
              break
          }
        }
      } catch (e) {
        throw `there was an error processing golangci-lint output: ${e}`
      }
    }

    if (res.stderr) {
      core.info(res.stderr)
    }

    if (exit_code === 1) {
      if (!lintOutput) {
        throw `unexpected state, golangci-lint exited with 1, but provided no lint output`
      }
      if (hasFailingIssues(lintOutput.Issues)) {
        throw `issues found`
      }
    } else if (exit_code > 1) {
      throw `golangci-lint exit with code ${exit_code}`
    }
  } catch (e) {
    return <void>core.setFailed(`${e}`)
  }
  return <void>core.info(`golangci-lint found no blocking issues`)
}

async function runLint(lintPath: string, patchPath: string, checkRunId: number): Promise<void> {
  const debug = core.getInput(`debug`)
  if (debug.split(`,`).includes(`cache`)) {
    const res = await execShellCommand(`${lintPath} cache status`)
    printOutput(res)
  }

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
  try {
    const res = await execShellCommand(cmd, cmdArgs)
    await printLintOutput(res, checkRunId)
  } catch (exc) {
    // This logging passes issues to GitHub annotations but comments can be more convenient for some users.
    // TODO: support reviewdog or leaving comments by GitHub API.
    await printLintOutput(exc, checkRunId)
  }

  core.info(`Ran golangci-lint in ${Date.now() - startedAt}ms`)
}

export async function run(): Promise<void> {
  try {
    const { lintPath, patchPath, checkRunId } = await core.group(`prepare environment`, prepareEnv)
    core.addPath(path.dirname(lintPath))
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

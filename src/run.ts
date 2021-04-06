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

async function resolveCheckRunId(): Promise<number> {
  let jobId = -1
  const ctx = github.context

  if (process.env.GITHUB_ACTIONS === `true` && ctx.runId) {
    try {
      core.info(`Attempting to resolve current GitHub Job (${ctx.runId})`)
      const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }))
      let workflowJobs = (
        await octokit.actions
          .listJobsForWorkflowRun({
            ...ctx.repo,
            run_id: ctx.runId,
          })
          .catch((e: string) => {
            throw `Unable to fetch Workflow Job List: ${e}`
          })
      ).data.jobs.filter((job) => job.status === `in_progress`)

      if (workflowJobs.length > 0) {
        core.info(`resolveCheckRunId() Found ${workflowJobs.length} Jobs:\n` + inspect(workflowJobs))
        if (workflowJobs.length > 1) {
          const searchRegExp = new RegExp(`^` + ctx.job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + `(\\s+\\(|$)`)
          const jobs = workflowJobs.filter((job) => searchRegExp.test(job.name))
          core.info(`resolveCheckRunId() Found ${jobs.length} Jobs whose base name is '${ctx.job}'`)
          workflowJobs = jobs.length ? jobs : workflowJobs
        }
        if (workflowJobs.length > 1) {
          const searchToken = uuidv4()
          core.info(`::warning::[ignore] Resolving GitHub Job with Search Token: ${searchToken}`)
          const startedAt = Date.now()
          // Sleep for MS, to allow Annotation to be captured and populated
          await ((ms): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))(10 * 1000)
          core.info(`Slept for ${Date.now() - startedAt}ms`)
          for (const job of workflowJobs) {
            try {
              const { data: annotations } = await octokit.checks.listAnnotations({
                ...ctx.repo,
                check_run_id: job.id,
              })

              core.info(`resolveCheckRunId() Found ${annotations.length} Annotations for Job '${job.id}':\n` + inspect(annotations))

              if (
                annotations.findIndex((annotation) => {
                  core.info(`resolveCheckRunId() Looking for Search Token (${searchToken}) in message: ${annotation.message}`)
                  return annotation.message.includes(searchToken)
                }) !== -1
              ) {
                core.info(`resolveCheckRunId() Found Search Token (${searchToken}) in Job ${job.id}`)
                jobId = job.id
                break
              }
            } catch (e) {
              core.info(`resolveCheckRunId() Error Fetching Job ${job.id}: ${e}`)
            }
          }
          core.info(`resolveCheckRunId() Finished looking for Search Token`)
        } else if (workflowJobs[0]) {
          jobId = workflowJobs[0].id
        } else {
          throw `Unable to resolve GitHub Job`
        }
        core.info(`Current Job: ${jobId}`)
      } else {
        throw `Fetching octokit.actions.getWorkflowRun(${process.env.GITHUB_RUN_ID}) returned no results`
      }
    } catch (e) {
      core.info(`::error::Unable to resolve GitHub Job: ${e}`)
    }
  } else {
    core.info(`Not in GitHub Action Context, Skipping Job Resolution`)
  }

  return jobId
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
  const title = `GolangCI-Lint`
  for (let i = 0; i < Math.ceil(issues.length / chunkSize); i++) {
    octokit.checks
      .update({
        ...ctx.repo,
        check_run_id: checkRunId,
        output: {
          title: title,
          annotations: issues.slice(i * chunkSize, i * chunkSize + chunkSize).map(
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
          ),
          summary: `There are {issueCounts.failure} failures, {issueCounts.wairning} warnings, and {issueCounts.notice} notices.`,
        },
      })
      .catch((e) => {
        throw `Error patching Check Run Data (annotations): ${e}`
      })
  }
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
        logLintIssues(lintIssues)

        // We can only Annotate (or Comment) on Push or Pull Request
        switch (github.context.eventName) {
          case `pull_request`:
          // TODO: When we are ready to handle these as Comments, instead of Annotations, we would place that logic here
          /* falls through */
          case `push`:
            await annotateLintIssues(lintIssues, checkRunId)
            break
          default:
            // At this time, other events are not supported
            break
        }
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

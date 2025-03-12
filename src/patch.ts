import * as core from "@actions/core"
import * as github from "@actions/github"
import { Context } from "@actions/github/lib/context"
import * as pluginRetry from "@octokit/plugin-retry"
import fs from "fs"
import path from "path"
import { dir } from "tmp"
import { promisify } from "util"

import { alterDiffPatch } from "./utils/diffUtils"

const writeFile = promisify(fs.writeFile)
const createTempDir = promisify(dir)

export function isOnlyNewIssues(): boolean {
  return core.getBooleanInput(`only-new-issues`, { required: true })
}

export async function fetchPatch(): Promise<string> {
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

  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }), {}, pluginRetry.retry)

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
  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }), {}, pluginRetry.retry)

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

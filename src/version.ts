import * as core from "@actions/core"
import * as github from "@actions/github"
import { Octokit } from "@actions/github/node_modules/@octokit/rest"

async function performResilientGitHubRequest<T>(opName: string, execFn: () => Promise<Octokit.Response<T>>): Promise<T> {
  let lastError = ``
  for (let i = 0; i < 3; i++) {
    // TODO: configurable params, timeouts, random jitters, exponential back-off, etc
    try {
      const res = await execFn()
      if (res.status === 200) {
        return res.data
      }
      lastError = `GitHub returned HTTP code ${res.status}`
    } catch (exc) {
      lastError = exc.message
    }
  }

  throw new Error(`failed to execute github operation '${opName}': ${lastError}`)
}

// TODO: make a class
export type Version = {
  major: number
  minor: number
  patch: number | null
}

const versionRe = /^v(\d+)\.(\d+)(?:\.(\d+))?$/

const parseVersion = (s: string): Version => {
  const match = s.match(versionRe)
  if (!match) {
    throw new Error(`invalid version string '${s}', expected format v1.2 or v1.2.3`)
  }

  return {
    major: parseInt(match[1]),
    minor: parseInt(match[2]),
    patch: match[3] === undefined ? null : parseInt(match[3]),
  }
}

export const stringifyVersion = (v: Version): string => `v${v.major}.${v.minor}${v.patch !== null ? `.${v.patch}` : ``}`

const minVersion = {
  major: 1,
  minor: 14,
  patch: 0,
}

const isLessVersion = (a: Version, b: Version): boolean => {
  if (a.major != b.major) {
    return a.major < b.major
  }

  if (a.minor != b.minor) {
    return a.minor < b.minor
  }

  if (a.patch === null || b.patch === null) {
    return true
  }

  return a.patch < b.patch
}

const getRequestedLintVersion = (): Version => {
  const requestedLintVersion = core.getInput(`version`, { required: true })
  const parsedRequestedLintVersion = parseVersion(requestedLintVersion)
  if (parsedRequestedLintVersion.patch !== null) {
    throw new Error(
      `requested golangci-lint version '${requestedLintVersion}' was specified with the patch version, need specify only minor version`
    )
  }
  if (isLessVersion(parsedRequestedLintVersion, minVersion)) {
    throw new Error(
      `requested golangci-lint version '${requestedLintVersion}' isn't supported: we support only ${stringifyVersion(
        minVersion
      )} and later versions`
    )
  }
  return parsedRequestedLintVersion
}

export async function findLintVersion(): Promise<Version> {
  core.info(`Finding needed golangci-lint version...`)
  const startedAt = Date.now()
  const reqLintVersion = getRequestedLintVersion()

  const githubToken = core.getInput(`github-token`, { required: true })
  const octokit = new github.GitHub(githubToken)

  // TODO: fetch all pages, not only the first one.
  const releasesPage = await performResilientGitHubRequest(`fetch releases of golangci-lint`, function() {
    return octokit.repos.listReleases({ owner: `golangci`, repo: `golangci-lint`, [`per_page`]: 100 })
  })

  // TODO: use semver and semver.satisfies
  let latestPatchVersion: number | null = null
  for (const rel of releasesPage) {
    const ver = parseVersion(rel.tag_name)
    if (ver.patch === null) {
      // < minVersion
      continue
    }

    if (ver.major == reqLintVersion.major && ver.minor == reqLintVersion.minor) {
      latestPatchVersion = latestPatchVersion !== null ? Math.max(latestPatchVersion, ver.patch) : ver.patch
    }
  }

  if (latestPatchVersion === null) {
    throw new Error(
      `requested golangci-lint lint version ${stringifyVersion(reqLintVersion)} doesn't exist in list of golangci-lint releases`
    )
  }

  const neededVersion = { ...reqLintVersion, patch: latestPatchVersion }
  core.info(`Calculated needed golangci-lint version ${stringifyVersion(neededVersion)} in ${Date.now() - startedAt}ms`)
  return neededVersion
}

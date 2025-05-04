import * as core from "@actions/core"
import * as httpm from "@actions/http-client"
import * as fs from "fs"
import path from "path"

import { InstallMode } from "./install"

// TODO: make a class
export type Version = {
  major: number
  minor: number
  patch: number | null
} | null

const versionRe = /^v(\d+)\.(\d+)(?:\.(\d+))?$/
const modVersionRe = /github.com\/golangci\/golangci-lint\/v2\s(v\S+)/

const parseVersion = (s: string): Version => {
  if (s == "latest" || s == "") {
    return null
  }

  const match = s.match(versionRe)
  if (!match) {
    throw new Error(`invalid version string '${s}', expected format v1.2 or v1.2.3`)
  }

  if (parseInt(match[1]) !== 2) {
    throw new Error(`invalid version string '${s}', golangci-lint v${match[1]} is not supported by golangci-lint-action >= v7.`)
  }

  return {
    major: parseInt(match[1]),
    minor: parseInt(match[2]),
    patch: match[3] === undefined ? null : parseInt(match[3]),
  }
}

export const stringifyVersion = (v: Version): string => {
  if (v == null) {
    return "latest"
  }
  return `v${v.major}.${v.minor}${v.patch !== null ? `.${v.patch}` : ``}`
}

const minVersion = {
  major: 2,
  minor: 1,
  patch: 0,
}

const isLessVersion = (a: Version, b: Version): boolean => {
  if (a == null) {
    return true
  }
  if (b == null) {
    return false
  }
  if (a.major != b.major) {
    return a.major < b.major
  }

  // Do not compare patch parts because if the min version has a non-zero value
  // then it returns false, since the patch version of requested is always zero
  return a.minor < b.minor
}

const getRequestedVersion = (): Version => {
  let requestedVersion = core.getInput(`version`)
  const workingDirectory = core.getInput(`working-directory`)

  let goMod = "go.mod"
  if (workingDirectory) {
    goMod = path.join(workingDirectory, goMod)
  }

  if (requestedVersion == "" && fs.existsSync(goMod)) {
    const content = fs.readFileSync(goMod, "utf-8")
    const match = content.match(modVersionRe)
    if (match) {
      requestedVersion = match[1]
      core.info(`Found golangci-lint version '${requestedVersion}' in '${goMod}' file`)
    }
  }

  const parsedRequestedVersion = parseVersion(requestedVersion)
  if (parsedRequestedVersion == null) {
    return null
  }

  if (isLessVersion(parsedRequestedVersion, minVersion)) {
    throw new Error(
      `requested golangci-lint version '${requestedVersion}' isn't supported: we support only ${stringifyVersion(
        minVersion
      )} and later versions`
    )
  }

  return parsedRequestedVersion
}

export type VersionInfo = {
  Error?: string
  TargetVersion: string
}

type VersionMapping = {
  MinorVersionToConfig: {
    [minorVersion: string]: VersionInfo
  }
}

const fetchVersionMapping = async (): Promise<VersionMapping> => {
  const http = new httpm.HttpClient(`golangci/golangci-lint-action`, [], {
    allowRetries: true,
    maxRetries: 5,
  })
  try {
    const url = `https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/assets/github-action-config-v2.json`
    const response: httpm.HttpClientResponse = await http.get(url)
    if (response.message.statusCode !== 200) {
      throw new Error(`failed to download from "${url}". Code(${response.message.statusCode}) Message(${response.message.statusMessage})`)
    }

    const body = await response.readBody()
    return JSON.parse(body)
  } catch (exc) {
    throw new Error(`failed to get action config: ${exc.message}`)
  }
}

export async function getVersion(mode: InstallMode): Promise<VersionInfo> {
  core.info(`Finding needed golangci-lint version...`)

  if (mode == InstallMode.GoInstall) {
    const v: string = core.getInput(`version`)

    return { TargetVersion: v ? v : "latest" }
  }

  const reqVersion = getRequestedVersion()

  // if the patched version is passed, just use it
  if (reqVersion?.major === 2 && reqVersion?.minor != null && reqVersion?.patch !== null) {
    return new Promise((resolve) => {
      const versionWithoutV = `${reqVersion.major}.${reqVersion.minor}.${reqVersion.patch}`
      resolve({ TargetVersion: `v${versionWithoutV}` })
    })
  }

  const startedAt = Date.now()

  const mapping = await fetchVersionMapping()
  if (!mapping.MinorVersionToConfig) {
    core.warning(JSON.stringify(mapping))
    throw new Error(`invalid config: no MinorVersionToConfig field`)
  }

  const versionInfo = mapping.MinorVersionToConfig[stringifyVersion(reqVersion)]
  if (!versionInfo) {
    throw new Error(`requested golangci-lint version '${stringifyVersion(reqVersion)}' doesn't exist`)
  }

  if (versionInfo.Error) {
    throw new Error(`failed to use requested golangci-lint version '${stringifyVersion(reqVersion)}': ${versionInfo.Error}`)
  }

  core.info(
    `Requested golangci-lint '${stringifyVersion(reqVersion)}', using '${versionInfo.TargetVersion}', calculation took ${
      Date.now() - startedAt
    }ms`
  )

  return versionInfo
}

import * as core from "@actions/core"
import * as httpm from "@actions/http-client"

// TODO: make a class
export type Version = {
  major: number
  minor: number
  patch: number | null
} | null

const versionRe = /^v(\d+)\.(\d+)(?:\.(\d+))?$/

const parseVersion = (s: string): Version => {
  if (s == "latest" || s == "") {
    return null
  }
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

export const stringifyVersion = (v: Version): string => {
  if (v == null) {
    return "latest"
  }
  return `v${v.major}.${v.minor}${v.patch !== null ? `.${v.patch}` : ``}`
}

const minVersion = {
  major: 1,
  minor: 28,
  patch: 3,
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

  // Do not compare patch parts because if the min version has a non zero value
  // then it returns false, since the patch version of requested is always zero
  return a.minor < b.minor
}

const getRequestedLintVersion = (): Version => {
  const requestedLintVersion = core.getInput(`version`)
  const parsedRequestedLintVersion = parseVersion(requestedLintVersion)
  if (parsedRequestedLintVersion == null) {
    return null
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

export type VersionConfig = {
  Error?: string
  TargetVersion: string
  AssetURL: string
}

type Config = {
  MinorVersionToConfig: {
    [minorVersion: string]: VersionConfig
  }
}

const getConfig = async (): Promise<Config> => {
  const http = new httpm.HttpClient(`golangci/golangci-lint-action`, [], {
    allowRetries: true,
    maxRetries: 5,
  })
  try {
    const url = `https://raw.githubusercontent.com/golangci/golangci-lint/master/assets/github-action-config.json`
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

export async function findLintVersion(): Promise<VersionConfig> {
  core.info(`Finding needed golangci-lint version...`)
  const reqLintVersion = getRequestedLintVersion()
  // if the patched version is passed, just use it
  if (reqLintVersion?.major !== null && reqLintVersion?.minor != null && reqLintVersion?.patch !== null) {
    return new Promise((resolve) => {
      const versionWithoutV = `${reqLintVersion.major}.${reqLintVersion.minor}.${reqLintVersion.patch}`
      resolve({
        TargetVersion: `v${versionWithoutV}`,
        AssetURL: `https://github.com/golangci/golangci-lint/releases/download/v${versionWithoutV}/golangci-lint-${versionWithoutV}-linux-amd64.tar.gz`,
      })
    })
  }
  const startedAt = Date.now()

  const config = await getConfig()
  if (!config.MinorVersionToConfig) {
    core.warning(JSON.stringify(config))
    throw new Error(`invalid config: no MinorVersionToConfig field`)
  }

  const versionConfig = config.MinorVersionToConfig[stringifyVersion(reqLintVersion)]
  if (!versionConfig) {
    throw new Error(`requested golangci-lint version '${stringifyVersion(reqLintVersion)}' doesn't exist`)
  }

  if (versionConfig.Error) {
    throw new Error(`failed to use requested golangci-lint version '${stringifyVersion(reqLintVersion)}': ${versionConfig.Error}`)
  }

  core.info(
    `Requested golangci-lint '${stringifyVersion(reqLintVersion)}', using '${versionConfig.TargetVersion}', calculation took ${
      Date.now() - startedAt
    }ms`
  )
  return versionConfig
}

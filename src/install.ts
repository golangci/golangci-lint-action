import * as core from "@actions/core"
import * as tc from "@actions/tool-cache"
import path from "path"
import { run as setupGo } from "setup-go/lib/main"

import { stringifyVersion, Version } from "./version"

// The installLint returns path to installed binary of golangci-lint.
export async function installLint(ver: Version): Promise<string> {
  core.info(`Installing golangci-lint ${stringifyVersion(ver)}...`)
  const startedAt = Date.now()
  const dirName = `golangci-lint-${ver.major}.${ver.minor}.${ver.patch}-linux-amd64`
  const assetUrl = `https://github.com/golangci/golangci-lint/releases/download/${stringifyVersion(ver)}/${dirName}.tar.gz`

  const tarGzPath = await tc.downloadTool(assetUrl)
  const extractedDir = await tc.extractTar(tarGzPath, process.env.HOME)
  const lintPath = path.join(extractedDir, dirName, `golangci-lint`)
  core.info(`Installed golangci-lint into ${lintPath} in ${Date.now() - startedAt}ms`)
  return lintPath
}

export async function installGo(): Promise<void> {
  const startedAt = Date.now()
  process.env[`INPUT_GO-VERSION`] = `1`
  await setupGo()
  core.info(`Installed Go in ${Date.now() - startedAt}ms`)
}

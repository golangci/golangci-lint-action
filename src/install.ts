import * as core from "@actions/core"
import * as tc from "@actions/tool-cache"
import path from "path"
import { run as setupGo } from "setup-go/lib/main"

import { VersionConfig } from "./version"

// The installLint returns path to installed binary of golangci-lint.
export async function installLint(versionConfig: VersionConfig): Promise<string> {
  core.info(`Installing golangci-lint ${versionConfig.TargetVersion}...`)
  const startedAt = Date.now()

  core.info(`Downloading ${versionConfig.AssetURL} ...`)
  const tarGzPath = await tc.downloadTool(versionConfig.AssetURL)
  const extractedDir = await tc.extractTar(tarGzPath, process.env.HOME)

  const urlParts = versionConfig.AssetURL.split(`/`)
  const dirName = urlParts[urlParts.length - 1].replace(/\.tar\.gz$/, ``)
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

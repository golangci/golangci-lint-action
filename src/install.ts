import * as core from "@actions/core"
import * as tc from "@actions/tool-cache"
import os from "os"
import path from "path"
import { run as setupGo } from "setup-go/lib/main"

import { VersionConfig } from "./version"

const downloadURL = "https://github.com/golangci/golangci-lint/releases/download"

const getAssetURL = (versionConfig: VersionConfig): string => {
  let ext = "tar.gz"
  let platform = os.platform().toString()
  switch (platform) {
    case "win32":
      platform = "windows"
      ext = "zip"
      break
  }
  let arch = os.arch()
  switch (arch) {
    case "x64":
      arch = "amd64"
      break
    case "x32":
    case "ia32":
      arch = "386"
      break
  }
  const noPrefix = versionConfig.TargetVersion.slice(1)

  return `${downloadURL}/${versionConfig.TargetVersion}/golangci-lint-${noPrefix}-${platform}-${arch}.${ext}`
}

// The installLint returns path to installed binary of golangci-lint.
export async function installLint(versionConfig: VersionConfig): Promise<string> {
  core.info(`Installing golangci-lint ${versionConfig.TargetVersion}...`)
  const startedAt = Date.now()
  const assetURL = getAssetURL(versionConfig)
  core.info(`Downloading ${assetURL} ...`)
  const archivePath = await tc.downloadTool(assetURL)
  let extractedDir = ""
  let repl = /\.tar\.gz$/
  if (assetURL.endsWith("zip")) {
    extractedDir = await tc.extractZip(archivePath, process.env.HOME)
    repl = /\.zip$/
  } else {
    extractedDir = await tc.extractTar(archivePath, process.env.HOME)
  }

  const urlParts = assetURL.split(`/`)
  const dirName = urlParts[urlParts.length - 1].replace(repl, ``)
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

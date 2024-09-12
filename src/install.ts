import * as core from "@actions/core"
import * as tc from "@actions/tool-cache"
import { exec, ExecOptions } from "child_process"
import os from "os"
import path from "path"
import { promisify } from "util"

import { VersionConfig } from "./version"

const execShellCommand = promisify(exec)

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

export enum InstallMode {
  Binary = "binary",
  GoInstall = "goinstall",
  None = "none",
}

type ExecRes = {
  stdout: string
  stderr: string
}

const printOutput = (res: ExecRes): void => {
  if (res.stdout) {
    core.info(res.stdout)
  }
  if (res.stderr) {
    core.info(res.stderr)
  }
}

/**
 * Install golangci-lint.
 *
 * @param versionConfig information about version to install.
 * @param mode          installation mode.
 * @returns             path to installed binary of golangci-lint.
 */
export async function installLint(versionConfig: VersionConfig, mode: InstallMode): Promise<string> {
  core.info(`Installation mode: ${mode}`)

  switch (mode) {
    case InstallMode.Binary:
      return installBin(versionConfig)
    case InstallMode.GoInstall:
      return goInstall(versionConfig)
    default:
      return installBin(versionConfig)
  }
}

/**
 * Install golangci-lint via `go install`.
 *
 * @param versionConfig information about version to install.
 * @returns             path to installed binary of golangci-lint.
 */
export async function goInstall(versionConfig: VersionConfig): Promise<string> {
  core.info(`Installing golangci-lint ${versionConfig.TargetVersion}...`)

  const startedAt = Date.now()

  const options: ExecOptions = { env: { ...process.env, CGO_ENABLED: "1" } }

  const exres = await execShellCommand(
    `go install github.com/golangci/golangci-lint/cmd/golangci-lint@${versionConfig.TargetVersion}`,
    options
  )
  printOutput(exres)

  const res = await execShellCommand(
    `go install -n github.com/golangci/golangci-lint/cmd/golangci-lint@${versionConfig.TargetVersion}`,
    options
  )
  printOutput(res)

  // The output of `go install -n` when the binary is already installed is `touch <path_to_the_binary>`.
  const lintPath = res.stderr
    .split(/\r?\n/)
    .map((v) => v.trimStart().trimEnd())
    .filter((v) => v.startsWith("touch "))
    .reduce((a, b) => a + b, "")
    .split(` `, 2)[1]

  core.info(`Installed golangci-lint into ${lintPath} in ${Date.now() - startedAt}ms`)

  return lintPath
}

/**
 * Install golangci-lint via the precompiled binary.
 *
 * @param versionConfig information about version to install.
 * @returns             path to installed binary of golangci-lint.
 */
export async function installBin(versionConfig: VersionConfig): Promise<string> {
  core.info(`Installing golangci-lint binary ${versionConfig.TargetVersion}...`)

  const startedAt = Date.now()

  const assetURL = getAssetURL(versionConfig)

  core.info(`Downloading binary ${assetURL} ...`)

  const archivePath = await tc.downloadTool(assetURL)

  let extractedDir = ""
  let repl = /\.tar\.gz$/
  if (assetURL.endsWith("zip")) {
    extractedDir = await tc.extractZip(archivePath, process.env.HOME)
    repl = /\.zip$/
  } else {
    // We want to always overwrite files if the local cache already has them
    const args = ["xz"]
    if (process.platform.toString() != "darwin") {
      args.push("--overwrite")
    }
    extractedDir = await tc.extractTar(archivePath, process.env.HOME, args)
  }

  const urlParts = assetURL.split(`/`)
  const dirName = urlParts[urlParts.length - 1].replace(repl, ``)
  const lintPath = path.join(extractedDir, dirName, `golangci-lint`)

  core.info(`Installed golangci-lint into ${lintPath} in ${Date.now() - startedAt}ms`)

  return lintPath
}

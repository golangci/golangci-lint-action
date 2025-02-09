import * as core from "@actions/core"
import * as tc from "@actions/tool-cache"
import { exec, ExecOptions } from "child_process"
import os from "os"
import path from "path"
import { promisify } from "util"

import { VersionInfo } from "./version"

const execShellCommand = promisify(exec)

const getAssetURL = (versionInfo: VersionInfo): string => {
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
    case "arm64":
      arch = "arm64"
      break
    case "x64":
      arch = "amd64"
      break
    case "x32":
    case "ia32":
      arch = "386"
      break
  }

  const noPrefix = versionInfo.TargetVersion.slice(1)

  return `https://github.com/golangci/golangci-lint/releases/download/${versionInfo.TargetVersion}/golangci-lint-${noPrefix}-${platform}-${arch}.${ext}`
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
 * @param versionInfo   information about version to install.
 * @param mode          installation mode.
 * @returns             path to installed binary of golangci-lint.
 */
export async function installLint(versionInfo: VersionInfo, mode: InstallMode): Promise<string> {
  core.info(`Installation mode: ${mode}`)

  switch (mode) {
    case InstallMode.Binary:
      return installBin(versionInfo)
    case InstallMode.GoInstall:
      return goInstall(versionInfo)
    default:
      return installBin(versionInfo)
  }
}

/**
 * Install golangci-lint via `go install`.
 *
 * @param versionInfo   information about version to install.
 * @returns             path to installed binary of golangci-lint.
 */
export async function goInstall(versionInfo: VersionInfo): Promise<string> {
  core.info(`Installing golangci-lint ${versionInfo.TargetVersion}...`)

  const startedAt = Date.now()

  const options: ExecOptions = { env: { ...process.env, CGO_ENABLED: "1" } }

  // TODO(ldez): it should be updated for v2.
  const exres = await execShellCommand(
    `go install github.com/golangci/golangci-lint/cmd/golangci-lint@${versionInfo.TargetVersion}`,
    options
  )
  printOutput(exres)

  // TODO(ldez): it should be updated for v2.
  const res = await execShellCommand(
    `go install -n github.com/golangci/golangci-lint/cmd/golangci-lint@${versionInfo.TargetVersion}`,
    options
  )
  printOutput(res)

  // The output of `go install -n` when the binary is already installed is `touch <path_to_the_binary>`.
  const binPath = res.stderr
    .split(/\r?\n/)
    .map((v) => v.trimStart().trimEnd())
    .filter((v) => v.startsWith("touch "))
    .reduce((a, b) => a + b, "")
    .split(` `, 2)[1]

  core.info(`Installed golangci-lint into ${binPath} in ${Date.now() - startedAt}ms`)

  return binPath
}

/**
 * Install golangci-lint via the precompiled binary.
 *
 * @param versionInfo   information about version to install.
 * @returns             path to installed binary of golangci-lint.
 */
export async function installBin(versionInfo: VersionInfo): Promise<string> {
  core.info(`Installing golangci-lint binary ${versionInfo.TargetVersion}...`)

  const startedAt = Date.now()

  const assetURL = getAssetURL(versionInfo)

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
  const binPath = path.join(extractedDir, dirName, `golangci-lint`)

  core.info(`Installed golangci-lint into ${binPath} in ${Date.now() - startedAt}ms`)

  return binPath
}

import * as core from "@actions/core"
import * as tc from "@actions/tool-cache"
import { exec, ExecOptionsWithStringEncoding } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { promisify } from "util"
import which from "which"

import { getVersion, VersionInfo } from "./version"

const execCommand = promisify(exec)

export enum InstallMode {
  Binary = "binary",
  GoInstall = "goinstall",
  None = "none",
}

type ExecRes = {
  stdout: string
  stderr: string
}

const printOutput = (res: ExecRes): ExecRes => {
  if (res.stdout) {
    core.info(res.stdout)
  }
  if (res.stderr) {
    core.info(res.stderr)
  }

  return res
}

/**
 * Install golangci-lint.
 *
 * @returns             path to installed binary of golangci-lint.
 */
export async function install(): Promise<string> {
  const problemMatchers = core.getBooleanInput(`problem-matchers`)

  if (problemMatchers) {
    const matchersPath = path.join(__dirname, "../..", "problem-matchers.json")
    if (fs.existsSync(matchersPath)) {
      // Adds problem matchers.
      // https://github.com/actions/setup-go/blob/cdcb36043654635271a94b9a6d1392de5bb323a7/src/main.ts#L81-L83
      core.info(`##[add-matcher]${matchersPath}`)
    }
  }

  const mode = core.getInput("install-mode").toLowerCase()

  if (mode === InstallMode.None) {
    const binPath = await which("golangci-lint", { nothrow: true })
    if (!binPath) {
      throw new Error("golangci-lint binary not found in the PATH")
    }
    return binPath
  }

  const versionInfo = await getVersion(<InstallMode>mode)

  return await installBinary(versionInfo, <InstallMode>mode)
}

/**
 * Install golangci-lint.
 *
 * @param versionInfo   information about version to install.
 * @param mode          installation mode.
 * @returns             path to installed binary of golangci-lint.
 */
export async function installBinary(versionInfo: VersionInfo, mode: InstallMode): Promise<string> {
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
async function goInstall(versionInfo: VersionInfo): Promise<string> {
  core.info(`Installing golangci-lint ${versionInfo.TargetVersion}...`)

  const startedAt = Date.now()

  const options: ExecOptionsWithStringEncoding = { env: { ...process.env, CGO_ENABLED: "1" } }

  await execCommand(`go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${versionInfo.TargetVersion}`, options).then(
    printOutput
  )

  const res = await execCommand(
    `go install -n github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${versionInfo.TargetVersion}`,
    options
  ).then(printOutput)

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
async function installBin(versionInfo: VersionInfo): Promise<string> {
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

function getAssetURL(versionInfo: VersionInfo): string {
  let ext = "tar.gz"

  let platform = os.platform().toString()
  switch (platform) {
    case "win32":
      platform = "windows"
      ext = "zip"
      break
  }

  let platformArch = "amd64"
  switch (os.arch()) {
    case "arm64":
      platformArch = "arm64"
      break
    case "x64":
      platformArch = "amd64"
      break
    case "ia32":
      platformArch = "386"
      break
  }

  const noPrefix = versionInfo.TargetVersion.slice(1)

  return `https://github.com/golangci/golangci-lint/releases/download/${versionInfo.TargetVersion}/golangci-lint-${noPrefix}-${platform}-${platformArch}.${ext}`
}

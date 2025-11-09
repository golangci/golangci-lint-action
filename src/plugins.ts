import * as core from "@actions/core"
import { exec, ExecOptionsWithStringEncoding } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { promisify } from "util"
import YAML from "yaml"

const execShellCommand = promisify(exec)

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

export async function install(binPath: string): Promise<string> {
  let rootDir = core.getInput(`working-directory`)

  if (rootDir) {
    if (!fs.existsSync(rootDir) || !fs.lstatSync(rootDir).isDirectory()) {
      throw new Error(`working-directory (${rootDir}) was not a path`)
    }

    rootDir = path.resolve(rootDir)
  } else {
    rootDir = process.cwd()
  }

  const configFile = ["yml", "yaml", "json"]
    .map((ext) => `.custom-gcl.${ext}`)
    .map((filename) => path.join(rootDir, filename))
    .find((filePath) => fs.existsSync(filePath))

  if (!configFile || configFile === "") {
    return ""
  }

  core.info(`Found configuration for the plugin module system : ${configFile}`)

  core.info(`Building and installing custom golangci-lint binary...`)

  const startedAt = Date.now()

  const config = YAML.parse(fs.readFileSync(configFile, "utf-8"))

  const v: string = core.getInput(`version`)
  if (v !== "" && config.version !== v) {
    core.warning(
      `The golangci-lint version (${config.version}) defined inside ${configFile} does not match the version defined in the action (${v})`
    )
  }

  if (!config.destination) {
    config.destination = "."
  }
  if (!config.name) {
    config.name = "custom-gcl"
  }

  if (!fs.existsSync(config.destination)) {
    core.info(`Creating destination directory: ${config.destination}`)
    fs.mkdirSync(config.destination, { recursive: true })
  }

  const cmd = `${binPath} custom`

  core.info(`Running [${cmd}] in [${rootDir}] ...`)

  try {
    const options: ExecOptionsWithStringEncoding = {
      cwd: rootDir,
    }

    const res = await execShellCommand(cmd, options)
    printOutput(res)

    core.info(`Built custom golangci-lint binary in ${Date.now() - startedAt}ms`)

    return path.join(rootDir, config.destination, config.name)
  } catch (exc) {
    throw new Error(`Failed to build custom golangci-lint binary: ${exc.message}`)
  }
}

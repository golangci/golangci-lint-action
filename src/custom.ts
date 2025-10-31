import * as core from "@actions/core"
import * as crypto from "crypto"
import { exec, ExecOptionsWithStringEncoding } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { promisify } from "util"

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

/**
 * Check if a custom golangci-lint config file exists.
 * The file can be .custom-gcl.yml, .custom-gcl.yaml, or .custom-gcl.json.
 *
 * @param workingDirectory  the working directory to search in
 * @returns                 the path to the custom config file, or null if not found
 */
export function findCustomConfigFile(workingDirectory: string): string | null {
    const possibleFiles = [".custom-gcl.yml", ".custom-gcl.yaml", ".custom-gcl.json"]

    for (const file of possibleFiles) {
        const filePath = path.join(workingDirectory, file)
        if (fs.existsSync(filePath)) {
            core.info(`Found custom golangci-lint config: ${filePath}`)
            return filePath
        }
    }

    return null
}

/**
 * Parse the custom config file to extract the binary name and destination.
 *
 * @param configPath  path to the custom config file
 * @returns           object with name and destination (relative path)
 */
export function getCustomBinaryInfo(configPath: string): { name: string; destination: string } {
    try {
        const content = fs.readFileSync(configPath, "utf-8")

        let name = "custom-gcl"
        let destination = "."

        // Try to parse as YAML/JSON
        // Look for "name:" field in the config
        const nameMatch = content.match(/^name:\s*["']?([^"'\s]+)["']?/m)
        if (nameMatch && nameMatch[1]) {
            name = nameMatch[1]
        }

        // Look for "destination:" field in the config
        const destMatch = content.match(/^destination:\s*["']?([^"'\s]+)["']?/m)
        if (destMatch && destMatch[1]) {
            destination = destMatch[1]
        }

        // For JSON format
        if (configPath.endsWith(".json")) {
            try {
                const json = JSON.parse(content)
                if (json.name) {
                    name = json.name
                }
                if (json.destination) {
                    destination = json.destination
                }
            } catch {
                // Fallback to default
            }
        }

        return { name, destination }
    } catch (err) {
        core.warning(`Failed to parse custom config file: ${err}`)
    }

    // Default values
    return { name: "custom-gcl", destination: "." }
}

/**
 * Build a custom golangci-lint binary using `golangci-lint custom`.
 *
 * @param binPath           path to the golangci-lint binary
 * @param workingDirectory  the working directory
 * @param customConfigPath  path to the custom config file
 * @returns                 path to the built custom binary
 */
export async function buildCustomBinary(binPath: string, workingDirectory: string, customConfigPath: string): Promise<string> {
    core.info(`Building custom golangci-lint binary from ${customConfigPath}...`)

    const startedAt = Date.now()

    const cmdArgs: ExecOptionsWithStringEncoding = {
        cwd: workingDirectory,
    }

    const binaryInfo = getCustomBinaryInfo(customConfigPath)
    const destinationDir = path.join(workingDirectory, binaryInfo.destination)
    const customBinaryPath = path.join(destinationDir, binaryInfo.name)

    // Ensure destination directory exists
    if (!fs.existsSync(destinationDir)) {
        core.info(`Creating destination directory: ${destinationDir}`)
        fs.mkdirSync(destinationDir, { recursive: true })
    }

    // Check if the binary already exists (from cache)
    if (fs.existsSync(customBinaryPath)) {
        core.info(`Custom binary already exists at ${customBinaryPath}`)
        return customBinaryPath
    }

    const cmd = `${binPath} custom`

    core.info(`Running [${cmd}] in [${workingDirectory}] ...`)

    try {
        const res = await execShellCommand(cmd, cmdArgs)
        printOutput(res)

        core.info(`Built custom golangci-lint binary in ${Date.now() - startedAt}ms`)

        return customBinaryPath
    } catch (exc) {
        core.error(`Failed to build custom golangci-lint binary: ${exc}`)
        throw new Error(`Failed to build custom golangci-lint binary: ${exc.message}`)
    }
}

/**
 * Calculate the hash of the custom config file.
 *
 * @param configPath  path to the custom config file
 * @returns           SHA256 hash of the file content
 */
export function hashCustomConfigFile(configPath: string): string {
    const content = fs.readFileSync(configPath, "utf-8")
    return crypto.createHash("sha256").update(content).digest("hex")
}

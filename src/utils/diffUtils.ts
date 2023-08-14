import * as core from "@actions/core"
import * as path from "path"

// If needed alter diff file to be compatible with working directory
export function alterDiffPatch(patch: string): string {
  const workingDirectory = core.getInput(`working-directory`)

  if (workingDirectory) {
    return alterPatchWithWorkingDirectory(patch, workingDirectory)
  }

  return patch
}

function alterPatchWithWorkingDirectory(patch: string, workingDirectory: string): string {
  const workspace = process.env["GITHUB_WORKSPACE"] || ""

  const wd = path.relative(workspace, workingDirectory)

  // ignore diff sections not related to the working directory
  let ignore = false

  const lines = patch.split("\n")
  const filteredLines = []

  // starts with "--- a/xxx/" or "+++ a/xxx/" or "--- b/xxx/" or "+++ b/xxx/"
  const cleanDiff = new RegExp(`^((?:\\+{3}|-{3}) [ab]\\/)${escapeRegExp(wd)}\\/(.*)`, "gm")

  // contains " a/xxx/" or " b/xxx/"
  const firstLine = new RegExp(`( [ab]\\/)${escapeRegExp(wd)}\\/(.*)`, "gm")

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      ignore = !line.includes(` a/${wd}/`)
      if (ignore) {
        continue
      }

      filteredLines.push(line.replaceAll(firstLine, "$1$2"))
    } else {
      if (ignore) {
        continue
      }

      filteredLines.push(line.replaceAll(cleanDiff, "$1$2"))
    }
  }

  // Join the modified lines back into a diff string
  return filteredLines.join("\n")
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
function escapeRegExp(exp: string): string {
  return exp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // $& means the whole matched string
}

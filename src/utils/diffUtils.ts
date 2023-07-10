import * as core from "@actions/core"
import * as path from "path"

// If needed alter diff file to be compatible with working directory
export function alterDiffFile(diffFile: string): string {
  let workingDirectory = core.getInput(`working-directory`)
  if (workingDirectory) {
    const workspace = process.env["GITHUB_WORKSPACE"] || ""
    const relativeFile = path.relative(workspace, workingDirectory)
    workingDirectory = relativeFile

    const diffLines = diffFile.split("\n")
    let ignore = false
    const filteredDiffLines = []

    for (const line of diffLines) {
      if (line.startsWith("diff --git")) {
        if (line.includes(`a/${workingDirectory}/`)) {
          ignore = false
          filteredDiffLines.push(line.replace(` a/${workingDirectory}/`, " a/").replace(` b/${workingDirectory}/`, " b/"))
        } else {
          ignore = true
        }
      } else {
        if (!ignore) {
          if (line.startsWith(`--- a/${workingDirectory}/`)) {
            filteredDiffLines.push(line.replace(`--- a/${workingDirectory}/`, "--- a/"))
          } else if (line.startsWith(`+++ a/${workingDirectory}/`)) {
            filteredDiffLines.push(line.replace(`+++ a/${workingDirectory}/`, "+++ a/"))
          } else if (line.startsWith(`--- b/${workingDirectory}/`)) {
            filteredDiffLines.push(line.replace(`--- b/${workingDirectory}/`, "--- b/"))
          } else if (line.startsWith(`+++ b/${workingDirectory}/`)) {
            filteredDiffLines.push(line.replace(`+++ b/${workingDirectory}/`, "+++ b/"))
          } else {
            filteredDiffLines.push(line)
          }
        }
      }
    }
    // Join the modified lines back into a diff string
    diffFile = filteredDiffLines.join("\n")
  }
  return diffFile
}

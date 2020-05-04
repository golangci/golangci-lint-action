import * as core from "@actions/core"
import restore from "cache/lib/restore"
import save from "cache/lib/save"

// TODO: ensure dir exists, have access, etc
const getCacheDir = (): string => `${process.env.HOME}/.cache/golangci-lint`

const setCacheInputs = (): void => {
  process.env.INPUT_KEY = `golangci-lint.analysis-cache`
  process.env.INPUT_PATH = getCacheDir()
}

export async function restoreCache(): Promise<void> {
  const startedAt = Date.now()
  setCacheInputs()

  // Tell golangci-lint to use our cache directory.
  process.env.GOLANGCI_LINT_CACHE = getCacheDir()

  await restore()
  core.info(`Restored golangci-lint analysis cache in ${Date.now() - startedAt}ms`)
}

export async function saveCache(): Promise<void> {
  const startedAt = Date.now()
  setCacheInputs()
  await save()
  core.info(`Saved golangci-lint analysis cache in ${Date.now() - startedAt}ms`)
}

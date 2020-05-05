import * as core from "@actions/core"
import restore from "cache/lib/restore"
import save from "cache/lib/save"
import * as crypto from "crypto"
import * as fs from "fs"

function checksumFile(hashName: string, path: string) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(hashName)
    const stream = fs.createReadStream(path)
    stream.on("error", err => reject(err))
    stream.on("data", chunk => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

const pathExists = async (path: string) => !!(await fs.promises.stat(path).catch(e => false))

const getLintCacheDir = (): string => `${process.env.HOME}/.cache/golangci-lint`

const getCacheDirs = (): string[] => {
  // Not existing dirs are ok here: it works.
  return [getLintCacheDir(), `${process.env.HOME}/.cache/go-build`, `${process.env.HOME}/go/pkg`]
}

const getIntervalKey = (invalidationIntervalDays: number): string => {
  const now = new Date()
  const secondsSinceEpoch = now.getTime() / 1000
  const intervalNumber = Math.floor(secondsSinceEpoch / (invalidationIntervalDays * 86400))
  return intervalNumber.toString()
}

async function buildCacheKeys(): Promise<string[]> {
  const keys = []
  let cacheKey = `golangci-lint.cache-`
  keys.push(cacheKey)

  // Periodically invalidate a cache because a new code being added.
  // TODO: configure it via inputs.
  cacheKey += `${getIntervalKey(7)}-`
  keys.push(cacheKey)

  if (await pathExists(`go.mod`)) {
    // Add checksum to key to invalidate a cache when dependencies change.
    cacheKey += await checksumFile(`sha1`, `go.mod`)
  } else {
    cacheKey += `nogomod`
  }
  keys.push(cacheKey)

  return keys
}

export async function restoreCache(): Promise<void> {
  const startedAt = Date.now()

  const keys = await buildCacheKeys()
  const primaryKey = keys.pop()
  const restoreKeys = keys.reverse()
  core.info(`Primary analysis cache key is '${primaryKey}', restore keys are '${restoreKeys.join(` | `)}'`)
  process.env[`INPUT_RESTORE-KEYS`] = restoreKeys.join(`\n`)
  process.env.INPUT_KEY = primaryKey

  process.env.INPUT_PATH = getCacheDirs().join(`\n`)

  // Tell golangci-lint to use our cache directory.
  process.env.GOLANGCI_LINT_CACHE = getLintCacheDir()

  await restore()
  core.info(`Restored cache for golangci-lint from key '${primaryKey}' in ${Date.now() - startedAt}ms`)
}

export async function saveCache(): Promise<void> {
  const startedAt = Date.now()

  const cacheDirs = getCacheDirs()
  process.env.INPUT_PATH = cacheDirs.join(`\n`)

  await save()
  core.info(`Saved cache for golangci-lint from paths '${cacheDirs.join(`, `)}' in ${Date.now() - startedAt}ms`)
}

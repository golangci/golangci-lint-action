import * as cache from "@actions/cache"
import * as core from "@actions/core"
import * as crypto from "crypto"
import * as fs from "fs"
import path from "path"

import { Events, State } from "./constants"
import * as utils from "./utils/actionUtils"

function checksumFile(hashName: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(hashName)
    const stream = fs.createReadStream(path)
    stream.on("error", (err) => reject(err))
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

const pathExists = async (path: string): Promise<boolean> => !!(await fs.promises.stat(path).catch(() => false))

const getLintCacheDir = (): string => {
  return path.resolve(`${process.env.HOME}/.cache/golangci-lint`)
}

const getCacheDirs = (): string[] => {
  // Not existing dirs are ok here: it works.
  return [getLintCacheDir(), path.resolve(`${process.env.HOME}/.cache/go-build`), path.resolve(`${process.env.HOME}/go/pkg`)]
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
  if (!utils.isValidEvent()) {
    utils.logWarning(
      `Event Validation Error: The event type ${process.env[Events.Key]} is not supported because it's not tied to a branch or tag ref.`
    )
    return
  }

  const startedAt = Date.now()

  const keys = await buildCacheKeys()
  const primaryKey = keys.pop()
  const restoreKeys = keys.reverse()

  // Tell golangci-lint to use our cache directory.
  process.env.GOLANGCI_LINT_CACHE = getLintCacheDir()

  if (!primaryKey) {
    utils.logWarning(`Invalid primary key`)
    return
  }
  core.saveState(State.CachePrimaryKey, primaryKey)
  try {
    const cacheKey = await cache.restoreCache(getCacheDirs(), primaryKey, restoreKeys)
    if (!cacheKey) {
      core.info(`Cache not found for input keys: ${[primaryKey, ...restoreKeys].join(", ")}`)
      return
    }
    // Store the matched cache key
    utils.setCacheState(cacheKey)
    core.info(`Restored cache for golangci-lint from key '${primaryKey}' in ${Date.now() - startedAt}ms`)
  } catch (error) {
    if (error.name === cache.ValidationError.name) {
      throw error
    } else {
      core.warning(error.message)
    }
  }
}

export async function saveCache(): Promise<void> {
  // Validate inputs, this can cause task failure
  if (!utils.isValidEvent()) {
    utils.logWarning(
      `Event Validation Error: The event type ${process.env[Events.Key]} is not supported because it's not tied to a branch or tag ref.`
    )
    return
  }

  const startedAt = Date.now()

  const cacheDirs = getCacheDirs()
  const primaryKey = core.getState(State.CachePrimaryKey)
  if (!primaryKey) {
    utils.logWarning(`Error retrieving key from state.`)
    return
  }

  const state = utils.getCacheState()

  if (utils.isExactKeyMatch(primaryKey, state)) {
    core.info(`Cache hit occurred on the primary key ${primaryKey}, not saving cache.`)
    return
  }

  try {
    await cache.saveCache(cacheDirs, primaryKey)
    core.info(`Saved cache for golangci-lint from paths '${cacheDirs.join(`, `)}' in ${Date.now() - startedAt}ms`)
  } catch (error) {
    if (error.name === cache.ValidationError.name) {
      throw error
    } else if (error.name === cache.ReserveCacheError.name) {
      core.info(error.message)
    } else {
      core.info(`[warning] ${error.message}`)
    }
  }
}

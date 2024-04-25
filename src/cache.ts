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

const getIntervalKey = (invalidationIntervalDays: number): string => {
  const now = new Date()
  const secondsSinceEpoch = now.getTime() / 1000
  const intervalNumber = Math.floor(secondsSinceEpoch / (invalidationIntervalDays * 86400))
  return intervalNumber.toString()
}

async function buildCacheKeys(): Promise<string[]> {
  const keys = []
  // Periodically invalidate a cache because a new code being added.
  // TODO: configure it via inputs.
  let cacheKey = `golangci-lint.cache-${getIntervalKey(7)}-`
  keys.push(cacheKey)
  // Get working directory from input
  const workingDirectory = core.getInput(`working-directory`)
  // create path to go.mod prepending the workingDirectory if it exists
  const goModPath = path.join(workingDirectory, `go.mod`)
  core.info(`Checking for go.mod: ${goModPath}`)
  if (await pathExists(goModPath)) {
    // Add checksum to key to invalidate a cache when dependencies change.
    cacheKey += await checksumFile(`sha1`, goModPath)
  } else {
    cacheKey += `nogomod`
  }
  keys.push(cacheKey)

  return keys
}

export async function restoreCache(): Promise<void> {
  if (core.getInput(`skip-cache`, { required: true }).trim() == "true") return

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
    const cacheKey = await cache.restoreCache([getLintCacheDir()], primaryKey, restoreKeys)
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
  if (core.getInput(`skip-cache`, { required: true }).trim() == "true") return
  if (core.getInput(`skip-save-cache`, { required: true }).trim() == "true") return

  // Validate inputs, this can cause task failure
  if (!utils.isValidEvent()) {
    utils.logWarning(
      `Event Validation Error: The event type ${process.env[Events.Key]} is not supported because it's not tied to a branch or tag ref.`
    )
    return
  }

  const startedAt = Date.now()

  const cacheDirs = [getLintCacheDir()]
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

// @ts-check

// Shared atomic temp-file + rename write, plus ENOENT-tolerant reads.
// Before this module the tmp+rename dance was hand-rolled at 20+ sites,
// each re-deciding tmp naming, mode handling, and cleanup-on-failure
// (most leaked the tmp file when the rename threw).

import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { errCode } from './json_util.js'

/**
 * Thrown when `expectedMtimeMs` was given and the target changed (or
 * disappeared) between the caller's read and this write. Callers that
 * expose a domain error class re-wrap this; the `code` is the stable
 * contract.
 */
export class ConcurrentEditError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options) {
    super(message, options)
    this.name = 'ConcurrentEditError'
    this.code = 'CONCURRENT_EDIT'
  }
}

/**
 * @typedef {object} AtomicWriteOptions
 * @property {number} [mode] file mode for the temp file (carried over by rename)
 * @property {number} [dirMode] mode for parent directories created on demand
 * @property {boolean} [fsync] fsync the temp file before the rename
 * @property {number} [expectedMtimeMs] reject with {@link ConcurrentEditError}
 *   unless the target's mtime still matches (optimistic concurrency)
 * @property {typeof fsp} [fs] promises-API override, for tests
 */

/** @param {string} filePath */
function tmpPathFor(filePath) {
  return `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
}

/**
 * Write `data` to `filePath` atomically: temp file in the same
 * directory (same filesystem, so the rename is atomic), then rename
 * over the target. Parent directories are created on demand. The temp
 * file is removed on failure.
 *
 * @param {string} filePath
 * @param {string | Uint8Array} data
 * @param {AtomicWriteOptions} [options]
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(filePath, data, options = {}) {
  const { mode, dirMode, fsync = false, expectedMtimeMs, fs = fsp } = options

  if (expectedMtimeMs !== undefined) {
    let current
    try {
      current = await fs.stat(filePath)
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        throw new ConcurrentEditError(
          `${filePath} disappeared between read and write; retry`,
          { cause: err }
        )
      }
      throw err
    }
    if (current.mtimeMs !== expectedMtimeMs) {
      throw new ConcurrentEditError(
        `${filePath} changed on disk between read and write; retry`
      )
    }
  }

  await fs.mkdir(path.dirname(filePath), {
    recursive: true,
    ...dirMode !== undefined ? { mode: dirMode } : {},
  })

  const tmpPath = tmpPathFor(filePath)
  let renamed = false
  try {
    if (fsync) {
      let handle
      try {
        handle = await fs.open(tmpPath, 'w', mode ?? 0o666)
        await handle.writeFile(data, 'utf8')
        await handle.sync()
      } finally {
        if (handle) await handle.close()
      }
    } else {
      await fs.writeFile(tmpPath, data, mode !== undefined ? { mode } : 'utf8')
    }
    await fs.rename(tmpPath, filePath)
    renamed = true
  } finally {
    if (!renamed) {
      try {
        await fs.rm(tmpPath, { force: true })
      } catch {
        // Best-effort: a leaked temp file is preferable to masking the
        // original error.
      }
    }
  }
}

/**
 * Synchronous {@link atomicWriteFile}. No fsync or mtime-guard support:
 * no sync caller needs them.
 *
 * @param {string} filePath
 * @param {string | Uint8Array} data
 * @param {{ mode?: number, dirMode?: number }} [options]
 */
export function atomicWriteFileSync(filePath, data, options = {}) {
  const { mode, dirMode } = options
  fsSync.mkdirSync(path.dirname(filePath), {
    recursive: true,
    ...dirMode !== undefined ? { mode: dirMode } : {},
  })
  const tmpPath = tmpPathFor(filePath)
  try {
    fsSync.writeFileSync(tmpPath, data, mode !== undefined ? { mode } : 'utf8')
    fsSync.renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      fsSync.rmSync(tmpPath, { force: true })
    } catch {
      // Best-effort: a leaked temp file is preferable to masking the
      // original error.
    }
    throw err
  }
}

/**
 * {@link atomicWriteFile} of `JSON.stringify(value, null, 2)` plus a
 * trailing newline.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {AtomicWriteOptions} [options]
 * @returns {Promise<void>}
 */
export function atomicWriteJson(filePath, value, options) {
  return atomicWriteFile(filePath, JSON.stringify(value, null, 2) + '\n', options)
}

/**
 * Synchronous {@link atomicWriteJson}.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {{ mode?: number, dirMode?: number }} [options]
 */
export function atomicWriteJsonSync(filePath, value, options) {
  atomicWriteFileSync(filePath, JSON.stringify(value, null, 2) + '\n', options)
}

/**
 * The file's text, or `null` when it does not exist. Every other error
 * propagates.
 *
 * @param {string} filePath
 * @param {{ fs?: typeof fsp }} [options]
 * @returns {Promise<string | null>}
 */
export async function readFileIfExists(filePath, options = {}) {
  const { fs = fsp } = options
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null
    throw err
  }
}

/**
 * Synchronous {@link readFileIfExists}.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
export function readFileIfExistsSync(filePath) {
  try {
    return fsSync.readFileSync(filePath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null
    throw err
  }
}

/**
 * Parsed JSON contents, or `null` when the file does not exist. Parse
 * errors propagate: a present-but-corrupt file is the caller's problem
 * to surface, not something to silently treat as missing.
 *
 * @param {string} filePath
 * @param {{ fs?: typeof fsp }} [options]
 * @returns {Promise<unknown>}
 */
export async function readJsonIfExists(filePath, options) {
  const raw = await readFileIfExists(filePath, options)
  return raw === null ? null : JSON.parse(raw)
}

/**
 * Synchronous {@link readJsonIfExists}.
 *
 * @param {string} filePath
 * @returns {unknown}
 */
export function readJsonIfExistsSync(filePath) {
  const raw = readFileIfExistsSync(filePath)
  return raw === null ? null : JSON.parse(raw)
}

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Read a JSON cursor file. Returns `undefined` when the file does not exist
 * — callers treat that as "no prior cursor". Any other error (parse failure,
 * permission denied) is logged through `onError` and treated as missing so
 * the daemon prefers to reprocess from the start over crashing.
 *
 * @param {string} filePath
 * @param {{ onError?: (msg: string) => void }} [opts]
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
export async function readCursor(filePath, opts = {}) {
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return undefined
    }
    opts.onError?.(`gascity: failed to read cursor ${filePath}: ${formatError(err)}`)
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      opts.onError?.(`gascity: cursor ${filePath} is not a JSON object — ignoring`)
      return undefined
    }
    return /** @type {Record<string, unknown>} */ (parsed)
  } catch (err) {
    opts.onError?.(`gascity: cursor ${filePath} is not valid JSON: ${formatError(err)}`)
    return undefined
  }
}

/**
 * Atomically write a JSON cursor file: write to `<path>.tmp`, fsync, rename.
 * The parent directory is created on demand.
 *
 * Atomicity matters because the cursor is the daemon's only memory of where
 * a stream left off; a torn file would either replay frames (acceptable) or
 * skip frames (data loss). The write-then-rename pattern guarantees readers
 * either see the previous full file or the new full file — never a partial.
 *
 * @param {string} filePath
 * @param {Record<string, unknown>} value
 * @returns {Promise<void>}
 */
export async function writeCursor(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  const body = `${JSON.stringify(value)}\n`
  const handle = await fs.open(tmpPath, 'w')
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmpPath, filePath)
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}

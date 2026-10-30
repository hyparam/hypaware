// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * @import { AntigravityWatermarkState } from './types.js'
 */

const WATERMARK_FILENAME = 'watermark.json'
const WATERMARK_VERSION = 1

/**
 * Resolve the watermark file path inside the plugin's state directory.
 *
 * @param {string} stateDir
 * @returns {string}
 */
export function watermarkFilePath(stateDir) {
  return path.join(stateDir, WATERMARK_FILENAME)
}

/**
 * Load the persisted poll watermark state for `appDataDir`. If the file is
 * missing, corrupt, or bound to a different `appDataDir`, returns `{}` so the
 * poll source re-projects cleanly.
 *
 * @param {string} stateDir
 * @param {string} appDataDir
 * @returns {Promise<AntigravityWatermarkState>}
 */
export async function loadWatermarkState(stateDir, appDataDir) {
  const file = watermarkFilePath(stateDir)
  let rawText
  try {
    rawText = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return {}
    return {}
  }

  let parsed
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return {}
  }
  if (!isPlainObject(parsed)) return {}
  if (parsed.version !== WATERMARK_VERSION) return {}
  if (parsed.app_data_dir !== path.resolve(appDataDir)) return {}
  if (!isPlainObject(parsed.conversations)) return {}

  /** @type {AntigravityWatermarkState} */
  const out = {}
  for (const [key, val] of Object.entries(parsed.conversations)) {
    if (!isPlainObject(val)) continue
    const size = typeof val.size === 'number' && Number.isFinite(val.size) && val.size >= 0
      ? Math.trunc(val.size)
      : 0
    const mtimeMs = typeof val.mtime_ms === 'number' && Number.isFinite(val.mtime_ms) && val.mtime_ms >= 0
      ? val.mtime_ms
      : 0
    const stepCount = typeof val.step_count === 'number' && Number.isFinite(val.step_count) && val.step_count >= 0
      ? Math.trunc(val.step_count)
      : 0
    out[key] = { size, mtime_ms: mtimeMs, step_count: stepCount }
  }
  return out
}

/**
 * Atomically persist the poll watermark state to `<stateDir>/watermark.json`.
 *
 * @param {string} stateDir
 * @param {string} appDataDir
 * @param {AntigravityWatermarkState} watermarks
 * @returns {Promise<void>}
 */
export async function saveWatermarkState(stateDir, appDataDir, watermarks) {
  await fs.mkdir(stateDir, { recursive: true })
  const file = watermarkFilePath(stateDir)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const payload = JSON.stringify(
    {
      version: WATERMARK_VERSION,
      app_data_dir: path.resolve(appDataDir),
      conversations: watermarks,
    },
    null,
    2
  )
  await fs.writeFile(tmp, `${payload}\n`, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

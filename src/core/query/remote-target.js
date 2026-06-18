// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * @import { RemoteTarget } from './types.d.ts'
 */

const TARGET_BASENAME = 'query-remote.json'
const TARGET_VERSION = 1

/**
 * Path to the machine-local remote query target. It lives beside the
 * other per-host state under `<HYP_HOME>/hypaware/` — never in the v2
 * config, and never through the central/local config merge.
 *
 * @ref LLP 0032#target-storage [implements] — per-host query state, not fleet config
 * @param {string} stateDir
 * @returns {string}
 */
export function queryRemoteTargetPath(stateDir) {
  return path.join(stateDir, TARGET_BASENAME)
}

/**
 * Read the saved remote target, or null if none is set (or the file is
 * absent / unreadable / malformed — a missing target is the normal
 * "querying locally" state, not an error).
 *
 * @param {string} stateDir
 * @returns {Promise<RemoteTarget | null>}
 */
export async function readRemoteTarget(stateDir) {
  let raw
  try {
    raw = await fs.readFile(queryRemoteTargetPath(stateDir), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.server_url !== 'string' || parsed.server_url.length === 0) {
      return null
    }
    return { serverUrl: parsed.server_url }
  } catch {
    return null
  }
}

/**
 * Persist the remote target (URL only — the admin token is never written
 * to disk). Atomic write, mode 0600.
 *
 * @ref LLP 0032#credential [constrained-by] — URL only; token stays in the environment
 * @param {string} stateDir
 * @param {string} serverUrl
 * @returns {Promise<string>} the path written
 */
export async function writeRemoteTarget(stateDir, serverUrl) {
  const target = queryRemoteTargetPath(stateDir)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const body = JSON.stringify({ version: TARGET_VERSION, server_url: serverUrl }, null, 2) + '\n'
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`
  await fs.writeFile(tmp, body, { mode: 0o600 })
  await fs.rename(tmp, target)
  return target
}

/**
 * Remove the saved remote target. Idempotent — returns true if a target
 * existed and was cleared, false if there was nothing to clear.
 *
 * @param {string} stateDir
 * @returns {Promise<boolean>}
 */
export async function clearRemoteTarget(stateDir) {
  try {
    await fs.unlink(queryRemoteTargetPath(stateDir))
    return true
  } catch {
    return false
  }
}

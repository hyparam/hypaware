// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { atomicWriteJson } from '../util/fs_atomic.js'

const PICK_PENDING_SUBDIR = 'usage-policy'
const PICK_PENDING_FILENAME = 'pick-pending.json'
const PICK_PENDING_VERSION = 1

/**
 * How long a pick-pending marker holds sink exports before it is considered
 * abandoned. Sized to comfortably cover the enrolling login's bounded waits
 * (attach + capture, 30s each) plus a human actually reading the picker,
 * while guaranteeing an abandoned or crashed login can never stall
 * forwarding indefinitely: the hold is always bounded, the pick is not a
 * kill switch.
 *
 * @ref LLP 0093#bounded [implements]: the hold expires on its own; only the login's clear ends it early
 */
export const PICK_PENDING_TTL_MS = 10 * 60_000

/**
 * Path of the machine-local pick-pending marker, co-located with the
 * `local-only` list it guards the first read of (`usage-policy/` under
 * `HYP_HOME` state).
 *
 * @param {string} stateDir `readObservabilityEnv(env).stateDir`
 * @returns {string}
 */
export function pickPendingMarkerPath(stateDir) {
  if (!stateDir) throw new Error('pickPendingMarkerPath: stateDir is required')
  return path.join(stateDir, PICK_PENDING_SUBDIR, PICK_PENDING_FILENAME)
}

/**
 * Write the pick-pending marker: an enrolling login is about to run the
 * local-only directory picker, so sink exports should hold until the pick
 * lands (or the TTL expires). The content is for debuggability only -
 * freshness is judged by the file's mtime, so a torn write can never wedge
 * or extend the hold.
 *
 * Throws on failure; the caller (the enrolling login) treats that as
 * "no hold this run" rather than a login failure.
 *
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<void>}
 */
export async function writePickPendingMarker({ stateDir, fs }) {
  const filePath = pickPendingMarkerPath(stateDir)
  const payload = {
    version: PICK_PENDING_VERSION,
    created_at: new Date().toISOString(),
    pid: process.pid,
  }
  await atomicWriteJson(filePath, payload, fs ? { fs } : undefined)
}

/**
 * Remove the pick-pending marker (the pick landed, or the login exited on
 * any path). Idempotent: a missing marker is the common case after a TTL
 * expiry already cleaned it up, not an error.
 *
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<void>}
 */
export async function clearPickPendingMarker({ stateDir, fs = fsp }) {
  try {
    await fs.unlink(pickPendingMarkerPath(stateDir))
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
    throw err
  }
}

/**
 * Is a fresh pick-pending marker present? Never throws.
 *
 * Freshness is `now - mtime < ttlMs`. A stale marker is treated as absent
 * and opportunistically unlinked (best-effort) so an abandoned login leaves
 * no residue. A stat failure other than ENOENT also reads as absent: unlike
 * the local-only *list* (the actual privacy signal, which fails loudly, LLP
 * 0080 #fail-safe), the marker is only a bounded timing hint - failing
 * closed on an unreadable marker would wedge every export until someone
 * hand-deleted a file, an unbounded hold this mechanism exists to rule out.
 *
 * @ref LLP 0093#bounded [implements]: stale or unreadable markers read as absent; the hold can only ever be bounded
 * @param {{ stateDir: string, ttlMs?: number, now?: number, fs?: typeof fsp }} opts
 * @returns {Promise<boolean>}
 */
export async function isPickPending({ stateDir, ttlMs = PICK_PENDING_TTL_MS, now = Date.now(), fs = fsp }) {
  const filePath = pickPendingMarkerPath(stateDir)
  /** @type {import('node:fs').Stats} */
  let stat
  try {
    stat = await fs.stat(filePath)
  } catch {
    return false
  }
  if (now - stat.mtimeMs < ttlMs) return true
  try {
    await fs.unlink(filePath)
  } catch {
    // Best-effort hygiene only; the stale marker already reads as absent.
  }
  return false
}

// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { atomicWriteJson } from '../util/fs_atomic.js'

const FIRST_SYNC_HOLD_SUBDIR = 'usage-policy'
const FIRST_SYNC_HOLD_FILENAME = 'first-sync-hold.json'
const FIRST_SYNC_HOLD_VERSION = 1

/**
 * The minimum lead time a fresh 11:59pm deadline must clear. An enrollment
 * that lands after 8pm would otherwise get a useless sub-4h review window, so
 * the deadline rolls to the following day's 11:59pm instead.
 *
 * @ref LLP 0101#deadline [implements]: the 4-hour floor rolls a late-evening deadline to the next day
 */
export const FIRST_SYNC_MIN_LEAD_MS = 4 * 60 * 60_000

/**
 * Compute the absolute first-sync hold deadline for an enrollment happening
 * at `now`: the next local 11:59pm, rolled to the following day's 11:59pm
 * when the same-day one is less than four hours away (`FIRST_SYNC_MIN_LEAD_MS`).
 *
 * An absolute end-of-day time is memorable ("tonight at 11:59pm") where a
 * duration is not, and it hints at the eventual daily-sync cadence without
 * inventing one. All arithmetic is local-time via `Date` setters, so DST
 * transitions and month boundaries fall out correctly.
 *
 * @ref LLP 0101#deadline [implements]: next local 11:59pm, +1 day when under the 4-hour floor
 * @param {number} [now] epoch ms; defaults to `Date.now()`
 * @returns {number} the deadline as epoch ms
 */
export function computeFirstSyncDeadline(now = Date.now()) {
  const deadline = new Date(now)
  deadline.setHours(23, 59, 0, 0)
  if (deadline.getTime() - now < FIRST_SYNC_MIN_LEAD_MS) {
    // setDate rolls the month/year in local time; the 23:59:00 wall-clock
    // time is preserved across the roll (and across a DST boundary).
    deadline.setDate(deadline.getDate() + 1)
  }
  return deadline.getTime()
}

/**
 * Format an absolute deadline (epoch ms) as a memorable local date/time. The
 * one place the login message ([LLP 0100](../../../llp/0100-enrollment-privacy-review.spec.md)
 * R1) and `hyp status` (R9) render "the deadline", so the two consent
 * surfaces cannot drift apart on wording.
 *
 * @ref LLP 0100#requirements [implements]: shared formatting keeps R1's login message and R9's status line in sync
 * @param {number} deadlineMs epoch ms
 * @returns {string}
 */
export function formatFirstSyncDeadline(deadlineMs) {
  return new Date(deadlineMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Path of the machine-local first-sync hold marker, co-located with the
 * `usage-policy/` state it lives beside (the machine-local policy lists).
 *
 * @param {string} stateDir `readObservabilityEnv(env).stateDir`
 * @returns {string}
 */
export function firstSyncHoldMarkerPath(stateDir) {
  if (!stateDir) throw new Error('firstSyncHoldMarkerPath: stateDir is required')
  return path.join(stateDir, FIRST_SYNC_HOLD_SUBDIR, FIRST_SYNC_HOLD_FILENAME)
}

/**
 * Write the first-sync hold marker: an enrolling login is about to install a
 * daemon, and its first export ticks must hold until a printed, absolute
 * deadline so the user can review captured history before anything leaves the
 * machine ([LLP 0100](../../../llp/0100-enrollment-privacy-review.spec.md) R2).
 *
 * The deadline is stored **inside** the marker, not derived from mtime,
 * because an hours-long hold must survive incidental touches. Throws on write
 * failure; the caller (the enrolling login) treats that as "no hold this run"
 * rather than a login failure.
 *
 * @ref LLP 0101 [implements]: the enrolling login writes a hold marker carrying an absolute deadline
 * @param {{ stateDir: string, now?: number, fs?: typeof fsp }} opts
 * @returns {Promise<number>} the deadline written (epoch ms), so the caller can print it
 */
export async function writeFirstSyncHoldMarker({ stateDir, now = Date.now(), fs }) {
  const deadlineMs = computeFirstSyncDeadline(now)
  const filePath = firstSyncHoldMarkerPath(stateDir)
  const payload = {
    version: FIRST_SYNC_HOLD_VERSION,
    created_at: new Date(now).toISOString(),
    deadline: new Date(deadlineMs).toISOString(),
    deadline_ms: deadlineMs,
    pid: process.pid,
  }
  await atomicWriteJson(filePath, payload, fs ? { fs } : undefined)
  return deadlineMs
}

/**
 * Read the live first-sync hold deadline, or `null` when no hold applies.
 * Never throws.
 *
 * Fail-open polarity (the [LLP 0093 #bounded](../../../llp/0093-pick-pending-export-hold.decision.md#bounded)
 * doctrine this generalizes): the machine-local policy lists are the privacy
 * signal, the marker is only timing. So an unreadable or malformed marker
 * reads as **absent** rather than wedging every export behind a hold no one
 * can lift. A deadline in the past also reads as absent, and the stale marker
 * is opportunistically unlinked so an expired hold leaves no residue.
 *
 * Because the deadline lives inside the marker, the hold survives incidental
 * touches to the file (mtime is irrelevant) - an hours-long window cannot be
 * shortened or extended by a stray `stat`/rewrite.
 *
 * @ref LLP 0101 [implements]: deadline read from the marker body; past/corrupt reads as absent (fail-open)
 * @param {{ stateDir: string, now?: number, fs?: typeof fsp }} opts
 * @returns {Promise<number | null>} the future deadline (epoch ms), or null when no hold applies
 */
export async function readFirstSyncDeadline({ stateDir, now = Date.now(), fs = fsp }) {
  const filePath = firstSyncHoldMarkerPath(stateDir)
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
  let deadlineMs
  try {
    const parsed = JSON.parse(raw)
    deadlineMs = parsed?.deadline_ms
  } catch {
    return null
  }
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs)) return null
  if (deadlineMs <= now) {
    try {
      await fs.unlink(filePath)
    } catch {
      // Best-effort hygiene only; the expired marker already reads as absent.
    }
    return null
  }
  return deadlineMs
}

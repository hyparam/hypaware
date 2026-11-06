// @ts-check

/**
 * How long since a client's last captured row, and when that gap is a
 * warning or an error.
 */

import { parseIsoMs } from './values.js'

/**
 * Client activity newer than the capture baseline by more than this is a
 * capture gap worth a diagnostic. Under working capture the two move in near
 * lockstep - Claude Code appends the transcript and flushes the exporter on
 * the same turns, seconds apart - so the threshold only has to clear flush
 * cadence and batch timing, and fifteen minutes clears them by an order of
 * magnitude while still catching a broken path within the same sitting.
 */
export const CAPTURE_GAP_WARNING_MS = 15 * 60_000

/**
 * Past this the gap severity escalates to `error`, which degrades `overall`:
 * two hours of transcript activity with no telemetry is a whole working
 * session lost, not a timing artifact. The escalation is the "visible
 * instead of discovered at report time" duty of LLP 0262 open question 1 -
 * best-effort delivery was accepted on the condition that a silent gap
 * cannot stay silent.
 */
export const CAPTURE_GAP_ERROR_MS = 2 * 3_600_000

/**
 * Judge one otel-attached client's capture gap. Pure, so the threshold
 * contract is unit-testable without a filesystem.
 *
 * The baseline is the newest of three moments capture could be measured from:
 * the last event seen, the attach timestamp, and the running listener's own
 * start. Activity older than the attach proves nothing about the otel path
 * (the usual shape right after a migration from proxy attach, where months of
 * transcripts predate the first possible event), and a listener that has seen
 * nothing at all is measured from the attach instead. No baseline at all - no
 * events, no listener, and an unreadable attach time - reads as `ok`, because
 * a gap claim needs a moment capture was supposed to start.
 *
 * `listenerStartedAt` is the third because the listener's `lastEventAt` lives
 * only in its process: every daemon restart republishes `last_event_at: null`
 * however long capture has been healthy, and without this the baseline would
 * fall back to an attach timestamp that can be weeks old. A machine attached a
 * month ago and used an hour ago would then report a month-long gap - severity
 * `error`, degrading `overall` - immediately after a routine
 * `hyp daemon restart`, which is itself the first repair `capture_gap` prints.
 * The caller passes it ONLY for a live daemon: on a dead one the last daemon's
 * start says nothing about now, and the growing gap is precisely the thing to
 * surface.
 *
 * @ref LLP 0257#status-and-health [implements]: the gap threshold and its severity
 * @param {{ lastEventAt?: string | null, lastTranscriptActivityAt?: string | null, attachedAt?: string | null, listenerStartedAt?: string | null }} args
 * @returns {{ state: 'ok' | 'gap', gapMs: number, severity?: 'warning' | 'error' }}
 */
export function assessCaptureHealth({ lastEventAt, lastTranscriptActivityAt, attachedAt, listenerStartedAt }) {
  const transcriptMs = parseIsoMs(lastTranscriptActivityAt)
  if (transcriptMs === undefined) return { state: 'ok', gapMs: 0 }
  const baseline = captureBaselineMs(lastEventAt, attachedAt, listenerStartedAt)
  if (baseline === undefined) return { state: 'ok', gapMs: 0 }
  const gapMs = Math.max(0, transcriptMs - baseline)
  if (gapMs <= CAPTURE_GAP_WARNING_MS) return { state: 'ok', gapMs }
  return {
    state: 'gap',
    gapMs,
    severity: gapMs > CAPTURE_GAP_ERROR_MS ? 'error' : 'warning',
  }
}

/**
 * A gap length for diagnostic prose: coarse on purpose, like
 * `formatEntrypointAge`, because the message's claim is "a sitting" or "a
 * day", never a precise bound.
 *
 * @param {number} gapMs
 * @returns {string}
 */
export function formatGapDuration(gapMs) {
  const minutes = Math.floor(gapMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * The moment capture was supposed to be running from: the newest of the last
 * event seen, the attach, and the running listener's start. `undefined` when
 * none of the three is readable, which is the no-baseline case a gap claim
 * cannot be made from. Shared so the gap verdict and the confirmation read
 * that second-guesses it measure from the same instant.
 *
 * @param {string | null | undefined} lastEventAt
 * @param {string | null | undefined} attachedAt
 * @param {string | null | undefined} listenerStartedAt
 * @returns {number | undefined}
 */
export function captureBaselineMs(lastEventAt, attachedAt, listenerStartedAt) {
  const eventMs = parseIsoMs(lastEventAt)
  const attachedMs = parseIsoMs(attachedAt)
  const listenerMs = parseIsoMs(listenerStartedAt)
  if (eventMs === undefined && attachedMs === undefined && listenerMs === undefined) return undefined
  return Math.max(eventMs ?? -Infinity, attachedMs ?? -Infinity, listenerMs ?? -Infinity)
}

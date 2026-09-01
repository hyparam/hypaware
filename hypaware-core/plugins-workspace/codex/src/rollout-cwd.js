// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { compareStrings } from 'hypaware/core/util'
import { readRolloutSessionMeta } from '../../../../src/core/codex/rollout_session_meta.js'

// `sessionIdFromPath` predates the thread/container distinction: what it lifts
// out of a rollout file name is the THREAD id (`session_meta.payload.id`), which
// is the only id a rollout name carries. Kept as the shared helper so this
// resolver and the backfill read the same convention out of the same code.
import { sessionIdFromPath } from './backfill.js'

/**
 * @import { RolloutCwdResolver, RolloutCwdResolverOptions, RolloutDirent } from './types.js'
 */

// A negative resolution (no cwd found: the rollout is not yet written on the
// session's first exchange, or a momentary read error) is trusted only briefly
// before it is re-checked, mirroring the usage-policy resolver's 5s TTL. A
// positive cwd is cached for the session's life. Bounding the miss cache this
// way stops a session-start race or a transient EMFILE/EIO from recording
// `cwd = NULL` for a session's whole life, which would silently fail
// `.hypignore` open for that session once the rollout became readable.
const NEGATIVE_CACHE_TTL_MS = 5_000

/**
 * Resolve a Codex **thread's** `cwd` from its rollout file's `session_meta` line.
 *
 * The ChatGPT-subscription route (`provider='chatgpt'`, `/backend-api/codex/*`)
 * carries no in-band cwd (`codex-tui` sends no `x-codex-turn-metadata` header
 * and the subscription protocol has no `metadata.cwd` field), so the live
 * exchange projector would record `cwd = NULL` and `.hypignore` would fail open
 * for the whole traffic class. Codex nonetheless writes `session_meta.cwd` into
 * the rollout (`<sessionsDir>/.../rollout-<ts>-<thread_id>.jsonl`, line 1) at
 * session start, for both auth modes: the same value the codex backfill reads.
 * This resolver gives the live projector that fallback, so folder coverage is
 * client-independent and live rows carry the cwd backfill already sees.
 * @ref LLP 0083 [implements]: rollout is the live cwd fallback for Codex
 *
 * **The lookup key is the THREAD id, never the session container.** A rollout is
 * one thread's file: its name embeds `session_meta.payload.id` (the thread), not
 * `payload.session_id` (the container the gateway partitions and drops on). The
 * two are the same uuid on a root thread and diverge on a subagent one, which is
 * exactly where handing over the container went wrong: a subagent turn resolved
 * the ROOT thread's rollout, so a directory-scoped privacy control was evaluated
 * against a directory the turn never ran in.
 * @ref LLP 0083#decision [implements]: keyed on the thread id, and the located
 * rollout must say so
 *
 * A resolved cwd is cached per thread id for the thread's life; a miss is
 * cached only briefly (`NEGATIVE_CACHE_TTL_MS`) so a not-yet-written or
 * momentarily-unreadable rollout is re-checked on a later exchange rather than
 * fixed at NULL. The scan itself is newest-first and returns on first match, so
 * a resolution touches the filesystem at most once per thread per TTL window:
 * bounded, not one walk per exchange. @ref LLP 0049#requirements R6
 *
 * @param {RolloutCwdResolverOptions} opts
 * @returns {RolloutCwdResolver}
 */
export function createRolloutCwdResolver(opts) {
  const sessionsDir = opts.sessionsDir
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? NEGATIVE_CACHE_TTL_MS
  const readdirSync = opts.readdirSync ?? defaultReaddir
  const log = opts.log
  /** @type {Map<string, { cwd: string | undefined, expiresAt: number }>} */
  const cache = new Map()
  return {
    resolve(threadId) {
      if (typeof threadId !== 'string' || threadId.length === 0) return undefined
      const cached = cache.get(threadId)
      if (cached !== undefined && cached.expiresAt > now()) return cached.cwd
      const cwd = readRolloutCwd(sessionsDir, threadId, readdirSync, log)
      // A resolved cwd is trusted for the thread's life (Infinity); a miss is
      // trusted only for the TTL, so a transient miss is re-resolved instead of
      // becoming a permanent NULL cwd (which fails `.hypignore` open).
      // @ref LLP 0083 [constrained-by]: a transient miss must not fix the cwd at NULL for the thread's life
      cache.set(threadId, { cwd, expiresAt: cwd === undefined ? now() + ttlMs : Infinity })
      return cwd
    },
  }
}

/**
 * Find the rollout whose filename embeds `threadId` (via `sessionIdFromPath`,
 * shared with the backfill) and read its `session_meta.cwd`. Best-effort: a
 * missing sessions root, no matching rollout, an unreadable file, or a first
 * line that is not a `session_meta` record all yield `undefined` (fail open on
 * a genuinely absent rollout, matching the nullable `cwd` column).
 *
 * The header read itself is `readRolloutSessionMeta`, shared with the
 * `hyp session` id resolver: two privacy controls read this one line, and the
 * rules for reading it drifted apart twice while each kept its own copy.
 * @ref LLP 0150 [constrained-by]: one reader for `session_meta`, not one per caller
 *
 * @param {string} sessionsDir
 * @param {string} threadId
 * @param {(dirPath: string, options: { withFileTypes: true }) => RolloutDirent[]} readdirSync
 * @param {{ warn?: (message: string, fields?: Record<string, unknown>) => void }} [log]
 * @returns {string | undefined}
 */
function readRolloutCwd(sessionsDir, threadId, readdirSync, log) {
  const rolloutPath = findRolloutFile(sessionsDir, threadId, readdirSync)
  if (!rolloutPath) return undefined
  // A line that is not a `session_meta` header, and an unreadable or empty
  // file, are one answer: this file establishes nothing.
  const meta = readRolloutSessionMeta(rolloutPath)
  if (!meta) return undefined
  // Identity guard: the file was located by NAME, and the naming convention is
  // Codex's, not ours. Require the body to agree that this rollout records the
  // thread that was asked for, so a renamed, copied, or convention-changed file
  // yields "cwd unknown" rather than letting some OTHER thread's cwd silently
  // decide this turn's `.hypignore` outcome and get stamped on its row. The
  // shared reader takes the id off the RAW JSONL line rather than through
  // Codex's `Deserialize` (LLP 0150 rule 1), which is what makes an absent
  // `payload.id` read as absent here and refuse instead of matching.
  // `meta.sessionId` (`payload.session_id`) is deliberately NOT consulted: the
  // container is not what selects a rollout, and a rollout too old to carry one
  // still records a perfectly good cwd for its thread.
  // @ref LLP 0083#decision [implements]: a filename/body disagreement is a
  // refusal, not a guess
  const rolloutThreadId = meta.threadId
  if (rolloutThreadId !== threadId) {
    // The two refusals have different diagnoses, so they get different
    // `error_kind`s: `thread_id_absent` is the one rollout shape the backfill
    // still accepts (`buildSession` falls back to the filename id), so it points
    // at the live/backfill divergence LLP 0083 records, while
    // `thread_id_mismatch` points at a renamed or copied file. Same message so
    // one query finds both.
    log?.warn?.('plugin.codex.rollout_cwd_thread_mismatch', {
      component: 'codex',
      operation: 'rollout_cwd_resolve',
      status: 'refused',
      error_kind: rolloutThreadId === undefined ? 'thread_id_absent' : 'thread_id_mismatch',
      wanted_thread_id: threadId,
      rollout_thread_id: rolloutThreadId ?? null,
      rollout: path.basename(rolloutPath),
    })
    return undefined
  }
  // `meta.cwd` is already predicated: core's `sessionMetaCwd` refuses a blank or
  // relative `session_meta.cwd`, so a value that arrives here is an absolute
  // path the policy matcher can resolve without supplying a base of its own.
  // @ref LLP 0150#usable-cwd [constrained-by]
  return meta.cwd
}

/**
 * Scan the sessions root for the rollout whose filename embeds `threadId`,
 * newest-first: entries are visited in *descending* name order, so the
 * most-recent date dirs (`…/YYYY/MM/DD`) and rollout files come first. The
 * active session (the common lookup on the capture hot path) lives in the
 * newest date dir, so a typical resolution returns after touching only the
 * newest branch instead of walking the whole history oldest-first. Returns the
 * first match. A missing or unreadable directory contributes nothing rather
 * than throwing, and a genuinely absent rollout still yields `undefined`.
 *
 * The name is a cheap prefilter, not the answer: the caller re-checks the
 * located file's `session_meta.payload.id`, so a name that lies is caught.
 *
 * The directory reader is injected (defaulting to `node:fs`) so tests can count
 * scans and prove the walk stays bounded. @ref LLP 0049#requirements R6
 *
 * @param {string} sessionsDir
 * @param {string} threadId
 * @param {(dirPath: string, options: { withFileTypes: true }) => RolloutDirent[]} readdirSync
 * @returns {string | undefined}
 */
function findRolloutFile(sessionsDir, threadId, readdirSync) {
  /** @type {string[]} */
  const dirs = [sessionsDir]
  while (dirs.length > 0) {
    const dir = dirs.shift()
    if (dir === undefined) break
    /** @type {RolloutDirent[]} */
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    // Descending sort => newest date dirs / rollout files first.
    entries.sort((a, b) => compareStrings(b.name, a.name))
    /** @type {string[]} */
    const subdirs = []
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isFile() && isRolloutFileName(entry.name) && sessionIdFromPath(entry.name) === threadId) {
        return entryPath
      }
      if (entry.isDirectory()) subdirs.push(entryPath)
    }
    // Depth-first, newest subdir first: `subdirs` is already newest→oldest, so
    // unshifting it whole keeps that order at the front of the queue.
    dirs.unshift(...subdirs)
  }
  return undefined
}

/**
 * Default `withFileTypes` directory reader, delegating to `node:fs`. Isolated
 * so the injectable-reader type stays narrow (a `Dirent[]` is a `RolloutDirent[]`).
 *
 * @param {string} dirPath
 * @param {{ withFileTypes: true }} options
 * @returns {RolloutDirent[]}
 */
function defaultReaddir(dirPath, options) {
  return fs.readdirSync(dirPath, options)
}

/** @param {string} name */
function isRolloutFileName(name) {
  return name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith('.json'))
}

// @ts-check

import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPiMessageEntry } from '../../../../packages/pi-extension/index.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { readBackfillPolicy } from '../../../../src/core/config/backfill_policy.js'
import { AI_GATEWAY_MESSAGES_DATASET, projectedExchangeItem, resolveWindow } from '../../../../src/core/backfill/scan_util.js'
import { piEntryFingerprint, piSessionHeader, projectPiEntries } from './projector.js'

/** @import { BackfillContribution, JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */

const MAX_FILES = 10000
const MAX_ENTRIES = 100000
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const MAX_SWEEP_BYTES = 256 * 1024 * 1024

/** Floor between mid-run marker-store reloads. */
export const SESSION_IGNORE_REFRESH_MS = 1000

/** @param {NodeJS.ProcessEnv} env */
export function piSessionsRoot(env) {
  return path.resolve(env.PI_CODING_AGENT_SESSION_DIR ?? path.join(env.PI_CODING_AGENT_DIR ?? path.join(env.HOME ?? os.homedir(), '.pi', 'agent'), 'sessions'))
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, config?: JsonObject, localOnlyListPath?: string, ignoredSessions?: Set<string> }} [opts]
 * @returns {BackfillContribution}
 * @ref LLP 0416#bounds: bounded streaming with success-only process-local fingerprints
 */
export function createPiBackfillProvider(opts = {}) {
  const fingerprints = new Map()
  let nextFile = ''
  const policy = readBackfillPolicy({ name: '@hypaware/pi', config: opts.config })
  const backfill = /** @type {any} */ (opts.config?.backfill)
  return {
    name: 'pi', plugin: '@hypaware/pi', datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import persisted Pi session entries',
    ...(policy.onJoin !== false ? { sweep: { cron: backfill?.sweep_cron ?? '*/5 * * * *' } } : {}),
    async *run(ctx) {
      refreshSessionIgnores(opts.ignoredSessions)
      if (sessionIgnoreLoadError(opts.ignoredSessions)) throw new Error('Pi session exclusions are unreadable')
      let ignoresLoadedAtMs = Date.now()
      // @ref LLP 0403#backfill [constrained-by]: an import in flight may use
      //   its run-start snapshot, so a mid-run reload buys prompt opt-out
      //   rather than meeting a contract. Each one is a synchronous directory
      //   walk plus a stat, read and hash per marker, so a floor between them
      //   keeps that cost off the daemon loop as entries and exclusions grow.
      const refreshIgnoresThrottled = () => {
        const now = Date.now()
        const sinceMs = now - ignoresLoadedAtMs
        // A backwards wall-clock step cannot prove the window, so reload.
        if (sinceMs >= 0 && sinceMs < SESSION_IGNORE_REFRESH_MS) return
        // Armed on the attempt: a failed load keeps capture off until a
        // complete valid one, and retrying that per flush is the cost this
        // floor exists to bound.
        ignoresLoadedAtMs = now
        refreshSessionIgnores(opts.ignoredSessions)
      }
      const resolver = createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
      const root = piSessionsRoot(opts.env ?? ctx.env)
      const window = resolveWindow(ctx)
      const files = []
      for await (const file of sessionFiles(root)) {
        if (ctx.signal?.aborted) return
        files.push(file)
      }
      files.sort()
      const found = new Set(files)
      // Prune before processing: cancellation or a failed scan must not let
      // deleted-file fingerprints accumulate across runs.
      for (const file of fingerprints.keys()) if (!found.has(file)) fingerprints.delete(file)
      const start = ctx.sweep ? Math.max(0, files.findIndex(file => file >= nextFile)) : 0
      let scanBytes = 0
      let deferred = false
      const budgetExceeded = new Error('sweep_budget')
      /** @param {number} bytes */
      const reserve = bytes => {
        if (ctx.sweep && scanBytes + bytes > MAX_SWEEP_BYTES) throw budgetExceeded
        scanBytes += bytes
      }
      let read = 0
      let unchanged = 0
      let failed = 0
      let dropped = 0
      for (let index = 0; index < files.length; index++) {
        if (ctx.signal?.aborted) return
        const file = files[(start + index) % files.length]
        if (ctx.sweep) nextFile = file
        try {
          const stat = await fs.lstat(file)
          const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}`
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('file_budget')
          if (window.sinceMs !== undefined && stat.mtimeMs < window.sinceMs) continue
          if (ctx.sweep && fingerprints.get(file) === fingerprint) { unchanged++; continue }
          reserve(stat.size)
          read++
          let session
          let inherited = new Map()
          let batch = []
          let positions = []
          let nextMessage = 0
          let batchBytes = 0
          let entries = 0
          let skipped = false
          const failures = ctx.itemsFailed
          for await (const { entry, bytes } of readPiLines(file, stat.size)) {
            if (ctx.signal?.aborted) return
            if (!session) {
              session = piSessionHeader(entry)
              if (!session) throw new Error('unsupported_header')
              if (opts.ignoredSessions?.has(String(session.id)) || resolver.resolve(String(session.cwd)).class === 'ignore') {
                dropped++
                skipped = true
                break
              }
              if (session.parentSession) {
                const parent = String(session.parentSession)
                if (!path.isAbsolute(parent)) throw new Error('fork_parent_path')
                const real = await fs.realpath(parent)
                const realRoot = await fs.realpath(root)
                if (!real.startsWith(realRoot + path.sep) || real === await fs.realpath(file)) throw new Error('fork_parent_outside_root')
                const parentStat = await fs.stat(real)
                if (!parentStat.isFile() || parentStat.size > MAX_FILE_BYTES) throw new Error('fork_parent_budget')
                reserve(parentStat.size)
                let header
                let parentEntries = 0
                for await (const { entry: previous } of readPiLines(real, parentStat.size)) {
                  if (ctx.signal?.aborted) return
                  if (!header) {
                    header = piSessionHeader(previous)
                    if (!header || opts.ignoredSessions?.has(String(header.id)) || resolver.resolve(String(header.cwd)).class === 'ignore') throw new Error('fork_parent_unavailable')
                    continue
                  }
                  if (++parentEntries > MAX_ENTRIES) throw new Error('fork_parent_budget')
                  if (typeof previous.id === 'string') inherited.set(previous.id, piEntryFingerprint(previous))
                }
                if (!header) throw new Error('fork_parent_unavailable')
              }
              continue
            }
            if (++entries > MAX_ENTRIES) throw new Error('entry_budget')
            const messageIndex = nextMessage
            if (isPiMessageEntry(entry)) nextMessage++
            const timestamp = Date.parse(entry.timestamp)
            if (window.sinceMs !== undefined && timestamp < window.sinceMs) continue
            if (window.untilMs !== undefined && timestamp > window.untilMs) continue
            if (batch.length && (batch.length >= 64 || batchBytes + bytes > MAX_LINE_BYTES)) {
              refreshIgnoresThrottled()
              if (sessionIgnoreLoadError(opts.ignoredSessions) || opts.ignoredSessions?.has(String(session.id)) || resolver.resolve(String(session.cwd)).class === 'ignore') { skipped = true; dropped++; break }
              const projection = projectPiEntries({ session, entries: batch, message_indices: positions }, { inherited })
              if (projection) yield projectedExchangeItem(projection, { client_name: 'pi', source_path: file, native_id: String(session.id) })
              batch = []
              positions = []
              batchBytes = 0
            }
            batch.push(entry)
            positions.push(messageIndex)
            batchBytes += bytes
          }
          refreshIgnoresThrottled()
          if (session && !skipped && !sessionIgnoreLoadError(opts.ignoredSessions) && !opts.ignoredSessions?.has(String(session.id)) && resolver.resolve(String(session.cwd)).class !== 'ignore') {
            const projection = projectPiEntries({ session, entries: batch, message_indices: positions }, { inherited })
            if (projection) yield projectedExchangeItem(projection, { client_name: 'pi', source_path: file, native_id: String(session.id) })
            if (!ctx.dryRun && ctx.itemsFailed === failures) fingerprints.set(file, fingerprint)
          }
        } catch (err) {
          if (err === budgetExceeded) { deferred = true; break }
          failed++
          // Files and parse errors can contain customer data. Report the class only.
          ctx.log.warn('pi.backfill.file_failed', { component: 'plugin.pi', operation: 'backfill.read', status: 'failed', error_kind: err instanceof SyntaxError ? 'invalid_jsonl' : 'session_unavailable_or_over_budget' })
          yield { type: 'event', event: 'file_failed', attributes: { client_name: 'pi', error_kind: 'session_unavailable_or_over_budget' } }
        }
      }
      if (deferred) yield { type: 'event', event: 'scan_deferred', attributes: { client_name: 'pi', reason: 'sweep_byte_budget' } }
      ctx.log.info('pi.backfill.scan', { component: 'plugin.pi', operation: 'backfill.scan', status: failed || deferred ? 'partial' : 'ok', files_read: read, files_unchanged: unchanged, files_failed: failed, policy_drops: dropped, scan_bytes_reserved: scanBytes, scan_deferred: deferred, fingerprint_count: fingerprints.size })
    },
  }
}

/** Default Pi layout is one directory per cwd; custom roots may contain files directly. @param {string} root */
async function* sessionFiles(root) {
  let count = 0
  const dirs = [root]
  for (const dir of dirs) {
    let handle
    try { handle = await fs.opendir(dir) } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue
      throw err
    }
    for await (const entry of handle) {
      if (++count > MAX_FILES) throw new Error('Pi discovery exceeds 10000 entries')
      if (entry.isDirectory() && dir === root) dirs.push(path.join(dir, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path.join(dir, entry.name)
    }
  }
}

/** LF-only framing, bounded even for an unterminated line. @param {string} file @param {number} size */
export async function* readPiLines(file, size) {
  if (!size) return
  const stream = createReadStream(file, { end: size - 1, highWaterMark: 64 * 1024 })
  /** @type {Buffer[]} */
  let fragments = []
  let bytes = 0
  try {
    for await (const chunk of stream) {
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline < 0 ? chunk.length : newline
        const fragment = chunk.subarray(start, end)
        bytes += fragment.length
        if (bytes > MAX_LINE_BYTES) throw new Error('line_budget')
        if (newline < 0) { fragments.push(fragment); break }
        const text = fragments.length
          ? Buffer.concat([...fragments, fragment], bytes).toString('utf8')
          : fragment.toString('utf8')
        const lineBytes = bytes
        fragments = []
        bytes = 0
        start = end + 1
        if (!text.trim()) continue
        const value = JSON.parse(text)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_entry')
        yield { entry: value, bytes: lineBytes }
      }
    }
    // An append in progress is retried when the fingerprint changes.
  } finally { stream.destroy() }
}

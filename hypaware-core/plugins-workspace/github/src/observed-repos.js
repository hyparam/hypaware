// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { repoKey, repoKeyFromRemote } from './keys.js'

/** @import { CachePartitionMeta, LocalObservedRepoState, ObservedRepoRevalidationState, ObservedReposIndex, PluginLogger, QueryStorageService, SinkContinuation } from './types.js' */

const DATASET = 'ai_gateway_messages'
const STATE_FILE = 'github-observed-repos.json'
const SCHEMA_VERSION = 1

// Fixed implementation policy, not a user configuration surface (the same
// stance as LLP 0361's 400-request capture budget): one revalidation slice
// examines at most this many streamed evidence rows before persisting its
// cursor and yielding to the next tick.
// @ref LLP 0367#bounded-revalidation [implements]: the per-tick revalidation row budget
const REVALIDATION_ROW_BUDGET = 50_000

// Backstop cadence for policy inputs the fingerprint cannot see (committable
// `.hypignore` dotfiles are unenumerable, LLP 0367#policy-fingerprint).
const REVALIDATION_MAX_AGE_MS = 7 * 24 * 60 * 60_000

/**
 * Build the local repository index for the default session inventory. The
 * export-seam reader keeps local-only and client-opted-out evidence from
 * producing provenance-free GitHub rows that could later sync. The first
 * narrow history scan is cached; later calls read only rows beyond each
 * partition continuation.
 *
 * The cached set is not admission-time-only: when the withholding policy
 * changes, evidence partitions regress or disappear, or the last derivation
 * is old, the index re-derives its repositories from history under a bounded
 * resumable row budget, and while that pass is incomplete `list()` returns
 * only the repositories the pass has re-confirmed.
 *
 * @ref LLP 0360#inventory [implements]: export-eligible session evidence supplies the default local repository inventory
 * @ref LLP 0367#triggers [implements]: triggers are re-derived from persisted state every tick, never stored as events
 *
 * @param {{
 *   storage: QueryStorageService,
 *   stateDir: string,
 *   log?: PluginLogger,
 *   revalidationRowBudget?: number,
 *   revalidationMaxAgeMs?: number,
 *   now?: () => number,
 * }} args
 * @returns {ObservedReposIndex}
 */
export function createLocalObservedReposIndex({ storage, stateDir, log, revalidationRowBudget, revalidationMaxAgeMs, now = Date.now }) {
  const rowBudget = Math.max(1, revalidationRowBudget ?? REVALIDATION_ROW_BUDGET)
  const maxAgeMs = revalidationMaxAgeMs ?? REVALIDATION_MAX_AGE_MS
  let state = readState(stateDir)
  /** @type {Promise<void> | null} */
  let updating = null

  /** @param {string} name @param {Record<string, unknown>} fields */
  function emit(name, fields) {
    log?.info(name, fields)
  }

  async function update() {
    const fingerprint = storage.exportPolicyFingerprint?.() ?? 'none'
    const discovered = await storage.discoverCachePartitions({ datasets: [DATASET] })
    /** @type {Map<string, CachePartitionMeta>} */
    const discoveredByPath = new Map()
    for (const part of discovered) {
      if (part.dataset === DATASET && typeof part.path === 'string' && part.path !== '') {
        discoveredByPath.set(part.path, part)
      }
    }
    const paths = [...discoveredByPath.keys()].sort()
    /** @type {LocalObservedRepoState} */
    const next = {
      schema_version: SCHEMA_VERSION,
      repos: [...state.repos],
      partitions: { ...state.partitions },
      partition_versions: { ...state.partition_versions },
      ...(state.policy_fingerprint !== undefined ? { policy_fingerprint: state.policy_fingerprint } : {}),
      ...(state.revalidated_at !== undefined ? { revalidated_at: state.revalidated_at } : {}),
      ...(state.revalidation !== undefined ? { revalidation: cloneRevalidation(state.revalidation) } : {}),
    }
    let changed = false

    // A policy change mid-pass restarts the pass: repositories confirmed
    // under the abandoned fingerprint prove nothing about the new one.
    if (next.revalidation && next.revalidation.fingerprint !== fingerprint) {
      delete next.revalidation
      changed = true
    }
    if (!next.revalidation) {
      const trigger = revalidationTrigger(next, fingerprint, discoveredByPath)
      if (trigger !== null) {
        next.revalidation = { fingerprint, repos: [], partitions: {}, done: [], versions: {} }
        changed = true
        emit('github.observed_repos_revalidation_started', {
          operation: 'observed_repos_revalidate',
          trigger,
          repos: next.repos.length,
          partitions: paths.length,
        })
      }
    }

    if (next.revalidation) {
      await revalidateSlice(next, paths, discoveredByPath)
      changed = true
    } else {
      changed = (await incrementalScan(next, paths, discoveredByPath)) || changed
      if (next.policy_fingerprint !== fingerprint) {
        // Only a pristine sidecar reaches here with a mismatch (a tracked one
        // triggers a revalidation instead). Its build above admitted every
        // row through the live seam, so the result is already valid for the
        // current fingerprint.
        next.policy_fingerprint = fingerprint
        next.revalidated_at = new Date(now()).toISOString()
        changed = true
      }
    }
    if (changed) writeState(stateDir, next)
    state = next
  }

  /**
   * Whether a full re-derivation must start, and why. `null` on the ordinary
   * tick: fingerprint match, no partition regression, derivation fresh. A
   * pristine sidecar (nothing tracked) never triggers: its first build IS the
   * derivation.
   *
   * @param {LocalObservedRepoState} next
   * @param {string} fingerprint
   * @param {Map<string, CachePartitionMeta>} discoveredByPath
   * @returns {string | null}
   */
  function revalidationTrigger(next, fingerprint, discoveredByPath) {
    const tracked =
      next.repos.length > 0 ||
      Object.keys(next.partitions).length > 0 ||
      Object.keys(next.partition_versions).length > 0
    if (!tracked) return null
    // Covers a pre-fingerprint sidecar too: `undefined` never equals a digest.
    if (next.policy_fingerprint !== fingerprint) return 'policy_changed'
    // Purge recomputes a partition's `rowCount` from the live post-delete
    // count and retention can evict a partition whole, so both evidence
    // removals surface here on the discover pass every tick already performs.
    // Row-count growth is ordinary appends; the incremental path handles it.
    for (const [tablePath, stored] of Object.entries(next.partition_versions)) {
      const meta = discoveredByPath.get(tablePath)
      if (!meta) return 'partition_removed'
      const version = partitionVersion(meta)
      if (version === null || version === stored) continue
      const [storedEpoch, storedRows] = stored.split(':').map(Number)
      const [epoch, rows] = version.split(':').map(Number)
      if (epoch !== storedEpoch || rows < storedRows) return 'partition_regressed'
    }
    for (const tablePath of Object.keys(next.partitions)) {
      if (!discoveredByPath.has(tablePath)) return 'partition_removed'
    }
    const last = next.revalidated_at === undefined ? NaN : Date.parse(next.revalidated_at)
    if (!Number.isFinite(last) || now() - last > maxAgeMs) return 'stale'
    return null
  }

  /**
   * The ordinary tick: read only rows beyond each partition continuation,
   * skipping partitions whose `epoch:rowCount` version is unchanged. Zero
   * history reads when nothing changed.
   *
   * @param {LocalObservedRepoState} next
   * @param {string[]} paths
   * @param {Map<string, CachePartitionMeta>} discoveredByPath
   * @returns {Promise<boolean>}
   */
  async function incrementalScan(next, paths, discoveredByPath) {
    let changed = false
    const repos = new Set(next.repos)
    for (const tablePath of paths) {
      const version = partitionVersion(/** @type {CachePartitionMeta} */ (discoveredByPath.get(tablePath)))
      if (version !== null && next.partition_versions[tablePath] === version) continue
      const since = next.partitions[tablePath]
      let after = since
      for await (const item of storage.readRowsSince(tablePath, {
        since,
        columns: ['git_remote'],
        includeLegacy: since === undefined,
      })) {
        after = item.after
        if (item.dropped) continue
        const repo = repoKeyFromRemote(item.row.git_remote)
        if (repo && !repos.has(repo)) {
          repos.add(repo)
          changed = true
        }
      }
      if (after !== undefined && !sameContinuation(next.partitions[tablePath], after)) {
        next.partitions[tablePath] = after
        changed = true
      }
      if (version !== null && next.partition_versions[tablePath] !== version) {
        next.partition_versions[tablePath] = version
        changed = true
      } else if (version === null && Object.hasOwn(next.partition_versions, tablePath)) {
        delete next.partition_versions[tablePath]
        changed = true
      }
    }
    next.repos = [...repos].sort()
    return changed
  }

  /**
   * One budgeted slice of a re-derivation pass. Streams each remaining
   * partition's evidence from its pass continuation through the live export
   * seam, reducing rows to `owner/repo` keys immediately; nothing retained
   * scales with row count. Persistable progress (confirmed repos, per-
   * partition continuations, completed partitions) lives on the revalidation
   * record, so a later tick or a restarted daemon resumes mid-partition. Only
   * a fully completed pass swaps the derived set.
   *
   * @ref LLP 0367#bounded-revalidation [implements]: budgeted, resumable, streaming re-derivation with an atomic swap
   * @ref LLP 0367#conservative [implements]: the swap is what re-admits; until then `list()` serves only the pass's confirmed repos
   * @param {LocalObservedRepoState} next
   * @param {string[]} paths
   * @param {Map<string, CachePartitionMeta>} discoveredByPath
   * @returns {Promise<void>}
   */
  async function revalidateSlice(next, paths, discoveredByPath) {
    const reval = /** @type {ObservedRepoRevalidationState} */ (next.revalidation)
    const confirmed = new Set(reval.repos)
    const done = new Set(reval.done)
    let rowsRead = 0
    let budgetExhausted = false
    for (const tablePath of paths) {
      if (done.has(tablePath)) continue
      if (budgetExhausted) break
      const version = partitionVersion(/** @type {CachePartitionMeta} */ (discoveredByPath.get(tablePath)))
      const since = reval.partitions[tablePath]
      let after = since
      for await (const item of storage.readRowsSince(tablePath, {
        since,
        columns: ['git_remote'],
        includeLegacy: since === undefined,
      })) {
        after = item.after
        rowsRead += 1
        if (!item.dropped) {
          const repo = repoKeyFromRemote(item.row.git_remote)
          if (repo) confirmed.add(repo)
        }
        if (rowsRead >= rowBudget) {
          budgetExhausted = true
          break
        }
      }
      if (after !== undefined) reval.partitions[tablePath] = after
      if (!budgetExhausted) {
        done.add(tablePath)
        // The version observed before reading, so rows appended between the
        // discover and the read re-surface as an ordinary version mismatch
        // after the swap (a duplicate examination, never a skipped row).
        if (version !== null) reval.versions[tablePath] = version
        else delete reval.versions[tablePath]
      }
    }
    reval.repos = [...confirmed].sort()
    reval.done = [...done].sort()
    if (paths.every((p) => done.has(p))) {
      const retired = next.repos.filter((repo) => !confirmed.has(repo)).length
      const pathSet = new Set(paths)
      next.repos = reval.repos
      next.partitions = pickPaths(reval.partitions, pathSet)
      next.partition_versions = pickPaths(reval.versions, pathSet)
      next.policy_fingerprint = reval.fingerprint
      next.revalidated_at = new Date(now()).toISOString()
      delete next.revalidation
      emit('github.observed_repos_revalidation_completed', {
        operation: 'observed_repos_revalidate',
        status: 'ok',
        rows_read: rowsRead,
        repos_confirmed: confirmed.size,
        repos_retired: retired,
      })
    } else {
      emit('github.observed_repos_revalidation_progress', {
        operation: 'observed_repos_revalidate',
        status: 'pending',
        rows_read: rowsRead,
        row_budget: rowBudget,
        partitions_done: done.size,
        partitions_total: paths.length,
        repos_confirmed: confirmed.size,
      })
    }
  }

  return {
    async list() {
      if (!updating) updating = update().finally(() => { updating = null })
      await updating
      return state.revalidation ? [...state.revalidation.repos] : [...state.repos]
    },
    revalidationPending() {
      return state.revalidation !== undefined
    },
  }
}

/** @param {string} stateDir @returns {LocalObservedRepoState} */
function readState(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILE), 'utf8'))
    if (!raw || raw.schema_version !== SCHEMA_VERSION || !Array.isArray(raw.repos) || !raw.partitions || typeof raw.partitions !== 'object') return emptyState()
    const repos = new Set()
    for (const value of raw.repos) {
      const repo = repoKey(value)
      if (repo) repos.add(repo)
    }
    const partitions = readContinuations(raw.partitions)
    const partitionVersions = readVersions(raw.partition_versions)
    const fingerprint = typeof raw.policy_fingerprint === 'string' && raw.policy_fingerprint !== '' ? raw.policy_fingerprint : undefined
    const revalidatedAt = typeof raw.revalidated_at === 'string' && raw.revalidated_at !== '' ? raw.revalidated_at : undefined
    // A malformed in-progress record is dropped, never repaired: the pass
    // restarts because its trigger re-derives from the kept fields.
    const revalidation = readRevalidation(raw.revalidation)
    return {
      schema_version: SCHEMA_VERSION,
      repos: [...repos].sort(),
      partitions,
      partition_versions: partitionVersions,
      ...(fingerprint !== undefined ? { policy_fingerprint: fingerprint } : {}),
      ...(revalidatedAt !== undefined ? { revalidated_at: revalidatedAt } : {}),
      ...(revalidation !== null ? { revalidation } : {}),
    }
  } catch {
    return emptyState()
  }
}

/** @param {unknown} value @returns {ObservedRepoRevalidationState | null} */
function readRevalidation(value) {
  if (!value || typeof value !== 'object') return null
  const raw = /** @type {Record<string, unknown>} */ (value)
  if (typeof raw.fingerprint !== 'string' || raw.fingerprint === '') return null
  if (!Array.isArray(raw.repos) || !Array.isArray(raw.done) || !raw.partitions || typeof raw.partitions !== 'object') return null
  const repos = new Set()
  for (const entry of raw.repos) {
    const repo = repoKey(entry)
    if (repo) repos.add(repo)
  }
  const done = [...new Set(raw.done.filter((entry) => typeof entry === 'string' && entry !== ''))].sort()
  return {
    fingerprint: raw.fingerprint,
    repos: [...repos].sort(),
    partitions: readContinuations(raw.partitions),
    done: /** @type {string[]} */ (done),
    versions: readVersions(raw.versions),
  }
}

/** @param {ObservedRepoRevalidationState} reval @returns {ObservedRepoRevalidationState} */
function cloneRevalidation(reval) {
  return {
    fingerprint: reval.fingerprint,
    repos: [...reval.repos],
    partitions: { ...reval.partitions },
    done: [...reval.done],
    versions: { ...reval.versions },
  }
}

/** @param {unknown} value @returns {Record<string, SinkContinuation>} */
function readContinuations(value) {
  /** @type {Record<string, SinkContinuation>} */
  const out = {}
  if (!value || typeof value !== 'object') return out
  for (const [tablePath, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const cursor = readContinuation(entry)
    if (cursor) out[tablePath] = cursor
  }
  return out
}

/** @param {unknown} value @returns {Record<string, string>} */
function readVersions(value) {
  /** @type {Record<string, string>} */
  const out = {}
  if (!value || typeof value !== 'object') return out
  for (const [tablePath, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (typeof entry === 'string' && /^\d+:\d+$/.test(entry)) out[tablePath] = entry
  }
  return out
}

/**
 * @template {SinkContinuation | string} T
 * @param {Record<string, T>} record
 * @param {Set<string>} paths
 * @returns {Record<string, T>}
 */
function pickPaths(record, paths) {
  /** @type {Record<string, T>} */
  const out = {}
  for (const [tablePath, value] of Object.entries(record)) {
    if (paths.has(tablePath)) out[tablePath] = value
  }
  return out
}

/** @param {string} stateDir @param {LocalObservedRepoState} state */
function writeState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, STATE_FILE)
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

/** @returns {LocalObservedRepoState} */
function emptyState() {
  return { schema_version: SCHEMA_VERSION, repos: [], partitions: {}, partition_versions: {} }
}

/** @param {CachePartitionMeta} part @returns {string | null} */
function partitionVersion(part) {
  if (!Number.isSafeInteger(part.epoch) || part.epoch < 0) return null
  if (!Number.isSafeInteger(part.rowCount) || part.rowCount < 0) return null
  return `${part.epoch}:${part.rowCount}`
}

/** @param {SinkContinuation | undefined} left @param {SinkContinuation} right */
function sameContinuation(left, right) {
  return left?.v === right.v && left.seq === right.seq
}

/** @param {unknown} value @returns {SinkContinuation | null} */
function readContinuation(value) {
  if (!value || typeof value !== 'object') return null
  const cursor = /** @type {Record<string, unknown>} */ (value)
  if (cursor.v !== 1 || typeof cursor.seq !== 'string' || !/^\d+$/.test(cursor.seq)) return null
  return { v: 1, seq: cursor.seq }
}

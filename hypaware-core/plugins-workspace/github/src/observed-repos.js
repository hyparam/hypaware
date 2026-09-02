// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { repoKey, repoKeyFromRemote } from './keys.js'

/** @import { CachePartitionMeta, LocalObservedRepoState, ObservedReposIndex, QueryStorageService, SinkContinuation } from './types.js' */

const DATASET = 'ai_gateway_messages'
const STATE_FILE = 'github-observed-repos.json'
const SCHEMA_VERSION = 1

/**
 * Build the local repository index for the default session inventory. The
 * export-seam reader keeps local-only and client-opted-out evidence from
 * producing provenance-free GitHub rows that could later sync. The first
 * narrow history scan is cached; later calls read only rows beyond each
 * partition continuation.
 *
 * @ref LLP 0360#inventory [implements]: export-eligible session evidence supplies the default local repository inventory
 *
 * @param {{ storage: QueryStorageService, stateDir: string }} args
 * @returns {ObservedReposIndex}
 */
export function createLocalObservedReposIndex({ storage, stateDir }) {
  let state = readState(stateDir)
  /** @type {Promise<void> | null} */
  let updating = null

  async function update() {
    const discovered = await storage.discoverCachePartitions({ datasets: [DATASET] })
    /** @type {Map<string, CachePartitionMeta>} */
    const discoveredByPath = new Map()
    for (const part of discovered) {
      if (part.dataset === DATASET && typeof part.path === 'string' && part.path !== '') {
        discoveredByPath.set(part.path, part)
      }
    }
    const paths = [...discoveredByPath.keys()].sort()
    const pathSet = new Set(paths)
    /** @type {LocalObservedRepoState} */
    const next = {
      schema_version: SCHEMA_VERSION,
      repos: [...state.repos],
      partitions: { ...state.partitions },
      partition_versions: { ...state.partition_versions },
    }
    const repos = new Set(next.repos)
    let changed = false

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
    for (const tablePath of Object.keys(next.partitions)) {
      if (!pathSet.has(tablePath)) {
        delete next.partitions[tablePath]
        changed = true
      }
    }
    for (const tablePath of Object.keys(next.partition_versions)) {
      if (!pathSet.has(tablePath)) {
        delete next.partition_versions[tablePath]
        changed = true
      }
    }
    next.repos = [...repos].sort()
    if (changed) writeState(stateDir, next)
    state = next
  }

  return {
    async list() {
      if (!updating) updating = update().finally(() => { updating = null })
      await updating
      return [...state.repos]
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
    /** @type {Record<string, SinkContinuation>} */
    const partitions = {}
    for (const [tablePath, value] of Object.entries(raw.partitions)) {
      const cursor = readContinuation(value)
      if (cursor) partitions[tablePath] = cursor
    }
    /** @type {Record<string, string>} */
    const partitionVersions = {}
    if (raw.partition_versions && typeof raw.partition_versions === 'object') {
      for (const [tablePath, value] of Object.entries(raw.partition_versions)) {
        if (typeof value === 'string' && /^\d+:\d+$/.test(value)) partitionVersions[tablePath] = value
      }
    }
    return { schema_version: SCHEMA_VERSION, repos: [...repos].sort(), partitions, partition_versions: partitionVersions }
  } catch {
    return emptyState()
  }
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

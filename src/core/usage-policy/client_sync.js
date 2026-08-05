// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteJson, readFileIfExists } from '../util/fs_atomic.js'

/**
 * @import { ClientSyncEntry } from '../../../src/core/usage-policy/types.js'
 */

const CLIENT_SYNC_SUBDIR = 'usage-policy'
const CLIENT_SYNC_FILENAME = 'client-sync.json'

export const CLIENT_SYNC_LIST_VERSION = 1

const CLIENT_SYNC_CLASSES = new Set(['local-only'])

/** `error_kind` carried by {@link ClientSyncListUnreadableError}. */
export const CLIENT_SYNC_LIST_UNREADABLE_ERROR_KIND = 'client_sync_list_unreadable'

/**
 * Thrown when the machine-local `client-sync.json` file exists but cannot be
 * read or parsed as the recognized list shape (missing is not an error: that
 * case returns `null`, see {@link readClientSyncEntries}). An uninterpretable
 * privacy signal must never be silently treated as "nothing opted out", so
 * callers (the export-seam resolver, `hyp status`) are expected to let this
 * propagate rather than swallow it, exactly as the sibling directory list
 * does.
 *
 * @ref LLP 0049#fail-safe [constrained-by]: an uninterpretable privacy signal resolves to "suppress more", never to "no exclusions"
 */
export class ClientSyncListUnreadableError extends Error {
  /**
   * @param {string} filePath
   * @param {{ cause?: unknown }} [options]
   */
  constructor(filePath, options) {
    super(`client-sync list at '${filePath}' is unreadable or malformed`, options)
    this.name = 'ClientSyncListUnreadableError'
    this.error_kind = CLIENT_SYNC_LIST_UNREADABLE_ERROR_KIND
    this.filePath = filePath
  }
}

/**
 * Path of the machine-local per-client sync opt-out list: `HYP_HOME` state,
 * beside the directory-scoped `local-only.json`, so it survives cache
 * rebuilds and `hyp leave`, never a repo dotfile and never layered/central
 * config.
 *
 * @ref LLP 0188#opt-out [implements]: the opt-out list is one machine-local file under HYP_HOME state
 * @param {string} stateDir `readObservabilityEnv(env).stateDir`
 * @returns {string}
 */
export function clientSyncListPath(stateDir) {
  if (!stateDir) throw new Error('clientSyncListPath: stateDir is required')
  return path.join(stateDir, CLIENT_SYNC_SUBDIR, CLIENT_SYNC_FILENAME)
}

/**
 * Normalize a raw entry list into the canonical on-disk form: one entry per
 * `source` (a later duplicate wins over an earlier one, so callers can
 * express "upsert" as append + normalize), sorted by `source`.
 *
 * @param {readonly ClientSyncEntry[]} entries
 * @returns {ClientSyncEntry[]}
 */
function normalizeEntries(entries) {
  const bySource = new Map()
  for (const entry of entries) bySource.set(entry.source, entry.class)
  return [...bySource.entries()]
    .map(([source, cls]) => ({ source, class: cls }))
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
}

/**
 * Parse a raw parsed-JSON value into a normalized entry list. Returns `null`
 * when `parsed` does not match the version-1 shape, so the caller can fail
 * safe.
 *
 * @param {unknown} parsed
 * @returns {ClientSyncEntry[] | null}
 */
function parseListShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = /** @type {{ version?: unknown, entries?: unknown }} */ (parsed)
  if (candidate.version !== CLIENT_SYNC_LIST_VERSION) return null
  if (!Array.isArray(candidate.entries)) return null
  const valid = candidate.entries.every((/** @type {unknown} */ entry) => {
    if (entry === null || typeof entry !== 'object') return false
    const { source, class: cls } = /** @type {{ source?: unknown, class?: unknown }} */ (entry)
    return typeof source === 'string' && source !== '' && typeof cls === 'string' && CLIENT_SYNC_CLASSES.has(cls)
  })
  if (!valid) return null
  return normalizeEntries(/** @type {ClientSyncEntry[]} */ (candidate.entries))
}

/**
 * Read the machine-local client-sync opt-out list. A missing file returns
 * `null`, NOT `[]`: absence is the LLP 0188 migration marker (a machine that
 * enrolled before the default-sync flip has no file, and the boot migration
 * materializes its derived withheld set), so callers must be able to tell
 * "never stamped" from "stamped, nothing opted out". A present-but-unreadable
 * or unparseable file throws {@link ClientSyncListUnreadableError} rather
 * than silently resolving to empty.
 *
 * @ref LLP 0188#migration [implements]: store absence is the migration marker, so absent reads as null, never as empty
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<ClientSyncEntry[] | null>}
 */
export async function readClientSyncEntries({ stateDir, fs = fsp }) {
  const filePath = clientSyncListPath(stateDir)
  let raw
  try {
    raw = await readFileIfExists(filePath, { fs })
  } catch (err) {
    throw new ClientSyncListUnreadableError(filePath, { cause: err })
  }
  if (raw === null) return null

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ClientSyncListUnreadableError(filePath, { cause: err })
  }
  const entries = parseListShape(parsed)
  if (entries === null) throw new ClientSyncListUnreadableError(filePath)
  return entries
}

/**
 * Write the machine-local client-sync opt-out list: normalize (deduped-by-
 * source/sorted), `mkdir -p` the parent, then an atomic temp-file + rename,
 * so a crash mid-write never leaves a torn or half-written list.
 *
 * @param {{ stateDir: string, entries: readonly ClientSyncEntry[], fs?: typeof fsp }} opts
 * @returns {Promise<ClientSyncEntry[]>}
 */
export async function writeClientSyncEntries({ stateDir, entries, fs }) {
  const filePath = clientSyncListPath(stateDir)
  const normalized = normalizeEntries(entries)
  /** @type {{ version: 1, entries: ClientSyncEntry[] }} */
  const file = { version: CLIENT_SYNC_LIST_VERSION, entries: normalized }
  await atomicWriteJson(filePath, file, fs ? { fs } : undefined)
  return normalized
}

/**
 * The opted-out picker source ids in an entry list (every entry is
 * `local-only` today; the class field exists for shape symmetry with the
 * directory list).
 *
 * @param {readonly ClientSyncEntry[] | null} entries
 * @returns {string[]}
 */
export function optedOutClientSourceIds(entries) {
  if (!entries) return []
  return entries.filter((entry) => entry.class === 'local-only').map((entry) => entry.source)
}

/**
 * Stamp an empty client-sync store if none exists, and report whether this
 * call wrote it. Enrollment calls this before writing the central seed so a
 * freshly enrolled machine is marked new-era (default-sync) before any boot
 * can see a central layer with no store and run the upgrade migration
 * (LLP 0188#migration ordering).
 *
 * @ref LLP 0188#migration [implements]: enrollment seeds the empty store before the central seed exists
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<boolean>} true when this call created the store
 */
export async function seedClientSyncStoreIfAbsent({ stateDir, fs = fsp }) {
  const existing = await readClientSyncEntries({ stateDir, fs })
  if (existing !== null) return false
  await writeClientSyncEntries({ stateDir, entries: [], fs })
  return true
}

// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteJson, readFileIfExists } from '../util/fs_atomic.js'

/**
 * @import { LocalOnlyEntry, UsageClass } from '../../../src/core/usage-policy/types.js'
 */

const LOCAL_ONLY_SUBDIR = 'usage-policy'
const LOCAL_ONLY_FILENAME = 'local-only.json'
const LOCAL_ONLY_LIST_VERSION = 2

const USAGE_CLASSES = new Set(['ignore', 'local-only', 'full'])

/** `error_kind` carried by {@link LocalOnlyListUnreadableError} (LLP 0080 #fail-safe). */
export const LOCAL_ONLY_LIST_UNREADABLE_ERROR_KIND = 'local_only_list_unreadable'

/**
 * Thrown when the machine-local `local-only.json` file exists but cannot be
 * read or parsed as a recognized list shape (missing is not an error: that
 * case returns `[]`). An uninterpretable privacy signal must never be
 * silently treated as "no exclusions", so callers (the export-seam resolver,
 * `hyp status`) are expected to let this propagate rather than swallow it.
 *
 * @ref LLP 0080#fail-safe [implements]: a corrupt list fails loudly, naming the file, rather than resolving to empty
 */
export class LocalOnlyListUnreadableError extends Error {
  /**
   * @param {string} filePath
   * @param {{ cause?: unknown }} [options]
   */
  constructor(filePath, options) {
    super(`local-only list at '${filePath}' is unreadable or malformed`, options)
    this.name = 'LocalOnlyListUnreadableError'
    this.error_kind = LOCAL_ONLY_LIST_UNREADABLE_ERROR_KIND
    this.filePath = filePath
  }
}

/**
 * Path of the machine-local `local-only` directory list: `HYP_HOME` state, so
 * it survives cache rebuilds and `hyp leave` (LLP 0071 consequences), never a
 * repo dotfile and never layered/central config.
 *
 * @ref LLP 0071 [implements]: the list is one machine-local file under HYP_HOME state
 * @param {string} stateDir `readObservabilityEnv(env).stateDir`
 * @returns {string}
 */
export function localOnlyListPath(stateDir) {
  if (!stateDir) throw new Error('localOnlyListPath: stateDir is required')
  return path.join(stateDir, LOCAL_ONLY_SUBDIR, LOCAL_ONLY_FILENAME)
}

/**
 * Normalize a raw entry list into the canonical on-disk form: absolute dirs
 * (`path.resolve`), one entry per `dir` (a later duplicate wins over an
 * earlier one, so callers can express "upsert" as append + normalize), sorted
 * by `dir`.
 *
 * @param {readonly { dir: string, class: UsageClass }[]} entries
 * @returns {LocalOnlyEntry[]}
 */
function normalizeEntries(entries) {
  const byDir = new Map()
  for (const entry of entries) byDir.set(path.resolve(entry.dir), entry.class)
  return [...byDir.entries()]
    .map(([dir, cls]) => ({ dir, class: cls }))
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
}

/**
 * Parse a raw parsed-JSON value into a normalized entry list, migrating the
 * LLP 0071 version-1 shape (`{ version: 1, dirs: string[] }`) on read: a bare
 * `dirs` array meant every listed directory was `local-only`, exactly what it
 * migrates to (LLP 0103). Returns `null` when `parsed` matches neither the
 * version-1 nor version-2 shape, so the caller can fail safe.
 *
 * @ref LLP 0103 [implements]: version-1 `dirs` arrays migrate on read as all-`local-only`
 * @param {unknown} parsed
 * @returns {LocalOnlyEntry[] | null}
 */
function parseListShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = /** @type {{ version?: unknown, dirs?: unknown, entries?: unknown }} */ (parsed)
  if (candidate.version === 1) {
    if (!Array.isArray(candidate.dirs) || !candidate.dirs.every((dir) => typeof dir === 'string')) return null
    return normalizeEntries(
      candidate.dirs.map((/** @type {string} */ dir) => ({ dir, class: /** @type {UsageClass} */ ('local-only') }))
    )
  }
  if (candidate.version === LOCAL_ONLY_LIST_VERSION) {
    if (!Array.isArray(candidate.entries)) return null
    const valid = candidate.entries.every((/** @type {unknown} */ entry) => {
      if (entry === null || typeof entry !== 'object') return false
      const { dir, class: cls } = /** @type {{ dir?: unknown, class?: unknown }} */ (entry)
      return typeof dir === 'string' && typeof cls === 'string' && USAGE_CLASSES.has(cls)
    })
    if (!valid) return null
    return normalizeEntries(/** @type {LocalOnlyEntry[]} */ (candidate.entries))
  }
  return null
}

/**
 * Read the machine-local `local-only` list as class-per-entry data
 * (`{ dir, class }[]`), migrating a version-1 file on read. A missing file is
 * the common case (no exclusions yet) and returns `[]`; a present-but-
 * unreadable or unparseable file throws {@link LocalOnlyListUnreadableError}
 * rather than silently resolving to empty.
 *
 * @ref LLP 0103 [implements]: the class-per-entry reader, migrate-on-read for version 1
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<LocalOnlyEntry[]>}
 */
export async function readLocalOnlyEntries({ stateDir, fs = fsp }) {
  const filePath = localOnlyListPath(stateDir)
  let raw
  try {
    raw = await readFileIfExists(filePath, { fs })
  } catch (err) {
    throw new LocalOnlyListUnreadableError(filePath, { cause: err })
  }
  if (raw === null) return []

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new LocalOnlyListUnreadableError(filePath, { cause: err })
  }
  const entries = parseListShape(parsed)
  if (entries === null) throw new LocalOnlyListUnreadableError(filePath)
  return entries
}

/**
 * Write the machine-local `local-only` list as class-per-entry data: normalize
 * (absolute/deduped-by-dir/sorted), `mkdir -p` the parent, then an atomic
 * temp-file + rename (the same discipline `src/core/sinks/watermarks.js` uses
 * for other `HYP_HOME` state), so a crash mid-write never leaves a torn or
 * half-written list.
 *
 * @ref LLP 0103 [implements]: the class-per-entry writer, version-2 on-disk shape
 * @param {{ stateDir: string, entries: readonly { dir: string, class: UsageClass }[], fs?: typeof fsp }} opts
 * @returns {Promise<LocalOnlyEntry[]>}
 */
export async function writeLocalOnlyEntries({ stateDir, entries, fs }) {
  const filePath = localOnlyListPath(stateDir)
  const normalized = normalizeEntries(entries)
  /** @type {{ version: 2, entries: LocalOnlyEntry[] }} */
  const file = { version: LOCAL_ONLY_LIST_VERSION, entries: normalized }
  await atomicWriteJson(filePath, file, fs ? { fs } : undefined)
  return normalized
}

/**
 * Back-compat view over the class-per-entry store: the `local-only`-class
 * subset of dirs, for callers that only ever cared about that one class
 * (the LLP 0069 enrollment picker, `hyp status`'s withholding count). Prefer
 * {@link readLocalOnlyEntries} for anything that needs to see other classes.
 *
 * @ref LLP 0103 [implements]: dirs-only back-compat read, the `local-only` subset
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<string[]>}
 */
export async function readLocalOnlyDirs({ stateDir, fs = fsp }) {
  const entries = await readLocalOnlyEntries({ stateDir, fs })
  return entries.filter((entry) => entry.class === 'local-only').map((entry) => entry.dir)
}

/**
 * Back-compat writer over the class-per-entry store: replaces the
 * `local-only`-class subset of entries with exactly `dirs`, leaving any
 * `ignore`/`full` entries untouched (never downgrades or clobbers a
 * class-aware entry written by the LLP 0103 marking verbs). Used by the LLP
 * 0069 enrollment picker, whose "confirmed checked set replaces every shown
 * candidate" editor semantics only ever mean `local-only`.
 *
 * @ref LLP 0103 [implements]: dirs-only back-compat write, merges into the `local-only` subset without touching other classes
 * @param {{ stateDir: string, dirs: readonly string[], fs?: typeof fsp }} opts
 * @returns {Promise<string[]>}
 */
export async function writeLocalOnlyDirs({ stateDir, dirs, fs }) {
  const existing = await readLocalOnlyEntries({ stateDir, fs: fs ?? fsp })
  const requested = new Set(dirs.map((dir) => path.resolve(dir)))
  const existingDirs = new Set(existing.map((entry) => entry.dir))
  const kept = existing.filter((entry) => entry.class !== 'local-only' || requested.has(entry.dir))
  const added = [...requested]
    .filter((dir) => !existingDirs.has(dir))
    .map((dir) => ({ dir, class: /** @type {UsageClass} */ ('local-only') }))
  const merged = await writeLocalOnlyEntries({ stateDir, entries: [...kept, ...added], fs })
  return merged.filter((entry) => entry.class === 'local-only').map((entry) => entry.dir)
}

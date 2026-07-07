// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteJson, readFileIfExists } from '../util/fs_atomic.js'

/**
 * @import { LocalOnlyListFile } from '../../../src/core/usage-policy/types.js'
 */

const LOCAL_ONLY_SUBDIR = 'usage-policy'
const LOCAL_ONLY_FILENAME = 'local-only.json'
const LOCAL_ONLY_LIST_VERSION = 1

/** `error_kind` carried by {@link LocalOnlyListUnreadableError} (LLP 0080 #fail-safe). */
export const LOCAL_ONLY_LIST_UNREADABLE_ERROR_KIND = 'local_only_list_unreadable'

/**
 * Thrown when the machine-local `local-only.json` file exists but cannot be
 * read or parsed as the LLP 0071 list shape (missing is not an error: that
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
 * Normalize a raw directory list into the canonical on-disk form: absolute
 * (`path.resolve`), deduplicated, sorted. Entries need not exist on disk or
 * be git repos (LLP 0069 R4).
 *
 * @param {readonly string[]} dirs
 * @returns {string[]}
 */
function normalizeDirs(dirs) {
  const resolved = new Set(dirs.map((dir) => path.resolve(dir)))
  return [...resolved].sort()
}

/**
 * @param {unknown} parsed
 * @returns {parsed is LocalOnlyListFile}
 */
function isValidListShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return false
  const candidate = /** @type {{ version?: unknown, dirs?: unknown }} */ (parsed)
  return (
    candidate.version === LOCAL_ONLY_LIST_VERSION &&
    Array.isArray(candidate.dirs) &&
    candidate.dirs.every((dir) => typeof dir === 'string')
  )
}

/**
 * Read the machine-local `local-only` directory list. A missing file is the
 * common case (no exclusions yet) and returns `[]`; a present-but-unreadable
 * or unparseable file throws {@link LocalOnlyListUnreadableError} (see the
 * module-level fail-safe note) rather than silently resolving to empty.
 *
 * @ref LLP 0071 [implements]: the reader half of the machine-local exclusion list
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<string[]>}
 */
export async function readLocalOnlyDirs({ stateDir, fs = fsp }) {
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
  if (!isValidListShape(parsed)) {
    throw new LocalOnlyListUnreadableError(filePath)
  }
  return normalizeDirs(parsed.dirs)
}

/**
 * Write the machine-local `local-only` directory list: normalize/dedupe/sort
 * `dirs`, `mkdir -p` the parent, then an atomic temp-file + rename (the same
 * discipline `src/core/sinks/watermarks.js` uses for other `HYP_HOME` state),
 * so a crash mid-write never leaves a torn or half-written list.
 *
 * @ref LLP 0071 [implements]: the writer half of the machine-local exclusion list, atomic write-rename
 * @param {{ stateDir: string, dirs: readonly string[], fs?: typeof fsp }} opts
 * @returns {Promise<string[]>}
 */
export async function writeLocalOnlyDirs({ stateDir, dirs, fs }) {
  const filePath = localOnlyListPath(stateDir)
  const normalized = normalizeDirs(dirs)
  /** @type {LocalOnlyListFile} */
  const file = { version: LOCAL_ONLY_LIST_VERSION, dirs: normalized }
  await atomicWriteJson(filePath, file, fs ? { fs } : undefined)
  return normalized
}

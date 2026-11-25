// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteJson, readFileIfExists } from '../util/fs_atomic.js'
import { usagePolicyPath } from '../runtime/paths.js'

/**
 * @import { FolderAskMode } from '../../../src/core/usage-policy/types.js'
 */


export const FOLDER_ASK_VERSION = 1

/** The two modes, in the order the wizard and `hyp policy folders` present them. */
export const FOLDER_ASK_MODES = /** @type {const} */ (['ask', 'sync'])

/**
 * The product default, and what an absent store means (LLP 0200 #default):
 * new folders sync and nobody is interrupted. The per-folder ask
 * ([LLP 0106](../../../llp/0106-session-start-classification-hook.decision.md))
 * is now the opt-in half of the pair, chosen in the wizard's new-folder step
 * or with `hyp policy folders ask`.
 *
 * @ref LLP 0200#default [implements]: sync-by-default; the per-folder ask is opt-in, and store absence means the default
 * @type {FolderAskMode}
 */
export const DEFAULT_FOLDER_ASK_MODE = 'sync'

/** `error_kind` carried by {@link FolderAskUnreadableError}. */
export const FOLDER_ASK_UNREADABLE_ERROR_KIND = 'folder_ask_unreadable'

/**
 * Thrown when the machine-local `folder-ask.json` exists but cannot be read or
 * parsed (missing is not an error: that reads as {@link DEFAULT_FOLDER_ASK_MODE}).
 * The CLI surfaces let this propagate so a broken preference is repaired rather
 * than silently reinterpreted; the session-start hook is the one caller that
 * swallows it, resolving to `ask` (LLP 0200 #fail-safe) - the one direction
 * that cannot be wrong about a user who deliberately turned the ask on.
 *
 * @ref LLP 0200#fail-safe [implements]: an unreadable preference resolves toward asking, which is never the leaking direction
 */
export class FolderAskUnreadableError extends Error {
  /**
   * @param {string} filePath
   * @param {{ cause?: unknown }} [options]
   */
  constructor(filePath, options) {
    super(`folder-ask preference at '${filePath}' is unreadable or malformed`, options)
    this.name = 'FolderAskUnreadableError'
    this.error_kind = FOLDER_ASK_UNREADABLE_ERROR_KIND
    this.filePath = filePath
  }
}

/**
 * Path of the machine-local folder-ask preference: `HYP_HOME` state, beside
 * the directory list (`local-only.json`) and the per-client opt-out store
 * (`client-sync.json`), so it survives cache rebuilds and `hyp leave`. Never a
 * repo dotfile and never layered/central config: how often *this* machine's
 * user wants to be interrupted is not an org policy (LLP 0200 #machine-local).
 *
 * @ref LLP 0200#machine-local [implements]: the preference is one machine-local file under HYP_HOME state, beside its siblings
 * @param {string} stateDir `readObservabilityEnv(env).stateDir`
 * @returns {string}
 */
export function folderAskPath(stateDir) {
  if (!stateDir) throw new Error('folderAskPath: stateDir is required')
  return usagePolicyPath(stateDir, 'folder-ask')
}

/**
 * The folder-ask preference that sits beside a machine-local list file. The
 * usage-policy resolver is handed the list's path and nothing else, and both
 * stores live in one directory ({@link usagePolicyPath}), so the sibling is
 * how it finds the mode without every caller threading a second path.
 *
 * @ref LLP 0622#one-place [implements]: the resolver finds the mode from the list path it already holds
 * @param {string} listPath `localOnlyListPath(stateDir)`
 * @returns {string}
 */
export function folderAskPathBeside(listPath) {
  return path.join(path.dirname(listPath), path.basename(usagePolicyPath('.', 'folder-ask')))
}

/**
 * Whether a present preference file's bytes put the collecting rule in force
 * (LLP 0622), for the resolver's synchronous read. Never throws.
 *
 * - `sync`: no.
 * - `ask` stamped `enforced`: yes. Every `ask` this version writes is stamped.
 * - `ask` with no stamp: no. That file was written by a version where `ask`
 *   was only a question, and its folders are still collected until the keep
 *   step has run and stamped it (LLP 0626).
 * - bytes that do not parse to a known mode: yes, the direction that collects
 *   less.
 *
 * @ref LLP 0622#fail-safe [implements]: an unreadable preference means not collected, never collected by accident
 * @ref LLP 0626#stamp [implements]: an unstamped `ask` keeps its old meaning until it is adopted
 * @param {string} raw
 * @returns {boolean}
 */
export function folderAskEnforcedFromRaw(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return true
  }
  const mode = parseFileShape(parsed)
  if (mode === null) return true
  return mode === 'ask' && parsed.enforced === true
}

/**
 * Read the machine-local folder-ask preference. A missing file returns
 * {@link DEFAULT_FOLDER_ASK_MODE} (`'sync'`); a present-but-unparseable file
 * throws {@link FolderAskUnreadableError} rather than resolving to either
 * mode by accident.
 *
 * @ref LLP 0200#store [implements]: absence reads as the product default, so an un-asked machine syncs new folders quietly
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<FolderAskMode>}
 */
export async function readFolderAskMode({ stateDir, fs = fsp }) {
  return (await readFolderAskState({ stateDir, fs })).mode
}

/**
 * Read the preference with its stamp: the mode, and whether the collecting
 * rule is in force for it (always false for `sync`). Same failure contract as
 * {@link readFolderAskMode}: absent is the default, unparseable throws.
 *
 * @ref LLP 0626#stamp [implements]: callers that must tell an adopted `ask` from one an older version wrote read the stamp here
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<{ mode: FolderAskMode, enforced: boolean }>}
 */
export async function readFolderAskState({ stateDir, fs = fsp }) {
  const filePath = folderAskPath(stateDir)
  let raw
  try {
    raw = await readFileIfExists(filePath, { fs })
  } catch (err) {
    throw new FolderAskUnreadableError(filePath, { cause: err })
  }
  if (raw === null) return { mode: DEFAULT_FOLDER_ASK_MODE, enforced: false }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new FolderAskUnreadableError(filePath, { cause: err })
  }
  const mode = parseFileShape(parsed)
  if (mode === null) throw new FolderAskUnreadableError(filePath)
  return { mode, enforced: mode === 'ask' && parsed.enforced === true }
}

/**
 * {@link readFolderAskState} that never throws. An unreadable *present* file
 * reads as an enforced `ask`, which is what the resolver does with the same
 * bytes, so every reader agrees about a corrupt preference.
 *
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<{ mode: FolderAskMode, enforced: boolean }>}
 */
export async function readFolderAskStateSafe({ stateDir, fs }) {
  try {
    return await readFolderAskState({ stateDir, ...(fs ? { fs } : {}) })
  } catch {
    return { mode: 'ask', enforced: true }
  }
}

/**
 * Write the machine-local folder-ask preference (atomic temp-file + rename,
 * like its sibling stores, so a crash mid-write never leaves a torn file).
 *
 * @param {{ stateDir: string, mode: FolderAskMode, fs?: typeof fsp }} opts
 * @returns {Promise<FolderAskMode>}
 */
export async function writeFolderAskMode({ stateDir, mode, fs }) {
  if (!isFolderAskMode(mode)) throw new Error(`writeFolderAskMode: unknown mode ${String(mode)}`)
  const filePath = folderAskPath(stateDir)
  // Every `ask` this version writes is the collecting rule, and says so. The
  // version stays 1 and the stamp is one extra key, so an older build still
  // reads the file (it ignores the key and keeps asking).
  // @ref LLP 0626#stamp [implements]: an `ask` written here is stamped; only a file an older version wrote lacks it
  const payload = mode === 'ask' ? { version: FOLDER_ASK_VERSION, mode, enforced: true } : { version: FOLDER_ASK_VERSION, mode }
  await atomicWriteJson(filePath, payload, fs ? { fs } : undefined)
  return mode
}

/**
 * Read the preference without ever throwing, for callers that must not fail a
 * session on it (the session-start hook). Absence is the product default;
 * an unreadable *present* file resolves to `'ask'` instead, because a file
 * that exists is a preference someone set, and the only wrong guess that
 * costs anything is guessing "sync" for a user who asked to be asked. One
 * extra question is the cheap failure.
 *
 * @ref LLP 0200#fail-safe [implements]: the hook's read cannot throw; a corrupt (not absent) preference falls to asking
 * @param {{ stateDir: string, fs?: typeof fsp }} opts
 * @returns {Promise<FolderAskMode>}
 */
export async function readFolderAskModeSafe({ stateDir, fs }) {
  try {
    return await readFolderAskMode({ stateDir, ...(fs ? { fs } : {}) })
  } catch {
    return 'ask'
  }
}

/**
 * @param {unknown} value
 * @returns {value is FolderAskMode}
 */
export function isFolderAskMode(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (FOLDER_ASK_MODES).includes(value)
}

/**
 * @param {unknown} parsed
 * @returns {FolderAskMode | null}
 */
function parseFileShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = /** @type {{ version?: unknown, mode?: unknown }} */ (parsed)
  if (candidate.version !== FOLDER_ASK_VERSION) return null
  return isFolderAskMode(candidate.mode) ? candidate.mode : null
}

// @ts-check

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveClientSettingsPath } from '../daemon/client_settings_path.js'

/**
 * @import { FileHandle } from 'node:fs/promises'
 * @import { ClientDescriptor } from '../plugin_catalog.js'
 * @import { DetachFromDiskResult } from './types.d.ts'
 */

/**
 * The single core undo — the disk-driven, plugin-agnostic reverse of a
 * client's attach. It is the *one* detach implementation: both the reconciler's
 * `reverse()` (a fleet-config drop, fired only after the staged restart has
 * already unloaded the adapter) and the manual `hyp detach` command route
 * through it, so there is no second implementation to drift from.
 *
 * Reverse runs from **disk state alone** — the descriptor's `attachProbe`
 * locates the settings file, and the client's own settings-file marker is a
 * **self-describing undo record** that `attach()` wrote (LLP 0045 §Part 3). The
 * routine is **format-aware but plugin-agnostic**: it understands `json`
 * (marker-key) and `toml` (managed-block) — the same dispatch
 * `probeClientAttached` uses on the *read* side — and how to replay an undo
 * record, never "Claude" vs "Codex". It imports no plugin code (which would not
 * survive the plugin being unloaded), subsuming what the adapters' old
 * `detach()` did — including the Codex `# BEGIN/END hypaware …` marked-block
 * strip and prior-`model_provider` restore. The managed-block convention is
 * therefore a **core-understood format contract**, not a codex-private detail.
 *
 * @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements] — one core/disk-driven undo, format-aware (json marker-key / toml managed-block), plugin-agnostic, reusing resolveClientSettingsPath + the probeClientAttached format dispatch
 * @ref LLP 0044#conflict--back-up--override-restore-on-leave [constrained-by] — the marker is the backup; reverse restores it (or removes the managed value) on leave
 */

const TOML_MANAGED_BEGIN = '# BEGIN hypaware'
const TOML_MANAGED_END = '# END hypaware'
const TOML_PREVIOUS_KEY = 'previous_model_provider'
const TOML_ROOT_RESTORE_KEY = 'model_provider'
const TOML_MANAGED_BASE_URL_KEY = 'base_url'

const TOML_BASIC_MULTILINE_DELIMITER = '"""'
const TOML_LITERAL_MULTILINE_DELIMITER = '\'\'\''
const TOML_KEY_PART = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)`
const TOML_DOTTED_KEY = String.raw`${TOML_KEY_PART}(?:\s*\.\s*${TOML_KEY_PART})*`
const TOML_TABLE_HEADER_RE = new RegExp(String.raw`^\s*\[\s*${TOML_DOTTED_KEY}\s*\]\s*(?:#.*)?$`)
const TOML_TABLE_ARRAY_HEADER_RE = new RegExp(String.raw`^\s*\[\[\s*${TOML_DOTTED_KEY}\s*\]\]\s*(?:#.*)?$`)
const TOML_ROOT_MODEL_PROVIDER_RE = new RegExp(
  String.raw`^\s*(?:${TOML_ROOT_RESTORE_KEY}|"${TOML_ROOT_RESTORE_KEY}"|'${TOML_ROOT_RESTORE_KEY}')\s*=`
)

export class ClientDetachError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'ClientDetachError'
    /** @type {string | undefined} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * Reverse a client's attach from disk, driven by the descriptor's
 * `attachProbe` and the settings-file marker. No-op (`{ changed: false }`) when
 * the descriptor has no probe, the file is absent, or it carries no marker.
 *
 * @param {{
 *   descriptor: ClientDescriptor,
 *   homeDir?: string,
 *   env?: NodeJS.ProcessEnv,
 *   fs?: typeof fsp,
 * }} args
 * @returns {Promise<DetachFromDiskResult>}
 */
export async function detachClientFromDisk({ descriptor, homeDir = os.homedir(), env, fs = fsp }) {
  const probe = descriptor.attachProbe
  if (!probe) return { changed: false }

  const settingsPath = resolveClientSettingsPath(descriptor.name, probe.settings_file, env, homeDir)

  if (probe.format === 'json' && probe.marker_key) {
    return await detachJsonMarker({ settingsPath, markerKey: probe.marker_key, fs })
  }
  if (probe.format === 'toml') {
    return await detachTomlManagedBlock({ settingsPath, fs })
  }
  // Unknown/incomplete probe: nothing this core routine knows how to reverse.
  return { changed: false, settingsPath }
}

/* ------------------------------- JSON format ------------------------------ */

/**
 * Reverse a `json` marker-key attach (e.g. Claude's `_hypaware`). Replays the
 * self-describing undo record: restore-or-remove each managed `env` key,
 * strip the recorded managed hook entries (leaving no orphaned `hyp …` hooks),
 * and delete the marker.
 *
 * @param {{ settingsPath: string, markerKey: string, fs: typeof fsp }} args
 * @returns {Promise<DetachFromDiskResult>}
 */
async function detachJsonMarker({ settingsPath, markerKey, fs }) {
  const read = await readJson(settingsPath, fs)
  if (!read.existed) return { changed: false, settingsPath }

  const value = read.value
  const marker = value[markerKey]
  if (!isPlainObject(marker)) return { changed: false, settingsPath }

  // Pre-upgrade markers have the legacy shape {attached_at,version,port,
  // state_file} with no self-describing `managed` undo record. There is no
  // record to replay, so reverse them by the original (now-retired) convention
  // instead of just deleting the marker — otherwise env.ANTHROPIC_BASE_URL and
  // the `hyp claude-hook session-context` entries it wrote would orphan, and the
  // detach is non-retryable once the marker is gone.
  // @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [constrained-by] — legacy markers predate the undo record; fall back to the convention attach used before it
  if (!isPlainObject(marker.managed)) {
    return await detachLegacyJsonMarker({
      settingsPath,
      markerKey,
      value,
      marker,
      mtimeMs: read.mtimeMs,
      fs,
    })
  }

  const managed = isPlainObject(marker.managed) ? marker.managed : {}
  const managedEnv = isPlainObject(managed.env) ? managed.env : {}
  const hookEntries = Array.isArray(managed.hooks) ? managed.hooks : []
  const prevBaseUrl = typeof marker.prev_base_url === 'string' ? marker.prev_base_url : undefined

  delete value[markerKey]
  stripManagedHooks(value, hookEntries)

  /** @type {string | undefined} */
  let removed
  /** @type {string | undefined} */
  let restoredValue
  /** @type {string | undefined} */
  let warning

  if (isPlainObject(value.env)) {
    const envObj = /** @type {Record<string, unknown>} */ (value.env)
    for (const [key, ourVal] of Object.entries(managedEnv)) {
      const current = envObj[key]
      if (current === ourVal) {
        // The value we wrote is still live: restore the recorded prior, or
        // remove the key when the attach had no pre-existing value to back up.
        if (prevBaseUrl !== undefined) {
          envObj[key] = prevBaseUrl
          restoredValue = prevBaseUrl
        } else {
          removed = typeof current === 'string' ? current : String(current)
          delete envObj[key]
        }
      } else if (typeof current === 'string') {
        // Overridden externally after we attached — never clobber a user edit.
        warning = `${key} was overridden externally; leaving in place`
      }
    }
    if (Object.keys(envObj).length === 0) delete value.env
  }

  await writeJsonAtomic(settingsPath, value, read.mtimeMs, fs)

  /** @type {DetachFromDiskResult} */
  const result = { changed: true, settingsPath }
  if (removed !== undefined) result.removed = removed
  if (restoredValue !== undefined) result.restoredValue = restoredValue
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * Strip the managed hook entries the marker recorded — matching each by its
 * `event` / `matcher` / exact `command`, so only the handlers this attach
 * installed are removed and no orphaned `hyp …` hooks survive. Empty groups
 * and empty event arrays are pruned; an emptied `hooks` root is deleted.
 *
 * @param {Record<string, unknown>} value
 * @param {unknown[]} hookEntries
 */
function stripManagedHooks(value, hookEntries) {
  const hooksRoot = value.hooks
  if (!isPlainObject(hooksRoot)) return

  for (const entry of hookEntries) {
    if (!isPlainObject(entry)) continue
    const event = typeof entry.event === 'string' ? entry.event : undefined
    const command = typeof entry.command === 'string' ? entry.command : undefined
    if (event === undefined || command === undefined) continue
    const matcher = typeof entry.matcher === 'string' ? entry.matcher : undefined

    const groups = hooksRoot[event]
    if (!Array.isArray(groups)) continue

    /** @type {unknown[]} */
    const nextGroups = []
    for (const group of groups) {
      if (!isPlainObject(group) || !groupMatcherEquals(group, matcher) || !Array.isArray(group.hooks)) {
        nextGroups.push(group)
        continue
      }
      const handlers = group.hooks
      const keptHandlers = handlers.filter((h) => !isManagedHandler(h, command))
      if (keptHandlers.length === handlers.length) {
        nextGroups.push(group) // nothing matched — leave the group untouched
      } else if (keptHandlers.length > 0) {
        nextGroups.push({ ...group, hooks: keptHandlers })
      }
      // else: the group held only the managed handler — drop it entirely.
    }

    if (nextGroups.length > 0) {
      hooksRoot[event] = nextGroups
    } else {
      delete hooksRoot[event]
    }
  }

  if (Object.keys(hooksRoot).length === 0) delete value.hooks
}

/**
 * @param {Record<string, unknown>} group
 * @param {string | undefined} matcher
 */
function groupMatcherEquals(group, matcher) {
  const groupMatcher = typeof group.matcher === 'string' ? group.matcher : undefined
  return groupMatcher === matcher
}

/**
 * @param {unknown} handler
 * @param {string} command
 */
function isManagedHandler(handler, command) {
  return isPlainObject(handler) && handler.type === 'command' && handler.command === command
}

/* ----------------------------- legacy JSON marker ---------------------------- */

const LEGACY_CLAUDE_HOOK_PATTERN = /\bclaude-hook\s+session-context\b/

/**
 * Reverse a pre-upgrade legacy `json` marker — the old Claude marker shape
 * `{attached_at,version,port,state_file}` that predates the self-describing
 * `managed` undo record. We can't replay a record the marker never wrote, so we
 * fall back to the convention `attach()` used before the record existed:
 * remove `env.ANTHROPIC_BASE_URL` only when it still equals the recorded
 * `http://127.0.0.1:${port}` gateway URL (never clobbering a later user edit),
 * and strip the session-context hooks by the `claude-hook session-context`
 * command pattern. Legacy JSON markers were only ever written by Claude, so the
 * key/pattern are safe to assume here. Moved from the retired claude-adapter
 * `detach()` so the one core undo owns this reversal too.
 *
 * @param {{
 *   settingsPath: string,
 *   markerKey: string,
 *   value: Record<string, unknown>,
 *   marker: Record<string, unknown>,
 *   mtimeMs: number | undefined,
 *   fs: typeof fsp,
 * }} args
 * @returns {Promise<DetachFromDiskResult>}
 */
async function detachLegacyJsonMarker({ settingsPath, markerKey, value, marker, mtimeMs, fs }) {
  const markerPort = typeof marker.port === 'number' ? marker.port : undefined

  delete value[markerKey]
  stripLegacyClaudeHooks(value)

  /** @type {string | undefined} */
  let removed
  /** @type {string | undefined} */
  let warning
  if (isPlainObject(value.env)) {
    const envObj = /** @type {Record<string, unknown>} */ (value.env)
    const current = envObj.ANTHROPIC_BASE_URL
    if (markerPort !== undefined && current === `http://127.0.0.1:${markerPort}`) {
      removed = typeof current === 'string' ? current : String(current)
      delete envObj.ANTHROPIC_BASE_URL
    } else if (typeof current === 'string') {
      warning = 'ANTHROPIC_BASE_URL was overridden externally; leaving in place'
    }
    if (Object.keys(envObj).length === 0) delete value.env
  }

  await writeJsonAtomic(settingsPath, value, mtimeMs, fs)

  /** @type {DetachFromDiskResult} */
  const result = { changed: true, settingsPath }
  if (removed !== undefined) result.removed = removed
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * Strip the legacy Claude session-context hooks — matched by the
 * `claude-hook session-context` command pattern rather than the marker's undo
 * record (a legacy marker recorded no hook entries). Empty groups, emptied
 * event arrays, and an emptied `hooks` root are pruned, so no orphaned `hyp …`
 * hooks survive. Preserves a user's own non-managed handlers for the same event.
 *
 * @param {Record<string, unknown>} value
 */
function stripLegacyClaudeHooks(value) {
  const hooksRoot = value.hooks
  if (!isPlainObject(hooksRoot)) return

  for (const event of Object.keys(hooksRoot)) {
    const groups = hooksRoot[event]
    if (!Array.isArray(groups)) continue

    /** @type {unknown[]} */
    const nextGroups = []
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        nextGroups.push(group)
        continue
      }
      const keptHandlers = group.hooks.filter((h) => !isLegacyClaudeHandler(h))
      if (keptHandlers.length === group.hooks.length) {
        nextGroups.push(group) // nothing matched — leave untouched
      } else if (keptHandlers.length > 0) {
        nextGroups.push({ ...group, hooks: keptHandlers })
      }
      // else: the group held only legacy managed handlers — drop it entirely.
    }

    if (nextGroups.length > 0) {
      hooksRoot[event] = nextGroups
    } else {
      delete hooksRoot[event]
    }
  }

  if (Object.keys(hooksRoot).length === 0) delete value.hooks
}

/** @param {unknown} handler */
function isLegacyClaudeHandler(handler) {
  return isPlainObject(handler) &&
    handler.type === 'command' &&
    typeof handler.command === 'string' &&
    LEGACY_CLAUDE_HOOK_PATTERN.test(handler.command)
}

/* ------------------------------- TOML format ------------------------------ */

/**
 * Reverse a `toml` managed-block attach (e.g. Codex's `# BEGIN/END hypaware …`
 * blocks). The blocks are self-delimiting and record the prior `model_provider`
 * as `# previous_model_provider`, so core strips the blocks and restores the
 * recorded root pointer — without importing the codex plugin.
 *
 * @param {{ settingsPath: string, fs: typeof fsp }} args
 * @returns {Promise<DetachFromDiskResult>}
 */
async function detachTomlManagedBlock({ settingsPath, fs }) {
  const read = await readText(settingsPath, fs)
  if (!read.existed) return { changed: false, settingsPath }

  const lines = splitLines(read.content)
  const blockValues = readManagedBlockValues(lines)
  if (!blockValues.found) return { changed: false, settingsPath }

  let next = removeManagedBlocks(lines)

  /** @type {string | undefined} */
  let restoredValue
  /** @type {string | undefined} */
  let warning
  if (blockValues.previous !== undefined) {
    const current = readRootModelProvider(next)
    if (current === undefined) {
      next = insertRootLines(next, [`${TOML_ROOT_RESTORE_KEY} = ${tomlString(blockValues.previous)}`])
      restoredValue = blockValues.previous
    } else if (current !== blockValues.previous) {
      warning = `${TOML_ROOT_RESTORE_KEY} was changed externally; leaving ${current} in place`
    }
  }

  await writeTextAtomic(settingsPath, formatLines(next), read.mtimeMs, fs)

  /** @type {DetachFromDiskResult} */
  const result = { changed: true, settingsPath }
  if (blockValues.removed !== undefined) result.removed = blockValues.removed
  if (restoredValue !== undefined) result.restoredValue = restoredValue
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * Single pass over the managed blocks: detect their presence and read the prior
 * `model_provider` (the restore target, recorded as a `# previous_model_provider`
 * comment) and the managed `base_url` (reported as `removed`).
 *
 * @param {string[]} lines
 * @returns {{ found: boolean, previous?: string, removed?: string }}
 */
function readManagedBlockValues(lines) {
  const prevRe = new RegExp(String.raw`^#\s*${TOML_PREVIOUS_KEY}\s*=\s*(.+)$`)
  const baseRe = new RegExp(String.raw`^\s*${TOML_MANAGED_BASE_URL_KEY}\s*=\s*(.+)$`)
  let inside = false
  let found = false
  /** @type {string | undefined} */
  let previous
  /** @type {string | undefined} */
  let removed
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inside) {
      if (trimmed.startsWith(TOML_MANAGED_BEGIN)) {
        inside = true
        found = true
      }
      continue
    }
    if (trimmed.startsWith(TOML_MANAGED_END)) {
      inside = false
      continue
    }
    if (previous === undefined) {
      const m = line.match(prevRe)
      if (m) previous = parseTomlString(m[1])
    }
    if (removed === undefined) {
      const m = line.match(baseRe)
      if (m) removed = parseTomlString(m[1])
    }
  }
  /** @type {{ found: boolean, previous?: string, removed?: string }} */
  const result = { found }
  if (previous !== undefined) result.previous = previous
  if (removed !== undefined) result.removed = removed
  return result
}

/**
 * Strip every `# BEGIN hypaware …` … `# END hypaware …` block (inclusive). The
 * convention is self-delimiting, so this removes exactly what attach inserted.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function removeManagedBlocks(lines) {
  /** @type {string[]} */
  const next = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith(TOML_MANAGED_BEGIN)) {
      next.push(lines[i])
      continue
    }
    let foundEnd = false
    for (i++; i < lines.length; i++) {
      if (lines[i].trim().startsWith(TOML_MANAGED_END)) {
        foundEnd = true
        break
      }
    }
    if (!foundEnd) {
      throw new ClientDetachError('unterminated hypaware-managed config block', {
        code: 'MALFORMED_MARKER',
      })
    }
  }
  return next
}

/**
 * Read the root `model_provider` (before the first table header), honoring
 * multiline strings so a `"""…"""` value can't be misread as an assignment.
 *
 * @param {string[]} lines
 * @returns {string | undefined}
 */
function readRootModelProvider(lines) {
  const firstTable = findFirstTableIndex(lines)
  /** @type {string | undefined} */
  let multilineDelimiter
  for (let i = 0; i < firstTable; i++) {
    if (multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(lines[i], multilineDelimiter)
      continue
    }
    if (TOML_ROOT_MODEL_PROVIDER_RE.test(lines[i])) return parseAssignmentString(lines[i])
    multilineDelimiter = openMultilineString(lines[i])
  }
  return undefined
}

/**
 * Insert lines at the root (before the first table header / trailing blanks).
 *
 * @param {string[]} lines
 * @param {string[]} insert
 * @returns {string[]}
 */
function insertRootLines(lines, insert) {
  const next = lines.slice()
  let index = findFirstTableIndex(next)
  if (index === next.length) {
    while (index > 0 && next[index - 1] === '') index--
  }
  next.splice(index, 0, ...insert)
  return next
}

/** @param {string[]} lines */
function findFirstTableIndex(lines) {
  /** @type {string | undefined} */
  let multilineDelimiter
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(line, multilineDelimiter)
      continue
    }
    if (isTableHeader(line)) return i
    multilineDelimiter = openMultilineString(line)
  }
  return lines.length
}

/** @param {string} line */
function isTableHeader(line) {
  return TOML_TABLE_HEADER_RE.test(line) || TOML_TABLE_ARRAY_HEADER_RE.test(line)
}

/** @param {string} line */
function openMultilineString(line) {
  const value = assignmentValue(line) ?? line.trimStart()
  if (value.startsWith(TOML_BASIC_MULTILINE_DELIMITER)) {
    return hasClosingMultilineString(value.slice(3), TOML_BASIC_MULTILINE_DELIMITER)
      ? undefined
      : TOML_BASIC_MULTILINE_DELIMITER
  }
  if (value.startsWith(TOML_LITERAL_MULTILINE_DELIMITER)) {
    return hasClosingMultilineString(value.slice(3), TOML_LITERAL_MULTILINE_DELIMITER)
      ? undefined
      : TOML_LITERAL_MULTILINE_DELIMITER
  }
  return undefined
}

/**
 * @param {string} line
 * @param {string} delimiter
 */
function closeMultilineString(line, delimiter) {
  return hasClosingMultilineString(line, delimiter) ? undefined : delimiter
}

/** @param {string} line */
function assignmentValue(line) {
  if (/^\s*#/.test(line)) return undefined
  const index = line.indexOf('=')
  return index === -1 ? undefined : line.slice(index + 1).trimStart()
}

/**
 * @param {string} value
 * @param {string} delimiter
 */
function hasClosingMultilineString(value, delimiter) {
  if (delimiter === TOML_LITERAL_MULTILINE_DELIMITER) return value.includes(delimiter)
  for (let index = value.indexOf(delimiter); index !== -1; index = value.indexOf(delimiter, index + 1)) {
    if (!isEscaped(value, index)) return true
  }
  return false
}

/**
 * @param {string} value
 * @param {number} index
 */
function isEscaped(value, index) {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) backslashes++
  return backslashes % 2 === 1
}

/** @param {string} line */
function parseAssignmentString(line) {
  const index = line.indexOf('=')
  if (index === -1) return undefined
  return parseTomlString(line.slice(index + 1))
}

/** @param {string} value */
function parseTomlString(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    const match = trimmed.match(/^"(?:\\.|[^"\\])*"/)
    if (!match) return undefined
    try { return JSON.parse(match[0]) } catch { return undefined }
  }
  if (trimmed.startsWith('\'')) {
    const match = trimmed.match(/^'([^']*)'/)
    return match ? match[1] : undefined
  }
  return undefined
}

/** @param {string} value */
function tomlString(value) {
  return JSON.stringify(value)
}

/**
 * @param {string} content
 * @returns {string[]}
 */
function splitLines(content) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (normalized === '') return []
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
function formatLines(lines) {
  let start = 0
  let end = lines.length
  while (start < end && lines[start] === '') start++
  while (end > start && lines[end - 1] === '') end--
  const out = lines.slice(start, end)
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

/* --------------------------------- I/O ------------------------------------ */

/**
 * @param {string} settingsPath
 * @param {typeof fsp} fs
 * @returns {Promise<{ value: Record<string, unknown>, existed: boolean, mtimeMs: number | undefined }>}
 */
async function readJson(settingsPath, fs) {
  const read = await readText(settingsPath, fs)
  if (!read.existed) return { value: {}, existed: false, mtimeMs: undefined }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(read.content)
  } catch (err) {
    throw new ClientDetachError(`malformed JSON in ${settingsPath}: ${errMsg(err)}`, {
      code: 'MALFORMED_JSON',
      cause: err,
    })
  }
  if (!isPlainObject(parsed)) {
    throw new ClientDetachError(`${settingsPath} must contain a JSON object at the root`, {
      code: 'NOT_AN_OBJECT',
    })
  }
  return { value: parsed, existed: true, mtimeMs: read.mtimeMs }
}

/**
 * @param {string} settingsPath
 * @param {typeof fsp} fs
 * @returns {Promise<{ content: string, existed: boolean, mtimeMs: number | undefined }>}
 */
async function readText(settingsPath, fs) {
  // Stat BEFORE reading the content so the captured mtime never post-dates the
  // bytes we return. If we stat'd after the read, a concurrent edit landing in
  // the read→stat window would leave us holding stale content paired with the
  // *new* mtime — and the write-time guard would then pass and silently clobber
  // that edit. Stat-first instead makes the guard err toward CONCURRENT_EDIT.
  let stat
  try {
    stat = await fs.stat(settingsPath)
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { content: '', existed: false, mtimeMs: undefined }
    throw new ClientDetachError(`failed to stat ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { content: '', existed: false, mtimeMs: undefined }
    throw new ClientDetachError(`failed to read ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }
  return { content: raw, existed: true, mtimeMs: stat.mtimeMs }
}

/**
 * @param {string} settingsPath
 * @param {unknown} value
 * @param {number | undefined} expectedMtimeMs
 * @param {typeof fsp} fs
 */
async function writeJsonAtomic(settingsPath, value, expectedMtimeMs, fs) {
  await writeTextAtomic(settingsPath, JSON.stringify(value, null, 2) + '\n', expectedMtimeMs, fs)
}

/**
 * Atomic temp-file + rename write, gated on the file's mtime so a concurrent
 * edit between read and write is detected (CONCURRENT_EDIT) rather than
 * silently clobbered — the same guarantee the adapters' writers gave.
 *
 * @param {string} filePath
 * @param {string} body
 * @param {number | undefined} expectedMtimeMs
 * @param {typeof fsp} fs
 */
async function writeTextAtomic(filePath, body, expectedMtimeMs, fs) {
  if (expectedMtimeMs !== undefined) {
    let current
    try {
      current = await fs.stat(filePath)
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        throw new ClientDetachError(`${filePath} disappeared between read and write; retry`, {
          code: 'CONCURRENT_EDIT',
          cause: err,
        })
      }
      throw err
    }
    if (current.mtimeMs !== expectedMtimeMs) {
      throw new ClientDetachError(`${filePath} changed on disk between read and write; retry`, {
        code: 'CONCURRENT_EDIT',
      })
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  // The uniquely-named temp file must never outlive a *failed* write: a
  // write/sync/close error before the final rename would otherwise orphan it on
  // disk (these names are unique per call, so a leak accumulates rather than
  // being overwritten on retry). Track whether the rename committed and
  // best-effort unlink the temp on every other exit — swallowing the unlink
  // error so a cleanup hiccup never masks the real write/rename failure.
  let renamed = false
  try {
    /** @type {FileHandle | undefined} */
    let handle
    try {
      handle = await fs.open(tmpPath, 'w', 0o600)
      await handle.writeFile(body, 'utf8')
      await handle.sync()
    } finally {
      if (handle) await handle.close()
    }
    await fs.rename(tmpPath, filePath)
    renamed = true
  } finally {
    if (!renamed) {
      try {
        await fs.rm(tmpPath, { force: true })
      } catch {
        // Best-effort: a leaked temp file is preferable to losing the original error.
      }
    }
  }
}

/* ------------------------------- Utilities -------------------------------- */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} err */
function errCode(err) {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined
  const code = Reflect.get(err, 'code')
  return typeof code === 'string' ? code : undefined
}

/** @param {unknown} err */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}

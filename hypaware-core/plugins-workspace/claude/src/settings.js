// @ts-check

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Claude Code settings.json attach writer, keyed on the `_hypaware`
 * managed marker.
 *
 * Writes are atomic (temp file + rename) and gated on mtime so a
 * concurrent edit is detected instead of silently overwritten. The
 * `_hypaware` marker is the self-describing undo record the single core
 * undo (`detachClientFromDisk`, LLP 0045 §Part 3) replays — there is no
 * adapter `detach()`; the reverse lives in core so it survives the
 * plugin being unloaded (legacy pre-record markers included).
 *
 * The marker is also a **self-describing undo record**: it records
 * `prev_base_url` (the restore target) and the managed
 * `env.ANTHROPIC_BASE_URL` / session-context hook entries it added, so
 * a format-aware but plugin-agnostic core routine can reverse the
 * attach from disk alone — with the plugin unloaded. See LLP 0045
 * Part 3.
 */

/**
 * @import { ClaudeAttachOptions, ClaudeAttachResult } from './types.js'
 * @import { FileHandle } from 'node:fs/promises'
 */

const MARKER_KEY = '_hypaware'
const MANAGED_HOOK_SPECS = [
  { event: 'SessionStart' },
  { event: 'CwdChanged' },
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: 'Bash' },
]
const MANAGED_HOOK_PATTERN = /\bclaude-hook\s+session-context\b/

export class ClaudeSettingsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'ClaudeSettingsError'
    /** @type {string | undefined} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * Default Claude Code settings.json location: `~/.claude/settings.json`.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
export function defaultSettingsPath(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.claude', 'settings.json')
}

/**
 * Route Claude Code through the local AI gateway by writing the
 * `_hypaware` marker, `env.ANTHROPIC_BASE_URL`, and the managed
 * session-context hook entries into settings.json.
 *
 * @param {ClaudeAttachOptions} opts
 * @returns {Promise<ClaudeAttachResult>}
 */
export async function attach(opts) {
  const { port, version, stateFile, settingsPath = defaultSettingsPath(), binPath = 'hyp' } = opts
  validatePort(port)
  validateVersion(version)
  validateStateFile(stateFile)

  const { value, mtimeMs } = await readSettings(settingsPath)
  const priorMarker = isPlainObject(value[MARKER_KEY]) ? value[MARKER_KEY] : undefined

  const env = ensureObject(value, 'env')
  const liveBaseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : undefined
  // Preserve the recorded original across a re-attach: once we own the
  // URL the live value is *our* gateway URL, so keep the marker's
  // recorded `prev_base_url` rather than backing up the gateway URL
  // over it. A first attach backs up whatever was live.
  // @ref LLP 0044#conflict--back-up--override-restore-on-leave [constrained-by] — the marker IS the backup restored on leave
  const prevBaseUrl = priorMarker
    ? (typeof priorMarker.prev_base_url === 'string' ? priorMarker.prev_base_url : undefined)
    : liveBaseUrl

  const baseUrl = `http://127.0.0.1:${port}`
  const command = managedHookCommand(binPath, stateFile)

  env.ANTHROPIC_BASE_URL = baseUrl
  installSessionContextHooks(value, command)
  // Self-describing undo record: enough for the format-aware core undo
  // to restore-or-remove `env.ANTHROPIC_BASE_URL`, strip the managed
  // hook entries, and delete the marker without loading this plugin —
  // leaving no orphaned `hyp claude-hook` entries.
  // @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements] — claude marker records prev_base_url + managed env/hook entries
  value[MARKER_KEY] = {
    attached_at: new Date().toISOString(),
    version,
    port,
    state_file: stateFile,
    managed: {
      env: { ANTHROPIC_BASE_URL: baseUrl },
      hooks: managedHookEntries(command),
    },
    ...(prevBaseUrl !== undefined ? { prev_base_url: prevBaseUrl } : {}),
  }

  await writeAtomic(settingsPath, value, mtimeMs)

  /** @type {ClaudeAttachResult} */
  const result = { changed: true }
  if (prevBaseUrl !== undefined) result.prevValue = prevBaseUrl
  return result
}

/**
 * @param {string} settingsPath
 * @returns {Promise<{ value: Record<string, unknown>, existed: boolean, mtimeMs: number | undefined }>}
 */
async function readSettings(settingsPath) {
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      return { value: {}, existed: false, mtimeMs: undefined }
    }
    throw new ClaudeSettingsError(`failed to read ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  let stat
  try {
    stat = await fs.stat(settingsPath)
  } catch (err) {
    throw new ClaudeSettingsError(`failed to stat ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    if (looksLikeJsonc(raw)) {
      throw new ClaudeSettingsError(
        `${settingsPath} appears to be JSONC; refuse to modify`,
        { code: 'JSONC', cause: err }
      )
    }
    throw new ClaudeSettingsError(`malformed JSON in ${settingsPath}: ${errMsg(err)}`, {
      code: 'MALFORMED_JSON',
      cause: err,
    })
  }

  if (!isPlainObject(parsed)) {
    throw new ClaudeSettingsError(
      `${settingsPath} must contain a JSON object at the root`,
      { code: 'NOT_AN_OBJECT' }
    )
  }

  return { value: parsed, existed: true, mtimeMs: stat.mtimeMs }
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @param {number | undefined} expectedMtimeMs
 * @returns {Promise<void>}
 */
async function writeAtomic(filePath, value, expectedMtimeMs) {
  if (expectedMtimeMs !== undefined) {
    let current
    try {
      current = await fs.stat(filePath)
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        throw new ClaudeSettingsError(
          `${filePath} disappeared between read and write; retry`,
          { code: 'CONCURRENT_EDIT', cause: err }
        )
      }
      throw err
    }
    if (current.mtimeMs !== expectedMtimeMs) {
      throw new ClaudeSettingsError(
        `${filePath} changed on disk between read and write; retry`,
        { code: 'CONCURRENT_EDIT' }
      )
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  const body = JSON.stringify(value, null, 2) + '\n'
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`

  /** @type {FileHandle | undefined} */
  let handle
  try {
    handle = await fs.open(tmpPath, 'w', 0o600)
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    if (handle) await handle.close()
  }

  try {
    await fs.rename(tmpPath, filePath)
  } catch (err) {
    await fs.rm(tmpPath, { force: true })
    throw err
  }
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function ensureObject(value, key) {
  const existing = value[key]
  if (isPlainObject(existing)) return existing
  /** @type {Record<string, unknown>} */
  const fresh = {}
  value[key] = fresh
  return fresh
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} command
 */
function installSessionContextHooks(value, command) {
  const hooksRoot = ensureObject(value, 'hooks')
  for (const spec of MANAGED_HOOK_SPECS) {
    const { event } = spec
    const existing = hooksRoot[event]
    const groups = Array.isArray(existing)
      ? existing.filter((group) => !isManagedHookGroup(group)).map(removeManagedHandlers)
      : []
    groups.push({
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: 'command', command }],
    })
    hooksRoot[event] = groups
  }
}

/**
 * The managed session-context hook entries this attach installs,
 * recorded into the marker's undo record so the core undo can strip
 * exactly what `installSessionContextHooks` added without re-deriving
 * them from the (possibly unloaded) plugin.
 *
 * @param {string} command
 * @returns {{ event: string, matcher?: string, command: string }[]}
 */
function managedHookEntries(command) {
  return MANAGED_HOOK_SPECS.map((spec) => ({
    event: spec.event,
    ...(spec.matcher ? { matcher: spec.matcher } : {}),
    command,
  }))
}

/** @param {unknown} group */
function removeManagedHandlers(group) {
  if (!isPlainObject(group)) return group
  const handlers = group.hooks
  if (!Array.isArray(handlers)) return group
  return {
    ...group,
    hooks: handlers.filter((handler) => !isManagedHookHandler(handler)),
  }
}

/** @param {unknown} group */
function isManagedHookGroup(group) {
  if (!isPlainObject(group)) return false
  const handlers = group.hooks
  return Array.isArray(handlers) &&
    handlers.length > 0 &&
    handlers.every(isManagedHookHandler)
}

/** @param {unknown} handler */
function isManagedHookHandler(handler) {
  if (!isPlainObject(handler)) return false
  return handler.type === 'command' &&
    typeof handler.command === 'string' &&
    MANAGED_HOOK_PATTERN.test(handler.command)
}

/**
 * @param {string} binPath
 * @param {string} stateFile
 */
function managedHookCommand(binPath, stateFile) {
  return `${shellQuote(binPath)} claude-hook session-context --state-file ${shellQuote(stateFile)}`
}

/** @param {string} value */
function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value
  const quote = String.fromCharCode(39)
  return quote + value.split(quote).join(quote + '\\' + quote + quote) + quote
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {string} content */
function looksLikeJsonc(content) {
  let inString = false
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (inString) {
      if (c === '\\' && i + 1 < content.length) {
        i++
        continue
      }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '/' && i + 1 < content.length) {
      const next = content[i + 1]
      if (next === '/' || next === '*') return true
    }
  }
  return false
}

/** @param {unknown} port */
function validatePort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ClaudeSettingsError(`invalid port: ${String(port)}`, { code: 'INVALID_PORT' })
  }
}

/** @param {unknown} version */
function validateVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new ClaudeSettingsError('version must be a non-empty string', {
      code: 'INVALID_VERSION',
    })
  }
}

/** @param {unknown} stateFile */
function validateStateFile(stateFile) {
  if (typeof stateFile !== 'string' || stateFile.length === 0) {
    throw new ClaudeSettingsError('stateFile must be a non-empty path', {
      code: 'INVALID_STATE_FILE',
    })
  }
  if (!path.isAbsolute(stateFile)) {
    throw new ClaudeSettingsError(
      `stateFile must be an absolute path, got '${stateFile}'`,
      { code: 'INVALID_STATE_FILE' }
    )
  }
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

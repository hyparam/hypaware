// @ts-check

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Claude Code settings.json attach/detach writer. Ported from the
 * Collectivus donor `src/claude-code/settings.js`, with the managed
 * marker key renamed `_collectivus` → `_hypaware` and the embedded
 * hook command pointed at `hyp` instead of `ctvs`.
 *
 * Writes are atomic (temp file + rename) and gated on mtime so a
 * concurrent edit is detected instead of silently overwritten. The
 * `_hypaware` marker is what `detach()` keys off to know which keys
 * it inserted and is safe to remove.
 */

/**
 * @import { ClaudeAttachOptions, ClaudeAttachResult, ClaudeDetachOptions, ClaudeDetachResult } from './types.js'
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

  const env = ensureObject(value, 'env')
  const previous = env.ANTHROPIC_BASE_URL
  const prevValue = typeof previous === 'string' ? previous : undefined

  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  installSessionContextHooks(value, managedHookCommand(binPath, stateFile))
  value[MARKER_KEY] = {
    attached_at: new Date().toISOString(),
    version,
    port,
    state_file: stateFile,
  }

  await writeAtomic(settingsPath, value, mtimeMs)

  /** @type {ClaudeAttachResult} */
  const result = { changed: true }
  if (prevValue !== undefined) result.prevValue = prevValue
  return result
}

/**
 * Reverse a previous `attach`. No-op when settings.json is absent or
 * has no `_hypaware` marker. Removes `env.ANTHROPIC_BASE_URL` only
 * when it still matches the recorded port; otherwise leaves it and
 * surfaces a warning.
 *
 * @param {ClaudeDetachOptions} [opts]
 * @returns {Promise<ClaudeDetachResult>}
 */
export async function detach(opts = {}) {
  const { settingsPath = defaultSettingsPath() } = opts
  const { value, existed, mtimeMs } = await readSettings(settingsPath)

  if (!existed) return { changed: false }

  const marker = value[MARKER_KEY]
  if (!isPlainObject(marker)) return { changed: false }

  const markerPort = typeof marker.port === 'number' ? marker.port : undefined
  delete value[MARKER_KEY]
  removeSessionContextHooks(value)

  /** @type {string | undefined} */
  let removed
  /** @type {string | undefined} */
  let warning
  if (isPlainObject(value.env)) {
    const env = /** @type {Record<string, unknown>} */ (value.env)
    const current = env.ANTHROPIC_BASE_URL
    if (markerPort !== undefined && current === `http://127.0.0.1:${markerPort}`) {
      removed = /** @type {string} */ (current)
      delete env.ANTHROPIC_BASE_URL
    } else if (typeof current === 'string') {
      warning = 'ANTHROPIC_BASE_URL was overridden externally; leaving in place'
    }
    if (Object.keys(env).length === 0) delete value.env
  }

  await writeAtomic(settingsPath, value, mtimeMs)

  /** @type {ClaudeDetachResult} */
  const result = { changed: true }
  if (removed !== undefined) result.removed = removed
  if (warning !== undefined) result.warning = warning
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
 * @param {Record<string, unknown>} value
 */
function removeSessionContextHooks(value) {
  const hooksRoot = value.hooks
  if (!isPlainObject(hooksRoot)) return
  for (const event of managedHookEvents()) {
    const existing = hooksRoot[event]
    if (!Array.isArray(existing)) continue
    const groups = existing
      .filter((group) => !isManagedHookGroup(group))
      .map(removeManagedHandlers)
      .filter((group) => !isEmptyHookGroup(group))
    if (groups.length > 0) {
      hooksRoot[event] = groups
    } else {
      delete hooksRoot[event]
    }
  }
  if (Object.keys(hooksRoot).length === 0) delete value.hooks
}

function managedHookEvents() {
  return [...new Set(MANAGED_HOOK_SPECS.map((spec) => spec.event))]
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

/** @param {unknown} group */
function isEmptyHookGroup(group) {
  return isPlainObject(group) && Array.isArray(group.hooks) && group.hooks.length === 0
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

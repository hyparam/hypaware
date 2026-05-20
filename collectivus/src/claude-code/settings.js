import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * @import { FileHandle } from 'node:fs/promises'
 * @import { AttachOptions, AttachResult, DetachOptions, DetachResult, IsAttachedOptions, ReadSettingsResult } from '../types.js'
 */

const MANAGED_HOOK_SPECS = [
  { event: 'SessionStart' },
  { event: 'CwdChanged' },
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: 'Bash' },
]
const MANAGED_HOOK_PATTERN = /\bclaude-hook\s+session-context\b/

export class SettingsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'SettingsError'
    /** @type {string | undefined} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * Default settings.json location: `~/.claude/settings.json`.
 *
 * @returns {string}
 */
export function defaultSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

/**
 * Route Claude Code through the local collectivus proxy by writing a
 * `_collectivus` marker and `env.ANTHROPIC_BASE_URL` into settings.json.
 * Always overwrites the marker so timestamps stay current.
 *
 * @param {AttachOptions} opts
 * @returns {Promise<AttachResult>}
 */
export async function attach(opts) {
  const { port, version, settingsPath = defaultSettingsPath(), binPath = 'ctvs' } = opts
  validatePort(port)
  validateVersion(version)

  const { value, mtimeMs } = await readSettings(settingsPath)

  const env = ensureObject(value, 'env')
  const previous = env.ANTHROPIC_BASE_URL
  const prevValue = typeof previous === 'string' ? previous : undefined

  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  installSessionContextHooks(value, managedHookCommand(binPath, port))
  value._collectivus = {
    attached_at: new Date().toISOString(),
    version,
    port,
  }

  await writeAtomic(settingsPath, value, mtimeMs)

  /** @type {AttachResult} */
  const result = { changed: true }
  if (prevValue !== undefined) result.prevValue = prevValue
  return result
}

/**
 * Reverse a previous `attach`. No-op when settings.json is absent or has no
 * `_collectivus` marker. Removes `env.ANTHROPIC_BASE_URL` only when it still
 * matches the recorded port; otherwise leaves it and surfaces a warning.
 *
 * @param {DetachOptions} [opts]
 * @returns {Promise<DetachResult>}
 */
export async function detach(opts = {}) {
  const { settingsPath = defaultSettingsPath() } = opts
  const { value, existed, mtimeMs } = await readSettings(settingsPath)

  if (!existed) return { changed: false }

  const marker = value._collectivus
  if (!isPlainObject(marker)) return { changed: false }

  const markerPort = typeof marker.port === 'number' ? marker.port : undefined
  delete value._collectivus
  removeSessionContextHooks(value)

  /** @type {string | undefined} */
  let removed
  /** @type {string | undefined} */
  let warning
  if (isPlainObject(value.env)) {
    const { env } = value
    const current = env.ANTHROPIC_BASE_URL
    if (markerPort !== undefined && current === `http://127.0.0.1:${markerPort}`) {
      removed = current
      delete env.ANTHROPIC_BASE_URL
    } else if (typeof current === 'string') {
      warning = 'ANTHROPIC_BASE_URL was overridden externally; leaving in place'
    }
    if (Object.keys(env).length === 0) delete value.env
  }

  await writeAtomic(settingsPath, value, mtimeMs)

  /** @type {DetachResult} */
  const result = { changed: true }
  if (removed !== undefined) result.removed = removed
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * Return true when settings.json exists and carries a `_collectivus` marker.
 * Throws on a malformed file so callers see real problems instead of a
 * silent "not attached".
 *
 * @param {IsAttachedOptions} [opts]
 * @returns {Promise<boolean>}
 */
export async function isAttached(opts = {}) {
  const { settingsPath = defaultSettingsPath() } = opts
  const { value, existed } = await readSettings(settingsPath)
  if (!existed) return false
  return isPlainObject(value._collectivus)
}

/**
 * Read and parse settings.json. Returns an empty object when the file is
 * missing so attach() can create a fresh one. Throws SettingsError for any
 * other failure (malformed JSON, JSONC, non-object root, IO error).
 *
 * @param {string} settingsPath
 * @returns {Promise<ReadSettingsResult>}
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
    throw new SettingsError(`failed to read ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  let stat
  try {
    stat = await fs.stat(settingsPath)
  } catch (err) {
    throw new SettingsError(`failed to stat ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    if (looksLikeJsonc(raw)) {
      throw new SettingsError(
        `${settingsPath} appears to be JSONC; refuse to modify`,
        { code: 'JSONC', cause: err }
      )
    }
    throw new SettingsError(`malformed JSON in ${settingsPath}: ${errMsg(err)}`, {
      code: 'MALFORMED_JSON',
      cause: err,
    })
  }

  if (!isPlainObject(parsed)) {
    throw new SettingsError(
      `${settingsPath} must contain a JSON object at the root`,
      { code: 'NOT_AN_OBJECT' }
    )
  }

  return { value: parsed, existed: true, mtimeMs: stat.mtimeMs }
}

/**
 * Write `value` as pretty JSON to `filePath` atomically. If `expectedMtimeMs`
 * is defined, refuses to overwrite when the file's mtime has moved since the
 * read (best-effort concurrent-edit detection). Cleans up the tmp file on
 * rename failure.
 *
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
        throw new SettingsError(
          `${filePath} disappeared between read and write; retry`,
          { code: 'CONCURRENT_EDIT', cause: err }
        )
      }
      throw err
    }
    if (current.mtimeMs !== expectedMtimeMs) {
      throw new SettingsError(
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
 * Return `value[key]` when it's a plain object, otherwise replace it with a
 * fresh empty object. Used to prepare nested keys for mutation without
 * preserving non-object values that callers can't safely merge into.
 *
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
 * @returns {void}
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
 * @returns {void}
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

/**
 * @returns {string[]}
 */
function managedHookEvents() {
  return [...new Set(MANAGED_HOOK_SPECS.map((spec) => spec.event))]
}

/**
 * @param {unknown} group
 * @returns {unknown}
 */
function removeManagedHandlers(group) {
  if (!isPlainObject(group)) return group
  const handlers = group.hooks
  if (!Array.isArray(handlers)) return group
  return {
    ...group,
    hooks: handlers.filter((handler) => !isManagedHookHandler(handler)),
  }
}

/**
 * @param {unknown} group
 * @returns {boolean}
 */
function isManagedHookGroup(group) {
  if (!isPlainObject(group)) return false
  const handlers = group.hooks
  return Array.isArray(handlers) &&
    handlers.length > 0 &&
    handlers.every(isManagedHookHandler)
}

/**
 * @param {unknown} group
 * @returns {boolean}
 */
function isEmptyHookGroup(group) {
  return isPlainObject(group) && Array.isArray(group.hooks) && group.hooks.length === 0
}

/**
 * @param {unknown} handler
 * @returns {boolean}
 */
function isManagedHookHandler(handler) {
  if (!isPlainObject(handler)) return false
  return handler.type === 'command' &&
    typeof handler.command === 'string' &&
    MANAGED_HOOK_PATTERN.test(handler.command)
}

/**
 * @param {string} binPath
 * @param {number} port
 * @returns {string}
 */
function managedHookCommand(binPath, port) {
  return `${shellQuote(binPath)} claude-hook session-context --port ${port}`
}

/**
 * @param {string} value
 * @returns {string}
 */
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

/**
 * Best-effort detection of `//` or `/* ... *\/` comments outside string
 * literals. Used as a hint when JSON.parse fails so callers see "JSONC"
 * instead of a generic "Unexpected token /" message.
 *
 * @param {string} content
 * @returns {boolean}
 */
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

/**
 * @param {unknown} port
 * @returns {asserts port is number}
 */
function validatePort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SettingsError(`invalid port: ${String(port)}`, { code: 'INVALID_PORT' })
  }
}

/**
 * @param {unknown} version
 * @returns {asserts version is string}
 */
function validateVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new SettingsError('version must be a non-empty string', {
      code: 'INVALID_VERSION',
    })
  }
}

/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
function errCode(err) {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined
  const { code } = err
  return typeof code === 'string' ? code : undefined
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}

// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { ConcurrentEditError, atomicWriteFile, errCode, isPlainObject } from 'hypaware/core/util'
import { resolveClientSettingsPath } from '../../../../src/core/daemon/client_settings_path.js'

/**
 * OpenClaw openclaw.json attach writer.
 *
 * OpenClaw strictly validates its config root: an unknown root key makes
 * its own gateway refuse to start, so the attach marker cannot be a
 * top-level `_hypaware` key like Claude's. Instead the marker is the
 * injected `models.providers.hypaware` entry itself, and the
 * self-describing undo record (LLP 0045 Part 3) rides that provider's
 * schema-legal free-form `headers` map as the `x-hypaware-marker`
 * value. The same headers map injects `x-hypaware-client: openclaw`
 * onto every request so the gateway projector has a deterministic
 * match signal.
 *
 * Writes are atomic (temp file + rename) and gated on mtime so a
 * concurrent edit is detected instead of silently overwritten. There is
 * no adapter `detach()`; the reverse is the single core disk-driven undo
 * (`detachClientFromDisk`, `json_path` format) keyed off the manifest
 * `attach_probe`.
 *
 * @ref LLP 0109#decision [implements]: dedicated `hypaware` provider entry whose headers map carries the undo record
 */

/**
 * @import { JsonObject } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { Stats } from 'node:fs'
 */

export const CLIENT_NAME = 'openclaw'
export const SETTINGS_FILE = '.openclaw/openclaw.json'
export const PROVIDER_ID = 'hypaware'
export const PROVIDER_PATH = 'models.providers.hypaware'
export const PRIMARY_PATH = 'agents.defaults.model.primary'
export const MODELS_ALLOWLIST_PATH = 'agents.defaults.models'
export const CLIENT_HEADER = 'x-hypaware-client'
export const MARKER_HEADER = 'x-hypaware-marker'

const ANTHROPIC_PREFIX = 'anthropic/'

export class OpenclawSettingsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'OpenclawSettingsError'
    /** @type {string | undefined} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * Default OpenClaw config location: `~/.openclaw/openclaw.json`, with
 * `OPENCLAW_HOME` replacing the `.openclaw` component. Resolved through
 * the same core seam the daemon status probe and the core detach use,
 * so the plugin and the plugin-agnostic undo can never disagree on the
 * path.
 *
 * @ref LLP 0109#attach-plugin-owned [implements]: HOME-relative; OPENCLAW_HOME overrides via the generic resolveClientSettingsPath seam
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {string} homeDir
 * @returns {string}
 */
export function defaultSettingsPath(env, homeDir) {
  return resolveClientSettingsPath(CLIENT_NAME, SETTINGS_FILE, env, homeDir)
}

/**
 * Pure attach transform over a parsed openclaw.json object. Never
 * mutates `configObject`; returns the next config object plus what
 * changed, or throws an `OpenclawSettingsError` refusal.
 *
 * First attach:
 *  - requires `agents.defaults.model.primary` to be `anthropic/<model>`
 *    (absent or non-Anthropic primaries are refused with a clear error:
 *    v1 cannot know OpenClaw's built-in default, and only the Anthropic
 *    Messages path is supported);
 *  - adds `models.providers.hypaware` pointing at the local gateway,
 *    with the undo record in `headers[x-hypaware-marker]`;
 *  - repoints the primary to `hypaware/<model>` and, when an
 *    `agents.defaults.models` allowlist exists, appends
 *    `hypaware/<model>` to it (recording the addition).
 *
 * Re-attach (provider already present): same port is a no-op; a new
 * port rewrites `baseUrl` and the record's `port`/`attached_at`/
 * `version` while preserving the ORIGINAL `managed` undo record (prev
 * values, created parents, appends), so detach after any number of
 * re-attaches still restores the user's own settings.
 *
 * @ref LLP 0109#attach-plugin-owned [implements]: the undo record shape ({ managed: { added, created_parents, set, appended } })
 * @param {Record<string, unknown>} configObject
 * @param {{ port: number, version: string, attachedAt?: string }} opts
 * @returns {{
 *   config: Record<string, unknown>,
 *   changed: boolean,
 *   action: 'attached' | 'updated' | 'noop',
 *   model: string | undefined,
 *   prevPrimary: string | undefined,
 * }}
 */
export function prepareAttach(configObject, opts) {
  validatePort(opts.port)
  validateVersion(opts.version)
  const attachedAt = opts.attachedAt ?? new Date().toISOString()
  const config = structuredClone(configObject)

  const existingProvider = readProvider(config)
  if (existingProvider) {
    return reattach(config, existingProvider, { port: opts.port, version: opts.version, attachedAt })
  }

  const primary = readPath(config, ['agents', 'defaults', 'model', 'primary'])
  if (typeof primary !== 'string' || primary.length === 0) {
    // Without a primary we cannot know which model OpenClaw's built-in
    // default resolves to, so there is nothing safe to mirror into the
    // injected provider's models list or to repoint.
    // @ref LLP 0109#attach-plugin-owned [constrained-by]: v1 scope guard
    throw new OpenclawSettingsError(
      `OpenClaw config has no ${PRIMARY_PATH}; set it to an anthropic/<model> id ` +
        '(e.g. anthropic/claude-sonnet-4-5) and re-run hyp attach - HypAware cannot ' +
        "know OpenClaw's built-in default model",
      { code: 'NO_PRIMARY_MODEL' }
    )
  }
  const model = primary.startsWith(ANTHROPIC_PREFIX)
    ? primary.slice(ANTHROPIC_PREFIX.length)
    : ''
  if (model.length === 0) {
    throw new OpenclawSettingsError(
      `OpenClaw primary model is '${primary}'; v1 attach supports only Anthropic ` +
        `primaries - set ${PRIMARY_PATH} to anthropic/<model> and re-run hyp attach`,
      { code: 'NON_ANTHROPIC_PRIMARY' }
    )
  }
  const managedPrimary = `${PROVIDER_ID}/${model}`

  // Create the provider's parent objects, recording ONLY the ones this
  // attach actually created so the core undo prunes exactly what we
  // added and never deletes a `models` subtree the user already had.
  /** @type {string[]} */
  const createdParents = []
  const models = ensureObjectAt(config, 'models', createdParents, 'models')
  const providers = ensureObjectAt(models, 'providers', createdParents, 'models.providers')

  /** @type {Array<{ path: string, value: string, prev: string }>} */
  const set = [{ path: PRIMARY_PATH, value: managedPrimary, prev: primary }]
  writePath(config, ['agents', 'defaults', 'model', 'primary'], managedPrimary)

  // Model allowlist: OpenClaw refuses a primary that fails the optional
  // `agents.defaults.models` allowlist, so the managed id must join it.
  // Recorded only when actually appended, so detach never removes a
  // value the user listed themselves.
  /** @type {Array<{ path: string, value: string }>} */
  const appended = []
  const allowlist = readPath(config, ['agents', 'defaults', 'models'])
  if (Array.isArray(allowlist) && !allowlist.includes(managedPrimary)) {
    allowlist.push(managedPrimary)
    appended.push({ path: MODELS_ALLOWLIST_PATH, value: managedPrimary })
  }

  const record = {
    attached_at: attachedAt,
    version: opts.version,
    port: opts.port,
    managed: {
      added: [PROVIDER_PATH],
      created_parents: createdParents,
      set,
      appended,
    },
  }
  providers[PROVIDER_ID] = buildProvider(opts.port, [model], record)

  return { config, changed: true, action: 'attached', model, prevPrimary: primary }
}

/**
 * Handle a re-attach: the managed provider already exists, so parse its
 * marker record and either no-op (same port) or rewrite the gateway
 * port while preserving the original undo record.
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} provider
 * @param {{ port: number, version: string, attachedAt: string }} opts
 * @returns {ReturnType<typeof prepareAttach>}
 */
function reattach(config, provider, opts) {
  const headers = isPlainObject(provider.headers) ? provider.headers : undefined
  const rawRecord = headers ? headers[MARKER_HEADER] : undefined
  /** @type {unknown} */
  let record
  try {
    record = typeof rawRecord === 'string' ? JSON.parse(rawRecord) : undefined
  } catch {
    record = undefined
  }
  if (!headers || !isPlainObject(record) || !isPlainObject(record.managed)) {
    throw new OpenclawSettingsError(
      `${PROVIDER_PATH} exists but carries no parseable ${MARKER_HEADER} undo record; ` +
        'remove the provider entry manually (or run hyp detach --client openclaw after ' +
        'restoring the record) before re-attaching',
      { code: 'MALFORMED_MARKER' }
    )
  }

  const managed = record.managed
  const setEntries = Array.isArray(managed.set) ? managed.set.filter(isPlainObject) : []
  const prevPrimary = typeof setEntries[0]?.prev === 'string' ? setEntries[0].prev : undefined
  const providerModels = Array.isArray(provider.models)
    ? provider.models.filter((m) => typeof m === 'string')
    : []
  const model = typeof providerModels[0] === 'string' ? providerModels[0] : undefined

  if (record.port === opts.port) {
    return { config, changed: false, action: 'noop', model, prevPrimary }
  }

  // Port changed: rewrite baseUrl and the record's envelope fields, but
  // keep the ORIGINAL `managed` block so `prev` still names the user's
  // own pre-attach values, never a value we wrote ourselves.
  // @ref LLP 0044#conflict--back-up--override-restore-on-leave [constrained-by]: the marker IS the backup restored on leave
  provider.baseUrl = gatewayBaseUrl(opts.port)
  headers[CLIENT_HEADER] = CLIENT_NAME
  headers[MARKER_HEADER] = JSON.stringify({
    attached_at: opts.attachedAt,
    version: opts.version,
    port: opts.port,
    managed,
  })
  return { config, changed: true, action: 'updated', model, prevPrimary }
}

/**
 * The injected provider entry. Every field is schema-legal OpenClaw
 * config: `${ANTHROPIC_API_KEY}` is OpenClaw's own env interpolation
 * (attach warns when the variable is unset, see `attach()`), and the
 * custom baseUrl origin is automatically allowed by OpenClaw's network
 * policy.
 *
 * @param {number} port
 * @param {string[]} models
 * @param {unknown} record
 * @returns {Record<string, unknown>}
 */
function buildProvider(port, models, record) {
  return {
    baseUrl: gatewayBaseUrl(port),
    api: 'anthropic-messages',
    apiKey: '${ANTHROPIC_API_KEY}',
    headers: {
      [CLIENT_HEADER]: CLIENT_NAME,
      [MARKER_HEADER]: JSON.stringify(record),
    },
    models,
  }
}

/** @param {number} port */
function gatewayBaseUrl(port) {
  return `http://127.0.0.1:${port}`
}

/**
 * Route OpenClaw through the local AI gateway by rewriting
 * `~/.openclaw/openclaw.json` (see `prepareAttach` for the transform).
 * This is the I/O wrapper the gateway client registration calls: it
 * resolves the settings path, refuses symlinked or JSON5-styled config
 * files, performs the atomic mtime-gated write, warns (non-fatally) when
 * `ANTHROPIC_API_KEY` is unset, and renders the attach output (JSON or
 * human prose) onto the attach context's streams.
 *
 * @param {{
 *   endpoint: string,
 *   stdout: { write(chunk: string): unknown },
 *   stderr: { write(chunk: string): unknown },
 *   dryRun?: boolean,
 *   json?: boolean,
 *   env: NodeJS.ProcessEnv,
 *   homeDir: string,
 *   version: string,
 *   settingsPath?: string,
 * }} opts
 * @returns {Promise<{ changed: boolean, action: 'attached' | 'updated' | 'noop' | 'dry_run', settingsPath: string, prevPrimary?: string }>}
 */
export async function attach(opts) {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath(opts.env, opts.homeDir)

  if (typeof opts.env.ANTHROPIC_API_KEY !== 'string' || opts.env.ANTHROPIC_API_KEY.length === 0) {
    // Non-fatal: the injected provider authenticates via OpenClaw's own
    // `${ANTHROPIC_API_KEY}` env interpolation; OpenClaw auth-alias or
    // keychain credentials are not visible to a custom provider.
    // @ref LLP 0109#known-v1-limitations-revisit-triggers [implements]: attach warns when the env var is unset
    opts.stderr.write(
      'warning: ANTHROPIC_API_KEY is not set; the injected OpenClaw provider ' +
        'authenticates via ${ANTHROPIC_API_KEY} and will fail until it is exported\n'
    )
  }

  if (opts.dryRun) {
    const port = safePort(opts.endpoint)
    /** @type {ReturnType<typeof prepareAttach> | undefined} */
    let prepared
    if (port !== undefined) {
      // Read-only plan: run the pure transform against the on-disk config
      // so a dry run reports the real action (and surfaces refusals such
      // as a non-Anthropic primary) without writing anything.
      const { value } = await readSettings(settingsPath)
      prepared = prepareAttach(value, { port, version: opts.version })
    }
    writeAttachOutput(opts, {
      status: 'ok',
      dryRun: true,
      settingsPath,
      port,
      changed: false,
      action: prepared?.action,
      model: prepared?.model,
      prevPrimary: prepared?.prevPrimary,
    })
    return { changed: false, action: 'dry_run', settingsPath }
  }

  const port = endpointPort(opts.endpoint)
  const { value, mtimeMs } = await readSettings(settingsPath)
  const prepared = prepareAttach(value, { port, version: opts.version })
  if (prepared.changed) {
    await writeAtomic(settingsPath, prepared.config, mtimeMs)
  }
  writeAttachOutput(opts, {
    status: 'ok',
    dryRun: false,
    settingsPath,
    port,
    changed: prepared.changed,
    action: prepared.action,
    model: prepared.model,
    prevPrimary: prepared.prevPrimary,
  })
  /** @type {{ changed: boolean, action: 'attached' | 'updated' | 'noop', settingsPath: string, prevPrimary?: string }} */
  const result = { changed: prepared.changed, action: prepared.action, settingsPath }
  if (prepared.prevPrimary !== undefined) result.prevPrimary = prepared.prevPrimary
  return result
}

/**
 * @param {string} settingsPath
 * @returns {Promise<{ value: Record<string, unknown>, existed: boolean, mtimeMs: number | undefined }>}
 */
async function readSettings(settingsPath) {
  // OpenClaw hot-reloads the file and replaces it by rename; writing
  // through a symlink would silently retarget whatever it points at and
  // desync from what OpenClaw re-reads, so refuse up front.
  // @ref LLP 0109#attach-plugin-owned [implements]: writes are atomic, mtime-gated, and never through a symlink
  /** @type {Stats | undefined} */
  let lstat
  try {
    lstat = await fs.lstat(settingsPath)
  } catch (err) {
    if (errCode(err) !== 'ENOENT') {
      throw new OpenclawSettingsError(`failed to stat ${settingsPath}: ${errMsg(err)}`, { cause: err })
    }
  }
  if (lstat?.isSymbolicLink()) {
    throw new OpenclawSettingsError(
      `${settingsPath} is a symlink; refusing to rewrite it (OpenClaw replaces the file by rename)`,
      { code: 'SYMLINK' }
    )
  }
  if (!lstat) {
    return { value: {}, existed: false, mtimeMs: undefined }
  }

  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    throw new OpenclawSettingsError(`failed to read ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // OpenClaw accepts JSON5, but rewriting a commented config through
    // JSON.stringify would destroy the user's comments; refuse instead,
    // mirroring the Claude adapter's JSONC refusal.
    // @ref LLP 0109#attach-plugin-owned [implements]: JSON5 comment syntax is refused rather than destroyed
    if (looksLikeJson5(raw)) {
      throw new OpenclawSettingsError(
        `${settingsPath} contains JSON5 comment syntax; refusing to rewrite it - ` +
          'convert the file to strict JSON and re-run hyp attach',
        { code: 'JSON5', cause: err }
      )
    }
    throw new OpenclawSettingsError(
      `malformed JSON in ${settingsPath}: ${errMsg(err)} - the file must parse as strict JSON`,
      { code: 'MALFORMED_JSON', cause: err }
    )
  }

  if (!isPlainObject(parsed)) {
    throw new OpenclawSettingsError(
      `${settingsPath} must contain a JSON object at the root`,
      { code: 'NOT_AN_OBJECT' }
    )
  }

  return { value: parsed, existed: true, mtimeMs: lstat.mtimeMs }
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @param {number | undefined} expectedMtimeMs
 * @returns {Promise<void>}
 */
async function writeAtomic(filePath, value, expectedMtimeMs) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const body = JSON.stringify(value, null, 2) + '\n'
  try {
    await atomicWriteFile(filePath, body, { mode: 0o600, fsync: true, expectedMtimeMs })
  } catch (err) {
    if (err instanceof ConcurrentEditError) {
      throw new OpenclawSettingsError(err.message, { code: 'CONCURRENT_EDIT', cause: err.cause ?? err })
    }
    throw err
  }
}

/**
 * Render attach output: machine-readable JSON when `json` is set,
 * otherwise human prose. Keeps the JSON shape stable (`status`,
 * `action`, `client`, `dry_run` at minimum) so callers can grep it.
 *
 * @param {{ stdout: { write(chunk: string): unknown }, json?: boolean }} streams
 * @param {{
 *   status: 'ok' | 'failed',
 *   dryRun: boolean,
 *   settingsPath: string,
 *   port: number | undefined,
 *   changed: boolean,
 *   action: 'attached' | 'updated' | 'noop' | undefined,
 *   model: string | undefined,
 *   prevPrimary: string | undefined,
 * }} fields
 */
function writeAttachOutput(streams, fields) {
  if (streams.json) {
    /** @type {Record<string, unknown>} */
    const payload = {
      status: fields.status,
      action: 'attach',
      client: CLIENT_NAME,
      dry_run: fields.dryRun,
      settings_path: fields.settingsPath,
      changed: fields.changed,
    }
    if (fields.port !== undefined) payload.port = fields.port
    if (fields.prevPrimary !== undefined) payload.prev_value = fields.prevPrimary
    streams.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  if (fields.dryRun) {
    streams.stdout.write(`(dry-run) Would attach OpenClaw via ${fields.settingsPath}\n`)
    if (fields.port !== undefined) {
      streams.stdout.write(`  Would add ${PROVIDER_PATH} -> ${gatewayBaseUrl(fields.port)}\n`)
    }
    if (fields.model !== undefined && fields.action !== 'noop') {
      streams.stdout.write(`  Would set ${PRIMARY_PATH} = ${PROVIDER_ID}/${fields.model}\n`)
    }
    return
  }
  if (fields.action === 'noop') {
    streams.stdout.write(`✓ OpenClaw already attached (${fields.settingsPath})\n`)
    return
  }
  streams.stdout.write(`✓ OpenClaw attached (${fields.settingsPath})\n`)
  if (fields.port !== undefined) {
    streams.stdout.write(`  ${PROVIDER_PATH} -> ${gatewayBaseUrl(fields.port)}\n`)
  }
  if (fields.model !== undefined) {
    streams.stdout.write(`  ${PRIMARY_PATH} = ${PROVIDER_ID}/${fields.model}\n`)
  }
  if (fields.prevPrimary !== undefined) {
    streams.stdout.write(`  (previous primary was ${fields.prevPrimary})\n`)
  }
}

/**
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown> | undefined}
 */
function readProvider(config) {
  const provider = readPath(config, ['models', 'providers', PROVIDER_ID])
  return isPlainObject(provider) ? provider : undefined
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} segments
 * @returns {unknown}
 */
function readPath(obj, segments) {
  /** @type {unknown} */
  let current = obj
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined
    current = current[segment]
  }
  return current
}

/**
 * Set a value at a dotted path whose parents are known to exist as
 * objects (the caller read the leaf beforehand). No-op when a parent
 * is missing, which cannot happen on the prepareAttach path.
 *
 * @param {Record<string, unknown>} obj
 * @param {string[]} segments
 * @param {unknown} value
 */
function writePath(obj, segments, value) {
  const parent = readPath(obj, segments.slice(0, -1))
  if (isPlainObject(parent)) parent[segments[segments.length - 1]] = value
}

/**
 * Get-or-create `parent[key]` as an object, appending `recordedPath` to
 * `createdParents` only when the key did not exist. A key that exists
 * with a non-object value is a config OpenClaw itself would refuse, so
 * we refuse too instead of clobbering it.
 *
 * @param {Record<string, unknown>} parent
 * @param {string} key
 * @param {string[]} createdParents
 * @param {string} recordedPath
 * @returns {Record<string, unknown>}
 */
function ensureObjectAt(parent, key, createdParents, recordedPath) {
  const existing = parent[key]
  if (isPlainObject(existing)) return existing
  if (existing !== undefined) {
    throw new OpenclawSettingsError(
      `OpenClaw config key '${recordedPath}' is not an object; fix the config and re-run hyp attach`,
      { code: 'MALFORMED_CONFIG' }
    )
  }
  /** @type {Record<string, unknown>} */
  const fresh = {}
  parent[key] = fresh
  createdParents.push(recordedPath)
  return fresh
}

/**
 * @param {string} endpoint
 * @returns {number}
 */
function endpointPort(endpoint) {
  const port = safePort(endpoint)
  if (port === undefined) {
    throw new OpenclawSettingsError(
      `@hypaware/openclaw: cannot derive port from endpoint '${endpoint}'`,
      { code: 'INVALID_ENDPOINT' }
    )
  }
  return port
}

/**
 * Like `endpointPort`, but tolerates the placeholder dry-run endpoint
 * (`http://127.0.0.1:0`) the dispatcher uses when the gateway source
 * is not yet started.
 *
 * @param {string} endpoint
 * @returns {number | undefined}
 */
function safePort(endpoint) {
  try {
    const url = new URL(endpoint)
    const port = Number.parseInt(url.port, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
    return port
  } catch {
    return undefined
  }
}

/**
 * Comment syntax (`//` or a block comment) outside string literals: the
 * JSON5/JSONC construct that would be destroyed by a JSON.stringify
 * rewrite. Other JSON5-only constructs simply fail strict parsing and
 * surface as MALFORMED_JSON.
 *
 * @param {string} content
 */
function looksLikeJson5(content) {
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
    throw new OpenclawSettingsError(`invalid port: ${String(port)}`, { code: 'INVALID_PORT' })
  }
}

/** @param {unknown} version */
function validateVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new OpenclawSettingsError('version must be a non-empty string', {
      code: 'INVALID_VERSION',
    })
  }
}

/** @param {unknown} err */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}

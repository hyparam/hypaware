import fs from 'node:fs'
import process from 'node:process'
import { GATEWAY_ID_MAX_LENGTH, GATEWAY_ID_PATTERN, isValidGatewayId } from './gateway_id.js'

/**
 * @import { CollectivusConfig } from './types.js'
 */

export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{ pointer?: string }} [opts]
   */
  constructor(message, opts = {}) {
    const { pointer } = opts
    super(pointer ? `${pointer}: ${message}` : message)
    this.name = 'ConfigError'
    /** @type {string | undefined} */
    this.pointer = pointer
  }
}

const ALLOWED_TOP_KEYS = new Set([
  'version', 'role', 'gateway_id', 'otel', 'proxy', 'sink', 'upload', 'query', 'server', 'central_server', 'gascity',
])
const ALLOWED_GASCITY_KEYS = new Set(['name', 'api_url', 'include_templates', 'exclude_templates'])
const ALLOWED_PROXY_KEYS = new Set(['listen', 'upstreams', 'redact_headers'])
const ALLOWED_UPSTREAM_KEYS = new Set(['name', 'base_url', 'match'])
const ALLOWED_SINK_KEYS = new Set(['type', 'dir'])
const ALLOWED_UPLOAD_KEYS = new Set([
  'bucket', 'prefix', 'region', 'time', 'signals', 'catchupDays', 'endpoint',
])
const ALLOWED_QUERY_KEYS = new Set(['cache'])
const ALLOWED_QUERY_CACHE_KEYS = new Set(['enabled', 'dir'])
const ALLOWED_SERVER_KEYS = new Set([
  'control_plane_listen', 'public_url', 'identity_issuer', 'data_dir', 'sink_dir', 'ingest',
  'admin', 'enrollment', 'rendezvous',
])
const ALLOWED_INGEST_KEYS = new Set([
  'max_pending_rows', 'high_water_pct', 'retry_after_seconds', 'max_bytes_per_second',
])
const ALLOWED_IDENTITY_ISSUER_KEYS = new Set([
  'secret', 'secret_env', 'jwt_ttl_seconds', 'bootstrap_ttl_seconds', 'bootstrap_store_path',
])
const ALLOWED_ADMIN_KEYS = new Set(['token', 'token_env'])
const ALLOWED_ENROLLMENT_KEYS = new Set(['gateway_prefix'])
const ALLOWED_RENDEZVOUS_KEYS = new Set([
  'url', 'url_env', 'registration_token', 'registration_token_env',
])
const ALLOWED_CENTRAL_SERVER_KEYS = new Set(['url', 'identity', 'poll_interval_seconds', 'outbox_dir'])
const ALLOWED_CENTRAL_IDENTITY_KEYS = new Set(['bootstrap_token', 'persisted_path'])
const ALLOWED_ROLES = new Set(['server', 'gateway', 'standalone'])
const ALLOWED_SIGNALS = new Set(['logs', 'traces', 'metrics', 'proxy'])
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const IDENTITY_SECRET_MIN_LENGTH = 32
const ADMIN_TOKEN_MIN_LENGTH = 32

/**
 * Returns true when `value` is a `http://` or `https://` URL that
 * `loadConfigAsync` should fetch instead of reading from disk.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isConfigUrl(value) {
  return /^https?:\/\//i.test(value)
}

/**
 * Load and validate a collectivus JSON config file.
 *
 * @param {string} configPath - Absolute or relative path to a JSON config file.
 * @param {{ strict?: boolean, stderr?: { write: (s: string) => void } }} [opts]
 *   `strict=true` rejects unknown top-level keys; the default warns to stderr
 *   and proceeds. Per-section unknown keys are always rejected.
 * @returns {CollectivusConfig} The parsed and validated config.
 * @throws {ConfigError} when the file is missing, JSON is invalid, or the schema check fails.
 */
export function loadConfig(configPath, opts = {}) {
  let raw
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') {
      throw new ConfigError(`config file not found: ${configPath}`)
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`failed to read ${configPath}: ${msg}`)
  }

  return parseConfig(raw, configPath, opts)
}

/**
 * Load and validate a collectivus JSON config from either a local path or
 * an `http(s)://` URL. URLs are fetched with `globalThis.fetch`; non-URL
 * values fall through to the sync `loadConfig` reader.
 *
 * @param {string} pathOrUrl
 * @param {{ strict?: boolean, stderr?: { write: (s: string) => void }, fetch?: typeof fetch }} [opts]
 * @returns {Promise<CollectivusConfig>}
 * @throws {ConfigError} when the source is unreachable, the body is not JSON, or the schema check fails.
 */
export async function loadConfigAsync(pathOrUrl, opts = {}) {
  if (!isConfigUrl(pathOrUrl)) return loadConfig(pathOrUrl, opts)

  const fetchFn = opts.fetch ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new ConfigError(`fetch is not available; cannot load config from ${pathOrUrl}`)
  }

  let response
  try {
    response = await fetchFn(pathOrUrl)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`failed to fetch ${pathOrUrl}: ${msg}`)
  }

  if (!response.ok) {
    throw new ConfigError(
      `failed to fetch ${pathOrUrl}: HTTP ${response.status} ${response.statusText}`
    )
  }

  let raw
  try {
    raw = await response.text()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`failed to read response body from ${pathOrUrl}: ${msg}`)
  }

  return parseConfig(raw, pathOrUrl, opts)
}

/**
 * Parse a raw JSON config string and run schema validation. The `source`
 * argument is only used to render error locations.
 *
 * @param {string} raw
 * @param {string} source
 * @param {{ strict?: boolean, stderr?: { write: (s: string) => void } }} [opts]
 * @returns {CollectivusConfig}
 */
export function parseConfig(raw, source, opts = {}) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const location = jsonErrorLocation(raw, msg)
    throw new ConfigError(`invalid JSON in ${source}${location}: ${msg}`)
  }

  validateConfig(parsed, {
    strict: opts.strict ?? false,
    stderr: opts.stderr ?? process.stderr,
  })
  return parsed
}

/**
 * Extract `at line N, column M` from a `JSON.parse` error message.
 * V8 reports `position N`; older runtimes may report `line N column M`. If we
 * can't find an offset, return an empty string and leave the location off.
 *
 * @param {string} raw - The original JSON source.
 * @param {string} msg - The error message from JSON.parse.
 * @returns {string} A leading-space location string, or '' when not derivable.
 */
function jsonErrorLocation(raw, msg) {
  const posMatch = /position (\d+)/.exec(msg)
  if (posMatch) {
    const offset = Number.parseInt(posMatch[1], 10)
    const before = raw.slice(0, Math.min(offset, raw.length))
    const line = before.split('\n').length
    const lastNewline = before.lastIndexOf('\n')
    const column = lastNewline === -1 ? before.length + 1 : before.length - lastNewline
    return ` at line ${line}, column ${column}`
  }
  const lineMatch = /line (\d+) column (\d+)/.exec(msg)
  if (lineMatch) return ` at line ${lineMatch[1]}, column ${lineMatch[2]}`
  return ''
}

/**
 * Validate an in-memory config object the way a gateway would when loading
 * one off disk. Used by the server-side config registry to reject configs at
 * write time that would fail to load on the receiving gateway.
 *
 * Defaults match `loadConfig`: non-strict (unknown top keys warn, not error),
 * stderr swallowed so the validator can be called from non-CLI contexts.
 *
 * @param {unknown} cfg
 * @param {{ strict?: boolean, stderr?: { write: (s: string) => void } }} [opts]
 * @returns {asserts cfg is CollectivusConfig}
 */
export function validateCollectivusConfig(cfg, opts = {}) {
  validateConfig(cfg, {
    strict: opts.strict ?? false,
    stderr: opts.stderr ?? { write: () => {} },
  })
}

/**
 * @param {unknown} cfg
 * @param {{ strict: boolean, stderr: { write: (s: string) => void } }} opts
 * @returns {asserts cfg is CollectivusConfig}
 */
function validateConfig(cfg, opts) {
  assertObject(cfg, '')
  // version is checked first so a v0 file fails with the documented hard
  // error instead of being routed through the unknown-key paths below.
  if (!Object.prototype.hasOwnProperty.call(cfg, 'version')) {
    throw new ConfigError(
      'missing "version" field. This collectivus binary requires version: 1.',
      { pointer: '/version' }
    )
  }
  if (cfg.version !== 1) {
    throw new ConfigError(
      `unsupported version ${JSON.stringify(cfg.version)}. This collectivus binary requires version: 1.`,
      { pointer: '/version' }
    )
  }

  if (opts.strict) {
    assertOnlyKeys(cfg, ALLOWED_TOP_KEYS, '')
  } else {
    warnUnknownTopKeys(cfg, opts.stderr)
  }

  if (cfg.gateway_id !== undefined) validateGatewayId(cfg.gateway_id)
  if (cfg.otel !== undefined) validateOtel(cfg.otel)
  if (cfg.proxy !== undefined) validateProxy(cfg.proxy)
  const role = cfg.role === undefined ? 'standalone' : cfg.role
  if ((cfg.otel !== undefined || cfg.proxy !== undefined) && cfg.sink === undefined && role !== 'gateway') {
    throw new ConfigError(
      'sink is required when otel or proxy is configured',
      { pointer: '/sink' }
    )
  }
  if (cfg.sink !== undefined) validateSink(cfg.sink)
  if (cfg.upload !== undefined) validateUpload(cfg.upload)
  if (cfg.query !== undefined) validateQuery(cfg.query)
  if (cfg.gascity !== undefined) validateGascity(cfg.gascity)
  validateRole(cfg)
}

/**
 * Validate `role` and the role-bound `server` / `central_server` blocks.
 *
 * The role-↔-block contract is enforced here rather than inside the per-block
 * validators because the constraints are cross-field (a `server` block alone
 * is not enough to know whether it's allowed; we need `role` too). An absent
 * `role` is treated as `standalone`.
 *
 * @param {Record<string, unknown>} cfg
 */
function validateRole(cfg) {
  const role = cfg.role === undefined ? 'standalone' : cfg.role
  if (typeof role !== 'string' || !ALLOWED_ROLES.has(role)) {
    throw new ConfigError(
      'must be one of "server", "gateway", "standalone"',
      { pointer: '/role' }
    )
  }
  if (role !== 'standalone' && cfg.gateway_id !== undefined) {
    throw new ConfigError(
      `gateway_id is only permitted when role is "standalone"; ${role} mode derives it from the JWT`,
      { pointer: '/gateway_id' }
    )
  }
  if (role === 'server') {
    if (cfg.server === undefined) {
      throw new ConfigError(
        'server block is required when role is "server"',
        { pointer: '/server' }
      )
    }
    if (cfg.central_server !== undefined) {
      throw new ConfigError(
        'central_server is not permitted when role is "server"',
        { pointer: '/central_server' }
      )
    }
    validateServer(cfg.server)
  } else if (role === 'gateway') {
    if (cfg.central_server === undefined) {
      throw new ConfigError(
        'central_server block is required when role is "gateway"',
        { pointer: '/central_server' }
      )
    }
    if (cfg.server !== undefined) {
      throw new ConfigError(
        'server is not permitted when role is "gateway"',
        { pointer: '/server' }
      )
    }
    validateCentralServer(cfg.central_server)
  } else {
    if (cfg.server !== undefined) {
      throw new ConfigError(
        'server is only permitted when role is "server"',
        { pointer: '/server' }
      )
    }
    if (cfg.central_server !== undefined) {
      throw new ConfigError(
        'central_server is only permitted when role is "gateway"',
        { pointer: '/central_server' }
      )
    }
  }
}

/** @param {unknown} server */
function validateServer(server) {
  assertObject(server, '/server')
  assertOnlyKeys(server, ALLOWED_SERVER_KEYS, '/server')
  if (server.control_plane_listen === undefined) {
    throw new ConfigError(
      'control_plane_listen is required',
      { pointer: '/server/control_plane_listen' }
    )
  }
  assertHostPort(server.control_plane_listen, '/server/control_plane_listen')
  if (server.public_url !== undefined) {
    assertHttpUrl(server.public_url, '/server/public_url')
  }
  if (server.identity_issuer === undefined) {
    throw new ConfigError(
      'identity_issuer is required',
      { pointer: '/server/identity_issuer' }
    )
  }
  validateIdentityIssuer(server.identity_issuer)
  if (server.data_dir !== undefined) {
    assertNonEmptyString(server.data_dir, '/server/data_dir')
  }
  if (server.sink_dir !== undefined) {
    assertNonEmptyString(server.sink_dir, '/server/sink_dir')
  }
  if (server.ingest !== undefined) {
    validateIngest(server.ingest)
  }
  if (server.admin !== undefined) {
    validateAdmin(server.admin)
    // Admin invite responses bake `public_url` into the join command; a
    // missing value produces a broken `npx collectivus join` line, so
    // require it explicitly whenever admin is active.
    if (server.public_url === undefined) {
      throw new ConfigError(
        'public_url is required when server.admin is configured',
        { pointer: '/server/public_url' }
      )
    }
  }
  if (server.enrollment !== undefined) {
    validateEnrollment(server.enrollment)
  }
  if (server.rendezvous !== undefined) {
    validateRendezvous(server.rendezvous)
  }
}

/** @param {unknown} admin */
function validateAdmin(admin) {
  assertObject(admin, '/server/admin')
  assertOnlyKeys(admin, ALLOWED_ADMIN_KEYS, '/server/admin')
  const hasToken = admin.token !== undefined
  const hasTokenEnv = admin.token_env !== undefined
  if (hasToken === hasTokenEnv) {
    throw new ConfigError(
      'must set exactly one of token or token_env',
      { pointer: '/server/admin' }
    )
  }
  if (hasToken) {
    assertNonEmptyString(admin.token, '/server/admin/token')
    if (admin.token.length < ADMIN_TOKEN_MIN_LENGTH) {
      throw new ConfigError(
        `must be at least ${ADMIN_TOKEN_MIN_LENGTH} characters`,
        { pointer: '/server/admin/token' }
      )
    }
  }
  if (hasTokenEnv) {
    assertNonEmptyString(admin.token_env, '/server/admin/token_env')
  }
}

/** @param {unknown} enrollment */
function validateEnrollment(enrollment) {
  assertObject(enrollment, '/server/enrollment')
  assertOnlyKeys(enrollment, ALLOWED_ENROLLMENT_KEYS, '/server/enrollment')
  if (enrollment.gateway_prefix !== undefined) {
    if (!isValidGatewayId(enrollment.gateway_prefix)) {
      throw new ConfigError(
        `must match ${GATEWAY_ID_PATTERN} and be 1..${GATEWAY_ID_MAX_LENGTH} characters`,
        { pointer: '/server/enrollment/gateway_prefix' }
      )
    }
  }
}

/** @param {unknown} rendezvous */
function validateRendezvous(rendezvous) {
  assertObject(rendezvous, '/server/rendezvous')
  assertOnlyKeys(rendezvous, ALLOWED_RENDEZVOUS_KEYS, '/server/rendezvous')
  const hasUrl = rendezvous.url !== undefined
  const hasUrlEnv = rendezvous.url_env !== undefined
  if (hasUrl === hasUrlEnv) {
    throw new ConfigError(
      'must set exactly one of url or url_env',
      { pointer: '/server/rendezvous' }
    )
  }
  if (hasUrl) {
    assertHttpUrl(rendezvous.url, '/server/rendezvous/url')
  }
  if (hasUrlEnv) {
    assertNonEmptyString(rendezvous.url_env, '/server/rendezvous/url_env')
  }
  const hasToken = rendezvous.registration_token !== undefined
  const hasTokenEnv = rendezvous.registration_token_env !== undefined
  if (hasToken === hasTokenEnv) {
    throw new ConfigError(
      'must set exactly one of registration_token or registration_token_env',
      { pointer: '/server/rendezvous' }
    )
  }
  if (hasToken) {
    assertNonEmptyString(rendezvous.registration_token, '/server/rendezvous/registration_token')
  }
  if (hasTokenEnv) {
    assertNonEmptyString(rendezvous.registration_token_env, '/server/rendezvous/registration_token_env')
  }
}

/** @param {unknown} ingest */
function validateIngest(ingest) {
  assertObject(ingest, '/server/ingest')
  assertOnlyKeys(ingest, ALLOWED_INGEST_KEYS, '/server/ingest')
  if (ingest.max_pending_rows !== undefined) {
    assertPositiveInteger(ingest.max_pending_rows, '/server/ingest/max_pending_rows')
  }
  if (ingest.high_water_pct !== undefined) {
    if (typeof ingest.high_water_pct !== 'number'
        || !Number.isInteger(ingest.high_water_pct)
        || ingest.high_water_pct < 1
        || ingest.high_water_pct > 100) {
      throw new ConfigError(
        'must be an integer between 1 and 100',
        { pointer: '/server/ingest/high_water_pct' }
      )
    }
  }
  if (ingest.retry_after_seconds !== undefined) {
    assertPositiveInteger(ingest.retry_after_seconds, '/server/ingest/retry_after_seconds')
  }
  if (ingest.max_bytes_per_second !== undefined) {
    assertPositiveInteger(ingest.max_bytes_per_second, '/server/ingest/max_bytes_per_second')
  }
}

/** @param {unknown} issuer */
function validateIdentityIssuer(issuer) {
  assertObject(issuer, '/server/identity_issuer')
  assertOnlyKeys(issuer, ALLOWED_IDENTITY_ISSUER_KEYS, '/server/identity_issuer')
  const hasSecret = issuer.secret !== undefined
  const hasSecretEnv = issuer.secret_env !== undefined
  if (hasSecret === hasSecretEnv) {
    throw new ConfigError(
      'must set exactly one of secret or secret_env',
      { pointer: '/server/identity_issuer' }
    )
  }
  if (hasSecret) {
    assertNonEmptyString(issuer.secret, '/server/identity_issuer/secret')
    if (issuer.secret.length < IDENTITY_SECRET_MIN_LENGTH) {
      throw new ConfigError(
        `must be at least ${IDENTITY_SECRET_MIN_LENGTH} characters`,
        { pointer: '/server/identity_issuer/secret' }
      )
    }
  }
  if (hasSecretEnv) {
    assertNonEmptyString(issuer.secret_env, '/server/identity_issuer/secret_env')
  }
  if (issuer.jwt_ttl_seconds !== undefined) {
    assertPositiveInteger(issuer.jwt_ttl_seconds, '/server/identity_issuer/jwt_ttl_seconds')
  }
  if (issuer.bootstrap_ttl_seconds !== undefined) {
    assertPositiveInteger(issuer.bootstrap_ttl_seconds, '/server/identity_issuer/bootstrap_ttl_seconds')
  }
  if (issuer.bootstrap_store_path !== undefined) {
    assertNonEmptyString(issuer.bootstrap_store_path, '/server/identity_issuer/bootstrap_store_path')
  }
}

/**
 * Resolve runtime-only secret references after config inspection but before
 * listeners start. This keeps config JSON safe for ECS task definitions while
 * still giving the server the concrete secret it needs for JWT signing.
 *
 * @param {CollectivusConfig} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {CollectivusConfig}
 */
export function resolveRuntimeSecrets(config, env = process.env) {
  const issuer = config.server?.identity_issuer
  if (!issuer?.secret_env) return config
  const secret = env[issuer.secret_env]
  if (!secret) {
    throw new ConfigError(
      `environment variable ${issuer.secret_env} is not set`,
      { pointer: '/server/identity_issuer/secret_env' }
    )
  }
  if (secret.length < IDENTITY_SECRET_MIN_LENGTH) {
    throw new ConfigError(
      `environment variable ${issuer.secret_env} must be at least ${IDENTITY_SECRET_MIN_LENGTH} characters`,
      { pointer: '/server/identity_issuer/secret_env' }
    )
  }
  return {
    ...config,
    server: {
      ...config.server,
      identity_issuer: {
        ...issuer,
        secret,
      },
    },
  }
}

/** @param {unknown} cs */
function validateCentralServer(cs) {
  assertObject(cs, '/central_server')
  assertOnlyKeys(cs, ALLOWED_CENTRAL_SERVER_KEYS, '/central_server')
  if (cs.url === undefined) {
    throw new ConfigError('url is required', { pointer: '/central_server/url' })
  }
  assertParseableUrl(cs.url, '/central_server/url')
  if (cs.identity === undefined) {
    throw new ConfigError(
      'identity is required',
      { pointer: '/central_server/identity' }
    )
  }
  validateCentralIdentity(cs.identity)
  if (cs.poll_interval_seconds !== undefined) {
    if (typeof cs.poll_interval_seconds !== 'number'
        || !Number.isInteger(cs.poll_interval_seconds)
        || cs.poll_interval_seconds < 5
        || cs.poll_interval_seconds > 3600) {
      throw new ConfigError(
        'must be an integer between 5 and 3600',
        { pointer: '/central_server/poll_interval_seconds' }
      )
    }
  }
  if (cs.outbox_dir !== undefined) {
    assertNonEmptyString(cs.outbox_dir, '/central_server/outbox_dir')
  }
}

/** @param {unknown} identity */
function validateCentralIdentity(identity) {
  assertObject(identity, '/central_server/identity')
  assertOnlyKeys(identity, ALLOWED_CENTRAL_IDENTITY_KEYS, '/central_server/identity')
  if (identity.bootstrap_token !== undefined) {
    assertNonEmptyString(identity.bootstrap_token, '/central_server/identity/bootstrap_token')
  }
  if (identity.persisted_path !== undefined) {
    assertNonEmptyString(identity.persisted_path, '/central_server/identity/persisted_path')
  }
}

/** @param {unknown} otel */
function validateOtel(otel) {
  assertObject(otel, '/otel')
  assertOnlyKeys(otel, new Set(['listen']), '/otel')
  assertNonEmptyString(otel.listen, '/otel/listen')
}

/** @param {unknown} proxy */
function validateProxy(proxy) {
  assertObject(proxy, '/proxy')
  assertOnlyKeys(proxy, ALLOWED_PROXY_KEYS, '/proxy')
  assertNonEmptyString(proxy.listen, '/proxy/listen')

  if (proxy.upstreams === undefined) {
    throw new ConfigError('upstreams is required', { pointer: '/proxy/upstreams' })
  }
  if (!Array.isArray(proxy.upstreams)) {
    throw new ConfigError('must be an array', { pointer: '/proxy/upstreams' })
  }
  if (proxy.upstreams.length === 0) {
    throw new ConfigError('at least one upstream is required', { pointer: '/proxy/upstreams' })
  }
  /** @type {Set<string>} */
  const seen = new Set()
  proxy.upstreams.forEach(function(u, i) {
    const pointer = `/proxy/upstreams/${i}`
    validateUpstream(u, pointer)
    // validateUpstream guarantees `name` is a non-empty string above.
    const { name } = u
    if (seen.has(name)) {
      throw new ConfigError(
        `duplicate upstream name "${name}"`,
        { pointer: `${pointer}/name` }
      )
    }
    seen.add(name)
  })

  if (proxy.redact_headers !== undefined) {
    if (!Array.isArray(proxy.redact_headers)) {
      throw new ConfigError('must be an array of strings', { pointer: '/proxy/redact_headers' })
    }
    proxy.redact_headers.forEach(function(h, i) {
      if (typeof h !== 'string' || h.length === 0) {
        throw new ConfigError('must be a non-empty string', { pointer: `/proxy/redact_headers/${i}` })
      }
    })
  }
}

/**
 * @param {unknown} upstream
 * @param {string} pointer
 */
function validateUpstream(upstream, pointer) {
  assertObject(upstream, pointer)
  assertOnlyKeys(upstream, ALLOWED_UPSTREAM_KEYS, pointer)
  assertNonEmptyString(upstream.name, `${pointer}/name`)
  assertNonEmptyString(upstream.base_url, `${pointer}/base_url`)
  if (upstream.match === undefined) {
    throw new ConfigError('match is required', { pointer: `${pointer}/match` })
  }
  assertObject(upstream.match, `${pointer}/match`)
  assertOnlyKeys(upstream.match, new Set(['path_prefix']), `${pointer}/match`)
  assertNonEmptyString(upstream.match.path_prefix, `${pointer}/match/path_prefix`)
}

/** @param {unknown} value */
function validateGatewayId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError('must be a non-empty string', { pointer: '/gateway_id' })
  }
  if (value.length > GATEWAY_ID_MAX_LENGTH) {
    throw new ConfigError(
      `must be at most ${GATEWAY_ID_MAX_LENGTH} characters`,
      { pointer: '/gateway_id' }
    )
  }
  if (!GATEWAY_ID_PATTERN.test(value)) {
    throw new ConfigError(
      'must start with [A-Za-z0-9] and contain only [A-Za-z0-9._+@-]',
      { pointer: '/gateway_id' }
    )
  }
}

/** @param {unknown} sink */
function validateSink(sink) {
  assertObject(sink, '/sink')
  assertOnlyKeys(sink, ALLOWED_SINK_KEYS, '/sink')
  if (sink.type !== 'file') {
    throw new ConfigError('only sink type "file" is supported in v0', { pointer: '/sink/type' })
  }
  assertNonEmptyString(sink.dir, '/sink/dir')
}

/**
 * Validate the `upload` block. Schema only — no defaults are injected so
 * `--print-config` round-trips a v1 config unchanged. Defaults are applied
 * later when the uploader is wired in (co-zdn.7.3).
 *
 * @param {unknown} upload
 */
function validateUpload(upload) {
  assertObject(upload, '/upload')
  assertOnlyKeys(upload, ALLOWED_UPLOAD_KEYS, '/upload')
  assertNonEmptyString(upload.bucket, '/upload/bucket')
  if (upload.prefix !== undefined) assertNonEmptyString(upload.prefix, '/upload/prefix')
  if (upload.region !== undefined && typeof upload.region !== 'string') {
    throw new ConfigError('must be a string', { pointer: '/upload/region' })
  }
  if (upload.time !== undefined) {
    if (typeof upload.time !== 'string' || !TIME_PATTERN.test(upload.time)) {
      throw new ConfigError('must be HH:MM (24-hour)', { pointer: '/upload/time' })
    }
  }
  if (upload.signals !== undefined) {
    if (!Array.isArray(upload.signals)) {
      throw new ConfigError('must be an array', { pointer: '/upload/signals' })
    }
    upload.signals.forEach(function(s, i) {
      if (typeof s !== 'string' || !ALLOWED_SIGNALS.has(s)) {
        throw new ConfigError(
          'must be one of "logs", "traces", "metrics", "proxy"',
          { pointer: `/upload/signals/${i}` }
        )
      }
    })
  }
  if (upload.catchupDays !== undefined) {
    if (typeof upload.catchupDays !== 'number'
        || !Number.isInteger(upload.catchupDays)
        || upload.catchupDays < 0) {
      throw new ConfigError(
        'must be a non-negative integer',
        { pointer: '/upload/catchupDays' }
      )
    }
  }
  if (upload.endpoint !== undefined) assertNonEmptyString(upload.endpoint, '/upload/endpoint')
}

/**
 * @param {unknown} query
 */
function validateQuery(query) {
  assertObject(query, '/query')
  assertOnlyKeys(query, ALLOWED_QUERY_KEYS, '/query')
  if (query.cache !== undefined) validateQueryCache(query.cache)
}

/**
 * @param {unknown} cache
 */
function validateQueryCache(cache) {
  assertObject(cache, '/query/cache')
  assertOnlyKeys(cache, ALLOWED_QUERY_CACHE_KEYS, '/query/cache')
  if (cache.enabled !== undefined && typeof cache.enabled !== 'boolean') {
    throw new ConfigError('must be a boolean', { pointer: '/query/cache/enabled' })
  }
  if (cache.dir !== undefined) {
    assertNonEmptyString(cache.dir, '/query/cache/dir')
  }
}

/**
 * Validate the `gascity` block — an array of supervisor cities the daemon
 * should subscribe to. Empty array is allowed (the source spins up but
 * captures nothing; useful for staging configs). Each entry must carry a
 * unique `name` and an `http(s)://` `api_url`; the optional template filter
 * arrays must hold non-empty strings.
 *
 * @param {unknown} gascity
 */
function validateGascity(gascity) {
  if (!Array.isArray(gascity)) {
    throw new ConfigError('must be an array', { pointer: '/gascity' })
  }
  /** @type {Set<string>} */
  const seen = new Set()
  gascity.forEach(function(city, i) {
    const pointer = `/gascity/${i}`
    assertObject(city, pointer)
    assertOnlyKeys(city, ALLOWED_GASCITY_KEYS, pointer)
    assertNonEmptyString(city.name, `${pointer}/name`)
    if (seen.has(city.name)) {
      throw new ConfigError(`duplicate gascity name "${city.name}"`, { pointer: `${pointer}/name` })
    }
    seen.add(city.name)
    assertHttpUrl(city.api_url, `${pointer}/api_url`)
    if (city.include_templates !== undefined) {
      validateTemplateList(city.include_templates, `${pointer}/include_templates`)
    }
    if (city.exclude_templates !== undefined) {
      validateTemplateList(city.exclude_templates, `${pointer}/exclude_templates`)
    }
  })
}

/**
 * @param {unknown} value
 * @param {string} pointer
 */
function validateTemplateList(value, pointer) {
  if (!Array.isArray(value)) {
    throw new ConfigError('must be an array of strings', { pointer })
  }
  value.forEach(function(item, i) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new ConfigError('must be a non-empty string', { pointer: `${pointer}/${i}` })
    }
  })
}

/**
 * @param {unknown} value
 * @param {string} pointer
 * @returns {asserts value is Record<string, unknown>}
 */
function assertObject(value, pointer) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('must be an object', { pointer: pointer || '/' })
  }
}

/**
 * @param {Record<string, unknown>} obj
 * @param {Set<string>} allowed
 * @param {string} pointer - Pointer to the object being checked ('' for root).
 */
function assertOnlyKeys(obj, allowed, pointer) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`unknown key "${key}"`, { pointer: `${pointer}/${key}` })
    }
  }
}

/**
 * Non-strict mode for top-level keys: log and continue. Per-section
 * validators still reject unknown keys to catch typos like `proxy.upsteams`.
 *
 * @param {Record<string, unknown>} obj
 * @param {{ write: (s: string) => void }} stderr
 */
function warnUnknownTopKeys(obj, stderr) {
  /** @type {string[]} */
  const unknown = []
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) unknown.push(key)
  }
  if (unknown.length === 0) return
  const recognized = Array.from(ALLOWED_TOP_KEYS).map((k) => `"${k}"`).join(', ')
  for (const key of unknown) {
    stderr.write(
      `warning: unknown config key "${key}" ignored ` +
      `(this collectivus binary recognizes: ${recognized})\n`
    )
  }
}

/**
 * @param {unknown} value
 * @param {string} pointer
 * @returns {asserts value is string}
 */
function assertNonEmptyString(value, pointer) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError('must be a non-empty string', { pointer })
  }
}

/**
 * Mirrors the listen-address parsing in `proxy.js`: a non-empty string with a
 * colon, a valid 0..65535 port, and a non-empty host (IPv6 literals may be
 * wrapped in `[]`). Validation only — the value is bound to a server later.
 *
 * @param {unknown} value
 * @param {string} pointer
 */
function assertHostPort(value, pointer) {
  assertNonEmptyString(value, pointer)
  const idx = value.lastIndexOf(':')
  if (idx === -1) {
    throw new ConfigError('must be host:port', { pointer })
  }
  const portStr = value.slice(idx + 1)
  const port = Number.parseInt(portStr, 10)
  if (Number.isNaN(port) || port < 0 || port > 65535 || String(port) !== portStr) {
    throw new ConfigError('invalid port in host:port', { pointer })
  }
  const rawHost = value.slice(0, idx)
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost
  if (host.length === 0) {
    throw new ConfigError('missing host in host:port', { pointer })
  }
}

/**
 * @param {unknown} value
 * @param {string} pointer
 */
function assertParseableUrl(value, pointer) {
  assertNonEmptyString(value, pointer)
  try {
    new URL(value)
  } catch {
    throw new ConfigError('must be a parseable URL', { pointer })
  }
}

/**
 * @param {unknown} value
 * @param {string} pointer
 */
function assertHttpUrl(value, pointer) {
  assertNonEmptyString(value, pointer)
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('bad protocol')
    }
  } catch {
    throw new ConfigError('must be an http(s) URL', { pointer })
  }
}

/**
 * @param {unknown} value
 * @param {string} pointer
 */
function assertPositiveInteger(value, pointer) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError('must be a positive integer', { pointer })
  }
}

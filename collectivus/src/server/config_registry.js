import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError, validateCollectivusConfig } from '../config.js'

/**
 * @import { CollectivusConfig, ServerConfig } from '../types.js'
 * @import { ConfigRegistry, ConfigRegistryEntry } from './types.d.ts'
 */

/**
 * Default `server.data_dir` when the operator omits it from `ServerConfig`.
 *
 * @param {string} [homeDir] Override for tests.
 * @returns {string}
 */
export function defaultServerDataDir(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'collectivus', 'server-data')
}

/**
 * Resolve the directory that holds per-gateway config files (one JSON per
 * gateway under `<data_dir>/configs/`). The caller is responsible for ensuring
 * the directory exists (created lazily on first write).
 *
 * @param {ServerConfig} serverConfig
 * @param {{ homeDir?: string }} [opts]
 * @returns {string}
 */
export function resolveConfigsDir(serverConfig, opts = {}) {
  const dataDir = serverConfig.data_dir ?? defaultServerDataDir(opts.homeDir)
  return path.join(dataDir, 'configs')
}

/**
 * Build a file-backed registry of per-gateway configs. One JSON file per
 * gateway lives at `<configsDir>/<gateway_id>.json`. The registry object is a
 * serializable data holder only; operations always re-read from disk so an
 * out-of-band write from another process is visible on the next read.
 *
 * Concurrency: writes are tmp+rename, atomic on POSIX. There is no
 * inter-process locking; if two writers race on the same gateway the last
 * `rename` wins. Operator workflows treat config writes as rare events.
 *
 * Authorization: the registry has no concept of authentication. Callers
 * (`control_plane.js` for the GET endpoint, `cli/config.js` for the operator
 * CLI) enforce access control above this layer.
 *
 * @param {{ configsDir: string }} opts
 * @returns {ConfigRegistry}
 */
export function createConfigRegistry(opts) {
  if (typeof opts?.configsDir !== 'string' || opts.configsDir.length === 0) {
    throw new Error('ConfigRegistry: configsDir is required')
  }
  return { configsDir: opts.configsDir }
}

/**
 * Read a gateway's config off disk. Returns `undefined` when no file exists.
 * Throws when the file exists but the JSON is unparseable or the recorded
 * config no longer satisfies the gateway-side validator (e.g. schema drift
 * after an upgrade) — in that case the operator must repair the file.
 *
 * @param {ConfigRegistry} registry
 * @param {string} gatewayId
 * @returns {ConfigRegistryEntry | undefined}
 */
export function getConfig(registry, gatewayId) {
  assertGatewayId(gatewayId)
  const file = configFileFor(registry, gatewayId)
  /** @type {string} */
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return undefined
    throw err
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`ConfigRegistry: invalid JSON in ${file}: ${msg}`)
  }
  validateCollectivusConfig(parsed)
  const config = /** @type {CollectivusConfig} */ (parsed)
  const etag = computeEtag(config)
  return { config, etag }
}

/**
 * Persist a config for a gateway. The config is validated against the same
 * schema a gateway would use to load it; an invalid config is rejected
 * before any file is written. Returns the new entry's ETag.
 *
 * @param {ConfigRegistry} registry
 * @param {string} gatewayId
 * @param {unknown} configObj
 * @returns {{ etag: string }}
 */
export function setConfig(registry, gatewayId, configObj) {
  assertGatewayId(gatewayId)
  try {
    validateCollectivusConfig(configObj)
  } catch (err) {
    if (err instanceof ConfigError) throw err
    throw err
  }
  const config = /** @type {CollectivusConfig} */ (configObj)
  fs.mkdirSync(registry.configsDir, { recursive: true })
  const file = configFileFor(registry, gatewayId)
  const canonical = canonicalJsonString(config)
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, canonical, { mode: 0o600 })
  fs.renameSync(tmp, file)
  return { etag: sha256Hex(canonical) }
}

/**
 * List all gateway IDs that have a config registered.
 *
 * Filenames must match `<gateway_id>.json` exactly. Files that don't conform
 * (hidden files, partial tmp files from a crash mid-write, stray text) are
 * silently skipped — the registry is not a directory listing.
 *
 * @param {ConfigRegistry} registry
 * @returns {string[]}
 */
export function listGateways(registry) {
  /** @type {string[]} */
  let entries
  try {
    entries = fs.readdirSync(registry.configsDir)
  } catch (err) {
    if (isEnoent(err)) return []
    throw err
  }
  /** @type {string[]} */
  const gateways = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const gateway = name.slice(0, -'.json'.length)
    if (gateway.length === 0) continue
    if (!isValidGatewayId(gateway)) continue
    gateways.push(gateway)
  }
  gateways.sort()
  return gateways
}

/**
 * Remove a gateway's config. Returns true if the file existed and was
 * deleted, false when no config was registered for the gateway.
 *
 * @param {ConfigRegistry} registry
 * @param {string} gatewayId
 * @returns {boolean}
 */
export function deleteConfig(registry, gatewayId) {
  assertGatewayId(gatewayId)
  const file = configFileFor(registry, gatewayId)
  try {
    fs.unlinkSync(file)
    return true
  } catch (err) {
    if (isEnoent(err)) return false
    throw err
  }
}

/**
 * @param {ConfigRegistry} registry
 * @param {string} gatewayId
 * @returns {string}
 */
export function configFileFor(registry, gatewayId) {
  return path.join(registry.configsDir, `${gatewayId}.json`)
}

/**
 * Compute the canonical-JSON ETag for a config object. Exposed for tests and
 * for callers that already have a parsed config in hand.
 *
 * @param {CollectivusConfig} config
 * @returns {string}
 */
export function computeEtag(config) {
  return sha256Hex(canonicalJsonString(config))
}

/**
 * Canonical JSON: lexically-sorted object keys, no extraneous whitespace.
 * Arrays preserve order. Used both for ETag computation and for atomic disk
 * writes so the file content matches the ETag byte-for-byte.
 *
 * Designed for plain config trees — strings, numbers, booleans, null, plain
 * objects, and arrays. Throws on functions, symbols, or anything `JSON.stringify`
 * would silently drop, on the principle that a registry mutation should fail
 * loudly rather than persist a lossy serialization.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJsonString(value) {
  return JSON.stringify(canonicalize(value))
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalJsonString: non-finite numbers are not representable')
    }
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const sorted = {}
    const obj = /** @type {Record<string, unknown>} */ (value)
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalize(obj[key])
    }
    return sorted
  }
  throw new Error(`canonicalJsonString: unsupported value of type ${typeof value}`)
}

/**
 * Gateway IDs are used both as JWT subjects and as filenames, so we constrain
 * them to a portable, non-traversal-prone alphabet that also accommodates real-
 * world email addresses (the `@` and `+` characters are common in operator-
 * assigned IDs like `firstname.last@acme.com`). Must match the ingest-side
 * validator in `src/server/ingest.js`; the validator is duplicated rather than
 * imported so the registry has no runtime dependency on the identity layer.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidGatewayId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false
  return /^[a-zA-Z0-9][a-zA-Z0-9._+@-]*$/.test(value)
}

/**
 * @param {unknown} value
 * @returns {asserts value is string}
 */
function assertGatewayId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('ConfigRegistry: gatewayId is required')
  }
  if (!isValidGatewayId(value)) {
    throw new Error(`ConfigRegistry: invalid gatewayId ${JSON.stringify(value)}`)
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isEnoent(err) {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')
}

/**
 * @param {string} input
 * @returns {string}
 */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

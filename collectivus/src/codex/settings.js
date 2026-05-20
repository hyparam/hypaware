import { defaultConfigPath, readConfig, writeAtomic } from './config-file.js'
import { CodexSettingsError } from './errors.js'
import { isManagedAttached, prepareAttach, prepareDetach } from './toml-config.js'

/**
 * @import { CodexAttachOptions, CodexAttachResult, CodexDetachOptions, CodexDetachResult, CodexIsAttachedOptions } from '../types.js'
 */

export { defaultConfigPath } from './config-file.js'
export { CodexSettingsError } from './errors.js'

/**
 * Route Codex through the local collectivus OpenAI-compatible proxy by adding
 * a managed `model_provider = "collectivus"` root setting plus provider table.
 *
 * @param {CodexAttachOptions} opts
 * @returns {Promise<CodexAttachResult>}
 */
export async function attach(opts) {
  const { port, version, configPath = defaultConfigPath() } = opts
  validatePort(port)
  validateVersion(version)

  const { content, mtimeMs } = await readConfig(configPath)
  const prepared = prepareAttach(content, port, version)
  await writeAtomic(configPath, prepared.content, mtimeMs)

  /** @type {CodexAttachResult} */
  const result = { changed: true }
  if (prepared.prevValue !== undefined) result.prevValue = prepared.prevValue
  return result
}

/**
 * Reverse a previous `attach`. No-op when config.toml is absent or has no
 * collectivus-managed Codex block. Restores the previous root model_provider
 * when attach recorded one and no user-edited root value has appeared.
 *
 * @param {CodexDetachOptions} [opts]
 * @returns {Promise<CodexDetachResult>}
 */
export async function detach(opts = {}) {
  const { configPath = defaultConfigPath() } = opts
  const { content, existed, mtimeMs } = await readConfig(configPath)
  if (!existed) return { changed: false }

  const prepared = prepareDetach(content)
  if (!prepared.changed) return { changed: false }

  await writeAtomic(configPath, prepared.content, mtimeMs)

  /** @type {CodexDetachResult} */
  const result = { changed: true }
  if (prepared.removed !== undefined) result.removed = prepared.removed
  if (prepared.restoredValue !== undefined) result.restoredValue = prepared.restoredValue
  if (prepared.warning !== undefined) result.warning = prepared.warning
  return result
}

/**
 * Return true when config.toml exists and carries the collectivus-managed
 * Codex model provider block.
 *
 * @param {CodexIsAttachedOptions} [opts]
 * @returns {Promise<boolean>}
 */
export async function isAttached(opts = {}) {
  const { configPath = defaultConfigPath() } = opts
  const { content, existed } = await readConfig(configPath)
  if (!existed) return false
  return isManagedAttached(content)
}

/**
 * @param {unknown} port
 * @returns {asserts port is number}
 */
function validatePort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CodexSettingsError(`invalid port: ${String(port)}`, { code: 'INVALID_PORT' })
  }
}

/**
 * @param {unknown} version
 * @returns {asserts version is string}
 */
function validateVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new CodexSettingsError('version must be a non-empty string', {
      code: 'INVALID_VERSION',
    })
  }
}

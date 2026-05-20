// @ts-check

import { defaultConfigPath, readConfig, writeAtomic } from './config-file.js'
import { CodexSettingsError } from './errors.js'
import { isManagedAttached, prepareAttach, prepareDetach } from './toml-config.js'

export { defaultConfigPath } from './config-file.js'
export { CodexSettingsError } from './errors.js'

/**
 * @typedef {Object} CodexAttachOptions
 * @property {number} port
 * @property {string} version
 * @property {string} [configPath]
 *
 * @typedef {{ changed: true, prevValue?: string }} CodexAttachResult
 *
 * @typedef {Object} CodexDetachOptions
 * @property {string} [configPath]
 *
 * @typedef {{ changed: true, removed?: string, restoredValue?: string, warning?: string } | { changed: false }} CodexDetachResult
 */

/**
 * Route Codex through the local AI gateway by adding a managed
 * `model_provider = "hypaware"` root setting plus a provider
 * table pointing at the gateway's OpenAI-compatible endpoint.
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
 * Reverse a previous `attach`. No-op when config.toml is absent or
 * has no hypaware-managed Codex block.
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
 * Return true when config.toml exists and carries the
 * hypaware-managed Codex model provider block.
 *
 * @param {{ configPath?: string }} [opts]
 */
export async function isAttached(opts = {}) {
  const { configPath = defaultConfigPath() } = opts
  const { content, existed } = await readConfig(configPath)
  if (!existed) return false
  return isManagedAttached(content)
}

/** @param {unknown} port */
function validatePort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CodexSettingsError(`invalid port: ${String(port)}`, { code: 'INVALID_PORT' })
  }
}

/** @param {unknown} version */
function validateVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new CodexSettingsError('version must be a non-empty string', {
      code: 'INVALID_VERSION',
    })
  }
}

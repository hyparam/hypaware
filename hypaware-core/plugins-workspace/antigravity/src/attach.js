// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'

import { markActionRefused } from '../../../../src/core/config/action_refusal.js'
import { resolveClientSettingsPath } from '../../../../src/core/daemon/client_settings_path.js'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'

export const ANTIGRAVITY_PLUGIN_MARKER = '// HYPWARE_ANTIGRAVITY_PLUGIN v1'
export const ANTIGRAVITY_PLUGIN_MANIFEST_REL = '.gemini/config/plugins/hypaware/plugin.json'

/**
 * Resolve the path to the managed Antigravity plugin manifest
 * (`~/.gemini/config/plugins/hypaware/plugin.json`).
 *
 * Both `antigravity` (CLI) and `antigravity-desktop` (Desktop) load user
 * plugins from `~/.gemini/config/plugins/<name>/plugin.json`.
 *
 * @param {{ clientName?: string, env?: NodeJS.ProcessEnv, homeDir?: string }} [opts]
 * @returns {string}
 */
export function antigravityPluginManifestPath(opts = {}) {
  const homeDir = opts.homeDir ?? opts.env?.HOME ?? os.homedir()
  const clientName = opts.clientName ?? 'antigravity'
  return resolveClientSettingsPath(
    clientName,
    ANTIGRAVITY_PLUGIN_MANIFEST_REL,
    opts.env,
    homeDir
  )
}

/**
 * Render the JSONC `plugin.json` manifest for the HypAware Antigravity plugin
 * bundle. Antigravity parses `plugin.json` as JSONC and rejects unknown JSON
 * keys, so the ownership marker lives in a leading line comment.
 *
 * @param {string} version
 * @returns {string}
 */
export function renderAntigravityPluginManifest(version) {
  const payload = {
    name: 'hypaware',
    version: version || '1.0.0',
    description: 'HypAware AI agent observability skills and analyst subagent for Antigravity.',
    skills: './skills',
    agents: './agents',
  }
  return `${ANTIGRAVITY_PLUGIN_MARKER}\n${JSON.stringify(payload, null, 2)}\n`
}

/**
 * Materialize `~/.gemini/config/plugins/hypaware/plugin.json` with the
 * HypAware ownership marker comment. Refuses via `markActionRefused` if a
 * file already exists at that path without the HypAware marker.
 *
 * @param {{
 *   version: string,
 *   clientName?: string,
 *   env?: NodeJS.ProcessEnv,
 *   homeDir?: string,
 *   dryRun?: boolean,
 * }} opts
 * @returns {Promise<{ settingsPath: string, changed: boolean }>}
 */
export async function attachAntigravityPlugin(opts) {
  const settingsPath = antigravityPluginManifestPath(opts)
  const body = renderAntigravityPluginManifest(opts.version)

  let existing
  try {
    existing = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
  }
  if (existing !== undefined && !existing.includes(ANTIGRAVITY_PLUGIN_MARKER)) {
    throw markActionRefused(
      new Error(`Antigravity plugin manifest already exists and is not HypAware-owned: ${settingsPath}`)
    )
  }
  const changed = existing !== body
  if (changed && !opts.dryRun) {
    await atomicWriteFile(settingsPath, body, { mode: 0o600, dirMode: 0o700, fsync: true })
  }
  return { settingsPath, changed }
}

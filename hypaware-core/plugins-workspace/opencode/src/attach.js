// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveClientSettingsPath } from '../../../../src/core/daemon/client_settings_path.js'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'

export const OPENCODE_PLUGIN_MARKER = '// HYPWARE_OPENCODE_PLUGIN v1'
const ENDPOINT_TOKEN = '__HYPWARE_OPENCODE_ENDPOINT__'

/** @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [opts] */
export function opencodePluginPath(opts = {}) {
  const homeDir = opts.homeDir ?? opts.env?.HOME ?? os.homedir()
  return resolveClientSettingsPath(
    'opencode',
    '.config/opencode/plugins/hypaware.js',
    opts.env,
    homeDir
  )
}

/**
 * @param {{ endpoint: string, version: string, env?: NodeJS.ProcessEnv, homeDir?: string, dryRun?: boolean }} opts
 */
export async function attachOpenCodePlugin(opts) {
  const settingsPath = opencodePluginPath(opts)
  const templatePath = fileURLToPath(new URL('../assets/hypaware.js', import.meta.url))
  const template = await fs.readFile(templatePath, 'utf8')
  const body = template
    .replace(ENDPOINT_TOKEN, opts.endpoint)
    .replace(OPENCODE_PLUGIN_MARKER, `${OPENCODE_PLUGIN_MARKER}\n// HypAware adapter ${opts.version}`)

  let existing
  try {
    existing = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
  }
  if (existing !== undefined && !existing.includes(OPENCODE_PLUGIN_MARKER)) {
    throw new Error(`OpenCode plugin path already exists and is not HypAware-owned: ${settingsPath}`)
  }
  const changed = existing !== body
  if (changed && !opts.dryRun) {
    await atomicWriteFile(settingsPath, body, { mode: 0o600, dirMode: 0o700, fsync: true })
  }
  return { settingsPath, changed }
}

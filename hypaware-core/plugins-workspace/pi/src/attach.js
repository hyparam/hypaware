// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { markActionRefused } from '../../../../src/core/config/action_refusal.js'
import { resolveClientSettingsPath } from '../../../../src/core/daemon/client_settings_path.js'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'
import { DEFAULT_PI_PORT } from './config.js'

export const PI_PLUGIN_MARKER = '// HYPWARE_PI_EXTENSION v1'
// Derived, not a third copy of the literal: the substitution token is the
// packaged extension's own default endpoint, which is built from the same
// port constant the listener binds. `String.replace` matches nothing rather
// than failing when the two drift, so the miss is asserted below instead of
// shipping an extension pointed at the wrong port.
const ENDPOINT_TOKEN = `http://127.0.0.1:${DEFAULT_PI_PORT}`

/** @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [opts] */
export function piPluginPath(opts = {}) {
  const homeDir = opts.homeDir ?? opts.env?.HOME ?? os.homedir()
  return resolveClientSettingsPath(
    'pi',
    '.pi/agent/extensions/hypaware.js',
    opts.env,
    homeDir
  )
}

/**
 * @param {{ endpoint: string, version: string, env?: NodeJS.ProcessEnv, homeDir?: string, dryRun?: boolean }} opts
 */
export async function attachPiPlugin(opts) {
  const settingsPath = piPluginPath(opts)
  const templatePath = fileURLToPath(new URL('../../../../packages/pi-extension/index.js', import.meta.url))
  const template = await fs.readFile(templatePath, 'utf8')
  if (!template.includes(ENDPOINT_TOKEN)) {
    throw new Error(`Pi extension template does not contain the endpoint token '${ENDPOINT_TOKEN}'; attach would install an extension pointed at the wrong port`)
  }
  const body = template
    .replace(ENDPOINT_TOKEN, opts.endpoint)
    .replace(PI_PLUGIN_MARKER, `${PI_PLUGIN_MARKER}\n// HypAware adapter ${opts.version}`)

  let existing
  try {
    existing = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
  }
  if (existing !== undefined && !existing.includes(PI_PLUGIN_MARKER)) {
    // @ref LLP 0186#markactionrefused--isactionrefused [implements]: only the
    //   user can move a foreign plugin file out of the way, so this is a
    //   terminal refusal, not a failure the reconciler should retry forever.
    throw markActionRefused(new Error(`Pi plugin path already exists and is not HypAware-owned: ${settingsPath}`))
  }
  const changed = existing !== body
  if (changed && !opts.dryRun) {
    await atomicWriteFile(settingsPath, body, { mode: 0o600, dirMode: 0o700, fsync: true })
  }
  return { settingsPath, changed }
}

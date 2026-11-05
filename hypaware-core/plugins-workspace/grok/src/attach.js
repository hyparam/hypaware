// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { stripManagedHooks } from '../../../../src/core/config/client_detach_disk.js'
import { markActionRefused } from '../../../../src/core/config/action_refusal.js'
import { resolveClientSettingsPath } from '../../../../src/core/daemon/client_settings_path.js'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'
import { isPlainObject } from '../../../../src/core/util/json_util.js'

export const GROK_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'StopCancelled', 'SubagentStop', 'PreCompact', 'SessionEnd'])

/** @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [opts] */
export function grokHooksPath(opts = {}) {
  return resolveClientSettingsPath('grok', '.grok/hooks/hypaware.json', opts.env, opts.homeDir ?? opts.env?.HOME ?? os.homedir())
}

/**
 * @param {{ endpoint: string, version: string, env?: NodeJS.ProcessEnv, homeDir?: string, dryRun?: boolean }} opts
 * @ref LLP 0585#attachment: one HypAware-owned file in Grok's hook directory
 */
export async function attachGrokHooks(opts) {
  const settingsPath = grokHooksPath(opts)
  let raw
  let mtime
  try {
    mtime = (await fs.stat(settingsPath)).mtimeMs
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
  const value = raw === undefined ? {} : JSON.parse(raw)
  if (!isPlainObject(value) || (value.hooks !== undefined && !isPlainObject(value.hooks))) throw markActionRefused(new Error('Grok hook file must hold a hooks object'))
  const old = value._hypaware
  if (old !== undefined && (!isPlainObject(old) || !isPlainObject(old.managed) || !Array.isArray(old.managed.hook_entries))) {
    throw markActionRefused(new Error('Grok _hypaware marker is not a readable managed hook record'))
  }
  if (isPlainObject(old) && isPlainObject(old.managed) && value.hooks) stripManagedHooks(value, /** @type {unknown[]} */ (old.managed.hook_entries))
  value.hooks ??= {}
  const hooks = /** @type {Record<string, any>} */ (value.hooks)
  const endpoint = new URL(opts.endpoint)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('Grok requires a loopback HTTP endpoint')
  const hookPath = fileURLToPath(new URL('./hook.mjs', import.meta.url))
  const command = [process.execPath, hookPath, endpoint.host].map(quote).join(' ')
  const entries = []
  for (const event of GROK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw markActionRefused(new Error(`Grok ${event} hooks must be matcher groups`))
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command, timeout: 3 }] }]
    entries.push({ event, command })
  }
  const { _hypaware: _, ...rest } = value
  const next = { ...rest, _hypaware: { version: opts.version,
    attached_at: isPlainObject(old) && typeof old.attached_at === 'string' ? old.attached_at : new Date().toISOString(),
    managed: { hook_entries: entries } } }
  const body = JSON.stringify(next, null, 2) + '\n'
  const changed = raw !== body
  if (changed && !opts.dryRun) await atomicWriteFile(settingsPath, body, { mode: 0o600, dirMode: 0o700, fsync: true, expectedMtimeMs: mtime })
  return { settingsPath, changed }
}

/** @param {string} value */
function quote(value) { return "'" + value.replace(/'/g, "'\\''") + "'" }

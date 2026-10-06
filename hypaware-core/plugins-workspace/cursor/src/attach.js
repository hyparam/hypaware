// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { stripManagedHooks } from '../../../../src/core/config/client_detach_disk.js'
import { markActionRefused } from '../../../../src/core/config/action_refusal.js'
import { resolveClientSettingsPath } from '../../../../src/core/daemon/client_settings_path.js'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'
import { isPlainObject } from '../../../../src/core/util/json_util.js'

export const CURSOR_EVENTS = Object.freeze([
  'beforeSubmitPrompt', 'afterAgentResponse', 'postToolUse', 'postToolUseFailure',
  'beforeReadFile',
  'sessionStart', 'sessionEnd', 'stop', 'subagentStart', 'subagentStop',
])

/** @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [opts] */
export function cursorHooksPath(opts = {}) {
  return resolveClientSettingsPath('cursor', '.cursor/hooks.json', opts.env, opts.homeDir ?? opts.env?.HOME ?? os.homedir())
}

/**
 * @param {{ endpoint: string, version: string, env?: NodeJS.ProcessEnv, homeDir?: string, dryRun?: boolean }} opts
 * @ref LLP 0399#attachment: exact commands in the shared JSON undo record
 *   own individual array entries, never the user's hooks file
 */
export async function attachCursorHooks(opts) {
  const settingsPath = cursorHooksPath(opts)
  let raw
  let mtime
  try {
    mtime = (await fs.stat(settingsPath)).mtimeMs
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
  }
  const value = raw === undefined ? {} : JSON.parse(raw)
  if (!isPlainObject(value) || (value.version !== undefined && value.version !== 1) ||
      (value.hooks !== undefined && !isPlainObject(value.hooks))) {
    throw markActionRefused(new Error('Cursor hooks must be a version 1 JSON object with a hooks object'))
  }
  const old = value._hypaware
  if (old !== undefined && (!isPlainObject(old) || !isPlainObject(old.managed) || !Array.isArray(old.managed.hook_entries))) {
    throw markActionRefused(new Error('Cursor _hypaware marker is not a readable managed hook record'))
  }
  if (isPlainObject(old) && isPlainObject(old.managed)) stripManagedHooks(value, /** @type {unknown[]} */ (old.managed.hook_entries))
  // Pruning the last owned hook deletes the hooks root. Reinsert the marker
  // last as on initial attach, so a fresh config stays byte-idempotent too.
  delete value._hypaware
  value.version ??= 1
  value.hooks ??= {}
  const hooks = /** @type {Record<string, unknown>} */ (value.hooks)
  const hookPath = fileURLToPath(new URL('./hook.mjs', import.meta.url))
  // Cursor CLI strips // comments even inside quoted JSON strings. Keep
  // the URL scheme out of its config; the standalone sender restores it.
  const endpoint = new URL(opts.endpoint)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('Cursor requires a loopback HTTP endpoint')
  const command = [process.execPath, hookPath, endpoint.host].map(quote).join(' ')
  const entries = []
  for (const event of CURSOR_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw markActionRefused(new Error(`Cursor ${event} hooks must be an array`))
    }
    // A matching unmarked command is not ours to adopt and later delete.
    const handlers = /** @type {unknown[]} */ (hooks[event] ?? [])
    if (handlers.some((h) => isPlainObject(h) && h.command === command)) {
      throw markActionRefused(new Error(`Cursor ${event} already contains an unowned HypAware command`))
    }
    hooks[event] = [...handlers, { type: 'command', command, timeout: 3, failClosed: false }]
    entries.push({ event, command })
  }
  value._hypaware = {
    version: opts.version,
    attached_at: isPlainObject(old) && typeof old.attached_at === 'string' ? old.attached_at : new Date().toISOString(),
    managed: { hook_entries: entries },
  }
  const body = JSON.stringify(value, null, 2) + '\n'
  const changed = raw !== body
  if (changed && !opts.dryRun) {
    await atomicWriteFile(settingsPath, body, { mode: 0o600, dirMode: 0o700, fsync: true, expectedMtimeMs: mtime })
  }
  return { settingsPath, changed }
}

/** @param {string} value */
function quote(value) { return "'" + value.replace(/'/g, "'\\''") + "'" }

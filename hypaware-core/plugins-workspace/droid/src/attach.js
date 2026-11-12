// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripManagedHooks } from '../../../../src/core/config/client_detach_disk.js'
import { markActionRefused } from '../../../../src/core/config/action_refusal.js'
import { clientHookMarkerPath, resolveClientSettingsPath } from '../../../../src/core/daemon/client_settings_path.js'
import { atomicWriteFile } from '../../../../src/core/util/fs_atomic.js'
import { isPlainObject } from '../../../../src/core/util/json_util.js'

export const DROID_EVENTS = Object.freeze(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd', 'Notification'])

/** @param {{ env?: NodeJS.ProcessEnv, homeDir?: string }} [opts] */
export function droidHooksPath(opts = {}) {
  return resolveClientSettingsPath('droid', '.factory/hooks.json', opts.env, opts.homeDir ?? opts.env?.HOME ?? os.homedir())
}

/** @param {string} file */
async function read(file) {
  try { return await fs.readFile(file, 'utf8') } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
}

/**
 * @param {{ endpoint: string, version: string, env?: NodeJS.ProcessEnv, homeDir?: string, dryRun?: boolean }} opts
 * @ref LLP 0551#attachment: own exact commands, including copies of shadowed fallback hooks
 */
export async function attachDroidHooks(opts) {
  const settingsPath = droidHooksPath(opts)
  const markerPath = /** @type {string} */ (clientHookMarkerPath('droid', settingsPath, opts.env, opts.homeDir ?? opts.env?.HOME ?? os.homedir()))
  const markerRaw = await read(markerPath)
  let mtime
  try { mtime = (await fs.stat(settingsPath)).mtimeMs } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
  const raw = await read(settingsPath)
  if (raw === undefined && await read(path.join(path.dirname(settingsPath), 'hooks', 'hooks.json')) !== undefined) {
    throw markActionRefused(new Error('Migrate Factory legacy hooks/hooks.json to hooks.json before attaching HypAware'))
  }
  const value = raw === undefined ? {} : JSON.parse(raw)
  if (!isPlainObject(value) || value.hooks !== undefined) throw markActionRefused(new Error('Factory hooks.json must map events directly to matcher arrays'))
  const old = markerRaw === undefined ? value._hypaware : JSON.parse(markerRaw)
  const priorEntries = []
  if (old !== undefined && (!isPlainObject(old) || !isPlainObject(old.managed) || !Array.isArray(old.managed.hook_entries))) {
    throw markActionRefused(new Error('Factory _hypaware marker is not a readable managed hook record'))
  }
  if (isPlainObject(old) && isPlainObject(old.managed)) {
    priorEntries.push(.../** @type {unknown[]} */ (old.managed.hook_entries))
    stripManagedHooks(value, priorEntries)
  }
  if (value._hypaware !== undefined && value._hypaware !== old) {
    const legacy = value._hypaware
    if (!isPlainObject(legacy) || !isPlainObject(legacy.managed) || !Array.isArray(legacy.managed.hook_entries)) {
      throw markActionRefused(new Error('Factory _hypaware marker is not a readable managed hook record'))
    }
    stripManagedHooks(value, legacy.managed.hook_entries)
    priorEntries.push(...legacy.managed.hook_entries)
  }
  delete value._hypaware
  const fallbackRaw = await read(path.join(path.dirname(settingsPath), 'settings.json'))
  const fallback = fallbackRaw === undefined ? {} : JSON.parse(fallbackRaw)
  if (!isPlainObject(fallback) || (fallback.hooks !== undefined && !isPlainObject(fallback.hooks))) throw markActionRefused(new Error('Factory settings.json hooks must be an object'))
  const endpoint = new URL(opts.endpoint)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('Factory requires a loopback HTTP endpoint')
  const hookPath = fileURLToPath(new URL('./hook.mjs', import.meta.url))
  const command = [process.execPath, hookPath, endpoint.host].map(quote).join(' ')
  const entries = []
  for (const event of DROID_EVENTS) {
    const inherited = value[event] === undefined
    const groups = value[event] ?? (isPlainObject(fallback.hooks) ? fallback.hooks[event] : undefined) ?? []
    if (!Array.isArray(groups) || groups.some(g => !isPlainObject(g) || !Array.isArray(g.hooks) || g.hooks.some(h => !isPlainObject(h) || h.type !== 'command' || typeof h.command !== 'string'))) {
      throw markActionRefused(new Error(`Factory ${event} hooks must be command matcher groups`))
    }
    for (const group of groups) for (const handler of group.hooks) {
      if (handler.command === command) throw markActionRefused(new Error(`Factory ${event} contains an unowned HypAware command`))
      // Creating this event in hooks.json overrides settings.json's event.
      // Copy its handlers, recording ownership of the copies only. Detach
      // removes those copies and exposes the original fallback again.
      if (inherited) entries.push({ event, ...(typeof group.matcher === 'string' ? { matcher: group.matcher } : {}), command: handler.command })
    }
    value[event] = [...groups, { matcher: '', hooks: [{ type: 'command', command, timeout: 3 }] }]
    entries.push({ event, matcher: '', command })
  }
  const marker = { version: opts.version,
    attached_at: isPlainObject(old) && typeof old.attached_at === 'string' ? old.attached_at : new Date().toISOString(),
    managed: { hook_entries: entries } }
  const body = JSON.stringify(value, null, 2) + '\n'
  const markerBody = JSON.stringify(marker, null, 2) + '\n'
  const changed = raw !== body || markerRaw !== markerBody
  if (changed && !opts.dryRun) {
    // Save both old and proposed ownership before changing hooks. A failed
    // settings write leaves either configuration detachable and retryable.
    const pendingEntries = [...new Map([...priorEntries, ...entries].map(entry => [JSON.stringify(entry), entry])).values()]
    const pending = { ...marker, managed: { hook_entries: pendingEntries } }
    await atomicWriteFile(markerPath, JSON.stringify(pending, null, 2) + '\n', { mode: 0o600, dirMode: 0o700, fsync: true })
    if (raw !== body) await atomicWriteFile(settingsPath, body, { mode: 0o600, dirMode: 0o700, fsync: true, expectedMtimeMs: mtime })
    await atomicWriteFile(markerPath, markerBody, { mode: 0o600, dirMode: 0o700, fsync: true })
  }
  return { settingsPath, changed }
}

/** @param {string} value */
function quote(value) { return "'" + value.replace(/'/g, "'\\''") + "'" }

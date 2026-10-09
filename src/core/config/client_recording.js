// @ts-check

import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { readObservabilityEnv } from '../observability/env.js'
import { resolveConfigPath } from '../runtime/boot.js'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { resolveCentralLayerPath } from './apply.js'
import { prepareLocalConfigWrite } from './schema.js'

/**
 * @import { PluginConfigInstance, PluginName } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ClientRecordingWriteResult, RawPluginEntry, RecordingState } from '../../../src/core/config/types.js'
 */

/**
 * Whether a plugin entry's client is recording. Absent means recording: only
 * an explicit `recording: false`, which `hyp client detach` writes, switches
 * it off.
 *
 * @ref LLP 0466#switch [implements]: one per-client on/off switch, on the owning plugin's entry
 * @param {Pick<PluginConfigInstance, 'recording'> | undefined} entry
 * @returns {boolean}
 */
export function isEntryRecording(entry) {
  return entry?.recording !== false
}

/**
 * Read the recording switch fresh from disk: the plugins whose local entry
 * says `recording: false`, minus any the central layer names (a central entry
 * outranks the local one at merge, so a local `false` there is inert).
 *
 * Raw reads, not `loadConfigFile`: this runs on every scheduled backfill run
 * in the daemon, which booted on an older copy of the config, and it is a
 * membership probe that must not emit `config.load_failed` for an ordinary
 * missing file. An unreadable local layer answers "nothing detached", the
 * pre-switch behavior.
 *
 * @ref LLP 0466#fresh-read [implements]: the daemon learns about a detach on its next run, with no restart
 * @param {{ env: NodeJS.ProcessEnv }} args
 * @returns {Promise<RecordingState>}
 */
export async function readRecordingStateFromDisk({ env }) {
  const { stateDir, hypHome } = readObservabilityEnv(env)
  const centralPath = resolveCentralLayerPath({ stateRoot: stateDir })
  return recordingState(
    await readRawPlugins(resolveConfigPath({ env, hypHome })),
    centralPath ? await readRawPlugins(centralPath) : []
  )
}

/**
 * Synchronous {@link readRecordingStateFromDisk}, for the reconciler's
 * synchronous `desired()`.
 *
 * @param {{ env: NodeJS.ProcessEnv }} args
 * @returns {RecordingState}
 */
export function readRecordingStateFromDiskSync({ env }) {
  const { stateDir, hypHome } = readObservabilityEnv(env)
  const centralPath = resolveCentralLayerPath({ stateRoot: stateDir })
  return recordingState(
    readRawPluginsSync(resolveConfigPath({ env, hypHome })),
    centralPath ? readRawPluginsSync(centralPath) : []
  )
}

/**
 * A strict owner-policy reader for live capture. Stat both layers fresh, but
 * parse only changed files. Retain two bounded plugin lists, never payloads.
 * The older detached-set readers deliberately keep their existing fallback.
 * @ref LLP 0474#recording [implements]: missing, disabled or unreadable Ollama policy closes capture without changing unrelated clients
 * @param {{ env: NodeJS.ProcessEnv, plugin: string }} args
 */
export function createClientRecordingPolicyReader({ env, plugin }) {
  const { stateDir, hypHome } = readObservabilityEnv(env)
  const localPath = resolveConfigPath({ env, hypHome })
  /** @type {Map<string, { signature: string, entries?: RawPluginEntry[], absent?: boolean }>} */
  const cache = new Map()
  /** @param {string | null | undefined} filePath @returns {{ signature?: string, entries?: RawPluginEntry[], absent?: boolean }} */
  function read(filePath) {
    if (!filePath) return { absent: true }
    try {
      const stat = fsSync.statSync(filePath)
      const signature = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
      const previous = cache.get(filePath)
      if (previous?.signature === signature) return previous
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return { signature }
      let entries
      let fd
      try {
        fd = fsSync.openSync(filePath, 'r')
        const actual = fsSync.fstatSync(fd)
        if (actual.isFile() && actual.size <= 4 * 1024 * 1024) {
          const buffer = Buffer.alloc(actual.size + 1)
          let bytes = 0
          let chunk
          do {
            chunk = fsSync.readSync(fd, buffer, bytes, buffer.length - bytes, null)
            bytes += chunk
          } while (chunk && bytes < buffer.length)
          if (bytes <= actual.size) {
            const parsed = JSON.parse(buffer.subarray(0, bytes).toString('utf8'))
            if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.plugins)) {
              entries = []
              for (const entry of parsed.plugins) if (entry && typeof entry === 'object' && entry.name === plugin) {
                entries.push({ name: entry.name, enabled: entry.enabled, recording: entry.recording })
                if (entries.length === 2) break
              }
            }
          }
        }
      } catch { /* Cache an invalid layer too, avoiding repeated failed parsing. */ }
      finally { if (fd !== undefined) fsSync.closeSync(fd) }
      const result = { signature, entries }
      cache.set(filePath, result)
      return result
    } catch (err) {
      cache.delete(filePath)
      return { absent: /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT' }
    }
  }
  return () => {
    // Enrollment and A/B slot flips are live policy changes too. Probe only
    // the four known names when resolution fails, never a directory listing.
    const centralPath = resolveCentralLayerPath({ stateRoot: stateDir })
    for (const key of cache.keys()) if (key !== localPath && key !== centralPath) cache.delete(key)
    if (!centralPath) for (const name of ['active', 'seed.json', 'config.a.json', 'config.b.json']) {
      try {
        fsSync.lstatSync(path.join(stateDir, 'config-control', name))
        return { recording: false, reason: 'policy_unreadable' }
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') return { recording: false, reason: 'policy_unreadable' }
      }
    }
    const central = read(centralPath)
    if (!central.absent && !central.entries) return { recording: false, reason: 'policy_unreadable' }
    const centralOwners = central.entries ?? []
    const local = centralOwners.length ? undefined : read(localPath)
    if (local && !local.absent && !local.entries) return { recording: false, reason: 'policy_unreadable' }
    const owners = centralOwners.length ? centralOwners : local?.entries ?? []
    if (owners.length !== 1) return { recording: false, reason: 'owner_absent' }
    const owner = owners[0]
    if ((owner.enabled !== undefined && typeof owner.enabled !== 'boolean') ||
        (owner.recording !== undefined && typeof owner.recording !== 'boolean')) return { recording: false, reason: 'policy_unreadable' }
    if (owner.enabled === false) return { recording: false, reason: 'owner_disabled' }
    return { recording: owner.recording !== false, reason: owner.recording === false ? 'recording_disabled' : 'recording_enabled' }
  }
}

/**
 * @param {RawPluginEntry[]} local
 * @param {RawPluginEntry[]} central
 * @returns {RecordingState}
 */
function recordingState(local, central) {
  /** @type {Set<string>} */
  const centralNames = new Set()
  /** @type {Set<string>} */
  const detached = new Set()
  for (const entry of central) {
    if (typeof entry.name !== 'string') continue
    centralNames.add(entry.name)
    if (entry.recording === false) detached.add(entry.name)
  }
  for (const entry of local) {
    if (typeof entry.name !== 'string' || centralNames.has(entry.name)) continue
    if (entry.recording === false) detached.add(entry.name)
  }
  return { detached, central: centralNames }
}

/**
 * Turn one client's recording switch on or off in the local config layer.
 *
 * Edits the raw document so shape parsing cannot normalize unrelated fields,
 * and only touches an existing local entry: a client whose plugin has no local
 * entry is not enabled there, so it is already not recording and inventing an
 * entry (which would enable the plugin) is the wrong fix. A plugin the central
 * layer names is refused: the merge drops the local entry, so the write would
 * be inert, and the org config is what requires the integration.
 *
 * @ref LLP 0466#central-refuses [implements]: org policy wins; detach refuses rather than half-detach
 * @param {{ env: NodeJS.ProcessEnv, plugin: PluginName, recording: boolean, dryRun?: boolean }} args
 * @returns {Promise<ClientRecordingWriteResult>}
 */
export async function writeClientRecording({ env, plugin, recording, dryRun = false }) {
  const { stateDir, hypHome } = readObservabilityEnv(env)
  const configPath = resolveConfigPath({ env, hypHome })
  if (plugin === '@hypaware/ollama' && createClientRecordingPolicyReader({ env, plugin })().reason === 'policy_unreadable') {
    return { status: 'failed', configPath, message: 'Ollama recording policy is unreadable; restore the owning config before changing recording.' }
  }
  const centralPath = resolveCentralLayerPath({ stateRoot: stateDir })
  const centralEntry = centralPath
    ? (await readRawPlugins(centralPath)).find((entry) => entry.name === plugin)
    : undefined
  if (centralEntry && centralEntry.enabled !== false) {
    // Detach is the direction org policy forbids. Attach has nothing to
    // switch back on, unless the central entry itself turns recording off.
    return recording === false || centralEntry.recording === false
      ? { status: 'central_managed', configPath }
      : { status: 'unchanged', configPath }
  }

  /** @type {{ plugins?: unknown } & Record<string, unknown>} */
  let raw
  try {
    raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === 'ENOENT') return { status: 'no_entry', configPath }
    return { status: 'failed', configPath, message: err instanceof Error ? err.message : String(err) }
  }
  const plugins = Array.isArray(raw?.plugins) ? raw.plugins : []
  const index = plugins.findIndex((entry) => entry && typeof entry === 'object' && entry.name === plugin)
  if (index === -1) return { status: 'no_entry', configPath }
  const entry = /** @type {Record<string, unknown>} */ (plugins[index])
  if ((entry.recording !== false) === recording) return { status: 'unchanged', configPath }
  if (dryRun) return { status: 'changed', configPath }

  const next = { ...entry }
  if (recording) delete next.recording
  else next.recording = false
  const nextPlugins = plugins.slice()
  nextPlugins[index] = next
  try {
    const stat = await fs.stat(configPath)
    const guard = await prepareLocalConfigWrite({ targetPath: configPath, force: true })
    if (!guard.proceed) return { status: 'failed', configPath, message: guard.message ?? 'config write refused' }
    await atomicWriteJson(configPath, { ...raw, plugins: nextPlugins }, {
      mode: stat.mode & 0o777, expectedMtimeMs: stat.mtimeMs,
    })
    return { status: 'changed', configPath, ...(guard.backupPath ? { backupPath: guard.backupPath } : {}) }
  } catch (err) {
    return { status: 'failed', configPath, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<RawPluginEntry[]>}
 */
async function readRawPlugins(filePath) {
  try {
    return rawPlugins(JSON.parse(await fs.readFile(filePath, 'utf8')))
  } catch {
    return []
  }
}

/**
 * @param {string} filePath
 * @returns {RawPluginEntry[]}
 */
function readRawPluginsSync(filePath) {
  try {
    return rawPlugins(JSON.parse(fsSync.readFileSync(filePath, 'utf8')))
  } catch {
    return []
  }
}

/**
 * @param {unknown} parsed
 * @returns {RawPluginEntry[]}
 */
function rawPlugins(parsed) {
  const plugins = /** @type {{ plugins?: unknown } | null} */ (parsed)?.plugins
  return Array.isArray(plugins) ? plugins.filter((entry) => entry && typeof entry === 'object') : []
}

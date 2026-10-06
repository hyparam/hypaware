// @ts-check

import fsSync from 'node:fs'
import fs from 'node:fs/promises'

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
  const centralPath = resolveCentralLayerPath({ stateRoot: stateDir })
  const centralEntry = centralPath
    ? (await readRawPlugins(centralPath)).find((entry) => entry.name === plugin)
    : undefined
  if (centralEntry && centralEntry.enabled !== false) {
    // Attach on a central entry has nothing to switch back on; detach is the
    // direction org policy forbids.
    return recording === false
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

// @ts-check

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { defaultConfigPath, loadConfigFile } from '../config/schema.js'
import { devTelemetryDir, readObservabilityEnv } from '../observability/env.js'
import { diagnoseV1Config, mergeInstalledManifestsIntoKnown, validateConfig } from '../config/validate.js'
import { discoverInstalledPlugins } from '../runtime/installed.js'
import {
  defaultLogDir,
  platformIsSupported,
} from './platform.js'
import {
  isLaunchAgentInstalled,
  launchAgentStatus,
} from './macos.js'
import {
  isSystemdUnitInstalled,
  systemdUnitStatus,
} from './linux.js'
import {
  daemonRunDir,
  processIsAlive,
  readPidFile,
} from './pid.js'

/**
 * Daemon health states the smoke and `hyp daemon status` rely on.
 *
 * - `starting`: the daemon has written its PID file but has not yet
 *   reported every configured source as up.
 * - `healthy`: every configured source returned a `StartedSource`.
 * - `degraded`: at least one source failed to start or failed status.
 * - `stopping`: SIGTERM/SIGINT received, sources are being shut down.
 * - `stopped`: shutdown completed; status file remains so a parallel
 *   `daemon status` can read the last terminal state.
 *
 * @typedef {'starting'|'healthy'|'degraded'|'stopping'|'stopped'} DaemonState
 */

/**
 * @typedef {Object} SourceSnapshot
 * @property {string} name
 * @property {string} plugin
 * @property {'started'|'failed'|'stopped'} state
 * @property {string} [error]
 * @property {object} [details]
 */

/**
 * @typedef {Object} SinkSnapshot
 * @property {string} instance
 * @property {string} plugin
 * @property {string} kind
 * @property {string} [lastTickAt]
 * @property {string} [lastSuccessAt]
 * @property {number} [failedOutboxCount]
 * @property {string} [nextScheduledAt]
 */

/**
 * @typedef {Object} DaemonStatus
 * @property {DaemonState} state
 * @property {number} pid
 * @property {string} startedAt              ISO timestamp of the daemon process boot.
 * @property {string} [healthyAt]            ISO timestamp the daemon first reached `healthy`.
 * @property {string} [stoppedAt]            ISO timestamp the daemon transitioned to `stopped`.
 * @property {number} uptimeMs               Milliseconds since `healthyAt` (0 when not yet healthy).
 * @property {string} runId                  dev_run_id stamped on telemetry from this daemon.
 * @property {string} mode                   `foreground` (Phase 3) or `detached` (Phase 4 installers).
 * @property {string} [configPath]           Active config file, when one was resolved.
 * @property {SourceSnapshot[]} sources
 * @property {SinkSnapshot[]} sinks
 * @property {string[]} [warnings]
 */

/**
 * Path to the daemon status file. Written by the daemon at each
 * lifecycle transition so a parallel `hyp daemon status --json` call
 * sees a consistent snapshot without having to walk the kernel.
 *
 * @param {string} stateRoot
 */
export function statusFilePath(stateRoot) {
  return path.join(daemonRunDir(stateRoot), 'status.json')
}

/**
 * Write a status file atomically (write to `.tmp`, then rename). The
 * smoke harness asserts against this file directly so it must always
 * be either absent or fully formed — partial writes would race the
 * SIGTERM assertion.
 *
 * @param {string} stateRoot
 * @param {DaemonStatus} status
 */
export function writeStatusFile(stateRoot, status) {
  const dir = daemonRunDir(stateRoot)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `status.json.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, statusFilePath(stateRoot))
}

/**
 * Read the status file. Returns `null` when no daemon has run for
 * this `HYP_HOME` yet — `hyp daemon status` surfaces that as
 * "daemon: not started" rather than an error.
 *
 * @param {string} stateRoot
 * @returns {DaemonStatus | null}
 */
export function readStatusFile(stateRoot) {
  /** @type {string} */
  let raw
  try {
    raw = fs.readFileSync(statusFilePath(stateRoot), 'utf8')
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
    throw err
  }
  /** @type {unknown} */
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`readStatusFile: malformed entry at ${statusFilePath(stateRoot)}`)
  }
  return /** @type {DaemonStatus} */ (parsed)
}

/* ---------- Phase 8: top-level status collector ---------- */

/** @typedef {import('../../../collectivus-plugin-kernel-types').HypAwareV2Config} HypAwareV2Config */
/** @typedef {import('../config/validate.js').V1Diagnostic} V1Diagnostic */
/** @typedef {import('../config/validate.js').ConfigValidationError} ConfigValidationError */

/**
 * @typedef {(
 *   |V1Diagnostic['kind']
 *   |'config_invalid'
 *   |'config_missing'
 *   |'config_unreadable'
 *   |'daemon_binary_missing'
 *   |'daemon_loaded_no_pid'
 *   |'client_attach_missing'
 *   |'recent_errors'
 * )} StatusDiagnosticKind
 */

/**
 * Diagnostic surfaced by `hyp status`. Carries a severity, the
 * machine-readable `kind` (so smoke tests can grep for specific
 * conditions), a human-readable `message`, and a list of `repair`
 * commands the operator can copy/paste.
 *
 * @typedef {Object} StatusDiagnostic
 * @property {'error'|'warning'} severity
 * @property {StatusDiagnosticKind} kind
 * @property {string} message
 * @property {string[]} repair
 * @property {string} [pointer]
 */

/**
 * Per-client attach state probed off the user's home directory.
 *
 * @typedef {Object} ClientAttachReport
 * @property {string} name              `claude` or `codex`.
 * @property {boolean} configured       Plugin enabled in config.
 * @property {boolean} attached         Settings file carries the HypAware marker.
 * @property {string} [settingsPath]    Path the probe inspected.
 * @property {string} [version]         Adapter version recorded in the marker, when present.
 * @property {string} [port]            Local gateway port the adapter routes through, when recorded.
 * @property {string} [error]           Probe error string, when the file was unreadable.
 */

/**
 * Service-level daemon state surfaced by `hyp status`.
 *
 * @typedef {Object} ServiceState
 * @property {boolean} installed              Service file present at the platform path.
 * @property {boolean} loaded                 Service registered with launchd/systemd.
 * @property {boolean} running                A process is currently running.
 * @property {number} [pid]                   PID, if running.
 * @property {DaemonState} [state]            Last reported daemon state, when a status file exists.
 * @property {string} [runId]                 dev_run_id of the active daemon process.
 * @property {string} [mode]                  `foreground` / `detached`.
 * @property {NodeJS.Platform} platform
 * @property {string} [error]                 Error reading installer state, if any.
 */

/**
 * @typedef {Object} HypAwareStatusReport
 * @property {string} configPath                    Path probed for the active config.
 * @property {boolean} configExists                 Config file exists on disk.
 * @property {boolean} configValid                  Schema + cross-plugin validation passed.
 * @property {string[]} activePlugins               Plugin names enabled in the config.
 * @property {ServiceState} daemon                  Daemon + service state.
 * @property {SourceSnapshot[]} sources             Source rows (kernel runtime where available).
 * @property {SinkSnapshot[]} sinks                 Sink rows.
 * @property {ClientAttachReport[]} clients         Per-client attach reports.
 * @property {{ days: number, source: 'config'|'default' }} retention
 * @property {{ totalBytes: number, oldestDate: string|null }} cache
 * @property {number} recentErrorCount              Error-level log entries in the recent telemetry window.
 * @property {StatusDiagnostic[]} diagnostics       Aggregated config + runtime diagnostics.
 * @property {'healthy'|'degraded'} overall
 */

/**
 * @typedef {Object} CollectStatusOptions
 * @property {NodeJS.ProcessEnv} [env]
 * @property {Object} [runtime]                Optional kernel runtime (already booted by the caller).
 * @property {import('../registry/sources.js').ExtendedSourceRegistry} [runtime.sources]
 * @property {import('../registry/sinks.js').ExtendedSinkRegistry} [runtime.sinks]
 * @property {import('../../../collectivus-plugin-kernel-types').CapabilityRegistry} [runtime.capabilities]
 * @property {import('../../../collectivus-plugin-kernel-types').QueryRegistry} [runtime.query]
 * @property {{ cacheRoot: string }} [runtime.storage]
 * @property {NodeJS.Platform} [platform]      Override platform (tests).
 * @property {string} [homeDir]                Override $HOME (tests).
 * @property {string} [binPath]                Absolute path to the daemon binary the installer recorded.
 * @property {(opts: any) => boolean} [isLaunchAgentInstalled]
 * @property {(opts: any) => Promise<{ loaded: boolean, pid?: number }>} [launchAgentStatus]
 * @property {(opts: any) => boolean} [isSystemdUnitInstalled]
 * @property {(opts: any) => Promise<{ loaded: boolean, pid?: number }>} [systemdUnitStatus]
 */

/**
 * Collect everything `hyp status` shows. Reads config from disk,
 * probes daemon install + runtime state, walks the kernel runtime
 * for source/sink contributions when available, and probes client
 * settings files for the HypAware attach markers. All probes are
 * best-effort: a single probe failing surfaces as a warning, not an
 * exception, so the operator always gets a complete report.
 *
 * @param {CollectStatusOptions} [opts]
 * @returns {Promise<HypAwareStatusReport>}
 */
export async function collectHypAwareStatus(opts = {}) {
  const env = opts.env ?? process.env
  const obsEnv = readObservabilityEnv(env)
  const hypHome = obsEnv.hypHome
  const stateRoot = obsEnv.stateDir
  const platform = opts.platform ?? process.platform
  const homeDir = opts.homeDir ?? env.HOME ?? process.env.HOME ?? ''

  // ----- config -----
  const configPath = env.HYP_CONFIG
    ? path.resolve(env.HYP_CONFIG)
    : defaultConfigPath(hypHome)
  const loaded = await loadConfigFile(configPath)
  const config = loaded.ok ? loaded.config : null
  const configExists = loaded.ok || (loaded.errorKind !== 'config_missing')

  /** @type {ConfigValidationError[]} */
  let validationErrors = []
  if (loaded.ok) {
    try {
      /** @type {Awaited<ReturnType<typeof discoverInstalledPlugins>>} */
      let installed
      try {
        installed = await discoverInstalledPlugins({ stateDir: stateRoot })
      } catch {
        installed = { loaded: [], failed: [], lockEntries: [] }
      }
      const knownPlugins = mergeInstalledManifestsIntoKnown(installed.loaded)
      const result = await validateConfig(loaded.config, { knownPlugins })
      validationErrors = result.errors
    } catch (err) {
      validationErrors = [{
        pointer: '/',
        errorKind: 'config_section_invalid',
        message: `config validation threw: ${err instanceof Error ? err.message : String(err)}`,
      }]
    }
  }
  const configValid = loaded.ok && validationErrors.length === 0

  // ----- diagnostics -----
  /** @type {StatusDiagnostic[]} */
  const diagnostics = []

  if (!loaded.ok) {
    if (loaded.errorKind === 'config_missing') {
      diagnostics.push({
        severity: 'warning',
        kind: 'config_missing',
        message: `config file not found at ${configPath}`,
        repair: ['hyp init', 'hyp init --from-file <config.json>'],
      })
    } else {
      diagnostics.push({
        severity: 'error',
        kind: 'config_unreadable',
        message: loaded.message,
        repair: ['hyp init --from-file <config.json>'],
      })
    }
  } else if (validationErrors.length > 0) {
    for (const err of validationErrors) {
      diagnostics.push({
        severity: 'error',
        kind: 'config_invalid',
        message: `[${err.errorKind}] ${err.pointer || '<root>'}: ${err.message}`,
        repair: repairForConfigError(err.errorKind),
        pointer: err.pointer,
      })
    }
  }

  // V1 advisory diagnostics layered on top.
  const v1Diagnostics = diagnoseV1Config(config)
  for (const d of v1Diagnostics) {
    diagnostics.push({
      severity: 'warning',
      kind: d.kind,
      message: d.message,
      repair: d.repair,
      pointer: d.pointer,
    })
  }

  // ----- active plugins -----
  /** @type {string[]} */
  const activePlugins = []
  if (config?.plugins) {
    for (const entry of config.plugins) {
      if (entry.enabled === false) continue
      activePlugins.push(entry.name)
    }
  }

  // ----- daemon -----
  /** @type {ServiceState} */
  const daemon = {
    installed: false,
    loaded: false,
    running: false,
    platform,
  }
  try {
    const installerOpts = { homeDir, platform }
    if (platform === 'darwin') {
      const installedFn = opts.isLaunchAgentInstalled ?? isLaunchAgentInstalled
      daemon.installed = installedFn(installerOpts)
      if (daemon.installed) {
        const statusFn = opts.launchAgentStatus ?? launchAgentStatus
        const probe = await statusFn(installerOpts)
        daemon.loaded = probe.loaded
        if (probe.pid !== undefined) {
          daemon.pid = probe.pid
          daemon.running = processIsAlive(probe.pid)
        }
      }
    } else if (platform === 'linux') {
      const installedFn = opts.isSystemdUnitInstalled ?? isSystemdUnitInstalled
      daemon.installed = installedFn(installerOpts)
      if (daemon.installed) {
        const statusFn = opts.systemdUnitStatus ?? systemdUnitStatus
        const probe = await statusFn(installerOpts)
        daemon.loaded = probe.loaded
        if (probe.pid !== undefined) {
          daemon.pid = probe.pid
          daemon.running = processIsAlive(probe.pid)
        }
      }
    }
  } catch (err) {
    daemon.error = err instanceof Error ? err.message : String(err)
  }

  // Fall back to the PID + status files when the installer probe
  // didn't already report a live process — covers foreground
  // `hyp daemon run` sessions.
  if (!daemon.running) {
    try {
      const pidEntry = readPidFile(stateRoot)
      if (pidEntry && processIsAlive(pidEntry.pid)) {
        daemon.running = true
        daemon.pid = pidEntry.pid
        daemon.runId = pidEntry.runId
        daemon.mode = pidEntry.mode
      }
    } catch (err) {
      if (!daemon.error) {
        daemon.error = err instanceof Error ? err.message : String(err)
      }
    }
  }

  /** @type {DaemonStatus | null} */
  let daemonStatusFile = null
  try {
    daemonStatusFile = readStatusFile(stateRoot)
  } catch (err) {
    if (!daemon.error) {
      daemon.error = err instanceof Error ? err.message : String(err)
    }
  }
  if (daemonStatusFile) {
    if (!daemon.runId) daemon.runId = daemonStatusFile.runId
    if (!daemon.mode) daemon.mode = daemonStatusFile.mode
    daemon.state = daemonStatusFile.state
  }

  if (daemon.installed && !daemon.loaded) {
    diagnostics.push({
      severity: 'warning',
      kind: 'daemon_loaded_no_pid',
      message:
        platform === 'darwin'
          ? 'launchd is not currently loading the HypAware LaunchAgent'
          : 'systemd is not currently loading the HypAware user unit',
      repair: ['hyp daemon restart'],
    })
  }

  if (opts.binPath) {
    let binExists = true
    try {
      await fsp.access(opts.binPath)
    } catch {
      binExists = false
    }
    if (!binExists) {
      diagnostics.push({
        severity: 'error',
        kind: 'daemon_binary_missing',
        message: `daemon installer references binary '${opts.binPath}' but the file is missing`,
        repair: ['hyp daemon install'],
      })
    }
  }

  // ----- sources / sinks -----
  /** @type {SourceSnapshot[]} */
  const sources = []
  /** @type {SinkSnapshot[]} */
  const sinks = []
  const runtimeSources = opts.runtime?.sources?.list?.() ?? []
  if (runtimeSources.length > 0) {
    for (const contribution of runtimeSources) {
      const started = opts.runtime.sources.started?.(contribution.name)
      sources.push({
        name: contribution.name,
        plugin: contribution.plugin,
        state: started ? 'started' : 'stopped',
      })
    }
  } else if (daemonStatusFile && (daemonStatusFile.sources?.length ?? 0) > 0) {
    sources.push(...(daemonStatusFile.sources ?? []))
  } else {
    sources.push(...inferConfiguredSources(activePlugins))
  }

  // Sinks are derived from the loaded config (so the count reflects
  // "how many sinks does the user have configured?" — the same number
  // a fresh kernel boot or a running daemon would surface). When
  // matching runtime handles exist on the kernel, layer in the live
  // instance metadata (plugin / kind) so the report does not lose
  // detail on a running install.
  /** @type {Map<string, { plugin: string, kind: string }>} */
  const handleByInstance = new Map()
  if (opts.runtime?.sinks) {
    for (const handle of opts.runtime.sinks.listHandles()) {
      handleByInstance.set(handle.instanceName, { plugin: handle.plugin, kind: handle.kind })
    }
  }
  if (config?.sinks) {
    for (const [name, raw] of Object.entries(config.sinks)) {
      const handle = handleByInstance.get(name)
      const entry = /** @type {Record<string, unknown>} */ (raw)
      const writer = typeof entry.writer === 'string' ? entry.writer : undefined
      const destination = typeof entry.destination === 'string' ? entry.destination : undefined
      const requestPlugin = typeof entry.plugin === 'string' ? entry.plugin : undefined
      sinks.push({
        instance: name,
        plugin: handle?.plugin ?? requestPlugin ?? destination ?? writer ?? '',
        kind: handle?.kind ?? (writer && destination ? 'blob' : requestPlugin ? 'request' : ''),
      })
    }
  } else if (handleByInstance.size > 0) {
    for (const [instance, info] of handleByInstance.entries()) {
      sinks.push({ instance, plugin: info.plugin, kind: info.kind })
    }
  } else if (daemonStatusFile) {
    sinks.push(...(daemonStatusFile.sinks ?? []))
  }

  // ----- client attach -----
  /** @type {ClientAttachReport[]} */
  const clients = []
  for (const clientName of /** @type {const} */ (['claude', 'codex'])) {
    const pluginName = clientName === 'claude' ? '@hypaware/claude' : '@hypaware/codex'
    const configured = activePlugins.includes(pluginName)
    const probe = await probeClientAttach({ clientName, homeDir, env })
    clients.push({
      name: clientName,
      configured,
      attached: probe.attached,
      ...(probe.settingsPath ? { settingsPath: probe.settingsPath } : {}),
      ...(probe.version !== undefined ? { version: probe.version } : {}),
      ...(probe.port !== undefined ? { port: probe.port } : {}),
      ...(probe.error !== undefined ? { error: probe.error } : {}),
    })
    if (configured && !probe.attached) {
      diagnostics.push({
        severity: 'warning',
        kind: 'client_attach_missing',
        message: `'${pluginName}' is enabled but ${clientName} settings show no HypAware marker — run 'hyp attach --client ${clientName}'`,
        repair: [`hyp attach --client ${clientName}`],
      })
    }
  }

  // ----- retention + cache stats -----
  const retention = readRetention(config)
  const cacheRoot = opts.runtime?.storage?.cacheRoot ?? path.join(stateRoot, 'cache')
  const cache = await measureCacheStats(cacheRoot)

  // ----- recent errors -----
  const recentErrorCount = await countRecentErrors(devTelemetryDir(stateRoot))
  if (recentErrorCount > 0) {
    diagnostics.push({
      severity: 'warning',
      kind: 'recent_errors',
      message: `${recentErrorCount} error log entr${recentErrorCount === 1 ? 'y' : 'ies'} in recent telemetry`,
      repair: ['hyp daemon restart'],
    })
  }

  // Anything that the operator would have to fix to call the install
  // "set up" should degrade overall — config errors, v1 inconsistencies,
  // and the "no config at all yet" case. `client_attach_missing` /
  // `recent_errors` stay informational so a perfectly-configured-but-
  // not-yet-attached install can still report healthy.
  const degradingKinds = new Set(['config_missing', 'config_unreadable'])
  const overall =
    diagnostics.some((d) => d.severity === 'error') ? 'degraded'
    : v1Diagnostics.length > 0 ? 'degraded'
    : diagnostics.some((d) => degradingKinds.has(d.kind)) ? 'degraded'
    : 'healthy'

  return {
    configPath,
    configExists,
    configValid,
    activePlugins,
    daemon,
    sources,
    sinks,
    clients,
    retention,
    cache,
    recentErrorCount,
    diagnostics,
    overall,
  }
}

/**
 * Infer configured V1 source rows without activating plugins. `hyp
 * status` uses this path so rendering the report cannot bind the
 * user's gateway or OTLP ports.
 *
 * @param {string[]} activePlugins
 * @returns {SourceSnapshot[]}
 */
function inferConfiguredSources(activePlugins) {
  const active = new Set(activePlugins)
  /** @type {SourceSnapshot[]} */
  const sources = []
  if (active.has('@hypaware/ai-gateway')) {
    sources.push({
      name: 'ai-gateway',
      plugin: '@hypaware/ai-gateway',
      state: 'stopped',
    })
  }
  if (active.has('@hypaware/otel')) {
    sources.push({
      name: 'otlp',
      plugin: '@hypaware/otel',
      state: 'stopped',
    })
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * @param {string} cacheRoot
 * @returns {Promise<{ totalBytes: number, oldestDate: string|null }>}
 */
async function measureCacheStats(cacheRoot) {
  /** @type {{ totalBytes: number, oldestMs: number|null }} */
  const acc = { totalBytes: 0, oldestMs: null }
  await walkForStats(cacheRoot, acc)
  const oldestDate = acc.oldestMs === null
    ? null
    : new Date(acc.oldestMs).toISOString().slice(0, 10)
  return { totalBytes: acc.totalBytes, oldestDate }
}

/**
 * @param {string} dir
 * @param {{ totalBytes: number, oldestMs: number|null }} acc
 */
async function walkForStats(dir, acc) {
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkForStats(full, acc)
    } else if (entry.isFile()) {
      const stat = await fsp.stat(full)
      acc.totalBytes += stat.size
      if (acc.oldestMs === null || stat.mtimeMs < acc.oldestMs) acc.oldestMs = stat.mtimeMs
    }
  }
}

/**
 * @param {HypAwareV2Config|null} config
 * @returns {{ days: number, source: 'config'|'default' }}
 */
function readRetention(config) {
  const days = config?.query?.cache?.retention?.default_days
  if (typeof days === 'number' && Number.isFinite(days) && days >= 0) {
    return { days, source: 'config' }
  }
  return { days: 30, source: 'default' }
}

const CLAUDE_MARKER = '_hypaware'
const CODEX_PROVIDER_HEADER = '[model_providers.hypaware]'

/**
 * Probe the on-disk settings for a client adapter and report whether
 * the HypAware attach marker is present.
 *
 * - claude: parses `~/.claude/settings.json`, looks for the
 *   `_hypaware` marker the adapter writes.
 * - codex: reads `~/.codex/config.toml`, looks for the
 *   `[model_providers.hypaware]` header the adapter writes.
 *
 * @param {{ clientName: 'claude'|'codex', homeDir: string, env?: NodeJS.ProcessEnv }} args
 * @returns {Promise<{ attached: boolean, settingsPath?: string, version?: string, port?: string, error?: string }>}
 */
async function probeClientAttach({ clientName, homeDir, env }) {
  if (!homeDir) return { attached: false }
  if (clientName === 'claude') {
    const settingsPath = path.join(homeDir, '.claude', 'settings.json')
    try {
      const raw = await fsp.readFile(settingsPath, 'utf8')
      /** @type {unknown} */
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') {
        return { attached: false, settingsPath }
      }
      const marker = /** @type {Record<string, unknown>} */ (parsed)[CLAUDE_MARKER]
      if (!marker || typeof marker !== 'object') return { attached: false, settingsPath }
      const markerObj = /** @type {Record<string, unknown>} */ (marker)
      return {
        attached: true,
        settingsPath,
        version: typeof markerObj.version === 'string' ? markerObj.version : undefined,
        port: typeof markerObj.port === 'number' ? String(markerObj.port) : undefined,
      }
    } catch (err) {
      const code = err && /** @type {NodeJS.ErrnoException} */ (err).code
      if (code === 'ENOENT') return { attached: false, settingsPath }
      return {
        attached: false,
        settingsPath,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
  // codex
  const settingsPath = path.join(codexHomeDir(env, homeDir), 'config.toml')
  try {
    const raw = await fsp.readFile(settingsPath, 'utf8')
    return { attached: raw.includes(CODEX_PROVIDER_HEADER), settingsPath }
  } catch (err) {
    const code = err && /** @type {NodeJS.ErrnoException} */ (err).code
    if (code === 'ENOENT') return { attached: false, settingsPath }
    return {
      attached: false,
      settingsPath,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {string} homeDir
 */
function codexHomeDir(env, homeDir) {
  const codexHome = env?.CODEX_HOME
  if (typeof codexHome === 'string' && codexHome.length > 0) return codexHome
  return path.join(homeDir, '.codex')
}

/**
 * Walk the recent telemetry directory and count log entries whose
 * `severityText` is `ERROR`. Returns 0 when the directory does not
 * exist yet (no observability run has captured anything).
 *
 * @param {string} telemetryDir
 */
async function countRecentErrors(telemetryDir) {
  /** @type {string[]} */
  let entries
  try {
    entries = await fsp.readdir(telemetryDir)
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return 0
    return 0
  }
  let count = 0
  for (const entry of entries) {
    if (!entry.startsWith('logs-') || !entry.endsWith('.jsonl')) continue
    /** @type {string} */
    let raw
    try {
      raw = await fsp.readFile(path.join(telemetryDir, entry), 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object' && /** @type {any} */ (parsed).severityText === 'ERROR') {
          count += 1
        }
      } catch {
        // skip malformed lines silently
      }
    }
  }
  return count
}

/**
 * Map config-validate `error_kind` values to the repair commands
 * status surfaces alongside them. Returning an empty array is
 * acceptable — the renderer just shows the diagnostic without a
 * "try this" line.
 *
 * @param {ConfigValidationError['errorKind']} kind
 * @returns {string[]}
 */
function repairForConfigError(kind) {
  switch (kind) {
    case 'sink_pair_incompatible':
    case 'sink_plugin_unknown':
    case 'sink_schedule_invalid':
    case 'request_sink_invalid_keys':
      return ['hyp init --from-file <config.json>']
    case 'capability_ambiguous':
      return ['# Add a disambiguate.<capability> entry to your config']
    case 'duplicate_plugin':
    case 'plugin_unknown':
      return ['hyp init --from-file <config.json>']
    default:
      return []
  }
}

/**
 * Expose the daemon log directory so command callers can render it
 * alongside the run state.
 *
 * @param {string} [homeDir]
 */
export function statusLogDir(homeDir) {
  return defaultLogDir(homeDir)
}

/**
 * Re-exported for symmetry with `statusLogDir`. The Phase 8 work uses
 * `platformIsSupported` to decide whether to skip installer probes
 * when running on Windows; surfacing the helper here keeps the import
 * surface of `core_commands.js` small.
 */
export { platformIsSupported }

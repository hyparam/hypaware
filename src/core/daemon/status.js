// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { defaultConfigPath, loadConfigFile } from '../config/schema.js'
import { readConfigControlStatus, resolveCentralLayerPath } from '../config/apply.js'
import { readClientActionStatus } from '../config/action_reconciler.js'
import { endpointFromListen } from '../config/gateway_endpoint.js'
import { readAttachPolicy } from '../config/attach_policy.js'
import { readBackfillPolicy } from '../config/backfill_policy.js'
import { DEFAULT_RETENTION_DAYS } from '../cache/retention.js'
import { resolveLayeredConfig } from '../config/merge.js'
import { devTelemetryDir, readObservabilityEnv } from '../observability/env.js'
import { collectConfigErrors, diagnoseV1Config, validateConfig } from '../config/validate.js'
import { discoverInstalledPlugins } from '../runtime/installed.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { classifyClientProvenance } from '../cli/wizard/provenance.js'
import { atomicWriteJsonSync, readFileIfExistsSync } from '../util/fs_atomic.js'
import { getAtDottedPath, isPlainObject, sanitizeLabel } from '../util/json_util.js'
import {
  ClientSyncListUnreadableError,
  localOnlyListPath,
  LocalOnlyListUnreadableError,
  optedOutClientSourceIds,
  readClientSyncEntries,
  readFolderAskModeSafe,
  readLocalOnlyDirs,
} from '../usage-policy/index.js'
import { readFirstSyncDeadline } from '../usage-policy/first_sync_hold.js'
import { resolveClientSettingsPath } from './client_settings_path.js'
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
 * @import { HypAwareV2Config, PluginConfigInstance } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ClientActionStatus, ConfigControlStatus, ConfigValidationError } from '../../../src/core/config/types.js'
 * @import { ClientActionReport, ClientActionsReport, ClientAttachReport, CollectStatusOptions, DaemonStatus, HypAwareStatusReport, RecentEntrypoint, ServiceState, SinkSnapshot, SourceSnapshot, StatusDiagnostic } from '../../../src/core/daemon/types.js'
 * @import { Dirent } from 'node:fs'
 * @import { ClientDescriptor, LoadedManifest, PluginCatalog } from '../../../src/core/types.js'
 * @import { FolderAskMode } from '../../../src/core/usage-policy/types.js'
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
 * be either absent or fully formed. Partial writes would race the
 * SIGTERM assertion.
 *
 * @param {string} stateRoot
 * @param {DaemonStatus} status
 */
export function writeStatusFile(stateRoot, status) {
  atomicWriteJsonSync(statusFilePath(stateRoot), status)
}

/**
 * Read the status file. Returns `null` when no daemon has run for
 * this `HYP_HOME` yet. `hyp daemon status` surfaces that as
 * "daemon: not started" rather than an error.
 *
 * @param {string} stateRoot
 * @returns {DaemonStatus | null}
 */
export function readStatusFile(stateRoot) {
  const raw = readFileIfExistsSync(statusFilePath(stateRoot))
  if (raw === null) return null
  /** @type {unknown} */
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`readStatusFile: malformed entry at ${statusFilePath(stateRoot)}`)
  }
  return /** @type {DaemonStatus} */ (parsed)
}

/** The AI gateway plugin name: the source whose bound port drives attach. */
const GATEWAY_PLUGIN_NAME = '@hypaware/ai-gateway'

/**
 * Pull the AI gateway source's bound `{ host, port }` out of a status-file
 * source-snapshot list. The daemon captures the gateway source's `status()`
 * `details: { host, port, ... }` into each `SourceSnapshot.details`
 * (`startConfiguredSources`), so the port a rebinding daemon actually chose is
 * always readable here, no in-process gateway needed. Returns `undefined`
 * when the gateway source is absent or recorded no usable host/port (e.g. it
 * failed to bind).
 *
 * @param {SourceSnapshot[] | undefined} sources
 * @returns {{ host: string, port: number, listenFallback: boolean, listenFallbackFrom?: string } | undefined}
 * @ref LLP 0086#endpoint-discovery [implements]: the daemon's live bound port is read from status.json sources[].details, not guessed
 */
export function gatewaySourceDetails(sources) {
  const details = gatewaySourceRawDetails(sources)
  if (!details) return undefined
  const port = details.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return undefined
  const host = typeof details.host === 'string' && details.host.length > 0 ? details.host : '127.0.0.1'
  // @ref LLP 0114#fallback-is-visible [implements]: the gateway records whether this bind came through the default-port fallback
  const listenFallback = details.listen_fallback === true
  const listenFallbackFrom =
    typeof details.listen_fallback_from === 'string' && details.listen_fallback_from.length > 0
      ? details.listen_fallback_from
      : undefined
  return { host, port, listenFallback, ...(listenFallbackFrom ? { listenFallbackFrom } : {}) }
}

/**
 * The gateway source's `status()` details as the daemon captured them, before
 * any "is it bound?" filtering. `gatewaySourceDetails` above answers "where do
 * I send traffic?" and so returns nothing for a gateway that never bound; the
 * idle checks below need the details of exactly that case.
 *
 * @param {SourceSnapshot[] | undefined} sources
 * @returns {Record<string, unknown> | undefined}
 */
function gatewaySourceRawDetails(sources) {
  const list = Array.isArray(sources) ? sources : []
  const source =
    list.find((s) => s && s.plugin === GATEWAY_PLUGIN_NAME) ??
    list.find((s) => s && s.name === 'ai-gateway')
  const rawDetails = source && typeof source.details === 'object' ? source.details : undefined
  if (!rawDetails) return undefined
  return /** @type {Record<string, unknown>} */ (rawDetails)
}

/**
 * How many upstreams a *deliberately idle* gateway was nonetheless configured
 * with, and which of them it can name, or `undefined` when the gateway is
 * bound, absent, or idle for the reason it is allowed to be idle.
 *
 * An upstream-less gateway is a legitimate config (LLP 0120: hermes composes
 * the plugin for its materializer alone and contributes no upstream), so the
 * source idles instead of failing to start. That trade turns one class of
 * misconfiguration silent: a config that *did* list upstreams and lost them
 * all to `compileUpstreams` (an entry missing either required key is dropped
 * without complaint, and `diagnoseV1Config`'s `gateway_missing_*_upstream`
 * check does not fire for that shape, since it matches on `provider` too) also
 * idles, reporting `started` and `healthy` while the user's client gets
 * ECONNREFUSED.
 *
 * The *count* is what separates them, not the names. `compileUpstreams` drops
 * an entry for a missing `name` exactly as silently as for a missing
 * `base_url`, and a nameless entry contributes nothing to `details.upstreams`,
 * so a config of `provider = "anthropic", base_url = "..."` looks identical to
 * hermes-only through the names alone. `details.upstreams_configured` counts
 * the entries the config listed whatever shape they were in, so hermes-only
 * yields 0 and any dropped upstream yields at least 1. The names still ride
 * along, pre-compile, because they make the warning concrete when they exist.
 *
 * A status file written before `upstreams_configured` existed carries names
 * only; those still count for themselves, so an older daemon's dropped
 * `base_url` stays visible.
 *
 * @param {SourceSnapshot[] | undefined} sources
 * @returns {{ count: number, names: string[] } | undefined}
 */
function gatewayIdleWithConfiguredUpstreams(sources) {
  const details = gatewaySourceRawDetails(sources)
  if (!details || details.listening !== false) return undefined
  const upstreams = details.upstreams
  const names = Array.isArray(upstreams)
    ? /** @type {string[]} */ (upstreams.filter((u) => typeof u === 'string' && u.length > 0))
    : []
  const rawCount = details.upstreams_configured
  const count =
    typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0
      ? rawCount
      : names.length
  return count > 0 ? { count, names } : undefined
}

/**
 * How many recent client surfaces `hyp status` will report. The gateway keeps
 * its own, deliberately equal, cap on the writing side; this one exists
 * because core reads a *file* and a file can have been written by an older
 * build, a different build, or something that is not this daemon at all. It
 * bounds the terminal output, not the tracker.
 */
const MAX_RECENT_ENTRYPOINTS = 32

/**
 * Lift the gateway source's `recent_entrypoints` detail out of a status-file
 * source-snapshot list, most recently seen first.
 *
 * This is the whole of core's knowledge about client surfaces: it validates
 * shape and orders by time, and never interprets an `entrypoint` string. Which
 * value means "Codex Desktop" stays Codex's business, exactly as
 * [LLP 0130]'s "rendering needs no plugin code" and LLP 0003's core/plugin
 * split require. Malformed or partial entries are dropped rather than repaired:
 * a name in `hyp status` that no query could reproduce would be worse than a
 * short list.
 *
 * Labels are sanitized here as well as at the gateway that wrote them, and the
 * list is capped here as well as there. This is not belt-and-braces:
 * `status.json` is a file, and core must not assume the daemon that wrote it
 * was this version, was this build, or was well behaved. Everything read here
 * is about to be printed to a terminal, so all three ways a label can be
 * hostile are answered at the last point before render - control and invisible
 * bytes (`sanitizeLabel`), unbounded length (`sanitizeLabel`), and unbounded
 * *count*, which the writer's cap does not cover for a file this build did not
 * write.
 *
 * @param {SourceSnapshot[] | undefined} sources
 * @returns {RecentEntrypoint[]}
 * @ref LLP 0164#status-reads-it-from-the-status-file [implements]: hyp status answers from status.json, with no dataset registry and no cache read
 */
export function recentEntrypointsFromSources(sources) {
  const list = Array.isArray(sources) ? sources : []
  const source =
    list.find((s) => s && s.plugin === GATEWAY_PLUGIN_NAME) ??
    list.find((s) => s && s.name === 'ai-gateway')
  const rawDetails = source && typeof source.details === 'object' ? source.details : undefined
  if (!rawDetails) return []
  const raw = /** @type {Record<string, unknown>} */ (rawDetails).recent_entrypoints
  if (!Array.isArray(raw)) return []
  /** @type {RecentEntrypoint[]} */
  const out = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const entrypoint = sanitizeLabel(item.entrypoint)
    const lastSeen = item.last_seen
    if (entrypoint === undefined) continue
    if (typeof lastSeen !== 'string' || Number.isNaN(Date.parse(lastSeen))) continue
    out.push({
      entrypoint,
      clientName: sanitizeLabel(item.client_name) ?? null,
      lastSeen,
      rows: typeof item.rows === 'number' && Number.isFinite(item.rows) ? item.rows : 0,
    })
  }
  out.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0))
  // Sorted before the cap so the entries kept are the most recently seen ones,
  // which is the same entry a "recent clients" readout would keep anyway.
  return out.slice(0, MAX_RECENT_ENTRYPOINTS)
}

/**
 * Resolve the AI gateway's live bound base URL from the on-disk daemon status
 * snapshot, **guarded by a daemon-liveness check** so a stale snapshot from a
 * dead daemon is never handed back. Returns `undefined` when no daemon is
 * running for this state root, no status file exists, or the gateway source
 * recorded no bound port.
 *
 * This is the discovery mechanism manual `hyp attach` uses on a default
 * install: only the running daemon knows which port it actually bound (the
 * well-known default, its ephemeral fallback when that port was taken - LLP
 * 0114 - or a pre-0114 ephemeral bind), and the daemon persists it here
 * (issue #277 / LLP 0086). It never fabricates a port for a daemon that is
 * not running.
 *
 * @param {{ stateRoot: string }} args
 * @returns {string | undefined}
 * @ref LLP 0086#manual-attach-reads-the-live-port [implements]: resolve the live gateway URL from status.json, gated on a live pid
 */
export function resolveLiveGatewayEndpointFromStatus({ stateRoot }) {
  // Liveness gate first: a status.json outlives its daemon, so a bound port in
  // it proves nothing without a living process behind the pid file.
  let pidEntry
  try {
    pidEntry = readPidFile(stateRoot)
  } catch {
    return undefined
  }
  if (!pidEntry || !processIsAlive(pidEntry.pid)) return undefined

  /** @type {DaemonStatus | null} */
  let status
  try {
    status = readStatusFile(stateRoot)
  } catch {
    return undefined
  }
  const details = status ? gatewaySourceDetails(status.sources) : undefined
  if (!details) return undefined
  return endpointFromListen(`${details.host}:${details.port}`)
}

/* ---------- Phase 8: top-level status collector ---------- */

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

  // ----- config (LLP 0031: central ⊕ local) -----
  // The user-facing config path is the local layer; the central layer is
  // resolved read-only from config-control/ (active slot or join seed).
  // Reading it never fires a config poll. What's "running" is the merge.
  // @ref LLP 0031#status-provenance [implements]: Restore inspectability: provenance tags + dropped-local section over the merged config
  const configPath = env.HYP_CONFIG
    ? path.resolve(env.HYP_CONFIG)
    : defaultConfigPath(hypHome)
  const localLoaded = await loadConfigFile(configPath)
  const localConfig = localLoaded.ok ? localLoaded.config : null

  const centralConfigPath = resolveCentralLayerPath({ stateRoot })
  const centralLoaded = centralConfigPath ? await loadConfigFile(centralConfigPath) : null
  const centralConfig = centralLoaded?.ok ? centralLoaded.config : null
  const hasCentral = centralConfig !== null

  // Build the plugin catalog before the merge so the layer resolution
  // validates local additions against the same plugin set the daemon
  // runs. A local plugin that invalidates the merge (capability tie,
  // unknown plugin) is dropped here, not surfaced as a config error.
  const catalog = await buildStatusCatalog({ stateDir: stateRoot })

  // @ref LLP 0031#central-layer-is-sacrosanct [implements]: Same merge + validation pruning as boot, so status shows exactly what runs
  const merged = resolveLayeredConfig({
    central: centralConfig,
    local: localConfig,
    validate: (cfg) => collectConfigErrors(cfg, {
      ...(catalog ? { knownPlugins: catalog.pluginMetadata, knownDatasets: catalog.knownDatasets } : {}),
    }),
  })
  const config = (centralConfig || localConfig) ? merged.effective : null
  const centralPluginNames = new Set((centralConfig?.plugins ?? []).map((p) => p.name))
  const centralSinkNames = new Set(Object.keys(centralConfig?.sinks ?? {}))
  /** @type {HypAwareStatusReport['layered']} */
  const layered = hasCentral
    ? {
      hasCentral: true,
      centralPlugins: [...centralPluginNames],
      centralSinks: [...centralSinkNames],
      drops: merged.drops,
      centralQueryIgnored: merged.centralQueryIgnored,
    }
    : null

  // A local file that fails to load is only a hard problem when no
  // central layer is carrying the host; under layering the central layer
  // always boots, so a broken/absent local layer is a warning, never an
  // outage. `configExists` tracks whether *anything* is configured.
  const configExists = config !== null

  // A local layer that is present but does not parse: `activePlugins` is then
  // empty (or central-only) because the file could not be read, not because
  // the operator disabled anything. Any diagnostic whose repair is "your
  // config no longer names this" would be reading a parse failure as intent,
  // so the attached-but-not-configured check below stands down here and lets
  // `config_unreadable` / `config_local_unreadable` own the run.
  const localConfigUnreadable = !localLoaded.ok && localLoaded.errorKind !== 'config_missing'

  // Validate the *effective* (merged + pruned) config: that is what runs.
  // After pruning, any error left is the central layer's own (apply-time's
  // concern); a local entry that lost the merge shows in `layered.drops`,
  // not here, so it never degrades `overall`.
  /** @type {ConfigValidationError[]} */
  let validationErrors = []
  if (config && catalog) {
    try {
      const result = await validateConfig(config, {
        knownPlugins: catalog.pluginMetadata,
        knownDatasets: catalog.knownDatasets,
      })
      validationErrors = result.errors
    } catch (err) {
      validationErrors = [{
        pointer: '/',
        errorKind: 'config_section_invalid',
        message: `config validation threw: ${err instanceof Error ? err.message : String(err)}`,
      }]
    }
  }
  const configValid = config !== null && validationErrors.length === 0

  // ----- diagnostics -----
  /** @type {StatusDiagnostic[]} */
  const diagnostics = []

  if (config === null) {
    // Nothing configured at all: no central layer and no readable local.
    if (localLoaded.ok || localLoaded.errorKind === 'config_missing') {
      diagnostics.push({
        severity: 'warning',
        kind: 'config_missing',
        message: `no config found - neither a central layer nor ${configPath}`,
        repair: ['hyp init', 'hyp init --from-file <config.json>', 'hyp join <url> <token>'],
      })
    } else {
      diagnostics.push({
        severity: 'error',
        kind: 'config_unreadable',
        message: localLoaded.message,
        repair: ['hyp init --from-file <config.json>'],
      })
    }
  } else {
    // A broken local file with the central layer still carrying the host
    // is loud but not an outage. The central layer always boots.
    if (!localLoaded.ok && localLoaded.errorKind !== 'config_missing') {
      diagnostics.push({
        severity: 'warning',
        kind: 'config_local_unreadable',
        message: `local config layer is unreadable (${localLoaded.message}) - running on the central layer only`,
        repair: ['hyp init --from-file <config.json> --force'],
      })
    }
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
  const v1Diagnostics = diagnoseV1Config(config, {
    clientDescriptors: catalog?.clientDescriptors,
    knownPlugins: catalog?.pluginMetadata,
  })
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
  // didn't already report a live process. This covers foreground
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
      const started = opts.runtime?.sources?.started?.(contribution.name)
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

  // ----- recent client surfaces (LLP 0164) -----
  // Read from the status file specifically, never from `sources` above: the
  // daemon is the only process traffic flows through, so an in-process
  // gateway source booted by this very CLI call has by definition seen
  // nothing. It is deliberately NOT gated on daemon liveness the way
  // `resolveLiveGatewayEndpointFromStatus` is - a bound port is a claim
  // about now and goes stale the moment the daemon dies, whereas "last seen
  // at T" stays true afterwards, and the rendered age makes staleness
  // self-evident.
  // @ref LLP 0164#not-liveness-gated [implements]: a last-seen timestamp survives its daemon; the rendered age carries the staleness
  const recentEntrypoints = recentEntrypointsFromSources(daemonStatusFile?.sources)

  // Sinks are derived from the loaded config (so the count reflects
  // "how many sinks does the user have configured?", the same number
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
      const writer = 'writer' in raw && typeof raw.writer === 'string' ? raw.writer : undefined
      const destination = 'destination' in raw && typeof raw.destination === 'string' ? raw.destination : undefined
      const requestPlugin = 'plugin' in raw && typeof raw.plugin === 'string' ? raw.plugin : undefined
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
  // The live gateway port the running daemon bound to, read from its own
  // status snapshot. A client whose recorded attach port differs from this has
  // drifted (the daemon rebound its ephemeral port and nothing re-attached);
  // surface it so the data already on disk becomes an actionable signal
  // instead of silent capture loss (issue #277 / LLP 0086).
  const liveGateway = daemon.running ? gatewaySourceDetails(daemonStatusFile?.sources) : undefined
  const liveGatewayPort = liveGateway ? String(liveGateway.port) : undefined
  if (liveGateway?.listenFallback) {
    // The daemon is bound, but not where the fixed default promised: the
    // default port was taken at boot and the gateway fell back to an
    // ephemeral bind. Attach self-heals (LLP 0086), but out-of-band
    // consumers pointed at the well-known port are talking to whatever
    // holds it. Non-degrading: a fallback boot is a working install.
    // @ref LLP 0114#fallback-is-visible [implements]: hyp status warns when the gateway runs on its ephemeral fallback instead of the fixed default
    const from = liveGateway.listenFallbackFrom ?? 'its default listen address'
    diagnostics.push({
      severity: 'warning',
      kind: 'gateway_port_fallback',
      message: `the gateway's default listen ${from} was taken at boot - it fell back to an ephemeral bind on port ${liveGatewayPort}; anything pointed at the default port is talking to the process that holds it`,
      repair: [`free ${from} and restart the daemon - attached clients re-point automatically`],
    })
  }
  const idleGatewayUpstreams = daemon.running
    ? gatewayIdleWithConfiguredUpstreams(daemonStatusFile?.sources)
    : undefined
  if (idleGatewayUpstreams) {
    // The gateway bound nothing while the config listed upstreams it wanted
    // proxied: every one was dropped at compile, so there is no listener and
    // no error either. Before the source was allowed to idle this was a source
    // start failure and `hyp status` said `[failed]`; the same install must not
    // now read `[started]` / `healthy` with the reason living only in a log
    // line. Non-degrading like `gateway_port_fallback`: an install that
    // *wanted* no upstream (hermes-only) reports no configured upstreams here
    // and never reaches this branch, so it stays healthy and silent.
    // @ref LLP 0114#fallback-is-visible [implements]: an exception to "the gateway is listening" is readable from status.json steadily, not only from a boot-time log line
    const { count, names } = idleGatewayUpstreams
    // Count first, names in parentheses when there are any: `name` is itself
    // one of the two keys that drops an entry, so the config that most needs
    // this warning is exactly the one that can supply no name to print.
    const named = names.length > 0 ? ` (${names.join(', ')})` : ''
    diagnostics.push({
      severity: 'warning',
      kind: 'gateway_idle_no_upstreams',
      message: `the gateway is running but listening on nothing: ${count} ${count === 1 ? 'upstream' : 'upstreams'}${named} ${count === 1 ? 'is' : 'are'} configured but none compiled to a route (each needs both a 'name' and a 'base_url') - clients will get connection refused`,
      // Not `hyp config validate`: it prints `config ok` for this config and
      // exits 0. `@hypaware/ai-gateway` registers no config section, so
      // nothing validates upstream shape, and `diagnoseV1Config` matches an
      // upstream by its `provider` field, so a nameless anthropic entry
      // satisfies the one check that does look. A repair line that sends the
      // user to a command which affirms the broken config is worse than no
      // repair line, so point at the file and the two required keys instead.
      // @ref LLP 0139#repair-must-be-runnable [constrained-by]: a repair has to be a step that changes something, so the inert validate command gives way to the edit that fixes it
      repair: [
        `add the missing 'name' / 'base_url' to each upstream in ${configPath} ('hyp config validate' does not check upstream shape)`,
        `hyp daemon restart  # the daemon reads the file only at boot`,
      ],
    })
  }
  /** @type {ClientAttachReport[]} */
  const clients = []
  const clientDescriptors = catalog?.clientDescriptors ?? new Map()
  for (const [clientName, descriptor] of clientDescriptors) {
    const configured = activePlugins.includes(descriptor.plugin)
    const probe = descriptor.attachProbe
      ? await probeClientAttachFromDescriptor({ descriptor, homeDir, env })
      : { attached: false }
    clients.push({
      name: clientName,
      plugin: descriptor.plugin,
      configured,
      attached: probe.attached,
      ...(probe.settingsPath ? { settingsPath: probe.settingsPath } : {}),
      ...(probe.version !== undefined ? { version: probe.version } : {}),
      ...(probe.port !== undefined ? { port: probe.port } : {}),
      ...(probe.error !== undefined ? { error: probe.error } : {}),
    })
    if (configured && !probe.attached) {
      // The repair is `hyp attach` only for a client whose plugin registers a
      // runtime adapter the generic reconciler can drive. A client that
      // declares `contributes.client` for probe/status plumbing but no
      // adapter (claude-desktop: its plist is placed by an attended command
      // with its own sudo prompt and consent gate, never by attach-on-join)
      // has to name its own setup command instead, or the repair we print is
      // one that answers `unknown client`. The command comes from the same
      // plugin's picker row, which already declares it as `configure_command`.
      // @ref LLP 0139#repair-must-be-runnable [implements]: an adapterless client's attach-missing repair names its configure_command, not the inert generic attach
      const configureCommand = catalog?.pickerDescriptors.get(clientName)?.configureCommand
      const repair = configureCommand ? `hyp ${configureCommand}` : `hyp attach --client ${clientName}`
      diagnostics.push({
        severity: 'warning',
        kind: 'client_attach_missing',
        message: `'${descriptor.plugin}' is enabled but ${clientName} settings show no HypAware marker - run '${repair}'`,
        repair: [repair],
      })
    } else if (
      configured &&
      probe.attached &&
      liveGatewayPort !== undefined &&
      probe.port !== undefined &&
      probe.port !== liveGatewayPort
    ) {
      // Attached, but at a stale port: the daemon rebound and this client still
      // points at the old one. Non-degrading like `client_attach_missing` - a
      // healthy install can still drift after a restart (LLP 0041
      // §failure-is-surfaced-not-fatal); the data for the comparison is already
      // on disk (probe port vs live status.json port).
      // @ref LLP 0086#status-drift-diagnostic [implements]: hyp status warns on a client attach port that no longer matches the live gateway
      diagnostics.push({
        severity: 'warning',
        kind: 'client_attach_stale',
        message: `${clientName} is attached at port ${probe.port} but the gateway is now bound to port ${liveGatewayPort} - run 'hyp attach --client ${clientName}' to re-point it`,
        repair: [`hyp attach --client ${clientName}`],
      })
    } else if (!configured && probe.attached && !hasCentral && !localConfigUnreadable) {
      // The mirror image of `client_attach_missing`: the marker is on disk but
      // nothing enables the adapter, so this client still routes through a
      // gateway that no longer collects it (and, with no gateway configured at
      // all, through a dead port). Re-running the picker and unchecking a
      // previously picked client is the way in; the wizard warns at the time,
      // and this is the after-the-fact backstop for a run already closed.
      //
      // Solo hosts only. On a joined host a config-named client's attach is the
      // reconciler's to reverse, so the same shape there is a pass it has not
      // run yet, not a state the operator should undo by hand. And only when
      // the local layer actually parsed: an unreadable file says nothing about
      // what the operator enabled, so "not configured" would be a guess, and
      // detaching on a guess is the one irreversible thing here.
      // @ref LLP 0185#status-backstop [implements]: attached-but-not-configured is a warning on solo hosts, and the reconciler's business on managed ones
      diagnostics.push({
        severity: 'warning',
        kind: 'client_attached_not_configured',
        message: `${clientName} settings still point at the HypAware gateway but '${descriptor.plugin}' is not enabled - its requests are no longer collected and can fail; run 'hyp detach --client ${clientName}' to unhook it`,
        repair: [`hyp detach --client ${clientName}`],
      })
    }
  }

  // ----- client sync split (LLP 0188 #never-silent) -----
  // On an enrolled machine every configured source syncs by default; only
  // the machine-local opt-out store (LLP 0188 #opt-out) keeps one local.
  // That withholding must never be a silent state: split every configured
  // picker source (not just attach-probed clients - a hermes opt-out must
  // be visible too) into syncing vs local-only. A solo host (no central
  // layer) has nothing to withhold from, so the split is null there and
  // the V1 surface is unchanged. A corrupt opt-out store degrades to a
  // null split plus a warning diagnostic: status is best-effort, the
  // export seam is what enforces (and fails closed on the same file).
  // @ref LLP 0188#never-silent [implements]: hyp status shows the syncing vs local-only split, driven by the opt-out store
  /** @type {{ syncing: string[], localOnly: string[] } | null} */
  let clientSync = null
  if (hasCentral && catalog) {
    const layeredForProvenance = { centralConfig, effective: config }
    /** @type {Set<string> | null} */
    let optedOut = null
    try {
      optedOut = new Set(optedOutClientSourceIds(await readClientSyncEntries({ stateDir: stateRoot })))
    } catch (err) {
      if (!(err instanceof ClientSyncListUnreadableError)) throw err
      diagnostics.push({
        severity: 'warning',
        kind: 'client_sync_list_unreadable',
        message: `the machine-local client policy store at '${err.filePath}' is unreadable or malformed - exports fail until it is repaired or removed`,
        repair: ['inspect and fix or remove the file, then rerun hyp status'],
      })
    }
    if (optedOut !== null) {
      /** @type {string[]} */
      const syncing = []
      /** @type {string[]} */
      const localOnly = []
      for (const id of catalog.pickerDescriptors.keys()) {
        const provenance = classifyClientProvenance(id, layeredForProvenance, catalog)
        if (provenance === 'absent') continue
        // Central sources always sync; an opt-out entry for one is inert
        // (LLP 0188 #locked), so only a 'local'-provenance opt-out lands
        // in the local-only column.
        if (provenance === 'local' && optedOut.has(id)) localOnly.push(id)
        else syncing.push(id)
      }
      if (syncing.length > 0 || localOnly.length > 0) {
        clientSync = { syncing: syncing.sort(), localOnly: localOnly.sort() }
      }
    }
  }

  // ----- retention + cache stats -----
  const retention = readRetention(config)
  const cacheRoot = opts.runtime?.storage?.cacheRoot ?? path.join(stateRoot, 'cache')
  // Best-effort like every other probe here (see this function's docstring): a
  // transient fs error mid-walk (EACCES/EMFILE/EIO, walkForStats re-throws
  // anything but ENOENT) must degrade to zeroed cache stats, never throw out of
  // the whole report.
  /** @type {{ totalBytes: number, oldestDate: string | null }} */
  let cache = { totalBytes: 0, oldestDate: null }
  try {
    cache = await measureCacheStats(cacheRoot)
  } catch { /* best-effort cache probe */ }

  // ----- remote config apply state (LLP 0025) -----
  /** @type {ConfigControlStatus | null} */
  let remoteConfig = null
  try {
    remoteConfig = readConfigControlStatus({ stateRoot })
  } catch { /* best-effort probe */ }
  if (remoteConfig?.lastRollback) {
    diagnostics.push({
      severity: 'warning',
      kind: 'remote_config_rolled_back',
      message: `remote config ${remoteConfig.lastRollback.etag} rolled back at ${remoteConfig.lastRollback.at} (${remoteConfig.lastRollback.reason})`,
      repair: ['fix the central config revision; the gateway re-applies when the served etag changes'],
    })
  }

  // ----- client-action reconciler state (LLP 0036 / 0041) -----
  // Read-only marker view; `hyp status` never runs a reconcile pass. A
  // failed backfill is surfaced here (its own section, below) but is
  // deliberately NOT a degrading diagnostic. The gateway runs fine on a
  // valid config (LLP 0041 §failure-is-surfaced-not-fatal).
  // @ref LLP 0041#failure-is-surfaced-not-fatal [implements]: Surface client-action failure as its own line, never an outage signal
  /** @type {ClientActionsReport | null} */
  let clientActions = null
  try {
    const actionStatus = readClientActionStatus({ stateRoot })
    // The catalog's client descriptors (claude/codex) are the honest static
    // proxy for both declared-target derivations: status cannot see the runtime
    // backfill/attach registries without activating plugins, so "this enabled
    // plugin is a client adapter" is read off the descriptors. backfill keys its
    // markers by owning-plugin name, attach by client name (the handlers'
    // request keys), buildClientActionsReport derives both from the one map.
    clientActions = buildClientActionsReport({ status: actionStatus, config, hasCentral, clientDescriptors })
  } catch { /* best-effort probe */ }

  // ----- local-only directory withholding (LLP 0069 R9 / LLP 0071) -----
  // Best-effort, read-only probe of the machine-local exclusion list: never
  // blocks `hyp status`. A corrupt list is the same uninterpretable-privacy-
  // signal case the export seam treats as fail-safe (LLP 0080 #fail-safe), so
  // it surfaces as a loud diagnostic and a null count rather than a silent 0
  // ("enrolled but withholding" must never be a silent state, R9).
  // @ref LLP 0069#requirements [implements]: R9 - hyp status surfaces the local-only list's presence and size
  // The standing new-folder ask (LLP 0200) rides in the same section: a
  // machine that stopped asking has a consent prompt switched off, which is
  // exactly the kind of state R9 says must never be silent. The safe reader
  // never throws and reads a corrupt preference as `ask`, the mode that is
  // actually in force when the hook cannot read it either.
  // @ref LLP 0200#cli [implements]: hyp status names a suppressed folder ask alongside the withholding counts
  const folderAsk = await readFolderAskModeSafe({ stateDir: stateRoot })

  /** @type {{ localOnlyDirCount: number, folderAsk: FolderAskMode } | null} */
  let usagePolicy = null
  try {
    const localOnlyDirs = await readLocalOnlyDirs({ stateDir: stateRoot })
    usagePolicy = { localOnlyDirCount: localOnlyDirs.length, folderAsk }
  } catch (err) {
    const filePath = err instanceof LocalOnlyListUnreadableError
      ? err.filePath
      : localOnlyListPath(stateRoot)
    diagnostics.push({
      severity: 'error',
      kind: 'local_only_list_unreadable',
      message: `local-only exclusion list at '${filePath}' is unreadable or malformed - directory withholding count is unknown`,
      repair: ['inspect and fix or remove the file, then rerun hyp status'],
    })
  }

  // ----- first-sync export hold (LLP 0101 / LLP 0100 R9) -----
  // A live hold pauses every sink tick driver-wide (LLP 0101 #hold): a held
  // machine must never be a silent state, so the pending deadline is
  // surfaced whenever one is live. `readFirstSyncDeadline` never throws and
  // already reads an absent/expired/corrupt marker as null (fail-open), so
  // this probe needs no diagnostic of its own - null here just means "no
  // hold", the same as the driver's own check sees it.
  // @ref LLP 0100#requirements [implements]: R9 - hyp status shows the pending first-sync deadline while the hold is live
  const firstSyncHoldDeadline = await readFirstSyncDeadline({ stateDir: stateRoot })

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
  // "set up" should degrade overall: config errors, v1 inconsistencies,
  // and the "no config at all yet" case. `client_attach_missing` /
  // `recent_errors` stay informational so a perfectly-configured-but-
  // not-yet-attached install can still report healthy. A failed
  // client-action (e.g. backfill-on-join) is likewise excluded. It has
  // its own status line but never flips `overall` (LLP 0041
  // §failure-is-surfaced-not-fatal); note it is not even a diagnostic, so
  // it cannot reach this computation.
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
    layered,
    daemon,
    sources,
    sinks,
    clients,
    clientSync,
    retention,
    cache,
    recentErrorCount,
    diagnostics,
    overall,
    remoteConfig,
    clientActions,
    usagePolicy,
    firstSyncHoldDeadline,
    recentEntrypoints,
  }
}

/**
 * Build the client-action reconciler section for `hyp status` from the
 * persisted marker store and the effective config. Pure: it reads markers
 * and config and never runs a reconcile pass (LLP 0041, the status surface
 * "reads the marker file, it never runs a pass"). Returns null when nothing
 * applies so the V1 status surface is unchanged on an ordinary host.
 *
 * Per-provider state:
 * - `done` / `failed` come straight from a persisted marker (any request
 *   key, even one whose plugin has since left the config).
 * - `pending` / `n/a` are derived for *declared* targets the reconciler would
 *   act on but has not yet. Two handlers declare such targets:
 *   - **backfill** (LLP 0037): a plugin entry's `config.backfill` block,
 *     keyed by owning-plugin name.
 *   - **attach** (LLP 0044 / 0045), an enabled client adapter, keyed by
 *     *client* name (the attach handler's request key), opted out by
 *     `config.attach.on_join: false`.
 *   Neither capability is visible to the status collector without activating
 *   plugins (both are runtime registrations, LLP 0041 §per-plugin-capability),
 *   so the catalog's client descriptors are the honest, provider-agnostic
 *   proxy: `on_join: false` or a non-joined host → `n/a` (the reconciler is a
 *   no-op); otherwise desired-but-unrun → `pending`.
 *
 * @param {{ status: ClientActionStatus, config: HypAwareV2Config | null, hasCentral: boolean, clientDescriptors?: Map<string, ClientDescriptor> }} args
 * @returns {ClientActionsReport | null}
 * @ref LLP 0041#idempotency-and-completion-state [implements]: Per-provider done/failed/pending/n-a derived from the per-handler/per-request-key marker store, no reconcile pass
 */
function buildClientActionsReport({ status, config, hasCentral, clientDescriptors }) {
  /** @type {ClientActionReport[]} */
  const actions = []
  const byKind = status?.byKind ?? {}
  // Client-adapter plugins (claude/codex), derived statically from the catalog
  // descriptors: the set the backfill default-on derivation needs ("this
  // enabled plugin imports on join") and, via the descriptors themselves, the
  // universe of attach targets below.
  const clientAdapterPlugins = new Set(
    [...(clientDescriptors?.values() ?? [])].map((d) => d.plugin)
  )

  // Declared backfill targets: enabled plugin entries that drive
  // backfill-on-join (LLP 0037, policy rides the owning plugin). Keyed by
  // owning-plugin name (the backfill handler's request key, LLP 0041). Two cases:
  //   1. An explicit `config.backfill` block (any host).
  //   2. *Default-on*: a known backfill provider with no explicit block. On
  //      a joined host `backfillHandler.desired()` still emits for it, so it
  //      is a real (pending) target. Status mirrors that here; without this
  //      the default-on case was invisible. It is gated on `hasCentral` so a
  //      non-joined host (where the reconciler never runs) keeps its
  //      V1-unchanged surface. A bare `claude`/`codex` install shows nothing.
  /** @type {Map<string, { onJoin: boolean }>} */
  const declared = new Map()
  for (const entry of config?.plugins ?? []) {
    if (entry.enabled === false) continue
    const raw = entry.config?.backfill
    const hasBlock = !!raw && typeof raw === 'object' && !Array.isArray(raw)
    if (hasBlock) {
      // Use the shared tri-state read so status can never disagree with the
      // reconciler about what a block means: a malformed `on_join` (e.g. the
      // string "false") is an opt-out, not default-on. `onJoin: undefined`
      // (block present, `on_join` absent) is default-on → not suppressed.
      const onJoin = readBackfillPolicy(entry).onJoin !== false
      declared.set(entry.name, { onJoin })
    } else if (hasCentral && clientAdapterPlugins.has(entry.name)) {
      declared.set(entry.name, { onJoin: true })
    }
  }

  // Declared attach targets (LLP 0044 / 0045): symmetric to backfill, but keyed
  // by *client* name, the attach handler's request key is the client name
  // (`descriptor.name`), not the owning plugin, so a `done` attach marker the
  // handler writes merges with the declared target instead of doubling it. Every
  // enabled client adapter on a joined host is a desired attach target by
  // default; an explicit `config.attach` block opts out via `on_join: false`,
  // read through the shared `readAttachPolicy` (the `backfill_policy.js` twin) so
  // status can never disagree with `action_attach.js` about what a block means.
  // The default-on case is gated on `hasCentral` for the same V1-surface reason
  // as backfill: a bare local claude/codex install shows nothing.
  // @ref LLP 0044#status-surface [implements]: per-client done/failed/pending/n-a; `on_join:false` or non-joined → n/a, never degrading
  /** @type {Map<string, PluginConfigInstance>} */
  const enabledByPlugin = new Map()
  for (const entry of config?.plugins ?? []) {
    if (entry.enabled === false) continue
    enabledByPlugin.set(entry.name, entry)
  }
  /** @type {Map<string, { onJoin: boolean }>} */
  const declaredAttach = new Map()
  for (const [clientName, descriptor] of clientDescriptors ?? new Map()) {
    const entry = enabledByPlugin.get(descriptor.plugin)
    if (!entry) continue
    const raw = entry.config?.attach
    const hasBlock = !!raw && typeof raw === 'object' && !Array.isArray(raw)
    if (hasBlock) {
      const onJoin = readAttachPolicy(entry).onJoin !== false
      declaredAttach.set(clientName, { onJoin })
    } else if (hasCentral) {
      declaredAttach.set(clientName, { onJoin: true })
    }
  }

  // Kinds to render: every kind the markers record, plus a kind for each
  // handler that declared a target (so a configured-but-unrun target shows even
  // with no marker yet). `backfill` keys by plugin, `attach` by client name.
  /** @type {Record<string, Map<string, { onJoin: boolean }>>} */
  const declaredByKind = { backfill: declared, attach: declaredAttach }
  /** @type {Set<string>} */
  const kinds = new Set(Object.keys(byKind))
  for (const [k, m] of Object.entries(declaredByKind)) {
    if (m.size > 0) kinds.add(k)
  }

  for (const kind of [...kinds].sort()) {
    const markers = byKind[kind] ?? {}
    const declaredForKind = declaredByKind[kind]
    /** @type {Set<string>} */
    const keys = new Set(Object.keys(markers))
    if (declaredForKind) for (const name of declaredForKind.keys()) keys.add(name)
    for (const requestKey of [...keys].sort()) {
      const marker = markers[requestKey]
      if (marker && marker.status === 'failed') {
        actions.push({
          kind,
          requestKey,
          state: 'failed',
          ...(typeof marker.reason === 'string' ? { reason: marker.reason } : {}),
          ...(typeof marker.last_attempt === 'string' ? { lastAttempt: marker.last_attempt } : {}),
          ...(typeof marker.attempts === 'number' ? { attempts: marker.attempts } : {}),
        })
      } else if (marker && marker.status === 'refused') {
        // @ref LLP 0186#hyp-status-attention-needed-surface [implements]: terminal refused marker, reason+at, no attempts
        actions.push({
          kind,
          requestKey,
          state: 'refused',
          ...(typeof marker.reason === 'string' ? { reason: marker.reason } : {}),
          ...(typeof marker.at === 'string' ? { at: marker.at } : {}),
        })
      } else if (marker) {
        // `done` (run-once / attached) or `applied` (reversible): the effect
        // is in place. For attach a `done` marker is the "attached" rendering.
        actions.push({
          kind,
          requestKey,
          state: 'done',
          ...(typeof marker.rows === 'number' ? { rows: marker.rows } : {}),
          ...(typeof marker.at === 'string' ? { at: marker.at } : {}),
        })
      } else {
        // No marker: a declared backfill or attach target. Suppressed
        // (on_join:false) or inert (host never joined → the reconciler is a
        // no-op) → n/a; otherwise desired and simply not run yet → pending.
        const decl = declaredForKind?.get(requestKey)
        const suppressed = decl ? !decl.onJoin : false
        const state = suppressed || !hasCentral ? 'n/a' : 'pending'
        actions.push({ kind, requestKey, state })
      }
    }
  }

  return actions.length > 0 ? { actions } : null
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
  /** @type {Dirent[]} */
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
  return { days: DEFAULT_RETENTION_DAYS, source: 'default' }
}

/**
 * Probe on-disk client settings using the descriptor's attach_probe
 * definition. Supports JSON (marker key lookup) and TOML (header string
 * search) formats. Returns a probe result without importing any client
 * plugin code.
 *
 * A manifest whose `settings_file` breaks the home-relative contract
 * resolves to no path at all, so the probe reports `error` rather than the
 * plain `attached: false` it uses for a genuinely unmarked file. Reading
 * "not attached" off a path the manifest never named is the one answer a
 * probe must never give: it looks identical to a correct negative.
 *
 * @ref LLP 0045#settings_file-is-home-relative-and-a-violation-is-loud [implements]: an unresolvable settings_file is an error result, not a silent not-attached
 * @param {{ descriptor: ClientDescriptor, homeDir: string, env?: NodeJS.ProcessEnv }} args
 * @returns {Promise<{ attached: boolean, settingsPath?: string, version?: string, port?: string, error?: string }>}
 */
export async function probeClientAttachFromDescriptor({ descriptor, homeDir, env }) {
  if (!homeDir || !descriptor.attachProbe) return { attached: false }
  const probe = descriptor.attachProbe
  /** @type {string} */
  let settingsPath
  try {
    settingsPath = resolveClientSettingsPath(descriptor.name, probe.settings_file, env, homeDir)
  } catch (err) {
    return { attached: false, error: err instanceof Error ? err.message : String(err) }
  }

  try {
    const raw = await fsp.readFile(settingsPath, 'utf8')

    if (probe.format === 'json' && probe.marker_key) {
      /** @type {unknown} */
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') {
        return { attached: false, settingsPath }
      }
      const marker = /** @type {Record<string, unknown>} */ (parsed)[probe.marker_key]
      if (!marker || typeof marker !== 'object') return { attached: false, settingsPath }
      const markerObj = /** @type {Record<string, unknown>} */ (marker)
      return {
        attached: true,
        settingsPath,
        version: typeof markerObj.version === 'string' ? markerObj.version : undefined,
        port: typeof markerObj.port === 'number' ? String(markerObj.port) : undefined,
      }
    }

    if (probe.format === 'toml' && probe.marker_header) {
      return { attached: raw.includes(probe.marker_header), settingsPath }
    }

    // @ref LLP 0172#lane-a-detach [implements]: the json_path read branch removed by
    // LLP 0143 / PR #510, restored parallel to the json/toml branches above; pure
    // read, attached when any configured provider key's marker header matches.
    if (probe.format === 'json_path' && probe.container_path && probe.provider_keys && probe.marker_header) {
      /** @type {unknown} */
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') {
        return { attached: false, settingsPath }
      }
      const container = getAtDottedPath(parsed, probe.container_path)
      if (!isPlainObject(container)) return { attached: false, settingsPath }
      const markerHeader = probe.marker_header
      const attached = probe.provider_keys.some((key) => {
        const entry = container[key]
        if (!isPlainObject(entry) || !isPlainObject(entry.headers)) return false
        return entry.headers[markerHeader] === key
      })
      return { attached, settingsPath }
    }

    return { attached: false, settingsPath }
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
 * Build the plugin catalog the status surfaces read from: bundled ⊕ installed.
 * Best-effort, exactly as the top-level collector was: each discovery failure
 * degrades to empty and any residual throw degrades the whole thing to
 * `undefined`, so a probe can always render a report rather than crash.
 *
 * @param {{ stateDir: string }} args
 * @returns {Promise<PluginCatalog | undefined>}
 */
async function buildStatusCatalog({ stateDir }) {
  try {
    /** @type {LoadedManifest[]} */
    let bundledLoaded = []
    /** @type {LoadedManifest[]} */
    let installedLoaded = []
    try {
      const bundled = await discoverBundledPlugins()
      bundledLoaded = [...bundled.loaded, ...bundled.excluded]
    } catch { /* bundled discovery failure is non-fatal */ }
    try {
      const installed = await discoverInstalledPlugins({ stateDir })
      installedLoaded = installed.loaded
    } catch { /* installed discovery failure is non-fatal */ }
    return buildPluginCatalog(bundledLoaded, installedLoaded)
  } catch {
    return undefined
  }
}

/**
 * Load just the client descriptors (claude/codex attach probes) from the plugin
 * catalog: the poll-invariant subset the login attach-wait needs. Best-effort
 * like the collector: discovery failure degrades to an empty map, never throws.
 *
 * @param {{ stateDir: string }} args
 * @returns {Promise<Map<string, ClientDescriptor>>}
 */
export async function loadClientDescriptors({ stateDir }) {
  const catalog = await buildStatusCatalog({ stateDir })
  return catalog?.clientDescriptors ?? new Map()
}

/**
 * The marker-only slice of `collectHypAwareStatus`: which of the given client
 * descriptors show a HypAware attach marker on disk right now. Does only
 * per-client settings reads via `probeClientAttachFromDescriptor`, which maps
 * ENOENT *and* any other fs error to "not attached", so it never walks the
 * cache and never re-throws the way the full collector's `walkForStats` can.
 * That is exactly what makes it safe to poll on a tight loop (the login
 * attach-wait) without either the collector's cost or its throw path.
 *
 * @param {{ descriptors: Map<string, ClientDescriptor>, homeDir: string, env?: NodeJS.ProcessEnv }} args
 * @returns {Promise<string[]>} attached client names (unsorted; the caller orders them)
 */
export async function probeAttachedClients({ descriptors, homeDir, env }) {
  /** @type {string[]} */
  const attached = []
  for (const [clientName, descriptor] of descriptors) {
    if (!descriptor.attachProbe) continue
    const probe = await probeClientAttachFromDescriptor({ descriptor, homeDir, env })
    if (probe.attached) attached.push(clientName)
  }
  return attached
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
 * acceptable. The renderer just shows the diagnostic without a
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


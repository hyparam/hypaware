// @ts-check

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { configRecordsPickAnswer, defaultConfigPath, loadConfigFile } from '../config/schema.js'
import { readConfigControlStatus, resolveCentralLayerPath } from '../config/apply.js'
import { readClientActionStatus } from '../config/action_reconciler.js'
import { isEntryRecording } from '../config/client_recording.js'
import {
  isOtlpHeadersOverride,
  otlpOverrideSignal,
  perSignalOtlpOverrides,
} from '../config/otlp_precedence.js'
import { resolveLayeredConfig } from '../config/merge.js'
import { readObservabilityEnv } from '../observability/env.js'
import { collectConfigErrors, diagnoseV1Config, validateConfig } from '../config/validate.js'
import { unloadableInstalledPlugins } from '../runtime/installed.js'
import { detectShadowedPlugins } from '../runtime/boot.js'
import { centralLayerUnreadable } from '../remote/gateway_seed.js'
import { pluginLockPath } from '../plugin_install/paths.js'
import { sinkInstanceName } from '../registry/sinks.js'
import { cacheRootOf, daemonLogPath, processingStateRoot } from '../runtime/paths.js'
import { classifyClientProvenance } from '../cli/wizard/provenance.js'
import { describeSelfUpdate } from '../update/self_update.js'
import { clientAssetStateRoot, readClientAssetLedger } from '../runtime/client_asset_ledger.js'
import { sanitizeLabel } from '../util/json_util.js'
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
import { isCaTrusted as probeCaTrusted } from '../tls/darwin_trust.js'
import {
  BOOT_FAILED_WARNING_PREFIX,
  MAX_ACTIVATION_MESSAGE_CHARS,
  REQUIRES_UNSATISFIED_ERROR_KIND,
  SINK_MATERIALIZE_FAILED_WARNING_PREFIX,
  requiredPluginFromMessage,
  warningsRecordBootFailure,
} from './boot_failure.js'
import { isLaunchdEnvSet as probeLaunchdEnvSet } from './launchd_env.js'
import {
  isLaunchAgentInstalled,
  launchAgentStatus,
} from './macos.js'
import {
  isSystemdUnitInstalled,
  systemdUnitStatus,
} from './linux.js'
import {
  processIsAlive,
  readPidFile,
} from './pid.js'
import {
  readStatusFile,
  DAEMON_HEARTBEAT_STALE_MS,
  daemonHeartbeatAgeMs,
  systemBootTimeMs,
  placeStopAgainstBoot,
} from './status/file.js'
import {
  GATEWAY_PLUGIN_NAME,
  gatewaySourceDetails,
  printableUpstreamNames,
  gatewayDroppedUpstreams,
  droppedUpstreamConsequence,
  recentEntrypointsFromSources,
} from './status/gateway.js'
import { describeMaintenanceSkipReasons, maintenanceSkipsFromStatus } from './status/maintenance.js'
import { readSourceIdentity, sourceDetails, inferConfiguredSources } from './status/sources.js'
import {
  attachWritesNoMarker,
  isClientAttachable,
  ollamaCaptureFromSnapshot,
  probeClientAttachFromDescriptor,
  discoverStatusManifests,
  catalogFromManifests,
} from './status/clients.js'
import { probeClientActivityFromDescriptor, confirmClientActivityFromDescriptor } from './status/client_activity.js'
import { describeAssetCoverage, buildClientActionsReport } from './status/client_actions.js'
import { assessCaptureHealth, formatGapDuration, captureBaselineMs } from './status/capture_health.js'
import { TRUST_PROBE_TIMEOUT_MS, collectProxyTrust } from './status/proxy_trust.js'
import { collectCacheFlushFailures, newestCachedClientRowAt, measureCacheStats, readRetention } from './status/cache.js'
import { RECENT_ERROR_WINDOW_HOURS, countRecentErrors } from './status/recent_errors.js'
import { heldDatasetDiagnostics, serviceTokenDiagnostics, collectGateways } from './status/sinks.js'
import {
  requiresUnsatisfiedConfigRepair,
  pluginRepairsByPointer,
  repairForConfigError,
} from './status/config_repair.js'

/**
 * @import { ConfigControlStatus, ConfigValidationError } from '../../../src/core/config/types.js'
 * @import { CacheFlushFailureReport, CaptureHealthReport, ClientActionsReport, ClientAttachReport, CollectStatusOptions, DaemonStatus, HypAwareStatusReport, ServiceState, SinkSnapshot, SourceSnapshot, StatusDiagnostic } from '../../../src/core/daemon/types.js'
 * @import { FolderAskMode } from '../../../src/core/usage-policy/types.js'
 */

// The helpers behind `collectHypAwareStatus` live in `./status/`, one module
// per concern. Callers keep importing them from here.
export {
  writeStatusFile,
  readStatusFile,
  resolveLiveGatewayEndpointFromStatus,
  resolveLiveSourceListenPortFromStatus,
  resolveLiveControlRouteEndpointsFromStatus,
  DAEMON_HEARTBEAT_STALE_MS,
  daemonHeartbeatAgeMs,
  systemBootTimeMs,
  placeStopAgainstBoot,
} from './status/file.js'
export { gatewaySourceDetails, recentEntrypointsFromSources } from './status/gateway.js'
export {
  MAX_SKIPPED_PARTITIONS_REPORTED,
  describeMaintenanceSkipReasons,
  summarizeMaintenanceSkips,
  maintenanceSkipsFromStatus,
} from './status/maintenance.js'
export { sourceHealth, readSourceIdentity } from './status/sources.js'
export {
  isClientAttachable,
  ollamaCaptureFromSnapshot,
  probeClientAttachFromDescriptor,
  loadClientDescriptors,
  probeAttachedClients,
} from './status/clients.js'
export { probeClientActivityFromDescriptor, confirmClientActivityFromDescriptor } from './status/client_activity.js'
export { describeAssetCoverage } from './status/client_actions.js'
export {
  CAPTURE_GAP_WARNING_MS,
  CAPTURE_GAP_ERROR_MS,
  assessCaptureHealth,
  formatGapDuration,
} from './status/capture_health.js'
export { RECENT_ERROR_WINDOW_HOURS, RECENT_ERROR_WINDOW_MS } from './status/recent_errors.js'

/**
 * The plugin the enrollment seed names. `hyp join` and the enrolling
 * `hyp remote login` write `plugins: [{ name: '@hypaware/central' }]` plus the
 * central sink so the machine can reach its server; it records no capture
 * choice, so a central layer naming only it has answered nothing. Only the
 * catalog-less fallback in `collectHypAwareStatus` reads it: with a catalog the
 * test is the positive one (does the layer name a capture plugin?), which
 * excludes this and every other non-capture plugin.
 */
const CENTRAL_ENROLLMENT_PLUGIN = '@hypaware/central'

/**
 * How much of a recorded boot failure `daemon_boot_failed` quotes. Room for a
 * bind error and the port-owner clause the gateway appends to it (#137).
 */
const MAX_BOOT_FAILURE_CHARS = 300

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
  const homeDir = opts.homeDir ?? env.HOME ?? process.env.HOME ?? os.homedir()

  // ----- config (LLP 0031: central ⊕ local) -----
  // The user-facing config path is the local layer; the central layer is
  // resolved read-only from the managed-config files (active slot or join seed).
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
  const manifests = await discoverStatusManifests({ stateDir: stateRoot })
  const catalog = catalogFromManifests(manifests)
  // Installed plugins a bundled name shadows: boot activates the bundled
  // copy and skips these, so they are idle code in the lock. Read off the
  // same discovery pass, by the same rule boot applies.
  const shadowedInstalled = detectShadowedPlugins({
    discovered: manifests.bundled,
    installed: manifests.installed,
  })
  // The second question the catalog cannot answer: which config entries name a
  // plugin this machine has installed but whose manifest the kernel rejected.
  // They are absent from the catalog exactly as a typo is, and only this tells
  // the validator which of the two it is looking at (issue #1936).
  const unloadableInstalled = unloadableInstalledPlugins(manifests.installed)
  const unloadablePlugins = new Set(unloadableInstalled.keys())

  // @ref LLP 0031#central-layer-is-sacrosanct [implements]: Same merge + validation pruning as boot, so status shows exactly what runs
  const merged = resolveLayeredConfig({
    central: centralConfig,
    local: localConfig,
    validate: (cfg) => collectConfigErrors(cfg, {
      ...(catalog ? { knownPlugins: catalog.pluginMetadata, knownDatasets: catalog.knownDatasets } : {}),
      unloadablePlugins,
    }),
  })
  const config = (centralConfig || localConfig) ? merged.effective : null
  const centralPluginNames = new Set((centralConfig?.plugins ?? []).map((p) => p.name))
  // A second fact about the same names, not a filter over them:
  // `mergeConfigLayers` drops a colliding local entry by name whatever its
  // enablement, so narrowing `centralPluginNames` would make status disagree
  // with the merge it reports.
  const centralDisabledPluginNames = new Set(
    (centralConfig?.plugins ?? []).filter((p) => p.enabled === false).map((p) => p.name)
  )
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

  // The stronger claim behind `configExists`: does anything on this machine
  // record an *answer* to onboarding's pick question, or does the config merely
  // exist because a writer that never asked one created it (`hyp remote add`
  // and the enrolling `hyp remote login` before the first `hyp init`, the
  // documented team order)?
  //
  // Each layer is read on its own terms, not off the merge. The local layer
  // answers when it records a pick answer at all, the same discriminator the
  // pick lane reads, so the two lanes cannot classify one file two ways. The
  // central layer answers when it carries capture of its own: a machine whose
  // fleet configured its sources is set up, the fleet having answered on its
  // behalf (LLP 0129 #join-before-picker).
  //
  // "Carries capture" is a plugin-level test against the picker catalog - does
  // the central layer name a plugin that contributes a picker row? - which is
  // the same test `computeCentralLockedSources` uses to decide which rows the
  // org owns, so the locked set and this claim cannot disagree. Naming a sink
  // or format plugin is not an answer to the pick question: it configures where
  // rows go, not whether any are recorded. Neither is `@hypaware/central` on
  // its own - it is the enrollment seed `hyp remote login` and `hyp join`
  // write to reach the server at all, and it is on disk before anyone has been
  // asked anything. Without a catalog the question cannot be asked at all, so
  // that case falls back to the weaker plugin-name reading, which keeps a
  // managed machine on the returning path: re-opening onboarding's consent
  // questions is the direction that costs the user something (LLP 0183).
  //
  // The merged config cannot express either half: it hides the enrollment seed
  // among the plugins, and it drops a local `plugins: []` whenever the merged
  // list comes out empty (`mergeConfigLayers` only sets the key when it is
  // non-empty), turning a deliberate record-nothing pick back into "no answer".
  // @ref LLP 0281#returning-gate [implements]: the report carries the answer-keyed claim the returning gate needs, not only file existence
  const capturePluginNames = catalog
    ? new Set([...catalog.pickerDescriptors.values()].map((d) => d.plugin))
    : null
  const centralAnswersPick = [...centralPluginNames].some((name) => (
    capturePluginNames ? capturePluginNames.has(name) : name !== CENTRAL_ENROLLMENT_PLUGIN
  ))
  const configRecordsAnswer =
    (localConfig !== null && configRecordsPickAnswer(localConfig)) || centralAnswersPick

  // A local layer that is present but does not parse: `activePlugins` is then
  // empty (or central-only) because the file could not be read, not because
  // the operator disabled anything. Any diagnostic whose repair is "your
  // config no longer names this" would be reading a parse failure as intent,
  // so the attached-but-not-configured check below stands down here and lets
  // `config_unreadable` / `config_local_unreadable` own the run.
  const localConfigUnreadable = !localLoaded.ok && localLoaded.errorKind !== 'config_missing'

  // Whether the central layer can be read at all, widest definition: every
  // load failure counts, `config_missing` included, and a null `centralLoaded`
  // is re-checked against the control directory instead of read as an
  // absence. See `centralLayerUnreadable`'s own doc for why. Like a local
  // parse failure, none of these is the operator removing anything, so the
  // export-withhold gate below reads every one of them as uncertainty (#2432).
  const centralUnreadable = centralLayerUnreadable({ stateDir: stateRoot, centralLoaded })

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
        unloadablePlugins,
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
        message: centralUnreadable === null
          ? `no config found - neither a central layer nor ${configPath}`
          : `no config found - ${configPath}`,
        repair: ['hyp setup', 'hyp setup --from-file <config.json>', 'hyp join <url> <token>'],
      })
    } else {
      diagnostics.push({
        severity: 'error',
        kind: 'config_unreadable',
        message: localLoaded.message,
        repair: ['hyp setup --from-file <config.json>'],
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
        repair: ['hyp setup --from-file <config.json> --force'],
      })
    }
    // A per-entry repair wins over the by-kind one where the entry has
    // something the kind cannot know - the install directory of a plugin whose
    // manifest would not load.
    const pluginRepairs = pluginRepairsByPointer(config, unloadableInstalled)
    for (const err of validationErrors) {
      diagnostics.push({
        severity: 'error',
        kind: 'config_invalid',
        message: `[${err.errorKind}] ${err.pointer || '<root>'}: ${err.message}`,
        repair: pluginRepairs.get(err.pointer) ?? repairForConfigError(err.errorKind),
        pointer: err.pointer,
      })
    }
  }

  // The same fact for the other layer, and why it needs a line of its own:
  // `centralConfig` is null both for a layer that is absent and for one that
  // is there and will not parse, so without this the report asserts
  // `layered: null` - no central layer at all - and nothing names the file
  // (issue #2423). An unreadable layer is not an absent one - the same
  // distinction LLP 0226 #unreadable-is-not-absent draws for a client asset -
  // and `hyp remote login` is what writes this very layer, so a host that
  // cannot read it has a layer all the same. `centralLayerUnreadable` covers
  // every way that can happen, not only a file that fails to parse: an
  // active-slot pointer naming a slot file that is gone, an active pointer
  // replaced by something other than a symlink, or a control directory this
  // process cannot even list.
  //
  // A warning on the local layer's precedent: the host runs on whichever layer
  // did load, so this is loud without being an outage signal, and staying out
  // of `degradingKinds` leaves `overall` as it was. Whether an unreadable org
  // layer *should* degrade the verdict is a separate question.
  //
  // `hyp remote login` is deliberately not a repair: its D4 gate reads the
  // same `centralLayerUnreadable` predicate and refuses while the layer is
  // unreadable, so it would be advice that cannot run on the one host that
  // sees this line. `hyp leave` can run here on purpose (#623), which is why
  // it leads the re-enrollment route, and the permission line covers the
  // control directory this process could not list, where `hyp join`'s own
  // seed write would fail too.
  if (centralUnreadable) {
    diagnostics.push({
      severity: 'warning',
      kind: 'config_central_unreadable',
      message: `central config layer ${centralUnreadable.configPath} is unreadable (${centralUnreadable.message}) - its team config is not in this report, and a running daemon may still be on the config it last applied`,
      repair: [
        'hyp join <url> <token>',
        'hyp leave, then hyp remote login',
        'check the ownership and permissions of the hypaware/state directory',
      ],
    })
  }

  // An installed plugin in a bundled name is code that never runs: boot
  // activates the bundled copy and warns once in the daemon log. This is the
  // surface that names it and the one command that clears it, and it is a
  // warning, never an outage: the machine is running the right code.
  // @ref LLP 0380#surfaced-not-fatal [implements]: the shadow is a repairable warning on `hyp status`, not a boot failure
  for (const name of shadowedInstalled) {
    diagnostics.push({
      severity: 'warning',
      kind: 'installed_plugin_shadowed',
      message: `installed plugin ${name} is shadowed by the bundled copy of the same name; the installed code never runs`,
      repair: [`hyp plugin remove ${name}`],
    })
  }

  // A lock entry the loader cannot use at all: hand-edited to drop its
  // `install_dir`, or no longer an object. Boot skips it, so this is the only
  // surface that can name it (issue #1958). Read off the lock like the shadow
  // above, so it holds with no daemon running, and an error rather than a
  // warning for the reason the sibling manifest diagnostic is one: whatever
  // that entry installed is capturing nothing. The lock path rides in the
  // message because the repair cannot reach a non-object entry, which `hyp
  // plugin remove` reads as not installed; for the reported shape (an object
  // missing `install_dir`) `removePlugin` falls back to the conventional
  // install directory and clears the row.
  // The repair names the row by line, never by key: the key is
  // hand-edited text, and a repair line is one an operator may paste, so no
  // byte of it belongs there. The sanitized label stays in the message, where
  // it identifies the row but is not offered as a command (issue #2115).
  const { malformed, malformedLines } = manifests.installed
  for (const name of malformed) {
    const label = sanitizeLabel(name, MAX_ACTIVATION_MESSAGE_CHARS) ?? '<unnamed>'
    const lockPath = pluginLockPath(stateRoot)
    const line = malformedLines.get(name)
    const row = line === undefined ? 'that entry' : `the entry on line ${line}`
    diagnostics.push({
      severity: 'error',
      kind: 'plugin_lock_entry_invalid',
      message: `plugin-lock.json entry '${label}' has no usable install_dir, so nothing it installed is running: ${lockPath}`,
      repair: [`open ${lockPath} and remove ${row}, or pass its exact key as one quoted argument to hyp plugin remove`],
    })
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
    daemon.processes = daemonStatusFile.processes
  }

  // ----- is the process that owns the pid still running its loop? -----
  // Everything above proves the daemon started and still owns its pid. None
  // of it proves the event loop can serve: a daemon wedged behind a stalled
  // sink export still holds its bound listeners, and the kernel completes
  // handshakes out of the accept backlog, so the gateway and the OTEL
  // listener answer the connect and then never write a byte (issue #1003).
  // The status file is the tell, because the tick that writes it is the same
  // loop that would have served those requests: it stops advancing at exactly
  // the moment the daemon stops working, while still saying `healthy`.
  //
  // Only ever asked of a live process. A snapshot left by a daemon that
  // exited ages forever and is a record, not a claim about now.
  // @ref LLP 0348#stale-heartbeat-is-unresponsive [implements]: a live pid with a frozen heartbeat is degraded, not healthy
  //
  // Asked only when the snapshot is this process's own. `daemon.running` is
  // `processIsAlive(pid)`, which proves a pid is taken, not that the daemon
  // took it: after a hard kill the OS is free to hand that number to an
  // unrelated process, and without this the leftover pair would be read as
  // that stranger's frozen heartbeat and raise an `error` on a machine
  // running no daemon at all. It also covers the restart window, where
  // launchd already reports the new pid and the file is still the old
  // daemon's.
  const snapshotIsThisProcess =
    typeof daemonStatusFile?.pid !== 'number' || daemonStatusFile.pid === daemon.pid
  // Is the snapshot a live daemon's own, and so readable in the present tense
  // at all? Every reader below that makes a claim about *now* is gated on it.
  const snapshotIsLive = daemon.running && snapshotIsThisProcess
  const heartbeatAgeMs = snapshotIsLive
    ? daemonHeartbeatAgeMs(daemonStatusFile, Date.now())
    : null
  if (heartbeatAgeMs !== null && heartbeatAgeMs > DAEMON_HEARTBEAT_STALE_MS) {
    // The reported state is this collector's verdict, not a transcription of
    // the file: reporting `healthy` here is the defect.
    daemon.state = 'degraded'
    diagnostics.push({
      severity: 'error',
      kind: 'daemon_heartbeat_stale',
      message: `the daemon process is alive but has not updated its status snapshot for ${formatGapDuration(heartbeatAgeMs)} - its tick has not completed in that time, so its bound listeners may accept connections without answering them`,
      repair: ['hyp daemon restart'],
    })
  }

  // A unit or plist on disk proves only that the installer got as far as
  // writing it: it is written before the service-manager calls that load and
  // start the daemon, so a failed `daemon-reload` leaves exactly this state
  // behind (issue #1387). When the probe answered and no process is running
  // either, the machine is capturing nothing, which degrades `overall` through
  // the severity rule the same way a wedged daemon does (LLP 0348).
  if (daemon.installed && !daemon.loaded) {
    const manager = platform === 'darwin' ? 'launchd' : 'systemd'
    const artifact = platform === 'darwin' ? 'HypAware LaunchAgent' : 'HypAware user unit'
    // `daemon.loaded` is only ever assigned inside the probe's `try` above, and
    // a probe that threw is folded into `daemon.error` there, so `!daemon.loaded`
    // means "not loaded, or could not be asked". Only a probe that answered can
    // support the claim below, and a live process alongside an unloaded unit is
    // capturing anyway: both of those keep the note this has always been.
    //
    // A stop the operator asked for lands on these same facts on macOS, and
    // only there: `hyp daemon stop` boots the LaunchAgent out, because
    // launchd's KeepAlive respawns a job that is merely killed, and the plist
    // stays on disk. `systemctl --user stop` leaves its unit loaded, so Linux
    // reaches the still-loaded block below instead. What tells a deliberate
    // stop from a load that failed is the signal that block already uses: the
    // daemon's own last snapshot. `shutdown()` persists `state: 'stopped'` as
    // its final write whatever asked for the stop, and a process that died
    // cannot. Read as a record of how the run ended, not as a claim about now.
    //
    // 0383 settled that signal for the shape where the probe reports the unit
    // *loaded*, which is the block below. Reusing it here, where the probe
    // reports the opposite, is an extension of it rather than an application:
    // it is the borrowed signal, but a wider claim: every clean shutdown writes
    // `stopped`, a reboot's included, so a LaunchAgent that fails to load at
    // the next login sits on a `stopped` snapshot too (#2267). The stop is
    // therefore only read as the operator's when it happened during this
    // boot; one from before it, or one that cannot be placed against it, is
    // the failed load this block exists to raise.
    // @ref LLP 0383#the-signal-is-the-daemons-last-state [constrained-by]: the crash-versus-stopped signal this borrows, settled there for the loaded shape
    // @ref LLP 0300#posix-keeps-signals [implements]: the stop that creates this shape on macOS, bounded by the current boot
    // Platform-gated, because the shape is only ambiguous on one of them.
    // On Linux a stop never lands here at all, so a snapshot that ends in a
    // stop is no evidence about *this* pair of facts and reading it as such
    // would mask the failed load (#1387) the block exists for.
    const stopPlacement = platform === 'darwin' && daemon.state === 'stopped'
      ? placeStopAgainstBoot(daemonStatusFile?.stoppedAt, opts.bootTimeMs ?? systemBootTimeMs)
      : undefined
    const stoppedOnPurpose = stopPlacement === 'this_boot'
    const capturingNothing = daemon.error === undefined && !daemon.running && !stoppedOnPurpose
    // Why a recorded stop was not read as the operator's, in plain words,
    // with the repair: the generic message alone would leave a reader who
    // remembers stopping the daemon wondering why it now says outage.
    const staleStop = !capturingNothing ? ''
      : stopPlacement === 'before_boot'
        ? `. The daemon's last stop came before this boot, so the ${artifact} did not load at login; reinstall it so ${manager} loads it again`
        : stopPlacement === 'unknown'
          ? `. The daemon's last stop could not be dated against this boot, so it is not read as a stop you asked for; reinstall the ${artifact} so ${manager} loads it again`
          : ''
    diagnostics.push({
      severity: capturingNothing ? 'error' : 'warning',
      kind: 'daemon_loaded_no_pid',
      // The message states what was observed, not why: the same pair of facts
      // is left by a failed `daemon-reload`, by a manual `launchctl bootout`,
      // and by a unit file an older version left behind, and naming one of
      // those is a wrong diagnosis rather than an unknown one.
      message: capturingNothing
        ? `${manager} is not loading the ${artifact} and no daemon process is running`
          + ' - nothing is being captured' + staleStop
        : `${manager} is not currently loading the ${artifact}`,
      // `hyp daemon restart` cannot repair a unit the service manager never
      // loaded: it sees the file on disk, calls straight through to
      // `systemctl --user restart` / `launchctl kickstart`, and exits 1. Only a
      // re-install runs the load step that is missing, which is why
      // `daemon_binary_missing` already points there.
      // A service the operator stopped needs neither: `hyp daemon start`
      // bootstraps the preserved plist back in and kickstarts it, which is
      // the one step missing and the exact reverse of what stopped it.
      repair: [capturingNothing ? 'hyp daemon install' : stoppedOnPurpose ? 'hyp daemon start' : 'hyp daemon restart'],
    })
  }

  // The complement of the block above, and the state the live facts alone
  // cannot read: the service manager still holds the unit and nothing runs
  // under it. `loaded` is a bootstrap fact on both platforms, independent of
  // active/inactive, and a stop the operator asked for lands on exactly these
  // three facts too (issue #1391) - by `systemctl --user stop`, which leaves
  // its unit loaded, or by the control file for a daemon with no service
  // behind it. (macOS is the exception in both directions: `hyp daemon stop`
  // boots the LaunchAgent out, so a macOS stop lands in the block above, and
  // this one is left describing a fault.)
  //
  // What tells them apart is the daemon's own last snapshot: `shutdown()`
  // persists `state: 'stopped'` as its final write whatever asked for the
  // stop, and a process that died cannot. Read as a record of how the run
  // ended, not as a claim about now - the live facts above supply "now".
  //
  // Named forwards, not as `!== 'stopped'`: no snapshot at all, one from an
  // older build, or one whose `state` a hostile file replaced with anything at
  // all is not evidence of a crash. Only the states a *serving* daemon writes
  // are. `stopping` is not one of them and is read below on its own terms.
  // `daemon.state` is the file's own here, because the heartbeat verdict above
  // only ever overwrites it for a live process.
  // @ref LLP 0383#the-signal-is-the-daemons-last-state [implements]: the crash-versus-stopped signal is the snapshot's terminal state, not a service-manager exit code
  const exitedWhileServing = daemon.state === 'starting'
    || daemon.state === 'healthy'
    || daemon.state === 'degraded'
  // The one ending the snapshot names outright, and the one `degraded` alone
  // gets wrong: a boot that threw never reached service and was owed no
  // shutdown, so "exited without shutting down" describes a shape it never
  // had. `runDaemon` persists `degraded` with the boot-failure warning before
  // it clears the pid and rethrows, read here through the same predicate
  // `previousBootLooksStuck` (`src/core/update/self_update.js`) applies to that
  // snapshot.
  // A `degraded` without that warning is a daemon that served with a failed
  // source, which the message below already describes.
  const bootFailed = daemon.state === 'degraded'
    && warningsRecordBootFailure(daemonStatusFile?.warnings)

  // `stopping` is the other ending, and only time reads it. `shutdown()` writes
  // it as its first statement, so it marks a stop that started, and a process
  // killed anywhere across shutdown freezes the snapshot there for good. A stop
  // still under way is spent with the process alive, and a stop that reached
  // its end wrote `stopped` before the process left - the probe above runs
  // before the file is read, so a dead process is always read beside the last
  // file that stop wrote. What stays silent here is the one non-failing way to
  // reach the pair, a supervised restart's forced exit (LLP 0365
  // #restart-exit-is-bounded), whose snapshot is minutes fresher than this
  // window while the service manager relaunches. The snapshot's age separates
  // the two, on the window and the last-write derivation the heartbeat check
  // above already uses. An age that cannot be derived stays silent, as an
  // unrecognised `state` does.
  // @ref LLP 0384#stopping-is-a-claim-with-an-expiry [implements]: a terminal `stopping` snapshot older than the heartbeat window is a stop that never finished
  const stoppingAgeMs = daemon.state === 'stopping'
    ? daemonHeartbeatAgeMs(daemonStatusFile, Date.now())
    : null
  const stalledStop = stoppingAgeMs !== null && stoppingAgeMs > DAEMON_HEARTBEAT_STALE_MS
    ? `recorded 'stopping' ${formatGapDuration(stoppingAgeMs)} ago - the stop began but never completed`
    : null
  if (daemon.installed && daemon.loaded && !daemon.running && (exitedWhileServing || stalledStop)) {
    const artifact = platform === 'darwin' ? 'LaunchAgent' : 'user unit'
    const recordedBootFailure = bootFailed
      ? 'recorded a failed boot - the daemon never finished starting'
      : null
    // `starting` is the same never-served ending with no record of why (issue
    // #1418): a boot that threw, an OOM kill and a `kill -9` mid-boot all
    // leave it, so this says where the run stopped and names no cause.
    const recordedNeverServed = daemon.state === 'starting'
      ? "recorded 'starting' and never recorded reaching service - the daemon exited before it finished starting"
      : null
    const recordedWhileServing = `recorded '${daemon.state}' rather than a completed stop`
      + ' - the daemon exited without shutting down'
    diagnostics.push({
      severity: 'error',
      kind: 'daemon_exited_abnormally',
      // States the observations, not a cause: the same pair is left by an OOM
      // kill, a fault, and a `kill -9`, and naming one of those is a wrong
      // diagnosis rather than an unknown one.
      message: `the ${artifact} is still loaded but no daemon process is running,`
        + ` and the last status snapshot ${stalledStop ?? recordedBootFailure ?? recordedNeverServed ?? recordedWhileServing},`
        + ' and nothing is being captured',
      // Unlike the unloaded case above, the service manager is holding the
      // unit, so the restart path reaches it.
      repair: ['hyp daemon restart'],
    })
  }

  // The live half of the same record: a supervised daemon whose boot found its
  // port taken holds its failed process for a retry interval before exiting
  // into the relaunch (#137), so the probe reports a running pid while the
  // snapshot, its own, still says the boot failed. Nothing is listening and
  // nothing ticks, so it must not read as a serving daemon.
  // @ref LLP 0521#status [implements]: a live process whose own snapshot records a failed boot is named, with the reason
  if (snapshotIsLive && bootFailed) {
    const recorded = (daemonStatusFile?.warnings ?? [])
      .find(w => typeof w === 'string' && w.startsWith(`${BOOT_FAILED_WARNING_PREFIX}:`))
    const reason = sanitizeLabel(recorded?.slice(BOOT_FAILED_WARNING_PREFIX.length + 1).trim(), MAX_BOOT_FAILURE_CHARS)
    diagnostics.push({
      severity: 'error',
      kind: 'daemon_boot_failed',
      message: `the daemon process is running but its last boot failed, and nothing is being captured`
        + (reason ? `: ${reason}` : '')
        + (reason && /EADDRINUSE/.test(reason) ? ' - it retries about once a minute while the port stays taken' : ''),
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
    // The `started()` probe and the row it labels have to be asking about the
    // same source, so both come from one guarded read (issue #1535). A
    // contribution that cannot be read back to its registered name is left off
    // the list rather than listed under a name that is not its own.
    let unregistered = 0
    for (const contribution of runtimeSources) {
      const identity = readSourceIdentity(opts.runtime?.sources, contribution)
      if (!identity.registered) {
        unregistered += 1
        continue
      }
      const started = opts.runtime?.sources?.started?.(identity.name)
      sources.push({
        name: identity.name,
        plugin: identity.plugin,
        state: started ? 'started' : 'stopped',
      })
    }
    if (unregistered > 0) {
      diagnostics.push({
        severity: 'warning',
        kind: 'source_name_unregistered',
        message: unregistered === 1
          ? 'a registered source could not be read back to the name it registered under and is left off this list'
          : `${unregistered} registered sources could not be read back to the names they registered under and are left off this list`,
        repair: ['hyp plugin list'],
      })
    }
  } else if (daemonStatusFile && Array.isArray(daemonStatusFile.sources) && daemonStatusFile.sources.length > 0) {
    // `status.json` outlives the process that wrote it, so with nothing
    // running a transcribed `started` is a present-tense claim on a machine
    // capturing nothing (issue #1410), under a daemon line that already reads
    // `not running`. The identity outlives the process and is worth listing;
    // the liveness claim does not, and `stopped` is what a source whose daemon
    // is gone is. `failed` is left as written: it records why the last run
    // went wrong, carries its `error` beside it, and claims nothing about now.
    //
    // The liveness the rewrite reads is `daemon.running && snapshotIsThisProcess`,
    // not `daemon.running` alone, for the reason spelled out where that pair is
    // derived above: `processIsAlive` proves a pid is taken, not that the daemon
    // took it, so a hard kill whose pid the OS reissued would otherwise let the
    // dead run's `started` through on exactly the machine this is about.
    //
    // The branch is entered on `Array.isArray`, not on a truthy `.length`,
    // because `readStatusFile` validates only "is an object": a `sources` of
    // `"abcd"` arrives here with `length` 4 and no `.map`
    // (LLP 0164#status-reads-it-from-the-status-file). That is the guard
    // `recentEntrypointsFromSources` and `liveStatusSources` already use, and a
    // file carrying no readable list falls through to the inference below, the
    // same as a file carrying none at all. An entry that is not an object is
    // dropped rather than carried through, for the reason `entryList` in
    // `commands/daemon.js` drops one: every reader past this point
    // dereferences `.name`, so a `null` in the list takes the whole report out
    // at the render rather than here.
    // @ref LLP 0348#stale-heartbeat-is-unresponsive [implements]: a snapshot left by an exited daemon is a record, not a claim about now
    sources.push(...daemonStatusFile.sources
      .filter((s) => !!s && typeof s === 'object')
      .map((s) => (
        snapshotIsLive || s.state !== 'started'
          ? s
          : /** @type {SourceSnapshot} */ ({ ...s, state: 'stopped' })
      )))
  } else {
    sources.push(...inferConfiguredSources(activePlugins))
  }

  // ----- plugins the running daemon could not activate (issues #1556, #1580) -----
  // `activePlugins` above is the configured set: the right answer to what this
  // machine is set up to do, the only answer available with no daemon running,
  // and no answer at all to whether a plugin is running. The daemon is the only
  // process that knows that, so it comes from the snapshot, whose entries are
  // validated the way every borrowed list here is: the file is only known to
  // hold an object (LLP 0164#status-reads-it-from-the-status-file).
  // @ref LLP 0383#a-record-not-a-claim [constrained-by]: an `error` diagnostic is present tense, so it is raised off a live daemon's snapshot only
  /** @type {string[]} */
  const failedPlugins = []
  const reportedFailures = snapshotIsLive && Array.isArray(daemonStatusFile?.failedPlugins)
    ? daemonStatusFile.failedPlugins
    : []
  // Where the untruncated reason is. Both files, because either process can be
  // the one that could not activate the plugin, and the entry does not say
  // which. Same two paths `recent_errors` counts (LLP 0349), derived the same
  // way, so the pointer cannot drift from the store it points at.
  const activationLogGrep = reportedFailures.length === 0 ? ''
    : `grep -s plugin_activate_failed ${daemonLogPath(stateRoot)} `
      + `${daemonLogPath(processingStateRoot(stateRoot))}`
  // The daemon's *own* sink rows, not the `sinks` list this collector builds
  // further down: that one starts from `config.sinks`, where a request
  // instance names its plugin whether or not anything came of it, so it would
  // report a sink running for a plugin that failed in both processes. A row
  // here is a handle the child materialized, and `materializeRequest` builds
  // one only for a plugin with a live activation context that registered the
  // contribution. Same shape guard as every other borrowed list here
  // (LLP 0164#status-reads-it-from-the-status-file).
  const liveSinks = reportedFailures.length === 0 || !Array.isArray(daemonStatusFile?.sinks)
    ? []
    : daemonStatusFile.sinks.filter((s) => !!s && typeof s === 'object')
  for (const entry of reportedFailures) {
    const name = sanitizeLabel(entry?.name)
    if (name === undefined) continue
    failedPlugins.push(name)
    // An error, so it degrades `overall` through the existing severity rule.
    // The daemon is up and the rest of the install works, but a plugin the
    // operator configured is capturing nothing, and a machine that silently
    // stopped capturing is the outage this surface exists to name.
    // What is left of the plugin, read off the same snapshot the failure came
    // from rather than asserted. A routing contributor activates in *both*
    // daemon processes, and in the gateway it gets a storage proxy that throws
    // on every cache call, so one that reads storage in `activate()` fails
    // there and comes up in the processing daemon: its source is `started` in
    // this very report while the entry says it never activated. "Nothing of it
    // is running" is a claim this collector can check, so it checks it - for
    // sinks as well as sources, because the same split state materializes a
    // configured request-sink instance in the child (issue #1571).
    //
    // Commands are not in the sentence at all. A `DaemonStatus` has no field
    // for them, so there is nothing to read; and asserting them anyway is not
    // merely unchecked but wrong, since commands are dispatched from the CLI's
    // own boot, where a plugin that only the gateway's storage proxy defeats
    // activates normally. This very process can run the command in the same
    // breath as calling it stopped.
    const stillContributing = sources.some((s) => s.plugin === name && s.state === 'started')
      || liveSinks.some((s) => s.plugin === name)
    // What is left of the plugin, never why it is gone, so both doors below
    // share it verbatim.
    const runningTail = stillContributing
      ? ' - it came up in only one of the daemon\'s two processes, so part of what it contributes is not running'
      : ' - none of its sources or sinks are running'
    const reason = sanitizeLabel(entry.message, MAX_ACTIVATION_MESSAGE_CHARS) ?? 'no message recorded'
    if (entry.errorKind === REQUIRES_UNSATISFIED_ERROR_KIND) {
      // A throw's severity, for the operator's reason rather than the author's:
      // the plugin they configured is capturing nothing either way, and `error`
      // is the only severity that moves `overall` off `healthy` - reporting
      // this install healthy being the whole defect (issue #1580). A kind of its
      // own because nothing else carries over: this plugin never ran a line of
      // its own code, so "failed to activate" would be a false sentence and
      // `hyp daemon restart` a repair that changes nothing while the config
      // still asks for a set the resolver cannot satisfy.
      diagnostics.push({
        severity: 'error',
        kind: 'plugin_requires_unsatisfied',
        message: `plugin '${name}' did not activate - the dependency resolver eliminated it (${reason})` + runningTail,
        // The reason is the resolver's own and names what is missing, so the
        // repair is the config edit that supplies it or withdraws the request.
        // Only a restart re-resolves: the daemon reads `requires` at boot.
        //
        // Which layer can make either edit is the whole question, because the
        // merge drops a local `plugins[]` entry whose name collides with a
        // central one - whichever of the two names it is. Withdrawing the
        // request edits the eliminated plugin's entry, so "remove '<name>'"
        // is inert for a central-owned plugin (issue #1598); supplying the
        // dependency edits the *dependency's* entry, so "enable what the
        // reason names" is inert when that name is the central-owned one
        // (issue #1826). A dependency named differently from the eliminated
        // plugin cannot collide with *its* entry, which says nothing about a
        // central entry of the dependency's own name.
        repair: [
          requiresUnsatisfiedConfigRepair({
            plugin: name,
            dependency: requiredPluginFromMessage(reason),
            centralPluginNames,
            centralDisabledPluginNames,
            configPath,
          }),
          'hyp daemon restart  # requires are resolved at boot',
        ],
      })
      continue
    }
    diagnostics.push({
      severity: 'error',
      kind: 'plugin_activate_failed',
      message: `plugin '${name}' failed to activate `
        + `(${sanitizeLabel(entry.errorKind) ?? 'activate_failed'}): `
        + reason
        + runningTail,
      // Not `hyp plugin list`, which since issue #1570 does name a plugin that
      // came up short - but for its own CLI boot: `ctx.failedPlugins` is that
      // process's `unavailablePlugins`, while this diagnostic is raised only
      // off a live daemon's snapshot. The two part company where it costs
      // most: the daemon boots under launchd/systemd with its own
      // environment, so a plugin that fails only there activates normally in
      // this process, and the listing would print it active while this line
      // says it failed. (A plugin the gateway's storage proxy defeats would
      // diverge the same way, if one called a withheld method at activate.)
      // That is consistent with `runPluginList` closing its own section by
      // sending the operator back here rather than the reverse. What the
      // listing supplies that this message does not is the version and which
      // copy boot selected; what it never supplies is the reason, the thing
      // the operator is missing. That reason is clamped to a sentence here
      // and the commonest real one is a module-resolution error longer than
      // that, so the first repair is the record that kept it whole. A
      // listing would in any case be a read that changes nothing
      // (LLP 0139#repair-must-be-runnable, as generalised by LLP 0195).
      repair: [activationLogGrep, 'hyp daemon restart'],
    })
  }

  // ----- configured sinks the running daemon could not materialize (issue #2547) -----
  // The daemon degrades its boot on these, but a sink with no handle has no
  // row in the snapshot, so the warning it persisted is the only record.
  // @ref LLP 0383#a-record-not-a-claim [constrained-by]: an `error` diagnostic is present tense, so it is raised off a live daemon's snapshot only
  const sinkMaterializePrefix = `${SINK_MATERIALIZE_FAILED_WARNING_PREFIX}: `
  // Also the first repair of the probation and recent-errors hints below.
  const sinkMaterializeLogGrep = `grep -s sink_materialize_failed ${daemonLogPath(processingStateRoot(stateRoot))} ${daemonLogPath(stateRoot)}`
  const sinkMaterializeFailures = snapshotIsLive && Array.isArray(daemonStatusFile?.warnings)
    ? daemonStatusFile.warnings.filter((w) => typeof w === 'string' && w.startsWith(sinkMaterializePrefix))
    : []
  for (const warning of sinkMaterializeFailures) {
    // The writer bounds each part; this bound is for a file it did not write.
    const detail = sanitizeLabel(warning.slice(sinkMaterializePrefix.length), 512)
    diagnostics.push({
      severity: 'error',
      kind: 'sink_materialize_failed',
      message: `${detail ?? 'a configured sink did not materialize'} - nothing is exported to it`,
      // A restart alone reproduces the same error; it only helps once the
      // cause is fixed, because sinks are materialized at boot.
      repair: [
        sinkMaterializeLogGrep,
        'hyp daemon restart  # after fixing the cause; sinks are materialized at boot',
      ],
    })
  }

  // ----- plugin directories whose manifest would not load (issue #1576) -----
  // The third door into `unavailablePlugins`, and the one no surface could
  // name: a manifest that is corrupt, unparseable, or fails schema validation
  // leaves a directory that contributes nothing and has no plugin name, so the
  // block above cannot carry it (its `name` is a plugin name and every reader
  // treats it as one) and `hyp plugin list` deliberately will not invent one
  // (issue #1570). Read off the snapshot on the same terms as every borrowed
  // list here: only a live daemon's own file, and only entries that are
  // objects (LLP 0164#status-reads-it-from-the-status-file).
  // @ref LLP 0383#a-record-not-a-claim [constrained-by]: an `error` diagnostic is present tense, so it is raised off a live daemon's snapshot only
  const unloadableManifests = snapshotIsLive && Array.isArray(daemonStatusFile?.unloadableManifests)
    ? daemonStatusFile.unloadableManifests.filter((entry) => !!entry && typeof entry === 'object')
    : []
  // One log file, not the pair `activationLogGrep` names: only the gateway
  // process records this door, because the manifest walk runs before any
  // plugin is selected and so sees the same set in both processes.
  const manifestLogGrep = unloadableManifests.length === 0 ? ''
    : `grep -s plugin_manifest_unloadable ${daemonLogPath(stateRoot)}`
  for (const entry of unloadableManifests) {
    const rootDir = sanitizeLabel(entry.rootDir, MAX_ACTIVATION_MESSAGE_CHARS)
    if (rootDir === undefined) continue
    const reason = sanitizeLabel(entry.message, MAX_ACTIVATION_MESSAGE_CHARS) ?? 'no message recorded'
    // An error, for the same reason the sibling above is one: whatever was in
    // that directory is capturing nothing, and a machine that silently stopped
    // capturing is the outage this surface exists to name.
    //
    // No "what is left of it" tail, unlike the sibling: that one has to read
    // the claim back because a plugin can activate in one of the daemon's two
    // processes and fail in the other. Here the kernel never got as far as a
    // plugin in either process, so nothing from this directory can be running.
    diagnostics.push({
      severity: 'error',
      kind: 'plugin_manifest_unloadable',
      // The directory, never a name, and said as a directory: a manifest that
      // did not parse has no plugin name, and there is no honest way to guess
      // one from a path.
      message: `plugin directory '${rootDir}' has no loadable manifest, so nothing in it is running: ${reason}`,
      // The reason is clamped to a sentence above, so the first repair is the
      // record that kept it whole - the same shape the activation diagnostic
      // uses, and for the same reason (LLP 0139#repair-must-be-runnable). A
      // restart is second because manifests are read once, at boot.
      repair: [manifestLogGrep, 'hyp daemon restart  # manifests are read at boot'],
    })
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

  // ----- partitions maintenance left fragmented (LLP 0228) -----
  // Same route and the same reason as the block above: the daemon runs the
  // hourly walk, and `hyp status` reads no cache, so answering this any other
  // way would mean firing a second maintenance walk from a status command.
  const maintenance = maintenanceSkipsFromStatus(daemonStatusFile)
  // A recorded failed attempt is tested directly rather than inferred from
  // the difference between the counts: the snapshot's floor makes the
  // difference agree, but the gate must not depend on that, or narrowing the
  // floor would silently suppress a real failure.
  // @ref LLP 0454#warning-policy [implements]: ineffective rewrites alone are verbose detail, not actionable failures
  if (maintenance && (maintenance.reasons.compaction_attempt_failed > 0 ||
    maintenance.skippedTotal > maintenance.reasons.compaction_ineffective)) {
    const one = maintenance.skippedTotal === 1
    const breakdown = describeMaintenanceSkipReasons(maintenance.reasons)
    // Warning, never an error: the daemon is running, capture works, and
    // queries answer. A frozen partition costs disk and query time, so it is
    // a thing to know about rather than an outage, which is why it sits with
    // `recent_errors` outside the set that degrades `overall` below.
    diagnostics.push({
      severity: 'warning',
      kind: 'maintenance_partitions_skipped',
      message: `cache maintenance is leaving ${maintenance.skippedTotal} partition${one ? '' : 's'} fragmented (${breakdown}), as of its tick at ${maintenance.tickAt}`,
      repair: [
        'hyp query maintain --dry-run',
      ],
    })
  }

  // Sinks are derived from the loaded config (so the count reflects
  // "how many sinks does the user have configured?", the same number
  // a fresh kernel boot or a running daemon would surface). When
  // matching runtime handles exist on the kernel, layer in the live
  // instance metadata (plugin / kind) so the report does not lose
  // detail on a running install.
  /** @type {Map<string, { plugin: string, kind: string }>} */
  const handleByInstance = new Map()
  // Cleared by the status-file fallback below, the one branch whose rows no
  // config entry and no live handle backs - but only when an empty
  // configured sink set is the operator's own removal. An unreadable local
  // or central config (`localConfigUnreadable`, `centralUnreadable`) and
  // a `sinks` entry the central layer merge dropped (`merged.drops`, reason
  // `invalid_merge`) also leave `config.sinks` empty without the operator
  // having removed anything, so none of these is read as intent here; reading
  // any of them as intent would silently drop a live export-failure warning
  // instead of fixing the over-warning issue #2361 set out to fix. A
  // merge-dropped entry only speaks for the destination it names, so it is
  // matched by key against the recovered rows below rather than treated as
  // a global flag; an unreadable layer speaks for all of them, since nothing
  // is known about which instances it named.
  const sinkKeysDroppedByMerge = new Set(merged.drops.filter((d) => d.section === 'sinks').map((d) => d.key))
  let sinksAreConfigured = true
  if (opts.runtime?.sinks) {
    // The registry's key, not the handle's own `instanceName`: nothing on
    // this path catches, so an owner's accessor on the name took `hyp status`
    // down whole (issue #1976). `plugin` and `kind` below are the same kind
    // of live property, still read off the handle, so that outage is narrowed
    // here and not yet closed (issue #2059).
    for (const handle of opts.runtime.sinks.listHandles()) {
      handleByInstance.set(sinkInstanceName(handle), { plugin: handle.plugin, kind: handle.kind })
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
    // Ungated, unlike the sources fallback above, because a `SinkSnapshot`
    // carries no liveness word: instance, plugin and kind are the shape of the
    // install, and `lastTickAt` / `lastSuccessAt` are last-seen facts that stay
    // true after their daemon exits (LLP 0164#not-liveness-gated). Dropping
    // them with nothing running would print `(none - keeping captured data
    // local only)` on a machine that does have a sink.
    //
    // Ungated for liveness is not ungated for shape: `readStatusFile` knows
    // only that it read an object, so a `sinks` of `5` throws out of the
    // collector at the spread and a `sinks` of `"ab"` spreads into one blank
    // row per character. Same guard as the sources list above.
    //
    // Shape is not configuration either: deleting the whole `sinks` key is the
    // one removal that lands here instead of the config branch, so reading
    // these rows as configured asks an operator to repair a destination they
    // deleted (issue #2361). But an unreadable local or central config, or a
    // merge-dropped `sinks` entry, land here too without being a removal, so
    // only clear the gate when none of those explains the empty `config.sinks`.
    // The merge-drop half is scoped to the recovered rows it actually names:
    // a dropped entry speaks only for the destination it named, not for every
    // row this fallback recovers, so only a recovered instance whose key was
    // dropped re-arms the gate. The unreadable-layer checks stay unscoped,
    // since an unreadable layer leaves no record of which instances it named.
    const recovered = (Array.isArray(daemonStatusFile.sinks) ? daemonStatusFile.sinks : [])
      .filter((s) => !!s && typeof s === 'object')
    sinksAreConfigured = localConfigUnreadable || !!centralUnreadable
      || recovered.some((s) => sinkKeysDroppedByMerge.has(s.instance))
    sinks.push(...recovered)
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
  const droppedGatewayUpstreams = daemon.running
    ? gatewayDroppedUpstreams(daemonStatusFile?.sources)
    : undefined
  if (droppedGatewayUpstreams) {
    // The config named upstreams the gateway is not proxying, because
    // `compileUpstreams` dropped them one by one and said nothing. Neither
    // half of that produces an error: the total loss idles the source (before
    // it was allowed to idle, this was a start failure and `hyp status` said
    // `[failed]`), and the partial loss binds a listener that looks entirely
    // healthy. Either way the reason must not live only in a boot log line.
    //
    // Non-degrading like `gateway_port_fallback`. An install that *wanted* no
    // upstream (hermes-only) drops nothing and never reaches this branch, so
    // it stays healthy and silent.
    // @ref LLP 0114#fallback-is-visible [implements]: an exception to "the gateway proxies what the config asked for" is readable from status.json steadily, not only from a boot-time log line
    // @ref LLP 0195#visible-when-unintended [implements]: one configured-vs-compiled comparison covers both the total loss and the partial one
    // @ref LLP 0195#consequences [constrained-by]: the warning stays loud in diagnostics and does not flip overall's health verdict
    const { idle, configured, dropped, names, attribution } = droppedGatewayUpstreams
    // Counts first, names in parentheses when there are any: `name` is itself
    // one of the two keys that drops an entry, so the config that most needs
    // this warning is exactly the one that can supply no name to print.
    //
    // The parenthetical stays only on the idle branch, where every configured
    // entry is also a dropped one, so hanging the names off "are configured"
    // states a fact. On the bound branch the two sets differ, and the same
    // placement reads "1 of its 2 configured upstreams (openai)" as if openai
    // were the configured set; there the names move to the consequence they
    // actually belong to.
    //
    // The names are the file's, so they are cleaned and capped on the way into
    // the line, and whatever `printableUpstreamNames` holds back is counted
    // there rather than dropped silently: a truncated list must never read as
    // a complete one. The count ahead of the parenthetical is the file's own
    // and stays untouched, which is the whole signal separating a dropped
    // upstream from a legitimately upstream-less gateway.
    const printed = printableUpstreamNames(names)
    const named = printed.length > 0 ? ` (${printed})` : ''
    const message = idle
      // Kept verbatim for the total loss. "Listening on nothing" and
      // "connection refused" are true only here, and an operator reading
      // `hyp status` against a dead gateway needs that sentence, not a
      // count of what a working one is missing.
      ? `the gateway is running but listening on nothing: ${configured} ${configured === 1 ? 'upstream' : 'upstreams'}${named} ${configured === 1 ? 'is' : 'are'} configured but none compiled to a route (each needs both a 'name' and a 'base_url') - clients will get connection refused`
      : `the gateway is listening, but ${dropped} of its ${configured} configured ${configured === 1 ? 'upstream' : 'upstreams'} did not compile to a route (each needs both a 'name' and a 'base_url') - ${droppedUpstreamConsequence(dropped, names, attribution)}`
    diagnostics.push({
      severity: 'warning',
      // Two kinds, one check. They cannot both fire (a gateway is either
      // bound or it is not), and consumers gate on `kind`: calling a
      // listening gateway `idle` to save a name would make the kind a lie
      // about the one thing its name asserts, and would merge an install
      // that refuses every connection with one that quietly misroutes a
      // single provider.
      kind: idle ? 'gateway_idle_no_upstreams' : 'gateway_upstreams_dropped',
      message,
      // Not `hyp config validate`: it prints `config ok` for this config and
      // exits 0. `@hypaware/ai-gateway` registers no config section, so
      // nothing validates upstream shape, and `diagnoseV1Config` matches an
      // upstream by its `provider` field, so a nameless anthropic entry
      // satisfies the one check that does look. A repair line that sends the
      // user to a command which affirms the broken config is worse than no
      // repair line, so point at the file and the two required keys instead.
      //
      // Which file is the question the eliminated-plugin repair above answers
      // (issue #1598): upstreams are the gateway plugin's own config slice, so
      // they live in whichever layer owns its `plugins[]` entry. When that is
      // the central layer the local entry carrying them is dropped at merge,
      // and an edit to it is exactly the inert repair this @ref forbids.
      // @ref LLP 0139#repair-must-be-runnable [constrained-by]: a repair has to be a step that changes something, so the inert validate command gives way to the edit that fixes it
      repair: [
        centralPluginNames.has(GATEWAY_PLUGIN_NAME)
          ? `add the missing 'name' / 'base_url' to each upstream in the central config's '${GATEWAY_PLUGIN_NAME}' entry`
            + ` - a local entry for it is dropped at merge, so editing ${configPath} changes nothing`
          : `add the missing 'name' / 'base_url' to each upstream in ${configPath} ('hyp config validate' does not check upstream shape)`,
        `hyp daemon restart  # the daemon reads the file only at boot`,
      ],
    })
  }
  /** @type {ClientAttachReport[]} */
  const clients = []
  /** @type {CaptureHealthReport[]} */
  const captureHealth = []
  const cacheRoot = opts.runtime?.storage?.cacheRoot ?? cacheRootOf(stateRoot)
  const clientDescriptors = catalog?.clientDescriptors ?? new Map()
  let capturePid
  try { capturePid = readPidFile(stateRoot) } catch { /* Unreadable identity stays unconfirmed. */ }
  for (const [clientName, descriptor] of clientDescriptors) {
    const configured = activePlugins.includes(descriptor.plugin)
    // One state per client: recording, or not. A detached client
    // (`recording: false`) is a choice, not a fault, so nothing below warns
    // about it; only a client that should be recording and whose wiring is
    // gone does.
    // @ref LLP 0466#status [implements]: status reads the same switch the runner and reconciler read
    const recording = configured && isEntryRecording(config?.plugins?.find((entry) => entry.name === descriptor.plugin))
    // Attach state is only a real state for a client that declares an
    // `attach_probe`. Without one there is no settings-file write to read back,
    // `action_attach.desired()` skips the descriptor for exactly that reason
    // (attach must be reversible), so no attach is ever performed and no marker
    // is ever written. Deriving `attached: false` from that silence is the wrong
    // negative indistinguishable from a right one (#544): the honest answer is
    // "not applicable", so the two surfaces that report attach *state* (the
    // clients row, and the attach action in `buildClientActionsReport`) read
    // this flag rather than a probe result that was never taken. The
    // `client_attach_missing` diagnostic just below now follows the same gate:
    // LLP 0358 made Desktop's probe-less transcript lane complete without any
    // setup marker.
    //
    // Codex reaches the same gate by a second route: its probe reads the
    // managed provider block, and in the default `transcript` mode attach
    // *removes* that block and writes no marker. The probe is declared but
    // can never be satisfied, so without this the warning below would stand
    // forever with a repair that does nothing.
    //
    // The probe still runs, though. It is the only thing that finds a marker
    // a previous mode left behind, which is what
    // `client_attached_not_configured` reads: suppressing the read would
    // strand that marker silently. Only the *verdict* narrows.
    // @ref LLP 0229#status-derives-by-the-same-gate [implements]: a probe-less client is unattachable, not unattached
    // @ref LLP 0429#status [implements]: a probe whose marker this capture mode can never write is n/a, not missing
    const probe = descriptor.attachProbe
      ? await probeClientAttachFromDescriptor({ descriptor, homeDir, env })
      : { attached: false }
    const attachable = isClientAttachable(clientName, descriptor, config)
    clients.push({
      name: clientName,
      plugin: descriptor.plugin,
      configured,
      recording,
      attachable,
      attached: probe.attached,
      ...(clientName === 'ollama' && configured ? { capture: ollamaCaptureFromSnapshot(config, daemonStatusFile, capturePid) } : {}),
      ...(probe.settingsPath ? { settingsPath: probe.settingsPath } : {}),
      ...(probe.version !== undefined ? { version: probe.version } : {}),
      ...(probe.port !== undefined ? { port: probe.port } : {}),
      ...(probe.mode !== undefined ? { mode: probe.mode } : {}),
      // `--json` only, like `version` and `port`: an operator debugging a
      // silent otel capture needs to see where the client is actually pointed,
      // and it is the field `client_telemetry_stale` below reasons about.
      ...(probe.telemetryPort !== undefined ? { telemetryPort: probe.telemetryPort } : {}),
      ...(probe.error !== undefined ? { error: probe.error } : {}),
    })
    // A probe-less client has no attach contract to satisfy. LLP 0358 makes
    // Desktop's scheduled transcript lane complete without a plist, so an
    // attach-missing warning would point at work capture does not need.
    // @ref LLP 0358#transcript-primary [implements]: Desktop capture health is
    //   independent of the optional managed-profile experiment
    if (recording && attachable && !probe.attached) {
      // The repair is `hyp client attach` only for a client whose plugin registers a
      // runtime adapter the generic reconciler can drive. A client that
      // declares `contributes.client` for probe/status plumbing but no
      // adapter (claude-desktop: its plist is placed by an attended command
      // with its own sudo prompt and consent gate, never by attach-on-join)
      // has to name its own setup command instead, or the repair we print is
      // one that answers `unknown client`. The command comes from the same
      // plugin's picker row, which already declares it as `configure_command`.
      // @ref LLP 0139#repair-must-be-runnable [implements]: an adapterless client's attach-missing repair names its configure_command, not the inert generic attach
      const configureCommand = catalog?.pickerDescriptors.get(clientName)?.configureCommand
      const repair = configureCommand ? `hyp ${configureCommand}` : `hyp client attach ${clientName}`
      diagnostics.push({
        severity: 'warning',
        kind: 'client_attach_missing',
        message: `'${descriptor.plugin}' is enabled but ${clientName} settings show no HypAware marker - run '${repair}'`,
        repair: [repair],
      })
    } else if (
      configured &&
      probe.attached &&
      // Gateway-routed modes only. An `otel` marker records the gateway port
      // like every other marker does, but nothing that client sends goes
      // there: it talks to Anthropic directly and exports telemetry to the
      // listener instead. Comparing that recorded port against the live
      // gateway made a routine rebind print "attached at port X, the gateway
      // is now bound to Y - re-attach", a rebind that changes nothing about
      // whether this client is captured, over a repair whose only real effect
      // is to rewrite the telemetry env block. `client_telemetry_stale` below
      // watches the port this mode actually depends on.
      // @ref LLP 0257#status-and-health [constrained-by]: S17b - on the otel
      //   path the endpoint that matters is the listener's, not the gateway's
      probe.mode !== 'otel' &&
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
        message: `${clientName} is attached at port ${probe.port} but the gateway is now bound to port ${liveGatewayPort} - run 'hyp client attach ${clientName}' to re-point it`,
        repair: [`hyp client attach ${clientName}`],
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
        message: `${clientName} settings still point at the HypAware gateway but '${descriptor.plugin}' is not enabled - its requests are no longer collected and can fail; run 'hyp client detach ${clientName}' to unhook it`,
        repair: [`hyp client detach ${clientName}`],
      })
    }

    // ----- capture health (LLP 0262 open question 1's duty) -----
    // On the otel path capture is best-effort: a stale endpoint, a down
    // daemon, or upstream event drift all fail into the same silence, with
    // every other line here healthy. This holds the client's own file trail
    // (fresh, probed off $HOME like the attach marker was) against the last
    // event the listener recorded (from status.json - deliberately NOT
    // liveness-gated, the LLP 0164 argument: "last seen at T" survives its
    // daemon, and the dead-daemon case is precisely the gap to surface).
    // Gated on `configured` because an otel marker with no enabled plugin is
    // `client_attached_not_configured`'s finding above, where the repair is a
    // detach rather than a capture fix.
    // @ref LLP 0257#status-and-health [implements]: last event seen vs last transcript activity, answered without a dataset or cache read
    if (configured && probe.attached && probe.mode === 'otel') {
      const snapshots = Array.isArray(daemonStatusFile?.sources) ? daemonStatusFile.sources : []
      const owned = snapshots.filter((s) => s && s.plugin === descriptor.plugin)
      // The plugin's listener source advertises itself by carrying the
      // `last_event_at` detail (null before the first event), the same
      // self-advertisement pattern as `control_routes`.
      const listenerSnap = owned.find((s) => {
        const details = sourceDetails(s)
        return !!details && 'last_event_at' in details
      }) ?? owned[0]
      const listenerDetails = sourceDetails(listenerSnap)
      const lastEventAt = typeof listenerDetails?.last_event_at === 'string'
        ? listenerDetails.last_event_at
        : null

      // ----- telemetry endpoint drift -----
      // The `otel` counterpart of `client_attach_stale` above, which compares
      // the marker's port against the *gateway* and so watches an address this
      // mode never uses. Attach writes one endpoint into the client's settings
      // and nothing rewrites it afterwards, while the listener may since have
      // bound elsewhere - it falls back to an ephemeral port when its default
      // is taken (LLP 0114 §ephemeral-fallback), and an attach that ran with no
      // live daemon could only write the default in the first place. The client
      // then POSTs its telemetry, prompts and responses included, at whatever
      // process holds the port it was told about, and every other line here
      // stays healthy. `capture_gap` below eventually notices the silence, but
      // only after fifteen minutes of transcript activity and without naming
      // the cause; this comparison is already on disk and is exact.
      //
      // Liveness-gated, unlike `last_event_at` right above: "the listener was
      // last bound to X" is not a claim a dead daemon's snapshot can support,
      // and a restart is exactly what moves the port back.
      // @ref LLP 0114#fallback-is-visible [implements]: a listener that came up on its ephemeral fallback is visible in status, not only in a boot log line - here through the client left pointing at the port it vacated
      // @ref LLP 0086#status-drift-diagnostic [implements]: the same warn-and-name-the-repair shape, against the port this attach mode actually writes
      const boundTelemetryPort = daemon.running && typeof listenerDetails?.listen_port === 'number'
        ? listenerDetails.listen_port
        : undefined
      if (
        probe.telemetryPort !== undefined &&
        boundTelemetryPort !== undefined &&
        Number.isInteger(boundTelemetryPort) &&
        probe.telemetryPort !== boundTelemetryPort
      ) {
        diagnostics.push({
          severity: 'warning',
          kind: 'client_telemetry_stale',
          message: `${clientName} exports its telemetry to port ${probe.telemetryPort} but the listener is bound to port ${boundTelemetryPort} - nothing it sends is being captured, and whatever holds port ${probe.telemetryPort} is receiving it; run 'hyp client attach ${clientName}' to re-point it`,
          repair: [
            `hyp client attach ${clientName}`,
            `start a fresh ${clientName} session - the settings env applies at launch`,
          ],
        })
      }
      // ----- per-signal OTLP override in the environment -----
      // The third leg beside the drift check above and the gap below. A
      // per-signal OTLP key outranks the general endpoint attach wrote, so one
      // variable left over in the user's shell - a profile, a launchd entry, a
      // collector switched off months ago - takes every event elsewhere, or
      // (exported empty, which still outranks) nowhere at all. Nothing else
      // here can see it: the settings file stays byte-perfect, the listener is
      // bound and started, and the body spool even keeps growing, because
      // OTEL_LOG_RAW_API_BODIES is a file path that endpoint precedence cannot
      // touch. `capture_gap` notices the resulting silence only after a
      // threshold of transcript activity, and cannot name a cause.
      //
      // Read off the shell `hyp status` was run in, which is not necessarily
      // the shell claude launches from - so a warning, non-degrading: a strong
      // lead, not a proof. The key name is named; the value never is, being
      // exactly where a collector credential lives.
      // @ref LLP 0271#status-names-it-too [implements]
      //
      // Reported in two groups, because the list carries two hazards and one
      // sentence cannot be true of both. A routing key (endpoint, protocol)
      // stops the export arriving; a headers key routes nothing and its harm
      // runs the other way, a collector credential attached to requests aimed
      // at the loopback listener. Telling someone with an unrelated
      // `OTEL_EXPORTER_OTLP_HEADERS` that nothing is captured would be the
      // standing false alarm that teaches them to skip the real line.
      const envOverrides = perSignalOtlpOverrides(/** @type {Record<string, unknown>} */ (env))
      const routingOverrides = envOverrides.filter((key) => !isOtlpHeadersOverride(key))
      const headerOverrides = envOverrides.filter(isOtlpHeadersOverride)
      if (routingOverrides.length > 0) {
        const names = routingOverrides.join(', ')
        const many = routingOverrides.length > 1
        const them = many ? 'them' : 'it'
        // What is lost, named by signal. Attach turns on two exporters and a
        // per-signal key only outranks its own: a shell exporting nothing but
        // `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` to a Prometheus collector - an
        // ordinary setup - loses the token and cost counters while every
        // prompt and response still reaches the listener. Telling that user on
        // every `hyp status` run that none of their telemetry is captured is
        // the same standing false alarm the headers split just below exists to
        // avoid, one list entry over.
        const signals = new Set(routingOverrides.map(otlpOverrideSignal))
        const lost = signals.has('logs') && signals.has('metrics')
          ? 'none of it is captured'
          : signals.has('logs')
            ? 'none of its log records are captured, the prompt and response text ' +
              'this attach turns on included (its metrics are unaffected)'
            : 'none of its token and cost metrics are captured (its log records, ' +
              'and the prompt and response text with them, are unaffected)'
        diagnostics.push({
          severity: 'warning',
          kind: 'client_telemetry_env_override',
          message:
            names + (many ? ' are' : ' is') + " set in this shell's environment and " +
            (many ? 'outrank' : 'outranks') + ' the telemetry settings ' + clientName +
            ' was attached with - a ' + clientName + ' session launched from a shell carrying ' +
            them + ' sends that traffic somewhere else, or nowhere at all if the value is ' +
            'empty, and ' + lost,
          // One `unset` with space-separated names, not the comma-joined list
          // in the message: `unset A, B` exits 0 in bash and unsets only `B`,
          // so a comma here would hand the user a repair that reports success
          // and leaves the key that is eating their capture still exported.
          repair: [
            'unset ' + routingOverrides.join(' ') +
              '  # in the shell profile or launchd entry that exports ' + them,
            'start a fresh ' + clientName + ' session from a shell without ' + them,
          ],
        })
      }
      if (headerOverrides.length > 0) {
        const names = headerOverrides.join(', ')
        const many = headerOverrides.length > 1
        const them = many ? 'them' : 'it'
        diagnostics.push({
          severity: 'warning',
          kind: 'client_telemetry_env_override',
          message:
            names + (many ? ' are' : ' is') + " set in this shell's environment, so a " +
            clientName + ' session launched from a shell carrying ' + them +
            ' sends ' + (many ? 'those headers' : 'that header') +
            " on every OTLP request to hypaware's local listener - capture still works, but " +
            'any collector credential in ' + (many ? 'those values' : 'that value') +
            ' is handed to a listener that never asked for it',
          repair: [
            'unset ' + headerOverrides.join(' ') +
              '  # in the shell profile or launchd entry that exports ' + them,
            'start a fresh ' + clientName + ' session from a shell without ' + them,
          ],
        })
      }
      let lastTranscriptActivityAt =
        (await probeClientActivityFromDescriptor({ descriptor, homeDir, env })) ?? null
      const attachedAt = probe.attachedAt ?? null
      // Live daemon only, deliberately. A dead daemon's snapshot still carries
      // the moment its listener started, but that moment stopped bounding
      // anything when the process ended, and the dead-daemon gap is the one
      // this line most needs to keep reporting.
      const listenerStartedAt = daemon.running && typeof listenerDetails?.listener_started_at === 'string'
        ? listenerDetails.listener_started_at
        : null
      let verdict = assessCaptureHealth({
        lastEventAt,
        lastTranscriptActivityAt,
        attachedAt,
        listenerStartedAt,
      })
      /** @type {'ok' | 'gap' | 'unknown'} */
      let state = verdict.state
      // The mtime pass above is a suspicion, not the finding: a transcript is
      // rewritten for plenty of reasons that produce no conversation and so
      // owe no telemetry, and mtime cannot tell those from a turn that went
      // uncaptured. The bounded read that can is spent only here, on the path
      // that would otherwise print "not being captured" and send the user off
      // to restart their daemon.
      // @ref LLP 0257#status-and-health [implements]: S17 compares the last event against last *transcript activity*; mtime only nominates a candidate, transcript content confirms it
      // @ref LLP 0536#positive-evidence [implements]: a confirmed turn reads gap despite a partial read; an unsettled one reads unknown, never ok
      if (verdict.state === 'gap') {
        const baselineMs = captureBaselineMs(lastEventAt, attachedAt, listenerStartedAt)
        const confirmed = await confirmClientActivityFromDescriptor({
          descriptor,
          homeDir,
          env,
          sinceMs: baselineMs ?? 0,
        })
        // A bounded read that ran out of budget knows neither way, and this
        // collector does not get to pick the convenient one: `unknown` is the
        // third answer, so an unconfirmed suspicion neither accuses the
        // capture path nor certifies it. A confirmed turn still reads `gap`
        // even when the read was partial - the finding is positive, and only
        // its severity could be understated by a newer turn gone unseen.
        if (confirmed.activityAt !== undefined) {
          lastTranscriptActivityAt = confirmed.activityAt
          verdict = assessCaptureHealth({
            lastEventAt,
            lastTranscriptActivityAt,
            attachedAt,
            listenerStartedAt,
          })
          state = verdict.state === 'gap' ? 'gap' : confirmed.certain ? 'ok' : 'unknown'
        } else if (confirmed.certain) {
          // Every post-baseline write was read, and none of it was a turn.
          verdict = { state: 'ok', gapMs: 0 }
          state = 'ok'
        } else {
          // `gapMs` stays the filesystem's suspicion, which is all it ever
          // was: `state` is what says the suspicion went unconfirmed.
          state = 'unknown'
        }
      }
      captureHealth.push({
        client: clientName,
        plugin: descriptor.plugin,
        source: listenerSnap?.name ?? null,
        lastEventAt,
        lastTranscriptActivityAt,
        attachedAt,
        listenerStartedAt,
        gapMs: verdict.gapMs,
        state,
      })
      if (state === 'gap' && verdict.severity !== undefined) {
        // Escalates to a degrading `error` past CAPTURE_GAP_ERROR_MS, unlike
        // the attach diagnostics above: a not-yet-attached install is merely
        // unfinished, but an attached one silently losing sessions is the
        // failure this line exists to make loud.
        const gapText = formatGapDuration(verdict.gapMs)
        const message = lastEventAt !== null
          ? `${clientName} is otel-attached, but its transcripts stayed active ${gapText} past the last telemetry event - those sessions are not being captured`
          // "past the point capture should have been running" rather than
          // "after the attach": with a live listener the baseline is whichever
          // of the attach and the listener's own start is newer, so naming the
          // attach would be wrong exactly when a restart moved the baseline.
          : `${clientName} is otel-attached, but no telemetry has arrived and its transcripts show activity ${gapText} past the point capture should have been running - those sessions are not being captured`
        diagnostics.push({
          severity: verdict.severity,
          kind: 'capture_gap',
          message,
          repair: [
            'hyp daemon restart  # the telemetry listener runs in the daemon',
            `hyp client attach ${clientName}  # rewrites the telemetry env block with the live listener port`,
            `start a fresh ${clientName} session - the settings env applies at launch`,
          ],
        })
      }
    }

    // ----- capture health, transcript lane -----
    // Transcript-mode Codex writes no marker and sends no telemetry, so the
    // otel line above can never fire for it and a working install had nothing
    // but "configured" to show (issue #2069). The capture this lane makes is
    // the row the sweep lands in the cache, so the line reads the newest one.
    // No row, or a table that cannot be read, is "unconfirmed": configured is
    // not captured.
    // @ref LLP 0546#newest-partition [implements]: one read of the newest date partition's timestamps, the narrow exception to LLP 0257 S17 and LLP 0164
    if (configured && attachWritesNoMarker(clientName, config)) {
      /** @type {string | null} */
      let newestRowAt = null
      try {
        newestRowAt = await newestCachedClientRowAt(cacheRoot, clientName)
      } catch { /* best-effort: an unreadable table confirms nothing */ }
      captureHealth.push({
        client: clientName,
        plugin: descriptor.plugin,
        source: null,
        lastEventAt: newestRowAt,
        lastTranscriptActivityAt: null,
        attachedAt: null,
        listenerStartedAt: null,
        gapMs: 0,
        state: newestRowAt === null ? 'unknown' : 'ok',
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
  // Best-effort like every other probe here (see this function's docstring): a
  // transient fs error mid-walk (EACCES/EMFILE/EIO, walkForStats re-throws
  // anything but ENOENT) must degrade to zeroed cache stats, never throw out of
  // the whole report.
  /** @type {{ totalBytes: number, oldestDate: string | null }} */
  let cache = { totalBytes: 0, oldestDate: null }
  try {
    cache = await measureCacheStats(cacheRoot)
  } catch { /* best-effort cache probe */ }

  // ----- tables whose last spool-to-cache flush failed (LLP 0322) -----
  // The cooldown is the visible half of a standing flush failure: a query
  // inside the window is told the cache may be stale, and nothing anywhere
  // told the user why. The stamp has carried the reason since the cooldown
  // shipped, on disk and unread. This is where it becomes readable.
  // @ref LLP 0330#capture-health-line [implements]: the stamp is collected for the capture-health line and both --json keys
  //
  // Read off the spool directly rather than through status.json, unlike
  // `recentEntrypoints` and `maintenance` above: those summarize a walk only
  // the daemon runs, while a flush failure is stamped by whichever process
  // attempted the flush - the daemon's scheduled one, a sink export, or the
  // `hyp query` in another terminal that first hit it. No single process
  // sees them all, so the file is the only place the whole answer exists.
  // The cost is one tree walk that stops at each spool directory, next to
  // the whole-tree stat sweep `measureCacheStats` already pays.
  // @ref LLP 0322#what-the-stamp-is-not [constrained-by]: reported as the reason a retry is paced, never folded into the freshness or size lines above
  /** @type {CacheFlushFailureReport[]} */
  let cacheFlushFailures = []
  let cacheFlushFailuresTotal = 0
  try {
    const collected = await collectCacheFlushFailures(cacheRoot)
    cacheFlushFailures = collected.failures
    cacheFlushFailuresTotal = collected.total
  } catch { /* best-effort spool probe */ }
  if (cacheFlushFailuresTotal > 0) {
    const one = cacheFlushFailuresTotal === 1
    // Warning, never an error, the `maintenance_partitions_skipped` parallel:
    // the daemon is running, capture works, the rows are durable in the spool
    // (LLP 0321), and queries answer from the confirmed cache. The
    // paging-grade signal already lives where LLP 0322 put it - the span
    // status code and `queryRunsTotal` - so this diagnostic is the local
    // repair pointer, and a flush failure alone never flips `overall`.
    // Enumerate first, retry second, the maintenance analog's repair shape:
    // `hyp status --json` lists every failing table, and a `hyp query
    // refresh` that completes clears the stamp (LLP 0322#clearing).
    // The retry reaches less than the count does, and the doc says so
    // rather than letting a reader assume otherwise: the enumeration walks
    // the spool (`collectCacheFlushFailures`, which reaches a table nothing
    // declared) while `hyp query refresh` iterates registered datasets, so a
    // stamp on an undeclared or deactivated table is counted here and
    // cleared by neither command.
    // @ref LLP 0330#warning-diagnostic [implements]: a standing flush failure is a warning with a repair, not a degraded install
    //
    // Attempt tense, not "is failing": the stamp asserts that the last
    // attempt failed and no attempt has completed since (LLP 0322#clearing),
    // and it cannot witness an ongoing condition - the cause may be fixed
    // with nothing retried yet. `stillCoolingDown` stays out of the message:
    // it is per-table state a one-line summary over N tables cannot claim,
    // and the capture-health line above renders it per table.
    // @ref LLP 0333#attempt-tense [implements]: the message states the stamp's assertion, nothing more current
    diagnostics.push({
      severity: 'warning',
      kind: 'cache_flush_failing',
      message: `last spool-to-cache flush attempt failed for ${cacheFlushFailuresTotal} table${one ? '' : 's'} (newest: ${cacheFlushFailures[0]?.table ?? 'unknown'})`,
      repair: [
        'hyp status --json',
        'hyp query refresh',
      ],
    })
  }

  // ----- remote config apply state (LLP 0025) -----
  /** @type {ConfigControlStatus | null} */
  let remoteConfig = null
  try {
    remoteConfig = readConfigControlStatus({ stateRoot })
  } catch { /* best-effort probe */ }
  // Kept so the recent-errors pass below, which reads the daemon log once,
  // can name the sink that stopped this host confirming the revision.
  /** @type {StatusDiagnostic | null} */
  let rollbackDiagnostic = null
  if (remoteConfig?.lastRollback) {
    // The three values in this message are display-only, and none of them is
    // this build's own: the etag is whatever the joined server served, and
    // all three come back through `state/config-control.json`, which is read
    // with no validation beyond "is an object". A diagnostic message is prose
    // assembled for a person, so its components are cleaned here, where the
    // prose is assembled, rather than in `readConfigControlStatus`.
    //
    // Be precise about what that does and does not mean. The message is
    // assembled once, here, so the cleaned prose is also what `--json` carries
    // at `diagnostics[].message`: a machine consumer of *that string* reads
    // the sanitized line, not the file's bytes, with each component stripped
    // and clamped to `sanitizeLabel`'s 120. That is accepted, not overlooked.
    // The prose line is not a parsing surface on either render, and the
    // unedited values stay one key away and structured, at
    // `remote_config.last_rollback`, which is where a program reads them and
    // which stays byte-exact. Cleaning at the single `${d.message}`
    // interpolation in `renderStatusText` instead would keep the prose raw for
    // `--json` too, but it would have to pick one clamp width that holds for
    // every diagnostic kind, not just this one.
    // @ref LLP 0225#decision [implements]: assembled prose is cleaned where it is assembled; the machine copy of the same values, `remote_config.last_rollback`, stays byte-exact
    const rolledBack = remoteConfig.lastRollback
    rollbackDiagnostic = {
      severity: 'warning',
      kind: 'remote_config_rolled_back',
      message: `remote config ${sanitizeLabel(rolledBack.etag) ?? ''} rolled back at ${sanitizeLabel(rolledBack.at) ?? ''} (${sanitizeLabel(rolledBack.reason) ?? ''})`,
      // @ref LLP 0517#retry: an unconfirmed revision is retried on its own, so the repair does not ask for a new one
      repair: [rolledBack.reason === 'probation_unconfirmed'
        ? 'the gateway retries this revision on its own after a backoff, or at once after a client upgrade'
        : 'fix the central config revision; the gateway re-applies when the served etag changes'],
    }
    diagnostics.push(rollbackDiagnostic)
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

  // ----- proxy-mode trust (LLP 0237 / LLP 0239) -----
  const proxyTrust = await collectProxyTrust({
    platform,
    stateRoot,
    config,
    isCaTrustedFn: opts.isCaTrusted
      ?? ((args) => probeCaTrusted({ ...args, timeoutMs: TRUST_PROBE_TIMEOUT_MS })),
    isLaunchdEnvSetFn: opts.isLaunchdEnvSet
      ?? (() => probeLaunchdEnvSet({ timeoutMs: TRUST_PROBE_TIMEOUT_MS })),
  })

  // ----- recent errors (LLP 0349) -----
  // Read every store this install actually keeps, not just the one a
  // developer's install keeps. `dev-telemetry/` alone made this counter
  // structurally zero on an ordinary machine (issue #1182), which is the one
  // answer a monitoring field must never give when it has not looked.
  // @ref LLP 0349#read-the-records-production-keeps [implements]: the count reads the daemon log and the sink outbox, which exist on every install, not only dev telemetry
  // Not simply the configured set: an unreadable layer, or a recovered row
  // whose `sinks` key the central merge dropped, leaves the gate armed over
  // the status-file fallback's recovered rows.
  // @ref LLP 0453#warning-rule [implements]: a destination outside the configured set does not warn, however the removal was spelled
  const lastRollback = remoteConfig?.lastRollback
  const recentErrors = await countRecentErrors(
    stateRoot,
    sinksAreConfigured ? sinks : [],
    daemonStatusFile?.sinks,
    (lastRollback?.reason === 'probation_expired' || lastRollback?.reason === 'probation_unconfirmed') &&
      typeof lastRollback.at === 'string' ? Date.parse(lastRollback.at) : NaN,
  )
  const recentErrorCount = recentErrors.total
  diagnostics.push(...recentErrors.sinkDiagnostics)
  if (sinksAreConfigured && config?.sinks) {
    diagnostics.push(...await heldDatasetDiagnostics(stateRoot, config))
    diagnostics.push(...await serviceTokenDiagnostics(stateRoot, config))
  }
  // A probation that expired while a sink could not materialize says this
  // host could not confirm the revision, not that the revision is bad, so the
  // hint names the sink instead of blaming the config (issue #2547).
  if (rollbackDiagnostic && recentErrors.probationSinkFailures.length > 0) {
    const named = recentErrors.probationSinkFailures
      .map((f) => `sink '${sanitizeLabel(f.instance) ?? 'unknown'}' (${sanitizeLabel(f.errorKind) ?? 'materialize_failed'})`)
      .join(', ')
    rollbackDiagnostic.message += `: this host could not confirm it because ${named} did not materialize`
    rollbackDiagnostic.repair = [
      sinkMaterializeLogGrep,
      'fix the sink error the log shows; the revision itself may be fine',
    ]
  }
  if (recentErrors.warningCount > 0) {
    // A restart reproduces a sink materialize failure, so it is offered only
    // for the other errors, and never first when a sink failed.
    const onlySinkFailures = recentErrors.sinkMaterialize === recentErrors.warningCount
    diagnostics.push({
      severity: 'warning',
      kind: 'recent_errors',
      // Export attempts have their own recovery-aware diagnostic. The history
      // count still includes them, but cannot make them actionable again.
      message: `${recentErrors.warningCount} error${recentErrors.warningCount === 1 ? '' : 's'} needing attention in the last ${RECENT_ERROR_WINDOW_HOURS}h (${recentErrors.breakdown.join('; ')})`,
      repair: recentErrors.sinkMaterialize === 0
        ? ['hyp daemon restart']
        : onlySinkFailures
          ? [sinkMaterializeLogGrep, 'fix the sink error the log shows']
          : [sinkMaterializeLogGrep, 'hyp daemon restart  # for the other errors; a restart alone does not fix a sink materialize failure'],
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
  // it cannot reach this computation. A `capture_gap` that escalated to
  // `error` severity degrades through the severity rule below by design
  // (LLP 0262 open question 1): silent session loss is an outage, not an
  // unfinished setup.
  // @ref LLP 0537#status-warning [implements]: rows a configured destination cannot accept stay local, which is not healthy forwarding
  const degradingKinds = new Set(['config_missing', 'config_unreadable', 'sink_dataset_unsupported'])
  const overall =
    diagnostics.some((d) => d.severity === 'error') ? 'degraded'
    : v1Diagnostics.length > 0 ? 'degraded'
    : diagnostics.some((d) => degradingKinds.has(d.kind)) ? 'degraded'
    : 'healthy'

  // Read after `overall` and never pushed as a diagnostic: the notice reports
  // coverage, not a fault, so it cannot move the verdict or the headline.
  const assetCoverage = catalog
    ? describeAssetCoverage({
      records: await readClientAssetLedger(clientAssetStateRoot(env, homeDir)),
      attached: clients.filter((c) => c.attached).map((c) => c.name),
      labelOf: (name) => catalog.pickerDescriptors.get(name)?.label ?? name,
    })
    : null

  return {
    configPath,
    configExists,
    configValid,
    configRecordsAnswer,
    activePlugins,
    failedPlugins,
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
    maintenance,
    captureHealth,
    cacheFlushFailures,
    cacheFlushFailuresTotal,
    proxyTrust,
    selfUpdate: describeSelfUpdate({ stateRoot, env }),
    assetCoverage,
    gateways: await collectGateways(stateRoot, config),
  }
}

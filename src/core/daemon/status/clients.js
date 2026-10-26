// @ts-check

/**
 * Whether each client is attached: its attach marker and hook settings,
 * the plugin catalog that names the clients, and Ollama capture.
 *
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { DaemonStatus, OllamaCaptureStatus } from '../../../../src/core/daemon/types.js'
 * @import { ClientDescriptor, LoadedManifest, PluginCatalog } from '../../../../src/core/types.js'
 * @import { DiscoverInstalledResult } from '../../../../src/core/runtime/types.js'
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { CLAUDE_SETTINGS_MARKER_SCHEMA } from '../../config/client_detach_disk.js'
import {
  endpointFromListen,
  configuredGatewayEndpoint,
  DEFAULT_GATEWAY_ENDPOINT,
} from '../../config/gateway_endpoint.js'
import { readCodexCaptureMode } from '../../config/attach_policy.js'
import { discoverInstalledPlugins } from '../../runtime/installed.js'
import { discoverBundledPlugins } from '../../runtime/bundled.js'
import { buildPluginCatalog } from '../../plugin_catalog.js'
import { isEphemeralRecordedBinPath } from '../../cli/global_install.js'
import { getAtDottedPath, isPlainObject } from '../../util/json_util.js'
import { resolveClientSettingsPath } from '../client_settings_path.js'
import {
  processIsAlive,
  readPidFile,
} from '../pid.js'
import { DAEMON_HEARTBEAT_STALE_MS, daemonHeartbeatAgeMs } from './file.js'
import { gatewaySourceDetails } from './gateway.js'

/**
 * Whether an otherwise-probe-declaring client writes no marker in its current
 * configuration, so its attach state is "n/a" rather than "not attached".
 * Codex is the only such client: `capture_mode: "gateway"` writes the managed
 * provider block, and the default `transcript` mode removes it.
 *
 * @param {string} clientName
 * @param {HypAwareV2Config | null | undefined} config
 * @returns {boolean}
 */
export function attachWritesNoMarker(clientName, config) {
  return clientName === 'codex' && readCodexCaptureMode(config?.plugins) === 'transcript'
}

/**
 * Whether a client has an attach marker to wait for in its configured capture
 * mode: it declares an `attach_probe`, and that mode writes the marker the
 * probe reads. The clients row and the login attach-wait share this one gate.
 *
 * @param {string} clientName
 * @param {ClientDescriptor} descriptor
 * @param {HypAwareV2Config | null | undefined} config
 * @returns {boolean}
 */
export function isClientAttachable(clientName, descriptor, config) {
  return !!descriptor.attachProbe && !attachWritesNoMarker(clientName, config)
}

/**
 * Saved config and finite source snapshots are separate facts. A current route
 * needs the exact daemon generation, fresh heartbeat and resolved alias.
 * @ref LLP 0474#diagnostics [implements]: cheap capture evidence never queries datasets or treats retained stamps as current health
 * @param {HypAwareV2Config | null} config
 * @param {DaemonStatus | null | undefined} status
 * @param {ReturnType<typeof readPidFile>} pid
 * @returns {OllamaCaptureStatus}
 */
export function ollamaCaptureFromSnapshot(config, status, pid) {
  const plugin = config?.plugins?.find(p => p.name === '@hypaware/ollama' && p.enabled !== false)
  const gateway = config?.plugins?.find(p => p.name === '@hypaware/ai-gateway' && p.enabled !== false)
  const upstreams = gateway?.config?.upstreams
  const upstream = Array.isArray(upstreams) ? upstreams.find(u => isPlainObject(u) && u.name === 'ollama') : undefined
  const direct = isPlainObject(upstream) && typeof upstream.base_url === 'string' ? upstream.base_url : 'http://127.0.0.1:11434'
  const configuredRoot = (configuredGatewayEndpoint(config ?? { version: 2 }) ?? DEFAULT_GATEWAY_ENDPOINT).replace(/\/+$/, '') + '/ollama'
  const age = daemonHeartbeatAgeMs(status, Date.now())
  const current = !!pid && processIsAlive(pid.pid) && status?.pid === pid.pid && status.runId === pid.runId
    && status.startedAt === pid.startedAt && ['healthy', 'degraded'].includes(status.state)
    && age !== null && age >= 0 && age <= DAEMON_HEARTBEAT_STALE_MS
  const source = Array.isArray(status?.sources) ? status.sources.slice(0, 128).find(s => s && s.name === 'ai-gateway' && s.state === 'started') : undefined
  const details = isPlainObject(source?.details) ? source.details : {}
  const bound = current && details.listening !== false ? gatewaySourceDetails(source ? [source] : []) : undefined
  const captureRoot = bound ? endpointFromListen(`${bound.host}:${bound.port}`) + '/ollama' : null
  const aliases = Array.isArray(details.upstream_aliases) ? details.upstream_aliases.slice(0, 32) : []
  let routeConfirmed = false
  try {
    const directUrl = new URL(direct)
    routeConfirmed = !!captureRoot && !directUrl.username && !directUrl.password && !directUrl.search && !directUrl.hash
      && aliases.some(a => isPlainObject(a) && a.name === 'ollama-native' && a.canonical === 'ollama' && a.path_prefix === '/ollama' && a.base_url === directUrl.href)
  } catch { /* Invalid saved transport is unconfirmed, never echoed. */ }
  const processorReady = current && details.capture_ready === true && details.recording_enabled === true
    && Array.isArray(details.projectors) && details.projectors.slice(0, 32).includes('ollama-native-chat')
  const outcomes = Array.isArray(details.capture_outcomes) ? details.capture_outcomes.slice(0, 32)
    .filter(o => isPlainObject(o) && typeof o.route === 'string' && ['ollama', 'ollama-native'].includes(o.route)) : []
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]{12}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null
  const newest = key => outcomes.reduce((last, o) => { const at = timestamp(o[key]); return at && (!last || at > last) ? at : last }, null)
  const recent = Array.isArray(details.recent_entrypoints) ? details.recent_entrypoints.slice(0, 32) : []
  const entrypointStamp = recent.reduce((last, e) => {
    const at = isPlainObject(e) && e.client_name === 'ollama' ? timestamp(e.last_seen) : null
    return at && (!last || at > last) ? at : last
  }, null)
  const lastPersisted = newest('last_persisted') ?? entrypointStamp
  const lastFailed = newest('last_failed')
  const failures = ['invalid_request', 'unsupported_shape', 'invalid_response', 'malformed_stream', 'trailing_record', 'missing_terminal', 'transport_error', 'upstream_unavailable', 'http_error', 'capture_limit', 'processor_unavailable', 'append_failure', 'policy_unreadable', 'recording_barrier_unconfirmed']
  const failed = outcomes.find(o => timestamp(o.last_failed) === lastFailed && failures.includes(o.reason))
  const reason = failed && typeof failed.reason === 'string' ? failed.reason : null
  const historical = !current || !plugin || plugin.recording === false
  const state = !plugin || plugin.recording === false ? 'disabled'
    : !routeConfirmed || !processorReady ? 'unconfirmed'
    : lastFailed && (!lastPersisted || lastFailed >= lastPersisted) ? 'failed'
    : outcomes.some(o => timestamp(o.last_observed) && (!timestamp(o.last_outcome) || o.last_observed > o.last_outcome)) ? 'observed'
    : lastPersisted ? 'persisted' : 'ready'
  const next = state === 'disabled' ? 'hyp client attach ollama'
    : state === 'unconfirmed' ? 'hyp daemon restart; hyp ollama setup'
    : state === 'failed' ? (reason === 'upstream_unavailable' || reason === 'http_error' ? 'Check the direct service with hyp ollama setup, then rerun hyp ollama verify --model <installed-model>'
      : reason === 'unsupported_shape' ? 'Use supported native chat/generate with think:false, then rerun hyp ollama verify --model <installed-model>'
        : 'Check hyp status --verbose and the daemon log, then rerun hyp ollama verify --model <installed-model>')
    : 'Route a client using the capture root, or run hyp ollama verify --model <installed-model>'
  return { state, configuredRoot, captureRoot, routeConfirmed, processorReady, lastPersisted, lastFailed, historical, reason, next }
}

/**
 * The port an attach marker's managed `OTEL_EXPORTER_OTLP_ENDPOINT` names.
 *
 * This is not {@link probeClientAttachFromDescriptor}'s `port`, which records
 * the gateway. An `otel`-mode client sends nothing to the gateway: its whole
 * capture path is this one endpoint, written into the client's settings once
 * at attach and never revisited. So it is the value a drift check has to
 * compare, and taking it from `managed.env` - the live env block attach wrote
 * and detach restores - means the check reads the address the client is
 * actually using rather than a parallel field that could disagree with it.
 *
 * Anything that is not a well-formed loopback-shaped `http(s)://host:port`
 * with an in-range port reads as absent: the marker is a file a hand edit
 * reaches, and a diagnostic built on a guess is worse than no diagnostic.
 *
 * @param {Record<string, unknown>} markerObj
 * @returns {number | undefined}
 */
function markerTelemetryPort(markerObj) {
  const managed = markerObj.managed
  if (!isPlainObject(managed)) return undefined
  const env = managed.env
  if (!isPlainObject(env)) return undefined
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (typeof endpoint !== 'string' || endpoint.length === 0) return undefined
  let parsed
  try {
    parsed = new URL(endpoint)
  } catch {
    return undefined
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return port
}

/**
 * Whether the marker still records its managed hook entries under the retired
 * `managed.hooks` name.
 *
 * Claude Code 2.1.257 reads `hooks` as a hook declaration wherever it sits in
 * settings.json, not only at the root, so a marker carrying that field makes
 * Claude reject the whole file. Attach writes `managed.hook_entries` instead
 * and re-attach is the migration - but the rename moves no other currency key
 * (the mode, the gateway port and the asset set are all unchanged by it), so
 * without a staleness signal `hyp client attach claude` short-circuits as
 * already-current and the machine the fix exists for stays broken.
 *
 * Presence, not type: what Claude refuses is the key, whatever it holds.
 *
 * Read here rather than from the adapter for the same reason the core undo
 * reads both names (`detachClientFromDisk`): the marker is a format core
 * already knows, and the probe runs with the plugin unloaded.
 *
 * @param {Record<string, unknown>} markerObj
 * @returns {boolean}
 */
function markerHasRetiredHookField(markerObj) {
  const managed = markerObj.managed
  return isPlainObject(managed) && Object.hasOwn(managed, 'hooks')
}

/**
 * Whether the marker's managed hook commands run the CLI out of a tree its
 * package manager deletes on a schedule of its own: npm's `_npx` cache, or a
 * project's own `node_modules`.
 *
 * The same class of drift as the retired field above, one field over: the
 * marker records what today's attach would refuse to write. A hook command
 * baked under `npx hypaware` names a cache npm prunes on its own schedule,
 * and the hook contract is exit-0-and-be-silent, so once it is pruned `cwd` /
 * `git_branch` capture stops with nothing to show for it. Issue #1602 stopped
 * attach writing that path, but only for an attach that reaches the adapter,
 * and this marker is current in every other key (port, mode, schema token,
 * asset set), so the repair short-circuits and changes nothing (issue #1607).
 *
 * The predicate is `isEphemeralRecordedBinPath`, the recorded-path form of the
 * one the adapter decides with when it bakes the command. Anything narrower
 * here reopens #1607 one tree over: the adapter warns that a project-local hook
 * command will stop capturing and names a re-attach as the repair, and a marker
 * current in every other key short-circuits that re-attach, so the operator
 * does as they are told and nothing changes. The recorded form adds the end
 * state of that same drift: a dependency tree deleted outright still has to
 * read stale, or the one machine whose hook is certainly dead is the one the
 * repair cannot reach (LLP 0434, issue #1624). A recorded path that merely no
 * longer resolves is still left alone: a CLI moves for ordinary reasons (a node
 * version switch, a prefix change) and "gone from disk" cannot tell that apart
 * from a deletion, so what carries the verdict is the tree, which is
 * package-manager-owned and deletion-scheduled by construction whether or not
 * it is still there today.
 *
 * With no CLI installed anywhere the re-attach writes the same path again,
 * because it is the only entrypoint there is, and takes the adapter's existing
 * ephemeral-hook warning branch - which is the point, since an already-attached
 * user is exactly who never saw that warning.
 *
 * @param {Record<string, unknown>} markerObj
 * @param {NodeJS.ProcessEnv | undefined} env
 * @returns {boolean}
 */
function markerRecordsEphemeralHookBin(markerObj, env) {
  const managed = markerObj.managed
  if (!isPlainObject(managed)) return false
  const entries = managed.hook_entries
  if (!Array.isArray(entries)) return false
  // One answer per distinct path, not per entry. Attach writes six managed
  // entries (`MANAGED_HOOK_SPECS` in the adapter) and every one of them names
  // the same bin, so asking per entry is five repeats of a walk plus a
  // `statSync` - work `isNpxBinPath` never did, on a function `hyp status` and
  // the login attach-wait's one-second poll both call.
  /** @type {Set<string> | undefined} */
  let asked
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue
    const bin = hookCommandBin(entry.command)
    // Absolute, or no claim. The predicate below resolves whatever it is
    // handed, so a relative token - a hand-edited `node hypaware.js ...`, an
    // empty quoted command - would be judged against the directory `hyp`
    // happened to run in, and one marker would read stale from inside a
    // project and current from anywhere else. Every command attach writes is
    // absolute, so the guard costs nothing and makes the verdict a property of
    // the marker alone.
    if (bin === undefined || !path.isAbsolute(bin)) continue
    asked ??= new Set()
    if (asked.has(bin)) continue
    asked.add(bin)
    if (isEphemeralRecordedBinPath(bin, env)) return true
  }
  return false
}

/**
 * The CLI path a recorded hook command runs, in the two forms the adapter
 * shell quoting produces: bare when the path holds only safe characters,
 * single-quoted (an embedded quote written `'\''`) otherwise. Anything else,
 * an empty command or an unterminated quote, is `undefined`: no claim, the
 * same answer as a path that is not from a cache.
 *
 * @param {unknown} command
 * @returns {string | undefined}
 */
function hookCommandBin(command) {
  if (typeof command !== 'string') return undefined
  const text = command.trimStart()
  if (text === '') return undefined
  if (text[0] !== "'") {
    const end = text.indexOf(' ')
    return end === -1 ? text : text.slice(0, end)
  }
  let out = ''
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== "'") {
      out += text[i]
      continue
    }
    if (text.startsWith("'\\''", i)) {
      out += "'"
      i += 3
      continue
    }
    return out
  }
  return undefined
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
 * @returns {Promise<{ attached: boolean, settingsPath?: string, version?: string, port?: string, mode?: string, attachedAt?: string, telemetryPort?: number, markerFormatStale?: boolean, error?: string }>}
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
      const telemetryPort = markerTelemetryPort(markerObj)
      return {
        attached: true,
        settingsPath,
        version: typeof markerObj.version === 'string' ? markerObj.version : undefined,
        port: typeof markerObj.port === 'number' ? String(markerObj.port) : undefined,
        // The marker's `mode` / `attached_at`, absent on markers that predate
        // them: mode is what gates the capture-health section, and the attach
        // timestamp is its baseline for a listener that has seen nothing yet.
        ...(typeof markerObj.mode === 'string' ? { mode: markerObj.mode } : {}),
        ...(typeof markerObj.attached_at === 'string' ? { attachedAt: markerObj.attached_at } : {}),
        // Where the client's own exporter is pointed, which for an `otel`
        // attach is the only address capture depends on. Read off
        // `managed.env` rather than added as a second marker field, so it is
        // literally the value the client is using and cannot fall out of step
        // with it.
        ...(telemetryPort !== undefined ? { telemetryPort } : {}),
        // A marker predating the current settings schema can carry a reserved
        // `hooks` key in managed entries or malformed-value backups. Claude
        // Code 2.1.257 refuses that file, and re-attach is the migration, so it
        // has to read as stale to callers that otherwise treat a marker at the
        // live port as nothing to do. Keep the retired-field check explicit so
        // a hand-edited marker cannot claim the current schema while retaining
        // the known-invalid field.
        ...(descriptor.name === 'claude' &&
          (markerHasRetiredHookField(markerObj) ||
            markerObj.settings_schema !== CLAUDE_SETTINGS_MARKER_SCHEMA ||
            markerRecordsEphemeralHookBin(markerObj, env))
          ? { markerFormatStale: true }
          : {}),
      }
    }

    if (probe.format === 'toml' && probe.marker_header) {
      return { attached: raw.includes(probe.marker_header), settingsPath }
    }

    // @ref LLP 0306#managed-plugin-file [implements]: a whole-file attach is
    //   owned only while its exact marker remains present
    if (probe.format === 'managed_file' && probe.marker_text) {
      return { attached: raw.includes(probe.marker_text), settingsPath }
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
  return catalogFromManifests(await discoverStatusManifests({ stateDir }))
}

/**
 * The one discovery pass behind {@link buildStatusCatalog}, exposed so the
 * collector can also ask the manifests questions the catalog cannot answer:
 * which installed plugins are shadowed by a bundled name, and which are in
 * the lock but contributed no manifest. The catalog is built from manifests
 * that loaded, so neither leaves a trace in it. Each discovery failure
 * degrades to empty, never throws.
 *
 * The installed side is returned whole rather than narrowed to `loaded`: the
 * lock entries are what say a plugin is installed, and the collector needs
 * them to tell an unloadable install from a name this machine never had
 * (issue #1936).
 *
 * @param {{ stateDir: string }} args
 * @returns {Promise<{ bundled: { loaded: LoadedManifest[], excluded: LoadedManifest[] }, installed: DiscoverInstalledResult }>}
 */
export async function discoverStatusManifests({ stateDir }) {
  /** @type {{ loaded: LoadedManifest[], excluded: LoadedManifest[] }} */
  let bundled = { loaded: [], excluded: [] }
  /** @type {DiscoverInstalledResult} */
  let installed = { loaded: [], failed: [], lockEntries: [], malformed: [], malformedLines: new Map() }
  try {
    bundled = await discoverBundledPlugins()
  } catch { /* bundled discovery failure is non-fatal */ }
  try {
    installed = await discoverInstalledPlugins({ stateDir })
  } catch { /* installed discovery failure is non-fatal */ }
  return { bundled, installed }
}

/**
 * @param {Awaited<ReturnType<typeof discoverStatusManifests>>} manifests
 * @returns {PluginCatalog | undefined}
 */
export function catalogFromManifests({ bundled, installed }) {
  try {
    return buildPluginCatalog([...bundled.loaded, ...bundled.excluded], installed.loaded)
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

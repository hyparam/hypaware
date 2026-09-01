// @ts-check

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { configRecordsPickAnswer, defaultConfigPath, loadConfigFile } from '../config/schema.js'
import { readConfigControlStatus, resolveCentralLayerPath } from '../config/apply.js'
import { readClientActionStatus } from '../config/action_reconciler.js'
import { endpointFromListen } from '../config/gateway_endpoint.js'
import { readAttachPolicy } from '../config/attach_policy.js'
import { readBackfillPolicy } from '../config/backfill_policy.js'
import {
  isOtlpHeadersOverride,
  otlpOverrideSignal,
  perSignalOtlpOverrides,
} from '../config/otlp_precedence.js'
import { DEFAULT_RETENTION_DAYS } from '../cache/retention.js'
import { discoverSpoolTables, QUERY_FLUSH_FAILURE_COOLDOWN_MS, readFlushFailure } from '../cache/spool.js'
import { resolveLayeredConfig } from '../config/merge.js'
import { devTelemetryDir, readObservabilityEnv } from '../observability/env.js'
import { collectConfigErrors, diagnoseV1Config, validateConfig } from '../config/validate.js'
import { discoverInstalledPlugins } from '../runtime/installed.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { compareStrings } from '../util/compare_strings.js'
import { classifyClientProvenance } from '../cli/wizard/provenance.js'
import { describeSelfUpdate } from '../update/self_update.js'
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
import { displayableCaHosts, readLocalCaInfo } from '../tls/ca.js'
import { isCaTrusted as probeCaTrusted } from '../tls/darwin_trust.js'
import { isLaunchdEnvSet as probeLaunchdEnvSet } from './launchd_env.js'
import { daemonLogDir } from './logs.js'
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
 * @import { CacheFlushFailureReport, CaptureHealthReport, ClientActionReport, ClientActionsReport, ClientAttachReport, CollectStatusOptions, DaemonStatus, DroppedUpstreamAttribution, HypAwareStatusReport, MaintenanceSkippedPartition, MaintenanceSkipReason, MaintenanceSkipSnapshot, ProxyTrustReport, RecentEntrypoint, ServiceState, SinkSnapshot, SourceSnapshot, StatusDiagnostic } from '../../../src/core/daemon/types.js'
 * @import { MaintenancePartitionReport, MaintenanceReport } from '../../../src/core/cache/types.js'
 * @import { Dirent } from 'node:fs'
 * @import { FileHandle } from 'node:fs/promises'
 * @import { ClientDescriptor, LoadedManifest, PluginCatalog } from '../../../src/core/types.js'
 * @import { FolderAskMode } from '../../../src/core/usage-policy/types.js'
 * @import { LocalCaInfo } from '../../../src/core/tls/types.js'
 */

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
  // Display-only, and read out of a file: `listen_fallback_from` is the
  // configured listen address the gateway could not take, and it is printed
  // verbatim into `gateway_port_fallback`'s message and its repair line. That
  // makes it the same kind of value as an upstream `name` or an `entrypoint`,
  // so it is cleaned at the same last point before render. `host` above is
  // deliberately left alone: it is not display-only (it composes the endpoint
  // attach writes into client settings), so bounding it is a separate change.
  // @ref LLP 0164#status-reads-it-from-the-status-file [constrained-by]: a string read back out of status.json is cleaned before it is printed, whichever detail it came from
  const listenFallbackFrom = sanitizeLabel(details.listen_fallback_from)
  return { host, port, listenFallback, ...(listenFallbackFrom ? { listenFallbackFrom } : {}) }
}

/**
 * The gateway source's `status()` details as the daemon captured them, before
 * any "is it bound?" filtering. `gatewaySourceDetails` above answers "where do
 * I send traffic?" and so returns nothing for a gateway that never bound; the
 * dropped-upstream check below needs the details of exactly that case.
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
 * How many upstream names a single warning line will spell out before it stops
 * naming them and counts the remainder.
 *
 * `sanitizeLabel` bounds each name; nothing bounds how many of them the file
 * holds. These names are read inside one sentence rather than down a block of
 * lines, so the cap sits well under `recent clients`' 32: the count leads that
 * sentence and is the number that actually matters, which leaves the list free
 * to be a sample.
 */
const MAX_PRINTED_UPSTREAM_NAMES = 8

/**
 * A list of upstream names out of the status file, rendered for the one
 * warning line that prints it: each name cleaned through `sanitizeLabel`, the
 * list capped, and everything the two filters held back counted at the end, so
 * a truncated list never reads as a complete one. `''` for an empty list,
 * which every caller already renders as "no names to show".
 *
 * These names arrive in the same file as `recent_entrypoints`, so the reason
 * that list is sanitized on read applies here unchanged: `status.json` is a
 * *file*, and core cannot assume the daemon that wrote it was this version,
 * this build, or well behaved, while everything read here is about to be
 * printed to a terminal. An upstream `name` is config-authored rather than
 * client-authored, which lowers the odds but not the reachability, and two
 * paths reading one file should not disagree about whether it is trusted.
 *
 * Rendering is where the cleaning happens, not `gatewayDroppedUpstreams`,
 * because the names are not display-only there: `attributeDroppedUpstreams`
 * intersects them with `registered_presets` to decide each dropped name's
 * fate, and a cleaned or capped list would silently change that answer.
 * Cleaning bounds what is *printed*, and must revise neither the counts the
 * message leads with nor the sets it splits them into.
 *
 * @param {string[]} list
 * @returns {string}
 * @ref LLP 0164#status-reads-it-from-the-status-file [constrained-by]: the sanitize-and-cap on read is a property of reading status.json, not of the entrypoint list that first needed it
 */
function printableUpstreamNames(list) {
  /** @type {string[]} */
  const printed = []
  for (const name of list) {
    if (printed.length === MAX_PRINTED_UPSTREAM_NAMES) break
    const label = sanitizeLabel(name)
    // A name that cleans away to nothing is withheld rather than printed
    // empty, and counted with the ones the cap dropped: from the reader's side
    // both are names the file holds and the line does not show.
    if (label !== undefined) printed.push(label)
  }
  const hidden = list.length - printed.length
  // Nothing survived cleaning: say how many names are being withheld rather
  // than render an empty list, which would read as "no names in the file".
  if (printed.length === 0) return hidden > 0 ? `${hidden} unprintable` : ''
  return hidden > 0 ? `${printed.join(', ')}, +${hidden} more` : printed.join(', ')
}

/**
 * The upstreams the gateway's config asked for and did not get, or `undefined`
 * when it got everything it asked for (which includes asking for nothing).
 *
 * `compileUpstreams` drops an upstream entry missing either `name` or
 * `base_url`, per entry and without complaint. Nothing downstream can see
 * that from the routing table alone, so the gateway source reports the raw
 * configured count next to the number that fell out, and this reads the
 * difference. One comparison covers both shapes of the fault:
 *
 * - **Every entry dropped.** The routing table is empty, so the source binds
 *   no listener at all (`listening: false`). An upstream-less gateway is a
 *   legitimate config (LLP 0120: hermes composes the plugin for its
 *   materializer alone and contributes no upstream), so this cannot be a start
 *   failure any more; without a diagnostic it reports `started` and `healthy`
 *   while every client gets ECONNREFUSED.
 * - **Some entries dropped.** The table is non-empty, the proxy binds, and
 *   `listening` is never set. Nothing about that install looks wrong, and the
 *   traffic for the typo'd provider is simply never proxied or captured.
 *
 * `idle` distinguishes them so the caller can say which one happened; the two
 * are mutually exclusive by construction, so they never double-report.
 *
 * Neither shape is caught anywhere else: `@hypaware/ai-gateway` registers no
 * config section, so nothing validates upstream shape, and `diagnoseV1Config`'s
 * `gateway_missing_*_upstream` check matches an upstream by its `provider`
 * field, which a nameless entry still has.
 *
 * Counts lead, names follow, because `name` is one of the two keys whose
 * absence drops an entry: `provider = "anthropic", base_url = "..."` yields no
 * name at all yet is exactly the config that needs the warning.
 *
 * A status file written before `upstreams_dropped` existed answers only the
 * all-dropped question, from `listening: false` plus whatever it did record of
 * the configured entries. A partial loss recorded by such a build stays
 * invisible rather than being guessed at.
 *
 * `attribution` answers the question the bound-gateway message would otherwise
 * have to hedge on: see `attributeDroppedUpstreams` below.
 *
 * Every name here is the file's own, uncleaned: the counts and the attribution
 * split are decided off them, and `printableUpstreamNames` cleans and caps at
 * each point one is rendered instead. Nothing in this function may be revised
 * by what a warning line is willing to print.
 *
 * @param {SourceSnapshot[] | undefined} sources
 * @returns {{ idle: boolean, configured: number, dropped: number, names: string[], attribution: DroppedUpstreamAttribution | undefined } | undefined}
 */
function gatewayDroppedUpstreams(sources) {
  const details = gatewaySourceRawDetails(sources)
  if (!details) return undefined
  const idle = details.listening === false
  const names = stringList(details.upstreams)
  const configured = nonNegativeInt(details.upstreams_configured) ?? names.length
  const rawDropped = nonNegativeInt(details.upstreams_dropped)
  // Older status file: an idle gateway lost every entry it had by definition,
  // which is what that build's own check inferred. A bound one tells us
  // nothing, so claim nothing.
  const dropped = rawDropped ?? (idle ? configured : 0)
  if (dropped <= 0) return undefined
  const droppedNames = stringList(details.upstreams_dropped_names)
  // On the older status file the dropped names are exactly the configured
  // ones, since none survived.
  const reportedNames = droppedNames.length > 0 ? droppedNames : idle ? names : []
  return {
    idle,
    configured,
    dropped,
    names: reportedNames,
    // Only the bound gateway has a routing table for a preset to have filled,
    // so only it has this question. An idle one bound nothing, which already
    // proves no preset covered anything.
    attribution: idle ? undefined : attributeDroppedUpstreams(details, dropped, reportedNames),
  }
}

/**
 * Split the dropped upstream names into the ones an adapter preset is still
 * proxying and the ones nothing is, or `undefined` when the status file does
 * not support the split.
 *
 * A dropped entry is absent from the compiled config table by definition, and
 * `mergeUpstreams` (the gateway source) backfills a registered preset into
 * exactly the names that table is missing. So a dropped name that is also a
 * registered preset name is still routed, by the preset's own entry rather
 * than the one the operator wrote; a dropped name that is not has no route of
 * its own at all. The daemon publishes both halves already
 * (`registered_presets`, `upstreams_dropped_names`), so the message can say
 * which one happened rather than hedging over both.
 *
 * Two shapes withhold the answer rather than inventing one, because this reads
 * a *file* that some other build may have written:
 *
 * - **No `registered_presets` key.** Absent is not empty. Reading a missing
 *   field as "no presets are registered" would turn every dropped name into a
 *   confident claim of silence on a build that never recorded the list.
 * - **A drop with no name.** `name` is one of the two keys whose absence drops
 *   an entry, so an unnamed drop has nothing to intersect with, and its
 *   destination is unknowable from status. Requiring one name per dropped
 *   entry also covers the deduped case (two same-named entries both dropping
 *   yield one name for two drops), where the shortfall is real but which entry
 *   the preset covers is not decidable.
 *
 * @param {Record<string, unknown>} details
 * @param {number} dropped
 * @param {string[]} names
 * @returns {DroppedUpstreamAttribution | undefined}
 */
function attributeDroppedUpstreams(details, dropped, names) {
  if (!Array.isArray(details.registered_presets)) return undefined
  if (names.length !== dropped) return undefined
  const presets = new Set(stringList(details.registered_presets))
  return {
    covered: names.filter((n) => presets.has(n)),
    silent: names.filter((n) => !presets.has(n)),
  }
}

/**
 * What a bound gateway's dropped upstreams mean for the traffic aimed at them.
 *
 * Two fates, and they are not close: a name no preset covers has no entry in
 * the routing table at all, while a name a preset covers has one, backfilled
 * from the preset rather than from what the operator wrote. Both are worth
 * the warning and they call for different fixes, so when `attribution` can
 * tell them apart the message names each set rather than hedging across both.
 *
 * Every clause is a claim about the *routing table*, never about the traffic,
 * because the table is all a name-set intersection can reach. Routing is by
 * `path_prefix` and `match()` and then by rank (`matchUpstream` and
 * `compileUpstreams` in the gateway's `proxy.js` sort on `priority`, then
 * prefix length, then merge order), and none of that is published:
 *
 * - **A dropped name is not a dead path.** A surviving upstream written with
 *   no `path_prefix` compiles to `/`, which `pathMatchesPrefix` matches every
 *   path against, so a request aimed at the dropped name can still be proxied
 *   and recorded - under the *other* upstream's name. The gateway source says
 *   the same where it logs this fault ("falls through to whatever the
 *   remaining routes match (or nothing)"). Hence "under the name X", with the
 *   fall-through spelled out, rather than a flat claim that nothing happens.
 * - **A covered name is a table entry, not a guarantee of traffic.** The
 *   backfilled preset can be shadowed outright: `mergeUpstreams` appends
 *   presets after the config entries, and `compileUpstreams` breaks a rank
 *   tie on that order, so a surviving config upstream at an equal
 *   `path_prefix` (or at a higher `priority`) wins every path the preset
 *   would have taken. Hence "in the routing table only as the preset", plus
 *   the outranking note, rather than "is still proxied".
 * - **A covered name loses more than its `base_url`, and not only its
 *   `path_prefix`.** `mergeUpstreams` backfills the preset's whole entry, so
 *   its `provider` and `priority` come too, and a preset carrying a `match()`
 *   (which every bundled adapter preset does) routes by that function while
 *   `path_prefix` degrades to a sort key `matchUpstream` never consults. The
 *   claude preset's `match()` takes `/v1/complete` and any anthropic-headered
 *   path, so naming `path_prefix` as "what is in force" understates its
 *   reach as badly as it overstates the operator's. Hence "routing rules".
 *
 * The hedge survives for the case that still deserves it, where the status
 * file does not say which of the two happened. It hedges only that question,
 * though. The catch-all above is a fact about the *routing table*, not about
 * the preset list, so it holds on the hedged branch identically and the
 * hedged sentence is bounded to the name in the same way. Hedging the preset
 * question is not licence to assert the traffic one: the shape that most
 * often reaches this branch is an entry that lost its `name` (nothing to
 * intersect), which is an ordinary current-build config, not only an old
 * status file.
 *
 * @ref LLP 0195#visible-when-unintended [constrained-by]: the kind still fires on the configured-vs-compiled comparison alone; this only reports which fate each dropped name met
 *
 * @param {number} dropped
 * @param {string[]} names
 * @param {DroppedUpstreamAttribution | undefined} attribution
 * @returns {string}
 */
function droppedUpstreamConsequence(dropped, names, attribution) {
  if (!attribution) {
    // Labelled, because unlike the idle branch these are not the configured
    // set: an unlabelled `(openai)` next to "2 configured upstreams" invites
    // exactly the wrong reading.
    const printed = printableUpstreamNames(names)
    const named = printed.length > 0 ? ` (dropped: ${printed})` : ''
    const oneEntry = dropped === 1
    // The entry nouns count entries and the name nouns count names, because
    // the two differ: the dedupe in `readConfiguredUpstreams` prints one name
    // for two same-named dropped entries, which is one of the shapes that
    // lands here. With no names to print at all there is nothing to
    // disagree with, so the entry count stands in.
    const oneName = (names.length > 0 ? names.length : dropped) === 1
    return `${oneEntry ? 'that entry is' : 'those entries are'} not in the routing table${named}, so unless an adapter preset already covers the same ${oneName ? 'name' : 'names'}, nothing is proxied or captured under ${oneName ? 'that name' : 'those names'}, and ${oneName ? 'a request' : 'requests'} aimed at ${oneName ? 'it' : 'them'} ${oneName ? 'gets' : 'get'} a 404 or ${oneName ? 'falls' : 'fall'} through to whatever surviving route ${oneName ? 'its path matches' : 'their paths match'}`
  }
  /** @type {string[]} */
  const parts = []
  const { silent, covered } = attribution
  // Each set's grammar counts the names the *file* holds, not the ones this
  // line prints, so cleaning and capping cannot make a plural set read as a
  // singular one.
  // Silence leads: it is the more damaging of the two, and the reason the
  // operator is reading this line at all.
  if (silent.length > 0) {
    const one = silent.length === 1
    parts.push(
      `nothing is proxied or captured under the ${one ? 'name' : 'names'} ${printableUpstreamNames(silent)} (no adapter preset covers ${one ? 'that name' : 'those names'}), so ${one ? 'a request' : 'requests'} aimed at ${one ? 'it' : 'them'} ${one ? 'gets' : 'get'} a 404 or ${one ? 'falls' : 'fall'} through to whatever surviving route ${one ? 'its path matches' : 'their paths match'}`,
    )
  }
  if (covered.length > 0) {
    const one = covered.length === 1
    parts.push(
      `${printableUpstreamNames(covered)} ${one ? 'is' : 'are'} in the routing table only as the adapter ${one ? 'preset' : 'presets'} registered under the same ${one ? 'name' : 'names'}, so ${one ? "that preset's" : "each preset's"} own base_url and routing rules are in force, nothing this config set for ${one ? 'it' : 'them'} took effect, and a surviving upstream can still outrank ${one ? 'the preset' : 'a preset'} on any path`,
    )
  }
  return parts.join('; ')
}

/** @param {unknown} v @returns {string[]} */
function stringList(v) {
  if (!Array.isArray(v)) return []
  return /** @type {string[]} */ (v.filter((s) => typeof s === 'string' && s.length > 0))
}

/** @param {unknown} v @returns {number | undefined} */
function nonNegativeInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
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
  out.sort((a, b) => compareStrings(b.lastSeen, a.lastSeen))
  // Sorted before the cap so the entries kept are the most recently seen ones,
  // which is the same entry a "recent clients" readout would keep anyway.
  return out.slice(0, MAX_RECENT_ENTRYPOINTS)
}

/* ---------- maintenance skips (LLP 0228) ---------- */

/**
 * How many skipped partitions the standing surface names. The counts beside
 * the list are exact, so this bounds the terminal block and the status file
 * without hiding the size of the problem; `hyp query maintain` is where an
 * operator enumerates every one. Eight is a screenful, and a cache with more
 * than eight frozen partitions has a story the count already tells.
 */
export const MAX_SKIPPED_PARTITIONS_REPORTED = 8

/** Every reason id, in the order the render lists them. */
const MAINTENANCE_SKIP_REASONS = Object.freeze(
  /** @type {MaintenanceSkipReason[]} */ (['compaction_ineffective', 'compaction_attempt_failed'])
)

/**
 * The reason breakdown as one phrase, e.g. `2 compaction_ineffective, 1
 * compaction_attempt_failed`. Reasons no partition was skipped for are left
 * out rather than printed as zeros, and the ids are printed verbatim: they
 * are the span attribute names, so this phrase is also the trace query
 * (LLP 0228#reason-ids-are-span-attribute-names).
 *
 * Both call sites interpolate this unconditionally into a sentence that
 * already committed to a parenthetical, so an empty phrase would render as a
 * bare `()`. That is unreachable from a snapshot this build wrote (every
 * skip has one of the two known reasons by construction), but not from a
 * `status.json` a later build wrote: LLP 0228#consequences names a third
 * reason id as exactly the kind of extension this shape absorbs, and a
 * snapshot whose only nonzero reasons are ones this build does not
 * recognize is precisely `skippedTotal > 0` with every known count at zero.
 * The fallback names that case instead of leaving the parenthetical empty.
 *
 * @param {Record<MaintenanceSkipReason, number>} reasons
 * @returns {string}
 */
export function describeMaintenanceSkipReasons(reasons) {
  const phrase = MAINTENANCE_SKIP_REASONS
    .filter((reason) => (reasons[reason] ?? 0) > 0)
    .map((reason) => `${reasons[reason]} ${reason}`)
    .join(', ')
  return phrase === '' ? 'reasons this build does not recognize' : phrase
}

/**
 * The partition tuple as one label: exactly the shape `hyp query maintain`
 * prints after the dataset name, so the same partition reads identically on
 * both surfaces.
 *
 * @param {Record<string, string> | undefined} partition
 * @returns {string}
 */
function partitionLabel(partition) {
  if (!isPlainObject(partition)) return 'all'
  const parts = Object.entries(partition)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `${k}=${v}`)
  return parts.length > 0 ? parts.join('/') : 'all'
}

/**
 * Why this tick left the partition fragmented, or undefined when it did not.
 *
 * A partition the tick *rewrote* is not on this surface even when the rewrite
 * achieved nothing: that is a run that did work, and the verdict it recorded
 * puts the partition on the next tick's snapshot as a skip. What this names is
 * the standing state, the partition the kernel has stopped rewriting.
 *
 * @param {MaintenancePartitionReport} p
 * @returns {MaintenanceSkipReason | undefined}
 * @ref LLP 0218#verdict-outranks-error [constrained-by]: maintenance already makes the two mutually exclusive, so this order only has to agree about which one a reader is owed if that ever stops holding
 */
function skipReasonOf(p) {
  if (p.compacted || p.rebaselined) return undefined
  if (p.compactionIneffective) return 'compaction_ineffective'
  if (p.compactionAttemptFailed) return 'compaction_attempt_failed'
  return undefined
}

/**
 * Summarize a maintenance tick's report into the snapshot the daemon persists
 * (`DaemonStatus.maintenance`). Pure, and deliberately cheap: it reads the
 * report the walk already produced and stats nothing, because proving a
 * skipped partition is also still fragmented is the per-tick cost the LLP 0199
 * baseline gate exists to avoid.
 *
 * A tick that skipped nothing still produces a snapshot (all-zero counts, an
 * empty list). The snapshot is the *current* answer, so a partition that
 * thawed has to be able to leave it.
 *
 * @param {MaintenanceReport} report
 * @param {{ at?: string }} [opts]
 * @returns {MaintenanceSkipSnapshot}
 * @ref LLP 0228#last-tick-only [implements]: one bounded snapshot per tick, named partitions capped and taken in the walk's own neediest-first order
 */
export function summarizeMaintenanceSkips(report, opts = {}) {
  const visited = Array.isArray(report?.partitions) ? report.partitions : []
  /** @type {Record<MaintenanceSkipReason, number>} */
  const reasons = { compaction_ineffective: 0, compaction_attempt_failed: 0 }
  /** @type {MaintenanceSkippedPartition[]} */
  const partitions = []
  let skippedTotal = 0
  for (const p of visited) {
    const reason = skipReasonOf(p)
    if (reason === undefined) continue
    reasons[reason] += 1
    skippedTotal += 1
    // No sort: the report is already in walk order, which is descending live
    // data-file count (LLP 0199#neediest-first), so the first entries past the
    // cap are the most fragmented ones by construction.
    if (partitions.length >= MAX_SKIPPED_PARTITIONS_REPORTED) continue
    partitions.push({
      // Sanitized here too, not only on read: LLP 0228#last-tick-only says the
      // cap and the sanitizing are both re-applied on read, which only holds
      // if the write side already produced a clean label. `dataset` and
      // `partition` are kernel-side identifiers in the ordinary case, but
      // `partition`'s values come off a captured row's `client_name` by way
      // of `resolveSourceSegments` -> `sanitizePathSegment`, which strips only
      // path-hostile bytes and applies no length clamp or bidi/zero-width
      // filtering. Unsanitized here, the daemon log line at
      // `runtime.js`'s `worst` field (which reads `partitions[0]` straight)
      // would be the one surface on this path with nothing downstream to
      // clean it.
      // @ref LLP 0228#last-tick-only [implements]: the write side sanitizes and clamps, not only the read side
      dataset: sanitizeLabel(p.dataset) ?? 'unknown',
      partition: sanitizeLabel(partitionLabel(p.partition)) ?? 'all',
      reason,
      // The count the recorded rewrite ran over, not the live one: the same
      // distinction `hyp query maintain` draws, for the same reason.
      ...(reason === 'compaction_ineffective' && typeof p.compactionIneffectiveFiles === 'number'
        ? { dataFiles: p.compactionIneffectiveFiles }
        : {}),
      ...(reason === 'compaction_attempt_failed' && typeof p.compactionAttemptFailedAt === 'string'
        ? { failedAt: p.compactionAttemptFailedAt }
        : {}),
    })
  }
  return {
    tickAt: opts.at ?? new Date().toISOString(),
    partitionsVisited: visited.length,
    skippedTotal,
    reasons,
    partitions,
  }
}

/**
 * Lift the maintenance snapshot out of a status file, or null when no daemon
 * has reported a tick for this state root.
 *
 * Validated, sanitized and re-capped on read as well as on write, for the
 * reason `recentEntrypointsFromSources` states: `status.json` is a file, this
 * build did not necessarily write it, and everything here is about to be
 * printed to a terminal. Dataset and partition labels are the only free-form
 * strings on the path and both are kernel-side identifiers, but they are
 * cleaned anyway rather than trusted.
 *
 * Not liveness-gated, for LLP 0164's reason: "these partitions were frozen as
 * of the tick at T" stays true after the daemon exits, and the rendered age
 * carries the staleness.
 *
 * @param {DaemonStatus | null} status
 * @returns {MaintenanceSkipSnapshot | null}
 * @ref LLP 0228#status-file-is-the-surface [implements]: hyp status answers from status.json rather than running a second maintenance walk
 */
export function maintenanceSkipsFromStatus(status) {
  const raw = status?.maintenance
  if (!isPlainObject(raw)) return null
  const tickAt = raw.tickAt
  // No timestamp, no snapshot: every render of this block is relative to when
  // the tick ran, and "frozen, at some unknown time" is not worth printing.
  if (typeof tickAt !== 'string' || Number.isNaN(Date.parse(tickAt))) return null

  const rawReasons = isPlainObject(raw.reasons) ? raw.reasons : {}
  /** @type {Record<MaintenanceSkipReason, number>} */
  const reasons = { compaction_ineffective: 0, compaction_attempt_failed: 0 }
  for (const reason of MAINTENANCE_SKIP_REASONS) {
    reasons[reason] = nonNegativeInt(rawReasons[reason]) ?? 0
  }

  /** @type {MaintenanceSkippedPartition[]} */
  const partitions = []
  const rawPartitions = Array.isArray(raw.partitions) ? raw.partitions : []
  for (const item of rawPartitions) {
    if (partitions.length >= MAX_SKIPPED_PARTITIONS_REPORTED) break
    if (!isPlainObject(item)) continue
    const reason = item.reason
    // An unknown reason id is dropped rather than printed: a name this build
    // cannot explain is worse than a shorter list, and the counts above still
    // account for it.
    if (typeof reason !== 'string' || !MAINTENANCE_SKIP_REASONS.includes(/** @type {MaintenanceSkipReason} */ (reason))) continue
    const dataset = sanitizeLabel(item.dataset)
    const partition = sanitizeLabel(item.partition)
    if (dataset === undefined || partition === undefined) continue
    const dataFiles = nonNegativeInt(item.dataFiles)
    const failedAt = sanitizeLabel(item.failedAt)
    partitions.push({
      dataset,
      partition,
      reason: /** @type {MaintenanceSkipReason} */ (reason),
      ...(dataFiles !== undefined ? { dataFiles } : {}),
      ...(failedAt !== undefined ? { failedAt } : {}),
    })
  }

  const recordedTotal = nonNegativeInt(raw.skippedTotal)
    ?? MAINTENANCE_SKIP_REASONS.reduce((sum, reason) => sum + reasons[reason], 0)
  return {
    tickAt,
    // Floored at the skipped total (and the named list, which the total
    // itself is already floored at below): "visited" can never be smaller
    // than "skipped", or the render says "5 of 0 partitions" for a snapshot
    // no tick could have produced. A file this build did not write can claim
    // whatever it wants here, so the floor is enforced rather than trusted.
    partitionsVisited: Math.max(nonNegativeInt(raw.partitionsVisited) ?? 0, recordedTotal, partitions.length),
    // The list is capped, so the count leads; but a count smaller than the
    // list would render "2 partitions" above three lines of them.
    skippedTotal: Math.max(recordedTotal, partitions.length),
    reasons,
    partitions,
  }
}

/**
 * Resolve the AI gateway's live bound base URL from the on-disk daemon status
 * snapshot, **guarded by a daemon-liveness check** so a stale snapshot from a
 * dead daemon is never handed back. Returns `undefined` when no daemon is
 * running for this state root, no status file exists, or the gateway source
 * recorded no bound port.
 *
 * This is the discovery mechanism manual `hyp client attach` uses on a default
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

/**
 * Resolve a named listener source's live bound `listen_port` from the on-disk
 * daemon status snapshot, behind the same daemon-liveness gate as
 * {@link resolveLiveGatewayEndpointFromStatus}: a stale snapshot from a dead
 * daemon is never handed back, and no port is ever fabricated.
 *
 * The generic sibling of the gateway resolver above, for sources that publish
 * `details.listen_port` (the OTLP receiver, the Claude telemetry listener).
 * The first consumer is `hyp client attach claude` in `otel` mode: only the running
 * daemon knows which port the listener actually bound (its configured default,
 * or the ephemeral fallback when that port was taken), so the endpoint attach
 * writes must come from here whenever a daemon is up.
 *
 * @param {{ stateRoot: string, sourceName: string }} args
 * @returns {number | undefined}
 */
export function resolveLiveSourceListenPortFromStatus({ stateRoot, sourceName }) {
  const list = liveStatusSources(stateRoot)
  if (!list) return undefined
  const source = list.find((s) => s && s.name === sourceName)
  const details = sourceDetails(source)
  const port = details?.listen_port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined
  }
  return port
}

/**
 * Every live source advertising a named `/_hypaware/` control route in its
 * status details (`control_routes`), resolved to the base URL of its bound
 * listener.
 *
 * This is how `hyp session ignore` / `unignore` finds the recorders beyond
 * the gateway: a recorder that hosts the route says so in its own status
 * details, so the verb stays client-agnostic and a listener that is not
 * running (absent from a live snapshot, or no live daemon at all) is simply
 * not addressed - it is recording nothing, so there is nothing to notify.
 * The gateway itself is NOT discovered here; its endpoint has its own,
 * richer resolution (`status.json` plus the pinned `listen` fallback).
 *
 * @ref LLP 0256#cli-posts-to-both [implements]: the CLI addresses every
 * listener that offers the route; offering is advertised, never guessed
 * @param {{ stateRoot: string, route: string }} args
 * @returns {Array<{ source: string, endpoint: string }>}
 */
export function resolveLiveControlRouteEndpointsFromStatus({ stateRoot, route }) {
  const list = liveStatusSources(stateRoot)
  if (!list) return []
  /** @type {Array<{ source: string, endpoint: string }>} */
  const out = []
  for (const source of list) {
    if (!source || typeof source.name !== 'string') continue
    const details = sourceDetails(source)
    const routes = details?.control_routes
    if (!Array.isArray(routes) || !routes.includes(route)) continue
    const port = details?.listen_port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) continue
    const host = typeof details?.listen_host === 'string' && details.listen_host.length > 0
      ? details.listen_host
      : '127.0.0.1'
    const endpoint = endpointFromListen(`${host}:${port}`)
    if (endpoint) out.push({ source: source.name, endpoint })
  }
  return out
}

/**
 * The liveness-gated snapshot read shared by the resolvers above: a live pid
 * and a readable status file, or nothing. A `status.json` outlives its
 * daemon, so a bound port in it proves nothing without a living process
 * behind the pid file.
 *
 * @param {string} stateRoot
 * @returns {SourceSnapshot[] | undefined}
 */
function liveStatusSources(stateRoot) {
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
  return Array.isArray(status?.sources) ? status.sources : []
}

/**
 * @param {SourceSnapshot | undefined} source
 * @returns {Record<string, unknown> | undefined}
 */
function sourceDetails(source) {
  return source && typeof source.details === 'object' && source.details !== null
    ? /** @type {Record<string, unknown>} */ (source.details)
    : undefined
}

/**
 * How long the daemon's own status snapshot may go unwritten before
 * `hyp status` stops believing the `state` recorded in it.
 *
 * The daemon persists that snapshot at the end of every tick, and the tick
 * interval is fixed at 60s outside the test harnesses, so this is five
 * consecutive missed ticks. It is deliberately several ticks wide: one slow
 * tick is ordinary (the sink export runs inside it), and a status command
 * that flickered to `degraded` whenever an export ran long would be worse
 * than the bug it is here to catch. It is also the reason the window is not
 * tighter: the daemon's timers do not fire while the machine is asleep, so a
 * host that just woke reads as stale until its next tick lands.
 *
 * @ref LLP 0348#the-window [implements]: several missed ticks, not one
 */
export const DAEMON_HEARTBEAT_STALE_MS = 5 * 60_000

/**
 * How long ago the daemon last wrote its status snapshot, derived from the
 * two fields the snapshot already carries: `persist()` recomputes `uptimeMs`
 * as `now - healthyAt` immediately before every write, so `healthyAt +
 * uptimeMs` *is* the moment of that write. Nothing new has to be recorded
 * for the heartbeat to be readable.
 *
 * Returns `null` when the snapshot has never reached `healthy` (a daemon
 * still booting has no heartbeat to be late for) or when either field is
 * missing or unusable, which is also how a status file written by an older
 * build reads.
 *
 * @param {DaemonStatus | null | undefined} status
 * @param {number} nowMs
 * @returns {number | null}
 * @ref LLP 0348#heartbeat-is-derived [implements]: healthyAt + uptimeMs is the last persist, so no new status field is minted
 */
export function daemonHeartbeatAgeMs(status, nowMs) {
  const healthyAtMs = parseIsoMs(status?.healthyAt)
  if (healthyAtMs === undefined) return null
  const uptimeMs = status?.uptimeMs
  if (typeof uptimeMs !== 'number' || !Number.isFinite(uptimeMs) || uptimeMs < 0) return null
  return nowMs - (healthyAtMs + uptimeMs)
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
  const homeDir = opts.homeDir ?? env.HOME ?? process.env.HOME ?? os.homedir()

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
  const heartbeatAgeMs = daemon.running && snapshotIsThisProcess
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

  // ----- partitions maintenance left fragmented (LLP 0228) -----
  // Same route and the same reason as the block above: the daemon runs the
  // hourly walk, and `hyp status` reads no cache, so answering this any other
  // way would mean firing a second maintenance walk from a status command.
  const maintenance = maintenanceSkipsFromStatus(daemonStatusFile)
  if (maintenance && maintenance.skippedTotal > 0) {
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
        'hyp query maintain --force',
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
      // @ref LLP 0139#repair-must-be-runnable [constrained-by]: a repair has to be a step that changes something, so the inert validate command gives way to the edit that fixes it
      repair: [
        `add the missing 'name' / 'base_url' to each upstream in ${configPath} ('hyp config validate' does not check upstream shape)`,
        `hyp daemon restart  # the daemon reads the file only at boot`,
      ],
    })
  }
  /** @type {ClientAttachReport[]} */
  const clients = []
  /** @type {CaptureHealthReport[]} */
  const captureHealth = []
  const clientDescriptors = catalog?.clientDescriptors ?? new Map()
  for (const [clientName, descriptor] of clientDescriptors) {
    const configured = activePlugins.includes(descriptor.plugin)
    // Attach state is only a real state for a client that declares an
    // `attach_probe`. Without one there is no settings-file write to read back,
    // `action_attach.desired()` skips the descriptor for exactly that reason
    // (attach must be reversible), so no attach is ever performed and no marker
    // is ever written. Deriving `attached: false` from that silence is the wrong
    // negative indistinguishable from a right one (#544): the honest answer is
    // "not applicable", so the two surfaces that report attach *state* (the
    // clients row, and the attach action in `buildClientActionsReport`) read
    // this flag rather than a probe result that was never taken. The
    // `client_attach_missing` diagnostic just below deliberately does not.
    // @ref LLP 0229#status-derives-by-the-same-gate [implements]: a probe-less client is unattachable, not unattached
    const attachable = !!descriptor.attachProbe
    const probe = attachable
      ? await probeClientAttachFromDescriptor({ descriptor, homeDir, env })
      : { attached: false }
    clients.push({
      name: clientName,
      plugin: descriptor.plugin,
      configured,
      attachable,
      attached: probe.attached,
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
    // Deliberately ungated by `attachable`, unlike the two derived-state
    // surfaces above and below. This is not attach state: it is the standing
    // incomplete-setup prompt LLP 0224 #repair-surface leans on after it
    // stopped the wizard re-offering setup on every reconfigure. For a
    // probe-less client it cannot be cleared by observation, which LLP 0224
    // records as a known limitation with its own named follow-up (give Desktop
    // a plist-reading probe); until that lands, an unclearable prompt beats the
    // only alternative, which is no surface at all.
    // @ref LLP 0229#diagnostic-is-out-of-scope [constrained-by]: the gate governs derived attach state, not the setup-completeness prompt
    if (configured && !probe.attached) {
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
      const lastTranscriptActivityAt =
        (await probeClientActivityFromDescriptor({ descriptor, homeDir, env })) ?? null
      const attachedAt = probe.attachedAt ?? null
      // Live daemon only, deliberately. A dead daemon's snapshot still carries
      // the moment its listener started, but that moment stopped bounding
      // anything when the process ended, and the dead-daemon gap is the one
      // this line most needs to keep reporting.
      const listenerStartedAt = daemon.running && typeof listenerDetails?.listener_started_at === 'string'
        ? listenerDetails.listener_started_at
        : null
      const verdict = assessCaptureHealth({
        lastEventAt,
        lastTranscriptActivityAt,
        attachedAt,
        listenerStartedAt,
      })
      captureHealth.push({
        client: clientName,
        plugin: descriptor.plugin,
        source: listenerSnap?.name ?? null,
        lastEventAt,
        lastTranscriptActivityAt,
        attachedAt,
        listenerStartedAt,
        gapMs: verdict.gapMs,
        state: verdict.state,
      })
      if (verdict.state === 'gap' && verdict.severity !== undefined) {
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
  if (remoteConfig?.lastRollback) {
    // The three values in this message are display-only, and none of them is
    // this build's own: the etag is whatever the joined server served, and
    // all three come back through `config-control/state.json`, which is read
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
    diagnostics.push({
      severity: 'warning',
      kind: 'remote_config_rolled_back',
      message: `remote config ${sanitizeLabel(rolledBack.etag) ?? ''} rolled back at ${sanitizeLabel(rolledBack.at) ?? ''} (${sanitizeLabel(rolledBack.reason) ?? ''})`,
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
  const recentErrors = await countRecentErrors(stateRoot)
  const recentErrorCount = recentErrors.total
  if (recentErrorCount > 0) {
    diagnostics.push({
      severity: 'warning',
      kind: 'recent_errors',
      // The breakdown is the pointer: "in the daemon log" and "failed sink
      // export batches" are different places to look and different repairs,
      // and a bare total sends the operator to the wrong one. It is prose
      // only - no new report field is minted for it (LLP 0349#one-number).
      message: `${recentErrorCount} error${recentErrorCount === 1 ? '' : 's'} recorded in the last ${RECENT_ERROR_WINDOW_HOURS}h (${recentErrors.breakdown.join('; ')})`,
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
  // it cannot reach this computation. A `capture_gap` that escalated to
  // `error` severity degrades through the severity rule below by design
  // (LLP 0262 open question 1): silent session loss is an outage, not an
  // unfinished setup.
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
    configRecordsAnswer,
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
    maintenance,
    captureHealth,
    cacheFlushFailures,
    cacheFlushFailuresTotal,
    proxyTrust,
    selfUpdate: describeSelfUpdate({ stateRoot, env }),
  }
}

/**
 * How long either trust probe may take before `hyp status` gives up on it.
 *
 * Both are table reads (`security verify-cert` against a local root with no
 * AIA to chase, `launchctl getenv`), so the bound is not a performance
 * budget: it is there because a locked login keychain can put `security`
 * behind a GUI prompt, and `hyp status` is a report, not a dialog - nobody
 * is watching it who could decide to stop waiting. Timing out reports
 * `unknown` for that half, which is the honest answer and is exactly what
 * the probe-failure path already renders.
 */
const TRUST_PROBE_TIMEOUT_MS = 5_000

/**
 * Proxy mode's two invisible preconditions, read once so `hyp status` can
 * state them: does the login keychain still trust the CA on disk
 * (LLP 0237), and is `NODE_USE_SYSTEM_CA` live in the launchd user
 * environment (LLP 0239)? Neither is inferable from anything else the
 * report carries, and a CA re-mint strands the first silently, so an attach
 * that worked last month can stop working with every other line healthy.
 *
 * Null rather than a row of unknowns when the question does not apply: off
 * darwin neither mechanism exists (LLP 0237#darwin-only, LLP 0239's
 * "non-macOS platforms skip this entirely"), and with no CA on disk proxy
 * mode was never on, so there is nothing to be trusted or untrusted.
 *
 * The two probes shell out, so each is settled independently: a probe that
 * could not run reports `null` (unknown), never `false`, because "the
 * dialog was cancelled" and "`security` did not run" are different answers
 * and only the first is actionable. "Did not run" covers one case a try/catch
 * cannot reach on its own: a probe that never returns. Both probes therefore
 * spawn on a deadline (`TRUST_PROBE_TIMEOUT_MS`) and reject when it passes,
 * and they are started concurrently so the worst case is one deadline rather
 * than the sum of both. An offline or captive-portal host, where macOS trust
 * evaluation can sit on a revocation fetch indefinitely, then still gets a
 * rendered report with these lines unknown instead of a `hyp status` that
 * never prints. The fingerprint is computed locally from the DER and is
 * `[0-9A-F:]` by construction, and probe stderr is deliberately not surfaced,
 * so neither of those needs sanitizing.
 *
 * The permitted host set travels with the fingerprint because the grant is
 * wider than any one install uses: the CA is constrained to the whole static
 * provider set, so a user who trusts it while capturing only Claude still
 * carries a grant covering `api.openai.com` and `chatgpt.com`. The attach
 * dialog names them; so must this, or the standing grant is only ever stated
 * once, at the moment it is asked for. The strings come from the DER's own
 * permitted subtrees, so they are the grant itself rather than a
 * config-derived guess that could drift from it.
 *
 * That last property is also why the hosts are the one field here that does
 * need sanitizing (LLP 0225): they are bytes off disk rather than strings we
 * wrote, so a foreign or damaged certificate at the CA path can carry an
 * `ESC` run, a newline, or ten thousand subtrees into a line `hyp status`
 * prints. `displayableCaHosts` is that policy, shared with the attach dialog
 * that names the same grant, and applied here at collection like every other
 * label in this file so `--json` carries exactly what was printed.
 *
 * The effective config rides along because the CA alone cannot say whether
 * it is live or residue: `proxy_mode: true` makes the gateway re-mint and
 * present it on every start, and that is the difference between "this file
 * is safe to purge" and "purging this file breaks the running interception".
 *
 * @param {object} args
 * @param {NodeJS.Platform} args.platform
 * @param {string} args.stateRoot
 * @param {HypAwareV2Config | null} args.config
 * @param {(args: { certPath: string }) => Promise<boolean>} args.isCaTrustedFn
 * @param {() => Promise<boolean>} args.isLaunchdEnvSetFn
 * @returns {Promise<ProxyTrustReport | null>}
 * @ref LLP 0237#consequences [implements]: hyp status reports the trust state alongside the CA fingerprint, so a cancelled dialog is diagnosable without re-running attach
 * @ref LLP 0238#consequences [implements]: hyp status names all permitted hosts, so a grant wider than the configured providers stays informed
 * @ref LLP 0239#terminals-predating-attach [implements]: hyp status reports whether the variable is present in the launchd environment
 */
async function collectProxyTrust({ platform, stateRoot, config, isCaTrustedFn, isLaunchdEnvSetFn }) {
  if (platform !== 'darwin') return null
  /** @type {LocalCaInfo | undefined} */
  let ca
  try {
    ca = await readLocalCaInfo({ stateRoot })
  } catch {
    return null
  }
  if (!ca) return null

  // Started together, not one after the other: the two probes read
  // unrelated system state (the login keychain, the launchd environment) and
  // neither reads the other's answer, so serializing them only adds their
  // deadlines. On the wedged host this bound exists for that is the
  // difference between the report stalling for one probe timeout and for
  // two. `allSettled` keeps the per-probe independence the catches gave: one
  // rejection reports its own line unknown and leaves the other's answer.
  const [trustedResult, launchdResult] = await Promise.allSettled([
    isCaTrustedFn({ certPath: ca.certPath }),
    isLaunchdEnvSetFn(),
  ])
  /** @type {boolean | null} */
  const trusted = trustedResult.status === 'fulfilled' ? trustedResult.value : null
  /** @type {boolean | null} */
  const launchdEnvSet = launchdResult.status === 'fulfilled' ? launchdResult.value : null

  // Tri-state for the same reason the two probes above are: a plain `false`
  // sends the caller's note to "this CA is residue, purge it", which is the
  // wrong advice for a machine whose gateway is still intercepting. `config`
  // is null when the local config would not parse and no central layer covers
  // for it, and a config we could not read is not a config with `proxy_mode`
  // off. A disabled gateway entry is skipped for the same reason
  // `activePlugins` skips it: it is not what runs.
  /** @type {boolean | null} */
  const proxyModeConfigured = config === null
    ? null
    : (config.plugins ?? []).some(
      (entry) =>
        entry.name === GATEWAY_PLUGIN_NAME &&
        entry.enabled !== false &&
        entry.config?.proxy_mode === true
    )

  return {
    caFingerprint: ca.fingerprint,
    hosts: displayableCaHosts(ca.hosts),
    trusted,
    launchdEnvSet,
    proxyModeConfigured,
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
  /** @type {Map<string, { onJoin: boolean, inert?: boolean }>} */
  const declaredAttach = new Map()
  for (const [clientName, descriptor] of clientDescriptors ?? new Map()) {
    const entry = enabledByPlugin.get(descriptor.plugin)
    if (!entry) continue
    // A probe-less descriptor is the third way the reconciler is a no-op, next
    // to `on_join: false` and a non-joined host. `desired()` skips it because
    // attach must be reversible and only the probe can reverse it, so no marker
    // will ever appear and `pending` would be permanent (#544). Same shape as
    // the `readAttachPolicy` sharing above: status must not derive a target the
    // reconciler would never name.
    // @ref LLP 0229#status-derives-by-the-same-gate [implements]: a probe-less attach target is n/a, never pending
    const inert = !descriptor.attachProbe
    const raw = entry.config?.attach
    const hasBlock = !!raw && typeof raw === 'object' && !Array.isArray(raw)
    if (hasBlock) {
      const onJoin = readAttachPolicy(entry).onJoin !== false
      declaredAttach.set(clientName, { onJoin, inert })
    } else if (hasCentral) {
      declaredAttach.set(clientName, { onJoin: true, inert })
    }
  }

  // Kinds to render: every kind the markers record, plus a kind for each
  // handler that declared a target (so a configured-but-unrun target shows even
  // with no marker yet). `backfill` keys by plugin, `attach` by client name.
  /** @type {Record<string, Map<string, { onJoin: boolean, inert?: boolean }>>} */
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
        // (on_join:false), inert (host never joined, or the handler's own
        // `desired()` would skip this target) → the reconciler is a no-op →
        // n/a; otherwise desired and simply not run yet → pending.
        const decl = declaredForKind?.get(requestKey)
        const suppressed = decl ? !decl.onJoin || decl.inert === true : false
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
  return sources.sort((a, b) => compareStrings(a.name, b.name))
}

/**
 * Every table carrying a readable flush-failure stamp, newest failure first,
 * all of them. The eight-line cap is the text renderer's, a terminal
 * legibility bound, and `--json` is the pointer that cap's overflow line
 * names, so the collector must hand over the whole list: each entry is
 * individually bounded (a 120-character label, a 512-character message), the
 * array was always built whole in memory before any cap, and this report is
 * built per invocation and never persisted, so there is no status.json
 * growth to bound and no read-back to re-clamp, which is what forced the
 * maintenance snapshot's cap onto both planes.
 * @ref LLP 0330#count-beside-cap [implements]: the machine plane is uncapped, because it is where the text cap's pointer points
 *
 * `stillCoolingDown` is the difference between "the automatic retry is being
 * held off right now" and "an old failure that nothing has cleared", which
 * reads the same on disk and very differently to an operator.
 *
 * `total` rides beside the list even though it now always equals its length:
 * it shipped as a stable `--json` key, the text plane's overflow arithmetic
 * reads it, and the equality is an invariant a consumer may rely on.
 *
 * @param {string} cacheRoot
 * @param {number} [nowMs]
 * @returns {Promise<{ total: number, failures: CacheFlushFailureReport[] }>}
 */
async function collectCacheFlushFailures(cacheRoot, nowMs = Date.now()) {
  /** @type {CacheFlushFailureReport[]} */
  const failures = []
  for (const tablePath of await discoverSpoolTables(cacheRoot)) {
    const failure = await readFlushFailure(tablePath)
    if (!failure) continue
    // A path, so cleaned as a name: it is filesystem-sourced and reaches a
    // TTY. Cleaned on the write side and not only on read, the rule
    // LLP 0228#last-tick-only settled for the sibling `dataset`/`partition`
    // labels; a spool path carries partition segments that came off a
    // captured row. The message is not a name - it is the payload the
    // operator asked for, and it is cleaned where the prose is assembled
    // (LLP 0225).
    //
    // Relative always, never `tablePath`: `discoverSpoolTables` only yields
    // directories under `<cacheRoot>/datasets`, so the relative form is at
    // minimum `datasets` and an absolute host path can never reach the
    // label. `sanitizeLabel` returning nothing is the only fallback needed.
    const relative = path.relative(cacheRoot, tablePath)
    failures.push({
      table: sanitizeLabel(relative) ?? 'unknown',
      failedAt: new Date(failure.failedAtMs).toISOString(),
      errorMessage: failure.errorMessage,
      stillCoolingDown: nowMs - failure.failedAtMs < QUERY_FLUSH_FAILURE_COOLDOWN_MS,
    })
  }
  failures.sort((a, b) => compareStrings(b.failedAt, a.failedAt) || compareStrings(a.table, b.table))
  return { total: failures.length, failures }
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
 * @returns {Promise<{ attached: boolean, settingsPath?: string, version?: string, port?: string, mode?: string, attachedAt?: string, telemetryPort?: number, error?: string }>}
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
 * Ceiling on how deep the activity-probe walk descends below the declared
 * directory. Claude transcripts sit two levels down
 * (`projects/<slug>/<session>.jsonl`) and subagent transcripts four
 * (`projects/<slug>/<session>/subagents/agent-*.jsonl`); the cap exists so a
 * manifest pointing at a pathological tree bounds the probe instead of the
 * probe walking it to the bottom.
 */
const MAX_ACTIVITY_PROBE_DEPTH = 5

/**
 * When this client last left a file behind: the newest matching mtime under
 * the descriptor's `activity_probe.dir`, as an ISO timestamp.
 *
 * This is the transcript half of the capture-health comparison, probed fresh
 * on every `hyp status` run rather than read from `status.json`, because the
 * moment it matters most is a daemon that has been down while the user
 * worked - exactly when nothing was alive to record it. It stats file
 * metadata only, never opens a file, and is best-effort like every probe in
 * this collector: any failure reads as `undefined` (no claim), never as a
 * fabricated timestamp.
 *
 * @ref LLP 0257#status-and-health [implements]: the last-transcript-activity side of the capture-health line
 * @param {{ descriptor: ClientDescriptor, homeDir: string, env?: NodeJS.ProcessEnv }} args
 * @returns {Promise<string | undefined>}
 */
export async function probeClientActivityFromDescriptor({ descriptor, homeDir, env }) {
  const probe = descriptor.activityProbe
  if (!probe || !homeDir) return undefined
  /** @type {string} */
  let dirPath
  try {
    dirPath = resolveClientSettingsPath(descriptor.name, probe.dir, env, homeDir, {
      field: 'activity_probe.dir',
    })
  } catch {
    return undefined
  }
  const newest = await newestMtimeMs(dirPath, probe.file_suffix, MAX_ACTIVITY_PROBE_DEPTH)
  return newest === undefined ? undefined : new Date(newest).toISOString()
}

/**
 * Newest mtime (epoch ms) of any matching regular file under `dir`, walked
 * to `depth` levels. Symlinks are not followed and every fs error skips the
 * entry: a probe that cannot read a corner of the tree still answers from
 * the rest of it.
 *
 * @param {string} dir
 * @param {string | undefined} suffix
 * @param {number} depth
 * @returns {Promise<number | undefined>}
 */
async function newestMtimeMs(dir, suffix, depth) {
  /** @type {Dirent[]} */
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  /** @type {number | undefined} */
  let newest
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth <= 1) continue
      const nested = await newestMtimeMs(full, suffix, depth - 1)
      if (nested !== undefined && (newest === undefined || nested > newest)) newest = nested
    } else if (entry.isFile()) {
      if (suffix !== undefined && !entry.name.endsWith(suffix)) continue
      try {
        const stat = await fsp.stat(full)
        if (newest === undefined || stat.mtimeMs > newest) newest = stat.mtimeMs
      } catch { /* raced deletion or unreadable file: skip */ }
    }
  }
  return newest
}

/**
 * Client activity newer than the capture baseline by more than this is a
 * capture gap worth a diagnostic. Under working capture the two move in near
 * lockstep - Claude Code appends the transcript and flushes the exporter on
 * the same turns, seconds apart - so the threshold only has to clear flush
 * cadence and batch timing, and fifteen minutes clears them by an order of
 * magnitude while still catching a broken path within the same sitting.
 */
export const CAPTURE_GAP_WARNING_MS = 15 * 60_000

/**
 * Past this the gap severity escalates to `error`, which degrades `overall`:
 * two hours of transcript activity with no telemetry is a whole working
 * session lost, not a timing artifact. The escalation is the "visible
 * instead of discovered at report time" duty of LLP 0262 open question 1 -
 * best-effort delivery was accepted on the condition that a silent gap
 * cannot stay silent.
 */
export const CAPTURE_GAP_ERROR_MS = 2 * 3_600_000

/**
 * Judge one otel-attached client's capture gap. Pure, so the threshold
 * contract is unit-testable without a filesystem.
 *
 * The baseline is the newest of three moments capture could be measured from:
 * the last event seen, the attach timestamp, and the running listener's own
 * start. Activity older than the attach proves nothing about the otel path
 * (the usual shape right after a migration from proxy attach, where months of
 * transcripts predate the first possible event), and a listener that has seen
 * nothing at all is measured from the attach instead. No baseline at all - no
 * events, no listener, and an unreadable attach time - reads as `ok`, because
 * a gap claim needs a moment capture was supposed to start.
 *
 * `listenerStartedAt` is the third because the listener's `lastEventAt` lives
 * only in its process: every daemon restart republishes `last_event_at: null`
 * however long capture has been healthy, and without this the baseline would
 * fall back to an attach timestamp that can be weeks old. A machine attached a
 * month ago and used an hour ago would then report a month-long gap - severity
 * `error`, degrading `overall` - immediately after a routine
 * `hyp daemon restart`, which is itself the first repair `capture_gap` prints.
 * The caller passes it ONLY for a live daemon: on a dead one the last daemon's
 * start says nothing about now, and the growing gap is precisely the thing to
 * surface.
 *
 * @ref LLP 0257#status-and-health [implements]: the gap threshold and its severity
 * @param {{ lastEventAt?: string | null, lastTranscriptActivityAt?: string | null, attachedAt?: string | null, listenerStartedAt?: string | null }} args
 * @returns {{ state: 'ok' | 'gap', gapMs: number, severity?: 'warning' | 'error' }}
 */
export function assessCaptureHealth({ lastEventAt, lastTranscriptActivityAt, attachedAt, listenerStartedAt }) {
  const transcriptMs = parseIsoMs(lastTranscriptActivityAt)
  if (transcriptMs === undefined) return { state: 'ok', gapMs: 0 }
  const eventMs = parseIsoMs(lastEventAt)
  const attachedMs = parseIsoMs(attachedAt)
  const listenerMs = parseIsoMs(listenerStartedAt)
  if (eventMs === undefined && attachedMs === undefined && listenerMs === undefined) {
    return { state: 'ok', gapMs: 0 }
  }
  const baseline = Math.max(eventMs ?? -Infinity, attachedMs ?? -Infinity, listenerMs ?? -Infinity)
  const gapMs = Math.max(0, transcriptMs - baseline)
  if (gapMs <= CAPTURE_GAP_WARNING_MS) return { state: 'ok', gapMs }
  return {
    state: 'gap',
    gapMs,
    severity: gapMs > CAPTURE_GAP_ERROR_MS ? 'error' : 'warning',
  }
}

/**
 * A gap length for diagnostic prose: coarse on purpose, like
 * `formatEntrypointAge`, because the message's claim is "a sitting" or "a
 * day", never a precise bound.
 *
 * @param {number} gapMs
 * @returns {string}
 */
export function formatGapDuration(gapMs) {
  const minutes = Math.floor(gapMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** @param {string | null | undefined} value @returns {number | undefined} */
function parseIsoMs(value) {
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
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
 * The horizon `recent_error_count` reports over. The counter had none: it
 * returned every ERROR record still on disk, so a machine that failed once in
 * March carried the warning until someone deleted the file. A day is the
 * shortest window that still spans an overnight brownout (the #1003 incident
 * ran for hours while nobody was watching), and it is self-clearing, so an
 * install that was repaired stops warning on its own.
 *
 * @ref LLP 0349#the-window [implements]: a stated 24-hour horizon, so "recent" means something and a fixed install stops warning
 */
export const RECENT_ERROR_WINDOW_HOURS = 24
export const RECENT_ERROR_WINDOW_MS = RECENT_ERROR_WINDOW_HOURS * 3_600_000

/**
 * How much of `daemon.log` is read. The file is appended to for the life of
 * the install and nothing rotates it (the note on the control-file watcher in
 * `src/core/daemon/control.js` says so in as many words), so it is the one
 * store here that could be arbitrarily large, and `hyp status` is a report
 * that must not grow a cost with the age of the machine.
 *
 * The bound is sized against the worst case the window has to hold. A daemon
 * that fails at every tick writes 1,440 records a day, and one
 * `daemon.tick_failed` line with a real message runs a little over 200 bytes,
 * so a day of them is around 300 KiB before the info and warn lines
 * interleaved with them. A quarter-megabyte tail would therefore have cut
 * inside the stated window on exactly the install that most needs counting; a
 * megabyte clears it several times over and still reads in a millisecond or
 * two. The count stays a floor rather than a census: a daemon noisy enough to
 * overflow even this reports every error the tail holds, which is emphatically
 * not zero.
 *
 * @ref LLP 0349#bounded-reads [implements]: the daemon log is read from the tail, never whole
 */
const DAEMON_LOG_TAIL_BYTES = 1024 * 1024

/**
 * The timestamp the sink driver bakes into an outbox filename. `persistOutbox`
 * writes `<batchId>.json` where `batchId` is `<instance>-<iso>-<seq>`, so the
 * age of every failed export batch is readable from the directory listing
 * alone, with no file opened. Anything that does not match is not a batch this
 * daemon wrote and is not evidence of a failure, so it is skipped rather than
 * counted.
 */
const OUTBOX_BATCH_TIMESTAMP = /-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-\d+\.json$/

/**
 * Count the failures this install has actually recorded in the last
 * {@link RECENT_ERROR_WINDOW_HOURS} hours, across every store that exists on
 * an ordinary install.
 *
 * The two stores a production install keeps are disjoint, so nothing there is
 * counted twice: `daemon.log` carries what `fileLog` emits (boot, tick,
 * reload, source and maintenance failures) and the sink driver does not write
 * to it at all, while the sink outbox carries one file per failed export batch
 * and nothing else writes one.
 *
 * `dev-telemetry/logs-*.jsonl` is the third store, and it does overlap:
 * `recordFailure` in `src/core/sinks/driver.js` logs
 * `sink.export_batch.failed` through `getLogger` for the same batch
 * `persistOutbox` has just written a file for, so with `HYP_DEV_TELEMETRY=1`
 * set one failed export is counted once here and once there. That directory
 * exists only when that variable is set, which is why this counter used to
 * read zero on every real machine and why the overlap cannot reach one. The
 * diagnostic names both halves of the breakdown, so a developer who does set
 * it can see where the doubled total came from.
 *
 * @param {string} stateRoot
 * @param {number} [nowMs]
 * @returns {Promise<{ total: number, breakdown: string[] }>}
 */
async function countRecentErrors(stateRoot, nowMs = Date.now()) {
  const sinceMs = nowMs - RECENT_ERROR_WINDOW_MS
  const [daemonLog, sinkOutbox, devTelemetry] = await Promise.all([
    countDaemonLogErrors(path.join(daemonLogDir(stateRoot), 'daemon.log'), sinceMs),
    countSinkOutboxBatches(path.join(stateRoot, 'sinks'), sinceMs),
    countDevTelemetryErrors(devTelemetryDir(stateRoot), sinceMs),
  ])
  /** @type {string[]} */
  const breakdown = []
  if (daemonLog > 0) breakdown.push(`${daemonLog} in the daemon log`)
  if (sinkOutbox > 0) breakdown.push(`${sinkOutbox} failed sink export batch${sinkOutbox === 1 ? '' : 'es'}`)
  if (devTelemetry > 0) breakdown.push(`${devTelemetry} in dev telemetry`)
  return { total: daemonLog + sinkOutbox + devTelemetry, breakdown }
}

/**
 * Is a recorded instant inside the window? A record whose timestamp is
 * missing or unreadable counts: this whole defect was a counter that stayed
 * silent about failures it could not classify, and an unparseable stamp on a
 * record that says `level: "error"` is still an error someone should see.
 *
 * @param {unknown} value
 * @param {number} sinceMs
 */
function recordedWithinWindow(value, sinceMs) {
  if (typeof value !== 'string') return true
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return true
  return at >= sinceMs
}

/**
 * Count `level: "error"` records in the tail of the daemon log. This is the
 * production-side record: `openDaemonLog` runs on every boot, in every mode,
 * with no environment variable to enable it.
 *
 * @param {string} logPath
 * @param {number} sinceMs
 * @returns {Promise<number>}
 */
async function countDaemonLogErrors(logPath, sinceMs) {
  /** @type {FileHandle} */
  let handle
  try {
    handle = await fsp.open(logPath, 'r')
  } catch {
    return 0
  }
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - DAEMON_LOG_TAIL_BYTES)
    const length = size - start
    if (length <= 0) return 0
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buf, 0, length, start)
    let text = buf.subarray(0, bytesRead).toString('utf8')
    if (start > 0) {
      // The offset lands mid-record. Drop the fragment rather than let a
      // half-line parse as something it is not.
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }
    let count = 0
    for (const line of text.split('\n')) {
      if (!line) continue
      /** @type {any} */
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      if (parsed.level !== 'error') continue
      if (!recordedWithinWindow(parsed.ts, sinceMs)) continue
      count += 1
    }
    return count
  } catch {
    return 0
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Count failed export batches still sitting in the sink outboxes. One file is
 * one batch the sink could not hand over (`persistOutbox`), which is the only
 * durable trace a sink export failure leaves on an install without dev
 * telemetry: the driver's own `sink.export_batch.failed` goes to the OTel
 * logger, which has no exporter configured on an ordinary machine.
 *
 * Nothing drains these files, so the directory is a growing ledger and the
 * window is what makes a count off it mean "now". Costs one directory listing
 * per configured sink and opens no file: the batch id carries its own
 * timestamp. The collector already walks the whole cache tree with a `stat`
 * per file (`measureCacheStats`), so this sits well inside its budget.
 *
 * @param {string} sinksDir
 * @param {number} sinceMs
 * @returns {Promise<number>}
 */
async function countSinkOutboxBatches(sinksDir, sinceMs) {
  /** @type {Dirent[]} */
  let instances
  try {
    instances = await fsp.readdir(sinksDir, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const instance of instances) {
    if (!instance.isDirectory()) continue
    /** @type {string[]} */
    let files
    try {
      files = await fsp.readdir(path.join(sinksDir, instance.name, 'outbox'))
    } catch {
      continue
    }
    for (const file of files) {
      const match = OUTBOX_BATCH_TIMESTAMP.exec(file)
      if (!match) continue
      const at = Date.parse(match[1])
      if (!Number.isFinite(at) || at < sinceMs) continue
      count += 1
    }
  }
  return count
}

/**
 * Walk the dev telemetry directory and count log entries whose `severityText`
 * is `ERROR`. Returns 0 when the directory does not exist, which on an
 * ordinary install is always: this is the developer's store, kept as one
 * input among three rather than removed, because under `HYP_DEV_TELEMETRY=1`
 * it holds every `getLogger` error, and all but one of them reach no other
 * file. The exception is the sink driver's `sink.export_batch.failed`, which
 * describes a batch the outbox has a file for; `countRecentErrors` records
 * why that overlap is left alone.
 *
 * @param {string} telemetryDir
 * @param {number} sinceMs
 * @returns {Promise<number>}
 */
async function countDevTelemetryErrors(telemetryDir, sinceMs) {
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
        if (!parsed || typeof parsed !== 'object') continue
        if (/** @type {any} */ (parsed).severityText !== 'ERROR') continue
        if (!recordedWithinWindow(/** @type {any} */ (parsed).timestamp, sinceMs)) continue
        count += 1
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
      return ['hyp setup --from-file <config.json>']
    case 'capability_ambiguous':
      return ['# Add a disambiguate.<capability> entry to your config']
    case 'duplicate_plugin':
    case 'plugin_unknown':
      return ['hyp setup --from-file <config.json>']
    default:
      return []
  }
}

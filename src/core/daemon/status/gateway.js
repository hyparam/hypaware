// @ts-check

/**
 * What the AI gateway source reports in the status snapshot: its details,
 * the upstreams it dropped, and the entrypoints it saw recently.
 *
 * @import { DroppedUpstreamAttribution, RecentEntrypoint, SourceSnapshot } from '../../../../src/core/daemon/types.js'
 */

import { compareStrings } from '../../util/compare_strings.js'
import { isPlainObject, sanitizeLabel } from '../../util/json_util.js'
import { stringList, nonNegativeInt } from './values.js'

/** The AI gateway plugin name: the source whose bound port drives attach. */
export const GATEWAY_PLUGIN_NAME = '@hypaware/ai-gateway'

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
export function printableUpstreamNames(list) {
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
export function gatewayDroppedUpstreams(sources) {
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
export function droppedUpstreamConsequence(dropped, names, attribution) {
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
  const details = gatewaySourceRawDetails(sources)
  if (!details) return []
  const raw = details.recent_entrypoints
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

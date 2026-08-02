// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  AI_GATEWAY_MESSAGES_DATASET,
  errMessage,
  filterByWindow,
  projectedExchangeItem,
  resolveWindow,
} from '../../../../src/core/backfill/scan_util.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import {
  defaultOpenclawAgentsDir,
  readOpenclawSessionHeader,
  readOpenclawSessionMessages,
} from './session_file.js'
import { isPlainObject, sha256Hex, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, BackfillContribution, BackfillEvent, BackfillItem, BackfillPlan, BackfillPlanContext, BackfillRunContext, JsonObject, PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { OpenclawSessionHeader, OpenclawSessionMessage } from './types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * `@hypaware/openclaw` backfill provider.
 *
 * Imports local OpenClaw history into `ai_gateway_messages` by reading the
 * session JSONL OpenClaw writes under
 * `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`, through the one
 * LLP 0158 reader (`session_file.js`) the settlement enricher also uses (R9:
 * neither consumer may hold its own parse).
 *
 * The session file is the authoritative record of a turn: it already carries
 * one per-message record with the message's own native id and timestamp on
 * the record line, and its role, content and (for an assistant message) the
 * model, provider, api, stop reason and usage in the nested `message`
 * envelope the LLP 0158 reader normalizes. So this module builds an
 * `AiGatewayProjectedExchange` straight off those fields. It deliberately
 * does NOT route through `anthropicMessages()` (projector.js): those parse a
 * wire request/response pair, and there is no wire pair here to reconstruct.
 *
 * That directness is what makes R11 true by construction rather than by
 * coincidence. A backfilled row carries the record's own `message_id`, so it
 * never touches `computeMessageId`'s fallback-hash path and never needs an
 * LLP 0159 match key; the live route reaches the same native id only once
 * settlement upgrades it. Both routes therefore converge on the same
 * `message_id`, and since `part_id` is `<message_id>#<part_index>`, the
 * overlap collapses to zero writes through the existing `part_id` dedupe
 * (`createBackfillDedupe`) instead of landing twice.
 *
 * @ref LLP 0161#backfill-provider [implements]: the whole module, native
 * identity direct from the session file rather than a second copy of the
 * fallback-hash path
 * @ref LLP 0157#backfill [implements]: backfilled rows carry the same
 * `client_name` and `conversation_source` as live rows and no route marker,
 * matching the Codex posture
 * @ref LLP 0157#requirements [implements]: R9 (the LLP 0158 reader, no
 * private parse), R10 (per-session policy gate before any row projects, plus
 * the CLI-backend exclusion), R11 (identity-identical to settled live rows)
 */

const DEFAULT_CLIENT_NAME = 'openclaw'
const DEFAULT_PLUGIN_NAME = '@hypaware/openclaw'
const CONVERSATION_SOURCE = 'openclaw'
const COMPONENT = 'plugin.openclaw.backfill'

/**
 * Default Lane B sweep cadence (every 5 minutes), used when the plugin's
 * `backfill.sweep_cron` config key is absent. Mirrors R7: "tunable in the
 * plugin's `backfill` config section," default otherwise.
 *
 * @ref LLP 0172#lane-b-sweep [implements]: the sweep cadence default
 */
const DEFAULT_SWEEP_CRON = '*/5 * * * *'

/**
 * The quiesce window's default width, in milliseconds: the settlement flush
 * debounce (`QUERY_FLUSH_DEBOUNCE_MS` in `src/core/cache/spool.js`, 2
 * minutes) plus a one-minute margin. Not a re-guessed number: a sweep run
 * that considered a file inside this window could race a session OpenClaw
 * is still mid-write on, or a settlement pass still mid-flush against the
 * same turn (LLP 0170: "quiesce window = settlement flush interval +
 * margin"). `config.backfill.quiesce_ms` overrides it for an operator with a
 * slower disk or a longer flush debounce.
 *
 * @ref LLP 0170#decision [implements]: the sweep skips session files whose
 * mtime is inside the quiesce window, sized from the existing settlement
 * flush debounce plus margin, not a new invented constant.
 * @type {number}
 */
const DEFAULT_QUIESCE_MS = 180_000

/**
 * The CLI-backend exclusion (R10), as an explicit ALLOWLIST rather than a
 * denylist: a record projects only when the backend that served its turn is
 * one of the two HypAware actually steers and captures live.
 *
 * The direction matters more than the contents. An OpenClaw turn delegated to
 * the `claude` or `codex` binary is a child process that never touches
 * OpenClaw's provider layer; it belongs to the sibling Claude/Codex transcript
 * adapters permanently (LLP 0147), and re-projecting it here would double-count
 * it under the wrong `client_name`. The exact `provider`/`api` strings such a
 * turn writes into the session file are OpenClaw surface this repo does not own
 * and could not be verified at implementation time (no live OpenClaw install
 * was reachable; LLP 0161 Section 10 anticipates exactly this and says not to
 * block on it). A denylist would have to guess them and would fail OPEN on
 * every value it guessed wrong. This allowlist fails CLOSED instead: an
 * unrecognized or future `provider` is excluded and reported, never silently
 * mis-attributed.
 *
 * This is one of the two "living lists" LLP 0161 Section 11 names. Its first
 * addition (the obvious candidate: whatever a steered turn records once the
 * steering plugin has rewritten the model's provider, which may be a
 * `hypaware-*` shadow id rather than the canonical vendor id) should land as
 * its own short decision LLP citing LLP 0161/0162, not a silent diff here.
 *
 * @ref LLP 0147 [constrained-by]: CLI-backend turns are the sibling adapters'
 * territory, so backfill excludes them from projection
 * @type {ReadonlySet<string>}
 */
export const PROJECTABLE_PROVIDERS = new Set(['anthropic', 'openai'])

/**
 * Which HypAware route still captures an excluded turn, keyed on the prefix of
 * the `provider` value the session file recorded. Used ONLY to label the
 * exclusion event, never to decide whether a record projects: that decision is
 * {@link PROJECTABLE_PROVIDERS} alone, so an unrecognized provider is excluded
 * whether or not it appears here (and its event simply carries no `covered_by`,
 * which is the honest answer for a value nothing is known about).
 *
 * Mirrors the Codex desktop precedent's `covered_by` attribute: a boundary that
 * names the route still covering it reads as scope, not as a gap.
 *
 * @ref LLP 0157#backfill [implements]: surface the CLI-backend boundary as a
 * structured `covered_by` event
 * @type {ReadonlyArray<{ prefix: string, coveredBy: string }>}
 */
const SIBLING_ADAPTER_COVERAGE = [
  { prefix: 'claude-cli', coveredBy: 'claude_transcript' },
  { prefix: 'codex', coveredBy: 'codex_sessions_rollout' },
]

/**
 * Build the OpenClaw backfill provider. Registered at plugin activation via
 * `ctx.backfills.register(...)`, mirroring `@hypaware/codex`'s placement. The
 * provider closes over the resolved agents root so `run()` needs only the
 * kernel-supplied `BackfillRunContext`.
 *
 * @param {{
 *   homeDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   agentsDir?: string,
 *   clientName?: string,
 *   pluginName?: string,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 *   config?: JsonObject,
 * }} opts
 * @returns {BackfillContribution}
 */
export function createOpenclawBackfillProvider(opts) {
  const clientName = opts.clientName ?? DEFAULT_CLIENT_NAME
  const pluginName = opts.pluginName ?? DEFAULT_PLUGIN_NAME
  // The plugin's own validated `config` slice (LLP 0037), the same shape
  // `config.js`'s `validateBackfillSection` checks. Absent in every call
  // site that hasn't threaded it through yet (a pre-quiesce test harness, an
  // older host), which is exactly "not configured" and resolves to the
  // default below, not a throw.
  const config = opts.config
  // Through the LLP 0158 reader's own location helper, never a private
  // `path.join(homeDir, '.openclaw')`: that second opinion silently ignored
  // `OPENCLAW_HOME`, so a relocated install backfilled zero sessions while the
  // settlement enricher (which does use the helper) read the real ones.
  const agentsDir = opts.agentsDir ?? defaultOpenclawAgentsDir(opts.env, opts.homeDir)
  // One `.hypignore` resolver per provider instance, holding its per-cwd cache
  // for the whole scan (LLP 0049 R6).
  // @ref LLP 0103 [implements]: the machine-local list is the resolver's second
  // source, so `hyp backfill openclaw` skips `--private` (`ignore`) dirs rather
  // than re-importing sessions a live capture already dropped.
  const resolver = opts.resolver ?? createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })

  return {
    name: clientName,
    plugin: pluginName,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import local OpenClaw session transcripts into ai_gateway_messages',
    // @ref LLP 0172#lane-b-sweep [implements]: opt-in Lane B scheduling
    // metadata, tunable via `backfill.sweep_cron` (R7), defaulting to
    // every 5 minutes when the config key is absent.
    sweep: { cron: resolveSweepCron(config) },
    /**
     * @param {BackfillPlanContext} _ctx
     * @returns {Promise<BackfillPlan | undefined>}
     */
    async plan(_ctx) {
      const files = await listSessionFiles(agentsDir)
      return {
        estimated_items: files.length,
        sources: files.map((file) => file.filePath),
      }
    },
    async *run(ctx) {
      yield* runOpenclawBackfill({ ctx, agentsDir, clientName, resolver, config })
    },
  }
}

/**
 * Scan every session file under `agents/*<slash>sessions/*.jsonl`, project each
 * one, and yield a single `ai_gateway.projected_exchange` item per session.
 *
 * One item per session, not one per message record: the materializer allocates
 * a fresh conversation state per `materialize()` call, so splitting a session
 * across items would restart the `previous_message_id` chain and the
 * tool_use -> tool_result lookup at every record. The Codex provider yields per
 * session for the same reason, and `native_id` on the provenance envelope is
 * correspondingly the session's own id rather than a per-record id.
 *
 * @param {{
 *   ctx: BackfillRunContext,
 *   agentsDir: string,
 *   clientName: string,
 *   resolver: UsagePolicyResolver,
 *   config?: JsonObject,
 * }} args
 * @returns {AsyncGenerator<BackfillItem | BackfillEvent>}
 */
async function* runOpenclawBackfill(args) {
  const { ctx, agentsDir, clientName, resolver, config } = args
  const log = ctx.log
  const window = resolveWindow(ctx)
  // Lane B's quiesce window (LLP 0172#45-the-quiesce-window): computed once
  // per run, not once per file, so every file in the same run is judged
  // against the same instant. This composes with, rather than replaces, the
  // effectiveProviders/partitionByBackend forward/backward-fill logic below
  // (R10): it is a pre-filter on which files this run even reads, entirely
  // orthogonal to which records within a read file project.
  const quiesceMs = resolveQuiesceMs(config)
  const quiesceBeforeMs = Date.now() - quiesceMs

  log.info('openclaw.backfill.scan_started', {
    component: COMPONENT,
    operation: 'backfill.scan',
    agents_dir: agentsDir,
    quiesce_ms: quiesceMs,
    ...(window.sinceMs !== undefined ? { since: new Date(window.sinceMs).toISOString() } : {}),
    ...(window.untilMs !== undefined ? { until: new Date(window.untilMs).toISOString() } : {}),
    status: 'ok',
  })

  let filesSeen = 0
  let sessionsProjected = 0
  let sessionsIgnored = 0
  let messagesProjected = 0
  let recordsExcluded = 0

  for (const { agentId, filePath } of await listSessionFiles(agentsDir, quiesceBeforeMs)) {
    if (ctx.signal?.aborted) break
    filesSeen += 1

    // The LLP 0158 reader answers `undefined` for a missing, empty, or
    // non-header first line: "this file establishes nothing," which is a
    // session that is simply not gated, never a throw.
    const header = readOpenclawSessionHeader(filePath)
    const sessionId = header?.sessionId ?? sessionIdFromPath(filePath)

    // @ref LLP 0161#backfill-provider [implements]: a usable `cwd` is resolved
    // once per FILE and an `ignore` verdict skips the whole file. The cwd is
    // session-wide (LLP 0158 Context: one `cwd`, stated once in the header), so
    // per-row gating would resolve the same path N times for the same answer.
    // No usable cwd (absent, or a relative value the reader refuses) means the
    // session is not gated and projects, the existing convention LLP 0157
    // states explicitly for backfill.
    const policy = header?.cwd ? resolver.resolve(header.cwd) : undefined
    if (policy?.class === 'ignore') {
      sessionsIgnored += 1
      // A fail-safe clamp (an unimplemented declared token) escalates to warn
      // so an operator can tell it from an intended ignore (LLP 0049 R3).
      log[policy.warn ? 'warn' : 'info']('openclaw.backfill.usage_policy_drop', {
        component: COMPONENT,
        operation: 'usage_policy_drop',
        session_id: sessionId,
        // Hashed, never the raw path: the same shape the settlement drop log
        // uses, so one query reads both seams without either leaking a cwd.
        cwd_hash: hashShort(header?.cwd ?? ''),
        class: 'ignore',
        declared: policy.declared,
        governed_by: policy.governedBy,
        status: 'skipped',
        ...(policy.warn ? { warn: policy.warn } : {}),
      })
      yield {
        type: 'event',
        event: 'usage_policy_drop',
        attributes: {
          client_name: clientName,
          session_id: sessionId,
          source_path: filePath,
          class: 'ignore',
          ...(policy.declared ? { declared: policy.declared } : {}),
          ...(policy.governedBy ? { governed_by: policy.governedBy } : {}),
        },
      }
      continue
    }

    /** @type {OpenclawSessionMessage[]} */
    let records
    try {
      records = await readOpenclawSessionMessages(filePath)
    } catch (err) {
      log.warn('openclaw.backfill.session_read_failed', {
        component: COMPONENT,
        operation: 'backfill.scan',
        source_path: filePath,
        status: 'error',
        error_kind: 'session_read_failed',
        error: errMessage(err),
      })
      continue
    }

    const windowed = filterByWindow(records, window)
    const { projectable, excludedByProvider } = partitionByBackend(windowed)
    for (const [provider, count] of excludedByProvider) {
      recordsExcluded += count
      const coveredBy = siblingCoverageFor(provider)
      log.info('openclaw.backfill.cli_backend_excluded', {
        component: COMPONENT,
        operation: 'backfill.scan',
        session_id: sessionId,
        source_path: filePath,
        provider,
        record_count: count,
        status: 'skipped',
        ...(coveredBy ? { covered_by: coveredBy } : {}),
      })
      yield {
        type: 'event',
        event: 'excluded_backend',
        attributes: {
          client_name: clientName,
          session_id: sessionId,
          provider,
          record_count: count,
          ...(coveredBy ? { covered_by: coveredBy } : {}),
        },
      }
    }

    const exchange = projectedExchangeFromSession({ agentId, sessionId, header, projectable, clientName })
    if (!exchange) continue

    sessionsProjected += 1
    messagesProjected += exchange.messages.length
    log.info('openclaw.backfill.session_projected', {
      component: COMPONENT,
      operation: 'backfill.project',
      session_id: sessionId,
      message_count: exchange.messages.length,
      identity_source: 'native',
      status: 'ok',
    })

    yield projectedExchangeItem(exchange, {
      client_name: clientName,
      source_path: filePath,
      native_id: sessionId,
    })
  }

  log.info('openclaw.backfill.scan_complete', {
    component: COMPONENT,
    operation: 'backfill.scan',
    files_seen: filesSeen,
    sessions_projected: sessionsProjected,
    sessions_ignored: sessionsIgnored,
    messages_projected: messagesProjected,
    records_excluded: recordsExcluded,
    status: 'ok',
  })
}

/**
 * Split a session's records into the ones the allowlist projects and a count
 * per excluded backend.
 *
 * The allowlist reads a record's EFFECTIVE provider, which is the record's own
 * `provider` when it states one and otherwise the nearest one that does,
 * preferring the record that follows. Only an assistant record carries
 * `provider` (LLP 0158 Context); a user prompt and a tool result do not. Read
 * literally against the record's own field, the allowlist would exclude every
 * user prompt in every session, including the prompts of the very turns
 * HypAware does capture. Reading forward attributes an unstated record to the
 * turn it belongs to: the user prompt of a `claude-cli` turn is excluded with
 * that turn (the Claude transcript already holds it, LLP 0147), and a tool
 * result mid-loop takes the same backend as the assistant record that consumes
 * it. A file where no record ever states a provider projects nothing, which is
 * the fail-closed direction {@link PROJECTABLE_PROVIDERS} exists to hold.
 *
 * @param {OpenclawSessionMessage[]} records
 * @returns {{ projectable: Array<{ record: OpenclawSessionMessage, provider: string }>, excludedByProvider: Map<string, number> }}
 */
function partitionByBackend(records) {
  /** @type {Array<{ record: OpenclawSessionMessage, provider: string }>} */
  const projectable = []
  /** @type {Map<string, number>} */
  const excludedByProvider = new Map()
  const effective = effectiveProviders(records)

  for (let i = 0; i < records.length; i++) {
    const provider = effective[i]
    if (provider !== undefined && PROJECTABLE_PROVIDERS.has(provider)) {
      projectable.push({ record: records[i], provider })
      continue
    }
    // `unknown` keeps a record with no attributable backend at all countable
    // and queryable rather than invisible; it is excluded either way.
    const key = provider ?? 'unknown'
    excludedByProvider.set(key, (excludedByProvider.get(key) ?? 0) + 1)
  }
  return { projectable, excludedByProvider }
}

/**
 * The effective provider of each record, in file order: its own when stated,
 * else the next stated one, else the previous stated one.
 *
 * @param {OpenclawSessionMessage[]} records
 * @returns {Array<string | undefined>}
 */
function effectiveProviders(records) {
  /** @type {Array<string | undefined>} */
  const effective = records.map((record) => record.provider)
  /** @type {string | undefined} */
  let next
  for (let i = effective.length - 1; i >= 0; i--) {
    if (effective[i] !== undefined) next = effective[i]
    else effective[i] = next
  }
  /** @type {string | undefined} */
  let previous
  for (let i = 0; i < effective.length; i++) {
    if (effective[i] !== undefined) previous = effective[i]
    else effective[i] = previous
  }
  return effective
}

/**
 * The `covered_by` token for an excluded provider value, or `undefined` when
 * nothing is known to cover it.
 *
 * @param {string} provider
 * @returns {string | undefined}
 */
function siblingCoverageFor(provider) {
  const lowered = provider.toLowerCase()
  return SIBLING_ADAPTER_COVERAGE.find((entry) => lowered.startsWith(entry.prefix))?.coveredBy
}

/**
 * Project one session file's allowlisted records into a single
 * `AiGatewayProjectedExchange`, or `undefined` when nothing projectable
 * survived (an empty file, a whole session of CLI-backend turns, or a window
 * that excluded every record).
 *
 * @param {{
 *   agentId: string,
 *   sessionId: string,
 *   header: OpenclawSessionHeader | undefined,
 *   projectable: Array<{ record: OpenclawSessionMessage, provider: string }>,
 *   clientName: string,
 * }} args
 * @returns {AiGatewayProjectedExchange | undefined}
 */
function projectedExchangeFromSession(args) {
  const { agentId, sessionId, header, projectable, clientName } = args
  /** @type {AiGatewayProjectedMessage[]} */
  const messages = []
  /** @type {string | undefined} */
  let provider
  for (const { record, provider: recordProvider } of projectable) {
    const message = projectedMessageFromRecord(record)
    if (!message) continue
    // The exchange carries one `provider`, so a session that mixed both wire
    // shapes records the first projected turn's. Identity does not depend on
    // it (`part_id` is `<message_id>#<part_index>`), so a mixed session still
    // dedupes against live rows correctly; only the `provider` column of the
    // minority turns reads as the majority's.
    provider ??= recordProvider
    messages.push(message)
  }
  if (messages.length === 0 || provider === undefined) return undefined

  /** @type {JsonObject} */
  const openclawAttributes = { identity_source: 'native' }
  if (agentId) openclawAttributes.agent_id = agentId

  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider,
    // The header's own session id: the session file IS the session container,
    // so unlike the live projector (which has no session id on the wire and
    // keys on a system-prompt-head hash, LLP 0144) backfill has the native
    // value in hand. `conversation_id` stays absent: OpenClaw's session file
    // records no thread within the session (LLP 0030's Claude-shaped case).
    session_id: sessionId,
    conversation_source: CONVERSATION_SOURCE,
    client_name: clientName,
    attributes: { openclaw: openclawAttributes },
    messages,
  }
  if (header?.startedAt) exchange.conversation_started_at = header.startedAt
  if (header?.cwd) exchange.cwd = header.cwd
  return exchange
}

/**
 * Project one session-file message record into a normalized gateway message,
 * or `undefined` when it carries no projectable content.
 *
 * `content` passes through as the session file wrote it. It is not rewritten
 * into Anthropic wire block shapes: the session file is the authoritative
 * record here, and the two properties R11 actually depends on (the native
 * `message_id`, and the block count and order that fix each part's
 * `part_index`) pass through unchanged either way. A rewrite would be a second
 * copy of the block-kind knowledge `match_key.js` already owns, which is the
 * drift LLP 0150 documented shipping twice.
 *
 * `previous_message_id` is deliberately NOT set. The gateway chains each
 * message to its immediate predecessor in the same thread when a projector
 * omits it, and that is the one chaining implementation the live route uses
 * too; supplying a second copy here could only differ from it.
 *
 * @param {OpenclawSessionMessage} message
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function projectedMessageFromRecord(message) {
  // Through the LLP 0158 reader's normalized fields, never `message.record`:
  // OpenClaw nests `role`/`content` under the record line's `message`
  // envelope, so the top-level read this used to do found neither and dropped
  // every record of every real session (#543).
  const rawRole = stringValue(message.role)
  if (!rawRole) return undefined
  const content = message.content
  // The gateway drops a message whose content normalizes to no blocks; doing it
  // here keeps `messages_projected` honest about what was actually emitted.
  if (typeof content === 'string' ? content.length === 0 : !Array.isArray(content) || content.length === 0) {
    return undefined
  }

  /** @type {AiGatewayProjectedMessage} */
  const projected = {
    role: normalizeRole(rawRole),
    content: /** @type {any} */ (content),
  }
  // Native identity, verbatim. This single line is what R11 rests on: the row
  // never reaches `computeMessageId`'s fallback hash, so it lands on the same
  // `message_id` (and therefore the same `part_id`) a settled live row does.
  if (message.id) projected.message_id = message.id
  if (message.timestampMs !== undefined) {
    projected.message_created_at = new Date(message.timestampMs).toISOString()
  }
  // Per-message, not per-exchange: a backfilled session can switch models
  // mid-stream, and the session file records `model` on assistant records only.
  if (message.model) projected.model = message.model
  if (message.stopReason) projected.stop_reason = message.stopReason
  const attributes = messageAttributes(message)
  if (attributes) projected.attributes = attributes
  return projected
}

/**
 * OpenClaw's own role vocabulary, mapped onto the roles the gateway's sibling
 * adapters already write. Only `toolResult` differs: `@hypaware/codex` emits
 * tool output under `role: 'tool'`, so using OpenClaw's spelling verbatim would
 * make one cross-client query need to know which adapter wrote the row.
 *
 * This is not the `toolResult` -> `user` fold `sessionMatchKey` performs. That
 * fold exists to line a session record up against an Anthropic WIRE message for
 * match-key comparison; backfill never computes a match key, and there is no
 * wire message here to line up against.
 *
 * @param {string} role
 * @returns {string}
 */
function normalizeRole(role) {
  return role === 'toolResult' ? 'tool' : role
}

/**
 * `attributes` for one projected message: the record's normalized token usage
 * and, when stated, the wire shape its turn spoke.
 *
 * @param {OpenclawSessionMessage} message
 * @returns {JsonObject | undefined}
 */
function messageAttributes(message) {
  /** @type {JsonObject} */
  const attributes = {}
  const usage = usageAttributes(message.usage)
  if (usage) attributes.usage = usage
  if (message.api) attributes.openclaw = { api: message.api }
  return Object.keys(attributes).length === 0 ? undefined : attributes
}

/**
 * Token counts under the gateway-wide names, so a token query aggregates
 * OpenClaw rows with Claude and Codex rows.
 *
 * Each name is read through a small alias list rather than one spelling: the
 * session file's `usage` block is OpenClaw's own normalization of whatever its
 * provider returned. A live install has since confirmed the camelCase
 * spelling (`input`/`output`/`cacheRead`/`cacheWrite`, LLP 0158 Context), so
 * the alias list is no longer a hedge against an unverified guess; it is kept
 * because the block is still the client's normalization of a provider payload
 * and a version that passed a wire spelling through would otherwise silently
 * zero out a session's tokens.
 *
 * @ref LLP 0035#one-carrier [implements]: usage rides the assistant record
 * only, so it lands once per response
 * @param {Record<string, unknown> | undefined} usage
 * @returns {JsonObject | undefined}
 */
function usageAttributes(usage) {
  if (!isPlainObject(usage)) return undefined
  /** @type {JsonObject} */
  const out = {}
  setNumber(out, 'input_tokens', usage, ['input_tokens', 'inputTokens', 'input', 'prompt_tokens'])
  setNumber(out, 'output_tokens', usage, ['output_tokens', 'outputTokens', 'output', 'completion_tokens'])
  setNumber(out, 'cache_read_tokens', usage, [
    'cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read', 'cacheRead',
  ])
  setNumber(out, 'cache_write_tokens', usage, [
    'cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write', 'cacheWrite',
  ])
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * @param {JsonObject} target
 * @param {string} key
 * @param {Record<string, unknown>} source
 * @param {string[]} aliases
 */
function setNumber(target, key, source, aliases) {
  for (const alias of aliases) {
    const value = source[alias]
    if (typeof value === 'number' && Number.isFinite(value)) {
      target[key] = value
      return
    }
  }
}

/**
 * Every `agents/<agentId>/sessions/*.jsonl` under `agentsDir`, sorted so a run
 * is deterministic. A missing or unreadable directory at any level is an empty
 * result, never a throw: a machine with no OpenClaw install must scan to zero
 * sessions, not fail the whole `hyp backfill` run.
 *
 * `quiesceBeforeMs` (LLP 0172#45-the-quiesce-window, LLP 0170#decision),
 * when given, excludes any file whose `mtimeMs` is more recent than it: a
 * session still inside the quiesce window is skipped for THIS run, not
 * permanently, so a later run (once the file's mtime has aged past the
 * cutoff, or the daemon sweep's next tick) picks it back up.
 *
 * The parameter is optional for exactly one caller: `plan()`, which counts and
 * names what is there rather than importing it, so a window that hides files
 * from an estimate would only misreport. Every `run()` applies the window,
 * whichever surface drives it - `hyp backfill --client openclaw`, the
 * onboarding finale, and the daemon sweep all enter through the same `run()`,
 * and `runOpenclawBackfill` computes the cutoff once per run before this is
 * ever called. There is no "non-sweep, unfiltered" import path.
 *
 * @param {string} agentsDir
 * @param {number} [quiesceBeforeMs] Exclusive upper bound on `mtimeMs`.
 * @returns {Promise<Array<{ agentId: string, filePath: string }>>}
 */
async function listSessionFiles(agentsDir, quiesceBeforeMs) {
  /** @type {Array<{ agentId: string, filePath: string }>} */
  const out = []
  for (const agentId of await readDirNames(agentsDir, 'dir')) {
    const sessionsDir = path.join(agentsDir, agentId, 'sessions')
    for (const name of await readDirNames(sessionsDir, 'file')) {
      if (!name.endsWith('.jsonl')) continue
      const filePath = path.join(sessionsDir, name)
      if (quiesceBeforeMs !== undefined && !(await isOutsideQuiesceWindow(filePath, quiesceBeforeMs))) continue
      out.push({ agentId, filePath })
    }
  }
  out.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0))
  return out
}

/**
 * Whether `filePath`'s mtime is old enough to clear the quiesce window: its
 * `mtimeMs` is at or before `quiesceBeforeMs`. A file that fails to stat
 * (removed between the directory read and this call) is treated as still
 * inside the window and excluded, the same fail-closed direction the
 * usage-policy gate above already takes for an unresolvable input: a
 * vanished file is not evidence a session has settled.
 *
 * @param {string} filePath
 * @param {number} quiesceBeforeMs
 * @returns {Promise<boolean>}
 */
async function isOutsideQuiesceWindow(filePath, quiesceBeforeMs) {
  try {
    const stat = await fs.stat(filePath)
    return stat.mtimeMs <= quiesceBeforeMs
  } catch {
    return false
  }
}

/**
 * `quiesceMs` resolved from the plugin's own validated `config` slice, or
 * {@link DEFAULT_QUIESCE_MS} when `config.backfill.quiesce_ms` is absent
 * (no `config` supplied, no `backfill` block, or no `quiesce_ms` key).
 * `config.js`'s `validateBackfillSection` already rejects a non-integer or
 * negative value before it ever reaches here, so this reads the field
 * as-is rather than re-validating it.
 *
 * @param {JsonObject | undefined} config
 * @returns {number}
 */
function resolveQuiesceMs(config) {
  const backfill = isPlainObject(config) && isPlainObject(config.backfill) ? config.backfill : undefined
  const quiesceMs = backfill?.quiesce_ms
  return typeof quiesceMs === 'number' ? quiesceMs : DEFAULT_QUIESCE_MS
}

/**
 * The contribution's `sweep.cron`, resolved from the plugin's own validated
 * `config` slice, or {@link DEFAULT_SWEEP_CRON} when `config.backfill.sweep_cron`
 * is absent. Read through the same `isPlainObject` narrowing `resolveQuiesceMs`
 * uses rather than an optional-property chain: the slice is a `JsonObject`, so
 * every step below its root is a `JsonValue` to the checker and a bare
 * `config?.backfill?.sweep_cron` does not typecheck. `config.js`'s
 * `validateBackfillSection` already rejects a malformed cron string before it
 * reaches here.
 *
 * @param {JsonObject | undefined} config
 * @returns {string}
 */
function resolveSweepCron(config) {
  const backfill = isPlainObject(config) && isPlainObject(config.backfill) ? config.backfill : undefined
  const sweepCron = backfill?.sweep_cron
  return typeof sweepCron === 'string' ? sweepCron : DEFAULT_SWEEP_CRON
}

/**
 * @param {string} dir
 * @param {'dir' | 'file'} kind
 * @returns {Promise<string[]>}
 */
async function readDirNames(dir, kind) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => (kind === 'dir' ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * The session id for a file whose header stated none. `session_id` is the
 * non-null partition key, so it always has to resolve to something stable, and
 * OpenClaw names the file after the session (`<sessionId>.jsonl`). Read off the
 * path rather than the line, so it never conflicts with the LLP 0158 reader's
 * "unconfirmable is unresolvable" rule for the header's own fields.
 *
 * @param {string} filePath
 * @returns {string}
 */
function sessionIdFromPath(filePath) {
  const base = path.basename(filePath, '.jsonl')
  return base.length > 0 ? base : hashShort(filePath)
}

/**
 * The 16-hex-char SHA-256 prefix, the gateway's hash-id convention, reused here
 * for the log's `cwd_hash`.
 *
 * @param {string} input
 * @returns {string}
 */
function hashShort(input) {
  return sha256Hex(input).slice(0, 16)
}

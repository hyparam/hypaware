// @ts-check

import os from 'node:os'
import path from 'node:path'

import { deriveRepoFromCwd } from './git_repo.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { projectedExchangeItem } from '../../../../src/core/backfill/scan_util.js'
import { isPlainObject, parseMaybeJson, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, BackfillItem, BackfillProvenance, JsonObject, JsonValue, PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { HermesMessageRow, HermesSessionRow } from './types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * Maps a whole hermes session (`state.db` `sessions` row + its `messages`
 * rows) to the `ai_gateway.projected_exchange` materializer item, exactly
 * like the claude/codex backfill projections. Both the backfill provider
 * (T3) and the poll source (T4) call {@link projectHermesSession} with the
 * same whole-session input, so a session's row identity never depends on
 * when or how often it was observed (spec R2, LLP 0122#watermark).
 *
 * @ref LLP 0120 [implements]: hermes rows materialize into
 *   `ai_gateway_messages` via the projected-exchange item; the adapter
 *   owns no dataset.
 * @ref LLP 0122#projection [implements]: the hermes -> AiGatewayProjectedExchange table.
 */

/** `client_name` / `conversation_source` for every hermes row (LLP 0120 #row-semantics). */
export const HERMES_CLIENT_NAME = 'hermes'

/**
 * `sessions.source` values that are messaging-channel gateways rather than
 * an interactive launch surface. Exhaustive per spec R10; any other source
 * (`cli`, `tui`, `cron`, ...) is treated as interactive and keeps its
 * genuine `cwd`.
 *
 * @ref LLP 0124 [implements]: the exact channel-source vocabulary R10 names.
 */
export const HERMES_CHANNEL_SOURCES = new Set(['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'email'])

/**
 * Known `billing_base_url` hostnames -> normalized provider name, seeding
 * LLP 0122's open question #1 ("needs one settled table..., seeded from
 * observed hermes configs"). An unrecognized host falls back to the raw
 * hostname, never `'hermes'` itself (LLP 0120 #row-semantics: hermes is a
 * client, not a provider).
 */
/** @type {Record<string, string>} */
const PROVIDER_HOST_MAP = {
  'api.openai.com': 'openai',
  'openrouter.ai': 'openrouter',
  'api.anthropic.com': 'anthropic',
  'generativelanguage.googleapis.com': 'google',
}

/**
 * Namespace a hermes store-scoped integer id (session or message) so it
 * never collides with another client's id space in `session_id` /
 * `parent_thread_id`. @ref LLP 0122#projection [implements]
 *
 * @param {number} id
 * @returns {string}
 */
export function hermesScopeId(id) {
  return `hermes-${id}`
}

/**
 * The canonical per-channel policy scope path a channel session's `cwd` is
 * stamped with, so the standard `.hypignore` / machine-local marking
 * machinery governs channel sessions with no hermes-specific config
 * (spec R10). The path need not exist on disk; the usage-policy resolver
 * and the export seam match on path shape, not filesystem state.
 *
 * @ref LLP 0124 [implements]: `~/.hermes/channels/<source>`.
 * @param {string} source
 * @param {string} [homeDir]
 * @returns {string}
 */
export function channelScopePath(source, homeDir = os.homedir()) {
  return path.join(homeDir, '.hermes', 'channels', source)
}

/**
 * Normalize a session's billing metadata to the shared `provider`
 * vocabulary. Hermes talks to arbitrary OpenAI-compatible upstreams, so
 * this reflects the upstream, never `'hermes'` (LLP 0120 #row-semantics).
 *
 * @param {HermesSessionRow} session
 * @returns {string}
 */
export function normalizeHermesProvider(session) {
  const baseUrl = session.billing_base_url
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    try {
      const host = new URL(baseUrl).hostname
      if (host) return PROVIDER_HOST_MAP[host] ?? host
    } catch {
      // Unparseable base_url: fall through to billing_provider.
    }
  }
  if (typeof session.billing_provider === 'string' && session.billing_provider.length > 0) {
    return session.billing_provider
  }
  return 'unknown'
}

/**
 * Deterministic `message_id` for one part of a hermes message row, minted
 * from hermes's own stable keys so re-imports dedupe via the materializer's
 * pre-write `part_id` guard rather than colliding or drifting on rerun.
 * `part_id` itself is `<message_id>#<content-index>` (always `#0` here,
 * since every minted message carries exactly one content block: the gateway
 * mints it, not the projector; see `message_projector.js#expandMessageParts`).
 *
 * @ref LLP 0120 [implements]: "session id + message id + part index".
 * @param {number} sessionId
 * @param {number} messageId
 * @param {number} partIndex
 * @returns {string}
 */
export function mintHermesMessageId(sessionId, messageId, partIndex) {
  return `hermes-${sessionId}-${messageId}-${partIndex}`
}

/**
 * Deterministic `message_id` for the synthetic session-end part
 * (`#session-end-part`): stable across re-projections of the same session,
 * so dedupe appends it exactly once no matter how many times an ended
 * session is re-observed.
 *
 * @param {number} sessionId
 * @returns {string}
 */
export function mintHermesSessionEndId(sessionId) {
  return `hermes-${sessionId}-session_end`
}

/**
 * One expansion unit of a hermes message row: reasoning, each tool call,
 * and the text/tool_result body all become their own projected message so
 * each carries its own deterministic `message_id` (LLP 0120
 * #row-semantics).
 *
 * @typedef {{ role: string, content: JsonObject[] }} HermesMessagePart
 */

/**
 * Expand one `messages` row into its ordered content parts. A row may
 * carry reasoning AND one or more tool calls AND a text/tool-result body
 * simultaneously (hermes duplicates reasoning onto the message that also
 * issues the tool call); each becomes a separate part, oldest-semantic
 * first: thinking, then tool calls in emission order, then the body.
 *
 * @param {HermesMessageRow} row
 * @returns {HermesMessagePart[]}
 */
function partsForMessageRow(row) {
  /** @type {HermesMessagePart[]} */
  const parts = []
  if (typeof row.reasoning === 'string' && row.reasoning.length > 0) {
    parts.push({ role: row.role, content: [{ type: 'thinking', thinking: row.reasoning }] })
  }
  for (const call of parseToolCalls(row.tool_calls)) {
    /** @type {JsonObject} */
    const block = { type: 'tool_use' }
    if (call.id) block.id = call.id
    if (call.name) block.name = call.name
    block.input = /** @type {JsonValue} */ (call.input ?? null)
    parts.push({ role: row.role, content: [block] })
  }
  if (row.role === 'tool') {
    /** @type {JsonObject} */
    const block = { type: 'tool_result' }
    if (row.tool_call_id) block.tool_use_id = row.tool_call_id
    if (typeof row.content === 'string') block.content = row.content
    parts.push({ role: 'tool', content: [block] })
  } else if (typeof row.content === 'string' && row.content.length > 0) {
    parts.push({ role: row.role, content: [{ type: 'text', text: row.content }] })
  }
  return parts
}

/**
 * Parse hermes's serialized `tool_calls` JSON text into `{ id, name, input }`
 * triples. Tolerant of an already-structured value (defensive: hermes
 * documents it as JSON text, but the reader passes columns through
 * unmodified) and of a per-call `arguments` that is itself a JSON string.
 *
 * @param {string | null} raw
 * @returns {Array<{ id: string | undefined, name: string | undefined, input: unknown }>}
 */
function parseToolCalls(raw) {
  if (raw == null) return []
  const parsed = parseMaybeJson(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isPlainObject).map((call) => ({
    id: stringValue(call.id) ?? stringValue(call.call_id),
    name: stringValue(call.name),
    input: call.arguments !== undefined ? parseMaybeJson(call.arguments) : (call.input ?? null),
  }))
}

/**
 * Build the synthetic session-end part (`#session-end-part`): once
 * `sessions.ended_at` is set, hermes's final facts (`end_reason`, final
 * token totals, costs, `api_call_count`) live only on the `sessions` row,
 * usually with no accompanying new message, so they get their own row.
 * `undefined` while the session is still open, so a backfill/poll of an
 * open session never emits it (present exactly once for an ended session,
 * absent for an open one).
 *
 * @ref LLP 0122#session-end-part [implements]
 * @param {HermesSessionRow} session
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function sessionEndMessage(session) {
  if (!session.ended_at) return undefined

  /** @type {JsonObject} */
  const usage = {}
  if (session.input_tokens != null) usage.input_tokens = session.input_tokens
  if (session.output_tokens != null) usage.output_tokens = session.output_tokens
  if (session.cache_read_tokens != null) usage.cache_read_tokens = session.cache_read_tokens
  if (session.cache_write_tokens != null) usage.cache_write_tokens = session.cache_write_tokens
  if (session.reasoning_tokens != null) usage.reasoning_tokens = session.reasoning_tokens

  /** @type {JsonObject} */
  const hermesExtra = { session_end: true }
  if (session.end_reason != null) hermesExtra.end_reason = session.end_reason
  if (session.estimated_cost_usd != null) hermesExtra.estimated_cost_usd = session.estimated_cost_usd
  if (session.actual_cost_usd != null) hermesExtra.actual_cost_usd = session.actual_cost_usd
  if (session.api_call_count != null) hermesExtra.api_call_count = session.api_call_count

  /** @type {JsonObject} */
  const attributes = { hermes: hermesExtra }
  if (Object.keys(usage).length > 0) attributes.usage = usage

  return {
    // Not 'assistant': the canonical LLP 0035 usage query sums
    // `role = 'assistant'` rows, and this row's totals are the whole
    // session's, not one more turn to add to that sum.
    role: 'system',
    content: [{ type: 'status', status: 'session_end' }],
    message_id: mintHermesSessionEndId(session.id),
    message_created_at: session.ended_at,
    attributes,
  }
}

/**
 * Project one whole hermes session into a ready-to-yield `BackfillItem`
 * (`kind: 'ai_gateway.projected_exchange'`). Both the backfill provider
 * (T3) and the poll source (T4) call this with the session's full row set
 * every time, never a partial batch, so `message_index` /
 * `previous_message_id` chains stay pure (spec R2, LLP 0122#watermark).
 *
 * Returns `undefined` when the session is usage-policy-dropped
 * (spec R3, `.hypignore` / machine-local `ignore`) or when there is
 * nothing to write (no messages and the session has not ended).
 *
 * @ref LLP 0050 [implements]: capture-seam usage-policy skip, resolved
 *   over the session's effective scope BEFORE any row is built.
 * @ref LLP 0124 [implements]: channel sessions resolve against the
 *   canonical `~/.hermes/channels/<source>` scope, not their (usually
 *   NULL) real `cwd`.
 * @param {{
 *   session: HermesSessionRow,
 *   messages: HermesMessageRow[],
 *   sourcePath?: string,
 *   clientName?: string,
 *   homeDir?: string,
 *   deriveRepo?: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 *   log?: PluginLogger,
 * }} args
 * @returns {Promise<BackfillItem | undefined>}
 */
export async function projectHermesSession(args) {
  const {
    session,
    messages,
    sourcePath,
    clientName = HERMES_CLIENT_NAME,
    homeDir = os.homedir(),
    deriveRepo = deriveRepoFromCwd,
    resolver = createUsagePolicyResolver({ localOnlyListPath: args.localOnlyListPath }),
    log,
  } = args

  const isChannel = HERMES_CHANNEL_SOURCES.has(session.source)
  // Effective scope: the channel's canonical policy path for channel
  // sessions (LLP 0124, always present), else the session's real `cwd`
  // when hermes recorded one. An interactive session with `cwd = NULL` has
  // no scope to match and records unconditionally (LLP 0122#usage-policy).
  const scopeCwd = isChannel ? channelScopePath(session.source, homeDir) : (session.cwd ?? undefined)

  if (scopeCwd) {
    const policy = resolver.resolve(scopeCwd)
    if (policy.class === 'ignore') {
      // A fail-safe clamp (declared token unimplemented) escalates to warn
      // so an operator can tell it from an intended ignore.
      log?.[policy.warn ? 'warn' : 'info']('plugin.hermes.usage_policy_drop', {
        component: 'hermes',
        operation: 'usage_policy_drop',
        session_id: session.id,
        scope: scopeCwd,
        declared: policy.declared,
        governed_by: policy.governedBy,
        ...(policy.warn ? { warn: policy.warn } : {}),
      })
      return undefined
    }
  }

  /** @type {AiGatewayProjectedMessage[]} */
  const projectedMessages = []
  for (const row of messages) {
    const parts = partsForMessageRow(row)
    if (parts.length === 0) continue
    // @ref LLP 0035#one-carrier [implements]: a hermes message row's single
    // `token_count` describes the whole row's response, so it (and
    // finish_reason) rides only the LAST expanded part, mirroring the
    // claude/codex one-carrier-per-response placement rule.
    const lastIndex = parts.length - 1
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      /** @type {AiGatewayProjectedMessage} */
      const projected = {
        role: part.role,
        content: part.content,
        message_id: mintHermesMessageId(session.id, row.id, i),
        // @ref LLP 0120#row-semantics [implements]: the raw hermes
        // `messages.id` rides `provider_uuid`, distinct from the minted
        // `message_id` (which folds in session id + part index for
        // dedupe-safe identity per spec R2).
        provider_uuid: String(row.id),
        message_created_at: row.timestamp,
      }
      if (i === lastIndex) {
        if (row.token_count != null) projected.attributes = { usage: { total_tokens: row.token_count } }
        if (row.finish_reason) projected.stop_reason = row.finish_reason
      }
      projectedMessages.push(projected)
    }
  }

  const endMessage = sessionEndMessage(session)
  if (endMessage) projectedMessages.push(endMessage)

  if (projectedMessages.length === 0) return undefined

  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: normalizeHermesProvider(session),
    // @ref LLP 0030#decision: hermes has no per-thread id distinct from the
    // session; like Claude, the session id is the partition key and
    // conversation_id stays null.
    session_id: hermesScopeId(session.id),
    conversation_source: clientName,
    client_name: clientName,
    entrypoint: session.source,
    messages: projectedMessages,
  }
  if (session.started_at) exchange.conversation_started_at = session.started_at
  if (session.model) exchange.model = session.model
  if (session.system_prompt) exchange.system_text = session.system_prompt
  if (session.parent_session_id != null) exchange.parent_thread_id = hermesScopeId(session.parent_session_id)

  /** @type {JsonObject} */
  const hermesAttrs = { source: session.source }
  if (isChannel) {
    // @ref LLP 0124 [implements]: the policy scope stamp, with the real
    // daemon cwd (when hermes recorded one) preserved verbatim.
    exchange.cwd = scopeCwd
    if (session.cwd) hermesAttrs.real_cwd = session.cwd
  } else if (session.cwd) {
    exchange.cwd = session.cwd
  }
  exchange.attributes = { hermes: hermesAttrs }

  // Repo enrichment only makes sense for a real interactive cwd; a
  // channel's synthetic scope path is never a git checkout.
  if (!isChannel && session.cwd) {
    const derived = await deriveRepo(session.cwd)
    if (derived.git_remote) exchange.git_remote = derived.git_remote
    if (derived.repo_root) exchange.repo_root = derived.repo_root
  }

  /** @type {BackfillProvenance} */
  const provenance = { client_name: clientName, native_id: String(session.id) }
  if (sourcePath) provenance.source_path = sourcePath

  return projectedExchangeItem(exchange, provenance)
}

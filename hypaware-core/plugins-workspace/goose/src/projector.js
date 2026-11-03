// @ts-check

import { deriveRepoFromCwd } from './git_repo.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { projectedExchangeItem } from '../../../../src/core/backfill/scan_util.js'
import { captureSessionTitle } from '../../../../src/core/backfill/session_title.js'
import { isPlainObject, parseMaybeJson, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, BackfillItem, BackfillProvenance, JsonObject, JsonValue, PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { GooseMessagePart, GooseMessageRow, GooseSessionRow } from './types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * Maps a whole Goose session (`sessions.db` `sessions` row + its `messages`
 * rows) to the `ai_gateway.projected_exchange` materializer item. The
 * backfill provider and the poll source both call
 * {@link projectGooseSession} with the whole session, so a part's identity
 * never depends on when or how often it was observed.
 *
 * @ref LLP 0570#projection [implements]: the Goose -> AiGatewayProjectedExchange mapping.
 */

/** `client_name` / `conversation_source` for every Goose row. */
export const GOOSE_CLIENT_NAME = 'goose'

/**
 * Namespace a Goose session id so it cannot collide with another client's
 * session id in the shared `session_id` column.
 *
 * @param {string} id
 * @returns {string}
 */
export function gooseScopeId(id) {
  return `goose-${id}`
}

/**
 * The reconciliation scope for one Goose session: only this client's rows
 * for this session are replaced.
 *
 * @param {string} clientName
 * @param {string} sessionId
 * @returns {{ client_name: string, session_id: string }}
 */
export function gooseReconcileScope(clientName, sessionId) {
  return { client_name: clientName, session_id: gooseScopeId(sessionId) }
}

/**
 * Deterministic `message_id` for one content item of a Goose message row.
 * `messageKey` is the provider `message_id`, or `id<row id>` when Goose
 * stored none; `occurrence` counts earlier rows in the session with the
 * same key, so a `replace_conversation` rewrite (new row ids, same
 * provider ids, same order) mints the same ids.
 *
 * @param {string} sessionId
 * @param {string} messageKey
 * @param {number} occurrence
 * @param {number} contentIndex
 * @returns {string}
 */
export function mintGooseMessageId(sessionId, messageKey, occurrence, contentIndex) {
  return `goose-${sessionId}-${messageKey}-${occurrence}-${contentIndex}`
}

/**
 * Goose `CURRENT_TIMESTAMP` text (`YYYY-MM-DD HH:MM:SS`, UTC) to ISO 8601.
 *
 * @param {string | null | undefined} value
 * @returns {string | undefined}
 */
export function gooseTimestampToIso(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const time = Date.parse(text)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/**
 * Epoch seconds to ISO 8601.
 *
 * @param {number} seconds
 * @returns {string | undefined}
 */
function epochSecondsToIso(seconds) {
  const value = Number(seconds)
  return Number.isFinite(value) ? new Date(Math.round(value * 1000)).toISOString() : undefined
}

/**
 * @param {string | null} raw
 * @returns {JsonObject}
 */
function parseObject(raw) {
  const parsed = raw == null ? undefined : parseMaybeJson(raw)
  return isPlainObject(parsed) ? /** @type {JsonObject} */ (parsed) : {}
}

/**
 * Expand one row's content items into parts, each tagged with its index in
 * the row's `content_json` so the minted id survives a skipped sibling.
 * Items Goose marks not user-visible and unknown item types yield nothing.
 *
 * @param {GooseMessageRow} row
 * @returns {Array<{ index: number, part: GooseMessagePart }>}
 */
function partsForMessageRow(row) {
  const parsed = parseMaybeJson(row.content_json)
  if (!Array.isArray(parsed)) return []
  const role = row.role === 'assistant' ? 'assistant' : 'user'
  /** @type {Array<{ index: number, part: GooseMessagePart }>} */
  const parts = []
  parsed.forEach((item, index) => {
    if (!isPlainObject(item) || item.userVisible === false) return
    if (item.type === 'text') {
      const text = stringValue(item.text)
      if (text) parts.push({ index, part: { role, content: [{ type: 'text', text }] } })
    } else if (item.type === 'toolRequest') {
      const call = isPlainObject(item.toolCall) && isPlainObject(item.toolCall.value) ? item.toolCall.value : {}
      /** @type {JsonObject} */
      const block = { type: 'tool_use' }
      const id = stringValue(item.id)
      const name = stringValue(call.name)
      if (id) block.id = id
      if (name) block.name = name
      block.input = /** @type {JsonValue} */ (parseMaybeJson(call.arguments) ?? null)
      parts.push({ index, part: { role: 'assistant', content: [block] } })
    } else if (item.type === 'toolResponse') {
      const result = isPlainObject(item.toolResult) && isPlainObject(item.toolResult.value) ? item.toolResult.value : {}
      /** @type {JsonObject} */
      const block = { type: 'tool_result' }
      const id = stringValue(item.id)
      if (id) block.tool_use_id = id
      const content = result.structuredContent ?? result.content
      if (content !== undefined) block.content = /** @type {JsonValue} */ (content)
      if (result.isError === true) block.is_error = true
      parts.push({ index, part: { role: 'tool', content: [block] } })
    }
  })
  return parts
}

/**
 * `metadata_json.usage` (camelCase) as the LLP 0035 usage attribute.
 *
 * @param {JsonObject} metadata
 * @returns {JsonObject | undefined}
 */
function usageOf(metadata) {
  if (!isPlainObject(metadata.usage)) return undefined
  /** @type {JsonObject} */
  const usage = {}
  for (const [from, to] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'], ['totalTokens', 'total_tokens']]) {
    const value = metadata.usage[from]
    if (typeof value === 'number' && Number.isFinite(value)) usage[to] = value
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

/**
 * Project one whole Goose session into a ready-to-yield `BackfillItem`.
 * Returns `undefined` only when the session is usage-policy dropped; an
 * empty transcript is still an item, so a full rewind reconciles the
 * session's parts away.
 *
 * @ref LLP 0050 [implements]: capture-seam usage-policy skip over `working_dir` before any row is built.
 * @param {{
 *   session: GooseSessionRow,
 *   messages: GooseMessageRow[],
 *   sourcePath?: string,
 *   clientName?: string,
 *   deriveRepo?: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 *   log?: PluginLogger,
 * }} args
 * @returns {Promise<BackfillItem | undefined>}
 */
export async function projectGooseSession(args) {
  const {
    session,
    messages,
    sourcePath,
    clientName = GOOSE_CLIENT_NAME,
    deriveRepo = deriveRepoFromCwd,
    resolver = createUsagePolicyResolver({ localOnlyListPath: args.localOnlyListPath }),
    log,
  } = args

  if (session.working_dir) {
    const policy = resolver.resolve(session.working_dir)
    if (policy.class === 'ignore') {
      // @ref LLP 0570#privacy [implements]: the drop log names ids and the policy, never the working_dir path.
      // `governedBy` is omitted: it is the `.hypignore` path, which spells the directory out.
      log?.[policy.warn ? 'warn' : 'info']('plugin.goose.usage_policy_drop', {
        component: 'goose',
        operation: 'usage_policy_drop',
        session_id: session.id,
        declared: policy.declared,
        ...(policy.warn ? { warn: policy.warn } : {}),
      })
      return undefined
    }
  }

  /** @type {Map<string, number>} */
  const occurrences = new Map()
  /** @type {AiGatewayProjectedMessage[]} */
  const projectedMessages = []
  /** @type {string | undefined} */
  let inferredProvider
  /** @type {string | undefined} */
  let inferredModel
  for (const row of messages) {
    const messageKey = row.message_id ?? `id${row.id}`
    const occurrence = occurrences.get(messageKey) ?? 0
    occurrences.set(messageKey, occurrence + 1)

    const metadata = parseObject(row.metadata_json)
    // Goose's per-turn context injection, and anything else it hides from
    // the user, is not part of the conversation.
    if (metadata.turnContext === true || metadata.userVisible === false) continue
    const parts = partsForMessageRow(row)
    if (parts.length === 0) continue

    const inference = isPlainObject(metadata.inference) ? metadata.inference : {}
    const model = row.role === 'assistant' ? stringValue(inference.requestedModel) : undefined
    if (row.role === 'assistant') {
      inferredProvider = stringValue(inference.provider) ?? inferredProvider
      inferredModel = model ?? inferredModel
    }
    // @ref LLP 0035#one-carrier [implements]: one inference's usage rides only the row's LAST part.
    const usage = row.role === 'assistant' ? usageOf(metadata) : undefined
    const lastIndex = parts.length - 1
    parts.forEach(({ index, part }, i) => {
      /** @type {AiGatewayProjectedMessage} */
      const projected = {
        role: part.role,
        content: part.content,
        message_id: mintGooseMessageId(session.id, messageKey, occurrence, index),
        provider_uuid: String(row.id),
        message_created_at: epochSecondsToIso(row.created_timestamp),
      }
      if (model && part.role === 'assistant') projected.model = model
      if (usage && i === lastIndex) projected.attributes = { usage }
      projectedMessages.push(projected)
    })
  }

  const modelConfig = parseObject(session.model_config_json)
  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: inferredProvider ?? session.provider_name ?? 'unknown',
    session_id: gooseScopeId(session.id),
    conversation_source: clientName,
    client_name: clientName,
    entrypoint: `goose-${session.session_type}`,
    messages: projectedMessages,
  }
  const model = inferredModel ?? stringValue(modelConfig.model_name)
  if (model) exchange.model = model
  const conversationStartedAt = gooseTimestampToIso(session.created_at)
  if (conversationStartedAt) exchange.conversation_started_at = conversationStartedAt
  // @ref LLP 0570#projection [implements]: D2, a sub_agent session links to its parent.
  if (session.parent_session_id) exchange.parent_thread_id = gooseScopeId(session.parent_session_id)
  if (session.working_dir) {
    exchange.cwd = session.working_dir
    const derived = await deriveRepo(session.working_dir)
    if (derived.git_remote) exchange.git_remote = derived.git_remote
    if (derived.repo_root) exchange.repo_root = derived.repo_root
  }

  // D3: the model-generated name is content, captured only past the policy
  // skip above. The name is the revision, so a session whose `updated_at`
  // moves on every message keeps one title row until it is renamed.
  const titleUpdatedAt = gooseTimestampToIso(session.updated_at)
  if (titleUpdatedAt) captureSessionTitle(exchange, session.name, { updatedAt: titleUpdatedAt, revision: session.name })

  /** @type {BackfillProvenance} */
  const provenance = { client_name: clientName, native_id: String(session.id) }
  if (sourcePath) provenance.source_path = sourcePath

  const item = projectedExchangeItem(exchange, provenance)
  // @ref LLP 0449#reconciliation [implements]: only this client's session is replaced.
  item.reconcile = { where: gooseReconcileScope(clientName, session.id), key: 'part_id' }
  return item
}

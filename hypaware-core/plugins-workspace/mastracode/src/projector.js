// @ts-check

import { deriveRepoFromCwd } from './git_repo.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { projectedExchangeItem } from '../../../../src/core/backfill/scan_util.js'
import { captureSessionTitle } from '../../../../src/core/backfill/session_title.js'
import { isPlainObject, parseMaybeJson, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, BackfillItem, BackfillProvenance, JsonObject, JsonValue, PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { MastraMessageRow, MastraSkipCounts, MastraThreadRow } from './types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * Maps a whole Mastra Code thread (one `mastra_threads` row plus its
 * `mastra_messages` rows, in `(createdAt, rowid)` order, as
 * `MastraDb.readThreadSnapshot` returns them) to the
 * `ai_gateway.projected_exchange` materializer item. The backfill provider
 * and the poll source both project the whole thread, so a part's identity
 * never depends on when or how often it was observed.
 *
 * @ref LLP 0586#projection [implements]: the Mastra Code -> AiGatewayProjectedExchange mapping.
 */

/** `client_name` / `conversation_source` / `entrypoint` for every Mastra Code row. */
export const MASTRACODE_CLIENT_NAME = 'mastracode'

/**
 * The `tokenUsage` counters carried in `process_token_usage`, as LLP 0586
 * records them. `raw` (the provider's own usage object) never is.
 */
const USAGE_COUNTERS = ['promptTokens', 'completionTokens', 'totalTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens']

/**
 * Namespace a Mastra Code thread id so it cannot collide with another
 * client's session id in the shared `session_id` column.
 *
 * @param {string} id
 * @returns {string}
 */
export function mastracodeScopeId(id) {
  return `mastracode-${id}`
}

/**
 * The reconciliation scope for one Mastra Code thread: only this client's
 * rows for this thread are replaced.
 *
 * @param {string} clientName
 * @param {string} threadId
 * @returns {{ client_name: string, session_id: string }}
 */
export function mastracodeReconcileScope(clientName, threadId) {
  return { client_name: clientName, session_id: mastracodeScopeId(threadId) }
}

/**
 * Deterministic `message_id` for one part of a Mastra Code message. Message
 * ids are UUIDs that survive an in-place rewrite, and `index` is the part's
 * position in the message's `parts` array, so a growing assistant row keeps
 * its ids. `suffix` tells apart the call and result one `tool-invocation`
 * yields.
 *
 * @param {string} threadId
 * @param {string} messageId
 * @param {number} index
 * @param {string} [suffix]
 * @returns {string}
 */
export function mintMastracodePartId(threadId, messageId, index, suffix) {
  return `mastracode-${threadId}-${messageId}-${index}${suffix ? `-${suffix}` : ''}`
}

/**
 * The provider segment of a Mastra Code model id: `openai` from
 * `openai/gpt-5.5` or `mastracode/openai/gpt-5.5`. Undefined for a bare
 * model name.
 *
 * @param {string | undefined} model
 * @returns {string | undefined}
 */
export function providerOfModel(model) {
  if (!model) return undefined
  const segments = model.split('/')
  if (segments[0] === MASTRACODE_CLIENT_NAME) segments.shift()
  return segments.length > 1 && segments[0] ? segments[0] : undefined
}

/**
 * @param {unknown} raw
 * @returns {JsonObject}
 */
function parseObject(raw) {
  const parsed = raw == null ? undefined : parseMaybeJson(raw)
  return isPlainObject(parsed) ? /** @type {JsonObject} */ (parsed) : {}
}

/**
 * A part's own epoch-ms `createdAt` as ISO 8601, else the row's.
 *
 * @param {JsonObject} part
 * @param {string} rowCreatedAt
 * @returns {string | undefined}
 */
function partCreatedAt(part, rowCreatedAt) {
  const ms = part.createdAt
  if (typeof ms === 'number' && Number.isFinite(ms)) return new Date(ms).toISOString()
  return stringValue(rowCreatedAt)
}

/**
 * @param {MastraSkipCounts | undefined} counts
 * @param {keyof MastraSkipCounts} kind
 */
function countSkip(counts, kind) {
  if (counts) counts[kind] = (counts[kind] ?? 0) + 1
}

/**
 * The thread's `tokenUsage` counters, finite numbers only, or undefined
 * when none are present.
 *
 * @param {JsonObject} metadata
 * @returns {JsonObject | undefined}
 */
function processTokenUsage(metadata) {
  if (!isPlainObject(metadata.tokenUsage)) return undefined
  /** @type {JsonObject} */
  const usage = {}
  for (const key of USAGE_COUNTERS) {
    const value = metadata.tokenUsage[key]
    if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

/**
 * Expand one user message: its text parts joined into one user part, tagged
 * with the first text part's index.
 *
 * @param {MastraMessageRow} row
 * @param {JsonObject[]} parts
 * @returns {Array<{ index: number, suffix?: string, role: string, content: JsonObject[], createdAt?: string, model?: string }>}
 */
function userParts(row, parts) {
  /** @type {string[]} */
  const texts = []
  let first = -1
  /** @type {string | undefined} */
  let createdAt
  parts.forEach((part, index) => {
    if (part.type !== 'text') return
    const text = stringValue(part.text)
    if (!text) return
    if (first === -1) {
      first = index
      createdAt = partCreatedAt(part, row.createdAt)
    }
    texts.push(text)
  })
  if (first === -1) return []
  return [{ index: first, role: 'user', content: [{ type: 'text', text: texts.join('\n') }], createdAt }]
}

/**
 * Expand one assistant message's parts, in content order. A `step-start`
 * part sets the model for the parts after it. D6: a
 * `data-workspace-metadata` part (which holds the workspace's filesystem and
 * sandbox paths) is dropped before anything is read from it.
 *
 * @ref LLP 0586#owner-decisions [implements]: D6, workspace metadata is dropped before a row is built.
 * @param {MastraMessageRow} row
 * @param {JsonObject[]} parts
 * @param {MastraSkipCounts | undefined} counts
 * @returns {Array<{ index: number, suffix?: string, role: string, content: JsonObject[], createdAt?: string, model?: string }>}
 */
function assistantParts(row, parts, counts) {
  /** @type {Array<{ index: number, suffix?: string, role: string, content: JsonObject[], createdAt?: string, model?: string }>} */
  const out = []
  /** @type {string | undefined} */
  let stepModel
  parts.forEach((part, index) => {
    if (part.type === 'data-workspace-metadata') return
    const createdAt = partCreatedAt(part, row.createdAt)
    if (part.type === 'step-start') {
      stepModel = stringValue(part.model) ?? stepModel
    } else if (part.type === 'text') {
      const text = stringValue(part.text)
      if (text) out.push({ index, role: 'assistant', content: [{ type: 'text', text }], createdAt, model: stepModel })
    } else if (part.type === 'tool-invocation') {
      const invocation = isPlainObject(part.toolInvocation) ? part.toolInvocation : {}
      const id = stringValue(invocation.toolCallId)
      /** @type {JsonObject} */
      const call = { type: 'tool_use' }
      const name = stringValue(invocation.toolName)
      if (id) call.id = id
      if (name) call.name = name
      call.input = /** @type {JsonValue} */ (parseMaybeJson(invocation.args) ?? null)
      out.push({ index, role: 'assistant', content: [call], createdAt, model: stepModel })
      // No error flag: the invocation part carries no error field.
      if (invocation.state === 'result') {
        /** @type {JsonObject} */
        const result = { type: 'tool_result' }
        if (id) result.tool_use_id = id
        if (invocation.result !== undefined) result.content = /** @type {JsonValue} */ (invocation.result)
        out.push({ index, suffix: 'result', role: 'tool', content: [result], createdAt })
      }
    } else if (part.type === 'data-sandbox-exit' || part.type === 'reasoning') {
      countSkip(counts, part.type)
    } else {
      countSkip(counts, 'unknown')
    }
  })
  return out
}

/**
 * Project one whole Mastra Code thread into a ready-to-yield `BackfillItem`.
 * Returns `undefined` only when the thread's project is usage-policy
 * dropped; an empty transcript is still an item, so a thread whose messages
 * were pruned reconciles its parts away.
 *
 * @ref LLP 0050 [implements]: capture-seam usage-policy skip over `projectPath` before any row is built.
 * @param {{
 *   thread: MastraThreadRow,
 *   messages: MastraMessageRow[],
 *   sourcePath?: string,
 *   clientName?: string,
 *   deriveRepo?: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 *   log?: PluginLogger,
 *   skipped?: MastraSkipCounts,
 * }} args
 * @returns {Promise<BackfillItem | undefined>}
 */
export async function projectMastracodeThread(args) {
  const {
    thread,
    messages,
    sourcePath,
    clientName = MASTRACODE_CLIENT_NAME,
    deriveRepo = deriveRepoFromCwd,
    resolver = createUsagePolicyResolver({ localOnlyListPath: args.localOnlyListPath }),
    log,
    skipped,
  } = args

  const metadata = parseObject(thread.metadata)
  const projectPath = stringValue(metadata.projectPath)
  if (projectPath) {
    const policy = resolver.resolve(projectPath)
    if (policy.class === 'ignore') {
      // @ref LLP 0586#privacy [implements]: the drop log names ids and the policy, never the project path.
      // `governedBy` is omitted: it is the `.hypignore` path, which spells the directory out.
      log?.[policy.warn ? 'warn' : 'info']('plugin.mastracode.usage_policy_drop', {
        component: 'mastracode',
        operation: 'usage_policy_drop',
        session_id: thread.id,
        declared: policy.declared,
        ...(policy.warn ? { warn: policy.warn } : {}),
      })
      return undefined
    }
  }
  const threadModel = stringValue(metadata.currentModelId)

  /** @type {Array<{ row: MastraMessageRow, role: 'user' | 'assistant', parts: ReturnType<typeof assistantParts>, model?: string, provider?: string }>} */
  const expanded = []
  for (const row of messages) {
    const content = parseObject(row.content)
    const parts = Array.isArray(content.parts) ? content.parts.filter(isPlainObject) : []
    if (row.role === 'signal') {
      if (row.type !== 'user') {
        countSkip(skipped, 'signal_other')
        continue
      }
      expanded.push({ row, role: 'user', parts: userParts(row, /** @type {JsonObject[]} */ (parts)) })
    } else if (row.role === 'assistant') {
      const contentMetadata = isPlainObject(content.metadata) ? content.metadata : {}
      const model = stringValue(contentMetadata.modelId) ?? threadModel
      const provider = stringValue(contentMetadata.provider) ?? providerOfModel(model)
      expanded.push({ row, role: 'assistant', parts: assistantParts(row, /** @type {JsonObject[]} */ (parts), skipped), model, provider })
    } else {
      countSkip(skipped, 'unknown')
    }
  }

  // The provider of each message's turn: its own for an assistant message,
  // else the next assistant message's, so a prompt carries the provider that
  // answered it (LLP 0194).
  /** @type {Array<string | undefined>} */
  const turnProvider = new Array(expanded.length)
  /** @type {string | undefined} */
  let next
  for (let i = expanded.length - 1; i >= 0; i--) {
    if (expanded[i].role === 'assistant') next = expanded[i].provider ?? next
    turnProvider[i] = next
  }

  /** @type {AiGatewayProjectedMessage[]} */
  const projectedMessages = []
  /** @type {string | undefined} */
  let inferredProvider
  /** @type {string | undefined} */
  let inferredModel
  /** @type {AiGatewayProjectedMessage | undefined} */
  let lastAssistantPart
  expanded.forEach((entry, entryIndex) => {
    const { row, role, parts } = entry
    if (parts.length === 0) return
    if (role === 'assistant') {
      inferredProvider = entry.provider ?? inferredProvider
      inferredModel = entry.model ?? inferredModel
    }
    const provider = turnProvider[entryIndex]
    const lastIndex = parts.length - 1
    parts.forEach((part, i) => {
      /** @type {AiGatewayProjectedMessage} */
      const projected = {
        role: part.role,
        content: part.content,
        message_id: mintMastracodePartId(thread.id, row.id, part.index, part.suffix),
        provider_uuid: row.id,
      }
      if (part.createdAt) projected.message_created_at = part.createdAt
      // The model is the step's `step-start` model, else the message's
      // `modelId`, else the thread's `currentModelId`.
      const model = part.model ?? entry.model
      if (model && part.role === 'assistant') projected.model = model
      if (provider) projected.provider = provider
      projectedMessages.push(projected)
      if (role === 'assistant' && i === lastIndex) lastAssistantPart = projected
    })
  })

  // @ref LLP 0586#owner-decisions [implements]: D4, no LLP 0035 usage; the
  // thread's running counter rides the latest assistant message's last part.
  const usage = processTokenUsage(metadata)
  if (usage && lastAssistantPart) {
    lastAssistantPart.attributes = { mastracode: { process_token_usage: usage } }
  }

  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: inferredProvider ?? providerOfModel(threadModel) ?? 'unknown',
    session_id: mastracodeScopeId(thread.id),
    conversation_source: clientName,
    client_name: clientName,
    entrypoint: clientName,
    messages: projectedMessages,
  }
  const model = inferredModel ?? threadModel
  if (model) exchange.model = model
  const conversationStartedAt = stringValue(thread.createdAt)
  if (conversationStartedAt) exchange.conversation_started_at = conversationStartedAt
  // @ref LLP 0586#privacy [implements]: `projectPath` is the row's `cwd`, the
  // marking the LLP 0070 export seam withholds local-only rows by, and the
  // only other place it goes is the repo lookup.
  if (projectPath) {
    exchange.cwd = projectPath
    const derived = await deriveRepo(projectPath)
    if (derived.git_remote) exchange.git_remote = derived.git_remote
    if (derived.repo_root) exchange.repo_root = derived.repo_root
  }

  // D8: the title is content, captured only past the policy skip above. The
  // title is the revision, so a thread whose `updatedAt` moves on every step
  // keeps one title row until it is renamed.
  const titleUpdatedAt = stringValue(thread.updatedAt)
  if (titleUpdatedAt && thread.title) captureSessionTitle(exchange, thread.title, { updatedAt: titleUpdatedAt, revision: thread.title })

  /** @type {BackfillProvenance} */
  const provenance = { client_name: clientName, native_id: thread.id }
  if (sourcePath) provenance.source_path = sourcePath

  const item = projectedExchangeItem(exchange, provenance)
  // @ref LLP 0449#reconciliation [implements]: only this client's thread is replaced.
  item.reconcile = { where: mastracodeReconcileScope(clientName, thread.id), key: 'part_id' }
  return item
}

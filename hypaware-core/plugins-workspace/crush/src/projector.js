// @ts-check

import { deriveRepoFromCwd } from './git_repo.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { projectedExchangeItem } from '../../../../src/core/backfill/scan_util.js'
import { captureSessionTitle } from '../../../../src/core/backfill/session_title.js'
import { isPlainObject, parseMaybeJson, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, BackfillItem, BackfillProvenance, JsonObject, JsonValue, PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { CrushMessageRow, CrushSessionRow } from './types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * Maps a whole Crush session (one `sessions` row plus its `messages` rows,
 * in `(created_at, rowid)` order, as `CrushDb.readSessionSnapshot` returns
 * them) to the `ai_gateway.projected_exchange` materializer item. The
 * backfill provider and the poll source both project the whole session, so
 * a part's identity never depends on when or how often it was observed.
 *
 * @ref LLP 0573#projection [implements]: the Crush -> AiGatewayProjectedExchange mapping.
 */

/** `client_name` / `conversation_source` for every Crush row. */
export const CRUSH_CLIENT_NAME = 'crush'

/**
 * Namespace a Crush session id so it cannot collide with another client's
 * session id in the shared `session_id` column.
 *
 * @param {string} id
 * @returns {string}
 */
export function crushScopeId(id) {
  return `crush-${id}`
}

/**
 * The reconciliation scope for one Crush session: only this client's rows
 * for this session are replaced.
 *
 * @param {string} clientName
 * @param {string} sessionId
 * @returns {{ client_name: string, session_id: string }}
 */
export function crushReconcileScope(clientName, sessionId) {
  return { client_name: clientName, session_id: crushScopeId(sessionId) }
}

/**
 * Deterministic `message_id` for one part of a Crush message. Crush message
 * ids are UUIDs that survive in-place updates, and `index` is the part's
 * position in the message's `parts` array, so a streamed message keeps its
 * ids as it grows. `suffix` tells apart the two parts one `shell_command`
 * yields.
 *
 * @param {string} sessionId
 * @param {string} messageId
 * @param {number} index
 * @param {string} [suffix]
 * @returns {string}
 */
export function mintCrushPartId(sessionId, messageId, index, suffix) {
  return `crush-${sessionId}-${messageId}-${index}${suffix ? `-${suffix}` : ''}`
}

/**
 * Remove Crush's last `<cwd>...</cwd>` element, preserving any hook text
 * appended after it. Earlier elements belong to the command's output.
 *
 * @ref LLP 0573#owner-decisions [implements]: D5, the working directory is stripped before a row is built.
 * @param {string} text
 * @returns {string}
 */
export function stripCwd(text) {
  const end = text.lastIndexOf('</cwd>')
  if (end === -1) return text
  const start = text.lastIndexOf('<cwd>', end)
  if (start === -1) return text
  return `${text.slice(0, start).trimEnd()}${text.slice(end + 6)}`.trimEnd()
}

/**
 * Epoch seconds to ISO 8601.
 *
 * @param {number | null | undefined} seconds
 * @returns {string | undefined}
 */
function epochSecondsToIso(seconds) {
  if (seconds == null) return undefined
  const value = Number(seconds)
  return Number.isFinite(value) ? new Date(Math.round(value * 1000)).toISOString() : undefined
}

/**
 * @param {string | undefined} role
 * @returns {'user' | 'assistant' | 'tool' | undefined}
 */
function roleOf(role) {
  return role === 'user' || role === 'assistant' || role === 'tool' ? role : undefined
}

/**
 * Expand one message's `parts` JSON into projected parts, each tagged with
 * its index in the array so the minted id survives a skipped sibling. The
 * `finish` reason is returned separately; it rides on the last part.
 *
 * D5: a tool result's `metadata` (which holds `working_directory`, and for
 * file tools the file path) is never carried, and its `content` loses the
 * last `<cwd>` element, even before hook text. Image and binary parts become
 * placeholders that name the type and MIME type, never the bytes, URL or file
 * path.
 *
 * @param {CrushMessageRow} row
 * @param {'user' | 'assistant' | 'tool'} role
 * @returns {{ parts: Array<{ index: number, suffix?: string, role: string, content: JsonObject[], shell?: boolean, crush?: JsonObject }>, finish?: string }}
 */
function partsForMessageRow(row, role) {
  const parsed = parseMaybeJson(row.parts)
  /** @type {Array<{ index: number, suffix?: string, role: string, content: JsonObject[], shell?: boolean, crush?: JsonObject }>} */
  const parts = []
  /** @type {string | undefined} */
  let finish
  if (!Array.isArray(parsed)) return { parts }
  parsed.forEach((item, index) => {
    if (!isPlainObject(item)) return
    const data = isPlainObject(item.data) ? item.data : {}
    if (item.type === 'text') {
      const text = stringValue(data.text)
      if (text) parts.push({ index, role, content: [{ type: 'text', text }] })
    } else if (item.type === 'reasoning') {
      const thinking = stringValue(data.thinking)
      if (thinking) parts.push({ index, role: 'assistant', content: [{ type: 'thinking', thinking }] })
    } else if (item.type === 'tool_call') {
      /** @type {JsonObject} */
      const block = { type: 'tool_use' }
      const id = stringValue(data.id)
      const name = stringValue(data.name)
      if (id) block.id = id
      if (name) block.name = name
      block.input = /** @type {JsonValue} */ (parseMaybeJson(data.input) ?? null)
      parts.push({ index, role: 'assistant', content: [block] })
    } else if (item.type === 'tool_result') {
      /** @type {JsonObject} */
      const block = { type: 'tool_result' }
      const id = stringValue(data.tool_call_id)
      if (id) block.tool_use_id = id
      if (typeof data.content === 'string') block.content = stripCwd(data.content)
      if (data.is_error === true) block.is_error = true
      parts.push({ index, role: 'tool', content: [block] })
    } else if (item.type === 'sub_agent_report') {
      // Crush v0.100.0 stores detached results as user messages, but they
      // are tool output, not human prompts. No tool-call id is supplied.
      /** @type {JsonObject} */
      const block = { type: 'tool_result', content: typeof data.output === 'string' ? stripCwd(data.output) : '' }
      if (data.failed === true) block.is_error = true
      /** @type {JsonObject} */
      const crush = {}
      const label = stringValue(data.label)
      const model = stringValue(data.model)
      if (label) crush.subagent_label = label
      // Keep the child's display model separate from parent turn attribution.
      if (model) crush.subagent_model = model
      parts.push({ index, role: 'tool', content: [block], crush })
    } else if (item.type === 'shell_command') {
      // A command the user ran with `!`: a tool call and its result, marked
      // so it is not counted as a prompt.
      const callId = `${row.id}-${index}`
      /** @type {JsonObject} */
      const result = { type: 'tool_result', tool_use_id: callId }
      if (typeof data.output === 'string') result.content = stripCwd(data.output)
      if (typeof data.exit_code === 'number' && Number.isFinite(data.exit_code)) {
        result.exit_code = data.exit_code
        if (data.exit_code !== 0) result.is_error = true
      }
      parts.push({ index, suffix: 'call', role, shell: true, content: [{ type: 'tool_use', id: callId, name: 'bash', input: { command: typeof data.command === 'string' ? data.command : '' } }] })
      parts.push({ index, suffix: 'result', role: 'tool', shell: true, content: [result] })
    } else if (item.type === 'image_url' || item.type === 'binary') {
      /** @type {JsonObject} */
      const block = { type: item.type === 'image_url' ? 'image' : 'binary' }
      const mime = stringValue(data.mime_type)
      if (mime) block.mime_type = mime
      parts.push({ index, role, content: [block] })
    } else if (item.type === 'finish') {
      finish = stringValue(data.reason) ?? finish
    }
  })
  return { parts, finish }
}

/**
 * Project one whole Crush session into a ready-to-yield `BackfillItem`.
 * Returns `undefined` only when the session's project is usage-policy
 * dropped; an empty transcript is still an item, so a full rewind
 * reconciles the session's parts away.
 *
 * @ref LLP 0050 [implements]: capture-seam usage-policy skip over the project directory before any row is built.
 * @param {{
 *   session: CrushSessionRow,
 *   messages: CrushMessageRow[],
 *   projectDir?: string,
 *   sourcePath?: string,
 *   clientName?: string,
 *   deriveRepo?: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 *   log?: PluginLogger,
 * }} args
 * @returns {Promise<BackfillItem | undefined>}
 */
export async function projectCrushSession(args) {
  const {
    session,
    messages,
    projectDir,
    sourcePath,
    clientName = CRUSH_CLIENT_NAME,
    deriveRepo = deriveRepoFromCwd,
    resolver = createUsagePolicyResolver({ localOnlyListPath: args.localOnlyListPath }),
    log,
  } = args

  if (projectDir) {
    const policy = resolver.resolve(projectDir)
    if (policy.class === 'ignore') {
      // @ref LLP 0573#privacy [implements]: the drop log names ids and the policy, never the project path.
      // `governedBy` is omitted: it is the `.hypignore` path, which spells the directory out.
      log?.[policy.warn ? 'warn' : 'info']('plugin.crush.usage_policy_drop', {
        component: 'crush',
        operation: 'usage_policy_drop',
        session_id: session.id,
        declared: policy.declared,
        ...(policy.warn ? { warn: policy.warn } : {}),
      })
      return undefined
    }
  }

  // The provider of each message's turn: its own for an assistant message,
  // else the next assistant message's, so a prompt and its tool results
  // carry the provider that answered them (LLP 0194).
  /** @type {Array<string | undefined>} */
  const turnProvider = new Array(messages.length)
  /** @type {string | undefined} */
  let next
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') next = stringValue(messages[i].provider) ?? next
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
  messages.forEach((row, rowIndex) => {
    const role = roleOf(row.role)
    if (!role) return
    const { parts, finish } = partsForMessageRow(row, role)
    if (parts.length === 0) return
    const model = role === 'assistant' ? stringValue(row.model) : undefined
    const provider = turnProvider[rowIndex]
    if (role === 'assistant') {
      inferredProvider = stringValue(row.provider) ?? inferredProvider
      inferredModel = model ?? inferredModel
    }
    const lastIndex = parts.length - 1
    parts.forEach((part, i) => {
      /** @type {AiGatewayProjectedMessage} */
      const projected = {
        role: part.role,
        content: part.content,
        message_id: mintCrushPartId(session.id, row.id, part.index, part.suffix),
        provider_uuid: row.id,
        message_created_at: epochSecondsToIso(row.created_at),
      }
      if (model && part.role === 'assistant') projected.model = model
      if (provider) projected.provider = provider
      /** @type {JsonObject} */
      const crush = part.crush ?? {}
      if (part.shell) crush.user_shell = true
      if (row.is_summary_message) crush.summary = true
      if (Object.keys(crush).length > 0) projected.attributes = { crush }
      if (finish && i === lastIndex) projected.stop_reason = finish
      projectedMessages.push(projected)
      if (role === 'assistant' && i === lastIndex) lastAssistantPart = projected
    })
  })

  // @ref LLP 0573#owner-decisions [implements]: D2, no usage; a root session's cost rides the latest assistant message's last part, omitted at 0.
  if (!session.parent_session_id && lastAssistantPart && Number.isFinite(session.cost) && session.cost > 0) {
    const attributes = lastAssistantPart.attributes ?? {}
    const crush = isPlainObject(attributes.crush) ? attributes.crush : {}
    crush.session_cost_usd = session.cost
    attributes.crush = crush
    lastAssistantPart.attributes = attributes
  }

  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: inferredProvider ?? 'unknown',
    session_id: crushScopeId(session.id),
    conversation_source: clientName,
    client_name: clientName,
    entrypoint: session.parent_session_id ? 'crush-task' : 'crush',
    messages: projectedMessages,
  }
  if (inferredModel) exchange.model = inferredModel
  const conversationStartedAt = epochSecondsToIso(session.created_at)
  if (conversationStartedAt) exchange.conversation_started_at = conversationStartedAt
  // @ref LLP 0573#owner-decisions [implements]: D3, a task session links to its parent.
  if (session.parent_session_id) exchange.parent_thread_id = crushScopeId(session.parent_session_id)
  // @ref LLP 0573#privacy [implements]: the project directory is the row's
  // `cwd`, the marking the LLP 0070 export seam withholds local-only rows by.
  // D5 strips only the paths inside tool results.
  if (projectDir) {
    exchange.cwd = projectDir
    const derived = await deriveRepo(projectDir)
    if (derived.git_remote) exchange.git_remote = derived.git_remote
    if (derived.repo_root) exchange.repo_root = derived.repo_root
  }

  // D7: the title is content, captured only past the policy skip above. The
  // title is the revision, so a session whose `updated_at` moves on every
  // message keeps one title row until it is renamed.
  const titleUpdatedAt = epochSecondsToIso(session.updated_at)
  if (titleUpdatedAt && session.title) captureSessionTitle(exchange, session.title, { updatedAt: titleUpdatedAt, revision: session.title })

  /** @type {BackfillProvenance} */
  const provenance = { client_name: clientName, native_id: session.id }
  if (sourcePath) provenance.source_path = sourcePath

  const item = projectedExchangeItem(exchange, provenance)
  // @ref LLP 0449#reconciliation [implements]: only this client's session is replaced.
  item.reconcile = { where: crushReconcileScope(clientName, session.id), key: 'part_id' }
  return item
}

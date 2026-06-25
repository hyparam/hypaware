// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { redactRemoteUserinfo } from './git-remote.js'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, BackfillContribution, BackfillEvent, BackfillItem, BackfillProvenance, BackfillRunContext, JsonObject, JsonValue, PluginLogger } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { CodexRolloutItem, CodexRolloutSession } from './types.d.ts'
 */

/**
 * `@hypaware/codex` backfill provider.
 *
 * Imports local Codex history into `ai_gateway_messages` by reading the
 * rollout files the Codex CLI/Desktop writes under
 * `<codexHome>/sessions/**`, recovering each session's conversation, and
 * projecting it into an `AiGatewayProjectedExchange`. The
 * `@hypaware/ai-gateway` `ai_gateway.projected_exchange` materializer
 * expands those into the same canonical rows the live Codex projector
 * produces, so backfilled and live rows line up for the same conversation
 * (`provider = 'openai'`, `conversation_source = 'codex'`).
 *
 * Discovery stack (V1):
 *   - `<codexHome>/sessions/**`     PRIMARY. Session/event JSONL (modern)
 *                                   and legacy single-doc `{session,items}`.
 *   - `<codexHome>/history.*`       diagnostic only — command/input history,
 *                                   not enough for canonical rows. Detected,
 *                                   never parsed here.
 *   - `<codexHome>/log/**`          diagnostic only — version/breadcrumbs.
 *   - ChatGPT/Codex app + browser   detected, NEVER parsed in V1; flagged
 *     storage                       via an `unsupported_location` event.
 *   - HypAware's gateway cache      excluded (lives under HYP_HOME, not
 *                                   scanned here).
 *
 * Parsing is best-effort and version-defensive: a malformed line, a
 * truncated trailing record, or an unreadable file degrades to whatever
 * parsed cleanly rather than aborting the run. Reruns are deterministic —
 * ids, parents, and timestamps come straight from the immutable rollout
 * and the materializer is pure.
 */

const DEFAULT_CLIENT_NAME = 'codex'
const DEFAULT_PLUGIN_NAME = '@hypaware/codex'

// The Codex client speaks the OpenAI wire format, so backfilled rows carry
// provider 'openai' and conversation_source 'codex' — matching the live
// @hypaware/codex exchange projector's chatgpt/api output split.
const PROVIDER = 'openai'
const CONVERSATION_SOURCE = 'codex'

// Dataset name and materializer dispatch key owned by `@hypaware/ai-gateway`
// (DATASET_NAME / AI_GATEWAY_PROJECTED_EXCHANGE_KIND in its dataset.js).
// Held as plain constants so this adapter does not pull the gateway's
// runtime module graph in just for two strings; the end-to-end test pins
// them by feeding yielded items through the real materializer.
const AI_GATEWAY_MESSAGES_DATASET = 'ai_gateway_messages'
const PROJECTED_EXCHANGE_KIND = 'ai_gateway.projected_exchange'

const COMPONENT = 'plugin.codex.backfill'
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Build the Codex backfill provider. Registered at plugin activation via
 * `ctx.backfills.register(...)`. The provider closes over the resolved
 * Codex home / sessions root so `run()` needs only the kernel-supplied
 * `BackfillRunContext`.
 *
 * @param {{
 *   homeDir: string,
 *   codexHome?: string,
 *   sessionsDir?: string,
 *   unsupportedLocations?: Array<{ kind: string, path: string }>,
 *   clientName?: string,
 *   pluginName?: string,
 * }} opts
 * @returns {BackfillContribution}
 */
export function createCodexBackfillProvider(opts) {
  const clientName = opts.clientName ?? DEFAULT_CLIENT_NAME
  const pluginName = opts.pluginName ?? DEFAULT_PLUGIN_NAME
  const codexHome = opts.codexHome ?? defaultCodexHome(opts.homeDir)
  const sessionsDir = opts.sessionsDir ?? path.join(codexHome, 'sessions')
  const unsupportedLocations = opts.unsupportedLocations ?? defaultUnsupportedLocations(opts.homeDir)

  return {
    name: clientName,
    plugin: pluginName,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import local Codex session rollouts into ai_gateway_messages',
    async *run(ctx) {
      yield* runCodexBackfill({ ctx, codexHome, sessionsDir, unsupportedLocations, clientName })
    },
  }
}

/** @param {string} homeDir */
export function defaultCodexHome(homeDir) {
  return path.join(homeDir, '.codex')
}

/**
 * Codex/ChatGPT app + browser storage we DETECT but never parse in V1.
 * The desktop apps and browser-based ChatGPT keep conversation state in
 * opaque app containers and browser local storage; recovering canonical
 * rows from them is out of scope, so the provider flags them with an
 * `unsupported_location` event instead of guessing at the format.
 *
 * @param {string} homeDir
 * @returns {Array<{ kind: string, path: string }>}
 */
function defaultUnsupportedLocations(homeDir) {
  return [
    { kind: 'chatgpt_desktop_app', path: path.join(homeDir, 'Library', 'Application Support', 'ChatGPT') },
    { kind: 'chatgpt_desktop_app', path: path.join(homeDir, '.config', 'ChatGPT') },
    { kind: 'codex_desktop_app', path: path.join(homeDir, 'Library', 'Application Support', 'Codex') },
  ]
}

/**
 * Scan the sessions root, project each session, and yield one
 * `ai_gateway.projected_exchange` item per session. One item per session
 * keeps the materializer's per-call dedup state and tool-call lookup whole,
 * so a conversation's tool_use → tool_result pairing and fallback id chain
 * are never split across items.
 *
 * @param {{
 *   ctx: BackfillRunContext,
 *   codexHome: string,
 *   sessionsDir: string,
 *   unsupportedLocations: Array<{ kind: string, path: string }>,
 *   clientName: string,
 * }} args
 * @returns {AsyncGenerator<BackfillItem | BackfillEvent>}
 */
async function* runCodexBackfill(args) {
  const { ctx, codexHome, sessionsDir, unsupportedLocations, clientName } = args
  const log = ctx.log
  const window = resolveWindow(ctx)

  log.info('codex.backfill.scan_started', {
    component: COMPONENT,
    operation: 'backfill.scan',
    sessions_dir: sessionsDir,
    ...(window.sinceMs !== undefined ? { since: new Date(window.sinceMs).toISOString() } : {}),
    ...(window.untilMs !== undefined ? { until: new Date(window.untilMs).toISOString() } : {}),
    status: 'ok',
  })

  // Diagnostic-only sources: history.* and log/** carry breadcrumbs but
  // never enough to rebuild canonical conversation rows on their own, so
  // they are detected for observability and intentionally not parsed.
  await noteDiagnosticSources({ codexHome, log })

  // App/browser storage: detected, never parsed in V1.
  yield* flagUnsupportedLocations({ unsupportedLocations, log })

  let filesSeen = 0
  let sessionsProjected = 0
  let messagesProjected = 0

  for (const filePath of await listRolloutFiles(sessionsDir)) {
    if (ctx.signal?.aborted) break
    filesSeen += 1
    /** @type {CodexRolloutSession[]} */
    let sessions
    try {
      sessions = await parseRolloutFile(filePath)
    } catch (err) {
      log.warn('codex.backfill.rollout_read_failed', {
        component: COMPONENT,
        operation: 'backfill.scan',
        source_path: filePath,
        status: 'error',
        error_kind: 'rollout_read_failed',
        error: errMessage(err),
      })
      continue
    }

    for (const session of sessions) {
      const exchange = projectedExchangeFromSession({
        session,
        items: filterByWindow(session.items, window),
        clientName,
      })
      if (!exchange) continue

      sessionsProjected += 1
      messagesProjected += exchange.messages.length
      log.info('codex.backfill.session_projected', {
        component: COMPONENT,
        operation: 'backfill.project',
        conversation_id: session.sessionId,
        message_count: exchange.messages.length,
        identity_source: readCodexIdentitySource(exchange),
        status: 'ok',
      })

      yield backfillItem(exchange, {
        client_name: clientName,
        source_path: filePath,
        native_id: session.sessionId,
      })
    }
  }

  log.info('codex.backfill.scan_complete', {
    component: COMPONENT,
    operation: 'backfill.scan',
    files_seen: filesSeen,
    sessions_projected: sessionsProjected,
    messages_projected: messagesProjected,
    status: 'ok',
  })
}

/**
 * Flag — but never parse — Codex/ChatGPT app and browser storage. Each
 * existing location emits both a structured log and an `unsupported_location`
 * `BackfillEvent` (the kernel's named lifecycle signal) so the runner and a
 * human can see what history was left on the table.
 *
 * @param {{ unsupportedLocations: Array<{ kind: string, path: string }>, log: PluginLogger }} args
 * @returns {AsyncGenerator<BackfillEvent>}
 */
async function* flagUnsupportedLocations(args) {
  for (const location of args.unsupportedLocations) {
    if (!(await pathExists(location.path))) continue
    args.log.info('codex.backfill.unsupported_location', {
      component: COMPONENT,
      operation: 'backfill.scan',
      location_kind: location.kind,
      source_path: location.path,
      status: 'skipped',
    })
    yield {
      type: 'event',
      event: 'unsupported_location',
      attributes: {
        client_name: 'codex',
        location_kind: location.kind,
        path: location.path,
      },
    }
  }
}

/**
 * Detect diagnostic-only Codex sources and record that they were seen but
 * deliberately not used as a canonical backfill source.
 *
 * @param {{ codexHome: string, log: PluginLogger }} args
 */
async function noteDiagnosticSources(args) {
  const candidates = [
    { kind: 'history', path: path.join(args.codexHome, 'history.jsonl') },
    { kind: 'history', path: path.join(args.codexHome, 'history.json') },
    { kind: 'log', path: path.join(args.codexHome, 'log') },
  ]
  for (const candidate of candidates) {
    if (!(await pathExists(candidate.path))) continue
    args.log.info('codex.backfill.diagnostic_source_detected', {
      component: COMPONENT,
      operation: 'backfill.scan',
      source_kind: candidate.kind,
      source_path: candidate.path,
      used_as_canonical: false,
      status: 'ok',
    })
  }
}

// ---------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------

/**
 * Recursively collect rollout files under the sessions root, sorted for a
 * deterministic scan order. Matches `rollout-*.jsonl` (modern) and
 * `rollout-*.json` (legacy). A missing root yields `[]` rather than throwing.
 *
 * @param {string} sessionsDir
 * @returns {Promise<string[]>}
 */
async function listRolloutFiles(sessionsDir) {
  /** @type {string[]} */
  const out = []
  await collectRolloutFiles(sessionsDir, out)
  out.sort()
  return out
}

/**
 * @param {string} dir
 * @param {string[]} out
 * @returns {Promise<void>}
 */
async function collectRolloutFiles(dir, out) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectRolloutFiles(filePath, out)
    } else if (entry.isFile() && isRolloutFileName(entry.name)) {
      out.push(filePath)
    }
  }
}

/** @param {string} name */
function isRolloutFileName(name) {
  return name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith('.json'))
}

// ---------------------------------------------------------------------
// Parsing (version-defensive)
// ---------------------------------------------------------------------

/**
 * Parse one rollout file into zero or more sessions. The legacy format is a
 * single pretty-printed JSON object; the modern format is line-delimited
 * records. Each file holds one session, so the array carries at most one
 * entry — the array shape just keeps the run loop uniform.
 *
 * @param {string} filePath
 * @returns {Promise<CodexRolloutSession[]>}
 */
async function parseRolloutFile(filePath) {
  const text = await fs.readFile(filePath, 'utf8')
  const legacy = parseLegacyDoc(text, filePath)
  if (legacy) return [legacy]
  const modern = parseJsonlRollout(text, filePath)
  return modern ? [modern] : []
}

/**
 * Legacy rollout: a single JSON object `{ session: {...}, items: [...] }`.
 * Returns `undefined` when `text` is not a single JSON object (i.e. the
 * modern line-delimited format, where `JSON.parse` of the whole file throws
 * on the second record), so the caller falls back to JSONL parsing.
 *
 * @param {string} text
 * @param {string} filePath
 * @returns {CodexRolloutSession | undefined}
 */
function parseLegacyDoc(text, filePath) {
  /** @type {unknown} */
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.items)) return undefined
  const sessionMeta = isPlainObject(doc.session) ? doc.session : {}
  /** @type {CodexRolloutItem[]} */
  const items = []
  for (const raw of doc.items) {
    if (isPlainObject(raw)) items.push({ payload: raw })
  }
  return buildSession({ metaPayload: sessionMeta, turnPayloads: [], items, fallbackId: sessionIdFromPath(filePath) })
}

/**
 * Modern rollout: line-delimited `{ timestamp, type, payload }` records —
 * one `session_meta`, zero+ `turn_context`, and the conversation's
 * `response_item`s. A `token_count` `event_msg` carries the turn's token
 * usage and is captured as a synthetic turn-boundary marker (no message);
 * all other `event_msg` / `compacted` and unknown line types are skipped. A
 * blank or truncated line never aborts the parse.
 *
 * @param {string} text
 * @param {string} filePath
 * @returns {CodexRolloutSession | undefined}
 */
function parseJsonlRollout(text, filePath) {
  /** @type {Record<string, unknown> | undefined} */
  let metaPayload
  /** @type {Record<string, unknown>[]} */
  const turnPayloads = []
  /** @type {CodexRolloutItem[]} */
  const items = []
  let sawRecord = false

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    /** @type {unknown} */
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isPlainObject(row)) continue
    sawRecord = true
    const type = stringValue(row.type)
    const payload = isPlainObject(row.payload) ? row.payload : undefined
    if (type === 'session_meta' && payload) {
      if (!metaPayload) metaPayload = payload
    } else if (type === 'turn_context' && payload) {
      turnPayloads.push(payload)
    } else if (type === 'response_item' && payload) {
      items.push({ payload, timestampMs: timestampToMs(row.timestamp) })
    } else if (type === 'event_msg' && payload) {
      // The one event_msg we keep: token_count. It is NOT a message — it is a
      // turn-boundary marker carrying that turn's normalized usage. Its slot in
      // the items stream is preserved (so the projector can attribute it to the
      // preceding assistant message), but it never projects a row of its own.
      const usageAttributes = codexUsageFromTokenCount(payload)
      if (usageAttributes) {
        items.push({ payload: { type: 'token_count' }, timestampMs: timestampToMs(row.timestamp), usageAttributes })
      }
    }
  }

  if (!sawRecord) return undefined
  return buildSession({ metaPayload: metaPayload ?? {}, turnPayloads, items, fallbackId: sessionIdFromPath(filePath) })
}

/**
 * Fold a session_meta payload plus the turn contexts into the normalized
 * session header. Tolerant of missing fields across Codex versions.
 *
 * @param {{
 *   metaPayload: Record<string, unknown>,
 *   turnPayloads: Record<string, unknown>[],
 *   items: CodexRolloutItem[],
 *   fallbackId: string,
 * }} args
 * @returns {CodexRolloutSession}
 */
function buildSession(args) {
  const { metaPayload, turnPayloads, items, fallbackId } = args
  const git = isPlainObject(metaPayload.git) ? metaPayload.git : undefined
  const sandboxPolicy = firstTurnObject(turnPayloads, 'sandbox_policy')

  return {
    sessionId: stringValue(metaPayload.id) ?? fallbackId,
    startedAtMs: timestampToMs(metaPayload.timestamp),
    cwd: firstString(stringValue(metaPayload.cwd), firstTurnString(turnPayloads, 'cwd')),
    gitOriginUrl: git ? redactRemoteUserinfo(firstString(stringValue(git.repository_url), stringValue(git.origin_url))) : undefined,
    gitCommit: git ? firstString(stringValue(git.commit_hash), stringValue(git.commit)) : undefined,
    gitBranch: git ? stringValue(git.branch) : undefined,
    gitDirty: git ? firstBool(boolValue(git.dirty), boolValue(git.is_dirty)) : undefined,
    sandbox: firstString(sandboxPolicy ? stringValue(sandboxPolicy.type) : undefined, firstTurnString(turnPayloads, 'sandbox')),
    entrypoint: stringValue(metaPayload.originator),
    clientVersion: stringValue(metaPayload.cli_version),
    threadSource: stringValue(metaPayload.thread_source),
    // Subagent lineage: the parent thread that spawned this one. Lives
    // in the rollout's first `session_meta` row (mirrors the live
    // `x-codex-turn-metadata` header's `parent_thread_id`).
    parentThreadId: stringValue(metaPayload.parent_thread_id),
    model: firstTurnString(turnPayloads, 'model'),
    modelProvider: stringValue(metaPayload.model_provider),
    source: stringValue(metaPayload.source),
    items,
  }
}

// ---------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------

/**
 * Project one session's items into an `AiGatewayProjectedExchange`. Returns
 * `undefined` when no item carries projectable content, so empty sessions
 * are skipped instead of yielding a no-row item.
 *
 * @param {{
 *   session: CodexRolloutSession,
 *   items: CodexRolloutItem[],
 *   clientName: string,
 * }} args
 * @returns {AiGatewayProjectedExchange | undefined}
 */
function projectedExchangeFromSession(args) {
  const { session, items, clientName } = args
  /** @type {AiGatewayProjectedMessage[]} */
  const messages = []
  let nativeIdCount = 0
  // Index in `messages` where the current turn began. A token_count marker
  // closes the turn: its usage is stamped onto that turn's LAST assistant
  // message (mirroring the live projector's stampUsageOnLastAssistant), then
  // the next turn starts. Reasoning-only assistant messages are skipped as
  // stamp targets so live and backfilled rows carry usage on the same logical
  // message and dedupe to one row. @ref LLP 0035#per-turn
  let turnStartIndex = 0
  for (const item of items) {
    if (item.usageAttributes) {
      stampUsageOnTurn(messages, turnStartIndex, item.usageAttributes)
      turnStartIndex = messages.length
      continue
    }
    const message = projectedMessageFromItem(item)
    if (!message) continue
    if (message.message_id) nativeIdCount += 1
    messages.push(message)
  }
  if (messages.length === 0) return undefined

  // Native message ids preserved verbatim when the rollout carries them;
  // otherwise the gateway computes deterministic fallback identity.
  const identitySource = nativeIdCount > 0 ? 'native' : 'gateway_fallback'

  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: PROVIDER,
    // @ref LLP 0030#decision — the rollout id is the thread; the rollout
    // carries no distinct session id, so session_id (the non-null
    // partition key) and conversation_id (the thread) are both the
    // rollout id here.
    session_id: session.sessionId,
    conversation_id: session.sessionId,
    conversation_source: CONVERSATION_SOURCE,
    client_name: clientName,
    attributes: { codex: codexAttributes(session, identitySource) },
    messages,
  }
  if (session.startedAtMs !== undefined) exchange.conversation_started_at = new Date(session.startedAtMs).toISOString()
  if (session.cwd) exchange.cwd = session.cwd
  if (session.gitBranch) exchange.git_branch = session.gitBranch
  // @ref LLP 0032#capture — repo identity for the graph bridge (Repo/Commit),
  // from the rollout's session_meta `git` block (commitKey rejects an
  // abbreviated sha). repo_root is intentionally NOT set from `cwd`: the rollout
  // records no verified git toplevel, and the cwd may be a repo subdir, which
  // would mis-relativize File keys. Codex File nodes keep absolute keys in V1,
  // matching the live Codex path. @ref LLP 0032#codex-repo-root
  if (session.gitOriginUrl) exchange.git_remote = session.gitOriginUrl
  if (session.gitCommit) exchange.head_sha = session.gitCommit
  if (session.clientVersion) exchange.client_version = session.clientVersion
  if (session.entrypoint) exchange.entrypoint = session.entrypoint
  if (session.threadSource) exchange.user_type = session.threadSource
  if (session.sandbox) exchange.permission_mode = session.sandbox
  if (session.threadSource !== undefined) exchange.is_sidechain = session.threadSource === 'subagent'
  if (session.parentThreadId) exchange.parent_thread_id = session.parentThreadId
  if (session.model) exchange.model = session.model
  return exchange
}

/**
 * Conversation-level `attributes.codex` provenance, mirroring the keys the
 * live Codex exchange projector stamps so live and backfilled rows agree.
 * `identity_source` records whether native ids were recovered.
 *
 * @param {CodexRolloutSession} session
 * @param {string} identitySource
 * @returns {JsonObject}
 */
function codexAttributes(session, identitySource) {
  /** @type {JsonObject} */
  const attrs = { identity_source: identitySource }
  setIfString(attrs, 'session_id', session.sessionId)
  setIfString(attrs, 'workspace', session.cwd)
  setIfString(attrs, 'git_origin_url', session.gitOriginUrl)
  setIfString(attrs, 'git_commit', session.gitCommit)
  setIfString(attrs, 'sandbox', session.sandbox)
  setIfString(attrs, 'originator', session.entrypoint)
  setIfString(attrs, 'thread_source', session.threadSource)
  setIfString(attrs, 'model_provider', session.modelProvider)
  setIfString(attrs, 'source', session.source)
  if (session.gitDirty !== undefined) attrs.has_changes = session.gitDirty
  return attrs
}

/**
 * Project one Codex rollout response item into a normalized gateway
 * message. Returns `undefined` for items with no projectable content
 * (blank messages, empty/encrypted reasoning, unknown item types). When the
 * item carries a native `id` it becomes `message_id` (verbatim identity);
 * otherwise identity is left to the gateway's deterministic fallback.
 *
 * @param {CodexRolloutItem} item
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function projectedMessageFromItem(item) {
  const payload = item.payload
  const itemType = stringValue(payload.type)

  /** @type {AiGatewayProjectedMessage | undefined} */
  let message
  switch (itemType) {
  case 'message':
    message = messageItemToProjected(payload)
    break
  case 'function_call':
  case 'custom_tool_call':
    message = toolCallItemToProjected(payload)
    break
  case 'function_call_output':
  case 'custom_tool_call_output':
    message = toolOutputItemToProjected(payload)
    break
  case 'reasoning':
    message = reasoningItemToProjected(payload)
    break
  default:
    return undefined
  }
  if (!message) return undefined

  const nativeId = stringValue(payload.id)
  if (nativeId) message.message_id = nativeId
  if (item.timestampMs !== undefined) message.message_created_at = new Date(item.timestampMs).toISOString()
  // Carry the native item type as a provenance breadcrumb on the row.
  if (itemType) message.provider_type = itemType
  return message
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function messageItemToProjected(payload) {
  const role = stringValue(payload.role) ?? 'user'
  const content = textBlocksFromContent(payload.content)
  if (content.length === 0) return undefined
  return { role, content }
}

/**
 * Codex message content blocks use `input_text` / `output_text` (the
 * Responses API), which both normalize to the gateway's `text` block. A
 * bare string content is tolerated for older/leaner records.
 *
 * @param {unknown} content
 * @returns {JsonObject[]}
 */
function textBlocksFromContent(content) {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  /** @type {JsonObject[]} */
  const blocks = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      if (raw.length > 0) blocks.push({ type: 'text', text: raw })
      continue
    }
    if (!isPlainObject(raw)) continue
    const text = stringValue(raw.text) ?? stringValue(raw.input_text) ?? stringValue(raw.output_text)
    if (text) blocks.push({ type: 'text', text })
  }
  return blocks
}

/**
 * `function_call` (arguments as a JSON string) and `custom_tool_call`
 * (input string) both become an assistant `tool_use` block keyed on the
 * Codex `call_id`, so the gateway can pair it with the matching output.
 *
 * @param {Record<string, unknown>} payload
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function toolCallItemToProjected(payload) {
  const name = stringValue(payload.name)
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id)
  if (!name || !callId) return undefined
  const rawArgs = payload.arguments !== undefined ? payload.arguments : payload.input
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: callId, name, input: normalizeToolInput(rawArgs) }],
  }
}

/**
 * `function_call_output` / `custom_tool_call_output` become a `tool_result`
 * block referencing the originating `call_id`. The gateway maps it to a
 * `tool_result` part and back-fills the tool name from the earlier call.
 *
 * @param {Record<string, unknown>} payload
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function toolOutputItemToProjected(payload) {
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id)
  if (!callId) return undefined
  const text = toolOutputText(payload.output)
  /** @type {JsonObject} */
  const block = { type: 'tool_result', tool_use_id: callId }
  if (text !== undefined) block.content = text
  return { role: 'tool', content: [block] }
}

/**
 * `reasoning` items carry plaintext `summary` and/or `content` plus opaque
 * `encrypted_content`. Only the plaintext is projected (as a `thinking`
 * block → `reasoning` part); encrypted reasoning is never decoded or
 * stored. No plaintext → no message.
 *
 * @param {Record<string, unknown>} payload
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function reasoningItemToProjected(payload) {
  const text = reasoningText(payload.summary) ?? reasoningText(payload.content)
  if (!text) return undefined
  return { role: 'assistant', content: [{ type: 'thinking', thinking: text }] }
}

// ---------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------

/**
 * Pull a turn's normalized token usage from a `token_count` event_msg
 * payload. Reads the per-turn delta (`info.last_token_usage`), NOT the
 * cumulative session running total (`info.total_token_usage`) — stamping the
 * cumulative would multiply-count when usage is summed across a conversation.
 * Returns `undefined` for any other event_msg or a usage-less payload.
 *
 * @param {Record<string, unknown>} payload
 * @returns {JsonObject | undefined}
 */
function codexUsageFromTokenCount(payload) {
  if (stringValue(payload.type) !== 'token_count') return undefined
  const info = payload.info
  if (!isPlainObject(info)) return undefined
  return codexUsageAttributes(info.last_token_usage)
}

/**
 * Normalize a Codex `last_token_usage` block into the gateway's
 * `attributes.usage` shape, matching the live Codex projector and Claude.
 *
 * @param {unknown} rawUsage
 * @returns {JsonObject | undefined}
 */
function codexUsageAttributes(rawUsage) {
  if (!isPlainObject(rawUsage)) return undefined
  /** @type {JsonObject} */
  const usage = {}

  // @ref LLP 0035#net-input — Codex `input_tokens` is gross (it includes
  // `cached_input_tokens`); HypAware stores input_tokens NET of cache so it
  // never double-counts against cache_read_tokens and matches the Claude /
  // live-Codex convention. total_tokens stays raw, so net + cache_read +
  // output == total.
  const cachedInput = numberValue(rawUsage.cached_input_tokens)
  const grossInput = numberValue(rawUsage.input_tokens)
  if (grossInput !== undefined) {
    usage.input_tokens = cachedInput !== undefined ? Math.max(0, grossInput - cachedInput) : grossInput
  }
  if (cachedInput !== undefined) usage.cache_read_tokens = cachedInput

  copyNumberAlias(rawUsage, usage, 'output_tokens', 'output_tokens')
  copyNumberAlias(rawUsage, usage, 'reasoning_output_tokens', 'reasoning_tokens')
  copyNumberAlias(rawUsage, usage, 'total_tokens', 'total_tokens')

  return Object.keys(usage).length === 0 ? undefined : { usage }
}

/**
 * Stamp a turn's usage onto the LAST assistant message at or after
 * `startIndex` that carries text or a tool_use — the same target the live
 * projector picks (its terminal output item), so live and backfilled rows fold
 * usage onto the one logical message and dedupe cleanly, and the row carrying
 * usage is the response's last assistant row for both Codex and Claude.
 * Reasoning-only (thinking) messages are skipped; if the turn produced no
 * eligible message (e.g. windowed out) the usage is dropped rather than
 * mis-attributed. @ref LLP 0035#one-carrier
 *
 * @param {AiGatewayProjectedMessage[]} messages
 * @param {number} startIndex
 * @param {JsonObject} usageAttributes
 */
function stampUsageOnTurn(messages, startIndex, usageAttributes) {
  for (let i = messages.length - 1; i >= startIndex; i--) {
    const message = messages[i]
    if (message.role !== 'assistant' || !hasTextOrToolUse(message)) continue
    message.attributes = { ...(message.attributes ?? {}), ...usageAttributes }
    return
  }
}

/** @param {AiGatewayProjectedMessage} message */
function hasTextOrToolUse(message) {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => {
    const type = isPlainObject(block) ? block.type : undefined
    return type === 'text' || type === 'tool_use'
  })
}

// ---------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------

/** @param {unknown} value @returns {JsonValue} */
function normalizeToolInput(value) {
  if (typeof value === 'string') {
    const parsed = tryParseJson(value)
    return parsed === undefined ? value : /** @type {JsonValue} */ (parsed)
  }
  if (value === undefined) return null
  return /** @type {JsonValue} */ (value)
}

/**
 * Codex tool output is usually a string, sometimes a wrapper object
 * (`{ output | content | text: "..." }`) or a structured payload. Reduce it
 * to display text best-effort; structured payloads are JSON-stringified so
 * the row keeps a faithful, queryable trace.
 *
 * @param {unknown} output
 * @returns {string | undefined}
 */
function toolOutputText(output) {
  if (typeof output === 'string') return output.length > 0 ? output : undefined
  if (isPlainObject(output)) {
    const inner = stringValue(output.output) ?? stringValue(output.content) ?? stringValue(output.text)
    return inner ?? JSON.stringify(output)
  }
  if (output === undefined || output === null) return undefined
  return JSON.stringify(output)
}

/** @param {unknown} value @returns {string | undefined} */
function reasoningText(value) {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (!Array.isArray(value)) return undefined
  /** @type {string[]} */
  const parts = []
  for (const raw of value) {
    if (typeof raw === 'string') {
      if (raw) parts.push(raw)
      continue
    }
    if (!isPlainObject(raw)) continue
    const text = stringValue(raw.text) ?? stringValue(raw.summary_text)
    if (text) parts.push(text)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * Wrap a projection in the `BackfillItem` envelope the runner expects. The
 * kernel types `value` as `Record<string, unknown>`; the projection is a
 * concrete interface, so bridge through `unknown`.
 *
 * @param {AiGatewayProjectedExchange} exchange
 * @param {BackfillProvenance} provenance
 * @returns {BackfillItem}
 */
function backfillItem(exchange, provenance) {
  return {
    dataset: AI_GATEWAY_MESSAGES_DATASET,
    kind: PROJECTED_EXCHANGE_KIND,
    value: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (exchange)),
    provenance,
  }
}

/**
 * Resolve the import window in epoch millis. Explicit `since` / `until` win;
 * otherwise a positive `retentionDays` sets the lower bound so a default run
 * does not import history older than the cache retains. Both ends may be
 * open (`undefined`).
 *
 * @param {BackfillRunContext} ctx
 * @returns {{ sinceMs?: number, untilMs?: number }}
 */
function resolveWindow(ctx) {
  const untilMs = parseIsoMs(ctx.until)
  let sinceMs = parseIsoMs(ctx.since)
  if (sinceMs === undefined && typeof ctx.retentionDays === 'number' && ctx.retentionDays > 0) {
    sinceMs = Date.now() - ctx.retentionDays * DAY_MS
  }
  return { sinceMs, untilMs }
}

/**
 * Keep items whose timestamp falls within the window. Items with no
 * timestamp (legacy rollouts, untimestamped records) are kept rather than
 * silently dropped.
 *
 * @param {CodexRolloutItem[]} items
 * @param {{ sinceMs?: number, untilMs?: number }} window
 * @returns {CodexRolloutItem[]}
 */
function filterByWindow(items, window) {
  if (window.sinceMs === undefined && window.untilMs === undefined) return items
  return items.filter((item) => {
    if (item.timestampMs === undefined) return true
    if (window.sinceMs !== undefined && item.timestampMs < window.sinceMs) return false
    if (window.untilMs !== undefined && item.timestampMs > window.untilMs) return false
    return true
  })
}

/**
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parseIsoMs(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** @param {unknown} value @returns {number | undefined} */
function timestampToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}

/**
 * Deterministic fallback session id from the rollout file name, e.g.
 * `rollout-2026-05-25T12-56-38-019e60b5-...-cda8.jsonl`. Falls back to the
 * whole base name so the id stays stable across reruns.
 *
 * @param {string} filePath
 * @returns {string}
 */
function sessionIdFromPath(filePath) {
  const base = path.basename(filePath).replace(/\.jsonl?$/, '')
  const uuid = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(base)
  return uuid ? uuid[1] : base
}

/**
 * @param {AiGatewayProjectedExchange} exchange
 * @returns {string | undefined}
 */
function readCodexIdentitySource(exchange) {
  const attributes = exchange.attributes
  if (!isPlainObject(attributes)) return undefined
  const codex = attributes.codex
  return isPlainObject(codex) ? stringValue(codex.identity_source) : undefined
}

/** @param {Record<string, unknown>[]} turns @param {string} key */
function firstTurnString(turns, key) {
  for (const turn of turns) {
    const value = stringValue(turn[key])
    if (value) return value
  }
  return undefined
}

/** @param {Record<string, unknown>[]} turns @param {string} key */
function firstTurnObject(turns, key) {
  for (const turn of turns) {
    const value = turn[key]
    if (isPlainObject(value)) return value
  }
  return undefined
}

/** @param {string} target */
async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/** @param {unknown} value @returns {unknown} */
function tryParseJson(value) {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | undefined} */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @param {unknown} value @returns {boolean | undefined} */
function boolValue(value) {
  return typeof value === 'boolean' ? value : undefined
}

/** @param {unknown} value @returns {number | undefined} */
function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * @param {Record<string, unknown>} source
 * @param {JsonObject} target
 * @param {string} sourceKey
 * @param {string} targetKey
 */
function copyNumberAlias(source, target, sourceKey, targetKey) {
  const value = numberValue(source[sourceKey])
  if (value !== undefined) target[targetKey] = value
}

/** @param {JsonObject} target @param {string} key @param {string | undefined} value */
function setIfString(target, key, value) {
  if (value !== undefined) target[key] = value
}

/** @param {Array<string | undefined>} values */
function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0)
}

/** @param {Array<boolean | undefined>} values */
function firstBool(...values) {
  return values.find((value) => typeof value === 'boolean')
}

/** @param {unknown} err */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

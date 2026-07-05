// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import {
  AI_GATEWAY_MESSAGES_DATASET,
  errMessage,
  filterByWindow,
  projectedExchangeItem,
  resolveWindow,
} from '../../../../src/core/backfill/scan_util.js'
import { redactRemoteUserinfo } from './git-remote.js'
import {
  copyNumberAlias,
  firstString,
  netInputUsage,
  numberValue,
  reasoningMessageFromPayload,
  setIfString,
  stampUsageOnLastAssistant,
  textBlocksFromContent,
  toolResultBlockFromPayload,
  toolUseBlockFromPayload,
} from './response-items.js'
import { isPlainObject, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, BackfillContribution, BackfillEvent, BackfillItem, BackfillRunContext, JsonObject, PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { CodexRolloutItem, CodexRolloutSession } from './types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
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
 *   - `<codexHome>/history.*`       diagnostic only: command/input history,
 *                                   not enough for canonical rows. Detected,
 *                                   never parsed here.
 *   - `<codexHome>/log/**`          diagnostic only: version/breadcrumbs.
 *   - ChatGPT/Codex app + browser   detected, NEVER parsed in V1; flagged
 *     storage                       via an `unsupported_location` event.
 *   - HypAware's gateway cache      excluded (lives under HYP_HOME, not
 *                                   scanned here).
 *
 * Parsing is best-effort and version-defensive: a malformed line, a
 * truncated trailing record, or an unreadable file degrades to whatever
 * parsed cleanly rather than aborting the run. Reruns are deterministic:
 * ids, parents, and timestamps come straight from the immutable rollout
 * and the materializer is pure.
 */

const DEFAULT_CLIENT_NAME = 'codex'
const DEFAULT_PLUGIN_NAME = '@hypaware/codex'

// The Codex client speaks the OpenAI wire format, so backfilled rows carry
// provider 'openai' and conversation_source 'codex': matching the live
// @hypaware/codex exchange projector's chatgpt/api output split.
const PROVIDER = 'openai'
const CONVERSATION_SOURCE = 'codex'

const COMPONENT = 'plugin.codex.backfill'

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
 *   resolver?: UsagePolicyResolver,
 * }} opts
 * @returns {BackfillContribution}
 */
export function createCodexBackfillProvider(opts) {
  const clientName = opts.clientName ?? DEFAULT_CLIENT_NAME
  const pluginName = opts.pluginName ?? DEFAULT_PLUGIN_NAME
  const codexHome = opts.codexHome ?? defaultCodexHome(opts.homeDir)
  const sessionsDir = opts.sessionsDir ?? path.join(codexHome, 'sessions')
  const unsupportedLocations = opts.unsupportedLocations ?? defaultUnsupportedLocations(opts.homeDir)
  // One `.hypignore` resolver per backfill run, holding its per-cwd cache for
  // the whole scan (LLP 0049 R6).
  const resolver = opts.resolver ?? createUsagePolicyResolver()

  return {
    name: clientName,
    plugin: pluginName,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import local Codex session rollouts into ai_gateway_messages',
    async *run(ctx) {
      yield* runCodexBackfill({ ctx, codexHome, sessionsDir, unsupportedLocations, clientName, resolver })
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
 *   resolver: UsagePolicyResolver,
 * }} args
 * @returns {AsyncGenerator<BackfillItem | BackfillEvent>}
 */
async function* runCodexBackfill(args) {
  const { ctx, codexHome, sessionsDir, unsupportedLocations, clientName, resolver } = args
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
  let sessionsIgnored = 0
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
      // @ref LLP 0050 [implements]: capture-seam drop for backfill, symmetric
      // to the @hypaware/claude backfill skip. A session whose recorded cwd has
      // an ancestor `.hypignore` of class `ignore` is skipped before projecting
      // or yielding any row, so `hyp backfill` never re-imports the exact
      // sessions ignored live (LLP 0049 R1).
      const sessionPolicy = session.cwd ? resolver.resolve(session.cwd) : null
      if (sessionPolicy?.class === 'ignore') {
        sessionsIgnored += 1
        // A fail-safe clamp (declared token unimplemented) escalates to warn
        // so an operator can tell it from an intended ignore (R3 SHOULD).
        log[sessionPolicy.warn ? 'warn' : 'info']('codex.backfill.usage_policy_drop', {
          component: COMPONENT,
          operation: 'usage_policy_drop',
          conversation_id: session.sessionId,
          class: 'ignore',
          declared: sessionPolicy.declared,
          governed_by: sessionPolicy.governedBy,
          status: 'skipped',
          ...(sessionPolicy.warn ? { warn: sessionPolicy.warn } : {}),
        })
        continue
      }

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

      yield projectedExchangeItem(exchange, {
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
    sessions_ignored: sessionsIgnored,
    messages_projected: messagesProjected,
    status: 'ok',
  })
}

/**
 * Flag, but never parse, Codex/ChatGPT app and browser storage. Each
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
 * entry: the array shape just keeps the run loop uniform.
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
 * Modern rollout: line-delimited `{ timestamp, type, payload }` records:
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
      // The one event_msg we keep: token_count. It is NOT a message: it is a
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
  // message (via the same stampUsageOnLastAssistant the live path uses), then
  // the next turn starts. Reasoning-only assistant messages are skipped as
  // stamp targets so live and backfilled rows carry usage on the same logical
  // message and dedupe to one row. @ref LLP 0035#per-turn
  let turnStartIndex = 0
  for (const item of items) {
    if (item.usageAttributes) {
      stampUsageOnLastAssistant(messages, item.usageAttributes, turnStartIndex)
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
    // @ref LLP 0030#decision: the rollout id is the thread; the rollout
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
  // @ref LLP 0032#capture: repo identity for the graph bridge (Repo/Commit),
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
  case 'custom_tool_call': {
    const block = toolUseBlockFromPayload(payload)
    message = block ? { role: 'assistant', content: [block] } : undefined
    break
  }
  case 'function_call_output':
  case 'custom_tool_call_output': {
    const block = toolResultBlockFromPayload(payload)
    message = block ? { role: 'tool', content: [block] } : undefined
    break
  }
  case 'reasoning':
    message = reasoningMessageFromPayload(payload)
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

// ---------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------

/**
 * Pull a turn's normalized token usage from a `token_count` event_msg
 * payload. Reads the per-turn delta (`info.last_token_usage`), NOT the
 * cumulative session running total (`info.total_token_usage`): stamping the
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
  // Codex `input_tokens` is gross: it includes `cached_input_tokens`
  // (@ref LLP 0035#net-input, netInputUsage).
  const usage = netInputUsage(numberValue(rawUsage.input_tokens), numberValue(rawUsage.cached_input_tokens))

  copyNumberAlias(rawUsage, usage, 'output_tokens', 'output_tokens')
  copyNumberAlias(rawUsage, usage, 'reasoning_output_tokens', 'reasoning_tokens')
  copyNumberAlias(rawUsage, usage, 'total_tokens', 'total_tokens')

  return Object.keys(usage).length === 0 ? undefined : { usage }
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

/** @param {unknown} value @returns {boolean | undefined} */
function boolValue(value) {
  return typeof value === 'boolean' ? value : undefined
}

/** @param {Array<boolean | undefined>} values */
function firstBool(...values) {
  return values.find((value) => typeof value === 'boolean')
}


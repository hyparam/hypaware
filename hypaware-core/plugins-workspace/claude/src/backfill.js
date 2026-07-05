// @ts-check

import {
  defaultClaudeProjectsDir,
  loadAgentMeta,
  loadTranscriptFile,
  walkTranscriptFiles,
} from './transcripts.js'
import { pickLatestMatching, readSessionContext } from './session_context.js'
import { deriveRepoFromCwd } from './git_repo.js'
import { anthropicMessageAttributes } from './anthropic.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, BackfillContribution, BackfillItem, BackfillProvenance, BackfillRunContext, JsonObject, PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { SessionContextRecord, TranscriptEntry } from './types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * `@hypaware/claude` backfill provider.
 *
 * Imports local Claude Code history into `ai_gateway_messages` by
 * reading the on-disk JSONL transcripts the CLI writes under
 * `<homeDir>/.claude/projects/**\/<session-id>.jsonl`, joining the
 * session-context channel (`<stateDir>/session-context.jsonl`) for
 * `cwd` / `git_branch`, and projecting each session into an
 * `AiGatewayProjectedExchange`. The `@hypaware/ai-gateway`
 * `ai_gateway.projected_exchange` materializer expands those into the
 * same canonical rows live capture produces, so backfilled and live
 * rows are identical for the same conversation.
 *
 * Native DAG identity is preserved verbatim (the gateway never
 * recomputes ids when the projector supplies them):
 *   - `uuid`       -> `message_id` / `provider_uuid`
 *   - `parentUuid` -> `parent_uuid`
 * `previous_message_id` is NOT supplied here; the gateway expansion
 * always fills it with the full prior-message-id chain, the same
 * shape live capture rows get.
 * Reruns are deterministic: ids, parents, and timestamps come straight
 * from the immutable transcript, and the materializer is pure.
 */

const DEFAULT_CLIENT_NAME = 'claude'
const DEFAULT_PLUGIN_NAME = '@hypaware/claude'

// Dataset name and materializer dispatch key owned by
// `@hypaware/ai-gateway` (DATASET_NAME / AI_GATEWAY_PROJECTED_EXCHANGE_KIND
// in its dataset.js). Held as plain constants here so this adapter does
// not pull the gateway's runtime module graph in just for two strings;
// the end-to-end test pins them by feeding yielded items through the
// real materializer.
const AI_GATEWAY_MESSAGES_DATASET = 'ai_gateway_messages'
const PROJECTED_EXCHANGE_KIND = 'ai_gateway.projected_exchange'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Build the Claude backfill provider. Registered at plugin activation
 * via `ctx.backfills.register(...)`. The provider closes over the
 * resolved transcript root and session-context state file so `run()`
 * needs only the kernel-supplied `BackfillRunContext`.
 *
 * @param {{
 *   homeDir: string,
 *   stateFile: string,
 *   projectsDir?: string,
 *   clientName?: string,
 *   pluginName?: string,
 *   deriveRepo?: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   resolver?: UsagePolicyResolver,
 * }} opts
 * @returns {BackfillContribution}
 */
export function createClaudeBackfillProvider(opts) {
  const clientName = opts.clientName ?? DEFAULT_CLIENT_NAME
  const pluginName = opts.pluginName ?? DEFAULT_PLUGIN_NAME
  const projectsDir = opts.projectsDir ?? defaultClaudeProjectsDir(opts.homeDir)
  const stateFile = opts.stateFile
  // @ref LLP 0032#capture: pre-0032 Claude sessions carry no captured remote;
  // recover it by running git in the session's cwd at backfill time. Injectable
  // so tests stub the git lookup and stay hermetic.
  const deriveRepo = opts.deriveRepo ?? deriveRepoFromCwd
  // One resolver per backfill run (LLP 0050): the per-cwd cache reflects disk at
  // run time and is shared across the whole scan. Injectable for hermetic tests.
  // @ref LLP 0050 [implements]: skip ignored sessions at the capture seam.
  const resolver = opts.resolver ?? createUsagePolicyResolver()

  return {
    name: clientName,
    plugin: pluginName,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import local Claude Code transcripts into ai_gateway_messages',
    async *run(ctx) {
      yield* runClaudeBackfill({ ctx, projectsDir, stateFile, clientName, deriveRepo, resolver })
    },
  }
}

/**
 * Walk the transcript root, project each session, and yield one
 * `ai_gateway.projected_exchange` item per session. One item per
 * session keeps the materializer's per-call dedup state whole, so a
 * conversation's `previous_message_id` chain is never split across
 * items.
 *
 * @param {{
 *   ctx: BackfillRunContext,
 *   projectsDir: string,
 *   stateFile: string,
 *   clientName: string,
 *   deriveRepo: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   resolver: UsagePolicyResolver,
 * }} args
 * @returns {AsyncGenerator<BackfillItem>}
 */
async function* runClaudeBackfill(args) {
  const { ctx, projectsDir, stateFile, clientName, deriveRepo, resolver } = args
  const log = ctx.log
  const window = resolveWindow(ctx)
  // Many sessions share a cwd (the same repo, often the same checkout), and
  // each derivation shells git; memoize per cwd so a backfill over thousands of
  // sessions runs one git probe per distinct directory, not per session.
  /** @type {Map<string, Promise<{ git_remote?: string, repo_root?: string }>>} */
  const repoByCwd = new Map()
  /** @param {string | undefined} cwd */
  const deriveRepoCached = (cwd) => {
    if (!cwd) return Promise.resolve({})
    let pending = repoByCwd.get(cwd)
    if (!pending) {
      pending = deriveRepo(cwd)
      repoByCwd.set(cwd, pending)
    }
    return pending
  }

  log.info('claude.backfill.scan_started', {
    component: 'plugin.claude.backfill',
    operation: 'backfill.scan',
    projects_dir: projectsDir,
    ...(window.sinceMs !== undefined ? { since: new Date(window.sinceMs).toISOString() } : {}),
    ...(window.untilMs !== undefined ? { until: new Date(window.untilMs).toISOString() } : {}),
    status: 'ok',
  })

  const sessionRecords = await readSessionContextSafe(stateFile, log)
  // Subagent → spawning tool call: one scan of the projects tree builds
  // the agent-id → toolUseId map from the `agent-<id>.meta.json` sidecars,
  // so backfilled subagent rows carry the same `spawned_by_tool_use_id`
  // provenance live capture stamps.
  const agentMeta = loadAgentMeta({ projectsDir })

  let filesSeen = 0
  let sessionsProjected = 0
  let messagesProjected = 0

  for (const filePath of walkTranscriptFiles(projectsDir)) {
    filesSeen += 1
    /** @type {TranscriptEntry[]} */
    let entries
    try {
      entries = await loadTranscriptFile(filePath)
    } catch (err) {
      log.warn('claude.backfill.transcript_read_failed', {
        component: 'plugin.claude.backfill',
        operation: 'backfill.scan',
        source_path: filePath,
        status: 'error',
        error_kind: 'transcript_read_failed',
        error: errMessage(err),
      })
      continue
    }

    for (const [sessionId, sessionEntries] of groupBySession(entries)) {
      const windowed = filterByWindow(sessionEntries, window)
      const record = pickLatestMatching(sessionRecords, { sessionId, transcriptPath: filePath })

      // @ref LLP 0050 [implements]: capture-seam drop for backfill. Skip an
      // ignored session BEFORE projecting/writing it, else `hyp backfill` would
      // silently re-import the exact sessions ignored live (LLP 0049#requirements
      // R1). The cwd precedence mirrors projectedExchangeFromEntries (the
      // hook-written record wins, else the first transcript line's cwd), so the
      // session is tested on the same cwd the row would have carried.
      const sessionCwd = record?.cwd ?? windowed.find((entry) => entry.cwd)?.cwd
      const sessionPolicy = sessionCwd ? resolver.resolve(sessionCwd) : null
      if (sessionPolicy?.class === 'ignore') {
        // A fail-safe clamp (declared token unimplemented) escalates to warn
        // so an operator can tell it from an intended ignore (R3 SHOULD).
        log[sessionPolicy.warn ? 'warn' : 'info']('claude.backfill.usage_policy_drop', {
          component: 'plugin.claude.backfill',
          operation: 'usage_policy_drop',
          session_id: sessionId,
          declared: sessionPolicy.declared,
          governed_by: sessionPolicy.governedBy,
          status: 'ok',
          ...(sessionPolicy.warn ? { warn: sessionPolicy.warn } : {}),
        })
        continue
      }

      const exchange = await projectedExchangeFromEntries({
        sessionId,
        entries: windowed,
        clientName,
        record,
        agentMeta,
        deriveRepo: deriveRepoCached,
      })
      if (!exchange) continue

      sessionsProjected += 1
      messagesProjected += exchange.messages.length
      log.info('claude.backfill.session_projected', {
        component: 'plugin.claude.backfill',
        operation: 'backfill.project',
        session_id: sessionId,
        message_count: exchange.messages.length,
        status: 'ok',
      })

      yield backfillItem(exchange, {
        client_name: clientName,
        source_path: filePath,
        native_id: sessionId,
      })
    }
  }

  log.info('claude.backfill.scan_complete', {
    component: 'plugin.claude.backfill',
    operation: 'backfill.scan',
    files_seen: filesSeen,
    sessions_projected: sessionsProjected,
    messages_projected: messagesProjected,
    status: 'ok',
  })
}

/**
 * Resolve the import window in epoch millis. Explicit `since` / `until`
 * win; otherwise a positive `retentionDays` sets the lower bound so a
 * default run does not import history older than the cache retains.
 * Both ends may be open (`undefined`).
 *
 * @param {BackfillRunContext} ctx
 * @returns {{ sinceMs: number | undefined, untilMs: number | undefined }}
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
 * Parse an optional ISO-8601 string to epoch millis, returning
 * `undefined` for an absent or unparseable value.
 *
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parseIsoMs(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Keep entries whose timestamp falls within the window. Entries with an
 * unparseable timestamp are kept rather than silently dropped.
 *
 * @param {TranscriptEntry[]} entries
 * @param {{ sinceMs: number | undefined, untilMs: number | undefined }} window
 * @returns {TranscriptEntry[]}
 */
function filterByWindow(entries, window) {
  if (window.sinceMs === undefined && window.untilMs === undefined) return entries
  return entries.filter((entry) => {
    if (entry.timestampMs === undefined) return true
    if (window.sinceMs !== undefined && entry.timestampMs < window.sinceMs) return false
    if (window.untilMs !== undefined && entry.timestampMs > window.untilMs) return false
    return true
  })
}

/**
 * Group entries by native session id. A transcript file is named for
 * its session, but grouping on the entry stays correct even if a file
 * ever interleaves sessions. Insertion order follows the
 * timestamp-sorted entries.
 *
 * @param {TranscriptEntry[]} entries
 * @returns {Map<string, TranscriptEntry[]>}
 */
function groupBySession(entries) {
  /** @type {Map<string, TranscriptEntry[]>} */
  const bySession = new Map()
  for (const entry of entries) {
    const list = bySession.get(entry.sessionId)
    if (list) list.push(entry)
    else bySession.set(entry.sessionId, [entry])
  }
  return bySession
}

/**
 * Project one session's entries into an `AiGatewayProjectedExchange`.
 * Returns `undefined` when no entry carries a usable message (so the
 * provider skips empty sessions instead of yielding a no-row item).
 *
 * @param {{
 *   sessionId: string,
 *   entries: TranscriptEntry[],
 *   clientName: string,
 *   record: SessionContextRecord | undefined,
 *   agentMeta: Map<string, { tool_use_id: string }>,
 *   deriveRepo: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 * }} args
 * @returns {Promise<AiGatewayProjectedExchange | undefined>}
 */
async function projectedExchangeFromEntries(args) {
  const { sessionId, entries, clientName, record, agentMeta, deriveRepo } = args
  /** @type {AiGatewayProjectedMessage[]} */
  const messages = []
  /** @type {string | undefined} */
  let clientVersion
  /** @type {number | undefined} */
  let startedAtMs
  /** @type {string | undefined} */
  let transcriptCwd
  // Usage is a response-level (per API message) figure that Claude Code
  // duplicates onto every block line of an assistant turn. Record the last
  // block line per API message id so usage is stamped on only that one block:
  // matching the live projector, so each response contributes usage to exactly
  // one row and live/backfill dedupe onto the same row. @ref LLP 0035#one-carrier
  /** @type {Map<string, number>} */
  const lastBlockIndexByMessageId = new Map()
  entries.forEach((entry, index) => {
    if (entry.messageId) lastBlockIndexByMessageId.set(entry.messageId, index)
  })
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    // Capture before the message filter: cwd rides every transcript line, not
    // only the ones that project to a message, and it's the only repo signal a
    // pre-0032 session carries.
    if (!transcriptCwd && entry.cwd) transcriptCwd = entry.cwd
    // A line with no API message id is its own single-block message → keep its
    // usage; otherwise only the last block of the message carries it.
    const stampUsage = !entry.messageId || lastBlockIndexByMessageId.get(entry.messageId) === index
    const message = projectedMessageFromEntry(entry, agentMeta, stampUsage)
    if (!message) continue
    messages.push(message)
    if (!clientVersion && entry.client_version) clientVersion = entry.client_version
    if (entry.timestampMs !== undefined && (startedAtMs === undefined || entry.timestampMs < startedAtMs)) {
      startedAtMs = entry.timestampMs
    }
  }
  if (messages.length === 0) return undefined

  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: 'anthropic',
    // @ref LLP 0030#decision: the Claude session id is the session_id
    // partition key; conversation_id is null (no per-thread id). Matches
    // live capture so backfilled and live rows still converge.
    session_id: sessionId,
    // Bead 2 contract: backfilled Claude history is tagged
    // conversation_source = client_name = 'claude'. Live capture derives
    // 'claude_code' / 'api' from the request User-Agent; backfill has no
    // request, and the materializer stamps attributes.gateway.source =
    // 'backfill', which already records the import origin.
    conversation_source: clientName,
    client_name: clientName,
    messages,
  }
  if (startedAtMs !== undefined) exchange.conversation_started_at = new Date(startedAtMs).toISOString()
  if (clientVersion) exchange.client_version = clientVersion
  // The hook-written record wins (it captured cwd in the live session); the
  // transcript line's cwd is the fallback for sessions whose record predates
  // cwd capture, so backfilled rows carry a cwd the join can key on.
  const cwd = record?.cwd ?? transcriptCwd
  if (cwd) exchange.cwd = cwd
  if (record?.git_branch) exchange.git_branch = record.git_branch
  // @ref LLP 0032#capture: repo identity rides the same hook-written
  // session-context record as cwd/git_branch; the live projector stamps these
  // too (projector.js), so backfilled and live Claude rows converge identically.
  // Unlike Codex, the Claude hook captures `git rev-parse --show-toplevel`, so
  // repo_root is a verified toplevel and File keys bridge safely.
  if (record?.git_remote) exchange.git_remote = record.git_remote
  if (record?.head_sha) exchange.head_sha = record.head_sha
  if (record?.repo_root) exchange.repo_root = record.repo_root
  // @ref LLP 0032#capture: sessions recorded before the hook captured git
  // identity have a record with no remote; recover it by running git in the
  // recovered cwd. Only when the record didn't already supply a remote, and
  // never head_sha: current HEAD ≠ the session's HEAD (git_repo.js).
  if (cwd && !exchange.git_remote) {
    const derived = await deriveRepo(cwd)
    if (derived.git_remote) exchange.git_remote = derived.git_remote
    if (derived.repo_root && !exchange.repo_root) exchange.repo_root = derived.repo_root
  }
  return exchange
}

/**
 * Project one transcript entry into an `AiGatewayProjectedMessage`,
 * mirroring the live Claude projector's native-DAG identity mapping.
 * Differs from live capture in two ways: `role` / `content` come
 * straight from the transcript frame, and `raw_frame` carries only a
 * minimized native-identity stub: never the full transcript line.
 *
 * @param {TranscriptEntry} entry
 * @param {Map<string, { tool_use_id: string }>} agentMeta
 * @param {boolean} stampUsage  fold attributes.usage onto this block (true only
 *   for the last block of an API message, so usage lands once per response)
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function projectedMessageFromEntry(entry, agentMeta, stampUsage) {
  const role = entry.role
  if (!role) return undefined

  /** @type {AiGatewayProjectedMessage} */
  const message = {
    role,
    content: /** @type {any} */ (entry.content),
  }
  if (entry.provider_uuid) {
    // Native id only: like the live projector, `previous_message_id`
    // is left to the gateway expansion, which fills the full
    // prior-message chain; the native DAG parent rides `parent_uuid`.
    message.message_id = entry.provider_uuid
    message.provider_uuid = entry.provider_uuid
  }
  if (entry.parent_uuid) message.parent_uuid = entry.parent_uuid
  if (entry.logical_parent_uuid) message.logical_parent_uuid = entry.logical_parent_uuid
  if (entry.source_tool_assistant_uuid) message.source_tool_assistant_uuid = entry.source_tool_assistant_uuid
  if (entry.request_id) message.request_id = entry.request_id
  if (entry.prompt_id) message.prompt_id = entry.prompt_id
  if (entry.provider_type) message.provider_type = entry.provider_type
  if (entry.provider_subtype) message.provider_subtype = entry.provider_subtype
  // Per-message model: live capture sets one model per exchange, but a
  // backfilled session can switch models mid-stream, so stamp it per assistant
  // line and let the gateway prefer it over the exchange model.
  if (entry.model) message.model = entry.model
  if (entry.entrypoint) message.entrypoint = entry.entrypoint
  if (entry.user_type) message.user_type = entry.user_type
  if (entry.permission_mode) message.permission_mode = entry.permission_mode
  if (entry.is_sidechain !== undefined) message.is_sidechain = entry.is_sidechain
  if (entry.agent_id) {
    message.agent_id = entry.agent_id
    // Mirror live capture: a subagent row carries the parent-thread tool
    // call that spawned it, read from the agent's `.meta.json` sidecar.
    const spawnedByToolUseId = agentMeta.get(entry.agent_id)?.tool_use_id
    if (spawnedByToolUseId) {
      message.attributes = { claude: { spawned_by_tool_use_id: spawnedByToolUseId } }
    }
  }
  // Mirror live capture: fold the assistant turn's token usage into
  // attributes.usage (anthropic.js owns the cache_*_input_tokens →
  // cache_{read,write}_tokens normalization), but only on the last block of the
  // API message so usage lands once per response. Merged, not assigned, so a
  // subagent's `claude.spawned_by_tool_use_id` above survives. @ref LLP 0035#one-carrier
  const usageAttrs = stampUsage ? anthropicMessageAttributes(entry) : undefined
  if (usageAttrs) message.attributes = { ...(message.attributes ?? {}), ...usageAttrs }
  if (entry.attachment_type) message.attachment_type = entry.attachment_type
  if (entry.hook_event) message.hook_event = entry.hook_event
  if (entry.is_compact_summary !== undefined) message.is_compact_summary = entry.is_compact_summary
  if (entry.compact_metadata !== undefined) message.compact_metadata = /** @type {any} */ (entry.compact_metadata)
  if (entry.timestampMs !== undefined) message.message_created_at = new Date(entry.timestampMs).toISOString()

  const rawFrame = minimizedRawFrame(entry)
  if (rawFrame) message.raw_frame = rawFrame
  return message
}

/**
 * Minimized native frame: enough to trace a row back to its Claude
 * transcript line (native uuids, type/subtype, timestamp) without
 * copying the full transcript or any prompt / response content. Per the
 * bead contract: store a minimized, redacted native frame, never the
 * raw line.
 *
 * @param {TranscriptEntry} entry
 * @returns {JsonObject | undefined}
 */
function minimizedRawFrame(entry) {
  /** @type {JsonObject} */
  const frame = {}
  if (entry.provider_uuid) frame.uuid = entry.provider_uuid
  if (entry.parent_uuid) frame.parent_uuid = entry.parent_uuid
  if (entry.logical_parent_uuid) frame.logical_parent_uuid = entry.logical_parent_uuid
  if (entry.provider_type) frame.type = entry.provider_type
  if (entry.provider_subtype) frame.subtype = entry.provider_subtype
  if (entry.messageId) frame.message_id = entry.messageId
  if (entry.timestampMs !== undefined) frame.timestamp = new Date(entry.timestampMs).toISOString()
  return Object.keys(frame).length > 0 ? frame : undefined
}

/**
 * Wrap a projection in the `BackfillItem` envelope the runner expects.
 * The kernel types `value` as `Record<string, unknown>`; the projection
 * is a concrete interface, so bridge through `unknown`.
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
 * Read the session-context records, degrading to `[]` on error so a
 * missing or unreadable channel never aborts the backfill (the join is
 * best-effort; `cwd` / `git_branch` are nullable columns).
 *
 * @param {string} stateFile
 * @param {PluginLogger} log
 * @returns {Promise<SessionContextRecord[]>}
 */
async function readSessionContextSafe(stateFile, log) {
  try {
    return await readSessionContext(stateFile)
  } catch (err) {
    log.warn('claude.backfill.session_context_read_failed', {
      component: 'plugin.claude.backfill',
      operation: 'backfill.scan',
      state_file: stateFile,
      status: 'error',
      error_kind: 'session_context_read_failed',
      error: errMessage(err),
    })
    return []
  }
}

/** @param {unknown} err */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

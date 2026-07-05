// @ts-check

import {
  assignTranscriptIdentity,
  defaultClaudeProjectsDir,
  loadAgentMeta,
  loadTranscriptFile,
  walkTranscriptFiles,
  withToolUseResult,
} from './transcripts.js'
import { createSessionContextReader, pickLatestMatching } from './session_context.js'
import { deriveRepoFromCwd } from './git_repo.js'
import { anthropicMessageAttributes } from './anthropic.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import {
  AI_GATEWAY_MESSAGES_DATASET,
  errMessage,
  filterByWindow,
  projectedExchangeItem,
  resolveWindow,
} from '../../../../src/core/backfill/scan_util.js'

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

  // Degrades to [] on error so a missing or unreadable channel never
  // aborts the backfill: the join is best-effort and `cwd` /
  // `git_branch` are nullable columns.
  const sessionRecords = await createSessionContextReader(stateFile, (err) => {
    log.warn('claude.backfill.session_context_read_failed', {
      component: 'plugin.claude.backfill',
      operation: 'backfill.scan',
      state_file: stateFile,
      status: 'error',
      error_kind: 'session_context_read_failed',
      error: errMessage(err),
    })
  })()
  // Subagent → spawning tool call: one scan of the projects tree builds
  // the agent-id → toolUseId map from the `agent-<id>.meta.json` sidecars,
  // so backfilled subagent rows carry the same `spawned_by_tool_use_id`
  // provenance live capture stamps.
  const agentMeta = loadAgentMeta({ projectsDir })

  let filesSeen = 0
  let sessionsProjected = 0
  let messagesProjected = 0

  for (const filePath of walkTranscriptFiles(projectsDir)) {
    if (ctx.signal?.aborted) break
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

      yield projectedExchangeItem(exchange, {
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
 * Project one transcript entry into an `AiGatewayProjectedMessage`.
 * Identity and provenance come from `assignTranscriptIdentity`: the
 * same single-source field copy the live projector applies on a
 * transcript match, so the two paths cannot drift. `role` / `content`
 * come straight from the transcript frame, and this path additionally
 * stamps the per-line model, agent-spawn provenance, usage, and
 * timestamp the live wire capture recovers elsewhere.
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
  // Native id only: like the live projector, `previous_message_id` is
  // left to the gateway expansion, which fills the full prior-message
  // chain; the native DAG parent rides `parent_uuid`.
  assignTranscriptIdentity(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (message)), entry)
  // Per-message model: live capture sets one model per exchange, but a
  // backfilled session can switch models mid-stream, so stamp it per assistant
  // line and let the gateway prefer it over the exchange model.
  if (entry.model) message.model = entry.model
  if (entry.agent_id) {
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
  message.attributes = /** @type {any} */ (withToolUseResult(message.attributes, entry))
  if (entry.timestampMs !== undefined) message.message_created_at = new Date(entry.timestampMs).toISOString()
  return message
}

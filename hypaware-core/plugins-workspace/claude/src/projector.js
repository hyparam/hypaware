// @ts-check

import fsp from 'node:fs/promises'

import {
  anthropicConversationFields,
  anthropicConversationSource,
  anthropicExchangeAttributes,
  anthropicMessageAttributes,
  anthropicMessages,
  claudeAuxKind,
  claudeClientVersion,
  hasAnthropicHeaderSignature,
  headerValue,
  isAnthropicExchange,
  isAnthropicPath,
  resolveAnthropicConversationId,
  resolveAnthropicUserId,
  resolveClaudeSessionId,
} from './anthropic.js'
import {
  assignTranscriptIdentity,
  defaultClaudeProjectsDir,
  entryBlockType,
  findTranscriptMatch,
  indexTranscriptEntries,
  loadAgentMeta,
  loadTranscript,
  matchKey,
} from './transcripts.js'
import {
  defaultSessionContextFile,
  pickLatestMatching,
  readSessionContext,
} from './session_context.js'
import { createUsagePolicyResolver, USAGE_POLICY_DROP } from '../../../../src/core/usage-policy/index.js'
import { isPlainObject, parseMaybeJson, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewayExchangeInput, AiGatewayExchangeProjector, AiGatewayProjectedExchange, AiGatewayProjectedMessage, AiGatewayUpstreamPreset, JsonObject } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { TranscriptEntry } from './types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * Build the Claude exchange projector. Returns the full
 * `AiGatewayExchangeProjector` the plugin hands to
 * `gateway.registerExchangeProjector()`.
 *
 * Behavior:
 *
 *  1. `match()`: true for any captured exchange whose path looks like
 *     `/v1/messages*` OR whose headers carry an Anthropic signature
 *     (`anthropic-version`, `x-api-key`, or `Authorization: Bearer sk-ant-*`).
 *  2. `project()`: parses the request + response (HTTP body for
 *     non-streamed, SSE event stream for streamed) into the canonical
 *     Anthropic message list, resolves a session id from
 *     `metadata.user_id.session_id` / `x-claude-code-session-id`, reads
 *     the latest matching session-context record off
 *     `<stateDir>/session-context.jsonl` for `cwd` / `git_branch`,
 *     and walks the JSONL transcript (session file plus its
 *     `<sessionId>/subagents/agent-*.jsonl` files) for native DAG
 *     identity. Wire messages are decomposed to the transcript's
 *     granularity (LLP 0023): assistant messages split one projected
 *     message per content block, user tool_results split one per
 *     result (joined by `tool_use_id`), prompts stay whole. When a
 *     transcript line matches:
 *       - `message_id = provider_uuid = uuid`, native parent on
 *         `parent_uuid`: `previous_message_id` is never supplied;
 *         the gateway always fills it with the full prior-message
 *         chain so enriched and fallback rows share one shape.
 *     On a miss, messages are returned without `message_id` so the
 *     gateway computes its fallback hash identity and stamps
 *     `attributes.gateway.identity_source = "gateway_fallback"`.
 *     Subagent exchanges (`x-claude-code-agent-id` header) stamp
 *     `is_sidechain` and the `agent_id` column regardless of
 *     transcript availability; transcript-matched rows also carry the
 *     entry's native `agentId`.
 *
 * @param {{
 *   homeDir: string,
 *   stateFile: string,
 *   projectsDir?: string,
 *   clientName?: string,
 *   logger?: { warn(message: string, fields?: Record<string, unknown>): void, debug?: (m: string, f?: Record<string, unknown>) => void },
 *   resolver?: UsagePolicyResolver,
 * }} opts
 * @returns {AiGatewayExchangeProjector}
 */
export function createClaudeExchangeProjector(opts) {
  const projectsDir = opts.projectsDir ?? defaultClaudeProjectsDir(opts.homeDir)
  const stateFile = opts.stateFile
  const clientName = opts.clientName ?? 'claude'
  const logger = opts.logger
  const sessionContextCache = createSessionContextCache()
  // One resolver per projector (per daemon run): the per-cwd cache rides the
  // projector's lifetime so the capture hot path adds no unbounded fs work.
  // @ref LLP 0050 [implements]: the .hypignore capture-seam drop lives in the
  // client adapter, the only place that resolves a cwd; injectable for tests.
  const resolver = opts.resolver ?? createUsagePolicyResolver()

  return {
    name: 'claude-anthropic-messages',
    priority: 100,
    match(input) {
      return isAnthropicExchange({ path: input.path, request_headers: input.request_headers })
    },
    async project(input, ctx) {
      const requestPath = stringValue(input.path) ?? ''
      const reqBody = parseMaybeJson(input.request_body)
      if (!isPlainObject(reqBody)) {
        // Surface the skip: adapter projectors that decline must
        // still leave a breadcrumb so a missing row is debuggable.
        ctx.log.warn('plugin.claude.projector_skip', {
          reason: 'unparseable_request_body',
          exchange_id: input.exchange_id,
        })
        return undefined
      }

      // Harness-internal aux traffic (e.g. the autonomous security
      // monitor) is not the user's conversation, but it IS real captured
      // data, so we tag rather than drop: stamp `attributes.claude.aux_kind`
      // on every projected message below so conversation queries exclude
      // it (`aux_kind IS NULL`) without losing it. `claudeAuxKind` keys
      // only on the dedicated security-monitor system prompt: the one aux
      // kind reliably fingerprintable today: so a normal turn is never
      // mislabeled. The drop this replaced silently lost ~88% of rows in
      // an autonomous session.
      // @ref LLP 0026#decision: tag-don't-drop; aux_kind rides the
      // attributes JSON (no schema change, per LLP 0027#decision pt 5).
      const auxKind = claudeAuxKind(reqBody)

      const responseBody = parseMaybeJson(input.response_body)
      const headers = parseHeaders(input.request_headers)
      // The exchange's subagent id (absent → main loop). Scopes
      // transcript matching to this thread so a subagent block can't
      // match a main-session or other-agent entry. @ref LLP 0026#decision
      const agentId = headerValue(headers, 'x-claude-code-agent-id')
      const sessionId = resolveClaudeSessionId(reqBody, headers)
      const messages = anthropicMessages(
        reqBody,
        responseBody,
        Array.isArray(input.stream_events) ? input.stream_events : []
      )
      if (messages.length === 0) {
        ctx.log.debug?.('plugin.claude.projector_skip', {
          reason: 'no_messages_in_exchange',
          exchange_id: input.exchange_id,
          path: requestPath,
        })
        return undefined
      }

      // Native DAG identity from local Claude Code transcripts. The
      // hook tells us the canonical transcript_path on the session
      // context channel; if it's missing we still try a sessionId
      // scan under `<homeDir>/.claude/projects/`.
      const sessionContextRecord = sessionId
        ? pickLatestMatching(await readSessionContextSafe(stateFile, logger, sessionContextCache), {
          sessionId,
        })
        : undefined

      // @ref LLP 0050 [implements]: capture-seam drop. Once the exchange's cwd
      // is resolved, an ancestor `.hypignore` that resolves to `ignore` means
      // this exchange is never recorded: return BEFORE building any rows, so the
      // gateway source's write guard (`if (messageRows.length > 0)`) persists
      // nothing. The response has already streamed to the client, so the live
      // LLM call is untouched (LLP 0049#requirements R2). The drop returns the
      // terminal `USAGE_POLICY_DROP` sentinel (NOT a bare `undefined`): the
      // dispatcher stops the projector walk on it so no later projector can
      // record the suppressed exchange, and logs it as a drop rather than a
      // `no_projector_match` miss.
      const cwd = sessionContextRecord?.cwd
      const policy = cwd ? resolver.resolve(cwd) : null
      if (policy?.class === 'ignore') {
        // A fail-safe clamp (declared token unimplemented) escalates to warn
        // so an operator can tell it from an intended ignore (R3 SHOULD).
        ctx.log[policy.warn ? 'warn' : 'info']('plugin.claude.usage_policy_drop', {
          component: 'claude',
          operation: 'usage_policy_drop',
          exchange_id: input.exchange_id,
          declared: policy.declared,
          governed_by: policy.governedBy,
          ...(policy.warn ? { warn: policy.warn } : {}),
        })
        return USAGE_POLICY_DROP
      }

      const transcriptEntries = sessionId
        ? await loadTranscriptSafe({
          projectsDir,
          sessionId,
          transcriptPath: sessionContextRecord?.transcript_path,
        }, logger)
        : []
      const transcriptIndex = indexTranscriptEntries(transcriptEntries)
      const identityFromTranscript = transcriptIndex.ordered.length > 0
      // @ref LLP 0030#decision: a Claude session is a container of many
      // threads (main loop, subagents, side chats), so the session id is
      // the `session_id` partition key, NOT `conversation_id`. Claude has
      // no per-thread conversation id, so conversation_id is null.
      // `resolveAnthropicConversationId` already yields a non-null value
      // (session id, else a content/exchange hash) so session_id is never
      // null even for generic Anthropic SDK traffic without a session id.
      const sessionIdColumn = resolveAnthropicConversationId(
        reqBody,
        input.exchange_id,
        sessionId
      )
      const conversationSource = anthropicConversationSource(headers)
      const clientVersion = claudeClientVersion(headers)
      const conversationFields = anthropicConversationFields(reqBody, responseBody)
      const exchangeAttrs = anthropicExchangeAttributes(
        reqBody,
        responseBody,
        input.duration_ms
      )
      // @ref LLP 0026#decision: decompose each wire message into the
      // transcript's native units (one per assistant block, one per
      // tool_result) so message_id is the transcript-line uuid and
      // live rows converge with backfill.
      /** @type {AiGatewayProjectedMessage[]} */
      const projectedMessages = []
      const responseMessageId = isPlainObject(responseBody)
        ? stringValue(responseBody.id)
        : undefined
      for (let m = 0; m < messages.length; m++) {
        const message = messages[m]
        const role = stringValue(message.role)
        if (!role) continue
        if (role === 'assistant') {
          projectedMessages.push(...projectAssistantMessage({
            message,
            // The response carries its API id only on the message
            // envelope; replayed history messages must NOT inherit it
            // or they'd mis-group against the current response's lines.
            apiMessageId: stringValue(message.id) ??
              (m === messages.length - 1 ? responseMessageId : undefined),
            agentId,
            transcriptIndex,
            matchEnabled: identityFromTranscript,
          }))
        } else if (role === 'user') {
          projectedMessages.push(...projectUserMessage({
            message,
            agentId,
            transcriptIndex,
            matchEnabled: identityFromTranscript,
          }))
        } else {
          const projected = wholeMessageProjection(role, message)
          if (identityFromTranscript) {
            applyTranscriptMatch(projected, findTranscriptMatch(transcriptIndex, { role, content: message.content, agentId }))
          }
          projectedMessages.push(projected)
        }
      }

      if (projectedMessages.length === 0) return undefined

      // Tag every message of an aux exchange so queries can exclude it.
      // Keyed on THIS exchange's request body (see `auxKind` above), so
      // only the aux exchange's rows carry `aux_kind`: real turns are
      // never mislabeled.
      if (auxKind) {
        for (const projected of projectedMessages) {
          projected.attributes = mergeAttrs(projected.attributes, {
            claude: { aux_kind: auxKind },
          })
        }
      }

      // @ref LLP 0027#decision: a message that came out fallback (no
      // transcript line on disk yet: the finalize race) carries the
      // content match-key so flush-time settlement can re-match it by
      // pure lookup once the line lands, without reconstructing the
      // content array that per-part expansion discards.
      for (const projected of projectedMessages) {
        if (projected.message_id) continue
        const role = stringValue(projected.role)
        if (!role) continue
        projected.attributes = mergeAttrs(projected.attributes, {
          claude: { match_key: matchKey(role, projected.content) },
        })
      }

      /** @type {AiGatewayProjectedExchange} */
      const projection = {
        provider: 'anthropic',
        session_id: sessionIdColumn,
        // conversation_id is null for Claude: the session id is the
        // session container, not a per-thread id. @ref LLP 0030#decision
        conversation_source: conversationSource,
        client_name: clientName,
        messages: projectedMessages,
      }
      if (conversationFields.model) projection.model = conversationFields.model
      if (conversationFields.system_text) projection.system_text = conversationFields.system_text
      if (conversationFields.tools !== undefined) projection.tools = /** @type {any} */ (conversationFields.tools)
      if (clientVersion) projection.client_version = clientVersion
      const userId = resolveAnthropicUserId(reqBody)
      if (userId) projection.user_id = userId
      if (sessionContextRecord?.cwd) projection.cwd = sessionContextRecord.cwd
      if (sessionContextRecord?.git_branch) projection.git_branch = sessionContextRecord.git_branch
      // @ref LLP 0032#capture: repo identity for the graph bridge, recovered
      // from the same hook-written session-context record as cwd/git_branch.
      if (sessionContextRecord?.git_remote) projection.git_remote = sessionContextRecord.git_remote
      if (sessionContextRecord?.head_sha) projection.head_sha = sessionContextRecord.head_sha
      if (sessionContextRecord?.repo_root) projection.repo_root = sessionContextRecord.repo_root
      if (exchangeAttrs) projection.attributes = exchangeAttrs
      if (input.ts_start) projection.conversation_started_at = input.ts_start

      // @ref LLP 0026#decision: subagent exchanges identify themselves
      // on the wire; sidechain provenance must not depend on winning the
      // transcript race, so it is stamped from the header (resolved
      // above, and used to scope transcript matching to this thread).
      if (agentId) {
        projection.is_sidechain = true
        projection.agent_id = agentId
        // The exchange tells us WHICH subagent this is, but not which
        // tool call launched it: that link lives only in the
        // `agent-<id>.meta.json` sidecar Claude writes next to the
        // subagent transcript. Stamp its `toolUseId` so a subagent's
        // rows point back at the parent-thread Agent/Task tool_call_id.
        const spawnedByToolUseId = sessionContextRecord?.transcript_path
          ? loadAgentMeta({ transcriptPath: sessionContextRecord.transcript_path }).get(agentId)?.tool_use_id
          : undefined
        if (spawnedByToolUseId) {
          projection.attributes = mergeAttrs(projection.attributes, {
            claude: { spawned_by_tool_use_id: spawnedByToolUseId },
          })
        }
      }

      // Claude-side identity provenance. Per the phase 2 spec, only
      // the missing-log case stamps an explicit marker: when the
      // transcript supplied uuids the projection's `message_id` /
      // `parent_uuid` already encode the native DAG and no
      // extra marker is needed. The gateway still stamps its own
      // `attributes.gateway.identity_source = "gateway_fallback"`
      // automatically when `message_id` is omitted, which is what
      // makes the two markers redundant on the gateway side but
      // useful here for Claude-specific debugging.
      if (!identityFromTranscript) {
        projection.attributes = mergeAttrs(projection.attributes, {
          claude: { identity_source: 'gateway_fallback' },
        })
      }

      // The projector preset is anchored on `/v1/messages` but we
      // accept arbitrary paths via header signature: record both so
      // the path heuristic is debuggable without re-running the smoke.
      if (requestPath && !isAnthropicPath(requestPath) && !hasAnthropicHeaderSignature(headers)) {
        // Defensive: should be unreachable because match() would have
        // returned false. Still, surface it.
        ctx.log.warn('plugin.claude.projector_unmatched_path', {
          exchange_id: input.exchange_id,
          path: requestPath,
        })
      }

      return projection
    },
  }
}

/**
 * Split one wire assistant message into per-block projected messages,
 * mirroring Claude Code's one-transcript-line-per-block representation.
 *
 * // @ref LLP 0026#decision: alignment: the lines of one API message
 * // share `message.id` in block order, so when the counts agree each
 * // block takes its positional line (type-checked); otherwise each
 * // block falls back to its own content key. Cardinality is recorded
 * // nowhere in the transcript, so a partially-written turn degrades
 * // per block instead of poisoning the whole message.
 *
 * @param {{
 *   message: Record<string, unknown>,
 *   apiMessageId: string | undefined,
 *   agentId: string | undefined,
 *   transcriptIndex: ReturnType<typeof indexTranscriptEntries>,
 *   matchEnabled: boolean,
 * }} args
 * @returns {AiGatewayProjectedMessage[]}
 */
function projectAssistantMessage(args) {
  const { message, apiMessageId, agentId, transcriptIndex, matchEnabled } = args
  const content = message.content
  const blocks = Array.isArray(content) ? content : undefined
  const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : undefined
  const messageAttrs = anthropicMessageAttributes(message)
  const unitCount = blocks ? blocks.length : 1
  const lines = matchEnabled && apiMessageId
    ? transcriptIndex.byMessageId.get(apiMessageId) ?? []
    : []

  /** @type {AiGatewayProjectedMessage[]} */
  const out = []
  for (let i = 0; i < unitCount; i++) {
    const unitContent = blocks ? [blocks[i]] : content
    /** @type {AiGatewayProjectedMessage} */
    const projected = { role: 'assistant', content: /** @type {any} */ (unitContent) }
    /** @type {TranscriptEntry | undefined} */
    let match
    if (lines.length === unitCount) {
      const block = blocks?.[i]
      const wireType = isPlainObject(block) ? stringValue(block.type) ?? 'text' : 'text'
      if (entryBlockType(lines[i]) === wireType) match = lines[i]
    }
    if (!match && matchEnabled) {
      match = findTranscriptMatch(transcriptIndex, { role: 'assistant', content: unitContent, agentId })
    }
    applyTranscriptMatch(projected, match)
    if (i === unitCount - 1) {
      // `usage` and `stop_reason` are response-level envelope fields, not
      // per-block. On a split turn they ride ONLY the last block's message so
      // each API message contributes its usage to exactly one row (a SUM over
      // rows isn't multiplied by the per-block fanout) and `finish_reason`
      // lands once. @ref LLP 0035#one-carrier @ref LLP 0026#consequences
      if (messageAttrs) projected.attributes = messageAttrs
      if (stopReason) projected.stop_reason = stopReason
    }
    out.push(projected)
  }
  return out
}

/**
 * Project one wire user message into the transcript's units.
 *
 * // @ref LLP 0026#decision: tool_results split one message per
 * // block (the transcript writes one line per result; `tool_use_id`
 * // is the join key). Prompt-style messages stay whole, matched with
 * // a wire-injected-reminder-stripped retry; on that match the
 * // projected content is the TRANSCRIPT's (else live `uuid#0`: a
 * // reminder: would collide with backfill `uuid#0`: the prompt),
 * // and the injected blocks become a separate `wire_only` message.
 *
 * @param {{
 *   message: Record<string, unknown>,
 *   agentId: string | undefined,
 *   transcriptIndex: ReturnType<typeof indexTranscriptEntries>,
 *   matchEnabled: boolean,
 * }} args
 * @returns {AiGatewayProjectedMessage[]}
 */
function projectUserMessage(args) {
  const { message, agentId, transcriptIndex, matchEnabled } = args
  const content = message.content
  const blocks = Array.isArray(content) ? content : undefined
  const messageAttrs = anthropicMessageAttributes(message)

  /** @type {AiGatewayProjectedMessage[]} */
  const out = []
  const toolResults = blocks
    ? blocks.filter((b) => isPlainObject(b) && b.type === 'tool_result')
    : []
  if (blocks && toolResults.length > 0) {
    for (const block of toolResults) {
      /** @type {AiGatewayProjectedMessage} */
      const projected = { role: 'user', content: /** @type {any} */ ([block]) }
      const toolUseId = isPlainObject(block) ? stringValue(block.tool_use_id) : undefined
      let match = matchEnabled && toolUseId
        ? transcriptIndex.byToolUseId.get(toolUseId)
        : undefined
      if (!match && matchEnabled) {
        match = findTranscriptMatch(transcriptIndex, { role: 'user', content: [block], agentId })
      }
      applyTranscriptMatch(projected, match)
      if (messageAttrs) projected.attributes = messageAttrs
      out.push(projected)
    }
    const rest = blocks.filter((b) => !(isPlainObject(b) && b.type === 'tool_result'))
    const realRest = rest.filter((b) => !isInjectedReminderBlock(b))
    const injectedRest = rest.filter(isInjectedReminderBlock)
    // Only harness-injected reminders are wire_only. Real content riding
    // alongside tool_results (queued user text, `[Request interrupted…]`
    // markers, skill banners) is a genuine user message: project it
    // normally with transcript matching, not as fallback-only noise.
    if (realRest.length > 0) {
      /** @type {AiGatewayProjectedMessage} */
      const projected = { role: 'user', content: /** @type {any} */ (realRest) }
      const match = matchEnabled
        ? findTranscriptMatch(transcriptIndex, { role: 'user', content: realRest, agentId })
        : undefined
      applyTranscriptMatch(projected, match)
      if (messageAttrs) projected.attributes = messageAttrs
      out.push(projected)
    }
    if (injectedRest.length > 0) out.push(wireOnlyMessage('user', injectedRest, messageAttrs))
    return out
  }

  let match = matchEnabled
    ? findTranscriptMatch(transcriptIndex, { role: 'user', content, agentId })
    : undefined
  if (!match && matchEnabled && blocks) {
    const injected = blocks.filter(isInjectedReminderBlock)
    if (injected.length > 0 && injected.length < blocks.length) {
      const core = blocks.filter((b) => !isInjectedReminderBlock(b))
      const coreMatch = findTranscriptMatch(transcriptIndex, { role: 'user', content: core, agentId })
      if (coreMatch) {
        /** @type {AiGatewayProjectedMessage} */
        const projected = { role: 'user', content: /** @type {any} */ (coreMatch.content) }
        applyTranscriptMatch(projected, coreMatch)
        if (messageAttrs) projected.attributes = messageAttrs
        out.push(projected)
        out.push(wireOnlyMessage('user', injected, messageAttrs))
        return out
      }
    }
  }
  /** @type {AiGatewayProjectedMessage} */
  const projected = { role: 'user', content: /** @type {any} */ (content) }
  applyTranscriptMatch(projected, match)
  if (messageAttrs) projected.attributes = messageAttrs
  out.push(projected)
  return out
}

/**
 * Generic single-message projection for roles the splitter has no
 * native mapping for (anything other than user/assistant).
 *
 * @param {string} role
 * @param {Record<string, unknown>} message
 * @returns {AiGatewayProjectedMessage}
 */
function wholeMessageProjection(role, message) {
  /** @type {AiGatewayProjectedMessage} */
  const projected = { role, content: /** @type {any} */ (message.content) }
  const messageAttrs = anthropicMessageAttributes(message)
  if (messageAttrs) projected.attributes = messageAttrs
  if (typeof message.stop_reason === 'string') projected.stop_reason = message.stop_reason
  return projected
}

/**
 * Copy a transcript line's native identity and provenance onto a
 * projected message. No-op when there is no match: the gateway then
 * computes fallback hash identity for the message.
 *
 * @param {AiGatewayProjectedMessage} projected
 * @param {TranscriptEntry | undefined} match
 */
function applyTranscriptMatch(projected, match) {
  if (!match) return
  // Native id only: `previous_message_id` is deliberately NOT supplied.
  // The gateway fills the full prior-message chain for every row; a
  // [parentUuid] singleton here would make enriched rows shaped
  // differently from fallback rows. The native DAG parent lands in
  // `parent_uuid` via the shared identity copy.
  assignTranscriptIdentity(/** @type {any} */ (projected), match)
}

/**
 * Wire-injected blocks the harness adds at request-build time and the
 * transcript never records as message content (`<system-reminder>`
 * banners). They are projected as their own fallback message, marked
 * so queries can exclude them from logical-conversation views.
 *
 * @param {string} role
 * @param {unknown[]} blocksContent
 * @param {JsonObject | undefined} messageAttrs
 * @returns {AiGatewayProjectedMessage}
 */
function wireOnlyMessage(role, blocksContent, messageAttrs) {
  /** @type {AiGatewayProjectedMessage} */
  const projected = { role, content: /** @type {any} */ (blocksContent) }
  projected.attributes = mergeAttrs(messageAttrs, { claude: { wire_only: true } })
  return projected
}

/**
 * @param {unknown} block
 */
function isInjectedReminderBlock(block) {
  return isPlainObject(block) &&
    block.type === 'text' &&
    typeof block.text === 'string' &&
    block.text.trimStart().startsWith('<system-reminder>')
}

/**
 * Register the Anthropic upstream preset on the gateway. Same routing
 * surface as `match()` on the projector: keeping them paired here
 * avoids drift between routing and projection.
 *
 * @returns {AiGatewayUpstreamPreset}
 */
export function anthropicUpstreamPreset() {
  return {
    name: 'anthropic',
    base_url: 'https://api.anthropic.com',
    provider: 'anthropic',
    path_prefix: '/v1/messages',
    priority: 100,
    match(input) {
      if (typeof input.path === 'string' && isAnthropicPath(input.path)) return true
      // Header-only path. Compose into the shape `hasAnthropicHeaderSignature`
      // expects (the route input uses `Record<string, string[]>`).
      return hasAnthropicHeaderSignature(input.headers)
    },
  }
}

/**
 * @param {string} stateFile
 * @param {{ warn(m: string, f?: Record<string, unknown>): void } | undefined} logger
 * @param {ReturnType<typeof createSessionContextCache>} cache
 */
async function readSessionContextSafe(stateFile, logger, cache) {
  try {
    const stat = await statIfExists(stateFile)
    if (!stat) {
      cache.size = 0
      cache.mtimeMs = 0
      cache.records = []
      return cache.records
    }
    if (cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) {
      return cache.records
    }
    const records = await readSessionContext(stateFile)
    cache.size = stat.size
    cache.mtimeMs = stat.mtimeMs
    cache.records = records
    return records
  } catch (err) {
    logger?.warn('plugin.claude.session_context_read_failed', {
      state_file: stateFile,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

function createSessionContextCache() {
  return {
    /** @type {number | undefined} */
    size: undefined,
    /** @type {number | undefined} */
    mtimeMs: undefined,
    /** @type {any[]} */
    records: [],
  }
}

/** @param {string} filePath */
async function statIfExists(filePath) {
  try {
    return await fsp.stat(filePath)
  } catch (err) {
    if (/** @type {{ code?: string }} */ (err)?.code === 'ENOENT') return undefined
    throw err
  }
}

/**
 * @param {{ projectsDir: string, sessionId: string, transcriptPath?: string }} opts
 * @param {{ warn(m: string, f?: Record<string, unknown>): void } | undefined} logger
 */
async function loadTranscriptSafe(opts, logger) {
  try {
    return await loadTranscript(opts)
  } catch (err) {
    logger?.warn('plugin.claude.transcript_read_failed', {
      session_id: opts.sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

/**
 * @param {JsonObject | undefined} a
 * @param {JsonObject | undefined} b
 * @returns {JsonObject | undefined}
 */
function mergeAttrs(a, b) {
  if (!a) return b
  if (!b) return a
  /** @type {JsonObject} */
  const out = { ...a }
  for (const [key, value] of Object.entries(b)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = { ...(/** @type {JsonObject} */ (out[key])), ...(/** @type {JsonObject} */ (value)) }
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * @param {string | null | undefined} raw
 */
function parseHeaders(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return /** @type {Record<string, string | string[]>} */ (parsed)
  } catch {
    return undefined
  }
}


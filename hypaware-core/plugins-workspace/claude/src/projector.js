// @ts-check

import fsp from 'node:fs/promises'

import {
  anthropicConversationFields,
  anthropicConversationSource,
  anthropicExchangeAttributes,
  anthropicMessageAttributes,
  anthropicMessages,
  claudeClientVersion,
  hasAnthropicHeaderSignature,
  isAnthropicExchange,
  isAnthropicPath,
  resolveAnthropicConversationId,
  resolveAnthropicUserId,
  resolveClaudeSessionId,
} from './anthropic.js'
import {
  defaultClaudeProjectsDir,
  findTranscriptMatch,
  indexTranscriptEntries,
  loadTranscript,
} from './transcripts.js'
import {
  defaultSessionContextFile,
  pickLatestMatching,
  readSessionContext,
} from './session_context.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayExchangeProjector} AiGatewayExchangeProjector */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayExchangeInput} AiGatewayExchangeInput */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayProjectedExchange} AiGatewayProjectedExchange */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayProjectedMessage} AiGatewayProjectedMessage */

/**
 * Build the Claude exchange projector. Returns the full
 * `AiGatewayExchangeProjector` the plugin hands to
 * `gateway.registerExchangeProjector()`.
 *
 * Behavior:
 *
 *  1. `match()` — true for any captured exchange whose path looks like
 *     `/v1/messages*` OR whose headers carry an Anthropic signature
 *     (`anthropic-version`, `x-api-key`, or `Authorization: Bearer sk-ant-*`).
 *  2. `project()` — parses the request + response (HTTP body for
 *     non-streamed, SSE event stream for streamed) into the canonical
 *     Anthropic message list, resolves a session id from
 *     `metadata.user_id.session_id` / `x-claude-code-session-id`, reads
 *     the latest matching session-context record off
 *     `<stateDir>/session-context.jsonl` for `cwd` / `git_branch`,
 *     and walks the JSONL transcript for native DAG identity. When the
 *     transcript supplies a matching `uuid`:
 *       - `message_id = provider_uuid = uuid`
 *       - `previous_message_id = parentUuid ? [parentUuid] : []`
 *     On a miss, messages are returned without `message_id` so the
 *     gateway computes its fallback hash identity and stamps
 *     `attributes.gateway.identity_source = "gateway_fallback"`.
 *
 * @param {{
 *   homeDir: string,
 *   stateFile: string,
 *   projectsDir?: string,
 *   clientName?: string,
 *   logger?: { warn(message: string, fields?: Record<string, unknown>): void, debug?: (m: string, f?: Record<string, unknown>) => void },
 * }} opts
 * @returns {AiGatewayExchangeProjector}
 */
export function createClaudeExchangeProjector(opts) {
  const projectsDir = opts.projectsDir ?? defaultClaudeProjectsDir(opts.homeDir)
  const stateFile = opts.stateFile
  const clientName = opts.clientName ?? 'claude'
  const logger = opts.logger
  const sessionContextCache = createSessionContextCache()

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
        // Surface the skip — adapter projectors that decline must
        // still leave a breadcrumb so a missing row is debuggable.
        ctx.log.warn('plugin.claude.projector_skip', {
          reason: 'unparseable_request_body',
          exchange_id: input.exchange_id,
        })
        return undefined
      }

      const responseBody = parseMaybeJson(input.response_body)
      const headers = parseHeaders(input.request_headers)
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
      const transcriptEntries = sessionId
        ? await loadTranscriptSafe({
          projectsDir,
          sessionId,
          transcriptPath: sessionContextRecord?.transcript_path,
        }, logger)
        : []
      const transcriptIndex = indexTranscriptEntries(transcriptEntries)
      const identityFromTranscript = transcriptIndex.ordered.length > 0
      const conversationId = resolveAnthropicConversationId(
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
      /** @type {AiGatewayProjectedMessage[]} */
      const projectedMessages = []
      const responseMessageId = isPlainObject(responseBody)
        ? stringValue(responseBody.id)
        : undefined
      for (const message of messages) {
        const role = stringValue(message.role)
        if (!role) continue
        const messageIdHint = role === 'assistant'
          ? stringValue(message.id) ?? responseMessageId
          : undefined
        const transcriptMatch = identityFromTranscript
          ? findTranscriptMatch(transcriptIndex, {
            role,
            content: message.content,
            messageId: messageIdHint,
          })
          : undefined
        /** @type {AiGatewayProjectedMessage} */
        const projected = {
          role,
          content: /** @type {any} */ (message.content),
        }
        if (transcriptMatch?.provider_uuid) {
          projected.message_id = transcriptMatch.provider_uuid
          projected.provider_uuid = transcriptMatch.provider_uuid
          projected.previous_message_id = transcriptMatch.parent_uuid
            ? [transcriptMatch.parent_uuid]
            : []
        }
        if (transcriptMatch) {
          if (transcriptMatch.parent_uuid) projected.parent_uuid = transcriptMatch.parent_uuid
          if (transcriptMatch.logical_parent_uuid) projected.logical_parent_uuid = transcriptMatch.logical_parent_uuid
          if (transcriptMatch.source_tool_assistant_uuid) projected.source_tool_assistant_uuid = transcriptMatch.source_tool_assistant_uuid
          if (transcriptMatch.request_id) projected.request_id = transcriptMatch.request_id
          if (transcriptMatch.prompt_id) projected.prompt_id = transcriptMatch.prompt_id
          if (transcriptMatch.provider_type) projected.provider_type = transcriptMatch.provider_type
          if (transcriptMatch.provider_subtype) projected.provider_subtype = transcriptMatch.provider_subtype
          if (transcriptMatch.entrypoint) projected.entrypoint = transcriptMatch.entrypoint
          if (transcriptMatch.user_type) projected.user_type = transcriptMatch.user_type
          if (transcriptMatch.permission_mode) projected.permission_mode = transcriptMatch.permission_mode
          if (transcriptMatch.is_sidechain !== undefined) projected.is_sidechain = transcriptMatch.is_sidechain
          if (transcriptMatch.attachment_type) projected.attachment_type = transcriptMatch.attachment_type
          if (transcriptMatch.hook_event) projected.hook_event = transcriptMatch.hook_event
          if (transcriptMatch.is_compact_summary !== undefined) projected.is_compact_summary = transcriptMatch.is_compact_summary
          if (transcriptMatch.compact_metadata !== undefined) projected.compact_metadata = /** @type {any} */ (transcriptMatch.compact_metadata)
          if (isPlainObject(transcriptMatch.raw_frame)) projected.raw_frame = /** @type {any} */ (transcriptMatch.raw_frame)
        }
        const messageAttrs = anthropicMessageAttributes(message)
        if (messageAttrs) projected.attributes = messageAttrs
        if (typeof message.stop_reason === 'string') {
          // The gateway core reads `stop_reason` off the projected
          // message; the projector contract keeps it on the message
          // (not on the exchange) so per-message status mapping works.
          /** @type {any} */ (projected).stop_reason = message.stop_reason
        }
        projectedMessages.push(projected)
      }

      if (projectedMessages.length === 0) return undefined

      /** @type {AiGatewayProjectedExchange} */
      const projection = {
        provider: 'anthropic',
        conversation_id: conversationId,
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
      if (exchangeAttrs) projection.attributes = exchangeAttrs
      if (input.ts_start) projection.conversation_started_at = input.ts_start

      // Claude-side identity provenance. Per the phase 2 spec, only
      // the missing-log case stamps an explicit marker — when the
      // transcript supplied uuids the projection's `message_id` /
      // `previous_message_id` already encode the native DAG and no
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
      // accept arbitrary paths via header signature — record both so
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
 * Register the Anthropic upstream preset on the gateway. Same routing
 * surface as `match()` on the projector — keeping them paired here
 * avoids drift between routing and projection.
 *
 * @returns {import('../../../../collectivus-plugin-kernel-types').AiGatewayUpstreamPreset}
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
 * @param {Record<string, unknown> | undefined} a
 * @param {Record<string, unknown> | undefined} b
 */
function mergeAttrs(a, b) {
  if (!a) return b
  if (!b) return a
  /** @type {Record<string, unknown>} */
  const out = { ...a }
  for (const [key, value] of Object.entries(b)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = { ...(/** @type {Record<string, unknown>} */ (out[key])), ...value }
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * @param {string | null | undefined} value
 */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
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

/** @param {unknown} value */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

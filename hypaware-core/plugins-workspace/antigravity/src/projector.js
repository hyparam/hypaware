// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveRepoFromCwd } from './git_repo.js'

/**
 * @import {
 *   AiGatewayProjectedExchange,
 *   AiGatewayProjectedMessage,
 *   JsonObject,
 *   JsonValue,
 * } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { UsageClass, UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 * @import { AntigravitySummaryRow, AntigravityTranscriptStep } from './types.js'
 */

export const ANTIGRAVITY_PROVIDER = 'google'
export const DEFAULT_ANTIGRAVITY_MODEL = 'antigravity'

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i

/**
 * Parse a `workspace_uris` JSON array from `conversation_summaries.db` and
 * return the first local filesystem path (`cwd`), or `undefined` when absent
 * or unparseable.
 *
 * @param {string | null | undefined} workspaceUrisJson
 * @returns {string | undefined}
 */
export function resolveCwdFromWorkspaceUris(workspaceUrisJson) {
  if (typeof workspaceUrisJson !== 'string' || workspaceUrisJson.length === 0) {
    return undefined
  }
  let parsed
  try {
    parsed = JSON.parse(workspaceUrisJson)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  for (const item of parsed) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (item.startsWith('file://')) {
      try {
        return fileURLToPath(item)
      } catch {
        continue
      }
    }
    if (path.isAbsolute(item)) {
      return item
    }
  }
  return undefined
}

/**
 * Extract the user prompt from an Antigravity `USER_INPUT` step's `content`.
 * Antigravity wraps user messages in `<USER_REQUEST>...</USER_REQUEST>` (often
 * preceded by `<USER_SETTINGS_CHANGE>...</USER_SETTINGS_CHANGE>`). When the
 * tag is present, returns the trimmed inner text; otherwise returns the
 * trimmed raw string.
 *
 * @param {string | undefined} rawContent
 * @returns {string}
 */
export function extractUserRequestText(rawContent) {
  if (typeof rawContent !== 'string' || rawContent.length === 0) return ''
  const match = USER_REQUEST_RE.exec(rawContent)
  if (match && typeof match[1] === 'string') {
    return match[1].trim()
  }
  return rawContent.trim()
}

/**
 * Parse a JSONL transcript text into an array of step objects, skipping blank
 * or malformed trailing lines.
 *
 * @param {string} jsonlText
 * @returns {AntigravityTranscriptStep[]}
 */
export function parseTranscriptJsonl(jsonlText) {
  /** @type {AntigravityTranscriptStep[]} */
  const steps = []
  let start = 0
  const len = jsonlText.length
  while (start < len) {
    let end = jsonlText.indexOf('\n', start)
    if (end === -1) end = len
    const line = jsonlText.slice(start, end).trim()
    start = end + 1
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        steps.push(parsed)
      }
    } catch {
      // Skip malformed or partially-written line
    }
  }
  return steps
}

/**
 * Read a conversation's transcript JSONL file and project it into an
 * `AiGatewayProjectedExchange` item ready for `ai_gateway.projected_exchange`.
 *
 * @param {{
 *   summary: AntigravitySummaryRow,
 *   transcriptPath: string,
 *   clientName?: 'antigravity' | 'antigravity-desktop',
 *   entrypoint?: 'cli' | 'desktop',
 *   resolver?: UsagePolicyResolver,
 *   ignoredSessions?: Set<string>,
 *   deriveRepo?: (cwd: string | undefined) => Promise<{ git_remote?: string, repo_root?: string }>,
 *   repoCache?: Map<string, Promise<{ git_remote?: string, repo_root?: string }>>,
 * }} args
 * @returns {Promise<
 *   | { item: AiGatewayProjectedExchange, skipped?: undefined }
 *   | { item?: undefined, skipped: 'hypignore' | 'ignored_session' | 'empty' | 'missing' }
 * >}
 */
export async function projectAntigravityConversation(args) {
  const {
    summary,
    transcriptPath,
    clientName = 'antigravity',
    entrypoint = 'cli',
    resolver,
    ignoredSessions,
    deriveRepo = deriveRepoFromCwd,
    repoCache,
  } = args

  const conversationId = summary.conversation_id
  if (!conversationId) return { skipped: 'empty' }

  if (ignoredSessions?.has(conversationId)) {
    return { skipped: 'ignored_session' }
  }

  const cwd = resolveCwdFromWorkspaceUris(summary.workspace_uris)

  /** @type {UsageClass} */
  let usageClass = 'full'
  if (cwd && resolver) {
    const decision = resolver.resolve(cwd)
    const resolvedClass = decision?.class
    if (resolvedClass === 'ignore') {
      ignoredSessions?.add(conversationId)
      return { skipped: 'hypignore' }
    }
    if (resolvedClass === 'local-only' || resolvedClass === 'full') {
      usageClass = resolvedClass
    }
  }

  let jsonlText
  try {
    jsonlText = await fs.readFile(transcriptPath, 'utf8')
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { skipped: 'missing' }
    }
    throw err
  }

  const steps = parseTranscriptJsonl(jsonlText)
  if (steps.length === 0) {
    return { skipped: 'empty' }
  }

  const fallbackIso = normalizeIsoTimestamp(
    summary.last_user_input_time ?? summary.last_modified_time,
    new Date(0).toISOString()
  )

  /** @type {AiGatewayProjectedMessage[]} */
  const projectedMessages = []
  /** @type {Array<{ id: string, name?: string }>} */
  const pendingToolCalls = []

  let firstTimestampIso = ''
  let lastTimestampIso = ''

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx]
    const stepIdx = typeof step.step_index === 'number' && Number.isFinite(step.step_index)
      ? Math.trunc(step.step_index)
      : idx
    const stepType = typeof step.type === 'string' ? step.type : ''
    const createdAt = normalizeIsoTimestamp(
      step.completed_at ?? step.created_at,
      lastTimestampIso || fallbackIso
    )
    if (!firstTimestampIso) firstTimestampIso = createdAt
    lastTimestampIso = createdAt

    const messageId = `agy-${conversationId}-step-${stepIdx}`

    if (stepType === 'USER_INPUT') {
      pendingToolCalls.length = 0
      const text = extractUserRequestText(step.content)
      if (text.length === 0) continue
      projectedMessages.push({
        message_id: messageId,
        role: 'user',
        message_created_at: normalizeIsoTimestamp(step.created_at, createdAt),
        content: [
          {
            type: 'text',
            text,
          },
        ],
      })
      continue
    }

    if (stepType === 'PLANNER_RESPONSE') {
      const inTok = nonNegInt(step.input_tokens)
      const outTok = nonNegInt(step.output_tokens)
      const cacheReadTok = nonNegInt(step.cache_read_tokens)

      /** @type {JsonObject[]} */
      const content = []

      if (typeof step.thinking === 'string' && step.thinking.length > 0) {
        content.push({
          type: 'thinking',
          thinking: step.thinking,
        })
      }

      if (Array.isArray(step.tool_calls)) {
        for (let tcIdx = 0; tcIdx < step.tool_calls.length; tcIdx++) {
          const tc = step.tool_calls[tcIdx]
          if (!tc || typeof tc !== 'object') continue
          const toolUseId = `${messageId}-call-${tcIdx}`
          const toolName = typeof tc.name === 'string' && tc.name.length > 0 ? tc.name : undefined
          const inputVal = /** @type {JsonValue} */ (tc.args ?? {})
          pendingToolCalls.push({ id: toolUseId, ...(toolName ? { name: toolName } : {}) })
          content.push({
            type: 'tool_use',
            id: toolUseId,
            ...(toolName ? { name: toolName } : {}),
            input: inputVal,
          })
        }
      }

      if (typeof step.content === 'string' && step.content.length > 0) {
        content.push({
          type: 'text',
          text: step.content,
        })
      }

      const hasUsage = (inTok !== undefined && inTok > 0)
        || (outTok !== undefined && outTok > 0)
        || (cacheReadTok !== undefined && cacheReadTok > 0)

      if (content.length === 0 && hasUsage) {
        content.push({
          type: 'text',
          text: '',
        })
      }

      if (content.length === 0) continue

      /** @type {JsonObject} */
      const usage = {}
      if (inTok !== undefined) usage.input_tokens = inTok
      if (outTok !== undefined) usage.output_tokens = outTok
      if (cacheReadTok !== undefined) usage.cache_read_tokens = cacheReadTok

      /** @type {AiGatewayProjectedMessage} */
      const msg = {
        message_id: messageId,
        role: 'assistant',
        model: DEFAULT_ANTIGRAVITY_MODEL,
        message_created_at: createdAt,
        content,
        ...(Object.keys(usage).length > 0 ? { attributes: { usage } } : {}),
      }

      projectedMessages.push(msg)
      continue
    }

    if (stepType === 'GENERIC') {
      const matchedCall = pendingToolCalls.shift()
      const isError = step.status === 'ERROR' || (typeof step.error === 'string' && step.error.length > 0)
      const contentText = typeof step.content === 'string' && step.content.length > 0
        ? step.content
        : typeof step.error === 'string'
          ? step.error
          : ''
      if (contentText.length === 0 && !isError && matchedCall === undefined) {
        continue
      }
      projectedMessages.push({
        message_id: messageId,
        role: 'tool',
        message_created_at: createdAt,
        content: [
          {
            type: 'tool_result',
            tool_use_id: matchedCall?.id ?? `${messageId}-result`,
            ...(matchedCall?.name ? { name: matchedCall.name } : {}),
            content: contentText,
            is_error: isError,
          },
        ],
      })
    }
  }

  if (projectedMessages.length === 0) {
    return { skipped: 'empty' }
  }

  let repo = {}
  if (cwd) {
    if (repoCache) {
      let cached = repoCache.get(cwd)
      if (!cached) {
        cached = deriveRepo(cwd)
        repoCache.set(cwd, cached)
      }
      repo = await cached
    } else {
      repo = await deriveRepo(cwd)
    }
  }

  const parentThreadId = typeof summary.parent_conversation_id === 'string' && summary.parent_conversation_id.length > 0
    ? summary.parent_conversation_id
    : undefined
  const isSidechain = parentThreadId !== undefined || (summary.nesting_depth > 0)
  const agentId = typeof summary.agent_name === 'string' && summary.agent_name.length > 0
    ? summary.agent_name
    : undefined

  /** @type {AiGatewayProjectedExchange} */
  const item = {
    request_id: `agy-${conversationId}`,
    conversation_started_at: firstTimestampIso || fallbackIso,
    conversation_source: clientName,
    provider: ANTIGRAVITY_PROVIDER,
    model: DEFAULT_ANTIGRAVITY_MODEL,
    session_id: conversationId,
    conversation_id: conversationId,
    ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(isSidechain ? { is_sidechain: true } : {}),
    client_name: clientName,
    entrypoint,
    ...(cwd ? { cwd } : {}),
    ...(repo.git_remote ? { git_remote: repo.git_remote } : {}),
    ...(repo.repo_root ? { repo_root: repo.repo_root } : {}),
    ...(usageClass !== 'full' ? { attributes: { usage_class: usageClass } } : {}),
    messages: projectedMessages,
  }

  return { item }
}

/**
 * Normalize a timestamp string into ISO-8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 *
 * @param {string | number | null | undefined} value
 * @param {string} fallbackIso
 * @returns {string}
 */
export function normalizeIsoTimestamp(value, fallbackIso) {
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return new Date(ms).toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000
    return new Date(Math.round(ms)).toISOString()
  }
  return fallbackIso
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function nonNegInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.trunc(value)
}

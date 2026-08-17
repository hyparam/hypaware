// @ts-check

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage } from '../../../../../hypaware-plugin-kernel-types.js'
 * @import { ClaudeTelemetryEvent, ClaudeTelemetrySessionFacts, SessionContextRecord } from '../types.js'
 */

/** Every row this path writes describes Claude Code talking to Anthropic. */
const PROVIDER = 'anthropic'

/**
 * How many unclaimed `api_request` usage records to carry between
 * batches. Most are claimed by the next batch's `assistant_response`;
 * a turn that ends in tool calls never produces one, so the map needs a
 * ceiling or a long session leaks one entry per tool round trip.
 */
export const USAGE_INDEX_LIMIT = 512

/**
 * `conversation_source` for the OTEL path. The live proxy derives
 * `claude_code` from the request User-Agent; there is no request here,
 * but the producer IS Claude Code by construction (the events come from
 * its own exporter), so the same value is the honest one and the two
 * producers' rows stay comparable.
 */
const CONVERSATION_SOURCE = 'claude_code'

/**
 * Event names this listener turns into `ai_gateway_messages` content.
 * Everything else on the stream is behavioral and belongs in
 * `claude_telemetry_events` (LLP 0255), not widened into this dataset.
 */
export const CONTENT_EVENT_NAMES = Object.freeze(['user_prompt', 'assistant_response'])

/**
 * Split a batch of events into one projected exchange per session.
 *
 * The event stream is the spine: `user_prompt` and `assistant_response`
 * each carry their own `message.uuid`, so a row's identity is known when
 * it is written and no settlement pass has anything to repair.
 * `api_request` carries no content and no uuid; it is the usage record
 * for the `request_id` an `assistant_response` names, and is folded onto
 * that message's `attributes.usage` rather than becoming a row of its
 * own.
 *
 * `usageByRequestId` is owned by the caller and outlives one batch: the
 * exporter flushes on a timer, so a turn's `api_request` and its
 * `assistant_response` can arrive in different POSTs.
 *
 * @ref LLP 0252#events-first [implements]: each content event is projected
 *   once, from the event that carries it, with `message.uuid` as the identity
 * @ref LLP 0254#identity-at-ingest [implements]: native identity, so no
 *   settlement enricher runs on these rows
 * @param {ClaudeTelemetryEvent[]} events
 * @param {{
 *   clientName: string,
 *   usageByRequestId: Map<string, Record<string, unknown>>,
 *   sessionContext?: (sessionId: string) => SessionContextRecord | undefined,
 * }} opts
 * @returns {AiGatewayProjectedExchange[]}
 */
export function projectClaudeTelemetryEvents(events, opts) {
  /** @type {Map<string, { facts: ClaudeTelemetrySessionFacts, messages: AiGatewayProjectedMessage[] }>} */
  const bySession = new Map()

  for (const event of events) {
    const sessionId = stringAttr(event, 'session.id')
    if (!sessionId) continue

    if (event.name === 'api_request') {
      const requestId = stringAttr(event, 'request_id')
      if (requestId) rememberUsage(opts.usageByRequestId, requestId, usageFromApiRequest(event))
      continue
    }
    if (!CONTENT_EVENT_NAMES.includes(event.name)) continue

    const message = messageFromEvent(event, opts.usageByRequestId)
    if (!message) continue

    let entry = bySession.get(sessionId)
    if (!entry) {
      entry = { facts: sessionFacts(event), messages: [] }
      bySession.set(sessionId, entry)
    }
    mergeSessionFacts(entry.facts, event)
    entry.messages.push(message)
  }

  /** @type {AiGatewayProjectedExchange[]} */
  const projections = []
  for (const [sessionId, entry] of bySession) {
    if (entry.messages.length === 0) continue
    projections.push(buildProjection({
      sessionId,
      facts: entry.facts,
      messages: entry.messages,
      clientName: opts.clientName,
      // @ref LLP 0254#hook-stays [implements]: cwd and git identity come from
      // the SessionStart hook's record, not from the event attributes (the
      // spike found no `workspace.host_paths` on a plain local session)
      record: opts.sessionContext?.(sessionId),
    }))
  }
  return projections
}

/**
 * @param {{
 *   sessionId: string,
 *   facts: ClaudeTelemetrySessionFacts,
 *   messages: AiGatewayProjectedMessage[],
 *   clientName: string,
 *   record: SessionContextRecord | undefined,
 * }} args
 * @returns {AiGatewayProjectedExchange}
 */
function buildProjection({ sessionId, facts, messages, clientName, record }) {
  /** @type {AiGatewayProjectedExchange} */
  const projection = {
    provider: PROVIDER,
    // conversation_id stays null for Claude: the session id is the
    // session container, not a per-thread id. @ref LLP 0030#decision
    session_id: sessionId,
    conversation_source: CONVERSATION_SOURCE,
    client_name: clientName,
    messages,
  }
  if (facts.clientVersion) projection.client_version = facts.clientVersion
  if (facts.entrypoint) projection.entrypoint = facts.entrypoint
  if (facts.userId) projection.user_id = facts.userId
  if (facts.model) projection.model = facts.model
  if (facts.startedAt) projection.conversation_started_at = facts.startedAt
  // @ref LLP 0252#consequences [implements]: `query_source` and `agent.name`
  // are the attribution source on this path; parent_uuid, logical_parent_uuid,
  // user_type and permission_mode are left unset and read null.
  if (facts.agentName) {
    projection.agent_id = facts.agentName
    projection.is_sidechain = true
  }
  if (record?.cwd) projection.cwd = record.cwd
  if (record?.git_branch) projection.git_branch = record.git_branch
  // @ref LLP 0032#capture: repo identity for the graph bridge rides the same
  // hook-written record the proxy and backfill producers read.
  if (record?.git_remote) projection.git_remote = record.git_remote
  if (record?.head_sha) projection.head_sha = record.head_sha
  if (record?.repo_root) projection.repo_root = record.repo_root

  /** @type {Record<string, unknown>} */
  const claude = {}
  if (facts.querySource) claude.query_source = facts.querySource
  if (facts.organizationId) claude.organization_id = facts.organizationId
  if (facts.terminalType) claude.terminal_type = facts.terminalType
  if (Object.keys(claude).length > 0) {
    projection.attributes = /** @type {any} */ ({ claude })
  }
  return projection
}

/**
 * Turn one content event into a projected message.
 *
 * @param {ClaudeTelemetryEvent} event
 * @param {Map<string, Record<string, unknown>>} usageByRequestId
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function messageFromEvent(event, usageByRequestId) {
  const uuid = stringAttr(event, 'message.uuid')
  const promptId = stringAttr(event, 'prompt.id')
  const requestId = stringAttr(event, 'request_id')

  if (event.name === 'user_prompt') {
    // No `prompt` attribute means the operator did not turn on
    // `OTEL_LOG_USER_PROMPTS`. There is nothing to record, so record
    // nothing rather than an empty-bodied row.
    const prompt = stringAttr(event, 'prompt')
    if (!prompt || !uuid) return undefined
    /** @type {AiGatewayProjectedMessage} */
    const message = { role: 'user', content: prompt, message_id: uuid, provider_uuid: uuid }
    if (event.timestamp) message.message_created_at = event.timestamp
    if (promptId) message.prompt_id = promptId
    return message
  }

  const response = stringAttr(event, 'response')
  if (!response || !uuid) return undefined
  /** @type {AiGatewayProjectedMessage} */
  const message = { role: 'assistant', content: response, message_id: uuid, provider_uuid: uuid }
  if (event.timestamp) message.message_created_at = event.timestamp
  if (promptId) message.prompt_id = promptId
  if (requestId) message.request_id = requestId
  const model = stringAttr(event, 'model')
  if (model) message.model = model
  // Usage lands on the assistant message, exactly where the proxy path
  // puts the response's `usage` block.
  const usage = requestId ? usageByRequestId.get(requestId) : undefined
  if (usage) {
    message.attributes = /** @type {any} */ (usage)
    if (requestId) usageByRequestId.delete(requestId)
  }
  return message
}

/**
 * Remember one turn's usage, oldest-first evicted at the cap. `Map`
 * iterates in insertion order, so the first key is the oldest.
 *
 * @param {Map<string, Record<string, unknown>>} index
 * @param {string} requestId
 * @param {Record<string, unknown>} usage
 */
function rememberUsage(index, requestId, usage) {
  index.set(requestId, usage)
  while (index.size > USAGE_INDEX_LIMIT) {
    const oldest = index.keys().next()
    if (oldest.done) break
    index.delete(oldest.value)
  }
}

/**
 * Build the `attributes` block an `api_request` event contributes.
 * `usage` mirrors the proxy path's shape (`cache_read_tokens` /
 * `cache_write_tokens`), so a report cannot tell the producers apart;
 * per-request cost and latency are net-new and sit under `claude`.
 *
 * @param {ClaudeTelemetryEvent} event
 * @returns {Record<string, unknown>}
 */
function usageFromApiRequest(event) {
  /** @type {Record<string, unknown>} */
  const usage = {}
  const input = numberAttr(event, 'input_tokens')
  const output = numberAttr(event, 'output_tokens')
  const cacheRead = numberAttr(event, 'cache_read_tokens')
  const cacheWrite = numberAttr(event, 'cache_creation_tokens')
  if (input !== undefined) usage.input_tokens = input
  if (output !== undefined) usage.output_tokens = output
  if (cacheRead !== undefined) usage.cache_read_tokens = cacheRead
  if (cacheWrite !== undefined) usage.cache_write_tokens = cacheWrite

  /** @type {Record<string, unknown>} */
  const claude = {}
  const costUsd = numberAttr(event, 'cost_usd')
  const durationMs = numberAttr(event, 'duration_ms')
  const speed = stringAttr(event, 'speed')
  if (costUsd !== undefined) claude.cost_usd = costUsd
  if (durationMs !== undefined) claude.duration_ms = durationMs
  if (speed) claude.speed = speed

  /** @type {Record<string, unknown>} */
  const attributes = {}
  if (Object.keys(usage).length > 0) attributes.usage = usage
  if (Object.keys(claude).length > 0) attributes.claude = claude
  return attributes
}

/**
 * @param {ClaudeTelemetryEvent} event
 * @returns {ClaudeTelemetrySessionFacts}
 */
function sessionFacts(event) {
  /** @type {ClaudeTelemetrySessionFacts} */
  const facts = {}
  mergeSessionFacts(facts, event)
  return facts
}

/**
 * Session-level identity is repeated on every event, so first-seen
 * wins and later events only fill gaps. The earliest event timestamp
 * seeds `conversation_started_at`.
 *
 * @param {ClaudeTelemetrySessionFacts} facts
 * @param {ClaudeTelemetryEvent} event
 */
function mergeSessionFacts(facts, event) {
  facts.clientVersion ??= stringAttr(event, 'app.version')
  facts.entrypoint ??= stringAttr(event, 'app.entrypoint')
  facts.userId ??= stringAttr(event, 'user.account_uuid')
  facts.organizationId ??= stringAttr(event, 'organization.id')
  facts.terminalType ??= stringAttr(event, 'terminal.type')
  facts.querySource ??= stringAttr(event, 'query_source')
  facts.agentName ??= stringAttr(event, 'agent.name')
  facts.model ??= stringAttr(event, 'model')
  if (event.timestamp && (facts.startedAt === undefined || event.timestamp < facts.startedAt)) {
    facts.startedAt = event.timestamp
  }
}

/**
 * @param {ClaudeTelemetryEvent} event
 * @param {string} key
 * @returns {string | undefined}
 */
function stringAttr(event, key) {
  const value = event.attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {ClaudeTelemetryEvent} event
 * @param {string} key
 * @returns {number | undefined}
 */
function numberAttr(event, key) {
  const value = event.attributes[key]
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

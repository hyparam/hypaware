// @ts-check

import { BODY_EVENT_NAMES, requestBodyFacts, spooledBodyGapMessages } from './bodies.js'

/**
 * @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage } from '../../../../../hypaware-plugin-kernel-types.js'
 * @import { ClaudeTelemetryEvent, ClaudeTelemetrySessionFacts, SessionContextRecord, SpooledClaudeBody } from '../types.js'
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
 * How many sessions' body-derived exchange facts (system prompt, tools)
 * to carry between batches. A request body arrives in an early batch
 * and the assistant response often in a later one; without carry-over
 * only the rows that share a POST with the body would get the
 * `system_text` and `tools` columns the proxy path stamps on every row.
 * Bounded because system prompts are large and sessions are minted
 * freely.
 */
export const SESSION_BODY_FACTS_LIMIT = 64

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
 * Body events (`api_request_body`, `api_response_body`) join through
 * `opts.spooledBodies`, keyed by the event's `body_ref`: the caller has
 * already read the files (an async step this pure function cannot do).
 * Their gap messages are spliced in at the body event's stream position,
 * so within a session the projected order follows the body's canonical
 * message ordering, which is one of the things events do not carry.
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
 *   spooledBodies?: Map<string, SpooledClaudeBody>,
 *   sessionBodyFacts?: Map<string, { systemText?: string, tools?: unknown }>,
 * }} opts
 * @returns {AiGatewayProjectedExchange[]}
 */
export function projectClaudeTelemetryEvents(events, opts) {
  /** @type {Map<string, { facts: ClaudeTelemetrySessionFacts, messages: AiGatewayProjectedMessage[] }>} */
  const bySession = new Map()

  /** @param {string} sessionId @param {ClaudeTelemetryEvent} event */
  const sessionEntry = (sessionId, event) => {
    let entry = bySession.get(sessionId)
    if (!entry) {
      entry = { facts: sessionFacts(event), messages: [] }
      bySession.set(sessionId, entry)
    }
    mergeSessionFacts(entry.facts, event)
    return entry
  }

  for (const event of events) {
    const sessionId = stringAttr(event, 'session.id')
    if (!sessionId) continue

    if (event.name === 'api_request') {
      const requestId = stringAttr(event, 'request_id')
      if (requestId) rememberUsage(opts.usageByRequestId, requestId, usageFromApiRequest(event))
      continue
    }

    if (BODY_EVENT_NAMES.includes(event.name)) {
      const ref = stringAttr(event, 'body_ref')
      const spooled = ref ? opts.spooledBodies?.get(ref) : undefined
      if (!spooled) continue
      const entry = sessionEntry(sessionId, event)
      mergeBodyFacts(entry.facts, spooled, sessionId, opts.sessionBodyFacts)
      for (const gap of spooledBodyGapMessages(spooled, {
        event,
        usageByRequestId: opts.usageByRequestId,
      })) {
        entry.messages.push(attributeMessageToEvent(gap, event))
      }
      continue
    }

    if (!CONTENT_EVENT_NAMES.includes(event.name)) continue

    const message = messageFromEvent(event, opts.usageByRequestId)
    if (!message) continue
    sessionEntry(sessionId, event).messages.push(attributeMessageToEvent(message, event))
  }

  /** @type {AiGatewayProjectedExchange[]} */
  const projections = []
  for (const [sessionId, entry] of bySession) {
    if (entry.messages.length === 0) continue
    // A batch without this session's request body (the exporter splits a
    // turn across POSTs) still stamps the remembered system prompt and
    // tools, so the assistant rows match the proxy path's.
    const remembered = opts.sessionBodyFacts?.get(sessionId)
    if (remembered) {
      entry.facts.systemText ??= remembered.systemText
      entry.facts.tools ??= remembered.tools
    }
    // A `user_prompt` event carries no `query_source` of its own, so its row
    // borrows the session's main-loop value rather than reading null. A
    // message that DID carry one keeps it, and a message a subagent produced
    // is skipped outright: the default is the main loop's by construction, so
    // lending it to a sidechain row would put the parent's attribution back on
    // a row this same pass has just labeled the subagent's.
    if (entry.facts.querySource) {
      for (const message of entry.messages) {
        if (message.is_sidechain || message.agent_id) continue
        if (querySourceOf(message) === undefined) stampQuerySource(message, entry.facts.querySource)
      }
    }
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
 * Build the exchange the session's messages hang off, from the facts that are
 * genuinely session-wide.
 *
 * @ref LLP 0252#consequences [implements]: parent_uuid, logical_parent_uuid,
 *   user_type and permission_mode are left unset and read null on this path;
 *   `query_source` and `agent.name` are the attribution source, and both are
 *   per request, so they are stamped per message (`attributeMessageToEvent`)
 *   rather than here
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
  // @ref LLP 0252#bodies-for-gaps [implements]: the system prompt and the tool
  // declarations exist only in the spooled request body; stamped
  // exchange-level, exactly where the proxy path puts them.
  if (facts.systemText) projection.system_text = facts.systemText
  if (facts.tools !== undefined) projection.tools = /** @type {any} */ (facts.tools)
  if (record?.cwd) projection.cwd = record.cwd
  if (record?.git_branch) projection.git_branch = record.git_branch
  // @ref LLP 0032#capture: repo identity for the graph bridge rides the same
  // hook-written record the proxy and backfill producers read.
  if (record?.git_remote) projection.git_remote = record.git_remote
  if (record?.head_sha) projection.head_sha = record.head_sha
  if (record?.repo_root) projection.repo_root = record.repo_root

  /** @type {Record<string, unknown>} */
  const claude = {}
  if (facts.organizationId) claude.organization_id = facts.organizationId
  if (facts.terminalType) claude.terminal_type = facts.terminalType
  if (Object.keys(claude).length > 0) {
    projection.attributes = /** @type {any} */ ({ claude })
  }
  return projection
}

/**
 * Stamp the attribution the EVENT carries onto the message it produced.
 *
 * `agent.name` names the Task subagent that issued the request, and its
 * presence is what marks the row a sidechain; `query_source` says what
 * kind of query it was. Both are per-request, and a subagent shares its
 * parent's `session.id`, so the only correct home for either is the
 * message. Stamping them exchange-level made a row's label (and, for a
 * body-derived block with no native uuid, its fallback identity scope)
 * depend on which other events shared the exporter's flush.
 *
 * @ref LLP 0262#field-parity-r1 [implements]: `is_sidechain` / `agent_id`
 *   read from `agent.name`, per event
 * @param {AiGatewayProjectedMessage} message
 * @param {ClaudeTelemetryEvent} event
 * @returns {AiGatewayProjectedMessage}
 */
function attributeMessageToEvent(message, event) {
  const agentName = stringAttr(event, 'agent.name')
  if (agentName) {
    message.agent_id = agentName
    message.is_sidechain = true
  }
  const querySource = stringAttr(event, 'query_source')
  if (querySource) stampQuerySource(message, querySource)
  return message
}

/**
 * @param {AiGatewayProjectedMessage} message
 * @returns {string | undefined}
 */
function querySourceOf(message) {
  const claude = /** @type {any} */ (message.attributes)?.claude
  const value = claude?.query_source
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Fold `query_source` into the message's `claude` attribute block without
 * disturbing the usage block an `api_request` event may already have put
 * there.
 *
 * @param {AiGatewayProjectedMessage} message
 * @param {string} querySource
 */
function stampQuerySource(message, querySource) {
  const attributes = /** @type {Record<string, unknown>} */ (message.attributes ?? {})
  const claude = /** @type {Record<string, unknown>} */ (
    typeof attributes.claude === 'object' && attributes.claude !== null ? attributes.claude : {}
  )
  message.attributes = /** @type {any} */ ({
    ...attributes,
    claude: { ...claude, query_source: querySource },
  })
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
  trimUsageIndex(index)
}

/**
 * Evict oldest-first until the index is back under `USAGE_INDEX_LIMIT`.
 * `Map` iterates in insertion order, so the first key is the oldest.
 *
 * @param {Map<string, Record<string, unknown>>} index
 */
function trimUsageIndex(index) {
  while (index.size > USAGE_INDEX_LIMIT) {
    const oldest = index.keys().next()
    if (oldest.done) break
    index.delete(oldest.value)
  }
}

/**
 * Put back the usage a batch claimed out of the index when the write that
 * would have carried it failed, so the exporter's retry re-projects against
 * the same inputs and its rows still get their tokens and cost.
 *
 * `snapshot` is the index as it stood before projection ran. A key missing
 * from `index` now was either claimed by an assistant message (whose row
 * never landed, so it has to come back) or evicted by the cap (which does
 * not), and the two are indistinguishable from here. So both come back and
 * the cap is re-applied: during a sustained write outage nothing is ever
 * claimed and nothing ever shrinks the index, and restoring the evictions
 * unchecked would grow it by a batch on every failure instead of holding it
 * at `USAGE_INDEX_LIMIT`. Entries the batch newly remembered are left
 * alone, so an `api_request` whose response has not arrived yet still waits.
 *
 * @param {Map<string, Record<string, unknown>>} index
 * @param {Map<string, Record<string, unknown>>} snapshot
 */
export function restoreUnclaimedUsage(index, snapshot) {
  for (const [requestId, usage] of snapshot) {
    if (!index.has(requestId)) index.set(requestId, usage)
  }
  trimUsageIndex(index)
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
 * Fold a spooled request body's exchange-level fields into the session
 * facts, and remember them (bounded, oldest session evicted first) so a
 * later batch of the same session can still stamp them.
 *
 * @param {ClaudeTelemetrySessionFacts} facts
 * @param {SpooledClaudeBody} spooled
 * @param {string} sessionId
 * @param {Map<string, { systemText?: string, tools?: unknown }> | undefined} cache
 */
function mergeBodyFacts(facts, spooled, sessionId, cache) {
  const bodyFacts = requestBodyFacts(spooled)
  facts.systemText ??= bodyFacts.system_text
  if (facts.tools === undefined) facts.tools = bodyFacts.tools
  facts.model ??= bodyFacts.model
  if (cache && (facts.systemText !== undefined || facts.tools !== undefined)) {
    cache.delete(sessionId)
    cache.set(sessionId, { systemText: facts.systemText, tools: facts.tools })
    while (cache.size > SESSION_BODY_FACTS_LIMIT) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      cache.delete(oldest.value)
    }
  }
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
  // @ref LLP 0262#field-parity-r1 [constrained-by]: `agent.name` and
  // `query_source` are per-EVENT attribution, and a Task subagent runs under
  // its parent's `session.id`, so neither can become a session fact: hoisted,
  // one subagent event in a flush stamps the whole batch. `agent.name` is not
  // hoisted at all; `query_source` is kept only as the default for events that
  // carry none, and only from events a subagent did not emit, so the borrowed
  // value is always the main loop's.
  if (!stringAttr(event, 'agent.name')) facts.querySource ??= stringAttr(event, 'query_source')
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

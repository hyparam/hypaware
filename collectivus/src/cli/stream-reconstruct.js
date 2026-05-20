/**
 * Pure synthesis of an Anthropic assistant message from the SSE
 * `stream_event` rows recorded for one exchange. The output mirrors what
 * `response.body` would have contained on a non-streaming exchange, so the
 * downstream `extractMessageParts` decomposition in `messages-parquet.js`
 * treats streaming and non-streaming responses identically.
 *
 * No I/O happens here. The caller reads `stream_event` JSONL rows from the
 * proxy log and passes them in, sorted by `t_ms` ascending and all sharing
 * the same `exchange_id`.
 *
 * See bead co-7ni0 for the surrounding design and co-7ni0.1 for the
 * decomposition layer that consumes the message produced here.
 */

/**
 * One row from the proxy `stream_event` JSONL/Parquet stream. The recorder
 * writes `data` as the raw SSE data field (a JSON string); callers that
 * pre-parse it are also accepted.
 *
 * @typedef {object} StreamEventRow
 * @property {string} [exchange_id]
 * @property {'stream_event'} [kind]
 * @property {number} [t_ms]
 * @property {string} [event]
 * @property {string | Record<string, unknown> | null} [data]
 */

/**
 * Synthesised Anthropic assistant message. Same shape that
 * `extractMessageParts` consumes on the non-streaming path.
 *
 * @typedef {object} AssistantMessage
 * @property {string} [id]
 * @property {'message'} [type]
 * @property {'assistant'} role
 * @property {string} [model]
 * @property {Array<Record<string, unknown>>} content
 * @property {string} [stop_reason]
 * @property {string} [stop_sequence]
 * @property {Record<string, unknown>} [usage]
 */

/**
 * Walk SSE event rows for one exchange and return the assistant message
 * that would have appeared in `response.body` if the response had not been
 * streamed.
 *
 * Returns `null` when the stream contained no `message_start` event — the
 * only event that carries the message id, model, and starting usage, so
 * without it there is nothing meaningful to scaffold.
 *
 * Truncation policy: if the stream ended before `message_stop` and no
 * `stop_reason` was ever observed (neither in `message_start.message` nor
 * in any `message_delta`), the reconstructed message is marked with
 * `stop_reason: 'error'` so consumers can distinguish a normal `end_turn`
 * from an upstream disconnect.
 *
 * Out-of-order events: `content_block_*` events carry their own `index`
 * which is authoritative. We never assume arrival order. A
 * `content_block_delta` that arrives before its `content_block_start`
 * causes a best-effort block scaffold to be created from the delta type.
 *
 * Unknown SSE event types and unknown `delta.type` values are ignored
 * rather than raised, so a new Anthropic event type can be added without
 * breaking historical replay.
 *
 * @param {ReadonlyArray<StreamEventRow>} streamEvents
 * @returns {AssistantMessage | null}
 */
export function reconstructAssistantMessage(streamEvents) {
  /** @type {AssistantMessage | null} */
  let message = null
  /** @type {Map<number, Record<string, unknown>>} */
  const blocksByIndex = new Map()
  /** @type {Map<number, string>} */
  const partialJsonByIndex = new Map()
  let sawMessageStop = false

  for (const row of streamEvents) {
    const payload = parseEventData(row)
    if (!payload) continue
    const type = readString(payload, 'type')
    if (!type) continue

    switch (type) {
    case 'message_start': {
      const m = readObject(payload, 'message')
      if (m) message = seedMessage(m)
      break
    }
    case 'content_block_start': {
      const index = readNumber(payload, 'index')
      const block = readObject(payload, 'content_block')
      if (index == null || !block) break
      blocksByIndex.set(index, { ...block })
      const blockType = readString(block, 'type')
      if (blockType === 'tool_use' || blockType === 'server_tool_use') {
        partialJsonByIndex.set(index, '')
      }
      break
    }
    case 'content_block_delta': {
      const index = readNumber(payload, 'index')
      const delta = readObject(payload, 'delta')
      if (index == null || !delta) break
      const block = ensureBlock(blocksByIndex, index, delta)
      applyDelta(block, delta, index, partialJsonByIndex)
      break
    }
    case 'content_block_stop': {
      const index = readNumber(payload, 'index')
      if (index == null) break
      finalizeBlock(blocksByIndex, partialJsonByIndex, index)
      break
    }
    case 'message_delta': {
      if (!message) break
      applyMessageDelta(message, payload)
      break
    }
    case 'message_stop':
      sawMessageStop = true
      break
    default:
      break
    }
  }

  if (!message) return null

  for (const index of Array.from(blocksByIndex.keys())) {
    finalizeBlock(blocksByIndex, partialJsonByIndex, index)
  }
  message.content = orderedContent(blocksByIndex)

  if (!sawMessageStop && message.stop_reason == null) {
    message.stop_reason = 'error'
  }

  return message
}

/**
 * Build the initial assistant-message scaffold from the `message` object
 * delivered in `message_start`. Copies the well-known fields; ignores
 * `content` (rebuilt from block events) and any unknown extensions so we
 * stay close to the historical wire shape.
 *
 * @param {Record<string, unknown>} m
 * @returns {AssistantMessage}
 */
function seedMessage(m) {
  /** @type {AssistantMessage} */
  const msg = { role: 'assistant', content: [], type: 'message' }
  const id = readString(m, 'id')
  if (id != null) msg.id = id
  const model = readString(m, 'model')
  if (model != null) msg.model = model
  const role = readString(m, 'role')
  if (role === 'assistant') msg.role = role
  const stopReason = readString(m, 'stop_reason')
  if (stopReason != null) msg.stop_reason = stopReason
  const stopSequence = readString(m, 'stop_sequence')
  if (stopSequence != null) msg.stop_sequence = stopSequence
  const usage = readObject(m, 'usage')
  if (usage) msg.usage = { ...usage }
  return msg
}

/**
 * Apply a `message_delta` payload to the running message. `delta`
 * carries terminal metadata (`stop_reason`, `stop_sequence`); `usage`
 * carries the final cumulative token counts. Both are merged in if
 * present.
 *
 * @param {AssistantMessage} message
 * @param {Record<string, unknown>} payload
 * @returns {void}
 */
function applyMessageDelta(message, payload) {
  const delta = readObject(payload, 'delta')
  if (delta) {
    if ('stop_reason' in delta) {
      const v = readString(delta, 'stop_reason')
      if (v != null) message.stop_reason = v
    }
    if ('stop_sequence' in delta) {
      const v = readString(delta, 'stop_sequence')
      if (v != null) message.stop_sequence = v
    }
  }
  const usage = readObject(payload, 'usage')
  if (usage) {
    message.usage = { ...message.usage ?? {}, ...usage }
  }
}

/**
 * Find or create the content block at `index`. The Anthropic protocol
 * always opens with `content_block_start`, but a truncated or replayed
 * stream may deliver a delta with no preceding start; in that case we
 * infer a best-effort block scaffold from the delta type so the delta
 * has somewhere to land.
 *
 * @param {Map<number, Record<string, unknown>>} blocksByIndex
 * @param {number} index
 * @param {Record<string, unknown>} delta
 * @returns {Record<string, unknown>}
 */
function ensureBlock(blocksByIndex, index, delta) {
  const existing = blocksByIndex.get(index)
  if (existing) return existing
  const dtype = readString(delta, 'type')
  /** @type {Record<string, unknown>} */
  let block
  switch (dtype) {
  case 'input_json_delta':
    block = { type: 'tool_use', input: {} }
    break
  case 'thinking_delta':
  case 'signature_delta':
    block = { type: 'thinking', thinking: '' }
    break
  case 'text_delta':
  default:
    block = { type: 'text', text: '' }
    break
  }
  blocksByIndex.set(index, block)
  return block
}

/**
 * Apply one `content_block_delta` payload to its block. Unknown delta
 * types are ignored so this is forward-compatible with new Anthropic
 * delta shapes (e.g. citations) that don't need explicit handling for
 * faithful reconstruction.
 *
 * @param {Record<string, unknown>} block
 * @param {Record<string, unknown>} delta
 * @param {number} index
 * @param {Map<number, string>} partialJsonByIndex
 * @returns {void}
 */
function applyDelta(block, delta, index, partialJsonByIndex) {
  const dtype = readString(delta, 'type')
  switch (dtype) {
  case 'text_delta': {
    const text = readString(delta, 'text')
    if (text == null) break
    const prev = typeof block.text === 'string' ? block.text : ''
    block.text = prev + text
    break
  }
  case 'input_json_delta': {
    const partial = readString(delta, 'partial_json')
    if (partial == null) break
    const prev = partialJsonByIndex.get(index) ?? ''
    partialJsonByIndex.set(index, prev + partial)
    break
  }
  case 'thinking_delta': {
    const t = readString(delta, 'thinking')
    if (t == null) break
    const prev = typeof block.thinking === 'string' ? block.thinking : ''
    block.thinking = prev + t
    break
  }
  case 'signature_delta': {
    const sig = readString(delta, 'signature')
    if (sig == null) break
    block.signature = sig
    break
  }
  default:
    break
  }
}

/**
 * Close out a block: if it accumulated partial JSON (only tool_use does),
 * parse the joined string into `block.input`. Parse failures fall back to
 * storing the raw string so the data is not silently lost. Non-tool blocks
 * are no-ops.
 *
 * @param {Map<number, Record<string, unknown>>} blocksByIndex
 * @param {Map<number, string>} partialJsonByIndex
 * @param {number} index
 * @returns {void}
 */
function finalizeBlock(blocksByIndex, partialJsonByIndex, index) {
  const block = blocksByIndex.get(index)
  if (!block) return
  const partial = partialJsonByIndex.get(index)
  if (partial == null) return
  partialJsonByIndex.delete(index)
  if (partial.length === 0) return
  try {
    block.input = JSON.parse(partial)
  } catch {
    block.input = partial
  }
}

/**
 * Materialise the block map as an array ordered by ascending `index`,
 * matching the server's content ordering.
 *
 * @param {Map<number, Record<string, unknown>>} blocksByIndex
 * @returns {Array<Record<string, unknown>>}
 */
function orderedContent(blocksByIndex) {
  /** @type {Array<Record<string, unknown>>} */
  const out = []
  const indices = Array.from(blocksByIndex.keys()).sort((a, b) => a - b)
  for (const i of indices) {
    const block = blocksByIndex.get(i)
    if (block) out.push(block)
  }
  return out
}

/**
 * Extract and JSON-parse the `data` field from one stream event row.
 * Accepts either a string (the recorder's wire format) or an already
 * parsed object (defensive for callers that pre-parse). Returns `null`
 * for missing or invalid data.
 *
 * @param {StreamEventRow} row
 * @returns {Record<string, unknown> | null}
 */
function parseEventData(row) {
  if (!row || typeof row !== 'object') return null
  const { data } = row
  if (data == null) return null
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? /** @type {Record<string, unknown>} */ (parsed)
        : null
    } catch {
      return null
    }
  }
  if (typeof data === 'object' && !Array.isArray(data)) {
    return /** @type {Record<string, unknown>} */ (data)
  }
  return null
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @returns {string | undefined}
 */
function readString(obj, key) {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @returns {number | undefined}
 */
function readNumber(obj, key) {
  const v = obj[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @returns {Record<string, unknown> | undefined}
 */
function readObject(obj, key) {
  const v = obj[key]
  return v && typeof v === 'object' && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : undefined
}

/**
 * Conversation walker for the `proxy_messages` Parquet dataset.
 *
 * Drives `extractMessageParts` from `./messages-parquet.js` across a
 * chronological stream of exchanges. Maintains per-walker state needed for
 * row emission that cannot be derived from a single exchange:
 *
 *   - `seen_messages`: globally dedupe message rows across exchanges and days
 *     (seeded from `priorSeen` so cross-day refreshes don't re-emit history).
 *   - `conversation_started_at`: the first observation time per conversation.
 *   - `tool_call_lookup`: `tool_call_id` → `{ tool_name, conversation_id }`,
 *     populated as `tool_use` blocks pass through so subsequent `tool_result`
 *     blocks (in a later exchange's user message) can resolve `tool_name`.
 *
 * The walker is pure-ish: it has no I/O of its own. Callers feed it
 * `ExchangeWithStreamEvents` values and the walker yields part rows
 * suitable for direct Parquet write (with `gateway_id` already attached).
 *
 * See umbrella co-7ni0 for the full design and bead co-7ni0.3 for the
 * walker contract.
 */

import { createHash } from 'node:crypto'

import { computeMessageId, extractMessageParts } from './messages-parquet.js'

/**
 * @import { ToolCallLookup } from './messages-parquet.js'
 */

/**
 * Walk exchanges chronologically and yield part rows for messages not
 * already present in `priorSeen` (and not already emitted earlier in this
 * walk). The output is in chronological order so callers can partition by
 * `message_created_at`-date as the rows stream past.
 *
 * @param {AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>} exchanges
 *   Sorted by `ts_start` ascending. Each item is a JSONL exchange row,
 *   optionally with stream events bundled (`stream_events`) so the
 *   reconstruction hook can build the assistant message when
 *   `response.body` is absent.
 * @param {WalkerOptions} [opts]
 * @yields {Record<string, unknown>}
 *   Part rows ready to be written to Parquet. Each row carries
 *   `gateway_id` (from opts) plus the schema columns declared in
 *   `messages-parquet.js`.
 */
export async function* walkExchanges(exchanges, opts) {
  const gateway_id = opts?.gateway_id
  const provider = resolveProvider(opts?.upstream)
  const reconstruct = typeof opts?.reconstructAssistantMessage === 'function'
    ? opts.reconstructAssistantMessage
    : undefined

  /** @type {Map<string, { conversation_id: string, message_index: number }>} */
  const seenMessages = new Map()
  if (opts?.priorSeen) {
    for (const [id, entry] of opts.priorSeen) {
      seenMessages.set(id, { conversation_id: entry.conversation_id, message_index: entry.message_index })
    }
  }

  /** @type {Map<string, unknown>} */
  const conversationStartedAt = new Map()
  /** @type {Map<string, Map<string, { tool_name?: string, conversation_id: string }>>} */
  const toolCallLookupByConversation = new Map()

  for await (const exchange of exchanges) {
    if (!exchange || typeof exchange !== 'object') continue

    const reqBodyParsed = parseMaybeJson(readPath(exchange, ['request', 'body']))
    if (!reqBodyParsed || typeof reqBodyParsed !== 'object') continue
    const reqBody = /** @type {Record<string, unknown>} */ (reqBodyParsed)
    const exchangeRow = /** @type {Record<string, unknown>} */ (exchange)

    const conversation_id = resolveConversationId(reqBody, exchangeRow)
    const claudeSessionId = resolveClaudeSessionId(reqBody, exchangeRow)
    const user_id = resolveUserId(reqBody)
    const conversation_source = resolveConversationSource(exchangeRow)
    const claudeContext = resolveClaudeContext(reqBody, exchangeRow, opts?.contextLookup)
    const modelRaw = readKey(reqBody, 'model')
    const model = typeof modelRaw === 'string' ? modelRaw : undefined
    const system_text = extractSystemText(readKey(reqBody, 'system'))
    const tools = readKey(reqBody, 'tools')

    const ts_start = readKey(exchangeRow, 'ts_start')
    if (!conversationStartedAt.has(conversation_id)) {
      conversationStartedAt.set(conversation_id, ts_start)
    }
    const conversation_started_at = conversationStartedAt.get(conversation_id)

    let conversationLookup = toolCallLookupByConversation.get(conversation_id)
    if (!conversationLookup) {
      conversationLookup = new Map()
      toolCallLookupByConversation.set(conversation_id, conversationLookup)
    }
    const tool_call_lookup = /** @type {ToolCallLookup} */ (conversationLookup)

    const historyMessages = Array.isArray(readKey(reqBody, 'messages'))
      ? /** @type {Array<unknown>} */ (readKey(reqBody, 'messages'))
      : []
    const messages = historyMessages.slice()

    const assistant = resolveAssistantMessage(exchangeRow, reconstruct)
    if (assistant) messages.push(assistant)

    /** @type {string | undefined} */
    let previous_message_id
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (!message || typeof message !== 'object') continue
      const m = /** @type {Record<string, unknown>} */ (message)
      const role = typeof m.role === 'string' ? m.role : ''
      if (role.length === 0) continue

      // extractMessageParts normalises content (string → single text block) before
      // hashing, so the walker must do the same to keep its pre-check in sync
      // with the message_id that ends up on each emitted row — otherwise a
      // priorSeen seed loaded from Parquet never matches a string-form history
      // message and dedup silently breaks across days.
      const message_id = computeMessageId(conversation_id, role, normalizeContent(m.content))

      if (seenMessages.has(message_id)) {
        previous_message_id = message_id
        continue
      }

      /** @type {import('./messages-parquet.js').MessagePartsContext} */
      const ctx = {
        conversation_id,
        conversation_started_at: /** @type {string} */ (conversation_started_at),
        conversation_source,
        cwd: claudeContext.cwd,
        git_branch: claudeContext.git_branch,
        claude_version: claudeContext.claude_version,
        user_id,
        provider,
        model,
        system_text,
        tools,
        message_index: i,
        previous_message_id,
        message_created_at: /** @type {string} */ (ts_start),
        tool_call_lookup,
        claude_transcript: resolveClaudeTranscript(opts?.contextLookup, claudeSessionId, m, ts_start),
      }

      const rows = extractMessageParts(exchangeRow, m, ctx)

      for (const row of rows) {
        if (
          row.part_type === 'tool_call' &&
          typeof row.tool_call_id === 'string' &&
          typeof row.tool_name === 'string'
        ) {
          conversationLookup.set(row.tool_call_id, {
            tool_name: row.tool_name,
            conversation_id,
          })
        }
      }

      seenMessages.set(message_id, { conversation_id, message_index: i })

      for (const row of rows) {
        if (gateway_id !== undefined) {
          yield { gateway_id, ...row }
        } else {
          yield row
        }
      }

      previous_message_id = message_id
    }
  }
}

/**
 * Resolve the `conversation_id` for an exchange using the tiered strategy
 * from the design: Claude Code's metadata first, then a stable hash of the
 * first user message's content, finally a hash of `exchange_id` (so even
 * malformed single-shot exchanges get a deterministic id).
 *
 * @param {Record<string, unknown>} reqBody
 * @param {Record<string, unknown>} exchange
 * @returns {string}
 */
function resolveConversationId(reqBody, exchange) {
  const sessionId = readMetadataSessionId(reqBody)
  if (sessionId) return sessionId

  const messages = readKey(reqBody, 'messages')
  if (Array.isArray(messages) && messages.length > 0) {
    const first = messages[0]
    if (first && typeof first === 'object') {
      const firstObj = /** @type {Record<string, unknown>} */ (first)
      const { content } = firstObj
      return sha256Hex(canonicalJson(content)).slice(0, 16)
    }
  }

  const exchangeId = readKey(exchange, 'exchange_id')
  return sha256Hex(typeof exchangeId === 'string' ? exchangeId : String(exchangeId ?? '')).slice(0, 16)
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {Record<string, unknown>} exchange
 * @returns {string | undefined}
 */
function resolveClaudeSessionId(reqBody, exchange) {
  return readMetadataSessionId(reqBody) ?? readHeader(exchange, 'x-claude-code-session-id')
}

/**
 * Extract `metadata.user_id.session_id` from `request.body.metadata`.
 * Anthropic encodes `user_id` as a JSON string at runtime; we accept both
 * the string form and the already-parsed object form.
 *
 * @param {Record<string, unknown>} reqBody
 * @returns {string | undefined}
 */
function readMetadataSessionId(reqBody) {
  const meta = readKey(reqBody, 'metadata')
  if (!meta || typeof meta !== 'object') return undefined
  const userId = /** @type {Record<string, unknown>} */ (meta).user_id
  const parsed = parseMaybeJson(userId)
  if (!parsed || typeof parsed !== 'object') return undefined
  const sessionId = /** @type {Record<string, unknown>} */ (parsed).session_id
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

/**
 * `user_id` is the Anthropic-supplied account identifier — top-level only,
 * not the per-session id used for conversation_id.
 *
 * @param {Record<string, unknown>} reqBody
 * @returns {string | undefined}
 */
function resolveUserId(reqBody) {
  const meta = readKey(reqBody, 'metadata')
  if (!meta || typeof meta !== 'object') return undefined
  const userId = /** @type {Record<string, unknown>} */ (meta).user_id
  const parsed = parseMaybeJson(userId)
  if (!parsed || typeof parsed !== 'object') return undefined
  const accountUuid = /** @type {Record<string, unknown>} */ (parsed).account_uuid
  return typeof accountUuid === 'string' && accountUuid.length > 0 ? accountUuid : undefined
}

/**
 * Resolve Claude Code local context from proxy-recorded session context first,
 * then from the optional transcript lookup. The user-agent fallback only
 * provides version; cwd/git_branch must come from recorded local context.
 *
 * @param {Record<string, unknown>} reqBody
 * @param {Record<string, unknown>} exchange
 * @param {ClaudeContextLookup | undefined} lookup
 * @returns {{ cwd?: string, git_branch?: string, claude_version?: string }}
 */
function resolveClaudeContext(reqBody, exchange, lookup) {
  const sessionId = readMetadataSessionId(reqBody) ?? readHeader(exchange, 'x-claude-code-session-id')
  const transcript = readTranscriptContext(lookup, sessionId, readKey(exchange, 'ts_start'))
  const recorded = resolveRecordedContext(reqBody, exchange)
  const uaVersion = claudeVersionFromUserAgent(readPath(exchange, ['client', 'user_agent']))

  return {
    cwd: firstString(recorded.cwd, transcript?.cwd),
    git_branch: firstString(recorded.git_branch, transcript?.git_branch),
    claude_version: firstString(recorded.claude_version, transcript?.claude_version, uaVersion),
  }
}

/**
 * @param {ClaudeContextLookup | undefined} lookup
 * @param {string | undefined} sessionId
 * @param {unknown} timestamp
 * @returns {{ cwd?: string, git_branch?: string, claude_version?: string } | undefined}
 */
function readTranscriptContext(lookup, sessionId, timestamp) {
  if (!lookup || !sessionId) return undefined
  try {
    return lookup(sessionId, timestamp)
  } catch {
    return undefined
  }
}

/**
 * @param {ClaudeContextLookup | undefined} lookup
 * @param {string | undefined} sessionId
 * @param {Record<string, unknown>} message
 * @param {unknown} timestamp
 * @returns {import('./messages-parquet.js').ClaudeTranscriptMatch | undefined}
 */
function resolveClaudeTranscript(lookup, sessionId, message, timestamp) {
  if (!lookup || !sessionId || typeof lookup.matchMessage !== 'function') return undefined
  try {
    return lookup.matchMessage(sessionId, message, timestamp)
  } catch {
    return undefined
  }
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {Record<string, unknown>} exchange
 * @returns {{ cwd?: string, git_branch?: string, claude_version?: string }}
 */
function resolveRecordedContext(reqBody, exchange) {
  const meta = readKey(reqBody, 'metadata')
  const userId = meta && typeof meta === 'object'
    ? parseMaybeJson(/** @type {Record<string, unknown>} */ (meta).user_id)
    : undefined

  return {
    cwd: firstString(
      readStringKey(exchange, 'cwd'),
      readStringKey(reqBody, 'cwd'),
      readStringKey(meta, 'cwd'),
      readStringKey(userId, 'cwd')
    ),
    git_branch: firstString(
      readStringKey(exchange, 'git_branch'),
      readStringKey(exchange, 'gitBranch'),
      readStringKey(reqBody, 'git_branch'),
      readStringKey(reqBody, 'gitBranch'),
      readStringKey(meta, 'git_branch'),
      readStringKey(meta, 'gitBranch'),
      readStringKey(userId, 'git_branch'),
      readStringKey(userId, 'gitBranch')
    ),
    claude_version: firstString(
      readStringKey(exchange, 'claude_version'),
      readStringKey(exchange, 'claudeVersion'),
      readStringKey(reqBody, 'claude_version'),
      readStringKey(reqBody, 'claudeVersion'),
      readStringKey(meta, 'claude_version'),
      readStringKey(meta, 'claudeVersion'),
      readStringKey(userId, 'claude_version'),
      readStringKey(userId, 'claudeVersion')
    ),
  }
}

/**
 * @param {unknown} obj
 * @param {string} key
 * @returns {string | undefined}
 */
function readStringKey(obj, key) {
  const value = readKey(obj, key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {unknown} exchange
 * @param {string} name
 * @returns {string | undefined}
 */
function readHeader(exchange, name) {
  const headers = readPath(exchange, ['request', 'headers'])
  if (!headers || typeof headers !== 'object') return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (headers))) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      const found = value.find((entry) => typeof entry === 'string' && entry.length > 0)
      if (typeof found === 'string') return found
    }
  }
  return undefined
}

/**
 * @param {unknown} userAgent
 * @returns {string | undefined}
 */
function claudeVersionFromUserAgent(userAgent) {
  if (typeof userAgent !== 'string') return undefined
  const match = /^claude-cli\/([^/\s]+)/.exec(userAgent)
  return match?.[1]
}

/**
 * @param {...(string | undefined)} values
 * @returns {string | undefined}
 */
function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0)
}

/**
 * Tag the conversation as `claude_code` when the recorded client UA looks
 * like the CLI, otherwise `api`. The CLI uses agent strings starting with
 * `claude-cli/`, which is the agreed source-of-truth signal.
 *
 * @param {Record<string, unknown>} exchange
 * @returns {string}
 */
function resolveConversationSource(exchange) {
  const userAgent = readPath(exchange, ['client', 'user_agent'])
  if (typeof userAgent === 'string' && /^claude-cli\//.test(userAgent)) return 'claude_code'
  return 'api'
}

/**
 * Concatenate the array of `system[].text` entries into the single string
 * that lives in column `system_text`. Strings pass through verbatim; arrays
 * are joined with `\n\n` to match the on-the-wire prompt layout; anything
 * else returns undefined so the column stays null.
 *
 * @param {unknown} system
 * @returns {string | undefined}
 */
function extractSystemText(system) {
  if (typeof system === 'string') {
    return system.length === 0 ? undefined : system
  }
  if (!Array.isArray(system)) return undefined
  const texts = []
  for (const block of system) {
    if (block && typeof block === 'object') {
      const blockObj = /** @type {Record<string, unknown>} */ (block)
      const { text } = blockObj
      if (typeof text === 'string') texts.push(text)
    }
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

/**
 * Return the assistant message for this exchange. Non-streaming responses
 * already contain it in `response.body`; streamed ones need
 * `reconstructAssistantMessage` (injected by the caller, since bead 2 owns
 * the reconstruction) to walk the bundled SSE events.
 *
 * @param {Record<string, unknown>} exchange
 * @param {((exchange: Record<string, unknown>) => Record<string, unknown> | null | undefined) | undefined} reconstruct
 * @returns {Record<string, unknown> | null}
 */
function resolveAssistantMessage(exchange, reconstruct) {
  const respBody = parseMaybeJson(readPath(exchange, ['response', 'body']))
  if (respBody && typeof respBody === 'object') {
    const respObj = /** @type {Record<string, unknown>} */ (respBody)
    const { role } = respObj
    if (role === 'assistant') return respObj
  }
  if (!reconstruct) return null
  try {
    const synthesized = reconstruct(exchange)
    if (synthesized && typeof synthesized === 'object') {
      return /** @type {Record<string, unknown>} */ (synthesized)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Choose the provider string for column 4. The walker's `opts.upstream`
 * carries this directly when callers know it; otherwise we default to
 * `"anthropic"` since this is the only provider the messages schema
 * targets today.
 *
 * @param {unknown} upstream
 * @returns {string}
 */
function resolveProvider(upstream) {
  if (typeof upstream === 'string' && upstream.length > 0) return upstream
  if (upstream && typeof upstream === 'object') {
    const upstreamObj = /** @type {Record<string, unknown>} */ (upstream)
    const { provider, name } = upstreamObj
    if (typeof provider === 'string' && provider.length > 0) return provider
    if (typeof name === 'string' && name.length > 0) return name
  }
  return 'anthropic'
}

/**
 * Mirror of `extractMessageParts`' content normalisation. A string body and
 * a single-text-block array body refer to the same logical content; both
 * must hash to the same `message_id` so cross-day dedup works regardless of
 * which shape Anthropic sent the day before.
 *
 * @param {unknown} content
 * @returns {unknown}
 */
function normalizeContent(content) {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) return content
  return []
}

/**
 * Stable JSON for the conversation_id fallback hash. Keeps the same
 * algorithm as `computeMessageId` so identical content always produces
 * identical ids — the messages-parquet module doesn't export its
 * `canonicalJson`, so we re-implement the tiny recursion here.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key])
    }
    return out
  }
  return value
}

/**
 * @param {string} input
 * @returns {string}
 */
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/**
 * @param {unknown} obj
 * @param {string[]} keys
 * @returns {unknown}
 */
function readPath(obj, keys) {
  /** @type {unknown} */
  let cur = obj
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = /** @type {Record<string, unknown>} */ (cur)[key]
  }
  return cur
}

/**
 * @param {unknown} obj
 * @param {string} key
 * @returns {unknown}
 */
function readKey(obj, key) {
  if (obj === null || typeof obj !== 'object') return undefined
  return /** @type {Record<string, unknown>} */ (obj)[key]
}

/**
 * Options accepted by `walkExchanges`.
 *
 * @typedef {object} WalkerOptions
 * @property {Map<string, { conversation_id: string, message_index: number }>} [priorSeen]
 *   Message ids already present in earlier Parquet partitions; the walker
 *   skips emission for any message with a matching id. Seeded by the
 *   refresh pipeline via a DuckDB query on prior partitions.
 * @property {string} [gateway_id]
 *   Prepended to every emitted row so partitions key off the right
 *   gateway. Optional so unit tests can run without a gateway dimension.
 * @property {unknown} [upstream]
 *   Provider hint for column 4. Accepts a string (taken verbatim) or an
 *   object with `.provider`/`.name`. Defaults to `"anthropic"`.
 * @property {ClaudeContextLookup} [contextLookup]
 *   Optional Claude transcript/local-context lookup keyed by session id and
 *   exchange timestamp. Callers build it once and pass it into each walk.
 * @property {(exchange: Record<string, unknown>) => Record<string, unknown> | null | undefined} [reconstructAssistantMessage]
 *   Injected by bead 4 once bead 2 lands. Returns a synthesized assistant
 *   message for streamed exchanges where `response.body` is absent.
 *   Absence is tolerated: those exchanges contribute their history only.
 */

/**
 * @typedef {((sessionId: string | undefined, timestamp: unknown) => ({ cwd?: string, git_branch?: string, claude_version?: string } | undefined)) & {
 *   matchMessage?: (sessionId: string | undefined, message: Record<string, unknown>, timestamp: unknown) => import('./messages-parquet.js').ClaudeTranscriptMatch | undefined,
 * }} ClaudeContextLookup
 */

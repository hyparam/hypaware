import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { walkExchanges } from '../../src/cli/messages-walker.js'
import { reconstructAssistantMessage } from '../../src/cli/stream-reconstruct.js'

const FIXTURE_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'fixtures', 'proxy')

/**
 * Load a fixture JSONL file and return the bundles the walker expects:
 * exchanges sorted by ts_start with `stream_events` attached for the
 * reconstruct hook to discover. Lets each test exercise the walker on real
 * proxy-log shapes without standing up the full reader pipeline.
 *
 * @param {string} fileName
 * @returns {{ exchanges: Record<string, unknown>[], streamEventsByExchange: Map<string, Record<string, unknown>[]> }}
 */
function loadFixture(fileName) {
  const filePath = path.join(FIXTURE_DIR, fileName)
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  /** @type {Map<string, Record<string, unknown>>} */
  const exchangesById = new Map()
  /** @type {Map<string, Record<string, unknown>[]>} */
  const eventsById = new Map()
  for (const line of lines) {
    const row = JSON.parse(line)
    const id = row.exchange_id
    if (typeof id !== 'string') continue
    if (row.kind === 'exchange') exchangesById.set(id, row)
    else if (row.kind === 'stream_event') {
      const list = eventsById.get(id) ?? []
      list.push(row)
      eventsById.set(id, list)
    }
  }
  for (const list of eventsById.values()) {
    list.sort((a, b) => Number(a.t_ms ?? 0) - Number(b.t_ms ?? 0))
  }
  const exchanges = Array.from(exchangesById.values()).sort((a, b) => {
    const aStart = typeof a.ts_start === 'string' ? a.ts_start : ''
    const bStart = typeof b.ts_start === 'string' ? b.ts_start : ''
    return aStart < bStart ? -1 : aStart > bStart ? 1 : 0
  })
  return { exchanges, streamEventsByExchange: eventsById }
}

/**
 * Drain `walkExchanges` into an array. Tests want the full list so they can
 * assert ordering and dedup across the whole walk; the walker streams in
 * production but the proxy-day file is bounded.
 *
 * @param {Parameters<typeof walkExchanges>[0]} exchanges
 * @param {Parameters<typeof walkExchanges>[1]} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function drainWalk(exchanges, opts) {
  /** @type {Record<string, unknown>[]} */
  const out = []
  for await (const row of walkExchanges(exchanges, opts)) out.push(row)
  return out
}

/**
 * Build the reconstructAssistantMessage hook a real refresh wires in,
 * given a map of exchange_id → stream events.
 *
 * @param {Map<string, Record<string, unknown>[]>} eventsByExchange
 * @returns {(exchange: Record<string, unknown>) => Record<string, unknown> | null}
 */
function reconstructHook(eventsByExchange) {
  /**
   * @param {Record<string, unknown>} exchange
   * @returns {Record<string, unknown> | null}
   */
  return (exchange) => {
    const id = exchange?.exchange_id
    if (typeof id !== 'string') return null
    const events = eventsByExchange.get(id)
    if (!events) return null
    return /** @type {Record<string, unknown> | null} */ (
      reconstructAssistantMessage(/** @type {import('../../src/cli/stream-reconstruct.js').StreamEventRow[]} */ (events))
    )
  }
}

describe('walkExchanges — dedup and ordering', function() {
  it('emits one row per distinct message across a 5-turn conversation', async function() {
    const { exchanges } = loadFixture('multi-turn.jsonl')
    const rows = await drainWalk(exchanges, { gateway_id: 'gw-test' })
    const messageIds = Array.from(new Set(rows.map((r) => r.message_id)))
    // 5 user messages + 5 assistant messages — each appears in later requests
    // as history but the walker dedups them.
    expect(messageIds).toHaveLength(10)
    // Every row should carry the gateway id
    expect(rows.every((r) => r.gateway_id === 'gw-test')).toBe(true)
  })

  it('chains previous_message_id correctly across the conversation', async function() {
    const { exchanges } = loadFixture('multi-turn.jsonl')
    const rows = await drainWalk(exchanges, { gateway_id: 'gw-test' })
    // Order rows by message_index per their emitted order — they appear in walk order.
    // The first row has no predecessor; the second points at the first; etc.
    expect(rows[0].previous_message_id).toBeUndefined()
    expect(rows[1].previous_message_id).toBe(rows[0].message_id)
    expect(rows[2].previous_message_id).toBe(rows[1].message_id)
    // Spot-check the whole chain
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].previous_message_id).toBe(rows[i - 1].message_id)
    }
  })

  it('uses ts_start of the first exchange as conversation_started_at and message_created_at', async function() {
    const { exchanges } = loadFixture('multi-turn.jsonl')
    const rows = await drainWalk(exchanges, { gateway_id: 'gw-test' })
    const firstTs = exchanges[0].ts_start
    // Every row's conversation_started_at is anchored at the first exchange
    expect(rows.every((r) => r.conversation_started_at === firstTs)).toBe(true)
    // The first row's message_created_at is also the first exchange's ts_start
    expect(rows[0].message_created_at).toBe(firstTs)
    // A row from a later turn carries that turn's ts_start
    const lastRow = rows[rows.length - 1]
    expect(lastRow.message_created_at).toBe(exchanges[exchanges.length - 1].ts_start)
  })

  it('does not dedup identical user content across different conversations', async function() {
    const { exchanges } = loadFixture('multi-conversation.jsonl')
    const rows = await drainWalk(exchanges, { gateway_id: 'gw-test' })
    const userRows = rows.filter((r) => r.role === 'user')
    expect(userRows).toHaveLength(2)
    // The two "hello" messages live in different conversations and therefore
    // get distinct message_ids and distinct conversation_ids.
    expect(userRows[0].message_id).not.toBe(userRows[1].message_id)
    expect(userRows[0].conversation_id).not.toBe(userRows[1].conversation_id)
  })

  it('resolves tool_name on a tool_result via the in-walk tool_call_lookup', async function() {
    const { exchanges } = loadFixture('non-streaming-tool.jsonl')
    const rows = await drainWalk(exchanges, { gateway_id: 'gw-test' })
    const toolResultRow = rows.find((r) => r.part_type === 'tool_result')
    expect(toolResultRow).toBeDefined()
    // tool_use happened in the first exchange; tool_result in the second. The
    // walker's per-conversation lookup must thread the name across.
    expect(toolResultRow?.tool_name).toBe('get_weather')
    expect(toolResultRow?.tool_call_id).toBe('toolu_weather_paris_01')
  })

  it('honours priorSeen to skip messages already in earlier partitions', async function() {
    const { exchanges } = loadFixture('multi-turn.jsonl')
    // First walk — discover all message ids
    const firstRows = await drainWalk(exchanges, { gateway_id: 'gw-test' })
    /** @type {Map<string, { conversation_id: string, message_index: number }>} */
    const priorSeen = new Map()
    for (const row of firstRows) {
      if (typeof row.message_id === 'string' && typeof row.conversation_id === 'string' && typeof row.message_index === 'number') {
        priorSeen.set(row.message_id, { conversation_id: row.conversation_id, message_index: row.message_index })
      }
    }
    // Second walk over the same exchanges, but everything is already seen
    const secondRows = await drainWalk(exchanges, { gateway_id: 'gw-test', priorSeen })
    expect(secondRows).toHaveLength(0)
  })

  it('tags claude-cli user agents as conversation_source="claude_code"', async function() {
    const { exchanges } = loadFixture('non-streaming-simple.jsonl')
    const rows = await drainWalk(exchanges, { gateway_id: 'gw-test' })
    expect(rows.every((r) => r.conversation_source === 'claude_code')).toBe(true)
  })

  it('tags non-claude-cli user agents as conversation_source="api"', async function() {
    const { exchanges: original } = loadFixture('non-streaming-simple.jsonl')
    // Clone with a different UA so we don't perturb other tests' fixture
    const exchanges = original.map((ex) => {
      const client = /** @type {Record<string, unknown>} */ (ex.client ?? {})
      return { ...ex, client: { ...client, user_agent: 'anthropic-sdk-python/0.10.0' } }
    })
    const rows = await drainWalk(exchanges, { gateway_id: 'gw-test' })
    expect(rows.every((r) => r.conversation_source === 'api')).toBe(true)
  })

  it('falls back to a content hash for conversation_id when metadata.user_id is absent', async function() {
    // Hand-built exchange with no metadata at all
    const exchange = {
      exchange_id: 'ex-no-meta',
      kind: 'exchange',
      ts_start: '2026-05-13T20:00:00.000Z',
      ts_end: '2026-05-13T20:00:00.100Z',
      duration_ms: 100,
      upstream: 'anthropic',
      client: { user_agent: 'anthropic-sdk-python/0.10.0' },
      request: { method: 'POST', path: '/v1/messages', headers: {}, body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'fallback-content' }],
      }) },
      response: { status: 200, headers: {}, body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        id: 'msg_fallback',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {},
      }) },
      stream_event_count: 0,
    }
    const rows = await drainWalk([exchange], { gateway_id: 'gw-test' })
    expect(rows[0].conversation_id).toMatch(/^[0-9a-f]{16}$/)
    // user_id is absent because metadata is missing
    expect(rows[0].user_id).toBeUndefined()
  })

  it('falls back to a hash of exchange_id when metadata and messages are unparseable', async function() {
    const exchange = {
      exchange_id: 'ex-totally-broken',
      kind: 'exchange',
      ts_start: '2026-05-13T21:00:00.000Z',
      ts_end: '2026-05-13T21:00:00.100Z',
      duration_ms: 100,
      upstream: 'anthropic',
      client: { user_agent: 'curl/8.7.1' },
      // No messages array at all — walker hits the exchange_id fallback
      request: { method: 'POST', path: '/v1/messages', headers: {}, body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 32,
      }) },
      response: { status: 200, headers: {}, body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        id: 'msg_fallback2',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: {},
      }) },
      stream_event_count: 0,
    }
    const rows = await drainWalk([exchange], { gateway_id: 'gw-test' })
    expect(rows[0].conversation_id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('drives reconstructAssistantMessage for streamed exchanges with empty response.body', async function() {
    const { exchanges, streamEventsByExchange } = loadFixture('streaming-text.jsonl')
    const rows = await drainWalk(exchanges, {
      gateway_id: 'gw-test',
      reconstructAssistantMessage: reconstructHook(streamEventsByExchange),
    })
    const assistantRow = rows.find((r) => r.role === 'assistant')
    expect(assistantRow).toBeDefined()
    expect(assistantRow?.content_text).toBe('Hello, world!')
  })

  it('extracts the account_uuid as user_id and the session_id as conversation_id', async function() {
    const { exchanges } = loadFixture('non-streaming-simple.jsonl')
    const rows = await drainWalk(exchanges, { gateway_id: 'gw-test' })
    expect(rows[0].conversation_id).toBe('sess-simple-aaaa')
    expect(rows[0].user_id).toBe('acct-test-0001')
  })

  it('enriches cwd/git_branch/claude_version from a session transcript lookup', async function() {
    const { exchanges } = loadFixture('non-streaming-simple.jsonl')
    const rows = await drainWalk(exchanges, {
      gateway_id: 'gw-test',
      contextLookup(sessionId, timestamp) {
        expect(sessionId).toBe('sess-simple-aaaa')
        expect(timestamp).toBe('2026-05-13T10:00:00.000Z')
        return { cwd: '/repo/app', git_branch: 'main', claude_version: '2.1.141' }
      },
    })
    expect(rows.every((r) => r.cwd === '/repo/app')).toBe(true)
    expect(rows.every((r) => r.git_branch === 'main')).toBe(true)
    expect(rows.every((r) =>
      /** @type {{ client?: { claude_version?: string } }} */ (r.attributes).client?.claude_version === '2.1.141'
    )).toBe(true)
  })

  it('prefers proxy-recorded local context over transcript context', async function() {
    const { exchanges: original } = loadFixture('non-streaming-simple.jsonl')
    const exchanges = original.map((ex) => {
      return {
        ...ex,
        cwd: '/hook/repo',
        git_branch: 'feature/hook',
      }
    })
    const rows = await drainWalk(exchanges, {
      gateway_id: 'gw-test',
      contextLookup() {
        return { cwd: '/transcript/repo', git_branch: 'main', claude_version: '2.1.141' }
      },
    })
    expect(rows[0].cwd).toBe('/hook/repo')
    expect(rows[0].git_branch).toBe('feature/hook')
    expect(/** @type {{ client?: { claude_version?: string } }} */ (rows[0].attributes).client?.claude_version).toBe('2.1.141')
  })
})

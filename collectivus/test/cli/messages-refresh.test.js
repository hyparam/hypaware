import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { refreshQueryCache } from '../../src/query/refresh.js'
import { QUERY_CACHE_SCHEMA_VERSION } from '../../src/query/schema.js'
import { readCacheCursor } from '../../src/query/iceberg/cursor.js'
import { readRowsFromCursor } from '../../src/query/iceberg/store.js'

/**
 * Memo writer for capturing the refresh CLI's stdout. The refresh helper
 * writes structured progress lines that some tests assert on; collecting them
 * here keeps the tests focused on observable behavior.
 *
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

/** @type {string} */
let tmpDir
/** @type {string} */
let sinkDir
/** @type {string} */
let cacheDir
/** @type {string | undefined} */
let originalHome

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-msgs-refresh-'))
  sinkDir = path.join(tmpDir, 'sink')
  cacheDir = path.join(tmpDir, 'cache')
  fs.mkdirSync(sinkDir, { recursive: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  originalHome = process.env.HOME
  process.env.HOME = tmpDir
})

afterEach(function() {
  if (originalHome !== undefined) process.env.HOME = originalHome
  else delete process.env.HOME
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Minimal QueryPaths constructed without going through the config layer —
 * refresh only reads `recordingRoot`, `cacheDir`, and `cacheEnabled`.
 *
 * @returns {import('../../src/query/types.js').QueryPaths}
 */
function paths() {
  return {
    config: /** @type {any} */ ({}),
    configPath: '<unused>',
    recordingRoot: sinkDir,
    cacheDir,
    cacheEnabled: true,
    explicitCacheDir: true,
  }
}

/**
 * Write a list of exchange + stream_event rows to
 * `<sinkDir>/<gw>/proxy/<date>.jsonl`. Each row is JSON-stringified verbatim.
 *
 * @param {string} gatewayId
 * @param {string} date
 * @param {Record<string, unknown>[]} rows
 */
function writeProxyJsonl(gatewayId, date, rows) {
  const dir = path.join(sinkDir, gatewayId, 'proxy')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${date}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  )
}

/**
 * @param {string} sessionId
 * @param {Record<string, unknown>[]} rows
 */
function writeClaudeTranscript(sessionId, rows) {
  const dir = path.join(tmpDir, '.claude', 'projects', '-repo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  )
}

/**
 * @param {string} gatewayId
 * @param {string} date
 * @param {Record<string, unknown>[]} rows
 */
function appendProxyJsonl(gatewayId, date, rows) {
  const filePath = path.join(sinkDir, gatewayId, 'proxy', `${date}.jsonl`)
  fs.appendFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

/**
 * Build a non-streaming exchange row with the given conversation_id (in
 * `metadata.user_id.session_id`), user content, and assistant text.
 *
 * @param {object} opts
 * @param {string} opts.exchangeId
 * @param {string} opts.tsStart
 * @param {string} opts.sessionId
 * @param {Record<string, unknown>[] | string} opts.userContent  -- the message[0].content
 * @param {Record<string, unknown>[] | undefined} [opts.history]  -- prior messages
 * @param {{ content: Record<string, unknown>[] | string, stop_reason?: string }} opts.assistant
 * @param {string} [opts.model]
 * @returns {Record<string, unknown>}
 */
function buildExchange(opts) {
  const userMessage = { role: 'user', content: opts.userContent }
  const history = opts.history ?? []
  const messages = [...history, userMessage]
  const requestBody = {
    model: opts.model ?? 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages,
    metadata: { user_id: JSON.stringify({
      account_uuid: 'acct-test-0001',
      session_id: opts.sessionId,
    }) },
  }
  const responseBody = {
    model: opts.model ?? 'claude-haiku-4-5-20251001',
    id: `msg_${opts.exchangeId}`,
    type: 'message',
    role: 'assistant',
    content: typeof opts.assistant.content === 'string'
      ? [{ type: 'text', text: opts.assistant.content }]
      : opts.assistant.content,
    stop_reason: opts.assistant.stop_reason ?? 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  }
  return {
    exchange_id: opts.exchangeId,
    kind: 'exchange',
    ts_start: opts.tsStart,
    ts_end: opts.tsStart,
    duration_ms: 100,
    upstream: 'anthropic',
    client: { ip: '127.0.0.1', user_agent: 'claude-cli/2.1.140 (external, cli)' },
    request: { method: 'POST', path: '/v1/messages', headers: {}, body: JSON.stringify(requestBody) },
    response: { status: 200, headers: {}, body: JSON.stringify(responseBody) },
    stream_event_count: 0,
  }
}

/**
 * Read all rows out of a cache partition for assertions. Tests use this to
 * verify what was actually written, not just refresh's reported counts.
 *
 * @param {string} gatewayId
 * @param {string} date
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readMessagesPartition(gatewayId, date) {
  const cursor = readCacheCursor(cursorPath(gatewayId, date))
  return cursor ? readRowsFromCursor(cursor) : []
}

/**
 * @param {string} gatewayId
 * @param {string} date
 * @returns {string}
 */
function cursorPath(gatewayId, date) {
  return path.join(cacheDir, 'datasets', 'proxy_messages', `gateway_id=${gatewayId}`, `date=${date}`, 'cursor.json')
}

describe('refreshQueryCache — proxy_messages incremental', function() {
  it('writes a fresh partition on first refresh with no priorSeen', async function() {
    writeProxyJsonl('gw-test', '2026-05-13', [
      buildExchange({
        exchangeId: 'ex-fresh-1',
        tsStart: '2026-05-13T10:00:00.000Z',
        sessionId: 'sess-fresh',
        userContent: 'hello',
        assistant: { content: 'hi back' },
      }),
    ])
    const stdout = memo()
    const result = await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout })
    expect(result.failures).toBe(0)
    expect(result.written).toBeGreaterThan(0)
    expect(stdout.value()).toMatch(/priorSeen proxy_messages\/gw-test\/2026-05-13: 0 messages, 0 tool calls/)

    const rows = await readMessagesPartition('gw-test', '2026-05-13')
    expect(rows.length).toBe(2) // one user row + one assistant row
    expect(rows[0].conversation_id).toBe('sess-fresh')
  })

  it('refreshes proxy_messages with Claude local context columns', async function() {
    const exchange = buildExchange({
      exchangeId: 'ex-context-1',
      tsStart: '2026-05-13T10:00:00.000Z',
      sessionId: 'sess-context',
      userContent: 'hello',
      assistant: { content: 'hi back' },
    })
    exchange.cwd = '/repo/app'
    exchange.git_branch = 'main'
    writeProxyJsonl('gw-test', '2026-05-13', [exchange])

    const result = await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout: memo() })
    expect(result.failures).toBe(0)

    const rows = await readMessagesPartition('gw-test', '2026-05-13')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      cwd: '/repo/app',
      git_branch: 'main',
      attributes: { client: { claude_version: '2.1.140' } },
    })
  })

  it('enriches proxy_messages from local Claude transcript frames', async function() {
    writeProxyJsonl('gw-test', '2026-05-13', [
      buildExchange({
        exchangeId: 'ex-transcript-1',
        tsStart: '2026-05-13T10:00:00.000Z',
        sessionId: 'sess-transcript',
        userContent: 'hello',
        assistant: { content: 'hi back' },
      }),
    ])
    writeClaudeTranscript('sess-transcript', [
      {
        type: 'user',
        uuid: 'uuid-user',
        parentUuid: null,
        sessionId: 'sess-transcript',
        timestamp: '2026-05-13T09:59:59.900Z',
        cwd: '/repo/app',
        gitBranch: 'main',
        version: '2.1.141',
        userType: 'external',
        entrypoint: 'cli',
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        uuid: 'uuid-assistant',
        parentUuid: 'uuid-user',
        requestId: 'req-abc',
        sessionId: 'sess-transcript',
        timestamp: '2026-05-13T10:00:00.100Z',
        cwd: '/repo/app',
        gitBranch: 'main',
        version: '2.1.141',
        userType: 'external',
        entrypoint: 'cli',
        message: {
          id: 'msg_ex-transcript-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi back' }],
        },
      },
    ])

    const result = await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout: memo() })
    expect(result.failures).toBe(0)

    const rows = await readMessagesPartition('gw-test', '2026-05-13')
    const user = rows.find((row) => row.role === 'user')
    const assistant = rows.find((row) => row.role === 'assistant')
    expect(user).toMatchObject({
      provider_uuid: 'uuid-user',
      provider_type: 'user',
      client_version: '2.1.141',
      entrypoint: 'cli',
      user_type: 'external',
    })
    expect(assistant).toMatchObject({
      provider_uuid: 'uuid-assistant',
      parent_uuid: 'uuid-user',
      request_id: 'req-abc',
      provider_type: 'assistant',
    })
  })

  it('skips a fresh partition on re-run with no source changes', async function() {
    writeProxyJsonl('gw-test', '2026-05-13', [
      buildExchange({
        exchangeId: 'ex-skip-1',
        tsStart: '2026-05-13T10:00:00.000Z',
        sessionId: 'sess-skip',
        userContent: 'hi',
        assistant: { content: 'hello' },
      }),
    ])
    await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout: memo() })
    const stdout = memo()
    const result = await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout })
    expect(result.written).toBe(0)
    expect(result.skipped).toBeGreaterThan(0)
    expect(stdout.value()).toMatch(/fresh proxy_messages\/gw-test\/2026-05-13/)
  })

  it('only rebuilds new days when a new JSONL is appended', async function() {
    writeProxyJsonl('gw-test', '2026-05-13', [
      buildExchange({
        exchangeId: 'ex-day1-1',
        tsStart: '2026-05-13T10:00:00.000Z',
        sessionId: 'sess-day-A',
        userContent: 'day one',
        assistant: { content: 'reply one' },
      }),
    ])
    const first = await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout: memo() })
    expect(first.written).toBeGreaterThan(0)

    const day1CursorPath = cursorPath('gw-test', '2026-05-13')
    const day1MtimeBefore = fs.statSync(day1CursorPath).mtimeMs

    // Add a second day; the first day's cache cursor must not be rewritten.
    writeProxyJsonl('gw-test', '2026-05-14', [
      buildExchange({
        exchangeId: 'ex-day2-1',
        tsStart: '2026-05-14T10:00:00.000Z',
        sessionId: 'sess-day-B',
        userContent: 'day two',
        assistant: { content: 'reply two' },
      }),
    ])
    // Bump time so any mtime comparison would not be ambiguous.
    await new Promise((r) => setTimeout(r, 20))
    const stdout = memo()
    const second = await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout })
    expect(second.written).toBe(1)
    expect(second.skipped).toBe(1)
    expect(stdout.value()).toMatch(/fresh proxy_messages\/gw-test\/2026-05-13/)
    expect(stdout.value()).toMatch(/wrote .*date=2026-05-14/)
    const day1MtimeAfter = fs.statSync(day1CursorPath).mtimeMs
    expect(day1MtimeAfter).toBe(day1MtimeBefore)
  })

  it('appends only new rows when the current day proxy JSONL grows', async function() {
    writeProxyJsonl('gw-test', '2026-05-15', [
      buildExchange({
        exchangeId: 'ex-today-1',
        tsStart: '2026-05-15T10:00:00.000Z',
        sessionId: 'sess-today',
        userContent: 'first',
        assistant: { content: 'first reply' },
      }),
    ])
    await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout: memo() })
    const firstRows = await readMessagesPartition('gw-test', '2026-05-15')
    expect(firstRows).toHaveLength(2)

    appendProxyJsonl('gw-test', '2026-05-15', [
      buildExchange({
        exchangeId: 'ex-today-2',
        tsStart: '2026-05-15T10:05:00.000Z',
        sessionId: 'sess-today',
        userContent: 'second',
        history: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'first reply' },
        ],
        assistant: { content: 'second reply' },
      }),
    ])

    const stdout = memo()
    const second = await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout })
    expect(second.failures).toBe(0)
    expect(second.written).toBe(1)
    expect(stdout.value()).toMatch(/priorSeen proxy_messages\/gw-test\/2026-05-15: 2 messages/)

    const rows = await readMessagesPartition('gw-test', '2026-05-15')
    const messageIds = new Set(rows.map((row) => row.message_id))
    expect(rows).toHaveLength(4)
    expect(messageIds.size).toBe(4)
  })

  it('dedupes cross-day messages: a resent user message lives only in its first day', async function() {
    // Day 1: user "hello" + assistant "hi back"
    writeProxyJsonl('gw-test', '2026-05-13', [
      buildExchange({
        exchangeId: 'ex-d1-1',
        tsStart: '2026-05-13T10:00:00.000Z',
        sessionId: 'sess-cross',
        userContent: 'hello',
        assistant: { content: 'hi back' },
      }),
    ])
    // Day 2: same conversation, second turn — history carries day 1's user+assistant.
    writeProxyJsonl('gw-test', '2026-05-14', [
      buildExchange({
        exchangeId: 'ex-d2-1',
        tsStart: '2026-05-14T10:00:00.000Z',
        sessionId: 'sess-cross',
        userContent: 'follow up',
        history: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi back' },
        ],
        assistant: { content: 'follow up reply' },
      }),
    ])
    await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout: memo() })
    const day1 = await readMessagesPartition('gw-test', '2026-05-13')
    const day2 = await readMessagesPartition('gw-test', '2026-05-14')
    const day1MessageIds = new Set(day1.map((r) => r.message_id))
    const day2MessageIds = new Set(day2.map((r) => r.message_id))
    // Two distinct messages on day 1: the user's "hello" and the assistant's "hi back"
    expect(day1MessageIds.size).toBe(2)
    // Day 2 has the new follow-up + the new assistant reply only (NOT the day-1 messages)
    expect(day2MessageIds.size).toBe(2)
    for (const id of day1MessageIds) {
      expect(day2MessageIds.has(id)).toBe(false)
    }
  })

  it('backfills tool_name on a tool_result when the matching tool_use is in an earlier day', async function() {
    // Day 1: assistant emits a tool_use
    writeProxyJsonl('gw-test', '2026-05-13', [
      buildExchange({
        exchangeId: 'ex-tool-d1',
        tsStart: '2026-05-13T10:00:00.000Z',
        sessionId: 'sess-tool-cross',
        userContent: 'what is the weather in Tokyo?',
        assistant: {
          content: [{ type: 'tool_use', id: 'toolu_cross_day_01', name: 'get_weather', input: { city: 'Tokyo' } }],
          stop_reason: 'tool_use',
        },
      }),
    ])
    // Day 2: user returns tool_result; matching tool_use is in yesterday's partition.
    writeProxyJsonl('gw-test', '2026-05-14', [
      buildExchange({
        exchangeId: 'ex-tool-d2',
        tsStart: '2026-05-14T10:00:00.000Z',
        sessionId: 'sess-tool-cross',
        userContent: [{ type: 'tool_result', tool_use_id: 'toolu_cross_day_01', content: 'cloudy, 18C' }],
        history: [
          { role: 'user', content: 'what is the weather in Tokyo?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_cross_day_01', name: 'get_weather', input: { city: 'Tokyo' } }] },
        ],
        assistant: { content: 'It is cloudy and 18C in Tokyo.' },
      }),
    ])
    await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout: memo() })
    const day2 = await readMessagesPartition('gw-test', '2026-05-14')
    const toolResultRow = day2.find((r) => r.part_type === 'tool_result')
    expect(toolResultRow).toBeDefined()
    expect(toolResultRow?.tool_call_id).toBe('toolu_cross_day_01')
    expect(toolResultRow?.tool_name).toBe('get_weather')
  })

  it('treats partitions with a stale cache_schema_version as stale and rewrites them', async function() {
    writeProxyJsonl('gw-test', '2026-05-13', [
      buildExchange({
        exchangeId: 'ex-sv-1',
        tsStart: '2026-05-13T10:00:00.000Z',
        sessionId: 'sess-sv',
        userContent: 'hello',
        assistant: { content: 'world' },
      }),
    ])
    await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout: memo() })
    const metaPath = cursorPath('gw-test', '2026-05-13')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    expect(meta.cache_schema_version).toBe(QUERY_CACHE_SCHEMA_VERSION)
    // Tamper with the version to a stale value and confirm the next refresh
    // rewrites the partition instead of skipping it.
    meta.cache_schema_version = 1
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')
    const stdout = memo()
    const result = await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout })
    expect(result.written).toBe(1)
    expect(result.skipped).toBe(0)
    const reread = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    expect(reread.cache_schema_version).toBe(QUERY_CACHE_SCHEMA_VERSION)
  })

  it('force=true rewrites a fresh partition without source changes', async function() {
    writeProxyJsonl('gw-test', '2026-05-13', [
      buildExchange({
        exchangeId: 'ex-force-1',
        tsStart: '2026-05-13T10:00:00.000Z',
        sessionId: 'sess-force',
        userContent: 'hi',
        assistant: { content: 'hi' },
      }),
    ])
    await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, stdout: memo() })
    const result = await refreshQueryCache({ paths: paths(), scope: { limit: 100 }, force: true, stdout: memo() })
    expect(result.skipped).toBe(0)
    expect(result.written).toBe(1)
  })
})

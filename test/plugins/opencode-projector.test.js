// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { createProjectedExchangeWriter } from '../../hypaware-core/plugins-workspace/ai-gateway/src/exchange_writer.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { projectOpenCodeSnapshot } from '../../hypaware-core/plugins-workspace/opencode/src/projector.js'

function exportFixture() {
  return {
    info: {
      id: 'ses_native',
      version: '1.18.22',
      directory: '/work/opencode-project',
      projectID: 'project-native',
      parentID: 'ses_parent',
      time: { created: Date.parse('2026-08-24T10:00:00.000Z') },
    },
    messages: [
      {
        info: {
          id: 'msg_user',
          role: 'user',
          time: { created: Date.parse('2026-08-24T10:00:01.000Z') },
        },
        parts: [
          { id: 'part_user_text', sessionID: 'ses_native', messageID: 'msg_user', type: 'text', text: 'Read notes.txt' },
        ],
      },
      {
        info: {
          id: 'msg_assistant',
          role: 'assistant',
          parentID: 'msg_user',
          providerID: 'openai',
          modelID: 'gpt-5.6-luna',
          finish: 'stop',
          cost: 0.0025,
          tokens: { input: 12, output: 8, reasoning: 2, cache: { read: 3, write: 1 } },
          time: { created: Date.parse('2026-08-24T10:00:02.000Z') },
        },
        parts: [
          { id: 'part_assistant_text', sessionID: 'ses_native', messageID: 'msg_assistant', type: 'text', text: 'I will read it.' },
          {
            id: 'part_pending',
            sessionID: 'ses_native',
            messageID: 'msg_assistant',
            type: 'tool',
            callID: 'call_pending',
            tool: 'read',
            state: { status: 'running', input: { path: 'later.txt' }, time: { start: 1 } },
          },
          {
            id: 'part_tool',
            sessionID: 'ses_native',
            messageID: 'msg_assistant',
            type: 'tool',
            callID: 'call_native',
            tool: 'read',
            state: {
              status: 'completed',
              input: { path: 'notes.txt' },
              output: 'fixture contents',
              title: 'Read notes.txt',
              metadata: {},
              time: { start: 2, end: 3 },
            },
          },
          {
            id: 'part_future',
            sessionID: 'ses_native',
            messageID: 'msg_assistant',
            type: 'future-shape',
            futureField: { kept: true },
          },
        ],
      },
    ],
  }
}

/** @param {ReturnType<typeof exportFixture>} exported */
function liveFixture(exported) {
  return { session: exported.info, messages: exported.messages }
}

function makeStorage() {
  /** @type {Record<string, unknown>[]} */
  const appended = []
  return {
    appended,
    cacheTablePath: (/** @type {string} */ dataset) => `/cache/${dataset}`,
    async discoverCachePartitions() { return [] },
    async *readRows() {},
    async *readSpooledRows() {},
    async appendRows(/** @type {string} */ _path, /** @type {unknown} */ _columns, /** @type {Record<string, unknown>[]} */ rows) {
      appended.push(...rows)
    },
  }
}

test('OpenCode SDK and export snapshots converge on native identities and authoritative order', () => {
  const exported = exportFixture()
  const history = projectOpenCodeSnapshot(exported, {
    entrypoint: 'desktop',
    entrypointSource: 'test',
  })
  const live = projectOpenCodeSnapshot(liveFixture(exported), {
    entrypoint: 'desktop',
    entrypointSource: 'test',
  })

  assert.deepEqual(live, history)
  assert.ok(live)
  assert.equal(live.session_id, 'ses_native')
  assert.equal(live.conversation_id, 'ses_native')
  assert.equal(live.entrypoint, 'desktop')
  assert.deepEqual(live.messages.map((message) => message.message_id), ['msg_user', 'msg_assistant'])
  assert.deepEqual(
    /** @type {Record<string, unknown>[]} */ (live.messages[1].content).map((part) => part.part_id),
    ['part_assistant_text', 'part_tool', 'part_future']
  )
})

test('OpenCode projection keeps the completed tool call/result and unknown parts without persisting transient tool states', () => {
  const projection = projectOpenCodeSnapshot(exportFixture())
  assert.ok(projection)
  const parts = /** @type {Record<string, unknown>[]} */ (projection.messages[1].content)
  const tool = parts.find((part) => part.part_id === 'part_tool')
  assert.deepEqual(tool, {
    type: 'tool_result',
    part_id: 'part_tool',
    tool_use_id: 'call_native',
    name: 'read',
    input: { path: 'notes.txt' },
    content: 'fixture contents',
    is_error: false,
    raw_frame: exportFixture().messages[1].parts[2],
  })
  assert.equal(parts.some((part) => part.part_id === 'part_pending'), false)
  const future = parts.find((part) => part.part_id === 'part_future')
  assert.equal(future?.type, 'future-shape')
  assert.deepEqual(/** @type {any} */ (future?.raw_frame).futureField, { kept: true })
})

test('shared row expansion preserves part ids and carries usage/cost exactly once', () => {
  const projection = projectOpenCodeSnapshot(exportFixture())
  assert.ok(projection)
  const rows = aiGatewayRowsFromProjectedExchange(projection)
  assert.deepEqual(rows.map((row) => row.part_id), [
    'part_user_text',
    'part_assistant_text',
    'part_tool',
    'part_future',
  ])
  const tool = rows.find((row) => row.part_id === 'part_tool')
  assert.equal(tool?.tool_name, 'read')
  assert.equal(tool?.tool_call_id, 'call_native')
  assert.deepEqual(tool?.tool_args, { path: 'notes.txt' })
  assert.equal(tool?.content_text, 'fixture contents')

  const usageRows = rows.filter((row) => /** @type {any} */ (row.attributes)?.usage !== undefined)
  assert.equal(usageRows.length, 1)
  assert.equal(usageRows[0].part_id, 'part_future')
  assert.deepEqual(/** @type {any} */ (usageRows[0].attributes).usage, {
    input_tokens: 12,
    output_tokens: 8,
    reasoning_tokens: 2,
    cache_read_tokens: 3,
    cache_write_tokens: 1,
    cost_usd: 0.0025,
  })
})

test('live then export replay writes zero duplicate rows through the shared writer', async () => {
  const exported = exportFixture()
  const live = projectOpenCodeSnapshot(liveFixture(exported), { entrypoint: 'cli' })
  const history = projectOpenCodeSnapshot(exported, { entrypoint: 'unknown' })
  assert.ok(live)
  assert.ok(history)
  const storage = makeStorage()
  const writer = createProjectedExchangeWriter({ storage: /** @type {any} */ (storage) })

  assert.deepEqual(await writer.record(live), { rowsWritten: 4, rowsSkipped: 0 })
  assert.deepEqual(await writer.record(history), { rowsWritten: 0, rowsSkipped: 0 })
  assert.deepEqual(await writer.record(history), { rowsWritten: 0, rowsSkipped: 0 })
  assert.equal(storage.appended.length, 4)
})

test('missing cwd is not guessed into a projection', () => {
  const fixture = /** @type {any} */ (exportFixture())
  delete fixture.info.directory
  assert.equal(projectOpenCodeSnapshot(fixture), undefined)
})

// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { projectCursorHook, cursorCwd } from '../../hypaware-core/plugins-workspace/cursor/src/projector.js'

function envelope(event = {}) {
  return { delivery_id: randomUUID(), observed_at: '2026-09-10T12:00:00.000Z', event: {
    conversation_id: 'conversation', generation_id: 'turn', workspace_roots: ['/work'],
    cursor_version: '3.19.19', hook_event_name: 'afterAgentResponse', text: 'Repeated text', ...event,
  } }
}

test('real file-content hook remains a separate observation without an invented tool result identity', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/cursor/file-content-2026-09-08.json', import.meta.url), 'utf8'))
  const event = fixture.hooks.find((event) => event.hook_event_name === 'beforeReadFile')
  const input = envelope(event)
  const row = projectCursorHook(input)
  assert.equal(row?.messages[0].role, 'system')
  assert.equal(row?.messages[0].hook_event, 'beforeReadFile')
  assert.equal(row?.messages[0].content, 'The probe value is MARIGOLD-42.\n')
  assert.equal(/** @type {any} */ (row?.attributes?.cursor)?.file_path, '/probe/workspace/notes.txt')
  assert.deepEqual(row, projectCursorHook(input))
  assert.notEqual(row?.messages[0].message_id, projectCursorHook({ ...input, delivery_id: randomUUID() })?.messages[0].message_id)
  for (const file_path of ['', 'relative', 'x'.repeat(4097)]) {
    assert.equal(projectCursorHook(envelope({ ...event, file_path })), undefined)
  }
})

test('conversation, tool, lifecycle and thought hooks are recovery triggers only', () => {
  for (const hook_event_name of ['beforeSubmitPrompt', 'afterAgentResponse', 'postToolUse', 'postToolUseFailure', 'stop', 'afterAgentThought']) {
    assert.equal(projectCursorHook(envelope({ hook_event_name, prompt: 'hello', tool_use_id: 'call', tool_name: 'Shell', tool_output: 'done' })), undefined)
  }
  assert.equal(cursorCwd({ cwd: 'relative' }), undefined)
  assert.equal(cursorCwd({ cwd: '/work', workspace_roots: ['/work', '/secret'] }), undefined)
})

test('terminal usage has one generation identity and rejects partial or invalid accounting', () => {
  const counts = { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 10 }
  const body = envelope({ hook_event_name: 'stop', ...counts, text: 'PRIVATE', model: 'auto' })
  const projection = projectCursorHook(body)
  assert.ok(projection)
  assert.deepEqual(projection.messages[0].attributes?.usage, { ...counts, total_tokens: 160 })
  assert.equal(projection.messages[0].role, 'system')
  assert.equal(projection.messages[0].request_id, 'turn')
  assert.equal(projection.model, undefined, 'selected model is not proof of the model billed')
  assert.equal(JSON.stringify(projection).includes('PRIVATE'), false)
  assert.equal(projection.messages[0].message_id, projectCursorHook({ ...body, delivery_id: randomUUID() })?.messages[0].message_id)
  assert.notEqual(projection.messages[0].message_id, projectCursorHook(envelope({ ...counts, hook_event_name: 'stop', generation_id: 'other' }))?.messages[0].message_id)
  for (const key of Object.keys(counts)) {
    for (const value of [undefined, null, '1', -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(projectCursorHook(envelope({ hook_event_name: 'stop', ...counts, [key]: value })), undefined)
    }
  }
  for (const event of [{ generation_id: '' }, { generation_id: 'x'.repeat(257) },
    { hook_event_name: 'afterAgentResponse' }, { input_tokens: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(projectCursorHook(envelope({ hook_event_name: 'stop', ...counts, ...event })), undefined)
  }
  assert.ok(projectCursorHook(envelope({ hook_event_name: 'stop', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 })))
})

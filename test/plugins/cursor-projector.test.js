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

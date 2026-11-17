// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultBlockFromPayload } from '../../hypaware-core/plugins-workspace/codex/src/response-items.js'
import { aiGatewayRowsFromProjectedExchange, computeMessageId } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createCodexExchangeProjector } from '../../hypaware-core/plugins-workspace/codex/src/exchange-projector.js'

const cases = [
  { name: 'structured nonzero exit', output: { exit_code: 2, output: 'failed' }, error: true },
  { name: 'serialized nonzero exit', output: '{"exit_code":1,"output":"failed"}', error: true },
  { name: 'successful command', output: '{"exit_code":0,"output":"ok"}', error: false },
  { name: 'command terminal footer', output: 'Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 7\nFinal output:\nfailed', error: true },
  { name: 'successful command footer with misleading content', output: 'Process exited with code 0\nFinal output:\nScript failed\nScript error: an old failure', error: false },
  { name: 'failed script envelope', output: 'Script failed\nScript error: Error: synthetic failure', error: true },
  { name: 'successful wrapper handles inner failure', output: 'Script completed\nWall time: 0.1 seconds\nOutput:\n{"exit_code":1,"handled":true}', error: false },
  { name: 'unknown text', output: 'directory listing', error: null },
  { name: 'running process', output: 'Process running with session ID 123\nOutput:\n', error: null },
  { name: 'nested inner result has no outer outcome', output: '{"inner":{"exit_code":1},"handled":true}', error: null },
  { name: 'unrecognized exit code', output: '{"exit_code":"failed"}', error: null },
  { name: 'absent result', output: null, error: null },
]

for (const scenario of cases) {
  test(`Codex tool outcome: ${scenario.name}`, () => {
    const payload = { type: 'function_call_output', call_id: 'call-shared', output: scenario.output }
    const block = toolResultBlockFromPayload(payload)
    assert.ok(block)
    assert.equal(block.is_error, scenario.error)
    const rows = aiGatewayRowsFromProjectedExchange({
      provider: 'openai', session_id: 'synthetic-session', conversation_id: 'synthetic-thread',
      messages: [{ role: 'tool', content: [block] }],
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].is_error ?? null, scenario.error === true ? true : null)
    assert.equal(/** @type {any} */ (rows[0].status)?.tool_status,
      scenario.error === null ? undefined : scenario.error ? 'error' : 'success')
    assert.equal(rows[0].tool_call_id, 'call-shared')
  })
}

test('scoped tool identities keep the same call id in unrelated sessions and verified copies separate', () => {
  const block = toolResultBlockFromPayload({ call_id: 'same-call', output: '{"exit_code":1}' })
  assert.ok(block)
  const rows = ['session-a', 'session-b'].flatMap(session_id => aiGatewayRowsFromProjectedExchange({
    provider: 'openai', session_id, conversation_id: 'thread',
    messages: [{ role: 'tool', content: [block] }],
  }, { gatewayId: 'synthetic-gateway' }))
  const withCopy = [...rows, { ...rows[0] }]
  assert.equal(new Set(withCopy.map(row => row.tool_call_id)).size, 1, 'global call-id distinct loses an attempt')
  const verified = new Set(withCopy.map(row => JSON.stringify([row.provider, row.gateway_id, row.session_id, row.conversation_id, row.part_id])))
  assert.equal(verified.size, 2, 'one verified copy is removed and both independent attempts survive')
})

test('live Codex outcome enrichment preserves the pre-upgrade message and part IDs', async () => {
  const projection = await createCodexExchangeProjector().project(/** @type {any} */ ({
    exchange_id: 'synthetic-exchange', provider: 'openai', path: '/v1/responses',
    ts_start: '2026-11-13T12:00:00Z', request_headers: '{}', response_headers: '{}', stream_events: [],
    request_body: JSON.stringify({ model: 'synthetic', input: [
      { type: 'function_call_output', call_id: 'call-stable', output: '{"exit_code":1}' },
    ] }),
    response_body: JSON.stringify({ id: 'synthetic-response', output_text: 'done' }),
  }), /** @type {any} */ ({ log: { info() {} } }))
  assert.ok(projection && 'messages' in projection)
  const expected = computeMessageId(projection.conversation_id ?? projection.session_id, 'tool', [
    { type: 'tool_result', tool_use_id: 'call-stable', content: '{"exit_code":1}' },
  ])
  const row = aiGatewayRowsFromProjectedExchange(projection).find(row => row.tool_call_id === 'call-stable')
  assert.ok(row)
  assert.equal(row.message_id, expected)
  assert.equal(row.part_id, `${expected}#0`)
  assert.equal(/** @type {any} */ (row.status).tool_status, 'error')
})

// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { AI_GATEWAY_SCHEMA_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import {
  aiGatewayRowsFromProjectedExchange,
  computeMessageId,
  createAiGatewayConversationState,
  createAiGatewayMessageProjector,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { USAGE_POLICY_DROP } from '../../src/core/usage-policy/index.js'

/**
 * @import { AiGatewayExchangeInput, AiGatewayExchangeProjectorContext, AiGatewayProjectedExchange } from '../../collectivus-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../src/core/cache/types.js'
 * @import { UsagePolicyDrop } from '../../src/core/usage-policy/types.js'
 */

const EXPECTED_COLUMNS = [
  ['gateway_id', 'STRING', false],
  ['schema_version', 'INT32', false],
  ['session_id', 'STRING', false],
  ['conversation_id', 'STRING', true],
  ['user_id', 'STRING', true],
  ['provider', 'STRING', false],
  ['model', 'STRING', true],
  ['system_text', 'STRING', true],
  ['tools', 'JSON', true],
  ['conversation_started_at', 'TIMESTAMP', false],
  ['conversation_source', 'STRING', true],
  ['client_name', 'STRING', true],
  ['cwd', 'STRING', true],
  ['git_branch', 'STRING', true],
  ['git_remote', 'STRING', true],
  ['head_sha', 'STRING', true],
  ['repo_root', 'STRING', true],
  ['client_version', 'STRING', true],
  ['entrypoint', 'STRING', true],
  ['user_type', 'STRING', true],
  ['permission_mode', 'STRING', true],
  ['is_sidechain', 'BOOLEAN', true],
  ['agent_id', 'STRING', true],
  ['parent_thread_id', 'STRING', true],
  ['message_id', 'STRING', false],
  ['previous_message_id', 'JSON', true],
  ['provider_uuid', 'STRING', true],
  ['parent_uuid', 'STRING', true],
  ['logical_parent_uuid', 'STRING', true],
  ['source_tool_assistant_uuid', 'STRING', true],
  ['request_id', 'STRING', true],
  ['prompt_id', 'STRING', true],
  ['message_index', 'INT32', false],
  ['message_created_at', 'TIMESTAMP', false],
  ['role', 'STRING', false],
  ['part_id', 'STRING', false],
  ['part_index', 'INT32', false],
  ['part_type', 'STRING', false],
  ['provider_type', 'STRING', true],
  ['provider_subtype', 'STRING', true],
  ['content_text', 'STRING', true],
  ['tool_name', 'STRING', true],
  ['tool_call_id', 'STRING', true],
  ['tool_args', 'JSON', true],
  ['caller_type', 'STRING', true],
  ['tool_result_for', 'STRING', true],
  ['thinking_signature', 'STRING', true],
  ['attachment_type', 'STRING', true],
  ['hook_event', 'STRING', true],
  ['is_error', 'BOOLEAN', true],
  ['is_compact_summary', 'BOOLEAN', true],
  ['compact_metadata', 'JSON', true],
  ['status', 'JSON', true],
  ['attributes', 'JSON', true],
  ['raw_frame', 'JSON', true],
  ['date', 'STRING', false],
]

test('ai_gateway_messages schema exposes the gateway message columns', () => {
  assert.deepEqual(
    AI_GATEWAY_SCHEMA_COLUMNS.map((column) => [column.name, column.type, column.nullable]),
    EXPECTED_COLUMNS,
  )
})

test('projectExchange returns zero rows when no projector is registered', async () => {
  const projector = createAiGatewayMessageProjector({ gatewayId: 'gw-test', projectors: [] })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 0)
})

test('projectExchange returns zero rows when no projector matches', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('never', { match: () => false, project: () => undefined })],
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 0)
})

test('first successful projector wins, sorted by descending priority then registration order', async () => {
  /** @type {string[]} */
  const calls = []
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('low', {
        priority: 0,
        project: () => {
          calls.push('low')
          return projection('low')
        },
      }),
      registered('high', {
        priority: 5,
        project: () => {
          calls.push('high')
          return projection('high')
        },
      }),
      registered('higher-but-late', {
        priority: 5,
        project: () => {
          calls.push('higher-but-late')
          return projection('higher-but-late')
        },
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.deepEqual(calls, ['high'])
  assert.ok(rows.length > 0)
  assert.equal(rows[0].provider, 'high')
})

test('throwing projectors are skipped and the next matching projector wins', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('boom', {
        priority: 10,
        project: () => { throw new Error('boom') },
      }),
      registered('ok', {
        priority: 5,
        project: () => projection('ok'),
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.ok(rows.length > 0)
  assert.equal(rows[0].provider, 'ok')
})

test('projector returning undefined or an empty messages array is skipped', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('undefined', { priority: 20, project: () => undefined }),
      registered('empty', { priority: 10, project: () => ({ provider: 'empty', session_id: 's', conversation_id: 'c', messages: [] }) }),
      registered('ok', { priority: 5, project: () => projection('ok') }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.ok(rows.length > 0)
  assert.equal(rows[0].provider, 'ok')
})

test('a usage-policy drop is terminal: dispatch stops, writes no row, and is logged as a drop (not no_projector_match)', async () => {
  // @ref LLP 0050 [tests]: an intentional `.hypignore` drop returns the
  // USAGE_POLICY_DROP sentinel. It must STOP the projector walk (no later
  // matching projector may record the suppressed exchange), write zero rows,
  // and be logged as a drop rather than a `no_projector_match` miss.
  /** @type {Array<{ level: string, message: string, fields: Record<string, unknown> }>} */
  const logs = []
  const log = collectingLogger(logs)
  let secondConsulted = 0
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      // Higher priority: the .hypignore-governed adapter drops the exchange.
      registered('drop', { priority: 20, project: () => USAGE_POLICY_DROP }),
      // Lower priority but ALSO matching. A spy: it must never be consulted, or
      // it could record the very exchange the user asked to suppress.
      registered('would-record', {
        priority: 10,
        project: () => { secondConsulted++; return projection('would-record') },
      }),
    ],
    log,
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 0, 'a usage-policy drop writes no row')
  assert.equal(secondConsulted, 0, 'a terminal drop must NOT fall through to a second matching projector')
  assert.ok(
    !logs.some((entry) => entry.fields?.reason === 'no_projector_match'),
    'a privacy drop must not be logged as a no_projector_match miss',
  )
  assert.ok(
    logs.some((entry) => entry.message === 'aigw.usage_policy_drop' && entry.fields?.reason === 'usage_policy_drop'),
    'a drop is logged with the usage_policy_drop reason',
  )
})

test('a bare undefined decline still falls through to the next matching projector (only the drop sentinel is terminal)', async () => {
  // Guardrail: the terminal contract applies ONLY to the drop sentinel. A
  // projector that genuinely declines with bare `undefined` must still let the
  // next matching projector win, and a normal exchange still projects.
  let secondConsulted = 0
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('declines', { priority: 20, project: () => undefined }),
      registered('records', {
        priority: 10,
        project: () => { secondConsulted++; return projection('records') },
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(secondConsulted, 1, 'a declining projector must still let the next matching one be consulted')
  assert.ok(rows.length > 0, 'a normal exchange still projects rows')
  assert.equal(rows[0].provider, 'records')
})

test('projector returning an invalid shape is skipped and the next one is tried', async () => {
  /** @type {Array<{ level: string, message: string, fields: Record<string, unknown> }>} */
  const logs = []
  const log = collectingLogger(logs)
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('bad-shape', {
        priority: 20,
        project: () => /** @type {any} */ ({ provider: '', conversation_id: 'c', messages: [] }),
      }),
      registered('ok', { priority: 5, project: () => projection('ok') }),
    ],
    log,
  })
  const rows = await projector.projectExchange(exchange())
  assert.ok(rows.length > 0)
  assert.equal(rows[0].provider, 'ok')
  assert.ok(
    logs.some((entry) => entry.level === 'warn' && entry.message === 'aigw.projector_invalid_output'),
    'invalid-output projector should produce an aigw.projector_invalid_output warn',
  )
})

test('all projectors failing returns zero rows and warns once per failure', async () => {
  /** @type {Array<{ level: string, message: string, fields: Record<string, unknown> }>} */
  const logs = []
  const log = collectingLogger(logs)
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('throws', { priority: 30, project: () => { throw new Error('boom') } }),
      registered('returns-invalid', {
        priority: 20,
        project: () => /** @type {any} */ ({ not: 'a projection' }),
      }),
      registered('returns-undefined', { priority: 10, project: () => undefined }),
    ],
    log,
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 0, 'no rows when every projector fails')
  const warnings = logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message)
  assert.ok(warnings.includes('aigw.projector_error'), 'throwing projector logs aigw.projector_error')
  assert.ok(warnings.includes('aigw.projector_invalid_output'), 'invalid-shape projector logs aigw.projector_invalid_output')
  assert.ok(
    warnings.includes('aigw.message_projection_skipped'),
    'dispatcher logs aigw.message_projection_skipped when no projector succeeds',
  )
})

test('skipping a non-matching projector does not call its project()', async () => {
  let projectCalls = 0
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('mismatch', {
        priority: 50,
        match: () => false,
        project: () => { projectCalls++; return projection('mismatch') },
      }),
      registered('ok', { priority: 5, project: () => projection('ok') }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.ok(rows.length > 0)
  assert.equal(rows[0].provider, 'ok')
  assert.equal(projectCalls, 0)
})

test('projector-supplied message_id and previous_message_id are preserved', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('native', {
        project: () => ({
          provider: 'native',
          session_id: 'sess-1',
          conversation_id: 'conv-1',
          messages: [
            { role: 'user', content: 'hi', message_id: 'msg-root', previous_message_id: [] },
            { role: 'assistant', content: 'ok', message_id: 'msg-2', previous_message_id: ['msg-root'] },
          ],
        }),
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 2)
  assert.equal(rows[0].message_id, 'msg-root')
  assert.deepEqual(rows[0].previous_message_id, [])
  assert.equal(rows[1].message_id, 'msg-2')
  assert.deepEqual(rows[1].previous_message_id, ['msg-root'])
  assert.equal(
    isPlainObject(rows[0].attributes) && isPlainObject(rows[0].attributes.gateway)
      ? rows[0].attributes.gateway.identity_source
      : undefined,
    undefined,
    'identity_source must NOT be stamped when the projector supplied a message_id'
  )
})

test('supplied message_id without history gets the immediate predecessor as previous_message_id', async () => {
  // Adapter projectors (Claude transcripts, Codex native ids) supply
  // message_id but never previous_message_id. The gateway fills the
  // immediate predecessor (0/1-element) so enriched rows match fallback
  // rows. Full ancestry is the transitive closure of these links.
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('native-no-history', {
        project: () => ({
          provider: 'native',
          session_id: 'sess-native',
          conversation_id: 'conv-native',
          messages: [
            { role: 'user', content: 'one', message_id: 'uuid-1' },
            { role: 'assistant', content: 'two', message_id: 'uuid-2' },
            { role: 'user', content: 'three', message_id: 'uuid-3' },
          ],
        }),
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0].previous_message_id, [])
  assert.deepEqual(rows[1].previous_message_id, ['uuid-1'])
  assert.deepEqual(rows[2].previous_message_id, ['uuid-2'])
  for (const row of rows) {
    assert.equal(
      isPlainObject(row.attributes) && isPlainObject(row.attributes.gateway)
        ? row.attributes.gateway.identity_source
        : undefined,
      undefined,
      'supplied ids must not be marked as fallback'
    )
  }
})

test('fallback identity stamps gateway.identity_source and a linear previous_message_id chain', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('partial', {
        project: () => ({
          provider: 'partial',
          session_id: 'sess-fallback',
          conversation_id: 'conv-fallback',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
          ],
        }),
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => typeof row.message_id === 'string' && row.message_id.length > 0))
  assert.deepEqual(rows[0].previous_message_id, [])
  assert.deepEqual(rows[1].previous_message_id, [rows[0].message_id])
  for (const row of rows) {
    assert.equal(
      isPlainObject(row.attributes) && isPlainObject(row.attributes.gateway)
        ? row.attributes.gateway.identity_source
        : undefined,
      'gateway_fallback',
      'fallback rows must mark attributes.gateway.identity_source'
    )
  }
})

test('fallback message_id ignores cache_control so identity is stable across replays', () => {
  const blocks = [
    { type: 'text', text: 'reminder' },
    { type: 'text', text: 'the actual prompt' },
  ]
  const withBreakpoint = [
    blocks[0],
    { ...blocks[1], cache_control: { type: 'ephemeral' } },
  ]
  const plain = computeMessageId('conv-1', 'user', blocks)
  assert.equal(
    computeMessageId('conv-1', 'user', withBreakpoint),
    plain,
    'moving the prompt-cache breakpoint must not change the fallback message_id'
  )
  // Real content changes still change identity.
  assert.notEqual(
    computeMessageId('conv-1', 'user', [blocks[0], { type: 'text', text: 'different prompt' }]),
    plain
  )
})

test('fallback message_id is scoped by agent_id so subagents do not collide on shared content', () => {
  const content = [{ type: 'text', text: 'ok' }]
  const mainLoop = computeMessageId('sess-1', 'assistant', content)
  const agentA = computeMessageId('sess-1', 'assistant', content, 'agent-a')
  const agentB = computeMessageId('sess-1', 'assistant', content, 'agent-b')
  // Same session, identical content, different agents → distinct ids.
  assert.notEqual(agentA, agentB)
  assert.notEqual(agentA, mainLoop)
  // Absent agent_id is unchanged from the pre-agent hash (no migration
  // for main-loop / Codex rows).
  assert.equal(computeMessageId('sess-1', 'assistant', content, undefined), mainLoop)
})

test('previous_message_id chains are scoped per (conversation_id ?? session_id, agent_id)', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('threaded', {
        project: () => ({
          provider: 'p',
          // Claude shape: conversation_id null, so the scope falls back
          // to session_id; a subagent (agent_id) still gets a fresh chain.
          session_id: 'sess-1',
          messages: [
            // main loop
            { role: 'user', content: 'main one' },
            { role: 'assistant', content: 'main two' },
            // subagent thread (agent_id set on the message)
            { role: 'user', content: 'agent one', agent_id: 'agent-x' },
            { role: 'assistant', content: 'agent two', agent_id: 'agent-x' },
          ],
        }),
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  const byContent = (text) => rows.find((r) => r.content_text === text)
  const mainOne = byContent('main one')
  const mainTwo = byContent('main two')
  const agentOne = byContent('agent one')
  const agentTwo = byContent('agent two')
  assert.ok(mainOne && mainTwo && agentOne && agentTwo, 'all four messages should be projected')

  // Main-loop second message chains only on the main-loop first.
  assert.deepEqual(mainTwo.previous_message_id, [mainOne.message_id])
  // Subagent's first message starts a FRESH chain. It must not include
  // the main-loop ids.
  assert.deepEqual(agentOne.previous_message_id, [])
  // Subagent's second chains only on the subagent's first.
  assert.deepEqual(agentTwo.previous_message_id, [agentOne.message_id])
})

test('session_id is the partition key; conversation_id is null for Claude, the thread for Codex', async () => {
  // Claude shape: session_id set, conversation_id absent → null column.
  const claude = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('claude', {
      project: () => ({ provider: 'anthropic', session_id: 'sess-claude', messages: [{ role: 'user', content: 'hi' }] }),
    })],
  })
  const claudeRows = await claude.projectExchange(exchange())
  assert.ok(claudeRows.length > 0)
  assert.equal(claudeRows[0].session_id, 'sess-claude')
  assert.equal(claudeRows[0].conversation_id, undefined, 'Claude rows carry a null conversation_id')

  // Codex shape: both set (session_id = session container, conversation_id = thread).
  const codex = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('codex', {
      project: () => ({ provider: 'chatgpt', session_id: 'sess-codex', conversation_id: 'thread-codex', messages: [{ role: 'user', content: 'go' }] }),
    })],
  })
  const codexRows = await codex.projectExchange(exchange())
  assert.ok(codexRows.length > 0)
  assert.equal(codexRows[0].session_id, 'sess-codex')
  assert.equal(codexRows[0].conversation_id, 'thread-codex')
})

test('a projection without session_id is rejected as an invalid shape', async () => {
  /** @type {Array<{ level: string, message: string, fields: Record<string, unknown> }>} */
  const logs = []
  const log = collectingLogger(logs)
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('no-session', {
        priority: 20,
        project: () => /** @type {any} */ ({ provider: 'p', conversation_id: 'c', messages: [{ role: 'user', content: 'x' }] }),
      }),
      registered('ok', { priority: 5, project: () => projection('ok') }),
    ],
    log,
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows[0].provider, 'ok', 'the session_id-less projection is skipped, next one wins')
  assert.ok(logs.some((e) => e.level === 'warn' && e.message === 'aigw.projector_invalid_output'))
})

test('attributes.gateway carries exchange provenance and dev_run_id', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-fixed',
    projectors: [registered('any', { project: () => projection('any') })],
  })
  const rows = await projector.projectExchange(exchange())
  assert.ok(rows.length > 0)
  const attrs = rows[0].attributes
  assert.ok(isPlainObject(attrs))
  assert.equal(attrs.dev_run_id, 'run-1')
  const gateway = isPlainObject(attrs.gateway) ? attrs.gateway : undefined
  assert.ok(gateway)
  assert.equal(gateway.exchange_id, 'ex-1')
  assert.equal(gateway.upstream, 'echo')
  assert.equal(gateway.path, '/v1/echo')
  assert.equal(gateway.status_code, 200)
  assert.equal(gateway.is_sse, false)
  assert.equal(rows[0].gateway_id, 'gw-fixed')
})

test('row output is stripped to the schema (no extra fields leak)', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('any', { project: () => projection('any') })],
  })
  const rows = await projector.projectExchange(exchange())
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      assert.ok(
        AI_GATEWAY_SCHEMA_COLUMNS.some((col) => col.name === key),
        `unexpected row key not in schema: ${key}`
      )
    }
  }
})

test('a multi-block usage-bearing message stamps usage on only the last part', () => {
  // @ref LLP 0035#one-carrier: Claude backfill emits multi-block carrier
  // messages (e.g. reasoning + parallel tool_use under one messageId). Usage is
  // per-response, so it must ride exactly one row (the last block), not every
  // block, or a plain SUM(attributes.usage.*) over-counts within the message.
  const rows = aiGatewayRowsFromProjectedExchange({
    provider: 'anthropic',
    session_id: 'sess-usage',
    messages: [
      {
        role: 'assistant',
        message_id: 'msg-multiblock',
        attributes: { usage: { input_tokens: 100, output_tokens: 42, cache_read_tokens: 9 } },
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'tool_use', id: 'call-a', name: 'Bash', input: {} },
          { type: 'tool_use', id: 'call-b', name: 'Bash', input: {} },
        ],
      },
    ],
  }, { gatewayId: 'gw', state: createAiGatewayConversationState() })

  assert.equal(rows.length, 3)
  const usageRows = rows.filter((r) => isPlainObject(r.attributes) && r.attributes.usage !== undefined)
  assert.equal(usageRows.length, 1, 'exactly one row carries usage')
  // The carrier is the last block (highest part_index), where stop_reason rides too.
  const carrier = usageRows[0]
  assert.equal(carrier.part_index, 2)
  assert.equal(carrier.part_type, 'tool_call')
  const usage = isPlainObject(carrier.attributes) ? carrier.attributes.usage : undefined
  assert.deepEqual(usage, { input_tokens: 100, output_tokens: 42, cache_read_tokens: 9 })
  // A plain SUM over the message's rows equals the single response's usage.
  // No per-block over-count.
  const summedOutput = rows.reduce((acc, r) => {
    const u = isPlainObject(r.attributes) ? r.attributes.usage : undefined
    return acc + (isPlainObject(u) && typeof u.output_tokens === 'number' ? u.output_tokens : 0)
  }, 0)
  assert.equal(summedOutput, 42)
})

test('two Codex threads sharing a session_id keep separate start time and tool lookup', () => {
  // A Codex session_id can carry several thread conversation_ids. Per-thread
  // state (conversation_started_at, tool_call→tool_name) must scope by the
  // thread (conversation_id), not the session, or a later thread inherits the
  // first thread's start time and cross-resolves tool-result names when
  // tool_call ids collide. Drive both threads through ONE shared state, as
  // live capture does. @ref LLP 0030#decision
  const state = createAiGatewayConversationState()

  const rowsT1 = aiGatewayRowsFromProjectedExchange({
    provider: 'openai',
    session_id: 'sess-shared',
    conversation_id: 'thread-1',
    conversation_started_at: '2026-06-01T00:00:00.000Z',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-x', name: 'read_file', input: {} }] },
    ],
  }, { gatewayId: 'gw', state })

  const rowsT2 = aiGatewayRowsFromProjectedExchange({
    provider: 'openai',
    session_id: 'sess-shared',
    conversation_id: 'thread-2',
    conversation_started_at: '2026-06-02T00:00:00.000Z',
    // Same tool_call id as thread-1, but thread-2 never issued that tool_use.
    messages: [
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'call-x', content: 'body' }] },
    ],
  }, { gatewayId: 'gw', state })

  assert.equal(rowsT1[0].conversation_started_at, '2026-06-01T00:00:00.000Z')
  // Thread-2 keeps its OWN start time. It does not inherit thread-1's.
  assert.equal(rowsT2[0].conversation_started_at, '2026-06-02T00:00:00.000Z')
  assert.equal(rowsT2[0].session_id, 'sess-shared')
  assert.equal(rowsT2[0].conversation_id, 'thread-2')
  // The colliding tool_call id must NOT resolve to thread-1's 'read_file':
  // thread-2 has its own (empty) tool lookup.
  assert.equal(rowsT2[0].tool_name ?? null, null, 'no cross-thread tool-name resolution on a colliding tool_call id')
})

test('per-message model wins over the exchange model; absent it falls back to the exchange model', () => {
  // The projector resolves model as `message.model ?? projection.model`. Drive
  // an exchange whose exchange-level model DIFFERS from a message's own model,
  // so the assertion fails if the operands were ever reversed. @ref LLP 0026#consequences
  const rows = aiGatewayRowsFromProjectedExchange({
    provider: 'anthropic',
    session_id: 'sess-model-precedence',
    model: 'exchange-model',
    messages: [
      // Per-message model present -> WINS over the exchange model.
      { role: 'assistant', content: [{ type: 'text', text: 'switched' }], model: 'msg-model', message_id: 'uuid-1' },
      // No per-message model -> FALLS BACK to the exchange model (the live-capture path).
      { role: 'assistant', content: [{ type: 'text', text: 'default' }], message_id: 'uuid-2' },
    ],
  }, { gatewayId: 'gw' })

  /** @param {string} text */
  const byText = (text) => {
    const row = rows.find((r) => r.content_text === text)
    assert.ok(row, `row for "${text}" present`)
    return row
  }
  assert.equal(byText('switched').model, 'msg-model', 'per-message model wins over the exchange model')
  assert.equal(byText('default').model, 'exchange-model', 'absent per-message model falls back to the exchange model')
})

test('restart replay: seeds seen-set from committed part_ids so prior history re-emits zero rows', async () => {
  // Simulate the pre-restart listener committing a session's rows,
  // then a fresh post-restart listener replaying the SAME history through
  // a stub storage that reports those rows as committed. With the seen-set
  // seeded from committed message_ids, the replay must emit zero rows.
  // Seeding scopes on session_id: the partition key (LLP 0030).
  const project = () => ({
    provider: 'native',
    session_id: 'sess-restart',
    messages: [
      { role: 'user', content: 'one', message_id: 'uuid-1' },
      { role: 'assistant', content: 'two', message_id: 'uuid-2' },
    ],
  })

  // First listener (no storage): captures and emits the rows fresh.
  const first = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('native', { project })],
  })
  const committed = await first.projectExchange(exchange())
  assert.equal(committed.length, 2, 'first capture writes both messages')

  // Restart: a brand-new projector with storage reporting the committed rows.
  const storage = stubStorage([
    { partition: { session_id: 'sess-restart' }, rows: committed },
  ])
  const restarted = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('native', { project })],
    storage,
  })
  const replayed = await restarted.projectExchange(exchange())
  assert.equal(replayed.length, 0, 'replay of already-committed history emits no duplicate rows')
})

test('restart replay: seeding scans each session lazily and at most once per listener', async () => {
  const project = () => ({
    provider: 'native',
    session_id: 'sess-lazy',
    messages: [{ role: 'user', content: 'one', message_id: 'uuid-1' }],
  })
  let scanCalls = 0
  const storage = stubStorage(
    [{ partition: { session_id: 'sess-lazy' }, rows: [{ message_id: 'uuid-1', session_id: 'sess-lazy' }] }],
    () => { scanCalls++ },
  )
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('native', { project })],
    storage,
  })
  await projector.projectExchange(exchange())
  await projector.projectExchange(exchange())
  await projector.projectExchange(exchange())
  assert.equal(scanCalls, 1, 'a session is scanned for committed part_ids at most once per listener')
})

test('restart replay: concurrent first exchanges for one session seed once and emit no duplicates', async () => {
  // The proxy fires onExchangeFinished without serializing, so two first
  // exchanges for the same session can be in flight at once. Both must
  // await the same committed-row scan before projecting; otherwise the
  // second races past a still-empty seen-set and re-emits committed rows.
  const project = () => ({
    provider: 'native',
    session_id: 'sess-concurrent',
    messages: [
      { role: 'user', content: 'one', message_id: 'uuid-1' },
      { role: 'assistant', content: 'two', message_id: 'uuid-2' },
    ],
  })
  let scanCalls = 0
  // The scan awaits discoverCachePartitions, so the seen-set is still empty
  // when control yields. A per-session "seeded" flag set before that
  // await would let the second caller through unseeded; awaiting the shared
  // seed promise does not.
  const storage = stubStorage(
    [{
      partition: { session_id: 'sess-concurrent' },
      rows: [
        { message_id: 'uuid-1', session_id: 'sess-concurrent' },
        { message_id: 'uuid-2', session_id: 'sess-concurrent' },
      ],
    }],
    () => { scanCalls++ },
  )
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('native', { project })],
    storage,
  })
  const [a, b] = await Promise.all([
    projector.projectExchange(exchange()),
    projector.projectExchange(exchange()),
  ])
  assert.equal(scanCalls, 1, 'concurrent first exchanges share a single committed-row scan')
  assert.equal(a.length + b.length, 0, 'both concurrent replays emit zero duplicate rows')
})

test('restart replay: a different session is not deduped against another session rows', async () => {
  const storage = stubStorage([
    { partition: { session_id: 'sess-A' }, rows: [{ message_id: 'uuid-A', session_id: 'sess-A' }] },
  ])
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('native', {
        project: () => ({
          provider: 'native',
          session_id: 'sess-B',
          messages: [{ role: 'user', content: 'fresh', message_id: 'uuid-B' }],
        }),
      }),
    ],
    storage,
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 1, 'sess-B is fresh; sess-A committed rows must not suppress it')
  assert.equal(rows[0].message_id, 'uuid-B')
})

test('restart replay: with no storage, behavior is unchanged (committed history is not seeded)', async () => {
  // Without a storage handle the projector cannot seed, so a replay re-emits
  // rows exactly as the pre-fix behavior did within one listener lifetime.
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('native', {
        project: () => ({
          provider: 'native',
          session_id: 'sess-nostorage',
          messages: [{ role: 'user', content: 'one', message_id: 'uuid-1' }],
        }),
      }),
    ],
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 1, 'with no storage the first projection still emits its rows')
})

test('restart replay: a throwing storage degrades to not-seeded and never drops rows', async () => {
  const storage = /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
    discoverCachePartitions() { throw new Error('boom') },
    async *readRows() {},
  }))
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('native', {
        project: () => ({
          provider: 'native',
          session_id: 'sess-throw',
          messages: [{ role: 'user', content: 'one', message_id: 'uuid-1' }],
        }),
      }),
    ],
    storage,
  })
  const rows = await projector.projectExchange(exchange())
  assert.equal(rows.length, 1, 'a seeding failure must never throw and never drop a row')
})

/**
 * Minimal `ExtendedQueryStorageService`-shaped stub exposing only the
 * committed-partition read surface the projector feature-detects:
 * `discoverCachePartitions` + `readRows`.
 *
 * @param {Array<{ partition: Record<string, string>, rows: Record<string, unknown>[] }>} parts
 * @param {() => void} [onScan]
 */
function stubStorage(parts, onScan) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byPath = new Map()
  const partitions = parts.map((part, index) => {
    const path = `/cache/part-${index}`
    byPath.set(path, part.rows)
    return { dataset: 'ai_gateway_messages', partition: part.partition, path, epoch: 0, rowCount: part.rows.length }
  })
  // Only the committed-read surface the projector feature-detects is real;
  // cast to the full service type so the call site typechecks.
  return /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      onScan?.()
      return partitions
    },
    /** @param {string} tablePath @param {string[]=} columns */
    async *readRows(tablePath, columns) {
      const rows = byPath.get(tablePath) ?? []
      for (const row of rows) {
        if (!columns) { yield row; continue }
        /** @type {Record<string, unknown>} */
        const projected = {}
        for (const column of columns) projected[column] = row[column]
        yield projected
      }
    },
  }))
}

/**
 * @param {string} provider
 */
function projection(provider) {
  return {
    provider,
    session_id: `${provider}-sess`,
    conversation_id: `${provider}-conv`,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'ok' },
    ],
  }
}

/**
 * @param {string} name
 * @param {{
 *   priority?: number,
 *   match?: (input: AiGatewayExchangeInput) => boolean,
 *   project: (input: AiGatewayExchangeInput, ctx: AiGatewayExchangeProjectorContext) => AiGatewayProjectedExchange | UsagePolicyDrop | Promise<AiGatewayProjectedExchange | UsagePolicyDrop | undefined> | undefined,
 * }} body
 */
function registered(name, body) {
  return {
    name,
    priority: body.priority,
    match: body.match ?? (() => true),
    project: body.project,
    _seq: 0,
  }
}

function exchange(overrides = {}) {
  return {
    exchange_id: 'ex-1',
    ts_start: '2026-05-20T10:00:00.000Z',
    ts_end: '2026-05-20T10:00:00.250Z',
    duration_ms: 250,
    upstream: 'echo',
    provider: null,
    method: 'POST',
    path: '/v1/echo',
    status_code: 200,
    request_bytes: 10,
    response_bytes: 20,
    is_sse: false,
    stream_event_count: 0,
    request_headers: JSON.stringify({ 'x-hyp-dev-run-id': 'run-1' }),
    request_body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    response_headers: JSON.stringify({ 'content-type': 'application/json' }),
    response_body: JSON.stringify({ role: 'assistant', content: 'ok' }),
    error: null,
    metadata: JSON.stringify({ dev_run_id: 'run-1' }),
    stream_events: [],
    ...overrides,
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {Array<{ level: string, message: string, fields: Record<string, unknown> }>} sink
 */
function collectingLogger(sink) {
  /** @param {string} level */
  const make = (level) => (
    /** @type {string} */ message,
    /** @type {Record<string, unknown>=} */ fields,
  ) => {
    sink.push({ level, message, fields: fields ?? {} })
  }
  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
  }
}

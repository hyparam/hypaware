// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { AI_GATEWAY_SCHEMA_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import {
  aiGatewayRowsFromProjectedExchange,
  computeMessageId,
  createAiGatewayConversationState,
  createAiGatewayMessageProjector,
  rollbackAiGatewayStateJournal,
  SESSION_INDEX_REBUILD_MS,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { USAGE_POLICY_DROP } from '../../src/core/usage-policy/index.js'

/**
 * @import { AiGatewayExchangeInput, AiGatewayExchangeProjectorContext, AiGatewayProjectedExchange } from '../../hypaware-plugin-kernel-types.js'
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

test('dispatcher threads a working isSessionIgnored predicate into the projector ctx', async () => {
  // @ref LLP 0066#enforcement [tests]: the gateway hands the adapter a
  // read-only membership test against its ignored-session set; the adapter
  // (not the gateway) does the drop. Here we only assert the predicate reaches
  // the projector ctx and answers correctly.
  /** @type {((sessionId: string) => boolean) | undefined} */
  let received
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    isSessionIgnored: (id) => id === 'ignored-sess',
    projectors: [registered('capture', {
      project: (_input, ctx) => {
        received = ctx.isSessionIgnored
        return projection('capture')
      },
    })],
  })
  await projector.projectExchange(exchange())
  assert.ok(received, 'ctx.isSessionIgnored is provided to the projector')
  assert.equal(received('ignored-sess'), true)
  assert.equal(received('other-sess'), false)
})

test('projector ctx defaults isSessionIgnored to a false predicate when none is supplied', async () => {
  // Absent an isSessionIgnored (backfill materialization, unit-test stubs) the
  // ctx still carries a predicate, and it always answers false, so existing
  // behavior is unchanged.
  /** @type {((sessionId: string) => boolean) | undefined} */
  let received
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('capture', {
      project: (_input, ctx) => {
        received = ctx.isSessionIgnored
        return projection('capture')
      },
    })],
  })
  await projector.projectExchange(exchange())
  assert.ok(received, 'ctx still carries a predicate when none was supplied')
  assert.equal(received('anything'), false)
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
  const afterFirst = scanCalls
  // First projection pays for the shared committed-session index build plus
  // this session's own committed-row scan; nothing after it re-scans.
  assert.equal(afterFirst, 2, 'first projection builds the session index and scans the session once')
  await projector.projectExchange(exchange())
  await projector.projectExchange(exchange())
  assert.equal(scanCalls, afterFirst, 'later exchanges for the session trigger no further scans')
})

test('seeding: sessions with no committed rows share one index build and skip the per-session scan', async () => {
  // Autonomous clients mint fresh session ids constantly; before the index,
  // EVERY new session paid a whole-table scan that found nothing. Now the
  // first projection builds one session index, and every fresh session
  // resolves against it without touching row data again.
  let discoverCalls = 0
  let messageScanReads = 0
  const committed = [{ message_id: 'uuid-old', session_id: 'sess-old' }]
  const storage = /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      discoverCalls++
      return [{ dataset: 'ai_gateway_messages', partition: {}, path: '/p', epoch: 0, rowCount: committed.length }]
    },
    /** @param {string} tablePath @param {string[]=} columns */
    async *readRows(tablePath, columns) {
      if (columns?.includes('message_id')) messageScanReads++
      for (const row of committed) yield row
    },
  }))
  // One listener, two fresh sessions (a listener is per-daemon, sessions churn).
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('native', {
        project: (input) => ({
          provider: 'native',
          session_id: String(input.path),
          messages: [{ role: 'user', content: 'fresh', message_id: `uuid-${input.path}` }],
        }),
      }),
    ],
    storage,
  })
  const a = await projector.projectExchange({ ...exchange(), path: 'sess-new-1' })
  const b = await projector.projectExchange({ ...exchange(), path: 'sess-new-2' })
  assert.equal(a.length, 1, 'first fresh session emits its row')
  assert.equal(b.length, 1, 'second fresh session emits its row')
  assert.equal(discoverCalls, 1, 'both fresh sessions share a single index build')
  assert.equal(messageScanReads, 0, 'no fresh session pays the per-session committed-row scan')
})

function freshSessionIndexStorage() {
  let discoverCalls = 0
  const storage = /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      discoverCalls++
      return [{ dataset: 'ai_gateway_messages', partition: {}, path: '/p', epoch: 0, rowCount: 1 }]
    },
    /** @param {string} tablePath @param {string[]=} columns */
    async *readRows(tablePath, columns) {
      // The only committed session id in this table is one no test below
      // ever looks up, so every lookup is a genuine miss.
      yield { session_id: 'sess-committed-elsewhere', message_id: 'uuid-committed' }
    },
  }))
  return { storage, getDiscoverCalls: () => discoverCalls }
}

/**
 * @param {ReturnType<typeof freshSessionIndexStorage>['storage']} storage
 * @param {() => number} now
 * @param {ReturnType<typeof collectingLogger>} [log]
 */
function freshSessionProjector(storage, now, log) {
  return createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('native', {
        project: (input) => ({
          provider: 'native',
          session_id: String(input.path),
          messages: [{ role: 'user', content: 'fresh', message_id: `uuid-${input.path}` }],
        }),
      }),
    ],
    storage,
    now,
    log,
  })
}

test('committed-session index: a miss past the rebuild window triggers exactly one rebuild', async () => {
  // Previously untested branch: SESSION_INDEX_REBUILD_MS is hard-coded, so
  // exercising "stale, then rebuilt" requires an injectable clock.
  let clockMs = 0
  const now = () => clockMs
  const { storage, getDiscoverCalls } = freshSessionIndexStorage()
  const projector = freshSessionProjector(storage, now)

  await projector.projectExchange({ ...exchange(), path: 'sess-a' })
  assert.equal(getDiscoverCalls(), 1, 'first projection builds the index')

  await projector.projectExchange({ ...exchange(), path: 'sess-a2' })
  assert.equal(getDiscoverCalls(), 1, 'still inside the rebuild window: the stale-but-fresh index is trusted')

  clockMs = SESSION_INDEX_REBUILD_MS + 1
  await projector.projectExchange({ ...exchange(), path: 'sess-b' })
  assert.equal(getDiscoverCalls(), 2, 'past the rebuild window: a miss triggers exactly one rebuild')
})

test('committed-session index: N concurrent fresh-session misses past the rebuild window share one rebuild', async () => {
  // Finding: `current` was captured before an `await`, so every caller that
  // suspended on the stale index re-tested the stale `atMs` after resuming
  // and rebuilt again, even though another caller had already refreshed
  // `built`. This must observe exactly one rebuild for N concurrent misses,
  // not N. (Verified to fail against the pre-fix code: N=6 concurrent misses
  // produced 7 discoverCachePartitions calls instead of 2.)
  let clockMs = 0
  const now = () => clockMs
  const { storage, getDiscoverCalls } = freshSessionIndexStorage()
  const projector = freshSessionProjector(storage, now)

  // Warm the index once, inside the window.
  await projector.projectExchange({ ...exchange(), path: 'sess-warm' })
  assert.equal(getDiscoverCalls(), 1, 'warm-up projection builds the index once')

  // Move past the rebuild window, then fire N concurrent lookups for N
  // distinct fresh session ids (autonomous clients minting session ids).
  clockMs = SESSION_INDEX_REBUILD_MS + 1
  const N = 6
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => projector.projectExchange({ ...exchange(), path: `sess-fresh-${i}` }))
  )
  for (const rows of results) assert.equal(rows.length, 1, 'each concurrent fresh session still emits its own row')
  assert.equal(
    getDiscoverCalls(),
    2,
    `${N} concurrent misses past the rebuild window must share a single rebuild, not one each`
  )
})

test('committed-session index: a scan that throws degrades the index instead of wedging it', async () => {
  // Finding (#685): the index's stamp-and-self-clear handler runs on
  // FULFILLMENT only, so a scan that ever threw was never normalized. The
  // failed attempt stays published in `built` and never clears itself, so
  // every later caller re-awaits the same rejection: one throwing scan
  // wedges the index for the listener's life and loses EVERY subsequent
  // exchange, rather than degrading the way the rest of this best-effort
  // path does. (#689 later chained that handler onto the scan, which
  // incidentally gave the rejection an awaiter and closed the original
  // unhandled-rejection-kills-the-daemon shape; the assertion below keeps
  // that closed, since nothing structural holds the chaining in place.)
  //
  // Driven here by a storage whose FIRST `discoverCachePartitions` (the
  // index build) answers with a non-iterable, so the exception escapes
  // `scanCommittedSessionIds` from outside its try/catch. Later calls are
  // well-formed, so the per-session fallback scan is unaffected and the
  // "err toward scanning" degradation is observable on its own.
  /** @type {unknown[]} */
  const unhandled = []
  /** @param {unknown} reason */
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    let discoverCalls = 0
    const storage = /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
      async discoverCachePartitions() {
        discoverCalls++
        // Contract says CachePartitionMeta[]; a malformed answer makes the
        // `for (const part of partitions ?? [])` loop throw.
        if (discoverCalls === 1) return /** @type {never} */ ({ malformed: true })
        return [{ dataset: 'ai_gateway_messages', partition: {}, path: '/p', epoch: 0, rowCount: 1 }]
      },
      async *readRows() {
        yield { session_id: 'sess-committed-elsewhere', message_id: 'uuid-committed' }
      },
    }))
    /** @type {Array<{ level: string, message: string, fields: Record<string, unknown> }>} */
    const logged = []
    const projector = freshSessionProjector(storage, () => 0, collectingLogger(logged))

    const rows = await projector.projectExchange({ ...exchange(), path: 'sess-throwing-index' })

    // An index that cannot answer must not swallow the session: the
    // per-session scan runs and the row is still emitted.
    assert.equal(rows.length, 1, 'a failed index build errs toward scanning and still emits the row')
    assert.ok(discoverCalls >= 2, 'the failed index build falls back to the per-session committed-row scan')

    // The rejected attempt must not stay published: a second session on the
    // same listener rebuilds (the scan is well-formed by now) instead of
    // re-awaiting the rejection forever.
    const callsAfterFirst = discoverCalls
    const later = await projector.projectExchange({ ...exchange(), path: 'sess-after-throwing-index' })
    assert.equal(later.length, 1, 'the next exchange survives a scan that rejected earlier')
    assert.ok(discoverCalls > callsAfterFirst, 'the failed attempt clears itself, so the next miss rebuilds')

    // Surviving the rejection must not make it invisible: the daemon now
    // keeps running on a degraded index, so the log line is the only thing
    // that says so. `error_kind` distinguishes this (a broken "resolve,
    // never reject" contract, i.e. a defect) from `discover_failed`, the
    // I/O condition that reaches the same message and may clear itself.
    const scanWarns = logged.filter(
      (entry) => entry.level === 'warn' && entry.message === 'aigw.session_index_scan_failed'
    )
    assert.equal(scanWarns.length, 1, 'a rejecting scan warns exactly once, not once per failure branch')
    assert.equal(scanWarns[0].fields.error_kind, 'scan_rejected')
    assert.match(String(scanWarns[0].fields.error), /not iterable/)

    // Unhandled rejections are only detected once the microtask queue has
    // drained, so give the loop a turn before asserting there were none.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
      unhandled.map((reason) => (reason instanceof Error ? reason.message : String(reason))),
      [],
      'a throwing session-index scan must not produce an unhandled rejection'
    )
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('committed-session index: a scan slower than the rebuild window still serves cache hits', async () => {
  // Finding: `atMs` was stamped when the scan STARTED. A `session_id` scan
  // that itself outlives SESSION_INDEX_REBUILD_MS was therefore stale the
  // moment it resolved, so the very next miss rebuilt again: back-to-back
  // whole-table scans that never serve a single hit, on exactly the table
  // size that makes the index worth having. The window has to age the
  // ANSWER, so it runs from completion.
  let clockMs = 0
  const now = () => clockMs
  let discoverCalls = 0
  /** @type {() => void} */
  let releaseScan = () => {}
  const scanGate = new Promise((resolve) => {
    releaseScan = () => resolve(undefined)
  })
  const storage = /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      discoverCalls++
      // The scan is in flight across the whole rebuild window.
      await scanGate
      return [{ dataset: 'ai_gateway_messages', partition: {}, path: '/p', epoch: 0, rowCount: 1 }]
    },
    async *readRows() {
      yield { session_id: 'sess-committed-elsewhere', message_id: 'uuid-committed' }
    },
  }))
  const projector = freshSessionProjector(storage, now)

  const first = projector.projectExchange({ ...exchange(), path: 'sess-a' })
  // Let the build start, advance the clock past the window while its scan is
  // still running, and only then let the scan finish.
  await new Promise((resolve) => setImmediate(resolve))
  clockMs = SESSION_INDEX_REBUILD_MS + 1
  releaseScan()
  assert.equal((await first).length, 1, 'the session that triggered the slow build still emits its row')
  assert.equal(discoverCalls, 1, 'a scan slower than the window is not stale the moment it resolves')

  // A later miss, one millisecond after the scan resolved: comfortably
  // inside a window measured from completion.
  clockMs += 1
  const second = await projector.projectExchange({ ...exchange(), path: 'sess-b' })
  assert.equal(second.length, 1, 'the next fresh session still emits its row')
  assert.equal(discoverCalls, 1, 'the freshly-completed index serves a hit instead of rebuilding at once')
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
  // 2 = one shared session-index build + one shared per-session scan; the
  // point is that concurrent first exchanges never each run their own.
  assert.equal(scanCalls, 2, 'concurrent first exchanges share the index build and the committed-row scan')
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

test('committed-session index: a build that could not scan is not cached as "no committed rows"', async () => {
  // A failed index build is a distinct outcome from a successful empty scan.
  // When the two were conflated, the failure was cached as "this table has no
  // committed sessions" for the whole SESSION_INDEX_REBUILD_MS window, so every
  // session whose first exchange landed in that window skipped its seed scan
  // and re-emitted its committed rows on a restart replay. The test above
  // ('a throwing storage degrades to not-seeded') cannot see that: it only
  // asserts rows are never dropped, which holds either way.
  //
  // Here `discoverCachePartitions` throws on call 1 (the index build) and
  // succeeds afterwards, so both halves of the fallback are observable: the
  // failing build must fall through to the per-session scan, and the NEXT
  // session must rebuild the index rather than trust the failed one, which is
  // what lets its already-committed row be seeded and deduped.
  let discoverCalls = 0
  const committed = [{ message_id: 'uuid-sess-committed', session_id: 'sess-committed' }]
  const storage = /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      discoverCalls++
      if (discoverCalls === 1) throw new Error('boom')
      return [{ dataset: 'ai_gateway_messages', partition: {}, path: '/p', epoch: 0, rowCount: committed.length }]
    },
    async *readRows() {
      for (const row of committed) yield row
    },
  }))
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [
      registered('native', {
        project: (input) => ({
          provider: 'native',
          session_id: String(input.path),
          messages: [{ role: 'user', content: 'one', message_id: `uuid-${input.path}` }],
        }),
      }),
    ],
    storage,
  })

  const first = await projector.projectExchange({ ...exchange(), path: 'sess-fresh' })
  assert.equal(first.length, 1, 'a fresh session still emits its row when the index build fails')
  assert.equal(
    discoverCalls,
    2,
    'a failed index build must err toward the per-session scan (build + scan), not skip it'
  )

  // Same listener, same rebuild window, a session that DOES have a committed
  // row. Trusting the failed build would skip its seed and re-emit the row.
  const second = await projector.projectExchange({ ...exchange(), path: 'sess-committed' })
  assert.equal(second.length, 0, 'the committed row is seeded and deduped, not re-emitted as a duplicate')
  assert.equal(
    discoverCalls,
    4,
    'the failed build is retried (3) and the session seeds its committed rows (4)'
  )
})

test('seed failure: a storage that breaks its discover contract loses no rows and does not poison the session memo', async () => {
  // Finding (#692), two halves of one silent failure:
  //
  //  - `scanCommittedMessageIds` guards only the `discoverCachePartitions`
  //    CALL; the walk over the answer sits outside that try/catch, so a
  //    storage resolving a truthy NON-iterable (a violation of its own
  //    declared `CachePartitionMeta[]` return type) throws out of a
  //    function whose whole point is to degrade rather than cost a row.
  //  - `seedPromises` memoized that rejected promise and never removed it,
  //    so `projectExchange` rejected, `source.js` caught it and dropped the
  //    row, and EVERY later exchange for the session short-circuited onto
  //    the poisoned memo and was dropped with no warn at all. Measured in
  //    review: five exchanges, two warn lines, zero rows.
  //
  // So both properties are asserted per exchange: the row still lands, and
  // the failure keeps saying so instead of going quiet after the first.
  //
  // The index build (discover call 1) is kept WELL-FORMED on purpose. A
  // storage malformed on that call too rejects inside the committed-session
  // index, which is issue #685 / PR #690's separate defect; keeping it
  // well-formed isolates this one and keeps this test independent of that
  // fix.
  let discoverCalls = 0
  const storage = /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      discoverCalls++
      if (discoverCalls === 1) {
        return [{ dataset: 'ai_gateway_messages', partition: {}, path: '/p', epoch: 0, rowCount: 1 }]
      }
      return /** @type {never} */ ({ malformed: true })
    },
    async *readRows() {
      // The index must place this session among the committed ones, or the
      // per-session scan is skipped and the defect never fires.
      yield { session_id: 'sess-broken-seed', message_id: 'uuid-committed' }
    },
  }))
  /** @type {Array<{ level: string, message: string, fields: Record<string, unknown> }>} */
  const logged = []
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('native', { project: perExchangeMessage })],
    storage,
    log: collectingLogger(logged),
  })

  const first = await settledProjection(
    projector.projectExchange({ ...exchange(), exchange_id: 'ex-1', path: 'sess-broken-seed' })
  )
  assert.equal(
    first.error === undefined ? undefined : String(first.error),
    undefined,
    'exchange 1: a seed that could not run must not fail the projection'
  )
  assert.equal(first.rows?.length, 1, 'exchange 1: the row survives a seed that could not run')

  const second = await settledProjection(
    projector.projectExchange({ ...exchange(), exchange_id: 'ex-2', path: 'sess-broken-seed' })
  )
  assert.equal(
    second.error === undefined ? undefined : String(second.error),
    undefined,
    'exchange 2: a memoized failure must not fail every later exchange for the session'
  )
  assert.equal(second.rows?.length, 1, 'exchange 2: the session is not permanently poisoned')

  // 3 = one index build + one seed scan per exchange. Exchange 2 having
  // re-run its scan is the direct evidence that no failed memo survived it.
  assert.equal(discoverCalls, 3, 'a seed that broke is retried, not cached as this session verdict')

  // Silence was the other half of the defect: a daemon dropping every row
  // for a session while logging nothing is the failure operators could not
  // see. Each failing exchange must carry its own signal.
  const warns = logged.filter((e) => e.level === 'warn' && e.message === 'aigw.seed_seen_messages_failed')
  assert.equal(warns.length, 2, 'each exchange whose seed failed emits its own operator signal')
  for (const warn of warns) {
    assert.equal(warn.fields.error_kind, 'seed_rejected')
    assert.equal(warn.fields.session_id, 'sess-broken-seed')
    assert.match(String(warn.fields.error), /not iterable/)
  }
})

/**
 * A projector whose message_id is unique per exchange. Reusing one id
 * across exchanges would let the seen-set dedup (the very thing the seed
 * feeds) suppress the second row legitimately, hiding a drop under a zero.
 *
 * @param {AiGatewayExchangeInput} input
 * @returns {AiGatewayProjectedExchange}
 */
function perExchangeMessage(input) {
  return {
    provider: 'native',
    session_id: String(input.path),
    messages: [{ role: 'user', content: 'hi', message_id: `uuid-${input.exchange_id}` }],
  }
}

/**
 * Settle a projection without letting a rejection escape, so a test can
 * assert on "it rejected" as evidence instead of dying on it.
 *
 * @param {Promise<unknown[]>} projecting
 * @returns {Promise<{ rows: unknown[] | undefined, error: unknown }>}
 */
function settledProjection(projecting) {
  return projecting.then(
    (rows) => ({ rows, error: undefined }),
    (/** @type {unknown} */ error) => ({ rows: undefined, error })
  )
}

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

/**
 * The live projector's dedup state is per-listener and outlives every
 * exchange, and row expansion commits to it before the caller's
 * `appendRows` has had a chance to fail. `journal` + rollback is how a
 * caller keeps that state describing what landed. Issue #879.
 */
test('a journaled projection can be rolled back so the same exchange projects again', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('ok', { project: () => projection('ok') })],
  })
  /** @type {(() => void)[]} */
  const journal = []
  const first = await projector.projectExchange(exchange(), { journal })
  assert.ok(first.length > 0)

  // Stand-in for the append the caller could not complete.
  rollbackAiGatewayStateJournal(journal)
  assert.equal(journal.length, 0)

  const retry = await projector.projectExchange(exchange())
  assert.deepEqual(retry.map((r) => r.part_id), first.map((r) => r.part_id))
  assert.deepEqual(retry.map((r) => r.previous_message_id), first.map((r) => r.previous_message_id))
})

test('without a rollback a re-projected exchange still dedups to nothing', async () => {
  const projector = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [registered('ok', { project: () => projection('ok') })],
  })
  const first = await projector.projectExchange(exchange())
  assert.ok(first.length > 0)
  const again = await projector.projectExchange(exchange())
  assert.equal(again.length, 0)
})

/**
 * A journal is replayed by ONE exchange, but the state it rewinds belongs to
 * the whole listener and the proxy runs its finalizers concurrently. So a
 * rollback must not unwind the thread from under turns another exchange
 * already chained and wrote: those turns stay in `chain.seen`, nothing
 * re-chains them, and the tail would silently settle before them.
 */
test('a rollback does not rewind a thread past turns a later exchange chained', () => {
  const state = createAiGatewayConversationState()
  /** @param {string} id @param {string} role */
  const message = (id, role) => ({ role, content: `c-${id}`, message_id: id, provider_uuid: id })
  /** @param {string[]} ids */
  const turns = (ids) => ({
    provider: 'anthropic',
    session_id: 's1',
    conversation_id: 'c1',
    client_name: 'claude',
    conversation_source: 'claude_code',
    messages: ids.map((id) => message(id, id.startsWith('u') ? 'user' : 'assistant')),
  })

  // Exchange A projects the first turn and is still awaiting its append.
  /** @type {(() => void)[]} */
  const journalA = []
  const rowsA = aiGatewayRowsFromProjectedExchange(/** @type {any} */ (turns(['u1', 'a1'])), {
    state,
    journal: journalA,
  })
  assert.deepEqual(rowsA.map((r) => r.message_id), ['u1', 'a1'])

  // Exchange B replays those, chains the second turn, and lands.
  const rowsB = aiGatewayRowsFromProjectedExchange(/** @type {any} */ (turns(['u1', 'a1', 'u2', 'a2'])), {
    state,
    journal: [],
  })
  assert.deepEqual(rowsB.map((r) => r.message_id), ['u2', 'a2'])
  assert.deepEqual(rowsB[0].previous_message_id, ['a1'])

  // Only now does A's append fail.
  rollbackAiGatewayStateJournal(journalA)

  const rowsC = aiGatewayRowsFromProjectedExchange(
    /** @type {any} */ (turns(['u1', 'a1', 'u2', 'a2', 'u3'])),
    { state },
  )
  const u3 = rowsC.find((r) => r.message_id === 'u3')
  assert.ok(u3, 'the new turn projects')
  assert.deepEqual(u3.previous_message_id, ['a2'], 'the thread still runs through the turn B wrote')
})

test('a rollback of the newest exchange restores the thread tail exactly', () => {
  const state = createAiGatewayConversationState()
  /** @param {string[]} ids */
  const turns = (ids) => ({
    provider: 'anthropic',
    session_id: 's2',
    conversation_id: 'c2',
    client_name: 'claude',
    conversation_source: 'claude_code',
    messages: ids.map((id) => ({
      role: id.startsWith('u') ? 'user' : 'assistant',
      content: `c-${id}`,
      message_id: id,
      provider_uuid: id,
    })),
  })

  aiGatewayRowsFromProjectedExchange(/** @type {any} */ (turns(['u1', 'a1'])), { state })
  /** @type {(() => void)[]} */
  const journal = []
  const second = aiGatewayRowsFromProjectedExchange(
    /** @type {any} */ (turns(['u1', 'a1', 'u2', 'a2'])),
    { state, journal },
  )
  assert.deepEqual(second.map((r) => r.previous_message_id), [['a1'], ['u2']])

  rollbackAiGatewayStateJournal(journal)

  const retry = aiGatewayRowsFromProjectedExchange(
    /** @type {any} */ (turns(['u1', 'a1', 'u2', 'a2'])),
    { state },
  )
  assert.deepEqual(retry.map((r) => r.message_id), ['u2', 'a2'])
  assert.deepEqual(retry.map((r) => r.previous_message_id), [['a1'], ['u2']])
})

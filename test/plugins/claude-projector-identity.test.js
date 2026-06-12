// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createClaudeExchangeProjector } from '../../hypaware-core/plugins-workspace/claude/src/projector.js'

/**
 * End-to-end identity tests for the Claude exchange projector. Each
 * test wires the Claude projector through the gateway core's
 * dispatcher (with no other projector registered) so the assertions
 * cover the same path that runs in production — including the
 * gateway's fallback hash identity stamp.
 */

test('native DAG identity: uuid from JSONL transcript becomes message_id and provider_uuid', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-1', [
      jsonlRow({
        sessionId: 'sess-1',
        uuid: 'u-user-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-1',
        uuid: 'u-assistant-1',
        parentUuid: 'u-user-1',
        type: 'assistant',
        message: { role: 'assistant', id: 'msg_abc', content: [{ type: 'text', text: 'hi' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-1' }) },
        messages: [{ role: 'user', content: 'hello' }],
      },
      responseBody: { id: 'msg_abc', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' },
    })

    assert.equal(rows.length, 2)
    const userRows = rows.filter((r) => r.role === 'user')
    const assistantRows = rows.filter((r) => r.role === 'assistant')
    assert.equal(userRows.length, 1)
    assert.equal(assistantRows.length, 1)

    // Native identity: message_id == provider_uuid == transcript uuid.
    assert.equal(userRows[0].message_id, 'u-user-1')
    assert.equal(userRows[0].provider_uuid, 'u-user-1')
    assert.equal(assistantRows[0].message_id, 'u-assistant-1')
    assert.equal(assistantRows[0].provider_uuid, 'u-assistant-1')
    assert.equal(userRows[0].part_type, 'text')
    assert.equal(userRows[0].provider_type, 'user')
    assert.equal(assistantRows[0].part_type, 'text')
    assert.equal(assistantRows[0].provider_type, 'assistant')

    // previous_message_id is the gateway-filled full prior-message
    // chain (here a single prior message); the native DAG parent
    // rides parent_uuid.
    assert.deepEqual(assistantRows[0].previous_message_id, ['u-user-1'])
    assert.equal(assistantRows[0].parent_uuid, 'u-user-1')

    // Gateway must NOT stamp identity_source when the projector
    // supplied message_id — the assertion guards the projector against
    // a regression that drops `message_id` and silently falls back.
    for (const row of rows) {
      const claude = readAttrPath(row, ['attributes', 'claude'])
      const gateway = readAttrPath(row, ['attributes', 'gateway'])
      assert.notEqual(claude?.identity_source, 'gateway_fallback', 'transcript-matched row must not be marked as fallback')
      assert.notEqual(gateway?.identity_source, 'gateway_fallback', 'gateway must not stamp fallback when projector supplies message_id')
    }
  } finally {
    await env.cleanup()
  }
})

test('root message gets previous_message_id = [] when parentUuid is null', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-root', [
      jsonlRow({
        sessionId: 'sess-root',
        uuid: 'u-root',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'first' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-root' }) },
        messages: [{ role: 'user', content: 'first' }],
      },
      responseBody: undefined,
    })

    assert.equal(rows.length, 1)
    assert.equal(rows[0].message_id, 'u-root')
    assert.deepEqual(rows[0].previous_message_id, [], 'root message must carry an empty previous_message_id array')
  } finally {
    await env.cleanup()
  }
})

test('transcript-enriched previous_message_id carries the full prior chain, not just the parent', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-chain', [
      jsonlRow({
        sessionId: 'sess-chain',
        uuid: 'u-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'first question' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-chain',
        uuid: 'a-1',
        parentUuid: 'u-1',
        type: 'assistant',
        message: { role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'first answer' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-chain',
        uuid: 'u-2',
        parentUuid: 'a-1',
        type: 'user',
        message: { role: 'user', content: 'second question' },
        timestamp: '2026-05-22T10:00:02.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-chain',
        uuid: 'a-2',
        parentUuid: 'u-2',
        type: 'assistant',
        message: { role: 'assistant', id: 'msg_2', content: [{ type: 'text', text: 'second answer' }] },
        timestamp: '2026-05-22T10:00:03.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-chain' }) },
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
          { role: 'user', content: 'second question' },
        ],
      },
      responseBody: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'second answer' }], stop_reason: 'end_turn' },
    })

    assert.equal(rows.length, 4)
    const byId = new Map(rows.map((r) => [r.message_id, r]))
    // Enriched rows must carry the SAME previous_message_id shape the
    // gateway fallback produces: every prior message id in order —
    // not the [parentUuid] singleton. The singleton's information
    // survives on parent_uuid.
    assert.deepEqual(byId.get('u-1')?.previous_message_id, [])
    assert.deepEqual(byId.get('a-1')?.previous_message_id, ['u-1'])
    assert.deepEqual(byId.get('u-2')?.previous_message_id, ['u-1', 'a-1'])
    assert.deepEqual(byId.get('a-2')?.previous_message_id, ['u-1', 'a-1', 'u-2'])
    assert.equal(byId.get('a-2')?.parent_uuid, 'u-2')
  } finally {
    await env.cleanup()
  }
})

test('subagent transcript under <sessionId>/subagents supplies sidechain identity', async () => {
  const env = await stageClaudeEnv()
  try {
    // Main session file exists but holds none of the subagent messages.
    await writeTranscript(env, 'sess-side', [
      jsonlRow({
        sessionId: 'sess-side',
        uuid: 'u-main-1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'main loop prompt' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
    ])
    // The CLI writes sidechain entries to a per-agent file in a
    // directory named for the session, still carrying the parent
    // sessionId on each entry.
    await writeSubagentTranscript(env, 'sess-side', 'agent-abc123.jsonl', [
      jsonlRow({
        sessionId: 'sess-side',
        agentId: 'abc123',
        isSidechain: true,
        uuid: 'u-side-user',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'run the subtask' },
        timestamp: '2026-05-22T10:00:02.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-side',
        agentId: 'abc123',
        isSidechain: true,
        uuid: 'u-side-assistant',
        parentUuid: 'u-side-user',
        type: 'assistant',
        message: { role: 'assistant', id: 'msg_side', content: [{ type: 'text', text: 'done' }] },
        timestamp: '2026-05-22T10:00:03.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-side' }) },
        messages: [{ role: 'user', content: 'run the subtask' }],
      },
      responseBody: { id: 'msg_side', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
    })

    assert.equal(rows.length, 2)
    const userRow = rows.find((r) => r.role === 'user')
    const assistantRow = rows.find((r) => r.role === 'assistant')
    assert.ok(userRow && assistantRow)
    assert.equal(userRow.message_id, 'u-side-user')
    assert.equal(assistantRow.message_id, 'u-side-assistant')
    assert.equal(userRow.is_sidechain, true)
    assert.equal(assistantRow.is_sidechain, true)
    assert.equal(userRow.agent_id, 'abc123', 'transcript agentId lands on the agent_id column')
    assert.equal(assistantRow.agent_id, 'abc123')
    for (const row of rows) {
      const gateway = readAttrPath(row, ['attributes', 'gateway'])
      assert.notEqual(gateway?.identity_source, 'gateway_fallback', 'sidechain rows must carry native transcript identity')
    }
  } finally {
    await env.cleanup()
  }
})

test('transcript_path from session context also loads sibling subagent files', async () => {
  const env = await stageClaudeEnv()
  try {
    // Non-standard location only reachable through transcript_path —
    // the projects-dir scan can never find it, so a uuid match proves
    // the sibling <sessionId>/ directory walk ran.
    const altDir = path.join(env.homeDir, 'alt-transcripts')
    const transcriptPath = path.join(altDir, 'sess-hook.jsonl')
    const subagentsDir = path.join(altDir, 'sess-hook', 'subagents')
    await fs.mkdir(subagentsDir, { recursive: true })
    await fs.writeFile(transcriptPath, jsonlRow({
      sessionId: 'sess-hook',
      uuid: 'u-hook-main',
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'main prompt' },
      timestamp: '2026-05-22T10:00:00.000Z',
    }) + '\n', 'utf8')
    await fs.writeFile(path.join(subagentsDir, 'agent-zzz.jsonl'), jsonlRow({
      sessionId: 'sess-hook',
      agentId: 'zzz',
      isSidechain: true,
      uuid: 'u-hook-side',
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'side prompt' },
      timestamp: '2026-05-22T10:00:01.000Z',
    }) + '\n', 'utf8')
    await fs.writeFile(
      env.stateFile,
      JSON.stringify({
        session_id: 'sess-hook',
        transcript_path: transcriptPath,
        ts: '2026-05-22T09:59:00.000Z',
      }) + '\n',
      'utf8'
    )

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-hook' }) },
        messages: [{ role: 'user', content: 'side prompt' }],
      },
      responseBody: undefined,
    })

    assert.equal(rows.length, 1)
    assert.equal(rows[0].message_id, 'u-hook-side')
    assert.equal(rows[0].is_sidechain, true)
  } finally {
    await env.cleanup()
  }
})

test('cache_control on wire blocks and caller on transcript blocks do not break matching', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-cc', [
      jsonlRow({
        sessionId: 'sess-cc',
        uuid: 'u-cc-user',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-cc',
        uuid: 'u-cc-assistant',
        parentUuid: 'u-cc-user',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            // Transcripts annotate tool_use blocks with `caller`; the
            // wire replay has no such field.
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' }, caller: { type: 'direct' } },
          ],
        },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-cc' }) },
        messages: [
          // The wire carries a prompt-cache breakpoint the transcript
          // never sees.
          { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } }] },
        ],
      },
      responseBody: undefined,
    })

    assert.equal(rows.length, 2)
    const userRow = rows.find((r) => r.role === 'user')
    const assistantRow = rows.find((r) => r.role === 'assistant')
    assert.ok(userRow && assistantRow)
    assert.equal(userRow.message_id, 'u-cc-user', 'cache_control on the wire block must not defeat the content match')
    assert.equal(assistantRow.message_id, 'u-cc-assistant', 'caller on the transcript block must not defeat the content match')
  } finally {
    await env.cleanup()
  }
})

test('multi-block assistant turn splits into per-line uuid messages (LLP 0023)', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-split', [
      jsonlRow({
        sessionId: 'sess-split',
        uuid: 'u-s-user',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'go' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-split',
        uuid: 'u-s-text',
        parentUuid: 'u-s-user',
        type: 'assistant',
        message: { id: 'msg_split', role: 'assistant', content: [{ type: 'text', text: 'working on it' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-split',
        uuid: 'u-s-tool',
        parentUuid: 'u-s-text',
        type: 'assistant',
        message: {
          id: 'msg_split',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' }, caller: { type: 'direct' } }],
        },
        timestamp: '2026-05-22T10:00:02.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-split' }) },
        messages: [{ role: 'user', content: 'go' }],
      },
      responseBody: {
        id: 'msg_split',
        role: 'assistant',
        content: [
          { type: 'text', text: 'working on it' },
          { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } },
        ],
        stop_reason: 'tool_use',
      },
    })

    // One row per transcript line: user, assistant text, assistant tool_use —
    // each its own message with a single part.
    assert.equal(rows.length, 3)
    const textRow = rows.find((r) => r.message_id === 'u-s-text')
    const toolRow = rows.find((r) => r.message_id === 'u-s-tool')
    assert.ok(textRow && toolRow, 'each assistant block must become its own uuid message')
    assert.equal(textRow.part_index, 0)
    assert.equal(toolRow.part_index, 0)
    assert.equal(textRow.part_type, 'text')
    assert.equal(toolRow.part_type, 'tool_call')
    assert.equal(toolRow.tool_name, 'Bash')
    // The native chain rides parent_uuid; previous_message_id is
    // gateway-owned (full prior chain) for enriched and fallback rows
    // alike.
    assert.equal(toolRow.parent_uuid, 'u-s-text')
    assert.ok(Array.isArray(toolRow.previous_message_id))
    assert.ok(/** @type {string[]} */ (toolRow.previous_message_id).includes('u-s-text'))
    // finish_reason rides the LAST block's message only.
    assert.equal(readAttrPath(toolRow, ['status'])?.finish_reason, 'tool_use')
    assert.equal(textRow.status, undefined)
  } finally {
    await env.cleanup()
  }
})

test('parallel tool_results split one message per result, joined by tool_use_id', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-par', [
      jsonlRow({
        sessionId: 'sess-par',
        uuid: 'u-p-r1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'one' }] },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-par',
        uuid: 'u-p-r2',
        parentUuid: 'u-p-r1',
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'two' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-par' }) },
        messages: [{
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_a', content: 'one' },
            { type: 'tool_result', tool_use_id: 'toolu_b', content: 'two' },
          ],
        }],
      },
      responseBody: undefined,
    })

    assert.equal(rows.length, 2)
    assert.deepEqual(
      rows.map((r) => r.message_id).sort(),
      ['u-p-r1', 'u-p-r2'],
      'each tool_result must match its own transcript line via tool_use_id'
    )
    for (const row of rows) {
      assert.equal(row.part_type, 'tool_result')
      assert.equal(row.part_index, 0)
    }
  } finally {
    await env.cleanup()
  }
})

test('reminder-wrapped prompt canonicalizes to transcript content + wire_only extra', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-rem', [
      jsonlRow({
        sessionId: 'sess-rem',
        uuid: 'u-r-prompt',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'do the thing' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-rem' }) },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>\ninjected banner\n</system-reminder>' },
            { type: 'text', text: 'do the thing' },
          ],
        }],
      },
      responseBody: undefined,
    })

    const matched = rows.filter((r) => r.message_id === 'u-r-prompt')
    assert.equal(matched.length, 1, 'the logical prompt must match its transcript line')
    assert.equal(matched[0].content_text, 'do the thing', 'matched row carries the TRANSCRIPT content, not the wire blocks')
    const wireOnly = rows.filter((r) => readAttrPath(r, ['attributes', 'claude'])?.wire_only === true)
    assert.equal(wireOnly.length, 1, 'injected reminder blocks become a separate wire_only message')
    assert.match(String(wireOnly[0].content_text), /system-reminder/)
  } finally {
    await env.cleanup()
  }
})

test('x-claude-code-agent-id header stamps is_sidechain even without a transcript', async () => {
  const env = await stageClaudeEnv()
  try {
    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-agent-hdr' }) },
        messages: [{ role: 'user', content: 'subagent prompt' }],
      },
      responseBody: undefined,
      requestHeaders: { 'x-claude-code-agent-id': 'a1b2c3' },
    })

    assert.ok(rows.length >= 1)
    for (const row of rows) {
      assert.equal(row.is_sidechain, true, 'agent-id header must mark the exchange sidechain')
      assert.equal(row.agent_id, 'a1b2c3', 'agent id from the header lands on the agent_id column')
    }
  } finally {
    await env.cleanup()
  }
})

test('unmatched multi-block assistant turn still splits, with stable per-block fallback ids', async () => {
  const env = await stageClaudeEnv()
  try {
    // No transcript at all for this session.
    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-nofile' }) },
        messages: [],
      },
      responseBody: {
        id: 'msg_nofile',
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking out loud' },
          { type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: '/tmp/y' } },
        ],
        stop_reason: 'tool_use',
      },
    })

    assert.equal(rows.length, 2)
    const [a, b] = rows
    assert.notEqual(a.message_id, b.message_id, 'each block gets its own fallback identity')
    for (const row of rows) {
      assert.equal(row.part_index, 0, 'split rows are single-part')
      assert.match(String(row.message_id), /^[0-9a-f]{16}$/)
    }
  } finally {
    await env.cleanup()
  }
})

test('missing transcript → gateway fallback identity + claude.identity_source marker', async () => {
  const env = await stageClaudeEnv()
  try {
    // No transcript file is written for this session.
    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-missing' }) },
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
        ],
      },
      responseBody: undefined,
    })

    assert.equal(rows.length, 2)
    // Gateway computed a hash message_id (deterministic but not a uuid).
    for (const row of rows) {
      assert.equal(typeof row.message_id, 'string')
      assert.equal(row.provider_uuid, undefined, 'no transcript means no provider_uuid')
    }
    // The gateway stamps its own fallback marker AND the Claude
    // projector stamps its own — both must be present so the row is
    // unambiguous to operators querying by either marker.
    for (const row of rows) {
      const claude = readAttrPath(row, ['attributes', 'claude'])
      const gateway = readAttrPath(row, ['attributes', 'gateway'])
      assert.equal(claude?.identity_source, 'gateway_fallback')
      assert.equal(gateway?.identity_source, 'gateway_fallback')
    }
  } finally {
    await env.cleanup()
  }
})

test('session-context state file supplies cwd and git_branch on the row', async () => {
  const env = await stageClaudeEnv()
  try {
    await fs.writeFile(
      env.stateFile,
      JSON.stringify({
        session_id: 'sess-ctx',
        cwd: '/Users/me/proj',
        git_branch: 'feature/abc',
        ts: '2026-05-22T09:59:00.000Z',
      }) + '\n',
      'utf8'
    )

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-ctx' }) },
        messages: [{ role: 'user', content: 'hello' }],
      },
      responseBody: undefined,
    })

    assert.ok(rows.length >= 1)
    for (const row of rows) {
      assert.equal(row.cwd, '/Users/me/proj')
      assert.equal(row.git_branch, 'feature/abc')
    }
  } finally {
    await env.cleanup()
  }
})

test('exchange without anthropic signature is skipped by match()', async () => {
  const env = await stageClaudeEnv()
  try {
    const projector = createClaudeExchangeProjector({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
    })
    assert.equal(projector.match({
      exchange_id: 'ex-1',
      ts_start: '2026-05-22T10:00:00.000Z',
      ts_end: null,
      duration_ms: null,
      upstream: 'openai',
      provider: null,
      method: 'POST',
      path: '/v1/chat/completions',
      status_code: null,
      request_bytes: null,
      response_bytes: null,
      is_sse: null,
      stream_event_count: null,
      request_headers: JSON.stringify({ 'user-agent': 'curl/8.0' }),
      request_body: null,
      response_headers: null,
      response_body: null,
      error: null,
      metadata: null,
      stream_events: [],
    }), false)
  } finally {
    await env.cleanup()
  }
})

test('match() accepts /v1/messages path even without anthropic headers', async () => {
  const env = await stageClaudeEnv()
  try {
    const projector = createClaudeExchangeProjector({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
    })
    assert.equal(projector.match({
      exchange_id: 'ex-1',
      ts_start: '2026-05-22T10:00:00.000Z',
      ts_end: null,
      duration_ms: null,
      upstream: 'anthropic',
      provider: null,
      method: 'POST',
      path: '/v1/messages',
      status_code: null,
      request_bytes: null,
      response_bytes: null,
      is_sse: null,
      stream_event_count: null,
      request_headers: null,
      request_body: null,
      response_headers: null,
      response_body: null,
      error: null,
      metadata: null,
      stream_events: [],
    }), true)
  } finally {
    await env.cleanup()
  }
})

test('match() accepts requests with anthropic-version header on non-canonical paths', async () => {
  const env = await stageClaudeEnv()
  try {
    const projector = createClaudeExchangeProjector({
      homeDir: env.homeDir,
      stateFile: env.stateFile,
    })
    assert.equal(projector.match({
      exchange_id: 'ex-1',
      ts_start: '2026-05-22T10:00:00.000Z',
      ts_end: null,
      duration_ms: null,
      upstream: 'anthropic',
      provider: null,
      method: 'POST',
      path: '/proxy/messages',
      status_code: null,
      request_bytes: null,
      response_bytes: null,
      is_sse: null,
      stream_event_count: null,
      request_headers: JSON.stringify({ 'anthropic-version': '2023-06-01' }),
      request_body: null,
      response_headers: null,
      response_body: null,
      error: null,
      metadata: null,
      stream_events: [],
    }), true)
  } finally {
    await env.cleanup()
  }
})

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * @returns {Promise<{ homeDir: string, stateDir: string, stateFile: string, cleanup: () => Promise<void> }>}
 */
async function stageClaudeEnv() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-projector-'))
  const stateDir = path.join(homeDir, 'state')
  await fs.mkdir(stateDir, { recursive: true })
  const stateFile = path.join(stateDir, 'session-context.jsonl')
  return {
    homeDir,
    stateDir,
    stateFile,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true })
    },
  }
}

/**
 * @param {{ homeDir: string }} env
 * @param {string} sessionId
 * @param {string[]} lines
 */
async function writeTranscript(env, sessionId, lines) {
  const projectsDir = path.join(env.homeDir, '.claude', 'projects', 'some-repo')
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.writeFile(
    path.join(projectsDir, `${sessionId}.jsonl`),
    lines.join('\n') + '\n',
    'utf8'
  )
}

/**
 * Write a subagent transcript file at the path the Claude CLI uses:
 * `<projectsDir>/<repo>/<sessionId>/subagents/<agentFileName>`.
 *
 * @param {{ homeDir: string }} env
 * @param {string} sessionId
 * @param {string} agentFileName
 * @param {string[]} lines
 */
async function writeSubagentTranscript(env, sessionId, agentFileName, lines) {
  const subagentsDir = path.join(env.homeDir, '.claude', 'projects', 'some-repo', sessionId, 'subagents')
  await fs.mkdir(subagentsDir, { recursive: true })
  await fs.writeFile(
    path.join(subagentsDir, agentFileName),
    lines.join('\n') + '\n',
    'utf8'
  )
}

/**
 * @param {Record<string, unknown>} obj
 */
function jsonlRow(obj) {
  return JSON.stringify(obj)
}

/**
 * Build the projector, wrap it in the gateway's dispatcher (so the
 * fallback identity path and `attributes.gateway.*` stamping run),
 * and project one synthetic exchange.
 *
 * @param {{ homeDir: string, stateFile: string }} env
 * @param {{ reqBody: Record<string, unknown>, responseBody: unknown, streamEvents?: Array<{ data: string, event?: string }>, requestHeaders?: Record<string, string> }} call
 */
async function projectViaGateway(env, call) {
  const projector = createClaudeExchangeProjector({
    homeDir: env.homeDir,
    stateFile: env.stateFile,
  })
  // Wrap as the gateway's `RegisteredProjector` shape.
  const dispatcher = createAiGatewayMessageProjector({
    gatewayId: 'gw-test',
    projectors: [{ ...projector, _seq: 0 }],
  })
  return dispatcher.projectExchange({
    exchange_id: 'ex-1',
    ts_start: '2026-05-22T10:00:05.000Z',
    ts_end: '2026-05-22T10:00:05.250Z',
    duration_ms: 250,
    upstream: 'anthropic',
    provider: null,
    method: 'POST',
    path: '/v1/messages',
    status_code: 200,
    request_bytes: 100,
    response_bytes: 200,
    is_sse: false,
    stream_event_count: 0,
    request_headers: JSON.stringify({
      'anthropic-version': '2023-06-01',
      'user-agent': 'claude-cli/1.0',
      ...(call.requestHeaders ?? {}),
    }),
    request_body: JSON.stringify(call.reqBody),
    response_headers: JSON.stringify({ 'content-type': 'application/json' }),
    response_body: call.responseBody === undefined ? null : JSON.stringify(call.responseBody),
    error: null,
    metadata: JSON.stringify({ dev_run_id: 'run-1' }),
    stream_events: call.streamEvents ?? [],
  })
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} path
 */
function readAttrPath(row, path) {
  /** @type {unknown} */
  let cur = row
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = /** @type {Record<string, unknown>} */ (cur)[key]
  }
  return /** @type {Record<string, unknown> | undefined} */ (
    cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : undefined
  )
}

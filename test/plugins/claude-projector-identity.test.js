// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAiGatewayMessageProjector } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createClaudeExchangeProjector } from '../../hypaware-core/plugins-workspace/claude/src/projector.js'
import { loadAgentMeta } from '../../hypaware-core/plugins-workspace/claude/src/transcripts.js'

/**
 * End-to-end identity tests for the Claude exchange projector. Each
 * test wires the Claude projector through the gateway core's
 * dispatcher (with no other projector registered) so the assertions
 * cover the same path that runs in production: including the
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

    // previous_message_id is the gateway-filled immediate predecessor
    // (here the single prior message); the native DAG parent rides
    // parent_uuid.
    assert.deepEqual(assistantRows[0].previous_message_id, ['u-user-1'])
    assert.equal(assistantRows[0].parent_uuid, 'u-user-1')

    // Gateway must NOT stamp identity_source when the projector
    // supplied message_id. The assertion guards the projector against
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

test('transcript-matched live rows carry the minimized raw_frame, never the full line', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-rf', [
      jsonlRow({
        sessionId: 'sess-rf',
        uuid: 'u-user-rf',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'a distinctive prompt payload' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-rf',
        uuid: 'u-assistant-rf',
        parentUuid: 'u-user-rf',
        type: 'assistant',
        message: { role: 'assistant', id: 'msg_rf', content: [{ type: 'text', text: 'a distinctive answer payload' }] },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-rf' }) },
        messages: [{ role: 'user', content: 'a distinctive prompt payload' }],
      },
      responseBody: { id: 'msg_rf', role: 'assistant', content: [{ type: 'text', text: 'a distinctive answer payload' }], stop_reason: 'end_turn' },
    })

    const assistant = rows.find((r) => r.role === 'assistant')
    assert.ok(assistant)
    const frame = typeof assistant.raw_frame === 'string' ? JSON.parse(assistant.raw_frame) : assistant.raw_frame
    assert.ok(frame, 'matched row keeps a raw_frame')
    // The minimized native-identity stub backfill has always stored...
    assert.equal(frame.uuid, 'u-assistant-rf')
    assert.equal(frame.parent_uuid, 'u-user-rf')
    assert.equal(frame.type, 'assistant')
    assert.equal(frame.message_id, 'msg_rf')
    // ...never the raw transcript line: no message payload, no content copy.
    assert.equal(frame.message, undefined)
    assert.equal(frame.sessionId, undefined)
    for (const row of rows) {
      const rowFrame = typeof row.raw_frame === 'string' ? row.raw_frame : JSON.stringify(row.raw_frame ?? {})
      assert.ok(!rowFrame.includes('distinctive'), 'raw_frame must not embed conversation content')
    }
  } finally {
    await env.cleanup()
  }
})

test('live: response-level usage lands once, on the last block of a split turn', async () => {
  const env = await stageClaudeEnv()
  try {
    // Transcript splits the assistant turn one line per block (text, then
    // tool_use), both sharing message id msg_u.
    await writeTranscript(env, 'sess-u', [
      jsonlRow({ sessionId: 'sess-u', uuid: 'u-user', parentUuid: null, type: 'user', message: { role: 'user', content: 'go' }, timestamp: '2026-05-22T10:00:00.000Z' }),
      jsonlRow({ sessionId: 'sess-u', uuid: 'u-text', parentUuid: 'u-user', type: 'assistant', message: { role: 'assistant', id: 'msg_u', content: [{ type: 'text', text: 'on it' }] }, timestamp: '2026-05-22T10:00:01.000Z' }),
      jsonlRow({ sessionId: 'sess-u', uuid: 'u-tool', parentUuid: 'u-text', type: 'assistant', message: { role: 'assistant', id: 'msg_u', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }, timestamp: '2026-05-22T10:00:02.000Z' }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-u' }) },
        messages: [{ role: 'user', content: 'go' }],
      },
      // Wire response carries both blocks and one response-level usage block.
      responseBody: {
        id: 'msg_u',
        role: 'assistant',
        content: [
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 500 },
      },
    })

    // The turn fans into two assistant rows; usage rides ONLY the last block
    // (the tool_call), not the text block. @ref LLP 0035#one-carrier
    const textRow = rows.find((r) => r.role === 'assistant' && r.part_type === 'text')
    const toolRow = rows.find((r) => r.role === 'assistant' && r.part_type === 'tool_call')
    assert.ok(textRow)
    assert.ok(toolRow)
    assert.equal(readAttrPath(textRow, ['attributes', 'usage']), undefined)
    assert.deepEqual(readAttrPath(toolRow, ['attributes', 'usage']), {
      input_tokens: 200,
      output_tokens: 60,
      cache_read_tokens: 500,
    })
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

test('transcript-enriched previous_message_id carries the immediate predecessor, scoped per thread', async () => {
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
    // Enriched rows carry the SAME previous_message_id shape the gateway
    // fallback produces: the immediate predecessor only (a 0/1-element
    // array). Full ancestry is the transitive closure of these links;
    // the native parent also survives on parent_uuid.
    assert.deepEqual(byId.get('u-1')?.previous_message_id, [])
    assert.deepEqual(byId.get('a-1')?.previous_message_id, ['u-1'])
    assert.deepEqual(byId.get('u-2')?.previous_message_id, ['a-1'])
    assert.deepEqual(byId.get('a-2')?.previous_message_id, ['u-2'])
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
      // Subagent exchanges carry the agent-id header; matching is scoped
      // to this agent's transcript entries.
      requestHeaders: { 'x-claude-code-agent-id': 'abc123' },
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
    // Non-standard location only reachable through transcript_path.
    // The projects-dir scan can never find it, so a uuid match proves
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
      requestHeaders: { 'x-claude-code-agent-id': 'zzz' },
      responseBody: undefined,
    })

    assert.equal(rows.length, 1)
    assert.equal(rows[0].message_id, 'u-hook-side')
    assert.equal(rows[0].is_sidechain, true)
  } finally {
    await env.cleanup()
  }
})

test('subagent exchange stamps spawned_by_tool_use_id from the meta sidecar', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-spawn', [
      jsonlRow({
        sessionId: 'sess-spawn',
        uuid: 'u-main',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'main prompt' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
    ])
    await writeSubagentTranscript(env, 'sess-spawn', 'agent-sa1.jsonl', [
      jsonlRow({
        sessionId: 'sess-spawn',
        agentId: 'sa1',
        isSidechain: true,
        uuid: 'u-side',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'side prompt' },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    // The sidecar Claude writes next to the subagent transcript records
    // the parent-thread Agent/Task tool call that spawned this agent.
    await fs.writeFile(
      path.join(env.homeDir, '.claude', 'projects', 'some-repo', 'sess-spawn', 'subagents', 'agent-sa1.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'do a thing', toolUseId: 'toolu_parent' }),
      'utf8'
    )
    await fs.writeFile(
      env.stateFile,
      JSON.stringify({
        session_id: 'sess-spawn',
        transcript_path: path.join(env.homeDir, '.claude', 'projects', 'some-repo', 'sess-spawn.jsonl'),
        ts: '2026-05-22T09:59:00.000Z',
      }) + '\n',
      'utf8'
    )

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-spawn' }) },
        messages: [{ role: 'user', content: 'side prompt' }],
      },
      requestHeaders: { 'x-claude-code-agent-id': 'sa1' },
      responseBody: undefined,
    })

    assert.equal(rows.length, 1)
    assert.equal(rows[0].agent_id, 'sa1')
    assert.equal(rows[0].is_sidechain, true)
    assert.equal(
      /** @type {any} */ (rows[0].attributes).claude.spawned_by_tool_use_id,
      'toolu_parent'
    )
  } finally {
    await env.cleanup()
  }
})

// A hook-written `transcript_path` can go stale: the file is gone, or was
// never written where the hook said. `loadTranscript` recovers the session by
// scanning `projectsDir` for the session id; the sidecar lookup must recover
// with it, or a row whose transcript identity was recovered still points at no
// parent tool call.
test('a stale transcript_path still recovers spawned_by_tool_use_id from the session scan', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-stale-spawn', [
      jsonlRow({
        sessionId: 'sess-stale-spawn',
        uuid: 'u-main',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'main prompt' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
    ])
    await writeSubagentTranscript(env, 'sess-stale-spawn', 'agent-sa1.jsonl', [
      jsonlRow({
        sessionId: 'sess-stale-spawn',
        agentId: 'sa1',
        isSidechain: true,
        uuid: 'u-side',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'side prompt' },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    await fs.writeFile(
      path.join(env.homeDir, '.claude', 'projects', 'some-repo', 'sess-stale-spawn', 'subagents', 'agent-sa1.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'do a thing', toolUseId: 'toolu_recovered' }),
      'utf8'
    )
    // ...but the hook recorded a path that no longer exists, so both the
    // direct transcript read and the sidecar walk rooted at it find nothing.
    await fs.writeFile(
      env.stateFile,
      JSON.stringify({
        session_id: 'sess-stale-spawn',
        transcript_path: path.join(env.homeDir, 'gone', 'sess-stale-spawn.jsonl'),
        ts: '2026-05-22T09:59:00.000Z',
      }) + '\n',
      'utf8'
    )

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-stale-spawn' }) },
        messages: [{ role: 'user', content: 'side prompt' }],
      },
      requestHeaders: { 'x-claude-code-agent-id': 'sa1' },
      responseBody: undefined,
    })

    assert.equal(rows.length, 1)
    assert.equal(rows[0].agent_id, 'sa1')
    assert.equal(rows[0].is_sidechain, true)
    // Transcript identity was recovered by the session scan...
    assert.equal(rows[0].message_id, 'u-side')
    // ...and so was the sidecar the scan's session directory holds.
    assert.equal(
      /** @type {any} */ (rows[0].attributes).claude.spawned_by_tool_use_id,
      'toolu_recovered'
    )
  } finally {
    await env.cleanup()
  }
})

// The other half: a `transcript_path` whose sidecar walk does find something
// stays rooted at that session directory. A decoy sidecar for the same agent
// id elsewhere in the projects tree is what a projects-wide walk would pick
// up, and it must not be read.
test('a valid transcript_path reads only its own session directory of sidecars', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-direct-spawn', [
      jsonlRow({
        sessionId: 'sess-direct-spawn',
        uuid: 'u-main',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'main prompt' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
    ])
    await writeSubagentTranscript(env, 'sess-direct-spawn', 'agent-sa1.jsonl', [
      jsonlRow({
        sessionId: 'sess-direct-spawn',
        agentId: 'sa1',
        isSidechain: true,
        uuid: 'u-side',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: 'side prompt' },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])
    await fs.writeFile(
      path.join(env.homeDir, '.claude', 'projects', 'some-repo', 'sess-direct-spawn', 'subagents', 'agent-sa1.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_named' }),
      'utf8'
    )
    // Same agent id, another session's directory: reachable only by a walk of
    // the whole projects tree.
    const decoyDir = path.join(env.homeDir, '.claude', 'projects', 'other-repo', 'sess-other', 'subagents')
    await fs.mkdir(decoyDir, { recursive: true })
    await fs.writeFile(
      path.join(decoyDir, 'agent-sa1.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_decoy' }),
      'utf8'
    )
    await fs.writeFile(
      env.stateFile,
      JSON.stringify({
        session_id: 'sess-direct-spawn',
        transcript_path: path.join(env.homeDir, '.claude', 'projects', 'some-repo', 'sess-direct-spawn.jsonl'),
        ts: '2026-05-22T09:59:00.000Z',
      }) + '\n',
      'utf8'
    )

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-direct-spawn' }) },
        messages: [{ role: 'user', content: 'side prompt' }],
      },
      requestHeaders: { 'x-claude-code-agent-id': 'sa1' },
      responseBody: undefined,
    })

    assert.equal(rows.length, 1)
    assert.equal(
      /** @type {any} */ (rows[0].attributes).claude.spawned_by_tool_use_id,
      'toolu_named'
    )
  } finally {
    await env.cleanup()
  }
})

// The fall-through is for a `transcript_path` that points nowhere, not for
// every empty result. A live session that has simply written no sidecar yet
// is the common sidechain shape: gating on the empty map alone made each of
// its exchanges walk the whole projects tree, a cost that grows with the
// user's history. The same session id under a second repo directory is the
// stand-in for that walk here (a real session lives in one directory): only
// the stale path may reach it.
test('an existing session directory ends the sidecar lookup; only a stale path scans projectsDir', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-agent-meta-'))
  try {
    const projectsDir = path.join(dir, 'projects')
    // The named session directory is real, and holds no sidecar.
    await fs.mkdir(path.join(projectsDir, 'repo-a', 'sess-x', 'subagents'), { recursive: true })
    await fs.writeFile(path.join(projectsDir, 'repo-a', 'sess-x.jsonl'), '', 'utf8')
    await fs.mkdir(path.join(projectsDir, 'repo-b', 'sess-x', 'subagents'), { recursive: true })
    await fs.writeFile(path.join(projectsDir, 'repo-b', 'sess-x.jsonl'), '', 'utf8')
    await fs.writeFile(
      path.join(projectsDir, 'repo-b', 'sess-x', 'subagents', 'agent-sa1.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_scanned' }),
      'utf8'
    )

    const named = loadAgentMeta({
      transcriptPath: path.join(projectsDir, 'repo-a', 'sess-x.jsonl'),
      projectsDir,
      sessionId: 'sess-x',
    })
    assert.equal(named.size, 0, 'a session directory that exists is not a stale path')

    const stale = loadAgentMeta({
      transcriptPath: path.join(dir, 'gone', 'sess-x.jsonl'),
      projectsDir,
      sessionId: 'sess-x',
    })
    assert.equal(stale.get('sa1')?.tool_use_id, 'toolu_scanned')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// An attached Claude Desktop does not write into `~/.claude/projects`: it runs
// each conversation in a sandbox home inside its own container, so a stale
// `transcript_path` leaves the projects scan nothing to find. `loadTranscript`
// sweeps the sandbox roots on that miss and recovers transcript identity; the
// sidecar lookup must sweep them with it, or the recovered row still points at
// no parent tool call.
test('a stale Desktop transcript_path recovers spawned_by_tool_use_id from the 3p sandbox root', async () => {
  const env = await stageClaudeEnv()
  try {
    const sandboxDir = desktop3pSandboxDir(env.homeDir)
    await fs.mkdir(path.join(sandboxDir, 'sess-3p-spawn', 'subagents'), { recursive: true })
    await fs.writeFile(
      path.join(sandboxDir, 'sess-3p-spawn.jsonl'),
      jsonlRow({
        sessionId: 'sess-3p-spawn',
        uuid: 'u-main',
        parentUuid: null,
        type: 'user',
        entrypoint: 'local-agent',
        message: { role: 'user', content: 'main prompt' },
        timestamp: '2026-05-22T10:00:00.000Z',
      }) + '\n',
      'utf8'
    )
    await fs.writeFile(
      path.join(sandboxDir, 'sess-3p-spawn', 'subagents', 'agent-sa1.jsonl'),
      jsonlRow({
        sessionId: 'sess-3p-spawn',
        agentId: 'sa1',
        isSidechain: true,
        uuid: 'u-side',
        parentUuid: null,
        type: 'user',
        entrypoint: 'local-agent',
        message: { role: 'user', content: 'side prompt' },
        timestamp: '2026-05-22T10:00:01.000Z',
      }) + '\n',
      'utf8'
    )
    await fs.writeFile(
      path.join(sandboxDir, 'sess-3p-spawn', 'subagents', 'agent-sa1.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_3p_recovered' }),
      'utf8'
    )
    // The hook recorded a path that is not there, and the shared projects tree
    // holds nothing for this session at all.
    await fs.writeFile(
      env.stateFile,
      JSON.stringify({
        session_id: 'sess-3p-spawn',
        transcript_path: path.join(env.homeDir, 'gone', 'sess-3p-spawn.jsonl'),
        ts: '2026-05-22T09:59:00.000Z',
      }) + '\n',
      'utf8'
    )

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-3p-spawn' }) },
        messages: [{ role: 'user', content: 'side prompt' }],
      },
      requestHeaders: { 'x-claude-code-agent-id': 'sa1' },
      responseBody: undefined,
    })

    assert.equal(rows.length, 1)
    assert.equal(rows[0].agent_id, 'sa1')
    assert.equal(rows[0].is_sidechain, true)
    // Transcript identity came from the sandbox root...
    assert.equal(rows[0].message_id, 'u-side')
    // ...and so must the sidecar in the same recovered directory.
    assert.equal(
      /** @type {any} */ (rows[0].attributes).claude.spawned_by_tool_use_id,
      'toolu_3p_recovered'
    )
  } finally {
    await env.cleanup()
  }
})

// The cost pin for both fallbacks, and their order. A live session whose
// sidecar is simply not written yet is the common sidechain shape, and it must
// end at its own (existing) session directory: neither the projects-wide walk
// nor the container sweep may run for it. Both decoys carry the SAME session id
// as the live session, the only shape that exercises the gate at all:
// `walkJsonlFiles` filters on the session id, so a decoy under any other id is
// invisible to the scans whether they run or not.
test('a live session with no sidecar yet scans neither projectsDir nor the 3p roots', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-agent-meta-3p-'))
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    // The named session directory is real and holds no sidecar: live, mid-spawn.
    await fs.mkdir(path.join(projectsDir, 'repo-a', 'sess-live', 'subagents'), { recursive: true })
    await fs.writeFile(path.join(projectsDir, 'repo-a', 'sess-live.jsonl'), '', 'utf8')
    // Decoy reachable only by a walk of the whole projects tree.
    await stageSidecar(path.join(projectsDir, 'repo-b'), 'sess-live', 'toolu_projects_decoy')
    // Decoy reachable only by the Desktop container sweep.
    await stageSidecar(desktop3pSandboxDir(homeDir), 'sess-live', 'toolu_3p_decoy')

    const live = loadAgentMeta({
      transcriptPath: path.join(projectsDir, 'repo-a', 'sess-live.jsonl'),
      projectsDir,
      sessionId: 'sess-live',
      homeDir,
    })
    assert.equal(live.size, 0, 'an existing session directory ends the lookup before either fallback')

    // Same tree, stale path: both fallbacks are now in play, and the projects
    // scan is the one that answers, because the container sweep comes last.
    const stale = loadAgentMeta({
      transcriptPath: path.join(homeDir, 'gone', 'sess-live.jsonl'),
      projectsDir,
      sessionId: 'sess-live',
      homeDir,
    })
    assert.equal(stale.get('sa1')?.tool_use_id, 'toolu_projects_decoy')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('the 3p sidecar sweep answers when projectsDir holds nothing, and only with a homeDir', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-agent-meta-3p-only-'))
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await stageSidecar(desktop3pSandboxDir(homeDir), 'sess-3p-only', 'toolu_3p_only')
    const staleOpts = {
      transcriptPath: path.join(homeDir, 'gone', 'sess-3p-only.jsonl'),
      projectsDir,
      sessionId: 'sess-3p-only',
    }

    assert.equal(loadAgentMeta({ ...staleOpts, homeDir }).get('sa1')?.tool_use_id, 'toolu_3p_only')
    // No `homeDir`, no sweep: the container is out of reach by construction.
    assert.equal(loadAgentMeta(staleOpts).size, 0)
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

// The cost pin for the re-sweep. An attached Desktop's hook-written path never
// resolves on the host, so its sidechain exchanges live inside the stale-path
// gate for the whole conversation, and a sidecar that is not written yet leaves
// `meta` empty every time. Re-sweeping the container on an empty map would put
// an uncached whole-container walk on every one of those exchanges; the session
// having been located is what says the cached root list was already complete.
test('a located session does not force an uncached container re-sweep', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-agent-meta-resweep-'))
  try {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    // In the container, with no sidecar: the standing shape of a Desktop
    // conversation mid-spawn.
    const sandboxDir = desktop3pSandboxDir(homeDir)
    await fs.mkdir(path.join(sandboxDir, 'sess-desk', 'subagents'), { recursive: true })
    await fs.writeFile(path.join(sandboxDir, 'sess-desk.jsonl'), '', 'utf8')
    const opts = {
      transcriptPath: path.join(homeDir, 'unresolvable', 'sess-desk.jsonl'),
      projectsDir,
      sessionId: 'sess-desk',
      homeDir,
    }
    // Sweeps the container once and caches the root list.
    assert.equal(loadAgentMeta(opts).size, 0)
    // A decoy only an uncached re-sweep could reach: a sandbox home that did
    // not exist when that list was cached.
    await stageSidecar(desktop3pSandboxDir(homeDir, 'late999'), 'sess-desk', 'toolu_resweep_decoy')
    assert.equal(loadAgentMeta(opts).size, 0, 'the session was located: the cached list was complete')

    // A session in none of the swept dirs is the case the re-sweep exists for,
    // and it still runs: the same late home answers for a session the cached
    // list never held.
    const missing = {
      ...opts,
      transcriptPath: path.join(homeDir, 'unresolvable', 'sess-late.jsonl'),
      sessionId: 'sess-late',
    }
    assert.equal(loadAgentMeta(missing).size, 0)
    await stageSidecar(desktop3pSandboxDir(homeDir, 'later000'), 'sess-late', 'toolu_late')
    assert.equal(loadAgentMeta(missing).get('sa1')?.tool_use_id, 'toolu_late')

    // And the sweep stops at the home that held the session, so the rest of
    // the container is neither walked nor allowed to answer under the same
    // session id. `sess-desk` is in the first-party `Claude` container, which
    // `claudeDesktop3pSessionRoots` names before the legacy `Claude-3p` one.
    await stageSidecar(
      desktop3pSandboxDir(homeDir, 'legacy', 'Claude-3p'), 'sess-desk', 'toolu_other_home'
    )
    assert.equal(loadAgentMeta(opts).size, 0, 'the home holding the session answers for it')

    // The projects scan locating the session settles it just as well: a
    // session lives in exactly one tree, so no container sweep is stale for
    // it. This is the CLI shape of the same standing state, a subagent whose
    // sidecar is not written yet under a session directory not created yet.
    await fs.mkdir(path.join(projectsDir, 'repo-a'), { recursive: true })
    await fs.writeFile(path.join(projectsDir, 'repo-a', 'sess-cli.jsonl'), '', 'utf8')
    const cli = { ...opts, transcriptPath: path.join(homeDir, 'gone', 'sess-cli.jsonl'), sessionId: 'sess-cli' }
    assert.equal(loadAgentMeta(cli).size, 0)
    await stageSidecar(desktop3pSandboxDir(homeDir, 'latest111'), 'sess-cli', 'toolu_cli_decoy')
    assert.equal(loadAgentMeta(cli).size, 0, 'the projects tree holds it: the container cannot be stale for it')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
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

    // One row per transcript line: user, assistant text, assistant tool_use.
    // Each its own message with a single part.
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
    // gateway-owned (immediate predecessor) for enriched and fallback
    // rows alike. Here the text block that precedes this tool block.
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

test('transcript toolUseResult is promoted onto the matched live row', async () => {
  const env = await stageClaudeEnv()
  try {
    // The structured result Claude Code writes only to the transcript.
    const toolUseResult = {
      filePath: '/work/a.txt',
      interrupted: false,
      structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }],
    }
    await writeTranscript(env, 'sess-tur', [
      jsonlRow({
        sessionId: 'sess-tur',
        uuid: 'u-t-r1',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
        toolUseResult,
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-tur' }) },
        messages: [{
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }],
        }],
      },
      responseBody: undefined,
    })

    assert.equal(rows.length, 1)
    assert.equal(rows[0].message_id, 'u-t-r1')
    const claude = readAttrPath(rows[0], ['attributes', 'claude'])
    assert.deepEqual(claude?.tool_use_result, toolUseResult)
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

test('real text riding with a tool_result is matched, not dumped as wire_only', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-mix', [
      jsonlRow({
        sessionId: 'sess-mix',
        uuid: 'u-mix-tr',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'result text' }] },
        timestamp: '2026-05-22T10:00:00.000Z',
      }),
      jsonlRow({
        sessionId: 'sess-mix',
        uuid: 'u-mix-text',
        parentUuid: 'u-mix-tr',
        type: 'user',
        message: { role: 'user', content: 'queued user text' },
        timestamp: '2026-05-22T10:00:01.000Z',
      }),
    ])

    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-mix' }) },
        messages: [{
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', content: 'result text' },
            { type: 'text', text: '<system-reminder>\ninjected banner\n</system-reminder>' },
            { type: 'text', text: 'queued user text' },
          ],
        }],
      },
      responseBody: undefined,
    })

    const toolRow = rows.filter((r) => r.message_id === 'u-mix-tr')
    assert.equal(toolRow.length, 1, 'tool_result matches its transcript line')
    assert.equal(toolRow[0].part_type, 'tool_result')

    const textRow = rows.filter((r) => r.message_id === 'u-mix-text')
    assert.equal(textRow.length, 1, 'real text alongside the tool_result is matched, not wire_only')
    assert.equal(textRow[0].content_text, 'queued user text')
    assert.notEqual(readAttrPath(textRow[0], ['attributes', 'claude'])?.wire_only, true, 'real text must not be marked wire_only')

    const wireOnly = rows.filter((r) => readAttrPath(r, ['attributes', 'claude'])?.wire_only === true)
    assert.equal(wireOnly.length, 1, 'only the injected reminder is wire_only')
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
    // projector stamps its own. Both must be present so the row is
    // unambiguous to operators querying by either marker.
    for (const row of rows) {
      const claude = readAttrPath(row, ['attributes', 'claude'])
      const gateway = readAttrPath(row, ['attributes', 'gateway'])
      assert.equal(claude?.identity_source, 'gateway_fallback')
      assert.equal(gateway?.identity_source, 'gateway_fallback')
      // LLP 0024: fallback rows carry the content match-key so flush-time
      // settlement can re-match them once the transcript lands.
      assert.equal(typeof claude?.match_key, 'string')
      assert.ok(String(claude.match_key).length > 0)
    }
  } finally {
    await env.cleanup()
  }
})

test('transcript-matched rows do NOT carry a settlement match_key', async () => {
  const env = await stageClaudeEnv()
  try {
    await writeTranscript(env, 'sess-nokey', [
      jsonlRow({
        sessionId: 'sess-nokey', uuid: 'u-nk', parentUuid: null, type: 'user',
        message: { role: 'user', content: 'hello' }, timestamp: '2026-05-22T10:00:00.000Z',
      }),
    ])
    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-nokey' }) },
        messages: [{ role: 'user', content: 'hello' }],
      },
      responseBody: undefined,
    })
    assert.equal(rows[0].message_id, 'u-nk')
    assert.equal(readAttrPath(rows[0], ['attributes', 'claude'])?.match_key, undefined)
  } finally {
    await env.cleanup()
  }
})

// Issue #106: aux traffic is TAGGED, not dropped. The prior behavior
// returned undefined (no rows) for the security monitor, silently losing
// real captured data. Now the exchange projects normally and every row
// carries attributes.claude.aux_kind so conversation queries can exclude
// it (aux_kind IS NULL) without dropping anything.
test('harness aux traffic (security monitor) is tagged with aux_kind, not dropped', async () => {
  const env = await stageClaudeEnv()
  try {
    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-aux' }) },
        system: 'You are a security monitor for autonomous AI coding agents.\n\n## Context\n…',
        messages: [{ role: 'user', content: '<transcript>…</transcript> judge this action' }],
      },
      responseBody: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'allow' }], stop_reason: 'end_turn' },
    })
    assert.ok(rows.length > 0, 'security-monitor requests must still produce rows (tag, do not drop)')
    for (const row of rows) {
      const claude = readAttrPath(row, ['attributes', 'claude'])
      assert.equal(claude?.aux_kind, 'security_monitor', 'every aux row must carry aux_kind = security_monitor')
    }
  } finally {
    await env.cleanup()
  }
})

test('ordinary conversation traffic carries no aux_kind', async () => {
  const env = await stageClaudeEnv()
  try {
    const rows = await projectViaGateway(env, {
      reqBody: {
        model: 'claude-3-opus',
        metadata: { user_id: JSON.stringify({ session_id: 'sess-normal' }) },
        system: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
        messages: [{ role: 'user', content: 'hello' }],
      },
      responseBody: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' },
    })
    assert.ok(rows.length > 0)
    for (const row of rows) {
      const claude = readAttrPath(row, ['attributes', 'claude'])
      assert.equal(claude?.aux_kind, undefined, 'a real turn must never be labeled aux')
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
 * The per-conversation directory of a first-party Desktop sandbox home (app
 * 1.40609.1), one level below the nested `.claude/projects` tree that
 * `claudeDesktop3pSessionRoots` reaches: staging here is what an attached
 * Desktop looks like on disk.
 *
 * @param {string} homeDir
 * @param {string} [sandboxId]  a second home stands for a conversation started
 *   after the root list was cached, which only an uncached re-sweep reaches
 * @param {string} [container]  the legacy `Claude-3p` container is the second
 *   root `claudeDesktop3pSessionRoots` names, so a home under it is always
 *   swept after one under `Claude`: the fixed order a scan-stop needs
 */
function desktop3pSandboxDir(homeDir, sandboxId = 'ghi789', container = 'Claude') {
  return path.join(
    homeDir, 'Library', 'Application Support', container,
    'local-agent-mode-sessions', '99990000', '00000000', `local_${sandboxId}`,
    '.claude', 'projects', 'sandbox-outputs'
  )
}

/**
 * A session with one subagent sidecar and nothing else, under `repoDir`. The
 * transcript files are empty: the scans only need a `<sessionId>.jsonl` to
 * resolve the session's directory.
 *
 * @param {string} repoDir
 * @param {string} sessionId
 * @param {string} toolUseId
 */
async function stageSidecar(repoDir, sessionId, toolUseId) {
  await fs.mkdir(path.join(repoDir, sessionId, 'subagents'), { recursive: true })
  await fs.writeFile(path.join(repoDir, `${sessionId}.jsonl`), '', 'utf8')
  await fs.writeFile(
    path.join(repoDir, sessionId, 'subagents', 'agent-sa1.meta.json'),
    JSON.stringify({ toolUseId }),
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

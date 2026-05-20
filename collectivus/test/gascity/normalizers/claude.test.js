import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CLAUDE_GATEWAY_ID, CLAUDE_PROVIDER, CLAUDE_SCHEMA_VERSION, claudeNormalize } from '../../../src/gascity/normalizers/claude.js'

/**
 * @import { SessionContext } from '../../../src/gascity/types.d.ts'
 * @import { NormalizedRow } from '../../../src/gascity/normalizers/types.d.ts'
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'gascity', 'claude')

/**
 * Build a SessionContext for tests with sensible defaults; overrides win.
 * @param {Partial<SessionContext>} [overrides]
 * @returns {SessionContext}
 */
function ctx(overrides = {}) {
  return {
    city: 'hyptown',
    sessionId: 'sess-test',
    template: 'desktop/test',
    rig: 'collectivus',
    alias: 'tester',
    conversationStartedAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * @param {string} name
 * @returns {Array<Record<string, unknown>>}
 */
function loadFixture(name) {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8')
  return raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l))
}

function allFixtureFiles() {
  return readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.jsonl'))
}

describe('claudeNormalize: fixture-driven coverage', () => {
  it('processes every fixture frame and produces at least one row each', () => {
    const files = allFixtureFiles()
    expect(files.length).toBeGreaterThan(0)
    let totalFrames = 0
    let totalRows = 0
    for (const file of files) {
      const frames = loadFixture(file)
      totalFrames += frames.length
      for (const frame of frames) {
        const rows = claudeNormalize(frame, ctx())
        expect(rows.length).toBeGreaterThan(0)
        totalRows += rows.length
      }
    }
    expect(totalFrames).toBeGreaterThanOrEqual(50)
    // Multi-block messages produce N rows per frame; rows should outpace frames.
    expect(totalRows).toBeGreaterThan(totalFrames)
  })

  it('stamps every row with the session context and constants', () => {
    for (const file of allFixtureFiles()) {
      for (const frame of loadFixture(file)) {
        const rows = claudeNormalize(frame, ctx())
        for (const row of rows) {
          expect(row.schema_version).toBe(CLAUDE_SCHEMA_VERSION)
          expect(row.provider).toBe(CLAUDE_PROVIDER)
          expect(row.gateway_id).toBe(CLAUDE_GATEWAY_ID)
          expect(row.city).toBe('hyptown')
          expect(row.gascity_template).toBe('desktop/test')
          expect(row.gascity_rig).toBe('collectivus')
          expect(row.gascity_alias).toBe('tester')
          expect(row.conversation_started_at).toBe('2026-05-14T00:00:00.000Z')
          expect(typeof row.message_created_at).toBe('string')
          expect(row.date).toBe(row.message_created_at.slice(0, 10))
          expect(row.raw_frame).toEqual(frame)
        }
      }
    }
  })

  it('covers every outer frame type that exists in the fixtures', () => {
    /** @type {Set<string>} */
    const seenPartTypes = new Set()
    for (const file of allFixtureFiles()) {
      for (const frame of loadFixture(file)) {
        for (const row of claudeNormalize(frame, ctx())) {
          seenPartTypes.add(row.part_type)
        }
      }
    }
    // All 9 outer frame types + 4 content-block types are exercised by the
    // fixture corpus. `unknown` should never appear because we have explicit
    // handlers for every documented frame shape.
    for (const expected of [
      'text', 'thinking', 'tool_use', 'tool_result',
      'attachment', 'last-prompt', 'permission-mode',
      'file-history-snapshot', 'queue-operation', 'ai-title', 'system',
    ]) {
      expect(seenPartTypes.has(expected)).toBe(true)
    }
  })
})

describe('claudeNormalize: assistant frames', () => {
  it('hoists message.* and usage onto every produced row', () => {
    const [frame] = loadFixture('assistant_text.jsonl')
    const rows = claudeNormalize(frame, ctx())
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row.part_type).toBe('text')
    expect(row.model).toBe('claude-opus-4-7')
    expect(row.message_id).toMatch(/^msg-/)
    expect(row.stop_reason).toBe('tool_use')
    expect(row.input_tokens).toBe(1)
    expect(row.output_tokens).toBe(974)
    expect(row.cache_creation_input_tokens).toBe(2329)
    expect(row.cache_read_input_tokens).toBe(42830)
    expect(row.ephemeral_1h_input_tokens).toBe(2329)
    expect(row.ephemeral_5m_input_tokens).toBe(0)
    expect(row.service_tier).toBe('standard')
    expect(row.speed).toBe('standard')
    expect(row.content_text).toMatch(/Deacon is healthy/)
  })

  it('captures thinking + signature on assistant:thinking frames', () => {
    const [frame] = loadFixture('assistant_thinking.jsonl')
    const rows = claudeNormalize(frame, ctx())
    expect(rows).toHaveLength(1)
    expect(rows[0].part_type).toBe('thinking')
    expect(typeof rows[0].thinking_signature).toBe('string')
    expect((rows[0].thinking_signature ?? '').length).toBeGreaterThan(0)
  })

  it('captures tool_use blocks with name + id + args + caller', () => {
    const frames = loadFixture('assistant_tool_use.jsonl')
    for (const frame of frames) {
      const rows = claudeNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('tool_use')
      expect(typeof row.tool_name).toBe('string')
      expect((row.tool_name ?? '').length).toBeGreaterThan(0)
      expect(row.tool_call_id).toMatch(/^tool-/)
      expect(row.tool_args).not.toBeNull()
      expect(row.caller_type).toBe('direct')
    }
  })

  it('produces one row per content block on multi-block assistant frames', () => {
    const frames = loadFixture('assistant_multi.jsonl')
    for (const frame of frames) {
      const message = /** @type {Record<string, unknown>} */ (frame.message ?? {})
      const blocks = /** @type {unknown[]} */ (message.content ?? [])
      const rows = claudeNormalize(frame, ctx())
      expect(rows).toHaveLength(blocks.length)
      // Distinct part_index 0..N-1, all sharing message_id + provider_uuid.
      const indices = rows.map((r) => r.part_index)
      expect([...indices].sort((a, b) => a - b)).toEqual([...Array(blocks.length).keys()])
      const messageIds = new Set(rows.map((r) => r.message_id))
      const providerUuids = new Set(rows.map((r) => r.provider_uuid))
      expect(messageIds.size).toBe(1)
      expect(providerUuids.size).toBe(1)
    }
  })
})

describe('claudeNormalize: user frames', () => {
  it('treats string-content as a single text row', () => {
    const frames = loadFixture('user_string.jsonl')
    for (const frame of frames) {
      const rows = claudeNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('text')
      expect(typeof row.content_text).toBe('string')
      // Bead-spec requirement: assistant-side hoist columns stay null on user rows.
      expect(row.model).toBeNull()
      expect(row.input_tokens).toBeNull()
    }
  })

  it('captures tool_result rows with tool_result_for + is_error', () => {
    const frames = loadFixture('user_tool_result_str.jsonl')
    for (const frame of frames) {
      const rows = claudeNormalize(frame, ctx())
      expect(rows.length).toBeGreaterThan(0)
      const tr = rows.find((r) => r.part_type === 'tool_result')
      expect(tr).toBeDefined()
      if (tr === undefined) return
      expect(tr.tool_result_for).toMatch(/^tool-/)
      expect(typeof tr.content_text).toBe('string')
      expect(typeof tr.is_error === 'boolean' || tr.is_error === null).toBe(true)
    }
  })

  it('flattens list-shaped tool_result content into content_text', () => {
    const frames = loadFixture('user_tool_result_list.jsonl')
    for (const frame of frames) {
      const rows = claudeNormalize(frame, ctx())
      const tr = rows.find((r) => r.part_type === 'tool_result')
      expect(tr).toBeDefined()
      if (tr === undefined) return
      // The flattening must preserve recognisable substrings from the original
      // sub-blocks so cross-source queries can grep for tool names / text.
      expect(typeof tr.content_text).toBe('string')
      expect((tr.content_text ?? '').length).toBeGreaterThan(0)
    }
  })

  it('links tool_result rows to their originating tool_use via tool_call_id', () => {
    // Build a fake conversation: one assistant frame with a tool_use, then a
    // user frame whose tool_result references the same `tool_use_id`.
    const assistantFrame = {
      type: 'assistant',
      uuid: 'a-1',
      sessionId: 'sess-test',
      timestamp: '2026-05-14T00:00:01.000Z',
      message: {
        id: 'msg-roundtrip',
        model: 'claude-opus-4-7',
        content: [{ type: 'tool_use', id: 'tool-link-1', name: 'Bash', input: { cmd: 'ls' } }],
      },
    }
    const userFrame = {
      type: 'user',
      uuid: 'u-1',
      sessionId: 'sess-test',
      timestamp: '2026-05-14T00:00:02.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-link-1', content: 'ok', is_error: false }],
      },
    }
    const [aRow] = claudeNormalize(assistantFrame, ctx())
    const [uRow] = claudeNormalize(userFrame, ctx())
    expect(aRow.tool_call_id).toBe('tool-link-1')
    expect(uRow.tool_result_for).toBe('tool-link-1')
    expect(uRow.tool_result_for).toBe(aRow.tool_call_id)
  })
})

describe('claudeNormalize: attachment frames', () => {
  it('captures hook_success with attachment_type + hook_event', () => {
    const frames = loadFixture('attachment_hook_success.jsonl')
    for (const frame of frames) {
      const rows = claudeNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('attachment')
      expect(row.attachment_type).toBe('hook_success')
      expect(typeof row.hook_event).toBe('string')
      expect((row.hook_event ?? '').length).toBeGreaterThan(0)
      // Content rendered into content_text (hook stdout / content field).
      expect(typeof row.content_text === 'string' || row.content_text === null).toBe(true)
    }
  })

  it('captures skill_listing with attachment_type=skill_listing', () => {
    const frames = loadFixture('attachment_skill_listing.jsonl')
    for (const frame of frames) {
      const rows = claudeNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      expect(rows[0].attachment_type).toBe('skill_listing')
    }
  })

  it('captures deferred_tools_delta, task_reminder, hook errors, edited files', () => {
    const buckets = [
      ['attachment_deferred_tools_delta.jsonl', 'deferred_tools_delta'],
      ['attachment_task_reminder.jsonl', 'task_reminder'],
      ['attachment_hook_non_blocking_error.jsonl', 'hook_non_blocking_error'],
      ['attachment_edited_text_file.jsonl', 'edited_text_file'],
    ]
    for (const [file, expectedType] of buckets) {
      const frames = loadFixture(file)
      for (const frame of frames) {
        const rows = claudeNormalize(frame, ctx())
        expect(rows).toHaveLength(1)
        expect(rows[0].attachment_type).toBe(expectedType)
      }
    }
  })
})

describe('claudeNormalize: low-frequency frame types', () => {
  it('produces a last-prompt row with leafUuid stashed in attributes', () => {
    for (const frame of loadFixture('last-prompt.jsonl')) {
      const rows = claudeNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('last-prompt')
      const attrs = /** @type {Record<string, unknown> | null} */ (row.attributes)
      expect(attrs).not.toBeNull()
      expect(attrs?.leafUuid).toMatch(/^uuid-/)
    }
  })

  it('produces a permission-mode row with new mode in content_text + permission_mode', () => {
    for (const frame of loadFixture('permission-mode.jsonl')) {
      const rows = claudeNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('permission-mode')
      expect(typeof row.content_text).toBe('string')
      expect(row.permission_mode).toBe(row.content_text)
    }
  })

  it('produces an ai-title row with the title in content_text', () => {
    for (const frame of loadFixture('ai-title.jsonl')) {
      const rows = claudeNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      expect(rows[0].part_type).toBe('ai-title')
      expect(typeof rows[0].content_text).toBe('string')
      expect((rows[0].content_text ?? '').length).toBeGreaterThan(0)
    }
  })

  it('produces a file-history-snapshot row with snapshot in attributes', () => {
    for (const frame of loadFixture('file-history-snapshot.jsonl')) {
      const rows = claudeNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      expect(rows[0].part_type).toBe('file-history-snapshot')
      const attrs = /** @type {Record<string, unknown>} */ (rows[0].attributes)
      expect(attrs).not.toBeNull()
      expect('snapshot' in attrs).toBe(true)
    }
  })

  it('produces a queue-operation row with operation + content in attributes', () => {
    for (const frame of loadFixture('queue-operation.jsonl')) {
      const rows = claudeNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('queue-operation')
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes)
      expect(typeof attrs?.operation).toBe('string')
      expect('content' in attrs).toBe(true)
    }
  })
})

describe('claudeNormalize: system frames', () => {
  it('produces system rows with subtype in attributes', () => {
    const buckets = [
      'system_stop_hook_summary.jsonl',
      'system_turn_duration.jsonl',
      'system_api_error.jsonl',
    ]
    for (const file of buckets) {
      for (const frame of loadFixture(file)) {
        const rows = claudeNormalize(frame, ctx())
        expect(rows).toHaveLength(1)
        const [row] = rows
        expect(row.part_type).toBe('system')
        const attrs = /** @type {Record<string, unknown>} */ (row.attributes)
        expect(typeof attrs?.subtype).toBe('string')
      }
    }
  })

  it('surfaces system.content on content_text when present', () => {
    for (const frame of loadFixture('system_away_summary.jsonl')) {
      const rows = claudeNormalize(frame, ctx())
      const [row] = rows
      expect(row.content_text).toBe(/** @type {Record<string, unknown>} */(frame).content)
    }
  })
})

describe('claudeNormalize: outer-frame hoist', () => {
  it('hoists cwd, gitBranch, version, entrypoint, isSidechain, permissionMode, prompt + request ids', () => {
    const frames = loadFixture('assistant_text.jsonl')
    for (const frame of frames) {
      const rows = claudeNormalize(frame, ctx())
      for (const row of rows) {
        expect(row.cwd).toBe(frame.cwd)
        expect(row.git_branch).toBe(frame.gitBranch)
        expect(row.client_version).toBe(frame.version)
        expect(row.entrypoint).toBe(frame.entrypoint)
        expect(row.is_sidechain).toBe(frame.isSidechain)
        expect(row.request_id).toBe(frame.requestId)
        expect(row.provider_uuid).toBe(frame.uuid)
        expect(row.parent_uuid).toBe(frame.parentUuid)
        expect(row.provider_session_id).toBe(frame.sessionId)
        expect(row.message_created_at).toBe(frame.timestamp)
      }
    }
  })

  it('surfaces sourceToolAssistantUUID on user/tool_result frames', () => {
    const frames = loadFixture('user_tool_result_str.jsonl')
    for (const frame of frames) {
      const rows = claudeNormalize(frame, ctx())
      for (const row of rows) {
        if (frame.sourceToolAssistantUUID !== undefined) {
          expect(row.source_tool_assistant_uuid).toBe(frame.sourceToolAssistantUUID)
        }
      }
    }
  })
})

describe('claudeNormalize: attributes overflow', () => {
  it('routes unmapped outer-frame keys into attributes (no silent data loss)', () => {
    const frame = {
      type: 'assistant',
      uuid: 'a-1',
      sessionId: 'sess-test',
      timestamp: '2026-05-14T00:00:01.000Z',
      message: { id: 'msg-1', content: [{ type: 'text', text: 'hi' }] },
      // a deliberately-unknown sibling key — must round-trip via attributes:
      futureField: { reportedBySupervisor: true, value: 42 },
      userType: 'external',
    }
    const [row] = claudeNormalize(frame, ctx())
    const attrs = /** @type {Record<string, unknown>} */ (row.attributes)
    expect(attrs).not.toBeNull()
    expect(attrs.futureField).toEqual({ reportedBySupervisor: true, value: 42 })
    expect(attrs.userType).toBe('external')
  })

  it('captures usage overflow (iterations, server_tool_use) in attributes.usage_overflow', () => {
    const [frame] = loadFixture('assistant_text.jsonl')
    const rows = claudeNormalize(frame, ctx())
    const attrs = /** @type {Record<string, unknown>} */ (rows[0].attributes)
    expect(attrs).not.toBeNull()
    const overflow = /** @type {Record<string, unknown>} */ (attrs.usage_overflow)
    expect(overflow).toBeDefined()
    expect('iterations' in overflow).toBe(true)
    expect('server_tool_use' in overflow).toBe(true)
  })

  it('keeps raw_frame identical to the input on every row', () => {
    for (const file of allFixtureFiles()) {
      for (const frame of loadFixture(file)) {
        for (const row of claudeNormalize(frame, ctx())) {
          expect(row.raw_frame).toEqual(frame)
        }
      }
    }
  })
})

describe('claudeNormalize: failure modes', () => {
  it('returns [] for non-object inputs without throwing', () => {
    expect(claudeNormalize(null, ctx())).toEqual([])
    expect(claudeNormalize(undefined, ctx())).toEqual([])
    expect(claudeNormalize('not a frame', ctx())).toEqual([])
    expect(claudeNormalize(42, ctx())).toEqual([])
    expect(claudeNormalize([], ctx())).toEqual([])
  })

  it('produces a passthrough row for unknown frame types (preserves raw_frame)', () => {
    const frame = { type: 'totally-novel-event', uuid: 'x', sessionId: 's', timestamp: '2026-05-14T00:00:00.000Z', payload: { a: 1 } }
    const rows = claudeNormalize(frame, ctx())
    expect(rows).toHaveLength(1)
    expect(rows[0].part_type).toBe('totally-novel-event')
    expect(rows[0].raw_frame).toEqual(frame)
    const attrs = /** @type {Record<string, unknown>} */ (rows[0].attributes)
    expect(attrs.unhandled_type).toBe('totally-novel-event')
  })

  it('handles malformed assistant frames (missing message) without crashing', () => {
    const frame = { type: 'assistant', uuid: 'x', sessionId: 's', timestamp: '2026-05-14T00:00:00.000Z' }
    const rows = claudeNormalize(frame, ctx())
    expect(rows).toHaveLength(1)
    // No content blocks -> single fallback row.
    expect(rows[0].provider_uuid).toBe('x')
  })

  it('falls back to ctx.sessionId when the frame lacks one', () => {
    const frame = { type: 'ai-title', aiTitle: 'orphan' }
    const [row] = claudeNormalize(frame, ctx({ sessionId: 'fallback-sess' }))
    expect(row.provider_session_id).toBe('fallback-sess')
    expect(row.gascity_session_id).toBe('fallback-sess')
  })

  it('defaults conversation_started_at to null when ctx has none', () => {
    const frame = { type: 'ai-title', aiTitle: 't' }
    const [row] = claudeNormalize(frame, ctx({ conversationStartedAt: undefined }))
    expect(row.conversation_started_at).toBeNull()
  })

  it('coerces numeric usage values that arrive as strings', () => {
    const frame = {
      type: 'assistant',
      uuid: 'a-1',
      sessionId: 's',
      timestamp: '2026-05-14T00:00:00.000Z',
      message: {
        id: 'msg-1',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: '5', output_tokens: 7, cache_read_input_tokens: 'not-a-number' },
      },
    }
    const [row] = claudeNormalize(frame, ctx())
    expect(row.input_tokens).toBe(5)
    expect(row.output_tokens).toBe(7)
    expect(row.cache_read_input_tokens).toBeNull()
  })
})

describe('claudeNormalize: round-trip identity check', () => {
  it('preserves every documented field on the round trip', () => {
    // Hand-crafted frame that exercises every column. Any silent data loss in
    // the normalizer should surface as a `toBe` mismatch below.
    const frame = {
      type: 'assistant',
      uuid: 'uuid-rt-1',
      parentUuid: 'uuid-rt-0',
      sessionId: 'sess-rt',
      timestamp: '2026-05-14T01:02:03.456Z',
      cwd: '/fixtures/rt-cwd',
      gitBranch: 'feat/rt',
      permissionMode: 'default',
      isSidechain: true,
      entrypoint: 'cli',
      version: '2.1.999',
      promptId: 'prompt-rt',
      requestId: 'req-rt-1',
      sourceToolAssistantUUID: 'uuid-rt-source',
      message: {
        id: 'msg-rt-1',
        role: 'assistant',
        model: 'claude-opus-4-7',
        stop_reason: 'end_turn',
        stop_details: { ended: true, reason: 'manual' },
        content: [
          { type: 'text', text: 'hello' },
          { type: 'thinking', thinking: 'pondering', signature: 'sig-rt' },
          { type: 'tool_use', id: 'tool-rt', name: 'Bash', input: { command: 'echo' }, caller: { type: 'subagent' } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
          service_tier: 'priority',
          inference_geo: 'us-west',
          speed: 'standard',
          cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 60 },
          iterations: [{ output_tokens: 20 }],
        },
      },
    }
    const rows = claudeNormalize(frame, ctx({
      city: 'rt-city',
      sessionId: 'sess-rt',
      template: 'desktop/rt',
      rig: 'rt-rig',
      alias: 'rt-alias',
      conversationStartedAt: '2026-05-14T01:00:00.000Z',
    }))
    expect(rows).toHaveLength(3)
    // Shared fields across all rows.
    for (const row of rows) {
      expect(row.provider).toBe('claude')
      expect(row.gateway_id).toBe('gascity-scribe')
      expect(row.schema_version).toBe(1)
      expect(row.city).toBe('rt-city')
      expect(row.gascity_template).toBe('desktop/rt')
      expect(row.gascity_rig).toBe('rt-rig')
      expect(row.gascity_alias).toBe('rt-alias')
      expect(row.provider_session_id).toBe('sess-rt')
      expect(row.gascity_session_id).toBe('sess-rt')
      expect(row.provider_uuid).toBe('uuid-rt-1')
      expect(row.parent_uuid).toBe('uuid-rt-0')
      expect(row.source_tool_assistant_uuid).toBe('uuid-rt-source')
      expect(row.message_id).toBe('msg-rt-1')
      expect(row.model).toBe('claude-opus-4-7')
      expect(row.stop_reason).toBe('end_turn')
      expect(row.stop_details).toEqual({ ended: true, reason: 'manual' })
      expect(row.cwd).toBe('/fixtures/rt-cwd')
      expect(row.git_branch).toBe('feat/rt')
      expect(row.permission_mode).toBe('default')
      expect(row.is_sidechain).toBe(true)
      expect(row.entrypoint).toBe('cli')
      expect(row.client_version).toBe('2.1.999')
      expect(row.prompt_id).toBe('prompt-rt')
      expect(row.request_id).toBe('req-rt-1')
      expect(row.message_created_at).toBe('2026-05-14T01:02:03.456Z')
      expect(row.date).toBe('2026-05-14')
      expect(row.conversation_started_at).toBe('2026-05-14T01:00:00.000Z')
      expect(row.input_tokens).toBe(10)
      expect(row.output_tokens).toBe(20)
      expect(row.cache_creation_input_tokens).toBe(30)
      expect(row.cache_read_input_tokens).toBe(40)
      expect(row.ephemeral_5m_input_tokens).toBe(50)
      expect(row.ephemeral_1h_input_tokens).toBe(60)
      expect(row.service_tier).toBe('priority')
      expect(row.inference_geo).toBe('us-west')
      expect(row.speed).toBe('standard')
      expect(row.raw_frame).toEqual(frame)
    }
    // Per-block fields.
    expect(rows[0].part_type).toBe('text')
    expect(rows[0].part_index).toBe(0)
    expect(rows[0].content_text).toBe('hello')
    expect(rows[1].part_type).toBe('thinking')
    expect(rows[1].part_index).toBe(1)
    expect(rows[1].content_text).toBe('pondering')
    expect(rows[1].thinking_signature).toBe('sig-rt')
    expect(rows[2].part_type).toBe('tool_use')
    expect(rows[2].part_index).toBe(2)
    expect(rows[2].tool_name).toBe('Bash')
    expect(rows[2].tool_call_id).toBe('tool-rt')
    expect(rows[2].tool_args).toEqual({ command: 'echo' })
    expect(rows[2].caller_type).toBe('subagent')
  })
})

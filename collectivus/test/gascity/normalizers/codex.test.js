import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CODEX_GATEWAY_ID, CODEX_PROVIDER, CODEX_SCHEMA_VERSION, codexNormalize } from '../../../src/gascity/normalizers/codex.js'

/**
 * @import { SessionContext } from '../../../src/gascity/types.d.ts'
 * @import { NormalizedRow } from '../../../src/gascity/normalizers/types.d.ts'
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'gascity', 'codex')

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

describe('codexNormalize: fixture-driven coverage', () => {
  it('processes every fixture frame and produces at least one row each', () => {
    const files = allFixtureFiles()
    expect(files.length).toBeGreaterThan(0)
    let totalFrames = 0
    let totalRows = 0
    for (const file of files) {
      const frames = loadFixture(file)
      totalFrames += frames.length
      for (const frame of frames) {
        const rows = codexNormalize(frame, ctx())
        expect(rows.length).toBeGreaterThan(0)
        totalRows += rows.length
      }
    }
    // Bead spec requires at least 20 sanitized fixtures.
    expect(totalFrames).toBeGreaterThanOrEqual(20)
    // Multi-block user/developer messages produce N rows per frame; rows
    // should outpace frames whenever any multi-block fixture is included.
    expect(totalRows).toBeGreaterThanOrEqual(totalFrames)
  })

  it('stamps every row with the session context and constants', () => {
    for (const file of allFixtureFiles()) {
      for (const frame of loadFixture(file)) {
        const rows = codexNormalize(frame, ctx())
        for (const row of rows) {
          expect(row.schema_version).toBe(CODEX_SCHEMA_VERSION)
          expect(row.provider).toBe(CODEX_PROVIDER)
          expect(row.gateway_id).toBe(CODEX_GATEWAY_ID)
          expect(row.city).toBe('hyptown')
          expect(row.gascity_template).toBe('desktop/test')
          expect(row.gascity_rig).toBe('collectivus')
          expect(row.gascity_alias).toBe('tester')
          expect(row.gascity_session_id).toBe('sess-test')
          expect(row.provider_session_id).toBe('sess-test')
          expect(row.conversation_started_at).toBe('2026-05-14T00:00:00.000Z')
          expect(typeof row.message_created_at).toBe('string')
          expect(row.date).toBe(row.message_created_at.slice(0, 10))
          expect(row.raw_frame).toEqual(frame)
          expect(typeof row.provider_uuid).toBe('string')
          expect(row.provider_uuid.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('covers every documented part_type across the fixture corpus', () => {
    /** @type {Set<string>} */
    const seenPartTypes = new Set()
    for (const file of allFixtureFiles()) {
      for (const frame of loadFixture(file)) {
        for (const row of codexNormalize(frame, ctx())) {
          seenPartTypes.add(row.part_type)
        }
      }
    }
    // The Codex normalizer extends the part_type vocabulary; these are the
    // documented values (see codex.js header + schema doc). `unknown`
    // should never appear: any unmapped frame type lands on its raw
    // `type` string as part_type, not `unknown`.
    for (const expected of [
      // Claude-shared
      'text', 'thinking', 'tool_use', 'tool_result',
      // Codex-specific frame types
      'session_meta', 'turn_context',
      // Codex-specific event types
      'agent_message', 'user_message', 'task_started', 'task_complete',
      'token_count', 'patch_apply_end', 'context_compacted', 'item_completed',
      'compacted',
    ]) {
      expect(seenPartTypes.has(expected)).toBe(true)
    }
  })
})

describe('codexNormalize: response_item.message frames', () => {
  it('captures assistant output_text into content_text', () => {
    const frames = loadFixture('message_assistant.jsonl')
    for (const frame of frames) {
      const rows = codexNormalize(frame, ctx())
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.part_type).toBe('text')
        expect(typeof row.content_text).toBe('string')
        expect((row.content_text ?? '').length).toBeGreaterThan(0)
        const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
        expect(attrs.role).toBe('assistant')
        // Codex assistant messages carry `phase: commentary|final_answer`.
        expect(typeof attrs.phase === 'string' || attrs.phase === null).toBe(true)
      }
    }
  })

  it('captures user input_text blocks (one row per block when multi-block)', () => {
    const frames = loadFixture('message_user.jsonl')
    for (const frame of frames) {
      const payload = /** @type {Record<string, unknown>} */ (frame.payload ?? {})
      const blocks = /** @type {unknown[]} */ (payload.content ?? [])
      const rows = codexNormalize(frame, ctx())
      expect(rows.length).toBe(blocks.length)
      for (const row of rows) {
        expect(row.part_type).toBe('text')
        const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
        expect(attrs.role).toBe('user')
      }
      // Distinct part_index 0..N-1.
      const indices = rows.map((r) => r.part_index).sort((a, b) => a - b)
      expect(indices).toEqual([...Array(blocks.length).keys()])
    }
  })

  it('captures developer messages with role=developer in attributes', () => {
    const frames = loadFixture('message_developer.jsonl')
    for (const frame of frames) {
      const rows = codexNormalize(frame, ctx())
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.part_type).toBe('text')
        const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
        expect(attrs.role).toBe('developer')
      }
    }
  })
})

describe('codexNormalize: response_item.function_call frames', () => {
  it('captures function_call with parsed tool_args and call_id', () => {
    const frames = loadFixture('function_call.jsonl')
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      const rows = codexNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('tool_use')
      expect(row.tool_name).toBe('exec_command')
      expect(row.tool_call_id).toMatch(/^call-/)
      // arguments is a JSON string in the wire format; the normalizer
      // parses it so analysts can use json_value(tool_args, '$.cmd').
      expect(typeof row.tool_args).toBe('object')
      const args = /** @type {Record<string, unknown>} */ (row.tool_args)
      expect(typeof args.cmd).toBe('string')
      expect(typeof args.workdir).toBe('string')
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect(attrs.tool_call_variant).toBe('function_call')
      expect(attrs.original_args_form).toBe('string')
      expect(typeof attrs.raw_args).toBe('string')
    }
  })

  it('captures function_call_output linked back to tool_call_id', () => {
    const calls = loadFixture('function_call.jsonl')
    const outputs = loadFixture('function_call_output.jsonl')
    expect(outputs.length).toBeGreaterThan(0)
    const callIds = new Set(calls.map((c) => /** @type {Record<string, unknown>} */ (c.payload ?? {}).call_id))
    for (const frame of outputs) {
      const rows = codexNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('tool_result')
      expect(row.tool_result_for).toMatch(/^call-/)
      expect(typeof row.content_text).toBe('string')
      // Outputs link back to their originating function_call's call_id —
      // exercises the cross-frame linkage spec.
      expect(callIds.has(row.tool_result_for)).toBe(true)
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect(attrs.tool_call_variant).toBe('function_call_output')
    }
  })

  it('detects exit_code != 0 in exec_command output as is_error=true', () => {
    // Construct a synthetic exec_command output with non-zero exit code.
    // exec_command wraps its result as `{"output":"...","metadata":{"exit_code":N}}`.
    const errFrame = {
      timestamp: '2026-05-14T20:31:31.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-err',
        output: JSON.stringify({
          output: 'no such file or directory',
          metadata: { exit_code: 1, duration_seconds: 0.01 },
        }),
      },
    }
    const okFrame = {
      timestamp: '2026-05-14T20:31:31.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-ok',
        output: JSON.stringify({
          output: 'all good',
          metadata: { exit_code: 0, duration_seconds: 0.01 },
        }),
      },
    }
    const [errRow] = codexNormalize(errFrame, ctx())
    const [okRow] = codexNormalize(okFrame, ctx())
    expect(errRow.is_error).toBe(true)
    expect(okRow.is_error).toBe(false)
  })
})

describe('codexNormalize: response_item.custom_tool_call frames', () => {
  it('captures custom_tool_call with raw input preserved when not JSON', () => {
    const frames = loadFixture('custom_tool_call.jsonl')
    for (const frame of frames) {
      const rows = codexNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('tool_use')
      // apply_patch's input is a free-form string starting with `*** Begin Patch`,
      // not JSON. The normalizer keeps it as-is (parseToolArgs returns it
      // verbatim because the first char isn't `{` or `[`).
      expect(typeof row.tool_args).toBe('string')
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect(attrs.tool_call_variant).toBe('custom_tool_call')
      expect(attrs.original_args_form).toBe('string')
    }
  })

  it('captures custom_tool_call_output linked to its call_id', () => {
    const frames = loadFixture('custom_tool_call_output.jsonl')
    for (const frame of frames) {
      const rows = codexNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('tool_result')
      expect(row.tool_result_for).toMatch(/^call-/)
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect(attrs.tool_call_variant).toBe('custom_tool_call_output')
    }
  })
})

describe('codexNormalize: response_item.reasoning frames', () => {
  it('preserves encrypted_content in attributes and renders summary into content_text when present', () => {
    const frames = loadFixture('reasoning.jsonl')
    for (const frame of frames) {
      const rows = codexNormalize(frame, ctx())
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row.part_type).toBe('thinking')
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      // Codex reasoning is encrypted-by-default; the blob lives in attributes.
      expect(typeof attrs.encrypted_content).toBe('string')
      expect((attrs.encrypted_content ?? '').toString().length).toBeGreaterThan(0)
    }
  })

  it('falls back to summary when content is null', () => {
    /** @type {Record<string, unknown>} */
    const frame = {
      timestamp: '2026-05-14T20:31:31.500Z',
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: [
          { type: 'summary_text', text: 'Considering options A and B.' },
          { type: 'summary_text', text: 'B is better because.' },
        ],
        content: null,
        encrypted_content: 'enc-blob',
      },
    }
    const [row] = codexNormalize(frame, ctx())
    expect(row.part_type).toBe('thinking')
    expect(row.content_text).toBe('Considering options A and B.\nB is better because.')
  })
})

describe('codexNormalize: event_msg frames', () => {
  it('captures agent_message events with phase in attributes', () => {
    const frames = loadFixture('event_agent_message.jsonl')
    for (const frame of frames) {
      const [row] = codexNormalize(frame, ctx())
      expect(row.part_type).toBe('agent_message')
      expect(typeof row.content_text).toBe('string')
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect(typeof attrs.phase === 'string' || attrs.phase === null).toBe(true)
    }
  })

  it('captures user_message events with raw text preserved', () => {
    const frames = loadFixture('event_user_message.jsonl')
    for (const frame of frames) {
      const [row] = codexNormalize(frame, ctx())
      expect(row.part_type).toBe('user_message')
      expect(typeof row.content_text).toBe('string')
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect('images' in attrs).toBe(true)
    }
  })

  it('captures task_started + task_complete lifecycle with turn_id linkage', () => {
    const starts = loadFixture('event_task_started.jsonl')
    const completes = loadFixture('event_task_complete.jsonl')
    expect(starts.length).toBeGreaterThan(0)
    expect(completes.length).toBeGreaterThan(0)
    for (const frame of starts) {
      const [row] = codexNormalize(frame, ctx())
      expect(row.part_type).toBe('task_started')
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect(typeof attrs.turn_id).toBe('string')
      expect(typeof attrs.model_context_window).toBe('number')
    }
    for (const frame of completes) {
      const [row] = codexNormalize(frame, ctx())
      expect(row.part_type).toBe('task_complete')
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect(typeof attrs.turn_id).toBe('string')
      expect(typeof attrs.duration_ms).toBe('number')
    }
  })

  it('hoists token_count.last_token_usage onto Claude-shaped token columns', () => {
    const frames = loadFixture('event_token_count.jsonl')
    let withInfo = 0
    for (const frame of frames) {
      const [row] = codexNormalize(frame, ctx())
      expect(row.part_type).toBe('token_count')
      const payload = /** @type {Record<string, unknown>} */ (frame.payload ?? {})
      if (payload.info !== null && payload.info !== undefined) {
        withInfo += 1
        expect(typeof row.input_tokens).toBe('number')
        expect(typeof row.output_tokens).toBe('number')
        // cached_input_tokens maps to Claude's cache_read column.
        expect(typeof row.cache_read_input_tokens).toBe('number')
      } else {
        expect(row.input_tokens).toBeNull()
        expect(row.output_tokens).toBeNull()
        expect(row.cache_read_input_tokens).toBeNull()
      }
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      // Rate limits always preserved.
      expect(attrs.rate_limits).not.toBeNull()
    }
    expect(withInfo).toBeGreaterThanOrEqual(1)
  })

  it('captures patch_apply_end as a tool_result-shaped row with is_error inverted from success', () => {
    const frames = loadFixture('event_patch_apply_end.jsonl')
    for (const frame of frames) {
      const [row] = codexNormalize(frame, ctx())
      expect(row.part_type).toBe('patch_apply_end')
      expect(row.tool_result_for).toMatch(/^call-/)
      const payload = /** @type {Record<string, unknown>} */ (frame.payload ?? {})
      if (typeof payload.success === 'boolean') {
        expect(row.is_error).toBe(!payload.success)
      } else {
        expect(row.is_error).toBeNull()
      }
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect('changes' in attrs).toBe(true)
    }
  })

  it('captures context_compacted markers', () => {
    const frames = loadFixture('event_context_compacted.jsonl')
    for (const frame of frames) {
      const [row] = codexNormalize(frame, ctx())
      expect(row.part_type).toBe('context_compacted')
    }
  })

  it('captures item_completed with item payload in attributes', () => {
    const frames = loadFixture('event_item_completed.jsonl')
    for (const frame of frames) {
      const [row] = codexNormalize(frame, ctx())
      expect(row.part_type).toBe('item_completed')
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect(typeof attrs.thread_id).toBe('string')
      expect(typeof attrs.turn_id).toBe('string')
      expect(attrs.item).not.toBeNull()
    }
  })
})

describe('codexNormalize: session_meta + turn_context frames', () => {
  it('hoists session_meta cwd / git.branch / cli_version / source onto typed columns', () => {
    const [frame] = loadFixture('session_meta.jsonl')
    const [row] = codexNormalize(frame, ctx())
    expect(row.part_type).toBe('session_meta')
    expect(row.cwd).toBe('/sandbox/beads')
    expect(row.git_branch).toBe('main')
    expect(row.client_version).toBe('0.130.0')
    expect(row.entrypoint).toBe('cli')
    const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
    expect(typeof attrs.session_payload_id).toBe('string')
    expect(attrs.model_provider).toBe('openai')
  })

  it('hoists turn_context.model + cwd; policy blocks land in attributes', () => {
    const frames = loadFixture('turn_context.jsonl')
    for (const frame of frames) {
      const [row] = codexNormalize(frame, ctx())
      expect(row.part_type).toBe('turn_context')
      expect(typeof row.model).toBe('string')
      expect(typeof row.cwd).toBe('string')
      // Codex's permission_mode has no Claude analog — leave NULL per spec.
      expect(row.permission_mode).toBeNull()
      const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
      expect(attrs.approval_policy).not.toBeNull()
      expect(typeof attrs.turn_id).toBe('string')
    }
  })
})

describe('codexNormalize: compacted frames', () => {
  it('preserves replacement_history under attributes', () => {
    const [frame] = loadFixture('compacted.jsonl')
    const [row] = codexNormalize(frame, ctx())
    expect(row.part_type).toBe('compacted')
    const attrs = /** @type {Record<string, unknown>} */ (row.attributes ?? {})
    expect(attrs.replacement_history).not.toBeNull()
    expect(Array.isArray(attrs.replacement_history)).toBe(true)
  })
})

describe('codexNormalize: tool linkage round-trip', () => {
  it('function_call.call_id matches function_call_output.tool_result_for', () => {
    // Build a real-shape pair from the fixtures so the linkage is exercised
    // against actual on-wire structure (not just synthetic data).
    const callFrame = loadFixture('function_call.jsonl')[0]
    const outputFrame = loadFixture('function_call_output.jsonl')[0]
    const [callRow] = codexNormalize(callFrame, ctx())
    const [outRow] = codexNormalize(outputFrame, ctx())
    expect(callRow.tool_call_id).toMatch(/^call-/)
    expect(outRow.tool_result_for).toMatch(/^call-/)
    // The fixture builder mapped call ids deterministically — callFrame[0]
    // and outputFrame[0] reference the same call.
    expect(outRow.tool_result_for).toBe(callRow.tool_call_id)
  })

  it('custom_tool_call.call_id matches custom_tool_call_output.tool_result_for', () => {
    const callFrame = loadFixture('custom_tool_call.jsonl')[0]
    const outputFrame = loadFixture('custom_tool_call_output.jsonl')[0]
    const [callRow] = codexNormalize(callFrame, ctx())
    const [outRow] = codexNormalize(outputFrame, ctx())
    expect(callRow.tool_call_id).toMatch(/^call-/)
    expect(outRow.tool_result_for).toBe(callRow.tool_call_id)
  })
})

describe('codexNormalize: provider_uuid + dedup', () => {
  it('synthesizes a stable content-hash uuid per frame; same frame → same uuid', () => {
    const [frame] = loadFixture('function_call.jsonl')
    const [first] = codexNormalize(frame, ctx())
    const [second] = codexNormalize(frame, ctx())
    expect(first.provider_uuid).toBe(second.provider_uuid)
    expect(first.provider_uuid).toMatch(/^[0-9a-f]{40}$/) // sha1 hex
  })

  it('different frames produce different provider_uuids', () => {
    const frames = loadFixture('function_call.jsonl')
    expect(frames.length).toBeGreaterThanOrEqual(2)
    const [a] = codexNormalize(frames[0], ctx())
    const [b] = codexNormalize(frames[1], ctx())
    expect(a.provider_uuid).not.toBe(b.provider_uuid)
  })

  it('multi-block frames produce N rows sharing provider_uuid with distinct part_index (mirrors Claude)', () => {
    const frames = loadFixture('message_user.jsonl')
    const multiBlock = frames.find((f) => {
      const p = /** @type {Record<string, unknown>} */ (f.payload ?? {})
      const c = /** @type {unknown[]} */ (p.content ?? [])
      return c.length > 1
    })
    if (multiBlock === undefined) {
      // Not every captured session has a multi-block user message; skip
      // gracefully rather than failing on a corpus-dependent expectation.
      return
    }
    const rows = codexNormalize(multiBlock, ctx())
    expect(rows.length).toBeGreaterThan(1)
    const uuids = new Set(rows.map((r) => r.provider_uuid))
    expect(uuids.size).toBe(1)
    const indices = rows.map((r) => r.part_index).sort((a, b) => a - b)
    expect(indices).toEqual([...Array(rows.length).keys()])
  })
})

describe('codexNormalize: failure modes', () => {
  it('returns [] for non-object frames', () => {
    expect(codexNormalize(null, ctx())).toEqual([])
    expect(codexNormalize(undefined, ctx())).toEqual([])
    expect(codexNormalize(42, ctx())).toEqual([])
    expect(codexNormalize('not a frame', ctx())).toEqual([])
    expect(codexNormalize([], ctx())).toEqual([])
  })

  it('routes unknown outer types to a single row with the type preserved as part_type', () => {
    const frame = {
      timestamp: '2026-05-14T20:31:31.500Z',
      type: 'mystery_type',
      payload: { whatever: true },
    }
    const rows = codexNormalize(frame, ctx())
    expect(rows).toHaveLength(1)
    expect(rows[0].part_type).toBe('mystery_type')
    const attrs = /** @type {Record<string, unknown>} */ (rows[0].attributes ?? {})
    expect(attrs.unhandled_type).toBe('mystery_type')
  })

  it('routes unknown response_item.payload.type to a single row', () => {
    const frame = {
      timestamp: '2026-05-14T20:31:31.500Z',
      type: 'response_item',
      payload: { type: 'mystery_item', whatever: true },
    }
    const rows = codexNormalize(frame, ctx())
    expect(rows).toHaveLength(1)
    expect(rows[0].part_type).toBe('mystery_item')
    const attrs = /** @type {Record<string, unknown>} */ (rows[0].attributes ?? {})
    expect(attrs.unhandled_item_type).toBe('mystery_item')
  })

  it('handles message frames with no content array', () => {
    const frame = {
      timestamp: '2026-05-14T20:31:31.500Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant' },
    }
    const rows = codexNormalize(frame, ctx())
    expect(rows).toHaveLength(1)
    expect(rows[0].part_type).toBe('text')
  })

  it('handles function_call with non-JSON arguments string', () => {
    const frame = {
      timestamp: '2026-05-14T20:31:31.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'something',
        arguments: 'not json at all',
        call_id: 'call-xyz',
      },
    }
    const [row] = codexNormalize(frame, ctx())
    expect(row.part_type).toBe('tool_use')
    expect(row.tool_args).toBe('not json at all')
  })

  it('synthesizes a 1970-epoch timestamp when frame.timestamp is missing', () => {
    const frame = {
      type: 'event_msg',
      payload: { type: 'context_compacted' },
    }
    const [row] = codexNormalize(frame, ctx())
    expect(row.message_created_at).toBe('1970-01-01T00:00:00.000Z')
    expect(row.date).toBe('1970-01-01')
  })

  it('falls back to "unknown" part_type when type is missing', () => {
    const frame = {
      timestamp: '2026-05-14T20:31:31.500Z',
      payload: { type: 'message' },
    }
    const [row] = codexNormalize(frame, ctx())
    expect(row.part_type).toBe('unknown')
  })
})

describe('codexNormalize: round-trip preservation', () => {
  it('every fixture row preserves raw_frame verbatim and emits a queryable part_type', () => {
    for (const file of allFixtureFiles()) {
      for (const frame of loadFixture(file)) {
        for (const row of codexNormalize(frame, ctx())) {
          expect(row.raw_frame).toEqual(frame)
          expect(row.part_type).not.toBe('unknown')
        }
      }
    }
  })
})

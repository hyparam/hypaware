import { describe, expect, it } from 'vitest'
import {
  computeMessageId,
  extractMessageParts,
  mapFinishReason,
  mapPartType,
} from '../../src/cli/messages-parquet.js'

/**
 * Minimal context for unit-level decomposition. Conversation state is fixed;
 * the only thing tests vary is the message and its content blocks.
 *
 * @param {Partial<import('../../src/cli/messages-parquet.js').MessagePartsContext>} [overrides]
 * @returns {import('../../src/cli/messages-parquet.js').MessagePartsContext}
 */
function ctx(overrides) {
  return {
    conversation_id: 'conv-aaaa',
    conversation_started_at: '2026-05-13T10:00:00.000Z',
    conversation_source: 'api',
    user_id: 'acct-test-0001',
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    system_text: undefined,
    tools: undefined,
    message_index: 0,
    previous_message_id: undefined,
    message_created_at: '2026-05-13T10:00:00.000Z',
    tool_call_lookup: new Map(),
    ...overrides,
  }
}

describe('extractMessageParts', function() {
  it('decomposes a non-streaming user→assistant text exchange into two part rows', function() {
    const userMessage = { role: 'user', content: 'What is 2+2?' }
    const assistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '2+2 is 4.' }],
      stop_reason: 'end_turn',
    }
    const userRows = extractMessageParts(undefined, userMessage, ctx({ message_index: 0 }))
    const assistantRows = extractMessageParts(undefined, assistantMessage, ctx({
      message_index: 1,
      previous_message_id: /** @type {string} */ (userRows[0].message_id),
    }))
    expect(userRows).toHaveLength(1)
    expect(assistantRows).toHaveLength(1)
    expect(userRows[0]).toMatchObject({
      role: 'user', part_index: 0, part_type: 'text', content_text: 'What is 2+2?',
    })
    expect(assistantRows[0]).toMatchObject({
      role: 'assistant', part_index: 0, part_type: 'text', content_text: '2+2 is 4.',
    })
    expect(assistantRows[0].status).toMatchObject({ finish_reason: 'stop' })
  })

  it('emits one row per content block in order with part_index', function() {
    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'block one' },
        { type: 'text', text: 'block two' },
        { type: 'text', text: 'block three' },
      ],
      stop_reason: 'end_turn',
    }
    const rows = extractMessageParts(undefined, message, ctx())
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.part_index)).toEqual([0, 1, 2])
    expect(rows.map((r) => r.content_text)).toEqual(['block one', 'block two', 'block three'])
    expect(rows.map((r) => r.part_id)).toEqual([
      `${rows[0].message_id}#0`, `${rows[0].message_id}#1`, `${rows[0].message_id}#2`,
    ])
    // finish_reason lives on the last assistant part only
    expect(rows[0].status).toBeUndefined()
    expect(rows[1].status).toBeUndefined()
    expect(rows[2].status).toMatchObject({ finish_reason: 'stop' })
  })

  it('preserves thinking signature verbatim on reasoning rows', function() {
    const message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I need to plan this.', signature: 'sig-abc-DEF-123==' },
        { type: 'text', text: 'Here is my answer.' },
      ],
      stop_reason: 'end_turn',
    }
    const rows = extractMessageParts(undefined, message, ctx())
    expect(rows[0].part_type).toBe('reasoning')
    expect(rows[0].thinking_signature).toBe('sig-abc-DEF-123==')
    expect(rows[0].content_text).toBe('I need to plan this.')
    expect(rows[1].thinking_signature).toBeUndefined()
  })

  it('emits tool_call rows with tool_name, tool_call_id, and tool_args populated', function() {
    const message = {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_abc',
        name: 'get_weather',
        input: { city: 'Paris' },
      }],
      stop_reason: 'tool_use',
    }
    const rows = extractMessageParts(undefined, message, ctx())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      part_type: 'tool_call',
      tool_name: 'get_weather',
      tool_call_id: 'toolu_abc',
      tool_args: { city: 'Paris' },
      content_text: undefined,
    })
    expect(rows[0].status).toMatchObject({ finish_reason: 'tool_use' })
  })

  it('emits tool_result rows with linked tool_call_id and string content', function() {
    const lookup = new Map([['toolu_abc', { tool_name: 'get_weather' }]])
    const message = {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_abc',
        content: 'sunny, 22C',
      }],
    }
    const rows = extractMessageParts(undefined, message, ctx({ tool_call_lookup: lookup }))
    expect(rows[0]).toMatchObject({
      part_type: 'tool_result',
      tool_call_id: 'toolu_abc',
      tool_name: 'get_weather',
      content_text: 'sunny, 22C',
    })
    expect(rows[0].status).toMatchObject({ tool_status: 'success' })
  })

  it('flags tool_result with is_error=true as tool_status="error"', function() {
    const lookup = new Map([['toolu_abc', { tool_name: 'get_weather' }]])
    const message = {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_abc',
        content: 'rate limited',
        is_error: true,
      }],
    }
    const rows = extractMessageParts(undefined, message, ctx({ tool_call_lookup: lookup }))
    expect(rows[0].status).toMatchObject({ tool_status: 'error' })
  })

  it('stringifies array-form tool_result content by joining text parts', function() {
    const message = {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_xyz',
        content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
      }],
    }
    const rows = extractMessageParts(undefined, message, ctx())
    expect(rows[0].content_text).toBe('line one\nline two')
  })

  it('normalises string content into a single text block', function() {
    const message = { role: 'user', content: 'hello' }
    const rows = extractMessageParts(undefined, message, ctx())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ part_type: 'text', content_text: 'hello' })
  })

  it('adds Claude local context as top-level columns and nested client attributes', function() {
    const rows = extractMessageParts(undefined, { role: 'user', content: 'hello' }, ctx({
      cwd: '/repo/app',
      git_branch: 'main',
      claude_version: '2.1.141',
    }))
    expect(rows[0]).toMatchObject({
      schema_version: 3,
      cwd: '/repo/app',
      git_branch: 'main',
      client_version: '2.1.141',
      attributes: { client: { claude_version: '2.1.141' } },
    })
  })

  it('hoists matched Claude transcript metadata into typed columns', function() {
    const rows = extractMessageParts(undefined, { id: 'msg-local', role: 'assistant', content: 'hello' }, ctx({
      claude_transcript: {
        provider_uuid: 'uuid-assistant',
        parent_uuid: 'uuid-user',
        request_id: 'req-123',
        provider_type: 'assistant',
        entrypoint: 'cli',
        client_version: '2.1.141',
        user_type: 'external',
        is_sidechain: false,
        raw_frame: { uuid: 'uuid-assistant' },
      },
    }))
    expect(rows[0]).toMatchObject({
      provider_uuid: 'uuid-assistant',
      parent_uuid: 'uuid-user',
      request_id: 'req-123',
      provider_type: 'assistant',
      entrypoint: 'cli',
      client_version: '2.1.141',
      user_type: 'external',
      is_sidechain: false,
      raw_frame: { uuid: 'uuid-assistant' },
    })
  })

  it('returns no rows for empty content', function() {
    expect(extractMessageParts(undefined, { role: 'user', content: '' }, ctx())).toEqual([])
    expect(extractMessageParts(undefined, { role: 'user', content: [] }, ctx())).toEqual([])
  })

  it('produces a stable message_id when content is identical', function() {
    const message = { role: 'user', content: 'hello' }
    const first = extractMessageParts(undefined, message, ctx())
    const second = extractMessageParts(undefined, message, ctx())
    expect(first[0].message_id).toBe(second[0].message_id)
  })
})

describe('computeMessageId', function() {
  it('returns the same id for the same content in the same conversation', function() {
    const a = computeMessageId('conv-A', 'user', 'hello')
    const b = computeMessageId('conv-A', 'user', 'hello')
    expect(a).toBe(b)
  })

  it('returns different ids for the same content in different conversations', function() {
    const a = computeMessageId('conv-A', 'user', 'hello')
    const b = computeMessageId('conv-B', 'user', 'hello')
    expect(a).not.toBe(b)
  })

  it('returns different ids for the same content under a different role', function() {
    const a = computeMessageId('conv-A', 'user', 'hello')
    const b = computeMessageId('conv-A', 'assistant', 'hello')
    expect(a).not.toBe(b)
  })

  it('canonicalises object key order so equivalent content hashes the same', function() {
    const a = computeMessageId('conv-A', 'user', [{ type: 'text', text: 'hi' }])
    const b = computeMessageId('conv-A', 'user', [{ text: 'hi', type: 'text' }])
    expect(a).toBe(b)
  })

  it('returns a 16-character hex prefix', function() {
    const id = computeMessageId('conv-A', 'user', 'hello')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('mapPartType', function() {
  it('maps known Anthropic block types to schema part types', function() {
    expect(mapPartType('text')).toBe('text')
    expect(mapPartType('thinking')).toBe('reasoning')
    expect(mapPartType('redacted_thinking')).toBe('reasoning')
    expect(mapPartType('tool_use')).toBe('tool_call')
    expect(mapPartType('server_tool_use')).toBe('tool_call')
    expect(mapPartType('tool_result')).toBe('tool_result')
    expect(mapPartType('web_search_tool_result')).toBe('tool_result')
    expect(mapPartType('image')).toBe('image')
    expect(mapPartType('document')).toBe('file')
    expect(mapPartType('file')).toBe('file')
    expect(mapPartType('error')).toBe('error')
  })

  it('passes unknown non-empty block types through verbatim', function() {
    expect(mapPartType('citations')).toBe('citations')
    expect(mapPartType('future_type')).toBe('future_type')
  })

  it('defaults to "text" for undefined or empty input', function() {
    expect(mapPartType(undefined)).toBe('text')
    expect(mapPartType('')).toBe('text')
  })
})

describe('mapFinishReason', function() {
  it('maps Anthropic stop reasons to schema finish reasons', function() {
    expect(mapFinishReason('end_turn')).toBe('stop')
    expect(mapFinishReason('stop_sequence')).toBe('stop')
    expect(mapFinishReason('max_tokens')).toBe('length')
    expect(mapFinishReason('tool_use')).toBe('tool_use')
    expect(mapFinishReason('pause_turn')).toBe('pause')
    expect(mapFinishReason('refusal')).toBe('refusal')
    expect(mapFinishReason('error')).toBe('error')
  })

  it('passes unknown stop reasons through verbatim', function() {
    expect(mapFinishReason('made_up_reason')).toBe('made_up_reason')
  })

  it('returns undefined for null or undefined input', function() {
    expect(mapFinishReason(null)).toBeUndefined()
    expect(mapFinishReason(undefined)).toBeUndefined()
  })
})

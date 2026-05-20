import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { reconstructAssistantMessage } from '../../src/cli/stream-reconstruct.js'

const FIXTURE_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'fixtures', 'proxy')

/**
 * Load the stream_event rows for one exchange from a fixture JSONL file. The
 * file may include both the exchange row and its events; we want only the
 * events, in `t_ms` ascending order, matching the wire shape callers feed in.
 *
 * @param {string} fileName
 * @param {string} exchangeId
 * @returns {Record<string, unknown>[]}
 */
function loadStreamEvents(fileName, exchangeId) {
  const filePath = path.join(FIXTURE_DIR, fileName)
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  /** @type {Record<string, unknown>[]} */
  const events = []
  for (const line of lines) {
    const parsed = JSON.parse(line)
    if (parsed.kind === 'stream_event' && parsed.exchange_id === exchangeId) events.push(parsed)
  }
  events.sort((a, b) => Number(a.t_ms ?? 0) - Number(b.t_ms ?? 0))
  return events
}

describe('reconstructAssistantMessage', function() {
  it('reconstructs a text-only stream that matches the non-streaming wire shape', function() {
    const events = loadStreamEvents('streaming-text.jsonl', 'ex-stream-text')
    const message = reconstructAssistantMessage(events)
    expect(message).not.toBeNull()
    expect(message?.role).toBe('assistant')
    expect(message?.id).toBe('msg_stream_text')
    expect(message?.model).toBe('claude-haiku-4-5-20251001')
    expect(message?.content).toEqual([{ type: 'text', text: 'Hello, world!' }])
    expect(message?.stop_reason).toBe('end_turn')
    expect(message?.usage).toMatchObject({ input_tokens: 7, output_tokens: 4 })
  })

  it('reconstructs an equivalent message to the non-streaming wire shape (text round-trip)', function() {
    const events = loadStreamEvents('streaming-text.jsonl', 'ex-stream-text')
    const message = reconstructAssistantMessage(events)
    // Compare against the wire shape a non-streaming response would have had
    const nonStreaming = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello, world!' }],
      stop_reason: 'end_turn',
    }
    expect({
      role: message?.role,
      content: message?.content,
      stop_reason: message?.stop_reason,
    }).toEqual(nonStreaming)
  })

  it('preserves mixed thinking + signature + tool_use blocks with input_json_delta accumulation', function() {
    const events = loadStreamEvents('streaming-thinking-tool.jsonl', 'ex-stream-think')
    const message = reconstructAssistantMessage(events)
    expect(message?.content).toHaveLength(2)
    expect(message?.content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'The user wants a directory listing.',
      signature: 'sig-thinking-abc123',
    })
    expect(message?.content[1]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_stream_bash_01',
      name: 'bash',
      input: { command: 'ls -la' },
    })
    expect(message?.stop_reason).toBe('tool_use')
  })

  it('parses accumulated input_json_delta into a structured object', function() {
    const events = loadStreamEvents('streaming-thinking-tool.jsonl', 'ex-stream-think')
    const message = reconstructAssistantMessage(events)
    const toolBlock = message?.content.find((b) => b.type === 'tool_use')
    expect(toolBlock?.input).toEqual({ command: 'ls -la' })
  })

  it('marks a truncated stream (no message_stop) with stop_reason="error"', function() {
    const events = loadStreamEvents('truncated-stream.jsonl', 'ex-truncated')
    const message = reconstructAssistantMessage(events)
    expect(message?.stop_reason).toBe('error')
    // The accumulated content up to the cut-off should still be present
    expect(message?.content[0]).toMatchObject({
      type: 'text',
      text: 'Once upon a time, there was a',
    })
  })

  it('returns null when no message_start event is present', function() {
    expect(reconstructAssistantMessage([])).toBeNull()
    expect(reconstructAssistantMessage([
      { kind: 'stream_event', t_ms: 0, event: 'content_block_start', data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}' },
    ])).toBeNull()
  })

  it('accepts events where data is already a parsed object, not just a string', function() {
    /** @type {Record<string, unknown>[]} */
    const events = [
      {
        kind: 'stream_event', t_ms: 0, event: 'message_start',
        data: {
          type: 'message_start',
          message: { id: 'msg_x', model: 'm', role: 'assistant', content: [], usage: { input_tokens: 1 } },
        },
      },
      {
        kind: 'stream_event', t_ms: 10, event: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        kind: 'stream_event', t_ms: 20, event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      },
      {
        kind: 'stream_event', t_ms: 30, event: 'message_stop',
        data: { type: 'message_stop' },
      },
    ]
    const message = reconstructAssistantMessage(events)
    expect(message?.content[0]).toMatchObject({ type: 'text', text: 'hi' })
  })

  it('ignores unknown SSE event types and unknown delta types without raising', function() {
    /** @type {Record<string, unknown>[]} */
    const events = [
      { kind: 'stream_event', t_ms: 0, event: 'message_start', data: '{"type":"message_start","message":{"id":"x","role":"assistant","content":[],"usage":{}}}' },
      { kind: 'stream_event', t_ms: 5, event: 'ping', data: '{"type":"ping"}' },
      { kind: 'stream_event', t_ms: 10, event: 'unknown_event', data: '{"type":"unknown_event"}' },
      { kind: 'stream_event', t_ms: 15, event: 'content_block_start', data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}' },
      { kind: 'stream_event', t_ms: 20, event: 'content_block_delta', data: '{"type":"content_block_delta","index":0,"delta":{"type":"future_delta","text":"ignored"}}' },
      { kind: 'stream_event', t_ms: 25, event: 'content_block_delta', data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"kept"}}' },
      { kind: 'stream_event', t_ms: 30, event: 'message_stop', data: '{"type":"message_stop"}' },
    ]
    const message = reconstructAssistantMessage(events)
    expect(message?.content[0]).toMatchObject({ type: 'text', text: 'kept' })
  })

  it('orders content blocks by their server-assigned index, not arrival order', function() {
    /** @type {Record<string, unknown>[]} */
    const events = [
      { kind: 'stream_event', t_ms: 0, event: 'message_start', data: '{"type":"message_start","message":{"id":"x","role":"assistant","content":[],"usage":{}}}' },
      // Index 1 arrives before index 0
      { kind: 'stream_event', t_ms: 5, event: 'content_block_start', data: '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":"two"}}' },
      { kind: 'stream_event', t_ms: 10, event: 'content_block_start', data: '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"one"}}' },
      { kind: 'stream_event', t_ms: 15, event: 'message_stop', data: '{"type":"message_stop"}' },
    ]
    const message = reconstructAssistantMessage(events)
    expect(message?.content.map((b) => b.text)).toEqual(['one', 'two'])
  })

  it('records message_delta usage and stop_reason on the message', function() {
    /** @type {Record<string, unknown>[]} */
    const events = [
      { kind: 'stream_event', t_ms: 0, event: 'message_start', data: '{"type":"message_start","message":{"id":"x","role":"assistant","content":[],"usage":{"input_tokens":50}}}' },
      { kind: 'stream_event', t_ms: 10, event: 'message_delta', data: '{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":120}}' },
      { kind: 'stream_event', t_ms: 20, event: 'message_stop', data: '{"type":"message_stop"}' },
    ]
    const message = reconstructAssistantMessage(events)
    expect(message?.stop_reason).toBe('max_tokens')
    expect(message?.usage).toMatchObject({ input_tokens: 50, output_tokens: 120 })
  })
})

import { describe, expect, it } from 'vitest'
import { Recorder } from '../src/recorder.js'

/**
 * @import { CollectingSink } from './types.js'
 */

/**
 * @returns {CollectingSink}
 */
function makeCollectingSink() {
  /** @type {any[]} */
  const rows = []
  return {
    rows,
    writeRow(obj) {
      rows.push(obj)
      return Promise.resolve()
    },
    close() {
      return Promise.resolve()
    },
  }
}

describe('Recorder — drop predicate', function() {
  it('skips both stream events and the final exchange row when the predicate returns true', async function() {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink, shouldDrop: () => true })
    const exchange = recorder.startExchange({
      upstream: 'anthropic',
      client: { ip: '127.0.0.1', user_agent: 'claude-code/1' },
      request: { method: 'POST', path: '/v1/messages', headers: { 'x-claude-code-session-id': 's1' } },
    })
    exchange.appendRequestChunk(Buffer.from('{"model":"x"}'))
    exchange.setResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } })
    exchange.markStreaming()

    await exchange.consumeStreamChunk(Buffer.from('event: a\ndata: 1\n\n'))
    await exchange.consumeStreamChunk(Buffer.from('event: b\ndata: 2\n\n'))
    await exchange.finish()

    expect(sink.rows).toEqual([])
    // The stream-event counter still increments — useful for an external
    // "dropped N events" observability hook even though no JSONL was written.
    expect(exchange.streamEventCount).toBe(2)
  })

  it('records normally when the predicate returns false', async function() {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink, shouldDrop: () => false })
    const exchange = recorder.startExchange({
      upstream: 'anthropic',
      client: { ip: '127.0.0.1', user_agent: 'claude-code/1' },
      request: { method: 'POST', path: '/v1/messages', headers: {} },
    })
    exchange.appendRequestChunk(Buffer.from('{"model":"x"}'))
    exchange.setResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } })
    exchange.markStreaming()
    await exchange.consumeStreamChunk(Buffer.from('event: a\ndata: 1\n\n'))
    await exchange.finish()
    const kinds = sink.rows.map((r) => r.kind)
    expect(kinds).toContain('stream_event')
    expect(kinds).toContain('exchange')
  })

  it('per-exchange shouldDrop overrides the constructor-level predicate', async function() {
    const sink = makeCollectingSink()
    const recorder = new Recorder({ sink, shouldDrop: () => true })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'POST', path: '/x', headers: {} },
      shouldDrop: () => false,
    })
    exchange.setResponseStart({ status: 200, headers: {} })
    exchange.appendResponseChunk(Buffer.from('ok'))
    await exchange.finish()
    expect(sink.rows).toHaveLength(1)
  })

  it('caches the drop decision across stream + finish so the predicate runs once', async function() {
    let calls = 0
    const sink = makeCollectingSink()
    const recorder = new Recorder({
      sink,
      shouldDrop() { calls += 1; return true },
    })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'POST', path: '/x', headers: {} },
    })
    exchange.setResponseStart({ status: 200, headers: { 'content-type': 'text/event-stream' } })
    exchange.markStreaming()
    await exchange.consumeStreamChunk(Buffer.from('event: a\ndata: 1\n\n'))
    await exchange.consumeStreamChunk(Buffer.from('event: b\ndata: 2\n\n'))
    await exchange.finish()
    expect(calls).toBe(1)
  })

  it('treats a thrown predicate error as "record" — recording must never break on filter failure', async function() {
    const sink = makeCollectingSink()
    const recorder = new Recorder({
      sink,
      shouldDrop() { throw new Error('boom') },
    })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'POST', path: '/x', headers: {} },
    })
    exchange.setResponseStart({ status: 200, headers: {} })
    await exchange.finish()
    expect(sink.rows).toHaveLength(1)
  })

  it('passes unredacted headers to the predicate even after sensitive headers are redacted', async function() {
    const sink = makeCollectingSink()
    let observed
    const recorder = new Recorder({
      sink,
      shouldDrop(args) {
        observed = args.requestHeaders.authorization
        return false
      },
    })
    const exchange = recorder.startExchange({
      upstream: 'a',
      client: { ip: undefined, user_agent: undefined },
      request: { method: 'POST', path: '/x', headers: { authorization: 'Bearer SECRET-TOKEN' } },
    })
    exchange.setResponseStart({ status: 200, headers: {} })
    await exchange.finish()
    expect(observed).toBe('Bearer SECRET-TOKEN')
    // …but the recorded row carries the redacted form.
    expect(sink.rows[0].request.headers.authorization).toMatch(/^REDACTED:/)
  })
})

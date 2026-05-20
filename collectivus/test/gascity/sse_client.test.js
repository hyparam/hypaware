import { describe, expect, it, vi } from 'vitest'
import { computeBackoff, streamSse } from '../../src/gascity/sse_client.js'

/**
 * Build a Response whose body emits one or more SSE chunks then ends.
 *
 * @param {string[]} chunks
 * @returns {Response}
 */
function sseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('computeBackoff', () => {
  it('doubles per attempt up to the cap with bounded jitter', () => {
    const noJitter = vi.spyOn(Math, 'random').mockReturnValue(0.5) // jitter = 0
    expect(computeBackoff(0, 1000, 30000)).toBe(1000)
    expect(computeBackoff(1, 1000, 30000)).toBe(2000)
    expect(computeBackoff(2, 1000, 30000)).toBe(4000)
    expect(computeBackoff(10, 1000, 30000)).toBe(30000)
    noJitter.mockRestore()
  })

  it('keeps the result non-negative even with maximum negative jitter', () => {
    const minJitter = vi.spyOn(Math, 'random').mockReturnValue(0)
    // base=1000, jitter = 1000 * 0.1 * (-1) = -100 → result 900
    expect(computeBackoff(0, 1000, 30000)).toBe(900)
    minJitter.mockRestore()
  })
})

describe('streamSse', () => {
  it('dispatches each parsed SSE event to onEvent and ends cleanly', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(sseResponse([
      'id: 1\nevent: a\ndata: one\n\n',
      'id: 2\nevent: b\ndata: two\n\n',
    ]))
    const controller = new AbortController()
    /** @type {Array<{ event: string, data: string, id?: string }>} */
    const events = []
    const sleep = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.resolve()
    })
    await streamSse({
      url: 'http://example/sse',
      signal: controller.signal,
      onEvent: (ev) => { events.push(ev) },
      sleep,
      fetchFn,
    })
    expect(events).toEqual([
      { event: 'a', data: 'one', id: '1' },
      { event: 'b', data: 'two', id: '2' },
    ])
  })

  it('reconnects with Last-Event-ID after a stream ends', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(sseResponse(['id: a1\nevent: x\ndata: 1\n\n']))
      .mockResolvedValueOnce(sseResponse(['id: a2\nevent: x\ndata: 2\n\n']))
    const controller = new AbortController()
    /** @type {string[]} */
    const seen = []
    let reconnects = 0
    const sleep = vi.fn().mockImplementation(() => {
      reconnects += 1
      if (reconnects >= 2) controller.abort()
      return Promise.resolve()
    })
    await streamSse({
      url: 'http://example/sse',
      signal: controller.signal,
      onEvent: (ev) => { seen.push(ev.data) },
      sleep,
      fetchFn,
    })
    expect(seen).toEqual(['1', '2'])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const secondCall = fetchFn.mock.calls[1]
    const headers = /** @type {{ headers: Record<string, string> }} */ (secondCall[1]).headers
    expect(headers['Last-Event-ID']).toBe('a1')
  })

  it('logs and retries when the upstream returns a non-2xx status', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 503, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(sseResponse(['id: ok\nevent: x\ndata: 1\n\n']))
    const controller = new AbortController()
    /** @type {string[]} */
    const errs = []
    /** @type {string[]} */
    const seen = []
    let calls = 0
    const sleep = vi.fn().mockImplementation(() => {
      calls += 1
      if (calls >= 2) controller.abort()
      return Promise.resolve()
    })
    await streamSse({
      url: 'http://example/sse',
      signal: controller.signal,
      onEvent: (ev) => { seen.push(ev.data) },
      onError: (msg) => { errs.push(msg) },
      sleep,
      fetchFn,
    })
    expect(errs[0]).toMatch(/HTTP 503/)
    expect(seen).toEqual(['1'])
  })

  it('treats fetch rejections as recoverable and retries with backoff', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(sseResponse(['id: x\nevent: ok\ndata: live\n\n']))
    const controller = new AbortController()
    /** @type {string[]} */
    const errs = []
    /** @type {string[]} */
    const seen = []
    let calls = 0
    const sleep = vi.fn().mockImplementation(() => {
      calls += 1
      if (calls >= 2) controller.abort()
      return Promise.resolve()
    })
    await streamSse({
      url: 'http://example/sse',
      signal: controller.signal,
      onEvent: (ev) => { seen.push(ev.data) },
      onError: (msg) => { errs.push(msg) },
      sleep,
      fetchFn,
    })
    expect(errs[0]).toMatch(/SSE connect failed/)
    expect(seen).toEqual(['live'])
  })

  it('exits cleanly when the abort signal fires before the first connect', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = vi.fn()
    await streamSse({
      url: 'http://example/sse',
      signal: controller.signal,
      onEvent: () => {},
      fetchFn,
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects upstreams that return a non event-stream content type', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('{"ok":true}', {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    const controller = new AbortController()
    /** @type {string[]} */
    const errs = []
    const sleep = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.resolve()
    })
    await streamSse({
      url: 'http://example/sse',
      signal: controller.signal,
      onEvent: () => {},
      onError: (msg) => { errs.push(msg) },
      sleep,
      fetchFn,
    })
    expect(errs[0]).toMatch(/non-event-stream content-type/)
  })
})

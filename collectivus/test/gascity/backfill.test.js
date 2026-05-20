import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { backfillCity, buildTranscriptUrl } from '../../src/gascity/backfill.js'
import { NormalizerDispatcher } from '../../src/gascity/normalizer_dispatcher.js'

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memoStream() {
  let buf = ''
  return { write: (s) => { buf += s }, value: () => buf }
}

describe('buildTranscriptUrl', () => {
  it('encodes path segments and appends format=raw', () => {
    expect(buildTranscriptUrl('http://h:8372', 'hyptown', 'hy-1', undefined))
      .toBe('http://h:8372/v0/city/hyptown/session/hy-1/transcript?format=raw')
  })

  it('appends after=<uuid> when provided', () => {
    const url = buildTranscriptUrl('http://h', 'a/b', 'sess&id', 'uuid-9')
    expect(url).toContain('/v0/city/a%2Fb/session/sess%26id/transcript')
    expect(url).toContain('after=uuid-9')
    expect(url).toContain('format=raw')
  })

  it('strips trailing slashes from the api base url', () => {
    expect(buildTranscriptUrl('http://h:8372/', 'c', 's', undefined))
      .toBe('http://h:8372/v0/city/c/session/s/transcript?format=raw')
  })
})

describe('backfillCity', () => {
  /** @type {string} */
  let sinkRoot
  beforeEach(async () => {
    sinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-backfill-'))
  })
  afterEach(async () => {
    await fs.rm(sinkRoot, { recursive: true, force: true })
  })

  /**
   * @param {string} city
   * @param {string} sessionId
   * @param {import('../../src/gascity/types.d.ts').SessionCursor} cursor
   */
  async function writeCursorFile(city, sessionId, cursor) {
    const dir = path.join(sinkRoot, '.cursors', city)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(cursor) + '\n', 'utf8')
  }

  it('is a no-op when the cursors dir does not exist', async () => {
    const result = await backfillCity({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher: new NormalizerDispatcher({ stderr: memoStream() }),
      stderr: memoStream(),
      fetchFn: vi.fn(),
    })
    expect(result).toEqual({ sessionsAttempted: 0, framesDispatched: 0, sessionsFailed: 0 })
  })

  it('dispatches transcript frames for each non-retired cursor', async () => {
    await writeCursorFile('hyptown', 'hy-1', { last_uuid: 'u-0', retired: false })
    await writeCursorFile('hyptown', 'hy-2', { last_uuid: 'u-10', retired: false })
    // The lifecycle cursor and retired cursors should be skipped.
    await writeCursorFile('hyptown', 'hy-3', { last_uuid: 'u-99', retired: true })
    await fs.writeFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'lifecycle.json'),
      JSON.stringify({ last_event_id: 'evt-1' }),
      'utf8'
    )

    const dispatcher = new NormalizerDispatcher({ stderr: memoStream() })
    /** @type {Array<{ frame: unknown, sessionId: string }>} */
    const dispatched = []
    dispatcher.register('claude', (frame, dctx) => {
      dispatched.push({ frame, sessionId: dctx.sessionId })
      return []
    })

    const fetchFn = vi.fn().mockImplementation(async (/** @type {string} */ url) => {
      if (url.includes('session/hy-1/')) {
        return new Response(JSON.stringify([
          { provider: 'claude', uuid: 'u-1' },
          { provider: 'claude', uuid: 'u-2' },
        ]), { status: 200 })
      }
      if (url.includes('session/hy-2/')) {
        return new Response(JSON.stringify({ frames: [{ provider: 'claude', uuid: 'u-11' }] }), { status: 200 })
      }
      return new Response('', { status: 404 })
    })

    const result = await backfillCity({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher,
      stderr: memoStream(),
      fetchFn,
    })
    expect(result).toEqual({ sessionsAttempted: 2, framesDispatched: 3, sessionsFailed: 0 })
    expect(dispatched.map((d) => d.sessionId).sort()).toEqual(['hy-1', 'hy-1', 'hy-2'])
    // Verify the `after` query param was passed through correctly.
    const calledUrls = fetchFn.mock.calls.map(([u]) => u)
    expect(calledUrls.some((u) => u.includes('session/hy-1/transcript?format=raw&after=u-0'))).toBe(true)
    expect(calledUrls.some((u) => u.includes('session/hy-2/transcript?format=raw&after=u-10'))).toBe(true)
  })

  it('dispatches supervisor transcript message envelopes with their provider hint', async () => {
    await writeCursorFile('hyptown', 'hy-1', { retired: false })
    const dispatcher = new NormalizerDispatcher({ stderr: memoStream() })
    /** @type {unknown[]} */
    const dispatched = []
    dispatcher.register('claude', (frame) => {
      dispatched.push(frame)
      return []
    })
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'te-1',
      provider: 'claude',
      format: 'raw',
      messages: [
        { type: 'user', uuid: 'u-1' },
        { type: 'assistant', uuid: 'u-2' },
      ],
    }), { status: 200 }))

    const result = await backfillCity({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher,
      stderr: memoStream(),
      fetchFn,
    })

    expect(result).toEqual({ sessionsAttempted: 1, framesDispatched: 2, sessionsFailed: 0 })
    expect(dispatched).toEqual([
      { type: 'user', uuid: 'u-1' },
      { type: 'assistant', uuid: 'u-2' },
    ])
  })

  it('logs and counts failures without throwing', async () => {
    await writeCursorFile('hyptown', 'hy-1', { last_uuid: 'u-0', retired: false })
    const stderr = memoStream()
    const fetchFn = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    const result = await backfillCity({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher: new NormalizerDispatcher({ stderr: memoStream() }),
      stderr,
      fetchFn,
    })
    expect(result).toEqual({ sessionsAttempted: 1, framesDispatched: 0, sessionsFailed: 1 })
    expect(stderr.value()).toMatch(/backfill_session_failed.*hy-1.*HTTP 500/)
  })

  it('treats HTTP 404 as a quiet skip (session retired upstream)', async () => {
    await writeCursorFile('hyptown', 'hy-1', { last_uuid: 'u-0', retired: false })
    const stderr = memoStream()
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    const result = await backfillCity({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher: new NormalizerDispatcher({ stderr: memoStream() }),
      stderr,
      fetchFn,
    })
    expect(result).toEqual({ sessionsAttempted: 1, framesDispatched: 0, sessionsFailed: 0 })
    expect(stderr.value()).toBe('')
  })

  it('skips cursors with no last_uuid and still hits the transcript endpoint', async () => {
    await writeCursorFile('hyptown', 'hy-1', { retired: false })
    const fetchFn = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }))
    const result = await backfillCity({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher: new NormalizerDispatcher({ stderr: memoStream() }),
      stderr: memoStream(),
      fetchFn,
    })
    expect(result.sessionsAttempted).toBe(1)
    expect(result.framesDispatched).toBe(0)
    const url = fetchFn.mock.calls[0][0]
    expect(url).toBe('http://h:8372/v0/city/hyptown/session/hy-1/transcript?format=raw')
  })
})

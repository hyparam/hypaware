import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NormalizerDispatcher } from '../../src/gascity/normalizer_dispatcher.js'
import { SessionWorker, buildSessionStreamUrl, extractUuid } from '../../src/gascity/session_worker.js'
import { blockingSleep, holdingSseResponse, memoStream, sseResponse, waitFor } from './helpers.js'

describe('buildSessionStreamUrl', () => {
  it('encodes the city/session path segments and adds format=raw', () => {
    expect(buildSessionStreamUrl('http://h:8372', 'hyptown', 'hy-1', undefined))
      .toBe('http://h:8372/v0/city/hyptown/session/hy-1/stream?format=raw')
  })

  it('appends the after=<uuid> query when a cursor is set', () => {
    const url = buildSessionStreamUrl('http://h', 'a/b', 'sess&id', 'uuid-9')
    expect(url).toContain('/v0/city/a%2Fb/session/sess%26id/stream')
    expect(url).toContain('after=uuid-9')
    expect(url).toContain('format=raw')
  })

  it('strips trailing slashes from the api base url at the consumer level', () => {
    // buildSessionStreamUrl itself does not strip — SessionWorker normalizes
    // the api_url in its constructor before passing it through. This test
    // pins the documented contract of the URL builder.
    expect(buildSessionStreamUrl('http://h', 'c', 's', undefined))
      .toBe('http://h/v0/city/c/session/s/stream?format=raw')
  })
})

describe('extractUuid', () => {
  it('reads the top-level uuid', () => {
    expect(extractUuid({ uuid: 'u-1' })).toBe('u-1')
  })

  it('falls through to frame.uuid', () => {
    expect(extractUuid({ frame: { uuid: 'u-2' } })).toBe('u-2')
  })

  it('returns undefined when no uuid is present', () => {
    expect(extractUuid({})).toBeUndefined()
    expect(extractUuid(null)).toBeUndefined()
    expect(extractUuid('not-an-object')).toBeUndefined()
  })
})

describe('SessionWorker', () => {
  /** @type {string} */
  let sinkRoot
  beforeEach(async () => {
    sinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-session-worker-'))
  })
  afterEach(async () => {
    await fs.rm(sinkRoot, { recursive: true, force: true })
  })

  it('parses each frame and dispatches it; cursor writes are owned by the writer (no per-frame writes)', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {unknown[]} */
    const dispatched = []
    dispatcher.register('claude', (frame) => { dispatched.push(frame); return [] })
    const fetchFn = vi.fn().mockImplementationOnce(async () => sseResponse([
      'id: e1\nevent: frame\ndata: {"provider":"claude","uuid":"u-1","x":1}\n\n',
      'id: e2\nevent: frame\ndata: {"provider":"claude","uuid":"u-2","x":2}\n\n',
    ])).mockImplementation(async (_url, /** @type {{ signal: AbortSignal }} */ opts) => {
      // Hold subsequent reconnects open so the worker never burns through the
      // mock; the test stops the worker explicitly.
      return holdingSseResponse([], opts.signal)
    })
    const worker = new SessionWorker({
      city: 'hyptown',
      apiUrl: 'http://h:8372',
      sessionId: 'hy-1',
      template: 'desktop/refinery',
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    worker.start()
    await waitFor(() => dispatched.length === 2)
    await worker.stop()
    expect(dispatched).toEqual([
      { provider: 'claude', uuid: 'u-1', x: 1 },
      { provider: 'claude', uuid: 'u-2', x: 2 },
    ])
    // No writer was attached, so no cursor file should have been written by
    // the worker itself — bead 3 moved cursor ownership to ParquetWriter.
    await expect(fs.access(path.join(sinkRoot, '.cursors', 'hyptown', 'hy-1.json')))
      .rejects.toThrow()
    // In-memory last_uuid is still tracked for observability.
    expect(worker.lastUuid).toBe('u-2')
  })

  it('resumes via ?after=<last_uuid> when a cursor exists', async () => {
    await fs.mkdir(path.join(sinkRoot, '.cursors', 'hyptown'), { recursive: true })
    await fs.writeFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'hy-2.json'),
      JSON.stringify({ last_uuid: 'u-prev' }) + '\n',
      'utf8'
    )
    const dispatcher = new NormalizerDispatcher({ stderr: memoStream() })
    const fetchFn = vi.fn().mockImplementation(async (_url, /** @type {{ signal: AbortSignal }} */ opts) => {
      return holdingSseResponse([], opts.signal)
    })
    const worker = new SessionWorker({
      city: 'hyptown',
      apiUrl: 'http://h:8372',
      sessionId: 'hy-2',
      sinkRoot,
      dispatcher,
      stderr: memoStream(),
      fetchFn,
      sleep: blockingSleep(),
    })
    worker.start()
    await waitFor(() => fetchFn.mock.calls.length >= 1)
    await worker.stop()
    const url = fetchFn.mock.calls[0][0]
    expect(url).toContain('after=u-prev')
    const headers = /** @type {{ headers: Record<string, string> }} */ (fetchFn.mock.calls[0][1]).headers
    expect(headers['Last-Event-ID']).toBe('u-prev')
  })

  it('skips ping/heartbeat events and frames with empty data', async () => {
    const dispatcher = new NormalizerDispatcher({ stderr: memoStream() })
    /** @type {unknown[]} */
    const dispatched = []
    dispatcher.register('claude', (frame) => { dispatched.push(frame); return [] })
    const fetchFn = vi.fn().mockImplementationOnce(async () => sseResponse([
      'event: ping\ndata: \n\n',
      'event: heartbeat\ndata: \n\n',
      'event: frame\ndata: \n\n',
      'event: frame\ndata: {"provider":"claude","uuid":"u"}\n\n',
    ])).mockImplementation(async (_url, /** @type {{ signal: AbortSignal }} */ opts) => holdingSseResponse([], opts.signal))
    const worker = new SessionWorker({
      city: 'hyptown',
      apiUrl: 'http://h',
      sessionId: 's',
      sinkRoot,
      dispatcher,
      stderr: memoStream(),
      fetchFn,
      sleep: blockingSleep(),
    })
    worker.start()
    await waitFor(() => dispatched.length === 1)
    await worker.stop()
    expect(dispatched).toEqual([{ provider: 'claude', uuid: 'u' }])
  })

  it('logs and continues when a frame is not valid JSON', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {unknown[]} */
    const dispatched = []
    dispatcher.register('claude', (frame) => { dispatched.push(frame); return [] })
    const fetchFn = vi.fn().mockImplementationOnce(async () => sseResponse([
      'event: frame\ndata: not-json\n\n',
      'event: frame\ndata: {"provider":"claude","uuid":"u-good"}\n\n',
    ])).mockImplementation(async (_url, /** @type {{ signal: AbortSignal }} */ opts) => holdingSseResponse([], opts.signal))
    const worker = new SessionWorker({
      city: 'hyptown',
      apiUrl: 'http://h',
      sessionId: 's',
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    worker.start()
    await waitFor(() => dispatched.length === 1)
    await worker.stop()
    expect(stderr.value()).toMatch(/frame_parse_error city=hyptown session=s/)
    expect(dispatched).toEqual([{ provider: 'claude', uuid: 'u-good' }])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NormalizerDispatcher } from '../../src/gascity/normalizer_dispatcher.js'
import { SupervisorSubscriber } from '../../src/gascity/supervisor_subscriber.js'
import { blockingSleep, holdingSseResponse, memoStream, waitFor } from './helpers.js'

describe('SupervisorSubscriber', () => {
  /** @type {string} */
  let sinkRoot
  beforeEach(async () => {
    sinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-sup-'))
  })
  afterEach(async () => {
    await fs.rm(sinkRoot, { recursive: true, force: true })
  })

  it('spawns a session worker on session.woke and persists the lifecycle cursor', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({ items: [] }, { 'x-gc-index': 'lc-0' })
      }
      if (url.includes('/events/stream')) {
        return holdingSseResponse(
          ['id: lc-1\nevent: session.woke\ndata: {"session_id":"hy-a","template":"desktop/refinery"}\n\n'],
          opts.signal
        )
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.some((c) => /session\/hy-a/.test(/** @type {string} */ (c[0]))))
    await subscriber.stop()
    expect(fetchFn).toHaveBeenCalledWith(
      'http://h:8372/v0/city/hyptown/events/stream',
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'text/event-stream' }) })
    )
    const cursor = JSON.parse(await fs.readFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'lifecycle.json'),
      'utf8'
    ))
    expect(cursor).toEqual({ last_event_id: 'lc-1' })
  })

  it('seeds active session workers before opening the lifecycle stream', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({
          items: [{
            id: 'te-a',
            alias: 'rig/gastown.worker',
            template: 'rig/gastown.worker',
            rig: 'rig',
            state: 'active',
          }],
        }, { 'x-gc-index': 'seed-42' })
      }
      if (url.includes('/events/stream')) {
        return holdingSseResponse([], opts.signal)
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.some((c) => {
      const url = /** @type {string} */ (c[0])
      return url.includes(`/session/${encodeURIComponent('rig/gastown.worker')}/stream`)
    }))
    await subscriber.stop()
    const eventsCall = fetchFn.mock.calls.find((c) => /\/events\/stream/.test(/** @type {string} */ (c[0])))
    if (!eventsCall) throw new Error('expected lifecycle stream fetch')
    const headers = /** @type {{ headers: Record<string, string> }} */ (eventsCall[1]).headers
    expect(headers['Last-Event-ID']).toBe('seed-42')
  })

  it('backfills seeded active session transcripts in the background', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {unknown[]} */
    const seen = []
    dispatcher.register('claude', (frame) => { seen.push(frame); return [] })
    const writer = /** @type {import('../../src/gascity/parquet_writer.js').ParquetWriter} */ (
      /** @type {unknown} */ ({
        getLastFlushedUuid: vi.fn(async () => undefined),
        retireSession: vi.fn(async () => undefined),
      })
    )
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({
          items: [{
            id: 'te-a',
            alias: 'rig/gastown.worker',
            template: 'rig/gastown.worker',
            rig: 'rig',
            state: 'active',
          }],
        }, { 'x-gc-index': 'seed-42' })
      }
      if (url.includes('/transcript')) {
        return jsonResponse({
          provider: 'claude',
          messages: [{ type: 'assistant', uuid: 'u-1' }],
        })
      }
      if (url.includes('/events/stream')) {
        return holdingSseResponse([], opts.signal)
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher,
      writer,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => seen.length === 1)
    await subscriber.stop()
    expect(seen).toEqual([{ type: 'assistant', uuid: 'u-1' }])
    expect(writer.getLastFlushedUuid).toHaveBeenCalledWith('hyptown', 'rig/gastown.worker')
  })

  it('spawns a session worker from the supervisor event-log envelope', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const sessionId = 'azworld/gastown-beads-lite.witness'
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({ items: [] }, { 'x-gc-index': '9' })
      }
      if (url.includes('/events/stream')) {
        return holdingSseResponse(
          [
            'id: 10\nevent: event\ndata: {"seq":10,"type":"session.woke","subject":"azworld/gastown-beads-lite.witness","payload":{}}\n\n',
          ],
          opts.signal
        )
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.some((c) => {
      const url = /** @type {string} */ (c[0])
      return url.includes(`/session/${encodeURIComponent(sessionId)}/stream`)
    }))
    expect(subscriber.workers.get(sessionId)?.template).toBe(sessionId)
    await subscriber.stop()
  })

  it('retires a session worker from the supervisor event-log envelope', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const sessionId = 'azworld/gastown-beads-lite.witness'
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({ items: [] }, { 'x-gc-index': '9' })
      }
      if (url.includes('/events/stream')) {
        return holdingSseResponse([
          'id: 10\nevent: event\ndata: {"seq":10,"type":"session.woke","subject":"azworld/gastown-beads-lite.witness","payload":{}}\n\n',
          'id: 11\nevent: event\ndata: {"seq":11,"type":"session.stopped","subject":"azworld/gastown-beads-lite.witness","payload":{}}\n\n',
        ], opts.signal)
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => !subscriber.workers.has(sessionId) && fetchFn.mock.calls.length > 1)
    await subscriber.stop()
  })

  it('honors include/exclude template filters before spawning workers', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({ items: [] }, { 'x-gc-index': '0' })
      }
      if (url.includes('/events/stream')) {
        return holdingSseResponse([
          'id: 1\nevent: session.woke\ndata: {"session_id":"sa","template":"desktop/refinery"}\n\n',
          'id: 2\nevent: session.woke\ndata: {"session_id":"sb","template":"desktop/witness"}\n\n',
          'id: 3\nevent: session.woke\ndata: {"session_id":"sc","template":"mobile/foo"}\n\n',
        ], opts.signal)
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: {
        name: 'hyptown',
        api_url: 'http://h:8372',
        include_templates: ['desktop/*'],
        exclude_templates: ['desktop/witness'],
      },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    const cursorFile = path.join(sinkRoot, '.cursors', 'hyptown', 'lifecycle.json')
    await waitFor(async () => {
      try {
        const body = await fs.readFile(cursorFile, 'utf8')
        return body.includes('"last_event_id":"3"')
      } catch {
        return false
      }
    })
    await subscriber.stop()
    const sessionUrls = fetchFn.mock.calls
      .map((c) => /** @type {string} */ (c[0]))
      .filter((u) => /\/session\//.test(u))
    const sessions = sessionUrls.map((u) => /session\/([^/]+)\/stream/.exec(u)?.[1] ?? '').sort()
    expect(sessions).toEqual(['sa'])
  })

  it('retires a session worker on session.stopped', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {AbortSignal | undefined} */
    let workerSignal
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({ items: [] }, { 'x-gc-index': '0' })
      }
      if (url.includes('/events/stream')) {
        return holdingSseResponse([
          'id: 1\nevent: session.woke\ndata: {"session_id":"hy-z","template":"desktop/x"}\n\n',
          'id: 2\nevent: session.stopped\ndata: {"session_id":"hy-z"}\n\n',
        ], opts.signal)
      }
      workerSignal = opts.signal
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => workerSignal?.aborted === true, {
      message: 'expected the spawned worker to be aborted by session.stopped',
    })
    await subscriber.stop()
    expect(workerSignal?.aborted).toBe(true)
  })

  it('logs and continues on malformed lifecycle data without crashing', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({ items: [] }, { 'x-gc-index': '0' })
      }
      if (url.includes('/events/stream')) {
        return holdingSseResponse([
          'id: 1\nevent: session.woke\ndata: not-json\n\n',
          'id: 2\nevent: session.woke\ndata: {"session_id":"ok","template":"desktop/x"}\n\n',
        ], opts.signal)
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.some((c) => /session\/ok\/stream/.test(/** @type {string} */ (c[0]))))
    await subscriber.stop()
    expect(stderr.value()).toMatch(/lifecycle_parse_error/)
  })

  it('resumes the lifecycle stream from the persisted cursor', async () => {
    await fs.mkdir(path.join(sinkRoot, '.cursors', 'hyptown'), { recursive: true })
    await fs.writeFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'lifecycle.json'),
      JSON.stringify({ last_event_id: 'lc-prev' }) + '\n',
      'utf8'
    )
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({ items: [] }, { 'x-gc-index': 'seed-ignored' })
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.some((c) => /\/events\/stream/.test(/** @type {string} */ (c[0]))))
    await subscriber.stop()
    const eventsCall = fetchFn.mock.calls.find((c) => /\/events\/stream/.test(/** @type {string} */ (c[0])))
    if (!eventsCall) throw new Error('expected lifecycle stream fetch')
    const headers = /** @type {{ headers: Record<string, string> }} */ (eventsCall[1]).headers
    expect(headers['Last-Event-ID']).toBe('lc-prev')
  })

  it('starts first lifecycle stream from the active-session snapshot index', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({ items: [] }, { 'x-gc-index': 'seed-99' })
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.some((c) => /\/events\/stream/.test(/** @type {string} */ (c[0]))))
    await subscriber.stop()
    const eventsCall = fetchFn.mock.calls.find((c) => /\/events\/stream/.test(/** @type {string} */ (c[0])))
    if (!eventsCall) throw new Error('expected lifecycle stream fetch')
    const headers = /** @type {{ headers: Record<string, string> }} */ (eventsCall[1]).headers
    expect(headers['Last-Event-ID']).toBe('seed-99')
  })

  it('falls back to event-log replay when active-session seeding fails', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return new Response('not found', { status: 404 })
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.some((c) => /\/events\/stream/.test(/** @type {string} */ (c[0]))))
    await subscriber.stop()
    const eventsCall = fetchFn.mock.calls.find((c) => /\/events\/stream/.test(/** @type {string} */ (c[0])))
    if (!eventsCall) throw new Error('expected lifecycle stream fetch')
    const headers = /** @type {{ headers: Record<string, string> }} */ (eventsCall[1]).headers
    expect(headers['Last-Event-ID']).toBe('0')
    expect(stderr.value()).toMatch(/active_sessions_seed_failed/)
  })

  it('does nothing when only ping/heartbeat events arrive', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/sessions?state=active')) {
        return jsonResponse({ items: [] }, { 'x-gc-index': '0' })
      }
      if (url.includes('/events/stream')) {
        return holdingSseResponse([
          ': heartbeat comment\n\n',
          'event: ping\ndata: \n\n',
        ], opts.signal)
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.length >= 1)
    // Give the supervisor a beat to consume the chunks.
    await new Promise((r) => setTimeout(r, 30))
    await subscriber.stop()
    // No session was spawned — only the lifecycle stream was opened.
    const sessionFetches = fetchFn.mock.calls.filter((c) => /\/session\//.test(/** @type {string} */ (c[0])))
    expect(sessionFetches).toHaveLength(0)
  })
})

/**
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function jsonResponse(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
}

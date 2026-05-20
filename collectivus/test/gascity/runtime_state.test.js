import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  GASCITY_STATE_SCHEMA_VERSION,
  GascityRuntimeStateWriter,
  readRuntimeState,
} from '../../src/gascity/runtime_state.js'

/** @returns {void} */
function swallow() { /* discard rejection */ }

describe('GascityRuntimeStateWriter', () => {
  /** @type {string} */
  let dir
  /** @type {GascityRuntimeStateWriter[]} */
  let openWriters
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-runtime-'))
    openWriters = []
  })
  afterEach(async () => {
    // Stop each writer first so a debounced flush doesn't fire AFTER we've
    // removed the temp directory and try to write into a now-missing path
    // (vitest surfaces those as cross-test unhandled rejections).
    await Promise.all(openWriters.map((w) => w.stop().catch(swallow)))
    await fs.rm(dir, { recursive: true, force: true })
  })

  /**
   * Build a writer with a deterministic clock so tests can assert on
   * timestamps without flakiness. The writer is registered on `openWriters`
   * so afterEach can `stop()` it before the temp dir gets removed.
   *
   * @param {{ now?: () => Date }} [opts]
   * @returns {{ writer: GascityRuntimeStateWriter, file: string, advance: (ms: number) => void }}
   */
  function buildWriter(opts = {}) {
    let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0)
    const now = opts.now ?? (() => new Date(nowMs))
    const file = path.join(dir, 'gascity-state.json')
    // Use a long debounce so the only writes that hit disk are explicit
    // `await writer.flush()` calls — keeps tests deterministic and dodges
    // the "timer fires after afterEach removed the dir" failure mode.
    const writer = new GascityRuntimeStateWriter({
      path: file,
      now,
      flushIntervalMs: 60_000,
    })
    openWriters.push(writer)
    return { writer, file, advance: /** @type {(ms: number) => void} */ (ms) => { nowMs += ms } }
  }

  it('snapshot has a versioned schema and stable city ordering', () => {
    const { writer } = buildWriter()
    writer.upsertCity({ name: 'b', api_url: 'http://b' })
    writer.upsertCity({ name: 'a', api_url: 'http://a' })
    const snap = writer.snapshot()
    expect(snap.schema_version).toBe(GASCITY_STATE_SCHEMA_VERSION)
    expect(snap.cities.map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('records a session as active and bumps the per-session frame count', async () => {
    const { writer, file } = buildWriter()
    writer.upsertCity({ name: 'hyptown', api_url: 'http://h' })
    writer.upsertSession('hyptown', { sessionId: 's1', template: 'desktop/x' })
    writer.recordFrame('hyptown', 's1', 3)
    await writer.flush()
    const state = await readRuntimeState(file)
    expect(state).toBeDefined()
    expect(state?.cities[0].sessions[0]).toMatchObject({
      sessionId: 's1',
      template: 'desktop/x',
      state: 'active',
      frames: 3,
    })
    expect(state?.cities[0].frames_total).toBe(3)
  })

  it('marks a session retired and stamps retired_at', async () => {
    const { writer, file } = buildWriter()
    writer.upsertCity({ name: 'hyptown', api_url: 'http://h' })
    writer.upsertSession('hyptown', { sessionId: 's1' })
    writer.retireSession('hyptown', 's1')
    await writer.flush()
    const state = await readRuntimeState(file)
    const sess = state?.cities[0].sessions[0]
    expect(sess?.state).toBe('retired')
    expect(typeof sess?.retired_at).toBe('string')
  })

  it('drops a city with removeCity and forgets sessions', async () => {
    const { writer, file } = buildWriter()
    writer.upsertCity({ name: 'hyptown', api_url: 'http://h' })
    writer.upsertSession('hyptown', { sessionId: 's1' })
    writer.removeCity('hyptown')
    await writer.flush()
    const state = await readRuntimeState(file)
    expect(state?.cities).toEqual([])
  })

  it('flush is atomic — the on-disk file is always parseable JSON', async () => {
    const { writer, file } = buildWriter()
    writer.upsertCity({ name: 'a', api_url: 'http://a' })
    await writer.flush()
    const raw = await fs.readFile(file, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('serialises concurrent flushes into a single chain', async () => {
    const { writer, file } = buildWriter()
    writer.upsertCity({ name: 'a', api_url: 'http://a' })
    const flushes = [writer.flush(), writer.flush(), writer.flush()]
    await Promise.all(flushes)
    const state = await readRuntimeState(file)
    expect(state?.cities.length).toBe(1)
  })

  it('stop flushes a final snapshot and ignores subsequent mutations', async () => {
    const { writer, file } = buildWriter()
    writer.upsertCity({ name: 'a', api_url: 'http://a' })
    await writer.stop()
    writer.upsertCity({ name: 'b', api_url: 'http://b' })
    await writer.flush()
    const state = await readRuntimeState(file)
    expect(state?.cities.map((c) => c.name)).toEqual(['a'])
  })

  it('lifecycle_connected toggles and stamps last_event_at on connect', async () => {
    const { writer, file } = buildWriter()
    writer.upsertCity({ name: 'a', api_url: 'http://a' })
    writer.setLifecycleConnected('a', true)
    await writer.flush()
    const state = await readRuntimeState(file)
    expect(state?.cities[0].lifecycle_connected).toBe(true)
    expect(typeof state?.cities[0].lifecycle_last_event_at).toBe('string')
  })

  it('upsertSession on a missing city is a no-op (does not crash)', async () => {
    const { writer, file } = buildWriter()
    // No city was upserted first — the call should silently do nothing
    // rather than throw or invent a phantom city in the snapshot.
    writer.upsertSession('not-attached', { sessionId: 'x' })
    await writer.flush()
    // Nothing was marked dirty, so flush() never wrote a file.
    const state = await readRuntimeState(file)
    expect(state).toBeUndefined()
  })

  it('forgetSession removes a session entry entirely', async () => {
    const { writer, file } = buildWriter()
    writer.upsertCity({ name: 'a', api_url: 'http://a' })
    writer.upsertSession('a', { sessionId: 'x' })
    writer.forgetSession('a', 'x')
    await writer.flush()
    const state = await readRuntimeState(file)
    expect(state?.cities[0].sessions).toEqual([])
  })

  it('frames_total accumulates across sessions in the same city', async () => {
    const { writer, file } = buildWriter()
    writer.upsertCity({ name: 'a', api_url: 'http://a' })
    writer.upsertSession('a', { sessionId: 'x' })
    writer.upsertSession('a', { sessionId: 'y' })
    writer.recordFrame('a', 'x', 5)
    writer.recordFrame('a', 'y', 7)
    await writer.flush()
    const state = await readRuntimeState(file)
    expect(state?.cities[0].frames_total).toBe(12)
  })
})

describe('readRuntimeState', () => {
  /** @type {string} */
  let dir
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-runtime-read-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns undefined when the file is missing', async () => {
    const out = await readRuntimeState(path.join(dir, 'no-such.json'))
    expect(out).toBeUndefined()
  })

  it('throws on malformed JSON', async () => {
    const file = path.join(dir, 'bad.json')
    await fs.writeFile(file, '{not-json', 'utf8')
    await expect(readRuntimeState(file)).rejects.toThrow(/not valid JSON/)
  })

  it('throws on a non-object payload', async () => {
    const file = path.join(dir, 'array.json')
    await fs.writeFile(file, '[]', 'utf8')
    await expect(readRuntimeState(file)).rejects.toThrow(/must be a JSON object/)
  })
})

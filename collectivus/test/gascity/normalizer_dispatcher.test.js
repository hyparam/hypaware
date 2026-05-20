import { describe, expect, it } from 'vitest'
import { NormalizerDispatcher, resolveProvider } from '../../src/gascity/normalizer_dispatcher.js'

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memoStream() {
  let buf = ''
  return {
    write: (s) => { buf += s },
    value: () => buf,
  }
}

/** @type {import('../../src/gascity/types.d.ts').SessionContext} */
const ctx = { city: 'hyptown', sessionId: 'hy-1', template: 'desktop/x', rig: undefined, alias: undefined }

describe('resolveProvider', () => {
  it('reads the top-level provider field', () => {
    expect(resolveProvider({ provider: 'claude', frame: {} })).toBe('claude')
  })

  it('falls through to the response envelope', () => {
    expect(resolveProvider({ response: { provider: 'codex' } })).toBe('codex')
  })

  it('falls through to the inner frame envelope', () => {
    expect(resolveProvider({ frame: { provider: 'gemini' } })).toBe('gemini')
  })

  it('returns undefined for non-objects and missing providers', () => {
    expect(resolveProvider(undefined)).toBeUndefined()
    expect(resolveProvider({})).toBeUndefined()
    expect(resolveProvider({ frame: {} })).toBeUndefined()
  })
})

describe('NormalizerDispatcher', () => {
  it('routes to a registered normalizer by provider name', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {Array<{ frame: unknown, ctx: unknown }>} */
    const seen = []
    dispatcher.register('claude', (frame, c) => { seen.push({ frame, ctx: c }); return [] })
    const frame = { provider: 'claude', uuid: 'u-1' }
    dispatcher.dispatch(frame, ctx)
    expect(seen).toEqual([{ frame, ctx }])
    expect(stderr.value()).toBe('')
  })

  it('falls through to passthrough when provider is not registered', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {unknown[]} */
    const seen = []
    dispatcher.passthrough = (frame) => { seen.push(frame); return [] }
    const frame = { provider: 'gemini' }
    dispatcher.dispatch(frame, ctx)
    expect(seen).toEqual([frame])
  })

  it('catches normalizer exceptions and logs without crashing the loop', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    dispatcher.register('claude', () => { throw new Error('boom') })
    /** @type {unknown[]} */
    const downstream = []
    dispatcher.register('codex', (frame) => { downstream.push(frame); return [] })
    dispatcher.dispatch({ provider: 'claude' }, ctx)
    dispatcher.dispatch({ provider: 'codex' }, ctx)
    expect(downstream).toEqual([{ provider: 'codex' }])
    expect(stderr.value()).toMatch(/normalizer error provider=claude session=hy-1 err=boom/)
  })

  it('routes to passthrough when the envelope has no provider tag', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {unknown[]} */
    const seen = []
    dispatcher.passthrough = (frame) => { seen.push(frame); return [] }
    dispatcher.dispatch({ uuid: 'no-provider' }, ctx)
    expect(seen).toEqual([{ uuid: 'no-provider' }])
  })

  it('unwraps provider frame envelopes before calling a registered normalizer', () => {
    const dispatcher = new NormalizerDispatcher({ stderr: memoStream() })
    /** @type {unknown[]} */
    const seen = []
    dispatcher.register('claude', (frame) => { seen.push(frame); return [] })
    dispatcher.dispatch({ provider: 'claude', frame: { type: 'assistant', uuid: 'u-1' } }, ctx)
    expect(seen).toEqual([{ type: 'assistant', uuid: 'u-1' }])
  })

  it('expands transcript message envelopes into individual normalizer calls', () => {
    const dispatcher = new NormalizerDispatcher({ stderr: memoStream() })
    /** @type {unknown[]} */
    const seen = []
    dispatcher.register('claude', (frame) => { seen.push(frame); return [] })
    dispatcher.dispatch({
      provider: 'claude',
      messages: [
        { type: 'user', uuid: 'u-1' },
        { type: 'assistant', uuid: 'u-2' },
      ],
    }, ctx)
    expect(seen).toEqual([
      { type: 'user', uuid: 'u-1' },
      { type: 'assistant', uuid: 'u-2' },
    ])
  })

  it('ships built-in stubs for claude and codex (overridable by beads 2/4)', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    expect(dispatcher.registry.has('claude')).toBe(true)
    expect(dispatcher.registry.has('codex')).toBe(true)
    // Stubs return empty rows — calling them must not throw or write to stderr.
    expect(dispatcher.dispatch({ provider: 'claude' }, ctx)).toEqual([])
    expect(dispatcher.dispatch({ provider: 'codex' }, ctx)).toEqual([])
    expect(stderr.value()).toBe('')
  })

  it('returns the rows produced by the normalizer', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const row = { schema_version: 1, part_index: 0, part_type: 'text' }
    dispatcher.register('claude', () => [/** @type {any} */ (row)])
    const rows = dispatcher.dispatch({ provider: 'claude' }, ctx)
    expect(rows).toEqual([row])
  })

  it('returns an empty array when a registered normalizer throws', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    dispatcher.register('claude', () => { throw new Error('boom') })
    const rows = dispatcher.dispatch({ provider: 'claude' }, ctx)
    expect(rows).toEqual([])
  })

  it('coerces a non-array return into an empty array', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @returns {undefined} */
    function brokenImpl() {
      return undefined
    }
    const broken = /** @type {import('../../src/gascity/types.d.ts').NormalizerFn} */ (
      /** @type {unknown} */ (brokenImpl)
    )
    dispatcher.register('claude', broken)
    expect(dispatcher.dispatch({ provider: 'claude' }, ctx)).toEqual([])
  })

  it('hands normalizer rows to the attached writer', async () => {
    const stderr = memoStream()
    /** @type {Array<{ ctx: unknown, rows: unknown[] }>} */
    const appended = []
    const writer = /** @type {import('../../src/gascity/parquet_writer.js').ParquetWriter} */ (
      /** @type {unknown} */ ({
        append: async (/** @type {unknown} */ c, /** @type {unknown[]} */ rows) => {
          appended.push({ ctx: c, rows: [...rows] })
        },
      })
    )
    const dispatcher = new NormalizerDispatcher({ stderr, writer })
    dispatcher.register('claude', (frame) => {
      const f = /** @type {Record<string, unknown>} */ (frame)
      return [/** @type {any} */ ({
        schema_version: 1,
        city: 'hyptown',
        provider_session_id: 'hy-1',
        provider_uuid: String(f.uuid),
        provider: 'claude',
        message_created_at: '2026-05-14T00:00:00Z',
        part_index: 0,
        part_type: 'text',
      })]
    })
    const rows = dispatcher.dispatch({ provider: 'claude', uuid: 'u-1' }, ctx)
    expect(rows).toHaveLength(1)
    // Append is async; wait for the next microtask.
    await new Promise((r) => setImmediate(r))
    expect(appended).toHaveLength(1)
    expect(appended[0].ctx).toEqual(ctx)
    const firstRow = /** @type {Record<string, unknown>} */ (appended[0].rows[0])
    expect(firstRow.provider_uuid).toBe('u-1')
  })

  it('drain waits for asynchronous writer appends', async () => {
    const stderr = memoStream()
    /** @type {(() => void) | undefined} */
    let releaseAppend
    let appendFinished = false
    const blocker = new Promise((resolve) => { releaseAppend = () => resolve(undefined) })
    const writer = /** @type {import('../../src/gascity/parquet_writer.js').ParquetWriter} */ (
      /** @type {unknown} */ ({
        append: async () => {
          await blocker
          appendFinished = true
        },
      })
    )
    const dispatcher = new NormalizerDispatcher({ stderr, writer })
    dispatcher.register('claude', () => [/** @type {any} */ ({
      schema_version: 1,
      city: 'hyptown',
      provider_session_id: 'hy-1',
      provider_uuid: 'u-1',
      provider: 'claude',
      message_created_at: '2026-05-14T00:00:00Z',
      part_index: 0,
      part_type: 'text',
    })])
    dispatcher.dispatch({ provider: 'claude', uuid: 'u-1' }, ctx)
    let drained = false
    const drainPromise = dispatcher.drain().then(() => { drained = true })
    await new Promise((r) => setImmediate(r))
    expect(drained).toBe(false)
    expect(appendFinished).toBe(false)
    releaseAppend?.()
    await drainPromise
    expect(drained).toBe(true)
    expect(appendFinished).toBe(true)
  })

  it('the default passthrough emits a raw_frame row when no provider matches', () => {
    const dispatcher = new NormalizerDispatcher({ stderr: memoStream() })
    const rows = dispatcher.dispatch(
      { provider: 'gemini', uuid: 'u-X', timestamp: '2026-05-14T00:00:00Z' },
      ctx
    )
    expect(rows).toHaveLength(1)
    const row = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (rows[0]))
    expect(row.part_type).toBe('raw_frame')
    expect(row.provider).toBe('gemini')
    expect(row.provider_uuid).toBe('u-X')
    expect(row.provider_session_id).toBe('hy-1')
    expect(row.city).toBe('hyptown')
  })
})

// @ts-check

/**
 * `withSpan` and `runRoot` read `error_kind` out of the attribute bag they
 * were handed when the span opened, and wrote it in their catch. A body that
 * had already classified its own failure and written a typed kind before
 * throwing lost it: the catch overwrote it with `unhandled_exception`, so a
 * typed refusal exported as indistinguishable from a crash (issue #2364).
 *
 * LLP 0021#span-helpers calls `unhandled_exception` the *default* for a
 * thrown error, and that is all it is here: the helpers name a failure only
 * when nothing else did.
 *
 * `query.execute_sql` is the real caller. It catches `QueryExecutionBudgetError`,
 * writes `error_kind: 'budget_exceeded'`, and rethrows into the helper, so
 * every budget refusal reported itself as a crash.
 *
 * Asserted on captured spans: the thrown error and the log line were already
 * right while the exported attribute was not.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { SpanStatusCode, TracerProvider } from '../../src/core/observability/runtime.js'
import { runRoot, withSpan } from '../../src/core/observability/span_helpers.js'
import { executeQuerySql, QueryExecutionBudgetError } from '../../src/core/query/sql.js'

/**
 * Collect the spans exported while `fn` runs, then put the global tracer
 * provider slot back. As in `daemon-op-failure-telemetry.test.js`: a
 * provider left installed captures the next test's spans into a dead array.
 *
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<{ spans: any[], thrown: unknown }>}
 */
async function captureSpans(fn) {
  /** @type {any[]} */
  const spans = []
  const provider = new TracerProvider({
    resource: { attributes: {} },
    // Copy at export: a retained live Span is not what the exporter saw.
    exporters: [{
      exportBatch: (/** @type {any[]} */ batch) => {
        for (const s of batch) spans.push({ name: s.name, status: { ...s.status }, attributes: { ...s.attributes } })
      },
    }],
  })
  provider.register()
  /** @type {unknown} */
  let thrown
  try {
    await fn()
  } catch (err) {
    thrown = err
  } finally {
    await provider.shutdown()
  }
  return { spans, thrown }
}

/** @param {any[]} spans @param {string} name */
function spanNamed(spans, name) {
  const found = spans.find((s) => s.name === name)
  assert.ok(found, `the run emitted a ${name} span`)
  return found
}

test('a body that classified its own failure keeps that error_kind on the exported span', async () => {
  const { spans, thrown } = await captureSpans(() => withSpan('probe.typed', { status: 'ok' }, async (span) => {
    span.setAttribute('error_kind', 'budget_exceeded')
    throw new Error('refused')
  }))

  assert.ok(thrown instanceof Error, 'the throw reaches the caller')
  const span = spanNamed(spans, 'probe.typed')
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(span.attributes.status, 'failed')
  assert.equal(span.attributes.error_kind, 'budget_exceeded', 'the kind the body named survives the catch')
})

test('a failure nothing named still exports the default kind', async () => {
  const { spans } = await captureSpans(() => withSpan('probe.untyped', { status: 'ok' }, async () => {
    throw new Error('crashed')
  }))

  const span = spanNamed(spans, 'probe.untyped')
  assert.equal(span.attributes.error_kind, 'unhandled_exception', 'the default is not silently dropped')
})

test('an error_kind declared in the opening bag still stands when the body names none', async () => {
  const { spans } = await captureSpans(() => withSpan('probe.bagged', { status: 'ok', error_kind: 'bag_kind' }, async () => {
    throw new Error('crashed')
  }))

  assert.equal(spanNamed(spans, 'probe.bagged').attributes.error_kind, 'bag_kind')
})

test('a body that names a kind and returns is untouched', async () => {
  const { spans, thrown } = await captureSpans(() => withSpan('probe.returns', { status: 'ok' }, async (span) => {
    span.setAttribute('error_kind', 'soft_miss')
    return 'value'
  }))

  assert.equal(thrown, undefined)
  const span = spanNamed(spans, 'probe.returns')
  assert.equal(span.status.code, SpanStatusCode.OK)
  assert.equal(span.attributes.status, 'ok')
  assert.equal(span.attributes.error_kind, 'soft_miss', 'the success branch never wrote this attribute and still does not')
})

test('a non-Error throw loses neither the body kind nor the rendered message', async () => {
  const { spans, thrown } = await captureSpans(() => withSpan('probe.non_error', { status: 'ok' }, async (span) => {
    span.setAttribute('error_kind', 'protocol_violation')
    throw 'just a string'
  }))

  assert.ok(thrown instanceof Error, 'a non-Error throw is still wrapped')
  const span = spanNamed(spans, 'probe.non_error')
  assert.equal(span.status.message, 'just a string')
  assert.equal(span.attributes.error_kind, 'protocol_violation')
})

/**
 * Each span owns its own attributes, so a kind belongs to the frame that
 * named it. An outer frame that re-classified the same failure keeps its own
 * kind, and one that named nothing keeps the default rather than inheriting
 * whatever the inner frame decided.
 */
test('nested spans each export the kind their own body named', async () => {
  const { spans } = await captureSpans(() => withSpan('probe.outer', { status: 'ok' }, async (outer) => {
    try {
      await withSpan('probe.inner', { status: 'ok' }, async (inner) => {
        inner.setAttribute('error_kind', 'inner_kind')
        throw new Error('inner refused')
      })
    } catch (err) {
      outer.setAttribute('error_kind', 'outer_kind')
      throw err
    }
  }))

  assert.equal(spanNamed(spans, 'probe.inner').attributes.error_kind, 'inner_kind')
  assert.equal(spanNamed(spans, 'probe.outer').attributes.error_kind, 'outer_kind')
})

test('an outer span that names nothing does not inherit the inner span kind', async () => {
  const { spans } = await captureSpans(() => withSpan('probe.outer_silent', { status: 'ok' }, async () => {
    await withSpan('probe.inner_typed', { status: 'ok' }, async (inner) => {
      inner.setAttribute('error_kind', 'inner_kind')
      throw new Error('inner refused')
    })
  }))

  assert.equal(spanNamed(spans, 'probe.inner_typed').attributes.error_kind, 'inner_kind')
  assert.equal(spanNamed(spans, 'probe.outer_silent').attributes.error_kind, 'unhandled_exception')
})

/**
 * `runRoot` carries its own copy of the catch, so the guarantee is only
 * half-pinned until a boot or top-level command span is driven through it
 * too.
 */
test('a root span keeps the kind its body named, and defaults when the body named none', async () => {
  const typed = await captureSpans(() => runRoot('command.run', { hyp_command: 'query', status: 'ok' }, async (span) => {
    span.setAttribute('error_kind', 'config_write_failed')
    throw new Error('root refused')
  }))
  assert.equal(spanNamed(typed.spans, 'command.run').attributes.error_kind, 'config_write_failed')

  const untyped = await captureSpans(() => runRoot('command.run', { hyp_command: 'query', status: 'ok' }, async () => {
    throw new Error('root crashed')
  }))
  assert.equal(spanNamed(untyped.spans, 'command.run').attributes.error_kind, 'unhandled_exception')
})

/**
 * A data source that refuses the way the heap watchdog does. The genuine
 * trip is `query-sql-budget.test.js`'s subject and costs a 20k-row scan and
 * a forced GC to provoke; what is under test here is the seam below it,
 * which every refusal reaches identically: `executeQuerySql` recognizes the
 * typed error, writes `budget_exceeded`, and rethrows into `withSpan`.
 *
 * @param {Error} [err]
 */
function refusingRegistry(err) {
  const source = {
    columns: ['a'],
    numRows: 1,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          throw err ?? new QueryExecutionBudgetError(1, 2, { site: 'row_scan', rawBytes: 2, baselineBytes: 0, gcMode: 'unavailable' }, true)
        },
      }
    },
  }
  return /** @type {any} */ ({
    getDataset: () => ({ discoverPartitions: async () => [], createDataSource: async () => source }),
    listDatasets: () => [],
  })
}

const storage = /** @type {any} */ ({
  cacheRoot: '/tmp/hypaware-test',
  pendingInfo: async () => ({ pending: false }),
})

test('a budget refusal exports budget_exceeded on query.execute_sql', async () => {
  const { spans, thrown } = await captureSpans(() => executeQuerySql({
    query: 'SELECT a FROM t',
    registry: refusingRegistry(),
    storage,
  }))

  assert.ok(thrown instanceof QueryExecutionBudgetError, 'the typed refusal reaches the caller')
  const span = spanNamed(spans, 'query.execute_sql')
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(span.attributes.status, 'failed')
  assert.equal(span.attributes.error_kind, 'budget_exceeded', 'a refusal is no longer indistinguishable from a crash')
})

test('an untyped query failure still exports the default kind', async () => {
  const { spans } = await captureSpans(() => executeQuerySql({
    query: 'SELECT a FROM t',
    registry: refusingRegistry(new Error('the cache directory vanished')),
    storage,
  }))

  assert.equal(spanNamed(spans, 'query.execute_sql').attributes.error_kind, 'unhandled_exception')
})

/**
 * A body's own `setAttribute` write takes the same value bound the opening
 * bag does (issue #2376). Before, an in-body `error_kind` reached the
 * exporter as written: an object, `NaN` or a 5000-character string where
 * the bag path would have exported a bounded scalar.
 */
test('an oversized or object error_kind written in the body exports as a bounded scalar', async () => {
  const long = await captureSpans(() => withSpan('probe.long_kind', { status: 'ok' }, async (span) => {
    span.setAttribute('error_kind', 'x'.repeat(5000))
    throw new Error('refused')
  }))
  assert.equal(spanNamed(long.spans, 'probe.long_kind').attributes.error_kind, 'x'.repeat(512))

  const object = await captureSpans(() => runRoot('command.run', { hyp_command: 'query', status: 'ok' }, async (span) => {
    span.setAttributes({ error_kind: { kind: 'nested' } })
    throw new Error('root refused')
  }))
  assert.equal(spanNamed(object.spans, 'command.run').attributes.error_kind, '{"kind":"nested"}')
})

test('an error_kind nothing can describe falls back to the default kind', async () => {
  const unreadable = {
    toJSON() { throw new Error('no json') },
    toString() { throw new Error('no string') },
  }
  const { spans } = await captureSpans(() => withSpan('probe.unreadable_kind', { status: 'ok' }, async (span) => {
    span.setAttribute('error_kind', unreadable)
    throw new Error('refused')
  }))
  assert.equal(spanNamed(spans, 'probe.unreadable_kind').attributes.error_kind, 'unhandled_exception')

  const nulled = await captureSpans(() => withSpan('probe.null_kind', { status: 'ok' }, async (span) => {
    span.setAttribute('error_kind', null)
    throw new Error('refused')
  }))
  assert.equal(spanNamed(nulled.spans, 'probe.null_kind').attributes.error_kind, 'unhandled_exception')
})

test('typed scalars written on the success branch export unchanged', async () => {
  const { spans } = await captureSpans(() => withSpan('probe.scalars', { status: 'ok' }, async (span) => {
    span.setAttributes({ rows_written: 3, ratio: 0.5, released: false, error_kind: 'soft_miss', note: '' })
    span.setAttribute('elapsed_ms', Number.NaN)
  }))
  const attrs = spanNamed(spans, 'probe.scalars').attributes
  assert.equal(attrs.rows_written, 3)
  assert.equal(attrs.ratio, 0.5)
  assert.equal(attrs.released, false)
  assert.equal(attrs.error_kind, 'soft_miss')
  assert.equal(attrs.note, '')
  assert.equal(attrs.elapsed_ms, 0, 'a non-finite number is bounded as the bag path bounds it')
})

// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'
import v8 from 'node:v8'
import vm from 'node:vm'

import {
  DEFAULT_RUNTIME_METRICS_INTERVAL_MS,
  MAX_RUNTIME_METRICS_INTERVAL_MS,
  MIN_RUNTIME_METRICS_INTERVAL_MS,
  readObservabilityEnv,
} from '../../src/core/observability/env.js'
import { installObservability } from '../../src/core/observability/index.js'
import { MeterProvider } from '../../src/core/observability/runtime.js'
import { installRuntimeMetrics } from '../../src/core/observability/runtime_metrics.js'

/** @import { MetricRecord } from '../../src/core/observability/types.js' */

// The GC dimension is bounded by construction: a four-entry kind map plus the
// `other` fallback for a kind V8 adds later. Spelled out here rather than
// imported so the test states independently what the sampler may emit.
const GC_KINDS = new Set(['major', 'minor', 'incremental', 'weak_callback', 'other'])

test('runtime metric env parsing defaults, clamps, and rejects malformed intervals', () => {
  const defaults = readObservabilityEnv({})
  assert.equal(defaults.runtimeMetrics, false)
  assert.equal(defaults.runtimeMetricsIntervalMs, DEFAULT_RUNTIME_METRICS_INTERVAL_MS)

  const enabled = readObservabilityEnv({
    HYP_OTEL_RUNTIME_METRICS: 'true',
    HYP_OTEL_RUNTIME_METRICS_INTERVAL_MS: '1000',
  })
  assert.equal(enabled.runtimeMetrics, true)
  assert.equal(enabled.runtimeMetricsIntervalMs, MIN_RUNTIME_METRICS_INTERVAL_MS)

  const malformed = readObservabilityEnv({
    HYP_OTEL_RUNTIME_METRICS: '1',
    HYP_OTEL_RUNTIME_METRICS_INTERVAL_MS: '10seconds',
  })
  assert.equal(malformed.runtimeMetrics, true)
  assert.equal(malformed.runtimeMetricsIntervalMs, DEFAULT_RUNTIME_METRICS_INTERVAL_MS)

  const absurd = readObservabilityEnv({
    HYP_OTEL_RUNTIME_METRICS: '1',
    HYP_OTEL_RUNTIME_METRICS_INTERVAL_MS: '99999999999',
  })
  assert.equal(absurd.runtimeMetricsIntervalMs, MAX_RUNTIME_METRICS_INTERVAL_MS)
})

// An interval past Node's 32-bit timer range does not schedule a very slow
// timer: Node warns and resets the delay to 1ms. Without the ceiling the knob
// meant to slow sampling down turns it into the tight loop the floor forbids.
test('an out-of-range interval still samples once, not on a 1ms loop', async () => {
  /** @type {MetricRecord[][]} */
  const batches = []
  const provider = new MeterProvider({
    resource: { attributes: { 'service.name': 'hypaware-runtime-metrics-test' } },
    exporters: [{ exportBatch(records) { batches.push(records) } }],
  })
  const env = readObservabilityEnv({
    HYP_OTEL_RUNTIME_METRICS: '1',
    HYP_OTEL_RUNTIME_METRICS_INTERVAL_MS: '99999999999',
  })
  const sampler = installRuntimeMetrics({ env, provider })
  try {
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    assert.equal(batches.length, 1, `sampler ticked ${batches.length} times in 100ms`)
  } finally {
    sampler?.stop()
  }
})

test('runtime metrics do no work when no meter exporter is installed', async () => {
  const env = readObservabilityEnv({ HYP_OTEL_RUNTIME_METRICS: '1' })
  const obs = installObservability({ env })
  try {
    assert.equal(obs.meter.provider, null)
    assert.equal(obs.runtimeMetrics, null)
  } finally {
    await obs.shutdown()
  }
})

test('one runtime sample is handed to the exporter as one diagnostic batch', () => {
  /** @type {MetricRecord[][]} */
  const batches = []
  const provider = new MeterProvider({
    resource: { attributes: { 'service.name': 'hypaware-runtime-metrics-test' } },
    exporters: [{ exportBatch(records) { batches.push(records) } }],
  })
  const env = readObservabilityEnv({ HYP_OTEL_RUNTIME_METRICS: '1' })
  const sampler = installRuntimeMetrics({ env, provider })
  try {
    assert.equal(sampler?.active, true)
    assert.equal(batches.length, 1)
    const metrics = batches[0]
    const names = new Set(metrics.map((metric) => metric.name))
    assert.ok(names.has('hyp_runtime_memory_bytes'))
    assert.ok(names.has('hyp_runtime_heap_space_bytes'))
    assert.ok(names.has('hyp_runtime_host_memory_bytes'))
    assert.ok(names.has('hyp_runtime_active_resources'))
    assert.ok(names.has('hyp_runtime_sampler_collect_duration_ms'))
    assert.ok(metrics.length > 20)
    assert.ok(metrics.length < 100)
  } finally {
    sampler?.stop()
  }
})

// The whole claim of LLP 0318 is that this surface is bounded, so the test that
// matters is the one that fails when a future attribute is unbounded. A pid, a
// path, a session id or a table name here mints a new time series per value and
// degrades a metrics backend silently.
test('every runtime attribute comes from a small closed vocabulary', () => {
  /** @type {MetricRecord[][]} */
  const batches = []
  const provider = new MeterProvider({
    resource: { attributes: { 'service.name': 'hypaware-runtime-metrics-test' } },
    exporters: [{ exportBatch(records) { batches.push(records) } }],
  })
  const env = readObservabilityEnv({ HYP_OTEL_RUNTIME_METRICS: '1' })
  const sampler = installRuntimeMetrics({ env, provider })
  try {
    assertBoundedVocabulary(batches.flat())
    assert.ok(batches.flat().some((metric) => metric.attributes.area === 'heap_used'))
    assert.equal(batches.flat().some((metric) => metric.attributes.area === 'heapUsed'), false)
  } finally {
    sampler?.stop()
  }
})

// The eager first sample runs before the GC observer can have seen anything, so
// a test that stops the sampler on the first batch never emits a `kind`
// attribute at all: the dimension reads as safe only because it is unreachable.
// Force a collection and let a later tick land so `kind` is actually exercised
// by the vocabulary rules that guard every other dimension.
// @ref LLP 0318#surface [tests]: GC kind is one of the bounded runtime enums, so a post-collection sample must exercise it
test('a sample after a collection carries the bounded gc kind dimension', async () => {
  /** @type {MetricRecord[][]} */
  const batches = []
  const provider = new MeterProvider({
    resource: { attributes: { 'service.name': 'hypaware-runtime-metrics-test' } },
    exporters: [{ exportBatch(records) { batches.push(records) } }],
  })
  // The 5s floor is a parsing rule for operator input, not a sampler contract.
  // Override it directly so the second tick is observable in test time.
  const env = {
    ...readObservabilityEnv({ HYP_OTEL_RUNTIME_METRICS: '1' }),
    runtimeMetricsIntervalMs: 25,
  }
  const sampler = installRuntimeMetrics({ env, provider })
  try {
    assert.equal(
      batches[0].some((metric) => metric.name.startsWith('hyp_runtime_gc_')),
      false,
      'the eager first sample cannot carry gc points, so gc coverage needs a later tick',
    )

    /** @type {MetricRecord[]} */
    let gcPoints = []
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      forceGarbageCollection()
      await new Promise((resolve) => { setTimeout(resolve, 25) })
      gcPoints = batches.flat().filter((metric) => metric.name.startsWith('hyp_runtime_gc_'))
      if (gcPoints.length > 0) break
    }
    assert.ok(gcPoints.length > 0, 'no gc points were emitted after forcing a collection')

    const names = new Set(gcPoints.map((metric) => metric.name))
    assert.ok(names.has('hyp_runtime_gc_events'), 'a collection emits no gc event count')
    assert.ok(names.has('hyp_runtime_gc_duration_ms'), 'a collection emits no gc duration')
    for (const metric of gcPoints) {
      assert.equal(
        Object.keys(metric.attributes).join(','),
        'kind',
        `${metric.name} must carry exactly the kind dimension`,
      )
      assert.ok(metric.value > 0, `${metric.name} reported a non-positive ${metric.value}`)
    }
    // Bounded by construction, so bounded in the emitted stream too: the whole
    // point of the dimension is that it cannot mint a series per collection.
    const kinds = new Set(gcPoints.map((metric) => String(metric.attributes.kind)))
    for (const kind of kinds) {
      assert.ok(GC_KINDS.has(kind), `kind=${kind} is not a known v8 collection kind`)
    }
    assert.ok(kinds.size <= GC_KINDS.size, `gc emitted ${kinds.size} distinct kinds`)

    // And the generic rules that catch a pid or a path smuggled into any
    // dimension now run over batches that actually contain `kind`.
    assertBoundedVocabulary(batches.flat())
  } finally {
    sampler?.stop()
  }
})

/**
 * Assert that every attribute on every point names a dimension from the closed
 * runtime vocabulary and carries a short enum member rather than an identifier.
 *
 * @param {MetricRecord[]} metrics
 */
function assertBoundedVocabulary(metrics) {
  const allowedKeys = new Set(['area', 'space', 'statistic', 'kind', 'window', 'resource'])
  // `space` values come straight from v8.getHeapSpaceStatistics(), a
  // genuinely closed vocabulary whose members V8 has been widening (a
  // shared_trusted_large_object_space landed in Node 24). Check membership
  // against the live set instead of guessing a length bound that the next
  // V8 revision can bust; every other dimension keeps the generic
  // short-enum length rule.
  const heapSpaceNames = new Set(v8.getHeapSpaceStatistics().map((space) => space.space_name))
  for (const metric of metrics) {
    const entries = Object.entries(metric.attributes)
    assert.ok(entries.length <= 2, `${metric.name} carries ${entries.length} attributes`)
    for (const [key, value] of entries) {
      assert.ok(allowedKeys.has(key), `unexpected runtime attribute key ${key}`)
      assert.equal(typeof value, 'string', `${key} must be an enum string, got ${typeof value}`)
      const text = String(value)
      // A path, a url, or a timestamp fails the shape check; a bare pid or
      // any other numeric per-process identifier fails the digits check.
      assert.match(text, /^[A-Za-z0-9][A-Za-z0-9_]*$/, `${key}=${text} does not look like an enum member`)
      assert.doesNotMatch(text, /^[0-9]+$/, `${key}=${text} looks like a per-process identifier`)
      // The shape check alone still admits an identifier concatenated onto
      // an enum prefix (`Timeout_1234`). No member of this vocabulary runs
      // three digits together - `p50`, `15m` and `Http2Session` are the
      // longest digit sequences it has - so a pid, port, or timestamp
      // smuggled into any dimension fails here.
      assert.doesNotMatch(text, /[0-9]{3}/, `${key}=${text} embeds a numeric identifier`)
      if (key === 'space') {
        assert.ok(heapSpaceNames.has(text), `space=${text} is not a real v8 heap space name`)
      } else if (key === 'kind') {
        assert.ok(GC_KINDS.has(text), `kind=${text} is not a known v8 collection kind`)
      } else {
        assert.ok(text.length > 0 && text.length <= 32, `${key}=${text} is not a short enum value`)
      }
    }
  }
}

/**
 * Provoke a collection the sampler's PerformanceObserver will report. Prefer a
 * real forced major GC over allocation churn so the test does not depend on
 * heap pressure it cannot control; fall back to churn if the host build will
 * not hand out `gc`.
 */
function forceGarbageCollection() {
  const forced = loadForcedGc()
  if (forced) {
    forced()
    return
  }
  for (let round = 0; round < 64; round += 1) {
    const junk = new Array(100_000).fill(round)
    if (junk.length !== 100_000) throw new Error('allocation churn failed')
  }
}

/** @type {(() => void)|null|undefined} */
let forcedGc

function loadForcedGc() {
  if (forcedGc !== undefined) return forcedGc
  const exposed = Reflect.get(globalThis, 'gc')
  if (typeof exposed === 'function') {
    forcedGc = /** @type {() => void} */ (exposed)
    return forcedGc
  }
  try {
    v8.setFlagsFromString('--expose-gc')
    const candidate = vm.runInNewContext('gc')
    v8.setFlagsFromString('--no-expose-gc')
    forcedGc = typeof candidate === 'function' ? /** @type {() => void} */ (candidate) : null
  } catch {
    forcedGc = null
  }
  return forcedGc
}

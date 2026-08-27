// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RUNTIME_METRICS_INTERVAL_MS,
  MIN_RUNTIME_METRICS_INTERVAL_MS,
  readObservabilityEnv,
} from '../../src/core/observability/env.js'
import { installObservability } from '../../src/core/observability/index.js'
import { MeterProvider } from '../../src/core/observability/runtime.js'
import { installRuntimeMetrics } from '../../src/core/observability/runtime_metrics.js'

/** @import { MetricRecord } from '../../src/core/observability/types.js' */

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
    const allowedKeys = new Set(['area', 'space', 'statistic', 'kind', 'window', 'resource'])
    for (const metric of batches.flat()) {
      const entries = Object.entries(metric.attributes)
      assert.ok(entries.length <= 2, `${metric.name} carries ${entries.length} attributes`)
      for (const [key, value] of entries) {
        assert.ok(allowedKeys.has(key), `unexpected runtime attribute key ${key}`)
        assert.equal(typeof value, 'string', `${key} must be an enum string, got ${typeof value}`)
        const text = String(value)
        assert.ok(text.length > 0 && text.length <= 32, `${key}=${text} is not a short enum value`)
        // A path, a url, or a timestamp fails the shape check; a bare pid or
        // any other numeric per-process identifier fails the digits check.
        assert.match(text, /^[A-Za-z0-9][A-Za-z0-9_]*$/, `${key}=${text} does not look like an enum member`)
        assert.doesNotMatch(text, /^[0-9]+$/, `${key}=${text} looks like a per-process identifier`)
      }
    }
    assert.ok(batches.flat().some((metric) => metric.attributes.area === 'heap_used'))
    assert.equal(batches.flat().some((metric) => metric.attributes.area === 'heapUsed'), false)
  } finally {
    sampler?.stop()
  }
})

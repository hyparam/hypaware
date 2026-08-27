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
  } finally {
    sampler?.stop()
  }
})

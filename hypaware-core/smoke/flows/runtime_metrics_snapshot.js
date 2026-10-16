// @ts-check

import { installObservability } from '../../../src/core/observability/index.js'

/**
 * Enable the opt-in runtime sampler against the smoke harness's JSONL meter
 * provider. The sampler emits an immediate snapshot, so the flow proves the
 * exporter wiring and bounded diagnostic surface without sleeping for an
 * interval.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0318#activation [tests]: the env switch activates only after the harness installs a metrics exporter
 * @ref LLP 0318#surface [tests]: one snapshot carries memory, heap-space, host, resource, and sampler-cost metrics
 */
export async function run({ harness, expect }) {
  process.env.HYP_OTEL_RUNTIME_METRICS = '1'
  const obs = installObservability()
  if (!obs.runtimeMetrics?.active) {
    throw new Error('runtime_metrics_snapshot: runtime metrics sampler was not installed')
  }

  await obs.shutdown()

  const metrics = await expect.metrics()
  const names = new Set(metrics.map((/** @type {any} */ metric) => metric.name))
  expect.that(
    'metrics: runtime memory snapshot present',
    names,
    (values) => values.has('hyp_runtime_memory_bytes'),
  )
  expect.that(
    'metrics: V8 heap-space snapshot present',
    names,
    (values) => values.has('hyp_runtime_heap_space_bytes'),
  )
  expect.that(
    'metrics: host memory snapshot present',
    names,
    (values) => values.has('hyp_runtime_host_memory_bytes'),
  )
  expect.that(
    'metrics: active resource counts present',
    names,
    (values) => values.has('hyp_runtime_active_resources'),
  )
  expect.that(
    'metrics: sampler collection cost present',
    names,
    (values) => values.has('hyp_runtime_sampler_collect_duration_ms'),
  )
  expect.that(
    'metrics: snapshot is significant but bounded',
    metrics,
    (rows) => rows.length > 20 && rows.length < 100,
  )
  expect.that(
    'metrics: every point carries the smoke dev_run_id resource',
    metrics,
    (rows) => rows.every((row) => row.resource?.dev_run_id === harness.devRunId),
  )
}

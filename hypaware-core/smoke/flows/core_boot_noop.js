// @ts-check

import {
  installObservability,
  getLogger,
  getKernelInstruments,
  runRoot,
  Attr,
} from '../../../src/core/observability/index.js'

/**
 * Phase 0 baseline. Boots the observability layer, opens a single
 * `kernel.boot` root span, emits one INFO log scoped to the kernel,
 * records the `hyp_plugins_loaded` counter at 0, then flushes and
 * asserts the JSONL artifacts match the §Phase 0 contract.
 *
 * Assertions:
 * - traces: one span named `kernel.boot`, `serviceName=hypaware-dev`,
 *   `status=ok`, `durationMs > 0`
 * - logs:   one INFO record with `hyp_component=kernel` and
 *           `smoke_step=core_boot_noop`
 * - metrics: `hyp_plugins_loaded` present with Sum = 0
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'core_boot_noop: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const log = getLogger('kernel')
  const instruments = getKernelInstruments()

  await runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'boot',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'core_boot_noop',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    () => {
      log.info('core boot noop', {
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'core_boot_noop',
        [Attr.DEV_RUN_ID]: harness.devRunId,
      })
      instruments.pluginsLoaded.add(0)
    }
  )

  await obs.shutdown()

  const traces = await expect.traces()
  const logs = await expect.logs()
  const metrics = await expect.metrics()

  const bootSpans = traces.filter((t) => t.name === 'kernel.boot')
  expect.that('traces: exactly one kernel.boot span', bootSpans, (rows) => rows.length === 1)
  const boot = bootSpans[0]
  expect.that('traces: kernel.boot serviceName=hypaware-dev', boot.serviceName, (v) => v === 'hypaware-dev')
  expect.that('traces: kernel.boot status=ok', boot.status, (v) => v === 'ok')
  expect.that('traces: kernel.boot durationMs > 0', boot.durationMs, (v) => typeof v === 'number' && v > 0)
  expect.that(
    'traces: kernel.boot has dev_run_id attribute',
    boot.attributes?.dev_run_id,
    (v) => v === harness.devRunId
  )

  const kernelInfo = logs.filter(
    (l) =>
      l.severityText === 'INFO' &&
      l.attributes?.hyp_component === 'kernel' &&
      l.attributes?.smoke_step === 'core_boot_noop'
  )
  expect.that(
    'logs: exactly one INFO with hyp_component=kernel and smoke_step=core_boot_noop',
    kernelInfo,
    (rows) => rows.length === 1
  )

  const pluginsLoaded = metrics.filter((m) => m.name === 'hyp_plugins_loaded')
  expect.that('metrics: hyp_plugins_loaded present', pluginsLoaded, (rows) => rows.length >= 1)
  const sum = pluginsLoaded.reduce((acc, m) => acc + (typeof m.value === 'number' ? m.value : 0), 0)
  expect.that('metrics: hyp_plugins_loaded Sum = 0', sum, (v) => v === 0)
}

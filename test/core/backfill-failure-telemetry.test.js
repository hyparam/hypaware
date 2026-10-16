// @ts-check

/**
 * A backfill run has several steps that can fail independently, and
 * `backfill.provider_finish` (plus the sweep's own settlement log) is what
 * an operator reads to find out which one did. One kind for all of them
 * names a provider run failure for a run that scanned, materialized and
 * wrote cleanly and then lost its forced flush (issue #2255).
 *
 * Asserted on captured spans and log records, because prose about telemetry
 * proves nothing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { runRoot } from '../../src/core/observability/index.js'
import { TracerProvider } from '../../src/core/observability/runtime.js'
import { runBackfillProvider } from '../../src/core/commands/backfill.js'
import { createBackfillSweepDriver } from '../../src/core/daemon/backfill_sweep.js'
import {
  createBackfillMaterializerRegistry,
  createBackfillRegistry,
} from '../../src/core/registry/backfills.js'
import { withLogRecords } from '../helpers/log_records.js'

const ITEM = { dataset: 'ds', kind: 'test.kind', value: { x: 1 } }

/**
 * A runner context over one provider that yields a single item, with a
 * switch for each step that can fail independently.
 *
 * @param {{
 *   providerThrows?: boolean,
 *   providerThrowsAfterYield?: boolean,
 *   flushThrows?: boolean,
 *   registerMaterializer?: boolean,
 *   materializerDataset?: string,
 *   registeredDatasets?: string[],
 * }} [opts]
 */
function runnerCtx(opts = {}) {
  const backfills = createBackfillRegistry()
  backfills.register({
    name: 'tester',
    plugin: '@test/plugin',
    datasets: [ITEM.dataset],
    async *run() {
      if (opts.providerThrows) throw new Error('provider generator blew up')
      yield ITEM
      if (opts.providerThrowsAfterYield) throw new Error('provider generator blew up mid-stream')
    },
  })
  const backfillMaterializers = createBackfillMaterializerRegistry()
  if (opts.registerMaterializer ?? true) {
    backfillMaterializers.register({
      kind: ITEM.kind,
      dataset: opts.materializerDataset ?? ITEM.dataset,
      plugin: '@test/plugin',
      materialize() { return [{ a: 1 }] },
    })
  }
  const registered = new Set(opts.registeredDatasets ?? [ITEM.dataset])
  const storage = {
    cacheRoot: '/tmp/fake-cache',
    /** @param {string} dataset @param {string[]} segs */
    cacheTablePath(dataset, segs) { return `/tmp/fake-cache/datasets/${dataset}/${segs.join('/')}` },
    async appendRows() {},
    async flushTable() {
      if (opts.flushThrows) throw new Error('forced flush blew up')
    },
  }
  const query = {
    /** @param {string} name */
    getDataset(name) {
      if (!registered.has(name)) return undefined
      return { name, plugin: '@test/plugin', schema: { columns: [{ name: 'a', type: 'INT32', nullable: true }] } }
    },
  }
  return /** @type {any} */ ({ env: {}, config: {}, backfills, backfillMaterializers, query, storage })
}

/**
 * Run one provider with every span captured.
 *
 * @param {any} ctx
 */
async function runWithSpans(ctx) {
  /** @type {any[]} */
  const captured = []
  const provider = new TracerProvider({
    resource: { attributes: {} },
    exporters: [{ exportBatch(spans) { captured.push(...spans) } }],
  })
  provider.register()
  /** @type {any} */
  let result
  try {
    await runRoot('command.run', { hyp_command: 'backfill', status: 'ok' }, async () => {
      result = await runBackfillProvider({ ctx, provider: 'tester', dryRun: false })
    })
  } finally {
    await provider.shutdown()
  }
  const finish = captured.find((span) => span.name === 'backfill.provider_finish')
  assert.ok(finish, 'the run emitted a backfill.provider_finish span')
  return { result, finish }
}

for (const scenario of [
  {
    name: 'the provider generator throws',
    opts: { providerThrows: true },
    errorKind: 'provider_run_failed',
  },
  {
    name: 'only the forced flush throws',
    opts: { flushThrows: true },
    errorKind: 'flush_failed',
  },
  {
    name: 'no materializer is registered for the yielded kind',
    opts: { registerMaterializer: false },
    errorKind: 'materializer_missing',
  },
  {
    name: 'the materializer targets another dataset',
    opts: { materializerDataset: 'other_ds' },
    errorKind: 'dataset_mismatch',
  },
  {
    name: 'the write finds no registered dataset',
    opts: { registeredDatasets: [] },
    errorKind: 'dataset_not_registered',
  },
]) {
  test(`provider_finish names the step that failed when ${scenario.name}`, async () => {
    // @ref LLP 0021#the-attribute-contract [tests]: a failure's `error_kind` names the step that broke
    const { result, finish } = await runWithSpans(runnerCtx(scenario.opts))
    assert.equal(finish.attributes.status, 'failed')
    assert.equal(finish.attributes.error_kind, scenario.errorKind)
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, scenario.errorKind, 'the compact result carries the same kind')
  })
}

/**
 * Two failures in one run. `markProviderFailed` sets `error` and
 * `error_kind` with `??=` on adjacent lines, so the first failure has to
 * win both and neither can be set without the other. Swap the
 * `error_kind ??=` for `=` and these two are what notices. The `error`
 * half is pinned elsewhere, by backfill-command.test.js's "a flush that
 * throws while handling a provider error does not mask that error".
 */
for (const scenario of [
  {
    name: 'a provider that throws after yielding beats a later flush failure',
    opts: { providerThrowsAfterYield: true, flushThrows: true },
    errorKind: 'provider_run_failed',
  },
  {
    name: 'an item failure beats a later flush failure',
    opts: { registerMaterializer: false, flushThrows: true },
    errorKind: 'materializer_missing',
  },
]) {
  test(`provider_finish reports the first failure when ${scenario.name}`, async () => {
    const { result, finish } = await runWithSpans(runnerCtx(scenario.opts))
    assert.equal(finish.attributes.status, 'failed')
    assert.equal(finish.attributes.error_kind, scenario.errorKind)
    assert.equal(result.errorKind, scenario.errorKind, 'the compact result carries the same kind')
  })
}

test('provider_finish leaves a clean run unmarked', async () => {
  const { result, finish } = await runWithSpans(runnerCtx())
  assert.equal(finish.attributes.status, 'ok')
  assert.equal(finish.attributes.error_kind, undefined)
  assert.equal(result.ok, true)
  assert.equal(result.errorKind, undefined)
})

/* ---------------------------- the sweep driver ---------------------------- */

test('the sweep settlement log reports the step the run reported, not provider_run_failed', async () => {
  const contribution = {
    name: 'openclaw',
    plugin: '@hypaware/openclaw',
    datasets: ['ai_gateway_messages'],
    sweep: { cron: '*/5 * * * *' },
    async *run() {},
  }
  const driver = createBackfillSweepDriver({
    backfills: /** @type {any} */ ({
      register() {},
      get: (/** @type {string} */ name) => (name === contribution.name ? contribution : undefined),
      list: () => [contribution],
    }),
    backfillMaterializers: /** @type {any} */ ({ register() {}, get: () => undefined, list: () => [] }),
    env: /** @type {any} */ ({ HYP_HOME: '/nonexistent-home' }),
    storage: /** @type {any} */ ({ cacheRoot: '/nonexistent-cache' }),
    query: /** @type {any} */ ({ getDataset: () => undefined }),
    runBackfill: async () => ({ ok: false, scanned: 1, rowsWritten: 1, skipped: 0, errorKind: 'flush_failed' }),
  })
  const { result: report, records } = await withLogRecords(async () => {
    const fired = await driver.tick({ now: new Date('2026-08-01T10:05:00.000Z') })
    // Two macrotask turns: the run is fired, not awaited, so its settlement
    // handler (which is what logs) runs after the tick resolves.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    return fired
  })

  assert.deepEqual(report.fired, ['openclaw'])
  const settled = records.find((record) => record.body === 'backfill.sweep_finished')
  assert.ok(settled, 'the sweep logged a settlement for the fired run')
  assert.equal(settled.attributes.status, 'failed')
  assert.equal(settled.attributes.error_kind, 'flush_failed')
})

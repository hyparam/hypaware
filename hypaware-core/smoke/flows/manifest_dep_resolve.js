// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  Attr,
  getKernelInstruments,
  getLogger,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'

/**
 * Phase 1 smoke. Seeds three temp plugin trees, loads their manifests
 * through `manifest.load`, then resolves the dependency graph. Asserts
 * the §Phase 1 instrumentation contract:
 *
 * - traces: a `manifest.load` span per manifest with `status=ok` for
 *   `@hypaware/dummy-a` and `@hypaware/dummy-b`
 * - logs: a `dep_graph.reject` for `@hypaware/dummy-cycle` with
 *   `error_kind=cycle`, and exactly one `cap.require_satisfied` for
 *   `hypaware.dummy` with `provider=@hypaware/dummy-a`
 * - metrics: `hyp_capabilities_provided` ticked at least once for
 *   `hypaware.dummy`
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'manifest_dep_resolve: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  const pluginsDir = path.join(harness.tmpDir, 'plugins')
  await fs.mkdir(pluginsDir, { recursive: true })

  const dummyADir = path.join(pluginsDir, 'dummy-a')
  const dummyBDir = path.join(pluginsDir, 'dummy-b')
  const dummyCycleDir = path.join(pluginsDir, 'dummy-cycle')

  await writeManifest(dummyADir, {
    schema_version: 1,
    name: '@hypaware/dummy-a',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    provides: { capabilities: { 'hypaware.dummy': '1.0.0' } },
  })

  await writeManifest(dummyBDir, {
    schema_version: 1,
    name: '@hypaware/dummy-b',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    requires: { capabilities: { 'hypaware.dummy': '^1.0.0' } },
  })

  await writeManifest(dummyCycleDir, {
    schema_version: 1,
    name: '@hypaware/dummy-cycle',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    requires: { plugins: { '@hypaware/dummy-cycle': '*' } },
  })

  const kernelLog = getLogger('kernel')
  const kernelInstruments = getKernelInstruments()

  const resolution = await runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'boot',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'manifest_dep_resolve',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const { loaded, failed } = await loadManifests([dummyADir, dummyBDir, dummyCycleDir])
      kernelLog.info('manifests loaded', {
        [Attr.SMOKE_STEP]: 'manifest_dep_resolve',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        hyp_loaded_count: loaded.length,
        hyp_failed_count: failed.length,
      })
      kernelInstruments.pluginsLoaded.add(0)
      return resolveDependencies(loaded.map((l) => l.manifest))
    }
  )

  await obs.shutdown()

  const traces = await expect.traces()
  const logs = await expect.logs()
  const metrics = await expect.metrics()

  const manifestLoads = traces.filter((t) => t.name === 'manifest.load')
  expect.that(
    'traces: three manifest.load spans (one per seeded plugin)',
    manifestLoads,
    (rows) => rows.length === 3
  )

  const byPlugin = new Map(manifestLoads.map((t) => [t.attributes?.hyp_plugin, t]))
  const a = byPlugin.get('@hypaware/dummy-a')
  const b = byPlugin.get('@hypaware/dummy-b')
  expect.that('traces: manifest.load for @hypaware/dummy-a status=ok', a?.status, (v) => v === 'ok')
  expect.that('traces: manifest.load for @hypaware/dummy-b status=ok', b?.status, (v) => v === 'ok')

  const cycleRejections = logs.filter(
    (l) =>
      l.body === 'dep_graph.reject' &&
      l.attributes?.error_kind === 'cycle' &&
      l.attributes?.hyp_plugin === '@hypaware/dummy-cycle'
  )
  expect.that(
    'logs: exactly one dep_graph.reject for @hypaware/dummy-cycle with error_kind=cycle',
    cycleRejections,
    (rows) => rows.length === 1
  )

  const capSatisfied = logs.filter(
    (l) =>
      l.body === 'cap.require_satisfied' &&
      l.attributes?.hyp_capability === 'hypaware.dummy'
  )
  expect.that(
    'logs: exactly one cap.require_satisfied for hypaware.dummy',
    capSatisfied,
    (rows) => rows.length === 1
  )
  const satisfied = capSatisfied[0]
  expect.that(
    'logs: cap.require_satisfied provider=@hypaware/dummy-a',
    satisfied?.attributes?.provider,
    (v) => v === '@hypaware/dummy-a'
  )
  expect.that(
    'logs: cap.require_satisfied requester=@hypaware/dummy-b',
    satisfied?.attributes?.hyp_plugin,
    (v) => v === '@hypaware/dummy-b'
  )
  expect.that(
    'logs: cap.require_satisfied carries dev_run_id',
    satisfied?.attributes?.dev_run_id,
    (v) => v === harness.devRunId
  )

  const resolveSpans = traces.filter((t) => t.name === 'dep_graph.resolve')
  expect.that(
    'traces: exactly one dep_graph.resolve span',
    resolveSpans,
    (rows) => rows.length === 1
  )
  const resolve = resolveSpans[0]
  expect.that(
    'traces: dep_graph.resolve hyp_plugin_count = 3',
    resolve?.attributes?.hyp_plugin_count,
    (v) => v === 3
  )
  expect.that(
    'traces: dep_graph.resolve hyp_capability_count = 1',
    resolve?.attributes?.hyp_capability_count,
    (v) => v === 1
  )

  const capsProvided = metrics.filter((m) => m.name === 'hyp_capabilities_provided')
  expect.that(
    'metrics: hyp_capabilities_provided emitted at least once',
    capsProvided,
    (rows) => rows.length >= 1
  )
  const dummyCap = capsProvided.find(
    (m) => m.attributes?.hyp_capability === 'hypaware.dummy'
  )
  expect.that(
    'metrics: hyp_capabilities_provided has a data point for hypaware.dummy',
    dummyCap,
    (v) => !!v
  )

  expect.that(
    'resolution: order is [dummy-a, dummy-b]',
    resolution.order,
    (v) => Array.isArray(v) && v.length === 2 && v[0] === '@hypaware/dummy-a' && v[1] === '@hypaware/dummy-b'
  )
  expect.that(
    'resolution: dummy-cycle reported as unsatisfied with error_kind=cycle',
    resolution.unsatisfied,
    (rows) => rows.some((r) => r.plugin === '@hypaware/dummy-cycle' && r.errorKind === 'cycle')
  )
}

/**
 * @param {string} dir
 * @param {Record<string, unknown>} manifest
 */
async function writeManifest(dir, manifest) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify(manifest, null, 2)
  )
}

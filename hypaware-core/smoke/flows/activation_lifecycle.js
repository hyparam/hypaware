// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { resolveDependencies } from '../../../src/core/dep_graph.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'

/**
 * Phase 2 smoke. Seeds two real-but-empty plugin trees, loads their
 * manifests, resolves the dep graph, then activates both inside a
 * single `kernel.boot` root span. Asserts the §Phase 2 contract:
 *
 * - traces: exactly two `plugin.activate` spans, both children of the
 *   same `kernel.boot` span, both `status=ok`
 * - metrics: `hyp_plugins_loaded` Sum = 2; per-plugin data points
 *   carry `hyp_plugin` at value 1 each
 * - filesystem: each plugin's `stateDir` exists under the temp install
 *   root
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'activation_lifecycle: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const pluginsDir = path.join(harness.tmpDir, 'plugins')
  await fs.mkdir(pluginsDir, { recursive: true })

  const dummyADir = path.join(pluginsDir, 'dummy-a')
  const dummyBDir = path.join(pluginsDir, 'dummy-b')

  await writePlugin(dummyADir, {
    manifest: {
      schema_version: 1,
      name: '@hypaware/dummy-a',
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
    },
    entrypoint: dummyEntrypoint('@hypaware/dummy-a'),
  })

  await writePlugin(dummyBDir, {
    manifest: {
      schema_version: 1,
      name: '@hypaware/dummy-b',
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
    },
    entrypoint: dummyEntrypoint('@hypaware/dummy-b'),
  })

  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  const activation = await runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'boot',
      [Attr.SMOKE_NAME]: harness.smokeName,
      [Attr.SMOKE_STEP]: 'activation_lifecycle',
      [Attr.DEV_RUN_ID]: harness.devRunId,
      status: 'ok',
    },
    async () => {
      const { loaded } = await loadManifests([dummyADir, dummyBDir])
      const resolution = await resolveDependencies(loaded.map((l) => l.manifest))
      const byName = new Map(loaded.map((l) => [l.manifest.name, l]))
      const entries = resolution.order.map((name) => {
        const lm = /** @type {NonNullable<ReturnType<typeof byName.get>>} */ (byName.get(name))
        return { manifest: lm.manifest, rootDir: lm.rootDir }
      })
      return activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        tmpRoot,
      })
    }
  )

  await obs.shutdown()

  expect.that(
    'activation: every plugin activated successfully',
    activation.results,
    (rows) => Array.isArray(rows) && rows.length === 2 && rows.every((r) => r.ok === true)
  )

  const traces = await expect.traces()
  const metrics = await expect.metrics()

  const bootSpans = traces.filter((t) => t.name === 'kernel.boot')
  expect.that('traces: exactly one kernel.boot span', bootSpans, (rows) => rows.length === 1)
  const boot = bootSpans[0]

  const activateSpans = traces.filter((t) => t.name === 'plugin.activate')
  expect.that(
    'traces: exactly two plugin.activate spans',
    activateSpans,
    (rows) => rows.length === 2
  )
  expect.that(
    'traces: each plugin.activate is a child of kernel.boot',
    activateSpans.map((s) => s.parentSpanId),
    (ids) => ids.every((id) => id === boot.spanId)
  )
  expect.that(
    'traces: each plugin.activate status=ok',
    activateSpans.map((s) => s.status),
    (statuses) => statuses.every((s) => s === 'ok')
  )

  const activatedPlugins = activateSpans
    .map((s) => s.attributes?.hyp_plugin)
    .sort()
  expect.that(
    'traces: plugin.activate spans tagged with both dummy plugin names',
    activatedPlugins,
    (names) =>
      names.length === 2 &&
      names[0] === '@hypaware/dummy-a' &&
      names[1] === '@hypaware/dummy-b'
  )

  const pluginsLoaded = metrics.filter((m) => m.name === 'hyp_plugins_loaded')
  expect.that(
    'metrics: hyp_plugins_loaded emitted at least once',
    pluginsLoaded,
    (rows) => rows.length >= 1
  )
  // `hyp_plugins_loaded` is a cumulative Sum, so every periodic export
  // re-emits the running total per attribute key. Collapse to the
  // latest value per `hyp_plugin` attribute so a multi-export run
  // doesn't double-count.
  const latestPerPlugin = new Map()
  for (const m of pluginsLoaded) {
    const key = m.attributes?.hyp_plugin
    if (!key) continue
    const v = typeof m.value === 'number' ? m.value : 0
    const prev = latestPerPlugin.get(key)
    if (prev === undefined || v > prev) latestPerPlugin.set(key, v)
  }
  const sum = Array.from(latestPerPlugin.values()).reduce((a, b) => a + b, 0)
  expect.that('metrics: hyp_plugins_loaded Sum = 2', sum, (v) => v === 2)
  expect.that(
    'metrics: hyp_plugins_loaded has data point for @hypaware/dummy-a at value 1',
    latestPerPlugin.get('@hypaware/dummy-a'),
    (v) => v === 1
  )
  expect.that(
    'metrics: hyp_plugins_loaded has data point for @hypaware/dummy-b at value 1',
    latestPerPlugin.get('@hypaware/dummy-b'),
    (v) => v === 1
  )

  const stateA = path.join(harness.stateDir, 'plugins', '@hypaware', 'dummy-a')
  const stateB = path.join(harness.stateDir, 'plugins', '@hypaware', 'dummy-b')
  await assertDirExists(expect, stateA, '@hypaware/dummy-a stateDir')
  await assertDirExists(expect, stateB, '@hypaware/dummy-b stateDir')
}

/**
 * @param {{ that: (msg: string, value: unknown, predicate: (v: any) => boolean) => void }} expect
 * @param {string} dir
 * @param {string} label
 */
async function assertDirExists(expect, dir, label) {
  let exists = false
  try {
    const stat = await fs.stat(dir)
    exists = stat.isDirectory()
  } catch {
    exists = false
  }
  expect.that(`filesystem: ${label} (${dir}) exists`, exists, (v) => v === true)
}

/**
 * @param {string} dir
 * @param {{ manifest: Record<string, unknown>, entrypoint: string }} content
 */
async function writePlugin(dir, content) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify(content.manifest, null, 2)
  )
  await fs.writeFile(path.join(dir, 'index.js'), content.entrypoint)
}

/**
 * Minimal plugin entrypoint: an ESM module exporting `activate(ctx)`
 * that logs a single `info('hello', {})` and returns. Mirrors the
 * Phase 2 plan exactly.
 *
 * @param {string} name
 * @returns {string}
 */
function dummyEntrypoint(name) {
  return (
    "// auto-generated by activation_lifecycle smoke; plugin: " + name + "\n" +
    "export async function activate(ctx) {\n" +
    "  ctx.log.info('hello', {})\n" +
    "}\n"
  )
}

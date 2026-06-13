// @ts-check

import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'

/**
 * @import { AddressInfo } from 'node:net'
 * @import { ColumnSpec } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { PluginActivationEntry } from '../../../src/core/runtime/loader.d.ts'
 */

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS_WORKSPACE = path.resolve(SMOKE_DIR, '../../plugins-workspace')

const DATASET = 'vector_rows'
const API_KEY_ENV = 'SMOKE_EMBED_KEY'
const API_KEY_VALUE = 'smoke-secret-embed-key-do-not-log'
const EMBED_MODEL = 'fake-letters-26'

/** @type {ColumnSpec[]} */
const COLUMNS = [{ name: 'text', type: 'STRING', nullable: true }]

/**
 * Hermetic smoke for `@hypaware/embedder-openai` + `@hypaware/vector-search`:
 * a localhost fake embedder (no real API calls), real cache partitions,
 * the real CLI dispatch path, and the daemon-style refresh source.
 *
 * Steps (each a `smoke_step`-tagged root span):
 *  1. populate       — seed two cache partitions with distinct texts.
 *  2. plugin_activate — activate both plugins against the fake server.
 *  3. status_missing — `hyp vector status --json` reports missing shards.
 *  4. first_search   — `hyp vector search` auto-builds both shards and
 *                      ranks the matching text first.
 *  5. staleness      — appending rows flips one shard to stale_rows.
 *  6. timer_refresh  — the `vector-search-refresh` source tick rebuilds
 *                      exactly the stale shard.
 *  7. no_refresh_search — `--no-refresh` finds the newly indexed row.
 *  8. telemetry      — spans prove the build/search/tick paths ran, and
 *                      neither the API key nor raw text leaked.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const cacheRoot = path.join(harness.stateDir, 'cache')
  const registry = createCommandRegistry()
  const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

  process.env[API_KEY_ENV] = API_KEY_VALUE

  // --- fake OpenAI-compatible embedder -------------------------------------
  // Embeds a text as its L2-normalized letter-frequency histogram, so
  // cosine similarity ranks shared vocabulary deterministically: a
  // query repeating a row's word scores 1.0 against that row.
  let authHeadersSeen = 0
  let embedRequests = 0
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      embedRequests++
      if (req.headers.authorization === `Bearer ${API_KEY_VALUE}`) authHeadersSeen++
      const { input } = JSON.parse(body)
      const data = input.map((/** @type {string} */ text, /** @type {number} */ index) => ({
        index,
        embedding: letterHistogram(text),
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data, usage: { prompt_tokens: input.length, total_tokens: input.length } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {AddressInfo} */ (server.address())
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    // --- 1. populate two partitions -----------------------------------------
    await runRoot(
      'smoke.populate',
      {
        [Attr.COMPONENT]: 'vector-search',
        [Attr.OPERATION]: 'smoke.populate',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'populate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        await kernel.storage.appendRowsToPartition(DATASET, ['source=alpha'], COLUMNS, [
          { text: 'alpha alpha alpha' },
          { text: 'omega omega omega' },
        ])
        await kernel.storage.appendRowsToPartition(DATASET, ['source=beta'], COLUMNS, [
          { text: 'beta beta beta' },
        ])
      }
    )

    // --- 2. activate plugins -------------------------------------------------
    await runRoot(
      'kernel.boot',
      {
        [Attr.COMPONENT]: 'kernel',
        [Attr.OPERATION]: 'boot',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'plugin_activate',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const { loaded, failed } = await loadManifests([
          path.join(PLUGINS_WORKSPACE, 'embedder-openai'),
          path.join(PLUGINS_WORKSPACE, 'vector-search'),
        ])
        if (failed.length > 0) {
          throw new Error(`manifest failures — ${failed.map((f) => `${f.manifestPath}: ${f.message}`).join('; ')}`)
        }
        // Embedder first: vector-search requires hypaware.embedder.
        const byName = new Map(loaded.map((l) => [l.manifest.name, l]))
        const embedderEntry = byName.get('@hypaware/embedder-openai')
        const vectorEntry = byName.get('@hypaware/vector-search')
        if (!embedderEntry || !vectorEntry) throw new Error('expected both plugin manifests')
        /** @type {PluginActivationEntry[]} */
        const entries = [
          {
            manifest: embedderEntry.manifest,
            rootDir: embedderEntry.rootDir,
            config: { base_url: baseUrl, model: EMBED_MODEL, api_key_env: API_KEY_ENV },
          },
          {
            manifest: vectorEntry.manifest,
            rootDir: vectorEntry.rootDir,
            config: {
              indexes: [{ dataset: DATASET, column: 'text' }],
              // ~120ms so the timer step is fast; the budget fields keep
              // their defaults — this smoke never approaches them.
              refresh: { interval_minutes: 0.002 },
            },
          },
        ]
        const result = await activatePlugins({
          plugins: entries,
          stateRoot: harness.stateDir,
          runId: harness.devRunId,
          runtime: kernel,
          tmpRoot: path.join(harness.tmpDir, 'plugin-temp'),
        })
        for (const r of result.results) {
          if (!r.ok) throw new Error(`activate ${r.plugin.name} failed (${r.errorKind}): ${r.message}`)
        }
      }
    )

    expect.that(
      'registry: vector search command registered',
      registry.get('vector search'),
      (/** @type {unknown} */ v) => v !== undefined
    )

    // --- 3. status: both shards missing --------------------------------------
    const statusBefore = await vectorStatusJson(registry, kernel)
    expect.that('status: one index reported', statusBefore.length, (/** @type {number} */ v) => v === 1)
    expect.that(
      'status: both shards missing before any search',
      statusBefore[0].shards.map((/** @type {any} */ s) => s.state).sort(),
      (/** @type {string[]} */ v) => v.length === 2 && v.every((s) => s === 'missing')
    )

    // --- 4. first search: auto-refresh builds both shards --------------------
    const firstSearch = await runRoot(
      'smoke.first_search',
      {
        [Attr.COMPONENT]: 'vector-search',
        [Attr.OPERATION]: 'smoke.first_search',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'first_search',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const stdout = makeBuf()
        const stderr = makeBuf()
        const code = await dispatch(
          ['vector', 'search', 'alpha', '--top-k', '3', '--format', 'json'],
          { stdout, stderr, kernel, registry }
        )
        return { code, stdout: stdout.text(), stderr: stderr.text() }
      }
    )
    expect.that('first search: exited 0', firstSearch.code, (/** @type {number} */ v) => v === 0)
    expect.that(
      'first search: refresh estimate printed to stderr',
      firstSearch.stderr,
      (/** @type {string} */ v) => v.includes('refreshing 2 shard(s)')
    )
    const firstHits = JSON.parse(firstSearch.stdout)
    expect.that('first search: returned hits', firstHits.length, (/** @type {number} */ v) => v >= 2)
    expect.that(
      'first search: alpha text ranked first with cosine ~1',
      firstHits[0],
      (/** @type {any} */ hit) => hit.text === 'alpha alpha alpha' && hit.partition === 'source=alpha' && hit.score > 0.99
    )
    expect.that(
      'first search: scores strictly ordered',
      firstHits,
      (/** @type {any[]} */ hits) => hits.every((h, i) => i === 0 || h.score <= hits[i - 1].score)
    )

    const statusFresh = await vectorStatusJson(registry, kernel)
    expect.that(
      'status: both shards fresh after first search',
      statusFresh[0].shards.map((/** @type {any} */ s) => s.state),
      (/** @type {string[]} */ v) => v.length === 2 && v.every((s) => s === 'fresh')
    )

    // --- 5. staleness: append rows to one partition ---------------------------
    await runRoot(
      'smoke.staleness',
      {
        [Attr.COMPONENT]: 'vector-search',
        [Attr.OPERATION]: 'smoke.staleness',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'staleness',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        await kernel.storage.appendRowsToPartition(DATASET, ['source=beta'], COLUMNS, [
          { text: 'gamma gamma gamma' },
        ])
      }
    )
    const statusStale = await vectorStatusJson(registry, kernel)
    expect.that(
      'status: exactly the appended shard is stale_rows',
      statusStale[0].shards.map((/** @type {any} */ s) => s.state).sort(),
      (/** @type {string[]} */ v) => v.join(',') === 'fresh,stale_rows'
    )

    // --- 6. daemon-style timer refresh ----------------------------------------
    await runRoot(
      'smoke.timer_refresh',
      {
        [Attr.COMPONENT]: 'vector-search',
        [Attr.OPERATION]: 'smoke.timer_refresh',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'timer_refresh',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const ctx = kernel.activationContexts.get('@hypaware/vector-search')
        if (!ctx) throw new Error('no activation context for @hypaware/vector-search')
        await kernel.sources.start('vector-search-refresh', ctx)
        try {
          const deadline = Date.now() + 5_000
          for (;;) {
            const status = await vectorStatusJson(registry, kernel)
            const states = status[0].shards.map((/** @type {any} */ s) => s.state)
            if (states.every((/** @type {string} */ s) => s === 'fresh')) break
            if (Date.now() > deadline) throw new Error(`timer refresh did not converge: ${states.join(',')}`)
            await sleep(50)
          }
        } finally {
          await kernel.sources.stop('vector-search-refresh')
        }
      }
    )

    // --- 7. --no-refresh search sees the timer-built shard --------------------
    const secondSearch = await runRoot(
      'smoke.no_refresh_search',
      {
        [Attr.COMPONENT]: 'vector-search',
        [Attr.OPERATION]: 'smoke.no_refresh_search',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: 'no_refresh_search',
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      async () => {
        const stdout = makeBuf()
        const stderr = makeBuf()
        const code = await dispatch(
          ['vector', 'search', 'gamma', '--no-refresh', '--top-k', '1', '--format', 'json'],
          { stdout, stderr, kernel, registry }
        )
        return { code, stdout: stdout.text(), stderr: stderr.text() }
      }
    )
    expect.that('no-refresh search: exited 0', secondSearch.code, (/** @type {number} */ v) => v === 0)
    expect.that(
      'no-refresh search: finds the timer-indexed row',
      JSON.parse(secondSearch.stdout)[0],
      (/** @type {any} */ hit) => hit?.text === 'gamma gamma gamma' && hit.partition === 'source=beta'
    )

    // --- 8. telemetry ----------------------------------------------------------
    await obs.shutdown()
    const traces = await expect.traces()
    const logs = await expect.logs()

    const buildSpans = traces.filter((/** @type {any} */ t) => t.name === 'vector.build_shard')
    expect.that(
      'telemetry: exactly 3 shard builds (2 first search + 1 timer)',
      buildSpans.length,
      (/** @type {number} */ v) => v === 3
    )
    expect.that(
      'telemetry: shard builds all ok with row counts',
      buildSpans,
      (/** @type {any[]} */ spans) => spans.every((s) => s.attributes?.status === 'ok' && s.attributes?.row_count >= 1)
    )
    const timerBuild = buildSpans.filter((/** @type {any} */ t) => t.attributes?.shard_reason === 'stale_rows')
    expect.that('telemetry: the timer rebuild was the stale shard', timerBuild.length, (/** @type {number} */ v) => v === 1)

    const searchSpans = traces.filter((/** @type {any} */ t) => t.name === 'vector.search')
    expect.that('telemetry: two vector.search spans', searchSpans.length, (/** @type {number} */ v) => v === 2)
    expect.that(
      'telemetry: search refresh modes recorded',
      searchSpans.map((/** @type {any} */ t) => t.attributes?.refresh_mode).sort(),
      (/** @type {string[]} */ v) => v.join(',') === 'auto,never'
    )

    const tickSpans = traces.filter((/** @type {any} */ t) => t.name === 'vector.refresh_tick')
    expect.that('telemetry: refresh tick span proves the timer path ran', tickSpans.length, (/** @type {number} */ v) => v >= 1)
    expect.that(
      'telemetry: some tick built the stale shard',
      tickSpans,
      (/** @type {any[]} */ spans) => spans.some((s) => s.attributes?.shards_built >= 1)
    )

    const embedSpans = traces.filter((/** @type {any} */ t) => t.name === 'embedder.embed')
    expect.that('telemetry: embedder spans emitted', embedSpans.length, (/** @type {number} */ v) => v >= 3)
    expect.that(
      'telemetry: embedder spans carry counts, not content',
      embedSpans,
      (/** @type {any[]} */ spans) => spans.every((s) => typeof s.attributes?.text_count === 'number')
    )

    expect.that(
      'telemetry: shard_built logs emitted',
      logs.filter((/** @type {any} */ l) => l.body === 'vector.shard_built').length,
      (/** @type {number} */ v) => v === 3
    )

    // Secret-safety: neither the API key nor any indexed text appears in
    // any telemetry record.
    const everything = JSON.stringify(traces) + JSON.stringify(logs)
    expect.that(
      'telemetry: API key never appears',
      everything.includes(API_KEY_VALUE),
      (/** @type {boolean} */ v) => v === false
    )
    expect.that(
      'telemetry: indexed text never appears',
      everything.includes('alpha alpha alpha'),
      (/** @type {boolean} */ v) => v === false
    )

    expect.that('fake embedder: requests were authenticated', authHeadersSeen, (/** @type {number} */ v) => v === embedRequests && v >= 3)
  } finally {
    server.close()
    delete process.env[API_KEY_ENV]
  }
}

/**
 * 26-dim L2-normalized letter histogram.
 *
 * @param {string} text
 * @returns {number[]}
 */
function letterHistogram(text) {
  const counts = new Array(26).fill(0)
  for (const ch of text.toLowerCase()) {
    const i = ch.charCodeAt(0) - 97
    if (i >= 0 && i < 26) counts[i]++
  }
  const norm = Math.sqrt(counts.reduce((acc, c) => acc + c * c, 0)) || 1
  return counts.map((c) => c / norm)
}

/**
 * @param {ReturnType<typeof createCommandRegistry>} registry
 * @param {ReturnType<typeof createKernelRuntime>} kernel
 * @returns {Promise<any[]>}
 */
async function vectorStatusJson(registry, kernel) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['vector', 'status', '--json'], { stdout, stderr, kernel, registry })
  if (code !== 0) throw new Error(`vector status failed: ${stderr.text()}`)
  return JSON.parse(stdout.text())
}

function makeBuf() {
  let buf = ''
  return {
    write(/** @type {string} */ chunk) { buf += String(chunk) },
    text() { return buf },
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

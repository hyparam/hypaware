// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'

import { Attr, getLogger, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { createSinkDriver } from '../../../src/core/sinks/driver.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { createReplicaSource } from '../../plugins-workspace/fastask/src/replica_source.js'
import { QUESTION, REPLICA_MARKER, REPO, TOKEN, makeBuf, startFastaskServer, waitFor } from '../lib/fastask_fixture.js'

/**
 * @import { ActivePlugin, ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 */

const DATASET = 'fastask_smoke_rows'
/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'msg', type: 'STRING', nullable: false },
]

/**
 * Hermetic smoke: the team graph replica is never exported (LLP 0480#replica,
 * #privacy; LLP 0481 T10), on the local_only_export_withhold.js template. The
 * real central forward sink runs through the real sink driver against a fake
 * ingest server, in an install that also holds a synced replica and has just
 * read teammates' evidence through `hyp fastask`. The sink ships this
 * machine's own rows and nothing of the replica or the evidence: the
 * replica is not a registered dataset, and evidence text is never written to
 * the cache.
 *
 *   setup          activate fastask, central and a fixture dataset; sync the replica
 *   read_evidence  run `hyp fastask` (cold): teammates' text is printed
 *   export_tick    the real driver ticks the real sink
 *   assert_withheld  nothing carrying the replica's or the evidence's marker,
 *                  session ids or file keys reached ingest; no fastask dataset
 *
 * @ref LLP 0480#replica [tests]: the replica is never a registered dataset and never ships through a sink
 * @ref LLP 0480#privacy [tests]: evidence text is fetched per call and not cached, so no sink can carry it
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) throw new Error('fastask_replica_never_exported: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')

  /** @param {string} name */
  const stepBag = (name) => ({
    [Attr.COMPONENT]: 'smoke', [Attr.OPERATION]: 'step', [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: name, [Attr.DEV_RUN_ID]: harness.devRunId, status: 'ok',
  })
  /** @template T @param {string} name @param {() => Promise<T>} fn @returns {Promise<T>} */
  const step = (name, fn) => runRoot(`smoke.step.${name}`, stepBag(name), fn)

  const team = await startFastaskServer()
  const ingest = await startFakeIngest()
  const fastaskStateDir = path.join(harness.stateDir, 'plugins', '@hypaware/fastask')
  /** @type {import('../../../hypaware-plugin-kernel-types.js').StartedSource | undefined} */
  let source
  try {
    // ----- smoke_step: setup -----
    const { kernel, driver } = await step('setup', async () => {
      const cacheRoot = path.join(harness.stateDir, 'cache')
      const registry = createCommandRegistry()
      registerCoreCommands(registry)
      const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })
      const fixtureDir = path.join(harness.tmpDir, 'plugins', 'test-fastask-rows')
      await writeFixturePlugin(fixtureDir)
      const workspace = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
      const centralDir = path.join(workspace, 'central')
      const fastaskDir = path.join(workspace, 'fastask')
      const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
      await fs.mkdir(tmpRoot, { recursive: true })
      const { loaded, failed } = await loadManifests([fixtureDir, centralDir, fastaskDir])
      if (failed.length > 0) throw new Error(`manifest failures: ${failed.map((f) => `${f.manifestPath}: ${f.message}`).join('; ')}`)
      const result = await activatePlugins({
        plugins: loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir })),
        stateRoot: harness.stateDir, runId: harness.devRunId, runtime: kernel, tmpRoot,
      })
      for (const r of result.results) if (!r.ok) throw new Error(`activate ${r.plugin.name} failed (${r.errorKind}): ${r.message}`)
      expect.that('setup: fastask activated with its source', kernel.sources.list().some((s) => s.name === 'team-graph-replica'), (v) => v === true)

      const contribution = kernel.sinks.getContribution('@hypaware/central', 'forward')
      if (!contribution) throw new Error('no forward sink contribution')
      /** @type {ActivePlugin} */
      const centralPlugin = {
        name: '@hypaware/central', version: '1.0.0', rootDir: centralDir,
        manifest: { schema_version: 1, name: '@hypaware/central', version: '1.0.0', hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './index.js' },
      }
      await kernel.sinks.instantiate({
        kind: 'request', instanceName: 'forward', contribution,
        config: { schedule: '* * * * *', url: ingest.baseUrl, identity: { bootstrap_token: 'smoke-bootstrap-token' } },
        plugin: centralPlugin,
        paths: {
          rootDir: centralDir,
          stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/central'),
          cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/central'),
          tempDir: path.join(tmpRoot, 'central'),
        },
        log: getLogger('plugin-central'),
      })
      const driver = createSinkDriver({ sinkRegistry: kernel.sinks, queryRegistry: kernel.query, storage: kernel.storage, stateRoot: harness.stateDir })

      // The replica, synced by the real source from the team server.
      await team.publish('g1', new Date(Date.now() - 3_600_000).toISOString())
      const start = createReplicaSource({
        resolveTarget: async () => ({ target: 'fx', url: team.url, org: null, token: async () => ({ ok: true, token: TOKEN, source: 'env', kind: 'static' }) }),
      })
      source = await start(/** @type {any} */ ({ paths: { stateDir: fastaskStateDir }, log: getLogger('plugin-fastask'), config: {} }))
      const started = source
      await waitFor(async () => (/** @type {any} */ (await started.status?.())?.details?.index_generation === 'g1'), 15_000, 'the replica to sync')
      await started.stop()
      source = undefined

      // This machine's own rows, which the sink should ship.
      const tablePath = kernel.storage.cacheTablePath(DATASET)
      await kernel.storage.appendRows(tablePath, COLUMNS, [
        { id: 1n, cwd: harness.tmpDir, msg: `own-1-${harness.devRunId}` },
        { id: 2n, cwd: harness.tmpDir, msg: `own-2-${harness.devRunId}` },
      ])
      await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed' })
      return { kernel, driver }
    })

    // The replica really holds the marker, so its absence downstream means something.
    const nodesOnDisk = await replicaNodesText(fastaskStateDir)
    expect.that('setup: the replica on disk carries the marker and the session ids', nodesOnDisk, (s) => s.includes(REPLICA_MARKER) && s.includes('fx-session-login-a'))

    // ----- smoke_step: read_evidence -----
    await step('read_evidence', async () => {
      const configPath = path.join(harness.hypHome, 'fastask-config.json')
      await fs.writeFile(configPath, JSON.stringify({
        version: 2, auto_update: false, plugins: [{ name: '@hypaware/fastask' }],
        query: { default_remote: 'fx', remotes: { fx: { url: team.url } } },
      }))
      const repo = path.join(harness.tmpDir, 'fx-repo')
      await fs.mkdir(path.join(repo, '.git'), { recursive: true })
      await fs.writeFile(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:${REPO}.git\n`)
      const stdout = makeBuf()
      const stderr = makeBuf()
      const code = await dispatch(['fastask', QUESTION], { stdout, stderr, cwd: repo, env: { ...process.env, HYP_CONFIG: configPath, HYP_REMOTE_TOKEN_FX: TOKEN } })
      expect.that('read_evidence: hyp fastask exits 0', { code, err: stderr.text() }, (v) => v.code === 0)
      expect.that('read_evidence: answered from the replica', stdout.text(), (s) => s.startsWith('source: team_replica (cold) on fx'))
      expect.that('read_evidence: teammates\' text was printed', stdout.text(), (s) => s.includes(REPLICA_MARKER))
    })

    // ----- smoke_step: export_tick -----
    await step('export_tick', async () => {
      const report = await driver.tick({ now: new Date(), force: true })
      expect.that('export_tick: the forward sink exported', report.sinks[0]?.status, (v) => v === 'exported')
      expect.that('export_tick: it shipped bytes (this machine\'s rows)', report.sinks[0]?.bytesWritten, (v) => typeof v === 'number' && v > 0)
    })

    // ----- smoke_step: assert_withheld -----
    await step('assert_withheld', async () => {
      const posts = ingest.received.filter((r) => r.method === 'POST' && r.path.startsWith('/v1/ingest/'))
      const shipped = posts.map((r) => r.body).join('\n')
      expect.that('assert_withheld: this machine\'s rows reached ingest', shipped, (s) => s.includes(`own-1-${harness.devRunId}`) && s.includes(`own-2-${harness.devRunId}`))
      expect.that('assert_withheld: no replica or evidence marker reached ingest', shipped, (s) => !s.includes(REPLICA_MARKER))
      expect.that('assert_withheld: no teammate session id reached ingest', shipped, (s) => !s.includes('fx-session-login') && !s.includes('fx-session-poll'))
      expect.that('assert_withheld: no team graph file key reached ingest', shipped, (s) => !s.includes(`${REPO}:src/login.js`))
      const everything = ingest.received.map((r) => `${r.path}\n${r.body}`).join('\n')
      expect.that('assert_withheld: nothing of it reached the server on any route', everything, (s) => !s.includes(REPLICA_MARKER))
      const datasets = kernel.query.listDatasets()
      expect.that('assert_withheld: fastask registers no dataset', datasets.filter((d) => d.plugin === '@hypaware/fastask').map((d) => d.name), (v) => v.length === 0)
      expect.that('assert_withheld: the fixture dataset is the one the sink saw', datasets.map((d) => d.name), (v) => v.includes(DATASET))
    })
  } finally {
    await source?.stop()
    await team.close()
    await ingest.stop()
    await obs.shutdown()
  }

  // ----- telemetry -----
  const traces = /** @type {any[]} */ (await expect.traces())
  const steps = new Set(traces.filter((t) => t.name?.startsWith('smoke.step.')).map((t) => t.attributes?.smoke_step))
  expect.that('telemetry: every smoke_step ran', [...steps].sort().join(','), (v) => v === 'assert_withheld,export_tick,read_evidence,setup')
  expect.that('telemetry: the replica was activated', traces.some((t) => t.name === 'replica.activate'), (v) => v === true)
  expect.that('telemetry: fastask read evidence on the cold path', traces.filter((t) => t.name === 'fastask.run').map((t) => t.attributes?.source_path), (p) => p.includes('cold'))
  expect.that('telemetry: no marker in any span', JSON.stringify(traces), (s) => !s.includes(REPLICA_MARKER))
}

/** The active generation's nodes, decompressed. @param {string} stateDir */
async function replicaNodesText(stateDir) {
  const root = path.join(stateDir, 'replicas')
  for (const key of await fs.readdir(root)) {
    for (const g of await fs.readdir(path.join(root, key, 'generations')).catch(() => [])) {
      return gunzipSync(await fs.readFile(path.join(root, key, 'generations', g, 'nodes.ndjson.gz'))).toString('utf8')
    }
  }
  return ''
}

/** A fake central server: identity bootstrap and ingest, recording every request. */
async function startFakeIngest() {
  /** @type {Array<{ method: string, path: string, body: string }>} */
  const received = []
  const jwt = ['{"alg":"none","typ":"JWT"}', '{"sub":"gateway-smoke"}', 'signature']
    .map((p) => Buffer.from(p).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')).join('.')
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const url = req.url ?? '/'
      received.push({ method: req.method ?? 'GET', path: url, body })
      if (req.method === 'POST' && (url === '/v1/identity/bootstrap' || url === '/v1/identity/refresh')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ jwt, expires_at: Math.floor(Date.now() / 1000) + 86_400 }))
      }
      if (req.method === 'POST' && url.startsWith('/v1/ingest/')) { res.writeHead(202); return res.end() }
      res.writeHead(404)
      res.end('{"error":"not_found"}')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    received,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)) }),
  }
}

/** A fixture plugin registering one plain dataset the forward sink exports. @param {string} dir */
async function writeFixturePlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1, name: '@hypaware/test-fastask-rows', version: '1.0.0', hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './index.js',
  }, null, 2))
  await fs.writeFile(path.join(dir, 'index.js'), `// auto-generated by fastask_replica_never_exported smoke
import fs from 'node:fs'
import path from 'node:path'

const DATASET = '${DATASET}'
const COLUMNS = ${JSON.stringify(COLUMNS)}
let activatedStorage = null

const dataset = {
  name: DATASET,
  plugin: '@hypaware/test-fastask-rows',
  // A signal the central forward sink exports, as in local_only_export_withhold.
  sourceSignal: 'proxy',
  schema: { columns: COLUMNS },
  primaryTimestampColumn: undefined,
  discoverPartitions(ctx) {
    const cacheDir = ctx.cacheDir ?? activatedStorage?.cacheRoot ?? ''
    const base = cacheDir ? path.join(cacheDir, 'datasets', DATASET) : ''
    const parts = []
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '_hypaware_spool') continue
        parts.push({ dataset: DATASET, partition: { partition: entry.name }, tablePath: path.join(base, entry.name) })
      }
    } catch {}
    if (parts.length === 0) parts.push({ dataset: DATASET, partition: { partition: 'all' }, tablePath: base ? path.join(base, 'all') : '' })
    return parts
  },
  async createDataSource(partitions, ctx) {
    for (const partition of partitions) {
      if (!partition.tablePath) continue
      const source = await ctx.storage.dataSourceForTable(partition.tablePath)
      if (source && (source.numRows ?? 0) > 0) return source
    }
    return { columns: COLUMNS.map((c) => c.name), numRows: 0, scan() { return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} } } }
  },
}

export async function activate(ctx) {
  activatedStorage = ctx.storage
  ctx.query.registerDataset(dataset)
}
`)
}

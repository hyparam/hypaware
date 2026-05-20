// @ts-check

import http from 'node:http'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  Attr,
  installObservability,
  runRoot,
} from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { createSinkDriver } from '../../../src/core/sinks/driver.js'

/**
 * Phase 8.5 smoke. Stands up:
 *
 *   - `@hypaware/test-otel` (fixture stand-in for `@hypaware/otel`):
 *     registers the `logs` dataset with `sourceSignal="logs"` and
 *     materializes one row carrying `dev_run_id` into the cache. Until
 *     Phase 8.2 lands the real OTLP listener, this fixture is what a
 *     "log payload posted to the OTLP listener" reduces to from the
 *     sink driver's point of view.
 *   - `@hypaware/central` (the plugin under test): registers the
 *     `forward` request sink contribution.
 *
 * An in-process fake central server endpoint records every request it
 * receives. It speaks the wire contract documented in
 * `hypaware-core/plugins-workspace/central/proto.md` (identity bootstrap
 * + ingest).
 *
 * The flow then instantiates the `forward` sink (pointing at the fake
 * server), fires `driver.tick({ now, force: true })` once, and verifies:
 *
 *   - The fake central server received exactly one POST to
 *     `/v1/ingest/logs` carrying the `dev_run_id` row.
 *   - A `sink.export_batch` span emitted with
 *     `hyp_sink_instance="forward"`, `status=ok`, and the same
 *     `dev_run_id`.
 *   - `hyp_sink_exports_total{sink_instance=forward, status=ok}` ticked.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'central_forward_outbox: tracer provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }
  if (!obs.meter.provider) {
    throw new Error(
      'central_forward_outbox: meter provider not installed — expected HYP_DEV_TELEMETRY=1'
    )
  }

  const fakeServer = await startFakeCentralServer()
  try {
    const cacheRoot = path.join(harness.stateDir, 'cache')
    const registry = createCommandRegistry()
    const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

    const otelDir = path.join(harness.tmpDir, 'plugins', 'test-otel')
    await writeOtelFixturePlugin(otelDir, harness.devRunId)
    const centralDir = path.resolve(
      import.meta.dirname,
      '..',
      '..',
      'plugins-workspace',
      'central'
    )

    const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
    await fs.mkdir(tmpRoot, { recursive: true })

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
        // Activate the otel fixture first so its `logs` dataset is
        // registered (and its row written) before the central sink's
        // create() runs identity bootstrap. Activation order matches the
        // dep graph the kernel will use in production once @hypaware/otel
        // ships its real implementation.
        const { loaded } = await loadManifests([otelDir, centralDir])
        const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir }))
        return activatePlugins({
          plugins: entries,
          stateRoot: harness.stateDir,
          runId: harness.devRunId,
          runtime: kernel,
          tmpRoot,
        })
      }
    )

    const contribution = kernel.sinks.getContribution('@hypaware/central', 'forward')
    expect.that(
      'sinks: @hypaware/central contributed a forward sink',
      contribution,
      (v) => v !== undefined
    )
    if (!contribution) return

    /** @type {import('../../../collectivus-plugin-kernel-types').ActivePlugin} */
    const centralPlugin = {
      name: '@hypaware/central',
      version: '1.0.0',
      manifest: {
        schema_version: 1,
        name: '@hypaware/central',
        version: '1.0.0',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
      },
      rootDir: centralDir,
    }

    await kernel.sinks.instantiate({
      kind: 'request',
      instanceName: 'forward',
      contribution,
      config: {
        schedule: '* * * * *',
        url: fakeServer.baseUrl,
        identity: {
          bootstrap_token: 'smoke-bootstrap-token',
        },
      },
      plugin: centralPlugin,
      paths: {
        rootDir: centralDir,
        stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/central'),
        cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/central'),
        tempDir: path.join(tmpRoot, 'central'),
      },
      log: makeNoopLogger(),
    })

    const driver = createSinkDriver({
      sinkRegistry: kernel.sinks,
      queryRegistry: kernel.query,
      storage: kernel.storage,
      stateRoot: harness.stateDir,
    })

    const report = await driver.tick({
      now: new Date('2026-02-15T10:00:00Z'),
      force: true,
    })

    expect.that(
      'driver: tick reported exactly one sink fired',
      report.sinks,
      (v) => Array.isArray(v) && v.length === 1
    )
    const sinkReport = report.sinks[0]
    expect.that(
      'driver: forward sink status was exported',
      sinkReport?.status,
      (v) => v === 'exported'
    )
    expect.that(
      'driver: forward sink bytesWritten > 0',
      sinkReport?.bytesWritten,
      (v) => typeof v === 'number' && v > 0
    )

    // Fake server received one POST to /v1/ingest/logs.
    const ingestRequests = fakeServer.received.filter(
      (req) => req.path === '/v1/ingest/logs' && req.method === 'POST'
    )
    expect.that(
      'fake server: received exactly one /v1/ingest/logs POST',
      ingestRequests,
      (rows) => rows.length === 1
    )
    const ingestReq = ingestRequests[0]
    expect.that(
      'fake server: ingest content-type is application/x-ndjson',
      ingestReq?.contentType,
      (v) => v === 'application/x-ndjson'
    )
    expect.that(
      'fake server: ingest Authorization header is bearer JWT',
      ingestReq?.authorization,
      (v) => typeof v === 'string' && v.startsWith('Bearer ')
    )
    const ndjsonLines = (ingestReq?.body ?? '').split('\n').filter((line) => line.length > 0)
    expect.that(
      'fake server: ingest body has exactly one NDJSON row',
      ndjsonLines,
      (rows) => rows.length === 1
    )
    /** @type {Record<string, unknown> | undefined} */
    let payload
    try { payload = JSON.parse(ndjsonLines[0]) } catch { payload = undefined }
    expect.that(
      'fake server: ingest row parses as JSON',
      payload,
      (v) => v !== undefined && typeof v === 'object' && v !== null
    )
    expect.that(
      'fake server: ingest row carries the same dev_run_id',
      /** @type {any} */ (payload)?.dev_run_id,
      (v) => v === harness.devRunId
    )

    // Identity bootstrap landed at the fake server too.
    const bootstrapReqs = fakeServer.received.filter(
      (req) => req.path === '/v1/identity/bootstrap'
    )
    expect.that(
      'fake server: received exactly one /v1/identity/bootstrap POST',
      bootstrapReqs,
      (rows) => rows.length === 1
    )

    await obs.shutdown()

    const traces = await expect.traces()
    const exportSpans = traces.filter((t) => t.name === 'sink.export_batch')
    expect.that(
      'traces: exactly one sink.export_batch span',
      exportSpans,
      (rows) => rows.length === 1
    )
    const exportSpan = exportSpans[0]
    expect.that(
      'traces: sink.export_batch hyp_sink_instance=forward',
      exportSpan?.attributes?.hyp_sink_instance,
      (v) => v === 'forward'
    )
    expect.that(
      'traces: sink.export_batch status=ok',
      exportSpan?.attributes?.status,
      (v) => v === 'ok'
    )
    expect.that(
      'traces: sink.export_batch span.status=ok',
      exportSpan?.status,
      (v) => v === 'ok'
    )
    expect.that(
      'traces: sink.export_batch carries the dev_run_id (resource)',
      exportSpan?.resource?.dev_run_id,
      (v) => v === harness.devRunId
    )
    expect.that(
      'traces: sink.export_batch partitions_count >= 1',
      exportSpan?.attributes?.partitions_count,
      (v) => typeof v === 'number' && v >= 1
    )
    expect.that(
      'traces: sink.export_batch bytes_written > 0',
      exportSpan?.attributes?.bytes_written,
      (v) => typeof v === 'number' && v > 0
    )

    const metrics = await expect.metrics()
    const exportMetric = metrics.find(
      (m) => m.name === 'hyp_sink_exports_total'
        && m.attributes?.hyp_sink_instance === 'forward'
        && m.attributes?.status === 'ok'
    )
    expect.that(
      'metrics: hyp_sink_exports_total{sink_instance=forward,status=ok} exists',
      exportMetric,
      (v) => v !== undefined
    )
    expect.that(
      'metrics: hyp_sink_exports_total{sink_instance=forward,status=ok} >= 1',
      Number(exportMetric?.value ?? 0),
      (v) => v >= 1
    )

    // No outbox file should exist for the green path.
    let outboxEntries = []
    try {
      outboxEntries = await fs.readdir(path.join(harness.stateDir, 'sinks', 'forward', 'outbox'))
    } catch (err) {
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err
    }
    expect.that(
      'state: outbox is empty after a green tick',
      outboxEntries,
      (rows) => Array.isArray(rows) && rows.length === 0
    )
  } finally {
    await fakeServer.stop()
  }
}

/**
 * Stand up an HTTP listener on a random port that pretends to be the
 * central HypAware server. Records every request it receives so the
 * smoke can assert exact contents and ordering.
 */
async function startFakeCentralServer() {
  /** @type {Array<{ method: string, path: string, contentType: string, authorization: string, body: string }>} */
  const received = []

  let nextExpiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
  let issuedCount = 0

  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const url = req.url ?? '/'
      received.push({
        method: req.method ?? 'GET',
        path: url,
        contentType: String(req.headers['content-type'] ?? ''),
        authorization: String(req.headers['authorization'] ?? ''),
        body,
      })

      if (req.method === 'POST' && url === '/v1/identity/bootstrap') {
        issuedCount += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jwt: signFakeJwt(`gateway-${issuedCount}`),
          expires_at: nextExpiresAt,
        }))
        return
      }
      if (req.method === 'POST' && url === '/v1/identity/refresh') {
        issuedCount += 1
        nextExpiresAt += 24 * 60 * 60
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jwt: signFakeJwt(`gateway-${issuedCount}`),
          expires_at: nextExpiresAt,
        }))
        return
      }
      if (req.method === 'POST' && url.startsWith('/v1/ingest/')) {
        res.writeHead(202)
        res.end()
        return
      }
      res.writeHead(404)
      res.end('{"error":"not_found"}')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('central_forward_outbox: fake server failed to bind a port')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    received,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}

/**
 * Produce a fake JWT whose payload contains the supplied `sub`. The
 * gateway only decodes (not verifies) the JWT to recover the gateway
 * id, so this is enough to drive the IdentityClient through bootstrap
 * and refresh paths.
 *
 * @param {string} subject
 */
function signFakeJwt(subject) {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })))
  const payload = base64UrlEncode(Buffer.from(JSON.stringify({ sub: subject })))
  const signature = base64UrlEncode(Buffer.from('signature'))
  return `${header}.${payload}.${signature}`
}

/** @param {Buffer} buf */
function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * @param {string} dir
 * @param {string} devRunId
 */
async function writeOtelFixturePlugin(dir, devRunId) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/test-otel',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  await fs.writeFile(
    path.join(dir, 'hypaware.plugin.json'),
    JSON.stringify(manifest, null, 2)
  )
  await fs.writeFile(path.join(dir, 'index.js'), otelFixturePluginSource(devRunId))
}

/** @param {string} devRunId */
function otelFixturePluginSource(devRunId) {
  return `// auto-generated by central_forward_outbox smoke; fixture: @hypaware/test-otel
import path from 'node:path'

const DATASET = 'logs'
const COLUMNS = [
  { name: 'dev_run_id', type: 'STRING', nullable: false },
  { name: 'body', type: 'STRING', nullable: false },
]

let activatedStorage = null

const dataset = {
  name: DATASET,
  plugin: '@hypaware/test-otel',
  sourceSignal: 'logs',
  schema: { columns: COLUMNS },
  primaryTimestampColumn: undefined,
  discoverPartitions(ctx) {
    const cacheDir = ctx.cacheDir ?? activatedStorage?.cacheRoot ?? ''
    return [
      {
        dataset: DATASET,
        partition: { partition: 'all' },
        tablePath: cacheDir ? path.join(cacheDir, 'datasets', DATASET, 'all') : '',
      },
    ]
  },
  async createDataSource(partitions, ctx) {
    const partition = partitions[0]
    if (!partition || !partition.tablePath) return emptySource()
    const source = await ctx.storage.dataSourceForTable(partition.tablePath)
    return source ?? emptySource()
  },
}

function emptySource() {
  return {
    columns: COLUMNS.map((c) => c.name),
    numRows: 0,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {},
      }
    },
  }
}

export async function activate(ctx) {
  activatedStorage = ctx.storage
  ctx.query.registerDataset(dataset)
  const tablePath = ctx.storage.cacheTablePath(DATASET)
  await ctx.storage.appendRows(tablePath, COLUMNS, [
    { dev_run_id: ${JSON.stringify(devRunId)}, body: 'fixture log line' },
  ])
}
`
}

function makeNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}

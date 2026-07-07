// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import { once } from 'node:events'
import path from 'node:path'

import {
  Attr,
  installObservability,
  getLogger,
  runRoot,
} from '../../../src/core/observability/index.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { createSinkDriver } from '../../../src/core/sinks/driver.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { executeQuerySql } from '../../../src/core/query/sql.js'

/**
 * @import { ActivePlugin, ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 */

const DATASET = 'local_only_smoke_rows'
/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'msg', type: 'STRING', nullable: false },
]

/**
 * Hermetic smoke closing the local-only-dir-selection change set (LLP
 * 0080/0081, task T9): seeds cache rows from two `cwd`s, marks one
 * `local-only` via the durable CLI (`hyp ignore --local-only`), then drives
 * the REAL central forward sink through the REAL sink driver end to end.
 *
 * @ref LLP 0070#enforce [tests]: the export-seam filter drops a `local-only`
 *   row's payload while advancing the cursor across it, proved through the
 *   real `readRowsSince` -> central forward sink -> driver.tick() path
 *   rather than a stubbed storage/sink.
 * @ref LLP 0070#incremental [tests]: a partition tail of withheld rows
 *   checkpoints once; a second forced tick reads nothing new.
 * @ref LLP 0069#requirements [tests]: R9 - `hyp status` surfaces the
 *   withholding count.
 * @ref LLP 0081#tasks: implements plan task T9 (the closing hermetic smoke).
 *
 * Asserts:
 *
 *   - the clean cwd's rows are exported to the fake central server;
 *   - the excluded cwd's rows never reach the server, but stay queryable
 *     from the local cache (`executeQuerySql` over the fixture dataset);
 *   - the sink watermark advances across the withheld rows: a second
 *     forced tick ships zero bytes and POSTs nothing new;
 *   - `usage_policy.export_drop` fires exactly once (on the first tick);
 *   - `hyp status` (text and `--json`) reports the withholding count.
 *
 * Every phase runs under a `smoke_step`-tagged root span so a failure
 * points at the broken step, per the repo's log-driven ethos.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'local_only_export_withhold: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  /**
   * Stable `smoke_step` attribute bag for a phase.
   * @param {string} name
   * @returns {Record<string, string>}
   */
  const stepBag = (name) => ({
    [Attr.COMPONENT]: 'smoke',
    [Attr.OPERATION]: 'step',
    [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: name,
    [Attr.DEV_RUN_ID]: harness.devRunId,
    status: 'ok',
  })

  /**
   * Run one phase under a `smoke_step`-tagged root span so a failure names
   * the broken step, per the repo's log-driven ethos.
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const step = (name, fn) => runRoot(`smoke.step.${name}`, stepBag(name), fn)

  const fakeServer = await startFakeCentralServer()
  try {
    const cacheRoot = path.join(harness.stateDir, 'cache')
    const registry = createCommandRegistry()
    registerCoreCommands(registry)
    const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })

    const fixtureDir = path.join(harness.tmpDir, 'plugins', 'test-local-only-rows')
    await writeFixturePlugin(fixtureDir)
    const centralDir = path.resolve(
      import.meta.dirname, '..', '..', 'plugins-workspace', 'central'
    )
    const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
    await fs.mkdir(tmpRoot, { recursive: true })

    // ----- smoke_step: setup (activate the fixture dataset + central sink) -----
    const setup = await step('setup', async () => {
      const { loaded, failed } = await loadManifests([fixtureDir, centralDir])
      if (failed.length > 0) {
        throw new Error(
          `local_only_export_withhold: manifest failures - ${
            failed.map((f) => `${f.manifestPath}: ${f.message}`).join('; ')
          }`
        )
      }
      const entries = loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir }))
      const result = await activatePlugins({
        plugins: entries,
        stateRoot: harness.stateDir,
        runId: harness.devRunId,
        runtime: kernel,
        tmpRoot,
      })
      for (const r of result.results) {
        if (!r.ok) throw new Error(`activate ${r.plugin.name} failed (${r.errorKind}): ${r.message}`)
      }

      const contribution = kernel.sinks.getContribution('@hypaware/central', 'forward')
      expect.that(
        'sinks: @hypaware/central contributed a forward sink',
        contribution,
        (v) => v !== undefined
      )
      if (!contribution) throw new Error('local_only_export_withhold: no forward sink contribution')

      /** @type {ActivePlugin} */
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
          identity: { bootstrap_token: 'smoke-bootstrap-token' },
        },
        plugin: centralPlugin,
        paths: {
          rootDir: centralDir,
          stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/central'),
          cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/central'),
          tempDir: path.join(tmpRoot, 'central'),
        },
        // A real logger (not a noop) so the sink's own
        // `central.forward.dropped` debug event lands in dev-telemetry
        // alongside the storage layer's `usage_policy.export_drop`.
        log: getLogger('plugin-central'),
      })

      const driver = createSinkDriver({
        sinkRegistry: kernel.sinks,
        queryRegistry: kernel.query,
        storage: kernel.storage,
        stateRoot: harness.stateDir,
      })

      const cleanCwd = path.join(harness.tmpDir, 'clean-repo')
      const excludedCwd = path.join(harness.tmpDir, 'excluded-repo')
      await fs.mkdir(cleanCwd, { recursive: true })
      await fs.mkdir(excludedCwd, { recursive: true })

      return { driver, cleanCwd, excludedCwd }
    })

    const { driver, cleanCwd, excludedCwd } = setup

    // ----- smoke_step: mark_local_only (the durable CLI, LLP 0072#cli) -----
    // Marked BEFORE the first sink tick: the kernel's shared usage-policy
    // resolver lazily reads+memoizes the list on its first `resolve()` call
    // (matcher.js), which happens inside the tick below, so this write is
    // guaranteed to be the one it observes.
    await step('mark_local_only', async () => {
      const stdout = makeBuf()
      const stderr = makeBuf()
      const code = await dispatch(['ignore', '--local-only', excludedCwd], {
        stdout,
        stderr,
        kernel,
        registry,
        env: process.env,
      })
      expect.that('cli: hyp ignore --local-only exited 0', code, (v) => v === 0)
      expect.that('cli: hyp ignore --local-only had no stderr', stderr.text(), (v) => v.length === 0)
      expect.that(
        'cli: hyp ignore --local-only confirms the added directory',
        stdout.text(),
        (v) => v.includes('added') && v.includes(excludedCwd) && v.includes('local-only list')
      )
    })

    // ----- smoke_step: seed_rows (two cwds, one partition) -----
    const tablePath = kernel.storage.cacheTablePath(DATASET)
    await step('seed_rows', async () => {
      await kernel.storage.appendRows(tablePath, COLUMNS, [
        { id: 1n, cwd: cleanCwd, msg: `clean-1-${harness.devRunId}` },
        { id: 2n, cwd: cleanCwd, msg: `clean-2-${harness.devRunId}` },
        { id: 3n, cwd: excludedCwd, msg: `excluded-1-${harness.devRunId}` },
        { id: 4n, cwd: excludedCwd, msg: `excluded-2-${harness.devRunId}` },
      ])
      await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed' })
    })

    // ----- smoke_step: export_tick (the real driver, the real sink) -----
    await step('export_tick', async () => {
      const now = new Date('2026-02-15T10:00:00Z')
      const report = await driver.tick({ now, force: true })
      expect.that('tick1: exactly one sink fired', report.sinks, (v) => Array.isArray(v) && v.length === 1)
      const sinkReport = report.sinks[0]
      expect.that('tick1: forward sink status=exported', sinkReport?.status, (v) => v === 'exported')
      expect.that('tick1: bytesWritten > 0 (the clean rows shipped)', sinkReport?.bytesWritten, (v) => typeof v === 'number' && v > 0)

      const ingestRequests = fakeServer.received.filter((r) => r.path === '/v1/ingest/proxy' && r.method === 'POST')
      expect.that('fake server: exactly one /v1/ingest/proxy POST', ingestRequests, (v) => v.length === 1)
      const lines = (ingestRequests[0]?.body ?? '').split('\n').filter((l) => l.length > 0)
      expect.that('fake server: ingest body carries exactly the 2 clean rows', lines, (v) => v.length === 2)
      /** @type {any[]} */
      const payloadRows = lines.map((l) => JSON.parse(l))
      expect.that(
        'fake server: every shipped row carries the clean cwd',
        payloadRows,
        (v) => v.every((r) => r.cwd === cleanCwd)
      )
      expect.that(
        'fake server: no shipped row carries the excluded cwd',
        payloadRows,
        (v) => v.every((r) => r.cwd !== excludedCwd)
      )
      expect.that(
        'fake server: shipped msgs are exactly the two clean rows',
        payloadRows.map((r) => r.msg).sort(),
        (v) => JSON.stringify(v) === JSON.stringify([`clean-1-${harness.devRunId}`, `clean-2-${harness.devRunId}`].sort())
      )
    })

    // ----- smoke_step: noop_tick (watermark already covers the withheld tail) -----
    await step('noop_tick', async () => {
      const before = fakeServer.received.filter((r) => r.path === '/v1/ingest/proxy').length
      const now = new Date('2026-02-15T10:01:00Z')
      const report = await driver.tick({ now, force: true })
      const sinkReport = report.sinks[0]
      expect.that('tick2: forward sink status=exported (no-op)', sinkReport?.status, (v) => v === 'exported')
      expect.that('tick2: bytesWritten = 0 (nothing new to ship or drop)', sinkReport?.bytesWritten, (v) => v === 0)
      const after = fakeServer.received.filter((r) => r.path === '/v1/ingest/proxy').length
      expect.that('fake server: no additional ingest POST on the no-op tick', [before, after], ([b, a]) => a === b)
    })

    // ----- smoke_step: assert_cache_queryable (locally queryable, never sent) -----
    await step('assert_cache_queryable', async () => {
      const all = await executeQuerySql({
        query: `SELECT id, cwd, msg FROM ${DATASET} ORDER BY id`,
        registry: kernel.query,
        storage: /** @type {any} */ (kernel.storage),
        refresh: 'never',
        config: /** @type {any} */ ({ version: 2 }),
      })
      expect.that('cache: all 4 seeded rows remain in the local cache', all.rows.length, (v) => v === 4)

      const excludedRows = await executeQuerySql({
        query: `SELECT id, msg FROM ${DATASET} WHERE cwd = '${excludedCwd}' ORDER BY id`,
        registry: kernel.query,
        storage: /** @type {any} */ (kernel.storage),
        refresh: 'never',
        config: /** @type {any} */ ({ version: 2 }),
      })
      expect.that(
        'cache: both excluded-cwd rows are still locally queryable',
        excludedRows.rows.map((r) => r.msg).sort(),
        (v) => JSON.stringify(v) === JSON.stringify([`excluded-1-${harness.devRunId}`, `excluded-2-${harness.devRunId}`].sort())
      )
    })

    // ----- smoke_step: status (R9 - never-silent withholding) -----
    await step('status', async () => {
      const textStdout = makeBuf()
      const textCode = await dispatch(['status'], {
        stdout: textStdout,
        stderr: makeBuf(),
        kernel,
        registry,
        env: process.env,
      })
      expect.that('status: hyp status exited 0', textCode, (v) => v === 0)
      expect.that(
        'status: text output reports withholding 1 directory',
        textStdout.text(),
        (v) => v.includes('local-only:') && v.includes('withholding 1 directories from forwarding (recorded locally)')
      )

      const jsonStdout = makeBuf()
      const jsonCode = await dispatch(['status', '--json'], {
        stdout: jsonStdout,
        stderr: makeBuf(),
        kernel,
        registry,
        env: process.env,
      })
      expect.that('status: hyp status --json exited 0', jsonCode, (v) => v === 0)
      /** @type {any} */
      let json
      try {
        json = JSON.parse(jsonStdout.text())
      } catch (err) {
        expect.that(`status: --json parseable (${err instanceof Error ? err.message : String(err)})`, false, (v) => v === true)
      }
      expect.that('status json: usage_policy.local_only_dir_count = 1', json?.usage_policy?.local_only_dir_count, (v) => v === 1)
    })

    await obs.shutdown()

    // ----- smoke_step: assert_telemetry (usage_policy.export_drop fires once) -----
    await step('assert_telemetry', async () => {
      const logs = await expect.logs()
      const drops = logs.filter(
        (/** @type {any} */ l) => l.body === 'usage_policy.export_drop' && l.attributes?.[Attr.DATASET] === DATASET
      )
      expect.that('logs: usage_policy.export_drop fired exactly once', drops, (v) => Array.isArray(v) && v.length === 1)
      expect.that('logs: it reports 2 dropped rows', drops[0]?.attributes?.dropped_row_count, (v) => v === 2)
      expect.that('logs: it reports 1 distinct withheld cwd', drops[0]?.attributes?.distinct_cwd_count, (v) => v === 1)

      const traces = await expect.traces()
      const exportSpans = traces.filter(
        (/** @type {any} */ t) => t.name === 'sink.export_batch' && t.attributes?.hyp_sink_instance === 'forward'
      )
      expect.that('traces: two sink.export_batch spans (one per tick)', exportSpans, (v) => Array.isArray(v) && v.length === 2)
      expect.that(
        'traces: every export_batch span status=ok',
        exportSpans,
        (v) => v.every((/** @type {any} */ t) => t.attributes?.status === 'ok')
      )
    })
  } finally {
    await fakeServer.stop()
  }
}

/**
 * Stand up an HTTP listener on a random port that pretends to be the
 * central HypAware server. Records every request it receives so the
 * smoke can assert exact contents and ordering (mirrors
 * `central_forward_outbox`'s fixture).
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
        res.end(JSON.stringify({ jwt: signFakeJwt(`gateway-${issuedCount}`), expires_at: nextExpiresAt }))
        return
      }
      if (req.method === 'POST' && url === '/v1/identity/refresh') {
        issuedCount += 1
        nextExpiresAt += 24 * 60 * 60
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jwt: signFakeJwt(`gateway-${issuedCount}`), expires_at: nextExpiresAt }))
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
    throw new Error('local_only_export_withhold: fake server failed to bind a port')
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
 * id, so this is enough to drive the IdentityClient through bootstrap.
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

/** @param {string} dir */
async function writeFixturePlugin(dir) {
  await fs.mkdir(dir, { recursive: true })
  const manifest = {
    schema_version: 1,
    name: '@hypaware/test-local-only-rows',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(dir, 'index.js'), fixturePluginSource())
}

function fixturePluginSource() {
  return `// auto-generated by local_only_export_withhold smoke; fixture: @hypaware/test-local-only-rows
import fs from 'node:fs'
import path from 'node:path'

const DATASET = '${DATASET}'
const COLUMNS = ${JSON.stringify(COLUMNS)}

let activatedStorage = null

const dataset = {
  name: DATASET,
  plugin: '@hypaware/test-local-only-rows',
  // 'proxy' is a KNOWN_SIGNALS entry for @hypaware/central's forward sink
  // (hypaware-core/plugins-workspace/central/src/sink.js), matching the
  // real ai_gateway_messages dataset this fixture stands in for.
  sourceSignal: 'proxy',
  schema: { columns: COLUMNS },
  primaryTimestampColumn: undefined,
  // appendRows re-partitions rows under datasets/<ds>/source=<client>/ (no
  // client_name column here -> 'source=unknown'), so discover whatever
  // partition dirs actually landed on disk rather than hardcoding one.
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
    if (parts.length === 0) {
      parts.push({ dataset: DATASET, partition: { partition: 'all' }, tablePath: base ? path.join(base, 'all') : '' })
    }
    return parts
  },
  // Several partition dirs can exist at once (the spool's own 'all' staging
  // dir alongside the committed 'source=unknown' table once flushed); pick
  // the first one that actually has rows rather than partitions[0], whose
  // directory-listing order is filesystem-dependent and can land on the
  // now-empty spool dir instead of the committed table.
  async createDataSource(partitions, ctx) {
    for (const partition of partitions) {
      if (!partition.tablePath) continue
      const source = await ctx.storage.dataSourceForTable(partition.tablePath)
      if (source && (source.numRows ?? 0) > 0) return source
    }
    return emptySource()
  },
}

function emptySource() {
  return {
    columns: COLUMNS.map((c) => c.name),
    numRows: 0,
    scan() {
      return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} }
    },
  }
}

export async function activate(ctx) {
  activatedStorage = ctx.storage
  ctx.query.registerDataset(dataset)
}
`
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}

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
import { buildSourceWithholdResolver } from '../../../src/core/runtime/source_withhold.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * @import { ActivePlugin, ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 */

const DATASET = 'source_optout_smoke_rows'
/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'msg', type: 'STRING', nullable: false },
]

/**
 * Hermetic smoke for LLP 0188: on an enrolled machine every source syncs by
 * default, a `hyp privacy client <name> local-only` opt-out withholds that
 * source's FUTURE rows at the export seam (drop-but-advance), and flipping
 * back to sync never retroactively ships the rows withheld in between.
 * Drives the REAL central forward sink through the REAL sink driver, with
 * the REAL opt-out store written by the REAL CLI verb.
 *
 * The kernel's withhold resolver is built with the production builder
 * (`buildSourceWithholdResolver`) over the harness state dir, a minimal
 * enrolled layered config, and a catalog whose fixture dataset declares
 * `client_name` as its attribution column - the same wiring `bootKernel`
 * performs, minus the daemon.
 *
 * @ref LLP 0188#rule [tests]: tick 1 ships BOTH clients' rows with nothing
 *   opted out - the default-sync reversal's headline assertion.
 * @ref LLP 0188#opt-out [tests]: after `hyp privacy client openclaw
 *   local-only`, tick 2 ships only the other client's new rows; the live
 *   (TTL-fresh) store read needs no resolver rebuild.
 * @ref LLP 0188#no-retroactive-ship [tests]: flipping back to sync ships
 *   nothing on the next tick - the watermark already advanced across the
 *   withheld rows.
 *
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error(
      'source_optout_export_withhold: tracer provider not installed - expected HYP_DEV_TELEMETRY=1'
    )
  }

  /**
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

    // The production resolver builder over the harness state dir: an
    // enrolled layered config (a central layer exists; the two client
    // plugins live in the local layer, so neither classifies 'central'
    // and both are opt-out-able), and a catalog declaring the fixture
    // dataset's attribution column. ttlMs 0 keeps every read fresh so
    // the CLI's mid-run store writes apply on the very next tick.
    const withholdCatalog = /** @type {any} */ ({
      plugins: new Map([
        ['@hypaware/test-source-optout-rows', {
          name: '@hypaware/test-source-optout-rows',
          contributes: { datasets: [{ name: DATASET, attribution_column: 'client_name' }] },
        }],
        ['@hypaware/openclaw', { name: '@hypaware/openclaw', contributes: {} }],
        ['@hypaware/hermes', { name: '@hypaware/hermes', contributes: {} }],
      ]),
      pickerDescriptors: new Map([
        ['openclaw', { plugin: '@hypaware/openclaw', id: 'openclaw', label: 'OpenClaw' }],
        ['hermes', { plugin: '@hypaware/hermes', id: 'hermes', label: 'Hermes' }],
      ]),
      clientDescriptors: new Map(),
    })
    const layered = {
      centralConfig: { version: 2, plugins: [{ name: '@hypaware/central' }] },
      effective: {
        version: 2,
        plugins: [
          { name: '@hypaware/central' },
          { name: '@hypaware/openclaw' },
          { name: '@hypaware/hermes' },
        ],
      },
    }
    const sourceWithholdResolver = buildSourceWithholdResolver({
      catalog: withholdCatalog,
      layered: /** @type {any} */ (layered),
      stateDir: harness.stateDir,
      ttlMs: 0,
    })
    expect.that('setup: the enrolled machine builds a live resolver', sourceWithholdResolver, (v) => v !== undefined)

    const kernel = createKernelRuntime({
      commandRegistry: registry,
      cacheRoot,
      ...(sourceWithholdResolver ? { sourceWithholdResolver } : {}),
    })

    const fixtureDir = path.join(harness.tmpDir, 'plugins', 'test-source-optout-rows')
    await writeFixturePlugin(fixtureDir)
    const centralDir = path.resolve(
      import.meta.dirname, '..', '..', 'plugins-workspace', 'central'
    )
    const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
    await fs.mkdir(tmpRoot, { recursive: true })

    // ----- smoke_step: setup (activate the fixture dataset + central sink) -----
    const driver = await step('setup', async () => {
      const { loaded, failed } = await loadManifests([fixtureDir, centralDir])
      if (failed.length > 0) {
        throw new Error(
          `source_optout_export_withhold: manifest failures - ${
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
      if (!contribution) throw new Error('source_optout_export_withhold: no forward sink contribution')

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
        log: getLogger('plugin-central'),
      })

      return createSinkDriver({
        sinkRegistry: kernel.sinks,
        queryRegistry: kernel.query,
        storage: kernel.storage,
        stateRoot: harness.stateDir,
      })
    })

    const tablePath = kernel.storage.cacheTablePath(DATASET)
    /** @param {string} p */
    const ingestPosts = (p = '/v1/ingest/proxy') =>
      fakeServer.received.filter((r) => r.path === p && r.method === 'POST')
    /** @param {{ body?: string }} req */
    const bodyRows = (req) =>
      (req?.body ?? '').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l))

    // ----- smoke_step: default_sync_tick (nothing opted out -> everything ships) -----
    await step('default_sync_tick', async () => {
      await kernel.storage.appendRows(tablePath, COLUMNS, [
        { id: 1n, client_name: 'openclaw', msg: `oc-1-${harness.devRunId}` },
        { id: 2n, client_name: 'openclaw', msg: `oc-2-${harness.devRunId}` },
        { id: 3n, client_name: 'hermes', msg: `he-1-${harness.devRunId}` },
        { id: 4n, client_name: 'hermes', msg: `he-2-${harness.devRunId}` },
      ])
      await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed' })

      const report = await driver.tick({ now: new Date('2026-02-15T10:00:00Z'), force: true })
      const sinkReport = report.sinks[0]
      expect.that('tick1: forward sink status=exported', sinkReport?.status, (v) => v === 'exported')

      const rows = ingestPosts().flatMap(bodyRows)
      expect.that('tick1: all 4 rows shipped - default-sync covers a client the org never named', rows.length, (v) => v === 4)
      expect.that(
        'tick1: both client_names present in the payload',
        new Set(rows.map((r) => r.client_name)),
        (v) => v.has('openclaw') && v.has('hermes')
      )
    })

    // ----- smoke_step: opt_out_cli (the real verb writes the real store) -----
    await step('opt_out_cli', async () => {
      const stdout = makeBuf()
      const stderr = makeBuf()
      const code = await dispatch(['privacy', 'client', 'openclaw', 'local-only'], {
        stdout,
        stderr,
        kernel,
        registry,
        env: process.env,
      })
      expect.that('cli: hyp privacy client openclaw local-only exited 0', code, (v) => v === 0)
      expect.that(
        'cli: the confirmation states future rows stay local',
        stdout.text(),
        (v) => v.includes('openclaw: local-only') && v.includes('rows already exported are not recalled')
      )

      const listOut = makeBuf()
      await dispatch(['privacy', 'client'], { stdout: listOut, stderr: makeBuf(), kernel, registry, env: process.env })
      expect.that('cli: hyp privacy client lists the opt-out', listOut.text(), (v) => v.includes('clients kept local-only: openclaw'))
    })

    // ----- smoke_step: withhold_tick (new openclaw rows dropped, hermes ships) -----
    await step('withhold_tick', async () => {
      await kernel.storage.appendRows(tablePath, COLUMNS, [
        { id: 5n, client_name: 'openclaw', msg: `oc-3-${harness.devRunId}` },
        { id: 6n, client_name: 'openclaw', msg: `oc-4-${harness.devRunId}` },
        { id: 7n, client_name: 'hermes', msg: `he-3-${harness.devRunId}` },
        { id: 8n, client_name: 'hermes', msg: `he-4-${harness.devRunId}` },
      ])
      await kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed_2' })

      const before = ingestPosts().length
      const report = await driver.tick({ now: new Date('2026-02-15T10:01:00Z'), force: true })
      const sinkReport = report.sinks[0]
      expect.that('tick2: forward sink status=exported', sinkReport?.status, (v) => v === 'exported')

      const newRows = ingestPosts().slice(before).flatMap(bodyRows)
      expect.that('tick2: exactly the 2 new hermes rows shipped', newRows.length, (v) => v === 2)
      expect.that(
        'tick2: no shipped row is openclaw-attributed',
        newRows,
        (v) => v.every((r) => r.client_name === 'hermes')
      )
      expect.that(
        'tick2: the shipped msgs are the two new hermes rows',
        newRows.map((r) => r.msg).sort(),
        (v) => JSON.stringify(v) === JSON.stringify([`he-3-${harness.devRunId}`, `he-4-${harness.devRunId}`].sort())
      )
    })

    // ----- smoke_step: flip_back_tick (sync again: future-only, no history upload) -----
    await step('flip_back_tick', async () => {
      const stdout = makeBuf()
      const code = await dispatch(['privacy', 'client', 'openclaw', 'sync'], {
        stdout,
        stderr: makeBuf(),
        kernel,
        registry,
        env: process.env,
      })
      expect.that('cli: hyp privacy client openclaw sync exited 0', code, (v) => v === 0)
      expect.that(
        'cli: the flip-back names the future-only property',
        stdout.text(),
        (v) => v.includes('future openclaw rows sync to your server')
      )
      // LLP 0345 moved retained history to its own consent-gated command, so the
      // flip-back no longer promises history is never uploaded: it promises it
      // does not upload it, and names the command that does.
      expect.that(
        'cli: the flip-back points at the separate history replay',
        stdout.text(),
        (v) => v.includes('hyp sync --history openclaw')
      )

      const before = ingestPosts().length
      const report = await driver.tick({ now: new Date('2026-02-15T10:02:00Z'), force: true })
      const sinkReport = report.sinks[0]
      expect.that('tick3: status=exported (no-op)', sinkReport?.status, (v) => v === 'exported')
      expect.that('tick3: bytesWritten = 0 - the withheld rows were drop-but-advance, never re-read', sinkReport?.bytesWritten, (v) => v === 0)
      expect.that('tick3: no additional ingest POST', ingestPosts().length, (v) => v === before)
    })

    // ----- smoke_step: assert_cache_intact (cache-but-never-forward) -----
    await step('assert_cache_intact', async () => {
      /** @type {number[]} */
      const cachedIds = []
      for (const part of await kernel.storage.discoverCachePartitions()) {
        for await (const row of kernel.storage.readRows(part.path)) cachedIds.push(Number(row.id))
      }
      expect.that('cache: all 8 seeded rows remain locally readable', cachedIds.sort((a, b) => a - b), (v) => JSON.stringify(v) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]))
    })

    await obs.shutdown()

    // ----- smoke_step: assert_telemetry (the drop is observable, not silent) -----
    await step('assert_telemetry', async () => {
      const logs = await expect.logs()
      const drops = logs.filter(
        (/** @type {any} */ l) => l.body === 'usage_policy.export_drop' && l.attributes?.[Attr.DATASET] === DATASET
      )
      expect.that('logs: usage_policy.export_drop fired exactly once (tick 2)', drops, (v) => Array.isArray(v) && v.length === 1)
      expect.that('logs: it reports 2 dropped rows', drops[0]?.attributes?.dropped_row_count, (v) => v === 2)
      expect.that('logs: both drops are source-scoped', drops[0]?.attributes?.dropped_source_row_count, (v) => v === 2)
    })
  } finally {
    await fakeServer.stop()
  }
}

/**
 * The fake central server, mirroring local_only_export_withhold's fixture:
 * bootstrap + refresh mint fake JWTs, ingest returns 202, everything is
 * recorded for exact-content assertions.
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
    throw new Error('source_optout_export_withhold: fake server failed to bind a port')
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
    name: '@hypaware/test-source-optout-rows',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
    contributes: {
      datasets: [{ name: DATASET, attribution_column: 'client_name' }],
    },
  }
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  await fs.writeFile(path.join(dir, 'index.js'), fixturePluginSource())
}

function fixturePluginSource() {
  return `// auto-generated by source_optout_export_withhold smoke; fixture: @hypaware/test-source-optout-rows
import fs from 'node:fs'
import path from 'node:path'

const DATASET = '${DATASET}'
const COLUMNS = ${JSON.stringify(COLUMNS)}

let activatedStorage = null

const dataset = {
  name: DATASET,
  plugin: '@hypaware/test-source-optout-rows',
  // 'proxy' is a KNOWN_SIGNALS entry for @hypaware/central's forward sink,
  // matching the real ai_gateway_messages dataset this fixture stands in for.
  sourceSignal: 'proxy',
  schema: { columns: COLUMNS },
  primaryTimestampColumn: undefined,
  // appendRows re-partitions rows under datasets/<ds>/source=<client_name>/,
  // so discover whatever partition dirs actually landed on disk.
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

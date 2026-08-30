// @ts-check

// `hyp sync --dry-run` may state a pending volume somebody consents from, and
// the only reason that number is trustworthy is that the preview walks the
// *same* seam the export walks. That parity is spelled out three times rather
// than shared: `includeLegacy = since === undefined` lives in
// `src/core/sinks/pending.js`, `src/core/sinks/incremental.js`, and
// `@hypaware/central`'s forward sink, and the partition discovery scope lives
// in both `src/core/sinks/pending.js` and `src/core/sinks/driver.js`. Nothing
// in the code makes those copies move together.
//
// Drift is not a cosmetic problem here. A preview that passed
// `includeLegacy: true` where the export passes `false` would count a
// pre-upgrade null-seq backlog the destination has already shipped and
// overstate; the reverse would hide a backlog the very next tick forwards,
// which is the undercount class this preview exists to close. So pin the
// property behaviourally: drive those three incremental seams against a
// recording storage stub and require the read options they hand to
// `readRowsSince` to be identical.
//
// Scope, stated so nobody reads a guarantee that is not here. One further
// `readRowsSince` call site is deliberately *not* pinned, because it is not the
// incremental export seam and is not supposed to agree with it:
//
// - `@hypaware/format-iceberg`'s table-format reader takes whole tables with
//   `{ includeLegacy: true }`; it has no watermark and no notion of pending.
//
// A fourth incremental seam added later is therefore not covered until it is
// added to the scenarios below by name.
//
// `@hypaware/central`'s `writeHistoryBaseline` used to sit on that list. It
// reads `{ includeLegacy: false }` with no `since` to skip a newly eligible open
// dataset's history *without sending it* (LLP 0305 #start-now), and the preview
// had no way to model that, so it over-counted such a dataset on its first
// tick - the safe direction on a consent prompt. LLP 0324 gave the preview a
// way to ask, so this file now covers it, under a second and different parity
// claim: not "two reads agree", but "what a destination says it would do agrees
// with what its export actually does".
//
// That second claim carries the whole hazard of the disposition seam. The
// preview now *believes* a sink that answers `skips` or `starts-from-now`, so a
// sink whose answer is more restrictive than its export makes the prompt
// promise less egress than occurs, which is the one failure class this preview
// exists to prevent and the reverse of the over-count it replaced. Nothing
// inside the preview can detect it: only driving both sides of the same sink
// can, which is what the scenarios at the bottom of this file do.
//
// This is a parity test on purpose. Extracting one helper would remove today's
// duplication but not the failure mode: a future site can call `readRowsSince`
// with its own options and bypass the helper silently, and it would drag the
// plugin's forward path into a kernel-internal import it does not otherwise
// need. A test observes what the seams actually pass, however each is written.
//
// @ref LLP 0040#storage-api-extension [tests]: every seam derives `includeLegacy` from the presence of a durable watermark, identically
// @ref LLP 0101#no-release [tests]: the preview's "prints what would leave" claim rests on reading the export's seam, not a second notion of pending
// @ref LLP 0324#drift-pinned [tests]: every dataset central's export forwards is one its disposition admits, and a missing-watermark start-now dataset really does ship zero

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDatasetRolloutStore } from '../../hypaware-core/plugins-workspace/central/src/rollout.js'
import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'
import { createSinkDriver } from '../../src/core/sinks/driver.js'
import { openIncrementalRows } from '../../src/core/sinks/incremental.js'
import { previewPendingRows } from '../../src/core/sinks/pending.js'
import { createSinkWatermarkStore } from '../../src/core/sinks/watermarks.js'

const DATASET = 'ai_gateway_messages'
const PARTITION_KEY = 'source=claude'
const PLUGIN = '@hypaware/central'
const INSTANCE = 'central'

/** @param {string} prefix */
async function makeHome(prefix) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `hyp-seamparity-${prefix}-`))
  await fs.mkdir(path.join(home, 'hypaware'), { recursive: true })
  return home
}

/** @param {string} home */
const stateDir = (home) => path.join(home, 'hypaware')

/** @param {string} home */
const cacheRoot = (home) => path.join(home, 'cache')

/** @param {string} home */
const tablePathFor = (home) => path.join(cacheRoot(home), 'datasets', DATASET, PARTITION_KEY)

/**
 * The watermark file at the layout the real sink instances use, so the preview
 * resolves a durable cursor through its own `keyFor`/`read` rather than one the
 * test handed it.
 *
 * @param {string} home
 * @param {string} seq
 */
async function writeWatermark(home, seq) {
  const file = path.join(
    stateDir(home), 'plugins', PLUGIN, 'sink-instances', INSTANCE,
    'watermarks', DATASET, `${PARTITION_KEY}.json`
  )
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify({ v: 1, continuation: { v: 1, seq }, exportedRowCount: Number(seq), updatedAt: '2026-08-20T09:00:00.000Z' })
  )
}

/**
 * A storage stub that records the read options every seam hands to
 * `readRowsSince`, normalized so only the values are compared.
 *
 * @param {string} home
 */
function recordingStorage(home) {
  const table = tablePathFor(home)
  /** @type {{ since: { v: number, seq: string } | null, includeLegacy: unknown }[]} */
  const reads = []
  return {
    reads,
    cacheRoot: cacheRoot(home),
    /** @param {string} p */
    tableExists: (p) => p === table,
    hasPendingSync: () => false,
    async flushTable() {},
    /** @param {string} p @param {{ since?: { v: number, seq: string }, includeLegacy?: boolean }} [opts] */
    readRowsSince(p, opts) {
      reads.push({
        since: opts?.since ? { v: opts.since.v, seq: String(opts.since.seq) } : null,
        includeLegacy: opts?.includeLegacy,
      })
      const since = opts?.since ? Number(opts.since.seq) : 0
      return {
        async *[Symbol.asyncIterator]() {
          if (p !== table) return
          for (let seq = 1; seq <= 4; seq += 1) {
            if (seq <= since) continue
            yield { row: { id: String(seq), content_text: 'x' }, after: { v: 1, seq: String(seq) } }
          }
        },
      }
    },
  }
}

/** @param {string} home */
function singlePartitionQuery(home) {
  return {
    listDatasets: () => [{
      name: DATASET,
      discoverPartitions: () => [
        { dataset: DATASET, partition: { source: 'claude' }, tablePath: tablePathFor(home) },
      ],
    }],
    getDataset: () => ({ sourceSignal: 'logs' }),
  }
}

/**
 * Seam 1: the `hyp sync` preview. It resolves the cursor off disk itself, so
 * the scenario is expressed as a watermark file rather than a passed value.
 *
 * @param {{ v: number, seq: string } | undefined} since
 */
async function previewSeamReads(since) {
  const home = await makeHome('preview')
  if (since) await writeWatermark(home, since.seq)
  const storage = recordingStorage(home)
  await previewPendingRows({
    handles: /** @type {any[]} */ ([{ instanceName: INSTANCE, plugin: PLUGIN, kind: 'request', config: {}, sink: {} }]),
    query: /** @type {any} */ (singlePartitionQuery(home)),
    storage: /** @type {any} */ (storage),
    stateRoot: stateDir(home),
  })
  return storage.reads
}

/**
 * Seam 2: the blob-sink incremental row reader.
 *
 * @param {{ v: number, seq: string } | undefined} since
 */
async function incrementalSeamReads(since) {
  const home = await makeHome('incremental')
  const storage = recordingStorage(home)
  const reader = await openIncrementalRows(
    /** @type {any} */ (storage),
    /** @type {any} */ ({ dataset: DATASET, tablePath: tablePathFor(home) }),
    /** @type {any} */ (since)
  )
  for await (const _row of reader.rows) { void _row }
  return storage.reads
}

/**
 * Seam 3: `@hypaware/central`'s forward sink, driven through its public
 * `exportBatch` so the derivation is observed where it actually runs.
 *
 * @param {{ v: number, seq: string } | undefined} since
 */
async function centralSeamReads(since) {
  const home = await makeHome('central')
  const storage = recordingStorage(home)
  const noop = () => {}
  const sink = createForwardSink({
    config: /** @type {any} */ ({ url: 'http://server:8740', identity: {} }),
    identityClient: /** @type {any} */ ({ async getCurrentJwt() { return 'jwt' }, async refresh() {} }),
    query: /** @type {any} */ (singlePartitionQuery(home)),
    storage: /** @type {any} */ (storage),
    watermarks: /** @type {any} */ ({
      keyFor: () => ({ dataset: DATASET, partitionKey: PARTITION_KEY }),
      filePath: () => path.join(stateDir(home), 'watermarks', DATASET, `${PARTITION_KEY}.json`),
      async read() {
        return since ? { v: 1, continuation: since, exportedRowCount: Number(since.seq), updatedAt: '' } : null
      },
      async write() { return { v: 1, continuation: { v: 1, seq: '4' }, exportedRowCount: 4, updatedAt: '' } },
    }),
    rollouts: /** @type {any} */ ({ async read() { return null }, async write() { throw new Error('unused') } }),
    log: /** @type {any} */ ({ debug: noop, info: noop, warn: noop, error: noop }),
    fetchFn: /** @type {any} */ (async () => ({
      status: 202, ok: true,
      headers: { get: () => null },
      async text() { return '' },
      body: { cancel: async () => {} },
    })),
    sleepFn: async () => {},
  })
  await sink.exportBatch(
    /** @type {any} */ ({ batchId: 'b1', partitions: [{ dataset: DATASET, tablePath: tablePathFor(home) }] }),
    /** @type {any} */ ({})
  )
  return storage.reads
}

for (const scenario of [
  { name: 'no durable watermark', since: undefined, expectLegacy: true },
  { name: 'a durable watermark', since: { v: 1, seq: '2' }, expectLegacy: false },
]) {
  test(`with ${scenario.name}, the preview, the blob seam, and the central sink read rows identically`, async () => {
    const preview = await previewSeamReads(scenario.since)
    const incremental = await incrementalSeamReads(scenario.since)
    const central = await centralSeamReads(scenario.since)

    assert.equal(preview.length, 1, 'the preview read the partition exactly once')
    assert.equal(incremental.length, 1, 'the blob seam read the partition exactly once')
    assert.equal(central.length, 1, 'the central sink read the partition exactly once')

    // The property under test: three independently written derivations, one
    // answer. Any one of them drifting makes this pair unequal.
    assert.deepEqual(
      incremental[0],
      preview[0],
      'the sync preview must read exactly what the blob export reads, or its count is not the export'
    )
    assert.deepEqual(
      central[0],
      preview[0],
      'the sync preview must read exactly what the central forward reads, or its count is not the export'
    )

    // And the answer itself, so a lockstep drift in all three is caught too.
    // Pre-upgrade null-seq rows are new only where no durable cursor exists.
    assert.equal(preview[0].includeLegacy, scenario.expectLegacy)
    assert.deepEqual(preview[0].since, scenario.since ?? null)
  })
}

test('the preview discovers partitions with exactly the scope the export driver uses', async () => {
  // The other half of the parity claim: a preview that discovered a different
  // set of partitions than the driver would count a different backlog, however
  // faithfully it then read each one.
  const home = await makeHome('scope')
  const storage = recordingStorage(home)

  /** @param {Record<string, unknown>[]} sink */
  const recordingQuery = (sink) => ({
    listDatasets: () => [{
      name: DATASET,
      /** @param {Record<string, unknown>} args */
      discoverPartitions: (args) => {
        sink.push(args)
        return [{ dataset: DATASET, partition: { source: 'claude' }, tablePath: tablePathFor(home) }]
      },
    }],
    getDataset: () => ({ sourceSignal: 'logs' }),
  })

  /** @type {Record<string, unknown>[]} */
  const previewArgs = []
  await previewPendingRows({
    handles: /** @type {any[]} */ ([{ instanceName: INSTANCE, plugin: PLUGIN, kind: 'request', config: {}, sink: {} }]),
    query: /** @type {any} */ (recordingQuery(previewArgs)),
    storage: /** @type {any} */ (storage),
    stateRoot: stateDir(home),
  })

  /** @type {Record<string, unknown>[]} */
  const driverArgs = []
  const driver = createSinkDriver({
    sinkRegistry: /** @type {any} */ ({
      listHandles: () => [{
        instanceName: INSTANCE,
        plugin: PLUGIN,
        kind: 'request',
        config: { schedule: '* * * * *' },
        sink: { async exportBatch() { return { status: 'exported', partitionsExported: 0, bytesWritten: 0 } } },
      }],
    }),
    queryRegistry: /** @type {any} */ (recordingQuery(driverArgs)),
    storage: /** @type {any} */ (storage),
    stateRoot: stateDir(home),
  })
  await driver.tick({ force: true, now: new Date('2026-08-20T09:00:00.000Z') })

  assert.equal(previewArgs.length, 1)
  // At least one, and every one: the driver re-discovers after a flush, so
  // pinning the *count* would fail on an unrelated change to when it flushes.
  // The property is the scope each call carries, not how many calls there are.
  assert.ok(driverArgs.length >= 1, 'the driver discovered partitions at least once')
  for (const args of driverArgs) {
    assert.deepEqual(previewArgs[0], args, 'the preview and the driver must ask for the same partitions')
  }
})

// ---------------------------------------------------------------------------
// The disposition seam (LLP 0324). The claim above is about how a seam READS;
// this one is about what a destination SAYS. The preview stopped counting
// datasets a destination refuses, which is only safe while the refusal it is
// told about is the refusal the export performs.
// ---------------------------------------------------------------------------

const OPEN_DATASET = 'context_graph_edges'
const LOCAL_ONLY_DATASET = 'context_graph_nodes'
const RESERVED_DATASET = 'logs'

/**
 * One dataset per class central's forwarding rule distinguishes: a legacy
 * signal, a name a legacy ingest path has reserved, a dataset declaring
 * local-only content, and a plain eligible open dataset.
 *
 * @param {string} home
 */
function dispositionDatasets(home) {
  /** @param {string} name */
  const tableFor = (name) => path.join(cacheRoot(home), 'datasets', name, PARTITION_KEY)
  /** @param {string} name @param {Record<string, unknown>} extra */
  const mk = (name, extra) => ({
    name,
    plugin: '@hypaware/test',
    schema: { fields: [{ name: 'id', type: 'string' }] },
    ...extra,
    discoverPartitions: () => [
      { dataset: name, partition: { source: 'claude' }, tablePath: tableFor(name) },
    ],
  })
  return [
    mk(DATASET, { sourceSignal: 'logs' }),
    mk(RESERVED_DATASET, {}),
    mk(LOCAL_ONLY_DATASET, { localOnlyContentColumns: ['content_text'] }),
    mk(OPEN_DATASET, {}),
  ]
}

/**
 * Four rows in every table, so a dataset that forwards forwards something and a
 * zero is never an artefact of an empty cache.
 *
 * @param {string} home
 * @param {ReturnType<typeof dispositionDatasets>} datasets
 */
function multiTableStorage(home, datasets) {
  const tables = new Set(datasets.map((d) => String(d.discoverPartitions()[0].tablePath)))
  return {
    cacheRoot: cacheRoot(home),
    /** @param {string} p */
    tableExists: (p) => tables.has(p),
    hasPendingSync: () => false,
    async flushTable() {},
    /** @param {string} p @param {{ since?: { v: number, seq: string } }} [opts] */
    readRowsSince(p, opts) {
      const since = opts?.since ? Number(opts.since.seq) : 0
      return {
        async *[Symbol.asyncIterator]() {
          if (!tables.has(p)) return
          for (let seq = 1; seq <= 4; seq += 1) {
            if (seq <= since) continue
            yield { row: { id: String(seq) }, after: { v: 1, seq: String(seq) } }
          }
        },
      }
    },
  }
}

/**
 * A real central forward sink over real on-disk watermark and rollout stores,
 * at the layout a real instance uses, so `writeHistoryBaseline` writes the file
 * the preview then reads. Every fetch is captured; the ingest route is the only
 * one that ships rows.
 *
 * @param {string} home
 */
function centralOverDatasets(home) {
  const datasets = dispositionDatasets(home)
  const storage = multiTableStorage(home, datasets)
  const byName = new Map(datasets.map((d) => [d.name, d]))
  const query = { listDatasets: () => datasets, getDataset: (/** @type {string} */ n) => byName.get(n) }
  const instanceDir = path.join(stateDir(home), 'plugins', PLUGIN, 'sink-instances', INSTANCE)
  /** @type {{ url: string, body: string }[]} */
  const posts = []
  const noop = () => {}
  const sink = createForwardSink({
    config: /** @type {any} */ ({ url: 'http://server:8740', identity: {} }),
    identityClient: /** @type {any} */ ({ async getCurrentJwt() { return 'jwt' }, async refresh() {} }),
    query: /** @type {any} */ (query),
    storage: /** @type {any} */ (storage),
    watermarks: createSinkWatermarkStore({ stateDir: instanceDir }),
    rollouts: createDatasetRolloutStore({
      paths: /** @type {any} */ ({ stateDir: path.join(stateDir(home), 'plugins', PLUGIN) }),
      instanceName: INSTANCE,
    }),
    log: /** @type {any} */ ({ debug: noop, info: noop, warn: noop, error: noop }),
    fetchFn: /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
      posts.push({ url: String(url), body: String(init?.body ?? '') })
      return {
        status: 202, ok: true,
        headers: { get: () => null },
        async text() { return '' },
        body: { cancel: async () => {} },
      }
    }),
    sleepFn: async () => {},
  })
  return { sink, storage, query, datasets, posts }
}

/**
 * Drive one sink's real `exportBatch` over each dataset in turn, and record,
 * per dataset, how many rows it actually put on the wire beside what its
 * disposition claims it would do. One `exportBatch` call per dataset, because
 * the ingest route is keyed by signal rather than by dataset name and a legacy
 * dataset's rows land under a path that does not carry its name.
 *
 * @param {{ datasetDisposition?: (dataset: any) => unknown, exportBatch: (batch: any, opts: any) => Promise<any> }} sink
 * @param {ReturnType<typeof dispositionDatasets>} datasets
 * @param {{ url: string, body: string }[]} posts
 */
async function observeForwarding(sink, datasets, posts) {
  /** @type {{ name: string, rowsForwarded: number, disposition: unknown }[]} */
  const observed = []
  for (const dataset of datasets) {
    const before = posts.length
    await sink.exportBatch({ batchId: `b-${dataset.name}`, partitions: dataset.discoverPartitions() }, {})
    const rowsForwarded = posts
      .slice(before)
      .filter((post) => post.url.includes('/v1/ingest/'))
      .reduce((n, post) => n + post.body.split('\n').filter((line) => line.length > 0).length, 0)
    observed.push({
      name: dataset.name,
      rowsForwarded,
      disposition: sink.datasetDisposition?.(dataset),
    })
  }
  return observed
}

/**
 * The property LLP 0324 #drift-pinned names, as an assertion rather than as
 * prose: a destination may not tell the consent prompt it withholds a dataset
 * and then ship it. Both restrictive answers are covered, because both are
 * promises about egress - `skips` promises none ever, `starts-from-now`
 * promises none from before the sink existed, and `observeForwarding` runs on
 * an instance with no watermarks, which is exactly "before the sink existed".
 *
 * Factored out so the drift scenario below can prove this catches a lie rather
 * than asserting it does.
 *
 * @param {{ name: string, rowsForwarded: number, disposition: unknown }[]} observed
 */
function assertNoUnderDisclosure(observed) {
  for (const row of observed) {
    if (row.disposition === 'skips') {
      assert.equal(
        row.rowsForwarded,
        0,
        `'${row.name}': the disposition answered 'skips' while the export forwarded ${row.rowsForwarded} rows, so the prompt would promise less egress than occurs`
      )
    }
    if (row.disposition === 'starts-from-now') {
      assert.equal(
        row.rowsForwarded,
        0,
        `'${row.name}': the disposition answered 'starts-from-now' while this instance's first export forwarded ${row.rowsForwarded} rows of history`
      )
    }
  }
}

test('every dataset central forwards is one its disposition admits', async () => {
  const home = await makeHome('disposition')
  const central = centralOverDatasets(home)

  const observed = await observeForwarding(central.sink, central.datasets, central.posts)

  assertNoUnderDisclosure(observed)

  // And the classification itself, because a sink answering `forwards` for
  // everything satisfies the property above without disclosing anything: the
  // point is that the preview's numbers move, not merely that they are safe.
  assert.deepEqual(observed, [
    { name: DATASET, rowsForwarded: 4, disposition: 'forwards' },
    { name: RESERVED_DATASET, rowsForwarded: 0, disposition: 'skips' },
    { name: LOCAL_ONLY_DATASET, rowsForwarded: 0, disposition: 'skips' },
    { name: OPEN_DATASET, rowsForwarded: 0, disposition: 'starts-from-now' },
  ])
})

test("a missing-watermark eligible open dataset's first export ships zero rows, and the preview says so", async () => {
  const home = await makeHome('startnow')
  const central = centralOverDatasets(home)
  const open = central.datasets.find((d) => d.name === OPEN_DATASET)
  assert.ok(open)

  assert.equal(central.sink.datasetDisposition?.(/** @type {any} */ (open)), 'starts-from-now')

  // The preview first, on an instance with no watermark anywhere: this is the
  // state the export is about to resolve, so both sides answer the same
  // question from the same disk.
  const previewQuery = { listDatasets: () => [open], getDataset: () => open }
  const handle = /** @type {any} */ ({
    instanceName: INSTANCE, plugin: PLUGIN, kind: 'request', config: {}, sink: central.sink,
  })
  const volumes = await previewPendingRows({
    handles: [handle],
    query: /** @type {any} */ (previewQuery),
    storage: /** @type {any} */ (central.storage),
    stateRoot: stateDir(home),
  })
  const volume = /** @type {any} */ (volumes.get(INSTANCE))
  assert.equal(volume.rows, 0, 'a start-now dataset with no cursor has no pending history')
  assert.equal(volume.status, 'counted', "zero here is the sink's answer, not a count that failed")
  assert.notEqual(volume.resume.kind, 'beginning', 'a start-now destination does not reach back at all')

  // A sink that answers nothing over the identical state is the contrast that
  // makes the zero above attributable to the disposition and not to an empty
  // cache: it quotes the whole four-row history.
  const silent = /** @type {any} */ ({
    instanceName: INSTANCE, plugin: PLUGIN, kind: 'request', config: {},
    sink: { async exportBatch() { return { status: 'exported', partitionsExported: 0, bytesWritten: 0 } } },
  })
  const silentVolume = /** @type {any} */ ((await previewPendingRows({
    handles: [silent],
    query: /** @type {any} */ (previewQuery),
    storage: /** @type {any} */ (central.storage),
    stateRoot: stateDir(home),
  })).get(INSTANCE))
  assert.equal(silentVolume.rows, 4)
  assert.equal(silentVolume.resume.kind, 'beginning')

  // Now the export, from that same empty state. It baselines the history
  // instead of sending it, so the wire stays empty and the preview was right.
  const result = await central.sink.exportBatch(
    /** @type {any} */ ({ batchId: 'b1', partitions: open.discoverPartitions() }),
    /** @type {any} */ ({})
  )
  assert.equal(result.status, 'exported')
  assert.deepEqual(
    central.posts.filter((post) => post.url.includes('/v1/ingest/')),
    [],
    'the rollout baseline skips the history without sending it'
  )
})

test('a disposition more restrictive than the export it describes is caught, not trusted', async () => {
  // The hazard the seam introduces, staged deliberately. A sink whose answer
  // under-states its own export makes the consent prompt promise less egress
  // than occurs, and the preview cannot detect that on its own: it has already
  // decided to believe the answer. So the guard has to be this parity property,
  // and a guard that has never been shown to fail is not a guard.
  const home = await makeHome('drift')
  const central = centralOverDatasets(home)

  // Central's real export path, central's real rows, and one lie on top.
  const lying = { ...central.sink, datasetDisposition: () => 'skips' }

  const observed = await observeForwarding(lying, central.datasets, central.posts)
  const forwarded = observed.find((row) => row.name === DATASET)
  assert.equal(forwarded?.rowsForwarded, 4, 'the lying sink really did put rows on the wire')

  assert.throws(
    () => assertNoUnderDisclosure(observed),
    /'ai_gateway_messages': the disposition answered 'skips' while the export forwarded 4 rows/
  )
})

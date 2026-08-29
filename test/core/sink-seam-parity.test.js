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
// Scope, stated so nobody reads a guarantee that is not here. Two further
// `readRowsSince` call sites are deliberately *not* pinned, because they are
// not the incremental export seam and are not supposed to agree with it:
//
// - `@hypaware/central`'s `writeHistoryBaseline` reads `{ includeLegacy: false }`
//   with no `since` to skip a newly eligible open dataset's history *without
//   sending it* (LLP 0305 #start-now). The preview does not model that, so it
//   over-counts such a dataset on its first tick: the safe direction on a
//   consent prompt, and the reason this file does not try to equalize them.
// - `@hypaware/format-iceberg`'s table-format reader takes whole tables with
//   `{ includeLegacy: true }`; it has no watermark and no notion of pending.
//
// A fourth incremental seam added later is therefore not covered until it is
// added to the scenarios below by name.
//
// This is a parity test on purpose. Extracting one helper would remove today's
// duplication but not the failure mode: a future site can call `readRowsSince`
// with its own options and bypass the helper silently, and it would drag the
// plugin's forward path into a kernel-internal import it does not otherwise
// need. A test observes what the seams actually pass, however each is written.
//
// @ref LLP 0040#storage-api-extension [tests]: every seam derives `includeLegacy` from the presence of a durable watermark, identically
// @ref LLP 0101#no-release [tests]: the preview's "prints what would leave" claim rests on reading the export's seam, not a second notion of pending

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'
import { createSinkDriver } from '../../src/core/sinks/driver.js'
import { openIncrementalRows } from '../../src/core/sinks/incremental.js'
import { previewPendingRows } from '../../src/core/sinks/pending.js'

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

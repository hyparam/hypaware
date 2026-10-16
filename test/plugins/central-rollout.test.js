// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDatasetRolloutStore } from '../../hypaware-core/plugins-workspace/central/src/rollout.js'
import { initializeOpenDatasetRollouts } from '../../hypaware-core/plugins-workspace/central/src/sink.js'
import { appendRowsToTable } from '../../src/core/cache/iceberg/store.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { INGEST_SEQ_COLUMN } from '../../src/core/cache/streaming-reader.js'
import { createSinkWatermarkStore } from '../../src/core/sinks/watermarks.js'

const DATASET = 'ai_gateway_messages'
const PARTITIONS = ['source=claude', 'source=codex']
const MARKER = 'central-baseline-payload:'

test('dataset rollout state persists per sink instance and distinguishes missing from corrupt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-central-rollout-'))
  try {
    const store = createDatasetRolloutStore({
      paths: /** @type {any} */ ({ stateDir: root }),
      instanceName: 'central-primary',
    })

    assert.equal(await store.read('claude_telemetry_events'), null)
    const written = await store.write(
      'claude_telemetry_events',
      ['source=unknown', 'source=claude', 'source=unknown'],
      null
    )
    assert.deepEqual(written.partitions, ['source=claude', 'source=unknown'])
    assert.deepEqual(await store.read('claude_telemetry_events'), written)

    await fs.writeFile(store.filePath('claude_telemetry_events'), '{not-json', 'utf8')
    await assert.rejects(
      store.read('claude_telemetry_events'),
      /rollout state .* is corrupt/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('dataset rollout state rejects unsafe persisted partition keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-central-rollout-'))
  try {
    const store = createDatasetRolloutStore({
      paths: /** @type {any} */ ({ stateDir: root }),
      instanceName: 'central-primary',
    })
    await assert.rejects(
      store.write('claude_telemetry_events', ['../../outside'], null),
      /rollout partition key/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// The rollout baseline walks a newly eligible open dataset's whole local
// history for the seq it starts forwarding after (LLP 0305 #start-now), and
// reads nothing but the continuation, so it asks for no payload columns. That
// watermark is the whole point of the walk: a narrowing that moved it by one
// row would make the sink skip history it should send, or resend history it
// should not. So the reference here is taken off the un-narrowed read, on real
// Parquet across two partitions, and the narrowed baseline must match it.
test('the open-dataset history baseline reaches the same watermark without decoding payloads', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-central-baseline-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const cacheRoot = path.join(home, 'cache')
  const stateDir = path.join(home, 'state')
  /** @param {string} partitionKey */
  const tablePathFor = (partitionKey) => path.join(cacheRoot, 'datasets', DATASET, partitionKey)

  // A withholding resolver is configured because the columns the withholding
  // rules read are forced into the scan whatever the caller projects: a
  // narrowing that silently disarmed them would forward a local-only row.
  const storage = createQueryStorageService({
    cacheRoot,
    usagePolicyResolver: /** @type {any} */ ({
      /** @param {string} cwd */
      resolve: (cwd) => ({ class: cwd === '/local' ? 'local-only' : 'full' }),
    }),
  })

  // Wide enough that decoding it is unmistakable in the decoder probe below.
  const payload = { content: [{ nested: { text: `${MARKER}${'x'.repeat(64 * 1024)}` } }] }
  const columns = /** @type {const} */ ([
    { name: 'cwd', type: 'STRING', nullable: true },
    { name: 'attributes', type: 'JSON', nullable: true },
    INGEST_SEQ_COLUMN,
  ])
  /** @param {number} base @param {number} count */
  const rowsFor = (base, count) => Array.from({ length: count }, (_, i) => ({
    cwd: i % 3 === 0 ? '/local' : '/full',
    attributes: payload,
    [INGEST_SEQ_COLUMN.name]: BigInt(base + i + 1),
  }))
  // Two appends per partition, so the high-water crosses more than one data
  // file, and different row counts, so the partitions end on different seqs.
  for (const [index, partitionKey] of PARTITIONS.entries()) {
    const base = index * 100
    await appendRowsToTable(tablePathFor(partitionKey), columns, rowsFor(base, 4))
    await appendRowsToTable(tablePathFor(partitionKey), columns, rowsFor(base + 4, index + 1))
  }

  // Observe the real nested string decoder rather than the options handed to a
  // stub, so "no payload decoding" is a measurement and not a restatement.
  let payloadDecodes = 0
  const decode = TextDecoder.prototype.decode
  t.mock.method(TextDecoder.prototype, 'decode', function (...args) {
    const result = Reflect.apply(decode, this, args)
    if (result.includes(MARKER)) payloadDecodes += 1
    return result
  })

  /** @type {Map<string, { seq: string, rows: number }>} */
  const reference = new Map()
  for (const partitionKey of PARTITIONS) {
    let seq = '0'
    let rows = 0
    for await (const entry of storage.readRowsSince(tablePathFor(partitionKey), { includeLegacy: false })) {
      seq = entry.after.seq
      rows += 1
    }
    reference.set(partitionKey, { seq, rows })
  }
  assert.deepEqual(
    [...reference.values()],
    [{ seq: '5', rows: 5 }, { seq: '106', rows: 6 }],
    'the fixture is two partitions of real rows ending on different seqs'
  )
  assert.ok(payloadDecodes > 0, 'the un-narrowed history read decodes the payload column')

  payloadDecodes = 0
  /** @type {{ message: string, fields: Record<string, unknown> }[]} */
  const logged = []
  const noop = () => {}
  const watermarks = createSinkWatermarkStore({ stateDir })
  await initializeOpenDatasetRollouts({
    query: /** @type {any} */ ({
      listDatasets: () => [{
        name: DATASET,
        discoverPartitions: () => PARTITIONS.map((partitionKey) => ({
          dataset: DATASET,
          tablePath: tablePathFor(partitionKey),
        })),
      }],
    }),
    storage: /** @type {any} */ (storage),
    watermarks: /** @type {any} */ (watermarks),
    rollouts: createDatasetRolloutStore({
      paths: /** @type {any} */ ({ stateDir }),
      instanceName: 'central',
    }),
    log: /** @type {any} */ ({
      debug: noop,
      warn: noop,
      error: noop,
      /** @param {string} message @param {Record<string, unknown>} [fields] */
      info: (message, fields) => { logged.push({ message, fields: fields ?? {} }) },
    }),
  })

  assert.equal(payloadDecodes, 0, 'establishing the baseline must not decode the payload column')
  for (const partitionKey of PARTITIONS) {
    const expected = reference.get(partitionKey)
    const record = await watermarks.read(watermarks.keyFor(cacheRoot, tablePathFor(partitionKey)))
    assert.equal(record?.continuation.seq, expected?.seq, `${partitionKey}: durable baseline seq`)
    assert.equal(record?.exportedRowCount, 0, `${partitionKey}: the baseline forwards nothing`)
  }
  assert.deepEqual(
    logged
      .filter((row) => row.message === 'central.forward.initial_history_skipped')
      .map((row) => ({ seq: row.fields.baseline_seq, rows: row.fields.skipped_row_count })),
    PARTITIONS.map((partitionKey) => reference.get(partitionKey)),
    'the skipped history is exactly what the un-narrowed read walked'
  )
})

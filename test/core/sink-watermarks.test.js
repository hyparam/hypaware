// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  createSinkWatermarkStore,
  deriveWatermarkKey,
} from '../../src/core/sinks/watermarks.js'

/**
 * @import { SinkContinuation } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sink-wm-'))
}

/**
 * @param {string} seq
 * @returns {SinkContinuation}
 */
function cont(seq) {
  return { v: 1, seq }
}

test('deriveWatermarkKey splits dataset from the partition path', () => {
  const cacheRoot = '/cache'
  const key = deriveWatermarkKey(cacheRoot, '/cache/datasets/proxy/source=claude')
  assert.deepEqual(key, { dataset: 'proxy', partitionKey: 'source=claude' })
})

test('deriveWatermarkKey is keyed by the LOGICAL path, independent of tableDir', () => {
  // The logical partition path is stable; the physical `table-<seq>` directory
  // inside it changes on every compaction. Callers pass the logical path, so the
  // key (and thus the watermark file) reads straight through a generation swap.
  const cacheRoot = '/cache'
  const logical = '/cache/datasets/proxy/source=claude'
  const a = deriveWatermarkKey(cacheRoot, logical)
  const b = deriveWatermarkKey(cacheRoot, logical)
  assert.deepEqual(a, b)

  const store = createSinkWatermarkStore({ stateDir: '/state' })
  const file = store.filePath(a)
  assert.ok(!file.includes('table-'), 'watermark file must not embed a physical tableDir')
  assert.equal(file, path.join('/state', 'watermarks', 'proxy', 'source=claude.json'))
})

test('deriveWatermarkKey preserves nested partition segments', () => {
  const key = deriveWatermarkKey('/cache', '/cache/datasets/logs/source=otel/date=2026-06-25')
  assert.deepEqual(key, { dataset: 'logs', partitionKey: 'source=otel/date=2026-06-25' })
  const store = createSinkWatermarkStore({ stateDir: '/state' })
  assert.equal(
    store.filePath(key),
    path.join('/state', 'watermarks', 'logs', 'source=otel', 'date=2026-06-25.json')
  )
})

test('deriveWatermarkKey sanitizes unsafe segment characters', () => {
  const key = deriveWatermarkKey('/cache', '/cache/datasets/weird ds/source=a b')
  assert.equal(key.dataset, 'weird_ds')
  assert.equal(key.partitionKey, 'source=a_b')
})

test('deriveWatermarkKey falls back to a sentinel when no partition segment', () => {
  const key = deriveWatermarkKey('/cache', '/cache/datasets/proxy')
  assert.deepEqual(key, { dataset: 'proxy', partitionKey: '_partition' })
})

test('deriveWatermarkKey rejects paths outside the datasets root', () => {
  assert.throws(() => deriveWatermarkKey('/cache', '/elsewhere/datasets/proxy/source=x'))
  assert.throws(() => deriveWatermarkKey('/cache', '/cache/_hyp_ingest_seq.json'))
})

test('read returns null when no watermark has been written', async () => {
  const stateDir = await makeTmpDir()
  const store = createSinkWatermarkStore({ stateDir })
  const key = deriveWatermarkKey('/cache', '/cache/datasets/proxy/source=claude')
  assert.equal(await store.read(key), null)
})

test('write then read round-trips the continuation and row count', async () => {
  const stateDir = await makeTmpDir()
  const store = createSinkWatermarkStore({ stateDir })
  const key = deriveWatermarkKey('/cache', '/cache/datasets/proxy/source=claude')

  const written = await store.write(key, { continuation: cont('42'), exportedRowCount: 7 })
  assert.deepEqual(written.continuation, cont('42'))
  assert.equal(written.exportedRowCount, 7)
  assert.equal(written.v, 1)
  assert.ok(written.updatedAt.length > 0)

  const read = await store.read(key)
  assert.ok(read)
  assert.deepEqual(read.continuation, cont('42'))
  assert.equal(read.exportedRowCount, 7)
})

test('write advances the watermark in place (latest wins)', async () => {
  const stateDir = await makeTmpDir()
  const store = createSinkWatermarkStore({ stateDir })
  const key = deriveWatermarkKey('/cache', '/cache/datasets/proxy/source=claude')

  await store.write(key, { continuation: cont('10'), exportedRowCount: 10 })
  await store.write(key, { continuation: cont('25'), exportedRowCount: 25 })

  const read = await store.read(key)
  assert.ok(read)
  assert.deepEqual(read.continuation, cont('25'))
  assert.equal(read.exportedRowCount, 25)

  // One file per (dataset, partition) — no per-write accumulation.
  const dir = path.join(stateDir, 'watermarks', 'proxy')
  const entries = await fs.readdir(dir)
  assert.deepEqual(entries, ['source=claude.json'])
})

test('write is atomic write-rename and leaves no temp files', async () => {
  const stateDir = await makeTmpDir()
  const store = createSinkWatermarkStore({ stateDir })
  const key = deriveWatermarkKey('/cache', '/cache/datasets/proxy/source=claude')

  await store.write(key, { continuation: cont('1'), exportedRowCount: 1 })
  const dir = path.join(stateDir, 'watermarks', 'proxy')
  const entries = await fs.readdir(dir)
  assert.ok(entries.every((e) => !e.includes('.tmp.')), `no temp file should survive: ${entries}`)
})

test('write rejects a malformed continuation before touching disk', async () => {
  const stateDir = await makeTmpDir()
  const store = createSinkWatermarkStore({ stateDir })
  const key = deriveWatermarkKey('/cache', '/cache/datasets/proxy/source=claude')

  // Type-valid token, but `seq` is not a decimal string — only the runtime
  // guard catches it.
  await assert.rejects(() => store.write(key, { continuation: { v: 1, seq: 'not-a-number' } }))
  await assert.rejects(
    // @ts-expect-error — wrong version
    () => store.write(key, { continuation: { v: 2, seq: '1' } })
  )
  // Nothing was persisted.
  assert.equal(await store.read(key), null)
})

test('read returns null on a corrupt watermark file (safe re-export, never silent skip)', async () => {
  const stateDir = await makeTmpDir()
  const store = createSinkWatermarkStore({ stateDir })
  const key = deriveWatermarkKey('/cache', '/cache/datasets/proxy/source=claude')

  const dest = store.filePath(key)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.writeFile(dest, '{ not valid json', 'utf8')
  assert.equal(await store.read(key), null)

  await fs.writeFile(dest, JSON.stringify({ v: 1, continuation: { v: 1, seq: 12 } }), 'utf8')
  assert.equal(await store.read(key), null, 'numeric seq is not the decimal-string contract')
})

test('keyFor matches deriveWatermarkKey', () => {
  const store = createSinkWatermarkStore({ stateDir: '/state' })
  assert.deepEqual(
    store.keyFor('/cache', '/cache/datasets/proxy/source=claude'),
    deriveWatermarkKey('/cache', '/cache/datasets/proxy/source=claude')
  )
})

test('createSinkWatermarkStore requires a stateDir', () => {
  // @ts-expect-error — exercising the runtime guard
  assert.throws(() => createSinkWatermarkStore({}))
})

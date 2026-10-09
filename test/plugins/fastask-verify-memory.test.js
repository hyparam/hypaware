// @ts-check

/**
 * Review r1 F6: the replica verifier must not buffer a decompressed line.
 * A 64 KiB gzip holding one node row with a 64 MiB `props` field used to
 * raise RSS by about 147 MB in the verifier before the capped index builder
 * refused it. This file runs in a process of its own (the test runner
 * isolates files), so the memory it measures is this shape's alone.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import v8 from 'node:v8'
import { runInNewContext } from 'node:vm'

import { measureFile } from '../../hypaware-core/plugins-workspace/graph-cache/src/contract.js'
import { createReplicaSync } from '../../hypaware-core/plugins-workspace/graph-cache/src/replica_sync.js'
import { replicaKey, replicaPaths } from '../../hypaware-core/plugins-workspace/graph-cache/src/replica_store.js'
import { largeRowGeneration, pinnedGeneration, startSnapshotServer } from '../helpers/fastask_snapshot_server.js'

const FIELD_BYTES = 64 * 1024 * 1024
const MAX_INDEX_BYTES = 1024 * 1024

v8.setFlagsFromString('--expose-gc')
const gc = /** @type {() => void} */ (runInNewContext('gc'))

/**
 * Runs `work` while sampling RSS and Buffer memory every millisecond, and
 * returns how far each rose above where it started.
 *
 * @param {() => Promise<unknown>} work
 */
async function peakIncrease(work) {
  gc()
  const start = process.memoryUsage()
  let rss = start.rss
  let arrayBuffers = start.arrayBuffers
  const poll = setInterval(() => {
    const now = process.memoryUsage()
    rss = Math.max(rss, now.rss)
    arrayBuffers = Math.max(arrayBuffers, now.arrayBuffers)
  }, 1)
  try {
    await work()
  } finally {
    clearInterval(poll)
  }
  const end = process.memoryUsage()
  return { rss: Math.max(rss, end.rss) - start.rss, arrayBuffers: Math.max(arrayBuffers, end.arrayBuffers) - start.arrayBuffers }
}

test('a 64 MiB row under a 1 MiB index ceiling is refused in the verifier without buffering it; the held generation stays', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastask-verify-memory-'))
  const server = await startSnapshotServer()
  server.publish(pinnedGeneration())
  const clock = { now: Date.parse('2026-10-09T04:00:00.000Z') }
  const target = { target: 'team', url: server.url, org: 'acme', token: async () => /** @type {const} */ ({ ok: true, token: 'tok', source: 'file', kind: 'oidc' }) }
  const sync = createReplicaSync({ stateDir, resolveTarget: async () => target, now: () => clock.now, random: () => 0, budget: { duty: 1 }, maxIndexBytes: MAX_INDEX_BYTES })
  t.after(async () => {
    await sync.close()
    await server.close()
    fs.rmSync(stateDir, { recursive: true, force: true })
  })
  const paths = replicaPaths(stateDir, replicaKey(server.url, 'acme'))
  const pinned = pinnedGeneration().manifest.generation

  assert.equal((await sync.syncOnce()).status.state, 'synced')
  const lease = sync.status().lease_expires_at

  const large = await largeRowGeneration({ generation: '1760000000000-100', fieldBytes: FIELD_BYTES })
  assert.ok(large.files.nodes.length < 128 * 1024, `the gzip is small (${large.files.nodes.length} bytes)`)
  assert.equal(large.manifest.files.nodes.rows, 1, 'one row: passes the up-front row-count check')
  server.publish(large)
  clock.now += 3600_000

  /** @type {any} */
  let status
  const peak = await peakIncrease(async () => { status = (await sync.syncOnce()).status })
  t.diagnostic(`peak increase: rss ${peak.rss} bytes, buffers ${peak.arrayBuffers} bytes (field ${FIELD_BYTES}, ceiling ${MAX_INDEX_BYTES})`)

  assert.equal(server.dataRequests().filter((r) => r.url.includes(large.manifest.generation)).length, 2, 'it was downloaded, so the verifier saw it')
  assert.equal(status.state, 'stale')
  assert.equal(status.reason, 'replica_too_large')
  assert.equal(status.generation, pinned, 'the held generation is kept')
  assert.equal(status.servable, true)
  assert.equal(status.lease_expires_at, lease, 'a refused generation does not renew the lease')
  assert.equal(JSON.parse(fs.readFileSync(paths.record, 'utf8')).last_error.code, 'line_too_large')
  assert.deepEqual(fs.readdirSync(paths.staging), [])
  assert.deepEqual(fs.readdirSync(paths.generations), [pinned])

  // Bounded by the ceiling plus a chunk, not by the 64 MiB field.
  assert.ok(peak.arrayBuffers < 4 * MAX_INDEX_BYTES, `buffers rose ${peak.arrayBuffers} bytes`)
  assert.ok(peak.rss < 32 * 1024 * 1024, `rss rose ${peak.rss} bytes`)
})

test('even with no ceiling, measuring the 64 MiB line never holds the line', async () => {
  const large = await largeRowGeneration({ generation: '1760000000000-101', fieldBytes: FIELD_BYTES })
  /** @type {any} */
  let measured
  const peak = await peakIncrease(async () => { measured = await measureFile(large.files.nodes) })
  assert.deepEqual(measured.problems, [])
  assert.equal(measured.facts.uncompressed_bytes, large.manifest.files.nodes.uncompressed_bytes)
  assert.equal(measured.facts.set_digest, large.manifest.files.nodes.set_digest)
  assert.ok(measured.facts.uncompressed_bytes > FIELD_BYTES)
  // What remains is decompressed chunks the collector has not reclaimed yet;
  // holding the line would take at least the whole field.
  assert.ok(peak.arrayBuffers < FIELD_BYTES / 2, `buffers rose ${peak.arrayBuffers} bytes for a ${FIELD_BYTES}-byte line`)
})

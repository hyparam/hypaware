// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { startIndexProcess, verifySnapshotInProcess } from '../../hypaware-core/plugins-workspace/graph-cache/src/index_process.js'
import { pinnedGeneration } from '../helpers/fastask_snapshot_server.js'

/** @import { TestContext } from 'node:test' */

/** @param {TestContext} t */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-cache-owner-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { manifest, files } = pinnedGeneration()
  for (const name of ['nodes', 'edges']) await fs.writeFile(path.join(dir, `${name}.ndjson.gz`), files[name])
  const stop = new AbortController()
  t.after(() => stop.abort())
  const index = await startIndexProcess({ dir, manifest, duty: 1, signal: stop.signal })
  t.after(() => index.close())
  return { index, dir, manifest, stop }
}

// @ref LLP 0490#memory [tests]: real process ownership, IPC and termination, not a mocked allocation count
test('isolated index answers discovery and traversal, then releases its process', async t => {
  const { index } = await fixture(t)
  const answer = JSON.parse(await index.discover({ question: 'app.js' }))
  assert.ok(answer.leads.some(l => l.session_id === 'fx-session-0001'))
  const hop = JSON.parse(await index.neighbors({ keys: [answer.anchors[0].key], direction: 'both' }))
  assert.ok(hop.neighbors.length > 0)
  assert.ok(index.bytes > 0 && index.buildRss > index.bytes)
  await index.close()
  assert.equal(index.alive, false)
  assert.throws(() => process.kill(index.pid, 0), { code: 'ESRCH' })
  await assert.rejects(index.discover({ question: 'app' }), /unavailable/)
})

test('IPC admits at most sixteen pending requests and drains them', async t => {
  const { index } = await fixture(t)
  const admitted = Array.from({ length: 16 }, () => index.discover({ question: 'app' }))
  await assert.rejects(index.discover({ question: 'overflow' }), /busy/)
  await Promise.all(admitted)
  assert.ok(JSON.parse(await index.discover({ question: 'app' })).leads.length > 0)
})

test('external helper death fails closed and abort terminates an owner', async t => {
  const { index, stop } = await fixture(t)
  process.kill(index.pid, 'SIGKILL')
  for (let i = 0; i < 100 && index.alive; i++) await sleep(10)
  assert.equal(index.alive, false)
  await assert.rejects(index.neighbors({ keys: ['any'] }), /unavailable/)
  stop.abort()
  await index.close()
})

test('build refusal preserves its typed reason and returns no owner', async t => {
  const { dir, manifest } = await fixture(t)
  await assert.rejects(startIndexProcess({ dir, manifest, maxBytes: 1, signal: new AbortController().signal }), { code: 'replica_too_large' })
})


test('isolated verification rejects tampering and line overruns before index activation', async t => {
  const { dir, manifest } = await fixture(t)
  const opts = { dir, manifest, maxLineBytes: 1024 * 1024, budget: { duty: 1 } }
  assert.equal((await verifySnapshotInProcess(opts)).ok, true)
  const limited = await verifySnapshotInProcess({ ...opts, maxLineBytes: 1 })
  assert.equal(limited.ok, false)
  assert.equal(limited.refused, 'line_too_large')
  await fs.appendFile(path.join(dir, 'nodes.ndjson.gz'), 'corrupt')
  const tampered = await verifySnapshotInProcess(opts)
  assert.equal(tampered.ok, false)
  assert.ok(tampered.problems.length > 0)
})

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { once } from 'node:events'

const SINK_URL = new URL('../../hypaware-core/plugins-workspace/central/src/sink.js', import.meta.url).href
const WATERMARK_URL = new URL('../../src/core/sinks/watermarks.js', import.meta.url).href

// Separate runtimes share real watermark/receipt files, as the CLI and daemon
// do. The first POST is held at an explicit barrier, not by a slow network.
const WORKER = `
import readline from 'node:readline'
import { createForwardSink } from ${JSON.stringify(SINK_URL)}
import { createSinkWatermarkStore } from ${JSON.stringify(WATERMARK_URL)}
const { root, hold, destination = 'http://fixture', fail = false } = JSON.parse(process.argv[1])
const input = readline.createInterface({ input: process.stdin })
const say = event => console.log(JSON.stringify(event))
let release
const gate = new Promise(resolve => { release = resolve })
input.on('line', line => { if (line === 'release') release(); if (line === 'close') void sink.close() })
const storage = {
  cacheRoot: root + '/cache', tableExists: () => true, async flushTable() {},
  async *readRowsSince(_path, options) {
    if (BigInt(options?.since?.seq ?? '0') < 1n) {
      yield { row: { message_id: 'synthetic', content_text: 'fixture' }, after: { v: 1, seq: '1' } }
    }
  },
}
const sink = createForwardSink({
  config: { url: destination },
  identityClient: { identity: { gateway_id: 'fixture' }, async getCurrentJwt() { return 'fixture' } },
  query: { getDataset: name => ({ name, plugin: 'fixture', sourceSignal: 'proxy', schema: { columns: [] } }) },
  storage,
  watermarks: createSinkWatermarkStore({ stateDir: root + '/instance' }),
  receiptsDir: root + '/instance/receipts', rollouts: {},
  log: { debug() {}, info(event, fields) { say({ type: 'log', event, fields }) }, warn() {}, error() {} },
  fetchFn: async (_url, init) => {
    await new Response(init.body).text()
    say({ type: 'post' })
    if (hold) await gate
    return new Response('{}', { status: fail ? 500 : 202 })
  },
})
say({ type: 'ready' })
const result = await sink.exportBatch({ partitions: [{ dataset: 'ai_gateway_messages', tablePath: root + '/cache/datasets/ai_gateway_messages/source=fixture' }] })
await sink.close()
say({ type: 'result', status: result.status })
input.close()
`

/** @param {Record<string, unknown>} args */
function worker(args) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER, JSON.stringify(args)])
  /** @type {Array<Record<string, any>>} */
  const events = []
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', line => events.push(JSON.parse(line)))
  const exited = once(child, 'exit')
  return {
    child, events, exited,
    /** @param {string} command */
    send(command) { child.stdin.write(command + '\n') },
    /** @param {(event: Record<string, any>) => boolean} predicate */
    async waitFor(predicate) {
      for (;;) {
        const found = events.find(predicate)
        if (found) return found
        assert.equal(child.exitCode, null, stderr || 'worker exited before its event')
        await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error(stderr || 'worker exited before its event') })])
      }
    },
  }
}

// @ref LLP 0550#ownership [tests]: the actual sink waits across processes and reads the watermark only after ownership transfers
test('foreground sync waits for daemon completion, then skips its acknowledged rows', { timeout: 15_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-upload-coordination-'))
  const first = worker({ root, hold: true })
  /** @type {Array<ReturnType<typeof worker>>} */
  const children = [first]
  t.after(async () => {
    for (const w of children) w.child.kill('SIGKILL')
    await Promise.all(children.map(w => w.exited))
    await fs.rm(root, { recursive: true, force: true })
  })
  await first.waitFor(e => e.type === 'post')
  const claimRoot = path.join(root, 'instance/receipts')
  const claims = (await fs.readdir(claimRoot)).filter(name => name.endsWith('.mutation-lock'))
  assert.equal(claims.length, 1)
  const old = new Date(Date.now() - 3_600_000)
  await fs.utimes(path.join(claimRoot, claims[0]), old, old)
  for (const owner of await fs.readdir(path.join(claimRoot, claims[0]))) {
    await fs.utimes(path.join(claimRoot, claims[0], owner), old, old)
  }
  const second = worker({ root })
  children.push(second)
  await second.waitFor(e => e.event === 'central.forward.partition_wait')
  assert.equal(second.events.some(e => e.type === 'post'), false)
  first.send('release')
  assert.equal((await first.waitFor(e => e.type === 'result')).status, 'exported')
  assert.equal((await second.waitFor(e => e.type === 'result')).status, 'exported')
  assert.equal(second.events.some(e => e.type === 'post'), false, 'fresh watermark prevents duplicate upload')
  assert.equal(second.events.filter(e => e.event === 'central.forward.partition_wait').length, 1)
  assert.equal(second.events.filter(e => e.event === 'central.forward.partition_acquired').length, 1)
})

test('a crashed uploader releases ownership through dead-PID recovery', { timeout: 15_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-upload-crash-'))
  const first = worker({ root, hold: true })
  const children = [first]
  t.after(async () => {
    for (const w of children) w.child.kill('SIGKILL')
    await Promise.all(children.map(w => w.exited))
    await fs.rm(root, { recursive: true, force: true })
  })
  await first.waitFor(e => e.type === 'post')
  first.child.kill('SIGKILL')
  await first.exited
  const second = worker({ root })
  children.push(second)
  assert.equal((await second.waitFor(e => e.type === 'result')).status, 'exported')
  assert.equal(second.events.filter(e => e.type === 'post').length, 1)
})

test('closing a waiting sync settles without uploading or releasing the other owner', { timeout: 15_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-upload-close-'))
  const first = worker({ root, hold: true })
  const children = [first]
  t.after(async () => {
    for (const w of children) w.child.kill('SIGKILL')
    await Promise.all(children.map(w => w.exited))
    await fs.rm(root, { recursive: true, force: true })
  })
  await first.waitFor(e => e.type === 'post')
  const second = worker({ root })
  children.push(second)
  await second.waitFor(e => e.event === 'central.forward.partition_wait')
  second.send('close')
  assert.equal((await second.waitFor(e => e.type === 'result')).status, 'failed')
  assert.equal(second.events.some(e => e.type === 'post'), false)
  const third = worker({ root })
  children.push(third)
  await third.waitFor(e => e.event === 'central.forward.partition_wait')
  assert.equal(third.events.some(e => e.type === 'post'), false, 'cancellation did not release the first owner')
  first.send('release')
  assert.equal((await first.waitFor(e => e.type === 'result')).status, 'exported')
  assert.equal((await third.waitFor(e => e.type === 'result')).status, 'exported')
})

test('a failed uploader releases its claim without advancing the shared watermark', { timeout: 15_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-upload-failure-'))
  const first = worker({ root, hold: true, fail: true })
  const children = [first]
  t.after(async () => {
    for (const w of children) w.child.kill('SIGKILL')
    await Promise.all(children.map(w => w.exited))
    await fs.rm(root, { recursive: true, force: true })
  })
  await first.waitFor(e => e.type === 'post')
  const second = worker({ root })
  children.push(second)
  await second.waitFor(e => e.event === 'central.forward.partition_wait')
  first.send('release')
  assert.equal((await first.waitFor(e => e.type === 'result')).status, 'failed')
  assert.equal((await second.waitFor(e => e.type === 'result')).status, 'exported')
  assert.equal(second.events.filter(e => e.type === 'post').length, 1, 'unacknowledged rows still upload')
})

test('a different destination does not wait for the first uploader', { timeout: 15_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-upload-independent-'))
  const first = worker({ root, hold: true })
  const children = [first]
  t.after(async () => {
    for (const w of children) w.child.kill('SIGKILL')
    await Promise.all(children.map(w => w.exited))
    await fs.rm(root, { recursive: true, force: true })
  })
  await first.waitFor(e => e.type === 'post')
  const second = worker({ root, destination: 'http://other-fixture' })
  children.push(second)
  assert.equal((await second.waitFor(e => e.type === 'result')).status, 'exported')
  assert.equal(second.events.filter(e => e.type === 'post').length, 1)
  assert.equal(second.events.some(e => e.event === 'central.forward.partition_wait'), false)
  first.send('release')
  assert.equal((await first.waitFor(e => e.type === 'result')).status, 'exported')
})

// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { cursorNativeFixture } from '../../hypaware-core/smoke/lib/cursor_native_fixture.js'
import { createCursorBackfillProvider } from '../../hypaware-core/plugins-workspace/cursor/src/recovery.js'
import { createStartCursorSource } from '../../hypaware-core/plugins-workspace/cursor/src/listener.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createUsagePolicyResolver } from '../../src/core/usage-policy/index.js'
import { aiGatewayTablePath } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

function envelope(cwd, event = {}) {
  return { delivery_id: randomUUID(), observed_at: '2026-09-10T12:00:00.000Z', event: {
    conversation_id: 'conversation', generation_id: 'turn', workspace_roots: [cwd],
    hook_event_name: 'beforeReadFile', file_path: path.join(cwd ?? '/missing', 'notes.txt'), content: 'hello', ...event,
  } }
}

async function fixture(deps = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-listener-'))
  await fs.writeFile(path.join(root, 'notes.txt'), 'hello')
  const policyPath = path.join(root, 'policy.json')
  const ignoredSessions = new Set()
  /** @type {any[]} */
  const rows = []
  const storage = {
    cacheTablePath: () => '/cache/ai_gateway_messages',
    async discoverCachePartitions() { return [] }, async *readRows() {},
    async *readSpooledRows() { yield* rows },
    async appendRows(_path, _cols, next) { rows.push(...next) },
  }
  const readOptions = { editorDb: path.join(root, 'native/state.vscdb'), cliRoot: path.join(root, 'native/chats') }
  const start = createStartCursorSource({ localOnlyListPath: policyPath, ignoredSessions, readOptions, ...deps })
  const ctx = /** @type {any} */ ({ config: { listen_port: 0 }, storage, log: { info() {}, warn() {}, error() {} } })
  let source = await start(ctx)
  let endpoint = `http://127.0.0.1:${(await source.status?.())?.details?.listen_port}`
  return {
    root, policyPath, rows, storage, ignoredSessions, readOptions, get source() { return source }, get endpoint() { return endpoint },
    post: (body) => fetch(`${endpoint}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    async restart() {
      await source.stop()
      source = await start(ctx)
      endpoint = `http://127.0.0.1:${(await source.status?.())?.details?.listen_port}`
    },
    async cleanup() {
      await source.stop()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

test('storage failure, concurrent redelivery, restart and waiting spool preserve exactly one delivery', async () => {
  const f = await fixture()
  try {
    const body = envelope(f.root)
    const append = f.storage.appendRows
    f.storage.appendRows = async () => { throw new Error('PRIVATE storage diagnostic') }
    assert.equal((await f.post(body)).status, 500)
    assert.equal(f.rows.length, 0)
    assert.equal((await f.source.status?.())?.lastError?.includes('PRIVATE'), false)
    f.storage.appendRows = append
    const responses = await Promise.all([f.post(body), f.post(body), f.post(body)])
    assert.ok(responses.every((r) => r.status === 200))
    assert.equal(f.rows.length, 1)
    await f.restart()
    assert.equal((await f.post(body)).status, 200)
    assert.equal(f.rows.length, 1)
    await f.post({ ...body, delivery_id: randomUUID() })
    assert.equal(f.rows.length, 2, 'a separate identical callback is a separate observation')
  } finally { await f.cleanup() }
})

test('file-content observations respect file policy, workspace boundaries and native delivery identity', async () => {
  const f = await fixture()
  try {
    const workspace = path.join(f.root, 'workspace')
    const privateDir = path.join(workspace, 'private')
    await fs.mkdir(privateDir, { recursive: true })
    const file = path.join(workspace, 'notes.txt')
    await fs.writeFile(file, 'probe contents')
    await fs.writeFile(path.join(privateDir, '.hypignore'), 'local-only\n')
    await fs.writeFile(path.join(privateDir, 'notes.txt'), 'private')
    const outside = path.join(f.root, 'outside.txt')
    await fs.writeFile(outside, 'outside')
    await fs.symlink(outside, path.join(workspace, 'link.txt'))
    const body = envelope(workspace, { hook_event_name: 'beforeReadFile', file_path: file, content: 'probe contents' })
    assert.equal((await f.post(body)).status, 200)
    await f.post(body)
    assert.equal(f.rows.length, 1)
    assert.equal(f.rows[0].content_text, 'probe contents')
    assert.equal(f.rows[0].role, 'system')
    assert.equal(f.rows[0].hook_event, 'beforeReadFile')
    assert.equal(f.rows[0].tool_call_id, undefined)
    for (const file_path of [outside, path.join(workspace, 'link.txt'), path.join(privateDir, 'notes.txt'),
      path.join(workspace, 'missing.txt'), 'relative']) {
      assert.equal((await f.post({ ...body, delivery_id: randomUUID(), event: { ...body.event, file_path } })).status, 202)
    }
    assert.equal(f.rows.length, 1)
    f.ignoredSessions.add('conversation')
    assert.equal((await f.post({ ...body, delivery_id: randomUUID() })).status, 202)
    assert.equal(f.rows.length, 1)
  } finally { await f.cleanup() }
})

test('generic tool hooks schedule native recovery without creating misleading success rows', async () => {
  const f = await fixture()
  try {
    const response = await f.post(envelope(f.root, { hook_event_name: 'postToolUse', tool_name: 'Shell', tool_use_id: 'helper-id', tool_output: '{"exit_code":0}' }))
    assert.equal(response.status, 202)
    assert.equal(/** @type {any} */ (await response.json()).reason, 'native_recovery_scheduled')
    assert.equal(f.rows.length, 0)
  } finally { await f.cleanup() }
})

test('policy/session ignore precede persistence; missing fields and disabled recovery coverage remain observable', async () => {
  const f = await fixture()
  try {
    const ignored = path.join(f.root, 'ignored')
    await fs.mkdir(ignored)
    await fs.writeFile(path.join(ignored, '.hypignore'), 'ignore\n')
    assert.equal((await f.post(envelope(ignored))).status, 202)
    const result = await fetch(`${f.endpoint}/_hypaware/ignore/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'conversation' }) })
    assert.equal(result.status, 200)
    assert.equal((await f.post(envelope(f.root))).status, 202)
    assert.equal((await f.post(envelope(undefined))).status, 202)
    assert.equal(f.rows.length, 0)
    const status = await f.source.status?.()
    assert.equal(status?.details?.history_recovery, 'native_store')
    assert.equal(status?.details?.usage_supported, false)
    assert.equal(status?.details?.policy_drops, 1)
    assert.equal(status?.details?.session_drops, 1)
    assert.equal(status?.details?.missing_cwd, 1)
    assert.equal(status?.details?.missing_transcripts, 3)
  } finally { await f.cleanup() }
})

test('writer rotation retains stored identity without retaining a lifetime adapter cache', async () => {
  const f = await fixture()
  try {
    const first = envelope(f.root)
    await f.post(first)
    for (let i = 1; i <= 1024; i++) assert.equal((await f.post(envelope(f.root))).status, 200)
    assert.equal(f.rows.length, 1025)
    assert.equal((await f.post(first)).status, 200)
    assert.equal(f.rows.length, 1025, 'the pre-rotation delivery is still deduped from waiting storage')
  } finally { await f.cleanup() }
})

test('bounded queue rejects a fifth writer and rechecks ignore when a queued write starts', async () => {
  const f = await fixture()
  let release = () => {}
  let entered = () => {}
  const writing = new Promise((r) => { entered = () => r(undefined) })
  const gate = new Promise((r) => { release = () => r(undefined) })
  const append = f.storage.appendRows
  f.storage.appendRows = async (...args) => {
    entered()
    await gate
    await append(...args)
  }
  try {
    const pending = [f.post(envelope(f.root))]
    await writing
    for (let i = 0; i < 3; i++) pending.push(f.post(envelope(f.root)))
    // Wait for listener admission, not an arbitrary scheduling delay.
    for (let i = 0; i < 100 && (await f.source.status?.())?.details?.active_requests !== 4; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.equal((await f.source.status?.())?.details?.active_requests, 4)
    assert.equal((await f.post(envelope(f.root))).status, 503)
    f.ignoredSessions.add('conversation')
    release()
    const results = await Promise.all(pending)
    assert.deepEqual(results.map((r) => r.status), [200, 202, 202, 202])
    assert.equal(f.rows.length, 1)
  } finally {
    release()
    await f.cleanup()
  }
})

test('receiver rejects browser simple requests, oversized bodies and foreign Host', async () => {
  const f = await fixture()
  try {
    const simple = await fetch(`${f.endpoint}/hook`, { method: 'POST', body: JSON.stringify(envelope(f.root)) })
    assert.equal(simple.status, 415)
    assert.equal((await f.post(envelope(f.root, { text: 'x'.repeat(1024 * 1024) }))).status, 413)
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${f.endpoint}/hook`, { method: 'POST', headers: { host: 'foreign.example', 'content-type': 'application/json' } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(status, 421)
    assert.equal(f.rows.length, 0)
  } finally { await f.cleanup() }
})

test('standalone hook sends valid payload and reports failure without blocking or writing disk', async () => {
  const f = await fixture()
  const run = (endpoint) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('hypaware-core/plugins-workspace/cursor/src/hook.mjs'), endpoint], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (v) => { out += v })
    child.stderr.on('data', (v) => { err += v })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, out, err }))
    child.stdin.end(JSON.stringify(envelope(f.root).event))
  })
  try {
    assert.deepEqual(await run(f.endpoint), { code: 0, out: '', err: '' })
    assert.equal(f.rows.length, 1)
    assert.deepEqual(await run(new URL(f.endpoint).host), { code: 0, out: '', err: '' })
    assert.equal(f.rows.length, 2)
    const failed = /** @type {any} */ (await run('http://127.0.0.1:1'))
    assert.equal(failed.code, 0)
    assert.equal(failed.out, '')
    assert.match(failed.err, /not confirmed/)
    assert.deepEqual(await fs.readdir(f.root), ['notes.txt'])
  } finally { await f.cleanup() }
})

test('local-only Cursor rows remain queryable but are withheld by the actual export seam', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-export-'))
  const cwd = path.join(root, 'private')
  await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, '.hypignore'), 'local-only\n')
  await fs.writeFile(path.join(cwd, 'notes.txt'), 'hello')
  const policy = createUsagePolicyResolver()
  const storage = createQueryStorageService({ cacheRoot: path.join(root, 'cache'), usagePolicyResolver: policy })
  const source = await createStartCursorSource()(/** @type {any} */ ({ config: { listen_port: 0 }, storage, log: { info() {}, warn() {} } }))
  try {
    const endpoint = `http://127.0.0.1:${(await source.status?.())?.details?.listen_port}/hook`
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope(cwd)) })
    assert.equal(response.status, 200)
    const table = aiGatewayTablePath(storage)
    await storage.flushTable(table, { reason: 'manual' })
    let local = 0
    let exported = 0
    let dropped = 0
    for (const part of await storage.discoverCachePartitions()) {
      for await (const row of storage.readRows(part.path)) {
        assert.equal(row.cwd, cwd)
        local++
      }
      for await (const row of storage.readRowsSince(part.path, {})) {
        if (row.dropped) dropped++
        else exported++
      }
    }
    assert.equal(local, 1)
    assert.equal(dropped, 1)
    assert.equal(exported, 0)
  } finally {
    await source.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('recovery did not settle')
}

test('native recovery retries failed writes, survives restart, and serializes with backfill', async () => {
  const activeRecoveries = new Set()
  const f = await fixture({ recoveryDelayMs: 10, activeRecoveries })
  const native = await cursorNativeFixture(f.readOptions.cliRoot, f.root)
  try {
    const body = envelope(f.root, { conversation_id: native.session.id, hook_event_name: 'sessionEnd' })
    const append = f.storage.appendRows
    let failed = false
    f.storage.appendRows = async (...args) => {
      if (!failed) { failed = true; throw new Error('PRIVATE diagnostic') }
      await append(...args)
    }
    await f.post(body)
    await waitFor(() => f.rows.length === 8)
    assert.equal((await f.source.status?.())?.details?.native_failures, 1)
    assert.equal((await f.source.status?.())?.lastError, undefined)
    await f.restart()
    await f.post(body)
    await waitFor(async () => (await f.source.status?.())?.details?.native_reads === 1)
    assert.equal(f.rows.length, 8)
    const provider = createCursorBackfillProvider({ ...f.readOptions, activeRecoveries })
    const ctx = /** @type {any} */ ({ dryRun: false, env: {}, log: { info() {}, warn() {} } })
    const iterator = provider.run(ctx)[Symbol.asyncIterator]()
    await iterator.next()
    assert.equal(activeRecoveries.has(native.session.id), true)
    await f.restart()
    await f.post(body)
    await waitFor(async () => Number((await f.source.status?.())?.details?.native_failures) >= 1)
    assert.equal((await f.source.status?.())?.details?.native_reads, 0)
    await iterator.return?.()
    assert.equal(activeRecoveries.size, 0)
    await waitFor(async () => (await f.source.status?.())?.details?.native_reads === 1)
    assert.equal(f.rows.length, 8)
  } finally { native.close(); await f.cleanup() }
})

test('pending recovery is bounded, cancelled on stop, and rechecks session ignore', async () => {
  const f = await fixture({ recoveryDelayMs: 30 })
  const native = await cursorNativeFixture(f.readOptions.cliRoot, f.root)
  try {
    await f.post(envelope(f.root, { conversation_id: native.session.id, hook_event_name: 'sessionEnd' }))
    f.ignoredSessions.add(native.session.id)
    await waitFor(async () => (await f.source.status?.())?.details?.pending_recovery === 0)
    assert.equal(f.rows.length, 0)
  } finally { native.close(); await f.cleanup() }
  const bounded = await fixture({ recoveryDelayMs: 30000 })
  try {
    for (let i = 0; i < 70; i++) await bounded.post(envelope(bounded.root, { conversation_id: randomUUID(), hook_event_name: 'sessionEnd' }))
    const details = (await bounded.source.status?.())?.details
    assert.equal(details?.pending_recovery, 64)
    assert.equal(details?.recovery_queue_drops, 6)
  } finally { await bounded.cleanup() }
  assert.equal((await bounded.source.status?.())?.details?.pending_recovery, 0)
})

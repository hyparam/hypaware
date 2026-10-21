// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import test from 'node:test'
import { projectDroidEntries, droidSessionHeader } from '../../hypaware-core/plugins-workspace/droid/src/projector.js'
import { droidSessionsRoot, readDroidTranscript, MAX_LINE_BYTES, MAX_FILE_BYTES } from '../../hypaware-core/plugins-workspace/droid/src/transcript.js'
import { createDroidBackfillProvider } from '../../hypaware-core/plugins-workspace/droid/src/backfill.js'
import { attachDroidHooks, droidHooksPath, DROID_EVENTS } from '../../hypaware-core/plugins-workspace/droid/src/attach.js'
import { validateDroidConfig } from '../../hypaware-core/plugins-workspace/droid/src/config.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'

const fixture = (await fs.readFile(new URL('../../hypaware-core/smoke/fixtures/droid-session.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
const silent = { info() {}, warn() {}, debug() {}, error() {} }
const descriptor = /** @type {any} */ ({ name: 'droid', attachProbe: { format: 'json', settings_file: '.factory/hooks.json', marker_key: '_hypaware' } })

/** @param {any} t */
async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-droid-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const root = droidSessionsRoot({ HOME: home })
  await fs.mkdir(path.join(root, 'project'), { recursive: true })
  const records = structuredClone(fixture)
  records[0].cwd = home
  const file = path.join(root, 'project', 'session.jsonl')
  await fs.writeFile(file, records.map(e => JSON.stringify(e)).join('\n') + '\n')
  return { home, root, records, file }
}

/** @param {any} iterable */
async function collect(iterable) {
  const items = []
  for await (const item of iterable) items.push(item)
  return items
}

/** @param {any[]} items */
function rows(items) { return items.filter(i => i.projection).flatMap(i => aiGatewayRowsFromProjectedExchange(i.projection)) }

/** @param {number} i */
function message(i) { return { type: 'message', id: `m-${i}`, timestamp: '2026-10-20T12:00:10Z', seq: i, message: { role: 'user', content: `Message ${i}` } } }

test('Droid native format projects stable IDs, sequence, models and tools without invented usage', () => {
  const entries = fixture.filter(e => e.type === 'message')
  const projection = projectDroidEntries(fixture[0], entries, entries.map(e => e.seq))
  assert.ok(projection)
  const projected = aiGatewayRowsFromProjectedExchange(projection)
  assert.equal(projected.length, 5)
  assert.deepEqual(projected.map(r => r.message_index), [0, 1, 1, 2, 3])
  assert.ok(projected.some(r => r.part_type === 'tool_call' && r.tool_name === 'Read' && r.tool_call_id === 'call-1'))
  assert.ok(projected.some(r => r.part_type === 'tool_result' && r.tool_call_id === 'call-1'))
  assert.ok(projected.every(r => !/** @type {any} */ (r.attributes)?.usage))
  assert.equal(projection.messages[1].model, 'fixture-model')
  assert.equal(projection.messages[1].previous_message_id?.[0], projection.messages[0].message_id)
  assert.deepEqual(projectDroidEntries(fixture[0], entries, entries.map(e => e.seq)), projection)
  assert.notEqual(projectDroidEntries({ ...fixture[0], id: 'fork' }, entries, entries.map(e => e.seq))?.messages[0].message_id, projection.messages[0].message_id)
  assert.equal(droidSessionHeader({ ...fixture[0], version: 3 }), undefined)
  assert.equal(droidSessionHeader({ ...fixture[0], cwd: 'relative' }), undefined)
})

test('Droid incremental reader handles append, partial UTF-8 lines, header rewrites and same-size edits', async t => {
  const { file, root, records } = await setup(t)
  const opts = { root, allowed: () => true }
  const first = await collect(readDroidTranscript(file, opts))
  assert.equal(rows(first).length, 5)
  const cursor = first.at(-1).cursor
  assert.ok(cursor)
  assert.equal(rows(await collect(readDroidTranscript(file, { ...opts, cursor }))).length, 0)
  const appended = JSON.stringify({ ...message(4), message: { role: 'user', content: 'Unicode ☃' } })
  const buffer = Buffer.from(appended + '\n')
  await fs.appendFile(file, buffer.subarray(0, buffer.length - 4))
  const partial = await collect(readDroidTranscript(file, { ...opts, cursor }))
  assert.equal(rows(partial).length, 0)
  assert.equal(partial.at(-1).cursor.offset, cursor.offset)
  await fs.appendFile(file, buffer.subarray(buffer.length - 4))
  assert.equal(rows(await collect(readDroidTranscript(file, { ...opts, cursor: partial.at(-1).cursor }))).length, 1)
  records[0].title = 'A longer rewritten title'
  await fs.writeFile(file, records.map(e => JSON.stringify(e)).join('\n') + '\n')
  const rewrite = await collect(readDroidTranscript(file, { ...opts, cursor }))
  assert.equal(rows(rewrite).length, 5)
  records[1].message.content[0].text = 'Read different!!'
  await fs.writeFile(file, records.map(e => JSON.stringify(e)).join('\n') + '\n')
  assert.equal(rows(await collect(readDroidTranscript(file, { ...opts, cursor: rewrite.at(-1).cursor }))).length, 5)
})

test('Droid bounds work per scan, maintains positions across batches and honors time windows', async t => {
  const { file, root, records } = await setup(t)
  const entries = Array.from({ length: 150 }, (_, i) => message(i))
  delete /** @type {any} */ (entries[10]).seq
  entries[80].timestamp = '2026-10-21T12:00:00Z'
  await fs.writeFile(file, [records[0], ...entries].map(e => JSON.stringify(e)).join('\n') + '\n')
  const opts = { root, allowed: () => true }
  const all = await collect(readDroidTranscript(file, opts))
  assert.deepEqual(rows(all).map(r => r.message_index), Array.from({ length: 150 }, (_, i) => i))
  assert.ok(all.filter(i => i.projection).every(i => i.projection.messages.length <= 64))
  const filtered = await collect(readDroidTranscript(file, { ...opts, window: { sinceMs: Date.parse('2026-10-21') } }))
  assert.deepEqual(rows(filtered).map(r => r.message_index), [80])
  const bounded = await collect(readDroidTranscript(file, { ...opts, maxBytes: 1024 }))
  assert.ok(rows(bounded).length < 150)
  assert.equal(bounded.at(-1).complete, false)
  const rest = await collect(readDroidTranscript(file, { ...opts, cursor: bounded.at(-1).cursor }))
  assert.equal(rows(bounded).length + rows(rest).length, 150)
})

test('Droid refuses outside-root files, unsupported headers and budgets, and leaves pending records retryable', async t => {
  const { file, root, records, home } = await setup(t)
  const opts = { root, allowed: () => true }
  const outside = path.join(home, 'outside.jsonl')
  await fs.copyFile(file, outside)
  const link = path.join(root, 'link.jsonl')
  await fs.symlink(outside, link)
  await assert.rejects(collect(readDroidTranscript(link, opts)), /outside_root/)
  await assert.rejects(collect(readDroidTranscript(file, { ...opts, sessionId: 'other' })), /unsupported_session/)
  assert.ok((await collect(readDroidTranscript(file, { ...opts, allowed: () => false })))[0].dropped)
  await fs.appendFile(file, 'x'.repeat(MAX_LINE_BYTES + 1))
  await assert.rejects(collect(readDroidTranscript(file, opts)), /line_budget/)
  const fd = await fs.open(file, 'r+')
  await fd.truncate(MAX_FILE_BYTES + 1)
  await fd.close()
  await assert.rejects(collect(readDroidTranscript(file, opts)), /file_budget/)
  records[3].message.content[0].content = '__TOOL_RESULT_PENDING__'
  await fs.writeFile(file, records.map(e => JSON.stringify(e)).join('\n') + '\n')
  const pending = await collect(readDroidTranscript(file, opts))
  assert.equal(rows(pending).length, 3)
  assert.equal(pending.at(-1).complete, false)
})

test('Droid recovery fingerprints only completed writes, retries failure and honors exclusions', async t => {
  const { home, file, records } = await setup(t)
  const ignored = new Set()
  const provider = createDroidBackfillProvider({ env: { HOME: home }, ignoredSessions: ignored })
  const ctx = /** @type {any} */ ({ env: {}, log: silent, dryRun: true, sweep: true, itemsFailed: 0 })
  assert.ok((await collect(provider.run(ctx))).some(i => i.value))
  ctx.dryRun = false
  for await (const item of provider.run(ctx)) if (item.type !== 'event') ctx.itemsFailed++
  assert.ok((await collect(provider.run(ctx))).some(i => i.value))
  assert.equal((await collect(provider.run(ctx))).length, 0)
  await fs.appendFile(file, JSON.stringify(message(4)) + '\n')
  assert.ok((await collect(provider.run(ctx))).some(i => i.value))
  ignored.add(records[0].id)
  ctx.sweep = false
  assert.equal((await collect(provider.run(ctx))).length, 0)
  ignored.clear()
  await fs.writeFile(path.join(home, '.hypignore'), 'ignore\n')
  assert.equal((await collect(provider.run(ctx))).length, 0)
  assert.equal(createDroidBackfillProvider({ config: { backfill: { on_join: false } } }).sweep, undefined)
  assert.equal(validateDroidConfig({ backfill: { window_days: 7 }, listen_port: 4324 }).ok, true)
  assert.equal(validateDroidConfig({ unexpected: true }).ok, false)
})

test('Droid attach preserves existing hooks and settings fallbacks, is idempotent and detaches from disk', async t => {
  const { home } = await setup(t)
  const env = { FACTORY_HOME_OVERRIDE: home, DROID_HOME: '/must-not-use' }
  const settingsPath = droidHooksPath({ env })
  const original = { Stop: [{ matcher: 'user', hooks: [{ type: 'command', command: 'echo existing' }] }], showHookOutput: true }
  const fallback = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo fallback' }] }] } }
  await fs.writeFile(settingsPath, JSON.stringify(original))
  await fs.writeFile(path.join(home, '.factory', 'settings.json'), JSON.stringify(fallback))
  const opts = { env, endpoint: 'http://127.0.0.1:4324', version: '1.0.0' }
  assert.equal((await attachDroidHooks({ ...opts, dryRun: true })).changed, true)
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), original)
  assert.equal((await attachDroidHooks(opts)).changed, true)
  assert.equal((await attachDroidHooks(opts)).changed, false)
  const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
  assert.equal(attached.Stop[0].hooks[0].command, 'echo existing')
  assert.equal(attached.SessionStart[0].hooks[0].command, 'echo fallback')
  assert.ok(DROID_EVENTS.every(event => attached[event].some(group => group.hooks.some(h => h.command.includes('hook.mjs')))))
  attached.Stop.push({ hooks: [{ type: 'command', command: 'echo later' }] })
  await fs.writeFile(settingsPath, JSON.stringify(attached))
  await detachClientFromDisk({ descriptor, homeDir: home, env })
  const detached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
  assert.deepEqual(detached, { ...original, Stop: [...original.Stop, { hooks: [{ type: 'command', command: 'echo later' }] }] })
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, '.factory', 'settings.json'), 'utf8')), fallback)
})

test('Droid refuses legacy hook shadowing and corrupt exclusion state', async t => {
  const { home } = await setup(t)
  await fs.mkdir(path.join(home, '.factory', 'hooks'))
  await fs.writeFile(path.join(home, '.factory', 'hooks', 'hooks.json'), '{}')
  await assert.rejects(attachDroidHooks({ homeDir: home, endpoint: 'http://127.0.0.1:4324', version: '1' }), /legacy/)
  const state = path.join(home, 'state')
  const ignored = new SessionIgnoreSet(state, silent)
  await fs.mkdir(path.join(state, 'session-ignores'), { recursive: true })
  await fs.writeFile(path.join(state, 'session-ignores', 'broken.json'), 'broken')
  const provider = createDroidBackfillProvider({ env: { HOME: home }, ignoredSessions: ignored })
  await assert.rejects(collect(provider.run(/** @type {any} */ ({ env: {}, log: silent }))), /exclusions|unreadable/)
})

test('Droid live writer failure leaves the cursor retryable; persistent opt-out and request boundaries apply', async t => {
  const { home, file, records } = await setup(t)
  const { createStartDroidSource } = await import('../../hypaware-core/plugins-workspace/droid/src/listener.js')
  const recorded = []
  let fail = true
  const storage = {
    cacheTablePath: () => '/cache/droid', async discoverCachePartitions() { return [] },
    async *readRows() {}, async *readSpooledRows() { yield* recorded },
    async appendRows(_plugin, _contract, batch) {
      if (fail) throw new Error('simulated write failure')
      recorded.push(...batch)
    },
  }
  const ignored = new SessionIgnoreSet(path.join(home, 'state'), silent)
  const source = await createStartDroidSource({ ignoredSessions: ignored })(/** @type {any} */ ({ config: { listen_port: 0 }, env: { HOME: home }, storage, log: silent }))
  t.after(() => source.stop())
  const endpoint = `http://127.0.0.1:${(await source.status?.())?.details?.listen_port}`
  const notification = { session_id: records[0].id, transcript_path: file }
  const post = (value = notification, route = '/hook', type = 'application/json') => fetch(endpoint + route, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(value) })
  assert.equal((await post()).status, 500)
  assert.equal((await source.status?.())?.details?.cursor_count, 0)
  fail = false
  assert.equal((await post()).status, 200)
  assert.equal(recorded.length, 5)
  assert.equal((await post()).status, 200)
  assert.equal(recorded.length, 5)
  assert.equal((await post(notification, '/hook', 'text/plain')).status, 415)
  assert.equal((await post({ ...notification, transcript_path: 'relative' })).status, 400)
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request(endpoint + '/hook', { method: 'POST', headers: { host: 'attacker.example', 'content-type': 'application/json' } }, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end(JSON.stringify(notification))
  })
  assert.equal(wrongHost, 421)
  const oversized = await fetch(endpoint + '/hook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(17000) })
  assert.equal(oversized.status, 413)
  const control = await fetch(endpoint + '/_hypaware/ignore/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: records[0].id }) })
  assert.equal(control.status, 200)
  await fs.appendFile(file, JSON.stringify(message(4)) + '\n')
  assert.equal((await post()).status, 202)
  assert.equal(recorded.length, 5)
  const restartedIgnores = new SessionIgnoreSet(path.join(home, 'state'), silent)
  const recovery = createDroidBackfillProvider({ env: { HOME: home }, ignoredSessions: restartedIgnores })
  assert.equal((await collect(recovery.run(/** @type {any} */ ({ env: {}, log: silent })))).length, 0)
})

test('Droid live capture and recovery fail closed when the session folder cannot be probed', async t => {
  if (process.getuid?.() === 0) return t.skip('root reads through directory permissions')
  const { home, file, records } = await setup(t)
  const locked = path.join(home, 'locked')
  await fs.mkdir(locked)
  records[0].cwd = locked
  await fs.writeFile(file, records.map(e => JSON.stringify(e)).join('\n') + '\n')
  const { createStartDroidSource } = await import('../../hypaware-core/plugins-workspace/droid/src/listener.js')
  /** @param {string} state */
  async function capture(state) {
    const recorded = []
    const storage = {
      cacheTablePath: () => '/cache/droid', async discoverCachePartitions() { return [] },
      async *readRows() {}, async *readSpooledRows() { yield* recorded },
      async appendRows(_plugin, _contract, batch) { recorded.push(...batch) },
    }
    const ignoredSessions = new SessionIgnoreSet(path.join(home, `state-${state}`), silent)
    const source = await createStartDroidSource({ ignoredSessions })(/** @type {any} */ ({ config: { listen_port: 0 }, env: { HOME: home }, storage, log: silent }))
    try {
      const endpoint = `http://127.0.0.1:${(await source.status?.())?.details?.listen_port}`
      await fetch(endpoint + '/hook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: records[0].id, transcript_path: file }) })
    } finally {
      await source.stop()
    }
    const recovery = createDroidBackfillProvider({ env: { HOME: home }, ignoredSessions })
    const recovered = await collect(recovery.run(/** @type {any} */ ({ env: {}, log: silent, dryRun: true })))
    return { live: recorded.length, recovered: recovered.filter(i => i.value).length }
  }
  await fs.writeFile(path.join(locked, '.hypignore'), 'ignore\n')
  assert.deepEqual(await capture('readable'), { live: 0, recovered: 0 })
  await fs.chmod(locked, 0o000)
  try {
    assert.deepEqual(await capture('locked'), { live: 0, recovered: 0 })
  } finally {
    await fs.chmod(locked, 0o700)
  }
  await fs.unlink(path.join(locked, '.hypignore'))
  const open = await capture('open')
  assert.equal(open.live, 5)
  assert.ok(open.recovered > 0)
})

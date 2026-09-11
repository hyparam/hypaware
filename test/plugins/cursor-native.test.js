// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { cursorNativeFixture, wire } from '../../hypaware-core/smoke/lib/cursor_native_fixture.js'
import { cursorFields, cursorStorePaths, findCursorSession, listCursorSessions, readCursorSession } from '../../hypaware-core/plugins-workspace/cursor/src/native.js'
import { createCursorBackfillProvider, cursorAdmission } from '../../hypaware-core/plugins-workspace/cursor/src/recovery.js'

/** @param {'cli' | 'editor'} [frontend] */
async function fixture(frontend = 'cli') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-native-'))
  const cwd = path.join(root, 'workspace')
  await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, 'notes.txt'), 'The probe value is MARIGOLD-42.\n')
  const f = await cursorNativeFixture(path.join(root, 'native'), cwd, frontend)
  const opts = { editorDb: frontend === 'editor' ? f.session.dbPath : path.join(root, 'absent'), cliRoot: frontend === 'cli' ? path.join(root, 'native') : path.join(root, 'absent') }
  return { ...f, root, cwd, opts, async cleanup() { f.close(); await fs.rm(root, { recursive: true, force: true }) } }
}

for (const frontend of /** @type {const} */ (['editor', 'cli'])) {
  test(`${frontend} reads committed WAL, preserves native identities and full outcomes, excludes private metadata`, async () => {
    const f = await fixture(frontend)
    try {
      // Fixture connection stays open: content exists in WAL, not just the db.
      assert.ok((await fs.stat(f.session.dbPath + '-wal')).size > 0)
      const before = await fs.readFile(f.session.dbPath)
      const session = await findCursorSession(f.session.id, f.cwd, f.opts)
      assert.ok(session)
      const snap = readCursorSession(session)
      const messages = snap.exchanges.flatMap((e) => e.messages)
      assert.equal(messages.length, 8)
      assert.equal(messages.filter((m) => m.content === 'Same text').length, 2)
      assert.equal(new Set(messages.map((m) => m.message_id)).size, 8)
      const tools = messages.filter((m) => m.role === 'tool').map((m) => /** @type {any} */ (m.content)[0])
      assert.deepEqual(tools.map((t) => t.name), ['Read', 'Grep', 'Glob', 'Shell', 'Shell'])
      assert.deepEqual(tools.map((t) => t.is_error), [false, false, false, true, true])
      assert.match(tools[0].content, /MARIGOLD-42/)
      assert.deepEqual(tools[0].input, { path: 'notes.txt' })
      assert.notEqual(tools[3].tool_use_id, tools[4].tool_use_id)
      assert.equal(JSON.stringify(snap).includes('PRIVATE'), false)
      assert.equal(snap.exchanges[0].entrypoint, frontend)
      assert.deepEqual(readCursorSession(session), snap)
      assert.equal(readCursorSession(session, snap.root).unchanged, true)
      assert.deepEqual(await fs.readFile(f.session.dbPath), before, 'read-only access does not rewrite database')
      assert.equal((await listCursorSessions(f.opts)).length, 1)
      assert.equal((await listCursorSessions(f.opts, { sinceMs: Date.now() + 10000 })).length, 0)
    } finally { await f.cleanup() }
  })
}

test('partial and incompatible native checkpoints fail explicitly instead of claiming conversation identities', async () => {
  const f = await fixture('editor')
  try {
    f.writeRoot(f.state, 'generating')
    assert.throws(() => readCursorSession(f.session), /native_in_progress/)
    f.writeRoot(Buffer.concat([f.state, wire([4, 'pending-call'])]))
    assert.throws(() => readCursorSession(f.session), /native_in_progress/)
    f.writeRoot(wire([8, Buffer.alloc(32)]))
    assert.throws(() => readCursorSession(f.session), /native_blob_missing_or_large/)
    f.writeRoot(f.state)
    const pointer = f.steps[0].toString('hex')
    f.db.prepare('UPDATE cursorDiskKV SET value=? WHERE key=?').run(Buffer.from('corruption'), 'agentKv:blob:' + pointer)
    assert.throws(() => readCursorSession(f.session), /native_blob_hash/)
    assert.throws(() => cursorFields(Buffer.from([0x0a, 0xff])), /native_truncated/)
    assert.throws(() => cursorFields(Buffer.alloc(1024 * 1024 + 1)), /native_record_limit/)
  } finally { await f.cleanup() }
})

test('CLI refuses unfinished assistant text, retains completed text without an end timestamp', async () => {
  const f = await fixture()
  try {
    const partial = f.put(wire([1, wire([1, 'partial text'], [2, 1789070400100])]))
    const turn = f.put(wire([1, wire([1, f.user], [2, partial], [3, 'native-generation'])]))
    f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turn]))
    assert.throws(() => readCursorSession(f.session), /native_in_progress/)
    f.writeRoot(f.state)
    assert.equal(readCursorSession(f.session).exchanges[0].messages.length, 8)
  } finally { await f.cleanup() }
})

test('only the exact suppression value drops a typed prompt, and it drops nothing else', async () => {
  const f = await fixture()
  const turnFor = (user) => f.put(wire([1, wire([1, user], ...f.steps.map((ref) => [2, ref]), [3, 'native-generation'])]))
  const userWith = (flag) => f.put(wire([1, 'Read and search notes.txt'], [2, 'native-user'], [25, 1789070400000], [5, flag]))
  try {
    f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turnFor(userWith(1))]))
    const suppressed = readCursorSession(f.session).exchanges[0].messages
    assert.equal(suppressed.length, 7)
    assert.equal(suppressed.some((m) => m.role === 'user'), false)
    // Any other value keeps the prompt, so an unrelated flag cannot silently
    // delete human speech while assistant and tool rows still land.
    for (const flag of [0, 2]) {
      f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turnFor(userWith(flag))]))
      const messages = readCursorSession(f.session).exchanges[0].messages
      assert.equal(messages.length, 8)
      assert.equal(messages[0].content, 'Read and search notes.txt')
    }
  } finally { await f.cleanup() }
})

test('archive/current overlap does not duplicate tools, and unknown tool outcomes stay unknown', async () => {
  const f = await fixture()
  try {
    const archive = f.put(wire(...f.refs.map((ref) => [1, ref])))
    f.writeRoot(Buffer.concat([f.state, wire([13, archive])]))
    assert.equal(readCursorSession(f.session).exchanges[0].messages.length, 8)
    const step = f.put(wire([2, wire([57, 'native-call-0'], [8, wire([2, wire([99, wire()])])])]))
    const turn = f.put(wire([1, wire([1, f.user], [2, step], [3, 'native-generation'])]))
    f.writeRoot(wire(...f.refs.map((ref) => [1, ref]), [8, turn]))
    const content = /** @type {any} */ (readCursorSession(f.session).exchanges[0].messages[1].content)
    assert.equal(content[0].is_error, null)
  } finally { await f.cleanup() }
})

test('discovery isolates a broken editor store so valid CLI history still recovers', async () => {
  const f = await fixture()
  try {
    const badDb = path.join(f.root, 'bad.db')
    await fs.writeFile(badDb, 'not sqlite PRIVATE')
    const errors = []
    const sessions = await listCursorSessions({ ...f.opts, editorDb: badDb, onError: (err) => errors.push(err.message) })
    assert.equal(sessions.length, 1)
    assert.ok(errors.length)
    assert.equal(JSON.stringify(errors).includes('PRIVATE'), false)
  } finally { await f.cleanup() }
})

test('native Read observes workspace, symlink and stricter policies; session ignore gates recovery', async () => {
  const f = await fixture()
  try {
    const ignoredSessions = new Set()
    const admission = cursorAdmission({ ignoredSessions })
    const exchange = readCursorSession(f.session).exchanges[0]
    assert.equal((await admission.filter(exchange))?.messages.length, 8)
    await fs.unlink(path.join(f.cwd, 'notes.txt'))
    await fs.writeFile(path.join(f.root, 'outside'), 'private')
    await fs.symlink(path.join(f.root, 'outside'), path.join(f.cwd, 'notes.txt'))
    assert.equal((await admission.filter(exchange))?.messages.length, 7)
    ignoredSessions.add(f.session.id)
    assert.equal(admission.session(f.session), false)
    assert.equal(await admission.filter(exchange), undefined)
  } finally { await f.cleanup() }
})

test('one refused file block refuses the whole message, whatever block follows it', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.root, 'outside.txt'), 'private')
    const block = (input, is_error) => ({ type: 'tool_result', name: 'Read', tool_use_id: String(Math.random()), input, content: 'text', is_error })
    const exchange = /** @type {any} */ ({ session_id: f.session.id, cwd: f.cwd, messages: [{ role: 'tool', content: [
      // Refused: resolves outside the workspace.
      block({ path: '../outside.txt' }, false),
      // A missing-file error is admissible on its own, and must not reinstate
      // the message the block before it refused.
      block({ path: 'missing.txt' }, true),
    ] }] })
    assert.equal((await cursorAdmission({}).filter(exchange))?.messages.length, 0)
  } finally { await f.cleanup() }
})

test('sweep fingerprints advance only after successful non-dry recovery and manual runs bypass them', async () => {
  const f = await fixture()
  try {
    const logs = []
    const provider = createCursorBackfillProvider(f.opts)
    const ctx = /** @type {any} */ ({ sweep: true, dryRun: false, env: {}, itemsFailed: 0, log: { info: (name) => logs.push(name), warn: (name) => logs.push(name) } })
    const collect = async () => { const items = []; for await (const item of provider.run(ctx)) items.push(item); return items }
    ctx.dryRun = true
    assert.equal((await collect()).length, 1)
    ctx.dryRun = false
    const failed = provider.run(ctx)[Symbol.asyncIterator]()
    await failed.next()
    ctx.itemsFailed++
    await failed.next()
    assert.equal((await collect()).length, 1)
    assert.equal((await collect()).length, 0)
    assert.ok(logs.includes('cursor.recovery.unchanged'))
    ctx.sweep = false
    assert.equal((await collect()).length, 1)
    assert.equal(createCursorBackfillProvider({ config: { backfill: { on_join: false } } }).sweep, undefined)
  } finally { await f.cleanup() }
})

test('Cursor CLI config paths honor its config variables independently of editor storage', () => {
  assert.equal(cursorStorePaths({ env: { HOME: '/home/user', CURSOR_CONFIG_DIR: '/custom' }, platform: 'linux' }).cliRoot, '/custom/chats')
  assert.equal(cursorStorePaths({ env: { HOME: '/home/user', XDG_CONFIG_HOME: '/config' }, platform: 'linux' }).cliRoot, '/config/cursor/chats')
})

test('historical windows select messages inside recently updated sessions and widening invalidates sweep shortcuts', async () => {
  const f = await fixture()
  try {
    const provider = createCursorBackfillProvider(f.opts)
    const ctx = /** @type {any} */ ({ sweep: true, dryRun: false, env: {}, log: { info() {}, warn() {} }, until: new Date(1789070400005).toISOString() })
    const collect = async () => { const items = []; for await (const item of provider.run(ctx)) if ('value' in item) items.push(item.value); return items }
    const first = await collect()
    assert.equal(first.length, 1, 'session update time does not hide earlier messages')
    assert.equal(first[0].messages.length, 2)
    assert.equal((await collect()).length, 0)
    delete ctx.until
    assert.equal((await collect())[0].messages.length, 8)
  } finally { await f.cleanup() }
})

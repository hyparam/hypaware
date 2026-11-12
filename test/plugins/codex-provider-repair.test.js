// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as zlib from 'node:zlib'
import test from 'node:test'
import { repairCodexProviders, restoreCodexProviders, validateCodexRepairRoute } from '../../hypaware-core/plugins-workspace/codex/src/provider_repair.js'

test('repair admits only the unchanged compatibility alias on the default native OpenAI route', () => {
  const alias = { name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true, supports_websockets: true, base_url: null, auth: null }
  const config = { model_provider: 'openai', model_providers: { hypaware: alias } }
  assert.doesNotThrow(() => validateCodexRepairRoute(config, null))
  const rejected = [
    { ...config, model_provider: 'custom' },
    { ...config, profile: 'private' },
    { ...config, experimental_thread_store: true },
    { ...config, openai_base_url: 'https://private.example' },
    { ...config, model_providers: { ...config.model_providers, openai: {} } },
    { ...config, model_providers: {} },
    ...[{ name: 'Customized alias' }, { base_url: 'http://127.0.0.1:4388' }, { env_key: 'PRIVATE_TOKEN' }, { auth: { command: 'custom' } }, { supports_websockets: false }].map(change => ({ ...config, model_providers: { hypaware: { ...alias, ...change } } })),
  ]
  for (const value of rejected) assert.throws(() => validateCodexRepairRoute(value, null), /custom routes and profiles/)
  assert.throws(() => validateCodexRepairRoute(config, { model_provider: 'managed-custom' }), /custom routes and profiles/)
})

async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-repair-')))
  const id = randomUUID()
  const file = path.join(home, 'sessions', '2026', `rollout-fixture-${id}.jsonl`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const config = '# Synthetic config must stay unchanged\n'
  await fs.writeFile(path.join(home, 'config.toml'), config)
  const header = JSON.stringify({ type: 'session_meta', payload: { id, model_provider: 'hypaware', cwd: home, timestamp: '2026-11-03T10:00:00Z' } })
  const suffix = '{ "type": "response_item", "payload": {"type":"message","role":"user","content":[{"type":"input_text","text":"Synthetic history"}]}}\r\n'
  const original = header + '\r\n' + suffix
  await fs.writeFile(file, original, { mode: 0o600 })
  const database = path.join(home, 'state_5.sqlite')
  const db = new DatabaseSync(database)
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, title TEXT, updated_at INTEGER)')
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, file, 'hypaware', 'Preserved title', 12345)
  const normalId = randomUUID()
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(normalId, '/unchanged', 'custom', 'Other provider', 45678)
  const rows = () => db.prepare('SELECT * FROM threads ORDER BY id').all().map(row => ({ ...row }))
  const before = rows()
  const options = { codexHome: home, assertStopped: async () => {} }
  return { home, id, normalId, file, original, suffix, db, database, before, rows, options,
    async cleanup() {
      db.close()
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

test('one-time repair preserves history and metadata, backs up WAL rows, is idempotent and restores', async () => {
  const f = await fixture()
  try {
    const dry = await repairCodexProviders({ ...f.options, dryRun: true })
    assert.equal(dry.repaired_threads, 1)
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
    await assert.rejects(fs.access(path.join(f.home, 'hypaware-provider-repair')))
    const result = await repairCodexProviders(f.options)
    assert.equal(result.repaired_threads, 1)
    assert.ok(result.backup_path)
    const repaired = await fs.readFile(f.file, 'utf8')
    assert.equal(JSON.parse(repaired.split('\n')[0]).payload.model_provider, 'openai')
    assert.equal(repaired.slice(repaired.indexOf('\n') + 1), f.suffix)
    // No POSIX mode bits on win32.
    if (process.platform !== 'win32') assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600)
    assert.deepEqual(f.rows(), f.before.map(row => row.id === f.id ? { ...row, model_provider: 'openai' } : row))
    assert.equal(await fs.readFile(path.join(f.home, 'config.toml'), 'utf8'), '# Synthetic config must stay unchanged\n')
    const manifest = JSON.parse(await fs.readFile(path.join(result.backup_path, 'manifest.json'), 'utf8'))
    assert.equal(manifest.status, 'complete')
    assert.equal(await fs.readFile(path.join(result.backup_path, '0.rollout'), 'utf8'), f.original)
    const backup = new DatabaseSync(path.join(result.backup_path, 'database-0.sqlite'), { readOnly: true })
    try { assert.deepEqual(backup.prepare('SELECT * FROM threads ORDER BY id').all().map(row => ({ ...row })), f.before) } finally { backup.close() }
    assert.equal((await repairCodexProviders(f.options)).repaired_threads, 0)
    assert.equal((await fs.readdir(path.dirname(result.backup_path))).length, 1)
    await restoreCodexProviders({ ...f.options, backupPath: result.backup_path })
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
    assert.deepEqual(f.rows(), f.before)
  } finally { await f.cleanup() }
})

test('an interrupted publish rolls back both the rollout and native metadata', async () => {
  const f = await fixture()
  try {
    await assert.rejects(repairCodexProviders({ ...f.options, async onStep() { throw new Error('injected publication failure') } }), /injected publication failure/)
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
    assert.deepEqual(f.rows(), f.before)
    const directory = path.join(f.home, 'hypaware-provider-repair')
    const [backup] = await fs.readdir(directory)
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, backup, 'manifest.json'), 'utf8')).status, 'rolled_back')
  } finally { await f.cleanup() }
})

test('restore refuses to overwrite conversation content appended after repair', async () => {
  const f = await fixture()
  try {
    const result = await repairCodexProviders(f.options)
    await fs.appendFile(f.file, '{"type":"event_msg","payload":{"type":"user_message","message":"New synthetic turn"}}\n')
    const changed = await fs.readFile(f.file, 'utf8')
    await assert.rejects(restoreCodexProviders({ ...f.options, backupPath: result.backup_path }), /chat changed since repair/)
    assert.equal(await fs.readFile(f.file, 'utf8'), changed)
    assert.equal(f.rows().find(row => row.id === f.id)?.model_provider, 'openai')
  } finally { await f.cleanup() }
})

test('repair refuses running clients and mismatched metadata before writing', async () => {
  const f = await fixture()
  try {
    await assert.rejects(repairCodexProviders({ ...f.options, async assertStopped() { throw new Error('Close Codex Desktop') } }), /Close Codex Desktop/)
    f.db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run('/outside/rollout.jsonl', f.id)
    await assert.rejects(repairCodexProviders(f.options), /outside this Codex home/)
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
    await assert.rejects(fs.access(path.join(f.home, 'hypaware-provider-repair')))
  } finally { await f.cleanup() }
})

test('a failure before publication removes its backup copies, so retries do not accumulate them', async () => {
  const f = await fixture()
  try {
    f.db.exec('BEGIN IMMEDIATE')
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(repairCodexProviders(f.options), /locked/)
    f.db.exec('ROLLBACK')
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
    assert.deepEqual(f.rows(), f.before)
    assert.deepEqual(await fs.readdir(path.join(f.home, 'hypaware-provider-repair')), [])
    assert.equal((await fs.readdir(path.dirname(f.file))).length, 1)
  } finally { await f.cleanup() }
})

test('rollouts without a session header are left alone instead of blocking repair', async () => {
  const f = await fixture()
  try {
    const strays = {
      'rollout-empty.jsonl': '',
      'rollout-legacy.jsonl': '{"id":"legacy","timestamp":"2025-01-01T00:00:00Z"}\n',
      'rollout-partial.jsonl': '{"type":"session_meta","payload":{"id":"cut',
      'rollout-turn.jsonl': '{"type":"turn_context","payload":{}}\n',
    }
    for (const [name, content] of Object.entries(strays)) await fs.writeFile(path.join(path.dirname(f.file), name), content)
    assert.equal((await repairCodexProviders(f.options)).repaired_threads, 1)
    for (const [name, content] of Object.entries(strays)) assert.equal(await fs.readFile(path.join(path.dirname(f.file), name), 'utf8'), content)
    assert.equal(f.rows().find(row => row.id === f.id)?.model_provider, 'openai')
  } finally { await f.cleanup() }
})

test('a metadata row whose rollout was deleted is left unchanged and counted instead of blocking repair', async () => {
  const f = await fixture()
  try {
    const goneId = randomUUID()
    const gone = path.join(f.home, 'sessions', '2025', `rollout-deleted-${goneId}.jsonl`)
    f.db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(goneId, gone, 'hypaware', 'Deleted chat', 1)
    const before = f.rows()
    assert.equal((await repairCodexProviders({ ...f.options, dryRun: true })).missing_rollouts, 1)
    const result = await repairCodexProviders(f.options)
    assert.equal(result.repaired_threads, 1)
    assert.equal(result.missing_rollouts, 1)
    assert.deepEqual(f.rows(), before.map(row => row.id === f.id ? { ...row, model_provider: 'openai' } : row))
    const manifest = JSON.parse(await fs.readFile(path.join(result.backup_path, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.databases[0].rows.map(row => row.id), [f.id])
    // Only the deleted chat is left: nothing to repair and no new backup.
    const again = await repairCodexProviders(f.options)
    assert.equal(again.repaired_threads, 0)
    assert.equal(again.missing_rollouts, 1)
    assert.equal((await fs.readdir(path.dirname(result.backup_path))).length, 1)
    await restoreCodexProviders({ ...f.options, backupPath: result.backup_path })
    assert.deepEqual(f.rows(), before)
    if (process.platform !== 'win32') {
      await fs.mkdir(path.dirname(gone), { recursive: true })
      await fs.symlink(path.join(f.home, 'nowhere.jsonl'), gone)
      // A dangling link is not a deleted chat and stays refused.
      await assert.rejects(repairCodexProviders(f.options), /Symlinked Codex/)
      assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
    }
  } finally { await f.cleanup() }
})

test('archived compressed rollouts preserve decompressed history and restore original compressed bytes', async () => {
  if (typeof zlib.zstdCompressSync !== 'function') return
  const f = await fixture()
  try {
    const archived = path.join(f.home, 'archived_sessions')
    await fs.mkdir(archived)
    const file = path.join(archived, `rollout-archived-${f.id}.jsonl.zst`)
    const original = zlib.zstdCompressSync(f.original)
    await fs.writeFile(file, original)
    await fs.rm(f.file)
    f.db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(file.slice(0, -4), f.id)
    const result = await repairCodexProviders(f.options)
    const decoded = zlib.zstdDecompressSync(await fs.readFile(file)).toString()
    assert.equal(JSON.parse(decoded.split('\n')[0]).payload.model_provider, 'openai')
    assert.equal(decoded.slice(decoded.indexOf('\n') + 1), f.suffix)
    await restoreCodexProviders({ ...f.options, backupPath: result.backup_path })
    assert.deepEqual(await fs.readFile(file), original)
  } finally { await f.cleanup() }
})

test('incomplete receipts require explicit restore before another repair, even if all providers were changed', async () => {
  const f = await fixture()
  try {
    const result = await repairCodexProviders(f.options)
    const file = path.join(result.backup_path, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    manifest.status = 'applying'
    await fs.writeFile(file, JSON.stringify(manifest))
    await assert.rejects(repairCodexProviders(f.options), /interrupted repair needs restoration/)
    await restoreCodexProviders({ ...f.options, backupPath: result.backup_path })
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
  } finally { await f.cleanup() }
})

test('a tampered backup is refused before any restored file or metadata is published', async () => {
  const f = await fixture()
  try {
    const result = await repairCodexProviders(f.options)
    await fs.appendFile(path.join(result.backup_path, '0.rollout'), 'tampered')
    const current = await fs.readFile(f.file, 'utf8')
    await assert.rejects(restoreCodexProviders({ ...f.options, backupPath: result.backup_path }), /backup was modified/)
    assert.equal(await fs.readFile(f.file, 'utf8'), current)
    assert.equal(f.rows().find(row => row.id === f.id)?.model_provider, 'openai')
  } finally { await f.cleanup() }
})

test('upgrade repair defers running clients, then repairs once across restarts and manual restore', async () => {
  const f = await fixture()
  try {
    const { createAutomaticCodexProviderRepair } = await import('../../hypaware-core/plugins-workspace/codex/src/provider_repair.js')
    const stateDir = path.join(f.home, 'hyp-state')
    let running = true
    let reads = 0
    const entries = []
    const log = { info: (name, fields) => entries.push({ name, ...fields }), warn: (name, fields) => entries.push({ name, ...fields }) }
    const options = { codexHome: f.home, stateDir, env: {}, cwd: f.home }
    const deps = {
      assertStopped: async () => { if (running) throw Object.assign(new Error('client is running'), { code: 'CODEX_RUNNING' }) },
      readConfig: async () => {
        reads++
        return { sqliteHome: f.home, configHash: createHash('sha256').update(await fs.readFile(path.join(f.home, 'config.toml'))).digest('hex') }
      },
    }
    const migrate = createAutomaticCodexProviderRepair(options, deps)
    await migrate(/** @type {any} */ (log))
    await migrate(/** @type {any} */ (log))
    assert.equal(reads, 0, 'a running client prevents config parsing and history discovery')
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
    assert.equal(entries.filter(row => row.reason === 'client_running').length, 1, 'unchanged deferral is logged once')
    running = false
    await migrate(/** @type {any} */ (log))
    const receipt = JSON.parse(await fs.readFile(path.join(stateDir, 'codex-provider-repair.json'), 'utf8'))
    assert.equal(receipt.status, 'complete')
    assert.equal(receipt.repaired_threads, 1)
    assert.equal(f.rows().find(row => row.id === f.id)?.model_provider, 'openai')
    await migrate(/** @type {any} */ (log))
    assert.equal(reads, 1)
    await restoreCodexProviders({ ...f.options, backupPath: receipt.backup_path })
    await createAutomaticCodexProviderRepair(options, deps)(/** @type {any} */ (log))
    assert.equal(reads, 1, 'the durable receipt skips native parsing after a restart')
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original, 'an explicit restore is not automatically undone')
    assert.equal(entries.filter(row => row.reason === 'complete').length, 1)
  } finally { await f.cleanup() }
})

test('an automatic route refusal changes nothing, avoids repeated attempts, and can recover after restart', async () => {
  const f = await fixture()
  try {
    const { createAutomaticCodexProviderRepair } = await import('../../hypaware-core/plugins-workspace/codex/src/provider_repair.js')
    let supported = false
    let reads = 0
    const entries = []
    const log = { info: (name, fields) => entries.push({ name, ...fields }), warn: (name, fields) => entries.push({ name, ...fields }) }
    const options = { codexHome: f.home, stateDir: path.join(f.home, 'hyp-state'), env: {}, cwd: f.home }
    const deps = {
      assertStopped: async () => {},
      readConfig: async () => {
        reads++
        if (!supported) validateCodexRepairRoute({ model_provider: 'custom' }, null)
        return { sqliteHome: f.home, configHash: createHash('sha256').update(await fs.readFile(path.join(f.home, 'config.toml'))).digest('hex') }
      },
    }
    const migrate = createAutomaticCodexProviderRepair(options, deps)
    await migrate(/** @type {any} */ (log))
    await migrate(/** @type {any} */ (log))
    assert.equal(reads, 1)
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
    await assert.rejects(fs.access(path.join(f.home, 'hyp-state', 'codex-provider-repair.json')))
    assert.equal(entries[0].status, 'failed')
    assert.ok(!JSON.stringify(entries).includes(f.home), 'automatic logs contain no customer paths or native error text')
    supported = true
    await migrate(/** @type {any} */ (log))
    assert.equal(reads, 1, 'a failed automatic attempt does not repeat expensive work')
    await createAutomaticCodexProviderRepair(options, deps)(/** @type {any} */ (log))
    assert.equal(reads, 2)
    assert.equal(f.rows().find(row => row.id === f.id)?.model_provider, 'openai')
  } finally { await f.cleanup() }
})

test('repair honors cancellation and an automatic backup budget before writing originals', async () => {
  const f = await fixture()
  try {
    await assert.rejects(repairCodexProviders({ ...f.options, maxBytes: 1 }), /automatic repair budget/)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(repairCodexProviders({ ...f.options, signal: controller.signal }), { name: 'AbortError' })
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
    assert.deepEqual(f.rows(), f.before)
    await assert.rejects(fs.access(path.join(f.home, 'hypaware-provider-repair')))
  } finally { await f.cleanup() }
})

test('cancellation after rollout publication rolls back history and native metadata', async () => {
  const f = await fixture()
  try {
    const controller = new AbortController()
    await assert.rejects(repairCodexProviders({ ...f.options, signal: controller.signal, onStep: async () => controller.abort() }), { name: 'AbortError' })
    assert.equal(await fs.readFile(f.file, 'utf8'), f.original)
    assert.deepEqual(f.rows(), f.before)
  } finally { await f.cleanup() }
})

test('an upgrade with no affected chats records completion without another backup', async () => {
  const f = await fixture()
  try {
    await repairCodexProviders(f.options)
    const { createAutomaticCodexProviderRepair } = await import('../../hypaware-core/plugins-workspace/codex/src/provider_repair.js')
    const stateDir = path.join(f.home, 'hyp-state')
    await createAutomaticCodexProviderRepair({ codexHome: f.home, stateDir, env: {}, cwd: f.home }, {
      assertStopped: async () => {},
      readConfig: async () => ({ sqliteHome: f.home, configHash: createHash('sha256').update(await fs.readFile(path.join(f.home, 'config.toml'))).digest('hex') }),
    })(/** @type {any} */ ({ info() {}, warn() {} }))
    const receipt = JSON.parse(await fs.readFile(path.join(stateDir, 'codex-provider-repair.json'), 'utf8'))
    assert.equal(receipt.status, 'complete')
    assert.equal(receipt.repaired_threads, 0)
    assert.equal((await fs.readdir(path.join(f.home, 'hypaware-provider-repair'))).length, 1)
  } finally { await f.cleanup() }
})

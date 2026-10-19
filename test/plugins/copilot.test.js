// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { copilotFixture } from '../../hypaware-core/smoke/fixtures/copilot.js'
import { attachCopilot, checkCompatibility, receiptPath } from '../../hypaware-core/plugins-workspace/copilot/src/attach.js'
import { dataRoots, discoverStores } from '../../hypaware-core/plugins-workspace/copilot/src/paths.js'
import { validateCopilotConfig } from '../../hypaware-core/plugins-workspace/copilot/src/config.js'
import { createCopilotBackfillProvider, writeGuards } from '../../hypaware-core/plugins-workspace/copilot/src/backfill.js'
import { createAdmission } from '../../hypaware-core/plugins-workspace/copilot/src/admission.js'
import { openDatabase, retainedSpans, readAttributes, sessionMetadata } from '../../hypaware-core/plugins-workspace/copilot/src/native.js'
import { projectSpan } from '../../hypaware-core/plugins-workspace/copilot/src/projector.js'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { parseSettings, editSetting } from '../../src/core/config/jsonc_settings.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'

const log = { info() {}, warn() {}, error() {}, debug() {} }
const descriptor = /** @type {any} */ ({ name: 'copilot', plugin: '@hypaware/copilot', attachProbe: { format: 'json', settings_file: '.copilot/hypaware.json', marker_key: '_hypaware' } })

/** @param {string} [harness] */
async function setup(harness = 'local') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-test-'))
  const root = path.join(home, 'Code')
  const cwd = path.join(home, 'project')
  const env = { HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_CONFIG: path.join(home, 'config.json'), COPILOT_HOME: path.join(home, '.copilot') }
  const config = { user_data_dirs: [root] }
  await fs.writeFile(env.HYP_CONFIG, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/copilot', config }] }))
  const fixture = await copilotFixture({ root, cwd, id: 'session-' + harness, harness })
  await attachCopilot({ env, config, version: '1' })
  const ignoredSessions = new SessionIgnoreSet(path.join(home, 'state'), log)
  const health = { stores: 0, selected: 0, read: 0, unchanged: 0, dropped: 0, incomplete: 0 }
  const opts = { env, config, ignoredSessions }
  const provider = createCopilotBackfillProvider(opts, health)
  /** @type {any} */
  const ctx = { env, config, log, sweep: true, dryRun: false, itemsFailed: 0 }
  /** @param {any} [runCtx] @param {boolean} [fail] */
  async function scan(runCtx = ctx, fail = false) {
    const items = []
    const events = []
    for await (const value of provider.run(runCtx)) {
      if ('type' in value) events.push(value)
      else {
        items.push(value)
        if (fail) runCtx.itemsFailed++
      }
    }
    return { items, events, rows: items.flatMap(item => aiGatewayRowsFromProjectedExchange(/** @type {any} */ (item.value))) }
  }
  return { ...fixture, home, root, cwd, env, opts, ctx, provider, scan, health, ignoredSessions, async cleanup() {
    fixture.close()
    await fs.rm(home, { recursive: true, force: true })
  } }
}

for (const harness of ['local', 'agent-host']) test(`${harness}: WAL source projection, repeated turns, per-response usage, unchanged reads and late parents`, async () => {
  const f = await setup(harness)
  try {
    assert.ok((await fs.stat(f.file + '-wal')).size > 0)
    const first = await f.scan()
    assert.equal(first.events.length, 0)
    assert.equal(first.rows.length, 6)
    assert.equal(first.rows.filter(r => r.role === 'user').length, 2)
    assert.equal(new Set(first.rows.map(r => r.part_id)).size, 6)
    const usage = first.rows.map(r => /** @type {any} */ (r.attributes)?.usage).filter(Boolean)
    assert.equal(usage.length, 2)
    assert.equal(usage.reduce((n, u) => n + u.input_tokens, 0), 30)
    assert.equal(usage.reduce((n, u) => n + u.output_tokens, 0), 6)
    assert.equal(usage.reduce((n, u) => n + u.cache_read_tokens, 0), 10)
    assert.ok(first.rows.some(r => r.tool_call_id === 'call-1' && r.part_type === 'tool_result' && r.content_text === 'fixture contents'))
    assert.ok(!JSON.stringify(first.rows).includes('duplicated model history'))
    assert.equal((await f.scan()).items.length, 0)
    assert.equal(f.health.read, 0)
    assert.equal(f.health.unchanged, 5)
    f.insert({ span_id: 'late-parent', operation_name: 'invoke_agent', start_time_ms: Date.now() - 100000, end_time_ms: Date.now() }, { 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'Late parent' }] }] })
    const late = await f.scan()
    assert.equal(late.rows.length, 1)
    assert.equal(late.rows[0].content_text, 'Late parent')
    const manual = await f.scan({ ...f.ctx, sweep: false })
    assert.equal(manual.rows.length, 7)
    const bounded = await f.scan({ ...f.ctx, sweep: false, since: new Date(Date.now() - 10000).toISOString() })
    assert.equal(bounded.rows.length, 6)
  } finally { await f.cleanup() }
})

test('attach and disk-only detach preserve JSONC, foreign destinations and user edits', async () => {
  const f = await setup()
  try {
    await detachClientFromDisk({ descriptor, env: f.env, homeDir: f.home })
    const file = path.join(f.root, 'User', 'settings.json')
    const original = '{ // Keep this comment\n "editor.fontSize": 14, "chat.agentHost.otel.captureContent": false, "chat.agentHost.otel.otlpEndpoint": "https://example.invalid/otel", "unrelated.setting": "kept",\n}\n'
    await fs.writeFile(file, original)
    const dry = await attachCopilot({ ...f.opts, version: '1', dryRun: true })
    assert.equal(dry.changed, true)
    assert.equal(await fs.readFile(file, 'utf8'), original)
    await attachCopilot({ ...f.opts, version: '1' })
    assert.equal((await attachCopilot({ ...f.opts, version: '1' })).changed, false)
    let raw = await fs.readFile(file, 'utf8')
    assert.ok(raw.includes('// Keep this comment'))
    assert.equal(parseSettings(raw).value['editor.fontSize'], 14)
    raw = editSetting(raw, 'github.copilot.chat.otel.dbSpanExporter.enabled', false)
    await fs.writeFile(file, raw)
    const result = await detachClientFromDisk({ descriptor, env: f.env, homeDir: f.home })
    const restored = parseSettings(await fs.readFile(file, 'utf8')).value
    assert.equal(restored['chat.agentHost.otel.captureContent'], false)
    assert.equal(restored['chat.agentHost.otel.otlpEndpoint'], 'https://example.invalid/otel')
    assert.equal(restored['github.copilot.chat.otel.dbSpanExporter.enabled'], false)
    assert.equal(restored['chat.agentHost.otel.dbSpanExporter.enabled'], undefined)
    assert.match(result.warning ?? '', /overridden externally/)
    assert.equal((await f.scan()).rows.length, 0)
  } finally { await f.cleanup() }
})

test('protocol/environment conflicts and malformed settings refuse before any write', async () => {
  const f = await setup()
  try {
    const file = path.join(f.root, 'User', 'settings.json')
    for (const protocol of ['grpc', 'http/grpc', 'http/protobuf']) {
      const raw = JSON.stringify({ 'chat.agentHost.otel.otlpEndpoint': 'https://example.invalid' })
      await fs.writeFile(file, raw)
      await assert.rejects(attachCopilot({ ...f.opts, env: { ...f.env, OTEL_EXPORTER_OTLP_PROTOCOL: protocol }, version: '2' }), /copilot_exporter_conflict/)
      assert.equal(await fs.readFile(file, 'utf8'), raw)
    }
    assert.throws(() => checkCompatibility({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false' }, {}), /environment_conflict/)
    for (const text of ['{"a": 1, "a": 2}', '{ // unfinished', '[1,2]']) assert.throws(() => parseSettings(text))
    await fs.writeFile(file, '{broken')
    await assert.rejects(attachCopilot({ ...f.opts, version: '2' }))
    assert.equal(await fs.readFile(file, 'utf8'), '{broken')
  } finally { await f.cleanup() }
})

test('privacy refresh, queued session exclusion, ignore, local-only, detach and missing consent', async () => {
  const f = await setup()
  try {
    const admission = createAdmission(f.opts)
    assert.equal(await admission.allowed('session-local', f.cwd), true)
    await fs.writeFile(path.join(f.cwd, '.hypignore'), 'ignore\n')
    assert.equal((await f.scan()).rows.length, 0)
    await fs.writeFile(path.join(f.cwd, '.hypignore'), 'local-only\n')
    assert.equal((await f.scan()).rows.length, 6)
    // Stop the provider while an item is queued, before its write guard.
    const iterator = f.provider.run({ ...f.ctx, sweep: false })[Symbol.asyncIterator]()
    const queued = await iterator.next()
    assert.ok(queued.value && !('type' in queued.value))
    f.ignoredSessions.add('session-local')
    assert.equal(await writeGuards.get(/** @type {any} */ (queued.value))?.(), false)
    await iterator.return?.()
    assert.equal((await f.scan()).rows.length, 0)
    f.ignoredSessions.delete('session-local')
    await fs.writeFile(f.env.HYP_CONFIG, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/copilot', recording: false }] }))
    assert.equal((await f.scan()).rows.length, 0)
    await fs.writeFile(f.env.HYP_CONFIG, 'invalid')
    assert.equal((await f.scan()).rows.length, 0)
    await fs.rm(receiptPath(f.env))
    assert.equal(await admission.allowed('session-local', f.cwd), false)
  } finally { await f.cleanup() }
})

test('failed consumption retries, malformed/oversized payloads are incomplete, model histories are never fetched', async () => {
  const f = await setup()
  try {
    await f.scan(f.ctx, true)
    assert.equal((await f.scan()).rows.length, 6)
    f.insert({ span_id: 'bad', operation_name: 'chat' }, { 'gen_ai.output.messages': '[truncated' })
    assert.ok((await f.scan()).events.some(e => e.event === 'copilot.recovery.incomplete'))
    f.insert({ span_id: 'bad', operation_name: 'chat' }, { 'gen_ai.output.messages': 'x'.repeat(4 * 1024 * 1024 + 1) })
    assert.ok((await f.scan()).events.some(e => e.attributes?.error_kind === 'span_content_limit'))
    f.db.prepare('DELETE FROM spans WHERE span_id = ?').run('bad')
    f.db.prepare('INSERT OR REPLACE INTO span_attributes VALUES (?, ?, ?)').run('chat-0', 'gen_ai.input.messages', 'x'.repeat(5 * 1024 * 1024))
    assert.equal((await f.scan({ ...f.ctx, sweep: false })).rows.length, 6)
    f.db.exec('UPDATE schema_version SET version = 2')
    assert.ok((await f.scan()).events.some(e => e.attributes?.error_kind === 'unsupported_schema'))
    const abort = new AbortController()
    abort.abort()
    assert.equal((await f.scan({ ...f.ctx, signal: abort.signal })).items.length, 0)
  } finally { await f.cleanup() }
})

test('unclaimed/multi-root/changed-directory metadata is withheld for both harnesses', async () => {
  for (const harness of ['local', 'agent-host']) {
    const f = await setup(harness)
    try {
      if (harness === 'local') {
        await fs.appendFile(f.sessionFile, JSON.stringify({ kind: 1, k: ['workingDirectory'], v: pathToFileURL(path.join(f.home, 'elsewhere')).href }) + '\n')
      } else f.metadata.exec("INSERT INTO turn_workspace_transition VALUES ('turn', '{}')")
      const run = await f.scan()
      assert.equal(run.rows.length, 0)
      assert.ok(run.events.some(e => e.attributes?.error_kind === 'ownership_cwd_changed'))
    } finally { await f.cleanup() }
  }
  assert.throws(() => sessionMetadata('{"kind":0,"v":{}}', true), /metadata_incomplete/)
  assert.equal(sessionMetadata('{"kind":0,"v":{"sessionId":"s"}}\n{"kind":3,"k":["sessionId"]}\n', true).id, undefined)
})

test('file tools cannot capture outside roots, symlink targets or stricter descendants', async () => {
  const f = await setup()
  try {
    const admission = createAdmission(f.opts)
    const outside = path.join(f.home, 'outside.txt')
    await fs.writeFile(outside, 'private')
    const link = path.join(f.cwd, 'link.txt')
    const targets = [outside]
    try {
      await fs.symlink(outside, link)
      targets.push(link)
    } catch (err) {
      // A stock Windows account can lack the symlink capability. The ordinary
      // out-of-root assertion still runs on that host.
      if (!['EPERM', 'ENOSYS'].includes(err.code)) throw err
    }
    for (const target of targets) {
      const exchange = { provider: 'unknown', session_id: 'session-local', cwd: f.cwd, messages: [{ role: 'tool', content: [{ type: 'tool_result', name: 'read_file', input: { filePath: target }, content: 'private' }] }] }
      assert.equal((await admission.filter(exchange))?.messages.length, 0)
    }
  } finally { await f.cleanup() }
})

test('paths and config cover relocated data, portable installs, profiles and reject invented options', async () => {
  assert.deepEqual(dataRoots({ HOME: '/home/p', XDG_CONFIG_HOME: '/xdg' }, {}, 'linux'), ['/xdg/Code', '/xdg/Code - Insiders'])
  assert.deepEqual(dataRoots({ VSCODE_PORTABLE: '/portable' }), ['/portable/user-data'])
  assert.equal(validateCopilotConfig({ user_data_dirs: ['/custom'], backfill: { sweep_cron: '* * * * *', window_days: 2 } }).ok, true)
  for (const config of [{ user_data_dirs: ['relative'] }, { made_up: true }, { backfill: { sweep_cron: 'no' } }]) assert.equal(validateCopilotConfig(config).ok, false)
  const f = await setup()
  try {
    const relocated = path.join(f.root, 'User', 'profiles', 'profile-1', 'globalStorage', 'github.copilot-chat')
    await fs.mkdir(path.dirname(relocated), { recursive: true })
    await fs.rename(path.dirname(f.file), relocated)
    assert.equal((await discoverStores(f.env, f.opts.config))[0].profile, path.join(f.root, 'User', 'profiles', 'profile-1'))
    assert.equal((await f.scan()).rows.length, 6)
  } finally { await f.cleanup() }
})

test('cancelled chat has one final accounting observation, no speculative partial identity', async () => {
  const f = await setup()
  try {
    const db = openDatabase(f.file)
    try {
      const span = retainedSpans(db).find(s => s.span_id === 'chat-0')
      assert.ok(span)
      const exchange = projectSpan({ ...span, status_code: 2 }, {}, 'session-local', f.cwd, 'local')
      const rows = aiGatewayRowsFromProjectedExchange(exchange)
      assert.equal(rows.length, 1)
      assert.equal(/** @type {any} */ (rows[0].attributes).usage.input_tokens, 15)
      assert.equal(/** @type {any} */ (rows[0].attributes).copilot.status_code, 2)
      assert.equal(readAttributes(db, span)['gen_ai.input.messages'], undefined)
    } finally { db.close() }
  } finally { await f.cleanup() }
})


test('database replacement/reset and retention reconcile retained identities without a timestamp cursor', async () => {
  const f = await setup()
  let replacement
  try {
    assert.equal((await f.scan()).rows.length, 6)
    f.close()
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(f.file + suffix, { force: true })
    replacement = await copilotFixture({ root: f.root, cwd: f.cwd, id: 'session-local', harness: 'local' })
    assert.equal((await f.scan()).rows.length, 6)
    replacement.db.exec('DELETE FROM spans; DELETE FROM span_attributes')
    assert.equal((await f.scan()).items.length, 0)
    replacement.insert({ span_id: 'post-reset', operation_name: 'chat', start_time_ms: Date.now() - 200000, input_tokens: 1, output_tokens: 2 }, { 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'Recovered after reset' }] }] })
    assert.equal((await f.scan()).rows.length, 1)
  } finally {
    replacement?.close()
    await f.cleanup()
  }
})

test('persistent exclusions fail closed after restart and metadata ambiguity cannot claim a session', async () => {
  const f = await setup()
  try {
    f.ignoredSessions.add('session-local')
    const restarted = new SessionIgnoreSet(path.join(f.home, 'state'), log)
    const admission = createAdmission({ ...f.opts, ignoredSessions: restarted })
    assert.equal(await admission.allowed('session-local', f.cwd), false)
    await fs.writeFile(path.join(restarted.directory, 'unexpected.json'), '{}')
    await assert.rejects(admission.allowed('other', f.cwd))
    await fs.rm(path.join(restarted.directory, 'unexpected.json'))
    f.ignoredSessions.delete('session-local')
    const workspace = path.dirname(path.dirname(f.sessionFile))
    await fs.writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({ workspace: pathToFileURL(path.join(f.home, 'project.code-workspace')).href }))
    const scan = await f.scan()
    assert.equal(scan.rows.length, 0)
    assert.ok(scan.events.some(e => e.attributes?.error_kind === 'ownership_multiroot'))
  } finally { await f.cleanup() }
})


test('candidate caps bound selection and report incomplete rather than claiming full coverage', async () => {
  const f = await setup()
  try {
    f.db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 16385)
      INSERT INTO spans (span_id, trace_id, name, start_time_ms, end_time_ms, status_code)
      SELECT 'cap-' || x, 'trace', 'chat', 1, 2, 1 FROM n`)
    const scan = await f.scan()
    assert.equal(scan.rows.length, 0)
    assert.ok(scan.events.some(e => e.attributes?.error_kind === 'span_count_limit'))
    assert.equal(f.health.read, 0)
  } finally { await f.cleanup() }
})

test('normalized-part budget advances only consumed spans and recovers the remainder next pass', async () => {
  const f = await setup()
  try {
    for (let i = 0; i < 5; i++) f.insert({ span_id: 'wide-' + i, operation_name: 'chat' }, {
      'gen_ai.output.messages': [{ role: 'assistant', parts: Array.from({ length: 2048 }, () => ({ type: 'text', content: 'bounded' })) }],
    })
    const first = await f.scan()
    assert.ok(first.rows.length <= 8192)
    assert.ok(first.events.some(e => e.attributes?.error_kind === 'run_part_count_limit'))
    const second = await f.scan()
    assert.equal(first.rows.length + second.rows.length, 6 + 5 * 2048)
    assert.equal((await f.scan()).rows.length, 0)
  } finally { await f.cleanup() }
})


test('Agent Host current cwd cannot relabel history without a matching initial SDK context', async () => {
  const f = await setup('agent-host')
  try {
    const other = path.join(f.home, 'moved')
    await fs.mkdir(other)
    f.metadata.prepare('UPDATE session_metadata SET value = ? WHERE key = ?').run(pathToFileURL(other).href, 'copilot.workingDirectory')
    f.metadata.prepare('UPDATE session_metadata SET value = ? WHERE key = ?').run(JSON.stringify([pathToFileURL(other).href]), 'copilot.workingDirectories')
    const scan = await f.scan()
    assert.equal(scan.rows.length, 0)
    assert.ok(scan.events.some(e => e.attributes?.error_kind === 'ownership_cwd_changed'))
    const events = path.join(f.env.COPILOT_HOME, 'session-state', 'session-agent-host', 'events.jsonl')
    await fs.writeFile(events, JSON.stringify({ type: 'session.start', data: {} }) + '\n')
    assert.ok((await f.scan()).events.some(e => e.attributes?.error_kind === 'ownership_initial_context_missing'))
  } finally { await f.cleanup() }
})

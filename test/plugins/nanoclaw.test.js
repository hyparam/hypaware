// @ts-check
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { createNanoclawBackfillProvider, writeGuards } from '../../hypaware-core/plugins-workspace/nanoclaw/src/backfill.js'
import { readGroups, discoverFiles, readTranscript, projectTranscript, MAX_FILE_BYTES } from '../../hypaware-core/plugins-workspace/nanoclaw/src/transcripts.js'
import { validateNanoclawConfig } from '../../hypaware-core/plugins-workspace/nanoclaw/src/config.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { readObservabilityEnv } from '../../src/core/observability/env.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'

const silent = { info() {}, warn() {}, debug() {}, error() {} }
const fixture = await fs.readFile(new URL('../../hypaware-core/smoke/fixtures/nanoclaw-session.jsonl', import.meta.url), 'utf8')

/** @param {any} t */
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-nanoclaw-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const group = { id: 'group-1', cwd: path.join(root, 'groups', 'test'), projects: path.join(root, 'data', 'v2-sessions', 'group-1', '.claude-shared', 'projects') }
  const file = path.join(group.projects, '-workspace-agent', 'session.jsonl')
  await fs.mkdir(group.cwd, { recursive: true })
  await fs.mkdir(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(path.join(root, 'data', 'v2.db'))
  db.exec("CREATE TABLE agent_groups (id TEXT, folder TEXT); INSERT INTO agent_groups VALUES ('group-1', 'test')")
  db.close()
  await fs.writeFile(file, fixture)
  const health = { groups: 0, files_read: 0, files_unchanged: 0, files_failed: 0, policy_drops: 0, deferred: false }
  const ignoredSessions = new SessionIgnoreSet(path.join(root, 'state'))
  const provider = createNanoclawBackfillProvider({ config: { root }, ignoredSessions }, health)
  return { root, file, group, health, provider, ignoredSessions }
}

/** @param {any} provider @param {any} [extra] */
async function collect(provider, extra = {}) {
  const items = []
  for await (const item of provider.run({ log: silent, env: {}, itemsFailed: 0, ...extra })) items.push(item)
  return items
}
/** @param {any[]} items */
function rows(items) { return items.filter(i => i.value).flatMap(i => aiGatewayRowsFromProjectedExchange(i.value)) }

test('NanoClaw uses native Claude tools, IDs and one usage carrier per API response', async t => {
  const { provider, group } = await setup(t)
  const result = rows(await collect(provider))
  assert.equal(result.length, 5)
  assert.ok(result.every(r => r.client_name === 'nanoclaw' && r.cwd === group.cwd))
  assert.deepEqual(result.map(r => r.message_id), ['nc-u1', 'nc-a1', 'nc-a2', 'nc-u2', 'nc-a3'])
  assert.deepEqual(result.map(r => r.message_index), [0, 1, 2, 3, 4])
  assert.ok(result.some(r => r.part_type === 'tool_result' && r.tool_call_id === 'nc-tool'))
  assert.equal(result.reduce((sum, r) => sum + Number(/** @type {any} */ (r.attributes)?.usage?.input_tokens ?? 0), 0), 6)
  assert.ok(result.every(r => /** @type {any} */ (r.attributes)?.nanoclaw?.agent_group_id === 'group-1'))
})

test('NanoClaw windows keep native positions; rotation preserves identity and subagent files are found', async t => {
  const { root, file, provider, group } = await setup(t)
  const before = rows(await collect(provider))
  const filtered = rows(await collect(provider, { since: '2026-10-21T10:00:03Z' }))
  assert.deepEqual(filtered.map(r => r.message_index), [3, 4])
  assert.deepEqual(filtered[0].previous_message_id, ['nc-a2'])
  await fs.rename(file, `${file}.rotated-123`)
  assert.deepEqual(rows(await collect(provider)).map(r => r.part_id), before.map(r => r.part_id))
  const sub = path.join(path.dirname(file), 'session', 'subagents', 'agent-1.jsonl')
  await fs.mkdir(path.dirname(sub), { recursive: true })
  await fs.writeFile(sub, fixture.split('\n').filter(Boolean).map(line => JSON.stringify({ ...JSON.parse(line), agentId: 'agent-1', isSidechain: true, uuid: `sub-${JSON.parse(line).uuid}` })).join('\n') + '\n')
  assert.equal((await discoverFiles(root, [group])).length, 2)
  assert.ok(rows(await collect(provider)).some(r => r.agent_id === 'agent-1'))
})

test('NanoClaw fingerprints skip unchanged files, but not dry runs, failed writes or unfinished appends', async t => {
  const { provider, file, health } = await setup(t)
  await collect(provider, { sweep: true, dryRun: true })
  assert.equal(rows(await collect(provider, { sweep: true })).length, 5)
  assert.equal(rows(await collect(provider, { sweep: true })).length, 0)
  assert.equal(health.files_unchanged, 1)
  const append = JSON.stringify({ type: 'user', uuid: 'new', sessionId: 'nc-session', timestamp: '2026-10-21T10:00:05Z', message: { role: 'user', content: 'More ☃' } })
  await fs.appendFile(file, append)
  await collect(provider, { sweep: true })
  assert.equal(health.deferred, true)
  await fs.appendFile(file, '\n')
  const ctx = { log: silent, env: {}, sweep: true, itemsFailed: 0 }
  for await (const item of provider.run(/** @type {any} */ (ctx))) if ('value' in item) ctx.itemsFailed++
  assert.equal(rows(await collect(provider, { sweep: true })).length, 6)
  assert.equal(rows(await collect(provider, { sweep: true })).length, 0)
})

test('NanoClaw maps host workspace ignore policy and persists session exclusions across providers', async t => {
  const { provider, group, root, ignoredSessions, health } = await setup(t)
  const ignore = path.join(group.cwd, '.hypignore')
  await fs.writeFile(ignore, 'ignore\n')
  assert.equal(rows(await collect(provider)).length, 0)
  assert.equal(health.files_read, 0)
  await fs.unlink(ignore)
  ignoredSessions.add('nc-session')
  assert.equal(rows(await collect(provider, { sweep: true })).length, 0)
  const second = createNanoclawBackfillProvider({ config: { root }, ignoredSessions: new SessionIgnoreSet(path.join(root, 'state')) }, health)
  assert.equal(rows(await collect(second)).length, 0)
  ignoredSessions.delete('nc-session')
  assert.equal(rows(await collect(provider, { sweep: true })).length, 5)
  const items = await collect(provider)
  await fs.writeFile(ignore, 'ignore\n')
  assert.equal(writeGuards.get(items[0])?.(), false)
  await fs.unlink(ignore)
  await fs.writeFile(path.join(root, 'state', 'session-ignores', 'bad.json'), 'broken')
  await assert.rejects(collect(provider), /capture unavailable/)
})

test('NanoClaw refuses unknown catalogs, path escapes, symlinks and oversized or malformed transcripts', async t => {
  const { root, file, group, provider, health } = await setup(t)
  const outside = path.join(root, 'outside.jsonl')
  await fs.writeFile(outside, fixture)
  await fs.unlink(file)
  await fs.symlink(outside, file)
  await assert.rejects(readTranscript(root, { file, group }), /unsafe_path/)
  assert.equal((await discoverFiles(root, [group])).length, 0)
  await fs.unlink(file)
  await fs.writeFile(file, '{malformed}\n')
  await collect(provider)
  assert.equal(health.files_failed, 1)
  await fs.truncate(file, MAX_FILE_BYTES + 1)
  await assert.rejects(readTranscript(root, { file, group }), /file_budget/)
  await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024 + 1))
  await assert.rejects(readTranscript(root, { file, group }), /line_budget/)
  const manyBlocks = { ...JSON.parse(fixture.split('\n')[0]), message: { role: 'user', content: Array.from({ length: 20001 }, () => ({ type: 'text', text: 'x' })) } }
  await fs.writeFile(file, JSON.stringify(manyBlocks) + '\n')
  await assert.rejects(readTranscript(root, { file, group }), /entry_budget/)
  const db = new DatabaseSync(path.join(root, 'data', 'v2.db'))
  db.exec("UPDATE agent_groups SET folder = '../escape'")
  db.close()
  await assert.rejects(readGroups(root), /unsupported_group/)
  await fs.unlink(path.join(root, 'data', 'v2.db'))
  await assert.rejects(collect(provider), /capture unavailable/)
})

test('NanoClaw config is explicit and automatic recovery honors opt-out', () => {
  assert.equal(validateNanoclawConfig({ root: '/tmp/nano', backfill: { on_join: false, window_days: 1 } }).ok, true)
  for (const config of [undefined, {}, { root: 'relative' }, { root: '/tmp/nano', other: true }]) assert.equal(validateNanoclawConfig(config).ok, false)
  const provider = createNanoclawBackfillProvider({ config: { root: '/tmp/nano', backfill: { on_join: false } } }, /** @type {any} */ ({}))
  assert.equal(provider.sweep, undefined)
})

test('NanoClaw waits for a boundary on legacy records without finalized response metadata', async t => {
  const { file, provider, health } = await setup(t)
  const records = fixture.trim().split('\n')
  await fs.writeFile(file, records.slice(0, 2).join('\n') + '\n')
  const first = rows(await collect(provider, { sweep: true }))
  assert.equal(first.length, 1)
  assert.equal(health.deferred, true)
  await fs.appendFile(file, records[2] + '\n')
  assert.equal(rows(await collect(provider, { sweep: true })).length, 1)
  await fs.appendFile(file, records.slice(3).join('\n') + '\n')
  const finished = rows(await collect(provider, { sweep: true }))
  const unique = new Map([...first, ...finished].map(row => [row.part_id, row]))
  assert.equal(unique.size, 5)
  assert.equal([...unique.values()].reduce((sum, row) => sum + Number(/** @type {any} */ (row.attributes)?.usage?.input_tokens ?? 0), 0), 6)
})

test('real NanoClaw subagent and crash tails capture finalized usage without a turn marker', async t => {
  const { root, file, group, health, provider } = await setup(t)
  // Actual SDK 0.3.296 / CLI 2.1.296 output, with a deterministic local model
  // and a real Read tool. Only chat records and their native fields retained.
  const native = await fs.readFile(new URL('../../hypaware-core/smoke/fixtures/nanoclaw-subagent.jsonl', import.meta.url), 'utf8')
  const records = native.trim().split('\n')
  const captured = new Map()
  // Simulate a sweep between the two finalized blocks of one API response.
  // Restart recovery after each append: no in-memory completion state needed.
  for (let end = 1; end <= records.length; end++) {
    await fs.writeFile(file, records.slice(0, end).join('\n') + '\n')
    const fresh = createNanoclawBackfillProvider({ config: { root } }, health)
    for (const row of rows(await collect(fresh))) if (!captured.has(row.part_id)) captured.set(row.part_id, row)
  }
  const result = [...captured.values()]
  assert.equal(result.length, 5)
  assert.equal(health.deferred, false)
  assert.ok(result.every(row => row.agent_id === 'aa1c14af41b6d836d' && row.cwd === group.cwd))
  assert.equal(result.reduce((sum, row) => sum + Number(/** @type {any} */ (row.attributes)?.usage?.input_tokens ?? 0), 0), 22)
  assert.equal(result.reduce((sum, row) => sum + Number(/** @type {any} */ (row.attributes)?.usage?.output_tokens ?? 0), 0), 14)
  assert.equal(rows(await collect(provider, { sweep: true })).length, 5)
  assert.equal(rows(await collect(provider, { sweep: true })).length, 0, 'completed subagents are fingerprinted instead of reread forever')
  // A crash after finalized tool blocks, before the tool result or cost-state,
  // preserves the response and its usage rather than deferring it forever.
  await fs.writeFile(file, records.slice(0, 3).join('\n') + '\n')
  const crashed = rows(await collect(provider))
  assert.equal(crashed.length, 3)
  assert.equal(health.deferred, false)
  assert.equal(crashed.reduce((sum, row) => sum + Number(/** @type {any} */ (row.attributes)?.usage?.input_tokens ?? 0), 0), 11)
})

test('NanoClaw scan budget makes progress through mixed-case paths and restarts recover all history', async t => {
  const { root, file, provider, health } = await setup(t)
  await fs.unlink(file)
  // Five valid 13 MiB files exceed one scan. Pending tails force rereads,
  // exposing cursor starvation even when earlier files never fingerprint.
  const names = ['a', 'b', 'c', 'd', 'Z']
  const filler = JSON.stringify({ type: 'attachment', padding: 'x'.repeat(1024 * 1024 - 100) }) + '\n'
  for (const name of names) {
    const user = JSON.stringify({ type: 'user', uuid: name, sessionId: name, timestamp: '2026-10-21T10:00:00Z', message: { role: 'user', content: name } }) + '\n'
    await fs.writeFile(path.join(path.dirname(file), `${name}.jsonl`), user + filler.repeat(13) + '{')
  }
  const seen = new Set()
  for (let i = 0; i < 3; i++) {
    for (const row of rows(await collect(provider, { sweep: true }))) seen.add(row.session_id)
    assert.equal(health.deferred, true)
    assert.ok(health.files_read <= 4)
  }
  assert.deepEqual([...seen].sort(), [...names].sort())
  // A fresh process ignores old process-local fingerprints and can reread.
  const fresh = createNanoclawBackfillProvider({ config: { root } }, health)
  assert.ok(rows(await collect(fresh, { sweep: true })).length > 0)
  assert.deepEqual(rows(await collect(fresh)).map(row => row.session_id).sort(), [...names].sort(),
    'explicit imports complete the discovered history instead of rereading the same budgeted prefix forever')
})

test('NanoClaw retries an append during a snapshot and recovers rotation during a read', async t => {
  const { file, provider, health } = await setup(t)
  const extra = JSON.stringify({ type: 'user', uuid: 'concurrent', sessionId: 'nc-session', timestamp: '2026-10-21T10:00:05Z', message: { role: 'user', content: 'Concurrent append' } }) + '\n'
  const open = fs.open.bind(fs)
  let mutation = 'append'
  // Pause at a real file read, then mutate the file before the consistency
  // check. No timing sleeps or probabilistic scheduling in this race test.
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args)
    if (args[0] !== file) return handle
    const read = handle.read.bind(handle)
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs)
      const action = mutation
      mutation = ''
      if (action === 'append') await fs.appendFile(file, extra)
      if (action === 'rotate') {
        await fs.rename(file, `${file}.rotated-456`)
        await fs.writeFile(file, extra)
      }
      return result
    }
    return handle
  })
  assert.equal(rows(await collect(provider, { sweep: true })).length, 0)
  assert.equal(health.files_failed, 1)
  const recovered = rows(await collect(provider, { sweep: true }))
  assert.equal(recovered.length, 6)
  assert.equal(health.files_failed, 0)
  mutation = 'rotate'
  // Manual recovery reads even when the scheduled fingerprint is unchanged.
  const duringRotation = rows(await collect(provider))
  const afterRotation = rows(await collect(provider, { sweep: true }))
  const unique = new Map([...recovered, ...duringRotation, ...afterRotation].map(row => [row.part_id, row]))
  assert.equal(unique.size, 6)
  assert.equal(health.files_failed, 0)
})

test('NanoClaw-only session controls persist exclusions through dispatch without a gateway', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-nanoclaw-cli-')))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const configPath = path.join(home, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false, plugins: [{ name: '@hypaware/nanoclaw', config: { root: path.join(home, 'nano') } }] }))
  const env = { ...isolatedClientEnv(process.env, home), HYP_HOME: home, HYP_CONFIG: configPath }
  /** @param {string[]} argv */
  const run = async argv => {
    let out = ''
    let err = ''
    const code = await dispatch(['session', ...argv], { env, stdout: { write: chunk => { out += chunk; return true } }, stderr: { write: chunk => { err += chunk; return true } } })
    return { code, out, err }
  }
  const ignored = await run(['ignore', 'native-1', '--json'])
  assert.equal(ignored.code, 0, ignored.err)
  assert.deepEqual(JSON.parse(ignored.out), { status: 'ok', session_id: 'native-1', ignored: true, guarantee: 'persisted_set_membership', earlier_rows: 'retained', recorder: 'nanoclaw' })
  const store = new SessionIgnoreSet(readObservabilityEnv(env).stateDir)
  store.refresh()
  assert.equal(store.has('native-1'), true)
  assert.equal((await run(['status', 'native-1'])).code, 0)
  assert.equal((await run(['unignore', 'native-1'])).code, 0)
  const status = await run(['status', 'native-1'])
  assert.equal(status.code, 1)
  assert.match(status.out, /eligible for NanoClaw recording/)
  const missing = await run(['ignore'])
  assert.equal(missing.code, 2)
  assert.match(missing.err, /NanoClaw session controls require an explicit native session ID/)
})

test('NanoClaw manifest requires the node:sqlite floor it imports', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../../hypaware-core/plugins-workspace/nanoclaw/hypaware.plugin.json', import.meta.url), 'utf8'))
  assert.equal(manifest.node_engine, '>=22.13')
})

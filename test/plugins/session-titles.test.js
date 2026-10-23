// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCodexBackfillProvider } from '../../hypaware-core/plugins-workspace/codex/src/backfill.js'
import { createClaudeBackfillProvider } from '../../hypaware-core/plugins-workspace/claude/src/backfill.js'
import { readCodexSessionTitles, readCodexTitleDatabase } from '../../hypaware-core/plugins-workspace/codex/src/session_titles.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { projectOpenCodeSnapshot } from '../../hypaware-core/plugins-workspace/opencode/src/projector.js'
import { projectCloudHistory } from '../../hypaware-core/plugins-workspace/codex-cloud/src/cloud.js'
import { aiGatewayRowsFromProjectedExchange, createAiGatewayConversationState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { captureSessionTitle } from '../../src/core/backfill/session_title.js'

const at = '2026-10-20T10:00:00.000Z'

/** @param {any} provider */
async function scan(provider) {
  const logs = []
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (/** @type {string} */ event, /** @type {any} */ fields) => logs.push({ event, fields })]))
  const ctx = /** @type {any} */ ({ env: {}, dryRun: false, sweep: true, log, storage: {}, cacheRoot: '/unused' })
  const rows = []
  for await (const item of provider.run(ctx)) {
    if (item.type !== 'event') rows.push(...await aiGatewayBackfillMaterializer().materialize(item, ctx))
  }
  return { rows, logs }
}

/** @param {any[]} rows */
function metadata(rows) { return rows.filter(row => row.part_type === 'session_metadata') }

test('Codex captures a late title and renames without any rollout change; unchanged scans stay cheap', async t => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-titles-codex-'))
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }))
  const root = path.join(homeDir, '.codex')
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true })
  const file = path.join(root, 'sessions', 'rollout-title.jsonl')
  await fs.writeFile(file, [
    { type: 'session_meta', payload: { id: 'thread-1', cwd: '/work/repo', timestamp: at } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  const provider = createCodexBackfillProvider({ homeDir })
  assert.equal(metadata((await scan(provider)).rows).length, 0)
  const identities = []
  for (const [index, title] of ['Zulu', 'Alpha', 'Zulu'].entries()) {
    await fs.appendFile(path.join(root, 'session_index.jsonl'), JSON.stringify({
      id: 'thread-1', thread_name: title, updated_at: `2026-10-2${index + 1}T10:00:00Z`,
    }) + '\n')
    const { rows, logs } = await scan(provider)
    const [update] = metadata(rows)
    assert.equal(update.attributes.session.title, title)
    assert.equal(update.message_created_at, at, 'renaming does not change activity')
    assert.equal(rows.filter(row => row.part_type !== 'session_metadata').length, 1)
    identities.push(update.part_id)
    assert.equal(logs.some(row => row.fields?.title_captured === true), true)
    const unchanged = await scan(provider)
    assert.equal(unchanged.rows.length, 0)
    assert.equal(unchanged.logs.find(row => row.event === 'codex.backfill.scan_complete')?.fields.files_read, 0)
  }
  assert.equal(new Set(identities).size, 3, 'renaming back to an earlier title is a new revision')
  assert.equal((await fs.stat(file)).size > 0, true)
})

test('Claude preserves generated names, prefers explicit renames, and retries stable native revisions', async t => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-titles-claude-'))
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }))
  const root = path.join(homeDir, '.claude', 'projects', 'repo')
  await fs.mkdir(root, { recursive: true })
  const file = path.join(root, 'session-1.jsonl')
  await fs.writeFile(file, JSON.stringify({ sessionId: 'session-1', uuid: 'msg-1', cwd: '/work/repo',
    type: 'user', timestamp: at, message: { role: 'user', content: 'hello' } }) + '\n')
  const provider = createClaudeBackfillProvider({ homeDir, stateFile: path.join(homeDir, 'context.jsonl'), deriveRepo: async () => ({}) })
  assert.equal(metadata((await scan(provider)).rows).length, 0)
  const identities = []
  for (const [index, title] of ['Generated', 'Renamed', 'Generated'].entries()) {
    await fs.appendFile(file, JSON.stringify(index === 0
      ? { type: 'ai-title', aiTitle: title, sessionId: 'session-1' }
      : { type: 'custom-title', customTitle: title, sessionId: 'session-1' }) + '\n')
    // Native title records have no timestamp; make the observation time explicit.
    const time = new Date(`2026-10-2${index + 1}T10:00:00Z`)
    await fs.utimes(file, time, time)
    const { rows } = await scan(provider)
    const [update] = metadata(rows)
    assert.equal(update.attributes.session.title, title)
    assert.equal(update.message_created_at, at)
    identities.push(update.part_id)
  }
  await fs.appendFile(file, JSON.stringify({ type: 'ai-title', aiTitle: 'Background replacement', sessionId: 'session-1' }) + '\n')
  const [preserved] = metadata((await scan(provider)).rows)
  assert.equal(preserved.attributes.session.title, 'Generated', 'a generated title cannot overwrite a custom name')
  assert.equal(preserved.part_id, identities.at(-1), 'same native title revision deduplicates on replay')
  assert.equal(new Set(identities).size, 3)
})

test('title index rejects oversized metadata and ignores malformed, incomplete, or older revisions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-title-index-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'session_index.jsonl')
  await fs.writeFile(file, [
    '{broken',
    JSON.stringify({ id: 'one', thread_name: 'Current', updated_at: '2026-10-22T00:00:00Z' }),
    JSON.stringify({ id: 'one', thread_name: 'Stale', updated_at: '2026-10-21T00:00:00Z' }),
    JSON.stringify({ id: 'two', thread_name: 'Incomplete', updated_at: '2026-10-23T00:00:00Z' }),
  ].join('\n'))
  const names = await readCodexSessionTitles(file)
  assert.equal(names.get('one')?.title, 'Current')
  assert.equal(names.has('two'), false)
  await fs.truncate(file, 8 * 1024 * 1024 + 1)
  await assert.rejects(readCodexSessionTitles(file), /title_index_budget/)
})

test('OpenCode and Codex cloud names use the same durable title contract', () => {
  const open = projectOpenCodeSnapshot({ info: { id: 'open-1', directory: '/repo', title: 'OpenCode name',
    time: { created: Date.parse(at), updated: Date.parse(at) + 1000 } },
  messages: [{ info: { id: 'message-1', role: 'user', time: { created: Date.parse(at) } }, parts: [{ id: 'part-1', type: 'text', text: 'hello' }] }] })
  assert.equal((/** @type {any} */ (open?.messages.at(-1)?.attributes?.session))?.title, 'OpenCode name')
  assert.equal((/** @type {any} */ (open?.messages.at(-1)?.content))[0].type, 'session_metadata')
  const cloud = projectCloudHistory({ thread: { id: 'cloud-1', name: 'Cloud name', originator: 'codex_cloud',
    createdAt: Date.parse(at) / 1000, updatedAt: Date.parse(at) / 1000 + 1 },
  items: [{ completedAtMs: Date.parse(at), item: { id: 'cloud-message-1', type: 'agentMessage', text: 'done' } }] })
  assert.equal((/** @type {any} */ (cloud.exchange.messages.at(-1)?.attributes?.session))?.title, 'Cloud name')
  const rows = aiGatewayRowsFromProjectedExchange(cloud.exchange, /** @type {any} */ ({ gatewayId: 'test', tsStart: at }))
  assert.equal(metadata(rows).length, 1)
})

test('Codex Desktop-only generated names are read from name without recording prompt previews', async t => {
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch { t.skip('node:sqlite unavailable'); return }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-title-db-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const file = path.join(home, 'state_9.sqlite')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, updated_at INTEGER, updated_at_ms INTEGER)')
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run('desktop-1', 'Generated desktop name', 'Private opening prompt', 1, Date.parse(at))
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run('unnamed', null, 'Another private prompt', 1, Date.parse(at))
  db.close()
  const before = await fs.readFile(file)
  const names = await readCodexTitleDatabase(home)
  assert.deepEqual([...names], [['desktop-1', { title: 'Generated desktop name', updatedAt: at }]])
  assert.deepEqual(await fs.readFile(file), before, 'the source database stays read-only')
})

test('metadata never joins the predecessor chain or replicates heavy context', () => {
  const state = createAiGatewayConversationState()
  const exchange = { provider: 'openai', session_id: 'one', client_name: 'codex', model: 'model',
    system_text: 'large system context', tools: [{ name: 'tool' }],
    messages: [{ role: 'user', message_id: 'first', content: 'hello', message_created_at: at }] }
  assert.equal(captureSessionTitle(exchange, 'A name', { updatedAt: at }), true)
  const first = aiGatewayRowsFromProjectedExchange(exchange, { state })
  assert.equal((/** @type {any} */ (first[0].attributes))?.session, undefined, 'native titles are stored once, not repeated on every content part')
  const [update] = metadata(first)
  assert.equal(update.system_text, undefined)
  assert.equal(update.tools, undefined)
  assert.equal(update.model, undefined)
  const [next] = aiGatewayRowsFromProjectedExchange({ provider: 'openai', session_id: 'one',
    messages: [{ role: 'user', message_id: 'next', content: 'again' }] }, { state })
  assert.deepEqual(next.previous_message_id, ['first'])
  assert.equal(aiGatewayRowsFromProjectedExchange(exchange, { state }).length, 0)
})

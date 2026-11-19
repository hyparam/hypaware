// @ts-check

// The usage-by-task scripts run against a seeded cache, the way a started
// client runs them: one session per lane and day, Codex ids that share a
// prefix, an approval-review turn, and a page rendered from a hostile digest.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { aiGatewayDatasetRegistration, AI_GATEWAY_SCHEMA_COLUMNS } from '../../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { appendRowsToSourceTable } from '../../../src/core/cache/partition.js'
import { cacheRootOf, stateRootOf } from '../../../src/core/runtime/paths.js'

/** @import { TestContext } from 'node:test' */

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CHAT = path.join(ROOT, 'hypaware-core', 'usage', 'hypaware-usage-by-task', 'scripts')
const PAGE = path.join(ROOT, 'hypaware-core', 'usage', 'hypaware-usage-by-task-page', 'scripts')

const A = 'aaaa1111-0000-4000-8000-000000000001' // Claude Code on both lanes on the 18th, proxy only on the 17th and 19th
const B = 'bbbb2222-0000-4000-8000-000000000002' // transcript lane only
const C1 = '019a1b2c-3d4e-7000-8000-000000000001' // Codex: shares its first 19 characters with C2
const C2 = '019a1b2c-3d4e-7000-8000-000000000002'
const D = 'dddd4444-0000-4000-8000-000000000004' // transcript on the 17th and 18th, proxy attached on the 18th

/** @param {TestContext} t */
async function seededHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-usage-scripts-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const hypHome = path.join(root, '.hyp')
  await fs.mkdir(hypHome, { recursive: true })
  await fs.writeFile(path.join(hypHome, 'hypaware-config.json'), JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/ai-gateway' }] }))
  const empty = Object.fromEntries(AI_GATEWAY_SCHEMA_COLUMNS.map((c) => [c.name, null]))
  let seq = 0
  /**
   * @param {Record<string, any>} o
   * @returns {Record<string, any>}
   */
  const row = (o) => {
    seq++
    const at = Date.parse(o.at)
    const { at: iso, ...rest } = o
    return {
      ...empty, gateway_id: 'gw', provider: 'anthropic', client_name: 'test', message_id: `m${seq}`, part_id: `m${seq}#0`,
      message_created_at: at, conversation_started_at: at, schema_version: 8, message_index: seq, part_index: 0,
      date: iso.slice(0, 10), is_sidechain: false, role: 'assistant', part_type: 'text', content_text: 'ok', model: 'claude-x', ...rest,
    }
  }
  /** @param {number} out */
  const usage = (out) => ({ usage: { input_tokens: 10, output_tokens: out, cache_read_tokens: 5, cache_write_tokens: 1 } })
  const human = { claude: { origin: { kind: 'human' } } }
  const typed = { codex: { content_item_kinds: '["user.text"]' } }
  const rows = [
    row({ session_id: A, conversation_source: 'claude_code', at: '2026-11-18T10:00:00Z', attributes: usage(100) }),
    row({ session_id: A, conversation_source: 'claude_code', at: '2026-11-18T10:01:00Z', attributes: usage(100) }),
    row({ session_id: A, conversation_source: 'claude', at: '2026-11-18T10:02:00Z', attributes: usage(150) }),
    row({ session_id: A, conversation_source: 'claude_code', at: '2026-11-17T10:00:00Z', attributes: usage(7) }),
    row({ session_id: A, conversation_source: 'claude_code', at: '2026-11-19T10:00:00Z', attributes: usage(9) }),
    row({ session_id: A, conversation_source: 'claude_code', role: 'user', content_text: 'A typed via proxy', at: '2026-11-18T09:00:00Z', attributes: human }),
    row({ session_id: A, conversation_source: 'claude', role: 'user', content_text: 'A typed via transcript', at: '2026-11-18T09:00:01Z', attributes: human }),
    row({ session_id: B, conversation_source: 'claude', at: '2026-11-18T11:00:00Z', attributes: usage(40) }),
    row({ session_id: D, conversation_source: 'claude', at: '2026-11-17T08:00:00Z', attributes: usage(30) }),
    row({ session_id: D, conversation_source: 'claude', at: '2026-11-18T08:00:00Z', attributes: usage(30) }),
    row({ session_id: D, conversation_source: 'claude_code', at: '2026-11-18T08:05:00Z', attributes: usage(31) }),
    row({ session_id: D, conversation_source: 'claude_code', at: '2026-11-18T08:06:00Z', attributes: usage(31) }),
  ]
  for (const [sid, out] of /** @type {const} */ ([[C1, 300], [C2, 50]])) {
    rows.push(row({ session_id: sid, provider: 'openai', conversation_source: 'codex', model: 'gpt-5', at: '2026-11-18T12:00:00Z', attributes: usage(out) }))
    rows.push(row({ session_id: sid, provider: 'openai', conversation_source: 'codex', model: 'gpt-5', role: 'user', content_text: `typed in ${sid.slice(-1)}`, at: '2026-11-18T11:59:00Z', attributes: typed }))
  }
  rows.push(row({ session_id: C1, provider: 'openai', conversation_source: 'codex', model: 'codex-auto-review', role: 'user', content_text: 'APPROVAL REVIEW', at: '2026-11-18T12:01:00Z', attributes: typed }))
  const cacheRoot = cacheRootOf(stateRootOf(hypHome))
  const declaration = aiGatewayDatasetRegistration().cachePartitioning
  /** @type {Map<string, any[]>} */ const bySource = new Map()
  for (const r of rows) bySource.set(r.conversation_source, [...(bySource.get(r.conversation_source) ?? []), r])
  for (const [source, batch] of bySource) {
    await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', [`source=${source}`], AI_GATEWAY_SCHEMA_COLUMNS, batch, { declaration })
  }
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HOME: root, HYP_HOME: hypHome }
  delete env.CODEX_HOME
  return { root, env }
}

/**
 * @param {string} script
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
const node = (script, args, env) => run(process.execPath, [script, ...args], { env, maxBuffer: 1 << 24 })

/**
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {string} from
 * @param {string} to
 */
async function digest(root, env, from, to) {
  const out = path.join(root, `digest-${from}-${to}.json`)
  await node(path.join(CHAT, 'digest.mjs'), ['--no-gh', '--prs', 'none', '--from', from, '--to', to, '--out', out], env)
  return JSON.parse(await fs.readFile(out, 'utf8'))
}

test('the digest counts each session once per day, from the lane with more output that day', async (t) => {
  const { root, env } = await seededHome(t)
  const d = await digest(root, env, '2026-11-17', '2026-11-19')
  // a slice id shortens the session id to its shortest unique prefix, so key by the full one
  const slices = Object.fromEntries(d.slices.map((/** @type {any} */ s) => [`${s.session_id}|${s.date}`, s]))
  // both lanes on the 18th: the proxy's 200, not the transcript's 150 and not both
  assert.equal(slices[`${A}|2026-11-18`].tokens.output, 200)
  assert.deepEqual(slices[`${A}|2026-11-18`].prompts, ['A typed via proxy'])
  assert.equal(slices[`${B}|2026-11-18`].tokens.output, 40)
  // the proxy wins the 18th, but the 17th was recorded only by the transcript lane and still counts
  assert.equal(slices[`${D}|2026-11-18`].tokens.output, 62)
  assert.equal(slices[`${D}|2026-11-17`].tokens.output, 30)
  // Codex ids that share a prefix stay two sessions, and the approval reviewer's turn is nobody's prompt
  assert.equal(slices[`${C1}|2026-11-18`].tokens.output, 300)
  assert.equal(slices[`${C2}|2026-11-18`].tokens.output, 50)
  assert.deepEqual(slices[`${C1}|2026-11-18`].prompts, ['typed in 1'])
  assert.equal(d.slices.length, 8)
})

test('a one-day window reads that day only, and a window that is not two dates is refused', async (t) => {
  const { root, env } = await seededHome(t)
  const d = await digest(root, env, '2026-11-19', '2026-11-19')
  assert.deepEqual(d.slices.map((/** @type {any} */ s) => `${s.session_id}|${s.date}`), [`${A}|2026-11-19`])
  for (const bad of ["2026-11-19' OR '1'='1", '2026-13-40', 'yesterday']) {
    await assert.rejects(node(path.join(CHAT, 'digest.mjs'), ['--no-gh', '--to', bad, '--out', path.join(root, 'never.json')], env), (/** @type {any} */ e) => {
      assert.equal(e.code, 2)
      assert.match(e.stderr, /--to must be a date written YYYY-MM-DD/)
      return true
    })
  }
  await assert.rejects(fs.access(path.join(root, 'never.json')))
})

test('the page escapes every digest field and links PRs over https only', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-usage-page-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const X = '</script><script>alert(1)</script>"\'><img src=x onerror=alert(2)>'
  /** @param {string} id @param {string} url */
  const pr = (id, url) => ({ id, repo: 'o/r', number: Number(id.split('#')[1]), author: 'me', title: `title ${X}`, state: 'OPEN', createdAt: '2026-11-18T10:05:00Z', url, claimed_by_rule: true })
  const prs = { 'o/r#1': pr('o/r#1', 'javascript:alert(3)//'), 'o/r#2': pr('o/r#2', 'data:text/html,alert(4)') }
  /** @param {string} id @param {string} client @param {Record<string, any>} extra */
  const slice = (id, client, extra) => ({
    id, session_id: id.split('|')[0], date: `2026-11-18${X}`, client, models: { [`m${X}`]: 100 }, repos: [], branches: [],
    first_at: '2026-11-18T10:00:00Z', last_at: '2026-11-18T11:00:00Z', msgs: 3, tokens: { input: 1, output: 100, cache_read: 1, cache_write: 1 },
    prompts: [`prompt ${X}`], last_prompt: null, tools: {}, prs_seen: [], prs_rule: [], prs_graph: [], ...extra,
  })
  for (const mode of ['repo', 'pr']) {
    const ids = Object.keys(prs)
    const opened = mode === 'repo' ? { prs_rule: ids } : { prs_seen: ids.map((p) => ({ pr: p, minutes_after_created: 30 })) }
    const digestFile = path.join(root, `${mode}.json`)
    await fs.writeFile(digestFile, JSON.stringify({
      window: { from: '2026-11-18', to: '2026-11-18' }, remote: null, org: null, pr_source: 'gh', generated_at: `2026-11-19${X}`, attrib_window_min: X,
      totals: { sessions: 2, slices: 2, msgs: 6, tokens: { input: 2, output: 200, cache_read: 2, cache_write: 2 } },
      prs: structuredClone(prs), slices: [slice('aaaa|2026-11-18', 'Claude Code', opened), slice('bbbb|2026-11-18', `Codex${X}`, {})],
    }))
    const out = path.join(root, 'pages', `${mode}.html`)
    await node(path.join(PAGE, 'render.mjs'), ['--digest', digestFile, '--out', out], { ...process.env })
    const page = await fs.readFile(out, 'utf8')
    assert.doesNotMatch(page, /<script>alert/, mode)
    assert.doesNotMatch(page, /<img src=x/, mode)
    assert.doesNotMatch(page, /javascript:|data:text/, mode)
    if (process.platform !== 'win32') assert.equal((await fs.stat(out)).mode & 0o777, 0o600)
  }
})

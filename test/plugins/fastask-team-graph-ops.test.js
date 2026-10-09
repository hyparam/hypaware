// @ts-check

// The agent-callable team-graph operations' pure parts (LLP 0481 T15,
// LLP 0487#decision): discover with explicit terms and paging, the one-hop
// neighbors walk over the index's adjacency, and the per-session search
// fan-out over query_sql. The commands and their sources are tested in
// fastask-team-graph-commands.test.js.

import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_POSTINGS, MAX_STARTS, MAX_VISITS, SEED_MAX_FILES, discover, explicitTerms, neighbors } from '../../hypaware-core/plugins-workspace/fastask/src/discovery.js'
import { createIndexBuilder, splitTokens } from '../../hypaware-core/plugins-workspace/fastask/src/index_builder.js'
import { MAX_SEARCH_SESSIONS, SEARCH_CONCURRENCY, searchSessions, sessionSql } from '../../hypaware-core/plugins-workspace/fastask/src/team_search.js'

/**
 * @import { GraphIndex } from '../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

const T0 = Date.UTC(2026, 8, 1)
const DAY = 86_400_000

/**
 * Sessions s0..s(n-1) each touched acme/app:src/login.js on day i; s0 also
 * touched src/poll.js and used the Tool Bash; one touch comes from a session
 * the node file lacks.
 *
 * @param {number} n
 * @returns {Promise<GraphIndex>}
 */
async function graph(n) {
  const b = createIndexBuilder()
  b.addNode({ node_id: 'f-login', node_type: 'File', natural_key: 'acme/app:src/login.js' })
  b.addNode({ node_id: 'f-poll', node_type: 'File', natural_key: 'acme/app:src/poll.js' })
  b.addNode({ node_id: 't-bash', node_type: 'Tool', natural_key: 'Bash' })
  for (let i = 0; i < n; i++) {
    b.addNode({ node_id: `s${i}`, node_type: 'Session', natural_key: `sess-${i}`, first_seen: T0, props: { cwd: '/w', git_branch: 'main', client_name: 'claude-code', user_id: `u${i % 3}` } })
    b.addEdge({ edge_type: 'touched', src_id: `s${i}`, dst_id: 'f-login', src_type: 'Session', dst_type: 'File', first_seen: T0 + i * DAY, source_keys: { session_id: `sess-${i}`, message_id: `m-${i}` } })
  }
  b.addEdge({ edge_type: 'touched', src_id: 's0', dst_id: 'f-poll', src_type: 'Session', dst_type: 'File', first_seen: T0 })
  b.addEdge({ edge_type: 'used', src_id: 's0', dst_id: 't-bash', src_type: 'Session', dst_type: 'Tool', first_seen: T0 })
  b.addEdge({ edge_type: 'touched', src_id: 'gone', dst_id: 'f-login', src_type: 'Session', dst_type: 'File', first_seen: T0 - DAY })
  return b.finish()
}

test('explicit terms are used as written: no splitting, no stopwords, deduplicated, at most 12', () => {
  assert.deepEqual(explicitTerms(['  parseRetryAfter ', 'the', 'src/login.js', 'PARSERETRYAFTER', '', 'work_budget']), [
    { text: 'parseRetryAfter', kind: 'word' },
    { text: 'the', kind: 'word' },
    { text: 'src/login.js', kind: 'path' },
    { text: 'work_budget', kind: 'word' },
  ])
  assert.equal(explicitTerms(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 12)
})

test('discover takes explicit terms and pages through the ranked sessions without gaps or repeats', async () => {
  const index = await graph(25)
  const first = discover(index, { question: '', terms: ['login'], leads: 10 })
  assert.deepEqual(first.terms, [{ text: 'login', kind: 'word' }])
  assert.equal(first.anchors[0].node_id, 'f-login')
  assert.deepEqual(first.page, { offset: 0, limit: 10, next_offset: 10 })
  assert.deepEqual(first.leads.map((l) => l.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(first.leads[0].session_id, 'sess-24', 'newest touch first')
  assert.equal(first.leads[0].node_id, 's24')
  assert.equal(first.leads[0].why[0].anchor.node_id, 'f-login')
  const second = discover(index, { question: '', terms: ['login'], leads: 10, offset: 10 })
  const third = discover(index, { question: '', terms: ['login'], leads: 10, offset: 20 })
  assert.deepEqual(second.page, { offset: 10, limit: 10, next_offset: 20 })
  assert.deepEqual(third.page, { offset: 20, limit: 10, next_offset: null }, 'the last page says so')
  assert.equal(third.leads.length, 5)
  assert.deepEqual(third.leads.map((l) => l.rank), [21, 22, 23, 24, 25])
  const all = [...first.leads, ...second.leads, ...third.leads].map((l) => l.session_id)
  assert.equal(new Set(all).size, 25)
  assert.deepEqual(all, discover(index, { question: '', terms: ['login'], leads: 40 }).leads.map((l) => l.session_id))
  assert.deepEqual(discover(index, { question: '', terms: ['login'], leads: 10, offset: 500 }).leads, [])
  // The question path is unchanged: terms come from the question when none are given.
  assert.deepEqual(discover(index, { question: 'why is login shaped' }).terms.map((t) => t.text), ['login', 'shaped'])
})

test('neighbors: one hop in either direction, newest first, with edge types, keys and placeholders', async () => {
  const index = await graph(3)
  const out = neighbors(index, { ids: ['s0'], direction: 'out' })
  assert.deepEqual(out.starts, [{ input: 's0', by: 'id', found: true, node_id: 's0', type: 'Session', key: 'sess-0' }])
  assert.deepEqual(out.neighbors.map((n) => [n.direction, n.edge_type, n.node.node_id]).sort(), [['out', 'touched', 'f-login'], ['out', 'touched', 'f-poll'], ['out', 'used', 't-bash']])
  const onlyUsed = neighbors(index, { ids: ['s0'], direction: 'out', edgeTypes: ['used'] })
  assert.deepEqual(onlyUsed.neighbors.map((n) => n.node.key), ['Bash'])

  const into = neighbors(index, { keys: ['acme/app:src/login.js'], direction: 'in' })
  assert.equal(into.starts[0].by, 'key')
  assert.equal(into.starts[0].node_id, 'f-login')
  assert.deepEqual(into.neighbors.map((n) => n.node.node_id), ['s2', 's1', 's0', 'gone'], 'newest touch first, placeholder last')
  const s2 = into.neighbors[0]
  assert.equal(s2.from, 'f-login')
  assert.equal(s2.first_seen, new Date(T0 + 2 * DAY).toISOString())
  assert.deepEqual(s2.exemplar, { message_id: 'm-2', part_id: null })
  assert.deepEqual(s2.node.session, { first_seen: new Date(T0).toISOString(), cwd: '/w', git_branch: 'main', client_name: 'claude-code', user_id: 'u2' })
  const gone = into.neighbors[3].node
  assert.deepEqual([gone.placeholder, gone.key, gone.type], [true, null, 'Session'])
  assert.equal(into.coverage.unresolved_met, 1)

  const both = neighbors(index, { ids: ['s0'], keys: ['nope'] })
  assert.equal(both.neighbors.length, 3)
  assert.deepEqual(both.starts[1], { input: 'nope', by: 'key', found: false, node_id: null, type: null, key: null })
})

test('neighbors is bounded: result limit, visit budget shared across starts, at most 50 starts', async () => {
  const index = await graph(MAX_VISITS + 2_000)
  const limited = neighbors(index, { ids: ['f-login'], direction: 'in', limit: 7 })
  assert.equal(limited.neighbors.length, 7)
  assert.equal(limited.coverage.results_truncated, true)
  const walked = neighbors(index, { ids: ['f-login'], direction: 'in', limit: 500 })
  assert.equal(walked.neighbors.length, 500)
  const budget = neighbors(index, { ids: ['f-login', 'f-poll'], direction: 'in', limit: 500, maxVisits: 100 })
  assert.equal(budget.coverage.visits, 51, 'f-login gets half the budget; f-poll has one edge')
  assert.equal(budget.coverage.truncated, true)
  const many = neighbors(index, { ids: Array.from({ length: MAX_STARTS + 5 }, (_, i) => `s${i}`), direction: 'out', limit: 1 })
  assert.equal(many.starts.length, MAX_STARTS)
  assert.equal(many.coverage.starts_dropped, 5)
})

test('search: one bounded query per session, at most two at a time, each reported separately', async () => {
  let inFlight = 0
  let peak = 0
  /** @type {string[]} */
  const sqls = []
  /** @param {string} sql */
  const runSql = async (sql) => {
    sqls.push(sql)
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inFlight--
    const session = /session_id = '([^']+)'/.exec(sql)?.[1]
    if (session === 'bad') throw new Error('query_sql failed: boom')
    const limit = Number(/LIMIT (\d+)$/.exec(sql)?.[1])
    const rows = Array.from({ length: session === 'busy' ? 50 : 1 }, (_, i) => ({
      message_id: `${session}-m${i}`, part_id: `${session}-m${i}#0`, role: 'user', message_created_at: '2026-10-01T12:00:00.000Z',
      content_text: `${'x'.repeat(1000)} the Login poll ${'y'.repeat(1000)}`,
    }))
    return rows.slice(0, limit)
  }
  const sessions = ['a', 'busy', 'bad', 'a', ...Array.from({ length: 20 }, (_, i) => `s${i}`)]
  const r = await searchSessions({ runSql, sessions, terms: ['login', 'POLL', 'login', 'ab%c\\'], hitsPerSession: 5, hitChars: 100 })
  assert.equal(peak, SEARCH_CONCURRENCY)
  assert.equal(r.sessions.length, MAX_SEARCH_SESSIONS)
  assert.equal(r.coverage.sessions_dropped, 23 - MAX_SEARCH_SESSIONS)
  assert.deepEqual(r.terms, ['login', 'POLL', 'ab%c\\'])
  assert.equal(sqls.length, MAX_SEARCH_SESSIONS)
  assert.match(sqls[0], /LIKE '%login%' OR lower\(content_text\) LIKE '%poll%' OR lower\(content_text\) LIKE '%abc%'/)
  assert.match(sqls[0], /LIMIT 6$/)

  const [a, busy, bad] = r.sessions
  assert.deepEqual([a.session_id, a.hits.length, a.truncated, a.error], ['a', 1, false, null])
  assert.deepEqual([busy.hits.length, busy.truncated], [5, true])
  assert.deepEqual([bad.hits.length, bad.error], [0, 'query_sql failed: boom'])
  const hit = a.hits[0]
  assert.deepEqual(hit.matched_terms, ['login', 'POLL'])
  assert.equal(hit.excerpt.length, 100)
  assert.ok(hit.excerpt.includes('Login poll'), 'the excerpt shows the match')
  assert.equal(hit.text_truncated, true)
  assert.deepEqual(hit.read, { session_id: 'a', from: '2026-10-01T11:45:00.000Z', to: '2026-10-01T12:15:00.000Z', order: 'asc' })
})

test('search SQL quotes session ids and terms', () => {
  const sql = sessionSql("it's", ["o'clock"], 3)
  assert.match(sql, /session_id = 'it''s'/)
  assert.match(sql, /LIKE '%o''clock%'/)
  assert.match(sql, /role IN \('user', 'assistant'\) AND part_type IN \('text'\)/)
})

// ----- path tokens (LLP 0488#path-tokens) -----

/**
 * Files (keys) each touched by one session of the same index, on day i, so
 * which files anchor can be read off the leads.
 * @param {string[]} keys
 */
async function files(keys) {
  const b = createIndexBuilder()
  keys.forEach((key, i) => {
    b.addNode({ node_id: `f${i}`, node_type: 'File', natural_key: key })
    b.addNode({ node_id: `s${i}`, node_type: 'Session', natural_key: `sess-${i}` })
    b.addEdge({ edge_type: 'touched', src_id: `s${i}`, dst_id: `f${i}`, src_type: 'Session', dst_type: 'File', first_seen: T0 + i * DAY })
  })
  return b.finish()
}

/** @param {GraphIndex} index @param {Record<string, unknown>} input */
const keysFor = (index, input) => discover(index, { question: '', ...input }).anchors.map((a) => a.key)

test('path tokens: directory segments and basename parts, split on / - _ . and camelCase, lowercased', () => {
  assert.deepEqual(splitTokens('docs/onboarding/0042-quick-setup-flow.decision.md'), ['docs', 'onboarding', '0042', 'quick', 'setup', 'flow', 'decision', 'md'])
  assert.deepEqual(splitTokens('src/parseRetryAfter_v2.HTTPServer.js'), ['src', 'parse', 'retry', 'after', 'v2', 'http', 'server', 'js'])
})

test('a term matches a token exactly, or as a prefix from four characters; never inside a word', async () => {
  const index = await files(['acme/app:docs/onboarding/0042-quick-setup-flow.decision.md', 'acme/app:vendor/resetup/core.py', 'acme/app:src/settings.js'])
  assert.deepEqual(keysFor(index, { terms: ['setup'] }), ['acme/app:docs/onboarding/0042-quick-setup-flow.decision.md'], 'never inside a word: resetup is not setup')
  assert.deepEqual(keysFor(index, { terms: ['onboard'] }), ['acme/app:docs/onboarding/0042-quick-setup-flow.decision.md'], 'a 4+ character prefix of a directory token')
  assert.deepEqual(keysFor(index, { terms: ['set'] }), [], 'a 3-character term matches only an equal token')
  assert.deepEqual(keysFor(index, { terms: ['up'] }), [], 'terms under 3 characters are dropped')
  const anchor = discover(index, { question: '', terms: ['onboard'] }).anchors[0]
  assert.equal(anchor.match, 'token_prefix')
})

test('a compound term matches only files with every part, and counts as one term', async () => {
  const index = await files(['acme/app:docs/0042-quick-setup-flow.md', 'acme/app:docs/quick-start.md', 'acme/app:src/setupFlow.js'])
  assert.deepEqual(keysFor(index, { terms: ['quick_setup'] }), ['acme/app:docs/0042-quick-setup-flow.md'])
  assert.deepEqual(keysFor(index, { terms: ['setupFlow'] }).sort(), ['acme/app:docs/0042-quick-setup-flow.md', 'acme/app:src/setupFlow.js'], 'order and adjacency are not required')
  assert.deepEqual(keysFor(index, { terms: ['login.js'] }), [], "'js' is dropped, so login.js needs only 'login'")
  const r = discover(index, { question: '', terms: ['quick_setup', 'flow'] })
  assert.equal(r.anchors[0].term, 'quick_setup + flow', 'the anchor names the term set it matched')
})

test('ranking: the caller\'s repository first, then distinct terms, basename over directory, rarer over common, newer on ties', async () => {
  const keys = [
    'other/lib:docs/setup/notes.md',      // f0: directory token, other repo
    'other/lib:docs/notes/setup.md',      // f1: basename token, other repo
    'acme/app:docs/misc/readme.md',       // f2: no match
    '/home/me/app/docs/setup-guide.md',   // f3: absolute key under the caller's repository root
    'acme/app:docs/setup-onboarding.md',  // f4: two terms, caller's repository
  ]
  const index = await files(keys)
  const r = discover(index, { question: '', terms: ['setup', 'onboarding'], repo: 'acme/app', repoRoot: '/home/me/app' })
  assert.deepEqual(r.anchors.map((a) => [a.key, a.in_repo, a.proven]), [
    ['acme/app:docs/setup-onboarding.md', true, true],
    ['/home/me/app/docs/setup-guide.md', true, true],
    ['other/lib:docs/notes/setup.md', false, false],
    ['other/lib:docs/setup/notes.md', false, false],
  ])
  // Equal in everything else, the more recently touched file ranks first.
  const tie = await files(['acme/app:a/setup-one.md', 'acme/app:b/setup-two.md'])
  assert.deepEqual(keysFor(tie, { terms: ['setup'] }), ['acme/app:b/setup-two.md', 'acme/app:a/setup-one.md'])
})

test('a token in more than 5,000 files only scores; it never seeds a candidate alone', async () => {
  const keys = Array.from({ length: SEED_MAX_FILES + 10 }, (_, i) => `acme/app:src/common/file${i}.js`)
  keys.push('acme/app:src/common/rarething.js')
  const index = await files(keys)
  const alone = discover(index, { question: '', terms: ['common'] })
  assert.deepEqual(alone.anchors, [], 'common alone seeds nothing')
  assert.equal(alone.no_anchor, true)
  const both = discover(index, { question: '', terms: ['rarething', 'common'] })
  assert.equal(both.anchors[0].key, 'acme/app:src/common/rarething.js')
  assert.equal(both.anchors[0].term, 'rarething + common', 'the common token still counts for a file a rarer one found')
  assert.equal(both.coverage.postings_examined, 1)
})

test('postings are read rarest first and capped; reaching the cap sets anchors_truncated', async () => {
  const keys = Array.from({ length: 300 }, (_, i) => `acme/app:pkg${i % 3}/widget${i}.js`)
  const index = await files(keys)
  const capped = discover(index, { question: '', terms: ['widget', 'pkg1'], maxPostings: 120 })
  assert.equal(capped.coverage.postings_examined, 120)
  assert.ok(capped.coverage.anchors_truncated > 0)
  const full = discover(index, { question: '', terms: ['widget', 'pkg1'] })
  assert.equal(full.coverage.postings_examined, 400, 'pkg1 (100 files) then the widget prefix (300 tokens of one file each)')
  assert.ok(full.anchors.every((a) => a.key.includes('pkg1/')), 'files matching both terms rank first')
  assert.ok(MAX_POSTINGS === 60_000)
})

test('prefix recall is intended and ranks below an exact token (setup reaches setuptools, after setup itself)', async () => {
  // The setuptools file is the more recent, so only the exact-over-prefix
  // weight can put the setup file first.
  const index = await files(['acme/app:docs/setup/notes.md', 'acme/app:vendor/setuptools/core.py'])
  const r = discover(index, { question: '', terms: ['setup'] })
  assert.deepEqual(r.anchors.map((a) => [a.key, a.match]), [
    ['acme/app:docs/setup/notes.md', 'token'],
    ['acme/app:vendor/setuptools/core.py', 'token_prefix'],
  ])
  const confirm = await files(['acme/app:docs/confirmation-step.md'])
  assert.deepEqual(keysFor(confirm, { terms: ['confirm'] }), ['acme/app:docs/confirmation-step.md'])
})

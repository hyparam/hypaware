// @ts-check

// Fastask discovery over the warm index (LLP 0481 T6, LLP 0480#discovery):
// term extraction, anchor resolution with repository preference and honest
// proven/candidate marking, ambiguity kept as competing groups, a missing
// endpoint, a term with no anchor, and the anchor and visit budgets.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_ANCHORS, MAX_VISITS, discover, extractTerms, vocabularyMismatch } from '../../hypaware-core/plugins-workspace/fastask/src/discovery.js'
import { buildIndexFromSnapshot, createIndexBuilder } from '../../hypaware-core/plugins-workspace/fastask/src/index_builder.js'

/**
 * @import { GraphIndex } from '../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

const GRAPH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'contracts', 'graph-snapshot', 'v1')
const DAY = 86_400_000
const T0 = Date.UTC(2026, 8, 1)

/**
 * A small generated team graph: `files` are File keys; `touches` are
 * [session, file key, day offset, exemplar message id?].
 *
 * @param {{ files: string[], touches: Array<[string, string, number, string?]>, missingSessions?: string[] }} spec
 * @returns {Promise<GraphIndex>}
 */
async function graph(spec) {
  const builder = createIndexBuilder()
  const sessions = new Set(spec.touches.map(([s]) => s))
  for (const s of sessions) {
    if (spec.missingSessions?.includes(s)) continue
    builder.addNode({ node_id: `id-${s}`, node_type: 'Session', natural_key: s, label: s, first_seen: T0, props: { cwd: `/w/${s}`, git_branch: 'main', client_name: 'claude-code', user_id: 'u-1' } })
  }
  for (const key of spec.files) builder.addNode({ node_id: `id-${key}`, node_type: 'File', natural_key: key, label: key.split('/').pop() })
  for (const [s, key, day, message] of spec.touches) {
    builder.addEdge({
      edge_type: 'touched', src_id: `id-${s}`, dst_id: `id-${key}`, src_type: 'Session', dst_type: 'File',
      first_seen: T0 + day * DAY, source_keys: message ? { session_id: s, message_id: message } : { session_id: s },
    })
  }
  return builder.finish()
}

test('terms: paths and filenames as written, compound identifiers, then words minus stopwords, at most 12', () => {
  const terms = extractTerms('Why is the login function shaped this way in src/auth/login.js? see parseRetryAfter, work_budget and "README.md".')
  assert.deepEqual(terms.slice(0, 5), [
    { text: 'src/auth/login.js', kind: 'path' },
    { text: 'README.md', kind: 'path' },
    { text: 'parseRetryAfter', kind: 'identifier' },
    { text: 'work_budget', kind: 'identifier' },
    { text: 'login', kind: 'word' },
  ])
  const words = terms.filter((t) => t.kind === 'word').map((t) => t.text)
  assert.ok(words.includes('parse') && words.includes('retry') && words.includes('budget'))
  assert.ok(!words.includes('why') && !words.includes('the') && !words.includes('way'))
  assert.equal(extractTerms(Array.from({ length: 30 }, (_, n) => `word${String.fromCharCode(97 + n % 26)}${n}`).join(' ')).length, 12)
  assert.deepEqual(extractTerms('the and of'), [])
})

const TWO_LOGINS = {
  files: ['acme/app:src/login.js', 'other/lib:lib/login.js', 'acme/app:src/poll.js'],
  touches: /** @type {Array<[string, string, number, string?]>} */ ([
    ['s-acme-1', 'acme/app:src/login.js', 10],
    ['s-acme-2', 'acme/app:src/login.js', 12, 'm-acme-2'],
    ['s-acme-2', 'acme/app:src/poll.js', 11],
    ['s-other-1', 'other/lib:lib/login.js', 20],
    ['s-other-2', 'other/lib:lib/login.js', 21],
    ['s-other-3', 'other/lib:lib/login.js', 22],
  ]),
}

test('same basename in two repositories without a repository context returns competing groups', async () => {
  const index = await graph(TWO_LOGINS)
  const result = discover(index, { question: 'why is login.js shaped this way', leads: 4 })
  assert.equal(result.ambiguous, true)
  const competing = result.groups.filter((g) => g.term === 'login.js')
  assert.deepEqual(competing.map((g) => g.key).sort(), ['acme/app:src/login.js', 'other/lib:lib/login.js'])
  // Each competing file is represented, though the other repository's
  // sessions are newer: ambiguity is never collapsed into one confident lead.
  const groupsLed = new Set(result.leads.map((l) => l.group))
  assert.ok(groupsLed.has('acme/app:src/login.js') && groupsLed.has('other/lib:lib/login.js'))
  assert.ok(result.leads.every((l) => l.why.every((w) => w.anchor.proven && !w.anchor.in_repo)))
})

test('the caller\'s repository is preferred and resolves the ambiguity', async () => {
  const index = await graph(TWO_LOGINS)
  const result = discover(index, { question: 'why is login.js shaped this way', repo: 'Acme/App' })
  assert.equal(result.ambiguous, false)
  assert.equal(result.anchors[0].key, 'acme/app:src/login.js')
  assert.equal(result.anchors[0].in_repo, true)
  assert.deepEqual(result.leads.slice(0, 2).map((l) => l.session_id).sort(), ['s-acme-1', 's-acme-2'])
  // The graph ranks; it never excludes: the other repository's sessions follow.
  assert.ok(result.leads.some((l) => l.session_id.startsWith('s-other')))
  const top = result.leads[0]
  assert.equal(top.rank, 1)
  assert.equal(top.why[0].anchor.match, 'basename')
  assert.equal(top.why[0].edge, 'touched')
  assert.deepEqual(top.session, { first_seen: new Date(T0).toISOString(), cwd: `/w/${top.session_id}`, git_branch: 'main', client_name: 'claude-code', user_id: 'u-1' })
  assert.equal(vocabularyMismatch(index), null)
  assert.equal(result.fallback, null)
})

test('File nodes without touched edges are a vocabulary mismatch: anchors resolve, the walk is skipped, the caller falls back', async () => {
  const builder = createIndexBuilder()
  builder.addNode({ node_id: 's1', node_type: 'Session', natural_key: 'sess-1' })
  builder.addNode({ node_id: 'f1', node_type: 'File', natural_key: 'acme/app:src/login.js' })
  builder.addEdge({ edge_type: 'EDITED', src_id: 's1', dst_id: 'f1', src_type: 'Session', dst_type: 'File' })
  builder.addEdge({ edge_type: 'READ', src_id: 's1', dst_id: 'f1', src_type: 'Session', dst_type: 'File' })
  builder.addEdge({ edge_type: 'READ', src_id: 's1', dst_id: 'f1', src_type: 'Session', dst_type: 'File' })
  const index = await builder.finish()
  assert.deepEqual(vocabularyMismatch(index), { error_kind: 'vocabulary_mismatch', edge_types: { EDITED: 1, READ: 2 } })
  const result = discover(index, { question: 'login.js', repo: 'acme/app' })
  assert.deepEqual(result.fallback, { reason: 'vocabulary_mismatch', edge_types: { EDITED: 1, READ: 2 } })
  assert.deepEqual(result.leads, [])
  assert.equal(result.no_anchor, false)
  assert.equal(result.anchors[0].key, 'acme/app:src/login.js')
  assert.equal(result.coverage.visits, 0)
})

test('a graph with no File nodes is not a vocabulary mismatch', async () => {
  const builder = createIndexBuilder()
  builder.addNode({ node_id: 's1', node_type: 'Session', natural_key: 'sess-1' })
  builder.addNode({ node_id: 't1', node_type: 'Tool', natural_key: 'Bash' })
  builder.addEdge({ edge_type: 'used', src_id: 's1', dst_id: 't1', src_type: 'Session', dst_type: 'Tool' })
  // A File known only as a placeholder endpoint is not a File node of this generation.
  builder.addEdge({ edge_type: 'EDITED', src_id: 's1', dst_id: 'gone', src_type: 'Session', dst_type: 'File' })
  const index = await builder.finish()
  assert.equal(vocabularyMismatch(index), null)
  assert.equal(discover(index, { question: 'anything' }).fallback, null)
})

test('a session matching more terms ranks first, with its exemplar message and touch time', async () => {
  const index = await graph(TWO_LOGINS)
  const result = discover(index, { question: 'login poll', repo: 'acme/app' })
  const top = result.leads[0]
  assert.equal(top.session_id, 's-acme-2')
  assert.deepEqual(top.why.map((w) => w.term).sort(), ['login', 'poll'])
  assert.deepEqual(top.exemplar, { message_id: 'm-acme-2', part_id: null })
  assert.equal(top.touched_at, new Date(T0 + 12 * DAY).toISOString())
  assert.equal(top.why[0].anchor.match, 'stem')
})

test('a term with no anchor returns no graph leads and says so', async () => {
  const index = await graph(TWO_LOGINS)
  const result = discover(index, { question: 'what about the kubernetes migration' })
  assert.equal(result.no_anchor, true)
  assert.deepEqual(result.leads, [])
  assert.deepEqual(result.anchors, [])
  assert.ok(result.terms.length > 0)
})

test('an edge from a missing session is counted as unresolved, not shown as a lead', async () => {
  const index = await graph({
    files: ['acme/app:src/login.js'],
    touches: [['s-present', 'acme/app:src/login.js', 1], ['s-gone', 'acme/app:src/login.js', 2]],
    missingSessions: ['s-gone'],
  })
  assert.equal(index.unresolvedEdges, 1)
  const result = discover(index, { question: 'login.js' })
  assert.equal(result.coverage.unresolved_edges_met, 1)
  assert.deepEqual(result.leads.map((l) => l.session_id), ['s-present'])
})

test('--file resolves exactly in the caller\'s repository, by absolute path as a candidate, else by suffix', async () => {
  const index = await graph({
    files: ['acme/app:src/auth/login.js', 'other/lib:src/auth/login.js', '/home/t/work/app/src/auth/login.js'],
    touches: [['s1', 'acme/app:src/auth/login.js', 1], ['s2', 'other/lib:src/auth/login.js', 2], ['s3', '/home/t/work/app/src/auth/login.js', 3]],
  })
  const exact = discover(index, { question: '', files: ['/Users/me/app/src/auth/login.js'], repo: 'acme/app', repoRoot: '/Users/me/app' })
  assert.deepEqual(exact.anchors.map((a) => [a.key, a.match, a.proven, a.in_repo]), [['acme/app:src/auth/login.js', 'exact', true, true]])

  const absolute = discover(index, { question: '', files: ['/home/t/work/app/src/auth/login.js'] })
  assert.deepEqual(absolute.anchors.map((a) => [a.key, a.match, a.proven]), [['/home/t/work/app/src/auth/login.js', 'absolute', false]])

  const suffix = discover(index, { question: '', files: ['auth/login.js'] })
  assert.equal(suffix.anchors.length, 3)
  assert.ok(suffix.anchors.every((a) => a.match === 'suffix' && !a.proven), 'suffix matches are candidates, not proven identity')
  assert.equal(suffix.ambiguous, true)

  // An absolute path from another checkout falls back to its last segments.
  const elsewhere = discover(index, { question: '', files: ['/opt/x/app/src/auth/login.js'] })
  assert.equal(elsewhere.anchors.length, 3)
})

test('anchors are capped at 50 and shared fairly across terms', async () => {
  const files = Array.from({ length: 80 }, (_, n) => `org${n}/repo:src/handler.js`)
  files.push('acme/app:src/rare.js')
  const index = await graph({ files, touches: files.map((f, n) => /** @type {[string, string, number]} */ ([`s${n}`, f, n])) })
  const result = discover(index, { question: 'handler rare' })
  assert.equal(result.anchors.length, MAX_ANCHORS)
  assert.ok(result.anchors.some((a) => a.key === 'acme/app:src/rare.js'), 'a rare term keeps its anchor')
  assert.equal(result.coverage.anchors_truncated, 81 - MAX_ANCHORS)
})

test('the visit budget bounds the walk, keeps the newest touches and reports truncation', async () => {
  const sessions = MAX_VISITS + 5_000
  const index = await graph({
    files: ['acme/app:README.md'],
    touches: Array.from({ length: sessions }, (_, n) => /** @type {[string, string, number]} */ ([`s${n}`, 'acme/app:README.md', n / 1000])),
  })
  const result = discover(index, { question: 'README.md', leads: 3 })
  assert.equal(result.coverage.visits, MAX_VISITS)
  assert.equal(result.coverage.truncated, true)
  assert.equal(result.coverage.sessions_considered, MAX_VISITS)
  assert.deepEqual(result.leads.map((l) => l.session_id), [`s${sessions - 1}`, `s${sessions - 2}`, `s${sessions - 3}`])

  const small = discover(index, { question: 'README.md', maxVisits: 100 })
  assert.equal(small.coverage.visits, 100)
})

test('leads default to 8 and are capped at 40', async () => {
  const index = await graph({
    files: ['acme/app:a.js'],
    touches: Array.from({ length: 60 }, (_, n) => /** @type {[string, string, number]} */ ([`s${n}`, 'acme/app:a.js', n])),
  })
  assert.equal(discover(index, { question: 'a.js' }).leads.length, 8)
  assert.equal(discover(index, { question: 'a.js', leads: 500 }).leads.length, 40)
})

test('on the pinned fixture, discovery walks touched edges to the session, from unproven absolute-path anchors, non-ASCII names included', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(GRAPH, 'manifest.json'), 'utf8'))
  const index = await buildIndexFromSnapshot({
    manifest,
    nodes: fs.readFileSync(path.join(GRAPH, 'nodes.ndjson.gz')),
    edges: fs.readFileSync(path.join(GRAPH, 'edges.ndjson.gz')),
  })
  const result = discover(index, { question: 'what changed in app.js and café-日本-🚀.md', repo: 'fx-org/fx-repo' })
  assert.deepEqual(result.anchors.map((a) => [a.key, a.match, a.proven, a.in_repo]), [
    ['/work/fx-repo/src/app.js', 'basename', false, false],
    ['/work/fx-repo/docs/café-日本-🚀.md', 'basename', false, false],
  ])
  assert.equal(result.no_anchor, false)
  // The re-pinned fixture carries the projectors' `touched` (LLP 0484#edge-kinds).
  assert.equal(result.fallback, null)
  assert.equal(result.ambiguous, false)
  // app.js is also touched from a session absent from the node file.
  assert.equal(result.coverage.unresolved_edges_met, 1)
  assert.deepEqual(result.leads, [{
    session_id: 'fx-session-0001',
    node_id: '064cdf336fa1a22c8057df70',
    rank: 1,
    score: 6,
    // Equal weights: the lead's group is its earliest anchor's term.
    group: 'app.js',
    why: [
      { anchor: { type: 'File', node_id: 'b9ed4fa6dc7e6e60fda8964f', key: '/work/fx-repo/docs/café-日本-🚀.md', match: 'basename', proven: false, in_repo: false }, term: 'café-日本-🚀.md', edge: 'touched', touched_at: '2026-09-02T10:15:30.001Z' },
      { anchor: { type: 'File', node_id: 'daed8234d97ecd3c21815e80', key: '/work/fx-repo/src/app.js', match: 'basename', proven: false, in_repo: false }, term: 'app.js', edge: 'touched', touched_at: '2026-08-31T22:36:02.500Z' },
    ],
    touched_at: '2026-09-02T10:15:30.001Z',
    exemplar: { message_id: 'fx-msg-0003', part_id: null },
    session: { first_seen: '2026-08-31T22:35:40.016Z', cwd: null, git_branch: null, client_name: null, user_id: null },
  }])
})

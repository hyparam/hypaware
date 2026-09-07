// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  EVIDENCE_RUNS_KEPT,
  ROUTE_FLOORS,
  askInstructions,
  chooseRoutes,
  commandHeads,
  computeSignals,
  onDiskListing,
  prepareFirstAskEvidence,
  pruneRuns,
  renderTriage,
  sinkFiles,
  toTsv,
  triageSql,
  windowStart,
} from '../../src/core/query/first_ask_evidence.js'

// The recommendation ask (LLP 0388): the route rule, the files the client
// reads, and the run directory the client is started in.
// @ref LLP 0388#route-rule [tests]:

/** Signals with nothing over any floor. */
function quietSignals() {
  return computeSignals({ sink: [], cont: [], skill: [], rule: [], subagent: [] })
}

test('windowStart: thirty days back, as a UTC date', () => {
  assert.equal(windowStart(new Date('2026-09-07T05:00:00Z')), '2026-08-08')
  assert.equal(windowStart(new Date('2026-09-07T05:00:00Z'), 1), '2026-09-06')
})

test('triageSql: every statement excludes the duplicate OTEL lane and is bounded', () => {
  // @ref LLP 0388#human-turns [tests]: the duplicate lane never counts
  const sql = triageSql('2026-08-08')
  for (const [name, stmt] of Object.entries(sql)) {
    assert.ok(stmt.includes("conversation_source <> 'claude_code'"), `${name} keeps the duplicate lane`)
    assert.ok(/group by|count\(\*\)/.test(stmt), `${name} is not an aggregate`)
  }
  assert.ok(sql.skill.includes("user_type in ('external', 'user')"), 'the typed-line signal keeps Codex human turns and drops guardian reviews')
  assert.ok(sql.skill.includes('limit 8'))
})

test('computeSignals: reopened days are measured against the fresh ratio', () => {
  const s = computeSignals({
    sink: [
      { session_id: 'a', date: '2026-08-10', ctx: 1000, outp: 10 },
      { session_id: 'b', date: '2026-08-10', ctx: 1000, outp: 10 },
      // session c: day one at the fresh ratio, day two at four times it
      { session_id: 'c', date: '2026-08-11', ctx: 1000, outp: 10 },
      { session_id: 'c', date: '2026-08-12', ctx: 4000, outp: 10 },
    ],
    cont: [{ typed: 3, sessions: 2 }],
    skill: [],
    rule: [],
    subagent: [],
  })
  assert.equal(s.record.sessions, 3)
  assert.equal(s.record.sessionDays, 4)
  assert.equal(s.sink.fresh, 100)
  assert.equal(s.sink.reopenedDays, 1)
  assert.equal(s.sink.excess, 3000)
  assert.equal(s.sink.total, 7000)
  assert.equal(s.sink.continueTyped, 3)
  assert.equal(s.skill, undefined)
})

test('chooseRoutes: below every floor is none; the largest multiple wins; a near tie runs both', () => {
  // @ref LLP 0388#route-rule [tests]: floors, precedence, and the one-fifth band
  assert.deepEqual(chooseRoutes(quietSignals()), [])

  const s = quietSignals()
  s.sink.share = 0.157
  s.subagent.noDispatchDays = 136
  // sink 1.57x its floor, subagent 6.8x: subagent alone
  assert.deepEqual(chooseRoutes(s), ['subagent'])

  const t = quietSignals()
  t.subagent.noDispatchDays = 44   // 2.2x
  t.rule = { head: 'x', tool: 'Bash', sessions: 9, n: 20, others: [] }   // 1.8x, within a fifth of 2.2x
  assert.deepEqual(chooseRoutes(t), ['subagent', 'rule'])

  const u = quietSignals()
  u.sink.share = 0.099   // one tenth of a point under the floor stays out
  u.skill = { line: 'commit on appropriate branch', sessions: 15, days: 10, typed: 17, others: [] }
  assert.deepEqual(chooseRoutes(u), ['skill'])
  assert.equal(ROUTE_FLOORS.sink, 0.10)
})

test('renderTriage: the record line comes first and the applied rule names the route', () => {
  const s = quietSignals()
  s.record = { sessions: 3, sessionDays: 3 }
  const text = renderTriage(s, [], { from: '2026-08-08', scope: 'this machine' })
  const lines = text.split('\n')
  assert.match(lines[2], /^record\s+3 sessions over 3 session-days/)
  assert.ok(text.includes('threshold 3 sessions on 3 days'), 'a missing signal names its threshold, not a count')
  assert.ok(text.includes('Route chosen by HypAware: none'))
  const routed = renderTriage(s, ['sink', 'rule'], { from: '2026-08-08', scope: 'this machine' })
  assert.ok(routed.includes('Route chosen by HypAware: sink and rule.'))
})

test('toTsv: cells lose their newlines and tabs', () => {
  const tsv = toTsv(['a', 'b'], [{ a: 'x\ny', b: 'p\tq' }])
  assert.equal(tsv, 'a\tb\nx y\tp q\n')
})

test('commandHeads: a cd prefix is dropped and the head is the verb plus its subcommand', () => {
  const heads = commandHeads([
    { session_id: 's1', tool_name: 'Bash', args: '{"command":"cd /repo && git checkout -b topic"}' },
    { session_id: 's2', tool_name: 'Bash', args: '{"command":"git checkout master"}' },
    { session_id: 's1', tool_name: 'Read', args: '{"file_path":"/a/b/types.d.ts"}' },
  ])
  assert.deepEqual(heads.map((h) => h.head), ['Bash: git checkout -b', 'Bash: git checkout master', 'Read: types.d.ts'])
  assert.equal(heads[0].sessions, 1)
})

test('sinkFiles: summary slices and the per-day table agree', () => {
  const files = sinkFiles(
    [
      { s: 'aaaa1111', date: '2026-08-10', ctx: 1000, outp: 10, calls: 3 },
      { s: 'bbbb2222', date: '2026-08-11', ctx: 1000, outp: 10, calls: 3 },
      { s: 'bbbb2222', date: '2026-08-12', ctx: 5000, outp: 10, calls: 1 },
    ],
    [{ s: 'bbbb2222', date: '2026-08-12', i: 0, cwd: '/Users/someone/work', line: 'continue' }],
  )
  const byName = Object.fromEntries(files.map((f) => [f.name, f.content]))
  assert.match(byName['session_days_summary.txt'], /multi_later\t1\t5000\t10\t500/)
  assert.match(byName['session_days_summary.txt'], /excess context on later days, relative to the single-day ratio: 4000 tokens/)
  assert.match(byName['session_days.tsv'], /bbbb2222\t2026-08-12\t2\t2\t5000\t10\t500\t1/)
  assert.match(byName['day_openers.tsv'], /~\/work\tcontinue/)
})

test('askInstructions: route, files, and the answer shape the reader gets', () => {
  // @ref LLP 0388#answer-shape [tests]: recommendation first, no self-serve queries, sources last
  const text = askInstructions(['sink'], { scope: 'this machine', files: ['triage.txt', 'session_days.tsv', 'ASK.md'] })
  assert.ok(text.includes('Route: sink, chosen by HypAware'))
  assert.ok(text.includes('Run no queries of your own'))
  assert.ok(text.includes('`session_days.tsv`'))
  assert.ok(text.includes('Line 1: the recommendation'))
  assert.ok(text.includes('Under 110 words before the code block'))
  assert.ok(!text.includes('—'), 'no em dashes')
  const none = askInstructions([], { scope: 'this machine', files: ['triage.txt'] })
  assert.ok(none.includes('Route: none.'))
})

test('onDiskListing: missing directories and files are lines, never errors', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  const text = await onDiskListing({ homeDir: home })
  assert.ok(text.includes('## ~/.claude/skills\n(none)'))
  assert.ok(text.includes('## ~/.claude/CLAUDE.md\nabsent'))
  await fsp.mkdir(path.join(home, '.claude', 'skills', 'x'), { recursive: true })
  await fsp.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'hyp claude-hook session-context -' }] }] } }))
  const again = await onDiskListing({ homeDir: home })
  assert.ok(again.includes('## ~/.claude/skills\nx'))
  assert.ok(again.includes('SessionStart: hyp claude-hook session-context -'))
})

test('prepareFirstAskEvidence: writes the run directory, only the chosen route, and prunes old runs', async () => {
  // @ref LLP 0388#run-directory [tests]: one bounded directory per ask, the client starts inside it
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-runs-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  for (const stamp of ['20260801T000000Z', '20260802T000000Z', '20260803T000000Z', '20260804T000000Z', '20260805T000000Z']) {
    await fsp.mkdir(path.join(root, stamp))
  }
  /** @type {string[]} */
  const seen = []
  const runner = {
    hasDataset: () => true,
    async run(sql) {
      seen.push(sql)
      // The route's heavy-day table is checked before the triage probe,
      // which shares its dispatch clause.
      if (sql.includes('as result_bytes')) return { columns: [], rows: [{ s: 'a0000001', date: '2026-08-20', client: 'claude', calls: 60, read_calls: 50, shell_calls: 5, edit_calls: 0, dispatches: 0, result_bytes: 204800 }] }
      // Triage: a strong subagent signal and nothing else.
      if (sql.includes("tool_name = 'Agent') as dispatches")) {
        return { columns: [], rows: Array.from({ length: 25 }, (_, i) => ({ session_id: `s${i}`, date: '2026-08-20', reads: 50, dispatches: 0, calls: 60 })) }
      }
      if (sql.includes('as brief')) return { columns: [], rows: [] }
      if (sql.includes("in ('a0000001')")) return { columns: [], rows: [{ s: 'a0000001', date: '2026-08-20', i: 0, line: 'find every place we parse dates' }] }
      return { columns: [], rows: [] }
    },
  }
  const evidence = await prepareFirstAskEvidence({
    runner,
    root,
    homeDir: home,
    now: new Date('2026-09-07T05:00:00Z'),
  })
  assert.deepEqual(evidence.routes, ['subagent'])
  assert.equal(evidence.dir, path.join(root, '20260907T050000Z'))
  const names = (await fsp.readdir(evidence.dir)).sort()
  assert.deepEqual(names, ['ASK.md', 'agent_briefs.tsv', 'heavy_typed.tsv', 'on_disk.txt', 'read_heavy_sessions.tsv', 'triage.txt'])
  assert.ok(!names.includes('session_days.tsv'), 'the sink route was not gathered')
  const typed = await fsp.readFile(path.join(evidence.dir, 'heavy_typed.tsv'), 'utf8')
  assert.match(typed, /a0000001\t2026-08-20\t0\tfind every place we parse dates/)
  const kept = (await fsp.readdir(root)).sort()
  assert.equal(kept.length, EVIDENCE_RUNS_KEPT)
  assert.ok(!kept.includes('20260801T000000Z'), 'the oldest run was pruned')
  assert.ok(kept.includes('20260907T050000Z'))
  // Only the five triage statements ran before the route was chosen.
  assert.equal(seen.filter((q) => q.includes("part_type = 'tool_call'") && q.includes('having count(*) >= 40')).length, 1)
})

test('pruneRuns: a missing root is not an error', async () => {
  await pruneRuns(path.join(os.tmpdir(), 'hyp-ask-absent-' + Date.now()), 5)
})

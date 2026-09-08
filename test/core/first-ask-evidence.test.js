// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ROUTE_FLOORS,
  askInstructions,
  chooseRoutes,
  commandHeads,
  computeSignals,
  describeRoute,
  frontMatterDescription,
  onDiskListing,
  prepareFirstAskEvidence,
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
  assert.ok(sql.rule.includes("not like 'This Bash command contains multiple operations%'"), 'permission prompts are not agent mistakes')
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
  // Cost-weighted: every row prices its context as cache reads (0.1) and its
  // output at 5, so fresh days cost 15 per output token and day two of c
  // costs 45, an excess of 300 of 900 units.
  assert.equal(s.sink.excessCost, 300)
  assert.equal(s.sink.totalCost, 900)
  assert.ok(Math.abs(s.sink.share - 1 / 3) < 1e-9)
  assert.ok(Math.abs(s.sink.rawShare - 3000 / 7000) < 1e-9)
  assert.equal(s.sink.continueTyped, 3)
  assert.equal(s.skill, undefined)
})

test('chooseRoutes: below every floor is none; the largest multiple wins; a near tie runs both', () => {
  // @ref LLP 0388#route-rule [tests]: floors, precedence, and the one-fifth band
  assert.deepEqual(chooseRoutes(quietSignals()), [])

  const s = quietSignals()
  s.sink.share = 0.157
  s.subagent.costShare = 0.40
  s.subagent.noDispatchDays = 136
  // Inline reading at four times the sink's share, but no recurring task:
  // nothing a person can add would change it, so the sink wins alone.
  assert.deepEqual(chooseRoutes(s), ['sink'])
  s.subagent.recurring = { kind: 'line', text: 'review the pr for memory or cpu pain points', sessions: 4 }
  // With a request that recurs, the same cost is 4x its floor against the sink's 1.57x.
  assert.deepEqual(chooseRoutes(s), ['subagent'])

  const t = quietSignals()
  t.subagent.costShare = 0.22   // 2.2x
  t.subagent.recurring = { kind: 'brief', text: 'Audit one collection path', sessions: 3 }
  t.rule = { head: 'x', tool: 'Bash', sessions: 9, days: 6, n: 20, others: [] }   // min(1.8x, 2x) = 1.8x, within a fifth of 2.2x
  assert.deepEqual(chooseRoutes(t), ['subagent', 'rule'])

  const u = quietSignals()
  u.sink.share = 0.099   // one tenth of a point under the floor stays out
  u.skill = { line: 'commit on appropriate branch', sessions: 15, days: 10, typed: 17, others: [] }
  assert.deepEqual(chooseRoutes(u), ['skill'])
  assert.equal(ROUTE_FLOORS.sink, 0.10)
  assert.equal(ROUTE_FLOORS.subagent, ROUTE_FLOORS.sink, 'the two token routes share a floor so they compare')

  const burst = quietSignals()
  burst.sink.share = 0.216   // 2.16x
  burst.rule = { head: 'Column "type" not found', tool: 'Bash', sessions: 47, days: 5, n: 48, others: [] }
  // 47 sessions is 9.4x, but 5 days is 1.67x; the smaller wins, so a one-day
  // burst from an eval harness does not outrank a month of reopened sessions.
  assert.deepEqual(chooseRoutes(burst), ['sink'])
  burst.rule.days = 2
  assert.deepEqual(chooseRoutes(burst), ['sink'], 'under the day floor the rule route is out entirely')
})

test('computeSignals: inline reading is costed in tokens and needs a recurring task to count', () => {
  const s = computeSignals({
    sink: [{ session_id: 'a', date: '2026-08-10', ctx: 1_000_000, outp: 1000 }],
    cont: [],
    skill: [],
    rule: [],
    // 400 KB of results over 20 turns: 100k tokens re-sent for ~10 turns
    subagent: [{ session_id: 'a', date: '2026-08-10', reads: 60, dispatches: 0, calls: 80, turns: 20, result_bytes: 400_000 }],
    briefs: [{ brief: 'Audit one collection path', sessions: 3 }],
    recurring: [],
  })
  // 100k tokens re-sent for ~10 turns, priced as cache reads at 0.1: 100k cost units,
  // against a total spend of 100k (context as cache reads) + 5k (output at 5).
  assert.equal(s.subagent.inlineCost, 100_000)
  assert.ok(Math.abs(s.subagent.costShare - 100_000 / 105_000) < 1e-9)
  assert.deepEqual(s.subagent.recurring, { kind: 'brief', text: 'Audit one collection path', sessions: 3 })
  const typed = computeSignals({ sink: [], cont: [], skill: [], rule: [], subagent: [], briefs: [{ brief: 'x', sessions: 3 }], recurring: [{ line: 'check this pr for cpu pain points', sessions: 4 }] })
  assert.equal(typed.subagent.recurring?.kind, 'line', 'a typed request outranks a brief as the recurring task')
})

test('renderTriage: the record line comes first and the applied rule names the route', () => {
  const s = quietSignals()
  s.record = { sessions: 3, sessionDays: 3 }
  const text = renderTriage(s, [], { from: '2026-08-08', scope: 'this machine' })
  const lines = text.split('\n')
  assert.match(lines[2], /^record\s+3 sessions over 3 session-days/)
  assert.ok(text.includes('threshold 3 sessions on 3 days'), 'a missing signal names its threshold, not a count')
  assert.ok(text.includes('Route chosen by HypAware: none'))
  s.rule = { head: 'Column "type" not found', tool: 'Bash', sessions: 11, days: 5, n: 11, others: [] }
  const routed = renderTriage(s, ['sink', 'rule'], { from: '2026-08-08', scope: 'this machine' })
  assert.ok(routed.includes('Route chosen by HypAware: sink (reopened sessions:'))
  assert.ok(routed.includes('Route chosen by HypAware: rule (a mistake that keeps recurring: "Column "type" not found" failed in 11 sessions on 5 days (11 times).)'))
  assert.equal(describeRoute('skill', s), 'something you keep typing.')
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
  const s = quietSignals()
  s.sink.share = 0.209
  s.sink.reopenedDays = 64
  const text = askInstructions(['sink'], { scope: 'this machine', files: ['triage.txt', 'session_days.tsv', 'ASK.md'], signals: s })
  assert.ok(text.includes('- reopened sessions: 20.9% of all spend is excess on the 64 days a session was reopened.'), 'the route is a finding in words, never a bare id')
  assert.ok(!text.includes('Route: sink'))
  assert.ok(text.includes('at most two `hyp query` commands'), 'a bounded fetch for a missing figure is allowed')
  assert.ok(text.includes("read the hypaware-query skill's SKILL.md"), 'the skill is read before a query, and only then')
  assert.ok(text.includes('`session_days.tsv`'))
  assert.ok(text.includes('Based on your logs from the last 30 days,'))
  assert.ok(text.includes('Under 110 words before the code block'))
  assert.ok(!text.includes('\u2014'), 'no em dashes')
  const none = askInstructions([], { scope: 'this machine', files: ['triage.txt'] })
  assert.ok(none.includes('nothing over its floor'))
})

test('onDiskListing: skills and agents carry their descriptions; hooks are not listed', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  const text = await onDiskListing({ homeDir: home })
  assert.ok(text.includes('## ~/.claude/skills (name: what it is for)\n(none)'))
  assert.ok(text.includes('## ~/.claude/CLAUDE.md\nabsent'))
  await fsp.mkdir(path.join(home, '.claude', 'skills', 'hypaware-query'), { recursive: true })
  await fsp.writeFile(path.join(home, '.claude', 'skills', 'hypaware-query', 'SKILL.md'), '---\nname: hypaware-query\ndescription: Query this machine\'s recorded AI session history.\nuser-invocable: false\n---\n# body\n')
  await fsp.mkdir(path.join(home, '.claude', 'skills', '.DS_Store'), { recursive: true })
  await fsp.mkdir(path.join(home, '.claude', 'agents'), { recursive: true })
  await fsp.writeFile(path.join(home, '.claude', 'agents', 'hypaware-analyst.md'), '---\nname: hypaware-analyst\ndescription: "Worker for fan-out analysis."\ntools: Bash\n---\n')
  await fsp.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'hyp claude-hook session-context -' }] }] } }))
  const again = await onDiskListing({ homeDir: home })
  assert.ok(again.includes("hypaware-query: Query this machine's recorded AI session history."))
  assert.ok(again.includes('hypaware-analyst: Worker for fan-out analysis.'))
  assert.ok(!again.includes('.DS_Store'))
  assert.ok(!again.includes('hook'), 'hooks are not a change the ask proposes, so they are not evidence')
})

test('frontMatterDescription: one line, unquoted, capped, empty without front matter', () => {
  assert.equal(frontMatterDescription('---\nname: x\ndescription: "Does a thing."\n---\nbody'), 'Does a thing.')
  assert.equal(frontMatterDescription('---\ndescription: spans\n---\n'), 'spans')
  assert.equal(frontMatterDescription('# no front matter\ndescription: nope'), '')
  assert.equal(frontMatterDescription('---\ndescription: ' + 'x'.repeat(300) + '\n---\n').length, 200)
})

test('prepareFirstAskEvidence: rewrites the one directory with only the chosen route', async () => {
  // @ref LLP 0388#run-directory [tests]: one directory, wiped per ask, the client starts inside it
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-runs-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  // A leftover from a previous ask on another route must not survive.
  await fsp.writeFile(path.join(root, 'session_days.tsv'), 'stale\n')
  /** @type {string[]} */
  const seen = []
  const runner = {
    hasDataset: () => true,
    async run(sql) {
      seen.push(sql)
      // The route's heavy-day table carries the client column; the triage
      // probe carries turns. Both carry result bytes.
      if (sql.includes('max(client_name) as client')) return { columns: [], rows: [{ s: 'a0000001', date: '2026-08-20', client: 'claude', calls: 60, read_calls: 50, shell_calls: 5, edit_calls: 0, dispatches: 0, result_bytes: 204800 }] }
      // Triage: inline reading worth all of the context, on days that share one typed request.
      if (sql.includes('as turns')) {
        return { columns: [], rows: Array.from({ length: 25 }, (_, i) => ({ session_id: `a000000${i % 4}`, date: `2026-08-${10 + i}`, reads: 50, dispatches: 0, calls: 60, turns: 20, result_bytes: 400_000 })) }
      }
      if (sql.includes('as ctx')) return { columns: [], rows: [{ session_id: 'a0000001', date: '2026-08-10', ctx: 1_000_000, outp: 1000 }] }
      if (sql.includes('having count(distinct session_id) >= 3 order by sessions desc limit 3') && sql.includes('as line')) {
        return { columns: [], rows: [{ line: 'check this pr for cpu pain points', sessions: 4 }] }
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
  assert.equal(evidence.dir, root)
  const names = (await fsp.readdir(evidence.dir)).sort()
  assert.deepEqual(names, ['ASK.md', 'agent_briefs.tsv', 'heavy_typed.tsv', 'on_disk.txt', 'read_heavy_sessions.tsv', 'triage.txt'])
  assert.ok(!names.includes('session_days.tsv'), 'the sink route was not gathered and the stale file is gone')
  const typed = await fsp.readFile(path.join(evidence.dir, 'heavy_typed.tsv'), 'utf8')
  assert.match(typed, /a0000001\t2026-08-20\t0\tfind every place we parse dates/)
  // The triage probe ran once and the route's own gather once.
  assert.equal(seen.filter((q) => q.includes('as turns')).length, 1)
  assert.equal(seen.filter((q) => q.includes('max(client_name) as client')).length, 1)
})

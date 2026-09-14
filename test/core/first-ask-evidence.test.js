// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { asyncRow } from 'squirreling'

import { executeQuerySql } from '../../src/core/query/sql.js'
import {
  RECORD_FLOOR,
  askInstructions,
  buildCandidates,
  commandHeads,
  enoughRecorded,
  evidenceSql,
  frontMatterDescription,
  onDiskListing,
  prepareFirstAskEvidence,
  renderCandidates,
  sampleTriggers,
  sessionAnchors,
  windowStart,
} from '../../src/core/query/first_ask_evidence.js'

/**
 * @import { AsyncDataSource } from 'squirreling/src/types.js'
 */

// The recommendation ask (LLP 0398): the one signal, the files the client
// reads, and the folder the client is started in.
// @ref LLP 0398#one-signal [tests]:

test('windowStart: thirty days back, as a UTC date', () => {
  assert.equal(windowStart(new Date('2026-09-07T05:00:00Z')), '2026-08-08')
  assert.equal(windowStart(new Date('2026-09-07T05:00:00Z'), 1), '2026-09-06')
})

test('evidenceSql: every statement excludes the duplicate OTEL lane; user text is human turns only', () => {
  // @ref LLP 0398#human-turns [tests]: the duplicate lane never counts, and injected user text is not a person
  const sql = evidenceSql('2026-08-08')
  const stmts = [sql.record, sql.lines, sql.triggers(['x']), sql.calls([{ id: 'a', at: 0 }]), sql.replies([{ id: 'a', at: 0 }])]
  for (const stmt of stmts) assert.ok(stmt.includes("conversation_source <> 'claude_code'"))
  for (const stmt of [sql.lines, sql.triggers(['x'])]) {
    assert.ok(stmt.includes("user_type in ('external', 'user')"), 'Codex human turns count, guardian reviews do not')
    assert.ok(stmt.includes("not like 'Message Type:%'"), 'a pasted relay header is not a typed request')
    assert.ok(stmt.includes("not like '# AGENTS.md instructions%'"))
  }
  assert.ok(sql.lines.includes('having count(distinct session_id) >= 3 and count(distinct date) >= 3'))
  for (const stmt of [sql.lines, sql.triggers(['x'])]) {
    assert.ok(stmt.includes('length(content_text) between 12 and 160'), 'the occurrences counted are the same messages the candidate was found from')
  }
  assert.ok(sql.triggers(["it's done"]).includes("'it''s done'"), 'a quote in a line is escaped')
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

/** Two sessions that typed the commit line and then ran the procedure. */
function commitRows() {
  return {
    lines: [{ line: 'commit on appropriate branch and make a pr', sessions: 2, days: 2, typed: 2 }],
    triggers: [
      { session_id: 'sA', line: 'commit on appropriate branch and make a pr', at: '2026-08-12T10:00:00Z', date: '2026-08-12', example: 'commit on appropriate branch and make a PR' },
      { session_id: 'sB', line: 'commit on appropriate branch and make a pr', at: '2026-08-14T10:00:00Z', date: '2026-08-14', example: 'Commit on appropriate branch and make a PR' },
    ],
    calls: [
      // before the trigger: not part of the procedure
      { session_id: 'sA', at: '2026-08-12T09:00:00Z', tool_name: 'Bash', args: '{"command":"git log --oneline -3"}' },
      { session_id: 'sA', at: '2026-08-12T10:01:00Z', tool_name: 'Bash', args: '{"command":"git status --short"}' },
      { session_id: 'sA', at: '2026-08-12T10:02:00Z', tool_name: 'Bash', args: '{"command":"npm test 2>&1 | tail -3"}' },
      { session_id: 'sA', at: '2026-08-12T10:03:00Z', tool_name: 'Bash', args: '{"command":"git checkout -b topic"}' },
      { session_id: 'sA', at: '2026-08-12T10:04:00Z', tool_name: 'Bash', args: '{"command":"gh pr create --title x"}' },
      { session_id: 'sA', at: '2026-08-12T10:03:30Z', tool_name: 'Read', args: '{"file_path":"/repo/README.md"}' },
      { session_id: 'sB', at: '2026-08-14T10:01:00Z', tool_name: 'Bash', args: '{"command":"git checkout -b other"}' },
      { session_id: 'sB', at: '2026-08-14T10:02:00Z', tool_name: 'Bash', args: '{"command":"gh pr create --title y"}' },
    ],
    replies: [
      { session_id: 'sA', at: '2026-08-12T09:30:00Z', text: 'Here is the plan for the change, in three parts, before I commit anything at all.' },
      { session_id: 'sA', at: '2026-08-12T10:05:00Z', text: 'Committed on topic and opened PR #720: https://example/pull/720. Tests: 3894 passing, 4 failing, none from this change.' },
    ],
  }
}

test('buildCandidates: steps are the procedure commands after the line, ranked by sessions, with how one session ended', () => {
  // @ref LLP 0398#one-signal [tests]: the skill's steps are what the record shows ran
  const [c] = buildCandidates(commitRows())
  assert.equal(c.line, 'commit on appropriate branch and make a pr')
  assert.equal(c.sessionsWithCalls, 2)
  assert.deepEqual(c.example, { date: '2026-08-12', text: 'commit on appropriate branch and make a PR' })
  assert.deepEqual(c.steps.map((s) => [s.command, s.sessions]), [['git checkout -b', 2], ['gh pr create', 2], ['git status --short', 1], ['npm test 2>&1', 1]])
  assert.ok(!c.steps.some((s) => s.command.startsWith('git log')), 'a command before the trigger is not part of the procedure')
  assert.deepEqual(c.other.map((o) => o.head), ['Read: README.md'])
  assert.equal(c.ending?.date, '2026-08-12')
  assert.match(c.ending?.text ?? '', /^Committed on topic and opened PR #720/, 'the ending is the first substantial reply after the procedure, not before it')
})

test('buildCandidates: the procedure window is timed, not string-compared, across a day boundary', () => {
  // The cache hands a TIMESTAMP column back as a `Date`, and `String(date)`
  // opens on the weekday name, so "Mon Sep 14" sorts before "Sun Sep 13".
  // A session that crosses midnight is the ordinary evening session, and
  // comparing the rendered strings drops every call it made after it.
  const rows = {
    lines: [{ line: 'ship it when the tests are green', sessions: 3, days: 3, typed: 3 }],
    triggers: [{ session_id: 'sA', line: 'ship it when the tests are green', at: new Date('2026-09-13T23:50:00Z'), date: '2026-09-13', example: 'ship it when the tests are green' }],
    calls: [
      { session_id: 'sA', at: new Date('2026-09-13T23:00:00Z'), tool_name: 'Bash', args: '{"command":"git log --oneline -3"}' },
      { session_id: 'sA', at: new Date('2026-09-14T00:05:00Z'), tool_name: 'Bash', args: '{"command":"git checkout -b topic"}' },
      { session_id: 'sA', at: new Date('2026-09-14T00:06:00Z'), tool_name: 'Bash', args: '{"command":"gh pr create --title x"}' },
    ],
    replies: [{ session_id: 'sA', at: new Date('2026-09-14T00:07:00Z'), text: 'Opened the PR on topic and the checks are green.' }],
  }
  const [c] = buildCandidates(rows)
  assert.deepEqual(c.steps.map((step) => step.command), ['git checkout -b', 'gh pr create'])
  assert.ok(!c.steps.some((step) => step.command.startsWith('git log')), 'a call before the trigger is still not part of the procedure')
  assert.equal(c.ending?.date, '2026-09-13')
})

test('buildCandidates: a procedure command past the eight kept is not reported as other activity', () => {
  const verbs = ['git', 'gh', 'npm', 'node', 'hyp', 'make', 'cargo', 'go', 'docker']
  const [c] = buildCandidates({
    lines: [{ line: 'do the release', sessions: 3, days: 3, typed: 3 }],
    triggers: [{ session_id: 's1', line: 'do the release', at: new Date('2026-09-01T10:00:00Z'), date: '2026-09-01', example: 'do the release' }],
    calls: verbs.map((verb, i) => ({ session_id: 's1', at: new Date(`2026-09-01T10:0${i}:30Z`), tool_name: 'Bash', args: `{"command":"${verb} release"}` })),
    replies: [],
  })
  assert.equal(c.steps.length, 8)
  assert.deepEqual(c.other, [], 'the ninth is a step that did not fit, not context')
})

test('enoughRecorded: the record floor and the line floor both have to clear', () => {
  const [c] = buildCandidates(commitRows())
  assert.equal(enoughRecorded({ sessions: 3 }, [c]), false, 'three sessions is not a record')
  assert.equal(enoughRecorded({ sessions: 100 }, [c]), false, 'a line typed in two sessions is not a habit')
  assert.equal(enoughRecorded({ sessions: 100 }, [{ ...c, sessions: RECORD_FLOOR.lineSessions, days: RECORD_FLOOR.lineDays }]), true)
  assert.equal(enoughRecorded({ sessions: 100 }, []), false)
})

test('renderCandidates: a reader-ready page, or the not-enough sentence', () => {
  const cands = buildCandidates(commitRows())
  const page = renderCandidates({ sessions: 100, sessionDays: 120 }, cands, true)
  assert.ok(page.includes('Recorded: 100 sessions over 120 session-days.'))
  assert.ok(page.includes('## 1. "commit on appropriate branch and make a pr"'))
  assert.ok(page.includes('- `git checkout -b` (2)'))
  assert.ok(page.includes('How one ended (2026-08-12): "Committed on topic'))
  const thin = renderCandidates({ sessions: 3, sessionDays: 3 }, cands, false)
  assert.ok(thin.includes('Nothing is typed often enough yet to recommend a skill.'))
  assert.ok(!thin.includes('## 1.'))
})

test('askInstructions: one skill, from the record, in a colleague\'s voice, no queries', () => {
  // @ref LLP 0398#answer-shape [tests]: the answer is a skill the person can read and edit, told plainly
  const text = askInstructions({ scope: 'this machine' })
  assert.ok(text.startsWith('# What to do with this folder\n\nHypAware keeps your AI agents'), 'a cold session is told what HypAware is first')
  assert.ok(text.includes('over the last 30 days for this machine'))
  assert.ok(text.includes('Run no queries and no commands.'))
  assert.ok(text.includes('~/.claude/skills/<name>/SKILL.md, under 25 lines'))
  assert.ok(text.includes('no headings, no bold, no em dashes'))
  assert.ok(!text.includes('\u2014'), 'no em dash in the instructions')
  assert.ok(askInstructions({ scope: 'org acme on the central server', windowDays: 14 }).includes('over the last 14 days for org acme on the central server'))
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
  assert.ok(!again.includes('hook'))
})

test('frontMatterDescription: one line, unquoted, capped, empty without front matter', () => {
  assert.equal(frontMatterDescription('---\nname: x\ndescription: "Does a thing."\n---\nbody'), 'Does a thing.')
  assert.equal(frontMatterDescription('---\ndescription: spans\n---\n'), 'spans')
  assert.equal(frontMatterDescription('# no front matter\ndescription: nope'), '')
  assert.equal(frontMatterDescription('---\ndescription: ' + 'x'.repeat(300) + '\n---\n').length, 200)
})

test('prepareFirstAskEvidence: five queries, three files, one user-only folder rewritten each time', async () => {
  // @ref LLP 0398#run-directory [tests]: one directory, wiped per ask, the client starts inside it
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-runs-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  await fsp.writeFile(path.join(root, 'stale.tsv'), 'from a previous ask\n')
  const rows = commitRows()
  /** @type {string[]} */
  const seen = []
  const runner = {
    hasDataset: () => true,
    async run(sql) {
      seen.push(sql)
      if (sql.includes('as session_days')) return { columns: [], rows: [{ session_days: 130, sessions: 100 }] }
      if (sql.includes('as typed')) return { columns: [], rows: [{ ...rows.lines[0], sessions: 10, days: 7, typed: 12 }] }
      if (sql.includes('as example')) return { columns: [], rows: rows.triggers }
      if (sql.includes("part_type = 'tool_call'")) return { columns: [], rows: rows.calls }
      if (sql.includes("role = 'assistant' and part_type = 'text'")) return { columns: [], rows: rows.replies }
      return { columns: [], rows: [] }
    },
  }
  const evidence = await prepareFirstAskEvidence({ runner, root, homeDir: home, now: new Date('2026-09-07T05:00:00Z') })
  assert.equal(seen.length, 5)
  assert.equal(evidence.dir, root)
  assert.equal(evidence.enough, true)
  assert.equal(evidence.candidates?.[0].steps[0].command, 'git checkout -b')
  assert.deepEqual((await fsp.readdir(root)).sort(), ['ASK.md', 'candidates.md', 'on_disk.txt'], 'the stale file is gone')
  assert.equal((await fsp.stat(root)).mode & 0o777, 0o700)
  const page = await fsp.readFile(path.join(root, 'candidates.md'), 'utf8')
  assert.ok(page.includes('Typed 12 times in 10 sessions on 7 days.'))
})

test('prepareFirstAskEvidence: an empty record writes the not-enough page and runs no session queries', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-runs-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  let queries = 0
  const runner = { hasDataset: () => true, async run() { queries += 1; return { columns: [], rows: [] } } }
  const evidence = await prepareFirstAskEvidence({ runner, root, homeDir: home })
  assert.equal(queries, 2, 'the record probe and the lines probe only')
  assert.equal(evidence.enough, false)
  const page = await fsp.readFile(path.join(root, 'candidates.md'), 'utf8')
  assert.ok(page.includes('Recorded: 0 sessions over 0 session-days.'))
  assert.ok(page.includes('Nothing is typed often enough yet'))
})

test('evidenceSql: the duplicate-lane exclusion is null-safe', () => {
  // `conversation_source` is a nullable column, and `NULL <> 'claude_code'`
  // is NULL, which fails a WHERE. A row with no source label is not a
  // duplicate of anything, so it belongs in the record.
  const sql = evidenceSql('2026-08-08')
  for (const stmt of [sql.record, sql.lines, sql.triggers(['x']), sql.calls([{ id: 's1', at: 0 }]), sql.replies([{ id: 's1', at: 0 }])]) {
    assert.ok(stmt.includes("(conversation_source is null or conversation_source <> 'claude_code')"), 'a null source is kept')
  }
})

test('commandHeads: a call whose command fell outside the args slice is named by its tool, not by raw JSON', () => {
  // The SQL cuts `tool_args` at 160 characters, so a call whose JSON puts a
  // long `description` first loses `command` off the end. The head must not
  // become the truncated blob: it never reads as a step, and it prints the
  // person's own description text into the report.
  const args = JSON.stringify({ description: 'y'.repeat(150), command: 'gh pr create --title x' }).slice(0, 160)
  const [head] = commandHeads([{ session_id: 's1', tool_name: 'Bash', args }])
  assert.equal(head.head, 'Bash')
  assert.ok(!head.head.includes('yyy'), 'no JSON fragment, and no description text, in the head')
})

test('askInstructions and onDiskListing name the tree the reading client actually loads', async () => {
  const codex = { skillDir: '.codex/skills' }
  assert.ok(askInstructions({ scope: 'this machine', client: codex }).includes('~/.codex/skills/<name>/SKILL.md'))
  assert.ok(!askInstructions({ scope: 'this machine', client: codex }).includes('~/.claude/skills/<name>'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  await fsp.mkdir(path.join(home, '.codex', 'skills', 'release'), { recursive: true })
  const text = await onDiskListing({ homeDir: home, client: codex })
  assert.ok(text.includes('## ~/.codex/skills (name: what it is for)\nrelease'))
  assert.ok(!text.includes('agents (name: what it is for)'), 'a client with no agent tree gets no agents section')
})

test('onDiskListing: the 200-entry cap takes the first 200 by name, not by directory order', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-ask-home-'))
  const names = Array.from({ length: 210 }, (_, i) => `skill-${String(i).padStart(3, '0')}`)
  const text = await onDiskListing({
    homeDir: home,
    readdir: /** @type {any} */ (async () => [...names].reverse()),
    readFile: async () => { throw new Error('none') },
  })
  assert.ok(text.includes('skill-000'), 'the sorted head is listed whatever order the filesystem returned')
  assert.ok(!text.includes('skill-209'), 'the sorted tail is what the cap drops')
})

test('the gather is bounded in sessions and in rows, not only by the window', () => {
  // @ref LLP 0398#consequences [tests]: the sample and the shared row budget are what bound the two session lists
  // hypaware #1701: `triggers` returned every session that typed a candidate
  // line in the last 30 days, and the two statements that list rows per
  // session then returned every row of every one of them. The calls
  // statement, measured through the engine on 500 sessions of 300 calls:
  // 150,000 rows, 227 MB peak, 33 MB still held, 16 s. With the sample and
  // the budget: 2,400 rows, 33 MB peak, 0.6 MB held, 3 s.
  const line = 'commit on appropriate branch and make a pr'
  const triggers = Array.from({ length: 500 }, (_, i) => ({
    session_id: `s${String(i).padStart(3, '0')}`,
    line,
    at: new Date(Date.UTC(2026, 7, 10) + i * 60_000),
    date: '2026-08-10',
    example: 'commit on appropriate branch and make a PR',
  }))
  const sample = sampleTriggers(triggers)
  assert.equal(sample.length, 40, 'forty sessions a candidate, not every session that typed the line')
  assert.equal(sample[0].session_id, 's499', 'newest first: what the person does now')
  assert.equal(sample.at(-1)?.session_id, 's460')

  const calls = triggers.map((t) => ({ session_id: t.session_id, at: new Date(Number(t.at) + 1000), tool_name: 'Bash', args: '{"command":"git checkout -b topic"}' }))
  const [c] = buildCandidates({ lines: [{ line, sessions: 500, days: 20, typed: 500 }], triggers, calls, replies: [] })
  assert.equal(c.sessions, 500, 'the line is still reported as typed in every session that typed it')
  assert.equal(c.sessionsWithCalls, 40, 'the procedure was read from the sample, and the page says so')
  assert.deepEqual(c.steps.map((step) => [step.command, step.sessions]), [['git checkout -b', 40]], 'the count beside a step is the sample, not every session')
  assert.ok(renderCandidates({ sessions: 500, sessionDays: 600 }, [c], true).includes('of the 40 sampled sessions whose procedure was read'))

  const anchors = sessionAnchors(sample)
  const sql = evidenceSql('2026-08-08')
  assert.equal(anchors.length, 40, 'one anchor a sampled session, whatever lines it typed')
  assert.ok(sql.calls(anchors).endsWith('limit 2400'), 'sixty rows a sampled session: twice the thirty-call window')
  assert.ok(sql.replies(anchors).endsWith('limit 2400'))
})

test('the sample is bounded across candidate lines, not only within one', () => {
  // The per-line cap bounds one line; the two list statements pay for the
  // sum of every line, once per scanned row for the anchor disjunction and
  // once per named session for the row budget. Five lines in disjoint
  // sessions name 200, and at 200 the statement is slower than the
  // unbounded one it replaces (hypaware #1701 review round 2).
  const at = (i) => new Date(Date.UTC(2026, 7, 10) + i * 60_000)
  const triggers = []
  for (let line = 0; line < 5; line += 1) {
    for (let k = 0; k < 100; k += 1) {
      const i = line * 100 + k
      triggers.push({ session_id: `s${String(i).padStart(3, '0')}`, line: `line ${line}`, at: at(i), date: '2026-08-10', example: `line ${line}` })
    }
  }
  const sample = sampleTriggers(triggers)
  assert.equal(sample.length, 80, 'eighty in all, not five times forty')
  const perLine = new Map()
  for (const t of sample) perLine.set(t.line, (perLine.get(t.line) ?? 0) + 1)
  assert.deepEqual([...perLine.values()], [16, 16, 16, 16, 16], 'the total is divided between the lines, not spent by whichever sorts first')
  assert.equal(sampleTriggers(sample).length, 80, 'sampling a sampled list is still a no-op')
  assert.ok(evidenceSql('2026-08-08').calls(sessionAnchors(sample)).endsWith('limit 4800'), 'the budget follows the bounded sample')

  // One line is untouched by the total: it gets the whole per-line cap.
  const one = sampleTriggers(triggers.filter((t) => t.line === 'line 0'))
  assert.equal(one.length, 40, 'a single candidate line still reads its full forty')
})

test('a trigger instant that cannot be written into SQL costs its own session, not the whole gather', () => {
  // `instant` has a bigint branch, so a message_created_at materialized as
  // epoch nanoseconds is finite but outside the range `new Date(ms)
  // .toISOString()` accepts. Unguarded it threw a RangeError out of
  // `sqlTimestamp`, and the ask ended with no folder at all.
  const good = new Date(Date.UTC(2026, 7, 10, 9, 0, 0))
  const triggers = [
    { session_id: 's1', line: 'ship it', at: 1_755_000_000_000_000_000n },
    { session_id: 's2', line: 'ship it', at: good, date: '2026-08-10', example: 'ship it' },
  ]
  const sample = sampleTriggers(triggers)
  assert.deepEqual(sample.map((t) => t.session_id), ['s2'], 'the unplaceable trigger never takes a slot in the sample')
  const anchors = sessionAnchors(sample)
  assert.deepEqual(anchors, [{ id: 's2', at: good.getTime() }])
  assert.ok(evidenceSql('2026-08-08').calls(anchors).includes("timestamp '2026-08-10T09:00:00.000Z'"), 'the statement is still built, from the session that can be placed')
  assert.deepEqual(sessionAnchors(triggers), [{ id: 's2', at: good.getTime() }], 'and the guard holds if the sample is bypassed')
})

test('an unplaceable trigger does not displace a recent one through a NaN comparator', () => {
  // The bucket sort subtracts two instants, so an unparseable one makes
  // the comparator return NaN, which is not an ordering: V8 leaves such
  // rows wherever they fall, and they were surviving into the newest-forty
  // sample and then being dropped, costing a session its procedure.
  const line = 'ship it'
  const triggers = []
  for (let i = 0; i < 200; i += 1) {
    triggers.push({ session_id: `g${String(i).padStart(3, '0')}`, line, at: new Date(Date.UTC(2026, 7, 10) + i * 60_000) })
    if (i % 4 === 0) triggers.push({ session_id: `b${String(i).padStart(3, '0')}`, line, at: 'not a time' })
  }
  const sample = sampleTriggers(triggers)
  assert.equal(sample.length, 40)
  assert.equal(sample.filter((t) => typeof t.at === 'string').length, 0, 'no unparseable row holds a slot')
  assert.equal(sessionAnchors(sample).length, 40, 'forty sessions sampled is forty sessions anchored')
})

test('sessionAnchors takes the earliest trigger a session has, and drops one it cannot place', () => {
  // A session that typed two candidate lines is read from the earlier of
  // them, or the later line's procedure would start before the rows begin.
  // A trigger whose instant does not parse is dropped rather than read
  // unanchored: `buildCandidates` compares every call against it and NaN
  // compares false, so its rows could only ever be fetched and discarded.
  const early = new Date(Date.UTC(2026, 7, 10, 9, 0, 0))
  const late = new Date(Date.UTC(2026, 7, 10, 17, 0, 0))
  const anchors = sessionAnchors([
    { session_id: 's1', line: 'ship it', at: late },
    { session_id: 's1', line: 'make a pr', at: early },
    { session_id: 's2', line: 'ship it', at: 'not a time' },
    { session_id: '', line: 'ship it', at: early },
  ])
  assert.deepEqual(anchors, [{ id: 's1', at: early.getTime() }])
})

test('the engine reads each session from its trigger, and stops the statement at its budget', async () => {
  // A string assertion cannot say the budget is honored, only that it was
  // written, and it cannot say the rows bought are the rows the page is
  // built from. The statement goes through the same `executeQuerySql` the
  // gather runs on, over three sessions of a hundred calls each with the
  // candidate line typed at the seventieth - the ordinary shape, since a
  // line like "commit on appropriate branch and make a pr" is typed after
  // the work rather than before it.
  const columns = ['date', 'session_id', 'part_type', 'conversation_source', 'message_created_at', 'tool_name', 'tool_args']
  const base = Date.UTC(2026, 7, 10, 1, 0, 0)
  const at = (session, index) => new Date(base + session * 86_400_000 + index * 60_000)
  const rows = Array.from({ length: 300 }, (_, i) => {
    const session = Math.floor(i / 100)
    const index = i % 100
    return {
      date: '2026-08-10',
      session_id: `s${session}`,
      part_type: 'tool_call',
      conversation_source: null,
      message_created_at: at(session, index),
      tool_name: 'Bash',
      tool_args: index < 70 ? '{"command":"npm test --silent"}' : '{"command":"git commit -m wip"}',
    }
  })
  /** @type {AsyncDataSource} */
  const source = {
    columns,
    numRows: rows.length,
    scan(options) {
      const rowColumns = options?.columns ?? columns
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const row of rows) yield asyncRow(row, rowColumns)
        },
      }
    },
  }
  const registry = /** @type {any} */ ({ getDataset: () => ({ discoverPartitions: async () => [], createDataSource: async () => source }), listDatasets: () => [] })
  const storage = /** @type {any} */ ({ cacheRoot: '/tmp/hypaware-test', pendingInfo: async () => ({ pending: false }) })
  const anchors = [0, 1, 2].map((session) => ({ id: `s${session}`, at: at(session, 70).getTime() }))
  const result = await executeQuerySql({ query: evidenceSql('2026-08-08').calls(anchors), registry, storage })

  const perSession = new Map()
  for (const row of result.rows) perSession.set(String(row.session_id), (perSession.get(String(row.session_id)) ?? 0) + 1)
  assert.deepEqual([...perSession.entries()].sort(), [['s0', 30], ['s1', 30], ['s2', 30]], 'every session named is read, not whichever ones sort first')
  assert.ok(result.rows.every((row) => String(row.args).includes('git commit')), 'the rows bought are the procedure after the line, not the work before it')

  // The unanchored form is what the budget starves: 180 rows taken off the
  // front of s0 and s1, none of them after the line, and s2 unread.
  const unanchored = `select session_id, message_created_at as at, substr(cast(tool_args as varchar), 1, 160) as args from ai_gateway_messages where date >= '2026-08-08' and part_type = 'tool_call' and session_id in ('s0', 's1', 's2') order by session_id, message_created_at limit 180`
  const before = await executeQuerySql({ query: unanchored, registry, storage })
  assert.equal(new Set(before.rows.map((row) => String(row.session_id))).size, 2, 'a global budget over whole sessions leaves the last session nothing')
})

test('a candidate reports the sessions whose procedure was read, not the sessions it asked for', () => {
  // The two list statements share one row budget, so a long session can
  // leave a later one with no rows at all. Counting the sampled sessions
  // would print a denominator no step's numerator could reach: "git commit
  // -m (2)" beside "of the 6 most recent".
  const line = 'commit on appropriate branch and make a pr'
  const at = (session) => new Date(Date.UTC(2026, 7, 10, 1, 0, 0) + session * 86_400_000)
  const triggers = Array.from({ length: 6 }, (_, i) => ({ session_id: `s${i}`, line, at: at(i), date: '2026-08-10', example: line }))
  const calls = [0, 1].flatMap((session) => [{ session_id: `s${session}`, at: new Date(at(session).getTime() + 1000), tool_name: 'Bash', args: '{"command":"git commit -m wip"}' }])
  const [c] = buildCandidates({ lines: [{ line, sessions: 6, days: 6, typed: 6 }], triggers, calls, replies: [] })
  assert.equal(c.sessionsWithCalls, 2, 'four of the six returned no rows, and the page does not claim them')
  assert.deepEqual(c.steps.map((step) => [step.command, step.sessions]), [['git commit -m', 2]])
  assert.ok(renderCandidates({ sessions: 60, sessionDays: 90 }, [c], true).includes('(sessions that ran it, of the 2 sampled sessions whose procedure was read)'))
})

// @ts-check

/**
 * Evidence for the recommendation ask (LLP 0398).
 *
 * `hyp ask` asks one question: which skill would be the most useful to
 * add first. HypAware answers the data half before the client starts. It
 * finds the lines the person types again and again, pulls the commands
 * their agent ran after each one and how one such session ended, writes
 * that into a folder with instructions, and starts the client there. The
 * client's job is only to pick the one candidate that is a task, and to
 * write the skill from the steps the record shows.
 *
 * One signal, on purpose. An earlier version measured four (reopened
 * sessions, a repeated line, a request that should go to a worker, a
 * recurring mistake) and chose among them by a rule with floors. The
 * rule needed five corrections on one machine, each for a false signal
 * found by accident, and the skill it produced most often asked the
 * person to change a habit. The repeated line produced the skill the
 * person acted on, its steps matched the record, and the answer came
 * back in under a minute. The other signals are not wrong; they are not
 * the first thing to say.
 *
 * Every query excludes `conversation_source = 'claude_code'`, the OTEL
 * lane that duplicates the transcript lane's rows on machines that
 * attached after 1.31 (hypaware #1464), and every user-text query keeps
 * only human turns: Codex guardian reviews, subagent relays, and
 * injected preambles arrive as `role = 'user'`.
 *
 * @ref LLP 0398#in-process [implements]: HypAware gathers, the client reads; the model never writes SQL for this question
 * @ref LLP 0398#one-signal [implements]: the lines the person types most, and what ran after them
 *
 * @import { OverviewQueryRunner } from '../../../src/core/query/types.js'
 * @import { FirstAskCandidate, FirstAskEvidence } from '../../../src/core/query/types.js'
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { compareStrings } from '../util/compare_strings.js'

/** The suggested-prompt id whose launch is preceded by the gather. */
export const RECOMMEND_PROMPT_ID = 'recommend'

/** Days of history the evidence covers. */
export const EVIDENCE_WINDOW_DAYS = 30

/** The prompt the client is started with. Everything else is in `ASK.md`. */
export const RECOMMEND_LAUNCH_PROMPT =
  'From my HypAware history: what one skill would be the most useful to add first? The evidence is already gathered in this folder. Read ASK.md first and follow it exactly.'

/**
 * The gate. Below it the answer says how much was recorded and stops:
 * a skill proposed from three sessions is a guess dressed as a finding.
 */
export const RECORD_FLOOR = Object.freeze({ sessions: 20, lineSessions: 5, lineDays: 3 })

/** How many repeated lines the client is shown. */
const CANDIDATES = 5

/** Tool calls after the trigger line that count as its procedure. */
const CALLS_AFTER = 30

const NOT_DUPLICATE_LANE = "conversation_source <> 'claude_code'"

const HUMAN_TURN = [
  'coalesce(is_sidechain, false) = false',
  "(user_type is null or user_type in ('external', 'user'))",
  "content_text not like '<%'",
  "content_text not like '[Request%'",
  "content_text not like '# AGENTS.md instructions%'",
  "content_text not like 'Another language model started%'",
  "content_text not like '[$%'",
  "content_text not like 'Base directory for this skill%'",
  "content_text not like 'From my HypAware history%'",
  "content_text not like 'Message Type:%'",
].join(' and ')

/**
 * First day of the window, `days` calendar days before `now`, as
 * `YYYY-MM-DD` in UTC. Dates in the cache are UTC partition dates.
 *
 * @param {Date} now
 * @param {number} [days]
 * @returns {string}
 */
export function windowStart(now, days = EVIDENCE_WINDOW_DAYS) {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
}

/** @param {string} s */
function sqlString(s) {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * The statements, keyed by step. All bounded: aggregates, or lists over
 * a named set of sessions.
 *
 * @param {string} from
 * @returns {{
 *   record: string,
 *   lines: string,
 *   triggers: (lines: string[]) => string,
 *   calls: (sessionIds: string[]) => string,
 *   replies: (sessionIds: string[]) => string,
 * }}
 */
export function evidenceSql(from) {
  const human = `role = 'user' and part_type = 'text' and ${NOT_DUPLICATE_LANE} and ${HUMAN_TURN}`
  return {
    record: `select count(*) as session_days, count(distinct session_id) as sessions from (select session_id, date from ai_gateway_messages where date >= '${from}' and role = 'assistant' and ${NOT_DUPLICATE_LANE} group by 1, 2) s`,
    lines: `select lower(substr(content_text, 1, 42)) as line, count(distinct session_id) as sessions, count(distinct date) as days, count(*) as typed from ai_gateway_messages where date >= '${from}' and ${human} and length(content_text) between 12 and 160 group by 1 having count(distinct session_id) >= 3 and count(distinct date) >= 3 order by sessions desc limit ${CANDIDATES + 3}`,
    triggers: (lines) => `select session_id, lower(substr(content_text, 1, 42)) as line, min(message_created_at) as at, min(date) as date, min(substr(content_text, 1, 160)) as example from ai_gateway_messages where date >= '${from}' and ${human} and lower(substr(content_text, 1, 42)) in (${lines.map(sqlString).join(', ')}) group by 1, 2`,
    calls: (ids) => `select session_id, message_created_at as at, tool_name, substr(cast(tool_args as varchar), 1, 160) as args from ai_gateway_messages where date >= '${from}' and part_type = 'tool_call' and ${NOT_DUPLICATE_LANE} and session_id in (${ids.map(sqlString).join(', ')}) order by session_id, message_created_at`,
    replies: (ids) => `select session_id, message_created_at as at, substr(content_text, 1, 500) as text from ai_gateway_messages where date >= '${from}' and role = 'assistant' and part_type = 'text' and length(content_text) > 200 and ${NOT_DUPLICATE_LANE} and session_id in (${ids.map(sqlString).join(', ')}) order by session_id, message_created_at`,
  }
}

/**
 * Group tool calls by a short head, the way a reader would name them.
 *
 * @param {Record<string, unknown>[]} calls
 * @returns {{ head: string, n: number, sessions: number }[]}
 */
export function commandHeads(calls) {
  /** @type {Map<string, { n: number, sessions: Set<string> }>} */
  const heads = new Map()
  for (const r of calls) {
    const tool = String(r.tool_name ?? '?')
    const args = String(r.args ?? '')
    let key = tool
    if (tool === 'Bash' || tool === 'exec') {
      const m = /"command"\s*:\s*"((?:[^"\\]|\\.){0,160})/.exec(args)
      let cmd = (m ? m[1] : args).replace(/\\n/g, ' ')
      cmd = cmd.replace(/^cd\s+\S+\s*(&&|;|\|\|)?\s*/, '')
      const words = cmd.split(/\s+/).filter(Boolean)
      const take = ['hyp', 'gh', 'git', 'npm', 'node', 'curl'].includes(words[0] ?? '') ? 3 : 2
      key = `${tool}: ${words.slice(0, take).join(' ')}`
    } else if (['Read', 'Edit', 'Write', 'Grep', 'Glob'].includes(tool)) {
      const m = /"(?:file_path|pattern|path)"\s*:\s*"([^"]{0,120})/.exec(args)
      key = `${tool}: ${m ? path.basename(m[1]) : ''}`
    } else if (tool === 'Skill') {
      const m = /"skill"\s*:\s*"([^"]{0,60})/.exec(args)
      key = `Skill: ${m ? m[1] : ''}`
    }
    const entry = heads.get(key) ?? { n: 0, sessions: new Set() }
    entry.n += 1
    entry.sessions.add(String(r.session_id ?? ''))
    heads.set(key, entry)
  }
  return [...heads.entries()]
    .map(([head, e]) => ({ head, n: e.n, sessions: e.sessions.size }))
    .sort((a, b) => b.n - a.n)
}

/** A command head that is a step of a procedure, not a read. */
const STEP_HEAD = /^(Bash|exec): (git|gh|npm|node|hyp|make|pnpm|yarn|cargo|pytest|go|docker|curl) /

/**
 * Build the candidates from the raw rows. Pure, so it is testable
 * without a cache.
 *
 * @param {{
 *   lines: Record<string, unknown>[],
 *   triggers: Record<string, unknown>[],
 *   calls: Record<string, unknown>[],
 *   replies: Record<string, unknown>[],
 * }} rows
 * @returns {FirstAskCandidate[]}
 */
export function buildCandidates(rows) {
  /**
   * @param {Record<string, unknown>[]} list
   * @returns {Map<string, Record<string, unknown>[]>}
   */
  const bySession = (list) => {
    /** @type {Map<string, Record<string, unknown>[]>} */
    const m = new Map()
    for (const r of list) {
      const k = String(r.session_id ?? '')
      const bucket = m.get(k)
      if (bucket) bucket.push(r)
      else m.set(k, [r])
    }
    return m
  }
  const callsBy = bySession(rows.calls)
  const repliesBy = bySession(rows.replies)
  /** @type {FirstAskCandidate[]} */
  const out = []
  for (const l of rows.lines) {
    const line = String(l.line ?? '')
    const hits = rows.triggers.filter((t) => String(t.line ?? '') === line)
    /** @type {Record<string, unknown>[]} */
    const after = []
    /** @type {{ date: string, text: string } | undefined} */
    let ending
    for (const h of hits) {
      const sid = String(h.session_id ?? '')
      const at = String(h.at ?? '')
      const window = (callsBy.get(sid) ?? []).filter((c) => String(c.at ?? '') >= at).slice(0, CALLS_AFTER)
      after.push(...window)
      if (!ending) {
        const end = String(window.at(-1)?.at ?? at)
        const reply = (repliesBy.get(sid) ?? []).find((r) => String(r.at ?? '') > end)
        if (reply) ending = { date: String(h.date ?? ''), text: oneLine(String(reply.text ?? '')) }
      }
    }
    const heads = commandHeads(after)
    const steps = heads.filter((h) => STEP_HEAD.test(h.head)).sort((a, b) => b.sessions - a.sessions).slice(0, 8)
    const other = heads.filter((h) => !steps.includes(h)).slice(0, 5)
    const first = hits.slice().sort((a, b) => compareStrings(String(a.date), String(b.date)))[0]
    out.push({
      line,
      sessions: num(l.sessions),
      days: num(l.days),
      typed: num(l.typed),
      example: first ? { date: String(first.date ?? ''), text: oneLine(String(first.example ?? '')) } : undefined,
      sessionsWithCalls: hits.length,
      steps: steps.map((h) => ({ command: h.head.replace(/^(Bash|exec): /, ''), sessions: h.sessions })),
      other: other.map((h) => ({ head: h.head, sessions: h.sessions })),
      ending,
    })
  }
  return out
}

/**
 * Whether there is enough recorded to recommend from.
 *
 * @param {{ sessions: number }} record
 * @param {FirstAskCandidate[]} candidates
 * @returns {boolean}
 */
export function enoughRecorded(record, candidates) {
  return record.sessions >= RECORD_FLOOR.sessions
    && candidates.some((c) => c.sessions >= RECORD_FLOOR.lineSessions && c.days >= RECORD_FLOOR.lineDays)
}

/**
 * `candidates.md`: the repeated lines, each with the steps that ran after
 * it and how one such session ended. Written for a reader, so the client
 * has nothing to join.
 *
 * @param {{ sessions: number, sessionDays: number }} record
 * @param {FirstAskCandidate[]} candidates
 * @param {boolean} enough
 * @returns {string}
 */
export function renderCandidates(record, candidates, enough) {
  const head = [
    `# What you type again and again, last ${EVIDENCE_WINDOW_DAYS} days`,
    '',
    `Recorded: ${record.sessions} sessions over ${record.sessionDays} session-days.`,
    '',
  ]
  if (!enough) return head.concat(['Nothing is typed often enough yet to recommend a skill.', '']).join('\n')
  const body = candidates.map((c, i) => [
    `## ${i + 1}. "${c.line}"`,
    `Typed ${c.typed} times in ${c.sessions} sessions on ${c.days} days.${c.example ? ` Example, ${c.example.date}: "${c.example.text}"` : ''}`,
    '',
    `Commands that ran in the ${CALLS_AFTER} tool calls after it (sessions that ran it, of ${c.sessionsWithCalls}):`,
    ...(c.steps.length > 0 ? c.steps.map((s) => `- \`${s.command}\` (${s.sessions})`) : ['- (no standard commands)']),
    `Other activity: ${c.other.map((o) => `${o.head} (${o.sessions})`).join('; ') || 'none'}`,
    ...(c.ending ? ['', `How one ended (${c.ending.date}): "${c.ending.text}"`] : []),
    '',
  ].join('\n'))
  return head.concat(body).join('\n')
}

/**
 * The instructions the client reads. Written for a reader who will give
 * the answer ten seconds.
 *
 * @ref LLP 0398#answer-shape [implements]: a colleague's voice, the skill, the offer, one line of sources
 * @param {{ scope: string, windowDays?: number }} meta
 * @returns {string}
 */
export function askInstructions(meta) {
  const days = meta.windowDays ?? EVIDENCE_WINDOW_DAYS
  return `# What to do with this folder

HypAware keeps your AI agents' sessions, logs, and telemetry in one queryable history. This folder holds what the person typed again and again over the last ${days} days for ${meta.scope}, and what their agent then did, so you can recommend the one skill worth adding first.

## Files
- \`candidates.md\`: the lines typed in the most sessions, each with the commands that ran after it and how one such session ended.
- \`on_disk.txt\`: skills and agents already installed, with what each is for.

## Rules
- Pick the one candidate a skill would help most: a task done the same way each time that the agent currently works out from scratch. A line that is not a task (a check like "is claude working?", resuming a session, a one-word reply) is not a candidate.
- If candidates.md says nothing is typed often enough, say how much was recorded and that there is not enough yet, and stop.
- The skill goes in ~/.claude/skills/<name>/SKILL.md, under 25 lines. Its description opens with the phrase as the person types it. Its steps are the commands the file shows ran, in order, plus what the ending shows the person wanted reported.
- If a skill on the subject already exists per on_disk.txt, change it rather than adding a second.
- Run no queries and no commands. Read each file once. Standard commands need no testing.

## Answer
Write it the way you would tell a colleague what you found: short paragraphs, plain words, no headings, no bold, no em dashes, no file names or session ids in the text. Open with what you looked through and what stood out. Then what the skill does and the phrase that triggers it, and why this one. Then one real example with its date. Then "Here's the skill I'd add:", the path, and the SKILL.md in a fenced block. Then ask whether to add it, in one sentence. Then one line starting "Sources:" with the candidate number and figures you used. Under 120 words before the block.
`
}

/**
 * What is already installed for the client on this machine, so the
 * answer can change an existing skill rather than add a second. Skills
 * and agents are listed with the description their front matter
 * declares. Hooks are not listed: they are not a change the ask
 * proposes. Best-effort and bounded.
 *
 * @param {{ homeDir: string, readdir?: typeof fsp.readdir, readFile?: typeof fsp.readFile }} args
 * @returns {Promise<string>}
 */
export async function onDiskListing({ homeDir, readdir = fsp.readdir, readFile = fsp.readFile }) {
  /** @param {string} dir */
  const list = async (dir) => {
    try {
      return (await readdir(dir)).filter((n) => !n.startsWith('.')).slice(0, 200).sort()
    } catch {
      return []
    }
  }
  /** @param {string} file */
  const description = async (file) => {
    try {
      return frontMatterDescription(await readFile(file, 'utf8'))
    } catch {
      return ''
    }
  }
  const skillsDir = path.join(homeDir, '.claude', 'skills')
  const agentsDir = path.join(homeDir, '.claude', 'agents')
  /** @type {string[]} */
  const skills = []
  for (const name of await list(skillsDir)) {
    const d = await description(path.join(skillsDir, name, 'SKILL.md'))
    skills.push(d ? `${name}: ${d}` : name)
  }
  /** @type {string[]} */
  const agents = []
  for (const name of await list(agentsDir)) {
    if (!name.endsWith('.md')) continue
    const d = await description(path.join(agentsDir, name))
    agents.push(d ? `${name.slice(0, -3)}: ${d}` : name.slice(0, -3))
  }
  let claudeMd = 'absent'
  try {
    await readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf8')
    claudeMd = 'present'
  } catch {
    // absent
  }
  return [
    '## ~/.claude/skills (name: what it is for)',
    ...(skills.length > 0 ? skills : ['(none)']),
    '',
    '## ~/.claude/agents (name: what it is for)',
    ...(agents.length > 0 ? agents : ['(none)']),
    '',
    '## ~/.claude/CLAUDE.md',
    claudeMd,
    '',
  ].join('\n')
}

/**
 * The `description:` value of a Markdown file's front matter, one line,
 * cut at 200 characters. Empty when there is no front matter or no
 * description.
 *
 * @param {string} text
 * @returns {string}
 */
export function frontMatterDescription(text) {
  if (!text.startsWith('---')) return ''
  const end = text.indexOf('\n---', 3)
  const head = end >= 0 ? text.slice(3, end) : text.slice(3, 4000)
  const m = /^description:\s*(.*)$/m.exec(head)
  if (!m) return ''
  let value = m[1].trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
  return oneLine(value).slice(0, 200)
}

/**
 * Run the whole gather for one launch into `root`, which is emptied first
 * and created user-only: the files quote the person's own typed lines,
 * and on a shared machine the temp directory is not private by default.
 * One folder, replaced on every ask; nothing reads it afterwards.
 *
 * @ref LLP 0398#run-directory [implements]: one directory, wiped and rewritten per ask, and the client starts inside it
 * @param {{
 *   runner: OverviewQueryRunner,
 *   root: string,
 *   homeDir: string,
 *   now?: Date,
 *   scope?: string,
 *   windowDays?: number,
 *   say?: (line: string) => void,
 * }} args
 * @returns {Promise<FirstAskEvidence>}
 */
export async function prepareFirstAskEvidence({ runner, root, homeDir, now = new Date(), scope = 'this machine', windowDays = EVIDENCE_WINDOW_DAYS, say = () => {} }) {
  const from = windowStart(now, windowDays)
  const sql = evidenceSql(from)
  say(`Looking through the last ${windowDays} days...`)
  const recordRow = (await runner.run(sql.record)).rows[0] ?? {}
  const record = { sessions: num(recordRow.sessions), sessionDays: num(recordRow.session_days) }
  const lines = (await runner.run(sql.lines)).rows
    .filter((r) => {
      const line = String(r.line ?? '')
      return !line.includes('\n') && !/^[{"<#>[]/.test(line.trim())
    })
    .slice(0, CANDIDATES)
  /** @type {FirstAskCandidate[]} */
  let candidates = []
  if (lines.length > 0) {
    const triggers = (await runner.run(sql.triggers(lines.map((l) => String(l.line ?? ''))))).rows
    const ids = [...new Set(triggers.map((t) => String(t.session_id ?? '')))].filter(Boolean)
    const calls = ids.length > 0 ? (await runner.run(sql.calls(ids))).rows : []
    const replies = ids.length > 0 ? (await runner.run(sql.replies(ids))).rows : []
    candidates = buildCandidates({ lines, triggers, calls, replies })
  }
  const enough = enoughRecorded(record, candidates)
  const files = [
    { name: 'candidates.md', content: renderCandidates(record, candidates, enough) },
    { name: 'on_disk.txt', content: await onDiskListing({ homeDir }) },
    { name: 'ASK.md', content: askInstructions({ scope, windowDays }) },
  ]
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.mkdir(root, { recursive: true, mode: 0o700 })
  for (const f of files) await fsp.writeFile(path.join(root, f.name), f.content, 'utf8')
  return { dir: root, from, record, enough, candidates, files: files.map((f) => f.name) }
}

/** @param {unknown} v */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** @param {string} s */
function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim()
}

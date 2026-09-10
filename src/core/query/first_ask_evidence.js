// @ts-check

/**
 * Evidence for the recommendation ask (LLP 0395).
 *
 * `hyp ask` offers one question whose answer is a skill rather than a
 * number: "what one skill would be the most useful to add first". A cold
 * client cannot answer that well from SQL it writes itself, and the
 * recorded attempts show why: runs that saw only aggregate rows proposed
 * changes that were wrong, and runs that fetched their own evidence spent
 * most of their time on queries and sleeps. So HypAware does the data work
 * before the client starts. It measures four signals, picks the route by
 * a rule that lives in this file, pulls only that route's evidence into a
 * run directory, and starts the client in that directory with a short
 * prompt pointing at `ASK.md`.
 *
 * Every query here excludes `conversation_source = 'claude_code'`, the
 * OTEL lane that duplicates the transcript lane's rows on machines that
 * attached after 1.31 (hypaware #1464). Every user-text query is limited
 * to human turns: Codex guardian reviews and subagent relays arrive as
 * `role = 'user'` and swamped the typed-line signal on the first org run.
 *
 * @ref LLP 0395#in-process [implements]: HypAware gathers, the client reads; the model never writes SQL for this question
 * @ref LLP 0395#route-rule [implements]: the route is chosen here, by a stated rule, not by the model
 *
 * @import { OverviewQueryRunner } from '../../../src/core/query/types.js'
 * @import { FirstAskRoute, FirstAskSignals, FirstAskEvidence, FirstAskEvidenceFile } from '../../../src/core/query/types.js'
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { compareStrings } from '../util/compare_strings.js'
import { groupThousands } from '../util/format_number.js'

/** The suggested-prompt id whose launch is preceded by the gather. */
export const RECOMMEND_PROMPT_ID = 'recommend'

/** Days of history the evidence covers. */
export const EVIDENCE_WINDOW_DAYS = 30

/** The prompt the client is started with. Everything else is in `ASK.md`. */
export const RECOMMEND_LAUNCH_PROMPT =
  'From my HypAware history: what one skill would be the most useful to add first? The evidence is already gathered in this folder. Read ASK.md first and follow it exactly.'

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
  // A relay header some harnesses paste into Codex as user text; on the
  // first org run it became the "recurring request" of a whole answer.
  "content_text not like 'Message Type:%'",
].join(' and ')

/**
 * Tool results that are the harness asking a person, not a tool failing.
 * Left in, they dominate the rule signal on any machine that runs
 * non-interactive sessions with an allowlist, and none of them is a
 * mistake an instruction could prevent.
 */
const NOT_PERMISSION_PROMPT = [
  "content_text not like 'The user doesn%'",
  "content_text not like 'Permission for this action%'",
  "content_text not like 'This Bash command contains multiple operations%'",
  "content_text not like 'This command requires approval%'",
  "content_text not like 'Claude requested permissions%'",
  "content_text not like '%was blocked. For security%'",
  "content_text not like '%cannot be auto-allowed%'",
].join(' and ')

const USAGE_CTX = [
  "coalesce(cast(json_extract(attributes, '$.usage.input_tokens') as bigint), 0)",
  "coalesce(cast(json_extract(attributes, '$.usage.cache_read_tokens') as bigint), 0)",
  "coalesce(cast(json_extract(attributes, '$.usage.cache_write_tokens') as bigint), 0)",
].join(' + ')
const USAGE_OUT = "coalesce(cast(json_extract(attributes, '$.usage.output_tokens') as bigint), 0)"

/**
 * Route floors and the precedence used when two routes tie.
 *
 * A floor is the smallest signal worth acting on. Below every floor the
 * ask stops with "not enough recorded yet" rather than proposing from
 * noise. The floors were set from the first fleet run: two orgs sat at
 * 9.7 and 9.8 percent on the sink, which is exactly the margin a floor is
 * for, so it is a number an operator may want to revisit and it lives
 * here, once.
 *
 * @ref LLP 0395#route-rule [implements]: floors and precedence in one place
 */
export const ROUTE_FLOORS = Object.freeze({
  sink: 0.10,
  skill: { sessions: 10, days: 5 },
  /**
   * Estimated re-sent cost of inline reading on heavy days with no
   * dispatch, as a share of all context tokens: the same currency as the
   * sink, so the two compare. The route also needs a recurring task (a
   * typed line or a brief seen in 3+ sessions), because "delegate more"
   * is not a change a person can make; a named worker for a request they
   * already type is.
   */
  subagent: 0.10,
  subagentRecurring: 3,
  rule: { sessions: 5, days: 3 },
})

/**
 * Relative price per token, fresh input = 1. A cache read is cheap and
 * there are billions of them; an output token is dear and there are
 * millions. Counting them alike is how an earlier generation of reports
 * fixated on cached tokens, so both token signals (sink, subagent) are
 * measured in these units and `triage.txt` prints the raw share beside
 * the cost share. Anthropic list ratios; OpenAI's cached-input discount
 * is in the same range.
 *
 * @ref LLP 0395#route-rule [implements]: token signals are cost-weighted, never raw counts
 */
export const PRICE_RATIO = Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 })

/** @type {ReadonlyArray<FirstAskRoute>} */
const PRECEDENCE = Object.freeze(['sink', 'skill', 'subagent', 'rule'])

/**
 * The skill each route points to. The answer is always one skill: a
 * SKILL.md the person can read, trigger by a phrase they already type,
 * and edit, which is the most actionable place to start and the one
 * change that lands on the first day. The signals decide which skill.
 *
 * @ref LLP 0395#always-a-skill [implements]: four signals, one kind of answer
 */
export const ROUTE_SKILLS = Object.freeze({
  sink: "a handoff skill: at the end of a day's work it writes a short note (goal, files touched, decisions, next step) so tomorrow starts in a fresh session from the note instead of reopening the old one",
  skill: 'a skill for exactly that procedure, triggered by the phrase as the person types it, whose steps are the commands the record shows ran after it',
  subagent: 'a skill for that recurring request whose body hands the reading to a worker (an Explore or general-purpose subagent, or a shell reduction where the client has no subagent) and keeps the raw output out of the main conversation',
  rule: 'a skill for the task in which the mistake keeps happening, with the correct form built into its steps so the wrong one is never typed again',
})

/**
 * A draft SKILL.md for the route, built from the evidence, so the client
 * tailors a draft instead of composing from nothing. Composition was where
 * the cold session spent its minutes: three silent reasoning stretches of
 * 44, 84 and 76 seconds in one run, all before a word of the skill
 * appeared. The draft is deliberately plain; the session's job is to fit
 * the trigger phrases and the steps to what the record shows and to say
 * why in the answer.
 *
 * @ref LLP 0395#always-a-skill [implements]: HypAware drafts, the client tailors
 * @param {FirstAskRoute} route
 * @param {FirstAskSignals} s
 * @param {{ steps?: { head: string, n: number, sessions: number }[] }} [extra]
 * @returns {string}
 */
export function draftSkill(route, s, extra = {}) {
  switch (route) {
    case 'sink':
      return `---
name: handoff
description: "continue from where you left off", "pick up where we left off", "wrap up for today". Ends a day's work with a short note (goal, files touched, decisions, next step) and starts the next day from that note in a fresh session instead of reopening the old one. Offer it unprompted when a day's work is winding down.
---
# Handoff

The note is \`.claude/handoff.md\` in the folder being worked in. One note; overwrite it.

## Wrapping up
1. From this conversation: the goal in one line, the files touched, the decisions made and why, the exact next step, any open error pasted verbatim.
2. Write the note with the Write tool, under 30 lines.
3. Say: "Handoff written. Tomorrow, open a fresh session here and say: continue from where you left off."

## Continuing
1. Read \`.claude/handoff.md\`. If it is missing, say so and ask what to pick up; do not resume the old session.
2. Restate the goal and the next step in two lines, then start on the next step.

A skill cannot stop a session being resumed; it makes starting fresh the cheaper habit.
`
    case 'skill': {
      const phrase = s.skill?.line ?? 'the phrase you type'
      const steps = (extra.steps ?? []).filter((h) => /^Bash: (git|gh|npm|node|hyp|make|pnpm|yarn|cargo|pytest|go) /.test(h.head)).slice(0, 8)
      const body = steps.length > 0
        ? steps.map((h, i) => `${i + 1}. \`${h.head.replace(/^Bash: /, '')}\` (ran in ${h.sessions} of the sessions)`).join('\n')
        : '1. (the steps the record shows; see trigger.commands.tsv)'
      return `---
name: ${phrase.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'procedure'}
description: "${phrase}". Use for any wording of that request. Runs the same steps every time and reports what it did.
---
# ${phrase}

${body}

Report at the end: what was run, what was green, and anything left undone.
`
    }
    case 'subagent': {
      const phrase = s.subagent.recurring?.text ?? 'the recurring request'
      return `---
name: ${phrase.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'delegated-request'}
description: "${phrase}". Hands the reading to a worker and keeps raw output out of this conversation.
---
# ${phrase}

1. Do not read the files or run the searches here.
2. Dispatch one Explore subagent with the request and the paths that matter. Ask it to return under 30 lines: the answer, file:line citations, and any command that failed. No file contents, no raw output.
3. Act on the summary. Read a file yourself only if you are about to change it.

If this client has no subagent (Codex), reduce in the shell instead: counts and file lists first, then only the lines you need.
`
    }
    case 'rule': {
      const head = s.rule?.head ?? 'the recurring error'
      return `---
name: (the task this mistake happens in)
description: "(the phrase you type for that task)". Runs it the way that works; the wrong form that fails with "${head.slice(0, 60)}" is never typed.
---
# (task)

1. (the correct form of the step that keeps failing, with the exact command)
2. (the rest of the task's steps as the record shows them)

If this is a trap in a skill HypAware ships, say so in the answer: the lasting fix belongs there and this skill is a stopgap.
`
    }
    default:
      return ''
  }
}

/** What each route means, in the reader's words; the ids are internal. */
export const ROUTE_LABELS = Object.freeze({
  sink: 'reopened sessions',
  skill: 'something you keep typing',
  subagent: 'a request that should go to a worker',
  rule: 'a mistake that keeps recurring',
})

/**
 * One sentence per chosen route naming what was found, so a reader of
 * `ASK.md` or `triage.txt` never meets a bare route id.
 *
 * @param {FirstAskRoute} route
 * @param {FirstAskSignals} s
 * @returns {string}
 */
export function describeRoute(route, s) {
  switch (route) {
    case 'sink':
      return `${ROUTE_LABELS.sink}: ${(s.sink.share * 100).toFixed(1)}% of all spend is excess on the ${s.sink.reopenedDays} days a session was reopened.`
    case 'skill':
      return s.skill
        ? `${ROUTE_LABELS.skill}: "${s.skill.line}" typed in ${s.skill.sessions} sessions on ${s.skill.days} days.`
        : `${ROUTE_LABELS.skill}.`
    case 'subagent':
      return s.subagent.recurring
        ? `${ROUTE_LABELS.subagent}: "${s.subagent.recurring.text}" recurs in ${s.subagent.recurring.sessions} sessions, and inline reading on such days is ${(s.subagent.costShare * 100).toFixed(1)}% of all spend.`
        : `${ROUTE_LABELS.subagent}.`
    case 'rule':
      return s.rule
        ? `${ROUTE_LABELS.rule}: "${s.rule.head.slice(0, 80)}" failed in ${s.rule.sessions} sessions on ${s.rule.days} days (${s.rule.n} times).`
        : `${ROUTE_LABELS.rule}.`
    default:
      return String(route)
  }
}

/**
 * First day of the window, `days` calendar days before `now`, as
 * `YYYY-MM-DD` in UTC. Dates in the cache are UTC partition dates.
 *
 * @param {Date} now
 * @param {number} [days]
 * @returns {string}
 */
export function windowStart(now, days = EVIDENCE_WINDOW_DAYS) {
  const d = new Date(now.getTime() - days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

/**
 * The four triage statements plus the record-size probe, keyed by signal.
 * Every statement is bounded: an aggregate, or a `limit`ed list.
 *
 * @param {string} from
 * @returns {Record<'sink' | 'cont' | 'skill' | 'rule' | 'subagent' | 'briefs', string>}
 */
export function triageSql(from) {
  return {
    sink: `select session_id, date, sum(${USAGE_CTX}) as ctx, sum(${USAGE_OUT}) as outp, sum(coalesce(cast(json_extract(attributes, '$.usage.input_tokens') as bigint), 0)) as inp, sum(coalesce(cast(json_extract(attributes, '$.usage.cache_read_tokens') as bigint), 0)) as cr, sum(coalesce(cast(json_extract(attributes, '$.usage.cache_write_tokens') as bigint), 0)) as cw from ai_gateway_messages where date >= '${from}' and role = 'assistant' and ${NOT_DUPLICATE_LANE} group by 1, 2`,
    cont: `select count(*) as typed, count(distinct session_id) as sessions from ai_gateway_messages where date >= '${from}' and role = 'user' and part_type = 'text' and ${NOT_DUPLICATE_LANE} and lower(content_text) like 'continue from where you left off%'`,
    skill: `select lower(substr(content_text, 1, 42)) as line, count(distinct session_id) as sessions, count(distinct date) as days, count(*) as typed from ai_gateway_messages where date >= '${from}' and role = 'user' and part_type = 'text' and ${NOT_DUPLICATE_LANE} and ${HUMAN_TURN} and lower(content_text) not like 'continue from where you left off%' and length(content_text) between 12 and 160 group by 1 having count(distinct session_id) >= 3 and count(distinct date) >= 3 order by sessions desc limit 8`,
    rule: `select tool_name, substr(content_text, 1, 80) as head, count(*) as n, count(distinct session_id) as sessions, count(distinct date) as days from ai_gateway_messages where date >= '${from}' and part_type = 'tool_result' and is_error and ${NOT_DUPLICATE_LANE} and ${NOT_PERMISSION_PROMPT} group by 1, 2 having count(distinct session_id) >= 3 order by sessions desc limit 8`,
    subagent: `select session_id, date, count(*) filter (where part_type = 'tool_call' and tool_name in ('Read', 'Grep', 'Glob')) as reads, count(*) filter (where part_type = 'tool_call' and tool_name = 'Agent') as dispatches, count(*) filter (where part_type = 'tool_call') as calls, count(*) filter (where part_type = 'text' and role = 'assistant') as turns, sum(length(content_text)) filter (where part_type = 'tool_result') as result_bytes from ai_gateway_messages where date >= '${from}' and ${NOT_DUPLICATE_LANE} and (part_type in ('tool_call', 'tool_result') or (part_type = 'text' and role = 'assistant')) group by 1, 2 having count(*) filter (where part_type = 'tool_call') >= 40`,
    briefs: `select substr(regexp_extract(cast(tool_args as varchar), '"description"\\s*:\\s*"([^"]{1,60})', 1), 1, 60) as brief, count(distinct session_id) as sessions from ai_gateway_messages where date >= '${from}' and part_type = 'tool_call' and tool_name = 'Agent' and ${NOT_DUPLICATE_LANE} group by 1 having count(distinct session_id) >= ${ROUTE_FLOORS.subagentRecurring} order by sessions desc limit 3`,
  }
}

/**
 * Turn the five result sets into signals. Pure, so the rule is testable
 * without a cache.
 *
 * @param {{
 *   sink: Record<string, unknown>[],
 *   cont: Record<string, unknown>[],
 *   skill: Record<string, unknown>[],
 *   rule: Record<string, unknown>[],
 *   subagent: Record<string, unknown>[],
 *   briefs?: Record<string, unknown>[],
 *   recurring?: Record<string, unknown>[],
 * }} rows
 * @returns {FirstAskSignals}
 */
export function computeSignals(rows) {
  /** @type {Map<string, { ctx: number, outp: number, cost: number }[]>} */
  const bySession = new Map()
  for (const r of rows.sink) {
    const key = String(r.session_id ?? '')
    const list = bySession.get(key) ?? []
    // Cost in fresh-input units. A row from the raw count only (no split
    // columns) is priced as if all context were cache reads, the common
    // case, so a partial runner still ranks sensibly.
    const ctx = num(r.ctx)
    const split = r.inp !== undefined || r.cr !== undefined || r.cw !== undefined
    const cost = split
      ? num(r.inp) * PRICE_RATIO.input + num(r.cr) * PRICE_RATIO.cacheRead + num(r.cw) * PRICE_RATIO.cacheWrite + num(r.outp) * PRICE_RATIO.output
      : ctx * PRICE_RATIO.cacheRead + num(r.outp) * PRICE_RATIO.output
    list.push({ ctx, outp: num(r.outp), cost })
    bySession.set(key, list)
  }
  let total = 0, totalCost = 0, singleCtx = 0, singleOut = 0, singleCost = 0, laterCtx = 0, laterOut = 0, sessionDays = 0
  /** @type {{ ctx: number, outp: number, cost: number }[]} */
  const later = []
  for (const list of bySession.values()) {
    sessionDays += list.length
    for (const r of list) { total += r.ctx; totalCost += r.cost }
    if (list.length === 1) {
      singleCtx += list[0].ctx
      singleOut += list[0].outp
      singleCost += list[0].cost
    } else {
      // The runner returns session-days in no promised order; the first
      // day of a session is the one with the fewest re-sent turns, so the
      // smallest context/output ratio stands in for "first".
      const sorted = [...list].sort((a, b) => (a.ctx / Math.max(a.outp, 1)) - (b.ctx / Math.max(b.outp, 1)))
      for (const r of sorted.slice(1)) later.push(r)
    }
  }
  for (const r of later) { laterCtx += r.ctx; laterOut += r.outp }
  const fresh = singleCtx / Math.max(singleOut, 1)
  const reopened = laterCtx / Math.max(laterOut, 1)
  const freshCost = singleCost / Math.max(singleOut, 1)
  let excess = 0, excessCost = 0
  for (const r of later) {
    const e = r.ctx - fresh * r.outp
    if (e > 0) excess += e
    const ec = r.cost - freshCost * r.outp
    if (ec > 0) excessCost += ec
  }
  const cont = rows.cont[0] ?? {}
  const topLine = rows.skill[0]
  const topRule = rows.rule[0]
  const heavy = rows.subagent
  const noDispatch = heavy.filter((r) => num(r.dispatches) === 0)
  // Re-sent cost of inline reading, estimated: a result read into context
  // is sent again on every later turn, so on average for half the turns
  // of its day. Four bytes per token is the usual English ratio and is
  // stated as an estimate wherever the number is printed.
  // Re-sent bytes come back as cache reads, so they are priced as such.
  let inlineCost = 0
  for (const r of noDispatch) inlineCost += (num(r.result_bytes) / 4) * (num(r.turns) / 2) * PRICE_RATIO.cacheRead
  const brief = (rows.briefs ?? [])[0]
  const line = (rows.recurring ?? [])[0]
  /** @type {{ kind: 'brief' | 'line', text: string, sessions: number } | undefined} */
  let recurring
  if (line && num(line.sessions) >= ROUTE_FLOORS.subagentRecurring) recurring = { kind: 'line', text: String(line.line ?? ''), sessions: num(line.sessions) }
  else if (brief && num(brief.sessions) >= ROUTE_FLOORS.subagentRecurring) recurring = { kind: 'brief', text: String(brief.brief ?? ''), sessions: num(brief.sessions) }
  return {
    record: { sessions: bySession.size, sessionDays },
    sink: {
      share: totalCost > 0 ? excessCost / totalCost : 0,
      rawShare: total > 0 ? excess / total : 0,
      excess,
      excessCost,
      total,
      totalCost,
      reopenedDays: later.length,
      fresh,
      reopened,
      continueTyped: num(cont.typed),
      continueSessions: num(cont.sessions),
    },
    skill: topLine
      ? { line: String(topLine.line ?? ''), sessions: num(topLine.sessions), days: num(topLine.days), typed: num(topLine.typed), others: rows.skill.slice(1, 4).map((r) => ({ line: String(r.line ?? ''), sessions: num(r.sessions), days: num(r.days) })) }
      : undefined,
    rule: topRule
      ? { head: oneLine(String(topRule.head ?? '')), tool: String(topRule.tool_name ?? ''), sessions: num(topRule.sessions), days: num(topRule.days), n: num(topRule.n), others: rows.rule.slice(1, 4).map((r) => ({ head: oneLine(String(r.head ?? '')), sessions: num(r.sessions) })) }
      : undefined,
    subagent: {
      heavyDays: heavy.length,
      noDispatchDays: noDispatch.length,
      inlineReads: noDispatch.reduce((a, r) => a + num(r.reads), 0),
      dispatches: heavy.reduce((a, r) => a + num(r.dispatches), 0),
      inlineCost,
      costShare: totalCost > 0 ? inlineCost / totalCost : 0,
      recurring,
    },
  }
}

/**
 * The route rule. Each qualifying signal is scored as a multiple of its
 * floor; the largest wins, and any other qualifying route within a fifth
 * of it on that scale runs too. Ties fall to precedence. Below every
 * floor the result is empty, which the ask reports as "not enough yet".
 *
 * @ref LLP 0395#route-rule [implements]: largest multiple of its floor wins, near ties run together
 * @param {FirstAskSignals} s
 * @returns {FirstAskRoute[]}
 */
export function chooseRoutes(s) {
  /** @type {{ route: FirstAskRoute, score: number }[]} */
  const scored = []
  if (s.sink.share >= ROUTE_FLOORS.sink) scored.push({ route: 'sink', score: s.sink.share / ROUTE_FLOORS.sink })
  if (s.skill && s.skill.sessions >= ROUTE_FLOORS.skill.sessions && s.skill.days >= ROUTE_FLOORS.skill.days) {
    scored.push({ route: 'skill', score: s.skill.sessions / ROUTE_FLOORS.skill.sessions })
  }
  if (s.subagent.costShare >= ROUTE_FLOORS.subagent && s.subagent.recurring) {
    scored.push({ route: 'subagent', score: s.subagent.costShare / ROUTE_FLOORS.subagent })
  }
  // Sessions and days both have to clear their floor, and the score is the
  // smaller multiple: 41 eval-harness sessions on one afternoon are one
  // day's burst, not a habit, and must not outrank a month of reopened
  // sessions.
  if (s.rule && s.rule.sessions >= ROUTE_FLOORS.rule.sessions && s.rule.days >= ROUTE_FLOORS.rule.days) {
    scored.push({ route: 'rule', score: Math.min(s.rule.sessions / ROUTE_FLOORS.rule.sessions, s.rule.days / ROUTE_FLOORS.rule.days) })
  }
  if (scored.length === 0) return []
  const best = Math.max(...scored.map((x) => x.score))
  return PRECEDENCE.filter((route) => scored.some((x) => x.route === route && x.score >= best * 0.8))
}

/**
 * `triage.txt`: the signals as the client reads them, then the rule as
 * applied and its outcome, so the answer can cite why it got the route it
 * got. The record line comes first, because a reader given only "no line
 * repeats across 3 sessions" mistook the threshold for the count.
 *
 * @param {FirstAskSignals} s
 * @param {FirstAskRoute[]} routes
 * @param {{ from: string, scope: string }} meta
 * @returns {string}
 */
export function renderTriage(s, routes, meta) {
  const pct = (s.sink.share * 100).toFixed(1)
  const raw = (s.sink.rawShare * 100).toFixed(1)
  const lines = [
    `# Triage signals, ${meta.scope}, ${meta.from} to today. Duplicate OTEL lane excluded.`,
    '',
    `record    ${s.record.sessions} sessions over ${s.record.sessionDays} session-days in the window`,
    '          counts every session with at least one assistant turn',
    `sink      ${pct}% of all spend (cost-weighted: cache read ${PRICE_RATIO.cacheRead}, cache write ${PRICE_RATIO.cacheWrite}, output ${PRICE_RATIO.output}, fresh input 1) is excess on reopened days; ${raw}% by raw token count`,
    `          ${s.sink.reopenedDays} reopened session-days at ${s.sink.reopened.toFixed(0)} ctx/out vs ${s.sink.fresh.toFixed(0)} fresh; excess ${fmt(s.sink.excess)} of ${fmt(s.sink.total)}; "continue from where you left off" typed ${s.sink.continueTyped} times in ${s.sink.continueSessions} sessions`,
    `skill     ${s.skill ? `"${s.skill.line}" typed in ${s.skill.sessions} sessions on ${s.skill.days} days` : 'no typed line repeats often enough (threshold 3 sessions on 3 days)'}`,
    `          ${s.skill ? s.skill.others.map((o) => `${o.line.slice(0, 30)}: ${o.sessions}s/${o.days}d`).join('; ') : ''}`,
    `rule      ${s.rule ? `"${s.rule.head.slice(0, 60)}" in ${s.rule.sessions} sessions on ${s.rule.days} days (${s.rule.n} times)` : 'no error recurs often enough (threshold 3 sessions)'}`,
    `          ${s.rule ? s.rule.others.map((o) => `${o.head.slice(0, 36)}: ${o.sessions}s`).join('; ') : ''}`,
    `subagent  ${(s.subagent.costShare * 100).toFixed(1)}% of all spend is the estimated re-sent cost of inline reading on heavy days with no dispatch (priced as cache reads)`,
    `          ${s.subagent.noDispatchDays} of ${s.subagent.heavyDays} heavy session-days (40+ calls) dispatched no subagent; ${s.subagent.dispatches} dispatches on the other ${s.subagent.heavyDays - s.subagent.noDispatchDays}; recurring task: ${s.subagent.recurring ? `"${s.subagent.recurring.text}" (${s.subagent.recurring.kind}, ${s.subagent.recurring.sessions} sessions)` : `none seen in ${ROUTE_FLOORS.subagentRecurring}+ sessions, so this route cannot be chosen`}`,
    '',
    '# Rule, as applied',
    `Floors: sink ${(ROUTE_FLOORS.sink * 100).toFixed(0)}% share; skill ${ROUTE_FLOORS.skill.sessions}+ sessions on ${ROUTE_FLOORS.skill.days}+ days; subagent ${(ROUTE_FLOORS.subagent * 100).toFixed(0)}% share and a task recurring in ${ROUTE_FLOORS.subagentRecurring}+ sessions; rule ${ROUTE_FLOORS.rule.sessions}+ sessions on ${ROUTE_FLOORS.rule.days}+ days, scored on the smaller of the two.`,
    'The largest multiple of its floor wins; any other route within a fifth of it on that scale runs too; ties fall to sink, skill, subagent, rule.',
    ...(routes.length > 0
      ? routes.map((r) => `Route chosen by HypAware: ${r} (${describeRoute(r, s)})`)
      : ['Route chosen by HypAware: none. Every signal is below its floor.']),
    '',
  ]
  return lines.join('\n')
}

/**
 * The per-route statements. Each returns a JSON-safe row list the
 * writers below turn into TSV. Bounded by `limit` or by the window.
 *
 * @param {string} from
 * @returns {{
 *   sinkDays: string, sinkOpeners: string,
 *   skillLines: string,
 *   ruleHeads: string, ruleContext: string,
 *   subagentHeavy: string, subagentBriefs: string,
 * }}
 */
export function gatherSql(from) {
  const humanUser = `role = 'user' and part_type = 'text' and ${NOT_DUPLICATE_LANE} and ${HUMAN_TURN}`
  return {
    sinkDays: `select substr(session_id, 1, 8) as s, date, sum(${USAGE_CTX}) as ctx, sum(${USAGE_OUT}) as outp, count(*) filter (where part_type = 'tool_call') as calls from ai_gateway_messages where date >= '${from}' and role = 'assistant' and ${NOT_DUPLICATE_LANE} group by 1, 2 order by 1, 2`,
    sinkOpeners: `select substr(session_id, 1, 8) as s, date, message_index as i, cwd, substr(content_text, 1, 160) as line from ai_gateway_messages where date >= '${from}' and ${humanUser} and length(content_text) >= 12 order by s, date, i`,
    skillLines: `select substr(session_id, 1, 8) as s, session_id, date, message_index as i, cwd, substr(content_text, 1, 200) as line from ai_gateway_messages where date >= '${from}' and ${humanUser} and length(content_text) >= 12 order by date, s, i`,
    ruleHeads: `select tool_name, substr(content_text, 1, 90) as head, count(*) as n, count(distinct session_id) as sessions, max(date) as last from ai_gateway_messages where date >= '${from}' and part_type = 'tool_result' and is_error and ${NOT_DUPLICATE_LANE} group by 1, 2 having count(*) >= 3 order by n desc limit 40`,
    ruleContext: `select substr(session_id, 1, 8) as s, date, message_index as i, tool_name, substr(content_text, 1, 160) as err from ai_gateway_messages where date >= '${from}' and part_type = 'tool_result' and is_error and ${NOT_DUPLICATE_LANE} and ${NOT_PERMISSION_PROMPT} order by date, s, i limit 2000`,
    subagentHeavy: `select substr(session_id, 1, 8) as s, date, max(client_name) as client, count(*) filter (where part_type = 'tool_call') as calls, count(*) filter (where part_type = 'tool_call' and tool_name in ('Read', 'Grep', 'Glob')) as read_calls, count(*) filter (where part_type = 'tool_call' and tool_name in ('Bash', 'exec')) as shell_calls, count(*) filter (where part_type = 'tool_call' and tool_name in ('Edit', 'Write')) as edit_calls, count(*) filter (where part_type = 'tool_call' and tool_name = 'Agent') as dispatches, sum(length(content_text)) filter (where part_type = 'tool_result') as result_bytes from ai_gateway_messages where date >= '${from}' and ${NOT_DUPLICATE_LANE} and part_type in ('tool_call', 'tool_result') group by 1, 2 having count(*) filter (where part_type = 'tool_call') >= 40 order by result_bytes desc limit 40`,
    subagentBriefs: `select substr(regexp_extract(cast(tool_args as varchar), '"description"\\s*:\\s*"([^"]{1,60})', 1), 1, 60) as brief, substr(regexp_extract(cast(tool_args as varchar), '"subagent_type"\\s*:\\s*"([^"]{1,30})', 1), 1, 30) as type, count(*) as n, count(distinct session_id) as sessions from ai_gateway_messages where date >= '${from}' and part_type = 'tool_call' and tool_name = 'Agent' and ${NOT_DUPLICATE_LANE} group by 1, 2 order by n desc limit 30`,
  }
}

/**
 * The most repeated typed line across a named set of sessions, for the
 * subagent route's recurring-task condition.
 *
 * @param {string} from
 * @param {string[]} prefixes
 * @returns {string}
 */
export function recurringLineSql(from, prefixes) {
  const list = prefixes.map((p) => `'${p.replace(/[^0-9a-f]/g, '')}'`).join(', ')
  return `select lower(substr(content_text, 1, 42)) as line, count(distinct session_id) as sessions from ai_gateway_messages where date >= '${from}' and role = 'user' and part_type = 'text' and ${NOT_DUPLICATE_LANE} and ${HUMAN_TURN} and lower(content_text) not like 'continue from where you left off%' and length(content_text) between 12 and 160 and substr(session_id, 1, 8) in (${list}) group by 1 having count(distinct session_id) >= ${ROUTE_FLOORS.subagentRecurring} order by sessions desc limit 3`
}

/**
 * Typed lines for a named set of session prefixes, first few per day.
 *
 * @param {string} from
 * @param {string[]} prefixes
 * @returns {string}
 */
export function typedForSessionsSql(from, prefixes) {
  const list = prefixes.map((p) => `'${p.replace(/[^0-9a-f]/g, '')}'`).join(', ')
  return `select substr(session_id, 1, 8) as s, date, message_index as i, substr(content_text, 1, 160) as line from ai_gateway_messages where date >= '${from}' and role = 'user' and part_type = 'text' and ${NOT_DUPLICATE_LANE} and ${HUMAN_TURN} and length(content_text) >= 12 and substr(session_id, 1, 8) in (${list}) order by s, date, i`
}

/**
 * For the skill route: what the agent ran after the trigger line in each
 * session that typed it, and how those sessions ended. Two statements
 * over the named sessions; the "after" cut is applied in JS from the
 * line's own timestamp so there is no self-join.
 *
 * @param {string} from
 * @param {string[]} sessionIds full ids
 * @returns {{ trigger: string, calls: string, endings: string }}
 */
export function clusterSql(from, sessionIds) {
  const list = sessionIds.map((id) => `'${id.replace(/[^0-9a-f-]/g, '')}'`).join(', ')
  return {
    trigger: `select session_id, min(message_created_at) as at from ai_gateway_messages where date >= '${from}' and role = 'user' and part_type = 'text' and ${NOT_DUPLICATE_LANE} and session_id in (${list}) and lower(content_text) like '__PHRASE__%' group by 1`,
    calls: `select session_id, message_created_at as at, tool_name, substr(cast(tool_args as varchar), 1, 160) as args from ai_gateway_messages where date >= '${from}' and part_type = 'tool_call' and ${NOT_DUPLICATE_LANE} and session_id in (${list}) order by session_id, message_created_at`,
    endings: `select session_id, message_created_at as at, substr(content_text, 1, 1200) as text from ai_gateway_messages where date >= '${from}' and role = 'assistant' and part_type = 'text' and length(content_text) > 200 and ${NOT_DUPLICATE_LANE} and session_id in (${list}) order by session_id, message_created_at`,
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
    .slice(0, 80)
}

/**
 * Rows to TSV. Newlines and tabs inside a cell collapse to spaces; a
 * cell that could carry either is a line the reader would otherwise
 * lose.
 *
 * @param {string[]} columns
 * @param {Record<string, unknown>[]} rows
 * @param {(row: Record<string, unknown>) => unknown[]} [pick]
 * @returns {string}
 */
export function toTsv(columns, rows, pick) {
  const out = [columns.join('\t')]
  for (const r of rows) {
    const cells = pick ? pick(r) : columns.map((c) => r[c])
    out.push(cells.map((v) => oneLine(v == null ? '' : String(v))).join('\t'))
  }
  return out.join('\n') + '\n'
}

/**
 * The instructions the client reads. Written for a reader who will give
 * the answer ten seconds: the recommendation first, the reason second,
 * then why, then the change, then the question, then one line of sources.
 * The rules above the answer shape each close a failure the recorded
 * runs showed: unverified facts, self-serve queries, prose where a
 * mechanism was needed, and routes chosen by the model.
 *
 * @ref LLP 0395#answer-shape [implements]: recommendation first, evidence last, under 110 words before the block
 * @param {FirstAskRoute[]} routes
 * @param {{ scope: string, files: string[], signals?: FirstAskSignals, windowDays?: number }} meta
 * @returns {string}
 */
export function askInstructions(routes, meta) {
  const routeLine = routes.length === 0
    ? 'What HypAware found: nothing over its floor. Every signal is below the level worth acting on.'
    : `What HypAware found, and the skill each points to:\n${routes.map((r) => `- ${meta.signals ? describeRoute(r, meta.signals) : r} Skill: ${ROUTE_SKILLS[r]}.`).join('\n')}\nThe rule that chose this is printed in triage.txt.`
  const fileNotes = {
    'triage.txt': 'the four signals, the record size, the rule as applied, and the route. Read first.',
    'session_days_summary.txt': 'context tokens per output token for single-day sessions, first days, and later days of multi-day sessions, plus the excess on later days.',
    'worst_days.tsv': 'the reopened days that cost the most, each with what was typed first that day. Read this before the two files below; it is the join you would otherwise make by hand.',
    'session_days.tsv': 'one row per session per day: day number, days total, context tokens, output tokens, ratio, tool calls. Context is re-sent every turn, so a high ratio is a session paying to carry history.',
    'day_openers.tsv': 'the first lines typed each day in each session, so you can see what a reopened day was for.',
    'user_lines.tsv': 'every line typed in the window, 200-character cap, with session, date, position, cwd. Read all of it.',
    'trigger.commands.tsv': 'what ran after the most-typed line, by command head, with counts and session counts. The procedure a skill must run.',
    'trigger.endings.txt': 'how each of those sessions ended. What finished looks like.',
    'error_heads.tsv': 'failed tool results by first 90 characters, with count, sessions, last seen. A user declining a tool call is a choice, not a failure.',
    'error_context.tsv': 'every failure in order with session, date, position.',
    'read_heavy_sessions.tsv': 'session-days with 40+ calls ranked by KB of tool output pulled into the main context, with client, read and shell calls, edits, and dispatches.',
    'heavy_typed.tsv': 'the first lines typed on each of those session-days.',
    'agent_briefs.tsv': 'every subagent dispatch, grouped by its description, with count and sessions.',
    'SKILL.draft.md': 'a draft of the skill, built from the evidence. Start from it: fit the trigger phrases and the steps to what the record shows, cut what does not apply, and keep it under 25 lines. Do not compose a skill from nothing.',
    'on_disk.txt': 'the skills and agents already installed on this machine, each with what it is for, and whether a user-level CLAUDE.md exists.',
  }
  const files = meta.files.map((f) => `- \`${f}\`: ${fileNotes[/** @type {keyof typeof fileNotes} */ (f)] ?? ''}`).join('\n')
  return `# What to do with this folder

HypAware keeps your AI agents' sessions, logs, and telemetry in one queryable history. This folder holds what it measured over the last ${meta.windowDays ?? EVIDENCE_WINDOW_DAYS} days of that history for ${meta.scope}, prepared so you can recommend one change to the person whose sessions these are. \`hyp\` is its command line, and the hypaware-query skill is how to read the history if you need one more figure.

Scope: ${meta.scope}.

${routeLine}

The evidence is gathered; the files in this folder are what you work from. If one specific figure you need is not here, you may run at most two \`hyp query\` commands to get it, and you say in the Sources line what you ran. Before the first of them, read the hypaware-query skill's SKILL.md (listed in on_disk.txt) for the dialect and the column names, so the query is right the first time; do not read it if you run no query. Never more than two, never against a server, and never a sleep: if it is still not available, say so and go on.

## Files

${files}

## Rules

- Every number you state traces to a file in this folder (or to one of your two queries). The reader never sees session ids or file names in the answer itself; those go in the Sources line at the end, where each session is its eight-character id with the date and what was typed.
- A fact about a command, an error, or a tool must come from a file you read this session, cited path:line, or be written as a pointer. This applies to the text of the change itself, not only to the evidence for it.
- Standard commands (git, gh, npm, node, hyp) need no proof; the model knows them and the record shows they ran. A command specific to this repo or tool (a script under scripts/, a flag you have not seen in the record) is run once before it appears, and the answer shows the command and its output. Do not write outside this folder to do that. Never build a scratch repo or run git in the person's repo to test a step.
- The answer is always one skill: a SKILL.md under ~/.claude/skills/<name>/ that the person can read, trigger, and edit. Never an agent definition on its own, a hook, a settings entry, or a CLAUDE.md rule. If the skill needs the agent to offer it unprompted (a handoff at the end of the day), say so in one sentence in the answer; do not propose a second file.
- The skill's description opens with the phrase the person already types for this, so the client picks it up without being told. Its steps are the commands the record shows actually ran, not ones you imagine.
- For reopened sessions, be honest that a skill cannot stop a person from resuming; what it does is make starting fresh cheap enough to prefer.
- For a request that should go to a worker, the skill's body dispatches a worker for the reading and returns a summary; where the client has no subagent (Codex), the same skill reduces in the shell instead, and the answer says which client the days ran in.
- For a recurring mistake, the skill is for the task the mistake happens in, and its steps carry the correct form; if the mistake is a trap in something HypAware ships (a skill under ~/.claude/skills/hypaware-*, a command, an error message), say so: the lasting fix is there, and this skill is a stopgap.
- Discount session ids that carry identical typed lines on the same day as another id; that is one conversation recorded twice.
- If nothing was over its floor: two sentences, what was recorded (sessions and days, from the record line of triage.txt) and that there is not enough yet to recommend anything. Then the Sources line and stop; no question.

## Answer shape

This is the first thing a person sees after installing, and they will give it about ten seconds. Write it the way you would tell a colleague what you found: short paragraphs, plain words a non-engineer would follow, no headings, no bold labels, no em dashes, no citations, file names, or session ids in the text. Print nothing before the first sentence.

Open by saying what you did and what stood out, in your own words: that you looked through the last ${meta.windowDays ?? EVIDENCE_WINDOW_DAYS} days of sessions for ${meta.scope} and the one skill worth adding first. Then the recommendation itself, what the skill does and what phrase triggers it, and why, in a sentence or two. Then the evidence in prose: two or three plain facts with at most one number each, and one real example with its date and what was typed, told as a story rather than a citation. If you skipped something you had to skip, say so in a clause. A short bullet list is fine if it reads better than a paragraph; a table is not.

Then, on its own line, something like "Here's the skill I'd add:", the file path under ~/.claude/skills/, and the exact SKILL.md in a fenced code block, under 25 lines including the front matter.

Then ask whether to apply it, in one short sentence.

Then one line that starts with "Sources:" carrying everything you verified, compact: the file:line references, the sessions by id, and for any command the test command and its output. This line is for checking, not reading.

If nothing was over its floor: say what you looked through (sessions and days, from the record line of triage.txt), that there is not enough yet to recommend a skill, and when it would be worth asking again. Then "Sources:" and stop; no question.

When the answer is yes: create or edit the file with the Write or Edit tool in that same turn and print the result. Do not ask again.

Under 120 words before the code block. Read each file once, in one pass; do not page through it in pieces, and do not re-derive with grep what a file already lists. Aim to answer in under two minutes: the draft is written, the finding is stated, and your job is to fit them together and say why.
`
}

/**
 * What is already installed for the client on this machine, so the
 * answer can say whether something on the subject exists and why it
 * did not work. Skills and agents are listed with the description their
 * front matter declares, because the name alone ("hypaware-query") says
 * nothing about what a session would reach for it. Hooks are not listed:
 * they are invisible to the person, fragile across client updates, and
 * not a change the ask proposes. Best-effort and bounded: a missing
 * directory is a line, not an error, and a description is cut at 200
 * characters.
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
      const text = await readFile(file, 'utf8')
      return frontMatterDescription(text)
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
 * Gather one route's files from the runner.
 *
 * @param {FirstAskRoute} route
 * @param {OverviewQueryRunner} runner
 * @param {string} from
 * @param {FirstAskSignals} signals
 * @returns {Promise<FirstAskEvidenceFile[]>}
 */
export async function gatherRoute(route, runner, from, signals) {
  const sql = gatherSql(from)
  switch (route) {
    case 'sink': {
      const days = (await runner.run(sql.sinkDays)).rows
      const openers = (await runner.run(sql.sinkOpeners)).rows
      return [...sinkFiles(days, openers), { name: 'SKILL.draft.md', content: draftSkill('sink', signals) }]
    }
    case 'skill': {
      const lines = (await runner.run(sql.skillLines)).rows
      /** @type {FirstAskEvidenceFile[]} */
      const files = [{
        name: 'user_lines.tsv',
        content: toTsv(['session', 'date', 'i', 'cwd', 'line'], lines, (r) => [r.s, r.date, r.i, shortCwd(String(r.cwd ?? '')), r.line]),
      }]
      const phrase = signals.skill?.line
      /** @type {{ head: string, n: number, sessions: number }[]} */
      let steps = []
      if (phrase) {
        const ids = [...new Set(lines
          .filter((r) => String(r.line ?? '').toLowerCase().startsWith(phrase))
          .map((r) => String(r.session_id ?? '')))].slice(0, 20)
        if (ids.length > 0) {
          const cluster = await clusterFiles(runner, from, ids, phrase)
          files.push(...cluster.files)
          steps = cluster.heads
        }
      }
      files.push({ name: 'SKILL.draft.md', content: draftSkill('skill', signals, { steps }) })
      return files
    }
    case 'rule': {
      const heads = (await runner.run(sql.ruleHeads)).rows
      const context = (await runner.run(sql.ruleContext)).rows
      return [
        { name: 'error_heads.tsv', content: toTsv(['tool', 'n', 'sessions', 'last', 'head'], heads, (r) => [r.tool_name, r.n, r.sessions, r.last, r.head]) },
        { name: 'error_context.tsv', content: toTsv(['session', 'date', 'i', 'tool', 'error'], context, (r) => [r.s, r.date, r.i, r.tool_name, r.err]) },
        { name: 'SKILL.draft.md', content: draftSkill('rule', signals) },
      ]
    }
    case 'subagent': {
      const heavy = (await runner.run(sql.subagentHeavy)).rows
      const briefs = (await runner.run(sql.subagentBriefs)).rows
      const prefixes = [...new Set(heavy.map((r) => String(r.s ?? '')))].filter(Boolean)
      const typed = prefixes.length > 0 ? (await runner.run(typedForSessionsSql(from, prefixes))).rows : []
      /** @type {Map<string, number>} */
      const seen = new Map()
      const capped = typed.filter((r) => {
        const key = `${r.s}\t${r.date}`
        const n = (seen.get(key) ?? 0) + 1
        seen.set(key, n)
        return n <= 4
      })
      return [
        { name: 'read_heavy_sessions.tsv', content: toTsv(['session', 'date', 'client', 'read_calls', 'shell_calls', 'result_kb', 'edit_calls', 'agent_dispatches', 'tool_calls'], heavy, (r) => [r.s, r.date, r.client, r.read_calls, r.shell_calls, Math.floor(num(r.result_bytes) / 1024), r.edit_calls, r.dispatches, r.calls]) },
        { name: 'heavy_typed.tsv', content: toTsv(['session', 'date', 'i', 'line'], capped, (r) => [r.s, r.date, r.i, r.line]) },
        { name: 'agent_briefs.tsv', content: toTsv(['n', 'sessions', 'subagent_type', 'brief'], briefs, (r) => [r.n, r.sessions, r.type, r.brief]) },
        { name: 'SKILL.draft.md', content: draftSkill('subagent', signals) },
      ]
    }
    default:
      return []
  }
}

/**
 * The sink route's two files plus the summary.
 *
 * @param {Record<string, unknown>[]} days
 * @param {Record<string, unknown>[]} openers
 * @returns {FirstAskEvidenceFile[]}
 */
export function sinkFiles(days, openers) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const by = new Map()
  for (const r of days) {
    const key = String(r.s ?? '')
    const list = by.get(key) ?? []
    list.push(r)
    by.set(key, list)
  }
  const tot = { single: [0, 0, 0], multi_first: [0, 0, 0], multi_later: [0, 0, 0] }
  const out = ['session\tdate\tday_no\tdays_total\tcontext_tokens\toutput_tokens\tctx_per_out\ttool_calls']
  for (const [s, list] of by) {
    list.sort((a, b) => compareStrings(String(a.date), String(b.date)))
    list.forEach((r, j) => {
      const k = list.length === 1 ? 'single' : (j === 0 ? 'multi_first' : 'multi_later')
      const t = tot[k]
      t[0] += 1; t[1] += num(r.ctx); t[2] += num(r.outp)
      out.push([s, r.date, j + 1, list.length, num(r.ctx), num(r.outp), (num(r.ctx) / Math.max(num(r.outp), 1)).toFixed(0), num(r.calls)].join('\t'))
    })
  }
  const base = tot.single[1] / Math.max(tot.single[2], 1)
  let excess = 0
  for (const list of by.values()) {
    if (list.length < 2) continue
    for (const r of list.slice(1)) {
      const e = num(r.ctx) - base * num(r.outp)
      if (e > 0) excess += e
    }
  }
  const summary = [
    'slice\tsession_days\tcontext_tokens\toutput_tokens\tctx_per_out',
    ...Object.entries(tot).map(([k, t]) => `${k}\t${t[0]}\t${t[1]}\t${t[2]}\t${(t[1] / Math.max(t[2], 1)).toFixed(0)}`),
    '',
    `excess context on later days, relative to the single-day ratio: ${excess.toFixed(0)} tokens`,
    `total context tokens: ${Object.values(tot).reduce((a, t) => a + t[1], 0)}`,
    'context_tokens = input + cache_read + cache_write; every token in context is re-sent on every turn.',
    '',
  ].join('\n')
  // The worst reopened days with what they were opened for, pre-joined:
  // the reader wants "on the 28th you reopened the report work over a 400
  // error", and joining two files by hand is the one thing a cold session
  // spent its minutes on.
  /** @type {Map<string, string>} */
  const opener = new Map()
  for (const r of firstPerDay(openers, 1)) opener.set(`${r.s}\t${r.date}`, oneLine(String(r.line ?? '')))
  /** @type {{ s: string, date: string, dayNo: number, days: number, ctx: number, outp: number, excess: number, line: string }[]} */
  const worst = []
  for (const [s, list] of by) {
    if (list.length < 2) continue
    list.forEach((r, j) => {
      if (j === 0) return
      const e = num(r.ctx) - base * num(r.outp)
      if (e <= 0) return
      worst.push({ s, date: String(r.date), dayNo: j + 1, days: list.length, ctx: num(r.ctx), outp: num(r.outp), excess: e, line: opener.get(`${s}\t${r.date}`) ?? '' })
    })
  }
  worst.sort((a, b) => b.excess - a.excess)
  return [
    { name: 'session_days_summary.txt', content: summary },
    { name: 'worst_days.tsv', content: toTsv(['session', 'date', 'day_no', 'days_total', 'context_tokens', 'output_tokens', 'ctx_per_out', 'excess_tokens', 'first_line_that_day'], worst.slice(0, 15).map((w) => ({ session: w.s, date: w.date, day_no: w.dayNo, days_total: w.days, context_tokens: w.ctx, output_tokens: w.outp, ctx_per_out: (w.ctx / Math.max(w.outp, 1)).toFixed(0), excess_tokens: Math.round(w.excess), first_line_that_day: w.line }))) },
    { name: 'session_days.tsv', content: out.join('\n') + '\n' },
    { name: 'day_openers.tsv', content: toTsv(['session', 'date', 'i', 'cwd', 'first_lines_that_day'], firstPerDay(openers, 2), (r) => [r.s, r.date, r.i, shortCwd(String(r.cwd ?? '')), r.line]) },
  ]
}

/**
 * For the skill route: the procedure after the trigger line, and how the
 * sessions ended.
 *
 * @param {OverviewQueryRunner} runner
 * @param {string} from
 * @param {string[]} sessionIds
 * @param {string} phrase lower-cased head of the trigger line
 * @returns {Promise<{ files: FirstAskEvidenceFile[], heads: { head: string, n: number, sessions: number }[] }>}
 */
export async function clusterFiles(runner, from, sessionIds, phrase) {
  const sql = clusterSql(from, sessionIds)
  const safePhrase = phrase.replace(/'/g, "''").replace(/[%_]/g, '')
  const trigger = (await runner.run(sql.trigger.replace('__PHRASE__', safePhrase))).rows
  /** @type {Map<string, string>} */
  const after = new Map()
  for (const r of trigger) after.set(String(r.session_id ?? ''), String(r.at ?? ''))
  const calls = (await runner.run(sql.calls)).rows
    .filter((r) => {
      const t = after.get(String(r.session_id ?? ''))
      return t !== undefined && String(r.at ?? '') >= t
    })
  const heads = commandHeads(calls)
  const endings = (await runner.run(sql.endings)).rows
  /** @type {Map<string, string>} */
  const last = new Map()
  for (const r of endings) last.set(String(r.session_id ?? '').slice(0, 8), String(r.text ?? ''))
  return {
    heads,
    files: [
      { name: 'trigger.commands.tsv', content: toTsv(['count', 'sessions', 'command'], heads.map((h) => ({ count: h.n, sessions: h.sessions, command: h.head }))) },
      { name: 'trigger.endings.txt', content: [...last.entries()].map(([s, t]) => `=== ${s}\n${t.trim()}\n`).join('\n') + '\n' },
    ],
  }
}

/**
 * Run the whole gather for one launch: triage, route, files, `ASK.md`,
 * into `root`, which is emptied first and created user-only. One folder, replaced on every ask:
 * the files exist so the client can read them during that session, and
 * nothing reads them afterwards, so keeping old runs would only grow.
 *
 * @ref LLP 0395#run-directory [implements]: one directory, wiped and rewritten per ask, and the client starts inside it
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
  const t = triageSql(from)
  say(`Measuring the last ${windowDays} days...`)
  const rows = {
    sink: (await runner.run(t.sink)).rows,
    cont: (await runner.run(t.cont)).rows,
    skill: (await runner.run(t.skill)).rows,
    rule: (await runner.run(t.rule)).rows,
    subagent: (await runner.run(t.subagent)).rows,
    briefs: (await runner.run(t.briefs)).rows,
    /** @type {Record<string, unknown>[]} */
    recurring: [],
  }
  const quiet = rows.subagent.filter((r) => num(r.dispatches) === 0).map((r) => String(r.session_id ?? '').slice(0, 8)).filter(Boolean)
  if (quiet.length > 0) rows.recurring = (await runner.run(recurringLineSql(from, [...new Set(quiet)].slice(0, 60)))).rows
  const signals = computeSignals(rows)
  const routes = chooseRoutes(signals)
  /** @type {FirstAskEvidenceFile[]} */
  const files = [{ name: 'triage.txt', content: renderTriage(signals, routes, { from, scope }) }]
  for (const route of routes) {
    say(`Gathering evidence for the ${route} route...`)
    files.push(...await gatherRoute(route, runner, from, signals))
  }
  files.push({ name: 'on_disk.txt', content: await onDiskListing({ homeDir }) })
  files.push({ name: 'ASK.md', content: askInstructions(routes, { scope, files: files.map((f) => f.name), signals, windowDays }) })

  const dir = root
  await fsp.rm(dir, { recursive: true, force: true })
  // User-only: the files quote the person's own typed lines, and on a
  // shared machine the temp directory is not private by default.
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  for (const f of files) await fsp.writeFile(path.join(dir, f.name), f.content, 'utf8')
  return { dir, from, routes, signals, files: files.map((f) => f.name) }
}

/**
 * The first `keep` rows of each (session, date), in the order given.
 * Message positions do not restart when a session is reopened on a later
 * day, so "the first lines typed that day" cannot be a position filter;
 * it has to be taken per day.
 *
 * @param {Record<string, unknown>[]} rows ordered by session, date, position
 * @param {number} keep
 * @returns {Record<string, unknown>[]}
 */
export function firstPerDay(rows, keep) {
  /** @type {Map<string, number>} */
  const seen = new Map()
  return rows.filter((r) => {
    const key = `${r.s}\t${r.date}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    return n <= keep
  })
}

/** @param {unknown} v */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** @param {number} n */
function fmt(n) {
  return groupThousands(Math.round(n))
}

/** @param {string} s */
function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim()
}

/** @param {string} cwd */
function shortCwd(cwd) {
  return cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

// @ts-check

/**
 * The gateway overview: a probe that plans an affordable window, then four
 * aggregations over `ai_gateway_messages` inside it, rendered as aligned
 * tables with proportional bars. One block, two callers - the wizard's
 * closing first look (`cli/wizard/first_look.js`) and `hyp query overview`
 * (`commands/query.js`) - so what setup shows is exactly what the command
 * reproduces later.
 *
 * `renderOverview` and `chooseOverviewWindow` are pure: rows in, string or
 * plan out, no I/O.
 *
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { OverviewNotice, OverviewRows, OverviewQueryRunner, OverviewWindow } from '../../../src/core/query/types.js'
 */

import { executeQuerySql } from './sql.js'
import { renderLocalOnlyNotice } from './verb.js'

/** The dataset both overview queries read. Absent, there is nothing to show. */
export const OVERVIEW_DATASET = 'ai_gateway_messages'

/**
 * Tokens, the unit the block reports. Not rows: a row is one *part* of a
 * message (`part_id = <message_id>#<part_index>`, LLP 0026), so a
 * `count(*)` headline names a unit nobody outside the schema recognizes,
 * and inflates wherever a model answers in several content blocks. Tokens
 * are the unit users already think in, and they sum honestly:
 * response-level usage rides exactly one carrier row, so a plain `SUM`
 * over rows needs no dedup (LLP 0035 #one-carrier). Non-carrier rows hold
 * null, hence no `role` filter is needed - and leaving it off keeps
 * `sessions` counting every session, not only those with an assistant
 * reply.
 *
 * Cache gets its own column rather than being folded into input. Every
 * `input_tokens` is net of cache (LLP 0035 #net-input), so each column
 * here sums exactly the field it is named after, and the prompt total is
 * `input + cached`. Folding them would both hide where the volume goes
 * (on this repo's own history, cache is ~500x net input) and force the
 * "input tokens" header to mean something narrower elsewhere in the
 * schema.
 *
 * Each term carries its own `coalesce`: `cache_write_tokens` is Claude-only,
 * so an unguarded `read + write` addition is null for every OpenAI row and
 * silently drops that provider's cache reads from the sum.
 *
 * @ref LLP 0035#one-carrier [constrained-by]: a plain SUM over rows is the correct total, no dedup
 * @ref LLP 0035#net-input [constrained-by]: input is net of cache, so input + cached is the whole prompt and neither column double-counts
 * @ref LLP 0035#null-union [implements]: coalesce every sum and every term, since a provider-absent field nulls the arithmetic instead of zeroing it
 */
const SUM_INPUT =
  "coalesce(sum(cast(json_extract(attributes,'$.usage.input_tokens') as bigint)), 0) input_tokens"

const SUM_CACHED =
  "coalesce(sum(coalesce(cast(json_extract(attributes,'$.usage.cache_read_tokens') as bigint), 0)\n" +
  "           + coalesce(cast(json_extract(attributes,'$.usage.cache_write_tokens') as bigint), 0)), 0) cached_tokens"

const SUM_OUTPUT =
  "coalesce(sum(cast(json_extract(attributes,'$.usage.output_tokens') as bigint)), 0) output_tokens"

/**
 * The window planner's probe: how many rows sit on each day.
 *
 * Deliberately narrow - one column, no JSON extraction - so planning costs
 * a fraction of what it saves. Measured against 48k rows / 158MB: ~0.27s,
 * against ~0.50s for a single token section. Partitions are keyed by
 * `source`, not `date`, so this cannot be answered from Iceberg metadata;
 * asking the data is the cheap option, not the expensive one.
 */
export const OVERVIEW_PROBE_SQL =
  'select date, count(*) n from ai_gateway_messages group by 1 order by 1 desc'

/**
 * Build the four section statements for one window.
 *
 * Every section carries the same `date >= since` bound, so the block's
 * numbers are all one claim about one period rather than four differently
 * scoped ones.
 *
 * @param {string} since inclusive `YYYY-MM-DD` lower bound
 * @returns {{ models: string, daily: string, repos: string, tools: string }}
 */
export function buildOverviewSql(since) {
  // `since` is interpolated, not bound - the executor takes no parameters.
  // Today it can only be a projector-issued `date` (always
  // `toISOString().slice(0, 10)`) or the empty string, so nothing hostile
  // reaches here. But the value round-trips out of the cache, and "some
  // other package maintains an invariant" is the wrong thing for a string
  // concatenated into SQL to rest on. Assert the shape at the seam.
  if (since !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error(`buildOverviewSql: since must be YYYY-MM-DD (got ${JSON.stringify(since)})`)
  }
  const window = `where date >= '${since}'`
  return {
    // Which providers and models this machine actually uses, by token volume.
    models:
      `select provider, model,\n  ${SUM_INPUT},\n  ${SUM_CACHED},\n  ${SUM_OUTPUT}\n` +
      `from ai_gateway_messages ${window}\ngroup by 1, 2 order by input_tokens + output_tokens desc`,

    // Sessions and tokens per day, most recent first. No LIMIT: the
    // renderer shows the newest `MAX_DAY_ROWS` and states how many days it
    // folded, which it can only count from the full result. A LIMIT here
    // would truncate a 30-day window to 14 rows under a header that says
    // 30, and the reader summing the column would silently get half.
    daily:
      `select date, count(distinct session_id) sessions,\n  ${SUM_INPUT},\n  ${SUM_CACHED},\n  ${SUM_OUTPUT}\n` +
      `from ai_gateway_messages ${window}\ngroup by 1 order by 1 desc`,

    // Where the work happens. Grouped by repo alone, not repo + branch:
    // `git_branch` is set on 15 of 431 sessions on the authoring machine
    // (~3%), so a branch column would be almost entirely blank, and grouping
    // by it splits one repo across a "(no branch)" row and a named one - the
    // same repo, twice, looking like two places. Sessions with no repo are
    // folded into a count line by the renderer rather than filtered here, so
    // the total stays reconcilable.
    //
    // No LIMIT, for that same reason. The renderer's "+ N more repos" is
    // computed from what this returns, so a LIMIT would cap N rather than
    // the truth (a 20-row limit reports 12 hidden when 22 are), and the
    // repo-less group - which sorts by token volume like any other - could
    // be evicted off the end, taking its disclosure line with it. The
    // grouping is computed in full either way; the LIMIT only decided how
    // much of the answer the renderer got to see.
    repos:
      `select repo_root, count(distinct session_id) sessions,\n  ${SUM_INPUT},\n  ${SUM_CACHED},\n  ${SUM_OUTPUT}\n` +
      `from ai_gateway_messages ${window}\ngroup by 1 order by input_tokens + output_tokens desc`,

    // Which tools the models actually reach for. The part type is
    // `tool_call`, not `tool_use`: the projector normalizes every provider's
    // call shape onto one vocabulary (`text`/`reasoning`/`tool_call`/
    // `tool_result`/`image`/`fallback`), so the provider's own wire name for
    // a call matches nothing here and returns a silent empty result.
    tools:
      'select tool_name, count(*) calls, count(distinct session_id) sessions\n' +
      `from ai_gateway_messages ${window}\n  and part_type = 'tool_call' and tool_name is not null\n` +
      'group by 1 order by calls desc limit 10',
  }
}

/** Input's shade in a token bar; distinct from output without colour. */
const BAR_INPUT_CELL = '▒'

/** Output's shade: solid, since it is the scarce half worth reading first. */
const BAR_OUTPUT_CELL = '█'

/**
 * What the columns mean. Each header now names the field it sums, so the
 * legend only has to explain the split itself: which half of the prompt
 * went through cache.
 */
const UNIT_LEGEND =
  'Input is prompt sent fresh; cached is prompt served from (or written to) the cache.\n' +
  'Output is what the model generated. Input + cached is the whole prompt.'

/**
 * The sections, in display order. Both callers render all four;
 * `collectOverview` still takes a subset so a shorter variant stays one
 * argument away.
 *
 * @type {readonly ('models'|'daily'|'repos'|'tools')[]}
 */
export const OVERVIEW_SECTIONS = /** @type {const} */ (['models', 'daily', 'repos', 'tools'])

/**
 * How many rows the four sections may scan.
 *
 * Calibrated from measurement, not taste: 48k rows costs ~2.0s of query
 * work across the four sections, so 150k lands near 6s - inside the
 * wizard's 8s budget with room for the probe, and short of the ~200k-row
 * scale where LLP 0057 measured queries approaching the LLP 0056 heap
 * ceiling. Beyond it the window narrows rather than the block disappearing.
 *
 * @ref LLP 0056 [constrained-by]: stay well inside the per-query heap budget rather than relying on its refusal
 * @ref LLP 0135#window [implements]: the block picks a period it can afford instead of scanning without bound
 */
export const OVERVIEW_ROW_TARGET = 150_000

/**
 * How long the whole block should take: probe plus sections.
 *
 * One number for both callers. The wizard and `hyp query overview` plan
 * identically - same budget, same measurement, same window - because the
 * question "how much history can this machine summarize quickly?" has one
 * answer regardless of who asked. They differ only in what happens when
 * the plan turns out wrong: setup abandons (the block is a bonus at the end
 * of an install), the command runs on (you asked for it, and no answer is
 * worse than a slow one).
 *
 * The budget covers the probe because the probe is part of the wait. A
 * budget that only counted the sections would let a slow probe eat the
 * user's patience before planning had noticed it was spending anything.
 */
export const OVERVIEW_TIME_BUDGET_MS = 5000

/**
 * What the planner keeps for the sections even when the probe overran the
 * whole budget. Small on purpose: it buys the newest day or two rather
 * than nothing, which is the same "always show something" rule the day
 * walk follows.
 */
const MIN_SECTION_BUDGET_MS = 400

/**
 * What one section's scan costs relative to the probe's, per row.
 *
 * The probe reads one column; a section reads `attributes` and runs
 * `json_extract`/`cast` over it. Measured at 48k rows: ~0.27s against
 * ~0.50s, so a section is ~1.9x the probe. Deliberately a ratio rather
 * than an absolute rate - the ratio is a property of the queries, while
 * the rate is a property of the machine, and the machine's half is
 * measured fresh on every run.
 */
const SECTION_COST_VS_PROBE = 1.9

/**
 * How many rows the sections can scan inside the time budget, inferred
 * from what the probe just cost on this machine.
 *
 * Without a probe timing there is nothing to infer from, so the caller
 * falls back to the row cap alone (`Infinity` here defers to it).
 *
 * @param {{ budgetMs?: number, probeMs?: number, totalRows: number }} args
 * @returns {number}
 */
function rowsAffordable({ budgetMs = OVERVIEW_TIME_BUDGET_MS, probeMs, totalRows }) {
  if (probeMs === undefined || totalRows <= 0) return Infinity
  // A probe too fast to time is not evidence of infinite speed; floor it at
  // 1ms so the estimate stays finite and the row cap keeps its say.
  const perRowMs = Math.max(probeMs, 1) / totalRows
  const sectionCount = OVERVIEW_SECTIONS.length
  return Math.floor(budgetMs / (perRowMs * SECTION_COST_VS_PROBE * sectionCount))
}

/** Rows shown per section before the remainder is folded into a count line. */
const MAX_PROVIDER_ROWS = 8

/** Repos shown before the tail is folded into a count line. */
const MAX_REPO_ROWS = 8

/**
 * Days shown before the older ones are folded into a count line. Two weeks
 * is enough to read a rhythm off; a 31-day window printed in full would
 * make the daily table longer than the rest of the block combined.
 */
const MAX_DAY_ROWS = 14

/** Bar column width, in cells. */
const BAR_WIDTH = 18

/** Model names longer than this are ellipsized so the columns stay aligned. */
const MAX_MODEL_WIDTH = 30

const ANSI = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  reset: '\x1b[0m',
}


/**
 * @param {string} text
 * @param {string} sgr
 * @param {boolean} on
 */
function paint(text, sgr, on) {
  return on ? `${sgr}${text}${ANSI.reset}` : text
}

/**
 * Build the query runner from a command context. Runs the same executor,
 * refresh mode and caller cwd `hyp query sql` uses, so the overview shows
 * exactly what the user would see typing either query themselves - and
 * reports the same two things `hyp query sql` reports alongside the rows.
 *
 * `onNotice` receives those reports, tagged so each caller can decide:
 *
 *   - `local-only`: rows were withheld because their directory's usage
 *     class outranks the caller's (LLP 0105). This one is a rule, not a
 *     nicety - withholding may never be silent, or a total silently means
 *     something narrower than it claims. Rendered by the verb's own
 *     `renderLocalOnlyNotice` so the two surfaces cannot word it
 *     differently.
 *   - `freshness`: a partition had unflushed rows and the flush debounce
 *     suppressed the flush, so the answer trails live capture by under two
 *     minutes.
 *
 * Each distinct line is emitted once per runner, not once per section:
 * five statements over the same partitions would otherwise repeat the same
 * sentence five times.
 *
 * @ref LLP 0105 [implements]: the overview inherits both halves - the filter and the disclosure that it filtered
 * @ref LLP 0135#disclosure [implements]: which report each caller passes on, and why they differ
 *
 * @param {CommandRunContext} ctx
 * @param {(notice: OverviewNotice) => void} [onNotice]
 * @returns {OverviewQueryRunner | undefined}
 */
export function overviewRunnerFromCtx(ctx, onNotice) {
  const registry = /** @type {any} */ (ctx)?.query
  if (!registry || typeof registry.getDataset !== 'function') return undefined
  /** @type {Set<string>} */
  const said = new Set()
  // Recorded even when no `onNotice` was supplied: whether rows were
  // withheld decides which empty state the block renders, which is a
  // separate question from who wanted to be told about it.
  let withheld = false
  /** @param {OverviewNotice} notice */
  const say = (notice) => {
    if (notice.kind === 'local-only') withheld = true
    if (!onNotice || said.has(notice.line)) return
    said.add(notice.line)
    onNotice(notice)
  }
  return {
    sawWithholding: () => withheld,
    hasDataset(name) {
      try {
        return Boolean(registry.getDataset(name))
      } catch {
        return false
      }
    },
    async run(sql) {
      const result = await executeQuerySql({
        query: sql,
        registry,
        storage: /** @type {any} */ (ctx.storage),
        refresh: 'auto',
        config: ctx.config,
        callerCwd: typeof ctx.cwd === 'string' && ctx.cwd.length > 0 ? ctx.cwd : null,
      })
      for (const line of result.freshnessMessages ?? []) {
        say({ kind: 'freshness', line: `${line}\n` })
      }
      const withheld = renderLocalOnlyNotice(result.localOnly)
      if (withheld) say({ kind: 'local-only', line: withheld })
      return { columns: result.columns ?? [], rows: result.rows ?? [] }
    },
  }
}

/**
 * Choose the widest window this machine can summarize in time, walking days
 * newest-first.
 *
 * Two caps, for two different failure modes:
 *
 *   - **Time**, measured rather than assumed. The probe just scanned every
 *     row; how long *that* took on *this* machine, right now, is the only
 *     honest basis for predicting the sections. A row-count target alone
 *     bakes in the author's laptop - a slower disk, a weaker CPU or a
 *     machine under load would get the same window and take proportionally
 *     longer, which is exactly the "huge logs, long wait" case the window
 *     exists to prevent. `probeMs` turns the plan into an observation, and
 *     is also deducted from the budget, since the probe was part of the
 *     wait.
 *   - **Rows**, as a memory backstop. Time says nothing about heap, and a
 *     fast machine could otherwise pick a window big enough to approach the
 *     LLP 0056 execution ceiling. The tighter of the two wins.
 *
 * The newest day is always included, even alone, even when it exceeds both:
 * a block covering one busy day is a real answer, where no block at all is
 * not. That is the whole point of narrowing rather than skipping - the
 * reader always gets numbers, and always gets told which period they
 * describe.
 *
 * @param {Record<string, unknown>[]} probeRows `{ date, n }`, any order
 * @param {{
 *   targetRows?: number,
 *   days?: number,
 *   budgetMs?: number,
 *   probeMs?: number,
 * }} [opts] `days` pins an explicit window (the user asked for it) and
 *   skips both caps; `probeMs` is how long the probe took over every row,
 *   which calibrates the time cap to this machine
 * @returns {OverviewWindow | null} null when nothing has been recorded
 * @ref LLP 0135#window [implements]: the affordable-window plan, measured on the machine it runs on
 */
export function chooseOverviewWindow(probeRows, opts = {}) {
  const days = [...probeRows]
    .map((r) => ({ date: cell(r.date), rows: toNumber(r.n) }))
    .filter((d) => d.date !== '(none)')
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  if (days.length === 0) return null

  const totalRows = days.reduce((n, d) => n + d.rows, 0)
  const rowCap = opts.targetRows ?? OVERVIEW_ROW_TARGET
  // The probe has already been paid for out of the same budget, so plan the
  // sections against what is left. On a slow machine this is what turns a
  // blown deadline into a shorter window: the probe reporting that it cost
  // 4 of the 5 seconds leaves the planner one second to spend, and it picks
  // accordingly instead of budgeting as if the clock had not started.
  const budgetMs = opts.budgetMs ?? OVERVIEW_TIME_BUDGET_MS
  const sectionBudgetMs = Math.max(MIN_SECTION_BUDGET_MS, budgetMs - (opts.probeMs ?? 0))
  const timeCap = rowsAffordable({
    budgetMs: sectionBudgetMs,
    ...(opts.probeMs !== undefined ? { probeMs: opts.probeMs } : {}),
    totalRows,
  })
  const cap = Math.min(rowCap, timeCap)
  /** @type {OverviewWindow['boundBy']} */
  const boundBy = opts.days !== undefined ? 'requested' : timeCap < rowCap ? 'time' : 'rows'

  let included = 0
  let rows = 0
  for (const day of days) {
    // `opts.days` is an explicit request: honor it whatever it costs.
    if (opts.days !== undefined) {
      if (included >= opts.days) break
    } else if (included > 0 && rows + day.rows > cap) {
      break
    }
    rows += day.rows
    included += 1
  }

  return {
    since: days[included - 1].date,
    until: days[0].date,
    days: included,
    rows,
    boundBy,
    totalDays: days.length,
    totalRows,
    narrowed: included < days.length,
  }
}

/**
 * An empty result, for a caller that wants to watch one fill in.
 *
 * @returns {OverviewRows}
 */
export function emptyOverview() {
  return { providerRows: [], dailyRows: [], repoRows: [], toolRows: [] }
}

/**
 * Whether a (possibly partial) result has enough to render: a window to
 * state, and at least the headline section behind it.
 *
 * @param {OverviewRows} rows
 * @returns {boolean}
 */
export function hasRenderableOverview(rows) {
  return rows.window !== undefined && rows.providerRows.length > 0
}

/**
 * Which of the requested sections have landed. Lets a caller that stopped
 * early say what is missing rather than presenting a short block as whole.
 *
 * @param {OverviewRows} rows
 * @returns {('models'|'daily'|'repos'|'tools')[]}
 */
export function missingSections(rows) {
  /** @type {Record<string, Record<string, unknown>[]>} */
  const byName = {
    models: rows.providerRows,
    daily: rows.dailyRows,
    repos: rows.repoRows,
    tools: rows.toolRows,
  }
  return OVERVIEW_SECTIONS.filter((s) => byName[s].length === 0)
}

/**
 * Probe the cache, choose a window that fits, then run the requested
 * sections bounded by it. Only the asked-for sections are executed.
 *
 * The probe is what lets the block always render *something*: rather than
 * running four unbounded aggregations and hoping, it learns the per-day
 * row counts first (cheaply) and scopes the real work to what a reader can
 * wait for. The chosen window rides back on the result so the renderer can
 * state it - a number whose period is unstated is not an answer.
 *
 * `into` lets a caller watch the work accumulate: each section is written
 * as it lands, so a caller that stops waiting (the wizard's deadline) can
 * still render what completed instead of discarding it. Without it the
 * partial work of an abandoned run would be thrown away - three finished
 * sections and a fourth in flight would show as nothing.
 *
 * @param {OverviewQueryRunner} runner
 * @param {{
 *   sections?: readonly ('models'|'daily'|'repos'|'tools')[],
 *   targetRows?: number,
 *   days?: number,
 *   budgetMs?: number,
 *   clock?: () => number,
 *   into?: OverviewRows,
 * }} [opts]
 * @returns {Promise<OverviewRows>}
 */
export async function collectOverview(runner, opts = {}) {
  const sections = opts.sections ?? OVERVIEW_SECTIONS
  const clock = opts.clock ?? Date.now
  const out = opts.into ?? emptyOverview()

  // Timing the probe is what makes the plan an observation of this machine
  // rather than an assumption about it: the probe reads every row, so its
  // elapsed time is a fresh per-row rate for the hardware, disk and load
  // the sections are about to meet.
  const probeStart = clock()
  const probe = await runner.run(OVERVIEW_PROBE_SQL)
  const probeMs = Math.max(0, clock() - probeStart)
  const window = chooseOverviewWindow(probe.rows, {
    probeMs,
    ...(opts.targetRows !== undefined ? { targetRows: opts.targetRows } : {}),
    ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
    ...(opts.days !== undefined ? { days: opts.days } : {}),
  })
  // Nothing recorded: no window to state, and no section worth running.
  if (!window) return out
  out.window = window

  const sql = buildOverviewSql(window.since)
  out.sql = sql
  for (const section of OVERVIEW_SECTIONS) {
    if (!sections.includes(section)) continue
    const { rows } = await runner.run(sql[section])
    if (section === 'models') out.providerRows = rows
    else if (section === 'daily') out.dailyRows = rows
    else if (section === 'repos') out.repoRows = rows
    else out.toolRows = rows
  }
  return out
}

/**
 * Render the whole block, including its leading blank line. With no rows
 * at all, renders the empty state: what has to happen before there is
 * anything to show.
 *
 * `showSql` prints the statement behind each section. It is off by default
 * and pointed at by a one-line footer: the token queries are four lines of
 * `json_extract`/`cast` apiece, so printing them always would bury the
 * numbers the block exists to show - but they are also exactly the
 * incantation a user cannot guess, so they stay one flag away.
 *
 * `footer` is opt-out so a caller that closes with its own pointer line
 * (the wizard names `hyp query overview` itself) does not print two dim
 * lines naming the same command back to back.
 *
 * The window is always stated, directly under the title: every number in
 * the block is "per this period", and a total whose period is unstated is
 * not an answer. When the window was narrowed to stay affordable, the same
 * line says so and how to widen it, so a smaller number is never mistaken
 * for less work.
 *
 * @param {{
 *   providerRows: Record<string, unknown>[],
 *   dailyRows: Record<string, unknown>[],
 *   repoRows?: Record<string, unknown>[],
 *   toolRows?: Record<string, unknown>[],
 *   window?: OverviewWindow | undefined,
 *   sql?: { models: string, daily: string, repos: string, tools: string } | undefined,
 *   title?: string,
 *   color?: boolean,
 *   showSql?: boolean,
 *   footer?: boolean,
 *   withheld?: boolean,
 * }} args
 * @returns {string}
 */
export function renderOverview({
  providerRows,
  dailyRows,
  repoRows = [],
  toolRows = [],
  window: win,
  sql,
  title = 'What HypAware has recorded',
  color = false,
  showSql = false,
  footer = true,
  withheld = false,
}) {
  const statements = sql ?? buildOverviewSql(win?.since ?? '')
  let out = `\n${paint(title, ANSI.bold, color)}\n`
  if (win) out += paint(describeWindow(win), ANSI.dim, color) + '\n'
  out += `${paint('─'.repeat(40), ANSI.dim, color)}\n`

  if (providerRows.length === 0) {
    // "Nothing recorded yet" is a claim about the cache; when the LLP 0105
    // filter took every row it is a false one, and the withheld-row count
    // on stderr would be the only sign. Two different situations, two
    // different sentences, neither of them "start a session" to someone
    // whose sessions are all sitting there recorded.
    out += withheld
      ? '\nEvery recorded session in this window is marked local-only and not visible\n' +
        'from here. Re-run inside one of those directories, or with --include-local-only.\n'
      : '\nNothing recorded yet. Start a session in a client you attached,\n' +
        'then run `hyp query overview` again.\n'
    return out
  }

  // Painted per line: one SGR pair spanning a newline leaves the dim
  // attribute set across the break on some terminals.
  out += UNIT_LEGEND.split('\n').map((line) => paint(line, ANSI.dim, color)).join('\n') + '\n'
  out += barKeyLine(color) + '\n'
  out += '\n' + renderProviderMix(providerRows, color, showSql, statements.models)
  if (dailyRows.length > 0) out += '\n' + renderDailyActivity(dailyRows, color, showSql, statements.daily)
  if (repoRows.length > 0) out += '\n' + renderRepoMix(repoRows, color, showSql, statements.repos)
  if (toolRows.length > 0) out += '\n' + renderToolMix(toolRows, color, showSql, statements.tools)
  if (!showSql && footer) out += paint('\nThe SQL behind these: hyp query overview --sql\n', ANSI.dim, color)
  return out
}

/**
 * The window line: the period every number below describes, plus - when
 * the window was capped - what was left out and how to ask for it.
 *
 * @param {OverviewWindow} win
 * @returns {string}
 */
export function describeWindow(win) {
  const span = `${win.since} to ${win.until}`
  // "active days", not "days": the bounds are calendar dates but the count
  // is dates that recorded something, and a quiet weekend inside the range
  // would otherwise make the two look contradictory.
  const unit = `active day${win.days === 1 ? '' : 's'}`
  if (!win.narrowed) return `${span} (${win.days} ${unit}, ${formatCount(win.rows)} rows)`
  // Narrowed means totalDays > days >= 1, so the count it agrees with is
  // always plural - "1 of 30 active day" reads as a typo.
  // States what is shown and how to see more - not why it is short. The
  // reason (a row budget, a slow machine, an explicit --days) is the tool's
  // business; the reader only needs the scope and the lever. One wording
  // for every reason, so a window the user asked for does not arrive with
  // an apology attached.
  return (
    `${span} - showing ${win.days} of ${win.totalDays} active days ` +
    `(${formatCount(win.rows)} of ${formatCount(win.totalRows)} rows); widen with --days ${win.totalDays}`
  )
}

/**
 * Providers and models by token volume, largest first.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {boolean} color
 * @param {boolean} [showSql]
 * @param {string} [sql] the statement this section ran, for `--sql`
 * @returns {string}
 */
export function renderProviderMix(rows, color, showSql = false, sql = '') {
  // A zero-token row would render as "0  0  0", which reads like a bug, so
  // the table shows only measured rows. What the omitted ones are decides
  // whether their absence is worth a word:
  //
  //   - No model label: prompts, tool results, and every other row a model
  //     never answered. These CANNOT carry usage - a response's tokens are
  //     stamped on the response (LLP 0035 #one-carrier), so the prompt's
  //     cost is already in the answering model's `input`/`cached`. Counting
  //     them as "models without token counts" (14.5k prompts read as "2
  //     models") described the reader's own messages as something else.
  //     Omitted silently: nothing is missing to report.
  //   - Labelled, but zero: a real model whose provider reported no usage.
  //     That IS a gap in what was recorded, so it is counted out loud.
  const counted = rows.filter((r) => tokenTotal(r) > 0)
  const untokened = rows.filter((r) => tokenTotal(r) === 0 && hasModelLabel(r)).length
  const shown = counted.slice(0, MAX_PROVIDER_ROWS)
  const max = Math.max(...shown.map((r) => toNumber(r.input_tokens) + toNumber(r.output_tokens)))
  const body = shown.map((r) => [
    cell(r.provider),
    // An unlabelled row only reaches the table if it carried tokens, which
    // today it never does. If that changes, name it for what it is rather
    // than dropping measured tokens on the floor.
    truncate(hasModelLabel(r) ? String(r.model).trim() : '(model not recorded)', MAX_MODEL_WIDTH),
    formatCount(r.input_tokens),
    formatCount(r.cached_tokens),
    formatCount(r.output_tokens),
    tokenBar(toNumber(r.input_tokens), toNumber(r.output_tokens), max, color),
  ])

  let out = renderHeading('Which providers and models you use, by volume', sql, color, showSql)
  if (shown.length === 0) {
    // Traffic exists but no provider reported usage: say that, rather than
    // printing an empty table under a "by volume" heading.
    if (untokened === 0) return out + '  No token counts were recorded.\n'
    return out + `  ${untokened} model${untokened === 1 ? ' was' : 's were'} recorded, none with token counts.\n`
  }
  out += renderTable(
    ['provider', 'model', 'input', 'cached', 'output', 'by input+output'],
    body,
    ['left', 'left', 'right', 'right', 'right', 'left'],
    color,
    tokenBarCaption(color)
  )
  const hidden = counted.length - shown.length
  if (hidden > 0) out += paint(`  + ${hidden} more model${hidden === 1 ? '' : 's'}\n`, ANSI.dim, color)
  if (untokened > 0) {
    out += paint(
      `  + ${untokened} model${untokened === 1 ? '' : 's'} whose traffic was recorded without token counts\n`,
      ANSI.dim,
      color
    )
  }
  return out
}

/**
 * Sessions and tokens per day, most recent first.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {boolean} color
 * @param {boolean} [showSql]
 * @returns {string}
 */
export function renderDailyActivity(rows, color, showSql = false, sql = '') {
  const shown = rows.slice(0, MAX_DAY_ROWS)
  const max = Math.max(...shown.map((r) => toNumber(r.input_tokens) + toNumber(r.output_tokens)))
  const body = shown.map((r) => [
    cell(r.date),
    formatCount(r.sessions),
    formatCount(r.input_tokens),
    formatCount(r.cached_tokens),
    formatCount(r.output_tokens),
    tokenBar(toNumber(r.input_tokens), toNumber(r.output_tokens), max, color),
  ])

  let out = renderHeading('Sessions and tokens per day', sql, color, showSql)
  out += renderTable(
    ['day', 'sessions', 'input', 'cached', 'output', 'by input+output'],
    body,
    ['left', 'right', 'right', 'right', 'right', 'left'],
    color,
    tokenBarCaption(color)
  )
  // The header states the window; this table may be shorter than it. Say
  // so, or someone summing the column gets a fraction of the period they
  // were just told they were looking at.
  const older = rows.length - shown.length
  if (older > 0) {
    out += paint(`  + ${older} earlier day${older === 1 ? '' : 's'} in this window\n`, ANSI.dim, color)
  }
  return out
}

/**
 * Which repos the sessions ran in, busiest first.
 *
 * Sessions with no repo are folded into a count line rather than dropped
 * or rendered as a blank-named row: on the authoring machine that is 177
 * of 431 sessions, so hiding them silently would misrepresent the split,
 * and a nameless row would just look broken.
 *
 * The line says "no repo recorded", not "outside any repo", because those
 * are not the same claim and this column cannot tell them apart: Codex
 * rows carry `cwd` (and sometimes `git_branch`) but never `repo_root`, so
 * every Codex session lands here regardless of where it actually ran.
 * Saying they were outside a repo would state something false about them.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {boolean} color
 * @param {boolean} [showSql]
 * @returns {string}
 */
export function renderRepoMix(rows, color, showSql = false, sql = '') {
  const named = rows.filter((r) => typeof r.repo_root === 'string' && r.repo_root.trim().length > 0)
  const loose = rows.filter((r) => !named.includes(r)).reduce((n, r) => n + toNumber(r.sessions), 0)
  const shown = named.slice(0, MAX_REPO_ROWS)

  let out = renderHeading('Which repos the work happens in', sql, color, showSql)
  if (shown.length === 0) {
    return out + `  No repo was recorded on any session (${formatCount(loose)} of them).\n`
  }

  // Scaled on the same metric the bar charts, so a row's width means the
  // same thing here as in the models and daily tables.
  const max = Math.max(...shown.map((r) => toNumber(r.input_tokens) + toNumber(r.output_tokens)))
  const body = shown.map((r) => [
    shortRepo(String(r.repo_root)),
    formatCount(r.sessions),
    formatCount(r.input_tokens),
    formatCount(r.cached_tokens),
    formatCount(r.output_tokens),
    tokenBar(toNumber(r.input_tokens), toNumber(r.output_tokens), max, color),
  ])
  out += renderTable(
    ['repo', 'sessions', 'input', 'cached', 'output', 'by input+output'],
    body,
    ['left', 'right', 'right', 'right', 'right', 'left'],
    color,
    tokenBarCaption(color)
  )

  const hidden = named.length - shown.length
  if (hidden > 0) out += paint(`  + ${hidden} more repo${hidden === 1 ? '' : 's'}\n`, ANSI.dim, color)
  if (loose > 0) {
    out += paint(`  + ${formatCount(loose)} session${loose === 1 ? '' : 's'} with no repo recorded\n`, ANSI.dim, color)
  }
  return out
}

/**
 * Which tools the models reach for, most-called first.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {boolean} color
 * @param {boolean} [showSql]
 * @returns {string}
 */
export function renderToolMix(rows, color, showSql = false, sql = '') {
  const max = Math.max(...rows.map((r) => toNumber(r.calls)))
  const body = rows.map((r) => [
    truncate(cell(r.tool_name), MAX_MODEL_WIDTH),
    formatCount(r.calls),
    formatCount(r.sessions),
    paint(bar(toNumber(r.calls), max), ANSI.cyan, color),
  ])

  const out = renderHeading('Which tools get called', sql, color, showSql)
  return out + renderTable(['tool', 'calls', 'sessions', 'by calls'], body, ['left', 'right', 'right', 'left'], color)
}

/**
 * The bar key: each glyph and its word share a colour, so the mapping is
 * legible without reading the sentence. Assembled per segment rather than
 * dimmed as one run - a colour sequence inside a dim run ends it early.
 *
 * @param {boolean} color
 * @returns {string}
 */
function barKeyLine(color) {
  const dim = (/** @type {string} */ t) => paint(t, ANSI.dim, color)
  return (
    dim('Token bars split ') +
    paint(`${BAR_INPUT_CELL} input`, ANSI.magenta, color) +
    dim(' from ') +
    paint(`${BAR_OUTPUT_CELL} output`, ANSI.cyan, color) +
    dim('; cache is excluded.')
  )
}

/**
 * "by input+output" with each word in its bar shade, so the header itself
 * is the key: no legend lookup to learn which half of a bar is which.
 *
 * @param {boolean} color
 * @returns {string}
 */
function tokenBarCaption(color) {
  return (
    paint('by ', ANSI.dim, color) +
    paint('input', ANSI.magenta, color) +
    paint('+', ANSI.dim, color) +
    paint('output', ANSI.cyan, color)
  )
}

/**
 * A repo path shortened to its last two segments. Absolute paths are wide
 * enough to force the numeric columns off screen, and the tail is what
 * distinguishes them anyway (`hypaware-2/hypaware` from
 * `hypaware-3/hypaware`), which a basename alone would collapse.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
function shortRepo(repoRoot) {
  const parts = repoRoot.split('/').filter(Boolean)
  return parts.length <= 2 ? repoRoot : parts.slice(-2).join('/')
}

/**
 * A section title, optionally over the exact command that produced it.
 * The statement is indented as one runnable `hyp query sql "..."`: a
 * shell keeps embedded newlines inside the quotes, so the printed form
 * pastes and runs unchanged.
 *
 * @param {string} title
 * @param {string} sql
 * @param {boolean} color
 * @param {boolean} showSql
 * @returns {string}
 */
function renderHeading(title, sql, color, showSql) {
  if (!showSql) return `${title}\n\n`
  const indented = sql.split('\n').map((line, i) => (i === 0 ? line : `  ${line}`)).join('\n')
  return `${title}\n${paint(`  hyp query sql "${indented}"`, ANSI.dim, color)}\n\n`
}

/**
 * Pad `body` into aligned columns under a dim header row. The last column
 * is never padded, so a trailing bar column adds no trailing spaces.
 *
 * `caption` replaces the last header cell with a pre-painted string, so a
 * token table can colour the words "input" and "output" to match the shades
 * in the bars underneath. Header cells are painted one at a time rather
 * than as one dim run: a colour sequence inside a dim run ends it early,
 * leaving the rest of the row undimmed.
 *
 * @param {string[]} headers
 * @param {string[][]} body
 * @param {('left'|'right')[]} aligns
 * @param {boolean} color
 * @param {string} [caption] pre-painted replacement for the last header
 * @returns {string}
 */
function renderTable(headers, body, aligns, color, caption) {
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)))
  const last = headers.length - 1
  const headerLine = headers
    .map((h, i) => (i === last
      ? caption ?? paint(h, ANSI.dim, color)
      : paint(pad(h, widths[i], aligns[i]), ANSI.dim, color)))
    .join('  ')
  let out = `  ${headerLine}\n`
  // Bars arrive already painted: a token bar carries two colours, so the
  // table cannot assume one.
  for (const row of body) {
    const padded = row
      .map((c, i) => (i === row.length - 1 ? c : pad(c ?? '', widths[i], aligns[i])))
      .join('  ')
      .trimEnd()
    out += `  ${padded}\n`
  }
  return out
}

/**
 * @param {string} text
 * @param {number} width
 * @param {'left'|'right'} align
 */
function pad(text, width, align) {
  const fill = ' '.repeat(Math.max(0, width - text.length))
  return align === 'right' ? fill + text : text + fill
}

/**
 * A two-tone bar: input tokens then output tokens, scaled against the
 * largest `input + output` in the table.
 *
 * Cache is excluded on purpose. Cached runs 99.0-99.9% of every day's total
 * on real data, so a total-token bar is a cache-read chart: one long
 * conversation re-reading a big prompt outranks a day with 37 sessions,
 * and every other bar flattens against it. Cache is also the cheapest
 * token there is, so a total would weight the least significant volume
 * most heavily. Input + output is the tokens that were actually new.
 *
 * The split is encoded twice - shade *and* colour - so it survives a
 * monochrome terminal, a pipe (`color: false`), and colour-blind readers.
 *
 * @param {number} input
 * @param {number} output
 * @param {number} max largest `input + output` in the same table
 * @param {boolean} color
 * @returns {string}
 */
function tokenBar(input, output, max, color) {
  const total = Math.max(0, input) + Math.max(0, output)
  if (!(total > 0) || !(max > 0)) return ''
  const width = Math.min(BAR_WIDTH, Math.max(1, Math.round((total / max) * BAR_WIDTH)))
  let inputCells = Math.round((input / total) * width)
  // Never let a present component vanish, and never let it eat the whole
  // bar: a row that is 99% output should still show that it had input.
  if (input > 0 && inputCells === 0) inputCells = 1
  if (output > 0 && inputCells === width) inputCells = width - 1
  return (
    paint(BAR_INPUT_CELL.repeat(inputCells), ANSI.magenta, color) +
    paint(BAR_OUTPUT_CELL.repeat(width - inputCells), ANSI.cyan, color)
  )
}

/**
 * @param {number} value
 * @param {number} max
 * @returns {string}
 */
function bar(value, max) {
  if (!(value > 0) || !(max > 0)) return ''
  return '█'.repeat(Math.min(BAR_WIDTH, Math.max(1, Math.round((value / max) * BAR_WIDTH))))
}

/**
 * Group-by results carry empty strings for parts a provider did not label
 * (an unnamed model, an undated row), so render the absence explicitly
 * rather than emitting a blank column the reader has to interpret.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  if (value === null || value === undefined) return '(none)'
  const text = String(value).trim()
  return text.length === 0 ? '(none)' : text
}

/**
 * @param {string} text
 * @param {number} width
 */
function truncate(text, width) {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

/**
 * True when the group names a model. A group without one is not a model
 * at all: it is the rows no model answered (prompts, tool results), which
 * carry no usage by construction.
 *
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
function hasModelLabel(row) {
  return row.model !== null && row.model !== undefined && String(row.model).trim().length > 0
}

/**
 * Every token a row accounts for. Used only to tell a measured row from
 * one whose provider reported no usage at all.
 *
 * @param {Record<string, unknown>} row
 * @returns {number}
 */
function tokenTotal(row) {
  return toNumber(row.input_tokens) + toNumber(row.cached_tokens) + toNumber(row.output_tokens)
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Thousands separators without `toLocaleString`, whose grouping depends on
 * the host locale and would make the rendered block non-deterministic.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatCount(value) {
  // `Number(null)` is 0, so an absent count would otherwise read as a real
  // zero; route every empty value through the same `(none)` rendering.
  if (value === null || value === undefined || value === '') return cell(value)
  const n = Number(value)
  if (!Number.isFinite(n)) return cell(value)
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

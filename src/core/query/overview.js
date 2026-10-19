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

import { compareStrings } from '../util/compare_strings.js'
import { groupThousands } from '../util/format_number.js'
import { escapeForDisplay } from '../util/json_util.js'
import { AUTO_REFRESH_FAILURE_MESSAGE, REFRESH_FAILURE_REASON_PREFIX, executeQuerySql } from './sql.js'
import { renderLocalOnlyNotice } from './verb.js'
// @ref LLP 0189#palette [implements]: one ANSI table for the whole CLI
import { ANSI, displayWidth, paint, widthStepper } from '../cli/style.js'

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
 * `sections` is what is about to run, not the list of sections that exist.
 * `collectOverview` executes only the sections it was asked for, so
 * charging a two-section caller for four halves the window it gets in
 * exchange for work nobody will do - and the narrowing is invisible to it,
 * since a window bound by time reports no reason. LLP 0135 #window puts the
 * divisor as `perRowMs x 1.9 x sections`, which is the count planned.
 *
 * An empty section list divides by zero and yields `Infinity`, which is the
 * honest answer: no sections means no section cost, and the row cap decides
 * a window nothing will scan.
 *
 * @ref LLP 0135#window [implements]: the cost model's section term is the sections being planned for
 * @param {{
 *   budgetMs?: number,
 *   probeMs?: number,
 *   totalRows: number,
 *   sections?: readonly ('models'|'daily'|'repos'|'tools')[],
 * }} args
 * @returns {number}
 */
function rowsAffordable({
  budgetMs = OVERVIEW_TIME_BUDGET_MS,
  probeMs,
  totalRows,
  sections = OVERVIEW_SECTIONS,
}) {
  if (probeMs === undefined || totalRows <= 0) return Infinity
  // A probe too fast to time is not evidence of infinite speed; floor it at
  // 1ms so the estimate stays finite and the row cap keeps its say.
  const perRowMs = Math.max(probeMs, 1) / totalRows
  return Math.floor(budgetMs / (perRowMs * SECTION_COST_VS_PROBE * sections.length))
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

/** Bar column width, in cells, when the terminal has room for it. */
const BAR_WIDTH = 18

/** Model names longer than this are ellipsized so the columns stay aligned. */
const MAX_MODEL_WIDTH = 30

/**
 * The width the block is laid out for when the stream reports none: a pipe,
 * a file, a test buffer. Fixed rather than guessed, so piped output is the
 * same on every machine, and wide enough that the full layout fits.
 */
export const OVERVIEW_DEFAULT_COLUMNS = 100

/**
 * The first floors a narrow terminal reaches: the bar gives up cells before
 * any label does, then labels are ellipsized to this, then the bar shrinks
 * to its header. Counts never give ground (#410).
 */
const NARROW_BAR_WIDTH = 6
const NARROW_LABEL_WIDTH = 16

/** The last floor for a label before the table is stacked instead. */
const MIN_LABEL_WIDTH = 8

/** Each table row's leading indent, and the gap between its columns. */
const TABLE_INDENT = 2
const COLUMN_GAP = 2

/**
 * Code units a clipped cell keeps per column: room for the longest joined
 * emoji, with skin tones, and a bound on marks that draw nothing.
 */
const MAX_UNITS_PER_CELL = 8

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
 * `includeLocalOnly` is LLP 0105's informed-consent override, and it is the
 * caller's to pass, never this module's to assume. `hyp query overview`
 * exposes it because the disclosure it prints names it as the remedy - a
 * block that says "rerun with --include-local-only" and then refuses the
 * flag is worse than one that never mentioned it. The wizard never passes
 * it: nothing during an unattended-feeling setup step should quietly widen
 * what a captured transcript can carry.
 *
 * @param {CommandRunContext} ctx
 * @param {(notice: OverviewNotice) => void} [onNotice]
 * @param {{ includeLocalOnly?: boolean }} [opts]
 * @returns {OverviewQueryRunner | undefined}
 */
export function overviewRunnerFromCtx(ctx, onNotice, opts = {}) {
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
        includeLocalOnly: opts.includeLocalOnly === true,
      })
      for (const line of result.freshnessMessages ?? []) {
        // Split by meaning, not by source array. The debounce line is
        // advisory and a caller may drop it; the degrade warning says rows
        // are missing, so it routes with the disclosures instead, and the
        // reason line routes beside the warning it explains: a caller
        // allowed to drop the advisory line must not be able to keep "rows
        // may be missing" while dropping the why.
        // @ref LLP 0321#consequences [implements]: a degraded result never claims to be current, on every surface that renders it
        // @ref LLP 0330#query-quotes-the-reason [implements]: the reason is part of the disclosure, not a droppable advisory
        const kind = line === AUTO_REFRESH_FAILURE_MESSAGE || line.startsWith(REFRESH_FAILURE_REASON_PREFIX)
          ? 'refresh-failed'
          : 'freshness'
        say({ kind, line: `${line}\n` })
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
 *   sections?: readonly ('models'|'daily'|'repos'|'tools')[],
 * }} [opts] `days` pins an explicit window (the user asked for it) and
 *   skips both caps; `probeMs` is how long the probe took over every row,
 *   which calibrates the time cap to this machine; `sections` is the work
 *   the time cap is being asked to pay for, defaulting to all four
 * @returns {OverviewWindow | null} null when nothing has been recorded
 * @ref LLP 0135#window [implements]: the affordable-window plan, measured on the machine it runs on
 */
export function chooseOverviewWindow(probeRows, opts = {}) {
  const days = [...probeRows]
    .map((r) => ({ date: cell(r.date), rows: toNumber(r.n) }))
    .filter((d) => d.date !== '(none)')
    .sort((a, b) => compareStrings(b.date, a.date))
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
    ...(opts.sections !== undefined ? { sections: opts.sections } : {}),
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
 * Which of the requested sections have not landed. Lets a caller that
 * stopped early say what is missing rather than presenting a short block as
 * whole.
 *
 * Requested, not existing: the wizard prints this list as "the repos and
 * tools sections did not finish", and a section nobody asked for did not
 * fail to finish - it was never started. Naming it would be the same false
 * claim as calling an unfinished section empty, in the other direction.
 * `collectOverview` stamps the plan on the result, so a subset run carries
 * what it meant to do; a result assembled by hand falls back to all four.
 * The wizard's two-section first look reads its answer from that stamp
 * (LLP 0198#wizard-sections).
 *
 * @ref LLP 0135#overrun [implements]: unfinished sections are named as unfinished, which only the requested ones can be
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
  return (rows.sections ?? OVERVIEW_SECTIONS).filter((s) => byName[s].length === 0)
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
  // Recorded on the result, before any await, because after an abandoned
  // run the result object is all the caller still holds - and `missing`
  // means "asked for and did not land", which needs the plan to read.
  out.sections = sections

  // Timing the probe is what makes the plan an observation of this machine
  // rather than an assumption about it: the probe reads every row, so its
  // elapsed time is a fresh per-row rate for the hardware, disk and load
  // the sections are about to meet.
  const probeStart = clock()
  const probe = await runner.run(OVERVIEW_PROBE_SQL)
  const probeMs = Math.max(0, clock() - probeStart)
  const window = chooseOverviewWindow(probe.rows, {
    probeMs,
    sections,
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
 *   columns?: number | undefined,
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
  columns,
}) {
  // Whatever the caller read off its stream: a pipe has no width, and a
  // width that is not a positive number is no width either.
  const width = typeof columns === 'number' && columns > 0 ? Math.floor(columns) : OVERVIEW_DEFAULT_COLUMNS
  const statements = sql ?? buildOverviewSql(win?.since ?? '')
  let out = '\n' + wrapText(title, width).map((line) => paint(line, ANSI.bold, color) + '\n').join('')
  if (win) out += wrapText(describeWindow(win), width).map((line) => paint(line, ANSI.dim, color) + '\n').join('')
  out += `${paint('─'.repeat(Math.min(40, width)), ANSI.dim, color)}\n`

  if (providerRows.length === 0) {
    // "Nothing recorded yet" is a claim about the cache; when the LLP 0105
    // filter took every row it is a false one, and the withheld-row count
    // on stderr would be the only sign. Two different situations, two
    // different sentences.
    out += withheld
      ? '\n' + wrapLines(
        'Every recorded session in this window is marked local-only and not visible\n' +
        'from here. Re-run inside one of those directories, or with --include-local-only.',
        width
      ).join('\n') + '\n'
      : '\nNothing recorded yet.\n'
    return out
  }

  // Painted per line: one SGR pair spanning a newline leaves the dim
  // attribute set across the break on some terminals.
  out += wrapLines(UNIT_LEGEND, width).map((line) => paint(line, ANSI.dim, color)).join('\n') + '\n'
  out += barKeyLine(color, width) + '\n'
  out += '\n' + renderProviderMix(providerRows, color, showSql, statements.models, width)
  if (dailyRows.length > 0) out += '\n' + renderDailyActivity(dailyRows, color, showSql, statements.daily, width)
  if (repoRows.length > 0) out += '\n' + renderRepoMix(repoRows, color, showSql, statements.repos, width)
  if (toolRows.length > 0) out += '\n' + renderToolMix(toolRows, color, showSql, statements.tools, width)
  if (!showSql && footer) {
    // Broken only between the label and the command, so the command pastes whole.
    const pointer = ['The SQL behind these:', 'hyp query overview --sql']
    const lines = displayWidth(pointer.join(' ')) <= width ? [pointer.join(' ')] : pointer
    out += '\n' + lines.map((line) => paint(line, ANSI.dim, color)).join('\n') + '\n'
  }
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
 * @param {number} [columns] the width to lay the table out in
 * @returns {string}
 */
export function renderProviderMix(rows, color, showSql = false, sql = '', columns = OVERVIEW_DEFAULT_COLUMNS) {
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
    // than dropping measured tokens on the floor. Raw here: the table
    // clips it to the width it settles on, then escapes it.
    hasModelLabel(r) ? String(r.model).trim() : '(model not recorded)',
    formatCount(r.input_tokens),
    formatCount(r.cached_tokens),
    formatCount(r.output_tokens),
    '',
  ])

  let out = renderHeading('Which providers and models you use, by volume', sql, color, showSql, columns)
  if (shown.length === 0) {
    // Traffic exists but no provider reported usage: say that, rather than
    // printing an empty table under a "by volume" heading.
    if (untokened === 0) return out + prose('No token counts were recorded.', columns)
    return out + prose(`${untokened} model${untokened === 1 ? ' was' : 's were'} recorded, none with token counts.`, columns)
  }
  out += renderTable({
    headers: ['provider', 'model', 'input', 'cached', 'output', SHARE_HEADER],
    aligns: ['left', 'left', 'right', 'right', 'right', 'left'],
    body,
    label: 1,
    labelMax: MAX_MODEL_WIDTH,
    bar: (i, w) => tokenBar(toNumber(shown[i].input_tokens), toNumber(shown[i].output_tokens), max, color, w),
    color,
    columns,
  })
  const hidden = counted.length - shown.length
  if (hidden > 0) out += note(`+ ${hidden} more model${hidden === 1 ? '' : 's'}`, color, columns)
  if (untokened > 0) {
    out += note(
      `+ ${untokened} model${untokened === 1 ? '' : 's'} whose traffic was recorded without token counts`,
      color,
      columns
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
 * @param {string} [sql]
 * @param {number} [columns]
 * @returns {string}
 */
export function renderDailyActivity(rows, color, showSql = false, sql = '', columns = OVERVIEW_DEFAULT_COLUMNS) {
  const shown = rows.slice(0, MAX_DAY_ROWS)
  const max = Math.max(...shown.map((r) => toNumber(r.input_tokens) + toNumber(r.output_tokens)))
  const body = shown.map((r) => [
    cell(r.date),
    formatCount(r.sessions),
    formatCount(r.input_tokens),
    formatCount(r.cached_tokens),
    formatCount(r.output_tokens),
    '',
  ])

  let out = renderHeading('Sessions and tokens per day', sql, color, showSql, columns)
  out += renderTable({
    headers: ['day', 'sessions', 'input', 'cached', 'output', SHARE_HEADER],
    aligns: ['left', 'right', 'right', 'right', 'right', 'left'],
    body,
    bar: (i, w) => tokenBar(toNumber(shown[i].input_tokens), toNumber(shown[i].output_tokens), max, color, w),
    color,
    columns,
  })
  // The header states the window; this table may be shorter than it. Say
  // so, or someone summing the column gets a fraction of the period they
  // were just told they were looking at.
  const older = rows.length - shown.length
  if (older > 0) {
    out += note(`+ ${older} earlier day${older === 1 ? '' : 's'} in this window`, color, columns)
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
 * @param {string} [sql]
 * @param {number} [columns]
 * @returns {string}
 */
export function renderRepoMix(rows, color, showSql = false, sql = '', columns = OVERVIEW_DEFAULT_COLUMNS) {
  const named = rows.filter((r) => typeof r.repo_root === 'string' && r.repo_root.trim().length > 0)
  const loose = rows.filter((r) => !named.includes(r)).reduce((n, r) => n + toNumber(r.sessions), 0)
  const shown = named.slice(0, MAX_REPO_ROWS)

  let out = renderHeading('Which repos the work happens in', sql, color, showSql, columns)
  if (shown.length === 0) {
    return out + prose(`No repo was recorded on any session (${formatCount(loose)} of them).`, columns)
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
    '',
  ])
  out += renderTable({
    headers: ['repo', 'sessions', 'input', 'cached', 'output', SHARE_HEADER],
    aligns: ['left', 'right', 'right', 'right', 'right', 'left'],
    body,
    label: 0,
    bar: (i, w) => tokenBar(toNumber(shown[i].input_tokens), toNumber(shown[i].output_tokens), max, color, w),
    color,
    columns,
  })

  const hidden = named.length - shown.length
  if (hidden > 0) out += note(`+ ${hidden} more repo${hidden === 1 ? '' : 's'}`, color, columns)
  if (loose > 0) {
    out += note(`+ ${formatCount(loose)} session${loose === 1 ? '' : 's'} with no repo recorded`, color, columns)
  }
  return out
}

/**
 * Which tools the models reach for, most-called first.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {boolean} color
 * @param {boolean} [showSql]
 * @param {string} [sql]
 * @param {number} [columns]
 * @returns {string}
 */
export function renderToolMix(rows, color, showSql = false, sql = '', columns = OVERVIEW_DEFAULT_COLUMNS) {
  const max = Math.max(...rows.map((r) => toNumber(r.calls)))
  const body = rows.map((r) => [
    labelText(r.tool_name),
    formatCount(r.calls),
    formatCount(r.sessions),
    '',
  ])

  const out = renderHeading('Which tools get called', sql, color, showSql, columns)
  return out + renderTable({
    headers: ['tool', 'calls', 'sessions', 'by calls'],
    aligns: ['left', 'right', 'right', 'left'],
    body,
    label: 0,
    labelMax: MAX_MODEL_WIDTH,
    bar: (i, w) => paint(bar(toNumber(rows[i].calls), max, w), ANSI.cyan, color),
    color,
    columns,
  })
}

/**
 * The token tables' bar header. It was `by input+output`, and a column is
 * never narrower than its header, so those 15 characters were a floor no
 * bar width could get under. The key line above the tables says what the
 * share charts, so the header no longer has to (#410).
 */
const SHARE_HEADER = 'share'

/**
 * The bar key, and the caption for the `share` column: each glyph and its
 * word share a colour, so the mapping is legible without reading the
 * sentence. Assembled per segment rather than dimmed as one run - a colour
 * sequence inside a dim run ends it early. Broken before its last clause
 * when the line would not fit.
 *
 * @param {boolean} color
 * @param {number} columns
 * @returns {string}
 */
function barKeyLine(color, columns) {
  const dim = (/** @type {string} */ t) => paint(t, ANSI.dim, color)
  const key =
    dim('Share bars split ') +
    paint(`${BAR_INPUT_CELL} input`, ANSI.magenta, color) +
    dim(' from ') +
    paint(`${BAR_OUTPUT_CELL} output`, ANSI.cyan, color) +
    dim(';')
  const rest = 'cache is excluded.'
  return displayWidth(key) + 1 + rest.length <= columns ? key + dim(` ${rest}`) : `${key}\n${dim(rest)}`
}

/**
 * A dim note under a table, wrapped to the width with its continuation
 * lines indented under the text.
 *
 * @param {string} text
 * @param {boolean} color
 * @param {number} columns
 * @returns {string}
 */
function note(text, color, columns) {
  return prose(text, columns, color ? ANSI.dim : '')
}

/**
 * A sentence in a section's body, wrapped to the width with its
 * continuation lines indented under the text, each line painted `style`.
 *
 * @param {string} text
 * @param {number} columns
 * @param {string} [style]
 * @returns {string}
 */
function prose(text, columns, style = '') {
  return wrapText(text, columns - TABLE_INDENT)
    .map((line, i) => paint(`${i === 0 ? '  ' : '    '}${line}`, style, style !== '') + '\n')
    .join('')
}

/**
 * Each line of `text` word-wrapped to `width`. A line that already fits is
 * returned as it is, so text written to fit 80 columns is unchanged there.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
function wrapLines(text, width) {
  return text.split('\n').flatMap((line) => wrapText(line, width))
}

/**
 * One line word-wrapped to `width` at spaces. A word wider than the width
 * keeps its own line rather than being cut: it is a path or a flag, and a
 * split one would not paste.
 *
 * @param {string} line
 * @param {number} width
 * @returns {string[]}
 */
function wrapText(line, width) {
  if (displayWidth(line) <= width) return [line]
  /** @type {string[]} */
  const out = []
  let current = ''
  for (const word of line.split(' ')) {
    const next = current === '' ? word : `${current} ${word}`
    if (current !== '' && displayWidth(next) > width) {
      out.push(current)
      current = word
    } else {
      current = next
    }
  }
  out.push(current)
  return out
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
 * @param {number} columns the title wraps to it; the statement does not,
 *   since a line broken inside it would no longer paste and run
 * @returns {string}
 */
function renderHeading(title, sql, color, showSql, columns) {
  const heading = wrapText(title, columns).join('\n')
  if (!showSql) return `${heading}\n\n`
  const indented = sql.split('\n').map((line, i) => (i === 0 ? line : `  ${line}`)).join('\n')
  return `${heading}\n${paint(`  hyp query sql "${indented}"`, ANSI.dim, color)}\n\n`
}

/**
 * Pad `body` into aligned columns under a dim header row, in at most
 * `columns` terminal columns. The last column is the bar, never padded, so
 * it adds no trailing spaces. Header cells are painted one at a time rather
 * than as one dim run: a colour sequence inside a dim run ends it early,
 * leaving the rest of the row undimmed.
 *
 * The layout is settled once per table, from the cells' displayed widths
 * (style escapes ignored, wide characters counted twice). Only two columns
 * give ground: the bar, then the one `label` column, a captured name whose
 * clip is display-only. Every count keeps its full width. When even the
 * floors do not fit, the rows are stacked one field per line instead of
 * overflowing (#410).
 *
 * `body` holds every cell but the bar, already formatted, except the label
 * column, which arrives raw so it can be clipped before it is escaped; the
 * bar is drawn by `bar` at the width the layout chose.
 *
 * @param {{
 *   headers: string[],
 *   aligns: ('left'|'right')[],
 *   body: string[][],
 *   bar: (row: number, width: number) => string,
 *   label?: number,
 *   labelMax?: number,
 *   color: boolean,
 *   columns: number,
 * }} table
 * @returns {string}
 */
function renderTable({ headers, aligns, body, bar, label = -1, labelMax = Infinity, color, columns }) {
  const last = headers.length - 1
  const widths = headers.map((h, i) => (i === last || i === label
    ? 0
    : Math.max(displayWidth(h), ...body.map((r) => displayWidth(r[i])))))
  const fixed = TABLE_INDENT + COLUMN_GAP * last + widths.reduce((sum, w) => sum + w, 0)
  const labelHeader = label < 0 ? 0 : displayWidth(headers[label])
  const labelNatural = label < 0
    ? 0
    : Math.max(labelHeader, Math.min(labelMax, Math.max(...body.map((r) => displayWidth(escapeForDisplay(r[label]))))))
  const fit = fitTable(columns - fixed, labelNatural, Math.max(labelHeader, MIN_LABEL_WIDTH), displayWidth(headers[last]))
  if (!fit) return renderStacked({ headers, aligns, body, bar, label, labelMax, columns })

  const cells = body.map((r, n) => r.map((c, i) => (i === last ? bar(n, fit.bar) : i === label ? cell(c, fit.label) : c)))
  if (label >= 0) widths[label] = Math.max(labelHeader, ...cells.map((r) => displayWidth(r[label])))
  const headerLine = headers
    .map((h, i) => paint(i === last ? h : pad(h, widths[i], aligns[i]), ANSI.dim, color))
    .join('  ')
  let out = `  ${headerLine}\n`
  // Bars arrive already painted: a token bar carries two colours, so the
  // table cannot assume one.
  for (const row of cells) {
    const padded = row
      .map((c, i) => (i === last ? c : pad(c, widths[i], aligns[i])))
      .join('  ')
      .trimEnd()
    out += `  ${padded}\n`
  }
  return out
}

/**
 * The label and bar widths that fit `room`, the columns left once the
 * fixed columns are placed, or null when the floors do not fit. The bar
 * gives ground first, down to a short bar; then the label, down to a
 * readable clip; then the bar to its header, which sets the column's width
 * whatever the bar does; then the label to its last floor.
 *
 * @param {number} room
 * @param {number} labelNatural 0 for a table with no label column
 * @param {number} labelFloor
 * @param {number} barHeader
 * @returns {{ label: number, bar: number } | null}
 */
function fitTable(room, labelNatural, labelFloor, barHeader) {
  let label = labelNatural
  let barCells = BAR_WIDTH
  const over = () => label + Math.max(barCells, barHeader) - room
  if (over() > 0) barCells = Math.max(NARROW_BAR_WIDTH, barCells - over())
  if (over() > 0) label = Math.max(Math.min(label, Math.max(labelFloor, NARROW_LABEL_WIDTH)), label - over())
  if (over() > 0) barCells = Math.max(Math.min(barCells, barHeader), barCells - over())
  if (over() > 0) label = Math.max(Math.min(label, labelFloor), label - over())
  return over() > 0 ? null : { label, bar: barCells }
}

/**
 * The fallback for a terminal too narrow for the table: each row as a
 * block, its names on one line and then one field per line, every count
 * still exact. Nothing is dropped; a field that cannot fit even this way
 * overflows rather than being cut.
 *
 * @param {{
 *   headers: string[],
 *   aligns: ('left'|'right')[],
 *   body: string[][],
 *   bar: (row: number, width: number) => string,
 *   label: number,
 *   labelMax: number,
 *   columns: number,
 * }} table
 * @returns {string}
 */
function renderStacked({ headers, aligns, body, bar, label, labelMax, columns }) {
  const last = headers.length - 1
  const fields = headers.map((_, i) => i).filter((i) => i === last || aligns[i] === 'right')
  const names = headers.map((_, i) => i).filter((i) => !fields.includes(i))
  const nameWidth = Math.max(...fields.map((i) => displayWidth(headers[i])))
  const valueWidth = Math.max(0, ...fields.filter((i) => i !== last).flatMap((i) => body.map((r) => displayWidth(r[i]))))
  const barCells = Math.max(1, Math.min(BAR_WIDTH, columns - 2 * TABLE_INDENT - nameWidth - COLUMN_GAP))
  let out = ''
  body.forEach((r, n) => {
    if (n > 0) out += '\n'
    // The fixed names print whole; the label takes what is left of the line.
    const fixedNames = names.filter((i) => i !== label)
    const used = fixedNames.reduce((sum, i) => sum + displayWidth(r[i]) + COLUMN_GAP, TABLE_INDENT)
    const labelWidth = Math.max(MIN_LABEL_WIDTH, Math.min(labelMax, columns - used))
    out += `  ${names.map((i) => (i === label ? cell(r[i], labelWidth) : r[i])).join('  ')}\n`
    for (const i of fields) {
      const value = i === last ? bar(n, barCells) : pad(r[i], valueWidth, 'right')
      out += `    ${pad(headers[i], nameWidth, 'left')}  ${value}`.trimEnd() + '\n'
    }
  })
  return out
}

/**
 * @param {string} text
 * @param {number} width
 * @param {'left'|'right'} align
 */
function pad(text, width, align) {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(text)))
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
 * @param {number} [cells] the bar's full width, from the table's layout
 * @returns {string}
 */
function tokenBar(input, output, max, color, cells = BAR_WIDTH) {
  const total = Math.max(0, input) + Math.max(0, output)
  if (!(total > 0) || !(max > 0)) return ''
  const width = Math.min(cells, Math.max(1, Math.round((total / max) * cells)))
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
 * @param {number} [cells]
 * @returns {string}
 */
function bar(value, max, cells = BAR_WIDTH) {
  if (!(value > 0) || !(max > 0)) return ''
  return '█'.repeat(Math.min(cells, Math.max(1, Math.round((value / max) * cells))))
}

/**
 * Group-by results carry empty strings for parts a provider did not label
 * (an unnamed model, an undated row), so render the absence explicitly
 * rather than emitting a blank column the reader has to interpret.
 *
 * It is also where a captured group key (`provider`, `date`, `tool_name`)
 * is escaped for the terminal. The escape belongs on the captured value and
 * not on the assembled row, because this block emits `ESC` of its own: the
 * bars and headings are painted, so a sweep over the finished table would
 * erase the colour along with the attack.
 *
 * `width`, when given, is the displayed width the escaped cell may take.
 * The clip still runs on the raw trimmed value, never on the escaped one:
 * escaping first can cut a `\uXXXX` escape in half at the boundary. Each
 * raw character is charged the width its escape will print at.
 *
 * @ref LLP 0225#decision [implements]: the same rule on `hyp query overview`, per captured cell
 *
 * @param {unknown} value
 * @param {number} [width]
 * @returns {string}
 */
function cell(value, width) {
  if (value === null || value === undefined) return '(none)'
  const trimmed = String(value).trim()
  const clipped = width === undefined ? trimmed : truncate(trimmed, width)
  const text = escapeForDisplay(clipped)
  return text.length === 0 ? '(none)' : text
}

/**
 * @param {string} text
 * @param {number} width
 */
function truncate(text, width) {
  // Marks that draw nothing still cost bytes, so the clip also bounds
  // the code units it keeps (#2701 R1).
  const budget = width * MAX_UNITS_PER_CELL
  if (text.length <= budget && displayWidth(escapeForDisplay(text)) <= width) return text
  const step = widthStepper()
  let out = ''
  let used = 0
  for (const ch of text) {
    // Stepped over what is printed, not the raw character, so an escaped
    // mark both costs its escape and breaks a joined pictograph the way
    // displayWidth measures it (#2701 R2).
    let w = 0
    for (const printed of escapeForDisplay(ch)) w += step(/** @type {number} */ (printed.codePointAt(0)))
    // One column stays free for the ellipsis.
    if (used + w > width - 1 || out.length + ch.length > budget) break
    out += ch
    used += w
  }
  return `${out}…`
}

/**
 * A captured name as the label column takes it: trimmed, raw, with an
 * absent or blank value named rather than left as a blank cell.
 *
 * @param {unknown} value
 * @returns {string}
 */
function labelText(value) {
  if (value === null || value === undefined) return '(none)'
  const trimmed = String(value).trim()
  return trimmed.length === 0 ? '(none)' : trimmed
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
 * A table cell's count: the empty-value policy this block renders under, over
 * the shared locale-free grouping. The split is what let `hyp sync` reuse the
 * grouping without inheriting `(none)`, which is a table's answer to a missing
 * column and not a consent prompt's (#1121).
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
  return groupThousands(n)
}

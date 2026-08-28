// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { asyncRow } from 'squirreling'

import {
  OVERVIEW_DATASET,
  OVERVIEW_PROBE_SQL,
  buildOverviewSql,
  chooseOverviewWindow,
  collectOverview,
  describeWindow,
  emptyOverview,
  formatCount,
  missingSections,
  overviewRunnerFromCtx,
  renderDailyActivity,
  renderOverview,
  renderRepoMix,
} from '../../src/core/query/overview.js'
import { runQueryOverview } from '../../src/core/commands/query.js'
import { AUTO_REFRESH_FAILURE_MESSAGE } from '../../src/core/query/sql.js'

/** @import { OverviewWindow } from '../../src/core/query/types.js' */

// The shared gateway overview (LLP 0135 #first-look): the rendered block is
// a pure function of the rows, the runner is the ordinary query seam, and
// `hyp query overview` reprints exactly what the wizard ended on.
// @ref LLP 0135#first-look [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

const PROVIDER_ROWS = [
  { provider: 'anthropic', model: 'claude-opus-5', input_tokens: 15842, cached_tokens: 15842000, output_tokens: 158420 },
  { provider: 'anthropic', model: '', input_tokens: 1200, cached_tokens: 1200000, output_tokens: 12000 },
  { provider: 'openai', model: 'gpt-5.5', input_tokens: 512, cached_tokens: 64, output_tokens: 6 },
]

/**
 * The window a rendered block describes; real runs always have one.
 *
 * @type {OverviewWindow}
 */
const WINDOW = {
  since: '2026-07-23', until: '2026-07-24', days: 2, rows: 5150,
  totalDays: 2, totalRows: 5150, narrowed: false, boundBy: 'rows',
}

const DAILY_ROWS = [
  { date: '2026-07-24', sessions: 9, input_tokens: 648, cached_tokens: 64800, output_tokens: 648 },
  { date: '2026-07-23', sessions: 37, input_tokens: 4502, cached_tokens: 450200, output_tokens: 4502 },
]

/**
 * Raw rows shaped like ai_gateway_messages. Usage rides one carrier row
 * per response (LLP 0035 #one-carrier), so most rows carry no usage at all
 * - the fixtures mirror that rather than stamping every row. The OpenAI
 * row omits `cache_write_tokens` entirely, as that provider does.
 */
const RAW_ROWS = [
  {
    provider: 'anthropic',
    model: 'claude-opus-5',
    date: '2026-07-24',
    session_id: 's1',
    repo_root: '/w/acme/api',
    part_type: 'text',
    tool_name: null,
    attributes: null,
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-5',
    date: '2026-07-24',
    session_id: 's1',
    repo_root: '/w/acme/api',
    part_type: 'tool_call',
    tool_name: 'Bash',
    attributes: { usage: { input_tokens: 100, cache_read_tokens: 900, cache_write_tokens: 40, output_tokens: 50 } },
  },
  {
    provider: 'anthropic',
    model: 'claude-opus-5',
    date: '2026-07-23',
    session_id: 's2',
    repo_root: '/w/acme/api',
    part_type: 'tool_call',
    tool_name: 'Bash',
    attributes: { usage: { input_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 25 } },
  },
  {
    provider: 'openai',
    model: 'gpt-5.5',
    date: '2026-07-23',
    session_id: 's3',
    repo_root: null,
    part_type: 'tool_call',
    tool_name: 'exec_command',
    attributes: { usage: { input_tokens: 10, cache_read_tokens: 5, output_tokens: 7 } },
  },
]

/**
 * A command context whose query registry serves rows as the gateway
 * dataset, so the aggregates come from the same executor `hyp query sql`
 * uses rather than from a stub.
 *
 * @param {{ rows?: Record<string, any>[], dataset?: string }} [opts]
 */
function ctxWithRows(opts = {}) {
  const rows = opts.rows ?? RAW_ROWS
  // Off `rows[0]`, not `RAW_ROWS[0]`: a case that adds a column (`cwd`, which
  // is what arms the LLP 0105 filter) has to see it in the schema.
  const columns = Object.keys(rows[0] ?? RAW_ROWS[0])
  const dataset = {
    discoverPartitions: async () => [],
    createDataSource: async () => ({
      columns,
      numRows: rows.length,
      scan: () => ({
        async *rows() {
          for (const row of rows) yield asyncRow(row, columns)
        },
      }),
    }),
  }
  const stdout = makeBuf()
  const stderr = makeBuf()
  const name = opts.dataset ?? OVERVIEW_DATASET
  return {
    stdout,
    stderr,
    ctx: /** @type {any} */ ({
      stdout,
      stderr,
      query: {
        getDataset: (/** @type {string} */ n) => (n === name ? dataset : null),
        listDatasets: () => [],
      },
      storage: {},
      config: { version: 2 },
      env: {},
      cwd: '/w/project',
    }),
  }
}

test('renderOverview: aligns columns, groups thousands, and bars the largest row widest', () => {
  const out = renderOverview({ providerRows: PROVIDER_ROWS, dailyRows: DAILY_ROWS })
  const lines = out.split('\n')

  assert.match(out, /What HypAware has recorded/)
  // Cache is its own column, and the legend says what the split means.
  assert.match(out, /provider\s+model\s+input\s+cached\s+output/)
  assert.match(out, /Input is prompt sent fresh; cached is prompt served from \(or written to\) the cache/)
  assert.match(out, /Input \+ cached is the whole prompt/)

  const opus = lines.find((l) => l.includes('claude-opus-5')) ?? ''
  const gpt = lines.find((l) => l.includes('gpt-5.5')) ?? ''
  // The bar is two-tone: input's shade then output's, scaled on input +
  // output (cache excluded - it would swamp both).
  assert.match(opus, /anthropic\s+claude-opus-5\s+15,842\s+15,842,000\s+158,420\s+▒+█+/)
  // Column ends line up across rows of different content widths. Anchored
  // from the right: the bar column holds no digits, so the last digit run
  // on a line is always the output value.
  assert.equal(opus.lastIndexOf('158,420') + '158,420'.length, gpt.lastIndexOf('6') + 1)
  // Bars are scaled on input + output: the top row saturates, the smallest
  // gets the minimum.
  const cells = (/** @type {string} */ line) => (line.match(/[▒█]/g) ?? []).length
  assert.ok(cells(opus) > cells(gpt))
  assert.equal(cells(gpt), 1)
  // Each table says what its own bar charts, since they differ by section.
  assert.match(out, /output\s+by input\+output/)
  assert.match(out, /Token bars split ▒ input from █ output; cache is excluded/)

  // An unlabelled group renders explicitly rather than as a blank column.
  assert.match(lines.find((l) => l.includes('1,200,000')) ?? '', /anthropic\s+\(model not recorded\)\s+1,200\s+1,200,000/)

  const busiest = lines.find((l) => l.includes('2026-07-23')) ?? ''
  // Equal input and output split the bar down the middle.
  assert.match(busiest, /2026-07-23\s+37\s+4,502\s+450,200\s+4,502\s+▒+█+/)
})

test('buildOverviewSql: ranked tables sort by exactly what their bar charts', () => {
  const sql = buildOverviewSql('2026-07-01')
  // A table ranked by one metric and barred by another renders bars that do
  // not descend - the models table did this, sorting on output while the bar
  // charted input + output.
  assert.ok(sql.models.includes('order by input_tokens + output_tokens desc'), sql.models)
  assert.ok(sql.repos.includes('order by input_tokens + output_tokens desc'), sql.repos)
  assert.ok(sql.tools.includes('order by calls desc'), sql.tools)
  // Daily is chronological on purpose: its bars are a time series, not a rank.
  assert.ok(sql.daily.includes('order by 1 desc'), sql.daily)
})

test('renderOverview: bars descend with the row order in ranked tables', () => {
  const rows = [
    { provider: 'a', model: 'big', input_tokens: 1000, cached_tokens: 9_000_000, output_tokens: 9000 },
    { provider: 'a', model: 'mid', input_tokens: 500, cached_tokens: 1000, output_tokens: 4500 },
    { provider: 'a', model: 'small', input_tokens: 10, cached_tokens: 500_000_000, output_tokens: 90 },
  ]
  const lines = renderOverview({ providerRows: rows, dailyRows: [] }).split('\n')
  const width = (/** @type {string} */ name) =>
    ((lines.find((l) => l.includes(name)) ?? '').match(/[▒█]/g) ?? []).length
  assert.ok(width('big') > width('mid'), `${width('big')} should exceed ${width('mid')}`)
  assert.ok(width('mid') > width('small'), `${width('mid')} should exceed ${width('small')}`)
})

test('renderOverview: token bars split input from output and ignore cache', () => {
  const rows = [
    // Same input+output as the next row, but 1000x the cache. A bar that
    // counted cache would dwarf everything else here; these two must match.
    { provider: 'a', model: 'cache-heavy', input_tokens: 500, cached_tokens: 90_000_000, output_tokens: 500 },
    { provider: 'a', model: 'cache-light', input_tokens: 500, cached_tokens: 90_000, output_tokens: 500 },
    // All output, no input: no input shade at all.
    { provider: 'a', model: 'output-only', input_tokens: 0, cached_tokens: 0, output_tokens: 1000 },
  ]
  const lines = renderOverview({ providerRows: rows, dailyRows: [] }).split('\n')
  const barOf = (/** @type {string} */ name) => (lines.find((l) => l.includes(name)) ?? '').replace(/[^▒█]/g, '')

  assert.equal(barOf('cache-heavy'), barOf('cache-light'))
  // Equal input and output halve the bar.
  assert.equal(barOf('cache-heavy'), '▒'.repeat(9) + '█'.repeat(9))
  assert.equal(barOf('output-only'), '█'.repeat(18))
})

test('renderOverview: a component that exists never vanishes from its bar', () => {
  const rows = [
    { provider: 'a', model: 'big', input_tokens: 1000, cached_tokens: 0, output_tokens: 1000 },
    // Input is 0.05% of this row - too small to round to a cell, but real.
    { provider: 'a', model: 'sliver', input_tokens: 1, cached_tokens: 0, output_tokens: 1999 },
  ]
  const out = renderOverview({ providerRows: rows, dailyRows: [] })
  const sliver = (out.split('\n').find((l) => l.includes('sliver')) ?? '').replace(/[^▒█]/g, '')
  assert.ok(sliver.startsWith('▒'), `expected a visible input shade, got ${sliver}`)
  assert.ok(sliver.includes('█'))
})

test('renderOverview: SQL is hidden behind --sql, and pointed at when hidden', () => {
  const plain = renderOverview({ providerRows: PROVIDER_ROWS, dailyRows: DAILY_ROWS })
  assert.ok(!plain.includes('json_extract'))
  assert.match(plain, /The SQL behind these: hyp query overview --sql/)

  const sql = buildOverviewSql('2026-07-23')
  const withSql = renderOverview({ providerRows: PROVIDER_ROWS, dailyRows: DAILY_ROWS, sql, showSql: true })
  // Printed as one runnable command: a shell keeps the newlines inside the
  // quotes, so the block pastes back unchanged.
  assert.ok(withSql.includes('hyp query sql "select provider, model,'))
  assert.ok(withSql.includes(sql.daily.split('\n')[0]))
  // The printed statements carry the same window the numbers came from.
  assert.ok(withSql.includes("where date >= '2026-07-23'"))
  assert.ok(!withSql.includes('hyp query overview --sql'))
})

test('renderOverview: a labelled model with no usage is counted out loud', () => {
  const rows = [
    ...PROVIDER_ROWS,
    { provider: 'anthropic', model: 'claude-legacy', input_tokens: 0, cached_tokens: 0, output_tokens: 0 },
  ]
  const out = renderOverview({ providerRows: rows, dailyRows: [] })
  assert.match(out, /\+ 1 model whose traffic was recorded without token counts/)
  // Not shown as a "0  0  0" row masquerading as a measurement.
  assert.ok(!out.includes('claude-legacy '))
})

test('renderOverview: unlabelled groups are omitted silently, never called models', () => {
  // These are the reader's own prompts and tool results: no model answered
  // them, so they carry no usage by construction (LLP 0035 #one-carrier).
  const rows = [
    ...PROVIDER_ROWS,
    { provider: 'anthropic', model: null, input_tokens: 0, cached_tokens: 0, output_tokens: 0 },
    { provider: 'openai', model: '', input_tokens: 0, cached_tokens: 0, output_tokens: 0 },
  ]
  const out = renderOverview({ providerRows: rows, dailyRows: [] })
  assert.ok(!out.includes('without token counts'))
  assert.ok(!out.includes('(none)'))
})

test('renderOverview: an unlabelled group that DID carry tokens is named, not dropped', () => {
  const out = renderOverview({
    providerRows: [{ provider: 'anthropic', model: null, input_tokens: 10, cached_tokens: 0, output_tokens: 5 }],
    dailyRows: [],
  })
  assert.match(out, /anthropic\s+\(model not recorded\)\s+10\s+0\s+5/)
})

test('renderOverview: traffic with no token counts at all says so instead of an empty table', () => {
  const out = renderOverview({
    providerRows: [{ provider: 'anthropic', model: 'claude-opus-5', input_tokens: 0, cached_tokens: 0, output_tokens: 0 }],
    dailyRows: [],
  })
  assert.match(out, /1 model was recorded, none with token counts\./)
  // No table header over an empty table.
  assert.ok(!/provider\s+model\s+input\s+cached/.test(out))
})

test('renderOverview: nothing but unlabelled groups reports no counts, not "0 models"', () => {
  const out = renderOverview({
    providerRows: [{ provider: 'anthropic', model: null, input_tokens: 0, cached_tokens: 0, output_tokens: 0 }],
    dailyRows: [],
  })
  assert.match(out, /No token counts were recorded\./)
  assert.ok(!out.includes('0 models'))
})

test('renderOverview: a cache-only model counts as measured, not as missing usage', () => {
  const out = renderOverview({
    providerRows: [{ provider: 'anthropic', model: 'cache-only', input_tokens: 0, cached_tokens: 900, output_tokens: 0 }],
    dailyRows: [],
  })
  assert.match(out, /anthropic\s+cache-only\s+0\s+900\s+0/)
  assert.ok(!out.includes('without token counts'))
})

test('renderOverview: the caller names the heading (setup milestone vs standing command)', () => {
  const out = renderOverview({ providerRows: PROVIDER_ROWS, dailyRows: [], title: 'First look' })
  assert.match(out, /First look/)
  assert.ok(!out.includes('What HypAware has recorded'))
})

test('renderOverview: no rows renders the empty state with what to do next', () => {
  const out = renderOverview({ providerRows: [], dailyRows: [] })
  assert.match(out, /Nothing recorded yet/)
  assert.match(out, /hyp query overview/)
  assert.ok(!out.includes('provider  '))
})

test('renderOverview: folds the tail of a long provider list into a count line', () => {
  const rows = Array.from({ length: 11 }, (_, i) => (
    { provider: 'p', model: `m${i}`, input_tokens: 10, cached_tokens: 1000 - i, output_tokens: 100 - i }
  ))
  const out = renderOverview({ providerRows: rows, dailyRows: [] })
  assert.match(out, /\+ 3 more models/)
  assert.ok(!out.includes('m8'))
})

test('renderOverview: the caption and key wear the shades they describe', () => {
  const MAGENTA = '\x1b[35m'
  const CYAN = '\x1b[36m'
  const RESET = '\x1b[0m'
  const out = renderOverview({
    providerRows: [{ provider: 'a', model: 'm', input_tokens: 500, cached_tokens: 9_000_000, output_tokens: 500 }],
    dailyRows: [],
    color: true,
  })
  // The header names each half in its own colour, so the table is its own
  // key - matching the shades in the bar directly beneath it.
  assert.ok(out.includes(`${MAGENTA}input${RESET}`))
  assert.ok(out.includes(`${CYAN}output${RESET}`))
  // Legend glyph and word share a colour.
  assert.ok(out.includes(`${MAGENTA}▒ input${RESET}`))
  assert.ok(out.includes(`${CYAN}█ output${RESET}`))
  // The bar's own segments carry the same two colours.
  assert.ok(out.includes(`${MAGENTA}▒`))
  assert.ok(out.includes(`${CYAN}█`))

  // A colour run must never sit inside a dim run: the reset that ends the
  // colour would end the dim too, leaving the rest of the row undimmed.
  const header = out.split('\n').find((l) => l.includes('by ')) ?? ''
  assert.ok(!/\x1b\[2m[^\x1b]*\x1b\[3[56]m/.test(header), `dim run swallows a colour: ${JSON.stringify(header)}`)
})

test('renderOverview: color=true wraps in ANSI, the default emits none', () => {
  assert.ok(!renderOverview({ providerRows: PROVIDER_ROWS, dailyRows: DAILY_ROWS }).includes('\x1b['))
  assert.ok(renderOverview({ providerRows: PROVIDER_ROWS, dailyRows: DAILY_ROWS, color: true }).includes('\x1b['))
})

test('renderRepoMix: shortens paths, ranks by token volume, and counts repo-less sessions', () => {
  const out = renderOverview({
    providerRows: PROVIDER_ROWS,
    dailyRows: [],
    repoRows: [
      { repo_root: null, sessions: 172, input_tokens: 0, cached_tokens: 0, output_tokens: 0 },
      { repo_root: '/Users/x/Development/hyperparam-work/hypaware-3/hypaware', sessions: 73, input_tokens: 255403, cached_tokens: 488328729, output_tokens: 1993041 },
      { repo_root: '/Users/x/Development/hyperparam-work/hypaware-2/hypaware', sessions: 26, input_tokens: 235507, cached_tokens: 173399157, output_tokens: 1243332 },
    ],
  })
  // Last two segments: a basename alone would collapse hypaware-2 and -3.
  // Full token vocabulary: cache is ~76% of spend, so a repo table without a
  // cached column would show a repo's cost as its 1.5% sliver.
  assert.match(out, /hypaware-3\/hypaware\s+73\s+255,403\s+488,328,729\s+1,993,041\s+▒+█+/)
  assert.match(out, /hypaware-2\/hypaware\s+26\s+235,507\s+173,399,157\s+1,243,332\s+▒+█+/)
  // Same two-tone bar and caption as the other token tables.
  assert.match(out, /output\s+by input\+output/)
  assert.ok(!out.includes('/Users/x/'))
  // Stated, not silently dropped - and "no repo recorded" rather than
  // "outside a repo", which would be false for Codex rows (they never
  // carry repo_root even when they ran inside a checkout).
  assert.match(out, /\+ 172 sessions with no repo recorded/)
})

test('renderRepoMix: no repo at all says so rather than printing an empty table', () => {
  const out = renderOverview({
    providerRows: PROVIDER_ROWS,
    dailyRows: [],
    repoRows: [{ repo_root: '', sessions: 9, input_tokens: 0, cached_tokens: 0, output_tokens: 0 }],
  })
  assert.match(out, /No repo was recorded on any session \(9 of them\)\./)
})

test('renderToolMix: ranks by calls and shows the session spread', () => {
  const out = renderOverview({
    providerRows: PROVIDER_ROWS,
    dailyRows: [],
    toolRows: [
      { tool_name: 'Bash', calls: 8043, sessions: 384 },
      { tool_name: 'Read', calls: 1633, sessions: 237 },
    ],
  })
  assert.match(out, /Which tools get called/)
  assert.match(out, /tool\s+calls\s+sessions/)
  assert.match(out, /Bash\s+8,043\s+384\s+█+/)
  assert.match(out, /Read\s+1,633\s+237\s+█+/)
})

test('buildOverviewSql: every section carries the same window, and tools filters tool_call', () => {
  const sql = buildOverviewSql('2026-07-01')
  // One claim about one period: a section scoped differently would make the
  // block's numbers incomparable with each other.
  for (const statement of Object.values(sql)) {
    assert.ok(statement.includes("where date >= '2026-07-01'"), statement)
  }
  // `tool_use` is a provider wire name and matches no row, returning a
  // silent empty section.
  assert.ok(sql.tools.includes("part_type = 'tool_call'"))
  assert.ok(!sql.tools.includes('tool_use'))
})

test('chooseOverviewWindow: takes the widest span that fits the row budget', () => {
  const probe = [
    { date: '2026-07-24', n: 40 },
    { date: '2026-07-23', n: 40 },
    { date: '2026-07-22', n: 40 },
    { date: '2026-07-21', n: 40 },
  ]
  const win = chooseOverviewWindow(probe, { targetRows: 100 })
  assert.deepEqual(win, {
    since: '2026-07-23', until: '2026-07-24', days: 2, rows: 80,
    totalDays: 4, totalRows: 160, narrowed: true, boundBy: 'rows',
  })
})

test('chooseOverviewWindow: everything fits when the cache is small', () => {
  const probe = [{ date: '2026-07-24', n: 10 }, { date: '2026-07-23', n: 10 }]
  const win = chooseOverviewWindow(probe, { targetRows: 100 })
  assert.equal(win?.narrowed, false)
  assert.equal(win?.days, 2)
  assert.equal(win?.since, '2026-07-23')
})

test('chooseOverviewWindow: one oversized day is still shown, never nothing', () => {
  // The whole point of narrowing rather than skipping: a busy single day is
  // a real answer where an empty block is not.
  const win = chooseOverviewWindow(
    [{ date: '2026-07-24', n: 5_000_000 }, { date: '2026-07-23', n: 10 }],
    { targetRows: 100 }
  )
  assert.equal(win?.days, 1)
  assert.equal(win?.rows, 5_000_000)
  assert.equal(win?.narrowed, true)
})

test('chooseOverviewWindow: the same data yields a smaller window on a slower machine', () => {
  // 10 days x 10k rows. The row cap alone would take all of it; what
  // differs between these two runs is only how long the probe took, i.e.
  // how fast the machine is.
  const probe = Array.from({ length: 10 }, (_, i) => ({ date: `2026-07-${27 - i}`, n: 10_000 }))

  // Fast: the probe read 100k rows in 100ms, so the sections are affordable.
  const fast = chooseOverviewWindow(probe, { targetRows: 1_000_000, budgetMs: 5000, probeMs: 100 })
  assert.equal(fast?.days, 10)
  assert.equal(fast?.narrowed, false)

  // Slow: the same 100k rows took 10s to probe. Predicting the sections
  // from that rate, only a fraction of the history fits the same budget.
  const slow = chooseOverviewWindow(probe, { targetRows: 1_000_000, budgetMs: 5000, probeMs: 10_000 })
  assert.ok(slow && slow.days < 10, `expected a narrower window, got ${slow?.days} days`)
  assert.equal(slow.narrowed, true)
  assert.equal(slow.boundBy, 'time')
})

test('chooseOverviewWindow: the probe is charged to the budget it shares', () => {
  const probe = Array.from({ length: 10 }, (_, i) => ({ date: `2026-07-${27 - i}`, n: 10_000 }))
  // Identical machine speed (1ms per 1000 rows); the only difference is how
  // much of the budget the probe already spent. Planning as if the clock
  // had not started is what lets a slow probe blow a deadline no matter how
  // well the window was chosen.
  const fresh = chooseOverviewWindow(probe, { targetRows: 1e9, budgetMs: 5000, probeMs: 100 })
  const late = chooseOverviewWindow(probe, { targetRows: 1e9, budgetMs: 5000, probeMs: 4800 })
  assert.ok(fresh && late && late.days < fresh.days, `${late?.days} should be under ${fresh?.days}`)
})

test('chooseOverviewWindow: a probe that overran the budget still yields a window', () => {
  const probe = Array.from({ length: 10 }, (_, i) => ({ date: `2026-07-${27 - i}`, n: 10_000 }))
  // The probe alone cost double the budget. There is nothing left to spend,
  // but the block still shows the newest day rather than nothing.
  const win = chooseOverviewWindow(probe, { targetRows: 1e9, budgetMs: 5000, probeMs: 10_000 })
  assert.ok(win)
  assert.ok(win.days >= 1)
  assert.equal(win.narrowed, true)
})

test('chooseOverviewWindow: the row cap still binds a fast machine', () => {
  const probe = Array.from({ length: 10 }, (_, i) => ({ date: `2026-07-${27 - i}`, n: 10_000 }))
  // Instant probe: time says everything fits, but memory says otherwise.
  const win = chooseOverviewWindow(probe, { targetRows: 25_000, budgetMs: 5000, probeMs: 0 })
  assert.equal(win?.days, 2)
  assert.equal(win?.boundBy, 'rows')
})

test('chooseOverviewWindow: with no probe timing, the row cap decides alone', () => {
  const probe = Array.from({ length: 4 }, (_, i) => ({ date: `2026-07-${27 - i}`, n: 40 }))
  const win = chooseOverviewWindow(probe, { targetRows: 100 })
  assert.equal(win?.days, 2)
  assert.equal(win?.boundBy, 'rows')
})

/** 20 days x 10k rows, newest first, on dates that sort as strings. */
function twentyDayProbe() {
  return Array.from({ length: 20 }, (_, i) => ({
    date: `2026-07-${String(20 - i).padStart(2, '0')}`,
    n: 10_000,
  }))
}

test('chooseOverviewWindow: the plan charges for the sections it will run, not all four', () => {
  // LLP 0135 #window states the estimate as `remaining / (perRowMs x 1.9 x
  // sections)`, and `collectOverview` runs only the sections it was asked
  // for. Half the work is half the cost, so a two-section caller can afford
  // roughly twice the rows on the same machine and the same budget.
  const probe = twentyDayProbe()
  const opts = { targetRows: 1e9, budgetMs: 5000, probeMs: 2000 }

  const four = chooseOverviewWindow(probe, opts)
  const two = chooseOverviewWindow(probe, { ...opts, sections: ['models', 'daily'] })

  assert.ok(four && two)
  assert.equal(four.boundBy, 'time')
  assert.equal(two.boundBy, 'time')
  // 3000ms left after the probe, at 0.01ms/row: 39,473 rows for four
  // sections, 78,947 for two - three days against seven.
  assert.equal(four.days, 3)
  assert.equal(two.days, 7)
  assert.ok(two.rows > four.rows * 2, `${two.rows} should be over twice ${four.rows}`)
})

test('chooseOverviewWindow: an explicit --days request outranks both caps', () => {
  const probe = Array.from({ length: 10 }, (_, i) => ({ date: `2026-07-${20 - i}`, n: 1_000_000 }))
  // Row cap tiny, machine measured as glacial: the user asked anyway.
  const win = chooseOverviewWindow(probe, { targetRows: 100, budgetMs: 10, probeMs: 60_000, days: 5 })
  assert.equal(win?.days, 5)
  assert.equal(win?.rows, 5_000_000)
  assert.equal(win?.boundBy, 'requested')
})

test('chooseOverviewWindow: unordered probe rows and an empty cache', () => {
  const win = chooseOverviewWindow([
    { date: '2026-07-22', n: 1 },
    { date: '2026-07-24', n: 1 },
    { date: '2026-07-23', n: 1 },
  ], { targetRows: 100 })
  assert.equal(win?.until, '2026-07-24')
  assert.equal(win?.since, '2026-07-22')
  assert.equal(chooseOverviewWindow([], {}), null)
})

test('describeWindow: states the period, and the lever - never the reason', () => {
  assert.equal(
    describeWindow({ since: '2026-07-23', until: '2026-07-24', days: 2, rows: 80, totalDays: 2, totalRows: 80, narrowed: false, boundBy: /** @type {const} */ ('rows') }),
    // "active days", since the bounds are calendar dates but the count is
    // dates that recorded something - a quiet day inside the span is not a
    // contradiction.
    '2026-07-23 to 2026-07-24 (2 active days, 80 rows)'
  )
  const capped = describeWindow({
    since: '2026-07-24', until: '2026-07-24', days: 1, rows: 90, totalDays: 30, totalRows: 900_000, narrowed: true, boundBy: /** @type {const} */ ('time'),
  })
  assert.match(capped, /showing 1 of 30 active days \(90 of 900,000 rows\); widen with --days 30/)
  assert.ok(!capped.includes('stay fast'))

  // One wording whatever narrowed it: a window the user asked for must not
  // arrive with an apology, and the tool's reason is not the reader's
  // business either way.
  const asked = describeWindow({
    since: '2026-07-24', until: '2026-07-24', days: 1, rows: 90, totalDays: 30, totalRows: 900_000, narrowed: true, boundBy: /** @type {const} */ ('requested'),
  })
  assert.equal(asked, capped)
})

test('renderOverview: the window is stated under the title, always', () => {
  const out = renderOverview({ providerRows: PROVIDER_ROWS, dailyRows: DAILY_ROWS, window: WINDOW })
  const lines = out.split('\n').filter(Boolean)
  // Directly under the title, before the rule: every number below is "per
  // this period".
  assert.match(lines[0], /What HypAware has recorded/)
  assert.match(lines[1], /2026-07-23 to 2026-07-24 \(2 active days, 5,150 rows\)/)
})

/** A runner that answers the probe with `probe` and every section empty. */
function probingRunner(probe) {
  /** @type {string[]} */
  const seen = []
  return {
    seen,
    runner: {
      hasDataset: () => true,
      /** @param {string} sql */
      async run(sql) {
        seen.push(sql)
        return { columns: [], rows: sql === OVERVIEW_PROBE_SQL ? probe : [] }
      },
    },
  }
}

test('collectOverview: probes first, then runs only the requested sections', async () => {
  const { seen, runner } = probingRunner([{ date: '2026-07-24', n: 10 }])
  const rows = await collectOverview(runner, { sections: ['models', 'daily'] })
  const sql = buildOverviewSql('2026-07-24')
  // The probe pays for itself by scoping the expensive statements.
  assert.deepEqual(seen, [OVERVIEW_PROBE_SQL, sql.models, sql.daily])
  assert.deepEqual(rows.repoRows, [])
  assert.deepEqual(rows.toolRows, [])
})

/** A runner that answers the probe with `probe` and every section one row. */
function answeringRunner(probe) {
  return {
    hasDataset: () => true,
    /** @param {string} sql */
    async run(sql) {
      return { columns: [], rows: sql === OVERVIEW_PROBE_SQL ? probe : [{ n: 1 }] }
    },
  }
}

/** A clock whose second reading is `ms` later, so the probe times exactly. */
function clockSpending(ms) {
  let calls = 0
  return () => (calls++ === 0 ? 0 : ms)
}

test('collectOverview: the window is planned for the sections actually requested', async () => {
  // The same machine, the same budget, the same cache - only the section
  // list differs, and the subset caller is not charged for work it will
  // never do.
  const probe = twentyDayProbe()
  const four = await collectOverview(answeringRunner(probe), {
    targetRows: 1e9,
    clock: clockSpending(2000),
  })
  const two = await collectOverview(answeringRunner(probe), {
    sections: ['models', 'daily'],
    targetRows: 1e9,
    clock: clockSpending(2000),
  })
  assert.equal(four.window?.days, 3)
  assert.equal(two.window?.days, 7)
})

test('missingSections: a section nobody asked for is not reported as unfinished', async () => {
  // "The repos section did not finish" and "you did not ask for repos" are
  // different claims, and the wizard prints the first one verbatim
  // (LLP 0135 #overrun). A subset run has nothing missing.
  const probe = [{ date: '2026-07-24', n: 10 }]
  const two = await collectOverview(answeringRunner(probe), { sections: ['models', 'daily'] })
  assert.deepEqual(missingSections(two), [])

  // And a section that was asked for and did not land is still named.
  const { runner } = probingRunner(probe)
  const none = await collectOverview(runner, { sections: ['models', 'repos'] })
  assert.deepEqual(missingSections(none), ['models', 'repos'])
  assert.deepEqual(missingSections(emptyOverview()), ['models', 'daily', 'repos', 'tools'])
})

test('collectOverview: runs all four sections by default, in display order', async () => {
  const { seen, runner } = probingRunner([{ date: '2026-07-24', n: 10 }])
  const rows = await collectOverview(runner)
  const sql = buildOverviewSql('2026-07-24')
  assert.deepEqual(seen, [OVERVIEW_PROBE_SQL, sql.models, sql.daily, sql.repos, sql.tools])
  assert.equal(rows.window?.days, 1)
})

test('collectOverview: an empty cache runs no section at all', async () => {
  const { seen, runner } = probingRunner([])
  const rows = await collectOverview(runner)
  // Nothing recorded: no window to state, and nothing worth scanning for.
  assert.deepEqual(seen, [OVERVIEW_PROBE_SQL])
  assert.equal(rows.window, undefined)
  assert.deepEqual(rows.providerRows, [])
})

test('overviewRunnerFromCtx: aggregates through the real query seam', async () => {
  const runner = overviewRunnerFromCtx(ctxWithRows().ctx)
  assert.ok(runner)
  assert.equal(runner.hasDataset(OVERVIEW_DATASET), true)
  assert.equal(runner.hasDataset('logs'), false)

  const { providerRows, dailyRows } = await collectOverview(runner)
  // cached is read + write; the usage-free row contributes nothing, and no
  // row is double-counted. The OpenAI row carries no cache_write_tokens at
  // all: an unguarded `read + write` would go null and drop its 5 cached
  // tokens, so this pins the per-term coalesce.
  assert.deepEqual(providerRows, [
    { provider: 'anthropic', model: 'claude-opus-5', input_tokens: 300, cached_tokens: 940, output_tokens: 75 },
    { provider: 'openai', model: 'gpt-5.5', input_tokens: 10, cached_tokens: 5, output_tokens: 7 },
  ])
  // sessions counts every session, including one whose only row carries no
  // usage - which is why the queries take no `role = 'assistant'` filter.
  assert.deepEqual(dailyRows, [
    { date: '2026-07-24', sessions: 1, input_tokens: 100, cached_tokens: 940, output_tokens: 50 },
    { date: '2026-07-23', sessions: 2, input_tokens: 210, cached_tokens: 5, output_tokens: 32 },
  ])
})

test('overviewRunnerFromCtx: a withheld row is reported, once, not once per section', async () => {
  // A directory marked `local-only` holds the rows; the caller sits outside
  // it. The rows are recorded and locally readable, so `hyp query sql` would
  // report the withholding rather than perform it silently - and so must
  // this block, which is otherwise a place five queries could each swallow
  // the same disclosure or repeat it five times.
  // @ref LLP 0105 [tests]: withholding is never silent, on this surface too
  const root = mkdtempSync(path.join(tmpdir(), 'hyp-overview-vis-'))
  const shielded = path.join(root, 'private')
  const open = path.join(root, 'open')
  mkdirSync(shielded)
  mkdirSync(open)
  writeFileSync(path.join(shielded, '.hypignore'), 'local-only\n')

  const { ctx } = ctxWithRows({ rows: RAW_ROWS.map((row) => ({ ...row, cwd: shielded })) })
  ctx.cwd = open
  /** @type {{ kind: string, line: string }[]} */
  const notices = []
  const runner = overviewRunnerFromCtx(ctx, (notice) => notices.push(notice))
  assert.ok(runner)
  const rows = await collectOverview(runner)

  // Withheld, so the tables are empty - and the reason is on the record.
  assert.deepEqual(rows.providerRows, [])
  assert.deepEqual(notices.map((n) => n.kind), ['local-only'])
  assert.match(notices[0].line, /^local-only: withheld \d+ row\(s\) not visible from this full caller/)
  assert.match(notices[0].line, /--include-local-only/)

  rmSync(root, { recursive: true, force: true })
})

test('overviewRunnerFromCtx: nothing to withhold says nothing', async () => {
  /** @type {unknown[]} */
  const notices = []
  const runner = overviewRunnerFromCtx(ctxWithRows().ctx, (notice) => notices.push(notice))
  assert.ok(runner)
  await collectOverview(runner)
  assert.deepEqual(notices, [])
})

test('overviewRunnerFromCtx: a failed refresh routes apart from the debounce line', async () => {
  // Both lines arrive in `freshnessMessages`, so a caller that routes on the
  // array alone cannot tell "a couple of minutes stale" from "rows are
  // missing". The wizard's first look drops the first by design; tagging
  // them the same kind would drop the second with it.
  // @ref LLP 0321#consequences [tests]: a degraded result never claims to be current, on every surface
  const { ctx } = ctxWithRows()
  const dataset = ctx.query.getDataset(OVERVIEW_DATASET)
  dataset.discoverPartitions = async () => [{ tablePath: '/cache/ai_gateway_messages' }]
  ctx.storage = {
    cacheRoot: '/cache',
    pendingInfo: async () => ({ pending: true, pendingBytes: 1, lastFlushAtMs: null }),
    flushTable: async () => {
      throw new Error('cache-iceberg: partition field "session_id" is new - adding a partition field is spec evolution and requires an explicit migration')
    },
  }
  /** @type {{ kind: string, line: string }[]} */
  const notices = []
  const runner = overviewRunnerFromCtx(ctx, (notice) => notices.push(notice))
  assert.ok(runner)
  await collectOverview(runner)

  assert.deepEqual(notices.map((n) => n.kind), ['refresh-failed'])
  assert.equal(notices[0].line, `${AUTO_REFRESH_FAILURE_MESSAGE}\n`)
})

test('overviewRunnerFromCtx: no query registry yields no runner', () => {
  assert.equal(overviewRunnerFromCtx(/** @type {any} */ ({})), undefined)
  assert.equal(overviewRunnerFromCtx(/** @type {any} */ ({ query: {} })), undefined)
})

test('hyp query overview: renders all four sections from real rows', async () => {
  const { ctx, stdout, stderr } = ctxWithRows()
  const code = await runQueryOverview([], ctx)
  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  const text = stdout.text()
  assert.match(text, /What HypAware has recorded/)
  assert.match(text, /anthropic\s+claude-opus-5\s+300\s+940\s+75\s+▒*█+/)
  assert.match(text, /2026-07-24\s+1\s+100\s+940\s+50/)
  // repos: path shortened, and the repo-less OpenAI session counted below
  assert.match(text, /acme\/api\s+2\s+300\s+940\s+75\s+▒+█+/)
  // Every token table captions the same bar metric; tools charts its own.
  assert.match(text, /output\s+by input\+output/)
  assert.match(text, /sessions\s+by calls/)
  assert.match(text, /\+ 1 session with no repo recorded/)
  // tools: only tool_call rows, most-called first
  assert.match(text, /Bash\s+2\s+2\s+█+/)
  assert.match(text, /exec_command\s+1\s+1/)
  assert.ok(!text.includes('json_extract'))
})

test('hyp query overview: a withheld row is disclosed on stderr, off the block', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hyp-overview-cmd-vis-'))
  const shielded = path.join(root, 'private')
  const open = path.join(root, 'open')
  mkdirSync(shielded)
  mkdirSync(open)
  writeFileSync(path.join(shielded, '.hypignore'), 'local-only\n')

  const { ctx, stdout, stderr } = ctxWithRows({ rows: RAW_ROWS.map((row) => ({ ...row, cwd: shielded })) })
  ctx.cwd = open
  const code = await runQueryOverview([], ctx)

  // Withholding is not a failure: the block still prints, still exits 0, and
  // says on stderr what it left out - so stdout stays the block (and stays
  // parseable under --json).
  assert.equal(code, 0)
  assert.match(stderr.text(), /^local-only: withheld \d+ row\(s\)/)
  assert.ok(!stdout.text().includes('local-only:'))
  // And the empty state names the real reason. "Nothing recorded yet" is a
  // claim about the cache, and here it is simply false - every one of those
  // sessions is recorded, just not visible from this directory.
  assert.match(stdout.text(), /Every recorded session in this window is marked local-only/)
  assert.match(stdout.text(), /--include-local-only/)
  assert.ok(!stdout.text().includes('Nothing recorded yet'))

  rmSync(root, { recursive: true, force: true })
})

test('hyp query overview --sql: prints the statement above each table', async () => {
  const { ctx, stdout } = ctxWithRows()
  const code = await runQueryOverview(['--sql'], ctx)
  assert.equal(code, 0)
  const text = stdout.text()
  assert.match(text, /hyp query sql "select provider, model,/)
  assert.match(text, /json_extract\(attributes,'\$\.usage\.output_tokens'\)/)
  assert.ok(!text.includes('The SQL behind these'))
})

test('hyp query overview --json: emits both result sets for scripting', async () => {
  const { ctx, stdout } = ctxWithRows()
  const code = await runQueryOverview(['--json'], ctx)
  assert.equal(code, 0)
  const parsed = JSON.parse(stdout.text())
  assert.deepEqual(parsed.providerRows[0], {
    provider: 'anthropic',
    model: 'claude-opus-5',
    input_tokens: 300,
    cached_tokens: 940,
    output_tokens: 75,
  })
  assert.equal(parsed.dailyRows.length, 2)
  assert.ok(!stdout.text().includes('█'))
})

test('hyp query overview: no capture configured reports that, not a schema name', async () => {
  const { ctx, stdout, stderr } = ctxWithRows({ dataset: 'something-else' })
  const code = await runQueryOverview([], ctx)
  assert.equal(code, 1)
  assert.equal(stdout.text(), '')
  assert.match(stderr.text(), /nothing has been recorded yet - no AI client is connected/)
  assert.match(stderr.text(), /Run `hyp setup` to start capturing Claude or Codex sessions/)
  // The dataset name is the tool's vocabulary, not the reader's.
  assert.ok(!stderr.text().includes('ai_gateway_messages'))
  assert.ok(!stderr.text().includes('dataset'))
})

test('hyp query overview: an empty dataset renders the empty state, not an error', async () => {
  const { ctx, stdout } = ctxWithRows({ rows: [] })
  const code = await runQueryOverview([], ctx)
  assert.equal(code, 0)
  assert.match(stdout.text(), /Nothing recorded yet/)
})

test('formatCount: groups thousands and passes non-numbers through', () => {
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1000), '1,000')
  assert.equal(formatCount(15842), '15,842')
  assert.equal(formatCount(1234567), '1,234,567')
  assert.equal(formatCount(null), '(none)')
})

// --- what the block folds, it counts correctly ---

test('renderRepoMix: the fold count is the real tail, and the repo-less line survives it', () => {
  // 30 named repos plus a repo-less group. The SQL carries no LIMIT for
  // exactly this reason: a 20-row cap would report "+ 12 more" (the tail of
  // what SQL returned) rather than "+ 22 more" (the truth), and the
  // repo-less group - which sorts by token volume like any other row -
  // could be pushed off the end, taking its disclosure line with it.
  /** @type {Record<string, unknown>[]} */
  const rows = Array.from({ length: 30 }, (_, i) => ({
    repo_root: `/w/r${i}`, sessions: 2, input_tokens: 1000 - i, cached_tokens: 0, output_tokens: 10,
  }))
  rows.push({ repo_root: null, sessions: 41, input_tokens: 1, cached_tokens: 0, output_tokens: 1 })
  const out = renderRepoMix(rows, false)
  assert.match(out, /\+ 22 more repos/)
  assert.match(out, /\+ 41 sessions with no repo recorded/)
  assert.ok(!out.includes('+ 12 more'))
  // Only MAX_REPO_ROWS are tabled; the rest are the count line.
  assert.equal((out.match(/^\s+\/w\/r\d+\s/gm) ?? []).length, 8)
})

test('buildOverviewSql: no LIMIT on the sections whose tails are counted', () => {
  const sql = buildOverviewSql('2026-07-01')
  // A LIMIT here would silently become the renderer's idea of the whole
  // result, and every fold count would be computed against it.
  assert.ok(!/limit/i.test(sql.repos))
  assert.ok(!/limit/i.test(sql.daily))
  assert.ok(!/limit/i.test(sql.models))
  // tools is the exception: it has no fold line, and "top 10 tools" is the
  // whole question rather than a truncation of it.
  assert.match(sql.tools, /limit 10/)
})

test('renderDailyActivity: a window longer than the table says how many days it folded', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-07-${String(30 - i).padStart(2, '0')}`,
    sessions: 2, input_tokens: 100, cached_tokens: 10, output_tokens: 5,
  }))
  const out = renderDailyActivity(rows, false)
  // The header states a 30-day window; the table shows 14. Summing this
  // column without the fold line silently yields half the period.
  assert.equal((out.match(/^\s+2026-07-\d\d\s/gm) ?? []).length, 14)
  assert.match(out, /\+ 16 earlier days in this window/)
})

test('renderDailyActivity: a window that fits says nothing', () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    date: `2026-07-0${3 - i}`, sessions: 1, input_tokens: 10, cached_tokens: 1, output_tokens: 1,
  }))
  assert.ok(!renderDailyActivity(rows, false).includes('earlier day'))
})

test('buildOverviewSql: rejects a since that is not a plain date', () => {
  // `since` is concatenated into five statements and the executor takes no
  // bind parameters, so the shape is asserted at the seam rather than left
  // to an invariant maintained in another package.
  assert.throws(() => buildOverviewSql("2026-07-01' or '1'='1"), /must be YYYY-MM-DD/)
  assert.throws(() => buildOverviewSql('yesterday'), /must be YYYY-MM-DD/)
  // The empty string is the no-window case the renderer passes when there
  // is nothing to scope.
  assert.doesNotThrow(() => buildOverviewSql(''))
  assert.doesNotThrow(() => buildOverviewSql('2026-07-01'))
})

// --- flag parsing goes through the shared codec ---

test('hyp query overview: --days=7 is honored, not silently ignored', async () => {
  const { ctx, stdout } = ctxWithRows()
  assert.equal(await runQueryOverview(['--days=1'], ctx), 0)
  // A pinned window overrides the planner, so the stated period is the one
  // asked for rather than the one measured.
  assert.match(stdout.text(), /2026-07-24 to 2026-07-24/)
})

test('hyp query overview: an unknown flag is refused, not ignored', async () => {
  const { ctx, stdout, stderr } = ctxWithRows()
  assert.equal(await runQueryOverview(['--bogus'], ctx), 2)
  assert.match(stderr.text(), /unknown flag --bogus/)
  assert.match(stderr.text(), /usage: hyp query overview/)
  assert.equal(stdout.text(), '')
})

test('hyp query overview: --days rejects non-positive and non-integer values', async () => {
  for (const bad of ['0', '-1', 'abc', '3.5']) {
    const { ctx, stderr } = ctxWithRows()
    assert.equal(await runQueryOverview(['--days', bad], ctx), 2, `--days ${bad}`)
    assert.match(stderr.text(), /--days expects a positive integer/)
  }
})

test('hyp query overview: --help prints usage and exits 0', async () => {
  const { ctx, stdout } = ctxWithRows()
  assert.equal(await runQueryOverview(['--help'], ctx), 0)
  assert.match(stdout.text(), /^usage: hyp query overview/)
})

test('hyp query overview: NO_COLOR suppresses ANSI even on a TTY', async () => {
  const { ctx, stdout } = ctxWithRows()
  ctx.stdout.isTTY = true
  ctx.env = { NO_COLOR: '1' }
  assert.equal(await runQueryOverview([], ctx), 0)
  assert.ok(!/\x1b\[/.test(stdout.text()))
})

test('hyp query overview: --include-local-only is accepted, and does what the disclosure promises', async () => {
  // The block's own withheld-rows notice names this flag as the remedy, in
  // two places. Declaring it on the schema is what makes that advice true:
  // the codec refuses undeclared flags, so advising one it does not declare
  // would exit 2 on the single action the output told the user to take.
  const root = mkdtempSync(path.join(tmpdir(), 'hyp-overview-override-'))
  const shielded = path.join(root, 'private')
  const open = path.join(root, 'open')
  mkdirSync(shielded)
  mkdirSync(open)
  writeFileSync(path.join(shielded, '.hypignore'), 'local-only\n')
  const rows = RAW_ROWS.map((row) => ({ ...row, cwd: shielded }))

  // Without it: withheld, disclosed, and the empty state names the flag.
  const withoutFlag = ctxWithRows({ rows })
  withoutFlag.ctx.cwd = open
  assert.equal(await runQueryOverview([], withoutFlag.ctx), 0)
  assert.match(withoutFlag.stdout.text(), /--include-local-only/)

  // With it: the rows the disclosure was about actually appear.
  const withFlag = ctxWithRows({ rows })
  withFlag.ctx.cwd = open
  assert.equal(await runQueryOverview(['--include-local-only'], withFlag.ctx), 0)
  assert.match(withFlag.stdout.text(), /claude-opus-5/)
  assert.ok(!withFlag.stdout.text().includes('marked local-only'))
  // Nothing was withheld, so nothing is disclosed.
  assert.equal(withFlag.stderr.text(), '')

  rmSync(root, { recursive: true, force: true })
})

test('hyp query overview: the usage line lists every flag the codec accepts', async () => {
  const { ctx, stdout } = ctxWithRows()
  await runQueryOverview(['--help'], ctx)
  // A flag missing here is a flag users cannot discover; a flag listed but
  // undeclared is one that exits 2 when they try it.
  for (const flag of ['--json', '--sql', '--days', '--include-local-only']) {
    assert.match(stdout.text(), new RegExp(flag.replace(/-/g, '\\-')), flag)
  }
})

// @ref LLP 0225#decision [tests]: the overview's captured columns are escaped too
test('renderOverview escapes captured columns and keeps its own colour', () => {
  const ESC = '\u001b'
  const RLO = '\u202e'
  const usage = { input_tokens: 10, cached_tokens: 0, output_tokens: 5 }
  const out = renderOverview({
    providerRows: [{ provider: `anth${ESC}[8mropic`, model: `claude${RLO}-opus`, ...usage }],
    dailyRows: [{ date: `2026-08-1${ESC}[1A`, sessions: 1, ...usage }],
    repoRows: [{ repo_root: `/a/b${ESC}[2K`, sessions: 1, ...usage }],
    toolRows: [{ tool_name: `Ba${ESC}[8msh`, calls: 3, sessions: 1 }],
    // Colour on, so the painted bars keep their own ESC. That is what proves
    // the escape is applied per captured cell rather than swept over the
    // finished block, which would take the colour with it.
    color: true,
  })
  assert.match(out, /anth\\u001b\[8mropic/)
  assert.match(out, /claude\\u202e-opus/)
  assert.match(out, /2026-08-1\\u001b\[1A/)
  assert.match(out, /b\\u001b\[2K/)
  assert.match(out, /Ba\\u001b\[8msh/)
  // Every raw ESC that is left is one of our own colour codes.
  for (const found of out.match(/\u001b.{0,4}/g) ?? []) {
    assert.match(found, /^\u001b\[[0-9;]*m/, JSON.stringify(found))
  }
})

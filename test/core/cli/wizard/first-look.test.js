// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { firstLookNoticeSink, runWizardFirstLook } from '../../../../src/core/cli/wizard/first_look.js'
import { OVERVIEW_PROBE_SQL, buildOverviewSql } from '../../../../src/core/query/overview.js'

// The wizard's half of the first look (LLP 0135 #first-look): when the step
// runs, and that it can never fail a finished install. The block's layout
// is covered by test/core/query-overview.test.js.
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
  { provider: 'anthropic', model: 'claude-opus-5', input_tokens: 200, cached_tokens: 4000, output_tokens: 42 },
]
const DAILY_ROWS = [
  { date: '2026-07-24', sessions: 3, input_tokens: 200, cached_tokens: 4000, output_tokens: 42 },
]
const REPO_ROWS = [{ repo_root: '/w/acme/api', sessions: 3, input_tokens: 200, cached_tokens: 4000, output_tokens: 42 }]
const TOOL_ROWS = [{ tool_name: 'Bash', calls: 9, sessions: 3 }]
const PROBE_ROWS = [{ date: '2026-07-24', n: 120 }]

/**
 * Rows for the probe and for whichever section statement follows it. The
 * window the planner picks from PROBE_ROWS decides the statements, so the
 * fixtures key off that same window.
 */
const SECTION_SQL = buildOverviewSql('2026-07-24')
const ROWS_BY_SQL = {
  [OVERVIEW_PROBE_SQL]: PROBE_ROWS,
  [SECTION_SQL.models]: PROVIDER_ROWS,
  [SECTION_SQL.daily]: DAILY_ROWS,
  [SECTION_SQL.repos]: REPO_ROWS,
  [SECTION_SQL.tools]: TOOL_ROWS,
}

test('runWizardFirstLook: writes the two setup sections, names the fuller command, reports row counts', async () => {
  const stdout = makeBuf()
  /** @type {string[]} */
  const seen = []
  const result = await runWizardFirstLook({
    stdout,
    runner: {
      hasDataset: () => true,
      async run(sql) {
        seen.push(sql)
        return { columns: [], rows: ROWS_BY_SQL[sql] ?? [] }
      },
    },
  })
  // Probe, then models and daily. Repos and tools are not run at all:
  // setup pays for the two sections that prove capture worked, and
  // `hyp query overview` is where the other two live.
  // @ref LLP 0198#wizard-sections [tests]:
  assert.deepEqual(seen, [OVERVIEW_PROBE_SQL, SECTION_SQL.models, SECTION_SQL.daily])
  assert.deepEqual(result, { shown: true, providerRows: 1, dayRows: 1 })
  const text = stdout.text()
  assert.match(text, /First look at what HypAware has recorded/)
  assert.match(text, /claude-opus-5/)
  assert.match(text, /2026-07-24/)
  // The two it does not run are absent, not empty-stated.
  assert.ok(!text.includes('acme/api'))
  assert.ok(!text.includes('Bash'))
  // A section that was never requested is never called unfinished.
  assert.ok(!text.includes('did not finish'))
  // One pointer line, and it says the full block is bigger than this one.
  assert.match(text, /See more anytime: hyp query overview \(adds repos and tools; --sql shows the queries\)/)
  assert.ok(!text.includes('The SQL behind these'))
})

test('runWizardFirstLook: an expired deadline keeps the sections that finished', async () => {
  const stdout = makeBuf()
  const result = await runWizardFirstLook({
    stdout,
    budgetMs: 120,
    runner: {
      hasDataset: () => true,
      /** @param {string} sql */
      async run(sql) {
        // Probe and `models` land fast; `daily` stalls past the budget.
        if (sql === SECTION_SQL.daily) {
          return new Promise((resolve) => { setTimeout(() => resolve({ columns: [], rows: [] }), 5000).unref() })
        }
        return { columns: [], rows: ROWS_BY_SQL[sql] ?? [] }
      },
    },
  })
  const text = stdout.text()
  // What completed is shown rather than thrown away.
  assert.equal(result.shown, true)
  assert.equal(result.partial, true)
  assert.match(text, /First look at what HypAware has recorded/)
  assert.match(text, /claude-opus-5/)
  // The unfinished section is named as unfinished, not as empty - and only
  // the requested one is named, never repos or tools.
  const stopped = text.split('\n').find((l) => l.startsWith('Stopped here')) ?? ''
  assert.match(stopped, /Stopped here to keep setup moving: the daily section did not finish\./)
  // Only the requested section is named. Repos and tools were never asked
  // for, so calling them unfinished would be a claim about work nobody
  // started (the pointer line below mentions them, which is a different
  // sentence and a different claim).
  assert.ok(!stopped.includes('repos') && !stopped.includes('tools'))
})

test('runWizardFirstLook: a slow cache skips within budget and says what to run', async () => {
  const stdout = makeBuf()
  const started = Date.now()
  const result = await runWizardFirstLook({
    stdout,
    budgetMs: 40,
    runner: {
      hasDataset: () => true,
      // Far longer than the budget: stands in for a cache big enough that
      // summarizing it would hold up the install. `unref` so the abandoned
      // query does not keep the test runner alive - production drops it at
      // `process.exit` instead.
      run: () => new Promise((resolve) => {
        setTimeout(() => resolve({ columns: [], rows: [] }), 5000).unref()
      }),
    },
  })
  assert.deepEqual(result, { shown: false, reason: 'slow' })
  // Setup moved on rather than waiting out the query.
  assert.ok(Date.now() - started < 2000)
  assert.match(stdout.text(), /Skipped the first look/)
  assert.match(stdout.text(), /Run `hyp query overview` to see it/)
})

test('runWizardFirstLook: a cache inside the budget still renders', async () => {
  const stdout = makeBuf()
  const result = await runWizardFirstLook({
    stdout,
    budgetMs: 5000,
    runner: {
      hasDataset: () => true,
      async run(sql) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { columns: [], rows: ROWS_BY_SQL[sql] ?? [] }
      },
    },
  })
  assert.equal(result.shown, true)
  assert.match(stdout.text(), /claude-opus-5/)
  assert.ok(!stdout.text().includes('Skipped the first look'))
})

test('runWizardFirstLook: an unregistered dataset skips silently', async () => {
  const stdout = makeBuf()
  const result = await runWizardFirstLook({
    stdout,
    runner: { hasDataset: () => false, async run() { throw new Error('must not run') } },
  })
  assert.deepEqual(result, { shown: false, reason: 'no-dataset' })
  assert.equal(stdout.text(), '')
})

test('runWizardFirstLook: a query failure degrades to a skipped step, not a throw', async () => {
  const stdout = makeBuf()
  const result = await runWizardFirstLook({
    stdout,
    runner: { hasDataset: () => true, async run() { throw new Error('cache unreadable') } },
  })
  assert.deepEqual(result, { shown: false, reason: 'error' })
  assert.equal(stdout.text(), '')
})

test('runWizardFirstLook: a synchronous write failure cannot escape and fail a finished install', async () => {
  // A stdout whose `write` throws. Rendering and writing sit after the
  // queries, so a throw here used to escape into the wizard and surface as
  // `hyp: <error>` with a non-zero exit from an install that had already
  // succeeded.
  //
  // What this does NOT pin: an async EPIPE from a real pipe, which arrives
  // as an 'error' event and no try/catch can contain. That is handled at
  // the process's streams and pinned against a real pipe in
  // test/core/cli/stream-errors.test.js.
  const exploding = {
    write() {
      const err = /** @type {Error & { code?: string }} */ (new Error('write EPIPE'))
      err.code = 'EPIPE'
      throw err
    },
  }
  const result = await runWizardFirstLook({
    stdout: exploding,
    runner: {
      hasDataset: () => true,
      async run(sql) {
        return { columns: [], rows: ROWS_BY_SQL[sql] ?? [] }
      },
    },
  })
  assert.deepEqual(result, { shown: false, reason: 'error' })
})

test('runWizardFirstLook: a render failure is contained too', async () => {
  const stdout = makeBuf()
  const result = await runWizardFirstLook({
    stdout,
    runner: {
      hasDataset: () => true,
      async run(sql) {
        // A row shape the renderer never expects: every field throws when
        // read. On a section setup actually runs, so the containment being
        // tested is reachable.
        if (sql === SECTION_SQL.daily) {
          return { columns: [], rows: [new Proxy({}, { get() { throw new Error('bad row') } })] }
        }
        return { columns: [], rows: ROWS_BY_SQL[sql] ?? [] }
      },
    },
  })
  assert.deepEqual(result, { shown: false, reason: 'error' })
})

test('firstLookNoticeSink: discloses withheld rows, drops the freshness line', async () => {
  const stderr = makeBuf()
  const sink = firstLookNoticeSink(stderr)
  // Setup is not an excuse to omit rows quietly (LLP 0105)...
  sink({ kind: 'local-only', line: 'local-only: withheld 3 row(s) not visible from this full caller\n' })
  // ...but a sub-two-minute lag on live capture is not something the person
  // finishing an install can act on. `hyp query overview` prints it.
  sink({ kind: 'freshness', line: 'note: capture may lag by up to 2 minutes\n' })
  assert.equal(stderr.text(), 'local-only: withheld 3 row(s) not visible from this full caller\n')
})

test('firstLookNoticeSink: a closed sink drops a late disclosure', async () => {
  // An expired deadline abandons queries that keep running. One resolving
  // after the step returned must not print over the privacy narration,
  // which setup documents as its last words.
  const stderr = makeBuf()
  const sink = firstLookNoticeSink(stderr)
  sink.close()
  sink({ kind: 'local-only', line: 'local-only: withheld 3 row(s)\n' })
  assert.equal(stderr.text(), '')
})

test('runWizardFirstLook: no runner (no query registry) skips', async () => {
  const stdout = makeBuf()
  const result = await runWizardFirstLook({ stdout })
  assert.deepEqual(result, { shown: false, reason: 'no-dataset' })
  assert.equal(stdout.text(), '')
})

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateEnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/config.js'
import { inWindowSessions, parseBackfillArgv } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/commands.js'

/**
 * @import { EnrichConfig } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/types.d.ts'
 */

/** @returns {EnrichConfig} */
function cfg(overrides = {}) {
  const result = validateEnrichConfig(overrides)
  if (!result.ok) throw new Error('test config invalid')
  return result.config
}

/**
 * Fake EnrichRuntime whose single `inWindowSessions` query returns `rows`
 * verbatim (the function issues exactly one GROUP BY over the source dataset).
 *
 * @param {Record<string, unknown>[]} rows
 */
function windowRuntime(rows) {
  return /** @type {any} */ ({
    config: cfg(),
    execSql: async () => ({ rows }),
  })
}

// --- parseBackfillArgv (the `hyp enrich backfill` flag parser) ---------------

test('parseBackfillArgv: bare argv runs both phases', () => {
  assert.deepEqual(parseBackfillArgv([]), { ok: true, proposeOnly: false, curateOnly: false, dryRun: false })
})

test('parseBackfillArgv: --propose-only selects only propose', () => {
  assert.deepEqual(parseBackfillArgv(['--propose-only']), { ok: true, proposeOnly: true, curateOnly: false, dryRun: false })
})

test('parseBackfillArgv: --curate-only selects only curate', () => {
  assert.deepEqual(parseBackfillArgv(['--curate-only']), { ok: true, proposeOnly: false, curateOnly: true, dryRun: false })
})

test('parseBackfillArgv: --since <date> scopes the curate pool', () => {
  assert.deepEqual(parseBackfillArgv(['--curate-only', '--since', '2026-06-08']), {
    ok: true, proposeOnly: false, curateOnly: true, dryRun: false, since: '2026-06-08',
  })
})

test('parseBackfillArgv: --since=<date> (equals form) is accepted', () => {
  assert.deepEqual(parseBackfillArgv(['--since=2026-06-08']), {
    ok: true, proposeOnly: false, curateOnly: false, dryRun: false, since: '2026-06-08',
  })
})

test('parseBackfillArgv: --dry-run is parsed', () => {
  assert.deepEqual(parseBackfillArgv(['--curate-only', '--dry-run', '--since', '2026-06-08']), {
    ok: true, proposeOnly: false, curateOnly: true, dryRun: true, since: '2026-06-08',
  })
})

test('parseBackfillArgv: a malformed --since date is rejected', () => {
  const r = parseBackfillArgv(['--since', 'last-week'])
  assert.equal(r.ok, false)
  assert.match(/** @type {{ error: string }} */ (r).error, /YYYY-MM-DD/)
})

test('parseBackfillArgv: --since requires a value', () => {
  const r = parseBackfillArgv(['--since'])
  assert.equal(r.ok, false)
  assert.match(/** @type {{ error: string }} */ (r).error, /YYYY-MM-DD/)
})

test('parseBackfillArgv: --since does not apply to --propose-only', () => {
  const r = parseBackfillArgv(['--propose-only', '--since', '2026-06-08'])
  assert.equal(r.ok, false)
  assert.match(/** @type {{ error: string }} */ (r).error, /does not apply to --propose-only/)
})

test('parseBackfillArgv: the two phase flags are mutually exclusive', () => {
  const r = parseBackfillArgv(['--propose-only', '--curate-only'])
  assert.equal(r.ok, false)
  assert.match(/** @type {{ error: string }} */ (r).error, /mutually exclusive/)
})

test('parseBackfillArgv: an unknown flag is rejected', () => {
  const r = parseBackfillArgv(['--nope'])
  assert.equal(r.ok, false)
  assert.match(/** @type {{ error: string }} */ (r).error, /unknown flag --nope/)
})

test('parseBackfillArgv: a stray positional is rejected (backfill takes no argument)', () => {
  const r = parseBackfillArgv(['session-123'])
  assert.equal(r.ok, false)
  assert.match(/** @type {{ error: string }} */ (r).error, /unexpected argument session-123/)
})

test('parseBackfillArgv: an unknown flag is reported even alongside a valid flag', () => {
  // Guards the `startsWith('--')` ordering: a real flag must not mask a later bad one.
  const r = parseBackfillArgv(['--propose-only', '--bogus'])
  assert.equal(r.ok, false)
  assert.match(/** @type {{ error: string }} */ (r).error, /unknown flag --bogus/)
})

// --- inWindowSessions (the `--since` UTC-midnight scope) ----------------------

test('inWindowSessions includes a session at exactly the --since UTC midnight and excludes one a second before', async () => {
  const midnight = Date.parse('2026-06-08T00:00:00Z')
  const rows = [
    { sid: 'on-boundary', last_ts: new Date(midnight) },
    { sid: 'just-before', last_ts: new Date(midnight - 1000) },
    { sid: 'well-after', last_ts: new Date(midnight + 86_400_000) },
  ]
  const keys = await inWindowSessions(windowRuntime(rows), '2026-06-08')
  assert.deepEqual([...keys].sort(), ['on-boundary', 'well-after'])
  assert.equal(keys.has('just-before'), false, 'the boundary is inclusive of midnight, exclusive below it')
})

test('inWindowSessions accepts string and epoch-millis timestamps and drops unparseable ones', async () => {
  const midnight = Date.parse('2026-06-08T00:00:00Z')
  const rows = [
    { sid: 'string-after', last_ts: '2026-06-09T12:00:00Z' },
    { sid: 'millis-after', last_ts: midnight + 5000 },
    { sid: 'string-before', last_ts: '2026-06-01T00:00:00Z' },
    { sid: 'unparseable', last_ts: 'not-a-date' },
    { sid: 'null-ts', last_ts: null },
  ]
  const keys = await inWindowSessions(windowRuntime(rows), '2026-06-08')
  assert.deepEqual([...keys].sort(), ['millis-after', 'string-after'])
})

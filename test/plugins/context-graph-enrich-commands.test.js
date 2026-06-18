// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseBackfillArgv } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/commands.js'

// --- parseBackfillArgv (the `hyp enrich backfill` flag parser) ---------------

test('parseBackfillArgv: bare argv runs both phases', () => {
  assert.deepEqual(parseBackfillArgv([]), { ok: true, proposeOnly: false, curateOnly: false })
})

test('parseBackfillArgv: --propose-only selects only propose', () => {
  assert.deepEqual(parseBackfillArgv(['--propose-only']), { ok: true, proposeOnly: true, curateOnly: false })
})

test('parseBackfillArgv: --curate-only selects only curate', () => {
  assert.deepEqual(parseBackfillArgv(['--curate-only']), { ok: true, proposeOnly: false, curateOnly: true })
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

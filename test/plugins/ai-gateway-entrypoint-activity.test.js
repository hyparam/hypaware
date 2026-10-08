// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createEntrypointActivity } from '../../hypaware-core/plugins-workspace/ai-gateway/src/entrypoint_activity.js'
/** @import { AiGatewayCaptureReason } from '../../hypaware-plugin-kernel-types.js' */

// The gateway's half of "hyp status names recent client surfaces": count and
// timestamp whatever the projector wrote into `entrypoint`, interpret none of
// it, and never grow without bound on a client-supplied string.
// @ref LLP 0164#gateway-tracks-what-core-cannot-name [tests]:

test('records one entry per entrypoint, counting rows and stamping last-seen', () => {
  let clock = Date.parse('2026-07-30T10:00:00.000Z')
  const activity = createEntrypointActivity({ now: () => clock })

  activity.record([
    { entrypoint: 'codex-tui', client_name: 'codex' },
    { entrypoint: 'codex-tui', client_name: 'codex' },
  ])
  clock += 60_000
  activity.record([{ entrypoint: 'Codex Desktop', client_name: 'codex' }])

  assert.deepEqual(activity.snapshot(), [
    {
      entrypoint: 'Codex Desktop',
      client_name: 'codex',
      last_seen: '2026-07-30T10:01:00.000Z',
      rows: 1,
    },
    {
      entrypoint: 'codex-tui',
      client_name: 'codex',
      last_seen: '2026-07-30T10:00:00.000Z',
      rows: 2,
    },
  ])
})

test('the snapshot is most-recently-seen first, so a stale surface sinks', () => {
  let clock = Date.parse('2026-07-30T10:00:00.000Z')
  const activity = createEntrypointActivity({ now: () => clock })

  activity.record([{ entrypoint: 'Codex Desktop', client_name: 'codex' }])
  clock += 3_600_000
  activity.record([{ entrypoint: 'codex-tui', client_name: 'codex' }])
  clock += 3_600_000
  activity.record([{ entrypoint: 'Codex Desktop', client_name: 'codex' }])

  assert.deepEqual(
    activity.snapshot().map((e) => e.entrypoint),
    ['Codex Desktop', 'codex-tui']
  )
  assert.equal(activity.snapshot()[0].rows, 2)
})

test('rows with no entrypoint are ignored rather than bucketed under a placeholder', () => {
  const activity = createEntrypointActivity()
  activity.record([
    { client_name: 'codex' },
    { entrypoint: '', client_name: 'codex' },
    { entrypoint: 42, client_name: 'codex' },
    { entrypoint: 'codex-tui' },
  ])

  const snapshot = activity.snapshot()
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].entrypoint, 'codex-tui')
  // No client_name on the row means none is invented for the status line.
  assert.equal(snapshot[0].client_name, null)
})

test('a client-supplied entrypoint cannot grow the map without bound', () => {
  const activity = createEntrypointActivity({ max: 3 })
  for (let i = 0; i < 50; i++) {
    activity.record([{ entrypoint: `surface-${i}`, client_name: 'codex' }])
  }
  assert.equal(activity.size(), 3)
  // The survivors are the most recently seen, which is what a "recent
  // clients" readout would have shown anyway.
  assert.deepEqual(
    activity.snapshot().map((e) => e.entrypoint).sort(),
    ['surface-47', 'surface-48', 'surface-49']
  )
})

test('seeing an old entrypoint again rescues it from eviction', () => {
  const activity = createEntrypointActivity({ max: 2 })
  activity.record([{ entrypoint: 'Codex Desktop', client_name: 'codex' }])
  activity.record([{ entrypoint: 'codex-tui', client_name: 'codex' }])
  activity.record([{ entrypoint: 'Codex Desktop', client_name: 'codex' }])
  activity.record([{ entrypoint: 'local-agent', client_name: 'claude' }])

  assert.deepEqual(
    activity.snapshot().map((e) => e.entrypoint).sort(),
    ['Codex Desktop', 'local-agent']
  )
})

test('an empty or malformed batch is a no-op, not a throw', () => {
  const activity = createEntrypointActivity()
  activity.record([])
  activity.record(/** @type {any} */ (undefined))
  activity.record(/** @type {any} */ ([null, 'nope', 7]))
  assert.deepEqual(activity.snapshot(), [])
})

// The tracker feeds a file on disk and a terminal, and one of the three routes
// into `entrypoint` (Claude's transcript `.jsonl`, via `assignTranscriptIdentity`)
// is not bounded by an HTTP parser: it is a JSON string of any length holding any
// byte. A count cap alone does not bound that.
test('a control-character entrypoint cannot forge lines or move the cursor', () => {
  const ESC = String.fromCharCode(27)
  const LF = String.fromCharCode(10)
  const activity = createEntrypointActivity()
  activity.record([
    { entrypoint: `local-agent${ESC}[2K${LF}  daemon:   FORGED`, client_name: `cl${ESC}[31maude` },
  ])

  const [entry] = activity.snapshot()
  assert.equal(entry.entrypoint.includes(ESC), false)
  assert.equal(entry.entrypoint.includes(LF), false)
  assert.equal(entry.client_name?.includes(ESC), false)
  // Stripped, not dropped: the surface is still named.
  assert.match(entry.entrypoint, /^local-agent/)
})

test('an over-long entrypoint is clamped, so status.json stays small', () => {
  const activity = createEntrypointActivity()
  activity.record([{ entrypoint: 'A'.repeat(50000), client_name: 'B'.repeat(50000) }])

  const [entry] = activity.snapshot()
  assert.ok(entry.entrypoint.length <= 128, `entrypoint length ${entry.entrypoint.length}`)
  assert.ok((entry.client_name ?? '').length <= 128)
  assert.ok(JSON.stringify(activity.snapshot()).length < 1024)
})

test('an entrypoint of nothing but control bytes is skipped, not stored blank', () => {
  const activity = createEntrypointActivity()
  activity.record([{ entrypoint: String.fromCharCode(27) + String.fromCharCode(7) }])
  assert.deepEqual(activity.snapshot(), [])
})

// Pins the shipped default. The eviction tests above all pass an explicit
// `max`, so without this the constant could be raised to any value and every
// test would still pass.
test('the default cap is 32 distinct entrypoints', () => {
  const activity = createEntrypointActivity()
  for (let i = 0; i < 200; i++) activity.record([{ entrypoint: `surface-${i}` }])
  assert.equal(activity.size(), 32)
})

// A control byte is not the only way a label can render as something other
// than what it stores. Bidi overrides print nothing and reverse what follows,
// and an unterminated one runs past the end of the label into the rest of the
// status line.
test('a bidi override cannot reorder the rendered status line', () => {
  const RLO = String.fromCharCode(0x202e)
  const LRI = String.fromCharCode(0x2066)
  const activity = createEntrypointActivity()
  activity.record([{ entrypoint: `local-agent${RLO}tnega-lacol`, client_name: `c${LRI}laude` }])

  const [entry] = activity.snapshot()
  assert.equal(entry.entrypoint.includes(RLO), false)
  assert.equal(entry.client_name?.includes(LRI), false)
  assert.match(entry.entrypoint, /^local-agent/)
})

// The whole reason the tracker sanitizes at `record` rather than at render is
// to keep the map *key* clean. Characters with no rendered width would
// otherwise mint unlimited distinct keys that an operator cannot tell apart,
// so 32 slots of one surface would evict every real one.
test('invisible characters cannot dilute the eviction cap', () => {
  const ZWSP = String.fromCharCode(0x200b)
  const activity = createEntrypointActivity()
  for (let i = 0; i < 500; i++) activity.record([{ entrypoint: 'codex-tui' + ZWSP.repeat(i) }])

  assert.equal(activity.size(), 1)
  assert.deepEqual(activity.snapshot().map((e) => e.entrypoint), ['codex-tui'])
})

// The clamp counts UTF-16 code units, so a cut can land between the halves of
// an astral character. A lone surrogate is not a well-formed string and would
// ride into `status.json` as one.
test('clamping an astral entrypoint leaves a well-formed string', () => {
  const activity = createEntrypointActivity()
  activity.record([{ entrypoint: 'A'.repeat(119) + String.fromCodePoint(0x1f600).repeat(50) }])

  const [entry] = activity.snapshot()
  assert.equal(entry.entrypoint.isWellFormed(), true)
  // The marker is inside the ceiling, not bolted on past it.
  assert.ok(entry.entrypoint.length <= 120, `length ${entry.entrypoint.length}`)
})

// @ref LLP 0474#diagnostics [tests]: every reason remains finite, append failure cannot stamp persistence, and default stderr does not need telemetry
test('capture evidence retains only known routes and reasons, capped scalar summaries and coalesced default stderr', async t => {
  const { createCaptureOutcomes, CAPTURE_REASONS, mergeCaptureOutcomes } = await import('../../hypaware-core/plugins-workspace/ai-gateway/src/entrypoint_activity.js')
  let at = Date.parse('2026-10-07T10:00:00Z')
  t.mock.method(Date, 'now', () => at)
  let stderr = ''
  t.mock.method(process.stderr, 'write', chunk => { stderr += chunk; return true })
  const tracker = createCaptureOutcomes(Array.from({ length: 100 }, (_, index) => 'route-' + index))
  assert.equal(tracker.snapshot().length, 32)
  tracker.record('arbitrary-SECRET', 'append_failure', 'SECRET invalid\nID')
  for (const reason of CAPTURE_REASONS) tracker.record('route-0', /** @type {AiGatewayCaptureReason} */ (reason), 'safe:1')
  let entry = tracker.snapshot()[0]
  assert.equal(Object.keys(entry.reasons).length, CAPTURE_REASONS.length)
  assert.equal(entry.persisted, 0)
  assert.equal(entry.last_persisted, undefined)
  tracker.record('route-0', 'text', 'safe:2')
  assert.equal(tracker.snapshot()[0].last_persisted, undefined, 'projection alone is not persistence')
  at += 30_000
  tracker.record('route-0', 'text', 'safe:2', true)
  entry = tracker.snapshot()[0]
  assert.equal(entry.persisted, 1)
  const stamp = entry.last_persisted
  const id = entry.persisted_id
  at += 30_000
  tracker.record('route-0', 'append_failure', 'safe:3')
  for (let index = 0; index < 100; index++) tracker.record('route-0', 'append_failure', 'safe:3')
  entry = tracker.snapshot()[0]
  assert.equal(entry.last_persisted, stamp)
  assert.equal(entry.persisted_id, id)
  assert.equal(entry.failed_id, 'safe:3')
  assert.equal(stderr.split('\n').filter(Boolean).length, 3)
  assert.match(stderr, /WARN.*append_failure/)
  assert.match(stderr, /INFO.*text/)
  assert.doesNotMatch(stderr, /SECRET|invalid/)
  const merged = mergeCaptureOutcomes(tracker.snapshot(), [{ route: 'route-0', observed: Infinity, failed: NaN, persisted: -1, reasons: { text: 9e99, append_failure: NaN, arbitrary: 200 }, reason: 'arbitrary', prompt: 'SECRET' }])
  const summary = /** @type {any} */ (merged[0])
  assert.equal(summary.observed, 0x7fffffff)
  assert.ok(summary.persisted >= 1)
  assert.equal(summary.reasons.text, 0x7fffffff)
  assert.ok(Number.isFinite(summary.reasons.append_failure))
  assert.equal(summary.reasons.arbitrary, undefined)
  assert.doesNotMatch(JSON.stringify(merged), /SECRET|prompt|NaN|Infinity/)
  assert.equal(mergeCaptureOutcomes(tracker.snapshot(), Array.from({ length: 40 }, (_, index) => ({ route: 'more-' + index }))).length, 32)
})

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createEntrypointActivity } from '../../hypaware-core/plugins-workspace/ai-gateway/src/entrypoint_activity.js'

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

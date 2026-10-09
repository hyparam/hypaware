// @ts-check

// The team graph status line in each replica state, against the UX
// guardian's wording in LLP 0480#status-line (the leave line is not used,
// LLP 0482).

import test from 'node:test'
import assert from 'node:assert/strict'

import { formatAge, summaryLine } from '../../hypaware-core/plugins-workspace/fastask/src/summary_line.js'

/**
 * @import { ReplicaStatus } from '../../hypaware-core/plugins-workspace/fastask/src/types.js'
 */

const NOW = Date.parse('2026-10-09T16:00:00.000Z')

/** @param {Partial<ReplicaStatus>} over @returns {ReplicaStatus} */
function status(over) {
  return {
    state: 'synced',
    reason: null,
    servable: true,
    target: 'team',
    origin: 'https://hyp.example',
    org: 'acme',
    generation: 'g1',
    watermark: '2026-10-09T02:00:00.000Z',
    watermark_age_s: 50_400,
    published_at: '2026-10-09T02:10:00.000Z',
    last_check: '2026-10-09T15:55:00.000Z',
    last_success: '2026-10-09T09:12:00.000Z',
    lease_expires_at: '2026-10-12T09:00:00.000Z',
    bytes_on_disk: 52_000_000,
    rows: { nodes: 1, edges: 1 },
    refresh_in_progress: false,
    generation_dir: '/x',
    ...over,
  }
}

/** @param {Partial<ReplicaStatus>} over */
const line = (over) => summaryLine(status(over), { now: NOW, timeZone: 'UTC' })

test('each state reads as the guardian wrote it', () => {
  const twoDays = '2026-10-07T16:00:00.000Z'
  assert.equal(line({}), 'team graph: synced, data as of 14 h ago (acme), 52 MB')
  assert.equal(line({ state: 'stale', reason: 'outage', watermark: twoDays }),
    'team graph: stale, server unreachable since 09:12, data as of 2 d ago, usable until Oct 12 09:00')
  assert.equal(line({ state: 'stale', reason: 'credential', watermark: twoDays }),
    'team graph: stale, sign in again (hyp remote login), data as of 2 d ago, usable until Oct 12 09:00')
  assert.equal(line({ state: 'expired', generation: null, servable: false }), 'team graph: expired, not used; reconnect to refresh')
  assert.equal(line({ state: 'withdrawn', generation: null, servable: false }), 'team graph: removed, access to acme was withdrawn')
  assert.equal(line({ state: 'unsupported', reason: 'protocol', generation: null, servable: false }),
    'team graph: unsupported, upgrade hypaware (or the server is older than this feature)')
  assert.equal(line({ state: 'unsupported', reason: 'format', watermark: twoDays }),
    'team graph: unsupported, upgrade hypaware; still using data as of 2 d ago until Oct 12 09:00')
  assert.equal(line({ state: 'unavailable', reason: 'pending', generation: null, servable: false, watermark: null }),
    'team graph: not available yet (server has not published one)')
})

test('reasons without a guardian line still say what to do, and stale always carries the age', () => {
  assert.match(line({ state: 'unavailable', reason: 'no_login', generation: null, servable: false }), /hyp remote login/)
  assert.match(line({ state: 'unavailable', reason: 'disabled', generation: null, servable: false }), /not turned team graph snapshots on/)
  for (const reason of ['pending', 'verify_failed', 'activate_failed', 'disk_full', 'replica_too_large']) {
    assert.match(line({ state: 'stale', reason }), /, data as of 14 h ago, usable until Oct 12 09:00$/, reason)
  }
  assert.ok(!line({ state: 'stale', reason: 'outage' }).includes('leave'), 'the leave line is not used (LLP 0482)')
})

test('ages read in minutes, hours, then days; an unknown watermark says so', () => {
  assert.equal(formatAge(new Date(NOW - 5 * 60_000).toISOString(), NOW), '5 min ago')
  assert.equal(formatAge(new Date(NOW - 20_000).toISOString(), NOW), '1 min ago')
  assert.equal(formatAge(new Date(NOW - 47 * 3600_000).toISOString(), NOW), '47 h ago')
  assert.equal(formatAge(new Date(NOW - 3 * 86400_000).toISOString(), NOW), '3 d ago')
  assert.equal(formatAge(null, NOW), 'an unknown time')
})

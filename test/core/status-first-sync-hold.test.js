// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import {
  firstSyncHoldMarkerPath,
  formatFirstSyncDeadline,
  writeFirstSyncHoldMarker,
} from '../../src/core/usage-policy/first_sync_hold.js'

// T6 - `hyp status` never-silent first-sync hold surface (LLP 0100 R9): a
// live hold pauses every sink tick driver-wide (LLP 0101 #hold), so a held
// machine must show the pending deadline rather than look like an ordinary,
// unheld install.
// @ref LLP 0100#requirements [tests]: R9

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-first-sync-hold-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

test('no hold marker: the deadline is null and text/JSON stay quiet', async () => {
  const hypHome = await makeHome()

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.firstSyncHoldDeadline, null)

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.equal(json.first_sync_hold, null)

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.doesNotMatch(stdout.text(), /first sync:/)
})

test('a live hold surfaces its deadline in text and JSON (LLP 0100 R9)', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const deadline = await writeFirstSyncHoldMarker({ stateDir: stateRoot })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.firstSyncHoldDeadline, deadline)
  assert.equal(report.overall, 'healthy', 'a live hold is expected state, never a degradation')

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.deepEqual(json.first_sync_hold, {
    deadline: new Date(deadline).toISOString(),
    deadline_ms: deadline,
  })

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()
  assert.match(text, /first sync:\s+held until /)
  assert.ok(
    text.includes(formatFirstSyncDeadline(deadline)),
    'the status line uses the same absolute-time formatting as the login message'
  )
  assert.match(text, /hypaware-privacy skill/)
})

test('an expired hold reads as absent, exactly as the sink driver sees it', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  // A deadline already in the past: writeFirstSyncHoldMarker always computes
  // a future one, so backdate `now` to get an expired marker on disk.
  await writeFirstSyncHoldMarker({ stateDir: stateRoot, now: Date.now() - 48 * 60 * 60_000 })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.firstSyncHoldDeadline, null)

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.doesNotMatch(stdout.text(), /first sync:/)
})

test('a corrupt marker fails open (absent, no diagnostic, no degrade) - LLP 0101 fail-open polarity', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const markerPath = firstSyncHoldMarkerPath(stateRoot)
  await fs.mkdir(path.dirname(markerPath), { recursive: true })
  await fs.writeFile(markerPath, '{ not valid json', 'utf8')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.firstSyncHoldDeadline, null)
  assert.equal(report.overall, 'healthy', 'a corrupt marker is timing-only; it never degrades overall (fail-open)')
  assert.deepEqual(report.diagnostics, [], 'a corrupt hold marker mints no diagnostic - it is timing-only, not a privacy signal')

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.equal(json.first_sync_hold, null)
})

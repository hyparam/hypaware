// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/** @import { CollectStatusOptions, StatusDiagnostic } from '../../src/core/daemon/types.js' */

// Issue #2547 part 3. A probation that expires because a sink could not
// materialize was reported as a bad config revision, and every recent error,
// a sink materialize failure included, was answered with `hyp daemon restart`.
// A restart materializes the same sink the same way, and the revision was
// never shown to be bad: this host just could not confirm it.

const CONFIG_HINT = 'fix the central config revision; the gateway re-applies when the served etag changes'

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-sink-hints-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateRoot, { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

/**
 * Write the processing daemon's log, the one that materializes sinks.
 *
 * @param {string} stateRoot
 * @param {Record<string, unknown>[]} records each with an `agoMs`
 */
async function writeProcessingLog(stateRoot, records) {
  const dir = path.join(stateRoot, 'processing', 'logs')
  await fs.mkdir(dir, { recursive: true })
  const lines = records.map(({ agoMs, ...rest }) => JSON.stringify({
    ts: new Date(Date.now() - Number(agoMs)).toISOString(),
    pid: 4242,
    dev_run_id: 'test-run',
    mode: 'detached',
    ...rest,
  }))
  await fs.writeFile(path.join(dir, 'daemon.log'), lines.join('\n') + '\n')
}

/**
 * @param {string} stateRoot
 * @param {number} agoMs
 */
async function writeExpiredRollback(stateRoot, agoMs) {
  const dir = path.join(stateRoot, 'config-control')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({
    last_rollback: { etag: 'W/"rev-7"', reason: 'probation_expired', at: new Date(Date.now() - agoMs).toISOString() },
  }))
}

/**
 * @param {StatusDiagnostic[]} diagnostics
 * @param {string} kind
 */
function find(diagnostics, kind) {
  const diag = diagnostics.find((d) => d.kind === kind)
  assert.ok(diag, `expected a ${kind} diagnostic`)
  return diag
}

/** @param {StatusDiagnostic} diag */
function offersRestart(diag) {
  return (diag.repair ?? []).some((r) => r.includes('hyp daemon restart'))
}

const MIN = 60_000

test('a probation that expired during a boot whose sink failed names the sink and offers no restart', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeProcessingLog(stateRoot, [
    { agoMs: 30 * MIN, level: 'info', event: 'daemon.starting' },
    { agoMs: 29 * MIN, level: 'error', event: 'daemon.sink_materialize_failed', instance: 'central', error_kind: 'sink_plugin_not_active' },
    { agoMs: 29 * MIN, level: 'warn', event: 'daemon.degraded' },
  ])
  await writeExpiredRollback(stateRoot, 25 * MIN)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const rollback = find(report.diagnostics, 'remote_config_rolled_back')
  assert.match(rollback.message, /sink 'central' \(sink_plugin_not_active\) did not materialize/)
  assert.ok(!rollback.repair?.includes(CONFIG_HINT), 'the config is not blamed')
  assert.ok(rollback.repair?.[0].startsWith('grep -s sink_materialize_failed '), 'the log grep comes first')
  assert.ok(!offersRestart(rollback))

  const recent = find(report.diagnostics, 'recent_errors')
  assert.match(recent.message, /1 of them sink materialize failure/)
  assert.ok(recent.repair?.[0].startsWith('grep -s sink_materialize_failed '))
  assert.ok(!offersRestart(recent), 'only materialize failures, so no restart')
})

test('a probation found expired at boot, before materialize ran, uses the previous boot', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeProcessingLog(stateRoot, [
    { agoMs: 60 * MIN, level: 'info', event: 'daemon.starting' },
    { agoMs: 59 * MIN, level: 'error', event: 'daemon.sink_materialize_failed', instance: 'central', error_kind: 'sink_build_failed' },
    { agoMs: 20 * MIN, level: 'info', event: 'daemon.starting' },
  ])
  await writeExpiredRollback(stateRoot, 19 * MIN)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const rollback = find(report.diagnostics, 'remote_config_rolled_back')
  assert.match(rollback.message, /sink 'central' \(sink_build_failed\)/)
  assert.ok(!offersRestart(rollback))
})

test('a failure from an earlier boot that later recovered does not explain the expiry', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeProcessingLog(stateRoot, [
    { agoMs: 90 * MIN, level: 'info', event: 'daemon.starting' },
    { agoMs: 89 * MIN, level: 'error', event: 'daemon.sink_materialize_failed', instance: 'central', error_kind: 'sink_build_failed' },
    { agoMs: 60 * MIN, level: 'info', event: 'daemon.starting' },
    { agoMs: 59 * MIN, level: 'info', event: 'daemon.healthy' },
    { agoMs: 30 * MIN, level: 'info', event: 'daemon.starting' },
  ])
  await writeExpiredRollback(stateRoot, 29 * MIN)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const rollback = find(report.diagnostics, 'remote_config_rolled_back')
  assert.deepEqual(rollback.repair, [CONFIG_HINT])
})

test('a current boot that materialized cleanly is not explained by the boot before it', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeProcessingLog(stateRoot, [
    { agoMs: 60 * MIN, level: 'info', event: 'daemon.starting' },
    { agoMs: 59 * MIN, level: 'error', event: 'daemon.sink_materialize_failed', instance: 'central', error_kind: 'sink_plugin_not_active' },
    { agoMs: 30 * MIN, level: 'info', event: 'daemon.starting' },
    { agoMs: 29 * MIN, level: 'info', event: 'daemon.healthy' },
  ])
  await writeExpiredRollback(stateRoot, 25 * MIN)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const rollback = find(report.diagnostics, 'remote_config_rolled_back')
  assert.doesNotMatch(rollback.message, /did not materialize/)
  assert.deepEqual(rollback.repair, [CONFIG_HINT])
})

test('a plain probation expiry keeps the config-revision hint', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeProcessingLog(stateRoot, [
    { agoMs: 30 * MIN, level: 'info', event: 'daemon.starting' },
    { agoMs: 29 * MIN, level: 'info', event: 'daemon.healthy' },
  ])
  await writeExpiredRollback(stateRoot, 25 * MIN)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const rollback = find(report.diagnostics, 'remote_config_rolled_back')
  assert.doesNotMatch(rollback.message, /did not materialize/)
  assert.deepEqual(rollback.repair, [CONFIG_HINT])
})

test('a sink failure after the rollback does not explain it', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeProcessingLog(stateRoot, [
    { agoMs: 30 * MIN, level: 'info', event: 'daemon.starting' },
    { agoMs: 29 * MIN, level: 'info', event: 'daemon.healthy' },
    { agoMs: 10 * MIN, level: 'info', event: 'daemon.starting' },
    { agoMs: 9 * MIN, level: 'error', event: 'daemon.sink_materialize_failed', instance: 'central', error_kind: 'sink_build_failed' },
  ])
  await writeExpiredRollback(stateRoot, 25 * MIN)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const rollback = find(report.diagnostics, 'remote_config_rolled_back')
  assert.deepEqual(rollback.repair, [CONFIG_HINT])
})

test('mixed recent errors put the log grep first and scope the restart to the others', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeProcessingLog(stateRoot, [
    { agoMs: 30 * MIN, level: 'info', event: 'daemon.starting' },
    { agoMs: 29 * MIN, level: 'error', event: 'daemon.sink_materialize_failed', instance: 'central', error_kind: 'sink_plugin_not_active' },
    { agoMs: 20 * MIN, level: 'error', event: 'daemon.source_failed' },
  ])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const recent = find(report.diagnostics, 'recent_errors')
  assert.ok(recent.repair?.[0].startsWith('grep -s sink_materialize_failed '))
  assert.match(recent.repair?.[1] ?? '', /^hyp daemon restart {2}# for the other errors/)
})

test('the dev telemetry half of a sink materialize failure is not one of the other errors', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeProcessingLog(stateRoot, [
    { agoMs: 29 * MIN, level: 'error', event: 'daemon.sink_materialize_failed', instance: 'central', error_kind: 'sink_plugin_not_active' },
  ])
  const telemetryDir = path.join(stateRoot, 'dev-telemetry')
  await fs.mkdir(telemetryDir, { recursive: true })
  await fs.writeFile(path.join(telemetryDir, 'logs-test.jsonl'), JSON.stringify({
    timestamp: new Date(Date.now() - 29 * MIN).toISOString(),
    severityText: 'ERROR',
    body: 'sink.materialize_failed',
  }) + '\n')

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const recent = find(report.diagnostics, 'recent_errors')
  assert.match(recent.message, /1 in dev telemetry, 1 of them sink materialize failure/)
  assert.ok(recent.repair?.[0].startsWith('grep -s sink_materialize_failed '))
  assert.ok(!offersRestart(recent), 'both halves are the same failure, so no restart')
})

test('recent errors with no sink materialize failure still offer a plain restart', async () => {
  const { hypHome, stateRoot } = await makeHome()
  await writeProcessingLog(stateRoot, [
    { agoMs: 20 * MIN, level: 'error', event: 'daemon.source_failed' },
  ])

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.deepEqual(find(report.diagnostics, 'recent_errors').repair, ['hyp daemon restart'])
})

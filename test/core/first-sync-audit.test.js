// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { runSync } from '../../src/core/commands/sync.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusSummary } from '../../src/core/commands/status.js'
import { daemonLogPath } from '../../src/core/runtime/paths.js'
import { firstSyncConfirmationActor, firstSyncHoldMarkerPath, readFirstSyncDeadline, readFirstSyncRelease, releaseFirstSyncHold, writeFirstSyncHoldMarker } from '../../src/core/usage-policy/first_sync_hold.js'

async function stage(t, env = {}, tty = false) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'first-sync-audit-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const stateDir = path.join(hypHome, 'hypaware')
  await writeFirstSyncHoldMarker({ stateDir })
  const calls = []
  const sink = { instanceName: 'synthetic', plugin: '@test/fake', kind: 'blob', config: { url: 'https://synthetic.invalid' },
    sink: { async exportBatch(batch) { calls.push(batch); return { status: 'exported', partitionsExported: 0, bytesWritten: 0 } } } }
  const output = []
  const input = Object.assign(new PassThrough(), { isTTY: tty })
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome, HOME: hypHome, HYP_CONFIG: '', ...env }, cwd: hypHome,
    config: { version: 2 }, stdin: input,
    stdout: { isTTY: false, write: text => output.push(text) }, stderr: { write: text => output.push(text) },
    query: { listDatasets: () => [] },
    storage: { cacheRoot: path.join(hypHome, 'cache'), tableExists: () => false, hasPendingSync: () => false, async flushTable() {} },
    sinks: { listHandles: () => [sink] },
  })
  return { hypHome, stateDir, ctx, calls, input, output }
}

/** @type {Array<[NodeJS.ProcessEnv, boolean, string]>} */
const scenarios = [
  [{ CODEX_THREAD_ID: 'synthetic-thread' }, true, 'agent-pty'],
  [{ CLAUDECODE: '1' }, false, 'agent-yes-flag'],
  [{ CURSOR_AGENT: '1' }, false, 'agent-yes-flag'],
  [{}, true, 'unknown'],
  [{}, false, 'unknown'],
]
for (const [env, tty, expected] of scenarios) {
  test(`first-sync release is durably attributed as ${expected}, tty=${tty}, env=${Object.keys(env)}`, async t => {
    const s = await stage(t, env, tty)
    if (tty) s.input.write('y\n')
    assert.equal(await runSync(tty ? [] : ['--yes'], s.ctx), 0)
    assert.equal(s.calls.length, 1)
    assert.equal(await readFirstSyncDeadline({ stateDir: s.stateDir }), null)
    const receipt = await readFirstSyncRelease({ stateDir: s.stateDir })
    assert.equal(receipt?.hyp_confirmed_by, expected)
    assert.equal(receipt?.hyp_confirmation_method, tty ? 'prompt' : 'yes-flag')
    assert.ok(Number.isFinite(Date.parse(receipt.ts)))
    const records = (await fs.readFile(daemonLogPath(s.stateDir), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(records.some(record => record.event === 'sync.first_sync_hold_created'))
    assert.ok(records.some(record => record.event === 'sync.first_sync_hold_released' && record.hyp_confirmed_by === expected))
    assert.equal(records.filter(record => record.event === 'sink.export_batch.ok').length, 1)
    assert.equal(await runSync(['--yes'], s.ctx), 0)
    const later = (await fs.readFile(daemonLogPath(s.stateDir), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(later.filter(record => record.event === 'sink.export_batch.ok').length, 1, 'one durable first-success event per sink handle')
    const report = await collectHypAwareStatus({ env: s.ctx.env, homeDir: s.hypHome })
    const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: s.ctx.storage.cacheRoot })
    assert.equal(json.first_sync_release?.hyp_confirmed_by, expected)
    let text = ''
    renderStatusSummary({ report, stdout: { write: chunk => { text += chunk } } })
    assert.match(text, /released early/)
    assert.match(text, new RegExp(expected))
    assert.doesNotMatch(await fs.readFile(daemonLogPath(s.stateDir), 'utf8'), /synthetic-thread|https:\/\//)
  })
}

test('a release receipt that cannot be committed leaves the hold and exports nothing', async t => {
  const s = await stage(t)
  await fs.mkdir(path.join(path.dirname(firstSyncHoldMarkerPath(s.stateDir)), 'first-sync-release.json'))
  assert.equal(await runSync(['--yes'], s.ctx), 1)
  assert.equal(s.calls.length, 0)
  assert.equal(typeof await readFirstSyncDeadline({ stateDir: s.stateDir }), 'number')
  assert.equal(await readFirstSyncRelease({ stateDir: s.stateDir }), null)
})

test('decline and dry-run preserve the hold without a release receipt', async t => {
  const s = await stage(t, {}, true)
  assert.equal(await runSync(['--dry-run'], s.ctx), 0)
  s.input.write('n\n')
  assert.equal(await runSync([], s.ctx), 0)
  assert.equal(s.calls.length, 0)
  assert.equal(await readFirstSyncRelease({ stateDir: s.stateDir }), null)
  assert.equal(typeof await readFirstSyncDeadline({ stateDir: s.stateDir }), 'number')
})

test('configuration-only Codex variables do not identify an agent', () => {
  assert.equal(firstSyncConfirmationActor({ CODEX_HOME: '/synthetic/config' }, true), 'unknown')
})

test('competing releases cannot recreate the hold or overwrite the winning receipt', async t => {
  const s = await stage(t)
  const deadline = await readFirstSyncDeadline({ stateDir: s.stateDir })
  assert.ok(deadline !== null)
  const results = await Promise.all(['agent-pty', 'unknown'].map(actor => releaseFirstSyncHold({
    stateDir: s.stateDir, deadline, actor: /** @type {'agent-pty' | 'unknown'} */ (actor), method: 'prompt',
  })))
  assert.deepEqual(results.sort(), [false, true])
  assert.equal(await readFirstSyncDeadline({ stateDir: s.stateDir }), null)
  const records = (await fs.readFile(daemonLogPath(s.stateDir), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.filter(record => record.event === 'sync.first_sync_hold_released').length, 1)
})

test('expiry is logged once and produces no early-release claim', async t => {
  const s = await stage(t)
  const deadline = await readFirstSyncDeadline({ stateDir: s.stateDir })
  assert.ok(deadline !== null)
  assert.equal(await readFirstSyncDeadline({ stateDir: s.stateDir, now: deadline + 1 }), null)
  assert.equal(await readFirstSyncDeadline({ stateDir: s.stateDir, now: deadline + 1 }), null)
  assert.equal(await readFirstSyncRelease({ stateDir: s.stateDir }), null)
  const records = (await fs.readFile(daemonLogPath(s.stateDir), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.filter(record => record.event === 'sync.first_sync_hold_expired').length, 1)
})

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { renderStatusJson, renderStatusText } from '../../src/core/cli/core_commands.js'

/**
 * @import { ClientActionReport } from '../../src/core/daemon/types.js'
 */

// T6: the client-action reconciler status surface (LLP 0036 / 0041). The
// collector reads the marker file (it never runs a pass) and derives a
// per-provider done/failed/pending/n-a section; a failed action is loud but
// never flips `overall` to `degraded`.
// @ref LLP 0041#failure-is-surfaced-not-fatal [tests]:

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-actions-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

/**
 * Write the reconciler marker file the way the daemon would, so the
 * read-only status path has something to surface.
 *
 * @param {string} hypHome
 * @param {Record<string, Record<string, object>>} byKind
 */
async function writeMarkers(hypHome, byKind) {
  const dir = path.join(hypHome, 'hypaware', 'config-control')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'client-actions.json'), JSON.stringify(byKind, null, 2) + '\n')
}

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/** @param {ClientActionReport[]} actions */
function byKey(actions) {
  /** @type {Map<string, ClientActionReport>} */
  const m = new Map()
  for (const a of actions) m.set(a.requestKey, a)
  return m
}

test('mixed done/failed/pending/n-a reads cleanly off the marker store + config', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')

  // Joined host: central enables the gateway plus two backfill-declaring
  // plugins: claude (on_join true → pending until a pass runs) and codex
  // (on_join false → suppressed → n/a).
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude', config: { backfill: { on_join: true, window_days: 30 } } },
      { name: '@hypaware/codex', config: { backfill: { on_join: false } } },
    ],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')

  // Markers from a prior pass: a completed import and a failed one, keyed by
  // plugin name. (Marker keys surface even if the plugin later left config.)
  await writeMarkers(hypHome, {
    backfill: {
      '@acme/done-plugin': { status: 'done', request_key: '@acme/done-plugin', rows: 1234, at: '2026-06-25T00:00:00.000Z' },
      '@acme/failed-plugin': { status: 'failed', request_key: '@acme/failed-plugin', reason: 'transcript dir missing', last_attempt: '2026-06-25T01:00:00.000Z', attempts: 2 },
    },
  })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.ok(report.clientActions, 'clientActions section is populated')
  const m = byKey(report.clientActions.actions)

  assert.equal(m.get('@acme/done-plugin')?.state, 'done')
  assert.equal(m.get('@acme/done-plugin')?.rows, 1234)
  assert.equal(m.get('@acme/done-plugin')?.at, '2026-06-25T00:00:00.000Z')

  assert.equal(m.get('@acme/failed-plugin')?.state, 'failed')
  assert.equal(m.get('@acme/failed-plugin')?.reason, 'transcript dir missing')
  assert.equal(m.get('@acme/failed-plugin')?.attempts, 2)

  assert.equal(m.get('@hypaware/claude')?.state, 'pending')
  assert.equal(m.get('@hypaware/codex')?.state, 'n/a') // on_join:false → suppressed

  // Every entry is namespaced under the backfill handler kind.
  assert.ok(report.clientActions.actions.every((a) => a.kind === 'backfill'))
})

test('a malformed on_join block renders n/a (not pending) on a joined host', async () => {
  // Regression (round-2): a *present but malformed* `on_join` (the JSON typo
  // `on_join: "false"`) is an opt-out, exactly as `backfillHandler.desired()`
  // reads it: so the reconciler never writes a marker and the honest state is
  // `n/a`. Status used to read `on_join !== false` inline, so the string
  // "false" (!== the boolean false) showed `pending` forever. Both consumers
  // now share `readBackfillPolicy`, so they agree.
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')

  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway' },
      // Malformed opt-out: the string "false", not the boolean false.
      { name: '@hypaware/claude', config: { backfill: { on_join: 'false' } } },
    ],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.ok(report.clientActions, 'the malformed-opt-out target is surfaced')
  const m = byKey(report.clientActions.actions)
  assert.equal(m.get('@hypaware/claude')?.state, 'n/a')
})

test('a default-on backfill target (enabled client, no explicit block) shows pending on a joined host', async () => {
  // Regression: backfillHandler.desired() emits for an enabled provider even
  // with no `config.backfill` block (default-on). Status used to require an
  // explicit block, so the default-on case was invisible. On a joined host
  // it must now surface as pending.
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')

  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway' },
      // No `config.backfill` block at all → default-on.
      { name: '@hypaware/claude' },
    ],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.ok(report.clientActions, 'the default-on target is surfaced')
  const m = byKey(report.clientActions.actions)
  assert.equal(m.get('@hypaware/claude')?.state, 'pending')
  assert.equal(m.get('@hypaware/claude')?.kind, 'backfill')
  // ai-gateway is enabled but is not a backfill provider: it must not appear.
  assert.equal(m.has('@hypaware/ai-gateway'), false)
})

test('a default-on client on a NON-joined host keeps the V1 surface (no spurious action)', async () => {
  // The reconciler never runs on a non-joined host, so a bare local claude
  // install must not grow a new status line.
  const hypHome = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.clientActions, null)
})

test('a failed backfill does not flip overall to degraded', async () => {
  const hypHome = await makeHome()

  // Minimal, otherwise-healthy config (gateway only: no client advisories)
  // so the only notable state is the failed action marker.
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')
  await writeMarkers(hypHome, {
    backfill: {
      '@hypaware/codex': { status: 'failed', request_key: '@hypaware/codex', reason: 'boom', last_attempt: '2026-06-25T01:00:00.000Z', attempts: 3 },
    },
  })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.overall, 'healthy')
  assert.ok(report.clientActions)
  assert.equal(report.clientActions?.actions[0]?.state, 'failed')
  // The failure is its own section, never a diagnostic.
  assert.ok(!report.diagnostics.some((d) => d.message.includes('boom')))
})

test('an ordinary host with no markers reports clientActions null (V1 surface unchanged)', async () => {
  const hypHome = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.clientActions, null)

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  assert.equal(json.client_actions, null)

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  assert.doesNotMatch(stdout.text(), /client actions:/)
})

test('JSON renderer emits a stable client_actions block', async () => {
  const hypHome = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')
  await writeMarkers(hypHome, {
    backfill: {
      '@hypaware/claude': { status: 'done', request_key: '@hypaware/claude', rows: 42, at: '2026-06-25T00:00:00.000Z' },
      '@hypaware/codex': { status: 'failed', request_key: '@hypaware/codex', reason: 'nope', last_attempt: '2026-06-25T02:00:00.000Z', attempts: 1 },
    },
  })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })

  assert.ok(Array.isArray(json.client_actions))
  const rows = /** @type {any[]} */ (json.client_actions)
  const claude = rows.find((r) => r.request_key === '@hypaware/claude')
  const codex = rows.find((r) => r.request_key === '@hypaware/codex')
  assert.deepEqual(claude, { kind: 'backfill', request_key: '@hypaware/claude', state: 'done', rows: 42, at: '2026-06-25T00:00:00.000Z' })
  assert.deepEqual(codex, { kind: 'backfill', request_key: '@hypaware/codex', state: 'failed', reason: 'nope', last_attempt: '2026-06-25T02:00:00.000Z', attempts: 1 })
})

test('text renderer prints the client actions section with per-state detail', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude', config: { backfill: { on_join: true } } },
      { name: '@hypaware/codex', config: { backfill: { on_join: false } } },
    ],
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  await writeMarkers(hypHome, {
    backfill: {
      '@acme/done-plugin': { status: 'done', request_key: '@acme/done-plugin', rows: 7, at: '2026-06-25T00:00:00.000Z' },
      '@acme/failed-plugin': { status: 'failed', request_key: '@acme/failed-plugin', reason: 'transcript dir missing', last_attempt: '2026-06-25T01:00:00.000Z', attempts: 2 },
    },
  })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()

  assert.match(text, /client actions:/)
  assert.match(text, /backfill @acme\/done-plugin\s+\[done\]\s+\(7 rows, at 2026-06-25T00:00:00\.000Z\)/)
  assert.match(text, /backfill @acme\/failed-plugin\s+\[failed\]\s+\(transcript dir missing, last attempt 2026-06-25T01:00:00\.000Z, 2 attempts\)/)
  assert.match(text, /backfill @hypaware\/claude\s+\[pending\]/)
  assert.match(text, /backfill @hypaware\/codex\s+\[n\/a\]/)
})

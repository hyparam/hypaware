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
 * @import { ClientActionReport } from '../../src/core/daemon/types.d.ts'
 */

// T6 — the client-action reconciler status surface (LLP 0036 / 0041). The
// collector reads the marker file (it never runs a pass) and derives a
// per-provider done/failed/pending/n-a section; a failed action is loud but
// never flips `overall` to `degraded`.
// @ref LLP 0041#failure-is-surfaced-not-fatal [tests]

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
  // plugins — claude (on_join true → pending until a pass runs) and codex
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
  assert.equal(m.get('@hypaware/codex')?.state, 'n/a') // backfill on_join:false → suppressed

  // The backfill rows are namespaced under the backfill handler kind, keyed by
  // owning-plugin name; the only other kind present is `attach` (T9 — the
  // joined claude/codex client adapters are default-on attach targets with no
  // marker, so they surface `pending`, keyed by *client* name).
  const backfillRows = report.clientActions.actions.filter((a) => a.kind === 'backfill')
  assert.ok(backfillRows.length >= 4) // done, failed, claude, codex
  assert.ok(report.clientActions.actions.every((a) => a.kind === 'backfill' || a.kind === 'attach'))
  const attach = new Map(
    report.clientActions.actions.filter((a) => a.kind === 'attach').map((a) => [a.requestKey, a])
  )
  assert.equal(attach.get('claude')?.state, 'pending')
  assert.equal(attach.get('codex')?.state, 'pending') // no `attach` block → default-on
})

test('a malformed on_join block renders n/a (not pending) on a joined host', async () => {
  // Regression (round-2): a *present but malformed* `on_join` (the JSON typo
  // `on_join: "false"`) is an opt-out, exactly as `backfillHandler.desired()`
  // reads it — so the reconciler never writes a marker and the honest state is
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
  // ai-gateway is enabled but is not a backfill provider — it must not appear.
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

  // Minimal, otherwise-healthy config (gateway only — no client advisories)
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

// T9 — the declared-attach-targets derivation (LLP 0044 / 0045), symmetric to
// backfill but keyed by *client* name (the attach handler's request key). Status
// reads the marker file and never runs a pass; a failed/pending attach is loud
// but never flips `overall` to `degraded`.
// @ref LLP 0044#status-surface [tests]

/** @param {ClientActionReport[]} actions */
function attachByKey(actions) {
  /** @type {Map<string, ClientActionReport>} */
  const m = new Map()
  for (const a of actions) if (a.kind === 'attach') m.set(a.requestKey, a)
  return m
}

test('attach declared targets read mixed done/failed/pending/n-a cleanly (T9)', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')

  // Joined host: central enables the gateway plus both client adapters. claude
  // is default-on (no `attach` block) → pending until a pass runs; codex opts
  // out (`attach.on_join: false`) → n/a.
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude' },
      { name: '@hypaware/codex', config: { attach: { on_join: false } } },
    ],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')

  // Attach markers from a prior pass, keyed by CLIENT name (the attach handler's
  // request key). A done (= attached) and a failed entry, even for a client
  // whose descriptor is not in the catalog — markers surface regardless.
  await writeMarkers(hypHome, {
    attach: {
      'acme-done': { status: 'done', request_key: 'acme-done', at: '2026-06-25T00:00:00.000Z' },
      'acme-failed': { status: 'failed', request_key: 'acme-failed', reason: 'settings not writable', last_attempt: '2026-06-25T01:00:00.000Z', attempts: 2 },
    },
  })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.ok(report.clientActions, 'clientActions populated')
  const attach = attachByKey(report.clientActions.actions)

  assert.equal(attach.get('acme-done')?.state, 'done')
  assert.equal(attach.get('acme-done')?.at, '2026-06-25T00:00:00.000Z')
  assert.equal(attach.get('acme-failed')?.state, 'failed')
  assert.equal(attach.get('acme-failed')?.reason, 'settings not writable')
  assert.equal(attach.get('acme-failed')?.attempts, 2)
  assert.equal(attach.get('claude')?.state, 'pending') // default-on, no marker
  assert.equal(attach.get('codex')?.state, 'n/a')       // attach.on_join:false → suppressed

  // The generic done/failed/pending/n-a rendering also reaches the text surface.
  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()
  assert.match(text, /attach acme-done\s+\[done\]/)
  assert.match(text, /attach claude\s+\[pending\]/)
  assert.match(text, /attach codex\s+\[n\/a\]/)
})

test('attach renders n/a for on_join:false and for a non-joined explicit target; bare local stays V1 (T9)', async () => {
  // (a) joined host, explicit opt-out → n/a.
  const home1 = await makeHome()
  const seed1 = centralSeedPath(path.join(home1, 'hypaware'))
  await fs.mkdir(path.dirname(seed1), { recursive: true })
  await fs.writeFile(seed1, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude', config: { attach: { on_join: false } } },
    ],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }) + '\n')
  await fs.writeFile(defaultConfigPath(home1), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  const r1 = await collectHypAwareStatus({ env: env(home1) })
  assert.equal(attachByKey(r1.clientActions?.actions ?? []).get('claude')?.state, 'n/a')

  // (b) non-joined host, *explicit* attach block → n/a: the reconciler never
  // runs off a joined host, so even an opted-in target is inert.
  const home2 = await makeHome()
  await fs.writeFile(defaultConfigPath(home2), JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude', config: { attach: { on_join: true } } },
    ],
  }) + '\n')
  const r2 = await collectHypAwareStatus({ env: env(home2) })
  assert.equal(attachByKey(r2.clientActions?.actions ?? []).get('claude')?.state, 'n/a')

  // (c) non-joined host, NO attach block → V1 surface unchanged (no attach row).
  const home3 = await makeHome()
  await fs.writeFile(defaultConfigPath(home3), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
  }) + '\n')
  const r3 = await collectHypAwareStatus({ env: env(home3) })
  assert.equal(attachByKey(r3.clientActions?.actions ?? []).size, 0)
})

test('a failed attach does not flip overall to degraded (T9)', async () => {
  const hypHome = await makeHome()
  // Minimal otherwise-healthy config (gateway only) so the only notable state
  // is the failed attach marker.
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')
  await writeMarkers(hypHome, {
    attach: {
      claude: { status: 'failed', request_key: 'claude', reason: 'boom', last_attempt: '2026-06-25T01:00:00.000Z', attempts: 3 },
    },
  })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.overall, 'healthy')
  assert.ok(report.clientActions)
  assert.equal(attachByKey(report.clientActions?.actions ?? []).get('claude')?.state, 'failed')
  // The failure is its own section, never a degrading diagnostic.
  assert.ok(!report.diagnostics.some((d) => d.message.includes('boom')))
})

test('a done attach marker renders attached and collapses with the declared target — no double row (T9)', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude' },
    ],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')

  // claude is a declared (default-on) attach target AND has a done marker keyed
  // by client name. The two must collapse into a single `done` row — proving the
  // declared-target key matches the handler's request key (the client name), so
  // the marker is not double-counted as both done and pending.
  await writeMarkers(hypHome, {
    attach: {
      claude: { status: 'done', request_key: 'claude', at: '2026-06-25T00:00:00.000Z' },
    },
  })

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  const claudeRows = (report.clientActions?.actions ?? [])
    .filter((a) => a.kind === 'attach' && a.requestKey === 'claude')
  assert.equal(claudeRows.length, 1, 'exactly one attach row for claude (no done+pending double)')
  assert.equal(claudeRows[0]?.state, 'done')
  assert.equal(claudeRows[0]?.at, '2026-06-25T00:00:00.000Z')
})

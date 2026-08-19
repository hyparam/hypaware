// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { renderStatusJson, renderStatusText } from '../../src/core/commands/status.js'

/**
 * @import { ClientActionReport } from '../../src/core/daemon/types.js'
 */

// A probe-less client (`contributes.client` with no `attach_probe`:
// claude-desktop per LLP 0115 #no-attach-on-join, the only one shipping today)
// is never named by the attach reconciler's `desired()`, so no marker is ever
// written for it. Status must derive by that same rule or it reports two states
// that can never resolve: a permanent `pending` attach action and a
// `not attached` client row (#544).
// @ref LLP 0229#decision [tests]: attach-on-join stays inert for a probe-less client, and status says so
// @ref LLP 0229#diagnostic-is-out-of-scope [tests]: the gate stops at attach state, so the incomplete-setup prompt still fires

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-probeless-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
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

/** @param {ClientActionReport[]} actions */
function attachByKey(actions) {
  /** @type {Map<string, ClientActionReport>} */
  const m = new Map()
  for (const a of actions) if (a.kind === 'attach') m.set(a.requestKey, a)
  return m
}

/**
 * A joined host whose central layer enables the probe-less client adapter
 * (claude-desktop) and two probed ones: claude, whose probe format is `json`,
 * and openclaw, whose `json_path` probe returned with LLP 0169. No attach
 * markers yet. The probed clients are the over-suppression guards: whatever
 * gates claude-desktop must leave their pending / `not attached` /
 * `client_attach_missing` trio intact. openclaw earns its place twice over,
 * since it is the client that crossed this gate in the other direction.
 *
 * @param {string} hypHome
 */
async function joinedWithDesktop(hypHome) {
  const stateRoot = path.join(hypHome, 'hypaware')
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude-desktop' },
      { name: '@hypaware/claude' },
      { name: '@hypaware/openclaw' },
    ],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  // A home with no client settings files at all: nothing carries a marker, so
  // the probed clients are genuinely unattached and the probe-less one has
  // nothing that could ever carry one.
  const homeDir = path.join(hypHome, 'home')
  await fs.mkdir(homeDir, { recursive: true })
  return await collectHypAwareStatus({ env: env(hypHome), homeDir })
}

test('a probe-less client on a joined host renders attach n/a, never a permanent pending (#544)', async () => {
  const hypHome = await makeHome()
  const report = await joinedWithDesktop(hypHome)

  const attach = attachByKey(report.clientActions?.actions ?? [])
  // The reconciler's `desired()` skips a probe-less descriptor, so `perform()`
  // never runs and no marker is ever written: `pending` would be permanent.
  assert.equal(attach.get('claude-desktop')?.state, 'n/a')
  // Over-suppression guards: a probed client with no marker is still pending.
  assert.equal(attach.get('claude')?.state, 'pending')
  assert.equal(attach.get('openclaw')?.state, 'pending')

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()
  assert.match(text, /attach claude-desktop\s+\[n\/a\]/)
  assert.match(text, /attach claude\s+\[pending\]/)
  assert.match(text, /attach openclaw\s+\[pending\]/)
})

test('the gate stops at attach state: client_attach_missing still fires for a probe-less client (#544)', async () => {
  const hypHome = await makeHome()
  const report = await joinedWithDesktop(hypHome)

  const missing = report.diagnostics.filter((d) => d.kind === 'client_attach_missing')
  // Probe-less is still NOT what gates this prompt. What gates it now is
  // RETIREMENT, which is a different property: claude-desktop happens to be
  // both, so it is the wrong witness for "probe-less still warns" and is
  // excluded here rather than asserted (LLP 0296#status-surface). The
  // exception #544 pinned survives for any probe-less client with a live
  // route; if one is ever added, assert it here.
  assert.equal(
    missing.some((d) => d.message.includes('claude-desktop')),
    false,
    'a retired client is skipped by the incomplete-setup prompt entirely'
  )
  // The probed clients are unaffected in the other direction.
  assert.ok(missing.some((d) => d.message.includes("'@hypaware/claude'")))
  assert.ok(missing.some((d) => d.message.includes("'@hypaware/openclaw'")))
})

test('a probe-less client row reads attach n/a, not "not attached" (#544)', async () => {
  const hypHome = await makeHome()
  const report = await joinedWithDesktop(hypHome)

  const desktop = report.clients.find((c) => c.name === 'claude-desktop')
  assert.ok(desktop, 'expected a claude-desktop client row')
  assert.equal(desktop.configured, true)
  assert.equal(desktop.attachable, false)

  for (const name of ['claude', 'openclaw']) {
    const probed = report.clients.find((c) => c.name === name)
    assert.ok(probed, `expected a ${name} client row`)
    assert.equal(probed.attachable, true)
    assert.equal(probed.attached, false)
  }

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()
  assert.match(text, /- claude-desktop {2}\[configured, attach n\/a\]/)
  assert.match(text, /- claude {2}\[configured, not attached\]/)
  assert.match(text, /- openclaw {2}\[configured, not attached\]/)

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  const rows = /** @type {any[]} */ (json.client_attach)
  assert.equal(rows.find((r) => r.name === 'claude-desktop')?.attachable, false)
  assert.equal(rows.find((r) => r.name === 'claude')?.attachable, true)
  assert.equal(rows.find((r) => r.name === 'openclaw')?.attachable, true)
  // `attached` keeps its type and its place for every row, so a consumer
  // pinning it does not break on the new key beside it.
  assert.equal(rows.find((r) => r.name === 'claude-desktop')?.attached, false)
})

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

// A probe-less client (`contributes.client` with no `attach_probe`: openclaw
// per LLP 0143, claude-desktop per LLP 0115) is never named by the attach
// reconciler's `desired()`, so no marker is ever written for it. Status must
// derive by that same rule or it reports three states that can never resolve:
// a permanent `pending` attach action, a `not attached` client row, and an
// inert `client_attach_missing` repair (#544).
// @ref LLP 0143#decision [tests]: attach-on-join stays inert for a probe-less client, and status says so

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
 * A joined host whose central layer enables both a probe-less client adapter
 * (openclaw) and a probed one (claude), with no attach markers yet. The probed
 * client is the over-suppression guard: whatever gates openclaw must leave
 * claude's pending/`not attached`/`client_attach_missing` trio intact.
 *
 * @param {string} hypHome
 */
async function joinedWithOpenClaw(hypHome) {
  const stateRoot = path.join(hypHome, 'hypaware')
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/central' },
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/openclaw' },
      { name: '@hypaware/claude' },
    ],
    sinks: { central: { plugin: '@hypaware/central', config: {} } },
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  // A home with no client settings files at all: nothing carries a marker, so
  // the probed client is genuinely unattached and the probe-less one has
  // nothing that could ever carry one.
  const homeDir = path.join(hypHome, 'home')
  await fs.mkdir(homeDir, { recursive: true })
  return await collectHypAwareStatus({ env: env(hypHome), homeDir })
}

test('a probe-less client on a joined host renders attach n/a, never a permanent pending (#544)', async () => {
  const hypHome = await makeHome()
  const report = await joinedWithOpenClaw(hypHome)

  const attach = attachByKey(report.clientActions?.actions ?? [])
  // The reconciler's `desired()` skips a probe-less descriptor, so `perform()`
  // never runs and no marker is ever written: `pending` would be permanent.
  assert.equal(attach.get('openclaw')?.state, 'n/a')
  // Over-suppression guard: a probed client with no marker is still pending.
  assert.equal(attach.get('claude')?.state, 'pending')

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()
  assert.match(text, /attach openclaw\s+\[n\/a\]/)
  assert.match(text, /attach claude\s+\[pending\]/)
})

test('a probe-less client raises no client_attach_missing, the probed one still does (#544)', async () => {
  const hypHome = await makeHome()
  const report = await joinedWithOpenClaw(hypHome)

  const missing = report.diagnostics.filter((d) => d.kind === 'client_attach_missing')
  // The printed repair (`hyp attach --client openclaw`) resolves the adapter's
  // deliberate LLP 0143 no-op and writes no marker, so it clears nothing.
  assert.ok(
    !missing.some((d) => d.message.includes('openclaw')),
    `expected no client_attach_missing for openclaw, got: ${missing.map((d) => d.message).join(' | ')}`
  )
  // Over-suppression guard: the probed client's attach really is missing.
  assert.ok(missing.some((d) => d.message.includes('claude')))
})

test('a probe-less client row reads attach n/a, not "not attached" (#544)', async () => {
  const hypHome = await makeHome()
  const report = await joinedWithOpenClaw(hypHome)

  const openclaw = report.clients.find((c) => c.name === 'openclaw')
  assert.ok(openclaw, 'expected an openclaw client row')
  assert.equal(openclaw.configured, true)
  assert.equal(openclaw.attachable, false)

  const claude = report.clients.find((c) => c.name === 'claude')
  assert.ok(claude, 'expected a claude client row')
  assert.equal(claude.attachable, true)
  assert.equal(claude.attached, false)

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()
  assert.match(text, /- openclaw {2}\[configured, attach n\/a\]/)
  assert.match(text, /- claude {2}\[configured, not attached\]/)

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  const rows = /** @type {any[]} */ (json.client_attach)
  assert.equal(rows.find((r) => r.name === 'openclaw')?.attachable, false)
  assert.equal(rows.find((r) => r.name === 'claude')?.attachable, true)
})

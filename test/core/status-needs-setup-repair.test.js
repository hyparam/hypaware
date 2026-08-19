// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

// The status surface for a RETIRED client (LLP 0295). This file used to pin
// the opposite: `client_attach_missing` firing for claude-desktop with its
// `configure_command` as the repair, which was the one place a declined
// Desktop setup got pointed at its finish command (LLP 0224 #repair-surface).
//
// With the route withdrawn that prompt became a permanent lie. A retired
// client is `configured && !attached` forever, so it fired on every
// `hyp status` for every machine that ever configured Desktop, said
// "settings show no HypAware marker" - now the DESIRED state - and named a
// repair that writes no marker and so never cleared itself.
//
// What replaces it is residue-gated: warn only while a file an older release
// left behind is still on disk, because that is the one condition the user
// can act on and the repair genuinely clears.
//
// @ref LLP 0295#status-surface [tests]: a retired client reports removable residue, never incomplete setup
// @ref LLP 0139#repair-must-be-runnable [tests]: the repair printed is a command that runs

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-needs-setup-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

/** The converging state an old Desktop install leaves in the config. */
async function writeOldDesktopConfig(hypHome) {
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude-account', config: { mode: 'subscription' } },
      { name: '@hypaware/claude-desktop' },
    ],
  }) + '\n')
}

test('a retired client never fires the incomplete-setup prompt, however it is configured', async () => {
  const hypHome = await makeHome()
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-needs-setup-home-'))
  await writeOldDesktopConfig(hypHome)

  const report = await collectHypAwareStatus({
    env: env(hypHome),
    homeDir,
    residueExists: async () => false,
  })

  // The prompt this file used to require. It must not come back: there is no
  // setup left to finish, so it could never be cleared by the user.
  assert.equal(
    report.diagnostics.some((d) => d.kind === 'client_attach_missing' && /claude-desktop/.test(d.message)),
    false,
    JSON.stringify(report.diagnostics, null, 2)
  )
  assert.equal(
    report.diagnostics.some((d) => d.kind === 'client_capture_residue'),
    false,
    'with no residue on disk a retired client is silent'
  )
})

test('a retired client with its old managed plist still installed warns, with a repair that clears it', async () => {
  const hypHome = await makeHome()
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-needs-setup-home-'))
  await writeOldDesktopConfig(hypHome)

  /** @type {string[]} */
  const probed = []
  const report = await collectHypAwareStatus({
    env: env(hypHome),
    homeDir,
    residueExists: async (residuePath) => {
      probed.push(residuePath)
      return true
    },
  })

  // The probe reads the path the plugin manifest declares, not a core table.
  assert.deepEqual(probed, ['/Library/Managed Preferences/com.anthropic.claudefordesktop.plist'])

  const found = report.diagnostics.find((d) => d.kind === 'client_capture_residue')
  assert.ok(found, JSON.stringify(report.diagnostics, null, 2))
  assert.equal(found.severity, 'warning')
  // The repair must be a command that runs. The plugin registers no runtime
  // adapter, so the generic `hyp client attach` would answer `unknown client`.
  assert.deepEqual(found.repair, ['hyp client claude-desktop disable'])
  assert.match(found.message, /still installed and still affects the app/)
})

test('with claude-desktop not in the config, an identical plist is not claimed as our residue', async () => {
  const hypHome = await makeHome()
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-needs-setup-home-'))
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')

  // The gate is not tidiness. LLP 0133 #one-surface put solo and fleet on
  // the SAME managed-preferences path: an MDM push and HypAware's own sudo
  // write are indistinguishable by the file alone. Warning here would tell
  // someone whose IT department manages that profile to delete it. Plugin-
  // in-config is the available evidence that HypAware is the placer.
  const report = await collectHypAwareStatus({
    env: env(hypHome),
    homeDir,
    residueExists: async () => true,
  })

  assert.equal(
    report.diagnostics.some((d) => d.kind === 'client_capture_residue'),
    false,
    JSON.stringify(report.diagnostics, null, 2)
  )
})

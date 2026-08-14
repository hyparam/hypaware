// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

// The incomplete-setup surface for a `needs_setup` picker row: the wizard's
// configure phase deliberately never re-offers a carried row (LLP 0224
// #ask-once-per-pick), so `hyp status`'s `client_attach_missing` diagnostic -
// whose repair names the row's own `configure_command` rather than the inert
// generic attach - is the one place a declined or failed Desktop setup is
// pointed at its finish command. These tests pin that surface so the claim
// the skip rests on cannot silently rot.
// @ref LLP 0224#repair-surface [tests]: an enabled, unattached needs_setup client warns with its configure_command as the repair
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

test('an enabled claude-desktop with no attach marker warns, naming hyp claude-desktop install', async () => {
  const hypHome = await makeHome()
  // The exact converging state a declined setup leaves behind (LLP 0139
  // Consequences): the composed plugins stay in the config, with no plist
  // and no credential on disk.
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-needs-setup-home-'))
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude-account', config: { mode: 'subscription' } },
      { name: '@hypaware/claude-desktop' },
    ],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome), homeDir })

  const found = report.diagnostics.find(
    (d) => d.kind === 'client_attach_missing' && /claude-desktop/.test(d.message)
  )
  assert.ok(found, JSON.stringify(report.diagnostics, null, 2))
  assert.equal(found.severity, 'warning')
  // The repair is the row's own configure_command, not `hyp attach`: the
  // plugin registers no runtime adapter, so the generic repair would answer
  // `unknown client`.
  assert.deepEqual(found.repair, ['hyp claude-desktop install'])
  assert.match(found.message, /run 'hyp claude-desktop install'/)
})

test('with claude-desktop not in the config, no such warning fires', async () => {
  const hypHome = await makeHome()
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-needs-setup-home-'))
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome), homeDir })

  assert.equal(
    report.diagnostics.some((d) => d.kind === 'client_attach_missing' && /claude-desktop/.test(d.message)),
    false
  )
})

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

// LLP 0358 removes Desktop's needs-setup contract. Its configured state means
// the scheduled transcript lane is enabled, so status must not diagnose the
// deliberately absent attach marker as a capture failure.

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-needs-setup-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

test('an enabled claude-desktop with no attach marker emits no attach-missing warning', async () => {
  const hypHome = await makeHome()
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-needs-setup-home-'))
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude' },
      { name: '@hypaware/claude-desktop' },
    ],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome), homeDir })

  assert.equal(
    report.diagnostics.some((d) => d.kind === 'client_attach_missing' && /claude-desktop/.test(d.message)),
    false,
    JSON.stringify(report.diagnostics, null, 2)
  )
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

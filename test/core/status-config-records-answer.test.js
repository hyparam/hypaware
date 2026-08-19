// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'

// `configRecordsAnswer` is the claim the returning gate reads: does anything
// on this machine record an answer to onboarding's pick question, or does the
// config file merely exist because a side-channel writer created it? The pick
// lane has keyed on that since LLP 0277; the report carries it so the gate can
// key on it too (LLP 0281 #returning-gate).
// @ref LLP 0281#returning-gate [tests]:

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-answer-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

// The exact file `hyp remote add` leaves behind before the first `hyp init`:
// the documented team onboarding order (LLP 0033 / LLP 0277 §context).
test('a remote-add-only config exists and validates, and records no pick answer', async () => {
  const hypHome = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    query: { remotes: { team: { url: 'https://example.invalid' } } },
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.configExists, true, 'the file is there')
  assert.equal(report.configValid, true, 'and it validates')
  assert.equal(report.configRecordsAnswer, false, 'but nobody answered the pick question')
})

test('a composed config records a pick answer', async () => {
  const hypHome = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.configRecordsAnswer, true)
})

// An emptied install cannot be told from a deliberate record-nothing pick, and
// re-opening onboarding's questions on it would re-consent on the user's
// behalf (LLP 0277 #answer-less, LLP 0183).
test('an empty plugins array is still an answer', async () => {
  const hypHome = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.configRecordsAnswer, true)
})

test('no config at all records no answer', async () => {
  const hypHome = await makeHome()
  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.configExists, false)
  assert.equal(report.configRecordsAnswer, false)
})

// Read off the *effective* config, not the local layer: a machine carried
// entirely by its central layer is set up, the fleet having answered on its
// behalf, so the gate must still front the summary there.
test('a central layer answers for a machine whose local layer does not', async () => {
  const hypHome = await makeHome()
  const stateRoot = path.join(hypHome, 'hypaware')
  const seedPath = centralSeedPath(stateRoot)
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/central' }, { name: '@hypaware/ai-gateway' }],
  }) + '\n')
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    query: { remotes: { team: { url: 'https://example.invalid' } } },
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.layered?.hasCentral, true)
  assert.equal(report.configRecordsAnswer, true)
})

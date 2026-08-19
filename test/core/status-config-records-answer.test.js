// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { centralSeedPath } from '../../src/core/config/apply.js'

/**
 * @import { HypAwareV2Config } from '../../hypaware-plugin-kernel-types.js'
 */

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

/**
 * The central layer as `hyp join` / the enrolling `hyp remote login` write it.
 *
 * @param {string} hypHome
 * @param {HypAwareV2Config} seed
 */
async function writeCentralSeed(hypHome, seed) {
  const seedPath = centralSeedPath(path.join(hypHome, 'hypaware'))
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify(seed) + '\n')
}

// A central layer *carrying capture* is the fleet answering on the machine's
// behalf, so the gate must still front the summary there.
test('a central layer answers for a machine whose local layer does not', async () => {
  const hypHome = await makeHome()
  await writeCentralSeed(hypHome, {
    version: 2,
    plugins: [{ name: '@hypaware/central' }, { name: '@hypaware/ai-gateway' }],
  })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    query: { remotes: { team: { url: 'https://example.invalid' } } },
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.layered?.hasCentral, true)
  assert.equal(report.configRecordsAnswer, true)
})

// The documented team order in full: `hyp remote add` then an *enrolling*
// `hyp remote login`, which writes the central seed (`enrollCentralSink`)
// before the first `hyp init`. That seed names `@hypaware/central` and the
// central sink so the machine can reach its server; nobody has been asked
// anything. Reading the merged config here would find a `plugins` array and
// call it an answer, leaving the returning gate exactly where LLP 0277
// §consequences found it.
test('an enrolled machine that has not run init yet records no pick answer', async () => {
  const hypHome = await makeHome()
  await writeCentralSeed(hypHome, {
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    sinks: { central: { plugin: '@hypaware/central', config: { url: 'https://example.invalid', identity: {} } } },
  })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    query: { remotes: { team: { url: 'https://example.invalid' } } },
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.layered?.hasCentral, true, 'enrolled')
  assert.equal(report.configExists, true, 'and configured enough to boot')
  assert.equal(report.configRecordsAnswer, false, 'but the enrollment seed answers nothing')
})

// `mergeConfigLayers` sets `plugins` on the effective config only when the
// merged list is non-empty, so a joined machine's deliberate record-nothing
// pick vanishes from the merge. Read from the local layer it survives, and
// onboarding does not re-open on a deliberately emptied install
// (LLP 0277 #answer-less).
test('an empty plugins array survives beside a central layer that adds none', async () => {
  const hypHome = await makeHome()
  await writeCentralSeed(hypHome, {
    version: 2,
    sinks: { central: { plugin: '@hypaware/central', config: { url: 'https://example.invalid', identity: {} } } },
  })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [],
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.layered?.hasCentral, true)
  assert.equal(report.configRecordsAnswer, true)
})

// The boundary on the central half: "carries capture of its own" is a test for
// a plugin that contributes a picker row, not for "any plugin that is not the
// enrollment seed". A fleet whose central layer also pushes a sink or format
// plugin has still asked nobody anything, and reading that as an answer would
// leave the returning gate fronting "already configured" over a machine that
// records nothing - the exact failure LLP 0281 #returning-gate closes.
test('a central layer carrying only non-capture plugins records no pick answer', async () => {
  const hypHome = await makeHome()
  await writeCentralSeed(hypHome, {
    version: 2,
    plugins: [{ name: '@hypaware/central' }, { name: '@hypaware/local-fs' }, { name: '@hypaware/format-parquet' }],
    sinks: { central: { plugin: '@hypaware/central', config: { url: 'https://example.invalid', identity: {} } } },
  })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    query: { remotes: { team: { url: 'https://example.invalid' } } },
  }) + '\n')

  const report = await collectHypAwareStatus({ env: env(hypHome) })
  assert.equal(report.layered?.hasCentral, true, 'enrolled')
  assert.equal(report.configExists, true, 'and configured enough to boot')
  assert.equal(report.configRecordsAnswer, false, 'but a sink plugin answers no pick question')
})

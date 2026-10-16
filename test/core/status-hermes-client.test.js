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

/** @import { TestContext } from 'node:test' */

// The Hermes plugin's `contributes.client` descriptor (its skill_dir, so the
// neutral skills install under `~/.hermes/skills`) makes hermes a client in
// `hyp status` for the first time. These pin the whole delta, measured before
// and after the descriptor landed, so a later change to it is a decision and
// not an accident. Every hermes line before the descriptor was the plugin
// row (and, joined, the syncing line); everything else below is new.
//
// The three joined rows match shapes status already renders: `attach n/a` is
// the probe-less claude-desktop rule (LLP 0229), and the backfill row is the
// default-on backfill every descriptor plugin declares on a joined host, which
// `backfillHandler.desired()` already runs for hermes; before the descriptor
// only its done row showed, never the pending one.
// @ref LLP 0494#skills [tests]: the Hermes skill descriptor adds exactly these status rows
// @ref LLP 0229#decision [tests]: a probe-less client reads attach n/a, never a permanent pending

const PLUGINS = [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/hermes' }]

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/**
 * @param {TestContext} t
 * @param {{ joined: boolean }} opts
 */
async function hermesStatus(t, { joined }) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-t12-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateRoot, { recursive: true })
  if (joined) {
    const seedPath = centralSeedPath(stateRoot)
    await fs.mkdir(path.dirname(seedPath), { recursive: true })
    await fs.writeFile(seedPath, JSON.stringify({
      version: 2,
      plugins: [{ name: '@hypaware/central' }, ...PLUGINS],
      sinks: { central: { plugin: '@hypaware/central', config: {} } },
    }) + '\n')
    await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  } else {
    await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: PLUGINS }) + '\n')
  }
  const homeDir = path.join(hypHome, 'home')
  await fs.mkdir(path.join(homeDir, '.hermes'), { recursive: true })
  const report = await collectHypAwareStatus({ env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }, homeDir })
  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  const hermesLines = stdout.text().split('\n').filter((line) => /hermes/i.test(line))
  return { report, json, hermesLines }
}

test('hermes on a joined host gains exactly attach n/a, backfill pending and a client row', async (t) => {
  const { report, json, hermesLines } = await hermesStatus(t, { joined: true })

  assert.deepEqual(hermesLines, [
    '  ! backfill @hypaware/hermes: pending',
    '    - @hypaware/hermes  [central · locked]',
    '    - hermes  [configured, attach n/a]  [central · locked]',
    '    syncing: hermes · raw-anthropic · raw-openai - local-only: (none)',
    '    - attach hermes  [n/a]',
    '    - backfill @hypaware/hermes  [pending]',
  ])

  const actions = (report.clientActions?.actions ?? []).filter((a) => /hermes/.test(a.requestKey))
  assert.deepEqual(actions.map((a) => [a.kind, a.requestKey, a.state]), [
    ['attach', 'hermes', 'n/a'],
    ['backfill', '@hypaware/hermes', 'pending'],
  ])
  // No attach-missing nag: there is no probe, so no marker can ever be owed.
  assert.deepEqual(report.diagnostics.filter((d) => /hermes/i.test(d.message)), [])

  const row = /** @type {any[]} */ (json.client_attach).find((r) => r.name === 'hermes')
  assert.deepEqual(row, {
    name: 'hermes',
    configured: true,
    recording: true,
    attachable: false,
    attached: false,
    provenance: 'central',
  })
})

test('hermes on a local host gains only its client row', async (t) => {
  const { report, json, hermesLines } = await hermesStatus(t, { joined: false })

  assert.deepEqual(hermesLines, [
    '    - @hypaware/hermes',
    '    - hermes  [configured, attach n/a]',
  ])
  assert.deepEqual((report.clientActions?.actions ?? []).filter((a) => /hermes/.test(a.requestKey)), [])
  assert.deepEqual(report.diagnostics.filter((d) => /hermes/i.test(d.message)), [])

  const row = /** @type {any[]} */ (json.client_attach).find((r) => r.name === 'hermes')
  assert.deepEqual(row, {
    name: 'hermes',
    configured: true,
    recording: true,
    attachable: false,
    attached: false,
  })
})

// @ts-check

/**
 * Managed skills and agents that update-time installation will not refresh
 * are named on ordinary and verbose `hyp status`, as information only: the
 * notice moves neither `overall` nor the headline.
 *
 * @ref LLP 0534#notice [tests]
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, describeAssetCoverage } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusSummary, renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { clientAssetStateRoot, writeClientAssetLedger } from '../../src/core/runtime/client_asset_ledger.js'

const NOTICE = /Managed skills\/agents for Codex are outside automatic update coverage; run hyp skills install after package updates/

async function stage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-asset-coverage-'))
  const hypHome = path.join(root, '.hypaware')
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/claude' },
      { name: '@hypaware/codex' },
    ],
  }) + '\n')
  // Claude attached by its settings marker, the same evidence `skills install --attached` reads.
  await fs.mkdir(path.join(root, '.claude'), { recursive: true })
  await fs.writeFile(
    path.join(root, '.claude', 'settings.json'),
    JSON.stringify({ _hypaware: { managed: { env: {}, hooks: [] } } })
  )
  const env = { ...process.env, HOME: root, HYP_HOME: hypHome, HYP_CONFIG: '' }
  /** @param {string[]} clients */
  const record = (clients) => writeClientAssetLedger(clientAssetStateRoot(env, root), clients.flatMap((client) => [
    { kind: /** @type {const} */ ('skill'), name: 'hypaware-query', client, dest: path.join(root, `.${client}`, 'skills', 'hypaware-query') },
    { kind: /** @type {const} */ ('agent'), name: 'hypaware-analyst', client, dest: path.join(root, `.${client}`, 'agents', 'hypaware-analyst.md') },
  ]))
  return { env, record, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

function buf() {
  let value = ''
  return {
    write(/** @type {string} */ chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/** @param {Awaited<ReturnType<typeof collectHypAwareStatus>>} report */
function render(report) {
  const compact = buf()
  renderStatusSummary({ report, stdout: compact })
  const verbose = buf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout: verbose })
  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  return { compact: compact.text(), verbose: verbose.text(), json: JSON.stringify(json) }
}

test('a transcript-mode codex with recorded assets is named once, and the attached claude is not', async () => {
  const s = await stage()
  try {
    const before = await collectHypAwareStatus({ env: s.env })
    await s.record(['claude', 'codex'])
    const report = await collectHypAwareStatus({ env: s.env })
    assert.equal(report.clients.find((c) => c.name === 'claude')?.attached, true)
    assert.equal(report.clients.find((c) => c.name === 'codex')?.attached, false)
    const out = render(report)
    assert.match(out.compact, NOTICE)
    assert.match(out.verbose, NOTICE)
    assert.equal(out.compact.match(/outside automatic update coverage/g)?.length, 1, 'two codex records, one line')
    assert.doesNotMatch(out.compact, /Claude Code[^\n]*outside automatic update coverage/)
    assert.doesNotMatch(out.json, /outside automatic update coverage/)

    // Information only: same verdict, diagnostics and headline as without the ledger.
    assert.equal(report.overall, before.overall)
    assert.deepEqual(report.diagnostics.map((d) => d.kind), before.diagnostics.map((d) => d.kind))
    const firstLine = (/** @type {string} */ text) => text.split('\n')[0]
    assert.equal(firstLine(out.compact), firstLine(render(before).compact))
  } finally {
    await s.cleanup()
  }
})

test('no ledger means no notice, and a ledger naming only attached clients means none', async () => {
  const s = await stage()
  try {
    const none = await collectHypAwareStatus({ env: s.env })
    assert.equal(none.assetCoverage, null)
    assert.doesNotMatch(render(none).compact, /outside automatic update coverage/)

    await s.record(['claude'])
    const covered = await collectHypAwareStatus({ env: s.env })
    assert.equal(covered.assetCoverage, null, 'only attached clients are recorded')
  } finally {
    await s.cleanup()
  }
})

test('the notice dedupes, sorts, labels, and bounds the client list', () => {
  /** @param {string} client */
  const rec = (client) => ({ kind: /** @type {const} */ ('skill'), name: 's', client, dest: `/x/${client}` })
  const labelOf = (/** @type {string} */ name) => name.toUpperCase()
  assert.equal(describeAssetCoverage({ records: [], attached: [], labelOf }), null)
  assert.equal(describeAssetCoverage({ records: [rec('a')], attached: ['a'], labelOf }), null)
  assert.match(
    describeAssetCoverage({ records: ['e', 'b', 'a', 'b', 'd', 'c'].map(rec), attached: ['a'], labelOf }) ?? '',
    /^Managed skills\/agents for B, C, D and 1 more are outside/
  )
})

test('long picker labels are clipped so the remedy survives the line cap in both views', async () => {
  /** @param {string} client */
  const rec = (client) => ({ kind: /** @type {const} */ ('skill'), name: 's', client, dest: `/x/${client}` })
  const remedy = /are outside automatic update coverage; run hyp skills install after package updates\n/
  /** @type {Array<[string[], (name: string) => string]>} */
  const cases = [
    [['a'], (name) => name.repeat(400)],
    [['a', 'b', 'c', 'd'], (name) => name.repeat(400)],
    // A label that sanitizes to nothing falls back to the client name, clipped too.
    [['a'.repeat(400), 'b'.repeat(400), 'c'.repeat(400)], () => '\n'],
    [['\n'], () => '\n'],
  ]
  for (const [clients, labelOf] of cases) {
    const line = describeAssetCoverage({ records: clients.map(rec), attached: [], labelOf })
    assert.ok(line && line.length <= 400, `line is ${line?.length} characters`)
    const s = await stage()
    try {
      const report = await collectHypAwareStatus({ env: s.env })
      report.assetCoverage = line
      const out = render(report)
      assert.match(out.compact, remedy)
      assert.match(out.verbose, remedy)
    } finally {
      await s.cleanup()
    }
  }
})

// @ts-check

/**
 * A detached client is "not recording", not broken: `hyp status` shows it on
 * every surface with a plain attach hint and raises no warning. A client that
 * should be recording but whose settings marker is gone still warns.
 *
 * @ref LLP 0464#status [tests]
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusSummary, renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

async function stage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-detached-'))
  const hypHome = path.join(root, '.hypaware')
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway' },
      // Detached on purpose: settings reverted, switch off.
      { name: '@hypaware/claude', recording: false },
      // Should be recording, but its hooks file was wiped.
      { name: '@hypaware/cursor' },
    ],
  }) + '\n')
  const env = { ...process.env, HOME: root, HYP_HOME: hypHome, HYP_CONFIG: '' }
  return { root, env, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

function buf() {
  let value = ''
  return {
    write(/** @type {string} */ chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

test('a detached client reads not recording on compact, verbose and json status, with no warning', async () => {
  const s = await stage()
  try {
    const report = await collectHypAwareStatus({ env: s.env })
    const claude = report.clients.find((c) => c.name === 'claude')
    assert.equal(claude?.configured, true)
    assert.equal(claude?.recording, false)
    assert.equal(report.diagnostics.some((d) => d.message.includes('claude')), false)

    const compact = buf()
    renderStatusSummary({ report, stdout: compact })
    assert.match(compact.text(), /claude\s+Not recording/)
    assert.match(compact.text(), /To record claude again: hyp client attach claude/)

    const verbose = buf()
    renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout: verbose })
    assert.match(verbose.text(), /- claude {2}\[configured, not recording, not attached\]/)
    assert.match(verbose.text(), /to record it again: hyp client attach claude/)
    assert.doesNotMatch(verbose.text(), /claude settings show no HypAware marker/)

    const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
    const row = /** @type {any} */ (json).client_attach.find((/** @type {any} */ c) => c.name === 'claude')
    assert.equal(row.recording, false)
    assert.equal(/** @type {any} */ (json).diagnostics.some((/** @type {any} */ d) => d.kind === 'client_attach_missing' && d.message.includes('claude')), false)
  } finally {
    await s.cleanup()
  }
})

test('a client that should be recording but lost its settings still warns', async () => {
  const s = await stage()
  try {
    const report = await collectHypAwareStatus({ env: s.env })
    assert.equal(report.clients.find((c) => c.name === 'cursor')?.recording, true)
    const missing = report.diagnostics.filter((d) => d.kind === 'client_attach_missing')
    assert.deepEqual(missing.map((d) => d.repair), [['hyp client attach cursor']])

    const compact = buf()
    renderStatusSummary({ report, stdout: compact })
    assert.match(compact.text(), /cursor\s+Settings missing/)
  } finally {
    await s.cleanup()
  }
})

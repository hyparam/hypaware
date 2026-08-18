// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusText } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/**
 * The attach mode on the text surface. `--json` has carried
 * `client_attach[].mode` since the marker grew one; a machine the LLP 0262
 * migration just moved from `proxy` to `otel` must be readable off the plain
 * `hyp status` too, or the migration's outcome is invisible on the surface a
 * human actually checks. Markers that predate modes keep the bare word.
 *
 * @ref LLP 0262#migration [tests]: hyp status reflects the new attach mode after the migration
 */

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-attach-mode-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return hypHome
}

/** @param {string} hypHome */
function env(hypHome) {
  return { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' }
}

function makeBuf() {
  let value = ''
  return {
    write(/** @type {string} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * A report whose client list these renderer tests own outright, the same
 * move status-client-error.test.js makes: catalog rows for the same names
 * would otherwise shadow the rows under test.
 *
 * @param {string} hypHome
 * @param {Array<Record<string, unknown>>} clients
 */
async function reportWithClients(hypHome, clients) {
  const report = await collectHypAwareStatus({ env: env(hypHome) })
  report.clients = /** @type {any} */ (clients)
  return report
}

test('an attached client renders its marker mode on the text surface', async () => {
  const hypHome = await makeHome()
  const report = await reportWithClients(hypHome, [
    { name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true, mode: 'otel' },
    { name: 'codex', plugin: '@hypaware/codex', configured: true, attached: true, mode: 'base_url' },
  ])

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()

  assert.match(text, /- claude {2}\[configured, attached \(otel\)\]/)
  assert.match(text, /- codex {2}\[configured, attached \(base_url\)\]/)
})

test('a mode-less marker and a detached client keep the bare words', async () => {
  const hypHome = await makeHome()
  const report = await reportWithClients(hypHome, [
    { name: 'claude', plugin: '@hypaware/claude', configured: true, attached: true },
    { name: 'codex', plugin: '@hypaware/codex', configured: true, attached: false },
  ])

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()

  assert.match(text, /- claude {2}\[configured, attached\]/)
  assert.match(text, /- codex {2}\[configured, not attached\]/)
})

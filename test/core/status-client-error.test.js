// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { renderStatusJson, renderStatusFull } from '../../src/core/commands/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

// A client whose attach probe could not resolve its settings file at all
// reports `error` rather than a plain `attached: false`. That distinction is
// only worth anything if the surface a human actually reads carries it: a bare
// "not attached" (or a `(none)` collapse) is the wrong negative indistinguishable
// from a right one all over again.
// @ref LLP 0045#settings_file-is-home-relative-and-a-violation-is-loud [tests]: the probe error reaches the text surface, not only --json

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-client-error-'))
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

const PROBE_ERROR =
  "client 'claude-desktop' declares an absolute settings_file " +
  "'/Library/Managed Preferences/com.anthropic.claudefordesktop.plist'; " +
  "settings_file must be relative to $HOME (e.g. '.codex/config.toml')"

/**
 * A status report for a host that has nothing configured, plus one client
 * whose probe failed to resolve. This is the shape that used to render as a
 * bare `(none)`.
 *
 * The errored row *replaces* any same-named row the bundled catalog produced
 * rather than joining it. Today the catalog does emit a `claude-desktop` row
 * carrying this very error (the manifest defect #445 removes), so appending
 * would leave two rows and a `find` by name would answer from whichever came
 * first - passing for the wrong reason now, and failing the moment #445 lands
 * and the catalog row loses its error. These tests are about the renderers,
 * so they own the whole client list.
 *
 * @param {string} hypHome
 */
async function reportWithProbeError(hypHome) {
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  const report = await collectHypAwareStatus({ env: env(hypHome) })
  report.clients = report.clients.filter((c) => c.name !== 'claude-desktop')
  report.clients.push({
    name: 'claude-desktop',
    plugin: '@hypaware/claude-desktop',
    configured: false,
    attached: false,
    error: PROBE_ERROR,
  })
  return report
}

test('the text renderer prints a client probe error instead of a bare not-attached', async () => {
  const hypHome = await makeHome()
  const report = await reportWithProbeError(hypHome)

  const stdout = makeBuf()
  renderStatusFull({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()

  assert.match(text, /- claude-desktop {2}\[not in config, not attached\]/)
  assert.match(text, /error: client 'claude-desktop' declares an absolute settings_file/)
})

test('a client carrying an error is never collapsed into the clients "(none)" line', async () => {
  const hypHome = await makeHome()
  const report = await reportWithProbeError(hypHome)

  const stdout = makeBuf()
  renderStatusFull({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()

  assert.doesNotMatch(text, /clients:\n {4}\(none\)/)
  assert.match(text, /claude-desktop/)
})

test('an all-clean host keeps the "(none)" clients collapse (surface unchanged)', async () => {
  const hypHome = await makeHome()
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  const report = await collectHypAwareStatus({ env: env(hypHome) })
  // Drop any errored row to get the all-clean shape this assertion is about.
  // On master that is the one bundled client whose settings_file cannot be
  // resolved (the Claude Desktop manifest #445 corrects); once #445 lands there
  // is nothing to drop and the filter is a no-op. Either way the shape under
  // test is "no client carries an error".
  report.clients = report.clients.filter((c) => !c.error)
  assert.ok(report.clients.every((c) => !c.configured))

  const stdout = makeBuf()
  renderStatusFull({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })

  assert.match(stdout.text(), /clients:\n {4}\(none\)/)
})

test('the JSON renderer carries the same client error', async () => {
  const hypHome = await makeHome()
  const report = await reportWithProbeError(hypHome)

  const json = renderStatusJson({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache' })
  const rows = /** @type {any[]} */ (json.client_attach)
  const desktop = rows.find((r) => r.name === 'claude-desktop')
  assert.equal(desktop.attached, false)
  assert.equal(desktop.error, PROBE_ERROR)
})

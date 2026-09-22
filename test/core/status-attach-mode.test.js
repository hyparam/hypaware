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

test('a probe-less client says attach n/a whatever mode its marker claims', async () => {
  const hypHome = await makeHome()
  const report = await reportWithClients(hypHome, [
    {
      name: 'hermes',
      plugin: '@hypaware/hermes',
      configured: true,
      attachable: false,
      attached: true,
      mode: 'otel',
    },
  ])

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })

  assert.match(stdout.text(), /- hermes {2}\[configured, attach n\/a\]/)
})

/**
 * The mode is read back out of the client's own settings file, which a hand
 * edit reaches, so it is a captured label rather than an in-process constant.
 *
 * @ref LLP 0225#one-vocabulary [tests]: a label lifted off disk cannot drive the terminal it is printed to
 */
test('a marker mode carrying terminal control bytes is stripped before it is printed', async () => {
  const hypHome = await makeHome()
  const report = await reportWithClients(hypHome, [
    {
      name: 'claude',
      plugin: '@hypaware/claude',
      configured: true,
      attached: true,
      mode: 'ot\u001b[2Kel\n',
    },
    {
      name: 'codex',
      plugin: '@hypaware/codex',
      configured: true,
      attached: true,
      mode: '\u200b\u200b',
    },
  ])

  const stdout = makeBuf()
  renderStatusText({ report, clientNames: [], datasets: [], cacheRoot: '/tmp/cache', stdout })
  const text = stdout.text()

  assert.ok(!text.includes('\u001b'), 'no escape byte reaches the terminal')
  assert.match(text, /- claude {2}\[configured, attached \(ot\[2Kel\)\]/)
  // A mode that sanitizes away to nothing leaves the bare word rather than an
  // empty parenthesis.
  assert.match(text, /- codex {2}\[configured, attached\]/)
})

/**
 * Codex's `attach_probe` reads the managed `[model_providers.hypaware]` block,
 * and the default `transcript` capture mode *removes* that block rather than
 * writing one. Status must therefore report attach as n/a, not missing: a
 * `client_attach_missing` warning here would stand forever and its repair
 * (`hyp client attach codex`) is a no-op that cannot clear it. That is the
 * wrong-negative LLP 0229 exists to stop.
 *
 * @ref LLP 0429#default [tests]: transcript capture writes no marker
 * @ref LLP 0229#status-derives-by-the-same-gate [tests]: no marker to write means unattachable, not unattached
 */
test('a transcript-mode codex is attach-n/a, and gateway mode still demands its marker', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-codex-mode-'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-codex-home-'))
  try {
    await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
    const baseEnv = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '', HOME: home }

    /** @param {Record<string, unknown>} codexConfig */
    const collect = async (codexConfig) => {
      await fs.writeFile(
        defaultConfigPath(hypHome),
        JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/codex', config: codexConfig }] }) + '\n'
      )
      const report = await collectHypAwareStatus({ env: baseEnv })
      return {
        row: report.clients.find((c) => c.name === 'codex'),
        missing: report.diagnostics.filter(
          (d) => d.kind === 'client_attach_missing' && d.message.includes('codex')
        ),
      }
    }

    const transcript = await collect({})
    assert.ok(transcript.row, 'codex is still listed as a client')
    assert.equal(transcript.row?.attachable, false, 'no marker is written, so attach state is n/a')
    assert.deepEqual(transcript.missing, [], 'no permanent warning whose repair does nothing')

    const gateway = await collect({ capture_mode: 'gateway' })
    assert.equal(gateway.row?.attachable, true, 'gateway mode does write the marker its probe reads')
    assert.equal(gateway.missing.length, 1, 'and an un-run attach is still reported')
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  }
})

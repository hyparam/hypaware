// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runInitWizard } from '../../../../src/core/cli/wizard/index.js'
import { runPickerFinale } from '../../../../src/core/cli/walkthrough.js'

// The joined-upgrade shape (#842): an enrolled machine moving from a
// base-URL version to a proxy-capable one runs `hyp init` through the team
// pathway. Every picked client already carries an attach marker and the
// daemon is already installed, so the finale used to skip both the install
// and the attach and restart at the very end - minting the proxy CA after
// the only chance to attach had passed, and leaving Claude on `base_url`
// with the wizard reporting success.
//
// @ref LLP 0243#composed-default [tests]: a proxy-mode install attaches in proxy mode
// @ref LLP 0244 [tests]: a base-URL attach on a proxy-mode install is unfinished, not done

/** @returns {{ write(chunk: string): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-joined-upgrade-'))
}

/**
 * Write the Claude settings a pre-proxy version left behind: the marker is
 * there, and it names the mode.
 *
 * @param {string} home
 * @param {string} [mode]
 */
async function writeClaudeMarker(home, mode) {
  const dir = path.join(home, '.claude')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4319' },
    _hypaware: {
      version: '1.22.0',
      port: 4319,
      ...(mode ? { mode } : {}),
    },
  }, null, 2))
}

/** A gateway block in proxy mode, the shape LLP 0243's fold composes. */
function proxyModeConfig() {
  return /** @type {any} */ ({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { upstreams: [], proxy_mode: true } },
      { name: '@hypaware/claude', config: {} },
    ],
  })
}

/** The Claude picker row, which is where `gateway_proxy_mode` is declared. */
function claudeRow() {
  return /** @type {any} */ ({
    plugin: '@hypaware/claude',
    id: 'claude',
    label: 'Claude Code',
    compose: { requires_gateway: true, gateway_proxy_mode: true },
  })
}

/**
 * The wizard driven down the team pathway with every phase scripted, so the
 * only thing under test is what the joined finale decides to skip.
 *
 * @param {string} home
 */
function joinedWizardOpts(home) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const opts = /** @type {any} */ ({
    stdout,
    stderr,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_NO_TUI: '1' },
    ctx: /** @type {any} */ ({ commands: { run: async () => 0 } }),
    capabilities: /** @type {any} */ ({ has: () => false }),
    catalog: /** @type {any} */ ({
      plugins: new Map(),
      pluginMetadata: new Map(),
      knownDatasets: new Set(),
      clientDescriptors: new Map(),
      pickerDescriptors: new Map(),
    }),
    finale: {},
    gate: async () => ({ action: 'first-run', managed: false, report: {} }),
    fork: async () => 'team',
    join: async () => ({ status: 'ok', lockedSources: [], managed: true }),
    pick: async () => /** @type {any} */ ({
      exitCode: 0,
      configPath: path.join(home, '.hyp', 'config.json'),
      config: proxyModeConfig(),
      sourcesPicked: ['claude'],
      exportPicked: 'local-parquet',
      clientsPicked: ['claude'],
      retentionDays: 30,
      descriptors: [claudeRow()],
      lockedSources: [],
    }),
    syncScope: async () => ({ optedOut: [] }),
    folderAsk: async () => ({ mode: 'sync' }),
    express: async () => 'choose',
    configure: async () => ({ results: [] }),
    finaleRunner: async (/** @type {any} */ args) => {
      opts._finaleArgs = args
      return {
        daemonInstall: { skipped: true, dryRun: false },
        globalInstall: { skipped: true, installed: false },
        attach: [],
        skillsInstalled: [],
        agentsInstalled: [],
        daemonRestart: { skipped: true, dryRun: false, ok: false },
        backfill: [],
      }
    },
  })
  return { opts, stdout, stderr }
}

test('a joined upgrade does not skip attach for a client still marked base_url', async () => {
  const home = await tmpHome()
  await writeClaudeMarker(home, 'base_url')
  const { opts } = joinedWizardOpts(home)

  await runInitWizard(opts)

  const skipped = opts._finaleArgs?.skipAttachClients
  assert.ok(
    !skipped || !skipped.has('claude'),
    'a base-URL marker on a proxy-mode install is unfinished migration, not a completed attach'
  )
})

// A marker written before modes existed is the same base-URL attach without
// the label, so it must not read as a proxy attach either.
test('a joined upgrade does not skip attach for a marker that records no mode at all', async () => {
  const home = await tmpHome()
  await writeClaudeMarker(home)
  const { opts } = joinedWizardOpts(home)

  await runInitWizard(opts)

  const skipped = opts._finaleArgs?.skipAttachClients
  assert.ok(!skipped || !skipped.has('claude'), 'an unlabelled marker is not evidence of a proxy attach')
})

// The skip still does its job where it always did: enrollment attached this
// client in the mode the install runs, so re-attaching is pure waste.
test('a joined run still skips attach for a client already attached by proxy', async () => {
  const home = await tmpHome()
  await writeClaudeMarker(home, 'proxy')
  const { opts } = joinedWizardOpts(home)

  await runInitWizard(opts)

  const skipped = opts._finaleArgs?.skipAttachClients
  assert.ok(skipped?.has('claude'), 'a proxy marker on a proxy-mode install is the attach already done')
})

// The ordering half of #842: with the install skipped, the restart that puts
// proxy mode (and therefore the CA) on the wire has to happen before attach,
// not after it. It is still exactly one restart.
test('a skipped install restarts the daemon before attach so the proxy CA exists', async () => {
  const home = await tmpHome()
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {string[]} */
  const events = []

  const summary = await runPickerFinale(/** @type {any} */ ({
    finale: { skipDaemonInstall: true, dryRun: false },
    retentionDays: 30,
    interactive: false,
    clientsPicked: ['claude'],
    capabilities: /** @type {any} */ ({
      has: (/** @type {string} */ id) => id === 'hypaware.ai-gateway',
      require: () => ({
        getClient: (/** @type {string} */ name) =>
          name === 'claude' ? { attach: async () => { events.push('attach') } } : undefined,
        localEndpoint: () => 'http://127.0.0.1:4319',
      }),
    }),
    config: proxyModeConfig(),
    configPath: path.join(home, '.hyp', 'config.json'),
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    stdout,
    stderr,
    restartDaemonFn: async () => { events.push('restart') },
    waitForCaFn: async () => {
      events.push('ca-wait')
      return { ready: true, certPath: path.join(home, 'ca-cert.pem') }
    },
  }))

  assert.deepEqual(events, ['restart', 'ca-wait', 'attach'])
  assert.equal(events.filter((e) => e === 'restart').length, 1, 'the restart moved, it did not multiply')
  assert.deepEqual(summary.daemonRestart, { skipped: false, dryRun: false, ok: true })
  assert.equal(stderr.text(), '', 'a ready CA prints no warning')
})

// A base-URL install keeps today's ordering exactly: nothing about proxy
// readiness applies, so the one restart stays at the end of the lane.
test('a skipped install with no proxy mode leaves the restart at the end', async () => {
  const home = await tmpHome()
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {string[]} */
  const events = []

  await runPickerFinale(/** @type {any} */ ({
    finale: { skipDaemonInstall: true, dryRun: false },
    retentionDays: 30,
    interactive: false,
    clientsPicked: ['claude'],
    capabilities: /** @type {any} */ ({
      has: (/** @type {string} */ id) => id === 'hypaware.ai-gateway',
      require: () => ({
        getClient: (/** @type {string} */ name) =>
          name === 'claude' ? { attach: async () => { events.push('attach') } } : undefined,
        localEndpoint: () => 'http://127.0.0.1:4319',
      }),
    }),
    config: /** @type {any} */ ({
      version: 2,
      plugins: [{ name: '@hypaware/ai-gateway', config: { upstreams: [] } }],
    }),
    configPath: path.join(home, '.hyp', 'config.json'),
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    stdout,
    stderr,
    restartDaemonFn: async () => { events.push('restart') },
    waitForCaFn: async () => { throw new Error('must not be called') },
  }))

  assert.deepEqual(events, ['attach', 'restart'])
})

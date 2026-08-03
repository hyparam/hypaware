// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { centralSeedPath } from '../../src/core/config/apply.js'
import { enableClientAdapter } from '../../src/core/config/client_enable.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { waitForGatewayBind } from '../../src/core/cli/remote_commands.js'

/**
 * T8 (LLP 0174/0178): the enable half of the manual-attach prompt. The write is
 * *additive* (the local layer is user-owned, so enabling one adapter must not
 * rewrite the rest of it), duplicate-aware against the **effective** merge (an
 * entry the central layer already names is never re-added locally), and every
 * step reports its own outcome so a partial failure can name what persisted.
 *
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

/** @returns {Promise<{ hypHome: string, configPath: string }>} */
async function stageHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-client-enable-'))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  return { hypHome, configPath: defaultConfigPath(hypHome) }
}

/**
 * @param {string} hypHome
 * @returns {CommandRunContext}
 */
function makeCtx(hypHome) {
  return /** @type {CommandRunContext} */ (/** @type {unknown} */ ({
    env: { HOME: hypHome, HYP_HOME: hypHome },
    cwd: hypHome,
    config: { version: 2 },
    stdout: { write() { return true } },
    stderr: { write() { return true } },
  }))
}

/** The dependency set T6 resolves for a claude enable. */
const CLAUDE_ENTRIES = /** @type {any} */ ([
  { name: '@hypaware/ai-gateway' },
  { name: '@hypaware/claude' },
])

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function backupsIn(dir) {
  const names = await fs.readdir(dir)
  return names.filter((n) => n.includes('.bak-'))
}

/**
 * Seed a live daemon run dir: a pid file for this (guaranteed alive) process
 * plus a status snapshot carrying the gateway's bound port. The liveness gate
 * in `resolveLiveGatewayEndpointFromStatus` is why the pid has to be real.
 *
 * @param {string} hypHome
 * @param {number} port
 * @returns {Promise<void>}
 */
async function seedBoundGateway(hypHome, port) {
  const runDir = path.join(hypHome, 'hypaware', 'run')
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(
    path.join(runDir, 'hypaware.pid'),
    JSON.stringify({ pid: process.pid, runId: 'test-run', mode: 'foreground' })
  )
  await fs.writeFile(
    path.join(runDir, 'status.json'),
    JSON.stringify({
      state: 'healthy',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      uptimeMs: 0,
      runId: 'test-run',
      mode: 'foreground',
      sources: [
        {
          name: 'ai-gateway',
          plugin: '@hypaware/ai-gateway',
          state: 'started',
          details: { host: '127.0.0.1', port },
        },
      ],
      sinks: [],
    })
  )
}

/* ------------------------------- the write ------------------------------- */

test('the enable write is additive: unrelated plugins and keys survive, and the prior config is backed up', async () => {
  const { hypHome, configPath } = await stageHome()
  const before = {
    version: 2,
    plugins: [{ name: '@hypaware/otel', config: { listen: '127.0.0.1:4317' } }],
    sinks: { local: { plugin: '@hypaware/parquet', config: { dir: '/data' } } },
    query: { cache: { dir: '/home/u/.hyp' } },
  }
  const raw = JSON.stringify(before, null, 2) + '\n'
  await fs.writeFile(configPath, raw)

  const result = await enableClientAdapter({
    name: 'claude',
    entries: CLAUDE_ENTRIES,
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: false }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.steps.write, 'ok')
  assert.deepEqual(result.addedPlugins, ['@hypaware/ai-gateway', '@hypaware/claude'])

  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.equal(after.version, 2)
  // Appended, in the order T6 resolved them, behind everything already there.
  assert.deepEqual(after.plugins.map((/** @type {{ name: string }} */ p) => p.name), [
    '@hypaware/otel',
    '@hypaware/ai-gateway',
    '@hypaware/claude',
  ])
  // The untouched half of the file is byte-identical in content, not merely
  // present: an "additive" write that reshaped the user's sinks would be a
  // rewrite wearing an append's clothes.
  assert.deepEqual(after.plugins[0], before.plugins[0])
  assert.deepEqual(after.sinks, before.sinks)
  assert.deepEqual(after.query, before.query)

  const backups = await backupsIn(hypHome)
  assert.equal(backups.length, 1)
  assert.match(backups[0], /hypaware-config\.json\.bak-/)
  assert.equal(result.backupPath, path.join(hypHome, backups[0]))
  assert.equal(await fs.readFile(result.backupPath ?? '', 'utf8'), raw)
})

test('an entry the central layer already names is not duplicated into the local layer', async () => {
  const { hypHome, configPath } = await stageHome()
  const seedPath = centralSeedPath(path.join(hypHome, 'hypaware'))
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:18521' } }],
  }) + '\n')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }, null, 2) + '\n')

  const result = await enableClientAdapter({
    name: 'claude',
    entries: CLAUDE_ENTRIES,
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: false }),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.addedPlugins, ['@hypaware/claude'])
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins.map((/** @type {{ name: string }} */ p) => p.name), ['@hypaware/claude'])
})

test('an entry already in the local layer is not appended a second time', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }, null, 2) + '\n')

  const result = await enableClientAdapter({
    name: 'claude',
    entries: CLAUDE_ENTRIES,
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: false }),
  })

  assert.deepEqual(result.addedPlugins, ['@hypaware/claude'])
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins.map((/** @type {{ name: string }} */ p) => p.name), [
    '@hypaware/ai-gateway',
    '@hypaware/claude',
  ])
})

/* ------------------------- restart and bind wait ------------------------- */

test('with no daemon service installed, restart and the bind wait are both skipped', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }, null, 2) + '\n')
  let restarts = 0
  let waits = 0

  const result = await enableClientAdapter({
    name: 'claude',
    entries: CLAUDE_ENTRIES,
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: false }),
    restartDaemon: async () => { restarts += 1 },
    waitForBind: async () => { waits += 1; return { bound: true } },
  })

  assert.equal(restarts, 0)
  assert.equal(waits, 0)
  assert.equal(result.ok, true)
  assert.equal(result.daemonInstalled, false)
  assert.deepEqual(result.steps, { write: 'ok', restart: 'n/a', wait: 'n/a' })
  assert.equal(result.completed, 'n/a')
  assert.equal(result.failedStep, undefined)
})

test('with a daemon installed, the write is followed by a restart and a wait that sees the bound port', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }, null, 2) + '\n')
  await seedBoundGateway(hypHome, 18999)
  /** @type {number[]} */
  const sleeps = []

  const result = await enableClientAdapter({
    name: 'claude',
    entries: CLAUDE_ENTRIES,
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
    restartDaemon: async () => { sleeps.push(-1) },
    timeoutMs: 200,
    sleep: async (ms) => { sleeps.push(ms) },
  })

  assert.equal(result.ok, true)
  assert.equal(result.daemonInstalled, true)
  assert.deepEqual(result.steps, { write: 'ok', restart: 'ok', wait: 'ok' })
  assert.equal(result.completed, 'wait')
  assert.equal(result.bound, true)
  assert.equal(result.endpoint, 'http://127.0.0.1:18999')
  // Restart first, and the port was already published, so the wait never slept.
  assert.deepEqual(sleeps, [-1])
})

test('a restart failure is reported as the restart step, with the write and its backup intact', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }, null, 2) + '\n')
  let waits = 0

  const result = await enableClientAdapter({
    name: 'claude',
    entries: CLAUDE_ENTRIES,
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
    restartDaemon: async () => { throw new Error('launchctl kickstart failed') },
    waitForBind: async () => { waits += 1; return { bound: true } },
  })

  assert.equal(result.ok, false)
  assert.equal(result.failedStep, 'restart')
  assert.deepEqual(result.steps, { write: 'ok', restart: 'failed', wait: 'n/a' })
  assert.equal(result.completed, 'write')
  assert.equal(result.message, 'launchctl kickstart failed')
  assert.equal(waits, 0, 'the bind wait never runs behind a restart that did not happen')
  // The config change persists: that is what makes a re-run resume.
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins.map((/** @type {{ name: string }} */ p) => p.name), [
    '@hypaware/ai-gateway',
    '@hypaware/claude',
  ])
  assert.match(result.backupPath ?? '', /\.bak-/)
})

test('a gateway that never binds times out into a reported wait failure, not a throw', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }, null, 2) + '\n')
  /** @type {number[]} */
  const sleeps = []

  const result = await enableClientAdapter({
    name: 'claude',
    entries: CLAUDE_ENTRIES,
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
    restartDaemon: async () => {},
    timeoutMs: 30,
    sleep: async (ms) => { sleeps.push(ms); await new Promise((resolve) => setTimeout(resolve, ms)) },
  })

  assert.equal(result.ok, false)
  assert.equal(result.failedStep, 'wait')
  assert.deepEqual(result.steps, { write: 'ok', restart: 'ok', wait: 'failed' })
  assert.equal(result.completed, 'restart')
  assert.equal(result.bound, false)
  assert.ok(sleeps.length > 0, 'the wait polled at least once before giving up')
})

/* --------------------------- waitForGatewayBind --------------------------- */

test('waitForGatewayBind returns as soon as status.json reports a bound port', async () => {
  const { hypHome } = await stageHome()
  await seedBoundGateway(hypHome, 41234)
  /** @type {number[]} */
  const sleeps = []

  const bind = await waitForGatewayBind({
    env: { HOME: hypHome, HYP_HOME: hypHome },
    homeDir: hypHome,
    timeoutMs: 500,
    sleep: async (ms) => { sleeps.push(ms) },
  })

  assert.deepEqual(bind, { bound: true, endpoint: 'http://127.0.0.1:41234' })
  assert.deepEqual(sleeps, [])
})

test('waitForGatewayBind polls until the port appears', async () => {
  const { hypHome } = await stageHome()
  let polls = 0

  const bind = await waitForGatewayBind({
    env: { HOME: hypHome, HYP_HOME: hypHome },
    timeoutMs: 1000,
    intervalMs: 1,
    probe: () => (++polls < 3 ? undefined : 'http://127.0.0.1:7777'),
    sleep: async () => {},
  })

  assert.deepEqual(bind, { bound: true, endpoint: 'http://127.0.0.1:7777' })
  assert.equal(polls, 3)
})

test('waitForGatewayBind returns { bound: false } on timeout instead of throwing', async () => {
  const { hypHome } = await stageHome()
  /** @type {number[]} */
  const sleeps = []

  const bind = await waitForGatewayBind({
    env: { HOME: hypHome, HYP_HOME: hypHome },
    timeoutMs: 25,
    sleep: async (ms) => { sleeps.push(ms); await new Promise((resolve) => setTimeout(resolve, ms)) },
  })

  assert.deepEqual(bind, { bound: false })
  // The sleep is capped at the remaining budget, never the full interval.
  assert.ok(sleeps.every((ms) => ms <= 25))
})

test('waitForGatewayBind treats a throwing probe as "not yet", not as a failure', async () => {
  const { hypHome } = await stageHome()
  let polls = 0

  const bind = await waitForGatewayBind({
    env: { HOME: hypHome, HYP_HOME: hypHome },
    timeoutMs: 1000,
    intervalMs: 1,
    probe: () => {
      polls += 1
      if (polls === 1) throw new Error('status.json half-written')
      return 'http://127.0.0.1:9000'
    },
    sleep: async () => {},
  })

  assert.deepEqual(bind, { bound: true, endpoint: 'http://127.0.0.1:9000' })
})

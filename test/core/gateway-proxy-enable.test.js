// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { centralSeedPath } from '../../src/core/config/apply.js'
import { enableGatewayProxyMode } from '../../src/core/config/gateway_proxy_enable.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { ensureLocalCa } from '../../src/core/tls/ca.js'

/**
 * The LLP 0244 #enable-write shape: `enableGatewayProxyMode` sets one key on
 * the existing local gateway entry (never appends, never rewrites the rest),
 * declines when the gateway block is centrally managed or absent, and after
 * the restart waits for the CA the proxy attach preflights on.
 *
 * LLP 0259 adds one entry state to the same function: `proxy_mode` already
 * on with no CA on disk is a stranded install, not "nothing to do", and its
 * repair is the restart half with the write skipped.
 *
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

/** @returns {Promise<{ hypHome: string, configPath: string }>} */
async function stageHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-gw-proxy-enable-'))
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

const ANTHROPIC = { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' }

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function backupsIn(dir) {
  const names = await fs.readdir(dir)
  return names.filter((n) => n.includes('.bak-'))
}

/* ------------------------------- the write ------------------------------- */

test('sets proxy_mode on the existing gateway entry; everything else survives byte-identical', async () => {
  const { hypHome, configPath } = await stageHome()
  const before = {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { upstreams: [ANTHROPIC] } },
      { name: '@hypaware/otel', config: { listen_port: 4318 } },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
    ],
    sinks: { local: { plugin: '@hypaware/parquet', config: { dir: '/data' } } },
  }
  const raw = JSON.stringify(before, null, 2) + '\n'
  await fs.writeFile(configPath, raw)

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: false }),
  })

  assert.equal(result.ok, true, result.message ?? '')
  assert.equal(result.outcome, 'enabled')
  assert.equal(result.steps.write, 'ok')
  assert.equal(result.daemonInstalled, false)
  assert.deepEqual([result.steps.restart, result.steps.wait, result.steps.ca], ['n/a', 'n/a', 'n/a'])

  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins[0], {
    name: '@hypaware/ai-gateway',
    config: { upstreams: [ANTHROPIC], proxy_mode: true },
  })
  assert.deepEqual(after.plugins[1], before.plugins[1])
  assert.deepEqual(after.plugins[2], before.plugins[2])
  assert.deepEqual(after.sinks, before.sinks)

  const backups = await backupsIn(hypHome)
  assert.equal(backups.length, 1)
  assert.equal(await fs.readFile(result.backupPath ?? '', 'utf8'), raw)
})

test('a bare local gateway entry (no config block) gains one holding only proxy_mode', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }, null, 2) + '\n')

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: false }),
  })

  assert.equal(result.ok, true, result.message ?? '')
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.deepEqual(after.plugins[0], { name: '@hypaware/ai-gateway', config: { proxy_mode: true } })
})

/* ------------------------------ the refusals ----------------------------- */

test('already on in the effective config, with the CA on disk: no write, no backup', async () => {
  const { hypHome, configPath } = await stageHome()
  const raw = JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { proxy_mode: true, upstreams: [ANTHROPIC] } }],
  }, null, 2) + '\n'
  await fs.writeFile(configPath, raw)
  await ensureLocalCa({ stateRoot: path.join(hypHome, 'hypaware'), hosts: ['api.anthropic.com'] })

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => {
      throw new Error('must not reach the daemon: nothing to do')
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'already')
  assert.equal(await fs.readFile(configPath, 'utf8'), raw)
  assert.deepEqual(await backupsIn(hypHome), [])
})

/* ------------------------------- the re-mint ----------------------------- */

// The `hyp detach claude --purge` residue: the CA is gone by design and the
// key stays on, so `already` was answering "nothing to do" about a machine
// that could no longer serve what its config asked for. The repair is the
// restart half of this same function, with the write skipped.
// @ref LLP 0259#repair-is-a-restart [tests]: proxy_mode with no CA restarts and waits, and writes nothing
test('proxy_mode on with no CA: the restart runs, the config is never rewritten', async () => {
  const { hypHome, configPath } = await stageHome()
  const raw = JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { proxy_mode: true, upstreams: [ANTHROPIC] } }],
  }, null, 2) + '\n'
  await fs.writeFile(configPath, raw)
  let restarts = 0

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
    restartDaemon: async () => { restarts += 1 },
    waitForBind: async () => ({ bound: true, endpoint: 'http://127.0.0.1:18521' }),
    waitForCaFn: async () => ({ ready: true, certPath: '/state/tls/ca-cert.pem' }),
  })

  assert.equal(result.ok, true, result.message ?? '')
  assert.equal(result.outcome, 'remint')
  assert.equal(restarts, 1)
  assert.deepEqual(result.steps, { write: 'n/a', restart: 'ok', wait: 'ok', ca: 'ok' })
  assert.equal(result.caReady, true)
  assert.equal(await fs.readFile(configPath, 'utf8'), raw, 'the config is untouched')
  assert.deepEqual(await backupsIn(hypHome), [], 'and no backup copy was made for a write that never happened')
})

// A re-mint writes nothing, so it has nothing for the LLP 0031 merge to drop:
// a fleet host is repaired exactly like a solo one, where the migration's own
// write would have to decline.
// @ref LLP 0259#repair-is-a-restart [tests]: central ownership does not block a repair that touches no config
test('a centrally-managed gateway is still re-minted: no write to collide', async () => {
  const { hypHome, configPath } = await stageHome()
  const seedPath = centralSeedPath(path.join(hypHome, 'hypaware'))
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { proxy_mode: true, upstreams: [ANTHROPIC] } }],
  }) + '\n')
  const raw = JSON.stringify({ version: 2, plugins: [] }, null, 2) + '\n'
  await fs.writeFile(configPath, raw)
  let restarts = 0

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
    restartDaemon: async () => { restarts += 1 },
    waitForBind: async () => ({ bound: true }),
    waitForCaFn: async () => ({ ready: true, certPath: '/state/tls/ca-cert.pem' }),
  })

  assert.equal(result.ok, true, result.message ?? '')
  assert.equal(result.outcome, 'remint')
  assert.equal(restarts, 1)
  assert.equal(await fs.readFile(configPath, 'utf8'), raw)
})

test('a re-mint with no daemon service reports ok with daemonInstalled false, so the caller names the ladder', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { proxy_mode: true, upstreams: [ANTHROPIC] } }],
  }, null, 2) + '\n')

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: false }),
    restartDaemon: async () => {
      throw new Error('must not restart a service that does not exist')
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'remint')
  assert.equal(result.daemonInstalled, false)
  assert.deepEqual(result.steps, { write: 'n/a', restart: 'n/a', wait: 'n/a', ca: 'n/a' })
})

test('a re-mint whose CA never appears fails the ca step, still with no write', async () => {
  const { hypHome, configPath } = await stageHome()
  const raw = JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { proxy_mode: true, upstreams: [ANTHROPIC] } }],
  }, null, 2) + '\n'
  await fs.writeFile(configPath, raw)

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
    restartDaemon: async () => {},
    waitForBind: async () => ({ bound: true }),
    waitForCaFn: async () => ({ ready: false }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'failed')
  assert.equal(result.failedStep, 'ca')
  assert.deepEqual(result.steps, { write: 'n/a', restart: 'ok', wait: 'ok', ca: 'failed' })
  assert.equal(await fs.readFile(configPath, 'utf8'), raw)
})

// @ref LLP 0244#central-managed [tests]: a fleet-owned gateway block is reported, never locally shadowed
test('a centrally-managed gateway block declines the local write', async () => {
  const { hypHome, configPath } = await stageHome()
  const seedPath = centralSeedPath(path.join(hypHome, 'hypaware'))
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { upstreams: [ANTHROPIC] } }],
  }) + '\n')
  const raw = JSON.stringify({ version: 2, plugins: [] }, null, 2) + '\n'
  await fs.writeFile(configPath, raw)

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: false }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'central_managed')
  assert.match(result.message ?? '', /central/)
  assert.equal(await fs.readFile(configPath, 'utf8'), raw)
  assert.deepEqual(await backupsIn(hypHome), [])
})

// The live failure this pins (2026-08-17): on a fleet host BOTH layers name
// the gateway. The LLP 0031 merge drops the local entry as a collision, so a
// local proxy_mode write is dead on arrival: the daemon restarts without
// proxy mode and the CA wait can only time out. Central NAMING the plugin is
// the ownership test, not the local file lacking it.
test('central and local both naming the gateway is still central_managed: no local write', async () => {
  const { hypHome, configPath } = await stageHome()
  const seedPath = centralSeedPath(path.join(hypHome, 'hypaware'))
  await fs.mkdir(path.dirname(seedPath), { recursive: true })
  await fs.writeFile(seedPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:18521', upstreams: [ANTHROPIC] } }],
  }) + '\n')
  const raw = JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { upstreams: [ANTHROPIC] } }],
  }, null, 2) + '\n'
  await fs.writeFile(configPath, raw)

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: false }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'central_managed')
  assert.equal(await fs.readFile(configPath, 'utf8'), raw)
  assert.deepEqual(await backupsIn(hypHome), [])
})

test('no gateway entry in any layer refuses with no_gateway', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }, null, 2) + '\n')

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: false }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'no_gateway')
})

/* --------------------- restart, bind wait, CA wait ----------------------- */

test('with a daemon installed: restart, bind wait, then the CA wait, each reported', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { upstreams: [ANTHROPIC] } }],
  }, null, 2) + '\n')
  let restarts = 0

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
    restartDaemon: async () => { restarts += 1 },
    waitForBind: async () => ({ bound: true, endpoint: 'http://127.0.0.1:18521' }),
    waitForCaFn: async () => ({ ready: true, certPath: '/state/tls/hypaware-ca.pem' }),
  })

  assert.equal(result.ok, true, result.message ?? '')
  assert.equal(restarts, 1)
  assert.deepEqual(result.steps, { write: 'ok', restart: 'ok', wait: 'ok', ca: 'ok' })
  assert.equal(result.bound, true)
  assert.equal(result.endpoint, 'http://127.0.0.1:18521')
  assert.equal(result.caReady, true)
  assert.equal(result.caCertPath, '/state/tls/hypaware-ca.pem')
})

test('a bind timeout fails the wait step; the write persists', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }, null, 2) + '\n')

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
    restartDaemon: async () => {},
    waitForBind: async () => ({ bound: false }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'failed', 'a post-write failure does not keep reporting enabled')
  assert.equal(result.failedStep, 'wait')
  assert.equal(result.steps.write, 'ok', 'the persisted write stays visible through the steps')
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.equal(after.plugins[0].config.proxy_mode, true)
})

// The CA wait is the step that keeps LLP 0232's preflight honest: a return
// before the mint would hand attach a proxy-mode daemon and a base-URL client.
// @ref LLP 0244#enable-write [tests]: the switch is not done until the CA the attach preflights on exists
test('a CA timeout fails the ca step even after a clean bind', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway' }],
  }, null, 2) + '\n')

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
    restartDaemon: async () => {},
    waitForBind: async () => ({ bound: true }),
    waitForCaFn: async () => ({ ready: false }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'failed', 'a post-write failure does not keep reporting enabled')
  assert.equal(result.failedStep, 'ca')
  assert.deepEqual(result.steps, { write: 'ok', restart: 'ok', wait: 'ok', ca: 'failed' })
})

// LLP 0244's safety promise leans on failure being reported per step, so the
// two remaining fallible steps get pins too: a restart that throws, and a
// write the filesystem refuses.
test('a restart that throws fails the restart step with the write persisted', async () => {
  const { hypHome, configPath } = await stageHome()
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { upstreams: [ANTHROPIC] } }],
  }, null, 2) + '\n')

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
    restartDaemon: async () => {
      throw new Error('launchctl kickstart exploded')
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'failed')
  assert.equal(result.failedStep, 'restart')
  assert.match(result.message ?? '', /launchctl kickstart exploded/)
  assert.deepEqual(result.steps, { write: 'ok', restart: 'failed', wait: 'n/a', ca: 'n/a' })
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'))
  assert.equal(after.plugins[0].config.proxy_mode, true, 'the write persisted and the steps say so')
})

test('a write the filesystem refuses fails the write step and changes nothing', async (t) => {
  const { hypHome, configPath } = await stageHome()
  const before = JSON.stringify({
    version: 2,
    plugins: [{ name: '@hypaware/ai-gateway', config: { upstreams: [ANTHROPIC] } }],
  }, null, 2) + '\n'
  await fs.writeFile(configPath, before)
  const configDir = path.dirname(configPath)
  await fs.chmod(configDir, 0o555)
  t.after(() => fs.chmod(configDir, 0o755))

  const result = await enableGatewayProxyMode({
    ctx: makeCtx(hypHome),
    daemonStatus: async () => ({ installed: true }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'failed')
  assert.equal(result.failedStep, 'write')
  assert.deepEqual(result.steps, { write: 'failed', restart: 'n/a', wait: 'n/a', ca: 'n/a' })
  await fs.chmod(configDir, 0o755)
  assert.equal(await fs.readFile(configPath, 'utf8'), before, 'the config on disk is untouched')
})

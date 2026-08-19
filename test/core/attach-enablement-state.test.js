// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'

/**
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// Client attach used to dead-end on two different "we don't know that client"
// messages when the real state was "the adapter exists but is not enabled on
// this install" (LLP 0174 #detection). These fixtures drive the three states
// through BOTH failure sites: the `hypaware.ai-gateway` capability gate (no
// gateway-using plugin enabled at all) and the live-registry miss (some other
// gateway-using plugin is enabled, this client's adapter is not).
//
// @ref LLP 0174#detection [tests]: unknown client / known-but-not-enabled /
// disabled-by-fleet, at both attach failure sites

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * Build a CommandRunContext rooted at a temp home.
 *
 * `gatewayCapability: false` reproduces the capability-gate failure site;
 * otherwise a live-but-empty registry reproduces the registry-miss site
 * (`registered` names the clients the fake gateway does know).
 *
 * @param {{ home: string, gatewayCapability?: boolean, registered?: string[] }} opts
 */
function makeCtx({ home, gatewayCapability = true, registered = [] }) {
  const gateway = {
    localEndpoint() {
      return 'http://127.0.0.1:60680'
    },
    /** @param {string} name */
    getClient(name) {
      if (!registered.includes(name)) return undefined
      return { name, async attach() {} }
    },
    listClients() {
      return registered.map((name) => ({ name }))
    },
  }
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout,
    stderr,
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: { version: 2 },
    capabilities: {
      /** @param {string} id */
      has: (id) => (id === 'hypaware.ai-gateway' ? gatewayCapability : false),
      require: () => gateway,
    },
  }))
  return { ctx, stdout, stderr }
}

/** @param {string} home */
function localConfigPath(home) {
  return path.join(home, '.hyp', 'hypaware-config.json')
}

/**
 * The exact guided error the design specifies for the fixable state.
 * @param {string} home
 * @param {string} client
 * @param {string} plugin
 */
function notEnabledMessage(home, client, plugin) {
  return (
    `error: the ${client} adapter is not enabled on this install; ` +
    `enable it with 'hyp setup', or add ${plugin} to ${localConfigPath(home)} ` +
    `and run 'hyp daemon restart', then re-run 'hyp client attach ${client}'\n`
  )
}

const DISABLED_CENTRAL_MESSAGE =
  `error: the claude adapter is disabled by your central config; ` +
  `a local config cannot override the central-managed setting\n`

/** @param {(home: string) => Promise<void> | void} fn */
async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-attach-enable-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Write a fleet (central) layer seed under the temp home's state root. The
 * whole central document wins and locks under LLP 0031's additive merge, so a
 * local add-back of the same plugin name is dropped.
 *
 * @param {string} home
 * @param {object} config
 */
function writeCentralConfig(home, config) {
  const controlDir = path.join(home, '.hyp', 'hypaware', 'config-control')
  mkdirSync(controlDir, { recursive: true })
  writeFileSync(path.join(controlDir, 'seed.json'), JSON.stringify(config))
}

test('capability gate: a catalog-known client reports not_enabled, not cap_missing', async () => {
  await withTempHome(async (home) => {
    // No gateway-using plugin enabled at all, so `hypaware.ai-gateway` is
    // absent. The old wording blamed the gateway plugin; the state is that the
    // claude adapter (which would have pulled the gateway in) is not enabled.
    const { ctx, stderr, stdout } = makeCtx({ home, gatewayCapability: false })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), notEnabledMessage(home, 'claude', '@hypaware/claude'))
    assert.equal(stdout.text(), '')
    assert.doesNotMatch(stderr.text(), /unknown client/)
    assert.doesNotMatch(stderr.text(), /installed and activated/)
  })
})

test('capability gate: bare attach runner defaults to claude and takes the same path', async () => {
  await withTempHome(async (home) => {
    const { ctx, stderr } = makeCtx({ home, gatewayCapability: false })
    const code = await runAttach([], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), notEnabledMessage(home, 'claude', '@hypaware/claude'))
  })
})

test('capability gate: --json carries error_kind adapter_not_enabled in the same payload shape', async () => {
  await withTempHome(async (home) => {
    const { ctx, stdout, stderr } = makeCtx({ home, gatewayCapability: false })
    const code = await runAttach(['claude', '--json'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), '')
    const payload = JSON.parse(stdout.text())
    assert.deepEqual(payload, {
      status: 'failed',
      action: 'attach',
      client: 'claude',
      dry_run: false,
      error_kind: 'adapter_not_enabled',
      error: notEnabledMessage(home, 'claude', '@hypaware/claude').replace(/^error: /, '').trimEnd(),
    })
  })
})

test('capability gate: a name no plugin contributes keeps the cap_missing wording', async () => {
  await withTempHome(async (home) => {
    // State 1 at the capability gate: nothing in the bundled+installed catalog
    // contributes this client, so there is no adapter to name and the gate's
    // own message stands unchanged.
    const { ctx, stderr } = makeCtx({ home, gatewayCapability: false })
    const code = await runAttach(['frobnicator'], ctx)
    assert.equal(code, 1)
    assert.equal(
      stderr.text(),
      'error: attach requires the @hypaware/ai-gateway plugin to be installed and activated\n'
    )
  })
})

test('registry miss: another gateway plugin is live but the requested adapter is not enabled', async () => {
  await withTempHome(async (home) => {
    // The gateway capability resolves (some other gateway-using plugin is
    // enabled) and its registry knows codex but not claude. Today's message
    // was `unknown client 'claude'`; the state is not_enabled.
    const { ctx, stderr, stdout } = makeCtx({ home, registered: ['codex'] })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), notEnabledMessage(home, 'claude', '@hypaware/claude'))
    assert.equal(stdout.text(), '')
    assert.doesNotMatch(stderr.text(), /unknown client/)
  })
})

test('registry miss: --json reports adapter_not_enabled', async () => {
  await withTempHome(async (home) => {
    const { ctx, stdout, stderr } = makeCtx({ home, registered: ['codex'] })
    const code = await runAttach(['claude', '--json'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), '')
    const payload = JSON.parse(stdout.text())
    assert.equal(payload.status, 'failed')
    assert.equal(payload.action, 'attach')
    assert.equal(payload.client, 'claude')
    assert.equal(payload.dry_run, false)
    assert.equal(payload.error_kind, 'adapter_not_enabled')
    assert.match(payload.error, /the claude adapter is not enabled on this install/)
  })
})

test('registry miss: a genuinely unrecognized name still gets the plain unknown client text', async () => {
  await withTempHome(async (home) => {
    const { ctx, stderr } = makeCtx({ home, registered: ['codex'] })
    const code = await runAttach(['frobnicator'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), "error: unknown client 'frobnicator'\n")
  })
})

test('central-disabled adapter refuses with the central-managed explanation, not the local remedy', async () => {
  await withTempHome(async (home) => {
    // The central layer names @hypaware/claude with enabled:false. LLP 0031's
    // merge drops any local entry with that name, so telling the user to edit
    // their own config would be advice that cannot work.
    writeCentralConfig(home, {
      version: 2,
      plugins: [{ name: '@hypaware/claude', enabled: false }],
    })
    mkdirSync(path.dirname(localConfigPath(home)), { recursive: true })
    writeFileSync(localConfigPath(home), JSON.stringify({ version: 2, plugins: [] }))

    const { ctx, stderr } = makeCtx({ home, registered: ['codex'] })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), DISABLED_CENTRAL_MESSAGE)
    assert.doesNotMatch(stderr.text(), /hyp setup/)
    assert.doesNotMatch(stderr.text(), /hyp daemon restart/)
  })
})

test('central-disabled adapter reports adapter_disabled_central through the capability gate too', async () => {
  await withTempHome(async (home) => {
    writeCentralConfig(home, {
      version: 2,
      plugins: [{ name: '@hypaware/claude', enabled: false }],
    })
    mkdirSync(path.dirname(localConfigPath(home)), { recursive: true })
    writeFileSync(localConfigPath(home), JSON.stringify({ version: 2, plugins: [] }))

    const { ctx, stdout } = makeCtx({ home, gatewayCapability: false })
    const code = await runAttach(['claude', '--json'], ctx)
    assert.equal(code, 1)
    const payload = JSON.parse(stdout.text())
    assert.equal(payload.error_kind, 'adapter_disabled_central')
    assert.equal(payload.error, DISABLED_CENTRAL_MESSAGE.replace(/^error: /, '').trimEnd())
  })
})

test('a locally disabled adapter is fixable, so it renders the not_enabled remedy', async () => {
  await withTempHome(async (home) => {
    // enabled:false in the LOCAL layer only: the entry exists but the user can
    // flip it, so this shares the not_enabled wording rather than the central one.
    mkdirSync(path.dirname(localConfigPath(home)), { recursive: true })
    writeFileSync(
      localConfigPath(home),
      JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/claude', enabled: false }] })
    )
    const { ctx, stderr } = makeCtx({ home, registered: ['codex'] })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.equal(stderr.text(), notEnabledMessage(home, 'claude', '@hypaware/claude'))
  })
})

test('a registered client still attaches unchanged', async () => {
  await withTempHome(async (home) => {
    const { ctx, stderr } = makeCtx({ home, registered: ['claude'] })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.equal(stderr.text(), '')
  })
})

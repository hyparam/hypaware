// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { centralSeedPath } from '../../src/core/config/apply.js'
import { runPickerFinale, waitForProxyCaBeforeAttach } from '../../src/core/cli/walkthrough.js'

/**
 * The finale's CA wait (LLP 0243 #composed-default): a fresh proxy-mode
 * install must not attach before the freshly installed daemon mints the CA,
 * because adapters preflight on the CA file (LLP 0232) and would silently
 * land on base-URL mode. These tests drive the extracted decision helper
 * directly - the open-gate finale path itself cannot run under the test
 * runner, whose daemon-install seam refuses real service managers
 * (LLP 0181) - plus one wiring pin that the skip-daemon finale never calls
 * the seam.
 *
 * @import { HypAwareV2Config } from '../../hypaware-plugin-kernel-types.js'
 */

/** @param {(home: string) => Promise<void>} fn */
async function withTempHome(fn) {
  const home = mkdtempSync(path.join(tmpdir(), 'hyp-finale-ca-'))
  try {
    await fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** @param {string} home */
function env(home) {
  return { HOME: home, HYP_HOME: path.join(home, '.hyp') }
}

/**
 * @param {{ proxyMode?: boolean }} [opts]
 * @returns {HypAwareV2Config}
 */
function localConfig(opts) {
  return {
    version: 2,
    plugins: [
      {
        name: /** @type {any} */ ('@hypaware/ai-gateway'),
        config: { upstreams: [], ...(opts?.proxyMode ? { proxy_mode: true } : {}) },
      },
    ],
  }
}

/**
 * @param {string} home
 * @param {{ proxyMode?: boolean }} [opts]
 */
function writeCentralLayer(home, opts) {
  const seedPath = centralSeedPath(path.join(home, '.hyp', 'hypaware'))
  mkdirSync(path.dirname(seedPath), { recursive: true })
  writeFileSync(seedPath, JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: { upstreams: [], ...(opts?.proxyMode ? { proxy_mode: true } : {}) },
      },
    ],
  }, null, 2) + '\n')
}

/** @returns {{ write(chunk: string): boolean, text(): string }} */
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

test('a proxy-mode local config waits for the CA and reports ready', async () => {
  await withTempHome(async (home) => {
    const stderr = makeBuf()
    /** @type {string[]} */
    const stateRoots = []
    const result = await waitForProxyCaBeforeAttach({
      config: localConfig({ proxyMode: true }),
      env: env(home),
      stderr,
      waitForCaFn: async ({ stateRoot }) => {
        stateRoots.push(stateRoot)
        return { ready: true, certPath: path.join(stateRoot, 'tls', 'ca-cert.pem') }
      },
    })
    assert.deepEqual(result, { waited: true, ready: true })
    assert.deepEqual(stateRoots, [path.join(home, '.hyp', 'hypaware')])
    assert.equal(stderr.text(), '', 'a clean mint prints nothing')
  })
})

test('a CA timeout degrades to the base-URL warning, not a failure', async () => {
  await withTempHome(async (home) => {
    const stderr = makeBuf()
    const result = await waitForProxyCaBeforeAttach({
      config: localConfig({ proxyMode: true }),
      env: env(home),
      stderr,
      waitForCaFn: async () => ({ ready: false }),
    })
    assert.deepEqual(result, { waited: true, ready: false })
    assert.match(stderr.text(), /did not mint the proxy CA in time/)
    assert.match(stderr.text(), /hyp attach <client>/)
  })
})

test('a config without proxy_mode never waits', async () => {
  await withTempHome(async (home) => {
    const stderr = makeBuf()
    const result = await waitForProxyCaBeforeAttach({
      config: localConfig(),
      env: env(home),
      stderr,
      waitForCaFn: async () => {
        throw new Error('must not be called')
      },
    })
    assert.deepEqual(result, { waited: false, ready: false })
    assert.equal(stderr.text(), '')
  })
})

// The fleet shape found live 2026-08-17: the central layer names the gateway,
// so the LLP 0031 merge drops the local entry and a locally composed
// `proxy_mode: true` is dead. Waiting on it could only burn the timeout.
// @ref LLP 0244#central-managed [tests]: the central layer owning the gateway block decides the mode
test('a central gateway without proxy_mode skips the wait even when the local key says true', async () => {
  await withTempHome(async (home) => {
    writeCentralLayer(home)
    const stderr = makeBuf()
    const result = await waitForProxyCaBeforeAttach({
      config: localConfig({ proxyMode: true }),
      env: env(home),
      stderr,
      waitForCaFn: async () => {
        throw new Error('must not be called')
      },
    })
    assert.deepEqual(result, { waited: false, ready: false })
    assert.equal(stderr.text(), '', 'no warning: nothing was skipped that could have worked')
  })
})

test('a central gateway with proxy_mode waits even when the local entry lacks the key', async () => {
  await withTempHome(async (home) => {
    writeCentralLayer(home, { proxyMode: true })
    const stderr = makeBuf()
    let calls = 0
    const result = await waitForProxyCaBeforeAttach({
      config: localConfig(),
      env: env(home),
      stderr,
      waitForCaFn: async () => {
        calls += 1
        return { ready: true, certPath: '/state/tls/ca-cert.pem' }
      },
    })
    assert.deepEqual(result, { waited: true, ready: true })
    assert.equal(calls, 1)
  })
})

test('an unreadable central layer falls back to the local config key', async () => {
  await withTempHome(async (home) => {
    const seedPath = centralSeedPath(path.join(home, '.hyp', 'hypaware'))
    mkdirSync(path.dirname(seedPath), { recursive: true })
    writeFileSync(seedPath, 'not json\n')
    const stderr = makeBuf()
    let calls = 0
    const result = await waitForProxyCaBeforeAttach({
      config: localConfig({ proxyMode: true }),
      env: env(home),
      stderr,
      waitForCaFn: async () => {
        calls += 1
        return { ready: true, certPath: '/state/tls/ca-cert.pem' }
      },
    })
    assert.deepEqual(result, { waited: true, ready: true })
    assert.equal(calls, 1, 'a layer that will not load proves nothing')
  })
})

// The wiring pin: the finale forwards `waitForCaFn` and gates it on a real
// daemon install, so the skip-daemon shape every hermetic finale test and
// smoke uses must reach the attach lane without ever touching the seam (no
// daemon was installed, so no CA is coming; waiting would only stall).
test('a skip-daemon finale attaches without calling the CA wait seam', async () => {
  await withTempHome(async (home) => {
    const stderr = makeBuf()
    const stdout = makeBuf()
    /** @type {string[]} */
    const attached = []
    const summary = await runPickerFinale({
      finale: { skipDaemon: true, dryRun: false },
      retentionDays: 30,
      interactive: false,
      clientsPicked: ['claude'],
      capabilities: /** @type {any} */ ({
        has: (/** @type {string} */ id) => id === 'hypaware.ai-gateway',
        require: () => ({
          getClient: (/** @type {string} */ name) =>
            name === 'claude'
              ? { attach: async () => { attached.push(name) } }
              : undefined,
          localEndpoint: () => 'http://127.0.0.1:4317',
        }),
      }),
      config: localConfig({ proxyMode: true }),
      configPath: path.join(home, '.hyp', 'hypaware-config.json'),
      env: env(home),
      stdout,
      stderr,
      waitForCaFn: async () => {
        throw new Error('must not be called')
      },
    })
    assert.equal(summary.daemonInstall.skipped, true)
    assert.deepEqual(attached, ['claude'], 'the attach lane still ran')
  })
})

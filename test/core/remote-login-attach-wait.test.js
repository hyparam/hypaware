// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { temporaryDirectory } from '../helpers/temp_dir.js'
import { runRemoteLogin, waitForClientAttach } from '../../src/core/cli/remote_commands.js'

/**
 * The login attach-wait reads the configured capture mode once, before it
 * polls. A client whose mode writes no marker (transcript-mode Codex) can never
 * satisfy the marker probe, so an install of only such clients skips the wait
 * instead of burning the budget and claiming nothing attached (#2071).
 */

/**
 * @param {Array<Record<string, unknown>>} plugins
 */
async function makeInstall(plugins) {
  const root = await temporaryDirectory('hyp-attach-wait-')
  const hypHome = path.join(root, 'hyp')
  const homeDir = path.join(root, 'home')
  await fs.mkdir(hypHome, { recursive: true })
  await fs.mkdir(homeDir, { recursive: true })
  const configPath = path.join(hypHome, 'config.json')
  const config = { version: 2, query: { remotes: { prod: { url: 'https://hyp.internal/mcp' } } }, plugins }
  await fs.writeFile(configPath, JSON.stringify(config))
  return { hypHome, homeDir, configPath, config, env: { HYP_HOME: hypHome, HYP_CONFIG: configPath } }
}

const codexTranscript = { name: '@hypaware/codex', config: { capture_mode: 'transcript' } }
const claude = { name: '@hypaware/claude' }

/** Counts sleeps so a test can tell a skipped wait from a polled one. */
function countingSleep() {
  const calls = { n: 0 }
  return { calls, sleep: async () => { calls.n++ } }
}

test('a transcript-only codex install skips the attach wait', async () => {
  const { env, homeDir } = await makeInstall([codexTranscript])
  const { calls, sleep } = countingSleep()
  const result = await waitForClientAttach({ env, homeDir, timeoutMs: 60_000, intervalMs: 1, sleep })
  assert.equal(result, null)
  assert.equal(calls.n, 0)
})

test('a mixed install still waits for the client that can attach', async () => {
  const { env, homeDir } = await makeInstall([codexTranscript, claude])
  const { calls, sleep } = countingSleep()
  const result = await waitForClientAttach({ env, homeDir, timeoutMs: 20, intervalMs: 1, sleep })
  assert.deepEqual(result, [])
  assert.ok(calls.n > 0, 'the bounded wait ran')
})

test('a gateway-mode codex install keeps the wait: its mode writes a marker', async () => {
  const { env, homeDir } = await makeInstall([{ name: '@hypaware/codex', config: { capture_mode: 'gateway' } }])
  const { calls, sleep } = countingSleep()
  const result = await waitForClientAttach({ env, homeDir, timeoutMs: 20, intervalMs: 1, sleep })
  assert.deepEqual(result, [])
  assert.ok(calls.n > 0, 'the bounded wait ran')
})

test('an install with no configured client keeps the wait for the first org-config pull', async () => {
  const { env, homeDir } = await makeInstall([])
  const { calls, sleep } = countingSleep()
  const result = await waitForClientAttach({ env, homeDir, timeoutMs: 20, intervalMs: 1, sleep })
  assert.deepEqual(result, [])
  assert.ok(calls.n > 0, 'the bounded wait ran')
})

test('a detached client does not count as configured', async () => {
  const { env, homeDir } = await makeInstall([codexTranscript, { ...claude, recording: false }])
  const result = await waitForClientAttach({ env, homeDir, timeoutMs: 60_000, intervalMs: 1, sleep: async () => {} })
  assert.equal(result, null)
})

/**
 * @param {Array<Record<string, unknown>>} plugins
 */
async function loginOutput(plugins) {
  const { env, homeDir, config } = await makeInstall(plugins)
  /** @type {string[]} */ const out = []
  const ctx = /** @type {any} */ ({
    env,
    config,
    stdin: { isTTY: true },
    stdout: { write: (/** @type {string} */ s) => { out.push(s) } },
    stderr: { write: () => {} },
  })
  const login = /** @type {any} */ (async () => ({
    refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme',
    gateway: { jwt: 'gw-jwt', expiresAt: 1_920_000_000, gatewayId: 'gw-1' },
  }))
  const enroll = /** @type {any} */ (async () => ({ provisioned: true, daemonCode: 0 }))
  const waitForAttach = /** @type {any} */ (
    (/** @type {any} */ opts) => waitForClientAttach({ ...opts, homeDir, timeoutMs: 0, intervalMs: 1, sleep: async () => {} })
  )
  const code = await runRemoteLogin(['prod'], ctx, { login, enroll, waitForAttach })
  return { code, text: out.join('') }
}

test('remote login on a transcript-only codex install points at hyp status without claiming nothing attached', async () => {
  const { code, text } = await loginOutput([codexTranscript])
  assert.equal(code, 0)
  assert.match(text, /Check 'hyp status' for capture activity\./)
  assert.doesNotMatch(text, /no clients attached yet/)
  assert.doesNotMatch(text, /hyp client attach/)
})

test('remote login on a genuinely unattached install keeps the attach guidance', async () => {
  const { code, text } = await loginOutput([claude])
  assert.equal(code, 0)
  assert.match(text, /no clients attached yet - check 'hyp status', or run 'hyp client attach <client>' to capture/)
  assert.doesNotMatch(text, /for capture activity/)
})

test('an empty HYP_CONFIG reads the default config path, as boot does', async () => {
  const { hypHome, homeDir, configPath, config } = await makeInstall([codexTranscript])
  await fs.writeFile(path.join(hypHome, 'hypaware-config.json'), JSON.stringify(config))
  await fs.rm(configPath)
  const env = { HYP_HOME: hypHome, HYP_CONFIG: '' }
  const result = await waitForClientAttach({ env, homeDir, timeoutMs: 60_000, intervalMs: 1, sleep: async () => {} })
  assert.equal(result, null)
})

/**
 * Write a central layer as the seed slot, where the resolver reads it before
 * any applied slot exists.
 *
 * @param {string} hypHome
 * @param {string} body
 */
async function writeCentral(hypHome, body) {
  const controlDir = path.join(hypHome, 'hypaware', 'state')
  await fs.mkdir(controlDir, { recursive: true })
  await fs.writeFile(path.join(controlDir, 'managed-config.seed.json'), body)
}

test('a bad local layer keeps the wait even when the central layer is transcript-only', async () => {
  const { env, homeDir, hypHome, configPath } = await makeInstall([])
  await writeCentral(hypHome, JSON.stringify({ version: 2, plugins: [codexTranscript] }))
  await fs.writeFile(configPath, '{ not json')
  const { calls, sleep } = countingSleep()
  const result = await waitForClientAttach({ env, homeDir, timeoutMs: 20, intervalMs: 1, sleep })
  assert.deepEqual(result, [])
  assert.ok(calls.n > 0, 'the bounded wait ran')
})

test('a bad central layer keeps the wait even when the local layer is transcript-only', async () => {
  const { env, homeDir, hypHome } = await makeInstall([codexTranscript])
  await writeCentral(hypHome, '{ not json')
  const { calls, sleep } = countingSleep()
  const result = await waitForClientAttach({ env, homeDir, timeoutMs: 20, intervalMs: 1, sleep })
  assert.deepEqual(result, [])
  assert.ok(calls.n > 0, 'the bounded wait ran')
})

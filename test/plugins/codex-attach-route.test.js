// @ts-check

import { CODEX_LEGACY_PROVIDER } from '../../src/core/config/client_detach_disk.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { activate as activateCodex } from '../../hypaware-core/plugins-workspace/codex/src/index.js'
import { prepareAttach } from '../../hypaware-core/plugins-workspace/codex/src/toml-config.js'

for (const initial of [undefined, 'model_provider = "custom"\nmodel = "test"\n']) {
  test(`default attach restores the provider without requiring a gateway (${initial ? 'upgrade' : 'fresh'})`, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-native-'))
    try {
      const configPath = path.join(home, '.codex', 'config.toml')
      if (initial) {
        await fs.mkdir(path.dirname(configPath), { recursive: true })
        await fs.writeFile(configPath, prepareAttach(initial, 4388, 'old').content)
      }
      const state = createGatewayState()
      const ctx = stubContext(createAiGatewayApi(state), home)
      ctx.config = {}
      await activateCodex(ctx)
      const client = state.clients.get('codex')
      assert.ok(client)
      assert.equal(client.requiresEndpoint, false)
      let stdout = ''
      const attachCtx = /** @type {any} */ ({ json: true, stdout: { write: (/** @type {string} */ s) => { stdout += s } } })
      await client.attach({ ...attachCtx, dryRun: true })
      // The dry run writes nothing AND reports what it would have done: on an
      // install carrying a managed block, `changed: false` would tell the
      // operator the opposite of the truth on the one command that inspects.
      assert.equal(JSON.parse(stdout).changed, initial ? true : false)
      if (initial) assert.match(await fs.readFile(configPath, 'utf8'), /model_providers.hypaware/)
      stdout = ''
      await client.attach(attachCtx)
      assert.equal(JSON.parse(stdout).mode, 'transcript')
      if (initial) assert.equal(await fs.readFile(configPath, 'utf8'), 'model = "test"\n\nmodel_provider = "custom"\n' + CODEX_LEGACY_PROVIDER)
      else await assert.rejects(fs.access(configPath), { code: 'ENOENT' })
      stdout = ''
      await client.attach(attachCtx)
      assert.equal(JSON.parse(stdout).changed, false)

      // The prose always names config.toml (a dry run that names no path
      // cannot be inspected, and two release smokes assert it), but promises
      // the removal only when there is a managed route to remove. On a fresh
      // install - the common case under the new default - nothing is written,
      // so announcing a removal would describe work that never happens.
      let prose = ''
      const proseCtx = /** @type {any} */ ({
        stdout: { write: (/** @type {string} */ s) => { prose += s } },
        stderr: { write: () => {} },
      })
      await client.attach({ ...proseCtx, dryRun: true })
      assert.match(prose, /^\(dry-run\) Would attach Codex via /)
      assert.ok(prose.includes(configPath), 'the file the attach concerns is always named')
      assert.equal(prose.includes('gateway route'), false, 'no route here, so none is promised')

      // With a route present the removal is announced.
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, prepareAttach('model_provider = "custom"\n', 4388, 'old').content)
      prose = ''
      await client.attach({ ...proseCtx, dryRun: true })
      assert.ok(prose.includes(configPath))
      assert.match(prose, /Would remove the managed gateway route/)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
}

/**
 * Attach writes one provider block, in both auth modes, permanently. Nothing
 * on disk encodes how the user logged in, so nothing on disk can go stale
 * when they switch: the gateway resolves the upstream per request from the
 * credential instead.
 *
 * This replaces the `auth.json`-shape inference of LLP 0099, whose whole
 * failure mode was that the file it read is a snapshot of a decision the user
 * can change at any time without telling anyone.
 *
 * @ref LLP 0313#the-neutral-prefix [tests]: one base_url and one provider name in both auth modes, and attach never reads auth.json
 */

const NEUTRAL_BASE_URL = 'http://127.0.0.1:4388/backend-api/codex'

/**
 * The regression in issue #1022, at the seam it entered: two machines
 * identical but for `auth.json`, which used to attach to two different
 * routes, must now write byte-identical config.
 */
for (const authFile of [
  { label: 'a ChatGPT subscription login', contents: { OPENAI_API_KEY: null, tokens: { access_token: 'x' } } },
  { label: 'an explicit chatgpt auth_mode', contents: { auth_mode: 'chatgpt', tokens: {} } },
  { label: 'an API-key login', contents: { OPENAI_API_KEY: 'sk-not-a-real-key' } },
  { label: 'no auth.json at all', contents: undefined },
]) {
  test(`attach writes the neutral route for ${authFile.label}`, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-attach-'))
    try {
      const codexHome = path.join(home, '.codex')
      await fs.mkdir(codexHome, { recursive: true })
      if (authFile.contents !== undefined) {
        await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify(authFile.contents))
      }

      const written = await runAttach(home)
      assert.match(written.config, /name = "HypAware Codex Gateway"/)
      assert.match(written.config, /base_url = "http:\/\/127\.0\.0\.1:4388\/backend-api\/codex"/)
      assert.equal(written.stdout.includes(NEUTRAL_BASE_URL), true)
      // The route no longer varies, so nothing in the managed block can
      // disagree with the credential Codex is about to send.
      assert.equal(/base_url = "[^"]*\/v1"/.test(written.config), false)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
}

/**
 * Run the codex adapter's real registered `attach()` against a staged HOME.
 *
 * @param {string} home
 * @returns {Promise<{ config: string, stdout: string }>}
 */
async function runAttach(home) {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  await activateCodex(stubContext(api, home))
  const client = state.clients.get('codex')
  assert.ok(client, 'the codex adapter registered no gateway client')

  let stdout = ''
  await client.attach(/** @type {any} */ ({
    endpoint: 'http://127.0.0.1:4388',
    stdout: { write: (/** @type {string} */ chunk) => { stdout += chunk } },
  }))
  const config = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8')
  return { config, stdout }
}

/**
 * @param {any} gateway
 * @param {string} home
 */
function stubContext(gateway, home) {
  return /** @type {any} */ ({
    env: { HOME: home, HYP_HOME: path.join(home, '.hypaware') },
    paths: { stateDir: path.join(home, '.hypaware/state/plugins/test') },
    plugin: { version: '0.0.0-test' },
    config: { capture_mode: 'gateway' },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    configRegistry: { registerSection() {} },
    requireCapability: () => gateway,
    backfills: { register() {} },
    commands: { register() {} },
    skills: { register() {} },
  })
}

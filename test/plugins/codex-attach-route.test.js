// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { activate as activateCodex } from '../../hypaware-core/plugins-workspace/codex/src/index.js'

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
    config: {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    configRegistry: { registerSection() {} },
    requireCapability: () => gateway,
    backfills: { register() {} },
    commands: { register() {} },
    skills: { register() {} },
  })
}

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
 * Issue #2072: `--dry-run` exists to tell an operator what a real attach would
 * do, so its `changed` has to come from the install and not from a constant.
 * The pin is the pair: the planned answer equals the applied one, and the plan
 * leaves the disk as it found it.
 */
test('a gateway dry-run reports the changed a real attach would, and writes nothing', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-dryrun-'))
  try {
    const codexHome = path.join(home, '.codex')
    await fs.mkdir(codexHome, { recursive: true })

    const planned = JSON.parse((await runAttach(home, { dryRun: true, json: true })).stdout)
    // Side-effect free: the plan neither created config.toml nor left a temp
    // file from the atomic write behind.
    assert.deepEqual(await fs.readdir(codexHome), [])

    const applied = JSON.parse((await runAttach(home, { json: true })).stdout)
    assert.equal(applied.changed, true, 'a real attach on an unattached install changes it')
    // The whole payload, not just `changed`: a plan that agrees on one field
    // and drops another still tells the operator something the attach will not
    // do. `dry_run` is the only field the two are allowed to differ on.
    assert.deepEqual(planned, { ...applied, dry_run: true })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/**
 * The same pin on an install that already carries a `model_provider` of its
 * own, where a stray write would destroy the user's setting rather than just
 * create a file.
 */
test('a gateway dry-run leaves an existing config.toml byte-identical', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-dryrun-'))
  try {
    const codexHome = path.join(home, '.codex')
    await fs.mkdir(codexHome, { recursive: true })
    const configPath = path.join(codexHome, 'config.toml')
    const before = 'model_provider = "openai"\n'
    await fs.writeFile(configPath, before)

    const planned = JSON.parse((await runAttach(home, { dryRun: true, json: true })).stdout)
    assert.equal(await fs.readFile(configPath, 'utf8'), before)
    assert.deepEqual(await fs.readdir(codexHome), ['config.toml'])

    const applied = JSON.parse((await runAttach(home, { json: true })).stdout)
    // Including `prev_value`: the setting a real attach is about to displace
    // is the fact this install has and a fresh one does not, so a plan that
    // omits it is not the same answer.
    assert.equal(applied.prev_value, 'openai')
    assert.deepEqual(planned, { ...applied, dry_run: true })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/**
 * The plan reads the install, so it can fail where the old constant could not.
 * It has to fail the way the attach it is planning fails, rather than
 * reporting a confident `status: ok` over a config neither path can read.
 */
test('a gateway dry-run fails the way a real attach fails on an unreadable install', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-dryrun-'))
  try {
    // A directory where config.toml belongs is unreadable to both paths, and
    // unlike a mode change it does not depend on the uid running the test.
    await fs.mkdir(path.join(home, '.codex', 'config.toml'), { recursive: true })

    const planned = await runAttach(home, { dryRun: true, json: true }).then(
      () => undefined,
      (/** @type {unknown} */ err) => err
    )
    const applied = await runAttach(home, { json: true }).then(
      () => undefined,
      (/** @type {unknown} */ err) => err
    )
    assert.ok(planned instanceof Error, 'the plan must not report ok on an install it cannot read')
    assert.ok(applied instanceof Error, 'a real attach on the same install fails')
    assert.equal(planned.constructor.name, applied.constructor.name)
    assert.equal(planned.message, applied.message)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/**
 * Run the codex adapter's real registered `attach()` against a staged HOME.
 *
 * @param {string} home
 * @param {{ dryRun?: boolean, json?: boolean }} [opts]
 * @returns {Promise<{ config: string, stdout: string }>}
 */
async function runAttach(home, opts = {}) {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  await activateCodex(stubContext(api, home))
  const client = state.clients.get('codex')
  assert.ok(client, 'the codex adapter registered no gateway client')

  let stdout = ''
  await client.attach(/** @type {any} */ ({
    endpoint: 'http://127.0.0.1:4388',
    dryRun: opts.dryRun === true,
    json: opts.json === true,
    stdout: { write: (/** @type {string} */ chunk) => { stdout += chunk } },
  }))
  const config = await fs
    .readFile(path.join(home, '.codex', 'config.toml'), 'utf8')
    .catch(() => '')
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

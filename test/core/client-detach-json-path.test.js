// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ClientDetachError, detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
// Fixture setup only. The core undo under test imports no plugin code; building
// the "this entry is ours" case with the real attach is what proves the two
// halves agree on the shape rather than on a shape this file invented.
import { createOpenclawAttach } from '../../hypaware-core/plugins-workspace/openclaw/src/attach.js'

/**
 * LLP 0173 T2: the `json_path` undo (`detachJsonPathProviders`). Unlike the
 * `json`/`toml` formats there is no HypAware-owned marker to replay: the
 * entries attach wrote *are* the record, so every outcome here turns on the
 * ownership check (`baseUrl` is the gateway's, `marker_header` names the key).
 *
 * @import { ClientDescriptor } from '../../src/core/types.js'
 */

/** @type {ClientDescriptor} */
const OPENCLAW_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/openclaw'),
  name: 'openclaw',
  skillDir: 'skills/openclaw',
  attachProbe: {
    format: 'json_path',
    settings_file: '.openclaw/openclaw.json',
    container_path: 'models.providers',
    provider_keys: ['anthropic', 'openai'],
    marker_header: 'x-hypaware-upstream',
    cache_glob: 'agents/*/agent/models.json',
  },
}

const ENDPOINT = 'http://127.0.0.1:18521'

/** @returns {Promise<string>} */
async function stageHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-detach-json-path-'))
}

/**
 * @param {string} home
 * @param {unknown} value
 * @returns {Promise<string>}
 */
async function writeOpenclawConfig(home, value) {
  const p = path.join(home, '.openclaw', 'openclaw.json')
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n')
  return p
}

/**
 * @param {string} home
 * @param {string} agentId
 * @param {string} content
 * @returns {Promise<string>}
 */
async function writeAgentCache(home, agentId, content) {
  const p = path.join(home, '.openclaw', 'agents', agentId, 'agent', 'models.json')
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
  return p
}

/** @param {string} settingsPath */
async function readJsonFile(settingsPath) {
  return JSON.parse(await fs.readFile(settingsPath, 'utf8'))
}

/**
 * Attach for real, with its output swallowed: these tests assert the file the
 * write produced, not the prose around it.
 *
 * @param {string} home
 */
async function attachForReal(home) {
  const attach = createOpenclawAttach({ homeDir: home, env: {} })
  return await attach.attach(/** @type {any} */ ({
    endpoint: ENDPOINT,
    stdout: { write() { return true } },
  }))
}

/** @param {string} upstream @param {string} baseUrl */
function ourEntry(upstream, baseUrl) {
  return { baseUrl, headers: { 'x-hypaware-upstream': upstream }, models: [] }
}

/* ------------------------------ ours: deleted ----------------------------- */

test('json_path undo deletes the two entries the gateway wrote', async () => {
  const home = await stageHome()
  try {
    const settingsPath = await writeOpenclawConfig(home, { theme: 'dark', models: { default: 'sonnet' } })
    assert.deepEqual(await attachForReal(home), { status: 'done' })

    const result = await detachClientFromDisk({
      descriptor: OPENCLAW_DESCRIPTOR,
      homeDir: home,
      env: {},
      expectedBaseUrl: ENDPOINT,
    })

    assert.equal(result.changed, true)
    assert.equal(result.settingsPath, settingsPath)
    // Both spellings attach writes are ours: the bare origin (anthropic) and
    // the `+ /v1` one (openai). A check that only knew one of them would leave
    // the other entry behind.
    const after = await readJsonFile(settingsPath)
    assert.deepEqual(after.models.providers, {})
    // Nothing outside the two keys is touched, and nothing is backed up:
    // there was no foreign value to preserve.
    assert.equal(after.theme, 'dark')
    assert.equal(after.models.default, 'sonnet')
    assert.equal(result.warning, undefined)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* ------------------- present but not ours: backed up, kept ------------------ */

test('json_path undo backs a present-but-not-ours entry up instead of discarding it', async () => {
  const home = await stageHome()
  try {
    const foreign = {
      baseUrl: 'https://foreign.example/anthropic',
      headers: { authorization: 'Bearer user-secret' },
      models: ['claude-x'],
    }
    const settingsPath = await writeOpenclawConfig(home, {
      models: { providers: { anthropic: foreign, openai: ourEntry('openai', `${ENDPOINT}/v1`) } },
    })

    const result = await detachClientFromDisk({
      descriptor: OPENCLAW_DESCRIPTOR,
      homeDir: home,
      env: {},
      expectedBaseUrl: ENDPOINT,
    })

    assert.equal(result.changed, true)
    const providers = (await readJsonFile(settingsPath)).models.providers
    // Ours went; theirs did not merely survive, it is still readable in the
    // same file a human opens after the detach.
    assert.equal('openai' in providers, false)
    assert.equal('anthropic' in providers, false)
    assert.deepEqual(providers._hypaware_detach_backup.anthropic, foreign)
    // Reported by path, never by value: a provider entry is exactly where a
    // credential header ends up, and this string is printed and echoed into
    // `hyp detach --json`.
    assert.match(String(result.warning), /models\.providers\._hypaware_detach_backup\.anthropic/)
    assert.equal(String(result.warning).includes('user-secret'), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo treats a right-URL wrong-marker entry as not ours', async () => {
  const home = await stageHome()
  try {
    // Points at the gateway, but the marker header names the other key: not a
    // shape attach produces, so it is preserved rather than deleted.
    const impostor = { baseUrl: ENDPOINT, headers: { 'x-hypaware-upstream': 'openai' }, models: [] }
    const settingsPath = await writeOpenclawConfig(home, { models: { providers: { anthropic: impostor } } })

    const result = await detachClientFromDisk({
      descriptor: OPENCLAW_DESCRIPTOR,
      homeDir: home,
      env: {},
      expectedBaseUrl: ENDPOINT,
    })

    assert.equal(result.changed, true)
    const providers = (await readJsonFile(settingsPath)).models.providers
    assert.deepEqual(providers._hypaware_detach_backup.anthropic, impostor)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo refuses rather than guessing when the gateway base URL is unknown', async () => {
  const home = await stageHome()
  try {
    await writeOpenclawConfig(home, {
      models: { providers: { anthropic: ourEntry('anthropic', ENDPOINT) } },
    })

    await assert.rejects(
      detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home, env: {} }),
      (err) => err instanceof ClientDetachError && err.code === 'EXPECTED_BASE_URL_UNKNOWN'
    )
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* ------------------------------ absent file ------------------------------- */

test('json_path undo is a no-op when the settings file is absent', async () => {
  const home = await stageHome()
  try {
    const result = await detachClientFromDisk({
      descriptor: OPENCLAW_DESCRIPTOR,
      homeDir: home,
      env: {},
      expectedBaseUrl: ENDPOINT,
    })

    assert.equal(result.changed, false)
    assert.equal(result.settingsPath, path.join(home, '.openclaw', 'openclaw.json'))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* --------------------------- best-effort cache purge ---------------------- */

test('json_path undo purges the derived caches, skipping one that will not parse', async () => {
  const home = await stageHome()
  try {
    const settingsPath = await writeOpenclawConfig(home, {
      models: { providers: { anthropic: ourEntry('anthropic', ENDPOINT) } },
    })
    const good = await writeAgentCache(home, 'main', JSON.stringify({
      anthropic: { baseUrl: ENDPOINT },
      openai: { baseUrl: `${ENDPOINT}/v1` },
      google: { baseUrl: 'https://vendor.example' },
    }, null, 2) + '\n')
    const brokenText = '{ this is not json'
    const broken = await writeAgentCache(home, 'sidecar', brokenText)

    const result = await detachClientFromDisk({
      descriptor: OPENCLAW_DESCRIPTOR,
      homeDir: home,
      env: {},
      expectedBaseUrl: ENDPOINT,
    })

    // The settings half landed and the malformed sibling did not fail it.
    assert.equal(result.changed, true)
    assert.deepEqual((await readJsonFile(settingsPath)).models.providers, {})

    // The purge is provider-key scoped: another vendor's cached entry stays.
    assert.deepEqual(await readJsonFile(good), { google: { baseUrl: 'https://vendor.example' } })
    // Skipped, not rewritten and not truncated.
    assert.equal(await fs.readFile(broken, 'utf8'), brokenText)
    assert.match(String(result.warning), /sidecar/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// `$OPENCLAW_HOME` may sit NESTED inside `$HOME`, which is the case that broke:
// deriving the config home from the first segment of the settings path's
// home-relative form answered `$HOME/.config` here, the `agents/*/...` glob
// matched nothing, and an unmatched glob is not an error - so the settings half
// reported success while the caches kept routing at the dead gateway. Two
// segments is what makes it a regression test; a one-segment relocation
// (`OPENCLAW_HOME=$HOME/elsewhere`) passed either way.
// @ref LLP 0169#decision [tests]: the cache purge follows the relocated config
// home, since the caches are what do not self-heal
test('json_path undo purges the caches under a nested $OPENCLAW_HOME', async () => {
  const home = await stageHome()
  try {
    const openclawHome = path.join(home, '.config', 'openclaw')
    const settingsPath = path.join(openclawHome, 'openclaw.json')
    await fs.mkdir(openclawHome, { recursive: true })
    await fs.writeFile(settingsPath, JSON.stringify({
      models: { providers: { anthropic: ourEntry('anthropic', ENDPOINT) } },
    }, null, 2) + '\n')

    const cachePath = path.join(openclawHome, 'agents', 'main', 'agent', 'models.json')
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, JSON.stringify({
      anthropic: { baseUrl: ENDPOINT },
      google: { baseUrl: 'https://vendor.example' },
    }, null, 2) + '\n')

    const result = await detachClientFromDisk({
      descriptor: OPENCLAW_DESCRIPTOR,
      homeDir: home,
      env: { OPENCLAW_HOME: openclawHome },
      expectedBaseUrl: ENDPOINT,
    })

    assert.equal(result.changed, true)
    assert.equal(result.settingsPath, settingsPath)
    assert.equal(result.removed, ENDPOINT)
    assert.deepEqual((await readJsonFile(settingsPath)).models.providers, {})
    // The half that silently no-opped before.
    assert.deepEqual(await readJsonFile(cachePath), { google: { baseUrl: 'https://vendor.example' } })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

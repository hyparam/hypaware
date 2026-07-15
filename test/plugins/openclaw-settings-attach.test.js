// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MARKER_HEADER,
  OpenclawSettingsError,
  attach,
  defaultSettingsPath,
  prepareAttach,
} from '../../hypaware-core/plugins-workspace/openclaw/src/settings.js'
import { probeClientAttachFromDescriptor } from '../../src/core/daemon/status.js'

/**
 * The core `json_path` descriptor for OpenClaw, matching the attach_probe
 * the manifest declares. Used to prove the core probe (which keys off
 * marker-path existence alone) and the on-disk capture state agree after
 * a re-attach heals config drift.
 *
 * @type {any}
 */
const OPENCLAW_DESCRIPTOR = {
  plugin: '@hypaware/openclaw',
  name: 'openclaw',
  skillDir: 'skills/openclaw',
  attachProbe: {
    format: 'json_path',
    settings_file: '.openclaw/openclaw.json',
    marker_path: 'models.providers.hypaware',
    marker_record: 'headers.x-hypaware-marker',
  },
}

/**
 * LLP 0109 attach transform: OpenClaw's strictly-validated config root
 * means the marker is the injected `models.providers.hypaware` entry
 * itself, and the self-describing undo record (LLP 0045 Part 3) rides
 * that provider's `headers` map as the `x-hypaware-marker` value. These
 * tests assert the undo record contents directly so the core `json_path`
 * undo always has what it needs to reverse from disk alone.
 */

const OPTS = { port: 4317, version: '1.0.0', attachedAt: '2026-07-15T00:00:00.000Z' }

/**
 * @param {Record<string, unknown>} config
 * @returns {Record<string, any>}
 */
function readRecord(config) {
  const provider = /** @type {any} */ (config).models.providers.hypaware
  return JSON.parse(provider.headers[MARKER_HEADER])
}

test('prepareAttach writes the provider, repoints the primary, and records a complete undo record', () => {
  const initial = {
    agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
  }
  const result = prepareAttach(initial, OPTS)

  assert.equal(result.changed, true)
  assert.equal(result.action, 'attached')
  assert.equal(result.model, 'claude-sonnet-4-5')
  assert.equal(result.prevPrimary, 'anthropic/claude-sonnet-4-5')
  // The input object is never mutated (pure transform).
  assert.equal(/** @type {any} */ (initial).models, undefined)

  const config = /** @type {any} */ (result.config)
  assert.equal(config.agents.defaults.model.primary, 'hypaware/claude-sonnet-4-5')
  const provider = config.models.providers.hypaware
  assert.equal(provider.baseUrl, 'http://127.0.0.1:4317')
  assert.equal(provider.api, 'anthropic-messages')
  assert.equal(provider.apiKey, '${ANTHROPIC_API_KEY}')
  assert.deepEqual(provider.models, ['claude-sonnet-4-5'])
  // Every OpenClaw request through the injected provider carries the
  // projector match signal.
  assert.equal(provider.headers['x-hypaware-client'], 'openclaw')

  // The undo record is parseable straight from the headers map and
  // matches the LLP 0109 shape.
  const record = readRecord(result.config)
  assert.equal(record.attached_at, '2026-07-15T00:00:00.000Z')
  assert.equal(record.version, '1.0.0')
  assert.equal(record.port, 4317)
  assert.deepEqual(record.managed.added, ['models.providers.hypaware'])
  assert.deepEqual(record.managed.created_parents, ['models', 'models.providers'])
  assert.deepEqual(record.managed.set, [{
    path: 'agents.defaults.model.primary',
    value: 'hypaware/claude-sonnet-4-5',
    prev: 'anthropic/claude-sonnet-4-5',
  }])
  assert.deepEqual(record.managed.appended, [])
})

test('created_parents lists only the parents attach actually created', () => {
  const withModels = prepareAttach({
    models: { providers: { openrouter: { baseUrl: 'https://openrouter.ai' } } },
    agents: { defaults: { model: { primary: 'anthropic/claude-opus-4' } } },
  }, OPTS)
  assert.deepEqual(readRecord(withModels.config).managed.created_parents, [])
  // Sibling providers survive the injection.
  assert.equal(
    /** @type {any} */ (withModels.config).models.providers.openrouter.baseUrl,
    'https://openrouter.ai'
  )

  const withBareModels = prepareAttach({
    models: {},
    agents: { defaults: { model: { primary: 'anthropic/claude-opus-4' } } },
  }, OPTS)
  assert.deepEqual(readRecord(withBareModels.config).managed.created_parents, ['models.providers'])
})

test('an existing agents.defaults.models allowlist gains the managed id, recorded as appended', () => {
  const result = prepareAttach({
    agents: {
      defaults: {
        model: { primary: 'anthropic/claude-sonnet-4-5' },
        models: ['anthropic/claude-sonnet-4-5', 'openrouter/gpt-5'],
      },
    },
  }, OPTS)

  const config = /** @type {any} */ (result.config)
  assert.deepEqual(config.agents.defaults.models, [
    'anthropic/claude-sonnet-4-5',
    'openrouter/gpt-5',
    'hypaware/claude-sonnet-4-5',
  ])
  assert.deepEqual(readRecord(result.config).managed.appended, [{
    path: 'agents.defaults.models',
    value: 'hypaware/claude-sonnet-4-5',
  }])
})

test('without an allowlist nothing is appended and none is created', () => {
  const result = prepareAttach({
    agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
  }, OPTS)
  assert.equal(/** @type {any} */ (result.config).agents.defaults.models, undefined)
  assert.deepEqual(readRecord(result.config).managed.appended, [])
})

test('re-attach at the same port is a no-op', () => {
  const once = prepareAttach({
    agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
  }, OPTS)
  const twice = prepareAttach(/** @type {any} */ (once.config), OPTS)

  assert.equal(twice.changed, false)
  assert.equal(twice.action, 'noop')
  assert.deepEqual(twice.config, once.config)
})

test('re-attach at a new port rewrites baseUrl but preserves the original prev values', () => {
  const once = prepareAttach({
    agents: {
      defaults: {
        model: { primary: 'anthropic/claude-sonnet-4-5' },
        models: ['anthropic/claude-sonnet-4-5'],
      },
    },
  }, OPTS)
  const twice = prepareAttach(/** @type {any} */ (once.config), {
    port: 5000,
    version: '1.1.0',
    attachedAt: '2026-07-16T00:00:00.000Z',
  })

  assert.equal(twice.changed, true)
  assert.equal(twice.action, 'updated')
  assert.equal(twice.prevPrimary, 'anthropic/claude-sonnet-4-5')

  const config = /** @type {any} */ (twice.config)
  assert.equal(config.models.providers.hypaware.baseUrl, 'http://127.0.0.1:5000')
  // The primary stays managed; a re-attach never re-backs-up our own value.
  assert.equal(config.agents.defaults.model.primary, 'hypaware/claude-sonnet-4-5')

  const record = readRecord(twice.config)
  assert.equal(record.port, 5000)
  assert.equal(record.version, '1.1.0')
  assert.equal(record.attached_at, '2026-07-16T00:00:00.000Z')
  // The ORIGINAL managed block survives: prev still names the user's own
  // pre-attach primary, so detach after any number of re-attaches
  // restores the user's settings, never one of ours.
  assert.deepEqual(record.managed, readRecord(once.config).managed)
})

test('re-attach at the same port HEALS a drifted primary and allowlist instead of silently no-oping', () => {
  // Attach once against a config that carries an allowlist.
  const once = prepareAttach({
    agents: {
      defaults: {
        model: { primary: 'anthropic/claude-sonnet-4-5' },
        models: ['anthropic/claude-sonnet-4-5'],
      },
    },
  }, OPTS)
  assert.equal(once.action, 'attached')

  // External drift: the marker provider survives, but the primary is
  // repointed straight back to anthropic and the allowlist loses our
  // managed id. Capture is now silently off while the marker still
  // exists, so the core probe would report attached.
  const drifted = /** @type {any} */ (structuredClone(once.config))
  drifted.agents.defaults.model.primary = 'anthropic/claude-sonnet-4-5'
  drifted.agents.defaults.models = ['anthropic/claude-sonnet-4-5']

  // Re-attach at the SAME port must restore capture, not no-op.
  const healed = prepareAttach(drifted, OPTS)
  assert.equal(healed.changed, true)
  assert.equal(healed.action, 'updated')

  const config = /** @type {any} */ (healed.config)
  assert.equal(config.agents.defaults.model.primary, 'hypaware/claude-sonnet-4-5')
  assert.ok(config.agents.defaults.models.includes('hypaware/claude-sonnet-4-5'))

  // The undo record still names the user's ORIGINAL pre-attach primary,
  // never the drifted value, so a later detach still restores it.
  const record = readRecord(healed.config)
  assert.deepEqual(record.managed.set, [{
    path: 'agents.defaults.model.primary',
    value: 'hypaware/claude-sonnet-4-5',
    prev: 'anthropic/claude-sonnet-4-5',
  }])
})

test('re-attach heals a drifted primary that OpenClaw hot-reloaded to a DIFFERENT model', () => {
  const once = prepareAttach({
    agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
  }, OPTS)
  const drifted = /** @type {any} */ (structuredClone(once.config))
  // A hot-reload revert / user edit that points the primary somewhere
  // else entirely, not just back to the original.
  drifted.agents.defaults.model.primary = 'anthropic/claude-opus-4'

  const healed = prepareAttach(drifted, OPTS)
  assert.equal(healed.changed, true)
  assert.equal(healed.action, 'updated')
  assert.equal(
    /** @type {any} */ (healed.config).agents.defaults.model.primary,
    'hypaware/claude-sonnet-4-5'
  )
})

test('re-attach heals drift AND rewrites the port when both changed', () => {
  const once = prepareAttach({
    agents: {
      defaults: {
        model: { primary: 'anthropic/claude-sonnet-4-5' },
        models: ['anthropic/claude-sonnet-4-5'],
      },
    },
  }, OPTS)
  const drifted = /** @type {any} */ (structuredClone(once.config))
  drifted.agents.defaults.model.primary = 'anthropic/claude-sonnet-4-5'

  const healed = prepareAttach(drifted, { port: 5001, version: '1.2.0', attachedAt: OPTS.attachedAt })
  const config = /** @type {any} */ (healed.config)
  assert.equal(healed.action, 'updated')
  assert.equal(config.models.providers.hypaware.baseUrl, 'http://127.0.0.1:5001')
  assert.equal(config.agents.defaults.model.primary, 'hypaware/claude-sonnet-4-5')
  assert.equal(readRecord(healed.config).port, 5001)
})

test('re-attach with the marker parent object removed refuses rather than silently no-oping', () => {
  const once = prepareAttach({
    agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
  }, OPTS)
  const drifted = /** @type {any} */ (structuredClone(once.config))
  // The whole agents.defaults.model object was removed: re-pointing the
  // primary would silently no-op, so attach must refuse loudly.
  delete drifted.agents.defaults.model

  assert.throws(
    () => prepareAttach(drifted, OPTS),
    (/** @type {any} */ err) =>
      err instanceof OpenclawSettingsError && err.code === 'DRIFT_CONFLICT'
  )
})

test('a non-Anthropic primary is refused with a clear error', () => {
  assert.throws(
    () => prepareAttach({
      agents: { defaults: { model: { primary: 'openrouter/gpt-5' } } },
    }, OPTS),
    (/** @type {any} */ err) =>
      err instanceof OpenclawSettingsError &&
      err.code === 'NON_ANTHROPIC_PRIMARY' &&
      /openrouter\/gpt-5/.test(err.message) &&
      /anthropic\/<model>/.test(err.message)
  )
})

test('a missing primary is refused: HypAware cannot know the built-in default', () => {
  for (const config of [{}, { agents: {} }, { agents: { defaults: { model: {} } } }]) {
    assert.throws(
      () => prepareAttach(config, OPTS),
      (/** @type {any} */ err) =>
        err instanceof OpenclawSettingsError &&
        err.code === 'NO_PRIMARY_MODEL' &&
        /agents\.defaults\.model\.primary/.test(err.message)
    )
  }
})

test('a bare anthropic/ primary (empty model id) is refused', () => {
  assert.throws(
    () => prepareAttach({
      agents: { defaults: { model: { primary: 'anthropic/' } } },
    }, OPTS),
    (/** @type {any} */ err) => err.code === 'NON_ANTHROPIC_PRIMARY'
  )
})

// ---------------------------------------------------------------------
// attach() I/O wrapper
// ---------------------------------------------------------------------

/** @returns {Promise<{ dir: string, settingsPath: string }>} */
async function stage() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-openclaw-settings-'))
  return { dir, settingsPath: path.join(dir, 'openclaw.json') }
}

/** @returns {{ out: string[], err: string[], stdout: { write(c: string): void }, stderr: { write(c: string): void } }} */
function streams() {
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const err = []
  return {
    out,
    err,
    stdout: { write: (c) => { out.push(c) } },
    stderr: { write: (c) => { err.push(c) } },
  }
}

const ENDPOINT = 'http://127.0.0.1:4317'

test('attach writes the file and emits the JSON output contract', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(settingsPath, JSON.stringify({
      agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
    }, null, 2))

    const io = streams()
    const result = await attach({
      endpoint: ENDPOINT,
      stdout: io.stdout,
      stderr: io.stderr,
      json: true,
      env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
      homeDir: dir,
      version: '1.0.0',
      settingsPath,
    })
    assert.equal(result.changed, true)

    const written = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(written.models.providers.hypaware.baseUrl, 'http://127.0.0.1:4317')
    assert.equal(written.agents.defaults.model.primary, 'hypaware/claude-sonnet-4-5')

    const payload = JSON.parse(io.out.join(''))
    assert.equal(payload.status, 'ok')
    assert.equal(payload.action, 'attach')
    assert.equal(payload.client, 'openclaw')
    assert.equal(payload.dry_run, false)
    assert.equal(payload.settings_path, settingsPath)
    assert.equal(payload.changed, true)
    assert.equal(payload.port, 4317)
    assert.equal(payload.prev_value, 'anthropic/claude-sonnet-4-5')
    // ANTHROPIC_API_KEY was set, so no warning.
    assert.deepEqual(io.err, [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach warns on stderr (non-fatally) when ANTHROPIC_API_KEY is unset', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(settingsPath, JSON.stringify({
      agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
    }))

    const io = streams()
    const result = await attach({
      endpoint: ENDPOINT,
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      homeDir: dir,
      version: '1.0.0',
      settingsPath,
    })
    assert.equal(result.changed, true)
    assert.match(io.err.join(''), /ANTHROPIC_API_KEY is not set/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach warns naming a stale resolved-provider cache that could override config', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(settingsPath, JSON.stringify({
      agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
    }))
    // Seed OpenClaw's per-agent resolved-provider cache alongside the
    // settings file: <home>/agents/<id>/agent/models.json.
    const cachePath = path.join(dir, 'agents', 'default', 'agent', 'models.json')
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, JSON.stringify({ baseUrl: 'https://api.anthropic.com' }))

    const io = streams()
    await attach({
      endpoint: ENDPOINT,
      stdout: io.stdout,
      stderr: io.stderr,
      // Key set so the ANTHROPIC_API_KEY warning does not fire; only the
      // stale-cache warning should appear.
      env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
      homeDir: dir,
      version: '1.0.0',
      settingsPath,
    })
    const err = io.err.join('')
    assert.match(err, /caches resolved providers/)
    assert.match(err, new RegExp(cachePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(err, /ANTHROPIC_API_KEY is not set/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach does not warn about caches when the agents dir is absent', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(settingsPath, JSON.stringify({
      agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
    }))
    const io = streams()
    await attach({
      endpoint: ENDPOINT,
      stdout: io.stdout,
      stderr: io.stderr,
      env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
      homeDir: dir,
      version: '1.0.0',
      settingsPath,
    })
    assert.deepEqual(io.err, [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('re-attach through attach() heals on-disk drift so the core probe reflects real capture', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(settingsPath, JSON.stringify({
      agents: {
        defaults: {
          model: { primary: 'anthropic/claude-sonnet-4-5' },
          models: ['anthropic/claude-sonnet-4-5'],
        },
      },
    }, null, 2))

    const env = { ANTHROPIC_API_KEY: 'sk-ant-x' }
    const first = await attach({
      endpoint: ENDPOINT,
      stdout: streams().stdout,
      stderr: streams().stderr,
      env,
      homeDir: dir,
      version: '1.0.0',
      settingsPath,
    })
    assert.equal(first.action, 'attached')

    // External drift: marker provider survives, primary + allowlist revert.
    const drifted = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    drifted.agents.defaults.model.primary = 'anthropic/claude-sonnet-4-5'
    drifted.agents.defaults.models = ['anthropic/claude-sonnet-4-5']
    await fs.writeFile(settingsPath, JSON.stringify(drifted, null, 2))

    // Status probes attached (marker exists) even though capture drifted -
    // the silent-miss the heal closes.
    const preProbe = await probeClientAttachFromDescriptor({
      descriptor: OPENCLAW_DESCRIPTOR,
      homeDir: dir,
      env: { OPENCLAW_HOME: dir },
    })
    assert.equal(preProbe.attached, true)

    const io = streams()
    const healed = await attach({
      endpoint: ENDPOINT,
      stdout: io.stdout,
      stderr: io.stderr,
      env,
      homeDir: dir,
      version: '1.0.0',
      settingsPath,
    })
    // Pre-fix this re-attach was a silent no-op (changed:false), leaving
    // the file drifted; post-fix it restores capture.
    assert.equal(healed.changed, true)
    assert.equal(healed.action, 'updated')

    const written = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(written.agents.defaults.model.primary, 'hypaware/claude-sonnet-4-5')
    assert.ok(written.agents.defaults.models.includes('hypaware/claude-sonnet-4-5'))

    // Status now reflects reality: attached AND capture is genuinely routed.
    const postProbe = await probeClientAttachFromDescriptor({
      descriptor: OPENCLAW_DESCRIPTOR,
      homeDir: dir,
      env: { OPENCLAW_HOME: dir },
    })
    assert.equal(postProbe.attached, true)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach refuses a JSON5-commented config, naming the file', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(settingsPath, [
      '{',
      '  // my model',
      '  "agents": { "defaults": { "model": { "primary": "anthropic/claude-sonnet-4-5" } } }',
      '}',
    ].join('\n'))

    const io = streams()
    await assert.rejects(
      attach({
        endpoint: ENDPOINT,
        stdout: io.stdout,
        stderr: io.stderr,
        env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
        homeDir: dir,
        version: '1.0.0',
        settingsPath,
      }),
      (/** @type {any} */ err) =>
        err instanceof OpenclawSettingsError &&
        err.code === 'JSON5' &&
        err.message.includes(settingsPath)
    )
    // Refused, not destroyed: the commented file is untouched.
    assert.match(await fs.readFile(settingsPath, 'utf8'), /\/\/ my model/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach refuses a symlinked settings file', async () => {
  const { dir, settingsPath } = await stage()
  try {
    const realPath = path.join(dir, 'real.json')
    await fs.writeFile(realPath, JSON.stringify({
      agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
    }))
    await fs.symlink(realPath, settingsPath)

    const io = streams()
    await assert.rejects(
      attach({
        endpoint: ENDPOINT,
        stdout: io.stdout,
        stderr: io.stderr,
        env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
        homeDir: dir,
        version: '1.0.0',
        settingsPath,
      }),
      (/** @type {any} */ err) => err.code === 'SYMLINK'
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach dry-run reads but never writes, and reports the plan', async () => {
  const { dir, settingsPath } = await stage()
  try {
    const body = JSON.stringify({
      agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
    }, null, 2)
    await fs.writeFile(settingsPath, body)

    const io = streams()
    const result = await attach({
      endpoint: ENDPOINT,
      stdout: io.stdout,
      stderr: io.stderr,
      dryRun: true,
      json: true,
      env: { ANTHROPIC_API_KEY: 'sk-ant-x' },
      homeDir: dir,
      version: '1.0.0',
      settingsPath,
    })
    assert.equal(result.changed, false)
    assert.equal(result.action, 'dry_run')
    assert.equal(await fs.readFile(settingsPath, 'utf8'), body)

    const payload = JSON.parse(io.out.join(''))
    assert.equal(payload.status, 'ok')
    assert.equal(payload.action, 'attach')
    assert.equal(payload.client, 'openclaw')
    assert.equal(payload.dry_run, true)
    assert.equal(payload.changed, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('defaultSettingsPath honors OPENCLAW_HOME via the core settings-path seam', () => {
  assert.equal(
    defaultSettingsPath(undefined, '/home/u'),
    path.join('/home/u', '.openclaw', 'openclaw.json')
  )
  assert.equal(
    defaultSettingsPath({ OPENCLAW_HOME: '/opt/claw' }, '/home/u'),
    path.join('/opt/claw', 'openclaw.json')
  )
})

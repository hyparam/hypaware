// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ClientDetachError, detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { probeClientAttachFromDescriptor } from '../../src/core/daemon/status.js'
import { V1_BUNDLED_PLUGIN_ALLOWLIST } from '../../src/core/runtime/bundled.js'

/**
 * LLP 0109: the third core probe/undo format, `json_path`. The marker is a
 * nested managed object (OpenClaw's `models.providers.hypaware`) rather than a
 * top-level key, and the self-describing undo record is a JSON-encoded string
 * inside it (`headers.x-hypaware-marker`). These tests hand-write fixtures the
 * shape the openclaw adapter's attach produces - core imports no plugin code,
 * and neither do the tests.
 */

/** @import { ClientDescriptor } from '../../src/core/types.js' */

/** @type {ClientDescriptor} */
const OPENCLAW_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/openclaw'),
  name: 'openclaw',
  skillDir: 'skills/openclaw',
  attachProbe: {
    format: 'json_path',
    settings_file: '.openclaw/openclaw.json',
    marker_path: 'models.providers.hypaware',
    marker_record: 'headers.x-hypaware-marker',
  },
}

const PRIMARY_PREV = 'anthropic/claude-sonnet-4-5'
const PRIMARY_OURS = 'hypaware/claude-sonnet-4-5'

/**
 * The undo record shape LLP 0109 specifies (attach writes it as a JSON
 * string). `any` so tests can bend fixtures per scenario.
 *
 * @returns {any}
 */
function undoRecord() {
  return {
    attached_at: '2026-07-15T00:00:00.000Z',
    version: '0.3.0',
    port: 4321,
    managed: {
      added: ['models.providers.hypaware'],
      created_parents: ['models', 'models.providers'],
      set: [{ path: 'agents.defaults.model.primary', value: PRIMARY_OURS, prev: PRIMARY_PREV }],
      appended: [{ path: 'agents.defaults.models', value: PRIMARY_OURS }],
    },
  }
}

/**
 * The pre-attach settings file: an anthropic primary and a models allowlist,
 * no `models` root.
 */
function originalSettings() {
  return {
    agents: {
      defaults: {
        model: { primary: PRIMARY_PREV },
        models: [PRIMARY_PREV],
      },
    },
  }
}

/**
 * What the openclaw adapter's attach leaves on disk: primary repointed,
 * allowlist appended, and the injected provider whose headers carry the
 * marker + record.
 *
 * @param {Record<string, unknown>} [record]
 * @returns {any}
 */
function attachedSettings(record = undoRecord()) {
  return {
    agents: {
      defaults: {
        model: { primary: PRIMARY_OURS },
        models: [PRIMARY_PREV, PRIMARY_OURS],
      },
    },
    models: {
      providers: {
        hypaware: {
          baseUrl: 'http://127.0.0.1:4321',
          api: 'anthropic-messages',
          apiKey: '${ANTHROPIC_API_KEY}',
          headers: {
            'x-hypaware-client': 'openclaw',
            'x-hypaware-marker': JSON.stringify(record),
          },
          models: ['claude-sonnet-4-5'],
        },
      },
    },
  }
}

/** @returns {Promise<string>} */
async function stageHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-detach-json-path-'))
}

/**
 * @param {string} home
 * @param {unknown} value
 * @returns {Promise<string>}
 */
async function writeOpenclawSettings(home, value) {
  const p = path.join(home, '.openclaw', 'openclaw.json')
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n')
  return p
}

/* --------------------------------- allowlist --------------------------------- */

test('@hypaware/openclaw is in the V1 bundled allowlist', () => {
  assert.ok(
    V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/openclaw'),
    'expected @hypaware/openclaw in V1_BUNDLED_PLUGIN_ALLOWLIST so it activates by default'
  )
})

/* ----------------------------------- probe ----------------------------------- */

test('json_path probe reports attached with version/port from the nested record', async () => {
  const home = await stageHome()
  try {
    const settingsPath = await writeOpenclawSettings(home, attachedSettings())

    const probe = await probeClientAttachFromDescriptor({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(probe.attached, true)
    assert.equal(probe.settingsPath, settingsPath)
    assert.equal(probe.version, '0.3.0')
    assert.equal(probe.port, '4321')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path probe reports not attached when the marker path is absent', async () => {
  const home = await stageHome()
  try {
    await writeOpenclawSettings(home, originalSettings())

    const probe = await probeClientAttachFromDescriptor({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(probe.attached, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path probe reports not attached when the settings file is absent', async () => {
  const home = await stageHome()
  try {
    const probe = await probeClientAttachFromDescriptor({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(probe.attached, false)
    assert.equal('error' in probe && probe.error !== undefined, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path probe tolerates a malformed record: attached with unknown version/port', async () => {
  const home = await stageHome()
  try {
    const value = attachedSettings()
    value.models.providers.hypaware.headers['x-hypaware-marker'] = 'not json {'
    await writeOpenclawSettings(home, value)

    const probe = await probeClientAttachFromDescriptor({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(probe.attached, true)
    assert.equal(probe.version, undefined)
    assert.equal(probe.port, undefined)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path probe tolerates a missing record header: attached with unknown version/port', async () => {
  const home = await stageHome()
  try {
    const value = attachedSettings()
    delete value.models.providers.hypaware.headers['x-hypaware-marker']
    await writeOpenclawSettings(home, value)

    const probe = await probeClientAttachFromDescriptor({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(probe.attached, true)
    assert.equal(probe.version, undefined)
    assert.equal(probe.port, undefined)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* ----------------------------------- detach ---------------------------------- */

test('json_path undo replays the full record and round-trips to the original bytes', async () => {
  const home = await stageHome()
  try {
    const originalText = JSON.stringify(originalSettings(), null, 2) + '\n'
    const settingsPath = await writeOpenclawSettings(home, attachedSettings())

    const result = await detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(result.restoredValue, PRIMARY_PREV)
    assert.equal(result.settingsPath, settingsPath)
    assert.equal('warning' in result, false)

    // Set restored, appended value removed, added subtree deleted, and the
    // created parents (`models`, `models.providers`) pruned - byte-for-byte.
    assert.equal(await fs.readFile(settingsPath, 'utf8'), originalText)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo clears exactly what the probe detects', async () => {
  const home = await stageHome()
  try {
    await writeOpenclawSettings(home, attachedSettings())
    assert.equal((await probeClientAttachFromDescriptor({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })).attached, true)
    await detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal((await probeClientAttachFromDescriptor({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })).attached, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo leaves an externally-overridden set value in place with a warning', async () => {
  const home = await stageHome()
  try {
    const value = attachedSettings()
    // The user repointed the primary after we attached.
    value.agents.defaults.model.primary = 'openai/gpt-5'
    const settingsPath = await writeOpenclawSettings(home, value)

    const result = await detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.match(String(result.warning), /overridden externally/)
    assert.equal('restoredValue' in result, false)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(parsed.agents.defaults.model.primary, 'openai/gpt-5') // user value untouched
    assert.equal('models' in parsed, false) // provider + created parents still removed
    assert.deepEqual(parsed.agents.defaults.models, [PRIMARY_PREV]) // appended value still removed
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo deletes a prev-less set leaf and reports it removed', async () => {
  const home = await stageHome()
  try {
    // Attach onto a file with no primary at all: the record's set entry has
    // no `prev`, so the undo deletes the leaf instead of restoring.
    const record = undoRecord()
    record.managed.set = [
      { path: 'agents.defaults.model.primary', value: PRIMARY_OURS },
    ]
    record.managed.appended = []
    const value = attachedSettings(record)
    value.agents.defaults.models = [PRIMARY_PREV]
    const settingsPath = await writeOpenclawSettings(home, value)

    const result = await detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(result.removed, PRIMARY_OURS)
    assert.equal('restoredValue' in result, false)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal('primary' in parsed.agents.defaults.model, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo skips an appended value the user already removed', async () => {
  const home = await stageHome()
  try {
    const value = attachedSettings()
    value.agents.defaults.models = [PRIMARY_PREV] // user removed ours
    const settingsPath = await writeOpenclawSettings(home, value)

    const result = await detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.deepEqual(parsed.agents.defaults.models, [PRIMARY_PREV])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo keeps a created parent that gained user keys since attach', async () => {
  const home = await stageHome()
  try {
    const value = attachedSettings()
    // The user added their own provider under the parent attach created.
    value.models.providers.mine = { baseUrl: 'https://mine.example' }
    const settingsPath = await writeOpenclawSettings(home, value)

    await detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal('hypaware' in parsed.models.providers, false)
    assert.deepEqual(parsed.models.providers.mine, { baseUrl: 'https://mine.example' })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo fails MALFORMED_MARKER on a marker without a readable record, leaving the file untouched', async () => {
  const home = await stageHome()
  try {
    const value = attachedSettings()
    value.models.providers.hypaware.headers['x-hypaware-marker'] = 'not json {'
    const settingsPath = path.join(home, '.openclaw', 'openclaw.json')
    await writeOpenclawSettings(home, value)
    const before = await fs.readFile(settingsPath, 'utf8')

    await assert.rejects(
      detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home }),
      (/** @type {any} */ err) => err instanceof ClientDetachError && err.code === 'MALFORMED_MARKER'
    )

    assert.equal(await fs.readFile(settingsPath, 'utf8'), before) // non-destructive
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo fails MALFORMED_MARKER when the record header is missing entirely', async () => {
  const home = await stageHome()
  try {
    const value = attachedSettings()
    delete value.models.providers.hypaware.headers
    const settingsPath = path.join(home, '.openclaw', 'openclaw.json')
    await writeOpenclawSettings(home, value)
    const before = await fs.readFile(settingsPath, 'utf8')

    await assert.rejects(
      detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home }),
      (/** @type {any} */ err) => err instanceof ClientDetachError && err.code === 'MALFORMED_MARKER'
    )

    assert.equal(await fs.readFile(settingsPath, 'utf8'), before)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo is a no-op when the marker is absent', async () => {
  const home = await stageHome()
  try {
    const text = JSON.stringify(originalSettings(), null, 2) + '\n'
    const settingsPath = await writeOpenclawSettings(home, originalSettings())

    const result = await detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, false)
    assert.equal(await fs.readFile(settingsPath, 'utf8'), text) // untouched
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('json_path undo is a no-op when the settings file is absent', async () => {
  const home = await stageHome()
  try {
    const result = await detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* ------------------------------ concurrent edit ------------------------------ */

/**
 * An `fs` double that delegates to the real `node:fs/promises` but bumps the
 * settings file's mtime right after the undo reads it - simulating an
 * external edit landing between read and write. The mtime-gated atomic
 * writer must surface CONCURRENT_EDIT rather than clobber.
 * @returns {any}
 */
function makeTouchAfterReadFs() {
  return /** @type {any} */ ({
    stat: (/** @type {string} */ p) => fs.stat(p),
    async readFile(/** @type {string} */ p, /** @type {any} */ enc) {
      const content = await fs.readFile(p, enc)
      await fs.utimes(p, new Date(), new Date(Date.now() + 5000))
      return content
    },
    mkdir: (/** @type {string} */ p, /** @type {any} */ opts) => fs.mkdir(p, opts),
    rename: (/** @type {string} */ a, /** @type {string} */ b) => fs.rename(a, b),
    rm: (/** @type {string} */ p, /** @type {any} */ opts) => fs.rm(p, opts),
    open: (/** @type {string} */ p, /** @type {any} */ flags, /** @type {any} */ mode) => fs.open(p, flags, mode),
  })
}

test('json_path undo surfaces CONCURRENT_EDIT when the file changes between read and write', async () => {
  const home = await stageHome()
  try {
    const settingsPath = path.join(home, '.openclaw', 'openclaw.json')
    await writeOpenclawSettings(home, attachedSettings())
    const before = await fs.readFile(settingsPath, 'utf8')

    await assert.rejects(
      detachClientFromDisk({ descriptor: OPENCLAW_DESCRIPTOR, homeDir: home, fs: makeTouchAfterReadFs() }),
      (/** @type {any} */ err) => err instanceof ClientDetachError && err.code === 'CONCURRENT_EDIT'
    )

    assert.equal(await fs.readFile(settingsPath, 'utf8'), before) // never clobbered
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

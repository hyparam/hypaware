// @ts-check

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MODE_BASE_URL,
  MODE_OTEL,
  MODE_PROXY,
  attach,
  otelModeEnv,
} from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { ensureLocalCa } from '../../src/core/tls/ca.js'

const PORT = 18521
const TELEMETRY_PORT = 4319

/**
 * A temp home with an optional seeded settings file.
 *
 * @param {Record<string, unknown>} [settings]
 */
async function rig(settings) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-otel-attach-'))
  const settingsPath = path.join(root, '.claude', 'settings.json')
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
  if (settings) await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')

  return {
    root,
    stateRoot: path.join(root, '.hyp', 'hypaware'),
    settingsPath,
    stateFile: path.join(root, 'session-context.jsonl'),
    spoolDir: path.join(root, '.hyp', 'spool', 'claude-bodies'),
    /** @returns {Promise<Record<string, any>>} */
    async read() {
      return JSON.parse(await fsp.readFile(settingsPath, 'utf8'))
    },
    /** @returns {Promise<string>} */
    async raw() {
      return fsp.readFile(settingsPath, 'utf8')
    },
    /** The env a core detach resolves the settings file from. */
    env: { HOME: root, HYP_HOME: path.join(root, '.hyp') },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

/** @param {{ settingsPath: string, stateFile: string, spoolDir: string }} r */
function otelAttach(r, extra = {}) {
  return attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_OTEL,
    telemetryPort: TELEMETRY_PORT,
    spoolDir: r.spoolDir,
    claudeVersion: '2.1.233',
    ...extra,
  })
}

/** The claude descriptor, as the core undo receives it. */
const CLAUDE_DESCRIPTOR = {
  name: 'claude',
  plugin: '@hypaware/claude',
  attachProbe: {
    format: 'json',
    settings_file: '.claude/settings.json',
    marker_key: '_hypaware',
  },
}

// The list IS the decision: the golden compare pins every key by value, so a
// silently renamed or dropped flag fails here rather than as an empty dataset.
// @ref LLP 0258#env-keys [tests]: exactly these keys, with exactly these values
test('otel attach writes exactly the telemetry env block', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await otelAttach(r)
  const value = await r.read()

  assert.equal(value.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1')
  assert.equal(value.env.OTEL_LOGS_EXPORTER, 'otlp')
  assert.equal(value.env.OTEL_METRICS_EXPORTER, 'otlp')
  assert.equal(value.env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json')
  assert.equal(value.env.OTEL_EXPORTER_OTLP_ENDPOINT, `http://127.0.0.1:${TELEMETRY_PORT}`)
  assert.equal(value.env.OTEL_LOG_USER_PROMPTS, '1')
  assert.equal(value.env.OTEL_LOG_ASSISTANT_RESPONSES, '1')
  assert.equal(value.env.OTEL_LOG_TOOL_DETAILS, '1')
  assert.equal(value.env.OTEL_LOG_RAW_API_BODIES, `file:${r.spoolDir}`)

  // The marker manages that block and nothing else, so the core undo removes
  // exactly what attach added.
  const expectedManaged = Object.fromEntries(
    otelModeEnv({ telemetryPort: TELEMETRY_PORT, spoolDir: r.spoolDir })
      .map(({ key, value: v }) => [key, v])
  )
  assert.deepEqual(value._hypaware.managed.env, expectedManaged)
})

// The Remote Control predicate, stated as absences: nothing this mode writes
// routes traffic, so the endpoint stays first party with no override keys.
// @ref LLP 0258#env-keys [tests]: no base URL, no proxy keys, no first-party overrides
test('otel attach writes no routing key and no first-party override', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await otelAttach(r)
  const value = await r.read()

  assert.equal(Object.hasOwn(value.env, 'ANTHROPIC_BASE_URL'), false)
  assert.equal(Object.hasOwn(value.env, 'HTTPS_PROXY'), false)
  assert.equal(Object.hasOwn(value.env, 'NODE_EXTRA_CA_CERTS'), false)
  assert.equal(Object.hasOwn(value.env, 'ENABLE_TOOL_SEARCH'), false)
  assert.equal(Object.hasOwn(value.env, '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL'), false)
})

// @ref LLP 0258#marker-and-spool [tests]: the marker records the mode and the spool directory
test('otel attach records mode and spool directory on the marker', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await otelAttach(r)
  const value = await r.read()

  assert.equal(value._hypaware.mode, 'otel')
  assert.equal(value._hypaware.spool_dir, r.spoolDir)
  // `port` stays the gateway's: it is what the attach-drift check compares.
  assert.equal(value._hypaware.port, PORT)
})

test('otel attach still installs the managed session hooks', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await otelAttach(r)
  const value = await r.read()

  const events = Object.keys(value.hooks).sort()
  assert.deepEqual(events, ['CwdChanged', 'PostToolUse', 'SessionStart', 'UserPromptSubmit'])
  assert.match(JSON.stringify(value.hooks), /claude-hook session-context/)
  assert.match(JSON.stringify(value.hooks), /claude-hook classify-cwd/)
})

// Below the floor the client emits none of the events the listener reads, so
// attach refuses rather than writing a settings file that says "attached"
// over a capture that never starts. No fallback to any other mode.
// @ref LLP 0258#version-floor [tests]: refusal, with the upgrade hint, before any settings I/O
test('otel attach refuses below the version floor and leaves settings untouched', async (t) => {
  const r = await rig({ env: { ANTHROPIC_API_KEY: 'sk-user-key' } })
  t.after(() => r.cleanup())

  const before = await r.raw()
  await assert.rejects(
    () => otelAttach(r, { claudeVersion: '2.1.192' }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 'VERSION_FLOOR')
      assert.match(String(/** @type {any} */ (err).message), /claude update/)
      return true
    }
  )
  assert.equal(await r.raw(), before)
})

// "Leaves any existing attach untouched" includes the mode being switched
// away from: a proxy-attached machine on an old client keeps its working
// proxy attach byte for byte.
// @ref LLP 0258#version-floor [tests]: an existing attach survives the refusal
test('a floor refusal leaves an existing proxy attach in place', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())
  const ca = await ensureLocalCa({ stateRoot: r.stateRoot, hosts: ['api.anthropic.com'] })

  await attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_PROXY,
    caCertPath: ca.certPath,
  })
  const before = await r.raw()

  await assert.rejects(
    () => otelAttach(r, { claudeVersion: '2.0.0' }),
    /claude update/
  )
  assert.equal(await r.raw(), before)
  assert.equal((await r.read())._hypaware.mode, 'proxy')
})

// Unknown is not old: refusing on "we could not tell" would block exactly the
// machines most likely to be current.
test('an undetectable version attaches', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await otelAttach(r, { claudeVersion: undefined })
  assert.equal((await r.read())._hypaware.mode, 'otel')
})

test('the floor itself attaches (2.1.193 is not below 2.1.193)', async (t) => {
  const r = await rig({})
  t.after(() => r.cleanup())

  await otelAttach(r, { claudeVersion: '2.1.193' })
  assert.equal((await r.read())._hypaware.mode, 'otel')
})

test('otel attach requires the telemetry port and an absolute spool path', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  await assert.rejects(
    () => otelAttach(r, { telemetryPort: undefined }),
    (err) => /** @type {any} */ (err).code === 'INVALID_TELEMETRY_PORT'
  )
  await assert.rejects(
    () => otelAttach(r, { spoolDir: undefined }),
    (err) => /** @type {any} */ (err).code === 'INVALID_SPOOL_DIR'
  )
  await assert.rejects(
    () => otelAttach(r, { spoolDir: 'relative/spool' }),
    (err) => /** @type {any} */ (err).code === 'INVALID_SPOOL_DIR'
  )
  // Nothing was written by any refused validation.
  await assert.rejects(() => r.raw(), (err) => /** @type {any} */ (err).code === 'ENOENT')
})

// A pre-existing OTEL endpoint is almost always the user's own collector:
// taken over with a backup and a notice, never silently, and the notice never
// echoes the value (collector endpoints carry tokens).
// @ref LLP 0044#conflict-back-up--override-restore-on-leave [tests]
test('an existing OTEL endpoint is backed up, warned about without the value, and restored', async (t) => {
  const r = await rig({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://token@collector.corp:4318' },
  })
  t.after(() => r.cleanup())

  const result = await otelAttach(r)
  assert.equal(result.changed, true)
  const warned = String(result.changed && result.warnings?.join(' '))
  assert.match(warned, /OTEL_EXPORTER_OTLP_ENDPOINT/)
  assert.doesNotMatch(warned, /collector\.corp/)
  // The display copy is redacted; the marker's backup is verbatim.
  assert.equal(result.changed && result.prevValue, 'https://***@collector.corp:4318')

  const attached = await r.read()
  assert.equal(
    attached._hypaware.prev_env.OTEL_EXPORTER_OTLP_ENDPOINT,
    'https://token@collector.corp:4318'
  )

  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })
  const detached = await r.read()
  assert.equal(detached.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://token@collector.corp:4318')
  assert.equal(Object.hasOwn(detached.env, 'CLAUDE_CODE_ENABLE_TELEMETRY'), false)
})

// Migrating an already-attached machine must not strand the old mode's keys.
// @ref LLP 0232#mode-migration [tests]: the same key release, in the new direction
test('switching from base-URL to otel mode releases the old keys', async (t) => {
  const r = await rig({ env: { ANTHROPIC_BASE_URL: 'https://gw.corp.example' } })
  t.after(() => r.cleanup())

  await attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_BASE_URL,
  })
  await otelAttach(r)
  const value = await r.read()

  // The user's own base URL came back rather than being left pointed at us.
  assert.equal(value.env.ANTHROPIC_BASE_URL, 'https://gw.corp.example')
  assert.equal(Object.hasOwn(value.env, 'ENABLE_TOOL_SEARCH'), false)
  assert.equal(Object.hasOwn(value.env, '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL'), false)
  assert.equal(value.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1')
  assert.equal(value._hypaware.mode, 'otel')
})

test('switching from proxy to otel mode releases the proxy keys', async (t) => {
  const r = await rig({ env: { HTTPS_PROXY: 'http://proxy.corp:8080' } })
  t.after(() => r.cleanup())
  const ca = await ensureLocalCa({ stateRoot: r.stateRoot, hosts: ['api.anthropic.com'] })

  await attach({
    port: PORT,
    version: '2.0.0',
    stateFile: r.stateFile,
    settingsPath: r.settingsPath,
    mode: MODE_PROXY,
    caCertPath: ca.certPath,
  })
  await otelAttach(r)
  const value = await r.read()

  assert.equal(value.env.HTTPS_PROXY, 'http://proxy.corp:8080')
  assert.equal(Object.hasOwn(value.env, 'NODE_EXTRA_CA_CERTS'), false)
  assert.equal(value.env.OTEL_EXPORTER_OTLP_ENDPOINT, `http://127.0.0.1:${TELEMETRY_PORT}`)
  assert.equal(value._hypaware.mode, 'otel')
})

// Detach stays the core disk-driven marker replay: no adapter code, and the
// settings end as if HypAware was never there.
// @ref LLP 0045#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [tests]
test('detach after an otel attach restores the settings byte for byte', async (t) => {
  const seed = {
    env: { ANTHROPIC_API_KEY: 'sk-user-key' },
    permissions: { allow: ['Bash(ls *)'] },
  }
  const r = await rig(seed)
  t.after(() => r.cleanup())
  const seedBody = await r.raw()

  await otelAttach(r)
  await detachClientFromDisk({
    descriptor: /** @type {never} */ (CLAUDE_DESCRIPTOR),
    homeDir: r.root,
    env: r.env,
  })

  assert.equal(await r.raw(), seedBody)
})

test('a re-attach keeps the original backup rather than backing up our own value', async (t) => {
  const r = await rig({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://own-collector:4318' } })
  t.after(() => r.cleanup())

  await otelAttach(r)
  const second = await otelAttach(r)

  const value = await r.read()
  assert.equal(value._hypaware.prev_env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://own-collector:4318')
  // Nothing new was displaced this run, so nothing new is warned about.
  assert.equal(second.changed && second.warnings, undefined)
})

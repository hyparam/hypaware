// @ts-check

/**
 * The proxy-to-otel migration `hyp attach claude` performs on a machine that
 * is still proxy-attached (LLP 0262 #migration): the settings write flips the
 * marker and releases the proxy keys through the ordinary mode-switch rule,
 * the launchd environment is unwound, and the CA trust is OFFERED as
 * `hyp detach claude --purge` but never taken. These tests drive the real
 * adapter (through `activate()`), the way an attach reaches it in production;
 * the writer-level key release itself is pinned by
 * claude-settings-otel-attach.test.js.
 *
 * @ref LLP 0262#migration [tests]: one command migrates a proxy-attached machine, and the CA purge is offered, never forced
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  activate as activateClaude,
  unwindProxyLaunchdEnv,
} from '../../hypaware-core/plugins-workspace/claude/src/index.js'
import {
  MODE_BASE_URL,
  MODE_OTEL,
  MODE_PROXY,
  attach as writeSettings,
  otelModeEnv,
} from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { ensureLocalCa } from '../../src/core/tls/ca.js'
import { collectHypAwareStatus, probeClientAttachFromDescriptor } from '../../src/core/daemon/status.js'
import { renderStatusText } from '../../src/core/commands/status.js'

const GATEWAY_PORT = 18521
const ENDPOINT = `http://127.0.0.1:${GATEWAY_PORT}`

/** The claude descriptor, the shape `hyp status` probes the marker through. */
const CLAUDE_DESCRIPTOR = /** @type {any} */ ({
  name: 'claude',
  plugin: '@hypaware/claude',
  attachProbe: {
    format: 'json',
    settings_file: '.claude/settings.json',
    marker_key: '_hypaware',
  },
})

/**
 * A temp home seeded with a user-owned settings file, plus the activation
 * fixture that registers the real claude adapter against a fake gateway.
 *
 * @param {{ claudeVersion?: string }} [opts]
 */
async function rig(opts = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-otel-migration-'))
  const settingsPath = path.join(root, '.claude', 'settings.json')
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
  const seed = {
    env: { ANTHROPIC_API_KEY: 'sk-user-key' },
    permissions: { allow: ['Bash(ls *)'] },
  }
  await fsp.writeFile(settingsPath, JSON.stringify(seed, null, 2) + '\n')

  // The install's own config, so `hyp status` reads this machine the way it
  // reads a real one: the claude plugin is enabled, which is what makes the
  // client line say `configured` beside the attach state.
  await fsp.mkdir(path.join(root, '.hyp'), { recursive: true })
  await fsp.writeFile(
    path.join(root, '.hyp', 'hypaware-config.json'),
    JSON.stringify({
      version: 2,
      plugins: [
        {
          name: '@hypaware/ai-gateway',
          config: {
            upstreams: [{
              name: 'anthropic',
              base_url: 'https://api.anthropic.com',
              path_prefix: '/v1/messages',
            }],
          },
        },
        { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
      ],
    }, null, 2) + '\n'
  )

  const env = {
    HOME: root,
    HYP_HOME: path.join(root, '.hyp'),
    HYP_CLAUDE_CODE_VERSION: opts.claudeVersion ?? '2.1.233',
  }

  /** @type {any} */
  const gateway = {
    registerUpstreamPreset() {},
    registerExchangeProjector() {},
    registerSettlementEnricher() {},
    /** @type {any} */
    client: undefined,
    registerClient(/** @type {any} */ client) { this.client = client },
  }
  const ctx = /** @type {any} */ ({
    env,
    paths: { stateDir: path.join(root, '.hyp', 'hypaware', 'plugins', 'claude') },
    plugin: { version: '0.0.0-test' },
    config: {},
    configRegistry: { registerSection() {} },
    requireCapability: () => gateway,
    backfills: { register() {} },
    commands: { register() {} },
    skills: { register() {} },
    agents: { register() {} },
    initPresets: { register() {} },
    sources: { register() {} },
    query: { registerDataset() {} },
  })
  await activateClaude(ctx)

  return {
    root,
    env,
    settingsPath,
    stateRoot: path.join(root, '.hyp', 'hypaware'),
    gateway,
    /** @returns {Promise<Record<string, any>>} */
    async read() {
      return JSON.parse(await fsp.readFile(settingsPath, 'utf8'))
    },
    async raw() {
      return fsp.readFile(settingsPath, 'utf8')
    },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

/**
 * Proxy-attach the rig's settings file the way a proxy-mode install left it,
 * with a real CA on disk so "the purge was never run" is observable.
 *
 * @param {Awaited<ReturnType<typeof rig>>} r
 */
async function seedProxyAttach(r) {
  const ca = await ensureLocalCa({ stateRoot: r.stateRoot, hosts: ['api.anthropic.com'] })
  await writeSettings({
    port: GATEWAY_PORT,
    version: '2.0.0',
    stateFile: path.join(r.root, 'session-context.jsonl'),
    settingsPath: r.settingsPath,
    mode: MODE_PROXY,
    caCertPath: ca.certPath,
  })
  return ca
}

function makeBuf() {
  let value = ''
  return {
    write(/** @type {unknown} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * The `hyp status` client line for this rig, produced the way the command
 * produces it: the real collector (which discovers the bundled claude
 * descriptor and probes the marker this rig wrote) feeding the real text
 * renderer. Nothing about the line is fabricated, so it moves only when a
 * real attach moves the marker.
 *
 * @param {Awaited<ReturnType<typeof rig>>} r
 * @returns {Promise<string>}
 */
async function statusClientLine(r) {
  const report = await collectHypAwareStatus({
    env: { ...process.env, HOME: r.root, HYP_HOME: path.join(r.root, '.hyp'), HYP_CONFIG: '' },
    homeDir: r.root,
  })
  const stdout = makeBuf()
  renderStatusText({
    report,
    // The live gateway's registered clients, which is what the command passes:
    // this rig's activation registered the claude adapter on its gateway.
    clientNames: ['claude'],
    datasets: [],
    cacheRoot: path.join(r.root, 'cache'),
    stdout,
  })
  const line = stdout.text().split('\n').find((l) => l.includes('- claude '))
  assert.ok(line !== undefined, 'hyp status listed no claude client line')
  return line
}

test('hyp attach claude migrates a proxy attach: marker flips, proxy keys release, nothing else is touched', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())
  const ca = await seedProxyAttach(r)

  const before = await probeClientAttachFromDescriptor({
    descriptor: CLAUDE_DESCRIPTOR,
    homeDir: r.root,
    env: r.env,
  })
  assert.equal(before.mode, 'proxy')

  const buf = makeBuf()
  await r.gateway.client.attach({ endpoint: ENDPOINT, stdout: buf, stderr: buf })

  const value = await r.read()
  // The marker is now an otel marker, and the spool it records is swept by
  // detach and purge.
  assert.equal(value._hypaware.mode, 'otel')
  assert.equal(typeof value._hypaware.spool_dir, 'string')
  // The proxy keys are gone from env: nothing routes Claude Code any more.
  assert.equal(Object.hasOwn(value.env, 'HTTPS_PROXY'), false)
  assert.equal(Object.hasOwn(value.env, 'NODE_EXTRA_CA_CERTS'), false)
  // Nothing else was touched: the env holds exactly the telemetry block plus
  // the user's own key, and the user's other settings survive verbatim.
  const expectedKeys = [
    'ANTHROPIC_API_KEY',
    ...otelModeEnv({ telemetryPort: 1, spoolDir: '/x' }).map((e) => e.key),
  ].sort()
  assert.deepEqual(Object.keys(value.env).sort(), expectedKeys)
  assert.equal(value.env.ANTHROPIC_API_KEY, 'sk-user-key')
  assert.deepEqual(value.permissions, { allow: ['Bash(ls *)'] })

  // The migration is narrated, and the CA purge is offered as the detach
  // command, not performed: the CA is still on disk afterwards.
  const out = buf.text()
  assert.match(out, /Migrated from proxy attach/)
  assert.match(out, /keep proxying until they restart/)
  assert.match(out, /hyp detach claude --purge/)
  await fsp.access(ca.certPath)

  // The launchd unwind ran through the real seam. Under the test runner the
  // service-manager guard refuses the spawn (LLP 0181), which surfaces as the
  // by-hand warning; what matters here is that the attempt was made and the
  // attach still succeeded.
  if (process.platform === 'darwin') {
    assert.match(out, /launchd environment could not be released/)
    assert.match(out, /launchctl unsetenv NODE_USE_SYSTEM_CA/)
  }

  // hyp status answers from this same probe: the machine now reads as otel.
  const after = await probeClientAttachFromDescriptor({
    descriptor: CLAUDE_DESCRIPTOR,
    homeDir: r.root,
    env: r.env,
  })
  assert.equal(after.attached, true)
  assert.equal(after.mode, 'otel')
})

test('the migration facts ride the --json payload', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())
  await seedProxyAttach(r)

  const buf = makeBuf()
  await r.gateway.client.attach({ endpoint: ENDPOINT, stdout: buf, stderr: buf, json: true })

  const payload = JSON.parse(buf.text().trim().split('\n')[0])
  assert.equal(payload.status, 'ok')
  assert.equal(payload.mode, 'otel')
  assert.equal(payload.migrated_from, 'proxy')
  if (process.platform === 'darwin') {
    // The guard refused the real launchctl under the test runner, so the
    // unwind reports false rather than being silently absent.
    assert.equal(payload.launchd_env_removed, false)
  }
})

// The migration is only finished when the surface a human checks agrees. The
// probe above is one half of `hyp status`; this drives both halves end to end
// over the same machine, before and after the one command.
// @ref LLP 0262#migration [tests]: hyp status reflects the new attach mode after the migration
test('hyp status reads the migrated machine as otel-attached', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())
  await seedProxyAttach(r)

  assert.match(await statusClientLine(r), /- claude {2}\[configured, attached \(proxy\)\]/)

  const buf = makeBuf()
  await r.gateway.client.attach({ endpoint: ENDPOINT, stdout: buf, stderr: buf })

  assert.match(await statusClientLine(r), /- claude {2}\[configured, attached \(otel\)\]/)
})

// Below the floor the migration must not begin: the proxy attach keeps
// working exactly as it is, and no residue is unwound for a switch that never
// happened.
// @ref LLP 0258#version-floor [tests]: a refusal on a proxy-attached machine leaves the proxy attach byte for byte
test('a floor refusal leaves the proxy attach untouched and unwinds nothing', async (t) => {
  const r = await rig({ claudeVersion: '2.1.100' })
  t.after(() => r.cleanup())
  const ca = await seedProxyAttach(r)
  const before = await r.raw()

  const buf = makeBuf()
  await assert.rejects(
    () => r.gateway.client.attach({ endpoint: ENDPOINT, stdout: buf, stderr: buf }),
    /claude update/
  )
  assert.equal(await r.raw(), before)
  assert.equal((await r.read())._hypaware.mode, 'proxy')
  await fsp.access(ca.certPath)
  assert.doesNotMatch(buf.text(), /Migrated from proxy attach/)
  // The residue unwind is downstream of the settings write, so a refusal
  // never reaches it: on darwin an attempted release would have printed here.
  assert.doesNotMatch(buf.text(), /launchd/)
})

test('a re-attach after the migration is routine: no migration notes, no offer', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())
  await seedProxyAttach(r)

  const first = makeBuf()
  await r.gateway.client.attach({ endpoint: ENDPOINT, stdout: first, stderr: first })
  assert.match(first.text(), /Migrated from proxy attach/)

  const second = makeBuf()
  await r.gateway.client.attach({ endpoint: ENDPOINT, stdout: second, stderr: second })
  assert.doesNotMatch(second.text(), /Migrated from proxy attach/)
  assert.doesNotMatch(second.text(), /hyp detach claude --purge/)
  assert.doesNotMatch(second.text(), /launchd/)
  assert.equal((await r.read())._hypaware.mode, 'otel')
})

// Only a proxy attach has residue outside the settings file; a base-URL
// attach migrates through the mode-switch key release alone.
test('a base-URL attach switches to otel without migration notes', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())
  await writeSettings({
    port: GATEWAY_PORT,
    version: '2.0.0',
    stateFile: path.join(r.root, 'session-context.jsonl'),
    settingsPath: r.settingsPath,
    mode: MODE_BASE_URL,
  })

  const buf = makeBuf()
  await r.gateway.client.attach({ endpoint: ENDPOINT, stdout: buf, stderr: buf })

  const value = await r.read()
  assert.equal(value._hypaware.mode, 'otel')
  assert.equal(Object.hasOwn(value.env, 'ANTHROPIC_BASE_URL'), false)
  assert.doesNotMatch(buf.text(), /Migrated from proxy attach/)
  // No proxy attach means no residue, so the launchd environment is left
  // alone: a base-URL machine may never have had it set at all.
  assert.doesNotMatch(buf.text(), /launchd/)
})

test('the writer reports the prior marker mode for the adapter to act on', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())
  await seedProxyAttach(r)

  const result = await writeSettings({
    port: GATEWAY_PORT,
    version: '2.0.0',
    stateFile: path.join(r.root, 'session-context.jsonl'),
    settingsPath: r.settingsPath,
    mode: MODE_OTEL,
    telemetryPort: 4319,
    spoolDir: path.join(r.root, '.hyp', 'spool', 'claude-bodies'),
    claudeVersion: '2.1.233',
  })
  assert.equal(result.changed && result.priorMode, 'proxy')
})

test('a first attach reports no prior mode', async (t) => {
  const r = await rig()
  t.after(() => r.cleanup())

  const result = await writeSettings({
    port: GATEWAY_PORT,
    version: '2.0.0',
    stateFile: path.join(r.root, 'session-context.jsonl'),
    settingsPath: r.settingsPath,
    mode: MODE_OTEL,
    telemetryPort: 4319,
    spoolDir: path.join(r.root, '.hyp', 'spool', 'claude-bodies'),
    claudeVersion: '2.1.233',
  })
  assert.equal(result.changed && 'priorMode' in result, false)
})

// The unwind helper itself, with the launchctl seam injected: this is the
// deterministic proof the migration invokes the unwind on macOS and never
// touches launchctl anywhere else.
test('unwindProxyLaunchdEnv removes the launchd env on darwin', async () => {
  /** @type {unknown[]} */
  const calls = []
  const result = await unwindProxyLaunchdEnv({
    homeDir: '/tmp/some-home',
    platform: 'darwin',
    removeEnv: async (args) => {
      calls.push(args)
      return { unset: true, removedPlist: true }
    },
  })
  assert.deepEqual(result, { launchdEnvRemoved: true, warnings: [] })
  assert.deepEqual(calls, [{ homeDir: '/tmp/some-home' }])
})

test('unwindProxyLaunchdEnv never runs launchctl off darwin', async () => {
  const result = await unwindProxyLaunchdEnv({
    homeDir: '/tmp/some-home',
    platform: 'linux',
    removeEnv: async () => {
      throw new Error('must not be called')
    },
  })
  assert.deepEqual(result, { warnings: [] })
})

test('unwindProxyLaunchdEnv degrades a failed unset to the by-hand hint', async () => {
  const result = await unwindProxyLaunchdEnv({
    platform: 'darwin',
    removeEnv: async () => ({ unset: false, removedPlist: false, detail: 'exit 1' }),
  })
  assert.equal(result.launchdEnvRemoved, false)
  assert.match(result.warnings[0], /NODE_USE_SYSTEM_CA could not be unset/)
  assert.match(result.warnings[0], /exit 1/)
  assert.match(result.warnings[0], /launchctl unsetenv NODE_USE_SYSTEM_CA/)
})

test('unwindProxyLaunchdEnv degrades a thrown release to the by-hand hint', async () => {
  const result = await unwindProxyLaunchdEnv({
    platform: 'darwin',
    removeEnv: async () => {
      throw new Error('sandbox says no')
    },
  })
  assert.equal(result.launchdEnvRemoved, false)
  assert.match(result.warnings[0], /launchd environment could not be released/)
  assert.match(result.warnings[0], /sandbox says no/)
})

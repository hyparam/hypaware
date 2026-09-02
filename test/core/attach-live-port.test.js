// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'
import { probeClientAttachFromDescriptor } from '../../src/core/daemon/status.js'

/**
 * Issue #277 Gap 1: on a default ephemeral-port install the gateway binds a
 * port only the running daemon knows; the daemon persists it to
 * `<HYP_HOME>/hypaware/run/status.json` as `sources[].details.port`. Manual
 * `hyp attach` (gateway not in this CLI process, no configured `listen`) must
 * discover that live port and attach at it, instead of reporting
 * "already attached, nothing to do" / "cannot resolve the gateway endpoint".
 *
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
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

/**
 * Build a CommandRunContext whose gateway capability is live but unbound
 * (localEndpoint() throws) and whose config has no ai-gateway listen. The
 * adapter's `attach()` records the endpoint it was handed so the test can
 * assert the resolved port.
 *
 * @param {{
 *   home: string,
 *   attachCalls: Array<{ name: string, endpoint: string }>,
 *   skills?: { name: string, clients: string[], sourceDir: string }[],
 * }} opts
 */
function makeCtx({ home, attachCalls, skills }) {
  const gateway = {
    localEndpoint() {
      throw new Error('ai-gateway: localEndpoint() called before the gateway started')
    },
    /** @param {string} name */
    getClient(name) {
      return {
        name,
        /** @param {{ endpoint: string, json?: boolean, stdout: any }} ctx */
        async attach(ctx) {
          attachCalls.push({ name, endpoint: ctx.endpoint })
          if (ctx.json) {
            ctx.stdout.write(
              JSON.stringify({ status: 'ok', action: 'attach', client: name, changed: true }) + '\n'
            )
          }
        },
      }
    },
    listClients() {
      return [{ name: 'claude' }]
    },
  }
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: { version: 2 },
    capabilities: {
      has: () => true,
      require: () => gateway,
    },
    ...(skills ? { skills: { register() {}, list() { return skills } } } : {}),
  })
  return { ctx: /** @type {CommandRunContext} */ (ctx), stdout, stderr }
}

/**
 * Seed the daemon run dir (`<HYP_HOME>/hypaware/run`) with a live pid file
 * (this test process, guaranteed alive) and a status.json snapshot carrying
 * the gateway source's bound host/port.
 *
 * @param {string} home
 * @param {number} port
 * @param {{ pid?: number }} [opts]
 */
function seedDaemonRun(home, port, opts = {}) {
  const runDir = path.join(home, '.hyp', 'hypaware', 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    path.join(runDir, 'hypaware.pid'),
    JSON.stringify({ pid: opts.pid ?? process.pid, runId: 'test-run', mode: 'foreground' })
  )
  writeFileSync(
    path.join(runDir, 'status.json'),
    JSON.stringify({
      state: 'healthy',
      pid: opts.pid ?? process.pid,
      startedAt: new Date().toISOString(),
      uptimeMs: 0,
      runId: 'test-run',
      mode: 'foreground',
      sources: [
        {
          name: 'ai-gateway',
          plugin: '@hypaware/ai-gateway',
          state: 'started',
          details: { host: '127.0.0.1', port, upstreams: ['anthropic'] },
        },
      ],
      sinks: [],
    })
  )
}

/** @param {(home: string) => Promise<void> | void} fn */
async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-attach-live-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('attach discovers the daemon live port from status.json and attaches there (#277 Gap 1)', async () => {
  await withTempHome(async (home) => {
    seedDaemonRun(home, 55555)
    /** @type {Array<{ name: string, endpoint: string }>} */
    const attachCalls = []
    const { ctx, stderr } = makeCtx({ home, attachCalls })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.equal(attachCalls.length, 1, 'the adapter must attach at the discovered live port')
    assert.equal(attachCalls[0].endpoint, 'http://127.0.0.1:55555')
    assert.doesNotMatch(stderr.text(), /cannot resolve/)
  })
})

test('attach re-attaches when the recorded marker port is stale vs the live port (#277 Gap 1/2)', async () => {
  await withTempHome(async (home) => {
    // Marker on disk says port 40000; the daemon is now bound to 55555. A stale
    // marker must NOT report "nothing to do"; it must re-attach at 55555.
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ _hypaware: { version: '2.0.0', port: 40000 } })
    )
    seedDaemonRun(home, 55555)
    /** @type {Array<{ name: string, endpoint: string }>} */
    const attachCalls = []
    const { ctx, stdout, stderr } = makeCtx({ home, attachCalls })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.equal(attachCalls.length, 1, 'a stale-port marker must re-attach, not no-op')
    assert.equal(attachCalls[0].endpoint, 'http://127.0.0.1:55555')
    assert.doesNotMatch(stdout.text(), /nothing to do/)
  })
})

test('attach reports already-attached (no-op) when the recorded port matches the live port (#277 Gap 2)', async () => {
  await withTempHome(async (home) => {
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ _hypaware: { version: '2.0.0', port: 55555, mode: 'otel', settings_schema: 3 } })
    )
    seedDaemonRun(home, 55555)
    /** @type {Array<{ name: string, endpoint: string }>} */
    const attachCalls = []
    const { ctx, stdout } = makeCtx({ home, attachCalls })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0)
    assert.deepEqual(attachCalls, [], 'a marker already at the live port is a no-op')
    assert.match(stdout.text(), /already attached/)
  })
})

test('attach re-attaches a marker still recording managed.hooks, so the retired field migrates', async () => {
  await withTempHome(async (home) => {
    // Everything the already-attached branch normally looks at is current: the
    // live port, the OTEL mode, the asset set. Only the undo record's field
    // name is stale, and that is the field Claude Code 2.1.257 refuses the
    // whole settings file over, so the documented repair has to actually run
    // attach rather than report there was nothing to do.
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({
        _hypaware: {
          version: '2.0.0',
          port: 55555,
          mode: 'otel',
          managed: { env: {}, hooks: [{ event: 'SessionStart', command: 'hyp claude-hook session-context' }] },
        },
      })
    )
    seedDaemonRun(home, 55555)
    /** @type {Array<{ name: string, endpoint: string }>} */
    const attachCalls = []
    const { ctx, stdout, stderr } = makeCtx({ home, attachCalls })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.equal(attachCalls.length, 1, 'a retired-field marker must re-attach, not no-op')
    assert.equal(attachCalls[0].endpoint, 'http://127.0.0.1:55555')
    assert.doesNotMatch(stdout.text(), /already attached/)
  })
})

test('a marker already using managed.hook_entries stays a no-op', async () => {
  await withTempHome(async (home) => {
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({
        _hypaware: {
          version: '2.0.0',
          port: 55555,
          mode: 'otel',
          settings_schema: 3,
          managed: { env: {}, hook_entries: [{ event: 'SessionStart', command: 'hyp claude-hook session-context' }] },
        },
      })
    )
    seedDaemonRun(home, 55555)
    /** @type {Array<{ name: string, endpoint: string }>} */
    const attachCalls = []
    const { ctx, stdout } = makeCtx({ home, attachCalls })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0)
    assert.deepEqual(attachCalls, [], 'the current marker format is not drift')
    assert.match(stdout.text(), /already attached/)
  })
})

test('a schema-2 marker re-attaches into the scalar-safe backup format', async () => {
  await withTempHome(async (home) => {
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({
        _hypaware: {
          version: '2.0.0',
          port: 55555,
          mode: 'otel',
          settings_schema: 2,
          managed: { env: {}, hook_entries: [] },
          prev_malformed: { hooks: '"broken"' },
          prev_malformed_encoding: 'json',
        },
      })
    )
    seedDaemonRun(home, 55555)
    /** @type {Array<{ name: string, endpoint: string }>} */
    const attachCalls = []
    const { ctx, stdout } = makeCtx({ home, attachCalls })

    const code = await runAttach(['claude'], ctx)

    assert.equal(code, 0)
    assert.equal(attachCalls.length, 1)
    assert.doesNotMatch(stdout.text(), /already attached/)
  })
})

test('schema-less JSON markers are stale only for Claude', async () => {
  await withTempHome(async (home) => {
    mkdirSync(path.join(home, '.other'), { recursive: true })
    writeFileSync(
      path.join(home, '.other', 'settings.json'),
      JSON.stringify({ _managed: { version: '1.0.0', port: 55555 } })
    )
    const descriptor = /** @type {any} */ ({
      name: 'other-json-client',
      attachProbe: {
        format: 'json',
        settings_file: '.other/settings.json',
        marker_key: '_managed',
      },
    })

    const probe = await probeClientAttachFromDescriptor({ descriptor, homeDir: home })
    assert.equal(probe.attached, true)
    assert.equal(probe.port, '55555')
    assert.equal('markerFormatStale' in probe, false)
  })
})

test('attach installs client assets even when the settings are already attached (LLP 0107 every-attach)', async () => {
  await withTempHome(async (home) => {
    // The daemon-managed install is the shape an operator most often runs
    // `hyp attach` on, and it is the one that short-circuits at "already
    // attached". Short-circuiting past the materialization would make the
    // command install nothing on exactly that machine.
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ _hypaware: { version: '2.0.0', port: 55555, mode: 'otel', settings_schema: 3 } })
    )
    seedDaemonRun(home, 55555)
    const source = path.join(home, 'contrib', 'helper')
    mkdirSync(source, { recursive: true })
    writeFileSync(path.join(source, 'SKILL.md'), 'helper\n')

    /** @type {Array<{ name: string, endpoint: string }>} */
    const attachCalls = []
    const { ctx, stdout, stderr } = makeCtx({
      home,
      attachCalls,
      skills: [{ name: 'helper', clients: ['claude'], sourceDir: source }],
    })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.deepEqual(attachCalls, [], 'the settings are still left alone')
    assert.equal(
      readFileSync(path.join(home, '.claude', 'skills', 'helper', 'SKILL.md'), 'utf8'),
      'helper\n',
      'the assets are installed even though there was nothing to wire'
    )
    assert.doesNotMatch(stdout.text(), /nothing to do/)
  })
})

test('attach does NOT trust a dead daemon status.json (liveness gate) (#277 Gap 1)', async () => {
  await withTempHome(async (home) => {
    // A status.json exists but the recorded pid is dead: the port is stale and
    // must not be used. With no marker present the command falls through to the
    // actionable "cannot resolve" error rather than attaching at a dead port.
    seedDaemonRun(home, 55555, { pid: 2147483646 /* not a live pid */ })
    /** @type {Array<{ name: string, endpoint: string }>} */
    const attachCalls = []
    const { ctx, stderr } = makeCtx({ home, attachCalls })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.deepEqual(attachCalls, [], 'a dead daemon endpoint must never be used')
    assert.match(stderr.text(), /cannot resolve the gateway endpoint/)
  })
})

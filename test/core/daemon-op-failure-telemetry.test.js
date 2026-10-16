// @ts-check

/**
 * `withDaemonOp` opens every `daemon.<op>` span with `status: 'ok'` in the
 * attribute bag, and a daemon operation that throws used to end with the
 * span status set to error while that attribute still read `ok`. An LDD
 * query filtering on the attribute counted the failure as a success
 * (issue #2342).
 *
 * Asserted on the captured spans, because the return value and the log line
 * were already right while the span attribute was not.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installDaemon, uninstallDaemon } from '../../src/core/daemon/install.js'
import { LaunchAgentError, plistPathFor } from '../../src/core/daemon/macos.js'
import { SpanStatusCode, TracerProvider } from '../../src/core/observability/runtime.js'
import { runRoot } from '../../src/core/observability/span_helpers.js'

const LABEL = 'com.hypaware.test.agent'
const OK = { exitCode: 0, stdout: '', stderr: '' }

/**
 * Collect the spans exported while `fn` runs, then put the global tracer
 * provider slot back. Mirrors `test/helpers/log_records.js` for traces: a
 * provider left installed captures the next test's spans into a dead array.
 *
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<{ spans: any[], thrown: unknown }>}
 */
async function captureSpans(fn) {
  /** @type {any[]} */
  const spans = []
  const provider = new TracerProvider({
    resource: { attributes: {} },
    exporters: [{ exportBatch: (/** @type {any[]} */ batch) => { spans.push(...batch) } }],
  })
  provider.register()
  /** @type {unknown} */
  let thrown
  try {
    await fn()
  } catch (err) {
    thrown = err
  } finally {
    await provider.shutdown()
  }
  return { spans, thrown }
}

/**
 * Fake launchctl, scripted by `print` exit code with the last entry
 * repeating, so a test can say "loaded forever" or "loaded once then gone".
 * Nothing here reaches a real launchd domain.
 *
 * @param {{ print?: number[], bootout?: { exitCode: number, stdout: string, stderr: string } }} script
 */
function fakeLaunchctl(script) {
  const printQ = script.print ?? [1]
  let i = 0
  return {
    print() { return Promise.resolve({ exitCode: printQ[Math.min(i++, printQ.length - 1)], stdout: '', stderr: '' }) },
    bootout() { return Promise.resolve(script.bootout ?? OK) },
    bootstrap() { return Promise.resolve(OK) },
    kickstart() { return Promise.resolve(OK) },
  }
}

/** @returns {string} */
function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-daemon-op-span-'))
}

/**
 * @param {string} plistDir
 * @returns {string} the path of the service file an earlier install left
 */
function seedPlist(plistDir) {
  fs.mkdirSync(plistDir, { recursive: true })
  const plistPath = plistPathFor(plistDir, LABEL)
  fs.writeFileSync(plistPath, '<plist/>\n')
  return plistPath
}

/** @param {any[]} spans @param {string} name */
function spanNamed(spans, name) {
  const found = spans.find((s) => s.name === name)
  assert.ok(found, `the run emitted a ${name} span`)
  return found
}

test('a failed daemon operation does not leave a status=ok attribute on its span', async () => {
  const home = tmpHome()
  const plistDir = path.join(home, 'LaunchAgents')
  seedPlist(plistDir)
  // Loaded before the bootout and still loaded after it: the unload is never
  // confirmed, so `uninstallLaunchAgent` throws.
  const launchctl = fakeLaunchctl({ print: [0], bootout: { exitCode: 1, stdout: '', stderr: 'bootout refused' } })

  const { spans, thrown } = await captureSpans(() => uninstallDaemon({
    platform: 'darwin',
    homeDir: home,
    plistDir,
    label: LABEL,
    launchctl,
    userDomain: 'gui/501',
    sleep: async function() {},
  }))

  assert.ok(thrown instanceof LaunchAgentError, 'the uninstall failed')
  const span = spanNamed(spans, 'daemon.uninstall')
  assert.equal(span.status.code, SpanStatusCode.ERROR, 'the span itself records the failure')
  assert.equal(span.attributes.status, 'failed', 'no attribute claims the failed operation succeeded')
  assert.equal(span.attributes.error_kind, 'unhandled_exception')
})

test('a successful daemon operation still records status=ok and no error_kind', async () => {
  const home = tmpHome()
  const plistDir = path.join(home, 'LaunchAgents')
  const plistPath = seedPlist(plistDir)
  // Loaded on the pre-check, gone on the next probe: the unload is confirmed.
  const launchctl = fakeLaunchctl({ print: [0, 1] })

  const { spans, thrown } = await captureSpans(() => uninstallDaemon({
    platform: 'darwin',
    homeDir: home,
    plistDir,
    label: LABEL,
    launchctl,
    userDomain: 'gui/501',
    sleep: async function() {},
  }))

  assert.equal(thrown, undefined, 'the uninstall succeeded')
  assert.equal(fs.existsSync(plistPath), false, 'the service file was removed')
  const span = spanNamed(spans, 'daemon.uninstall')
  assert.equal(span.status.code, SpanStatusCode.OK)
  assert.equal(span.attributes.status, 'ok')
  assert.equal(span.attributes.error_kind, undefined, 'a clean run carries no error_kind')
})

test('a daemon operation that fails after its partial work still reports failed', async () => {
  const home = tmpHome()
  const plistDir = path.join(home, 'LaunchAgents')
  // Never bootstrapped, so the install writes the plist and bootstraps, and
  // `print` then never reports a pid: the job is registered on disk and the
  // operation fails anyway.
  const launchctl = fakeLaunchctl({ print: [113, 0] })

  const { spans, thrown } = await captureSpans(() => installDaemon({
    platform: 'darwin',
    homeDir: home,
    plistDir,
    logDir: path.join(home, 'logs'),
    configPath: path.join(home, 'hypaware-config.json'),
    label: LABEL,
    binPath: '/x/bin/hypaware.js',
    binExplicit: true,
    nodePath: '/x/node',
    launchctl,
    userDomain: 'gui/501',
    sleep: async function() {},
  }))

  assert.ok(thrown instanceof LaunchAgentError, 'the install failed after writing the service file')
  assert.equal(fs.existsSync(plistPathFor(plistDir, LABEL)), true, 'the partial work landed')
  const span = spanNamed(spans, 'daemon.install')
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(span.attributes.status, 'failed')
  assert.equal(span.attributes.error_kind, 'unhandled_exception')
})

/**
 * A daemon operation runs underneath a boot or a top-level command, and those
 * open their span through `runRoot` rather than `withSpan`. The two helpers
 * carry separate copies of the same catch, so the guarantee above is only
 * half-pinned until the root helper is exercised too.
 */
test('a root span whose body throws reports failed, like the nested helper', async () => {
  const boom = new Error('boot step refused')

  const { spans, thrown } = await captureSpans(() => runRoot(
    'command.run',
    { hyp_command: 'daemon', status: 'ok' },
    async () => { throw boom }
  ))

  assert.equal(thrown, boom, 'the throw reaches the caller unchanged')
  const span = spanNamed(spans, 'command.run')
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(span.attributes.status, 'failed')
  assert.equal(span.attributes.error_kind, 'unhandled_exception')
})

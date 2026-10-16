// @ts-check

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// `hyp status` on darwin with a CA on disk shells out twice: `security
// verify-cert` and `launchctl getenv`. Neither had a deadline, and
// `runServiceCommand` only ever settled on the child's `close`, so a probe
// that never returned was not a caught error, it was a `hyp status` that
// printed nothing and never exited. macOS trust evaluation can reach the
// network for revocation, so an offline or captive-portal host on a
// proxy-mode install is the realistic trigger.
//
// Both facts under test are about a real spawned child that really does not
// return, so both are proved in a child process: the guard of LLP 0181 refuses
// every spawn inside the test runner, and a fake child would prove nothing
// about killing a real one. The scripts below are named `.mjs` and run with no
// `--test`, with `NODE_TEST_CONTEXT` deleted, so the guard is legitimately
// inactive in them rather than switched off.
//
// @ref LLP 0237#consequences [tests]: the trust line is reported, or reported
//   unknown, but never at the cost of the report
// @ref LLP 0181#the-guard [constrained-by]: the spawn seam refuses inside the
//   test runner, so a real hanging child has to be driven from outside it

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** @param {string} rel */
function moduleUrl(rel) {
  return pathToFileURL(path.join(REPO_ROOT, rel)).href
}

/** @param {(dir: string) => void} fn */
function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-svc-timeout-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Write an executable shell stub that never returns, the shape of the failure
 * this file exists for. `sleep` is a grandchild holding the pipe the wrapper
 * inherited, so a kill of the stub alone does not close it: exactly the case
 * that makes waiting for `close` after the kill the wrong move.
 *
 * @param {string} binDir
 * @param {string} name
 */
function writeHangingStub(binDir, name) {
  const stub = path.join(binDir, name)
  writeFileSync(stub, '#!/bin/sh\nsleep 600\n')
  chmodSync(stub, 0o755)
  return stub
}

/**
 * Run a script outside the test runner and report how it went. `spawnSync`'s
 * own timeout is the backstop that turns "the code under test hangs" into a
 * failed assertion instead of a wedged suite.
 *
 * @param {string} script
 * @param {{ pathPrefix?: string, timeout?: number }} [opts]
 */
function runOutsideTestRunner(script, opts = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.HYP_ALLOW_REAL_SERVICE_MANAGER
  if (opts.pathPrefix) env.PATH = `${opts.pathPrefix}${path.delimiter}${env.PATH ?? ''}`
  const run = spawnSync(process.execPath, [script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    timeout: opts.timeout ?? 60_000,
  })
  return {
    status: run.status,
    signal: run.signal,
    stdout: run.stdout ?? '',
    output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
  }
}

test('a service command that never returns is killed at its deadline, and the caller still exits', () => {
  withTempDir((dir) => {
    const binDir = path.join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const hanging = writeHangingStub(binDir, 'hangs')

    const script = path.join(dir, 'timeout-probe.mjs')
    writeFileSync(script, [
      `import { runServiceCommand } from ${JSON.stringify(moduleUrl('src/core/daemon/service_ops.js'))}`,
      'const startedAt = Date.now()',
      'let name = null',
      'try {',
      `  await runServiceCommand(${JSON.stringify(hanging)}, [], { timeoutMs: 250 })`,
      '  name = "resolved"',
      '} catch (err) {',
      '  name = err instanceof Error ? err.name : String(err)',
      '}',
      'process.stdout.write(JSON.stringify({ name, elapsedMs: Date.now() - startedAt }))',
      // No process.exit: the run only ends here if the killed child and its
      // pipes stopped holding the event loop open, which is half the fix.
      '',
    ].join('\n'))

    const run = runOutsideTestRunner(script, { timeout: 20_000 })
    assert.equal(
      run.signal,
      null,
      'the probe never returned and nothing bounded it: hyp status would hang exactly like this',
    )
    assert.equal(run.status, 0, run.output)
    const result = JSON.parse(run.stdout)
    assert.equal(result.name, 'ServiceCommandTimeoutError', run.output)
    assert.ok(result.elapsedMs < 10_000, `expected the deadline to settle it, waited ${result.elapsedMs}ms`)
  })
})

// The end-to-end shape of the report: real `collectHypAwareStatus`, real
// probes, real spawn, against a `security` that never answers. The trust line
// reads unknown, and every other line is still rendered.
test('hyp status still renders when the darwin trust probe never returns', () => {
  withTempDir((dir) => {
    const binDir = path.join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeHangingStub(binDir, 'security')
    // Only the trust probe hangs: `launchctl` answers at once, so its own line
    // stays a real answer and the assertion below is about the hanging one.
    const launchctl = path.join(binDir, 'launchctl')
    writeFileSync(launchctl, '#!/bin/sh\nexit 1\n')
    chmodSync(launchctl, 0o755)

    const script = path.join(dir, 'status-probe.mjs')
    writeFileSync(script, [
      "import fs from 'node:fs'",
      "import path from 'node:path'",
      `import { collectHypAwareStatus } from ${JSON.stringify(moduleUrl('src/core/daemon/status.js'))}`,
      `import { ensureLocalCa } from ${JSON.stringify(moduleUrl('src/core/tls/ca.js'))}`,
      `import { defaultConfigPath } from ${JSON.stringify(moduleUrl('src/core/config/schema.js'))}`,
      `const hypHome = ${JSON.stringify(path.join(dir, 'home'))}`,
      "const stateRoot = path.join(hypHome, 'hypaware')",
      "fs.mkdirSync(path.join(stateRoot, 'run'), { recursive: true })",
      'fs.writeFileSync(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + "\\n")',
      "const ca = await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com'] })",
      'const startedAt = Date.now()',
      'const report = await collectHypAwareStatus({',
      "  env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },",
      "  platform: 'darwin',",
      '  isLaunchAgentInstalled: () => false,',
      '  isSystemdUnitInstalled: () => false,',
      '})',
      'process.stdout.write(JSON.stringify({',
      '  elapsedMs: Date.now() - startedAt,',
      '  fingerprintMatches: report.proxyTrust?.caFingerprint === ca.fingerprint,',
      '  trusted: report.proxyTrust?.trusted ?? null,',
      '  launchdEnvSet: report.proxyTrust?.launchdEnvSet ?? null,',
      '  overall: report.overall,',
      '}))',
      // The report is what is under test, so end the run once it is printed
      // rather than make this case depend on every handle the collector opens.
      'process.exit(0)',
      '',
    ].join('\n'))

    const run = runOutsideTestRunner(script, { pathPrefix: binDir, timeout: 60_000 })
    assert.equal(
      run.signal,
      null,
      'hyp status hung on an unbounded macOS trust probe instead of rendering a report',
    )
    assert.equal(run.status, 0, run.output)
    const result = JSON.parse(run.stdout)
    assert.equal(result.trusted, null, 'a probe that never answered is unknown, never "not trusted"')
    assert.equal(result.launchdEnvSet, false, 'the probe that did answer still reports its answer')
    assert.equal(result.fingerprintMatches, true, 'the rest of the proxy-trust line is still rendered')
    assert.equal(result.overall, 'healthy', 'an unknown trust line is not an outage')
  })
})

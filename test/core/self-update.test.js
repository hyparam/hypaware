// @ts-check

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  applySelfUpdate,
  classifySelfProvenance,
  compareSemver,
  describeSelfUpdate,
  previousBootLooksStuck,
  readSelfUpdateState,
  resolveRegistryUrl,
  runSelfUpdatePass,
  SELF_UPDATE_RESTART_EXIT_CODE,
  shouldCheckNow,
  writeSelfUpdateState,
} from '../../src/core/update/self_update.js'
import { DAEMON_RESTART_EXIT_CODE } from '../../src/core/daemon/runtime.js'
import { parseConfigShape } from '../../src/core/config/schema.js'
import { mergeConfigLayers } from '../../src/core/config/merge.js'

const HOUR_MS = 60 * 60 * 1000

test('the updater restart code matches the daemon restart exit code', () => {
  assert.equal(SELF_UPDATE_RESTART_EXIT_CODE, DAEMON_RESTART_EXIT_CODE)
})

test('compareSemver orders releases and prereleases', () => {
  assert.ok(compareSemver('1.26.0', '1.25.3') > 0)
  assert.ok(compareSemver('1.25.0', '1.25.1') < 0)
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0)
  assert.ok(compareSemver('1.25.0-rc.1', '1.25.0') < 0)
  assert.ok(compareSemver('1.25.0', '1.25.0-rc.1') > 0)
  assert.equal(compareSemver('not-a-version', '1.0.0'), 0)
})

test('resolveRegistryUrl honors npm_config_registry, strips trailing slash, ignores junk', () => {
  assert.equal(resolveRegistryUrl({}), 'https://registry.npmjs.org')
  assert.equal(
    resolveRegistryUrl({ npm_config_registry: 'https://npm.corp.example/' }),
    'https://npm.corp.example'
  )
  assert.equal(resolveRegistryUrl({ npm_config_registry: 'file:///nope' }), 'https://registry.npmjs.org')
})

test('classifySelfProvenance tells npx, checkout, and global-like roots apart', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-provenance-'))
  try {
    const npxRoot = path.join(dir, 'cache', '_npx', 'abc', 'node_modules', 'hypaware')
    assert.equal(classifySelfProvenance({ packageRoot: npxRoot, env: {} }), 'npx')

    const checkoutRoot = path.join(dir, 'code', 'hypaware')
    await fsp.mkdir(path.join(checkoutRoot, '.git'), { recursive: true })
    assert.equal(classifySelfProvenance({ packageRoot: checkoutRoot, env: {} }), 'checkout')

    const bareRoot = path.join(dir, 'somewhere', 'hypaware')
    await fsp.mkdir(bareRoot, { recursive: true })
    assert.equal(classifySelfProvenance({ packageRoot: bareRoot, env: {} }), 'checkout')

    const globalRoot = path.join(dir, 'prefix', 'lib', 'node_modules', 'hypaware')
    await fsp.mkdir(globalRoot, { recursive: true })
    assert.equal(classifySelfProvenance({ packageRoot: globalRoot, env: {} }), 'global-candidate')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('shouldCheckNow: daily normally, hourly when the last boot looked stuck', () => {
  const nowMs = Date.parse('2026-08-24T12:00:00Z')
  assert.equal(shouldCheckNow({ state: {}, nowMs, eager: false }), true)
  const fresh = { checked_at: new Date(nowMs - 2 * HOUR_MS).toISOString() }
  assert.equal(shouldCheckNow({ state: fresh, nowMs, eager: false, jitter: 0 }), false)
  const stale = { checked_at: new Date(nowMs - 25 * HOUR_MS).toISOString() }
  assert.equal(shouldCheckNow({ state: stale, nowMs, eager: false, jitter: 0 }), true)
  // Jitter stretches the daily interval: 25h old is not yet due at full jitter (30h).
  assert.equal(shouldCheckNow({ state: stale, nowMs, eager: false, jitter: 1 }), false)
  // Eager: the same 2h-old check is already stale.
  assert.equal(shouldCheckNow({ state: fresh, nowMs, eager: true }), true)
  assert.equal(shouldCheckNow({ state: { checked_at: 'garbage' }, nowMs, eager: false }), true)
})

test('previousBootLooksStuck only for a status file frozen at starting', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-stuck-'))
  try {
    assert.equal(previousBootLooksStuck(dir), false)
    const runDir = path.join(dir, 'run')
    await fsp.mkdir(runDir, { recursive: true })
    await fsp.writeFile(path.join(runDir, 'status.json'), JSON.stringify({ state: 'starting' }))
    assert.equal(previousBootLooksStuck(dir), true)
    await fsp.writeFile(path.join(runDir, 'status.json'), JSON.stringify({ state: 'healthy' }))
    assert.equal(previousBootLooksStuck(dir), false)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('state writes merge instead of clobbering the cached flag', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-state-'))
  try {
    writeSelfUpdateState(dir, { auto_update: false })
    writeSelfUpdateState(dir, { checked_at: '2026-08-24T00:00:00.000Z', latest_version: '9.9.9' })
    const state = readSelfUpdateState(dir)
    assert.equal(state.auto_update, false)
    assert.equal(state.latest_version, '9.9.9')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

/**
 * Build a fake global install: `<dir>/prefix/lib/node_modules/hypaware`
 * with a package.json, plus a runner whose `npm config get prefix`
 * answers with that prefix and whose install succeeds.
 *
 * @param {string} dir
 * @param {{ installExit?: number, prefix?: string }} [opts]
 */
async function fakeGlobalInstall(dir, opts = {}) {
  const prefix = opts.prefix ?? path.join(dir, 'prefix')
  const packageRoot = path.join(prefix, 'lib', 'node_modules', 'hypaware')
  await fsp.mkdir(packageRoot, { recursive: true })
  await fsp.writeFile(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'hypaware', version: '1.0.0' })
  )
  /** @type {string[][]} */
  const calls = []
  /** @type {import('../../src/core/cli/types.js').CommandRunner} */
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (args[0] === 'config') {
      return { exitCode: 0, stdout: `${path.join(dir, 'prefix')}\n`, stderr: '' }
    }
    return { exitCode: opts.installExit ?? 0, stdout: '', stderr: '' }
  }
  return { packageRoot, runner, calls }
}

/** @param {string} version */
function fetchStub(version) {
  let called = 0
  /** @type {typeof fetch} */
  // @ts-expect-error minimal Response shape
  const impl = async () => {
    called += 1
    return { ok: true, status: 200, json: async () => ({ version }) }
  }
  return { impl, calledCount: () => called }
}

test('runSelfUpdatePass applies a newer release from a global install', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-pass-'))
  try {
    const { packageRoot, runner, calls } = await fakeGlobalInstall(dir)
    const probe = fetchStub('1.1.0')
    const result = await runSelfUpdatePass({
      stateRoot: dir,
      env: {},
      packageRoot,
      runner,
      fetchImpl: probe.impl,
    })
    assert.equal(result.action, 'updated')
    assert.equal(result.latest, '1.1.0')
    assert.deepEqual(calls.at(-1), ['npm', 'install', '-g', 'hypaware@1.1.0'])
    const state = readSelfUpdateState(dir)
    assert.equal(state.last_apply?.ok, true)
    assert.equal(state.available, false)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('runSelfUpdatePass records an up-to-date probe and respects the TTL after it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-ttl-'))
  try {
    const { packageRoot, runner } = await fakeGlobalInstall(dir)
    const probe = fetchStub('1.0.0')
    const first = await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot, runner, fetchImpl: probe.impl, jitter: 0,
    })
    assert.equal(first.action, 'checked')
    assert.equal(readSelfUpdateState(dir).available, false)
    const second = await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot, runner, fetchImpl: probe.impl, jitter: 0,
    })
    assert.equal(second.action, 'none')
    assert.equal(probe.calledCount(), 1)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('runSelfUpdatePass never probes from a checkout, and the off switch holds', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-guard-'))
  try {
    const checkoutRoot = path.join(dir, 'code', 'hypaware')
    await fsp.mkdir(path.join(checkoutRoot, '.git'), { recursive: true })
    await fsp.writeFile(
      path.join(checkoutRoot, 'package.json'),
      JSON.stringify({ name: 'hypaware', version: '1.0.0' })
    )
    const probe = fetchStub('9.9.9')
    const skipped = await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot: checkoutRoot, fetchImpl: probe.impl,
    })
    assert.equal(skipped.action, 'skipped')
    assert.equal(skipped.reason, 'checkout')
    assert.equal(probe.calledCount(), 0)

    writeSelfUpdateState(dir, { auto_update: false })
    const off = await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot: checkoutRoot, fetchImpl: probe.impl,
    })
    assert.equal(off.action, 'skipped')
    assert.equal(off.reason, 'auto_update_off')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a probe failure degrades to a recorded error, never a throw', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-probe-fail-'))
  try {
    const { packageRoot, runner } = await fakeGlobalInstall(dir)
    /** @type {typeof fetch} */
    const failing = async () => { throw new Error('boom') }
    const result = await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot, runner, fetchImpl: failing,
    })
    assert.equal(result.action, 'checked')
    assert.equal(result.reason, 'probe_failed')
    assert.match(readSelfUpdateState(dir).error ?? '', /probe_failed/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('applySelfUpdate refuses when the running root is not the npm global install', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-apply-guard-'))
  try {
    const { runner } = await fakeGlobalInstall(dir)
    const elsewhere = path.join(dir, 'elsewhere', 'node_modules', 'hypaware')
    await fsp.mkdir(elsewhere, { recursive: true })
    const refused = await applySelfUpdate({
      name: 'hypaware', version: '1.1.0', packageRoot: elsewhere, env: {}, runner, platform: 'darwin',
    })
    assert.deepEqual(refused, { applied: false, reason: 'not_global_install' })
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a failed npm install lands on the state file as a degraded notice', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-apply-fail-'))
  try {
    const { packageRoot, runner } = await fakeGlobalInstall(dir, { installExit: 1 })
    const probe = fetchStub('1.1.0')
    const result = await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot, runner, fetchImpl: probe.impl,
    })
    assert.equal(result.action, 'checked')
    assert.equal(result.reason, 'npm_install_failed')
    const state = readSelfUpdateState(dir)
    assert.equal(state.last_apply?.ok, false)
    assert.match(state.error ?? '', /apply_failed/)
    const described = describeSelfUpdate({ stateRoot: dir, env: {} })
    assert.match(described.line ?? '', /degraded/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('describeSelfUpdate: quiet when healthy, loud when off or an update waits', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-describe-'))
  try {
    assert.equal(describeSelfUpdate({ stateRoot: dir, env: {} }).line, null)
    writeSelfUpdateState(dir, { auto_update: false })
    assert.match(describeSelfUpdate({ stateRoot: dir, env: {} }).line ?? '', /off/)
    writeSelfUpdateState(dir, { auto_update: true, available: true, latest_version: '99.0.0' })
    assert.match(describeSelfUpdate({ stateRoot: dir, env: {} }).line ?? '', /99\.0\.0 available/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('config: auto_update parses as a boolean and central wins the merge', () => {
  const ok = parseConfigShape({ version: 2, auto_update: false })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.config.auto_update, false)

  const bad = parseConfigShape({ version: 2, auto_update: 'yes' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.errors[0].pointer, '/auto_update')

  const central = /** @type {const} */ ({ version: 2, auto_update: false })
  const local = /** @type {const} */ ({ version: 2, auto_update: true })
  assert.equal(mergeConfigLayers(/** @type {any} */ (central), /** @type {any} */ (local)).effective.auto_update, false)
  assert.equal(mergeConfigLayers(null, /** @type {any} */ (local)).effective.auto_update, true)
  assert.equal(mergeConfigLayers(/** @type {any} */ ({ version: 2 }), /** @type {any} */ (local)).effective.auto_update, true)
})

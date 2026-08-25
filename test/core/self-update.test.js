// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  acquireApplyLock,
  applySelfUpdate,
  APPLY_LOCK_STALE_MS,
  classifySelfProvenance,
  compareSemver,
  describeSelfUpdate,
  NPM_KILL_GRACE_MS,
  NPM_TIMEOUT_MS,
  previousBootLooksStuck,
  readLocalConfigAutoUpdate,
  readSelfUpdateState,
  resolveRegistryUrl,
  runSelfUpdatePass,
  SELF_UPDATE_RESTART_EXIT_CODE,
  shouldCheckNow,
  withNodeBinOnPath,
  writeSelfUpdateState,
} from '../../src/core/update/self_update.js'
import { DAEMON_RESTART_EXIT_CODE } from '../../src/core/daemon/runtime.js'
import { CONFIG_BASENAME, parseConfigShape } from '../../src/core/config/schema.js'
import { mergeConfigLayers } from '../../src/core/config/merge.js'

/**
 * @import { CommandRunner } from '../../src/core/cli/types.js'
 */

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

test('previousBootLooksStuck for a boot that died mid-way or threw out of bootKernel', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-stuck-'))
  try {
    assert.equal(previousBootLooksStuck(dir), false)
    const runDir = path.join(dir, 'run')
    await fsp.mkdir(runDir, { recursive: true })
    const statusPath = path.join(runDir, 'status.json')
    await fsp.writeFile(statusPath, JSON.stringify({ state: 'starting' }))
    assert.equal(previousBootLooksStuck(dir), true)
    await fsp.writeFile(statusPath, JSON.stringify({ state: 'healthy' }))
    assert.equal(previousBootLooksStuck(dir), false)
    // The runtime catches a bootKernel throw and records it as degraded
    // with a boot_failed warning, which is the shape a broken release
    // actually leaves behind most of the time.
    await fsp.writeFile(
      statusPath,
      JSON.stringify({ state: 'degraded', warnings: ['boot_failed: kaboom'] })
    )
    assert.equal(previousBootLooksStuck(dir), true)
    // A degraded kernel with a failed source is not a stuck boot: no
    // release fixes it, so it must not buy an hourly registry probe.
    await fsp.writeFile(
      statusPath,
      JSON.stringify({ state: 'degraded', warnings: ['source_failed: claude'] })
    )
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
 * @param {{ installExit?: number, prefix?: string, installWritesVersion?: boolean }} [opts]
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
  /** @type {CommandRunner} */
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (args[0] === 'config') {
      return { exitCode: 0, stdout: `${path.join(dir, 'prefix')}\n`, stderr: '' }
    }
    const exitCode = opts.installExit ?? 0
    // A real `npm install -g` replaces the package directory. The updater
    // reads the version back off disk before it claims success, so the
    // fake has to move too or it is not testing the same thing.
    if (exitCode === 0 && opts.installWritesVersion !== false) {
      const version = String(args[args.length - 1]).split('@').pop()
      await fsp.writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'hypaware', version })
      )
    }
    return { exitCode, stdout: '', stderr: '' }
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

test('before the first boot caches the flag, auto_update: false in the local config binds', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-preboot-off-'))
  try {
    // Mirror the real layout: stateRoot is `<HYP_HOME>/hypaware`, the
    // config file its sibling `<HYP_HOME>/hypaware-config.json`.
    const stateRoot = path.join(dir, 'hypaware')
    await fsp.mkdir(stateRoot, { recursive: true })
    const configPath = path.join(dir, CONFIG_BASENAME)
    await fsp.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false }))

    const { packageRoot, runner } = await fakeGlobalInstall(dir)
    const probe = fetchStub('9.9.9')
    const off = await runSelfUpdatePass({
      stateRoot, env: {}, packageRoot, runner, fetchImpl: probe.impl,
    })
    assert.equal(off.action, 'skipped')
    assert.equal(off.reason, 'auto_update_off')
    assert.equal(probe.calledCount(), 0)

    // The daemon-cached effective flag wins over the local file: central
    // may have overridden a local false, and the cache carries the merge.
    writeSelfUpdateState(stateRoot, { auto_update: true })
    const on = await runSelfUpdatePass({
      stateRoot, env: {}, packageRoot, runner, fetchImpl: probe.impl,
    })
    assert.equal(on.action, 'updated')

    // HYP_CONFIG relocates the file; a corrupt or flagless file is not an
    // answer and leaves the default in force.
    const altPath = path.join(dir, 'alt-config.json')
    await fsp.writeFile(altPath, JSON.stringify({ version: 2, auto_update: false }))
    assert.equal(readLocalConfigAutoUpdate({ stateRoot, env: { HYP_CONFIG: altPath } }), false)
    await fsp.writeFile(configPath, 'not json')
    assert.equal(readLocalConfigAutoUpdate({ stateRoot, env: {} }), undefined)
    await fsp.writeFile(configPath, JSON.stringify({ version: 2 }))
    assert.equal(readLocalConfigAutoUpdate({ stateRoot, env: {} }), undefined)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('the pre-boot lane honors the --config the service unit was launched with', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-preboot-cfg-'))
  try {
    // Both installers render `--config <path>` into the service unit, so a
    // non-default config is the ordinary shape, not an exotic one. The
    // default path is deliberately left absent here: if the lane read it
    // instead, the pass would probe and apply.
    const stateRoot = path.join(dir, 'hypaware')
    await fsp.mkdir(stateRoot, { recursive: true })
    const unitConfig = path.join(dir, 'elsewhere', 'hypaware-config.json')
    await fsp.mkdir(path.dirname(unitConfig), { recursive: true })
    await fsp.writeFile(unitConfig, JSON.stringify({ version: 2, auto_update: false }))

    const { packageRoot, runner } = await fakeGlobalInstall(dir)
    const probe = fetchStub('9.9.9')
    const off = await runSelfUpdatePass({
      stateRoot, env: {}, configPath: unitConfig, packageRoot, runner, fetchImpl: probe.impl,
    })
    assert.equal(off.action, 'skipped')
    assert.equal(off.reason, 'auto_update_off')
    assert.equal(probe.calledCount(), 0)

    // Same precedence as `resolveConfigPath`: the explicit flag outranks
    // HYP_CONFIG, which outranks the default beside the state root.
    const envPath = path.join(dir, 'env-config.json')
    await fsp.writeFile(envPath, JSON.stringify({ version: 2, auto_update: true }))
    assert.equal(
      readLocalConfigAutoUpdate({ stateRoot, env: { HYP_CONFIG: envPath }, configPath: unitConfig }),
      false
    )
    assert.equal(readLocalConfigAutoUpdate({ stateRoot, env: { HYP_CONFIG: envPath } }), true)

    // Without the flag the lane looks beside the state root, finds nothing,
    // and the default carries the pass through to an apply.
    const on = await runSelfUpdatePass({
      stateRoot, env: {}, packageRoot, runner, fetchImpl: probe.impl,
    })
    assert.equal(on.action, 'updated')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('an unreadable config or status file is no answer, never a throw', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-unreadable-'))
  try {
    const stateRoot = path.join(dir, 'hypaware')
    await fsp.mkdir(path.join(stateRoot, 'run'), { recursive: true })
    // A directory where a file belongs raises EISDIR, not ENOENT. A throw
    // escaping here would take the whole pass down on a machine the
    // pre-boot lane exists to repair, so both readers must absorb it.
    await fsp.mkdir(path.join(dir, CONFIG_BASENAME), { recursive: true })
    await fsp.mkdir(path.join(stateRoot, 'run', 'status.json'), { recursive: true })
    assert.equal(readLocalConfigAutoUpdate({ stateRoot, env: {} }), undefined)
    assert.equal(previousBootLooksStuck(stateRoot), false)
    // And the state file itself: `describeSelfUpdate` reads it inside
    // `hyp status`, which has no guard of its own around the call.
    await fsp.mkdir(path.join(stateRoot, 'run', 'self-update.json'), { recursive: true })
    assert.deepEqual(readSelfUpdateState(stateRoot), {})
    assert.equal(describeSelfUpdate({ stateRoot, env: {} }).json.auto_update, true)
    await fsp.rmdir(path.join(stateRoot, 'run', 'self-update.json'))

    const { packageRoot, runner } = await fakeGlobalInstall(dir)
    const probe = fetchStub('9.9.9')
    const result = await runSelfUpdatePass({
      stateRoot, env: {}, packageRoot, runner, fetchImpl: probe.impl,
    })
    assert.equal(result.action, 'updated')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('hyp status reports the off switch from config before a boot has cached it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-status-off-'))
  try {
    const stateRoot = path.join(dir, 'hypaware')
    await fsp.mkdir(stateRoot, { recursive: true })
    await fsp.writeFile(
      path.join(dir, CONFIG_BASENAME),
      JSON.stringify({ version: 2, auto_update: false })
    )
    // Status must not say the switch is on while the pass is already
    // honoring the off: same precedence on both sides.
    const off = describeSelfUpdate({ stateRoot, env: {} })
    assert.match(String(off.line), /self-update: off/)
    assert.equal(off.json.auto_update, false)

    // The cached effective flag still wins, here and in the updater.
    writeSelfUpdateState(stateRoot, { auto_update: true })
    const on = describeSelfUpdate({ stateRoot, env: {} })
    assert.equal(on.json.auto_update, true)
    assert.equal(on.line, null)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('npm runs with the node bin directory on PATH, not the service manager default', async () => {
  // launchd hands a user agent `/usr/bin:/bin:/usr/sbin:/sbin`, which has
  // neither Homebrew nor nvm on it, and neither service-file writer
  // renders an environment block. A bare `npm` would be ENOENT there.
  const nodeBin = path.dirname(process.execPath)
  const launchd = withNodeBinOnPath({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
  assert.equal(launchd.PATH?.split(path.delimiter)[0], nodeBin)
  assert.ok(launchd.PATH?.includes('/usr/bin'))
  // An empty environment still gets the directory, and an entry already
  // in front is left alone rather than duplicated.
  assert.equal(withNodeBinOnPath({}).PATH, nodeBin)
  const already = withNodeBinOnPath({ PATH: `${nodeBin}:/usr/bin` })
  assert.equal(already.PATH, `${nodeBin}:/usr/bin`)
  assert.equal(withNodeBinOnPath({ PATH: `/usr/bin:${nodeBin}` }).PATH, `${nodeBin}:/usr/bin`)

  // And the apply actually uses it.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-path-'))
  try {
    const { packageRoot } = await fakeGlobalInstall(dir)
    /** @type {NodeJS.ProcessEnv[]} */
    const envs = []
    /** @type {CommandRunner} */
    const runner = async (cmd, args, opts) => {
      envs.push(opts.env ?? {})
      if (args[0] === 'config') return { exitCode: 0, stdout: `${path.join(dir, 'prefix')}\n`, stderr: '' }
      await fsp.writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'hypaware', version: '1.1.0' })
      )
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const applied = await applySelfUpdate({
      name: 'hypaware', version: '1.1.0', packageRoot, runner, env: { PATH: '/usr/bin:/bin' },
    })
    assert.equal(applied.applied, true)
    assert.equal(envs.length, 2)
    for (const env of envs) assert.equal(env.PATH?.split(path.delimiter)[0], nodeBin)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('the apply lock outlives the longest legitimate hold and releases only its own', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-lock-life-'))
  try {
    const lockPath = path.join(dir, 'run', 'self-update.lock')
    // `applySelfUpdate` runs two npm commands, each capped at the npm
    // timeout plus the SIGKILL grace. A stale window below that sum lets a
    // second process steal a live holder's lock and start the concurrent
    // `npm install -g` the lock exists to prevent.
    assert.ok(APPLY_LOCK_STALE_MS > 2 * (NPM_TIMEOUT_MS + NPM_KILL_GRACE_MS))

    const release = acquireApplyLock(dir)
    assert.ok(release)
    assert.equal(acquireApplyLock(dir), null)

    // Simulate the reclaim-and-steal: another process replaces the file.
    // The original holder's release must leave that lock alone.
    await fsp.writeFile(lockPath, JSON.stringify({ token: 'someone-else', pid: 1 }))
    release()
    assert.equal(JSON.parse(await fsp.readFile(lockPath, 'utf8')).token, 'someone-else')

    await fsp.rm(lockPath)
    const second = acquireApplyLock(dir)
    assert.ok(second)
    second()
    assert.equal(fs.existsSync(lockPath), false)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('status stops advertising an update the running version already satisfies', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-avail-'))
  try {
    // A manual `npm install -g` satisfies a pending update without
    // clearing the flag the last probe wrote, and the next probe may be a
    // day away.
    writeSelfUpdateState(dir, { available: true, latest_version: '1.1.0' })
    const stale = describeSelfUpdate({ stateRoot: dir, env: {} })
    assert.equal(stale.json.available, false)
    assert.equal(stale.line, null)

    writeSelfUpdateState(dir, { available: true, latest_version: '99.0.0' })
    const real = describeSelfUpdate({ stateRoot: dir, env: {} })
    assert.equal(real.json.available, true)
    assert.match(String(real.line), /99\.0\.0 available/)
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

test('an npm install that exits 0 without replacing the root is not a success', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-noop-install-'))
  try {
    const { packageRoot, runner } = await fakeGlobalInstall(dir, { installWritesVersion: false })
    const result = await applySelfUpdate({
      name: 'hypaware', version: '1.1.0', packageRoot, env: {}, runner, platform: 'darwin',
    })
    assert.deepEqual(result, { applied: false, reason: 'version_not_installed' })
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a held apply lock stops a second process from racing npm install -g', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-lock-'))
  try {
    const held = acquireApplyLock(dir)
    assert.ok(held)
    assert.equal(acquireApplyLock(dir), null)

    const { packageRoot, runner, calls } = await fakeGlobalInstall(dir)
    const probe = fetchStub('1.1.0')
    const blocked = await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot, runner, fetchImpl: probe.impl,
    })
    assert.equal(blocked.action, 'checked')
    assert.equal(blocked.reason, 'apply_locked')
    assert.ok(!calls.some((c) => c.includes('install')))

    held?.()
    const after = acquireApplyLock(dir)
    assert.ok(after)
    after?.()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

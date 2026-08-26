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
  PROBE_QUIET_MS,
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

test('resolveRegistryUrl trusts http only on this machine', () => {
  // A local Verdaccio over http is a normal dev and test setup and stays
  // honored, brackets and all.
  for (const local of [
    'http://localhost:4873',
    'http://127.0.0.1:4873',
    'http://127.1.2.3:4873',
    'http://[::1]:4873',
  ]) {
    assert.equal(resolveRegistryUrl({ npm_config_registry: local + '/' }), local)
  }
  // Off-box plain http is not believed: the probe's answer decides
  // whether this install ever updates again. It degrades to the public
  // registry, the same place a .npmrc-only private registry already
  // probes, rather than to a spoofable "you are already current".
  for (const remote of [
    'http://npm.corp.example',
    'http://npm.corp.example:8080/path',
    'http://192.168.1.9:4873',
    'http://localhost.evil.example',
  ]) {
    assert.equal(resolveRegistryUrl({ npm_config_registry: remote }), 'https://registry.npmjs.org')
  }
  assert.equal(
    resolveRegistryUrl({ npm_config_registry: 'https://npm.corp.example' }),
    'https://npm.corp.example'
  )
})

test('a *.localhost registry over plain http is not on this machine on the strength of its name', () => {
  // RFC 6761 says a resolver must send `*.localhost` to loopback, but
  // glibc without systemd-resolved asks DNS anyway, so a hostile search
  // domain plus someone on the path turns `http://npm.localhost` into an
  // off-box registry whose answer decides whether this install ever
  // updates again. Only the literal name and the IP literals are decided
  // from the name alone.
  for (const suffixed of [
    'http://npm.localhost',
    'http://npm.localhost:4873',
    'http://evil.localhost.',
  ]) {
    assert.equal(
      resolveRegistryUrl({ npm_config_registry: suffixed }),
      'https://registry.npmjs.org',
      suffixed
    )
  }
  // The refusal is the narrow one: over https the same host is fine
  // (nobody on the path can answer for it), and plain `localhost` is
  // still the ordinary local-Verdaccio setup.
  assert.equal(
    resolveRegistryUrl({ npm_config_registry: 'https://npm.localhost' }),
    'https://npm.localhost'
  )
  assert.equal(
    resolveRegistryUrl({ npm_config_registry: 'http://localhost:4873' }),
    'http://localhost:4873'
  )
})

test('the loopback set is matched in the form URL leaves it in', () => {
  // `URL` re-serializes an IPv4-mapped literal in hex, so a spelling
  // check on the raw text refuses a mapped-loopback Verdaccio that is
  // plainly on this machine; a trailing root dot names the same host and
  // survives parsing. Both fail closed, so this is a usability fix, not
  // a hole.
  assert.equal(
    resolveRegistryUrl({ npm_config_registry: 'http://[::ffff:127.0.0.1]:4873' }),
    'http://[::ffff:7f00:1]:4873'
  )
  assert.equal(
    resolveRegistryUrl({ npm_config_registry: 'http://[::ffff:127.1.2.3]' }),
    'http://[::ffff:7f01:203]'
  )
  assert.equal(
    resolveRegistryUrl({ npm_config_registry: 'http://localhost./' }),
    'http://localhost.'
  )
  // Mapped is not a way off the machine: only 127.0.0.0/8 in a v6 coat
  // counts, and a mapped public address stays refused.
  for (const remote of ['http://[::ffff:8.8.8.8]', 'http://[::ffff:192.168.1.9]']) {
    assert.equal(
      resolveRegistryUrl({ npm_config_registry: remote }),
      'https://registry.npmjs.org',
      remote
    )
  }
})

test('a registry override npm could never speak is not trusted onto a loopback host', () => {
  // The loopback check answers "is this host on my machine"; it is not a
  // licence for any scheme that reaches one. npm talks http or https to a
  // registry, and `fetch` refuses the rest, so honoring one of these would
  // swap a working default for a permanently failing probe - which, with a
  // probe failure now kept out of the status line, would fail in silence.
  for (const scheme of ['ftp', 'ws', 'file', 'gopher']) {
    assert.equal(
      resolveRegistryUrl({ npm_config_registry: `${scheme}://localhost:4873` }),
      'https://registry.npmjs.org'
    )
  }
  // The trusted plain-http case is untouched by that guard.
  assert.equal(
    resolveRegistryUrl({ npm_config_registry: 'http://localhost:4873' }),
    'http://localhost:4873'
  )
})

test('a trusted override comes back normalized, not echoed', () => {
  // `new URL` accepts shapes the old `/^https?:\/\//` guard rejected, and
  // returning one verbatim builds a probe address that can only fail.
  // What comes back has to be a URL `fetch` will actually take.
  assert.equal(resolveRegistryUrl({ npm_config_registry: 'https:evil' }), 'https://evil')
  assert.equal(
    resolveRegistryUrl({ npm_config_registry: 'HTTPS://NPM.corp.example' }),
    'https://npm.corp.example'
  )
  // Normalization is not a way into the loopback set: it runs on the
  // parsed hostname, so every spelling that reaches 127.0.0.1 was already
  // on this machine, and one that only looks like it is still refused.
  for (const spelling of ['http://127.1', 'http://0x7f.0.0.1', 'http://2130706433']) {
    assert.equal(resolveRegistryUrl({ npm_config_registry: spelling }), 'http://127.0.0.1')
  }
  assert.equal(
    resolveRegistryUrl({ npm_config_registry: 'http://evil.example#.localhost' }),
    'https://registry.npmjs.org'
  )
})

test('dropping an untrusted registry override is logged, not silent', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-log-'))
  try {
    const { packageRoot, runner } = await fakeGlobalInstall(dir)
    /** @type {string[]} */
    const urls = []
    /** @type {Array<{ event: string, fields: Record<string, unknown> }>} */
    const logged = []
    /** @type {typeof fetch} */
    // @ts-expect-error minimal Response shape
    const probe = async (url) => {
      urls.push(String(url))
      return { ok: true, status: 200, json: async () => ({ version: '1.0.0' }) }
    }
    /** @type {(event: string, fields?: Record<string, unknown>) => void} */
    const log = (event, fields) => { logged.push({ event, fields: fields ?? {} }) }

    // An override that is dropped: the probe silently asks a different
    // registry than the operator configured, and the answer decides
    // whether this install ever updates. That decision belongs in a log.
    await runSelfUpdatePass({
      stateRoot: dir,
      env: { npm_config_registry: 'http://npm.corp.example:8080' },
      packageRoot,
      runner,
      fetchImpl: probe,
      log,
    })
    const ignored = logged.filter((l) => l.event === 'self_update.registry_override_ignored')
    assert.equal(ignored.length, 1)
    assert.equal(ignored[0]?.fields.ignored_origin, 'http://npm.corp.example:8080')
    assert.equal(ignored[0]?.fields.probing, 'https://registry.npmjs.org')
    assert.ok(urls[0]?.startsWith('https://registry.npmjs.org/'))

    // Credentials in the override never reach the log line.
    const withSecret = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-secret-'))
    logged.length = 0
    await runSelfUpdatePass({
      stateRoot: withSecret,
      env: { npm_config_registry: 'http://bot:hunter2@npm.corp.example' },
      packageRoot,
      runner,
      fetchImpl: probe,
      log,
    })
    const redacted = logged.filter((l) => l.event === 'self_update.registry_override_ignored')
    assert.equal(redacted.length, 1)
    assert.equal(redacted[0]?.fields.ignored_origin, 'http://npm.corp.example')
    assert.ok(!JSON.stringify(logged).includes('hunter2'))
    await fsp.rm(withSecret, { recursive: true, force: true })

    // A trusted override is honored, so there is nothing to report.
    const honored = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-ok-'))
    logged.length = 0
    urls.length = 0
    await runSelfUpdatePass({
      stateRoot: honored,
      env: { npm_config_registry: 'http://localhost:4873/' },
      packageRoot,
      runner,
      fetchImpl: probe,
      log,
    })
    assert.equal(logged.filter((l) => l.event === 'self_update.registry_override_ignored').length, 0)
    assert.ok(urls[0]?.startsWith('http://localhost:4873/'))
    await fsp.rm(honored, { recursive: true, force: true })
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
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

test('an offline probe failure stays out of the status text and in the json', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-probe-quiet-'))
  try {
    const { packageRoot, runner } = await fakeGlobalInstall(dir)
    /** @type {typeof fetch} */
    const offline = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') }
    const result = await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot, runner, fetchImpl: offline,
    })
    assert.equal(result.reason, 'probe_failed')
    // A laptop on a plane must not grow a degraded line on every status.
    const described = describeSelfUpdate({ stateRoot: dir, env: {} })
    assert.equal(described.line, null)
    assert.match(String(described.json.error), /^probe_failed/)

    // An apply failure is a real, sticky problem and still speaks up.
    writeSelfUpdateState(dir, { error: 'apply_failed: npm_install_failed' })
    assert.match(describeSelfUpdate({ stateRoot: dir, env: {} }).line ?? '', /degraded/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('an unrecognized pass option cannot silently suppress the apply', async () => {
  // `apply: false` was a dead affordance no caller ever set; it is gone,
  // and nothing in the option bag may quietly turn an update into a
  // no-op again.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-no-apply-opt-'))
  try {
    const { packageRoot, runner, calls } = await fakeGlobalInstall(dir)
    const probe = fetchStub('1.1.0')
    const result = await runSelfUpdatePass(/** @type {any} */ ({
      stateRoot: dir, env: {}, packageRoot, runner, fetchImpl: probe.impl, apply: false,
    }))
    assert.equal(result.action, 'updated')
    assert.ok(calls.some((c) => c.includes('install')))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('an unusable run directory is a real error, not "another update is already running"', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-lock-broken-'))
  try {
    // A plain file where the run directory belongs. The lock can never be
    // taken here and no rival process exists to blame, so reporting this
    // as contention sends an operator hunting a process that is not there.
    const wrongType = path.join(dir, 'wrong-type')
    await fsp.mkdir(wrongType, { recursive: true })
    await fsp.writeFile(path.join(wrongType, 'run'), 'not a directory')
    assert.throws(() => acquireApplyLock(wrongType), /ENOTDIR|EEXIST|ENOENT/)

    // And a run directory this user cannot write: the lock open fails
    // EACCES, which is this machine's problem, not another process's.
    const readOnly = path.join(dir, 'read-only')
    await fsp.mkdir(path.join(readOnly, 'run'), { recursive: true })
    await fsp.chmod(path.join(readOnly, 'run'), 0o555)
    try {
      let writable = false
      try {
        fs.closeSync(fs.openSync(path.join(readOnly, 'run', 'probe'), 'wx'))
        writable = true
      } catch { /* the permission bits bite, as intended */ }
      // Running as root ignores the bits; then there is nothing to assert.
      if (!writable) assert.throws(() => acquireApplyLock(readOnly), /EACCES|EPERM|EROFS/)
    } finally {
      await fsp.chmod(path.join(readOnly, 'run'), 0o755)
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('lock contention still reads as contention, and still fails closed', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-lock-eexist-'))
  try {
    const held = acquireApplyLock(dir)
    assert.ok(held)
    assert.equal(acquireApplyLock(dir), null)
    held?.()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a state file with a non-string error renders instead of taking hyp status down', async () => {
  // `readSelfUpdateState` is total by construction and validates no field
  // type, because `describeSelfUpdate` runs inside `hyp status` with no
  // guard of its own. A prefix test against whatever JSON.parse returned
  // is a TypeError waiting for a hand-edited or truncated state file, and
  // it would take the whole status report down with it.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-bad-error-'))
  try {
    await fsp.mkdir(path.join(dir, 'run'), { recursive: true })
    await fsp.writeFile(
      path.join(dir, 'run', 'self-update.json'),
      JSON.stringify({ error: 42 })
    )
    const described = describeSelfUpdate({ stateRoot: dir, env: {} })
    assert.match(described.line ?? '', /degraded \(42\)/)
    assert.equal(described.json.error, 42)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a probe that has been failing for a week stops being quiet', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-probe-entrenched-'))
  try {
    const { packageRoot, runner } = await fakeGlobalInstall(dir)
    /** @type {typeof fetch} */
    const offline = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') }
    const start = new Date('2026-01-01T00:00:00.000Z')
    await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot, runner, fetchImpl: offline, now: () => start,
    })
    assert.equal(readSelfUpdateState(dir).error_since, start.toISOString())

    // A second failure a day later does not restart the clock: `checked_at`
    // moves, `error_since` does not, and the line stays quiet.
    const day = new Date(start.getTime() + 24 * 60 * 60 * 1000)
    await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot, runner, fetchImpl: offline, force: true, now: () => day,
    })
    assert.equal(readSelfUpdateState(dir).error_since, start.toISOString())
    assert.equal(readSelfUpdateState(dir).checked_at, day.toISOString())
    const quiet = describeSelfUpdate({ stateRoot: dir, env: {}, now: () => day })
    assert.equal(quiet.line, null)
    // The quiet defers diagnosis to `--json`, so `--json` has to carry
    // what decides how long the quiet lasts, not only the error.
    assert.equal(quiet.json.error_since, start.toISOString())

    // Past the reprieve it is not a flight, it is an updater that will
    // never run again, and LLP 0309#cli-surface puts that in status.
    const later = new Date(start.getTime() + PROBE_QUIET_MS + 1)
    const loud = describeSelfUpdate({ stateRoot: dir, env: {}, now: () => later })
    assert.match(loud.line ?? '', /degraded \(probe_failed/)

    // And a probe that comes back clears the run, so the next failure
    // starts its own reprieve rather than inheriting this one.
    const probe = fetchStub('1.0.0')
    await runSelfUpdatePass({
      stateRoot: dir, env: {}, packageRoot, runner, fetchImpl: probe.impl, force: true, now: () => later,
    })
    assert.equal(readSelfUpdateState(dir).error_since, undefined)
    assert.equal(describeSelfUpdate({ stateRoot: dir, env: {}, now: () => later }).line, null)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('an ignored registry override cannot steer the install either', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-apply-'))
  try {
    const { packageRoot } = await fakeGlobalInstall(dir)
    /** @type {Array<NodeJS.ProcessEnv | undefined>} */
    const envs = []
    /** @type {CommandRunner} */
    const runner = async (cmd, args, opts) => {
      envs.push(opts.env)
      if (args[0] === 'config') {
        return { exitCode: 0, stdout: `${path.join(dir, 'prefix')}\n`, stderr: '' }
      }
      const version = String(args[args.length - 1]).split('@').pop()
      await fsp.writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'hypaware', version })
      )
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const probe = fetchStub('1.1.0')
    // npm reads `npm_config_registry` from the environment as happily as
    // the probe did, so handing the raw environment to `npm install -g`
    // would pull the tarball from the very host the probe rejected. But
    // the answer is not to pin the child to the public registry either:
    // an org whose override names an internal mirror publishes its own
    // build there, and a pinned install would silently swap it for the
    // public one. Not knowing where the bytes belong means not
    // installing.
    const applied = await runSelfUpdatePass({
      stateRoot: dir,
      env: { npm_config_registry: 'http://npm.corp.example' },
      packageRoot,
      runner,
      fetchImpl: probe.impl,
    })
    assert.equal(applied.action, 'checked')
    assert.equal(applied.reason, 'registry_untrusted')
    assert.equal(applied.latest, '1.1.0')
    // No npm child ran at all, so nothing was fetched from anywhere.
    assert.deepEqual(envs, [])
    // And the refusal is sticky state, not only a log line: an install
    // that can no longer update itself says so in `hyp status`.
    assert.equal(readSelfUpdateState(dir).error, 'registry_untrusted')
    assert.match(
      describeSelfUpdate({ stateRoot: dir, env: {} }).line ?? '',
      /degraded \(registry_untrusted\)/
    )

    // With no override in the environment the env is passed through
    // untouched, so an `.npmrc`-configured private registry keeps serving
    // the install exactly as it did before any of this.
    const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-plain-'))
    envs.length = 0
    await fsp.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'hypaware', version: '1.0.0' })
    )
    await runSelfUpdatePass({
      stateRoot: plain, env: {}, packageRoot, runner, fetchImpl: fetchStub('1.1.0').impl,
    })
    assert.ok(envs.length > 0)
    for (const env of envs) {
      assert.equal(Object.prototype.hasOwnProperty.call(env ?? {}, 'npm_config_registry'), false)
    }
    await fsp.rm(plain, { recursive: true, force: true })
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a trusted override is honored end to end, and its credentials never reach a log', async () => {
  // "Was the override dropped" is the trust decision, not a string
  // comparison of the raw value against the resolved one. `URL.href`
  // normalizes - an explicit `:443` disappears, a host lowercases, an
  // IDN becomes punycode - so comparing strings reports a *trusted*
  // override as ignored. That is a false alarm on its own, and because
  // the resolved form of a trusted override is the operator's own URL,
  // the "probing" field it reports is their registry password. Both
  // `hyp update` and the pre-boot daemon lane forward this event
  // straight to stderr.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-trusted-'))
  try {
    const { packageRoot, runner } = await fakeGlobalInstall(dir)
    /** @type {string[]} */
    const urls = []
    /** @type {typeof fetch} */
    // @ts-expect-error minimal Response shape
    const probe = async (url) => {
      urls.push(String(url))
      return { ok: true, status: 200, json: async () => ({ version: '1.0.0' }) }
    }
    for (const spelling of [
      'https://bot:hunter2@npm.corp.example:443',
      'https://bot:hunter2@NPM.corp.example',
      'https://bot:hunter2@npm.corp.example',
    ]) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-trusted-case-'))
      /** @type {Array<{ event: string, fields: Record<string, unknown> }>} */
      const logged = []
      urls.length = 0
      await runSelfUpdatePass({
        stateRoot: root,
        env: { npm_config_registry: spelling },
        packageRoot,
        runner,
        fetchImpl: probe,
        log: (event, fields) => { logged.push({ event, fields: fields ?? {} }) },
      })
      // Trusted means honored: the probe went to the operator's registry,
      // so there is nothing to report as ignored.
      assert.ok(urls[0]?.startsWith('https://bot:hunter2@npm.corp.example/'), spelling)
      assert.deepEqual(
        logged.filter((l) => l.event === 'self_update.registry_override_ignored'),
        [],
        spelling
      )
      assert.ok(!JSON.stringify(logged).includes('hunter2'), spelling)
      await fsp.rm(root, { recursive: true, force: true })
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('npm reads the registry override case-insensitively, and so does the guard', async () => {
  // `@npmcli/config` matches its environment variables with
  // `/^npm_config_/i`, so `NPM_CONFIG_REGISTRY` steers `npm install -g`
  // exactly as the lowercase spelling does. A guard that reads only the
  // lowercase name probes the public registry, sees no override to drop,
  // hands the environment to npm untouched, and npm pulls the tarball
  // from the plaintext host - the split the pin exists to close, reached
  // by shift key alone.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-case-'))
  try {
    const { packageRoot } = await fakeGlobalInstall(dir)
    /** @type {Array<NodeJS.ProcessEnv | undefined>} */
    const envs = []
    /** @type {CommandRunner} */
    const runner = async (cmd, args, opts) => {
      envs.push(opts.env)
      if (args[0] === 'config') {
        return { exitCode: 0, stdout: `${path.join(dir, 'prefix')}\n`, stderr: '' }
      }
      const version = String(args[args.length - 1]).split('@').pop()
      await fsp.writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'hypaware', version })
      )
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    /** @param {NodeJS.ProcessEnv} env */
    const pass = async (env) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-case-run-'))
      await fsp.writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'hypaware', version: '1.0.0' })
      )
      envs.length = 0
      /** @type {string[]} */
      const urls = []
      /** @type {typeof fetch} */
      // @ts-expect-error minimal Response shape
      const probe = async (url) => {
        urls.push(String(url))
        return { ok: true, status: 200, json: async () => ({ version: '1.1.0' }) }
      }
      const result = await runSelfUpdatePass({
        stateRoot: root, env, packageRoot, runner, fetchImpl: probe,
      })
      await fsp.rm(root, { recursive: true, force: true })
      return { result, urls, envs: envs.slice() }
    }

    // Untrusted under the uppercase spelling: probed at the default, and
    // the apply is refused rather than run against a registry the
    // operator never named. A guard blind to the spelling would instead
    // see no override, install, and let npm read the plaintext host.
    const upper = await pass({ NPM_CONFIG_REGISTRY: 'http://npm.corp.example' })
    assert.equal(upper.result.action, 'checked')
    assert.equal(upper.result.reason, 'registry_untrusted')
    assert.ok(upper.urls[0]?.startsWith('https://registry.npmjs.org/'))
    assert.deepEqual(upper.envs, [])

    // Trusted under the uppercase spelling: honored by the probe and
    // installed from, which is what keeps the refusal from stranding an
    // operator who happens to shout the variable name.
    const trusted = await pass({ NPM_CONFIG_REGISTRY: 'https://npm.corp.example' })
    assert.equal(trusted.result.action, 'updated')
    assert.ok(trusted.urls[0]?.startsWith('https://npm.corp.example/'))
    assert.ok(trusted.envs.length > 0)
    for (const env of trusted.envs) {
      assert.equal(env?.NPM_CONFIG_REGISTRY, 'https://npm.corp.example')
    }

    // Two spellings disagreeing have no precedence npm defines, so
    // neither is believed and nothing is installed.
    const conflict = await pass({
      npm_config_registry: 'https://npm.corp.example',
      NPM_CONFIG_REGISTRY: 'http://evil.example',
    })
    assert.equal(conflict.result.reason, 'registry_untrusted')
    assert.ok(conflict.urls[0]?.startsWith('https://registry.npmjs.org/'))
    assert.deepEqual(conflict.envs, [])

    // An override set to empty is not an override: npm skips it, so
    // nothing is dropped and the update goes through untouched.
    const empty = await pass({ npm_config_registry: '' })
    assert.equal(empty.result.action, 'updated')
    assert.ok(empty.urls[0]?.startsWith('https://registry.npmjs.org/'))
    for (const env of empty.envs) {
      assert.equal(env?.npm_config_registry, '')
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('going offline does not silence an apply failure that was already speaking', async () => {
  // A failed apply is sticky: an EACCES global prefix, a refused
  // registry. It does not heal by itself and it was already rendering a
  // degraded line. The offline reprieve is for a probe failure, and a
  // probe failure overwriting `error` would inherit that reprieve for
  // the sticky failure too, taking a permanently broken updater off the
  // status line for a week - the one case LLP 0309#cli-surface most
  // wants heard.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-sticky-'))
  try {
    const { packageRoot } = await fakeGlobalInstall(dir)
    /** @type {CommandRunner} */
    const failingInstall = async (cmd, args) => {
      if (args[0] === 'config') {
        return { exitCode: 0, stdout: `${path.join(dir, 'prefix')}\n`, stderr: '' }
      }
      return { exitCode: 1, stdout: '', stderr: 'EACCES' }
    }
    const start = new Date('2026-01-01T00:00:00.000Z')
    await runSelfUpdatePass({
      stateRoot: dir,
      env: {},
      packageRoot,
      runner: failingInstall,
      fetchImpl: fetchStub('1.1.0').impl,
      now: () => start,
    })
    assert.equal(readSelfUpdateState(dir).error, 'apply_failed: npm_install_failed')
    assert.match(
      describeSelfUpdate({ stateRoot: dir, env: {}, now: () => start }).line ?? '',
      /degraded \(apply_failed/
    )

    // Now the machine goes offline. The probe failure is real, but it
    // does not get to speak over a failure that is still outstanding.
    /** @type {typeof fetch} */
    const offline = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') }
    const later = new Date(start.getTime() + 60 * 60 * 1000)
    await runSelfUpdatePass({
      stateRoot: dir,
      env: {},
      packageRoot,
      runner: failingInstall,
      fetchImpl: offline,
      force: true,
      now: () => later,
    })
    const state = readSelfUpdateState(dir)
    assert.equal(state.error, 'apply_failed: npm_install_failed')
    assert.equal(state.error_since, undefined)
    assert.equal(state.checked_at, later.toISOString())
    assert.match(
      describeSelfUpdate({ stateRoot: dir, env: {}, now: () => later }).line ?? '',
      /degraded \(apply_failed/
    )

    // A probe that comes back clears the sticky error and the apply is
    // retried, so nothing here makes a real failure permanent.
    const healed = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-sticky-heal-'))
    await fsp.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'hypaware', version: '1.0.0' })
    )
    const { runner: workingInstall } = await fakeGlobalInstall(dir)
    const result = await runSelfUpdatePass({
      stateRoot: healed,
      env: {},
      packageRoot,
      runner: workingInstall,
      fetchImpl: fetchStub('1.1.0').impl,
      now: () => later,
    })
    assert.equal(result.action, 'updated')
    assert.equal(readSelfUpdateState(healed).error, undefined)
    await fsp.rm(healed, { recursive: true, force: true })
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("a credentialed registry's token does not survive a failed probe into state, status, or the log", async () => {
  // `resolveRegistryUrl` trusts a credentialed https override, and Node's
  // `fetch` then refuses it with a message that quotes the whole URL back,
  // userinfo included. That message is persisted as `probe_failed:`, read
  // out by `hyp status`, and logged as `self_update.probe_failed`, so
  // failing once copies an operator's registry password into three durable
  // places. The real global `fetch` is used deliberately: it is the source
  // of the message, and it refuses a credentialed URL before any DNS or
  // socket, so this stays offline and deterministic.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-creds-'))
  try {
    const { packageRoot, runner } = await fakeGlobalInstall(dir)
    /** @type {Array<{ event: string, fields: Record<string, unknown> }>} */
    const logged = []
    const result = await runSelfUpdatePass({
      stateRoot: dir,
      env: { npm_config_registry: 'https://bot:hunter2@npm.corp.example' },
      packageRoot,
      runner,
      log: (event, fields) => { logged.push({ event, fields: fields ?? {} }) },
    })
    assert.equal(result.reason, 'probe_failed')

    const state = readSelfUpdateState(dir)
    const error = String(state.error)
    assert.match(error, /^probe_failed/)
    assert.ok(!error.includes('hunter2'), error)
    assert.ok(!error.includes('bot:'), error)
    // Redacted, not blanked: which registry went wrong is the whole point
    // of recording the failure at all.
    assert.match(error, /npm\.corp\.example/)

    const probeFailures = logged.filter((l) => l.event === 'self_update.probe_failed')
    assert.equal(probeFailures.length, 1)
    assert.ok(!JSON.stringify(probeFailures).includes('hunter2'), JSON.stringify(probeFailures))

    // A probe failure is quiet for a week; past that it reaches the
    // status line, which is the third place the token would land.
    const later = new Date(Date.parse(String(state.error_since)) + PROBE_QUIET_MS + 1000)
    const described = describeSelfUpdate({ stateRoot: dir, env: {}, now: () => later })
    assert.match(described.line ?? '', /degraded \(probe_failed/)
    assert.ok(!(described.line ?? '').includes('hunter2'), described.line ?? '')
    assert.ok(!JSON.stringify(described.json).includes('hunter2'), JSON.stringify(described.json))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('the degraded line for a refused registry does not hand back the refused registry', async () => {
  // Every other degraded error ends in "run it by hand". For
  // `registry_untrusted` that advice reads the same `npm_config_registry`
  // the updater just declined to fetch a tarball from, so following the
  // status line performs the cross-registry swap the refusal exists to
  // prevent.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-self-registry-advice-'))
  try {
    writeSelfUpdateState(dir, { error: 'registry_untrusted' })
    const line = describeSelfUpdate({ stateRoot: dir, env: {} }).line ?? ''
    assert.match(line, /degraded \(registry_untrusted\)/)
    assert.ok(!line.includes('npm install -g'), line)
    assert.match(line, /npm_config_registry/)
    assert.match(line, /https URL/)

    // Every other error keeps the generic advice, which is right for them.
    writeSelfUpdateState(dir, { error: 'apply_failed: npm exited 1' })
    const generic = describeSelfUpdate({ stateRoot: dir, env: {} }).line ?? ''
    assert.match(generic, /degraded \(apply_failed: npm exited 1\)/)
    assert.match(generic, /npm install -g .+@latest/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

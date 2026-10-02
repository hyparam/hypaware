// @ts-check

// Issue #2443. `bootKernel` resolves the env a caller injected
// (`opts.env ?? process.env`) and uses it for config resolution and
// observability, but `activatePlugins` had no `env` parameter to hand it to, so
// `createActivationContext` fell back to its `env ?? process.env` default and
// every plugin's `ctx.env` was the ambient process environment no matter what
// the caller injected.
//
// A dozen bundled plugins read `ctx.env`, and `@hypaware/local-fs` is the one
// with a visible footprint: it resolves its BlobStore base from
// `ctx.env.HYP_HOME` and `mkdir`s it in `activate()`, so a caller booting with
// an injected HYP_HOME still created `~/.hyp/exports` in the real home.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch, activatePluginDependencyClosure } from '../../src/core/cli/dispatch.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { activatePlugins } from '../../src/core/runtime/loader.js'
import { bootKernel } from '../../src/core/runtime/boot.js'

/** @param {string} p */
async function exists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

test('activatePlugins hands the injected env to each activation context', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-env-plugin-'))
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-env-state-'))
  const seen = path.join(stateRoot, 'seen.txt')
  await fs.writeFile(
    path.join(rootDir, 'index.js'),
    'import fs from \'node:fs/promises\'\n' +
    'export async function activate(ctx) {\n' +
    `  await fs.writeFile(${JSON.stringify(seen)}, String(ctx.env.HYP_TEST_MARKER))\n` +
    '}\n'
  )
  const manifest = /** @type {any} */ ({
    schema_version: 1,
    name: '@acme/env-reader',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  })

  try {
    const cacheRoot = path.join(stateRoot, 'cache')
    const { results, runtime } = await activatePlugins({
      plugins: [{ manifest, rootDir, config: {} }],
      stateRoot,
      runId: 'env-forwarding',
      tmpRoot: stateRoot,
      env: /** @type {any} */ ({ HYP_TEST_MARKER: 'injected' }),
      // Issue #2454. Without a runtime, `createKernelRuntime` falls back to
      // `defaultCacheRoot()`, which reads HYP_HOME or `os.homedir()/.hyp`, so
      // the fixture's cache root lands outside the tmpdirs this test owns.
      // Nothing escaped to the real home: `npm test` already points HOME and
      // HYP_HOME at a throwaway dir (scripts/run-tests.js, isolatedClientEnv).
      // Pinning the root keeps that latent escape latent under a bare
      // `node --test` too. `<stateRoot>/cache` is the shape `bootKernel` passes.
      runtime: createKernelRuntime({ cacheRoot }),
    })
    assert.equal(results[0]?.ok, true, /** @type {any} */ (results[0])?.message)
    assert.equal(await fs.readFile(seen, 'utf8'), 'injected')
    // What this pins is that `activatePlugins` honors an injected runtime
    // instead of building its own: with no runtime it reads
    // `<HYP_HOME>/hypaware/cache`. Where state lands on disk is test 2's
    // assertion, not this one.
    assert.equal(runtime.cacheRoot, cacheRoot, 'the fixture runtime rooted its cache outside the test tmpdir')
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true })
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a dispatch boot places plugin state under the injected HYP_HOME, not the real home', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-env-home-'))

  // Issue #2451. A boot that reads `process.env` instead of the env it was
  // injected with resolves plugin state from the ambient home. Snapshotting
  // `~/.hyp/exports`'s existence could not see that escape: `mkdir` over a
  // directory already there is a no-op, so on a machine that has run HypAware
  // the before and the after are both `true`. An empty directory this test
  // owns gives the escape somewhere visible to land, and takes the real home
  // out of reach of every ambient arm (`HYP_HOME`, and `os.homedir()` through
  // HOME or USERPROFILE). `process.env` is private to this file's worker
  // (`node --test` runs one process per file, tests within a file in
  // sequence), so no concurrent test file can write here or see the swap.
  const ambientHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-env-ambient-home-'))
  const savedAmbient = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HYP_HOME: process.env.HYP_HOME }

  // Issue #2465. Deliberately a path that does not exist yet:
  // `createPluginPaths` mkdirs `<tmpRoot>/<plugin>-<runId>` recursively, so
  // this directory comes into existence only if the `tmpRoot` forwarding
  // reached it, and the teardown reclaim removes its children without removing
  // it. That lets one directory carry both halves of the proof below.
  const tmpRoot = path.join(hypHome, 'plugin-temp-root')

  const fromFile = path.join(hypHome, 'incoming.json')
  await fs.writeFile(fromFile, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/otel' }] }) + '\n')

  try {
    process.env.HOME = ambientHome
    process.env.USERPROFILE = ambientHome
    process.env.HYP_HOME = ambientHome

    const runId = `issue-2462-${process.pid}-${Date.now()}`
    const stderr = makeBuf()
    const code = await dispatch(['init', '--from-file', fromFile], {
      stdout: makeBuf(),
      stderr,
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '', DEV_RUN_ID: runId },
      // Issue #2462. The boot gives every activating plugin a temp dir under
      // `tmpRoot ?? os.tmpdir()` (src/core/runtime/paths.js), and left to the
      // default those land outside everything this test owns: a direct
      // `node --test` run left 17 of them in the OS temp root. Rooting them
      // under `hypHome` puts them where the `fs.rm` below reaches them even if
      // teardown ever stops reclaiming them.
      tmpRoot,
    })
    assert.equal(code, 0, stderr.text())

    // `@hypaware/local-fs` mkdirs `<HYP_HOME>/exports` in `activate()`, so where
    // that directory landed is the shortest proof of where activation read its env.
    assert.ok(await exists(path.join(hypHome, 'exports')), 'the exports dir did not land under the injected HYP_HOME')
    assert.deepEqual(
      await fs.readdir(ambientHome),
      [],
      'the boot placed plugin state under the ambient env\'s home, not the injected HYP_HOME'
    )

    // Issue #2465, two assertions on one directory that fail for opposite
    // reasons. `tmpRoot` existing is the positive guard on
    // `DispatchOptions.tmpRoot` reaching `bootKernel`: remove the forwarding
    // from src/core/cli/dispatch.js and `tempBase` falls back to
    // `os.tmpdir()`, so nothing ever mkdirs this path. It being empty is the
    // leak check: before dispatch reclaimed them at teardown, every activated
    // plugin's boot temp dir was still sitting in it.
    assert.ok(
      await exists(tmpRoot),
      'dispatch did not forward tmpRoot: no plugin temp dir was created under the test-owned root'
    )
    assert.deepEqual(
      await fs.readdir(tmpRoot),
      [],
      'plugin boot temp dirs survived under the test-owned tmpRoot'
    )

    // #2462's own complaint, survivors in the shared OS temp root, checked
    // directly rather than inferred from what landed under the test-owned
    // tmpRoot. `runId` is unique to this test run, so naming `os.tmpdir()` by a
    // suffix match stays safe even when other test files write into the same
    // shared directory under parallel `npm test` workers. On its own this says
    // nothing about `tmpRoot` any more, now that teardown reclaims what the
    // boot created: it passes whichever root the dirs were made under, which is
    // why the positive guard above exists.
    assert.deepEqual(
      (await fs.readdir(os.tmpdir())).filter((e) => e.endsWith('-' + runId)),
      [],
      'plugin boot temp dirs from this boot survived in the OS temp root'
    )
  } finally {
    for (const [key, value] of Object.entries(savedAmbient)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(hypHome, { recursive: true, force: true })
    await fs.rm(ambientHome, { recursive: true, force: true })
  }
})

// Issue #2450, one level up from the two tests above: `bootKernel` rooted its
// own `stateRoot`/`cacheRoot` under the `hypHome` it resolved but handed
// activation the raw `env`, so a boot whose `opts.hypHome` did not match
// `env.HYP_HOME` split kernel state from plugin state. No shipped caller
// presents a conflicting non-empty `env.HYP_HOME`: dispatch derives `hypHome`
// from the same env it passes, and the gateway forks the processor with
// `HYP_HOME` forced to its own home. The divergence that did ship is an absent
// one: `hyp daemon run` resolves the home through LLP 0300's `env.HOME` arm,
// which `readObservabilityEnv` and `@hypaware/local-fs` both ignore for
// `os.homedir()`, so a daemon under an injected `HOME` placed plugin state
// outside the home it was told to use. Either way `opts.hypHome` wins, as
// `BootKernelOptions` documents.
test('bootKernel forces its resolved hypHome into the env activation reads', async () => {
  const booted = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-env-boot-'))
  const ambient = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-env-ambient-'))

  try {
    const boot = await bootKernel({
      hypHome: booted,
      tmpRoot: booted,
      runId: 'boot-hyphome-forced',
      bootProfile: { activate: ['@hypaware/local-fs'] },
      env: { ...process.env, HYP_HOME: ambient, HYP_CONFIG: '' },
    })
    const activation = boot.activations.find((r) => r.plugin?.name === '@hypaware/local-fs')
    assert.equal(activation?.ok, true, `local-fs did not activate: ${JSON.stringify(activation)}`)

    // `@hypaware/local-fs` mkdirs `<ctx.env.HYP_HOME>/exports` in `activate()`,
    // so which of the two homes grew an `exports` dir is the proof.
    assert.ok(await exists(path.join(booted, 'exports')), 'plugin state did not land under the boot\'s resolved hypHome')
    assert.equal(await exists(path.join(ambient, 'exports')), false, 'plugin state landed under env.HYP_HOME instead of the resolved hypHome')
  } finally {
    await fs.rm(booted, { recursive: true, force: true })
    await fs.rm(ambient, { recursive: true, force: true })
  }
})

// Issue #2445, the same gap on a second activation path. `bootKernel` is not
// the only producer of activation entries: `activatePluginDependencyClosure`
// activates a config-selected plugin mid-command (the dispatch-miss seam and
// the manual-attach enable prompt), and it called `activatePlugins` with no
// `env` at all, so `createActivationContext` fell back to `process.env` there
// no matter what the command was invoked with. The injected env below carries
// nothing but the marker, so a `ctx.env` that came from the ambient process
// cannot accidentally satisfy the assertion.
test('the dependency-closure activation path hands the injected env to ctx.env', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-closure-plugin-'))
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-closure-state-'))
  const seen = path.join(stateRoot, 'seen.txt')
  const runId = `issue-2445-${process.pid}-${Date.now()}`
  await fs.writeFile(
    path.join(rootDir, 'index.js'),
    'import fs from \'node:fs/promises\'\n' +
    'export async function activate(ctx) {\n' +
    `  await fs.writeFile(${JSON.stringify(seen)}, String(ctx.env.HYP_CLOSURE_MARKER))\n` +
    '}\n'
  )
  const manifest = /** @type {any} */ ({
    schema_version: 1,
    name: '@acme/closure-env-reader',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  })

  try {
    // The `selection` seam the dispatch-miss caller uses, so the closure runs
    // off this fixture instead of a disk discovery of the real install.
    const result = await activatePluginDependencyClosure({
      seedNames: [manifest.name],
      kernel: createKernelRuntime({ cacheRoot: path.join(stateRoot, 'cache') }),
      stateRoot,
      runId,
      activePlugins: [],
      selection: /** @type {any} */ ({
        selectedManifests: [{ manifest, rootDir }],
        layered: { effective: { plugins: [{ name: manifest.name, config: {} }] } },
      }),
      env: /** @type {any} */ ({ HYP_CLOSURE_MARKER: 'injected' }),
    })
    assert.deepEqual(result, { activated: [manifest.name], failed: [] })
    assert.equal(await fs.readFile(seen, 'utf8'), 'injected')
  } finally {
    // This path passes no `tmpRoot`, so the fixture's boot temp dir lands in
    // the shared OS temp root; `runId` is unique to this run, so matching on
    // it reclaims only what this test made (issue #2477's residue stays).
    for (const entry of (await fs.readdir(os.tmpdir())).filter((e) => e.endsWith('-' + runId))) {
      await fs.rm(path.join(os.tmpdir(), entry), { recursive: true, force: true })
    }
    await fs.rm(rootDir, { recursive: true, force: true })
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

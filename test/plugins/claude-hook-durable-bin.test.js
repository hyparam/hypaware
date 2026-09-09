// @ts-check

/**
 * The managed Claude hook must never be pinned to npm's `_npx` cache.
 *
 * `hyp client attach claude` bakes an absolute CLI path into
 * `~/.claude/settings.json`, and that path is this package's own
 * `bin/hypaware.js`. Under `npx hypaware` this package *is* the npx cache
 * checkout, so the recorded path lives in `~/.npm/_npx/<hash>/...`, which npm
 * prunes on its own schedule. The hook contract is exit-0-and-say-nothing, so
 * a pruned cache stops `cwd` and `git_branch` capture with no error anywhere -
 * the same failure `daemon/install.js` already refuses for the daemon binary.
 *
 * Only a real `npx` run can put this package inside `_npx`, so these drive
 * `resolveHookBinPath` with that entrypoint supplied, against a real `$PATH`
 * laid out the way npx lays one out: its own shim directory in front, anything
 * durable behind it.
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveHookBinPath } from '../../hypaware-core/plugins-workspace/claude/src/index.js'
import { isNpxBinPath } from '../../src/core/cli/global_install.js'

/** @param {string} file */
async function writeExecutable(file) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, '#!/bin/sh\nexit 0\n')
  await fsp.chmod(file, 0o755)
}

/**
 * A temp home whose `$PATH` is entirely ours, standing in for a machine running
 * `npx hypaware`: the package's CLI sits in an `_npx` cache and that cache's
 * shim directory sits at the FRONT of `$PATH`, exactly where npx puts it.
 * Anything durable therefore has to be found past it.
 *
 * @param {{ installedBin?: boolean }} [opts]
 */
async function rig(opts = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-hook-bin-'))

  const npxRoot = path.join(root, '.npm', '_npx', 'a1b2c3d4')
  const npxBinDir = path.join(npxRoot, 'node_modules', '.bin')
  // What `import.meta.url` resolves to when the running package is the cache
  // checkout: the shim beside it is what npx puts on `$PATH`.
  const npxCliPath = path.join(npxRoot, 'node_modules', 'hypaware', 'bin', 'hypaware.js')
  await writeExecutable(path.join(npxBinDir, 'hypaware'))

  const globalBinDir = path.join(root, 'npm-global', 'bin')
  const globalBin = path.join(globalBinDir, 'hypaware')
  if (opts.installedBin === true) await writeExecutable(globalBin)
  else await fsp.mkdir(globalBinDir, { recursive: true })

  const env = {
    HOME: root,
    npm_config_cache: path.join(root, '.npm'),
    PATH: [npxBinDir, globalBinDir].join(path.delimiter),
  }

  return {
    env,
    npxCliPath,
    globalBin,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  }
}

test('an npx entrypoint resolves to the installed CLI, not the npx cache path', async (t) => {
  const r = await rig({ installedBin: true })
  t.after(() => r.cleanup())

  assert.equal(isNpxBinPath(r.npxCliPath, r.env), true, 'rig did not build an npx entrypoint')

  const resolved = resolveHookBinPath(r.env, r.npxCliPath)

  assert.equal(
    isNpxBinPath(resolved.binPath, r.env),
    false,
    `managed hook was pinned to the npx cache: ${resolved.binPath}`
  )
  assert.deepEqual(resolved, { binPath: r.globalBin, ephemeral: false })
})

test('with no CLI installed the npx path is still returned, flagged ephemeral', async (t) => {
  const r = await rig({ installedBin: false })
  t.after(() => r.cleanup())

  // Capture that works until npm prunes the cache beats no capture at all, so
  // the path is still recorded - what changes is that it is no longer silent.
  assert.deepEqual(resolveHookBinPath(r.env, r.npxCliPath), {
    binPath: r.npxCliPath,
    ephemeral: true,
  })
})

test('a durably installed entrypoint is recorded as it stands', async (t) => {
  const r = await rig({ installedBin: true })
  t.after(() => r.cleanup())

  // The package's own CLI on a normal install: durable already, so the `$PATH`
  // walk must not repoint the hook at some other copy.
  const durable = path.join(r.env.HOME, 'lib', 'node_modules', 'hypaware', 'bin', 'hypaware.js')
  assert.deepEqual(resolveHookBinPath(r.env, durable), { binPath: durable, ephemeral: false })
})

test('an explicit binary override wins over both', async (t) => {
  const r = await rig({ installedBin: true })
  t.after(() => r.cleanup())

  const cases = [
    { override: { HYP_BIN: '/custom/hyp' }, expected: '/custom/hyp' },
    { override: { HYPAWARE_BIN: '/preferred/hyp', HYP_BIN: '/custom/hyp' }, expected: '/preferred/hyp' },
  ]
  for (const { override, expected } of cases) {
    assert.deepEqual(resolveHookBinPath({ ...r.env, ...override }, r.npxCliPath), {
      binPath: path.resolve(expected),
      ephemeral: false,
    })
  }
})

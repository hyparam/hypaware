// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  GlobalInstallError,
  describeEphemeralBinPath,
  ensureDurableBinForNpx,
  findInstalledHypawareBin,
  globalHypawareBin,
  isEphemeralBinPath,
  isNpxBinPath,
} from '../../src/core/cli/global_install.js'

test('isNpxBinPath detects npm _npx cache entries', () => {
  assert.equal(
    isNpxBinPath('/Users/hyp/.npm/_npx/abc/node_modules/hypaware/bin/hypaware.js', {
      npm_config_cache: '/Users/hyp/.npm',
    }),
    true
  )
  assert.equal(
    isNpxBinPath('/Users/hyp/.npm-global/lib/node_modules/hypaware/bin/hypaware.js', {
      npm_config_cache: '/Users/hyp/.npm',
    }),
    false
  )
})

// The entrypoint side of the same question the walk answers for `$PATH`. Every
// case here is a real install layout, because the whole difficulty is that a
// global `npm install -g` and a project-local `npm install` both put the
// package under a `node_modules`, and only one of them survives an `npm ci`.
test('isEphemeralBinPath separates a project tree from every durable install', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ephemeral-bin-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  /** @param {string} file */
  const write = async (file) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{}\n')
  }

  // `npm install hypaware` inside a checkout: the manifest beside the tree is
  // what says a project owns it, and `npm ci` in that project deletes it.
  const project = path.join(root, 'repo')
  await write(path.join(project, 'package.json'))
  const projectBin = path.join(project, 'node_modules', 'hypaware', 'bin', 'hypaware.js')
  assert.equal(isEphemeralBinPath(projectBin, {}), true)

  // `npm install -g hypaware`: the same `node_modules` segment, no project.
  // Reading this one as ephemeral would warn on the very install the warning
  // tells people to perform.
  const prefix = path.join(root, 'npm-global')
  await write(path.join(prefix, 'lib', 'node_modules', 'hypaware', 'package.json'))
  const globalBin = path.join(prefix, 'lib', 'node_modules', 'hypaware', 'bin', 'hypaware.js')
  assert.equal(isEphemeralBinPath(globalBin, {}), false)

  // The Windows global layout, where the package sits directly under the
  // prefix. Structurally identical to a project tree apart from the manifest.
  const winPrefix = path.join(root, 'AppData', 'Roaming', 'npm')
  await write(path.join(winPrefix, 'node_modules', 'hypaware', 'package.json'))
  assert.equal(
    isEphemeralBinPath(path.join(winPrefix, 'node_modules', 'hypaware', 'bin', 'hypaware.js'), {}),
    false
  )

  // A dependency nested under a global root. Every package carries a manifest,
  // so only the OUTERMOST `node_modules` can decide: reading the nearest one
  // would call this ephemeral because `somepkg/package.json` exists.
  const nested = path.join(
    prefix, 'lib', 'node_modules', 'somepkg', 'node_modules', 'hypaware', 'bin', 'hypaware.js'
  )
  await write(path.join(prefix, 'lib', 'node_modules', 'somepkg', 'package.json'))
  assert.equal(isEphemeralBinPath(nested, {}), false)

  // A HypAware developer running their own clone. Not under any
  // `node_modules`, so the rule never reaches them and no warning ever fires
  // on a machine whose entrypoint is exactly the one they meant to run.
  const clone = path.join(root, 'src', 'hypaware')
  await write(path.join(clone, 'package.json'))
  assert.equal(isEphemeralBinPath(path.join(clone, 'bin', 'hypaware.js'), {}), false)

  // Whole segments only, the same rigour as the `_npx` test: a directory whose
  // name merely starts with `node_modules` is a directory.
  const lookalike = path.join(root, 'keep')
  await write(path.join(lookalike, 'package.json'))
  assert.equal(
    isEphemeralBinPath(path.join(lookalike, 'node_modules_old', 'hypaware', 'bin', 'hypaware.js'), {}),
    false
  )

  // A project tree whose manifest cannot be read at all is left durable: the
  // fail direction is the behaviour that shipped, never a warning invented on
  // a machine with nothing wrong with it.
  const manifestless = path.join(root, 'unmanifested')
  await fs.mkdir(manifestless, { recursive: true })
  assert.equal(
    isEphemeralBinPath(path.join(manifestless, 'node_modules', 'hypaware', 'bin', 'hypaware.js'), {}),
    false
  )

  // The npx cache still answers on its own tell, before any manifest is read.
  assert.equal(
    isEphemeralBinPath('/Users/hyp/.npm/_npx/abc/node_modules/hypaware/bin/hypaware.js', {
      npm_config_cache: '/Users/hyp/.npm',
    }),
    true
  )
})

// Issue #1625. The verdict above is "a manifest sits beside the outermost
// `node_modules`", and pnpm and yarn write one beside their GLOBAL root, so a
// global install under either reads ephemeral. The warning built from that
// verdict used to assert a project's `node_modules`, an `npm ci` and a branch
// switch, none of which that operator has. This lays a real global root of
// each beside a real project of each and shows why a third arm is not the fix:
// the four trees carry the same manifest, the same lockfile and the same
// `node_modules` (a pnpm project even carries the store directory a pnpm
// global root does), so no test on the tree tells them apart, and the message
// therefore has to claim neither.
test('the ephemeral-bin warning claims no tree a pnpm or yarn global root would disprove', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ephemeral-desc-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  /**
   * One package-manager-owned tree, laid out as that manager lays it out: the
   * manifest and lockfile at the top, the package under `node_modules`, and for
   * pnpm the store the visible entry is a link into (so the path recorded is
   * the one `realpath` gives, which is what every caller writes down).
   *
   * @param {{ dir: string, lockfile: string, store: boolean }} spec
   * @returns {Promise<string>} the CLI entry inside it
   */
  async function tree(spec) {
    await fs.mkdir(spec.dir, { recursive: true })
    await fs.writeFile(path.join(spec.dir, 'package.json'), '{"dependencies":{"hypaware":"1.0.0"}}\n')
    await fs.writeFile(path.join(spec.dir, spec.lockfile), '# lockfile\n')
    const inner = spec.store
      ? path.join(spec.dir, 'node_modules', '.pnpm', 'hypaware@1.0.0', 'node_modules', 'hypaware')
      : path.join(spec.dir, 'node_modules', 'hypaware')
    const bin = path.join(inner, 'bin', 'hypaware.js')
    await fs.mkdir(path.dirname(bin), { recursive: true })
    await fs.writeFile(bin, '#!/usr/bin/env node\n')
    return bin
  }

  // `pnpm add -g` and `yarn global add`, at the default global dirs.
  const pnpmGlobal = await tree({
    dir: path.join(root, '.local', 'share', 'pnpm', 'global', '5'),
    lockfile: 'pnpm-lock.yaml',
    store: true,
  })
  const yarnGlobal = await tree({
    dir: path.join(root, '.config', 'yarn', 'global'),
    lockfile: 'yarn.lock',
    store: false,
  })
  // The same two managers inside a checkout, which is the tree the old wording
  // asserted. Nothing above distinguishes these from the two above.
  const pnpmProject = await tree({
    dir: path.join(root, 'repo-pnpm'),
    lockfile: 'pnpm-lock.yaml',
    store: true,
  })
  const yarnProject = await tree({
    dir: path.join(root, 'repo-yarn'),
    lockfile: 'yarn.lock',
    store: false,
  })

  const effect = 'capture stops'
  /** @type {Set<string>} */
  const said = new Set()
  for (const bin of [pnpmGlobal, yarnGlobal, pnpmProject, yarnProject]) {
    assert.equal(isEphemeralBinPath(bin, {}), true, `premise: ${bin} reads durable`)
    const where = describeEphemeralBinPath(bin, effect, {})
    // The two clauses that were false for a pnpm or yarn global install: it is
    // nobody's project, and no `npm ci` or branch switch will ever remove it.
    assert.doesNotMatch(where, /inside a project's node_modules/, where)
    assert.doesNotMatch(where, /once an npm ci or a branch switch removes it/, where)
    // Still says what was actually observed and what the operator loses, which
    // is the whole reason the warning exists.
    assert.match(where, /inside a node_modules tree/, where)
    assert.match(where, new RegExp(`${effect} without warning`), where)
    said.add(where)
  }
  // One sentence for all four, because one verdict produced all four: a
  // message that varied here would be claiming a distinction nothing made.
  assert.equal(said.size, 1, [...said].join(' | '))

  // The other arm still names its tree, because `_npx` is npm's cache and
  // nothing else, and an operator sent to look for a project when their path
  // is in the cache is the failure this whole pair of arms exists to avoid.
  const npx = '/Users/hyp/.npm/_npx/abc/node_modules/hypaware/bin/hypaware.js'
  const cacheEnv = { npm_config_cache: '/Users/hyp/.npm' }
  assert.match(describeEphemeralBinPath(npx, effect, cacheEnv), /inside npm's npx cache/)
  assert.doesNotMatch(describeEphemeralBinPath(npx, effect, cacheEnv), /node_modules tree/)
})

// Whatever this returns gets written down and executed later, so every entry it
// accepts has to be a file that can still be run from somewhere else, some time
// from now. Three of the four it must walk past look executable to
// `access(X_OK)`, and the fourth is executable and real but temporary.
test('findInstalledHypawareBin only accepts a durable, runnable entry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-find-bin-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  /** @param {string} file */
  async function writeExecutable(file) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n')
    await fs.chmod(file, 0o755)
  }

  // npx's own shim directory, which sits at the FRONT of `$PATH` on the run
  // this helper exists for: resolving it re-records the cache path.
  const npxBinDir = path.join(root, '.npm', '_npx', 'a1b2c3', 'node_modules', '.bin')
  await writeExecutable(path.join(npxBinDir, 'hypaware'))
  // A directory named `hypaware`: searchable, so `access(X_OK)` says yes.
  const dirTrap = path.join(root, 'dir-trap')
  await fs.mkdir(path.join(dirTrap, 'hypaware'), { recursive: true })
  // A dangling link, the residue of an uninstall or a node version switch.
  const danglingDir = path.join(root, 'dangling')
  await fs.mkdir(danglingDir, { recursive: true })
  await fs.symlink(path.join(root, 'gone'), path.join(danglingDir, 'hypaware'))
  // A project-local install. Real, executable, and on `$PATH` for the whole of
  // an `npx` or `npm run`, but the next `npm ci` deletes it, so recording it
  // rots the same way the cache path does and with no `_npx` to give it away.
  const projectBinDir = path.join(root, 'proj', 'node_modules', '.bin')
  await writeExecutable(path.join(projectBinDir, 'hypaware'))
  const globalBinDir = path.join(root, 'npm-global', 'bin')
  await writeExecutable(path.join(globalBinDir, 'hypaware'))

  const npmCache = path.join(root, '.npm')
  const env = {
    npm_config_cache: npmCache,
    PATH: [npxBinDir, dirTrap, danglingDir, projectBinDir, globalBinDir].join(path.delimiter),
  }
  assert.equal(findInstalledHypawareBin(env), path.join(globalBinDir, 'hypaware'))

  // And with nothing durable at all behind it, a project-local copy is still
  // not the answer: `undefined` sends the caller to its own fallback.
  assert.equal(
    findInstalledHypawareBin({ npm_config_cache: npmCache, PATH: projectBinDir }),
    undefined
  )

  // A relative entry resolves against the cwd the caller happened to run in,
  // which is not a path anything can record.
  const relative = path.relative(process.cwd(), globalBinDir)
  assert.notEqual(relative, path.resolve(relative), 'the rig did not build a relative entry')
  assert.equal(
    findInstalledHypawareBin({ npm_config_cache: npmCache, PATH: relative }),
    undefined
  )

  // Nothing durable behind the shim, and no `$PATH` at all, are both "no".
  assert.equal(
    findInstalledHypawareBin({ npm_config_cache: npmCache, PATH: npxBinDir }),
    undefined
  )
  assert.equal(findInstalledHypawareBin({}), undefined)
})

// `accept` narrows what counts as an answer, and the narrowing has to happen
// inside the walk. A caller that filters the single returned path instead gets
// nothing whenever a rejected candidate happens to sit first on `$PATH`, which
// is exactly where the managers that ship shims put themselves.
test('findInstalledHypawareBin resumes the walk past a candidate accept rejects', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-find-bin-accept-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  /** @param {string} file */
  async function writeExecutable(file) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n')
    await fs.chmod(file, 0o755)
  }

  const shimDir = path.join(root, 'shim', 'bin')
  const wantedDir = path.join(root, 'wanted', 'bin')
  await writeExecutable(path.join(shimDir, 'hypaware'))
  await writeExecutable(path.join(wantedDir, 'hypaware'))
  const env = { PATH: [shimDir, wantedDir].join(path.delimiter) }

  // Without a filter the first entry still wins, unchanged.
  assert.equal(findInstalledHypawareBin(env), path.join(shimDir, 'hypaware'))

  /** @type {string[]} */
  const seen = []
  const accept = (/** @type {string} */ candidate) => {
    seen.push(candidate)
    return candidate.startsWith(wantedDir)
  }
  assert.equal(
    findInstalledHypawareBin(env, process.platform, accept),
    path.join(wantedDir, 'hypaware')
  )
  assert.deepEqual(seen, [path.join(shimDir, 'hypaware'), path.join(wantedDir, 'hypaware')])

  // A filter nothing satisfies is `undefined`, not the last thing it walked.
  assert.equal(findInstalledHypawareBin(env, process.platform, () => false), undefined)
})

test('ensureDurableBinForNpx installs the current package globally and returns the global bin', async () => {
  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = []
  const stdout = makeBuf()
  const env = { npm_config_cache: '/Users/hyp/.npm' }
  const packageSpec = await currentPackageSpec()

  const result = await ensureDurableBinForNpx({
    binPath: '/Users/hyp/.npm/_npx/abc/node_modules/hypaware/bin/hypaware.js',
    env,
    stdout,
    stderr: makeBuf(),
    async runner(cmd, args) {
      calls.push({ cmd, args })
      if (args.join(' ') === 'config get prefix') {
        return { exitCode: 0, stdout: '/Users/hyp/.npm-global\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })

  assert.equal(result.installed, true)
  assert.equal(result.skipped, false)
  assert.equal(result.packageSpec, packageSpec)
  assert.equal(result.binPath, globalHypawareBin('/Users/hyp/.npm-global'))
  assert.deepEqual(calls[0], {
    cmd: 'npm',
    args: ['install', '-g', packageSpec],
  })
  assert.deepEqual(calls[1], {
    cmd: 'npm',
    args: ['config', 'get', 'prefix'],
  })
  assert.match(stdout.text(), /npx detected: installing durable CLI/)
})

test('ensureDurableBinForNpx leaves stable bin paths untouched', async () => {
  const binPath = path.resolve('/opt/hypaware/bin/hypaware.js')
  let called = false
  const result = await ensureDurableBinForNpx({
    binPath,
    env: { npm_config_cache: '/Users/hyp/.npm' },
    stdout: makeBuf(),
    stderr: makeBuf(),
    async runner() {
      called = true
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })

  assert.equal(result.binPath, binPath)
  assert.equal(result.skipped, true)
  assert.equal(result.installed, false)
  assert.equal(called, false)
})

test('ensureDurableBinForNpx reports npm install failures with a repair command', async () => {
  const packageSpec = await currentPackageSpec()

  await assert.rejects(
    ensureDurableBinForNpx({
      binPath: '/Users/hyp/.npm/_npx/abc/node_modules/hypaware/bin/hypaware.js',
      env: { npm_config_cache: '/Users/hyp/.npm' },
      stdout: makeBuf(),
      stderr: makeBuf(),
      async runner() {
        return { exitCode: 1, stdout: '', stderr: 'EACCES permission denied' }
      },
    }),
    (err) => {
      // The class, not just the text: the picker finale tells an environment
      // failure it can carry on from from a bug in this lane by class (#1386).
      assert.ok(err instanceof GlobalInstallError, 'the npm refusal is a GlobalInstallError')
      assert.match(
        err.message,
        new RegExp(`npm install -g ${escapeRegExp(packageSpec)} failed: EACCES permission denied`)
      )
      return true
    }
  )
})

async function currentPackageSpec() {
  const raw = await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')
  const pkg = JSON.parse(raw)
  return `${pkg.name}@${pkg.version}`
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
    },
    text() {
      return value
    },
  }
}

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  GlobalInstallError,
  ensureDurableBinForNpx,
  findInstalledHypawareBin,
  globalHypawareBin,
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

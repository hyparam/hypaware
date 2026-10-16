// @ts-check

// Issue #2118: the install-name guard is lexical, so a symlink planted below
// the plugins root steered recursive deletes, mkdirs and renames outside it.
// Every case runs inside one mkdtemp root and asserts the "outside" sentinel
// is inside that root before handing it to the code under test.

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'

import { installPlugin, loadLock, removePlugin } from '../../src/core/plugin_install/install.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'
import { checkInstallDestination } from '../../src/core/plugin_install/paths.js'
import { pluginStateDir, runPluginRemove } from '../../src/core/commands/plugin.js'
import { isWithinDir } from '../../src/core/runtime/contribution_names.js'

/**
 * @param {string} dir
 * @param {string} name
 */
async function stagePlugin(dir, name) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1,
    name,
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './index.js',
  }))
  await fs.writeFile(path.join(dir, 'index.js'), 'export async function activate(){}\n')
  return dir
}

/**
 * A directory outside the plugins root holding `sub/keep.txt`.
 *
 * @param {string} tmpRoot
 */
async function makeOutside(tmpRoot) {
  const outside = path.join(tmpRoot, 'outside')
  assert.equal(isWithinDir(outside, tmpRoot), true)
  await fs.mkdir(path.join(outside, 'sub'), { recursive: true })
  await fs.writeFile(path.join(outside, 'sub', 'keep.txt'), 'precious\n')
  return {
    outside,
    intact: async () => {
      assert.deepEqual(await fs.readdir(outside), ['sub'])
      assert.equal(await fs.readFile(path.join(outside, 'sub', 'keep.txt'), 'utf8'), 'precious\n')
    },
  }
}

/** @param {(tmpRoot: string) => Promise<void>} body */
async function inTemp(body) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-install-fs-'))
  try {
    await body(tmpRoot)
  } finally {
    await fs.chmod(tmpRoot, 0o700).catch(() => undefined)
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }
}

test('removePlugin: a scope symlink out of the root is not followed, the row is cleared and the skip is reported', () => inTemp(async (tmpRoot) => {
  const stateDir = path.join(tmpRoot, 'hypaware')
  const root = path.join(stateDir, 'plugins')
  const { outside, intact } = await makeOutside(tmpRoot)
  await fs.mkdir(root, { recursive: true })
  await fs.symlink(outside, path.join(root, '@evil'))
  for (const installDir of [path.join(root, '@evil', 'sub'), undefined]) {
    await writeLock(stateDir, {
      schema_version: 1,
      plugins: /** @type {any} */ ({ '@evil/sub': { name: '@evil/sub', install_dir: installDir } }),
    })
    const result = await removePlugin({ name: '@evil/sub', stateDir })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.match(String(result.cleanupSkipped), /@evil is a symbolic link/)
    await intact()
    assert.deepEqual((await loadLock(stateDir)).plugins, {})
  }
}))

test('removePlugin: a recorded install_dir that walks through a link deletes the derived directory, not the link target', () => inTemp(async (tmpRoot) => {
  const stateDir = path.join(tmpRoot, 'hypaware')
  const root = path.join(stateDir, 'plugins')
  const outside = path.join(tmpRoot, 'outside')
  await fs.mkdir(path.join(outside, 'child'), { recursive: true })
  await fs.mkdir(path.join(outside, 'victim'), { recursive: true })
  await fs.writeFile(path.join(outside, 'victim', 'KEEP'), 'precious\n')
  await fs.mkdir(path.join(root, 'victim'), { recursive: true })
  await fs.writeFile(path.join(root, 'victim', 'index.js'), '')
  await fs.symlink(path.join(outside, 'child'), path.join(root, 'jump'))
  // Lexically `<root>/victim`, but the OS resolves `jump` first and lands in `outside`.
  const aliased = `${root}${path.sep}jump${path.sep}..${path.sep}victim`
  await writeLock(stateDir, {
    schema_version: 1,
    plugins: /** @type {any} */ ({ victim: { name: 'victim', install_dir: aliased } }),
  })
  const result = await removePlugin({ name: 'victim', stateDir })
  assert.equal(result.ok, true)
  assert.equal(await fs.readFile(path.join(outside, 'victim', 'KEEP'), 'utf8'), 'precious\n')
  await assert.rejects(fs.lstat(path.join(root, 'victim')), { code: 'ENOENT' })
  assert.deepEqual((await loadLock(stateDir)).plugins, {})
}))

test('removePlugin: a final link is unlinked and its target survives; a normal directory is removed', () => inTemp(async (tmpRoot) => {
  const stateDir = path.join(tmpRoot, 'hypaware')
  const root = path.join(stateDir, 'plugins')
  const { outside, intact } = await makeOutside(tmpRoot)
  await fs.mkdir(path.join(root, '@scope', 'real'), { recursive: true })
  await fs.writeFile(path.join(root, '@scope', 'real', 'index.js'), '')
  await fs.symlink(outside, path.join(root, 'linked'))
  await writeLock(stateDir, {
    schema_version: 1,
    plugins: /** @type {any} */ ({
      linked: { name: 'linked', install_dir: path.join(root, 'linked') },
      '@scope/real': { name: '@scope/real', install_dir: path.join(root, '@scope', 'real') },
    }),
  })

  const linked = await removePlugin({ name: 'linked', stateDir })
  assert.equal(linked.ok, true)
  assert.equal(linked.ok && linked.cleanupSkipped, undefined)
  await assert.rejects(fs.lstat(path.join(root, 'linked')), { code: 'ENOENT' })
  await intact()

  const real = await removePlugin({ name: '@scope/real', stateDir })
  assert.equal(real.ok, true)
  assert.equal(real.ok && real.cleanupSkipped, undefined)
  assert.deepEqual(await fs.readdir(path.join(root, '@scope')), [])
  assert.deepEqual((await loadLock(stateDir)).plugins, {})
}))

test('installPlugin (local-dir): a pre-existing scope symlink refuses before anything is removed', () => inTemp(async (tmpRoot) => {
  const stateDir = path.join(tmpRoot, 'hypaware')
  const root = path.join(stateDir, 'plugins')
  const { outside, intact } = await makeOutside(tmpRoot)
  const prior = await installPlugin({ rawSource: await stagePlugin(path.join(tmpRoot, 'prior'), 'prior'), stateDir })
  assert.equal(prior.ok, true)
  const lockBefore = (await loadLock(stateDir)).plugins
  await fs.symlink(outside, path.join(root, '@evil'))

  const result = await installPlugin({ rawSource: await stagePlugin(path.join(tmpRoot, 'src'), '@evil/sub'), stateDir })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'install_dir_unsafe')
  assert.match(result.message, /refused, .*@evil is a symbolic link; nothing was installed and nothing was removed/)
  await intact()
  assert.deepEqual((await loadLock(stateDir)).plugins, lockBefore)
  assert.deepEqual(await fs.readdir(path.join(root, 'prior')), ['hypaware.plugin.json', 'index.js'])
}))

test('installPlugin (git): a pre-existing scope symlink refuses before the backup rename', () => inTemp(async (tmpRoot) => {
  const sourceUrl = await buildGitSource(tmpRoot, '@evil/sub')
  const stateDir = path.join(tmpRoot, 'state')
  const root = path.join(stateDir, 'plugins')
  const { outside, intact } = await makeOutside(tmpRoot)
  await fs.mkdir(root, { recursive: true })
  await fs.symlink(outside, path.join(root, '@evil'))

  const result = await installPlugin({
    rawSource: sourceUrl,
    stateDir,
    confirm: async () => ({ proceed: true, outcome: 'auto_yes' }),
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'install_dir_unsafe')
  await intact()
  assert.deepEqual((await loadLock(stateDir)).plugins, {})
}))

test('installPlugin and removePlugin: a symlinked HYP_HOME and a missing scope still install and remove', () => inTemp(async (tmpRoot) => {
  const realHome = path.join(tmpRoot, 'real-home')
  await fs.mkdir(realHome)
  await fs.symlink(realHome, path.join(tmpRoot, 'home-link'))
  const stateDir = path.join(tmpRoot, 'home-link', 'hypaware')

  const local = await installPlugin({ rawSource: await stagePlugin(path.join(tmpRoot, 'a'), '@fresh/a'), stateDir })
  assert.equal(local.ok, true, /** @type {any} */ (local).message)
  const sourceUrl = await buildGitSource(tmpRoot, '@fresh/b')
  const git = await installPlugin({ rawSource: sourceUrl, stateDir })
  assert.equal(git.ok, true, /** @type {any} */ (git).message)
  const scopeDir = path.join(realHome, 'hypaware', 'plugins', '@fresh')
  assert.deepEqual((await fs.readdir(scopeDir)).sort(), ['a', 'b'])

  for (const name of ['@fresh/a', '@fresh/b']) {
    const removed = await removePlugin({ name, stateDir })
    assert.equal(removed.ok, true)
    assert.equal(removed.ok && removed.cleanupSkipped, undefined)
  }
  assert.deepEqual(await fs.readdir(scopeDir), [])
}))

test('checkInstallDestination: absent paths pass; linked, looping and uninspectable components refuse', () => inTemp(async (tmpRoot) => {
  const stateDir = path.join(tmpRoot, 'hypaware')
  const root = path.join(stateDir, 'plugins')
  assert.deepEqual(await checkInstallDestination(stateDir, '@none/x'), { ok: true })
  await fs.mkdir(root, { recursive: true })
  assert.deepEqual(await checkInstallDestination(stateDir, '@none/x'), { ok: true })
  assert.deepEqual(await checkInstallDestination(stateDir, 'plain'), { ok: true })

  // A scope linking to another scope inside the root aliases its plugins.
  await fs.mkdir(path.join(root, '@other', 'x'), { recursive: true })
  await fs.symlink(path.join(root, '@other'), path.join(root, '@alias'))
  assert.match(String(/** @type {any} */ (await checkInstallDestination(stateDir, '@alias/x')).reason), /symbolic link/)

  await fs.symlink(path.join(root, '@loop'), path.join(root, '@loop'))
  assert.equal((await checkInstallDestination(stateDir, '@loop/x')).ok, false)

  await fs.writeFile(path.join(root, '@file'), '')
  assert.match(String(/** @type {any} */ (await checkInstallDestination(stateDir, '@file/x')).reason), /not a directory/)

  if (process.getuid?.() !== 0) {
    await fs.mkdir(path.join(root, '@locked'))
    await fs.chmod(path.join(root, '@locked'), 0o000)
    try {
      assert.match(String(/** @type {any} */ (await checkInstallDestination(stateDir, '@locked/x')).reason), /cannot inspect .*EACCES/)
    } finally {
      await fs.chmod(path.join(root, '@locked'), 0o700)
    }
  }

  // The configured root may itself be a link, but not a dangling or looping one.
  const other = path.join(tmpRoot, 'other-state')
  await fs.mkdir(other)
  await fs.symlink(path.join(tmpRoot, 'nowhere'), path.join(other, 'plugins'))
  assert.match(String(/** @type {any} */ (await checkInstallDestination(other, 'plain')).reason), /symbolic link to nothing/)
  await fs.rm(path.join(other, 'plugins'))
  await fs.symlink(path.join(other, 'plugins'), path.join(other, 'plugins'))
  assert.match(String(/** @type {any} */ (await checkInstallDestination(other, 'plain')).reason), /ELOOP/)
  await fs.rm(path.join(other, 'plugins'))
  await fs.symlink(root, path.join(other, 'plugins'))
  assert.deepEqual(await checkInstallDestination(other, '@other/x'), { ok: true })
}))

test('runPluginRemove: a withheld delete is named on stderr after the removal line', () => inTemp(async (tmpRoot) => {
  let out = ''
  let err = ''
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: tmpRoot, HYP_CONFIG: '' },
    cwd: tmpRoot,
    stdout: { write: (/** @type {string} */ c) => { out += c; return true } },
    stderr: { write: (/** @type {string} */ c) => { err += c; return true } },
  })
  const stateDir = pluginStateDir(ctx)
  assert.equal(isWithinDir(stateDir, tmpRoot), true)
  const { outside, intact } = await makeOutside(tmpRoot)
  await fs.mkdir(path.join(stateDir, 'plugins'), { recursive: true })
  await fs.symlink(outside, path.join(stateDir, 'plugins', '@evil'))
  await writeLock(stateDir, {
    schema_version: 1,
    plugins: /** @type {any} */ ({ '@evil/sub': { name: '@evil/sub' } }),
  })

  const code = await runPluginRemove(['@evil/sub'], ctx)
  assert.equal(code, 0)
  assert.equal(out, 'removed @evil/sub\n')
  assert.match(err, /^hyp plugin remove: deleted nothing on disk: .*@evil is a symbolic link\n$/)
  await intact()
}))

/**
 * A file:// bare repo whose manifest carries `name`.
 *
 * @param {string} tmpRoot
 * @param {string} name
 */
async function buildGitSource(tmpRoot, name) {
  const work = path.join(tmpRoot, `git-work-${name.replace(/[@/]/g, '_')}`)
  await stagePlugin(work, name)
  await runGit(['init', '-q', '-b', 'main'], work)
  await runGit(['config', 'user.email', 'unit@hypaware.test'], work)
  await runGit(['config', 'user.name', 'HypAware Test'], work)
  await runGit(['add', '.'], work)
  await runGit(['commit', '--quiet', '--no-gpg-sign', '-m', 'initial'], work)
  const bare = `${work}.git`
  await runGit(['init', '--bare', '-q', '-b', 'main', bare], tmpRoot)
  await runGit(['push', '--quiet', bare, 'main'], work)
  return `file://${bare}`
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<void>}
 */
function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr}`)))
  })
}

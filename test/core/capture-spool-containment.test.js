// @ts-check

/**
 * The capture spool sweep only empties directories this install owns.
 *
 * `isCaptureSpoolDir` is a string test: `path.resolve` performs no `readlink`,
 * so `<hyp-home>/spool/claude-bodies` is a direct child of the spool root by
 * spelling and somewhere else in fact. `readdir` follows the path it is given,
 * and the sweep removes every file it lists with no name predicate and no
 * grace window, recursing through real subdirectories. That is LLP
 * 0326#one-level-down's door in a second subsystem, so it gets 0326's answer:
 * the pass asks the filesystem about each directory at the moment it walks it.
 *
 * @ref LLP 0328#sweep-path [tests]: neither shape empties a tree outside the
 *   HypAware home, and the ordinary spool still gets emptied
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { captureSpoolRoot, isCaptureSpoolDir, sweepCaptureSpool } from '../../src/core/capture_spool.js'
import { runPurge } from '../../src/core/commands/purge.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { MODE_OTEL, attach } from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { claudeBodySpoolDir } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/spool.js'

/** @import { ClientDescriptor } from '../../src/core/types.js' */

const skipSymlinks = process.platform === 'win32' && 'symlink creation needs Developer Mode on win32'

/** @param {string} prefix */
function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-spool-guard-${prefix}-`))
}

/**
 * A tree that is not ours: one file at the top and one a directory down, so a
 * sweep that recurses is measured doing it rather than assumed not to.
 *
 * @param {string} dir
 */
async function plantOutsideTree(dir) {
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true })
  await fs.writeFile(path.join(dir, 'precious.txt'), 'not ours')
  await fs.writeFile(path.join(dir, 'sub', 'deeper.txt'), 'not ours either')
}

/** @param {string} dir */
async function outsideTreeIntact(dir) {
  return {
    top: await fs.readFile(path.join(dir, 'precious.txt'), 'utf8').then(() => true, () => false),
    nested: await fs.readFile(path.join(dir, 'sub', 'deeper.txt'), 'utf8').then(() => true, () => false),
  }
}

/** @param {{ cacheRoot: string, hypHome: string }} args */
function makeCtx({ cacheRoot, hypHome }) {
  /** @type {{ text: string, write: (s: string) => void }} */
  const stdout = { text: '', write(s) { this.text += s } }
  /** @type {{ text: string, write: (s: string) => void }} */
  const stderr = { text: '', write(s) { this.text += s } }
  const ctx = /** @type {any} */ ({
    stdout,
    stderr,
    stdin: { isTTY: false },
    env: { HYP_HOME: hypHome },
    cwd: '/home/u',
    storage: { cacheRoot },
  })
  return { ctx, stdout, stderr }
}

/** @type {ClientDescriptor} */
const CLAUDE_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/claude'),
  name: 'claude',
  skillDir: 'skills/claude',
  attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
}

/** A temp home carrying an `otel`-mode attach whose marker names the spool. */
async function detachRig() {
  const root = await tmpDir('detach')
  const hypHome = path.join(root, '.hyp')
  const settingsPath = path.join(root, '.claude', 'settings.json')
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  const spoolDir = claudeBodySpoolDir(hypHome)
  await fs.mkdir(captureSpoolRoot(hypHome), { recursive: true })

  return {
    root,
    hypHome,
    spoolDir,
    attachOtel: () => attach({
      port: 18521,
      version: '2.0.0',
      stateFile: path.join(root, 'session-context.jsonl'),
      settingsPath,
      mode: MODE_OTEL,
      telemetryPort: 4319,
      spoolDir,
      claudeVersion: '2.1.233',
    }),
    detach: () => detachClientFromDisk({
      descriptor: CLAUDE_DESCRIPTOR,
      homeDir: root,
      env: /** @type {any} */ ({ HOME: root, HYP_HOME: hypHome }),
    }),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------
// The two shapes measured deleting outside the HypAware home.
// ---------------------------------------------------------------------------

// The detach shape. The marker's `spool_dir` passes `isCaptureSpoolDir` (it is
// a direct child of `<hyp-home>/spool` by spelling), and the sweep then walks
// through the link into a tree the user never pointed a destructive verb at.
test('detach empties nothing through a symlinked client spool directory', { skip: skipSymlinks }, async (t) => {
  const r = await detachRig()
  const outside = await tmpDir('detach-target')
  t.after(async () => {
    await r.cleanup()
    await fs.rm(outside, { recursive: true, force: true })
  })

  await plantOutsideTree(outside)
  await r.attachOtel()
  await fs.symlink(outside, r.spoolDir, 'dir')

  // The string gate still passes: that is the point, and it is not what this
  // change fixes.
  assert.equal(isCaptureSpoolDir(r.spoolDir, r.hypHome), true)

  const result = await r.detach()
  assert.equal(result.changed, true, 'the detach itself still lands')
  assert.deepEqual(
    await outsideTreeIntact(outside),
    { top: true, nested: true },
    'a spool directory that is a symlink is not a spool this install may empty'
  )
  assert.equal(
    await fs.readlink(r.spoolDir).then(() => true, () => false), true,
    'and the link is left standing rather than followed'
  )
})

// The purge shape. `hyp purge` sweeps the spool ROOT unconditionally, whatever
// the target was, so the plant is one symlink and needs no settings edit at
// all.
test('purge empties nothing through a symlinked spool root', { skip: skipSymlinks }, async (t) => {
  const cacheRoot = await tmpDir('purge-cache')
  const hypHome = await tmpDir('purge-home')
  const outside = await tmpDir('purge-target')
  t.after(async () => {
    for (const dir of [cacheRoot, hypHome, outside]) await fs.rm(dir, { recursive: true, force: true })
  })

  await plantOutsideTree(outside)
  await fs.symlink(outside, captureSpoolRoot(hypHome), 'dir')

  const { ctx, stdout } = makeCtx({ cacheRoot, hypHome })
  assert.equal(await runPurge(['--all', '--yes', '--json'], ctx), 0)
  assert.equal(JSON.parse(stdout.text).spoolFilesRemoved, 0, 'nothing outside the home is ours to count')
  assert.deepEqual(
    await outsideTreeIntact(outside),
    { top: true, nested: true },
    'the tree the link points at is untouched, nested directories included'
  )
})

// And the same question asked of the function both verbs go through, so the
// property is attached to the code that deletes rather than to its callers.
test('sweepCaptureSpool removes nothing through a symlinked entry path', { skip: skipSymlinks }, async (t) => {
  const home = await tmpDir('unit')
  const outside = await tmpDir('unit-target')
  t.after(async () => {
    for (const dir of [home, outside]) await fs.rm(dir, { recursive: true, force: true })
  })

  await plantOutsideTree(outside)
  const dir = claudeBodySpoolDir(home)
  await fs.mkdir(captureSpoolRoot(home), { recursive: true })
  await fs.symlink(outside, dir, 'dir')

  const swept = await sweepCaptureSpool(dir)
  assert.deepEqual(swept, { filesRemoved: 0, bytesRemoved: 0, failed: 0 })
  assert.deepEqual(await outsideTreeIntact(outside), { top: true, nested: true })
})

// The same plant, spelled with one more character. `lstat` reports on a link
// only when the path names the link: POSIX makes a trailing slash resolve the
// last component, so a guard asked about `<spool>/claude-bodies/` inspects the
// TARGET while `readdir` walks it. That spelling reaches the guard because
// detach passes the marker string verbatim while `isCaptureSpoolDir` judged a
// `path.resolve`d copy of it, which is the same hand-editable settings input
// the string gate exists for.
test('a symlinked entry path spelled with a trailing separator is still refused', { skip: skipSymlinks }, async (t) => {
  const home = await tmpDir('trailing')
  const outside = await tmpDir('trailing-target')
  t.after(async () => {
    for (const dir of [home, outside]) await fs.rm(dir, { recursive: true, force: true })
  })

  await plantOutsideTree(outside)
  const dir = claudeBodySpoolDir(home)
  await fs.mkdir(captureSpoolRoot(home), { recursive: true })
  await fs.symlink(outside, dir, 'dir')

  for (const spelling of [dir + '/', dir + '/.', dir + '//']) {
    const swept = await sweepCaptureSpool(spelling)
    assert.deepEqual(swept, { filesRemoved: 0, bytesRemoved: 0, failed: 0 }, spelling)
    assert.deepEqual(await outsideTreeIntact(outside), { top: true, nested: true }, spelling)
  }
})

// And through the real verb, because the spelling only matters if something
// can hand it to the sweep. Detach reads `spool_dir` off the marker in the
// user's own settings file and passes it on unchanged.
test('detach refuses a marker whose spool_dir spells the symlink with a trailing separator', { skip: skipSymlinks }, async (t) => {
  const r = await detachRig()
  const outside = await tmpDir('detach-trailing-target')
  t.after(async () => {
    await r.cleanup()
    await fs.rm(outside, { recursive: true, force: true })
  })

  await plantOutsideTree(outside)
  await r.attachOtel()

  // The hand edit: one trailing separator on a path the gate still approves.
  const settingsPath = path.join(r.root, '.claude', 'settings.json')
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
  settings._hypaware.spool_dir = r.spoolDir + '/'
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))
  assert.equal(isCaptureSpoolDir(settings._hypaware.spool_dir, r.hypHome), true, 'the string gate still passes')

  await fs.symlink(outside, r.spoolDir, 'dir')

  const result = await r.detach()
  assert.equal(result.changed, true, 'the detach itself still lands')
  assert.deepEqual(
    await outsideTreeIntact(outside),
    { top: true, nested: true },
    'a spelling that makes lstat resolve the link is not a way past the guard'
  )
})

// ---------------------------------------------------------------------------
// The over-tightening controls. A guard that refuses too much means the spool
// silently stops being reclaimed, which is quieter than the bug above.
// ---------------------------------------------------------------------------

test('an ordinary spool is still emptied to the bottom of its real subdirectories', async (t) => {
  const home = await tmpDir('ordinary')
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const dir = claudeBodySpoolDir(home)
  const nested = path.join(dir, 'nested')
  await fs.mkdir(nested, { recursive: true })
  await fs.writeFile(path.join(dir, 'req-1.json'), '0123456789')
  await fs.writeFile(path.join(nested, 'req-2.json'), '012')

  const swept = await sweepCaptureSpool(dir)
  assert.equal(swept.filesRemoved, 2, 'both bodies go, one of them a directory down')
  assert.equal(swept.bytesRemoved, 13)
  assert.equal(swept.failed, 0)
  assert.deepEqual(await fs.readdir(nested), [], 'the recursion still reaches the nested directory')
})

// Rejection needs positive evidence. A spool directory that is not there is
// the normal state on a machine that never attached a body-writing client, and
// it is not a spool somewhere else.
test('an absent spool is still a no-op rather than a refusal', async (t) => {
  const home = await tmpDir('absent')
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const swept = await sweepCaptureSpool(claudeBodySpoolDir(home))
  assert.deepEqual(swept, { filesRemoved: 0, bytesRemoved: 0, failed: 0 })
})

// The legitimate case a containment check most plausibly breaks: `$HYP_HOME`
// on another volume, or `/tmp` resolving to `/private/tmp` on macOS. The guard
// reads the directory it is about to walk and nothing above it, so the shape
// of the path the home lives at is not the sweep's business.
test('a spool under a symlinked $HYP_HOME is still emptied', { skip: skipSymlinks }, async (t) => {
  const root = await tmpDir('symlinked-home')
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  await fs.mkdir(path.join(root, 'volume', 'hyp-home'), { recursive: true })
  await fs.symlink(path.join(root, 'volume'), path.join(root, 'home'), 'dir')
  const hypHome = path.join(root, 'home', 'hyp-home')
  const dir = claudeBodySpoolDir(hypHome)
  await fs.mkdir(path.join(dir, 'nested'), { recursive: true })
  await fs.writeFile(path.join(dir, 'req-1.json'), 'body')
  await fs.writeFile(path.join(dir, 'nested', 'req-2.json'), 'body')

  const swept = await sweepCaptureSpool(dir)
  assert.equal(swept.filesRemoved, 2, 'every component above the spool is the home\'s business, not the sweep\'s')
  assert.deepEqual(await fs.readdir(dir), ['nested'])
})

// The other half of positive evidence, and the half an absent spool cannot
// show: a filesystem that will not answer says nothing about the directory.
// Refusing on silence would turn "I could not empty this, empty it by hand"
// into the same zero-count success an empty spool reports, which is the
// user-visible half of the guard going quiet.
test('a spool the process cannot stat is reported as unswept, not declared foreign', {
  skip: process.getuid?.() === 0 && 'a root process traverses a mode-000 directory anyway',
}, async (t) => {
  const home = await tmpDir('unreadable')
  const blocked = path.join(home, 'blocked')
  const dir = path.join(blocked, 'spool', 'claude-bodies')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'req-1.json'), 'body')
  await fs.chmod(blocked, 0o000)
  t.after(async () => {
    await fs.chmod(blocked, 0o700).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  })

  const swept = await sweepCaptureSpool(dir)
  assert.equal(swept.failed, 1, 'the sweep reports the directory it could not empty')
  assert.equal(swept.filesRemoved, 0)
})

// ---------------------------------------------------------------------------
// The seam and the check have to mean the same filesystem.
//
// `sweepCaptureSpool` takes an injectable `{ fs }` for `readdir`, `lstat`, and
// `rm`. The guard in front of them used to be `node:fs` `lstatSync`, so an
// injected filesystem was read by the walk and never by the check - and the
// check then failed OPEN, because a path absent from the real filesystem is
// not a confirmed symlink. Inert against the two production callers, which
// both pass real `fsp`; a door for anything else that takes the seam.
// ---------------------------------------------------------------------------

/**
 * A filesystem that exists only in this test. `root` is the one directory,
 * holding `files`; `rootIsSymlink` is what the injected `lstat` says about the
 * directory itself, and `lstatThrows` is it declining to say anything.
 *
 * @param {{ root: string, files?: string[], rootIsSymlink?: boolean, lstatThrows?: boolean }} spec
 */
function virtualSpoolFs({ root, files = ['req-1.json'], rootIsSymlink = false, lstatThrows = false }) {
  /** @type {string[]} */
  const removed = []
  return {
    removed,
    fs: /** @type {any} */ ({
      /** @param {string} p */
      async readdir(p) {
        if (p !== root) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return files.map((name) => ({ name, isDirectory: () => false }))
      },
      /** @param {string} p */
      async lstat(p) {
        if (p === root) {
          if (lstatThrows) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
          return { isSymbolicLink: () => rootIsSymlink, size: 0 }
        }
        return { isSymbolicLink: () => false, size: 10 }
      },
      /** @param {string} p */
      async rm(p) {
        removed.push(p)
      },
    }),
  }
}

// A path that exists nowhere on this machine, so the pre-change guard could
// only ever have answered about it with the real filesystem's `false`.
const VIRTUAL_SPOOL = path.join(path.sep, 'hyp-virtual-spool', 'claude-bodies')

test('the injected filesystem answers the containment check, not node:fs', async () => {
  const v = virtualSpoolFs({ root: VIRTUAL_SPOOL, rootIsSymlink: true })

  const swept = await sweepCaptureSpool(VIRTUAL_SPOOL, { fs: v.fs })

  assert.deepEqual(swept, { filesRemoved: 0, bytesRemoved: 0, failed: 0 })
  assert.deepEqual(v.removed, [], 'a symlink the injected filesystem confirms removes nothing')
})

test('an ordinary directory on an injected filesystem is still emptied', async () => {
  const v = virtualSpoolFs({ root: VIRTUAL_SPOOL, files: ['req-1.json', 'req-2.json'] })

  const swept = await sweepCaptureSpool(VIRTUAL_SPOOL, { fs: v.fs })

  assert.equal(swept.filesRemoved, 2, 'the seam is not a reason to stop reclaiming')
  assert.equal(swept.bytesRemoved, 20)
  assert.deepEqual(v.removed, [
    path.join(VIRTUAL_SPOOL, 'req-1.json'),
    path.join(VIRTUAL_SPOOL, 'req-2.json'),
  ])
})

// Positive evidence, asked of the seam. An injected filesystem that will not
// answer says nothing about the directory, exactly as an unanswerable
// `lstatSync` says nothing about a real one.
test('an injected filesystem that cannot stat the spool is not read as an escape', async () => {
  const v = virtualSpoolFs({ root: VIRTUAL_SPOOL, lstatThrows: true })

  const swept = await sweepCaptureSpool(VIRTUAL_SPOOL, { fs: v.fs })

  assert.equal(swept.filesRemoved, 1)
  assert.deepEqual(v.removed, [path.join(VIRTUAL_SPOOL, 'req-1.json')])
})

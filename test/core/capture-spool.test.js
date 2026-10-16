// @ts-check

/**
 * The capture spool as core knows it: where it lives, which directories a
 * settings-file marker may point a sweep at, and what emptying one does.
 *
 * @ref LLP 0253#spool-location [tests]: `<hyp-home>/spool/<client>`, which is
 *   what purge and detach can find without being told
 * @ref LLP 0253#purge-and-detach-sweep [tests]: emptying removes the contents
 *   and leaves the directory
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  captureSpoolRoot,
  isCaptureSpoolDir,
  sweepCaptureSpool,
} from '../../src/core/capture_spool.js'
import { claudeBodySpoolDir } from '../../hypaware-core/plugins-workspace/claude/src/telemetry/spool.js'

/** @param {string} prefix */
function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-spool-${prefix}-`))
}

test('captureSpoolRoot: the claude body spool is a child of the shared root', () => {
  const home = path.join(os.tmpdir(), 'hyp-home-fixture')
  assert.equal(captureSpoolRoot(home), path.join(home, 'spool'))
  assert.equal(path.dirname(claudeBodySpoolDir(home)), captureSpoolRoot(home))
  assert.equal(isCaptureSpoolDir(claudeBodySpoolDir(home), home), true)
})

test('isCaptureSpoolDir: only a direct child of <hyp-home>/spool qualifies', () => {
  const home = '/hyp/home'
  assert.equal(isCaptureSpoolDir('/hyp/home/spool/claude-bodies', home), true)
  // The root itself, a nested path, and anything outside are all refused: the
  // value comes off a settings file a hand edit can reach.
  assert.equal(isCaptureSpoolDir('/hyp/home/spool', home), false)
  assert.equal(isCaptureSpoolDir('/hyp/home/spool/claude-bodies/deeper', home), false)
  assert.equal(isCaptureSpoolDir('/hyp/home/cache', home), false)
  assert.equal(isCaptureSpoolDir('/etc', home), false)
  // A traversal spelling normalizes before the test, so it lands outside.
  assert.equal(isCaptureSpoolDir('/hyp/home/spool/../../../etc', home), false)
  assert.equal(isCaptureSpoolDir('relative/spool/claude-bodies', home), false)
  assert.equal(isCaptureSpoolDir(undefined, home), false)
  assert.equal(isCaptureSpoolDir(42, home), false)
})

test('sweepCaptureSpool: removes every file, keeps the directories, reports counts', async () => {
  const home = await tmpDir('sweep')
  try {
    const dir = claudeBodySpoolDir(home)
    const nested = path.join(dir, 'nested')
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(dir, 'a.json'), '0123456789')
    await fs.writeFile(path.join(dir, 'b.json'), '01234')
    await fs.writeFile(path.join(nested, 'c.json'), '012')

    const swept = await sweepCaptureSpool(dir)
    assert.equal(swept.filesRemoved, 3)
    assert.equal(swept.bytesRemoved, 18)
    assert.equal(swept.failed, 0)

    // The directory survives: the client was told this path at attach and is
    // not asked again.
    assert.deepEqual(await fs.readdir(dir), ['nested'])
    assert.deepEqual(await fs.readdir(nested), [])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('sweepCaptureSpool: an absent spool is a no-op, not a failure', async () => {
  const home = await tmpDir('absent')
  try {
    const swept = await sweepCaptureSpool(claudeBodySpoolDir(home))
    assert.deepEqual(swept, { filesRemoved: 0, bytesRemoved: 0, failed: 0 })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('sweepCaptureSpool: a file it cannot remove is counted, not thrown', async () => {
  const home = await tmpDir('failing')
  try {
    const dir = claudeBodySpoolDir(home)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'a.json'), 'x')
    await fs.writeFile(path.join(dir, 'b.json'), 'yy')

    const real = fs
    const failing = /** @type {any} */ ({
      readdir: real.readdir,
      lstat: real.lstat,
      /** @param {string} target @param {unknown} opts */
      rm: async (target, opts) => {
        if (path.basename(target) === 'a.json') throw new Error('EPERM: nope')
        return real.rm(target, /** @type {any} */ (opts))
      },
    })

    const swept = await sweepCaptureSpool(dir, { fs: failing })
    assert.equal(swept.filesRemoved, 1)
    assert.equal(swept.bytesRemoved, 2)
    assert.equal(swept.failed, 1)
    assert.deepEqual(await fs.readdir(dir), ['a.json'])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('sweepCaptureSpool: a symlink is removed as the link, not followed', { skip: process.platform === 'win32' && 'symlink creation needs Developer Mode on win32' }, async () => {
  const home = await tmpDir('symlink')
  const outside = await tmpDir('symlink-target')
  try {
    const kept = path.join(outside, 'keep-me.txt')
    await fs.writeFile(kept, 'not ours')
    const dir = claudeBodySpoolDir(home)
    await fs.mkdir(dir, { recursive: true })
    await fs.symlink(kept, path.join(dir, 'link.json'))

    const swept = await sweepCaptureSpool(dir)
    assert.equal(swept.filesRemoved, 1)
    assert.deepEqual(await fs.readdir(dir), [])
    assert.equal(await fs.readFile(kept, 'utf8'), 'not ours')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  }
})

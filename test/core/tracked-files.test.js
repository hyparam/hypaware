// @ts-check

// The repo-wide source gates (`@ref` hygiene and friends) enumerate their scan
// set with `git ls-files` and then read every path they get back. `git ls-files`
// reports the index, so on a working tree caught mid-rebase or mid-rename a
// tracked path can have no file behind it. These tests pin the guarantee the
// gates rely on: what the listing returns is readable.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { trackedFiles } from '../helpers/tracked_files.js'

/**
 * A throwaway git repository with `files` staged, then `absent` removed from the
 * working tree. Staging alone populates the index, so no commit is needed.
 *
 * @param {Record<string, string>} files
 * @param {string[]} absent paths to delete from disk after staging
 * @returns {string} the repository root
 */
function repoWith(files, absent = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-files-'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  execFileSync('git', ['add', '--all'], { cwd: root })
  for (const rel of absent) fs.rmSync(path.join(root, rel))
  return root
}

test('a tracked path with no file behind it is left out of the listing', () => {
  const root = repoWith({ 'kept.js': 'a', 'renamed-away.js': 'b' }, ['renamed-away.js'])
  try {
    assert.deepEqual(trackedFiles(root).sort(), ['kept.js'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('every listed path can be read, which is what the gates do next', () => {
  const root = repoWith({ 'src/a.js': 'a', 'src/gone.js': 'b', 'docs/d.md': 'c' }, ['src/gone.js'])
  try {
    const listed = trackedFiles(root)
    assert.ok(listed.length > 0, 'expected the staged files')
    for (const rel of listed) {
      assert.doesNotThrow(() => fs.readFileSync(path.join(root, rel), 'utf8'), `unreadable: ${rel}`)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the extension filter and the presence filter both apply', () => {
  const root = repoWith(
    { 'a.js': 'a', 'b.md': 'b', 'c.png': 'c', 'd.js': 'd' },
    ['d.js', 'c.png'],
  )
  try {
    assert.deepEqual(trackedFiles(root, new Set(['.js', '.md'])).sort(), ['a.js', 'b.md'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the real repository listing is non-empty and entirely readable', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..')
  const listed = trackedFiles(repoRoot, new Set(['.js']))
  assert.ok(listed.length > 100, `expected the repo's tracked sources, found ${listed.length}`)
  for (const rel of listed) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `unreadable: ${rel}`)
  }
})

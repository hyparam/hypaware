// @ts-check

// The hygiene gate reads every tracked file it decides to scan, and `git
// ls-files` answers from the index, so a tracked path can be absent from the
// working tree while a rename or a rebase is half-applied. That is a transient
// state of the developer's tree, not a hygiene result, and the gate has to
// survive it: an unguarded `readFileSync` over the index listing throws ENOENT
// at module load, so the file reports nothing at all rather than reporting that
// the annotations are fine.
//
// Proven against the real gate rather than against a copy of its logic: this
// spawns `test/core/llp-ref-hygiene.test.js` with a `git` on PATH that behaves
// exactly like the real one except that `ls-files -z` also names one path with
// no file behind it, so the only difference from a normal run is the condition
// under test.
//
// @ref LLP 0001#tooling [tests]: the gate that has to hold on every push has to hold on a mid-rename tree too

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = path.join('test', 'core', 'llp-ref-hygiene.test.js')

/** A scannable path the index reports and the working tree does not hold. */
const PHANTOM = 'src/core/absent-from-the-working-tree.js'

/**
 * Build a directory holding a `git` that delegates to the real one, except that
 * `ls-files -z` appends one path with no file behind it.
 *
 * @returns {string} the directory to put first on PATH
 */
function shimDir() {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-ls-files-shim-'))
  const shim = [
    '#!/bin/sh',
    'if [ "$1" = "ls-files" ] && [ "$2" = "-z" ]; then',
    `  "${realGit}" "$@" || exit $?`,
    `  printf '${PHANTOM}\\000'`,
    '  exit 0',
    'fi',
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'git'), shim, { mode: 0o755 })
  return dir
}

/**
 * Run the gate as its own process. The test runner skips nested runs when it
 * sees its own context in the environment, so that marker is cleared: without
 * this the child exits 0 having run nothing, and the assertions below would
 * pass against a gate that was never loaded.
 *
 * @param {string} dir the shim directory to put first on PATH
 * @returns {{ status: number | null, output: string }}
 */
function runGate(dir) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` }
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(process.execPath, ['--test', GATE], { cwd: REPO_ROOT, encoding: 'utf8', env })
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

test('the ref hygiene gate reports a result on a tree missing a tracked file', () => {
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, PHANTOM)), `${PHANTOM} must not exist`)
  const dir = shimDir()
  try {
    const { status, output } = runGate(dir)
    assert.ok(
      output.includes('# tests '),
      `the gate ran no tests, so this proves nothing:\n${output.slice(0, 2000)}`,
    )
    assert.ok(
      !output.includes('ENOENT'),
      `the gate died on a tracked path with no file behind it:\n${output.slice(0, 2000)}`,
    )
    assert.equal(status, 0, `the gate failed under the shim:\n${output.slice(0, 2000)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

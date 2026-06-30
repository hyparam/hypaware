// @ts-check

import nodeFs from 'node:fs'
import path from 'node:path'

const GIT_ENTRY = '.git'

/**
 * Find the git repository root governing `startDir`: the nearest ancestor
 * (inclusive) that contains a `.git` entry: a directory for an ordinary
 * clone, a file for a linked worktree or submodule. Returns `null` when
 * `startDir` is not inside a git repository.
 *
 * This is the repo-root resolution the `hyp ignore` CLI reuses to drop a
 * single repo-wide `.hypignore` at the toplevel, mirroring what the
 * Claude/Codex adapters derive with `git rev-parse --show-toplevel` when they
 * stamp `repo_root` (LLP 0049 #cli). It is kept as dependency-free,
 * fs-injectable path logic (an ancestor walk in the same shape as the
 * `.hypignore` matcher) so the CLI need not spawn git and so it stays
 * hermetically unit-testable.
 *
 * @param {string} startDir
 * @param {object} [fs]
 * @param {(p: string) => boolean} [fs.existsSync]
 * @returns {string | null}
 */
export function findRepoRoot(startDir, { existsSync = nodeFs.existsSync } = {}) {
  let dir = path.resolve(startDir)
  while (true) {
    if (existsSync(path.join(dir, GIT_ENTRY))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null // reached the filesystem root
    dir = parent
  }
}

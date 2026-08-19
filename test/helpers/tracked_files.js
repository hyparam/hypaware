// @ts-check

/**
 * The tracked-file listing shared by the repo-wide source gates.
 *
 * `git ls-files` reports the index, not the working tree, so a path it names can
 * be missing from disk: mid-rebase, mid-rename, or any other moment where the two
 * have not converged yet. A gate that feeds that list straight into
 * `fs.readFileSync` throws ENOENT at module load and takes its whole test file
 * with it, which turns a transiently inconsistent checkout into a wall of noise
 * instead of a hygiene result. So the listing is filtered to paths that are
 * actually readable right now, and every caller gets that guarantee for free.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Repo-relative paths that are both tracked by git and present on disk.
 *
 * @param {string} repoRoot absolute path to the repository to list
 * @param {Set<string>} [extensions] when given, keep only paths whose `path.extname` is in it
 * @returns {string[]}
 */
export function trackedFiles(repoRoot, extensions) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  return out
    .split('\0')
    .filter(f => f !== '')
    .filter(f => extensions === undefined || extensions.has(path.extname(f)))
    .filter(f => fs.existsSync(path.join(repoRoot, f)))
}

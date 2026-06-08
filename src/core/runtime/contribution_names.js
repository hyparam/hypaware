// @ts-check

import path from 'node:path'

/**
 * Skill and agent names are interpolated into filesystem destinations
 * (`<skill_dir>/<name>` and `<agent_dir>/<name>.md`). A plugin that
 * registers a name containing path separators, `..`, or an absolute
 * prefix could otherwise steer `install` to write outside the intended
 * client directory. This module centralizes the two guards that keep
 * those writes contained.
 *
 * @ref LLP 0003#principle — names cross the core/plugin trust boundary,
 *   so core validates them rather than trusting plugins.
 */

/**
 * True when `name` is a single, safe path segment: non-empty, not `.` or
 * `..`, with no path separators, null bytes, or absolute prefix. Such a
 * name always stays within whatever directory it is joined to.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSafeContributionName(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name === '.' || name === '..') return false
  if (name.includes('\0')) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (path.isAbsolute(name)) return false
  return path.basename(name) === name
}

/**
 * True when `dest` resolves to a path at or beneath `baseDir`. Defense in
 * depth for the install sites: even if a name or a manifest-supplied
 * directory slipped a traversal segment past registration, the copy is
 * skipped unless the final destination stays under the intended base.
 *
 * @param {string} dest
 * @param {string} baseDir
 * @returns {boolean}
 */
export function isWithinDir(dest, baseDir) {
  const resolvedBase = path.resolve(baseDir)
  const resolvedDest = path.resolve(dest)
  if (resolvedDest === resolvedBase) return true
  const rel = path.relative(resolvedBase, resolvedDest)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

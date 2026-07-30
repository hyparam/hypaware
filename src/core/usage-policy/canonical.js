// @ts-check

import { createHash } from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'

import { Attr } from '../observability/attrs.js'
import { getLogger } from '../observability/logger.js'

/**
 * `error_kind` for a `realpath(2)` that could not fully canonicalize a path.
 * Never fatal: the caller keeps the lexical spelling and the gate stays at
 * least as restrictive as it was (see {@link canonicalSpellings}).
 */
export const PATH_CANONICALIZE_ERROR_KIND = 'path_canonicalize_failed'

/**
 * Short one-way digest of a path, so a canonicalization failure is diagnosable
 * (which path, how often, which errno) without dev telemetry ever carrying a
 * raw local path. Same discipline as the `usage_policy.export_drop` aggregate
 * in `src/core/cache/storage.js`.
 *
 * @param {string} p
 * @returns {string}
 */
function hashPath(p) {
  return createHash('sha256').update(p).digest('hex').slice(0, 16)
}

/**
 * The `errno` code of a filesystem error, as a lowercase token suitable for a
 * log attribute (`enoent`, `eacces`, `eloop`), or `unknown`.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errnoOf(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code
  return typeof code === 'string' && code !== '' ? code.toLowerCase() : 'unknown'
}

/**
 * Canonicalize an absolute directory path, resolving every symlink component
 * that *can* be resolved and re-appending the components that cannot.
 *
 * `fs.realpathSync` is all-or-nothing: it throws `ENOENT` for a path whose leaf
 * does not exist, which is routine here (a `cwd` that has since been deleted, a
 * `local-only` entry for a directory not yet created, a unit test driving the
 * matcher over an injected fs of paths that never existed on disk). Throwing
 * that away entirely would forfeit the symlinked *ancestors*, which is where
 * the interesting case lives: with `/tmp` a symlink to `/private/tmp`,
 * `/tmp/proj/gone` still canonicalizes usefully to `/private/tmp/proj/gone`.
 * So this walks up to the deepest resolvable ancestor and rejoins the tail,
 * reporting how far it got.
 *
 * Never throws. `resolved: 'none'` means not even the filesystem root could be
 * read, and `path` is then the input unchanged.
 *
 * @param {string} abs absolute path (already `path.resolve`d)
 * @param {{ realpathSync?: (p: string) => string }} [deps]
 * @returns {{ path: string, resolved: 'full' | 'partial' | 'none', errno: string | null }}
 */
export function canonicalizeDirSync(abs, { realpathSync = nodeFs.realpathSync } = {}) {
  /** @type {string[]} */
  const missing = []
  /** @type {string | null} */
  let firstErrno = null
  let dir = abs
  while (true) {
    try {
      const real = realpathSync(dir)
      if (missing.length === 0) return { path: real, resolved: 'full', errno: null }
      return { path: path.join(real, ...missing.reverse()), resolved: 'partial', errno: firstErrno }
    } catch (err) {
      if (firstErrno === null) firstErrno = errnoOf(err)
      const parent = path.dirname(dir)
      if (parent === dir) return { path: abs, resolved: 'none', errno: firstErrno }
      missing.push(path.basename(dir))
      dir = parent
    }
  }
}

/**
 * Every path spelling that denotes the same directory as `target`: the lexical
 * absolute form first, then the canonical (symlink-resolved) form when it
 * differs.
 *
 * This is the shape the whole usage-policy gate is built on, and the reason it
 * is a *set* rather than a single canonical answer is a privacy argument, not a
 * convenience. `path.resolve` is lexical, so on `master` an ancestor walk from
 * a symlinked `cwd` climbed the symlink's parents and never met the
 * `.hypignore` governing the real directory. Canonicalizing *instead of* the
 * lexical form fixes that leak and opens another: a `local-only` entry the user
 * declared by its symlink spelling stops governing, so a directory the user
 * marked private starts forwarding. Resolving over both spellings and taking
 * the most restrictive verdict closes the first without opening the second, and
 * makes the failure mode structural: a `realpath` that fails can only remove a
 * *candidate* spelling, never a verdict some other spelling already produced,
 * so canonicalization can only ever move the gate toward more restrictive,
 * never toward `full`.
 *
 * Producing a set of spellings is necessary but not sufficient for that
 * invariant: a consumer that picks *one* of the matching spellings (the
 * machine-local list's nearest-governs argmax) can still lose a restrictive
 * verdict, so it also has to evaluate its rule over the declared spellings
 * alone and keep the more restrictive of the two answers. See
 * `selectGoverning` in `matcher.js`.
 *
 * A failure is reported as a `debug` aggregate (routine: a deleted or
 * not-yet-created directory), escalating to `warn` only for `resolved: 'none'`,
 * which means the filesystem itself refused every ancestor. Paths are hashed.
 *
 * @ref LLP 0050#canonicalization [implements]: the gate resolves over as-given and canonical spellings, most restrictive wins
 * @param {string} target
 * @param {{ realpathSync?: (p: string) => string, component?: string }} [deps]
 * @returns {string[]} lexical spelling first; length 1 when the two coincide
 */
export function canonicalSpellings(target, { realpathSync, component = 'usage-policy' } = {}) {
  const lexical = path.resolve(target)
  const outcome = canonicalizeDirSync(lexical, realpathSync ? { realpathSync } : undefined)
  if (outcome.resolved !== 'full') {
    const logger = getLogger('usage-policy')
    const attrs = {
      [Attr.COMPONENT]: component,
      [Attr.OPERATION]: 'usage_policy.canonicalize',
      status: 'degraded',
      [Attr.ERROR_KIND]: PATH_CANONICALIZE_ERROR_KIND,
      errno: outcome.errno,
      resolved: outcome.resolved,
      path_hash: hashPath(lexical),
    }
    if (outcome.resolved === 'none') logger.warn('usage_policy.canonicalize_failed', attrs)
    else logger.debug('usage_policy.canonicalize_failed', attrs)
  }
  return outcome.path === lexical ? [lexical] : [lexical, outcome.path]
}

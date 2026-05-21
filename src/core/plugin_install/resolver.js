// @ts-check

import path from 'node:path'

import { applyGitSourceFlags, parseGitSource } from './git_source.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginSourceSpec} PluginSourceSpec */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginSourceKind} PluginSourceKind */

const SCOPED_NAME_RE = /^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/i
const UNSCOPED_NAME_RE = /^([a-z0-9][a-z0-9._-]*)$/i
const GIT_PREFIX_RE = /^(github:|gitlab:|bitbucket:|git\+|git:|ssh:|https?:\/\/|file:\/\/)/i
const FIRST_PARTY_SCOPE = '@hypaware/'
const THIRD_PARTY_SCOPED_PREFIX = 'hypaware-plugin-'
const THIRD_PARTY_UNSCOPED_PREFIX = 'hypaware-plugin-'

/**
 * Resolve a raw `hyp plugin install <source>` token into a
 * `PluginSourceSpec`. The kernel keeps a fixed precedence so a
 * developer can predict which path will fire:
 *
 *   1. Anything beginning with `./`, `/`, or `../`, or that exists on
 *      disk under `cwd`, is a `local-dir` source. Used for in-repo
 *      development against `hypaware-core/plugins-workspace/<name>`.
 *   2. A token matching a known git prefix (`github:`, `git+https://`,
 *      `https://...git`, `ssh://`, etc.) is a `git` source. The
 *      resolver does not contact the network — it records the URL on
 *      the spec and lets `fetch` perform the clone.
 *   3. A scoped name beginning with `@hypaware/` is a first-party
 *      plugin. It maps to `github:hyperparam/hypaware-<name>` per
 *      design §Plugin Install and Locking.
 *   4. A scoped name `@<scope>/hypaware-plugin-<name>` is a
 *      third-party scoped plugin. The resolver records the npm name
 *      so the fetcher can look up `repository` in the npm registry.
 *   5. An unscoped `hypaware-plugin-<name>` is a third-party unscoped
 *      plugin, same registry lookup path.
 *
 * Everything else is rejected with a thrown `Error`. The resolver is
 * a pure function — no I/O — so the dispatcher can call it inside the
 * `plugin.install` span without surprises.
 *
 * @param {string} rawSource
 * @param {{ cwd?: string, ref?: string, subdir?: string }} [opts]
 * @returns {PluginSourceSpec}
 */
export function resolveSource(rawSource, opts = {}) {
  if (typeof rawSource !== 'string' || rawSource.length === 0) {
    throw new Error('plugin install: source must be a non-empty string')
  }
  const cwd = opts.cwd ?? process.cwd()
  const trimmed = rawSource.trim()

  // Git URLs win over the local-path heuristic so a `github:org/repo`
  // doesn't accidentally land on `looksLikeLocalPath`'s slash test.
  if (GIT_PREFIX_RE.test(trimmed)) {
    const parts = parseGitSource(trimmed)
    const enriched = applyGitSourceFlags(parts, { ref: opts.ref, subdir: opts.subdir })
    /** @type {PluginSourceSpec} */
    const spec = {
      kind: 'git',
      raw: rawSource,
      gitUrl: enriched.gitUrl,
    }
    if (enriched.ref) spec.ref = enriched.ref
    if (enriched.subdir) /** @type {PluginSourceSpec & { subdir?: string }} */ (spec).subdir = enriched.subdir
    return spec
  }

  if (looksLikeLocalPath(trimmed)) {
    const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed)
    return /** @type {PluginSourceSpec} */ ({
      kind: 'local-dir',
      raw: rawSource,
      path: abs,
    })
  }

  if (trimmed.startsWith(FIRST_PARTY_SCOPE)) {
    const shortName = trimmed.slice(FIRST_PARTY_SCOPE.length)
    if (!UNSCOPED_NAME_RE.test(shortName)) {
      throw new Error(`plugin install: invalid first-party name '${trimmed}'`)
    }
    return {
      kind: 'first-party',
      raw: rawSource,
      name: trimmed,
      gitUrl: `github:hyperparam/hypaware-${shortName}`,
    }
  }

  const scoped = SCOPED_NAME_RE.exec(trimmed)
  if (scoped) {
    const [, , bareName] = scoped
    if (!bareName.startsWith(THIRD_PARTY_SCOPED_PREFIX)) {
      throw new Error(
        `plugin install: scoped third-party plugins must use the '${THIRD_PARTY_SCOPED_PREFIX}<name>' naming convention (got '${trimmed}')`
      )
    }
    return {
      kind: 'scoped-third-party',
      raw: rawSource,
      name: trimmed,
    }
  }

  if (trimmed.startsWith(THIRD_PARTY_UNSCOPED_PREFIX)) {
    if (!UNSCOPED_NAME_RE.test(trimmed)) {
      throw new Error(`plugin install: invalid plugin name '${trimmed}'`)
    }
    return {
      kind: 'unscoped-third-party',
      raw: rawSource,
      name: trimmed,
    }
  }

  if (UNSCOPED_NAME_RE.test(trimmed)) {
    throw new Error(
      `plugin install: bare name '${trimmed}' must be prefixed with 'hypaware-plugin-' or scoped under '@hypaware/' / '@<scope>/hypaware-plugin-'`
    )
  }

  throw new Error(`plugin install: cannot resolve source '${rawSource}'`)
}

/**
 * Heuristic for "this looks like a local filesystem path." The CLI
 * design treats `./foo`, `/abs/foo`, `../foo`, and `foo/bar` as local
 * — anything that isn't a bare identifier and lacks a git protocol
 * prefix. The resolver does not stat the path; absence is handled by
 * `fetch.js` so the developer gets a `local_dir_missing` error_kind
 * instead of a confusing "unknown command" message.
 *
 * @param {string} raw
 */
function looksLikeLocalPath(raw) {
  if (raw === '.' || raw === '..') return true
  if (raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('/')) return true
  if (raw.startsWith('~/')) return true
  // A token that contains a slash but no git prefix and isn't a scoped
  // npm name (which would have matched the explicit scope branches).
  if (raw.includes('/') && !raw.startsWith('@')) return true
  return false
}

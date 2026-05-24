// @ts-check

/**
 * @import { PluginSourceSpec } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { GitSourceParts } from './types.d.ts'
 */

const HTTPS_GITHUB_RE = /^https?:\/\/(?:[^@/\s]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:#(.+))?$/i
const GITHUB_SHORTHAND_RE = /^github:([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i
const GIT_SSH_GITHUB_RE = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?(?:#(.+))?$/i
const PASSTHROUGH_GIT_RE = /^(?:git\+|git:|ssh:|https?:\/\/|gitlab:|bitbucket:|file:\/\/)/i


/**
 * Pure parser for the git URL forms `hyp plugin install` accepts:
 *
 *   1. `https://github.com/<owner>/<repo>.git[#<ref>]`
 *   2. `https://github.com/<owner>/<repo>[#<ref>]`           (no `.git`)
 *   3. `github:<owner>/<repo>[#<ref>]`                       (shorthand)
 *   4. `git@github.com:<owner>/<repo>.git[#<ref>]`           (SSH shorthand)
 *
 * Other git-prefixed URLs (gitlab:, bitbucket:, generic git+/git:/ssh:)
 * are accepted as-is so plugin authors using non-GitHub hosts still get
 * a working install path — owner/repo/host telemetry just stays empty.
 *
 * Returns the normalized HTTPS clone URL, parsed `ref` (URL fragment),
 * and GitHub owner/repo/host segments when discoverable. Throws when
 * the token starts with a recognized git prefix but otherwise fails to
 * parse — callers funnel the throw into the `resolver_error` span attr.
 *
 * @param {string} raw
 * @returns {GitSourceParts}
 */
export function parseGitSource(raw) {
  const trimmed = raw.trim()

  // Reject anything that begins with `-` so a value like
  // `--upload-pack=<cmd>` cannot smuggle a git option through callers
  // that build argv positionals. The `--` separator we add at the
  // execGit boundary is belt-and-braces; this is the suspenders.
  if (trimmed.startsWith('-')) {
    throw newGitSourceError(
      'resolver_error',
      `plugin install: git source must not start with '-' (got '${truncate(raw)}')`
    )
  }

  const httpsMatch = HTTPS_GITHUB_RE.exec(trimmed)
  if (httpsMatch) {
    const [, owner, repoRaw, ref] = httpsMatch
    const repo = stripGitSuffix(repoRaw)
    return {
      gitUrl: `https://github.com/${owner}/${repo}.git`,
      ref: validateFragmentRef(ref),
      owner,
      repo,
      host: 'github.com',
    }
  }

  const shortMatch = GITHUB_SHORTHAND_RE.exec(trimmed)
  if (shortMatch) {
    const [, owner, repoRaw, ref] = shortMatch
    const repo = stripGitSuffix(repoRaw)
    return {
      gitUrl: `https://github.com/${owner}/${repo}.git`,
      ref: validateFragmentRef(ref),
      owner,
      repo,
      host: 'github.com',
    }
  }

  const sshMatch = GIT_SSH_GITHUB_RE.exec(trimmed)
  if (sshMatch) {
    const [, owner, repoRaw, ref] = sshMatch
    const repo = stripGitSuffix(repoRaw)
    return {
      gitUrl: `https://github.com/${owner}/${repo}.git`,
      ref: validateFragmentRef(ref),
      owner,
      repo,
      host: 'github.com',
    }
  }

  if (PASSTHROUGH_GIT_RE.test(trimmed)) {
    // Non-GitHub clone URL — split a `#<ref>` fragment if present, then
    // strip any `user:pass@` userinfo from the resulting URL so the
    // persisted spec never carries credentials.
    const hashIdx = trimmed.lastIndexOf('#')
    if (hashIdx > 0 && hashIdx < trimmed.length - 1) {
      return {
        gitUrl: redactGitUrl(trimmed.slice(0, hashIdx)),
        ref: validateFragmentRef(trimmed.slice(hashIdx + 1)),
      }
    }
    return { gitUrl: redactGitUrl(trimmed) }
  }

  throw new Error(`plugin install: cannot parse git source '${truncate(raw)}'`)
}

/**
 * Vet a `#<ref>` fragment so it cannot smuggle a git option through
 * the eventual `git checkout <ref>` / `git ls-remote ... <ref>` call.
 * The CLI parser applies the same rule to explicit `--ref` values via
 * `applyGitSourceFlags`; mirroring it here keeps URL-fragment refs on
 * the same footing.
 *
 * @param {string | undefined} ref
 * @returns {string | undefined}
 */
function validateFragmentRef(ref) {
  if (!ref) return undefined
  if (ref.startsWith('-')) {
    throw newGitSourceError(
      'resolver_error',
      `plugin install: URL fragment ref must not start with '-' (got '${truncate(ref)}')`
    )
  }
  return ref
}

/**
 * Apply `--ref` / `--path` (subdir) CLI flags on top of a base
 * `GitSourceParts`. Enforces the two design-mandated rules:
 *
 * - Providing `--ref` AND a URL `#<ref>` fragment is ambiguous → throw
 *   `source_ambiguous`.
 * - Providing `--path <subdir>` is unsupported in MVP → throw
 *   `git_subdir_unsupported`. The `--path` slot is reserved for a
 *   future implementation; today the function rejects the flag before
 *   it can reach the resolver.
 *
 * Both `--ref` and `--path` values are also rejected when they begin
 * with `-` so a token like `--upload-pack=<cmd>` cannot be smuggled
 * through as a positional git argument.
 *
 * The caller decides how to wire the throw into telemetry; the kernel
 * funnels it through `resolveSource()`'s `resolver_error` path.
 *
 * @param {GitSourceParts} parts
 * @param {{ ref?: string, subdir?: string }} [opts]
 * @returns {GitSourceParts}
 */
export function applyGitSourceFlags(parts, opts = {}) {
  let ref = parts.ref
  if (opts.ref !== undefined) {
    if (opts.ref.startsWith('-')) {
      throw newGitSourceError(
        'resolver_error',
        `plugin install: --ref value must not start with '-' (got '${truncate(opts.ref)}')`
      )
    }
    if (parts.ref) {
      throw newGitSourceError(
        'source_ambiguous',
        `plugin install: --ref '${opts.ref}' conflicts with URL fragment '#${parts.ref}'`
      )
    }
    ref = opts.ref
  }

  const subdir = opts.subdir
  if (subdir !== undefined) {
    if (subdir.startsWith('-')) {
      throw newGitSourceError(
        'resolver_error',
        `plugin install: --path value must not start with '-' (got '${truncate(subdir)}')`
      )
    }
    throw newGitSourceError(
      'git_subdir_unsupported',
      `plugin install: --path '${subdir}' is reserved but not yet supported`
    )
  }

  return { ...parts, ref }
}

/**
 * Strip `user:pass@` userinfo from a URL so the resulting form is safe
 * to persist in the lock entry or echo back to the user in a
 * confirmation prompt. RFC 3986 forbids `@` inside the host segment,
 * so the regex below targets exactly the `<scheme>://...@` userinfo
 * span and leaves the rest of the URL untouched.
 *
 * @param {string} url
 * @returns {string}
 */
export function redactGitUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return url
  return url.replace(/^([a-z][a-z0-9+.\-]*:\/\/)[^@/\s]*@/i, '$1')
}

/**
 * Same idea as `redactGitUrl` but operates on the raw token the user
 * typed (which may include a `#<ref>` fragment, a custom `git+`/`git:`
 * prefix, or be an entirely non-URL shorthand like `github:owner/repo`).
 * Splits the fragment so the redactor only touches the URL portion,
 * then reattaches the unchanged ref.
 *
 * @param {string} raw
 * @returns {string}
 */
export function redactRawSource(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return raw
  const hashIdx = raw.lastIndexOf('#')
  if (hashIdx > 0 && hashIdx < raw.length - 1) {
    const head = raw.slice(0, hashIdx)
    const tail = raw.slice(hashIdx)
    return redactGitUrl(head) + tail
  }
  return redactGitUrl(raw)
}

/**
 * Truncate a long user-supplied value so it does not flood error
 * messages or span attributes. Keep enough characters to make the
 * problem identifiable without printing a runaway argument.
 *
 * @param {string} value
 */
function truncate(value) {
  if (typeof value !== 'string') return ''
  return value.length > 120 ? `${value.slice(0, 117)}...` : value
}

/**
 * Build a stable error with an attached `hypErrorKind` so the resolver
 * can map it onto the install span's `error_kind`.
 *
 * @param {string} kind
 * @param {string} message
 */
function newGitSourceError(kind, message) {
  /** @type {Error & { hypErrorKind?: string }} */
  const err = new Error(message)
  err.hypErrorKind = kind
  return err
}

/**
 * @param {string} repo
 */
function stripGitSuffix(repo) {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo
}

/**
 * Derive host/owner/repo from a git URL for telemetry. Returns an
 * empty object for unparseable URLs (e.g. SSH shorthand that doesn't
 * round-trip through the `URL` constructor) so callers can skip
 * setting attributes without conditional logic.
 *
 * @param {string} gitUrl
 * @returns {{ host?: string, owner?: string, repo?: string }}
 */
export function provenanceFromUrl(gitUrl) {
  if (!gitUrl) return {}
  try {
    const u = new URL(gitUrl)
    const host = u.host || u.hostname
    const segs = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/').filter(Boolean)
    if (segs.length >= 2) {
      return { host, owner: segs[0], repo: segs[1] }
    }
    return { host }
  } catch {
    return {}
  }
}

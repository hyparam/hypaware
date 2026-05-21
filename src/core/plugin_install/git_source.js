// @ts-check

/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginSourceSpec} PluginSourceSpec */

const HTTPS_GITHUB_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:#(.+))?$/i
const GITHUB_SHORTHAND_RE = /^github:([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/i
const GIT_SSH_GITHUB_RE = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?(?:#(.+))?$/i
const PASSTHROUGH_GIT_RE = /^(?:git\+|git:|ssh:|https?:\/\/|gitlab:|bitbucket:|file:\/\/)/i

/**
 * @typedef {Object} GitSourceParts
 * @property {string} gitUrl  HTTPS-normalized clone URL (or untouched for non-GitHub sources)
 * @property {string} [ref]   Ref parsed from a `#fragment`, if present
 * @property {string} [owner] GitHub owner segment (for telemetry / lock provenance)
 * @property {string} [repo]  GitHub repo segment (for telemetry / lock provenance)
 * @property {string} [host]  URL host (for telemetry)
 */

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

  const httpsMatch = HTTPS_GITHUB_RE.exec(trimmed)
  if (httpsMatch) {
    const [, owner, repoRaw, ref] = httpsMatch
    const repo = stripGitSuffix(repoRaw)
    return {
      gitUrl: `https://github.com/${owner}/${repo}.git`,
      ref: ref || undefined,
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
      ref: ref || undefined,
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
      ref: ref || undefined,
      owner,
      repo,
      host: 'github.com',
    }
  }

  if (PASSTHROUGH_GIT_RE.test(trimmed)) {
    // Non-GitHub clone URL — split a `#<ref>` fragment if present but
    // leave the URL otherwise untouched.
    const hashIdx = trimmed.lastIndexOf('#')
    if (hashIdx > 0 && hashIdx < trimmed.length - 1) {
      return {
        gitUrl: trimmed.slice(0, hashIdx),
        ref: trimmed.slice(hashIdx + 1),
      }
    }
    return { gitUrl: trimmed }
  }

  throw new Error(`plugin install: cannot parse git source '${raw}'`)
}

/**
 * Apply `--ref` / `--path` (subdir) CLI flags on top of a base
 * `GitSourceParts`. Enforces the two design-mandated rules:
 *
 * - Providing `--ref` AND a URL `#<ref>` fragment is ambiguous → throw
 *   `source_ambiguous`.
 * - Providing `--path <subdir>` is unsupported in MVP → throw
 *   `git_subdir_unsupported`, with the value still recorded on the
 *   returned spec so the eventual lock entry shape stays forward
 *   compatible.
 *
 * The caller decides how to wire the throw into telemetry; the kernel
 * funnels it through `resolveSource()`'s `resolver_error` path.
 *
 * @param {GitSourceParts} parts
 * @param {{ ref?: string, subdir?: string }} [opts]
 * @returns {GitSourceParts & { subdir?: string }}
 */
export function applyGitSourceFlags(parts, opts = {}) {
  let ref = parts.ref
  if (opts.ref) {
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
    throw newGitSourceError(
      'git_subdir_unsupported',
      `plugin install: --path '${subdir}' is reserved but not yet supported`
    )
  }

  return { ...parts, ref, ...(subdir !== undefined ? { subdir } : {}) }
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

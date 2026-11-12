// @ts-check

import nodeFs from 'node:fs'
import path from 'node:path'

import { findRepoRoot } from './repo_root.js'

/**
 * @import { RepoScopeResolver } from '../../../src/core/cache/types.js'
 * @import { ResolveResult, UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 */

// How long a derived verdict is trusted. Longer than the directory list's
// 5s because the input is a repository's `origin` remote, which changes
// rarely, and a miss costs an ancestor walk plus up to three small reads.
const CACHE_TTL_MS = 60_000

// Both memo maps are keyed by values the cache already holds (distinct
// `cwd`s, distinct remotes), so they stay small in practice; the cap only
// bounds a pathological cache in a long-running daemon.
const CACHE_MAX_ENTRIES = 4096

/**
 * Normalize one `sync_repos` entry to `host/owner` or `host/owner/repo`,
 * lowercased, or `null` when it is not one of those two shapes. Hosts and
 * GitHub-style owner/repo names are matched case-insensitively.
 *
 * @param {unknown} entry
 * @returns {string | null}
 */
export function normalizeRepoPrefix(entry) {
  if (typeof entry !== 'string') return null
  const parts = entry.trim().toLowerCase().split('/')
  if (parts.length < 2 || parts.length > 3) return null
  if (parts.some((part) => part === '' || /[\s:@?#]/.test(part))) return null
  const last = parts.length - 1
  if (last === 2 && parts[last].endsWith('.git')) parts[last] = parts[last].slice(0, -4)
  return parts[last] === '' ? null : parts.join('/')
}

/**
 * Reduce a git remote (scp-like SSH or URL form) to `host/owner/repo`,
 * lowercased, with credentials, port, and a trailing `.git` dropped. A
 * nested path (GitLab subgroups) keeps every segment, so an allowlist entry
 * matches it by prefix. Returns `null` for anything else (a local path
 * remote, an empty string).
 *
 * @param {unknown} remote
 * @returns {string | null}
 */
export function repoIdentityFromRemote(remote) {
  if (typeof remote !== 'string' || remote === '') return null
  const value = remote.trim()
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(value)
  const scp = url ? null : /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value)
  const match = url ?? scp
  if (!match) return null
  let repoPath = match[2].replace(/^\/+/, '').replace(/\/+$/, '')
  if (repoPath.endsWith('.git')) repoPath = repoPath.slice(0, -4)
  if (repoPath === '' || !repoPath.includes('/') || /[\s?#]/.test(repoPath)) return null
  return `${match[1]}/${repoPath}`.toLowerCase()
}

/**
 * Read the `origin` remote of the repository governing `dir` straight from
 * its git config, without spawning git: this runs inside the export scan.
 * Follows a `.git` file (linked worktree, submodule) to its git dir and a
 * `commondir` pointer to the shared config. A directory that no longer
 * exists still resolves through its nearest surviving ancestor, which is
 * how a session recorded in a since-deleted worktree finds its repository.
 *
 * @param {string} dir
 * @param {{ existsSync?: (p: string) => boolean, readFileSync?: (p: string, encoding: 'utf8') => string }} [fs]
 * @returns {string | null}
 */
export function readOriginRemote(dir, { existsSync = nodeFs.existsSync, readFileSync = nodeFs.readFileSync } = {}) {
  const root = findRepoRoot(dir, { existsSync })
  if (root === null) return null
  /** @param {string} file */
  const read = (file) => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }
  let gitDir = path.join(root, '.git')
  // A regular file here is a pointer; reading a directory fails and leaves
  // `gitDir` as the ordinary clone's `.git`.
  const pointer = read(gitDir)
  if (pointer !== null) {
    const target = /^gitdir:\s*(.+)$/m.exec(pointer)
    if (!target) return null
    gitDir = path.resolve(root, target[1].trim())
  }
  const common = read(path.join(gitDir, 'commondir'))
  if (common !== null && common.trim() !== '') gitDir = path.resolve(gitDir, common.trim())
  const config = read(path.join(gitDir, 'config'))
  if (config === null) return null
  let inOrigin = false
  for (const raw of config.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]/i.test(line)
      continue
    }
    if (!inOrigin) continue
    const url = /^url\s*=\s*(.+)$/i.exec(line)
    if (url) return url[1].trim()
  }
  return null
}

/**
 * Build the export seam's repository-scope resolver from an organization's
 * `sync_repos` allowlist. A row is withheld when its repository cannot be
 * shown to sit under one of the allowed prefixes: the row's own recorded
 * `git_remote` decides when it has one, otherwise the `origin` remote of
 * the repository its `cwd` is in, read from disk now. A `cwd` outside any
 * repository, or in one with no `origin`, is withheld.
 *
 * A row carrying neither value is left to the other seam rules: datasets
 * with no session directory (OTel signals, GitHub activity) are outside
 * this rule's reach, exactly as they are outside `local-only`'s.
 *
 * Entries that do not normalize are ignored here; config validation rejects
 * them before a config reaches boot.
 *
 * @ref LLP 0601#rule [implements]: a row syncs only when its repository is under an allowed prefix; undeterminable repositories stay local
 * @ref LLP 0601#evidence [implements]: the recorded remote decides first, the directory's current origin second
 * @param {{
 *   allowed: ReadonlyArray<string>,
 *   existsSync?: (p: string) => boolean,
 *   readFileSync?: (p: string, encoding: 'utf8') => string,
 *   now?: () => number,
 *   ttlMs?: number,
 * }} args
 * @returns {RepoScopeResolver}
 */
export function createRepoScopeResolver({ allowed, existsSync, readFileSync, now = Date.now, ttlMs = CACHE_TTL_MS }) {
  const prefixes = [...new Set(allowed.map(normalizeRepoPrefix).filter((p) => p !== null))].sort()

  /** @type {Map<string, boolean>} */
  const byRemote = new Map()
  /** @type {Map<string, { inScope: boolean, expiresAt: number }>} */
  const byCwd = new Map()

  /** @param {string | null} identity */
  const identityInScope = (identity) =>
    identity !== null && prefixes.some((prefix) => identity === prefix || identity.startsWith(`${prefix}/`))

  /** @param {string} remote */
  function remoteInScope(remote) {
    let inScope = byRemote.get(remote)
    if (inScope === undefined) {
      inScope = identityInScope(repoIdentityFromRemote(remote))
      if (byRemote.size >= CACHE_MAX_ENTRIES) byRemote.clear()
      byRemote.set(remote, inScope)
    }
    return inScope
  }

  /** @param {string} cwd */
  function cwdInScope(cwd) {
    const at = now()
    const cached = byCwd.get(cwd)
    if (cached && cached.expiresAt > at) return cached.inScope
    const remote = readOriginRemote(cwd, { existsSync, readFileSync })
    const inScope = remote !== null && remoteInScope(remote)
    if (byCwd.size >= CACHE_MAX_ENTRIES) byCwd.clear()
    byCwd.set(cwd, { inScope, expiresAt: at + ttlMs })
    return inScope
  }

  return {
    prefixes,
    withholds(gitRemote, cwd) {
      if (typeof gitRemote === 'string' && gitRemote !== '') return !remoteInScope(gitRemote)
      if (typeof cwd === 'string' && cwd !== '') return !cwdInScope(cwd)
      return false
    },
    // The allowlist is fixed for the life of the process (a config change
    // restarts the daemon), so the digest is the list itself.
    // @ref LLP 0367#policy-fingerprint [implements]: the repository-scope part of the export-policy fingerprint
    fingerprint() {
      return prefixes.join(',')
    },
  }
}

// What a directory outside the allowlist reports as its governing source.
const SYNC_REPOS_GOVERNOR = 'config:sync_repos'

/**
 * Fold a repository allowlist into a usage-policy resolver, for the query
 * seam: a directory nothing else governs, whose repository is outside the
 * allowlist, resolves `local-only`, because that is how the export seam
 * treats its rows. The class lattice then does the rest. A session in an
 * allowed repository is `full` and cannot read rows from outside the list
 * into its uploaded transcript; a session outside the list is `local-only`
 * and reads everything, since its own transcript never leaves.
 *
 * `rowClass` restates the export seam's rule (`storage.js`
 * `rowWithholdReason`) so the two seams agree row for row: an explicit
 * machine-local or dotfile answer stands, and otherwise the recorded
 * remote decides before the directory does.
 *
 * @ref LLP 0601#query-seam [implements]: rows the allowlist keeps local are local-only to the query seam too
 * @ref LLP 0105 [constrained-by]: same lattice, same caller rule; only the row's class gains an input
 * @param {UsagePolicyResolver} base
 * @param {RepoScopeResolver} scope
 * @returns {UsagePolicyResolver}
 */
export function withRepoScope(base, scope) {
  /** @type {ResolveResult} */
  const outside = { class: 'local-only', governedBy: SYNC_REPOS_GOVERNOR, declared: 'local-only' }
  return {
    resolve(cwd) {
      const verdict = base.resolve(cwd)
      if (verdict.class === 'full' && verdict.governedBy === null && scope.withholds(undefined, cwd)) return outside
      return verdict
    },
    isIgnored: (cwd) => base.isIgnored(cwd),
    rowClass(cwd, gitRemote) {
      let explicitSync = false
      if (typeof cwd === 'string' && cwd !== '') {
        const verdict = base.resolve(cwd)
        if (verdict.class !== 'full') return verdict.class
        explicitSync = verdict.governedBy !== null
      }
      return !explicitSync && scope.withholds(gitRemote, cwd) ? 'local-only' : 'full'
    },
    fingerprint: () => `${base.fingerprint?.() ?? 'none'} repo:${scope.fingerprint()}`,
  }
}

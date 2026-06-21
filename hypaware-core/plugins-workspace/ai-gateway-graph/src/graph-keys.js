// @ts-check

/**
 * Bridge-key vocabulary for cross-source convergence — owned by this connector.
 *
 * Graph node ids are content-addressed over `(kind, type, natural key)`
 * (LLP 0023 §content-addressed-ids), so the natural key *is* the identity:
 * two contracts converge on one node iff they normalize the **same key
 * identically**. The `Repo` / `Commit` / `File` recipes live here, beside the
 * contract that mints those node types (`graph_contract.js`) — not in the
 * generic `@hypaware/context-graph` engine, which stays node-type-agnostic. A
 * node type's identity recipe belongs to the plugin that emits it; the engine
 * only provides the type-blind `nodeId` / `edgeId` / `makeRowBuilders`
 * primitives, so the substrate scales to many (incl. unofficial) plugins
 * without privileging a blessed set of node types.
 *
 * The recipes here are **byte-identical** to `github-hyp-plugin/src/keys.js`:
 * that is what makes a repo, commit, or file seen by both the GitHub source and
 * a recorded Claude/Codex session land on one node. This connector is the
 * host-side twin of that GitHub `keys.js`. The cross-repo contract is enforced
 * by digest pins on both sides (host: `test/plugins/ai-gateway-graph-bridge.test.js`;
 * GitHub plugin: `test/graph-ids.test.js`) — if either side changes a recipe,
 * the pins mismatch and the change becomes a deliberate, visible decision
 * rather than a silent orphaning. The two are kept in sync by hand; the plugins
 * are decoupled (separate repos), so a shared module isn't an option — and the
 * engine is not it either, since convergence is pin-enforced, not engine-hosted.
 *
 * The host adds two reconciliation steps the GitHub side does not need (it
 * receives `owner/repo` and repo-relative paths straight from the API): turning
 * a captured git **remote URL** into `owner/repo`, and a captured **absolute
 * local path** into a repo-relative path against the repo root.
 *
 * @ref LLP 0032#shared-key-vocabulary [implements] — connector-owned bridge keys; Repo/Commit/File byte-identical to the GitHub side
 */

// ---------------------------------------------------------------------------
// Verbatim from github-hyp-plugin/src/keys.js — KEEP IN SYNC.
// @ref LLP 0032#shared-key-vocabulary [constrained-by] — byte-identical to the GitHub side or the join silently stops converging
// ---------------------------------------------------------------------------

/**
 * Lowercase a GitHub identifier (`owner`, `repo`). GitHub looks these up
 * case-insensitively but preserves display case; lowercasing guarantees
 * convergence and kills case-drift.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeLogin(value) {
  const s = str(value)
  return s ? s.toLowerCase() : null
}

/**
 * Repo-relative POSIX path: forward slashes, no leading slash, no `./`. The
 * local-absolute → repo-relative reconciliation is {@link relativizePath}; this
 * only canonicalizes an already-relative path (and matches the GitHub side,
 * which canonicalizes a path GitHub returns repo-relative).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeRelpath(value) {
  let s = str(value)
  if (!s) return null
  s = s.replace(/\\/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  while (s.startsWith('/')) s = s.slice(1)
  return s.length > 0 ? s : null
}

/**
 * `Repo` key — `owner/repo`, lowercased. Accepts either `(owner, repo)` or a
 * single `owner/repo` string. github.com is implied in V1 (no host segment —
 * see LLP 0032 §github-only-v1).
 *
 * @param {unknown} ownerOrFull
 * @param {unknown} [repo]
 * @returns {string | null}
 */
export function repoKey(ownerOrFull, repo) {
  if (repo === undefined) {
    const full = str(ownerOrFull)
    if (!full) return null
    const slash = full.indexOf('/')
    if (slash <= 0 || slash === full.length - 1) return null
    return `${full.slice(0, slash).toLowerCase()}/${full.slice(slash + 1).toLowerCase()}`
  }
  const o = normalizeLogin(ownerOrFull)
  const r = normalizeLogin(repo)
  if (!o || !r) return null
  return `${o}/${r}`
}

/**
 * `File` key — `owner/repo:relpath`. The repo half is normalized via
 * {@link repoKey}, the path via {@link normalizeRelpath}. A rename is a new
 * `File` (T0 keys path, not content). The `relpath` here is already
 * repo-relative; see {@link fileKeyFromParts} for the local-absolute form.
 *
 * @param {unknown} repoFull  `owner/repo` (any case)
 * @param {unknown} relpath
 * @returns {string | null}
 */
export function fileKey(repoFull, relpath) {
  const rk = repoKey(repoFull)
  const rp = normalizeRelpath(relpath)
  if (!rk || !rp) return null
  return `${rk}:${rp}`
}

/**
 * Coerce a value to a non-empty string, or null. Numbers/bigints stringify.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function str(value) {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

// ---------------------------------------------------------------------------
// Host-side additions: remote-URL → owner/repo, absolute path → relpath,
// and the 40-hex commit guard. These have no GitHub-side twin (the GitHub
// source gets owner/repo + repo-relative paths from the API directly), but
// they FEED the verbatim recipes above, so the resulting keys still converge.
// ---------------------------------------------------------------------------

/** github.com hosts we accept in V1. Other hosts need host-qualified keys (LLP 0032 §github-only-v1). */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * Parse a git remote URL into `owner/repo` (display case preserved; the
 * lowercasing happens in {@link repoKey}). Handles the forms git actually
 * stores:
 *
 *  - `git@github.com:owner/repo.git`     (scp-like SSH)
 *  - `ssh://git@github.com/owner/repo.git`
 *  - `https://github.com/owner/repo.git` (with optional `user:token@`)
 *  - `git://github.com/owner/repo.git`
 *
 * V1 is **github.com only** — a non-github remote returns null (no bridge-ready
 * `Repo`; the file/commit stay keyed on their fallbacks). Host-qualified keys
 * for other forges are a reserved migration (LLP 0032 §github-only-v1), not a
 * silent same-`owner/repo` collision across forges.
 *
 * @param {unknown} remote
 * @returns {string | null}
 */
export function ownerRepoFromRemote(remote) {
  const s = str(remote)
  if (!s) return null
  const m = parseRemote(s)
  if (!m) return null
  if (!GITHUB_HOSTS.has(m.host.toLowerCase())) return null
  const owner = m.owner
  let repo = m.repo
  if (repo.endsWith('.git')) repo = repo.slice(0, -4)
  if (!owner || !repo) return null
  return `${owner}/${repo}`
}

/**
 * `Repo` key from a git remote URL: {@link ownerRepoFromRemote} then
 * {@link repoKey}. Null for a non-github or unparseable remote.
 *
 * @param {unknown} remote
 * @returns {string | null}
 */
export function repoKeyFromRemote(remote) {
  const ownerRepo = ownerRepoFromRemote(remote)
  return ownerRepo ? repoKey(ownerRepo) : null
}

/**
 * `Commit` key — full 40-hex `sha`, lowercased. Unlike the GitHub side (which
 * trusts the API to return full shas), the host validates the length: a
 * captured **abbreviated** sha (e.g. Codex's `latest_git_commit_hash`, which
 * may be short) must NOT mint a `Commit` node, because an abbreviated key would
 * never converge with the GitHub side's full-sha node — it would mint a
 * distinct, dangling node instead. The guard only gates *whether* a key is
 * produced; for a full 40-hex sha the output is byte-identical to the GitHub
 * side. @ref LLP 0032#abbreviated-sha-guard
 *
 * @param {unknown} sha
 * @returns {string | null}
 */
export function commitKey(sha) {
  const s = str(sha)
  if (!s) return null
  const lower = s.toLowerCase()
  return /^[0-9a-f]{40}$/.test(lower) ? lower : null
}

/**
 * Reconcile an absolute local path to a repo-relative POSIX path against the
 * repo root. Returns null when the path is outside the repo root (a touched
 * file in `/tmp`, `~/.claude`, or another repo) — the caller then falls back to
 * keying that `File` on its absolute path, exactly as before the migration.
 *
 * Worktree convergence (LLP 0032 §worktree-convergence) rides on this: each
 * worktree of a repo has its own root (`git rev-parse --show-toplevel`) but the
 * same file sits at the same relpath, so two worktrees yield one `File` key.
 *
 * @param {unknown} repoRoot  absolute repo root
 * @param {unknown} absPath   absolute file path
 * @returns {string | null}
 */
export function relativizePath(repoRoot, absPath) {
  const root = str(repoRoot)
  const abs = str(absPath)
  if (!root || !abs) return null
  const r = trimTrailingSlash(root.replace(/\\/g, '/'))
  const a = abs.replace(/\\/g, '/')
  if (a === r) return null // the repo dir itself is not a file
  if (!a.startsWith(`${r}/`)) return null // outside the repo root
  return normalizeRelpath(a.slice(r.length + 1))
}

/**
 * `File` key from captured parts: a git remote URL, the repo root, and the
 * absolute local path. Composes {@link repoKeyFromRemote} +
 * {@link relativizePath} + {@link fileKey} so the result is byte-identical to
 * the GitHub side's `fileKey(owner/repo, relpath)`. Null when the file can't be
 * bridged (non-github remote, missing repo root, or path outside the repo) —
 * the caller keeps the absolute-path fallback.
 *
 * @param {unknown} remote
 * @param {unknown} repoRoot
 * @param {unknown} absPath
 * @returns {string | null}
 */
export function fileKeyFromParts(remote, repoRoot, absPath) {
  const ownerRepo = ownerRepoFromRemote(remote)
  if (!ownerRepo) return null
  const rel = relativizePath(repoRoot, absPath)
  if (!rel) return null
  return fileKey(ownerRepo, rel)
}

/**
 * @param {string} value
 * @returns {string}
 */
function trimTrailingSlash(value) {
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

/**
 * Split a remote URL into `{ host, owner, repo }`, or null if it doesn't look
 * like a repo URL.
 *
 * @param {string} s
 * @returns {{ host: string, owner: string, repo: string } | null}
 */
function parseRemote(s) {
  // scp-like: [user@]host:owner/repo(.git)
  const scp = /^(?:[^@/]+@)?([^/:]+):([^/]+)\/(.+)$/.exec(s)
  if (scp && !s.includes('://')) {
    return { host: scp[1], owner: scp[2], repo: trimTrailingSlash(scp[3]) }
  }
  // URL form: scheme://[user[:token]@]host[:port]/owner/repo(.git)
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/(.+)$/i.exec(s)
  if (url) {
    return { host: url[1], owner: url[2], repo: trimTrailingSlash(url[3]) }
  }
  return null
}

/**
 * The bridge-key helpers exposed on the `hypaware.context-graph` kit so a
 * contract receives them as `kit.keys` and never re-derives a key recipe.
 */
export const keys = {
  repoKey,
  repoKeyFromRemote,
  ownerRepoFromRemote,
  commitKey,
  fileKey,
  fileKeyFromParts,
  relativizePath,
  normalizeRelpath,
}

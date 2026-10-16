// @ts-check

/**
 * Natural-key construction + normalization for the GitHub graph taxonomy.
 *
 * Graph node ids are content-addressed over `(kind, type, natural key)`
 * (LLP 0023 §content-addressed-ids), so the key *is* the identity:
 * two contracts converge iff they normalize identically. These helpers are the
 * one place the rules are stated - the contract's `toRow`s call them rather
 * than each re-deriving a key - so a `Repo`/`Commit`/`File`/`Actor` minted by
 * another domain (the LLM-session graph) lands on the same id and merges.
 *
 * Changing any recipe here orphans every committed graph row that used the old
 * key; `test/plugins/github-graph-ids.test.js` digest-pins the outputs so a
 * change can only happen deliberately, with a migration.
 *
 * @ref LLP 0032#shared-key-vocabulary [implements]: owner/repo/login lowercased; relpath POSIX; sha full-40-hex lowercase
 */

/**
 * Lowercase a GitHub identifier (`owner`, `repo`, `login`). GitHub looks these
 * up case-insensitively but preserves display case; lowercasing guarantees
 * convergence and kills case-drift. Display case, if needed, rides in `props`.
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
 * local-absolute → repo-relative reconciliation is the *other* side's job
 * (LLP 0032); here we only canonicalize a path GitHub already returns
 * repo-relative.
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
 * `Repo` key - `owner/repo`, lowercased. Accepts either `(owner, repo)` or a
 * single `owner/repo` string. github.com is implied in V1 (no host segment -
 * see LLP 0032#github-only-v1).
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

/** github.com hosts admitted by the bridge-ready repository vocabulary. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * Turn a captured git remote into the same lowercase `owner/repo` key the
 * GitHub API side uses. Non-GitHub remotes and malformed values are not
 * eligible for GitHub capture.
 *
 * @param {unknown} remote
 * @returns {string | null}
 */
export function repoKeyFromRemote(remote) {
  const value = str(remote)
  if (!value) return null
  const parsed = parseRemote(value)
  if (!parsed || !GITHUB_HOSTS.has(parsed.host.toLowerCase())) return null
  let name = parsed.repo
  if (name.endsWith('.git')) name = name.slice(0, -4)
  if (/[/\s?#]/.test(parsed.owner) || /[/\s?#]/.test(name)) return null
  return repoKey(parsed.owner, name)
}

/**
 * Parse scp-like SSH and ordinary URL remote forms without retaining URL
 * credentials. The result contains only host and path segments.
 *
 * @param {string} remote
 * @returns {{ host: string, owner: string, repo: string } | null}
 */
function parseRemote(remote) {
  const scp = /^(?:[^@/:]+@)?([^/:]+):([^/]+)\/(.+)$/.exec(remote)
  if (scp) return { host: scp[1], owner: scp[2], repo: trimTrailingSlash(scp[3]) }

  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/(.+)$/i.exec(remote)
  if (url) return { host: url[1], owner: url[2], repo: trimTrailingSlash(url[3]) }
  return null
}

/** @param {string} value */
function trimTrailingSlash(value) {
  while (value.endsWith('/')) value = value.slice(0, -1)
  return value
}

/**
 * `Actor` key - `login`, lowercased.
 *
 * @param {unknown} login
 * @returns {string | null}
 */
export function actorKey(login) {
  return normalizeLogin(login)
}

/**
 * `Commit` key - the `sha` lowercased. The sha is globally unique across git,
 * so it is NOT repo-qualified: that is what makes it the cleanest bridge key
 * and lets it converge across forks (LLP 0032).
 *
 * Deliberately **not** length-validated. The host-side twin
 * (`ai-gateway-graph/src/graph-keys.js`) rejects anything but 40 hex, because
 * it keys off a captured `latest_git_commit_hash` that may be abbreviated and
 * an abbreviated key would mint a dangling node. This side reads the GitHub
 * API, which returns full shas, so it trusts them. LLP 0032 settles the
 * asymmetry in as many words: "stricter than the GitHub side, which trusts the
 * API for full shas". For a full sha the two outputs are byte-identical.
 *
 * @ref LLP 0032#abbreviated-sha-guard [constrained-by]: the guard is the host side's, not this one's
 *
 * @param {unknown} sha
 * @returns {string | null}
 */
export function commitKey(sha) {
  const s = str(sha)
  return s ? s.toLowerCase() : null
}

/**
 * `File` key - `owner/repo:relpath`. The repo half is normalized via
 * {@link repoKey}, the path via {@link normalizeRelpath}. A rename is a new
 * `File` (T0 keys path, not content).
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
 * `Issue` key - `owner/repo#number`. GitHub shares one number space across
 * issues+PRs per repo, so a number is *either* an issue or a PR (no collision);
 * the node `type` separates them in the hash regardless (LLP 0032).
 *
 * @param {unknown} repoFull
 * @param {unknown} number
 * @returns {string | null}
 */
export function issueKey(repoFull, number) {
  return numberedKey(repoFull, number)
}

/**
 * `PullRequest` key - `owner/repo#number` (see {@link issueKey} on the shared
 * number space).
 *
 * @param {unknown} repoFull
 * @param {unknown} number
 * @returns {string | null}
 */
export function pullRequestKey(repoFull, number) {
  return numberedKey(repoFull, number)
}

/**
 * `Review` key - `review/<review_id>`. The GitHub review id is globally unique.
 *
 * @param {unknown} reviewId
 * @returns {string | null}
 */
export function reviewKey(reviewId) {
  const n = intStr(reviewId)
  return n ? `review/${n}` : null
}

/**
 * @param {unknown} repoFull
 * @param {unknown} number
 * @returns {string | null}
 */
function numberedKey(repoFull, number) {
  const rk = repoKey(repoFull)
  const n = intStr(number)
  if (!rk || !n) return null
  return `${rk}#${n}`
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

/**
 * Coerce a GitHub integer id/number (which may arrive as a number, bigint, or
 * numeric string) to its canonical decimal string, rejecting non-integers.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function intStr(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : null
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value
  return null
}

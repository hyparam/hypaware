// @ts-check

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Repo enrichment for hermes sessions, recovered by running git in the
 * session's `cwd`. Hermes's `state.db` records `cwd` but no repo identity
 * (no remote, no toplevel), so the projector (`projector.js`) derives it
 * the same way the Claude adapter's backfill recovers pre-0032 sessions:
 * run git now, in the recorded cwd.
 *
 * Returns `git_remote` (credential-redacted) and `repo_root` only, never a
 * commit sha: `rev-parse HEAD` reports the repo's CURRENT HEAD, not
 * necessarily the commit the historical session sat on, so a derived
 * `head_sha` would be anachronistic (LLP 0032 #repo-commit-nodes). A cwd
 * that no longer resolves to a git repo (deleted worktree, moved checkout,
 * or a channel session's synthetic scope path, LLP 0124) degrades to `{}`.
 *
 * Kept tiny and duplicated per capture plugin (see `@hypaware/claude`
 * `git_repo.js`, `@hypaware/codex` `git-remote.js`) rather than shared: the
 * plugins are decoupled bundles (LLP 0121), each pre-bundled standalone.
 *
 * @ref LLP 0122#projection [implements]: `deriveRepoFromCwd` enrichment for
 *   interactive sessions whose cwd resolves to a real repo.
 * @param {string | undefined} cwd
 * @param {(file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>} [exec]
 *   git runner seam; defaults to `execFile`. Injected in tests so the
 *   derivation is hermetic.
 * @returns {Promise<{ git_remote?: string, repo_root?: string }>}
 */
export async function deriveRepoFromCwd(cwd, exec = execFileAsync) {
  if (typeof cwd !== 'string' || cwd.length === 0) return {}
  const [remote, repoRoot] = await Promise.all([
    gitLine(exec, cwd, ['config', '--get', 'remote.origin.url']),
    gitLine(exec, cwd, ['rev-parse', '--show-toplevel']),
  ])
  /** @type {{ git_remote?: string, repo_root?: string }} */
  const out = {}
  const redacted = redactRemoteUserinfo(remote)
  if (redacted) out.git_remote = redacted
  if (repoRoot) out.repo_root = repoRoot
  return out
}

/**
 * Strip credential userinfo (`user[:token]@`) from a git remote URL so a
 * token embedded in an HTTPS remote never lands in the stored `git_remote`
 * column. Only the `scheme://[user[:token]@]host/…` form carries a secret;
 * the scp-like SSH form (`git@github.com:owner/repo.git`) authenticates by
 * key, so its `git@` user is meaningful and is left intact.
 *
 * @ref LLP 0032#remote-redaction: owner/repo is all convergence needs; the raw remote can carry a secret
 * @param {string | undefined} remote
 * @returns {string | undefined}
 */
export function redactRemoteUserinfo(remote) {
  if (typeof remote !== 'string' || remote.length === 0) return remote
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1')
}

/**
 * Run one `git -C <cwd> <args…>` and return its first trimmed line, or
 * `undefined` on any failure (not a repo, no remote, git missing, timeout).
 *
 * @param {(file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>} exec
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string | undefined>}
 */
async function gitLine(exec, cwd, args) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { timeout: 2000 })
    const line = stdout.trim()
    return line || undefined
  } catch {
    return undefined
  }
}

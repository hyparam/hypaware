// @ts-check

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { redactRemoteUserinfo } from './hook_command.js'

const execFileAsync = promisify(execFile)

/**
 * Backfill-time repo recovery for Claude sessions captured before LLP 0032.
 *
 * The live hook (`hook_command.js` `gitRepoFacts`) writes `git_remote` /
 * `head_sha` / `repo_root` into the session-context sidecar, but sessions
 * recorded by an older hook have a sidecar that predates those fields — and
 * the transcript never carried them either. The one repo signal those
 * sessions DO carry is the `cwd` that rides each transcript line, so backfill
 * recovers identity by running git in that cwd NOW.
 *
 * Returns `git_remote` (credential-redacted) and `repo_root` only — never
 * `head_sha`. `rev-parse HEAD` today reports the repo's *current* HEAD, not
 * the commit the historical session sat on, so a derived `head_sha` would be
 * anachronistic and mint a wrong `Commit` node (LLP 0032 §repo-commit-nodes).
 * The headline `Session -in-> Repo` join needs only the remote, and a repo's
 * toplevel is stable across commits, so both are safe to derive after the
 * fact while `head_sha` is not. A cwd that no longer resolves to a git repo
 * (a deleted worktree, a moved checkout) degrades to `{}` — fall back rather
 * than mis-key (LLP 0032 §file-migration).
 *
 * @ref LLP 0032#capture [implements] — repo identity is captured by running git, not inferred from cwd, so deriving it at backfill time stays within the contract
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
  // Strip credential userinfo at ingress, exactly as the live hook does, so a
  // token in an HTTPS remote never reaches the row column (LLP 0032 §remote-redaction).
  const redacted = redactRemoteUserinfo(remote)
  if (redacted) out.git_remote = redacted
  if (repoRoot) out.repo_root = repoRoot
  return out
}

/**
 * Run one `git -C <cwd> <args…>` and return its first trimmed line, or
 * `undefined` on any failure (not a repo, no remote, git missing, timeout).
 * Mirrors `hook_command.js` `gitLine`, but with a backfill-appropriate
 * timeout — backfill is offline, so it need not stay under the hook's
 * never-block-Claude budget.
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

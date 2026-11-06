// @ts-check

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Derive `git_remote` (credential-redacted) and `repo_root` from a session's
 * working directory (`cwd`). Degrades to `{}` when `cwd` is absent or no
 * longer resolves to a git repository.
 *
 * @param {string | undefined} cwd
 * @param {(file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>} [exec]
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
 * Strip credential userinfo (`user[:token]@`) from an HTTPS git remote URL.
 *
 * @param {string | undefined} remote
 * @returns {string | undefined}
 */
export function redactRemoteUserinfo(remote) {
  if (typeof remote !== 'string' || remote.length === 0) return remote
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1')
}

/**
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

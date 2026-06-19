// @ts-check

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { appendSessionContext } from './session_context.js'

/**
 * @import { CommandRunContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

const execFileAsync = promisify(execFile)

/**
 * `hyp claude-hook session-context --state-file <absolute-path>`
 *
 * Plugin-contributed command registered by the `@hypaware/claude`
 * adapter during activation. Claude sends hook events on stdin; this
 * appends one JSONL record per event to the plugin's session-context
 * state file. The Claude exchange projector reads the same file when
 * it projects an Anthropic exchange and recovers `cwd` / `git_branch`
 * for the row.
 *
 * Hooks must never interrupt Claude Code. Malformed input, a missing
 * `--state-file`, a git lookup failure, or a write error all degrade
 * to "no context recorded" with exit 0.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runClaudeSessionContextHook(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) {
    ctx.stdout.write('usage: hyp claude-hook session-context --state-file <absolute-path>\n')
    return 0
  }
  const parsed = parseArgs(argv)
  const stateFile = parsed.stateFile ?? (parsed.legacyPort ? legacyStateFile(ctx.env) : undefined)
  if (!stateFile) return 0

  const input = await readStdin(ctx.stdin ?? process.stdin)
  /** @type {Record<string, unknown>} */
  let event
  try {
    const parsedEvent = JSON.parse(input || '{}')
    event = parsedEvent && typeof parsedEvent === 'object' && !Array.isArray(parsedEvent)
      ? /** @type {Record<string, unknown>} */ (parsedEvent)
      : {}
  } catch {
    return 0
  }

  const sessionId = str(event.session_id)
  const cwd = str(event.new_cwd) ?? str(event.cwd)
  if (!sessionId || !cwd) return 0
  const transcriptPath = str(event.transcript_path)
  const gitBranch = await currentGitBranch(cwd)
  // @ref LLP 0032#capture — the hook already runs git in the live cwd for the
  // branch; the remote/HEAD/root for the graph bridge come from the same place.
  const repo = await gitRepoFacts(cwd)

  /** @type {Record<string, unknown>} */
  const record = {
    session_id: sessionId,
    cwd,
    ts: new Date().toISOString(),
  }
  if (transcriptPath) record.transcript_path = transcriptPath
  if (gitBranch) record.git_branch = gitBranch
  if (repo.remote) record.git_remote = repo.remote
  if (repo.headSha) record.head_sha = repo.headSha
  if (repo.repoRoot) record.repo_root = repo.repoRoot

  try {
    await appendSessionContext(stateFile, /** @type {any} */ (record))
  } catch {
    /* hook MUST never throw back into Claude — exit 0 even on write failure */
  }
  return 0
}

/**
 * @param {string[]} argv
 * @returns {{ stateFile?: string, legacyPort?: number }}
 */
function parseArgs(argv) {
  /** @type {{ stateFile?: string, legacyPort?: number }} */
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--state-file' || arg.startsWith('--state-file=')) {
      const value = arg === '--state-file' ? argv[++i] : arg.slice('--state-file='.length)
      if (typeof value === 'string' && value.length > 0 && path.isAbsolute(value)) {
        out.stateFile = value
      }
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? argv[++i] : arg.slice('--port='.length)
      const port = typeof value === 'string' ? Number.parseInt(value, 10) : NaN
      if (Number.isInteger(port) && port > 0 && port <= 65535) out.legacyPort = port
    }
  }
  return out
}

/** @param {NodeJS.ProcessEnv} env */
function legacyStateFile(env) {
  const home = env.HOME
  const hypHome = env.HYP_HOME || (home ? path.join(home, '.hyp') : undefined)
  if (!hypHome) return undefined
  return path.join(hypHome, 'hypaware', 'plugins', '@hypaware', 'claude', 'session-context.jsonl')
}

/**
 * @param {NodeJS.ReadStream} stdin
 * @returns {Promise<string>}
 */
function readStdin(stdin) {
  if (stdin.isTTY) return Promise.resolve('')
  stdin.setEncoding('utf8')
  return new Promise((resolve) => {
    let data = ''
    let settled = false
    const finish = (/** @type {string} */ value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }
    const timeout = setTimeout(() => finish(data), 1000)
    stdin.on('data', (chunk) => { data += chunk })
    stdin.on('end', () => finish(data))
    stdin.on('error', () => finish(''))
  })
}

/**
 * @param {string} cwd
 * @returns {Promise<string | undefined>}
 */
async function currentGitBranch(cwd) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 1000 }
    )
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
  } catch {
    return undefined
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--short', 'HEAD'],
      { timeout: 1000 }
    )
    const commit = stdout.trim()
    return commit || undefined
  } catch {
    return undefined
  }
}

/**
 * Best-effort repo identity for the GitHub↔LLM graph bridge (LLP 0032):
 * the `origin` remote URL, the FULL HEAD sha (never the short form — an
 * abbreviated sha can't converge with the GitHub side's full-sha node), and
 * the repo root that relativizes touched-file paths. Each lookup is
 * independent and degrades to `undefined`; like `currentGitBranch`, the hook
 * must never interrupt Claude, so a missing remote or detached HEAD is fine.
 *
 * @param {string} cwd
 * @returns {Promise<{ remote?: string, headSha?: string, repoRoot?: string }>}
 */
async function gitRepoFacts(cwd) {
  const [remote, headSha, repoRoot] = await Promise.all([
    gitLine(cwd, ['config', '--get', 'remote.origin.url']),
    gitLine(cwd, ['rev-parse', 'HEAD']),
    gitLine(cwd, ['rev-parse', '--show-toplevel']),
  ])
  return {
    remote,
    headSha: headSha && /^[0-9a-f]{40}$/i.test(headSha) ? headSha : undefined,
    repoRoot,
  }
}

/**
 * Run one `git -C <cwd> <args…>` and return its first trimmed line, or
 * `undefined` on any failure (not a repo, no remote, git missing, timeout).
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string | undefined>}
 */
async function gitLine(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 1000 })
    const line = stdout.trim()
    return line || undefined
  } catch {
    return undefined
  }
}

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

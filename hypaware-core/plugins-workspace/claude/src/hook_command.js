// @ts-check

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { appendSessionContext } from './session_context.js'
import {
  DEFAULT_SPOOL_MAX_BYTES,
  claudeBodySpoolDir,
  enforceClaudeBodySpoolCap,
} from './telemetry/spool.js'

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

const execFileAsync = promisify(execFile)

/** The plugin whose v2 config slice carries the spool cap this hook applies. */
const PLUGIN_NAME = '@hypaware/claude'

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
 * Ordering (issue #258 / LLP 0085): `session_id` and `cwd` are in hand
 * instantly from stdin, but `cwd` is the ONLY field the `.hypignore`
 * usage-policy check needs, and the projector reads this channel the
 * moment the first exchange is captured. So a MINIMAL `{session_id, cwd,
 * ts}` record is appended FIRST - before the two git subprocesses run -
 * and a second enriched record (with `git_branch` / repo identity) is
 * appended only after. `pickLatestMatching` prefers the latest record,
 * so the enriched one wins once it lands; until then the projector at
 * least has `cwd`, collapsing the session-start race window from "hook
 * latency + 2 git execs" to ~one file append.
 *
 * Every invocation also enforces the raw-body spool's byte cap on its way out
 * (see {@link sweepBodySpool}), which is the half of LLP 0253's bound the
 * daemon cannot deliver on its own.
 *
 * @ref LLP 0085 [implements]: part (a) - shrink the null-cwd window at the
 * source by writing cwd before the git lookups.
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ gitBranch?: typeof currentGitBranch, gitRepoFacts?: typeof gitRepoFacts, sweepSpool?: typeof sweepBodySpool }} [deps]
 *   injectable git lookups and spool sweep (tests); default to the real
 *   subprocess helpers and the real sweep.
 */
export async function runClaudeSessionContextHook(argv, ctx, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    ctx.stdout.write('usage: hyp claude-hook session-context --state-file <absolute-path>\n')
    return 0
  }

  // The recording half is already internally fault-tolerant, but it is wrapped
  // here too so the invariant holds structurally: whatever it does, the hook
  // exits 0 and the sweep below still runs.
  try {
    await recordSessionContext(argv, ctx, deps)
  } catch {
    /* hook MUST never throw back into Claude Code */
  }

  // LAST, and on EVERY invocation, including the ones that recorded no
  // context. A malformed event or a missing `--state-file` says nothing about
  // whether Claude Code is filling the spool, and running last means a slow
  // directory can never delay the records above: the projector waits on
  // those, nothing waits on this.
  try {
    await (deps.sweepSpool ?? sweepBodySpool)(ctx)
  } catch {
    /* a spool that cannot be swept is never worth interrupting Claude for */
  }
  return 0
}

/**
 * Append the session-context record(s) for one hook event. Extracted from
 * {@link runClaudeSessionContextHook} so every "nothing to record" exit still
 * reaches the spool sweep that follows it.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ gitBranch?: typeof currentGitBranch, gitRepoFacts?: typeof gitRepoFacts }} deps
 * @returns {Promise<void>}
 */
async function recordSessionContext(argv, ctx, deps) {
  const parsed = parseArgs(argv)
  const stateFile = parsed.stateFile ?? (parsed.legacyPort ? legacyStateFile(ctx.env) : undefined)
  if (!stateFile) return

  const input = await readStdin(ctx.stdin ?? process.stdin)
  /** @type {Record<string, unknown>} */
  let event
  try {
    const parsedEvent = JSON.parse(input || '{}')
    event = parsedEvent && typeof parsedEvent === 'object' && !Array.isArray(parsedEvent)
      ? /** @type {Record<string, unknown>} */ (parsedEvent)
      : {}
  } catch {
    return
  }

  const sessionId = str(event.session_id)
  const cwd = str(event.new_cwd) ?? str(event.cwd)
  if (!sessionId || !cwd) return
  const transcriptPath = str(event.transcript_path)

  // Minimal record FIRST: cwd is what the .hypignore policy check needs and it
  // is available instantly from stdin. This closes the window in which the
  // projector reads a cwd-less record for the session's opening exchange.
  /** @type {Record<string, unknown>} */
  const minimal = { session_id: sessionId, cwd, ts: new Date().toISOString() }
  if (transcriptPath) minimal.transcript_path = transcriptPath
  try {
    await appendSessionContext(stateFile, /** @type {any} */ (minimal))
  } catch {
    /* hook MUST never throw back into Claude: a write failure records nothing */
  }

  // Enriched record SECOND: run the (slower) git subprocesses, then append the
  // branch / repo-graph identity. Wrapped so a git hang-or-throw or write error
  // still leaves the minimal record safely on disk (degrade to cwd-only).
  try {
    const branchOf = deps.gitBranch ?? currentGitBranch
    // @ref LLP 0032#capture: the hook already runs git in the live cwd for the
    // branch; the remote/HEAD/root for the graph bridge come from the same place.
    const repoFactsOf = deps.gitRepoFacts ?? gitRepoFacts
    const gitBranch = await branchOf(cwd)
    const repo = await repoFactsOf(cwd)

    /** @type {Record<string, unknown>} */
    const enriched = {}
    if (gitBranch) enriched.git_branch = gitBranch
    if (repo.remote) enriched.git_remote = repo.remote
    if (repo.headSha) enriched.head_sha = repo.headSha
    if (repo.repoRoot) enriched.repo_root = repo.repoRoot

    // Only append a second record when git actually added something; otherwise
    // the minimal record already fully represents the context (non-repo cwd).
    if (Object.keys(enriched).length > 0) {
      /** @type {Record<string, unknown>} */
      const record = { session_id: sessionId, cwd, ts: new Date().toISOString(), ...enriched }
      if (transcriptPath) record.transcript_path = transcriptPath
      await appendSessionContext(stateFile, /** @type {any} */ (record))
    }
  } catch {
    /* git or write failure: the minimal record already landed */
  }
}

/**
 * Enforce the raw-body spool's byte cap from OUTSIDE the daemon.
 *
 * LLP 0253 #byte-cap names the window the cap exists for: "the window this
 * exists for is precisely the one where the reader is not running". Every
 * enforcement that decision shipped with, though, lives inside the listener
 * source (its one-shot sweep at start and its 60-second timer), so the one
 * window it names is the one window nothing swept. Claude Code keeps writing
 * bodies whether or not the daemon is up, and the daemon is legitimately down
 * for a crashed service, a machine where one was never started, an uninstall
 * that skipped detach, and the attach-before-first-start path the port
 * resolver deliberately supports. In every one of those the directory grew at
 * roughly 145 KB per request with nothing bounding it: unbounded retention of
 * raw prompts, not merely a disk nit, because the attach turns
 * `OTEL_LOG_USER_PROMPTS` and `OTEL_LOG_ASSISTANT_RESPONSES` on.
 *
 * The hook is the right second enforcer because it already runs in its own
 * process at exactly the cadence bodies are written (SessionStart, CwdChanged,
 * UserPromptSubmit, and PostToolUse on Bash: LLP 0085), so the spool cannot
 * outrun it, and because it needs nothing the daemon owns.
 *
 * It deletes only what the daemon's own sweep would have deleted: the same
 * `enforceClaudeBodySpoolCap` over the same directory at the same cap, with
 * the same oldest-first order. The hook never widens the deletion rule, it
 * only runs the existing one while the daemon cannot.
 *
 * Cost is one `readdir` plus a `stat` per file. On an attached machine with
 * the daemon up the directory is near-empty, because the listener deletes what
 * it projects; on a proxy-attached or unattached machine it does not exist and
 * the sweep returns on `enforceClaudeBodySpoolCap`'s ENOENT arm without a
 * single stat. Either way it is well under the two git subprocesses the same
 * hook already spawns.
 *
 * @ref LLP 0263#hook-enforces-the-cap [implements]: the client hook is the
 *   second enforcer, so the cap holds in the window the daemon is down
 * @param {CommandRunContext} ctx
 * @returns {Promise<void>}
 */
async function sweepBodySpool(ctx) {
  const dir = claudeBodySpoolDir(readObservabilityEnv(ctx.env).hypHome)
  await enforceClaudeBodySpoolCap(dir, readSpoolMaxBytes(ctx.config))
}

/**
 * The cap this hook applies, read from the same `telemetry.spool_max_bytes`
 * key the listener's `readSpoolConfig` reads, out of the `@hypaware/claude`
 * slice of the v2 config the hook already carries. Matching the listener's
 * validation (a positive integer, anything else is the default) is what keeps
 * the two enforcers from disagreeing about how large the spool may be.
 *
 * A bad value falls back silently rather than warning: the listener already
 * warns about exactly this key, and a hook has no output surface that would
 * not push text at Claude Code.
 *
 * @ref LLP 0263#hook-enforces-the-cap [constrained-by]: the hook applies the
 *   operator's cap, never a rule of its own
 * @param {unknown} config
 * @returns {number}
 */
function readSpoolMaxBytes(config) {
  const plugins = obj(config)?.plugins
  if (!Array.isArray(plugins)) return DEFAULT_SPOOL_MAX_BYTES
  const entry = plugins.find((p) => obj(p)?.name === PLUGIN_NAME)
  const raw = obj(obj(obj(entry)?.config)?.telemetry)?.spool_max_bytes
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw
  return DEFAULT_SPOOL_MAX_BYTES
}

/**
 * Narrow a value to a plain object, so the config walk above can step through
 * a hand-edited config without a `TypeError` reaching Claude Code.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined
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
  // No os.homedir() fallback here on purpose: a legacy `--port` hook with no
  // env-provided home stays inert rather than writing into the invoking
  // user's real home. Legacy hooks predate win32 support, so the fallback
  // that LLP 0300 prescribes for read-side resolution buys nothing here.
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
 * the `origin` remote URL, the FULL HEAD sha (never the short form: an
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
    // Strip credential userinfo before it reaches the session-context record
    // (which the projector stamps onto the `git_remote` row column).
    remote: redactRemoteUserinfo(remote),
    headSha: headSha && /^[0-9a-f]{40}$/i.test(headSha) ? headSha : undefined,
    repoRoot,
  }
}

/**
 * Strip credential userinfo (`user[:token]@`) from a git remote URL so a token
 * embedded in an HTTPS remote: e.g. `https://x-access-token:<token>@github.com/owner/repo.git`,
 * which `gh` and CI checkouts write into `remote.origin.url`: never lands in
 * the session-context sidecar or the `git_remote` row column. Convergence only
 * needs the normalized `owner/repo`, so the raw secret has no downstream use.
 *
 * Only the `scheme://[user[:token]@]host/…` URL form carries a secret; the
 * scp-like SSH form (`git@github.com:owner/repo.git`) authenticates by key, so
 * its `git@` user is left intact. Duplicated (deliberately) in `@hypaware/codex`
 * `git-remote.js`: the plugins are decoupled; a test on each path pins it.
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

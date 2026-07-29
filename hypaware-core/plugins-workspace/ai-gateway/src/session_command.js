// @ts-check

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { configuredGatewayEndpoint } from '../../../../src/core/config/gateway_endpoint.js'
import { resolveLiveGatewayEndpointFromStatus } from '../../../../src/core/daemon/status.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { SessionEndpointResolution, SessionIdResolution, SessionStatusReport } from './types.js'
 */

const CONTROL_PATH = '/_hypaware/ignore/session'

/** The other, independent governor. LLP 0066 R7: either match suppresses. */
const FOLDER_GOVERNOR_NOTE = 'folder:  see `hyp policy show` (this verb reports the session set only)'

/**
 * `hyp session status` exit code for a **confirmed** "this session is NOT
 * being dropped" read. Distinct from `SESSION_EXIT_UNKNOWN` on purpose: the
 * whole point of the verb is that "recording, confirmed" and "could not
 * confirm anything" are different answers.
 */
export const SESSION_EXIT_NOT_IGNORED = 1

/** Usage error (bad flag / stray argument). Matches the house convention. */
export const SESSION_EXIT_USAGE = 2

/**
 * The fail-closed exit code: the gateway could not be reached, no endpoint
 * could be resolved, or the session id could not be determined. The verb
 * reports `unknown` and NEVER `ignored: false`.
 *
 * @ref LLP 0066#readable [implements]: an unconfirmable read is `unknown`,
 * not "not ignored" - conflating the two is what let the opt-out fail open.
 */
export const SESSION_EXIT_UNKNOWN = 3

/** How long to wait on the local control route before giving up. */
const REQUEST_TIMEOUT_MS = 5000

/** Bound on how many rollout files the Codex resolver will inspect. */
const MAX_ROLLOUT_SCAN = 5000

/**
 * Hard cap on a control response body. The route's own answers are a few dozen
 * bytes; anything larger is not the gateway, and buffering it unbounded lets
 * whatever owns the port balloon the CLI's memory. Mirrors the server-side
 * `MAX_BODY_BYTES` in control.js.
 */
const MAX_RESPONSE_BYTES = 64 * 1024

/**
 * How recently a Codex rollout must have been written for its id to be taken
 * as "the session this invocation is in".
 *
 * A live Codex session appends to its rollout on every turn, and the tool call
 * that runs `hyp session ...` is itself preceded by rollout writes, so the
 * legitimate case is seconds-to-minutes old. A rollout last written hours ago
 * is a FINISHED session: resolving it hands the verb a dead id, and the user is
 * then told a session they are not in is covered.
 */
const MAX_ROLLOUT_AGE_MS = 30 * 60 * 1000

/**
 * The variable in which Codex **states** the thread this process was spawned
 * from. Codex injects it into the environment of every shell/exec tool call and
 * exempts it from `shell_environment_policy.include_only` filtering, so its
 * presence is direct evidence of provenance: the thread that named it spawned
 * this process, and a thread that has ended cannot have spawned it.
 *
 * It carries a **thread** id, which is NOT the key the gateway drops on (that
 * is the session container). So it is used to identify WHICH rollout is live,
 * not as the answer: the answer is read out of that rollout.
 * @ref LLP 0067#cli-session-id
 */
const CODEX_THREAD_ENV = 'CODEX_THREAD_ID'

const IGNORE_USAGE = 'usage: hyp session ignore [session-id] [--json]'
const UNIGNORE_USAGE = 'usage: hyp session unignore [session-id] [--json]'
const STATUS_USAGE = 'usage: hyp session status [session-id] [--json]'

/**
 * `hyp session ignore` - stop recording this session.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runSessionIgnore(argv, ctx) {
  return runMutation(argv, ctx, 'POST', IGNORE_USAGE)
}

/**
 * `hyp session unignore` - resume recording this session.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runSessionUnignore(argv, ctx) {
  return runMutation(argv, ctx, 'DELETE', UNIGNORE_USAGE)
}

/**
 * `hyp session status` - is this session being dropped right now?
 *
 * Fails closed: anything that prevents a confirmed read (no resolvable
 * session id, no resolvable gateway endpoint, an unreachable or unhappy
 * gateway) reports `unknown` with `ignored: null` and exits
 * `SESSION_EXIT_UNKNOWN`. It never degrades to `ignored: false`, which a
 * caller would read as "confirmed: you are being recorded" and, worse, a
 * caller checking for the opposite would read as a completed check.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 * @ref LLP 0067#cli [implements]: the reader for the ephemeral opt-out set
 */
export async function runSessionStatus(argv, ctx) {
  const parsed = parseArgv(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.error}\n${STATUS_USAGE}\n`)
    return SESSION_EXIT_USAGE
  }

  const sessionId = parsed.id ?? undefined
  const resolvedId = sessionId
    ? /** @type {SessionIdResolution} */ ({ ok: true, sessionId, source: 'argument' })
    : resolveSessionIdForCli({ env: ctx.env, cwd: ctx.cwd })
  if (!resolvedId.ok) {
    return writeStatus(ctx, parsed.json, {
      status: 'unknown',
      session_id: null,
      session_id_source: null,
      session_id_evidence: null,
      thread_id: null,
      ignored: null,
      total: null,
      endpoint: null,
      endpoint_source: null,
      reason: resolvedId.error,
    })
  }

  /** @type {Pick<SessionStatusReport, 'session_id' | 'session_id_source' | 'session_id_evidence' | 'thread_id'>} */
  const who = {
    session_id: resolvedId.sessionId,
    session_id_source: resolvedId.source,
    session_id_evidence: resolvedId.evidence ?? null,
    // Reported beside the answer rather than folded into it: the thread is what
    // Codex states and what the user experiences as "this conversation", while
    // `session_id` is what the drop matches. Reporting only one of the two is
    // how they got conflated in the first place.
    thread_id: resolvedId.threadId ?? null,
  }

  const endpoint = resolveGatewayEndpointForCli(ctx)
  if (!endpoint.ok) {
    return writeStatus(ctx, parsed.json, {
      ...who,
      status: 'unknown',
      ignored: null,
      total: null,
      endpoint: null,
      endpoint_source: null,
      reason: endpoint.error,
    })
  }

  const result = await controlRequest({
    endpoint: endpoint.endpoint,
    method: 'GET',
    sessionId: resolvedId.sessionId,
  })
  if (!result.ok) {
    return writeStatus(ctx, parsed.json, {
      ...who,
      status: 'unknown',
      ignored: null,
      total: null,
      endpoint: endpoint.endpoint,
      endpoint_source: endpoint.source,
      reason: result.error,
    })
  }

  const ignored = result.body.ignored
  return writeStatus(ctx, parsed.json, {
    ...who,
    status: ignored ? 'ignored' : 'not_ignored',
    ignored,
    total: result.body.total,
    endpoint: endpoint.endpoint,
    endpoint_source: endpoint.source,
    reason: null,
  })
}

/**
 * Shared body for `ignore` / `unignore`: resolve the id, resolve the
 * endpoint, then toggle. Mutations fail closed the same way `status` does -
 * an unreachable gateway is an error, never a quiet success.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {'POST' | 'DELETE'} method
 * @param {string} usage
 * @returns {Promise<number>}
 */
async function runMutation(argv, ctx, method, usage) {
  const parsed = parseArgv(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.error}\n${usage}\n`)
    return SESSION_EXIT_USAGE
  }

  const resolvedId = parsed.id
    ? /** @type {SessionIdResolution} */ ({ ok: true, sessionId: parsed.id, source: 'argument' })
    : resolveSessionIdForCli({ env: ctx.env, cwd: ctx.cwd })
  if (!resolvedId.ok) {
    ctx.stderr.write(`hyp session: ${resolvedId.error}\n`)
    return SESSION_EXIT_UNKNOWN
  }

  const endpoint = resolveGatewayEndpointForCli(ctx)
  if (!endpoint.ok) {
    ctx.stderr.write(`hyp session: ${endpoint.error}\n`)
    return SESSION_EXIT_UNKNOWN
  }

  const result = await controlRequest({
    endpoint: endpoint.endpoint,
    method,
    sessionId: resolvedId.sessionId,
  })
  if (!result.ok) {
    ctx.stderr.write(`hyp session: ${result.error}\n`)
    return SESSION_EXIT_UNKNOWN
  }

  const ignored = result.body.ignored
  const total = result.body.total
  if (parsed.json) {
    ctx.stdout.write(
      JSON.stringify({
        status: 'ok',
        session_id: resolvedId.sessionId,
        session_id_source: resolvedId.source,
        session_id_evidence: resolvedId.evidence ?? null,
        thread_id: resolvedId.threadId ?? null,
        ignored,
        total,
        endpoint: endpoint.endpoint,
        endpoint_source: endpoint.source,
      }) + '\n'
    )
    return 0
  }
  ctx.stdout.write(
    ignored
      ? `session ${resolvedId.sessionId}: ignored - the gateway will drop this session (${total} ignored)\n`
      : `session ${resolvedId.sessionId}: not ignored - recording resumed (${total} ignored)\n`
  )
  if (ignored) {
    ctx.stdout.write('this opt-out is in-memory only: a gateway restart drops it. Re-check with `hyp session status`.\n')
  }
  // The write verbs carry the same provenance caveats as the read: "ignored"
  // printed off an inferred id is a claim about a session the user may not be
  // in, and that is louder here than in `status` because it reads as done.
  for (const note of provenanceNotes({
    idSource: resolvedId.source,
    idEvidence: resolvedId.evidence ?? null,
    threadId: resolvedId.threadId ?? null,
    endpointSource: endpoint.source,
  })) {
    ctx.stdout.write(`${note}\n`)
  }
  ctx.stdout.write(`${FOLDER_GOVERNOR_NOTE}\n`)
  return 0
}

/**
 * Render a `status` result and map it to an exit code.
 *
 * @param {CommandRunContext} ctx
 * @param {boolean} json
 * @param {SessionStatusReport} report
 * @returns {number}
 */
function writeStatus(ctx, json, report) {
  if (json) {
    ctx.stdout.write(JSON.stringify({ ...report, folder_policy: 'hyp policy show' }) + '\n')
  } else if (report.status === 'unknown') {
    const who = report.session_id ?? '(unresolved)'
    ctx.stdout.write(`session ${who}: UNKNOWN - cannot confirm the opt-out is in effect\n`)
    ctx.stdout.write(`reason:  ${report.reason ?? 'unknown'}\n`)
    ctx.stdout.write('assume this session IS being recorded until a check succeeds.\n')
    ctx.stdout.write(`${FOLDER_GOVERNOR_NOTE}\n`)
  } else if (report.status === 'ignored') {
    ctx.stdout.write(`session ${report.session_id}: ignored (${report.total} ignored in total)\n`)
    ctx.stdout.write('this opt-out is in-memory only: a gateway restart drops it. Re-check with `hyp session status`.\n')
    for (const note of provenanceNotes({
      idSource: report.session_id_source,
      idEvidence: report.session_id_evidence,
      threadId: report.thread_id,
      endpointSource: report.endpoint_source,
    })) {
      ctx.stdout.write(`${note}\n`)
    }
    ctx.stdout.write(`${FOLDER_GOVERNOR_NOTE}\n`)
  } else {
    ctx.stdout.write(`session ${report.session_id}: not ignored - this session IS being recorded\n`)
    ctx.stdout.write('run `hyp session ignore` to opt out.\n')
    for (const note of provenanceNotes({
      idSource: report.session_id_source,
      idEvidence: report.session_id_evidence,
      threadId: report.thread_id,
      endpointSource: report.endpoint_source,
    })) {
      ctx.stdout.write(`${note}\n`)
    }
    ctx.stdout.write(`${FOLDER_GOVERNOR_NOTE}\n`)
  }

  if (report.status === 'ignored') return 0
  if (report.status === 'not_ignored') return SESSION_EXIT_NOT_IGNORED
  return SESSION_EXIT_UNKNOWN
}

/**
 * Notes qualifying a CONFIRMED answer, printed next to it.
 *
 * A membership answer rests on two claims the verb cannot always prove: that
 * the id is this session's, and that the endpoint is the gateway. An explicit
 * argument or `CLAUDE_CODE_SESSION_ID` states the first; a Codex rollout only
 * INFERS it from disk. A live daemon's `status.json` proves the second; a
 * pinned `listen` only asserts it, and `validateControlResponse` can prove the
 * responder saw our token but not that it is the gateway. Naming the weaker
 * evidence in the output is the only remedy available at this layer, and it is
 * this change's own thesis: a control that can be wrong must at least say so.
 *
 * A Codex answer also carries a **grain** disclosure, which is not about weak
 * evidence but about the key itself: the resolved id is the session container,
 * so the drop covers sibling threads of the one the user is in (the documented
 * over-drop, LLP 0066 §scope). A user who asked to stop recording "this
 * conversation" should see that it stopped more than that, rather than infer it
 * from a gap in the cache.
 *
 * @ref LLP 0066#readable [implements]: R10 - the reader must not present
 * inferred inputs as if they were confirmed ones.
 *
 * @param {{
 *   idSource: SessionStatusReport['session_id_source'],
 *   idEvidence: string | null,
 *   threadId: string | null,
 *   endpointSource: SessionStatusReport['endpoint_source'],
 * }} args
 * @returns {string[]}
 */
function provenanceNotes(args) {
  const { idSource, idEvidence, threadId, endpointSource } = args
  /** @type {string[]} */
  const notes = []
  if (idSource === 'codex_rollout') {
    notes.push(
      `session id: INFERRED from ${idEvidence ?? 'a Codex rollout'} on disk, not stated by the client. If that is not the session you are in, re-run naming it: hyp session status <session-id>.`
    )
  }
  if (idSource === 'codex_env_rollout') {
    notes.push(
      `session id: the session containing the thread ${CODEX_THREAD_ENV} states, read from ${idEvidence ?? 'that rollout'} on disk. Codex states the thread, not the session, so the container had to be read rather than stated.`
    )
  }
  if (threadId) {
    notes.push(
      `scope:   the gateway drops by SESSION, so every Codex thread in this session is covered - sibling and subagent threads too, not only thread ${threadId}.`
    )
  }
  if (endpointSource === 'config_listen') {
    notes.push(
      'endpoint:  from the pinned `listen`, not a live daemon - nothing proved the gateway still owns that port.'
    )
  }
  return notes
}

/**
 * Parse `[--] [session-id] [--json]`.
 *
 * A bare `--` ends flag parsing, so a session id that begins with `-` can still
 * be named. The id is an opaque provider token (LLP 0066 R5) and the verb never
 * interprets it, so there is no shape it may be refused for; without a
 * terminator such an id would be unreachable and the user would have no way to
 * check or opt out that session at all.
 *
 * @param {string[]} argv
 * @returns {{ ok: true, id: string | null, json: boolean } | { ok: false, error: string }}
 */
function parseArgv(argv) {
  let json = false
  let literal = false
  /** @type {string | null} */
  let id = null
  for (const arg of argv) {
    if (!literal && arg === '--') {
      literal = true
      continue
    }
    if (!literal && arg === '--json') {
      json = true
      continue
    }
    if (!literal && arg.startsWith('-')) return { ok: false, error: `hyp session: unknown flag ${arg}` }
    if (id !== null) return { ok: false, error: 'hyp session: at most one session id may be given' }
    if (arg.trim().length === 0) return { ok: false, error: 'hyp session: session id must not be empty' }
    id = arg
  }
  return { ok: true, id, json }
}

/**
 * Resolve the local gateway's base URL **from disk and config**, never from a
 * guessed port. The daemon's live bound port wins (it is the only proven one
 * when the configured port was taken and LLP 0114's fallback kicked in);
 * a pinned `listen` is the fallback for a gateway running outside a daemon
 * this command can see.
 *
 * @param {CommandRunContext} ctx
 * @returns {SessionEndpointResolution}
 * @ref LLP 0086#manual-attach-reads-the-live-port [constrained-by]: endpoint
 * discovery reads status.json + config, so the verb never talks to a port
 * nothing proved was bound.
 */
export function resolveGatewayEndpointForCli(ctx) {
  let live
  try {
    const stateRoot = readObservabilityEnv(ctx.env).stateDir
    live = resolveLiveGatewayEndpointFromStatus({ stateRoot })
  } catch {
    live = undefined
  }
  if (live) return { ok: true, endpoint: live, source: 'daemon_status' }

  const configured = configuredGatewayEndpoint(ctx.config)
  if (configured) return { ok: true, endpoint: configured, source: 'config_listen' }

  return {
    ok: false,
    error:
      'could not resolve the HypAware gateway endpoint: no running daemon reported a bound port and no `listen` is pinned for @hypaware/ai-gateway. Start the daemon (`hyp start`) or pin a port with `hyp init`.',
  }
}

/**
 * Resolve which session this invocation is about, in the identifier the drop
 * actually matches on.
 *
 * **The answer is the session container, never the thread.** The gateway drops
 * on the `session_id` the adapter stamps (LLP 0066 R5), and for Codex that is
 * the session container: `metadata.session_id` live, `session_meta.session_id`
 * on disk. A Codex **thread** id is a different value whenever the thread is
 * not the root one, so stating a thread id here would report an opt-out the
 * gateway never matches - success printed over continued recording.
 *
 * Order:
 *
 * 1. `CLAUDE_CODE_SESSION_ID`. For Claude the session IS the conversation
 *    (LLP 0066 §scope), so a stated id is already the drop key.
 * 2. `CODEX_THREAD_ID`, used as a **selector, not an answer**: it names the
 *    live thread, so it picks the rollout without the mtime liveness proxy, and
 *    the session container is then read out of that rollout's `session_meta`.
 * 3. Otherwise the rollout whose `payload.cwd` matches the invocation cwd
 *    (`$CODEX_HOME/sessions/**\/rollout-<ts>-<uuid>.jsonl`), with the staleness
 *    bound below standing in for the liveness the environment would have given.
 *
 * **Refuses when two clients each state one.** Environments nest (Codex runs
 * `claude`, or the reverse), so both variables can be set at once and only one
 * of them names the session this invocation is in. Preferring either would be a
 * guess, and a wrong guess opts out a session the user is not in while
 * reporting success.
 *
 * **Refuses on ambiguity** rather than guessing newest-by-mtime: several
 * cwd-matching rollouts, or none, is an error naming the candidates. Guessing
 * would risk opting out the wrong session while telling the user they are
 * covered, which is the fail-open shape this whole change exists to remove.
 *
 * **Refuses on staleness too**, on the cwd path only: a thread stated in the
 * environment needs no age bound, because the thread that set it is the one
 * running now. "Exactly one rollout records this cwd" says
 * nothing about whether that session is still running: a cwd where Codex ran
 * once last week has exactly one match, and resolving it yields a confident
 * answer about a DEAD id while the session the user is actually in keeps being
 * recorded. That is the same wrong-session defect as believing an unvalidated
 * control reply, so it gets the same treatment - refuse, name the file and its
 * age, and point at the explicit-id escape hatch.
 *
 * **Refuses on a legacy rollout** that carries no `session_id` field at all,
 * rather than falling back to its thread id: see `readRolloutMeta`.
 *
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, maxScan?: number, maxAgeMs?: number, now?: number }} args
 * @returns {SessionIdResolution}
 * @ref LLP 0067#cli-session-id [implements]: session-id resolution contract -
 * the drop key (never the thread id), fail-closed on ambiguity (two stated
 * clients, or two matching rollouts), truncation, staleness, and a rollout with
 * no session container to read
 */
export function resolveSessionIdForCli(args) {
  // The id is an opaque provider token (LLP 0066 R5), so a stated value is
  // passed on byte-identical; only the emptiness test trims.
  const claudeSessionId = statedEnv(args.env.CLAUDE_CODE_SESSION_ID)
  const codexThreadId = statedEnv(args.env[CODEX_THREAD_ENV])
  if (claudeSessionId && codexThreadId) {
    return {
      ok: false,
      error: `could not resolve a session id: more than one client states one for this invocation - CLAUDE_CODE_SESSION_ID=${claudeSessionId}, ${CODEX_THREAD_ENV}=${codexThreadId}. Only one of them is the session this command is in, and picking either would act on the wrong one while reporting success. Pass the intended session id explicitly: hyp session status <session-id>.`,
    }
  }
  if (claudeSessionId) {
    return { ok: true, sessionId: claudeSessionId, source: 'claude_env' }
  }

  const codexHome =
    typeof args.env.CODEX_HOME === 'string' && args.env.CODEX_HOME.length > 0
      ? args.env.CODEX_HOME
      : path.join(args.env.HOME ?? os.homedir(), '.codex')
  const sessionsDir = path.join(codexHome, 'sessions')

  const maxScan = typeof args.maxScan === 'number' && args.maxScan > 0 ? args.maxScan : MAX_ROLLOUT_SCAN
  const scan = rolloutFiles(sessionsDir, maxScan)

  if (codexThreadId) return resolveFromStatedThread(scan, sessionsDir, codexThreadId, maxScan)

  // A truncated scan cannot support the uniqueness claim below: the rollout
  // that would have made the match ambiguous may be one of the ones never
  // looked at, so "exactly one match" would be an artefact of the bound
  // rather than a fact. Refuse instead of resolving on partial evidence.
  if (scan.truncated) {
    return {
      ok: false,
      error: `could not resolve a session id: the Codex rollout scan under ${sessionsDir} hit its ${maxScan}-file bound, so a unique cwd match cannot be established. Pass the session id explicitly: hyp session status <session-id>.`,
    }
  }

  /** @type {{ threadId: string, sessionId: string | undefined, cwd: string, file: string }[]} */
  const candidates = []
  for (const file of scan.files) {
    const meta = readRolloutMeta(file)
    if (!meta) continue
    if (meta.cwd !== args.cwd) continue
    candidates.push({ ...meta, file })
  }

  if (candidates.length === 1) {
    const only = candidates[0]
    const name = path.basename(only.file)
    const maxAgeMs =
      typeof args.maxAgeMs === 'number' && args.maxAgeMs > 0 ? args.maxAgeMs : MAX_ROLLOUT_AGE_MS
    const ageMs = rolloutAgeMs(only.file, args.now ?? Date.now())
    if (ageMs === undefined) {
      return {
        ok: false,
        error: `could not resolve a session id: the only Codex rollout recording cwd ${args.cwd} (${name}) could not be stat'd, so there is no evidence it belongs to a running session. Pass the session id explicitly: hyp session status <session-id>.`,
      }
    }
    if (ageMs > maxAgeMs) {
      return {
        ok: false,
        error: `could not resolve a session id: the only Codex rollout recording cwd ${args.cwd} (${name}) was last written ${describeAge(ageMs)} ago, so it is a finished session rather than this one. Acting on it would report the WRONG session as covered while this one keeps being recorded. Pass the intended session id explicitly: hyp session status <session-id>.`,
      }
    }
    if (only.sessionId === undefined) {
      return { ok: false, error: legacyRolloutError(`recording cwd ${args.cwd}`, name) }
    }
    return {
      ok: true,
      sessionId: only.sessionId,
      source: 'codex_rollout',
      evidence: name,
      threadId: only.threadId,
    }
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      error: `could not resolve a session id: no client stated one (CLAUDE_CODE_SESSION_ID, ${CODEX_THREAD_ENV}) and no Codex rollout under ${sessionsDir} records cwd ${args.cwd}. Pass the session id explicitly: hyp session status <session-id>.`,
    }
  }
  const named = candidates.map((c) => `${c.threadId} (${path.basename(c.file)})`).join(', ')
  return {
    ok: false,
    error: `could not resolve a session id: ${candidates.length} Codex rollouts record cwd ${args.cwd} - ${named}. Pass the intended session id explicitly rather than guessing: hyp session status <session-id>.`,
  }
}

/**
 * Resolve the session container for the thread Codex states in
 * `CODEX_THREAD_ID`.
 *
 * This is the liveness-preserving half of the trade-off: the environment proves
 * which thread is running (no mtime proxy), and the rollout for that thread
 * carries the only thing the environment cannot state - the session container
 * the drop keys on. Both halves are needed, so a rollout that cannot be found
 * or carries no container is a refusal, NOT a fall back to the cwd scan: that
 * scan answers about a thread nothing tied to this invocation, and the stated
 * thread has already told us that would be the wrong one.
 *
 * A truncated scan is only fatal here when the thread was not found. Unlike the
 * cwd path, this match is an identity test on a value the client stated, not a
 * uniqueness claim over the listing, so an unread file cannot invalidate a hit.
 *
 * @param {{ files: string[], truncated: boolean }} scan
 * @param {string} sessionsDir
 * @param {string} threadId
 * @param {number} maxScan
 * @returns {SessionIdResolution}
 */
function resolveFromStatedThread(scan, sessionsDir, threadId, maxScan) {
  /** @type {{ threadId: string, sessionId: string | undefined, cwd: string, file: string }[]} */
  const matches = []
  for (const file of scan.files) {
    const meta = readRolloutMeta(file)
    if (!meta) continue
    if (meta.threadId !== threadId) continue
    matches.push({ ...meta, file })
  }

  if (matches.length === 0) {
    const bound = scan.truncated
      ? ` The scan hit its ${maxScan}-file bound, so the rollout may simply not have been reached.`
      : ''
    return {
      ok: false,
      error: `could not resolve a session id: ${CODEX_THREAD_ENV}=${threadId} names the live Codex thread, but no rollout under ${sessionsDir} records that thread, so the session container the gateway drops on cannot be read.${bound} The thread id is NOT that container (they differ on a subagent thread), so it would be wrong to act on. Pass the session id explicitly: hyp session status <session-id>.`,
    }
  }

  const names = matches.map((m) => path.basename(m.file)).join(', ')
  if (matches.some((m) => m.sessionId === undefined)) {
    return { ok: false, error: legacyRolloutError(`for thread ${threadId}`, names) }
  }
  const distinct = [...new Set(matches.map((m) => m.sessionId))]
  if (distinct.length > 1) {
    return {
      ok: false,
      error: `could not resolve a session id: the rollouts for thread ${threadId} (${names}) disagree about which session contains it - ${distinct.join(', ')}. Pass the intended session id explicitly rather than guessing: hyp session status <session-id>.`,
    }
  }

  return {
    ok: true,
    sessionId: /** @type {string} */ (distinct[0]),
    source: 'codex_env_rollout',
    evidence: names,
    threadId,
  }
}

/**
 * The refusal for a rollout with no `session_id` field: a Codex old enough to
 * predate the field, so the container the drop keys on simply is not on disk.
 *
 * Falling back to the rollout's thread id here is the exact defect this
 * resolution exists to remove, and it would be invisible: on a root thread the
 * two coincide, so the wrong key only shows up on the subagent threads nobody
 * tests by hand.
 *
 * @param {string} which  how the rollout was selected, for the message
 * @param {string} names  rollout basename(s) the refusal is about
 * @returns {string}
 */
function legacyRolloutError(which, names) {
  return `could not resolve a session id: the Codex rollout ${which} (${names}) carries no session_id field, so the session container the gateway drops on cannot be read from it. Its thread id is NOT that container - they differ on a subagent thread - so acting on it would report an opt-out that suppresses nothing. Upgrade Codex (current versions write session_meta.session_id) or pass the session id explicitly: hyp session status <session-id>.`
}

/**
 * An environment value only counts as **stated** when it is non-blank. Returned
 * byte-identical (the id is an opaque provider token, LLP 0066 R5): a blank
 * variable falls through to the next source rather than resolving to nothing.
 *
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function statedEnv(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Every `rollout-*.jsonl` under a Codex sessions tree (it is nested by date).
 * Bounded so a very large history cannot turn a privacy check into a long
 * directory walk. Reports whether the bound was hit, because a truncated
 * listing cannot be used to argue a cwd match is unique.
 *
 * @param {string} root
 * @param {number} maxScan
 * @returns {{ files: string[], truncated: boolean }}
 */
function rolloutFiles(root, maxScan) {
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const stack = [root]
  while (stack.length > 0 && out.length < maxScan) {
    const dir = /** @type {string} */ (stack.pop())
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        out.push(full)
      }
    }
  }
  return { files: out, truncated: out.length >= maxScan || stack.length > 0 }
}

/**
 * How long ago a rollout was last appended to, or `undefined` when it cannot be
 * stat'd. `mtime` is the liveness proxy: a running session writes on every turn.
 *
 * @param {string} file
 * @param {number} now
 * @returns {number | undefined}
 */
function rolloutAgeMs(file, now) {
  try {
    const age = now - fs.statSync(file).mtimeMs
    return age < 0 ? 0 : age
  } catch {
    return undefined
  }
}

/**
 * Coarse human age for a refusal message. The point is that the reader can see
 * at a glance that the rollout is old, not the exact figure.
 *
 * @param {number} ms
 * @returns {string}
 */
function describeAge(ms) {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Read `payload.id` (the thread), `payload.session_id` (the session container
 * the drop keys on) and `payload.cwd` off a rollout's first line. Only a
 * bounded prefix is read: a rollout grows without limit, but its `session_meta`
 * header is the first record.
 *
 * **The raw JSON line is what is parsed, deliberately.** Codex's
 * `SessionMetaLine` has a hand-written `Deserialize` that BACK-FILLS
 * `session_id` from `id` when the field is absent, so anything reading a
 * deserialized `session_meta` gets the *thread* id handed back under the name
 * `session_id` on every legacy rollout - the wrong key, silently, exactly the
 * defect this resolution exists to remove. Reading the line means an absent
 * field is visible as absent, and `sessionId: undefined` is then a refusal at
 * the call site rather than a guess.
 *
 * @param {string} file
 * @returns {{ threadId: string, sessionId: string | undefined, cwd: string } | undefined}
 * @ref LLP 0067#cli-session-id [implements]: an absent session_id is
 * unresolvable, never the back-filled thread id
 */
function readRolloutMeta(file) {
  /** @type {number | undefined} */
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(64 * 1024)
    const read = fs.readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, read).toString('utf8')
    const newline = text.indexOf('\n')
    const line = newline === -1 ? text : text.slice(0, newline)
    const parsed = JSON.parse(line)
    const payload = parsed && typeof parsed === 'object' ? parsed.payload : undefined
    if (!payload || typeof payload !== 'object') return undefined
    const fields = /** @type {Record<string, unknown>} */ (payload)
    const id = fields.id
    const cwd = fields.cwd
    const sessionId = fields.session_id
    if (typeof id !== 'string' || id.length === 0) return undefined
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    return {
      threadId: id,
      sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
      cwd,
    }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Accept a control response only when it is the contract's shape AND is about
 * the session that was asked about.
 *
 * A 200 with JSON in it is not evidence: `resolveGatewayEndpointForCli` can
 * land on a port that some other local process now owns (a pinned `listen`
 * whose gateway is gone, a recycled ephemeral port), and any such process
 * answering `200 {}` would otherwise be read as "confirmed: `ignored` is
 * absent, therefore false". `ignored` must be a real boolean, `total` a real
 * number, and `session_id` must come back byte-identical to the token sent -
 * the route echoes it verbatim (R5), so a mismatch means the answer describes
 * a different session and establishes nothing about this one.
 *
 * @ref LLP 0066#readable [implements]: R10 - an answer that does not establish
 * membership for THIS session is `unknown`, never a confident `ignored` value.
 *
 * @param {unknown} parsed
 * @param {string} sessionId
 * @returns {{ ok: true, body: { session_id: string, ignored: boolean, total: number } } | { ok: false, error: string }}
 */
function validateControlResponse(parsed, sessionId) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'returned a non-object control response' }
  }
  const body = /** @type {Record<string, unknown>} */ (parsed)
  if (typeof body.ignored !== 'boolean') {
    return { ok: false, error: 'returned a control response with no boolean `ignored` field - it is not the HypAware control route' }
  }
  if (typeof body.total !== 'number' || !Number.isFinite(body.total)) {
    return { ok: false, error: 'returned a control response with no numeric `total` field - it is not the HypAware control route' }
  }
  if (body.session_id !== sessionId) {
    return {
      ok: false,
      error: `answered about session ${JSON.stringify(body.session_id)}, not the session that was asked about - the answer establishes nothing about ${sessionId}`,
    }
  }
  return { ok: true, body: { session_id: body.session_id, ignored: body.ignored, total: body.total } }
}

/**
 * One request to the gateway's local control route. Any transport failure,
 * timeout, non-200, or answer that is not a well-formed control response for
 * THIS session id is reported as an error string the caller turns into
 * `unknown` - never into a membership answer.
 *
 * @param {{ endpoint: string, method: 'GET' | 'POST' | 'DELETE', sessionId: string }} args
 * @returns {Promise<{ ok: true, body: { session_id: string, ignored: boolean, total: number } } | { ok: false, error: string }>}
 */
function controlRequest(args) {
  return new Promise((resolve) => {
    let settled = false
    /** @type {NodeJS.Timeout | undefined} */
    let deadline
    /** @param {{ ok: true, body: { session_id: string, ignored: boolean, total: number } } | { ok: false, error: string }} outcome */
    function finish(outcome) {
      if (settled) return
      settled = true
      if (deadline) clearTimeout(deadline)
      resolve(outcome)
    }

    /** @type {URL} */
    let url
    try {
      url = new URL(CONTROL_PATH, args.endpoint)
    } catch {
      finish({ ok: false, error: `invalid gateway endpoint ${args.endpoint}` })
      return
    }
    if (args.method === 'GET') {
      url.search = new URLSearchParams({ session_id: args.sessionId }).toString()
    }

    const body = args.method === 'GET' ? undefined : JSON.stringify({ session_id: args.sessionId })
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        method: args.method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        // `content-length` is not optional here: Node's HTTP client does not
        // apply chunked framing to a DELETE, so a body written without an
        // explicit length is silently dropped and the route 400s.
        headers:
          body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (settled) return
          raw += chunk
          // A control answer is a few dozen bytes. Whatever is streaming more
          // than MAX_RESPONSE_BYTES is not the gateway, and buffering it to the
          // end would let it grow this process without limit.
          if (raw.length > MAX_RESPONSE_BYTES) {
            finish({
              ok: false,
              error: `gateway at ${args.endpoint} returned more than ${MAX_RESPONSE_BYTES} bytes for ${CONTROL_PATH} - it is not the HypAware control route`,
            })
            req.destroy()
          }
        })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status !== 200) {
            finish({ ok: false, error: `gateway at ${args.endpoint} answered HTTP ${status} for ${CONTROL_PATH}` })
            return
          }
          /** @type {unknown} */
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch {
            finish({ ok: false, error: `gateway at ${args.endpoint} returned an unparseable control response` })
            return
          }
          const checked = validateControlResponse(parsed, args.sessionId)
          if (!checked.ok) {
            finish({ ok: false, error: `gateway at ${args.endpoint} ${checked.error}` })
            return
          }
          finish({ ok: true, body: checked.body })
        })
      }
    )
    // `timeout` is socket INACTIVITY, so a responder that trickles a byte every
    // few seconds resets it forever. The privacy check needs an answer or a
    // refusal in bounded time, so the deadline is wall-clock as well.
    deadline = setTimeout(() => {
      finish({ ok: false, error: `could not reach the HypAware gateway at ${args.endpoint}: timed out after ${REQUEST_TIMEOUT_MS}ms` })
      req.destroy()
    }, REQUEST_TIMEOUT_MS)
    deadline.unref?.()
    req.on('timeout', () => {
      req.destroy(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`))
    })
    req.on('error', (err) => {
      finish({ ok: false, error: `could not reach the HypAware gateway at ${args.endpoint}: ${err.message}` })
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

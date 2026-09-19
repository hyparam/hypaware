// @ts-check

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { refreshSessionIgnores } from '../../../../src/core/control/session_ignore_store.js'

import { AI_GATEWAY_MESSAGES_DATASET, errMessage, projectedExchangeItem, resolveWindow } from '../../../../src/core/backfill/scan_util.js'
import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { isPlainObject, stringValue } from 'hypaware/core/util'
import { projectOpenCodeSnapshot } from './projector.js'

/** @import { BackfillContribution, BackfillEvent, BackfillItem, BackfillRunContext } from '../../../../hypaware-plugin-kernel-types.js' */

const execFileAsync = promisify(execFile)
const MAX_SESSION_LIST = 1000
// An `opencode` child that starts and never exits parks the daemon's whole
// scheduled sweep, so both calls are bounded, on separate budgets. The listing
// is a bounded metadata read and takes the workspace's existing ceiling for a
// subprocess that does real I/O (the 10s on `gh auth token`), above the 1-3s
// given to calls that only read a version or a git line. The export renders one
// whole transcript, which `maxBuffer` already sizes at 32MB, and overrunning it
// costs one warned session where a slow listing fails the run.
const LIST_TIMEOUT_MS = 10_000
const EXPORT_TIMEOUT_MS = 60_000

/**
 * @param {{ localOnlyListPath?: string, runCommand?: (args: string[], timeoutMs: number) => Promise<string>, exactSessionIds?: string[], ignoredSessions?: Set<string> }} [opts]
 * @returns {BackfillContribution}
 */
export function createOpenCodeBackfillProvider(opts = {}) {
  const resolver = createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
  const runCommand = opts.runCommand ?? runOpenCode
  return {
    name: 'opencode',
    plugin: '@hypaware/opencode',
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import bounded OpenCode CLI and Desktop session exports',
    async *run(ctx) {
      refreshSessionIgnores(opts.ignoredSessions)
      yield* runBackfill({
        ctx,
        resolver,
        runCommand,
        exactSessionIds: opts.exactSessionIds,
        ignoredSessions: opts.ignoredSessions,
      })
    },
  }
}

/** @param {{ ctx: BackfillRunContext, resolver: ReturnType<typeof createUsagePolicyResolver>, runCommand: (args: string[], timeoutMs: number) => Promise<string>, exactSessionIds?: string[], ignoredSessions?: Set<string> }} deps */
async function* runBackfill(deps) {
  const window = resolveWindow(deps.ctx)
  let emptyStdout = false
  /** @type {Array<{ id: string, updated?: number, created?: number, directory?: string }>} */
  let selected = []
  if (deps.exactSessionIds && deps.exactSessionIds.length > 0) {
    selected = deps.exactSessionIds.map((id) => ({ id }))
  } else {
    // No `opencode` on PATH is the ordinary state of a Desktop-only install,
    // and Desktop is half of what this adapter attaches. Reading it as a
    // provider failure made every such setup end on "backfill opencode:
    // failed", where the file-reading peers (claude, codex) report ok with
    // zero rows for the same "nothing here to import" fact. ENOENT only: any
    // other failure of the list command is still a real one and still throws.
    /** @type {string} */
    let rawList
    try {
      rawList = await deps.runCommand(['session', 'list', '--format', 'json', '--max-count', String(MAX_SESSION_LIST)], LIST_TIMEOUT_MS)
    } catch (err) {
      if (!isMissingBinary(err)) throw err
      deps.ctx.log.info('opencode.backfill.cli_absent', {
        component: 'plugin.opencode.backfill',
        operation: 'backfill.select',
        selected_sessions: 0,
        status: 'ok',
        reason: 'opencode_cli_absent',
      })
      return
    }
    // OpenCode 1.18.22 returns before JSON formatting when its list is empty.
    // Accept only that exact successful response; malformed nonempty output
    // must still fail, and exports must always contain JSON.
    emptyStdout = rawList === ''
    const parsed = emptyStdout ? [] : JSON.parse(rawList)
    if (!Array.isArray(parsed)) throw new Error('opencode session list did not return an array')
    selected = parsed
      .filter(isPlainObject)
      .map((item) => ({
        id: stringValue(item.id) ?? '',
        updated: numberValue(item.updated),
        created: numberValue(item.created),
        directory: stringValue(item.directory),
      }))
      .filter((item) => item.id && withinWindow(item.updated ?? item.created, window))
  }

  deps.ctx.log.info('opencode.backfill.selection', {
    component: 'plugin.opencode.backfill',
    operation: 'backfill.select',
    selected_sessions: selected.length,
    selection_cap: MAX_SESSION_LIST,
    exact_ids: deps.exactSessionIds?.length ?? 0,
    ...(emptyStdout ? { reason: 'opencode_cli_empty_stdout' } : {}),
    status: 'ok',
  })

  for (const item of selected) {
    if (deps.ctx.signal?.aborted) break
    if (deps.ignoredSessions?.has(item.id)) {
      yield /** @type {BackfillEvent} */ ({
        type: 'event',
        event: 'session_ignore_drop',
        attributes: { session_id: item.id },
      })
      continue
    }
    if (item.directory) {
      const policy = deps.resolver.resolve(item.directory)
      if (policy.class === 'ignore') {
        yield /** @type {BackfillEvent} */ ({
          type: 'event',
          event: 'usage_policy_drop',
          attributes: { session_id: item.id, class: 'ignore' },
        })
        continue
      }
    }
    // Export only the exact ID selected above. Never call bare `export`, which
    // would choose a latest session unrelated to the requested window.
    // @ref LLP 0306#recovery-lane [implements]: bounded metadata selection,
    //   then exact-session content export
    // One unreadable session must not sink the rest of the run: the peer
    // adapters (codex, openclaw) warn and continue, and this loop can hold up
    // to MAX_SESSION_LIST sessions behind a single bad export.
    let exported
    try {
      const rawExport = await deps.runCommand(['export', item.id], EXPORT_TIMEOUT_MS)
      exported = JSON.parse(rawExport)
    } catch (err) {
      deps.ctx.log.warn('opencode.backfill.session_read_failed', {
        component: 'plugin.opencode.backfill',
        operation: 'backfill.scan',
        source_path: `opencode export ${item.id}`,
        session_id: item.id,
        status: 'error',
        error_kind: 'session_read_failed',
        error: errMessage(err),
      })
      continue
    }
    const session = isPlainObject(exported) && isPlainObject(exported.info) ? exported.info : undefined
    const cwd = stringValue(session?.directory)
    if (!cwd) {
      yield /** @type {BackfillEvent} */ ({
        type: 'event',
        event: 'missing_cwd',
        attributes: { session_id: item.id },
      })
      continue
    }
    // On the exact-id path `item.directory` is never populated, so this is the
    // only place the policy is consulted for those sessions. Report the drop
    // the same way the pre-export check does, or a `.hypignore` session is
    // silently absent from the run report rather than visibly withheld.
    const policy = deps.resolver.resolve(cwd)
    if (policy.class === 'ignore') {
      yield /** @type {BackfillEvent} */ ({
        type: 'event',
        event: 'usage_policy_drop',
        attributes: { session_id: item.id, class: 'ignore' },
      })
      continue
    }
    const projection = projectOpenCodeSnapshot(exported, {
      entrypoint: 'unknown',
      entrypointSource: 'historical-export',
    })
    if (!projection) continue
    yield projectedExchangeItem(projection, {
      client_name: 'opencode',
      source_path: `opencode export ${item.id}`,
      native_id: item.id,
    })
  }
}

/**
 * Did this command fail because the binary is not there, as opposed to
 * failing once it ran? `execFile` reports the first as ENOENT on the spawn
 * itself, which is the one failure that means "this machine has no OpenCode
 * CLI history to read" rather than "reading it went wrong".
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissingBinary(err) {
  return err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT'
}

/**
 * Did this command break its timeout, as opposed to exiting on its own?
 * `execFile` reports that as a kill it performed itself. The other failure it
 * kills for is a `maxBuffer` overflow, and that one names itself in `code`.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isTimeoutKill(err) {
  if (!(err instanceof Error)) return false
  const failure = /** @type {NodeJS.ErrnoException & { killed?: boolean }} */ (err)
  return failure.killed === true && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
}

/**
 * Stdout is returned verbatim. The empty-list check above reads exact
 * emptiness, so trimming here would silently turn a truncated whitespace-only
 * response into a successful "no sessions" import instead of the failure it is.
 *
 * A timeout kill reaches the caller as "Command failed: opencode ..." with no
 * mention of the deadline it broke. Restate it, so the disposition each call
 * site already gives a failure names the command and its budget:
 * `opencode.backfill.session_read_failed` for an export,
 * `backfill.provider_error` for a listing that fails the run.
 *
 * @param {string[]} args
 * @param {number} timeoutMs
 */
export async function runOpenCode(args, timeoutMs) {
  try {
    const result = await execFileAsync('opencode', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
    })
    return result.stdout
  } catch (err) {
    if (isTimeoutKill(err)) throw new Error(`opencode ${args.join(' ')} timed out after ${timeoutMs}ms`)
    throw err
  }
}

/** @param {number | undefined} timestamp @param {{ sinceMs?: number, untilMs?: number }} window */
function withinWindow(timestamp, window) {
  if (timestamp === undefined) return false
  if (window.sinceMs !== undefined && timestamp < window.sinceMs) return false
  if (window.untilMs !== undefined && timestamp > window.untilMs) return false
  return true
}

/** @param {unknown} value */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

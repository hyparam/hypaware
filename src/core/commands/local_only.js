// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, getLogger } from '../observability/index.js'
import { isTty } from '../cli/stdio.js'
import { multiselect } from '../cli/tui/index.js'
import { isPromptCancelledError } from '../cli/tui/runtime.js'
import { executeQuerySql } from '../query/sql.js'
import { readLocalOnlyDirs, writeLocalOnlyDirs } from '../usage-policy/local_only.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { CapturedDirectory, LocalOnlyPickerOutcome, LocalOnlyPickerResult } from '../../../src/core/commands/types.js'
 */

// The picker shows at most this many most-recently-active candidates
// (LLP 0080 #enumerate "bounded presentation"); the rest are still
// addressable via the durable `hyp ignore --local-only` command.
const MAX_SHOWN_CANDIDATES = 50

// Printed whenever the picker cannot run to completion (no candidates, a
// non-TTY login, or a failed enumeration) so the capability stays
// discoverable even when the interactive step is skipped (LLP 0072 #tty).
const DURABLE_HINT = "tip: mark a directory local-only anytime with 'hyp ignore --local-only [path]'\n"

// The dataset the candidate enumeration reads. Exported so the login flow
// can ask "can this kernel snapshot run the enumeration at all?" against the
// query registry (remote_commands.js) without the name drifting from the SQL.
export const CAPTURE_DATASET = 'ai_gateway_messages'

const ENUMERATE_SQL = `SELECT cwd, repo_root, COUNT(*) AS rows, MAX(date) AS last_seen ` +
  `FROM ${CAPTURE_DATASET} WHERE cwd IS NOT NULL GROUP BY cwd, repo_root ORDER BY last_seen DESC`

/**
 * Enumerate the distinct working directories the user has captured
 * Claude/Codex exchanges in, read from this machine's local cache only
 * (R2 — never contacts the remote). One `executeQuerySql` call
 * (`refresh: 'never'`, so enumeration never triggers a partition
 * refresh/backfill of its own); results are collapsed to one candidate per
 * distinct `cwd` (a `cwd` seen under several `repo_root`s keeps the
 * most-recently-active group, since the query is already ordered
 * `last_seen DESC`).
 *
 * Best-effort: any failure (dataset not registered, engine error) resolves
 * to `null` rather than throwing, so a broken enumeration can never block
 * `hyp remote login` — the caller is expected to treat `null` exactly like
 * an empty candidate list (skip the picker, print the durable-command hint).
 *
 * @ref LLP 0069#enumerate [implements]: distinct captured cwds, local-cache-only, best-effort
 * @param {{ query: CommandRunContext['query'], storage: CommandRunContext['storage'], config?: CommandRunContext['config'] }} args
 * @returns {Promise<CapturedDirectory[] | null>}
 */
export async function listCapturedDirectories({ query, storage, config }) {
  try {
    const out = await executeQuerySql({
      query: ENUMERATE_SQL,
      registry: query,
      storage: /** @type {ExtendedQueryStorageService} */ (storage),
      refresh: 'never',
      config,
    })
    return collapseByCwd(out.rows ?? [])
  } catch {
    return null
  }
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {CapturedDirectory[]}
 */
function collapseByCwd(rows) {
  /** @type {Map<string, CapturedDirectory>} */
  const byCwd = new Map()
  for (const row of rows) {
    const cwd = row.cwd == null ? '' : String(row.cwd)
    if (cwd === '') continue
    // Rows arrive ordered by last_seen DESC, so the first (cwd, repo_root)
    // group encountered for a given cwd is already its most-recent one; a
    // cwd seen under a second, older repo_root is intentionally dropped
    // rather than merged (LLP 0080 #enumerate).
    if (byCwd.has(cwd)) continue
    const rowsCount = Number(row.rows)
    byCwd.set(cwd, {
      cwd,
      repoRoot: row.repo_root == null ? null : String(row.repo_root),
      rows: Number.isFinite(rowsCount) ? rowsCount : 0,
      lastSeen: row.last_seen == null ? null : String(row.last_seen),
    })
  }
  return [...byCwd.values()]
}

/**
 * Human summary line for a candidate directory's picker option: repo root
 * (when known), exchange count, and last-seen (R3).
 *
 * @param {CapturedDirectory} candidate
 * @returns {string}
 */
function summarizeCandidate(candidate) {
  /** @type {string[]} */
  const parts = []
  if (candidate.repoRoot) parts.push(`repo: ${candidate.repoRoot}`)
  parts.push(`${candidate.rows} exchange${candidate.rows === 1 ? '' : 's'}`)
  if (candidate.lastSeen) parts.push(`last seen ${candidate.lastSeen}`)
  return parts.join(' · ')
}

/**
 * Run the post-enrollment `local-only` directory picker (LLP 0069 #trigger,
 * LLP 0072). Enumerates captured directories, renders a checkbox multi-select
 * on `ctx.stderr` (stdout stays clean for scripts) with directories already on
 * the machine-local list pre-checked, and persists the confirmed selection.
 *
 * Skips (prints the durable-command hint, zero exclusions) when: enumeration
 * fails or returns no candidates, or stdin/stderr is not an interactive TTY
 * (R1) — a piped/EOF'd stdin is not a TTY, so that case is covered by the
 * same gate; Ctrl-C is the interactive cancel, caught below.
 *
 * On cancel (`PromptCancelledError`) the picker proceeds without writing
 * anything: the existing on-disk list (if any) is left exactly as it was —
 * "zero exclusions" means zero *new* exclusions this run, never a silent
 * wipe of a prior session's choices (LLP 0072 #default, adapted for re-login
 * editor semantics). Any other thrown error (e.g. a corrupt existing list)
 * propagates: the caller (`runBrowserLogin`, LLP 0069 #trigger) is expected
 * to catch it, warn, and treat it as zero exclusions — the privacy
 * refinement must never break the enrollment it refines.
 *
 * @ref LLP 0072 [implements]: post-enrollment refinement — TTY-gated, defaults to nothing, never blocks
 * @param {{
 *   ctx: Pick<CommandRunContext, 'stdin' | 'stderr' | 'env' | 'query' | 'storage' | 'config'>,
 *   stateDir: string,
 *   listCandidates?: () => Promise<CapturedDirectory[] | null>,
 *   fs?: typeof fsp,
 * }} args
 * @returns {Promise<LocalOnlyPickerResult>}
 */
export async function runLocalOnlyPicker({ ctx, stateDir, listCandidates, fs }) {
  const stdin = ctx.stdin ?? process.stdin
  const stderr = ctx.stderr
  const enumerate = listCandidates ?? (() => listCapturedDirectories({
    query: ctx.query,
    storage: ctx.storage,
    config: ctx.config,
  }))

  const candidates = await enumerate()
  if (candidates === null) {
    stderr.write(DURABLE_HINT)
    return finish({ outcome: 'enumeration_failed', candidateCount: 0, selectedCount: 0, excludedDirs: [] })
  }
  if (candidates.length === 0) {
    stderr.write(DURABLE_HINT)
    return finish({ outcome: 'no_candidates', candidateCount: 0, selectedCount: 0, excludedDirs: [] })
  }

  if (!isTty(stdin) || !isTty(stderr)) {
    stderr.write(DURABLE_HINT)
    return finish({ outcome: 'non_tty', candidateCount: candidates.length, selectedCount: 0, excludedDirs: [] })
  }

  const readOpts = fs ? { stateDir, fs } : { stateDir }
  const existingDirs = await readLocalOnlyDirs(readOpts)
  const existingSet = new Set(existingDirs)

  const shown = candidates.slice(0, MAX_SHOWN_CANDIDATES)
  const overflow = candidates.length - shown.length
  const shownCwds = shown.map((c) => path.resolve(c.cwd))
  const shownSet = new Set(shownCwds)

  if (overflow > 0) {
    stderr.write(`…and ${overflow} more — manage with 'hyp ignore --local-only <path>'\n`)
  }

  const options = shown.map((candidate, i) => ({
    value: shownCwds[i],
    label: shownCwds[i],
    summary: summarizeCandidate(candidate),
    checked: existingSet.has(shownCwds[i]),
  }))

  /** @type {Array<string | number>} */
  let selected
  try {
    selected = await multiselect({
      title: 'Mark any directories as local-only (recorded here, never forwarded)?',
      options,
      clearOnResolve: true,
      stdin,
      stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (stderr)),
      env: ctx.env,
    })
  } catch (err) {
    if (!isPromptCancelledError(err)) throw err
    return finish({ outcome: 'cancelled', candidateCount: candidates.length, selectedCount: 0, excludedDirs: existingDirs })
  }

  // Editor semantics (LLP 0080 #picker): the confirmed checked set replaces
  // every candidate that was actually offered; list entries not shown this
  // round (vanished directories, or candidates beyond the 50-cap) are
  // preserved untouched.
  const selectedSet = new Set(selected.map((v) => String(v)))
  const preserved = existingDirs.filter((dir) => !shownSet.has(dir))
  const finalDirs = [...preserved, ...selectedSet]

  const writeOpts = fs ? { stateDir, dirs: finalDirs, fs } : { stateDir, dirs: finalDirs }
  await writeLocalOnlyDirs(writeOpts)
  getLogger('usage-policy').info('usage_policy.local_only_write', {
    [Attr.COMPONENT]: 'cmd-local-only',
    [Attr.OPERATION]: 'usage_policy.local_only_write',
    dir_count: finalDirs.length,
    status: 'ok',
  })

  // Never-silent (LLP 0072 #never-silent): only speak up when there is
  // something to withhold; an empty result is the quiet default state.
  if (finalDirs.length > 0) {
    stderr.write(
      `withholding ${finalDirs.length} director${finalDirs.length === 1 ? 'y' : 'ies'} from forwarding — recorded locally, never sent\n`
    )
  }

  const outcome = selectedSet.size > 0 ? 'selected' : 'none'
  return finish({ outcome, candidateCount: candidates.length, selectedCount: selectedSet.size, excludedDirs: finalDirs })
}

/**
 * Emit the `local_only.picker_result` telemetry event and return the result
 * shape callers get back, in one place so every exit path is logged.
 *
 * @param {{ outcome: LocalOnlyPickerOutcome, candidateCount: number, selectedCount: number, excludedDirs: string[] }} result
 * @returns {LocalOnlyPickerResult}
 */
function finish(result) {
  getLogger('usage-policy').info('local_only.picker_result', {
    [Attr.COMPONENT]: 'cmd-local-only',
    [Attr.OPERATION]: 'local_only.picker_result',
    candidate_count: result.candidateCount,
    selected_count: result.selectedCount,
    outcome: result.outcome,
    status: 'ok',
  })
  return result
}

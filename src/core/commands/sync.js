// @ts-check

import { requireConfirmation } from '../cli/confirm.js'
import { withSpinner } from '../cli/spinner.js'
import { parseCommandArgv, STRICT_SHORT_FLAGS } from '../cli/verb_codec.js'
import { Attr, getLogger } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { effectiveRemotes } from '../remote/builtin_remotes.js'
import { previewPendingRows } from '../sinks/pending.js'
import {
  SYNC_HELD_NO_DESTINATIONS_EXIT,
  clearFirstSyncHold,
  firstSyncHoldMarkerPath,
  formatFirstSyncDeadline,
  readFirstSyncDeadline,
} from '../usage-policy/first_sync_hold.js'
import { readClientSyncEntries, readLocalOnlyEntries } from '../usage-policy/index.js'
import { groupThousands } from '../util/format_number.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ExtendedSinkHandle, ExtendedSinkRegistry } from '../../../src/core/registry/types.js'
 * @import { PendingVolume } from '../../../src/core/sinks/types.js'
 * @import { SourceHistoryReplayPreview } from '../../../hypaware-plugin-kernel-types.js'
 */

const USAGE = 'usage: hyp sync [instance] [--history <client>] [--yes] [--dry-run]'

/**
 * `hyp sync [instance] [--history <client>] [--yes] [--dry-run]`
 *
 * Export every configured sink now, rather than on its cron schedule. The
 * user-facing name for the one action the driver performs; it replaced
 * `hyp sink force`, which spelled the same tick in the driver's vocabulary
 * instead of the user's.
 *
 * Two things make this more than a scheduling shortcut:
 *
 * 1. **It always confirms.** Not only when data leaves the machine: one
 *    unconditional rule beats a prompt whose appearance the user has to
 *    predict. `--yes` is the scripted bypass, as it is for `hyp purge`.
 * 2. **It is the only way to end the first-sync review window early.** While
 *    that hold is live the prompt escalates (see {@link renderFirstSyncWarning})
 *    and a confirmation clears the marker.
 *
 * @ref LLP 0101#no-release [implements]: supersedes "no early release" - a confirmed, attended release verb
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runSync(argv, ctx) {
  const log = getLogger('sync')
  const parsed = parseCommandArgv(
    argv,
    {
      type: 'object',
      properties: {
        instance: { type: 'string' },
        history: { type: 'string' },
        yes: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
      positional: ['instance'],
    },
    { ...STRICT_SHORT_FLAGS, aliases: { '-y': '--yes' } }
  )
  if ('help' in parsed) {
    ctx.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!parsed.ok) {
    ctx.stderr.write(`hyp sync: ${parsed.error}\n${USAGE}\n`)
    return 2
  }
  const { instance, history, yes, 'dry-run': dryRun } =
    /** @type {{ instance?: string, history?: string, yes: boolean, 'dry-run': boolean }} */ (parsed.params)
  // `--history=` parses to an empty string, which is falsy: without this the
  // flag silently disappears and the run becomes an ordinary all-destination
  // sync that also ends the first-sync review window. A mistyped client name
  // must never buy the larger action.
  if (history !== undefined && history === '') {
    ctx.stderr.write(`hyp sync: --history needs a client name\n${USAGE}\n`)
    return 2
  }

  // Read before the handle count, not after it: whether an empty handle set is
  // worth reporting depends on whether a window is open.
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const deadline = await readFirstSyncDeadline({ stateDir })

  const allHandles = /** @type {ExtendedSinkRegistry} */ (ctx.sinks).listHandles?.() ?? []
  const handles = instance ? allHandles.filter((h) => h.instanceName === instance) : allHandles
  if (instance && handles.length === 0) {
    ctx.stderr.write(`hyp sync: no sink named '${instance}' was instantiated\n`)
    const available = allHandles.map((h) => h.instanceName)
    if (available.length > 0) ctx.stderr.write(`  available: ${available.join(', ')}\n`)
    return 1
  }
  if (handles.length === 0) {
    // With no window open this really is nothing to do. While one is open it
    // is the opposite: the caller ran the one verb that ends the window early
    // and got back a success line that neither sent anything nor said the wait
    // still stands. Distinguishably, because a user who read the plan and
    // answered no also leaves the marker in place and exits 0.
    // @ref LLP 0101#no-release [implements]: a release that cannot happen says so rather than exiting 0 having sent nothing
    if (deadline !== null) {
      ctx.stderr.write(
        'hyp sync: no destinations are configured, so there is nothing to send.\n' +
        `  The first-sync review window stays open until ${formatFirstSyncDeadline(deadline)},\n` +
        '  and nothing leaves this machine while it has nowhere to go.\n' +
        '  Configure a destination, then run `hyp sync` again.\n'
      )
      return SYNC_HELD_NO_DESTINATIONS_EXIT
    }
    ctx.stdout.write('no sinks instantiated; nothing to do\n')
    return 0
  }

  const remotes = effectiveRemotes(ctx.config)
  const destinations = handles.map((handle) => describeDestination(handle, remotes))

  if (history) {
    return runHistorySync({
      source: history,
      handles,
      destinations,
      stateDir,
      deadline,
      yes,
      dryRun,
      ctx,
      log,
    })
  }

  // Two refusals, both because the hold is driver-wide (LLP 0101 #hold)
  // while the consent in front of it would not be. They come before the plan
  // is rendered: a scoped plan is exactly the misleading artifact the first
  // refusal exists to prevent, and printing "syncing now ends it early"
  // ahead of "you cannot end it this way" reads as a contradiction.
  //
  // A named instance shows a plan built from that one handle, so confirming
  // it would release every *other* destination unseen - the silent first
  // forward the hold exists to prevent. Releasing is all-or-nothing because
  // the hold is.
  //
  // `--yes` skips the plan's whole purpose. `#no-release` licenses release by
  // "confirmed, attended request" and "an explicit `y`"; a provisioning
  // script satisfies neither, and its destination list scrolls past in a log
  // nobody reads. Ordinary (unheld) syncs keep `--yes` - what it must not buy
  // is somebody's review window.
  //
  // `--dry-run` is exempt: it sends nothing, so showing a held machine what
  // one destination would export is information, not consent.
  if (deadline !== null && !dryRun) {
    const held = `hyp sync: the first-sync review window is open until ${formatFirstSyncDeadline(deadline)}.\n`
    if (instance) {
      ctx.stderr.write(
        held +
        `  Ending it is all-or-nothing: the hold covers every destination, so releasing it\n` +
        `  from a run that names only '${instance}' would forward the others unseen.\n` +
        '  Run `hyp sync` with no instance to review every destination and release,\n' +
        '  or wait for the deadline.\n'
      )
      return 2
    }
    if (yes) {
      ctx.stderr.write(
        held +
        '  Ending it early takes an interactive confirmation, so --yes cannot do it.\n' +
        '  Run `hyp sync` from a terminal, or wait for the deadline.\n'
      )
      return 2
    }
  }

  // "How much, and how far back?" is the first question a consent prompt has to
  // answer, and it is the one the plan used to leave out: a machine with three
  // queued rows and one with a quarter of a million rendered byte-identically.
  // Counted here rather than inside `renderPlan` so the renderer stays a pure
  // function of what it prints, and so a count that fails degrades to "unknown"
  // instead of taking the whole prompt down with it.
  //
  // The count scans every pending partition and runs before this verb has
  // printed a character, so a large backlog leaves the terminal blank between
  // the keystroke and the plan. `quietWhenPlain` keeps the plan the first
  // thing a script sees: there is nobody off a TTY to reassure, and the
  // elapsed time is in the log line below.
  // @ref LLP 0101#no-release [implements]: the "prints what would leave" half, in rows rather than only in destination names
  const previewStartedAt = Date.now()
  const volumes = await withSpinner(
    {
      stdout: ctx.stdout,
      env: ctx.env,
      quietWhenPlain: true,
      label: 'Counting pending rows...',
    },
    () => previewPendingRows({
      handles,
      query: ctx.query,
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      stateRoot: stateDir,
      config: ctx.config,
    })
  )
  // The elapsed time is the point of this line as much as the counts are: the
  // preview sits between the user's keystroke and the prompt, so if `hyp sync`
  // ever feels hung again the log says whether the count was the reason.
  log.info('sync.pending_preview', {
    [Attr.COMPONENT]: 'cmd-sync',
    [Attr.OPERATION]: 'sync.pending_preview',
    hyp_elapsed_ms: Date.now() - previewStartedAt,
    destinations: volumes.size,
    hyp_pending_rows: sum(volumes, (v) => v.rows),
    hyp_withheld_rows: sum(volumes, (v) => v.withheldRows),
    hyp_exact_counts: [...volumes.values()].filter((v) => v.status === 'counted').length,
  })
  ctx.stdout.write(renderPlan({ destinations, volumes, exclusions: await readExclusions(stateDir) }))
  if (deadline !== null) ctx.stdout.write(renderFirstSyncWarning(deadline))

  if (dryRun) {
    ctx.stdout.write('\n[dry-run] nothing was sent\n')
    return 0
  }

  const outcome = await requireConfirmation({
    ctx,
    yes,
    question: deadline !== null
      ? 'Send now and end the review window? [Y/n] '
      : `Send now to ${describeScope(destinations)}? [Y/n] `,
    defaultYes: true,
  })
  if (outcome === 'no-tty') {
    ctx.stderr.write(
      'error: refusing to sync without confirmation - pass --yes to send non-interactively\n'
    )
    return 2
  }
  if (outcome === 'declined') {
    ctx.stdout.write('sync cancelled\n')
    return 0
  }

  // Release before the tick, because the driver reads the marker itself and
  // would otherwise hold the very export just consented to. A failed export
  // leaves the window ended: consent was given, and the retry belongs to the
  // ordinary schedule rather than to a window that has served its purpose.
  //
  // A failed unlink must not read as success. The marker survives, the driver
  // holds the tick, and without this check the command would print nothing
  // further and exit 0 - the exact "opposite of the truth" output this verb
  // was written to replace.
  if (deadline !== null) {
    const cleared = await clearFirstSyncHold({ stateDir })
    const stillHeld = await readFirstSyncDeadline({ stateDir })
    if (!cleared || stillHeld !== null) {
      ctx.stderr.write(
        'hyp sync: could not end the review window - the hold marker could not be removed\n' +
        `  ${firstSyncHoldMarkerPath(stateDir)}\n` +
        '  Nothing was sent. Check the file\'s permissions and re-run.\n'
      )
      return 1
    }
    // The one moment a machine's history becomes forwardable ahead of its
    // deadline, and clearing the marker destroys the only on-disk evidence it
    // happened. Without this line nothing afterwards distinguishes "the window
    // expired" from "somebody released it".
    log.info('sync.first_sync_hold_released', {
      [Attr.COMPONENT]: 'cmd-sync',
      [Attr.OPERATION]: 'sync.first_sync_hold_released',
      hyp_deadline: new Date(deadline).toISOString(),
      hyp_released_early_ms: deadline - Date.now(),
      destinations: destinations.length,
      off_machine_destinations: destinations.filter((d) => d.offMachine === true).length,
    })
  }

  const { createSinkDriver } = await import('../sinks/driver.js')
  const driver = createSinkDriver({
    sinkRegistry: /** @type {ExtendedSinkRegistry} */ (ctx.sinks),
    queryRegistry: ctx.query,
    storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
    stateRoot: stateDir,
    config: ctx.config,
  })
  /** @type {{ now: Date, force: true, source: 'manual', sinkInstance?: string }} */
  const tickOpts = { now: new Date(), force: true, source: 'manual' }
  if (instance) tickOpts.sinkInstance = instance
  // The tick is the long silent wait of this verb: one export per sink, each
  // a network round trip, with nothing on screen between the user's "y" and
  // the result lines. The driver reports per sink only once the whole tick
  // settles, so an elapsed-time spinner is the progress that is available.
  const report = await withSpinner(
    { stdout: ctx.stdout, env: ctx.env, label: `Sending to ${describeScope(destinations)}...` },
    () => driver.tick(tickOpts)
  )

  // A hold that appeared between the check above and the tick (a concurrent
  // enrolling login) would otherwise print an empty report and exit 0.
  if (report.held) {
    ctx.stderr.write(`hyp sync: nothing was sent - the sink driver is holding every tick (${report.held})\n`)
    return 1
  }

  for (const r of report.sinks) {
    ctx.stdout.write(
      `${r.instance}: ${r.status} (partitions=${r.partitionsExported}, bytes=${r.bytesWritten}${
        r.error ? `, error=${r.error}` : ''
      })\n`
    )
  }
  return report.sinks.some((r) => r.status === 'failed') ? 1 : 0
}

/**
 * Preview and execute the explicit retained-history mode. It is separate from
 * the ordinary driver tick: the incremental cursor stays untouched and only
 * sinks that prove a replay-safe implementation participate.
 *
 * @ref LLP 0345#command [implements]: a separately confirmed `hyp sync --history <client>` path
 * @ref LLP 0345#sink-capability [implements]: use only sinks that expose both preview and execution
 * @param {{
 *   source: string,
 *   handles: ExtendedSinkHandle[],
 *   destinations: { instance: string, text: string, offMachine: boolean | null }[],
 *   stateDir: string,
 *   deadline: number | null,
 *   yes: boolean,
 *   dryRun: boolean,
 *   ctx: CommandRunContext,
 *   log: ReturnType<typeof getLogger>,
 * }} args
 * @returns {Promise<number>}
 */
async function runHistorySync({ source, handles, destinations, stateDir, deadline, yes, dryRun, ctx, log }) {
  let clientEntries
  try {
    clientEntries = (await readClientSyncEntries({ stateDir })) ?? []
  } catch (err) {
    ctx.stderr.write(`hyp sync --history: cannot verify client policy (${err instanceof Error ? err.message : String(err)})\n`)
    return 1
  }
  if (clientEntries.some((entry) => entry.source === source)) {
    ctx.stderr.write(
      `hyp sync --history: '${source}' is still local-only; nothing was sent\n` +
      `  First run: hyp privacy client ${source} sync\n`
    )
    return 1
  }

  if (deadline !== null && !dryRun) {
    ctx.stderr.write(
      `hyp sync --history: the first-sync review window is open until ${formatFirstSyncDeadline(deadline)}.\n` +
      '  Historical replay cannot bypass or clear that hold. Run `hyp sync` first,\n' +
      '  then repeat this command.\n'
    )
    return 2
  }

  const capable = handles.filter((handle) => (
    typeof handle.sink.previewSourceHistory === 'function' &&
    typeof handle.sink.replaySourceHistory === 'function'
  ))
  if (capable.length === 0) {
    ctx.stderr.write('hyp sync --history: no configured destination supports client-history replay\n')
    return 1
  }

  /** @type {Map<string, SourceHistoryReplayPreview>} */
  const previews = new Map()
  const previewStartedAt = Date.now()
  for (const handle of capable) {
    try {
      // A full scan of the client's retained history, once per destination,
      // and like the ordinary plan's count it runs before anything is on
      // screen. Quiet off a TTY for the same reason.
      const preview = await withSpinner(
        {
          stdout: ctx.stdout,
          env: ctx.env,
          quietWhenPlain: true,
          label: `Counting retained '${source}' history on ${handle.instanceName}...`,
        },
        async () => handle.sink.previewSourceHistory?.({ source })
      )
      if (!preview) throw new Error('history preview became unavailable')
      previews.set(handle.instanceName, preview)
    } catch (err) {
      ctx.stderr.write(
        `hyp sync --history: could not preview '${handle.instanceName}' (${err instanceof Error ? err.message : String(err)})\n` +
        '  Nothing was sent.\n'
      )
      return 1
    }
  }

  // The preview is a full scan of the client's retained history, once per
  // capable destination, and it sits between the keystroke and the prompt.
  // Same reason the ordinary plan logs its own elapsed time: if this ever
  // feels hung, the log should say whether the count was why.
  const previewRows = [...previews.values()]
  // `max`, not `sum`: every capable destination replays the same retained
  // history, so adding their counts would quote double the rows a two-sink
  // machine actually replays.
  const totalRows = previewRows.reduce((most, preview) => Math.max(most, preview.rows), 0)
  const totalWithheld = previewRows.reduce((most, preview) => Math.max(most, preview.withheldRows), 0)
  log.info('sync.history_preview', {
    [Attr.COMPONENT]: 'cmd-sync',
    [Attr.OPERATION]: 'sync.history_preview',
    hyp_elapsed_ms: Date.now() - previewStartedAt,
    hyp_sink_source: source,
    destinations: previews.size,
    hyp_pending_rows: totalRows,
    hyp_withheld_rows: totalWithheld,
  })

  const capableNames = new Set(capable.map((handle) => handle.instanceName))
  const selectedDestinations = destinations.filter((destination) => capableNames.has(destination.instance))
  const unsupported = destinations.filter((destination) => !capableNames.has(destination.instance))
  ctx.stdout.write(renderHistoryPlan({ source, destinations: selectedDestinations, previews, unsupported }))

  // A zero-row replay is a success (LLP 0345 #scope), but reporting it as
  // `exported (rows=0)` after a confirmation prompt reads as "your history
  // was contributed" to someone who ran this to contribute history. The
  // usual cause is a name that is not the one on the rows: `--history` matches
  // `client_name`, which is not always the picker id (claude-desktop's rows
  // are stamped `claude`). Say that instead of prompting for nothing.
  if (totalRows === 0) {
    ctx.stdout.write(`\nno retained history is attributed to '${source}'; nothing to replay\n`)
    // Zero eligible rows beside a non-zero withheld count is a different
    // diagnosis: rows were found and privacy policy held them back. Sending that
    // user to check `client_name` spellings points at the wrong thing. The
    // preview cannot narrow it further, because a dropped entry carries no row
    // and so no `client_name` to attribute the withholding to.
    if (totalWithheld > 0) {
      ctx.stdout.write(
        '  Retained rows were found and withheld by privacy policy (above); a dropped\n' +
        '  row carries no client_name, so this cannot say whether they were this\n' +
        "  client's. Check `hyp privacy list` before assuming the name is wrong.\n"
      )
    }
    ctx.stdout.write(
      '  --history matches the client_name on the rows, which is not always the\n' +
      '  client id: run `hyp query sql "select distinct client_name from ai_gateway_messages"`\n' +
      '  to see the names this machine actually recorded.\n'
    )
    return 0
  }

  if (dryRun) {
    ctx.stdout.write('\n[dry-run] nothing was sent\n')
    return 0
  }

  const outcome = await requireConfirmation({
    ctx,
    yes,
    question: `Replay ${plural(totalRows, 'retained row')} for '${source}' now? [Y/n] `,
    defaultYes: true,
  })
  if (outcome === 'no-tty') {
    ctx.stderr.write('error: refusing to replay history without confirmation - pass --yes to send non-interactively\n')
    return 2
  }
  if (outcome === 'declined') {
    ctx.stdout.write('historical sync cancelled\n')
    return 0
  }

  let failed = false
  for (const handle of capable) {
    let result
    try {
      result = await withSpinner(
        { stdout: ctx.stdout, env: ctx.env, label: `Replaying '${source}' history to ${handle.instanceName}...` },
        async () => handle.sink.replaySourceHistory?.({ source })
      )
    } catch (err) {
      failed = true
      ctx.stdout.write(
        `${handle.instanceName}: failed (${err instanceof Error ? err.message : String(err)})\n`
      )
      continue
    }
    if (!result) {
      failed = true
      ctx.stdout.write(`${handle.instanceName}: failed (history replay became unavailable)\n`)
      continue
    }
    ctx.stdout.write(
      `${handle.instanceName}: ${result.status} (rows=${result.rowsReplayed}, bytes=${result.bytesWritten}${
        result.error ? `, error=${result.error}` : ''
      })\n`
    )
    if (result.status === 'failed') failed = true
  }
  return failed ? 1 : 0
}

/**
 * @param {{
 *   source: string,
 *   destinations: { instance: string, text: string, offMachine: boolean | null }[],
 *   previews: Map<string, SourceHistoryReplayPreview>,
 *   unsupported: { instance: string, text: string }[],
 * }} args
 */
function renderHistoryPlan({ source, destinations, previews, unsupported }) {
  const width = Math.max(...destinations.map((destination) => destination.instance.length))
  const lines = [`hyp sync: retained '${source}' history\n`, '\n']
  for (const destination of destinations) {
    const preview = /** @type {SourceHistoryReplayPreview} */ (previews.get(destination.instance))
    const note = destination.offMachine === true
      ? '  (leaves this machine)'
      : destination.offMachine === false
        ? '  (stays on this machine)'
        : ''
    lines.push(`  ${destination.instance.padEnd(width)}  ${destination.text}${note}\n`)
    lines.push(`  ${' '.repeat(width)}  ${plural(preview.rows, 'row')} retained and eligible\n`)
    if (preview.withheldRows > 0) {
      // "privacy policy", not "directory policy": the export seam drops a row
      // for a local-only directory, a client opt-out, or the LLP 0192
      // unattributed rule, and a dropped entry carries no row, so the preview
      // cannot tell the three apart. Naming only one of them in a consent
      // prompt would misreport why the rest stayed here.
      lines.push(`  ${' '.repeat(width)}  ${plural(preview.withheldRows, 'row')} withheld by privacy policy (not sent)\n`)
    }
  }
  if (unsupported.length > 0) {
    lines.push(`\n  not replayed (destination does not support history): ${unsupported.map((d) => d.instance).join(' · ')}\n`)
  }
  return lines.join('')
}

/**
 * Where a sink writes, and whether that is off this machine.
 *
 * The driver deliberately has no notion of which sinks leave the host
 * ([LLP 0101 #hold](../../../llp/0101-first-sync-review-window.decision.md#hold)
 * holds all of them for exactly that reason), so this reads the instance's
 * own config rather than inventing a registration concept for one prompt.
 * An `http(s)` destination is off-machine on the evidence of the URL; a
 * filesystem path is on-machine on the evidence of the path. Anything else
 * reports `null` and the summary stays silent about it - a confirmation
 * prompt that guesses is worse than one that admits the gap.
 *
 * A server is named, never spelled as a URL. R1a binds the enrolling login's
 * surfaces by its own text, but its reason is about terminals, not about
 * which command printed the line: any `https://` run autolinks with no way
 * to opt out, and the server root answers `{"error":"unknown_path"}` in a
 * browser. This prompt appears at the same moment in onboarding and would
 * collect the same dead-link click. An origin with no configured name falls
 * back to its host, which is still not a URL a terminal will linkify.
 *
 * @ref LLP 0100#requirements [constrained-by]: R1a's reason - name the server, never its URL - applied to the consent prompt R1a's text does not reach
 * @param {ExtendedSinkHandle} handle
 * @param {Record<string, { url?: string }>} remotes configured targets, name to URL
 * @returns {{ instance: string, text: string, offMachine: boolean | null }}
 */
function describeDestination(handle, remotes) {
  const config = /** @type {Record<string, unknown>} */ (handle.config ?? {})
  const url = config.url
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    return { instance: handle.instanceName, text: nameServer(url, remotes), offMachine: true }
  }
  const dir = config.dir
  if (typeof dir === 'string' && dir.length > 0) {
    return { instance: handle.instanceName, text: dir, offMachine: false }
  }
  return { instance: handle.instanceName, text: handle.plugin ?? 'unknown destination', offMachine: null }
}

/**
 * Render a server URL as the name the user configured for it, matching on
 * origin so a target registered with a trailing path or slash still resolves.
 *
 * @param {string} url
 * @param {Record<string, { url?: string }>} remotes
 * @returns {string}
 */
function nameServer(url, remotes) {
  /** @param {string} value */
  const originOf = (value) => {
    try {
      return new URL(value).origin
    } catch {
      return null
    }
  }
  const origin = originOf(url)
  if (origin) {
    for (const [name, target] of Object.entries(remotes ?? {})) {
      if (typeof target?.url === 'string' && originOf(target.url) === origin) {
        return `the '${name}' server`
      }
    }
    return new URL(url).host
  }
  return url
}

/**
 * Count the directories the machine-local policy lists withhold, so the
 * prompt can state what is *not* going as well as what is.
 *
 * An unreadable list is reported, never swallowed and never fatal: the query
 * seam (not this summary) is what actually withholds those rows, so a failed
 * read changes what the user is told, not what ships.
 *
 * @param {string} stateDir
 * @returns {Promise<{ localOnly: number, ignore: number, clientLocalOnly: string[] } | { error: string }>}
 */
async function readExclusions(stateDir) {
  try {
    const entries = await readLocalOnlyEntries({ stateDir })
    // The per-client opt-out store (LLP 0188 #never-silent): clients kept
    // local-only are named, not counted - the list is short and "openclaw"
    // tells the user something "1 client" does not.
    const clientEntries = (await readClientSyncEntries({ stateDir })) ?? []
    return {
      localOnly: entries.filter((e) => e.class === 'local-only').length,
      ignore: entries.filter((e) => e.class === 'ignore').length,
      clientLocalOnly: clientEntries.map((e) => e.source).sort(),
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The pre-confirmation summary: every destination, named, with **how much**
 * would leave through it, how far back that reaches, and the exclusions that
 * will not travel. "Are you sure?" with nothing to be sure *about* is a
 * keystroke, not a decision, and a size-free plan was exactly that: identical
 * on a machine with three queued rows and one with a quarter of a million.
 *
 * @param {{
 *   destinations: { instance: string, text: string, offMachine: boolean | null }[],
 *   volumes?: Map<string, PendingVolume>,
 *   exclusions: { localOnly: number, ignore: number, clientLocalOnly?: string[] } | { error: string },
 * }} args
 * @returns {string}
 */
function renderPlan({ destinations, volumes, exclusions }) {
  const width = Math.max(...destinations.map((d) => d.instance.length))
  const lines = [`hyp sync: ${plural(destinations.length, 'destination')}\n`, '\n']
  for (const dest of destinations) {
    const note = dest.offMachine === true
      ? '  (leaves this machine)'
      : dest.offMachine === false
        ? '  (stays on this machine)'
        : ''
    lines.push(`  ${dest.instance.padEnd(width)}  ${dest.text}${note}\n`)
    for (const line of renderVolume(volumes?.get(dest.instance))) {
      lines.push(`  ${' '.repeat(width)}  ${line}\n`)
    }
  }
  // Naming a server instead of its URL is only safe if the name stays
  // auditable: R1a's second half, applied here for the same reason.
  if (destinations.some((d) => d.offMachine === true)) {
    lines.push("  (run 'hyp remote list' to see server URLs)\n")
  }
  lines.push('\n')
  if ('error' in exclusions) {
    lines.push(`  warning: could not read the local-only list (${exclusions.error});\n`)
    lines.push('  exclusions still apply, but cannot be summarized here\n')
  } else {
    const clientLocalOnly = exclusions.clientLocalOnly ?? []
    if (exclusions.localOnly > 0 || exclusions.ignore > 0) {
      const parts = []
      if (exclusions.localOnly > 0) parts.push(`${plural(exclusions.localOnly, 'directory', 'directories')} marked local-only`)
      if (exclusions.ignore > 0) parts.push(`${plural(exclusions.ignore, 'directory', 'directories')} marked ignore`)
      lines.push(`  withholding ${parts.join(', ')}\n`)
    } else if (clientLocalOnly.length === 0) {
      lines.push('  no directories or clients are marked local-only or ignore\n')
    }
    if (clientLocalOnly.length > 0) {
      lines.push(`  keeping these clients local-only: ${clientLocalOnly.join(' · ')}\n`)
    }
  }
  return lines.join('')
}

/**
 * The volume disclosure under one destination: what would go, how far back it
 * reaches, and what is being held back.
 *
 * Three rules, all of them about not misleading the person at the prompt:
 *
 * - **Withheld rows get their own line.** Folding them into the pending count
 *   would overstate the egress; dropping them entirely is how a machine that
 *   withholds *everything* looks identical to one that withholds nothing (#958
 *   was invisible at exactly this prompt).
 * - **A floor says so, on every line the scan produced.** A truncated count
 *   renders "at least N", never N, and the withheld tally carries the same
 *   mark: it came off the same short scan, so an exact-looking number beside
 *   an "at least" claims a precision the count never had and understates what
 *   policy held back, on the one line that says policy is working at all.
 * - **An unknown count says unknown.** Rendering it as "nothing pending" would
 *   be a false all-clear on a consent surface, which is worse than a gap.
 *
 * @param {PendingVolume | undefined} volume
 * @returns {string[]}
 */
function renderVolume(volume) {
  if (!volume) return []
  if (volume.status === 'unknown') {
    return [`pending volume unknown${volume.reason ? ` (${volume.reason})` : ''}`]
  }
  // One scan produced the payload tally and the withheld tally together, so
  // one truncation marks both.
  const floor = volume.status === 'partial' ? 'at least ' : ''
  const lines = []
  if (volume.rows === 0 && volume.status === 'counted') {
    lines.push('nothing pending')
  } else if (volume.rows === 0) {
    // A floor of zero is not a floor. "at least 0 rows pending" reads as a bug
    // on the one line somebody is deciding from, and it is reachable: a
    // destination whose whole pending range is withheld, counted short. Say the
    // payload count is incomplete and let the withheld line below carry the
    // magnitude, marked as the floor it is.
    lines.push(`pending volume not fully counted${volume.reason ? ` (${volume.reason})` : ''}`)
  } else {
    lines.push(`${floor}${plural(volume.rows, 'row')} pending${renderResume(volume.resume)}`)
  }
  if (volume.withheldRows > 0) {
    lines.push(`${floor}${plural(volume.withheldRows, 'row')} withheld by policy (not sent)`)
  }
  return lines
}

/**
 * The "covering what period" half. `beginning` is the loudest of the three:
 * nothing has ever been exported to this destination, so the range is the
 * machine's whole captured history.
 *
 * @param {PendingVolume['resume']} resume
 * @returns {string}
 */
function renderResume(resume) {
  if (resume.kind === 'beginning') return ', the full local history'
  if (resume.kind === 'since') return `, captured since ${formatResumeInstant(resume.at)}`
  return ''
}

/**
 * Minute-precision UTC, the resolution a person reads a resume point at.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatResumeInstant(iso) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return `${new Date(ms).toISOString().slice(0, 16)}Z`
}

/**
 * The escalated warning shown while the first-sync review window is open.
 *
 * This is the one prompt in the CLI where the user has never sent anything
 * before, so it says so, states what confirming gives up (the rest of the
 * window), and names the command that excludes a folder - a warning that
 * only warns leaves the user with no move except yes or no.
 *
 * @ref LLP 0100#requirements [implements]: R2's review window ends by deadline or by informed consent
 * @param {number} deadlineMs
 * @returns {string}
 */
function renderFirstSyncWarning(deadlineMs) {
  return (
    '\n' +
    '  FIRST SYNC - nothing has left this machine yet\n' +
    '\n' +
    `  Your review window runs until ${formatFirstSyncDeadline(deadlineMs)}.\n` +
    '  Syncing now ends it early and sends your backfilled history.\n' +
    '  What has been sent cannot be un-sent. To exclude a folder first:\n' +
    '    hyp privacy set <path> local-only\n'
  )
}

/**
 * Name the scope of an ordinary (unheld) confirmation by where the data
 * goes, so the question is answerable without scrolling back to the plan.
 *
 * @param {{ offMachine: boolean | null }[]} destinations
 * @returns {string}
 */
function describeScope(destinations) {
  const offMachine = destinations.filter((d) => d.offMachine === true).length
  if (offMachine === 0) return plural(destinations.length, 'destination')
  if (offMachine === destinations.length) return `${plural(offMachine, 'destination')} off this machine`
  return `${plural(destinations.length, 'destination')} (${offMachine} off this machine)`
}

/**
 * @param {number} n
 * @param {string} singular
 * @param {string} [pluralForm]
 * @returns {string}
 */
function plural(n, singular, pluralForm = `${singular}s`) {
  return `${formatCount(n)} ${n === 1 ? singular : pluralForm}`
}

/**
 * @param {Map<string, PendingVolume>} volumes
 * @param {(volume: PendingVolume) => number} pick
 * @returns {number}
 */
function sum(volumes, pick) {
  let total = 0
  for (const volume of volumes.values()) total += pick(volume)
  return total
}

/**
 * Thousands-grouped without a locale: a row count is the number this prompt
 * turns on, and it must not render as `236.650` on one machine and `236,650`
 * on another. Pinning `en-US` rendered the same string, but left that property
 * one deleted argument away from being false, and testable only by moving the
 * ambient locale out from under the running process. {@link groupThousands}
 * makes it true of the code instead (#1121).
 *
 * @param {number} n
 * @returns {string}
 */
function formatCount(n) {
  return groupThousands(n)
}

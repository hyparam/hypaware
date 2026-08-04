// @ts-check

import { requireConfirmation } from '../cli/confirm.js'
import { parseCommandArgv } from '../cli/verb_codec.js'
import { Attr, getLogger } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { effectiveRemotes } from '../remote/builtin_remotes.js'
import {
  clearFirstSyncHold,
  firstSyncHoldMarkerPath,
  formatFirstSyncDeadline,
  readFirstSyncDeadline,
} from '../usage-policy/first_sync_hold.js'
import { readClientSyncEntries, readLocalOnlyEntries } from '../usage-policy/index.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ExtendedSinkHandle, ExtendedSinkRegistry } from '../../../src/core/registry/types.js'
 */

const USAGE = 'usage: hyp sync [instance] [--yes] [--dry-run]'

/**
 * `hyp sync [instance] [--yes] [--dry-run]`
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
        yes: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
      positional: ['instance'],
    },
    { aliases: { '-y': '--yes' } }
  )
  if ('help' in parsed) {
    ctx.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!parsed.ok) {
    ctx.stderr.write(`hyp sync: ${parsed.error}\n${USAGE}\n`)
    return 2
  }
  const { instance, yes, 'dry-run': dryRun } =
    /** @type {{ instance?: string, yes: boolean, 'dry-run': boolean }} */ (parsed.params)

  const allHandles = /** @type {ExtendedSinkRegistry} */ (ctx.sinks).listHandles?.() ?? []
  const handles = instance ? allHandles.filter((h) => h.instanceName === instance) : allHandles
  if (instance && handles.length === 0) {
    ctx.stderr.write(`hyp sync: no sink named '${instance}' was instantiated\n`)
    const available = allHandles.map((h) => h.instanceName)
    if (available.length > 0) ctx.stderr.write(`  available: ${available.join(', ')}\n`)
    return 1
  }
  if (handles.length === 0) {
    ctx.stdout.write('no sinks instantiated; nothing to do\n')
    return 0
  }

  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const deadline = await readFirstSyncDeadline({ stateDir })
  const remotes = effectiveRemotes(ctx.config)
  const destinations = handles.map((handle) => describeDestination(handle, remotes))

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

  ctx.stdout.write(renderPlan({ destinations, exclusions: await readExclusions(stateDir) }))
  if (deadline !== null) ctx.stdout.write(renderFirstSyncWarning(deadline))

  if (dryRun) {
    ctx.stdout.write('\n[dry-run] nothing was sent\n')
    return 0
  }

  const outcome = await requireConfirmation({
    ctx,
    yes,
    question: deadline !== null
      ? 'Send now and end the review window? [y/N] '
      : `Send now to ${describeScope(destinations)}? [y/N] `,
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
  const report = await driver.tick(tickOpts)

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
    // The per-client opt-out store (LLP 0181 #never-silent): clients kept
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
 * The pre-confirmation summary: every destination, named, with the
 * exclusions that will not travel. "Are you sure?" with nothing to be sure
 * *about* is a keystroke, not a decision.
 *
 * @param {{
 *   destinations: { instance: string, text: string, offMachine: boolean | null }[],
 *   exclusions: { localOnly: number, ignore: number, clientLocalOnly?: string[] } | { error: string },
 * }} args
 * @returns {string}
 */
function renderPlan({ destinations, exclusions }) {
  const width = Math.max(...destinations.map((d) => d.instance.length))
  const lines = [`hyp sync: ${plural(destinations.length, 'destination')}\n`, '\n']
  for (const dest of destinations) {
    const note = dest.offMachine === true
      ? '  (leaves this machine)'
      : dest.offMachine === false
        ? '  (stays on this machine)'
        : ''
    lines.push(`  ${dest.instance.padEnd(width)}  ${dest.text}${note}\n`)
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
    '    hyp policy set <path> local-only\n'
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
  return `${n} ${n === 1 ? singular : pluralForm}`
}

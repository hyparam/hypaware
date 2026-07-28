// @ts-check

import { requireConfirmation } from '../cli/confirm.js'
import { parseCommandArgv } from '../cli/verb_codec.js'
import { readObservabilityEnv } from '../observability/env.js'
import {
  clearFirstSyncHold,
  formatFirstSyncDeadline,
  readFirstSyncDeadline,
} from '../usage-policy/first_sync_hold.js'
import { readLocalOnlyEntries } from '../usage-policy/index.js'

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
  const destinations = handles.map((handle) => describeDestination(handle))

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
  if (deadline !== null) await clearFirstSyncHold({ stateDir })

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
 * @param {ExtendedSinkHandle} handle
 * @returns {{ instance: string, text: string, offMachine: boolean | null }}
 */
function describeDestination(handle) {
  const config = /** @type {Record<string, unknown>} */ (handle.config ?? {})
  const url = config.url
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    return { instance: handle.instanceName, text: url, offMachine: true }
  }
  const dir = config.dir
  if (typeof dir === 'string' && dir.length > 0) {
    return { instance: handle.instanceName, text: dir, offMachine: false }
  }
  return { instance: handle.instanceName, text: handle.plugin ?? 'unknown destination', offMachine: null }
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
 * @returns {Promise<{ localOnly: number, ignore: number } | { error: string }>}
 */
async function readExclusions(stateDir) {
  try {
    const entries = await readLocalOnlyEntries({ stateDir })
    return {
      localOnly: entries.filter((e) => e.class === 'local-only').length,
      ignore: entries.filter((e) => e.class === 'ignore').length,
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
 *   exclusions: { localOnly: number, ignore: number } | { error: string },
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
  lines.push('\n')
  if ('error' in exclusions) {
    lines.push(`  warning: could not read the local-only list (${exclusions.error});\n`)
    lines.push('  exclusions still apply, but cannot be summarized here\n')
  } else if (exclusions.localOnly > 0 || exclusions.ignore > 0) {
    const parts = []
    if (exclusions.localOnly > 0) parts.push(`${plural(exclusions.localOnly, 'directory', 'directories')} marked local-only`)
    if (exclusions.ignore > 0) parts.push(`${plural(exclusions.ignore, 'directory', 'directories')} marked ignore`)
    lines.push(`  withholding ${parts.join(', ')}\n`)
  } else {
    lines.push('  no directories are marked local-only or ignore\n')
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

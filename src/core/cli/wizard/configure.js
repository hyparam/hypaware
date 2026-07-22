// @ts-check

/**
 * @import { PickerDescriptor } from '../../../../src/core/types.js'
 * @import { ConfigurePhaseEntryResult, ConfigurePhasePicked, ConfigurePhaseResult, RunConfigurePhaseOptions } from '../../../../src/core/cli/wizard/types.js'
 */

import { Attr, getLogger, withSpan } from '../../observability/index.js'

/**
 * The wizard's configure phase (LLP 0135 #configure). Runs the picked
 * `needs_setup` descriptors' `configure_command`s one at a time, in
 * process, through the `ctx.commands.run` seam (LLP 0130
 * #configure-command), narrating each and applying the drop-on-failure
 * rule.
 *
 * A failed (non-zero exit) or thrown configure drops that source from
 * this run with a printed catch-up hint naming the standalone command,
 * and the phase continues with the rest: the user always walks away with
 * a working, possibly narrower, install (LLP 0131).
 *
 * `--print-commands` is threaded onto the invoked command's own argv
 * (`printCommandsFlag`), so the standalone command's existing no-sudo
 * escape hatch prints the privileged commands instead of running them;
 * the wizard adds no second implementation.
 *
 * The phase is attended-only: the non-interactive callers (`--yes`,
 * `--dry-run`, presets, `--from-file`) set `opts.picks`, and this phase
 * runs nothing on that path.
 *
 * @ref LLP 0131#drop-on-failure [implements]: a failed or thrown
 *   configure drops that source with a printed catch-up command hint;
 *   the wizard continues with the rest.
 * @ref LLP 0131#attended-only [constrained-by]: never runs off
 *   `opts.picks` (non-interactive) paths.
 *
 * @param {ConfigurePhasePicked} picked
 * @param {RunConfigurePhaseOptions} opts
 * @returns {Promise<ConfigurePhaseResult>}
 */
export async function runConfigurePhase(picked, opts) {
  const log = getLogger('wizard')

  // Attended-only: unattended fleets are MDM's lane, not the wizard's.
  // The non-interactive callers carry `opts.picks`; they never reach a
  // configure command.
  if (opts.picks !== undefined && opts.picks !== null) {
    return { results: [] }
  }

  const descriptors = (picked?.descriptors ?? []).filter(
    (d) => !!d && d.needsSetup === true && typeof d.configureCommand === 'string' && d.configureCommand.length > 0
  )

  /** @type {ConfigurePhaseEntryResult[]} */
  const results = []
  for (const d of descriptors) {
    opts.stdout.write(`\nSetting up ${d.label}...\n`)
    const entry = await withSpan(
      'wizard.configure',
      {
        [Attr.COMPONENT]: 'wizard',
        [Attr.OPERATION]: 'wizard.configure',
        descriptor_id: d.id,
        status: 'ok',
      },
      (span) => runOneConfigure(d, opts, span),
      { component: 'wizard' }
    )
    results.push(entry)
    log.info('wizard.configure', {
      [Attr.COMPONENT]: 'wizard',
      descriptor_id: d.id,
      status: entry.ok ? 'ok' : 'dropped',
    })
  }
  return { results }
}

/**
 * Run one descriptor's `configure_command` through the seam and map its
 * outcome to an entry result, dropping the source (with a catch-up hint)
 * on a non-zero exit or a throw. Never rethrows: a single drop must not
 * abort the phase.
 *
 * @param {PickerDescriptor} d
 * @param {RunConfigurePhaseOptions} opts
 * @param {{ setAttribute?: (key: string, value: unknown) => void }} [span]
 * @returns {Promise<ConfigurePhaseEntryResult>}
 */
async function runOneConfigure(d, opts, span) {
  const name = /** @type {string} */ (d.configureCommand)
  try {
    const exitCode = await opts.ctx.commands.run(name, printCommandsFlag(opts))
    if (exitCode === 0) {
      setSpanAttr(span, 'status', 'ok')
      return { id: d.id, ok: true, exitCode }
    }
    setSpanAttr(span, 'status', 'dropped')
    setSpanAttr(span, Attr.ERROR_KIND, 'configure_nonzero_exit')
    printCatchUpHint(opts, d)
    return { id: d.id, ok: false, exitCode }
  } catch (err) {
    setSpanAttr(span, 'status', 'dropped')
    setSpanAttr(span, Attr.ERROR_KIND, 'configure_threw')
    printCatchUpHint(opts, d)
    return { id: d.id, ok: false, error: String(err) }
  }
}

/**
 * The `--print-commands` passthrough. Returns the flag as the invoked
 * command's own argv when the wizard was run with it, so the standalone
 * command handles the no-sudo escape hatch itself (LLP 0131
 * #idempotent-rerun); otherwise an empty argv.
 *
 * @param {RunConfigurePhaseOptions} opts
 * @returns {string[]}
 */
function printCommandsFlag(opts) {
  return opts.printCommands ? ['--print-commands'] : []
}

/**
 * Print the catch-up hint for a dropped source: the standalone command
 * that finishes what this run skipped (LLP 0131 #drop-on-failure). The
 * command string doubles as both the wizard's in-process invocation and
 * the user-facing `hyp <configure_command>` they can re-run later.
 *
 * @param {RunConfigurePhaseOptions} opts
 * @param {PickerDescriptor} d
 */
function printCatchUpHint(opts, d) {
  opts.stdout.write(`Skipping ${d.label} for now. Finish later with \`hyp ${d.configureCommand}\`.\n`)
}

/**
 * @param {{ setAttribute?: (key: string, value: unknown) => void } | undefined} span
 * @param {string} key
 * @param {unknown} value
 */
function setSpanAttr(span, key, value) {
  if (span && typeof span.setAttribute === 'function') span.setAttribute(key, value)
}

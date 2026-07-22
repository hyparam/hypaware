// @ts-check

import fs from 'node:fs'

import { MANAGED_PLIST_PATH, computeDesiredPlistContent, plistUpToDate, residueDirPath } from './install.js'
import { resolveInputs } from './inputs.js'

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AnthropicCredentialCapability } from '../../claude-account/src/types.js'
 * @import { VerifyResult } from './types.js'
 */

/**
 * Compute the automatic half of the two-tier verify: whether the managed
 * plist is present and matches what `install` would render today, and
 * whether the dialog-residue directory has been cleared. Pure of I/O
 * side-effects besides the two reads, so `runVerify` and any future
 * caller (e.g. a status surface) share one source of truth for "is this
 * install actually in place".
 *
 * @param {{ sectionConfig: Record<string, unknown>, credential: AnthropicCredentialCapability, stateDir: string, managedPlistPath?: string }} opts
 * @param {CommandRunContext} cmdCtx
 * @returns {VerifyResult}
 */
export function checkInstallState(opts, cmdCtx) {
  const plistPath = opts.managedPlistPath ?? MANAGED_PLIST_PATH
  const inputs = resolveInputs(opts.sectionConfig, opts.credential, cmdCtx, opts.stateDir)
  const desired = computeDesiredPlistContent(inputs)
  const plistPresent = fs.existsSync(plistPath)
  const plistUpToDateResult = plistPresent && plistUpToDate(plistPath, desired)
  const residueCleared = !fs.existsSync(residueDirPath(cmdCtx.env))
  return {
    plistPresent,
    plistUpToDate: plistUpToDateResult,
    residueCleared,
    ok: plistPresent && plistUpToDateResult && residueCleared,
  }
}

/**
 * `hyp claude-desktop verify`: the two-tier verify.
 *
 * @ref LLP 0131#verify-is-a-hint [implements]: the automatic half (plist present and up to date, dialog residue cleared) drives the exit code; the in-app half (send a message, confirm capture) needs a human inside the app, so it is printed as a hint and never checked or blocked on here
 *
 * @param {string[]} argv
 * @param {CommandRunContext} cmdCtx
 * @param {{ sectionConfig: Record<string, unknown>, credential: AnthropicCredentialCapability, stateDir: string, managedPlistPath?: string }} opts
 * @returns {Promise<number>}
 */
export async function runVerify(argv, cmdCtx, opts) {
  /** @type {VerifyResult} */
  let result
  try {
    result = checkInstallState(opts, cmdCtx)
  } catch (err) {
    cmdCtx.stderr.write(`claude-desktop verify: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const plistPath = opts.managedPlistPath ?? MANAGED_PLIST_PATH
  cmdCtx.stdout.write(
    `managed plist: ${
      !result.plistPresent ? `MISSING (${plistPath})`
        : result.plistUpToDate ? 'present, up to date'
          : 'present, STALE (re-run "hyp claude-desktop install")'
    }\n`,
  )
  cmdCtx.stdout.write(
    `dialog residue: ${result.residueCleared ? 'clear' : 'PRESENT (re-run "hyp claude-desktop install" to back it up and clear it)'}\n`,
  )

  cmdCtx.stdout.write('\nin-app check (not verified automatically, LLP 0131#verify-is-a-hint):\n')
  cmdCtx.stdout.write('  1. Quit and reopen Claude Desktop so it picks up the managed profile.\n')
  cmdCtx.stdout.write('  2. Send it a message.\n')
  cmdCtx.stdout.write(
    "  3. Confirm capture: rows land under entrypoint 'claude-desktop-3p' in ai_gateway_messages "
    + "(check via 'hyp status' or 'hyp mcp').\n",
  )

  if (!result.ok) {
    cmdCtx.stdout.write('\nautomatic checks incomplete; run \'hyp claude-desktop install\' to finish\n')
    return 1
  }
  return 0
}

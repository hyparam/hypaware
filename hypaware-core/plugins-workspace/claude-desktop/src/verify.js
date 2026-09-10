// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { isNpxBinPath } from '../../../../src/core/cli/global_install.js'
import { MANAGED_PLIST_PATH, computeDesiredPlistContent, plistUpToDate, residueDirPath } from './install.js'
import { resolveInputs } from './inputs.js'
import { parseCredentialHelperScript } from './profile.js'

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AnthropicCredentialCapability } from '../../claude-account/src/types.js'
 * @import { HelperCheck, VerifyResult } from './types.js'
 */

/**
 * Bound on the wrapper read. What this plugin generates is five short lines,
 * but `claude_desktop.helper_path` can point the check at any file at all, so
 * the read is capped rather than trusted. A file that overruns the cap is not
 * judged at all (`readBakedPaths`), so the cap can cost a verdict but never
 * invent one.
 */
const HELPER_READ_LIMIT_BYTES = 4096

/**
 * Whether the credential wrapper the profile vouches for still works.
 *
 * The plist carries the wrapper's *path*, so a wrapper whose contents rotted
 * renders a byte-identical plist and `plistUpToDate` keeps saying yes, while
 * Desktop runs the wrapper with the app's environment and reads trimmed
 * stdout (LLP 0116#helper-contract). Without this read the only observer of a
 * rotted bake is Claude Desktop silently losing its credentials.
 *
 * The two baked paths rot on different schedules, so they get different
 * predicates. `hypBin` inside npm's `_npx` cache is stale whether or not it is
 * still on disk today, because the cache is npm-owned and prune-scheduled by
 * construction: the same reasoning as core's `markerRecordsEphemeralHookBin`
 * for the sibling Claude hook (#1607). No longer the same predicate, though,
 * and deliberately so: core widened to `isEphemeralBinPath` because a stale
 * verdict there is what lets `hyp client attach claude` stop short-circuiting
 * and rewrite the hook, and nothing else can reach that command. Here the
 * repair is `install-helper`, which regenerates the wrapper unconditionally
 * whatever this says, so the narrower test costs only an under-report: a
 * project-local `hypBin` reads healthy until the tree is actually deleted,
 * which the `missingBin` check below then catches. Either path simply gone is
 * stale on its own, which is the `nodeBin` case, since it is `process.execPath`
 * frozen at generation time and any routine node version switch moves it.
 *
 * `stale: false` is not a claim of health for a wrapper this plugin did not
 * write: an unreadable or unrecognised file is left alone, so the check never
 * cries wolf on a working machine.
 *
 * @param {string} helperPath
 * @param {NodeJS.ProcessEnv} env
 * @returns {HelperCheck}
 */
export function checkHelperScript(helperPath, env) {
  if (!fs.existsSync(helperPath)) return { present: false, stale: false }
  const baked = readBakedPaths(helperPath)
  if (baked === undefined) return { present: true, stale: false }

  // Absolute, or no claim: `isNpxBinPath` and `existsSync` both resolve what
  // they are handed against the cwd, so a relative token would make one
  // wrapper read healthy from one directory and rotted from another.
  if (path.isAbsolute(baked.hypBin) && isNpxBinPath(baked.hypBin, env)) {
    return {
      present: true,
      stale: true,
      // The generic re-run alone is not the repair here: re-running under the
      // same `npx` bakes the same cache path back in. Name the durable
      // install first, so the verdict is one an operator can clear.
      detail: `baked CLI path is in npm's _npx cache, which npm prunes on its own schedule (${baked.hypBin})`
        + "; install a durable CLI first with 'npm install -g hypaware'",
    }
  }
  const gone = missingBin('interpreter', baked.nodeBin)
    ?? missingBin('CLI', baked.hypBin)
    ?? lostExecuteBit(helperPath)
  return gone === undefined ? { present: true, stale: false } : { present: true, stale: true, detail: gone }
}

/**
 * The wrapper's baked paths, or `undefined` when the file cannot be read or is
 * not one this plugin generated.
 *
 * @param {string} helperPath
 * @returns {{ nodeBin: string, hypBin: string } | undefined}
 */
function readBakedPaths(helperPath) {
  let fd
  try {
    // Kind first, because `helper_path` is operator-supplied and `openSync`
    // on a fifo blocks until a writer shows up: `verify` and `status` have to
    // stay total, and a wrapper Desktop can exec is a regular file.
    if (!fs.statSync(helperPath).isFile()) return undefined
    fd = fs.openSync(helperPath, 'r')
    const buf = Buffer.allocUnsafe(HELPER_READ_LIMIT_BYTES)
    const read = fs.readSync(fd, buf, 0, HELPER_READ_LIMIT_BYTES, 0)
    // A read that filled the cap did not reach the end of the file, and the
    // renderer writes `exec` last: whatever the cap did reach is therefore not
    // the baked command, whether it cut a path in half or stopped inside a
    // quoted `HYP_HOME` whose value carries an `exec` line of its own. Either
    // way the parse would judge a line the shell never runs and report a live
    // wrapper STALE, so an overrun is no claim at all. It costs nothing real:
    // what this plugin generates is five short lines.
    if (read >= HELPER_READ_LIMIT_BYTES) return undefined
    return parseCredentialHelperScript(buf.toString('utf8', 0, read))
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * @param {string} role
 * @param {string} bin
 * @returns {string | undefined}
 */
function missingBin(role, bin) {
  if (!path.isAbsolute(bin) || fs.existsSync(bin)) return undefined
  return `baked ${role} path no longer exists (${bin})`
}

/**
 * Desktop runs `inferenceCredentialHelper` as a bare executable
 * (LLP 0116#helper-contract), so a wrapper that lost its execute bit fails the
 * same silent way a rotted path does: `install-helper` chmods 0755, and a
 * restore, a copy across filesystems, or a sync tool that drops the mode does
 * not. Asked only of a wrapper this plugin generated, because that is the one
 * whose repair really is the re-run the verdict names.
 *
 * @param {string} helperPath
 * @returns {string | undefined}
 */
function lostExecuteBit(helperPath) {
  try {
    fs.accessSync(helperPath, fs.constants.X_OK)
    return undefined
  } catch {
    return 'the wrapper is no longer executable, and Desktop runs it as a bare executable'
  }
}

/**
 * Compute the automatic half of the two-tier verify: whether the managed
 * plist is present and matches what `install` would render today, whether
 * the credential wrapper it names still works (`checkHelperScript`), and
 * whether the dialog-residue directory has been cleared. Pure of I/O
 * side-effects besides the reads, so `runVerify` and the `status` surface
 * share one source of truth for "is this install actually in place".
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
  const helper = checkHelperScript(inputs.helperPath, cmdCtx.env)
  return {
    plistPresent,
    plistUpToDate: plistUpToDateResult,
    residueCleared,
    helper,
    helperPath: inputs.helperPath,
    ok: plistPresent && plistUpToDateResult && residueCleared && helper.present && !helper.stale,
  }
}

/**
 * One rendering of the wrapper verdict for both surfaces that report it, so
 * `verify` and `status` cannot come to different conclusions about the same
 * file the way they did while only one of them read it at all.
 *
 * @param {HelperCheck} helper
 * @param {string} helperPath
 * @returns {string}
 */
export function renderHelperLine(helper, helperPath) {
  if (!helper.present) return `${helperPath} (NOT installed - run 'hyp client claude-desktop install')`
  if (helper.stale) {
    return `${helperPath} (installed but STALE: ${helper.detail} - re-run 'hyp client claude-desktop install')`
  }
  return `${helperPath} (installed)`
}

/**
 * `hyp claude-desktop verify`: the two-tier verify.
 *
 * @ref LLP 0131#verify-is-a-hint [implements]: the automatic half (plist present and up to date, credential wrapper live, dialog residue cleared) drives the exit code; the in-app half (send a message, confirm capture) needs a human inside the app, so it is printed as a hint and never checked or blocked on here
 *
 * @param {string[]} argv
 * @param {CommandRunContext} cmdCtx
 * @param {{ sectionConfig: Record<string, unknown>, credential: AnthropicCredentialCapability, stateDir: string, managedPlistPath?: string, platform?: string }} opts
 * @returns {Promise<number>}
 */
export async function runVerify(argv, cmdCtx, opts) {
  // The plist and residue checks answer for macOS paths that mean nothing
  // elsewhere, so off-platform verify refuses like install rather than
  // reporting a misleading MISSING.
  // @ref LLP 0139#macos-only [implements]: verify shares install's platform refusal
  const platform = opts.platform ?? process.platform
  if (platform !== 'darwin') {
    cmdCtx.stderr.write(`claude-desktop verify: refused: unsupported platform '${platform}' (only darwin is supported)\n`)
    return 1
  }

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
          : 'present, STALE (re-run "hyp client claude-desktop install")'
    }\n`,
  )
  cmdCtx.stdout.write(`credential wrapper: ${renderHelperLine(result.helper, result.helperPath)}\n`)
  cmdCtx.stdout.write(
    `dialog residue: ${result.residueCleared ? 'clear' : 'PRESENT (re-run "hyp client claude-desktop install" to back it up and clear it)'}\n`,
  )

  cmdCtx.stdout.write('\nin-app check (not verified automatically, LLP 0131#verify-is-a-hint):\n')
  cmdCtx.stdout.write('  1. Quit and reopen Claude Desktop so it picks up the managed profile.\n')
  cmdCtx.stdout.write('  2. Send it a message.\n')
  // 'local-agent' is what Desktop's 3p mode writes on the current build;
  // 'claude-desktop-3p' was observed on an earlier one (LLP 0133#attribution).
  // Pointing at `hyp status` was aspirational until the gateway started
  // tracking last-seen entrypoints: the command activates no plugins and
  // reads no cache, so it had no way to see a row. It does now.
  // @ref LLP 0164#status-reads-it-from-the-status-file [implements]: "confirm capture via hyp status" is a check a human can actually run
  cmdCtx.stdout.write(
    "  3. Confirm capture: run 'hyp status' and look for entrypoint 'local-agent' "
    + "(older builds: 'claude-desktop-3p') under 'recent clients'. The rows themselves "
    + "are in ai_gateway_messages (query via 'hyp query' or 'hyp mcp serve').\n",
  )

  if (!result.ok) {
    cmdCtx.stdout.write('\nautomatic checks incomplete; run \'hyp client claude-desktop install\' to finish\n')
    return 1
  }
  return 0
}

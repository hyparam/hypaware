// @ts-check

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveInputs } from './inputs.js'
import { buildManagedProfile, renderManagedPreferencesPlist, shellQuote } from './profile.js'

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AnthropicCredentialCapability } from '../../claude-account/src/types.js'
 * @import { InstallStepOutcome, ProfileInputs } from './types.js'
 */

/**
 * The one local placement surface for solo and fleet (LLP 0133#one-surface).
 * A fleet MDM push targets the same path; this module owns only the
 * solo inline-sudo write.
 */
export const MANAGED_PLIST_PATH = '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist'

/**
 * The Claude Desktop app's own third-party-settings dialog persists its
 * config here, per machine, keyed by the app's `Claude-3p` profile
 * directory (LLP 0133#dialog-residue, correcting LLP 0115's "not persisted
 * to disk at all" finding). Undocumented by the app; this is the directory
 * the live-test finding identified as shadowing the managed plist.
 *
 * @ref LLP 0133#dialog-residue [implements]: a pre-existing Claude-3p config silently shadows a correct managed plist, so every install backs it up and clears it unconditionally
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function residueDirPath(env) {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : os.homedir()
  return path.join(home, 'Library', 'Application Support', 'Claude', 'Claude-3p')
}

/**
 * Build the plist bytes `install`/`verify` compare the on-disk file
 * against. Shared by both so "up to date" means exactly one thing.
 *
 * @param {ProfileInputs} inputs
 * @returns {string}
 */
export function computeDesiredPlistContent(inputs) {
  return renderManagedPreferencesPlist(buildManagedProfile(inputs))
}

/**
 * @param {string} plistPath
 * @param {string} desired
 * @returns {boolean}
 */
export function plistUpToDate(plistPath, desired) {
  try {
    return fs.readFileSync(plistPath, 'utf8') === desired
  } catch {
    return false
  }
}

/**
 * The privileged command sequence `--print-commands` prints and the
 * non-print path executes verbatim via `spawnSync`, one seam for both so
 * they can never drift apart.
 *
 * @param {string} tmpPath
 * @param {string} plistPath
 * @returns {Array<{ cmd: string, args: string[] }>}
 */
export function buildPlistWriteCommands(tmpPath, plistPath) {
  return [
    { cmd: 'sudo', args: ['mkdir', '-p', path.dirname(plistPath)] },
    { cmd: 'sudo', args: ['cp', tmpPath, plistPath] },
    { cmd: 'sudo', args: ['chmod', '644', plistPath] },
  ]
}

/**
 * @param {{ cmd: string, args: string[] }} command
 * @returns {string}
 */
function formatCommand(command) {
  return [command.cmd, ...command.args].map(shellQuote).join(' ')
}

/**
 * `hyp claude-desktop install`: the shared solo/fleet placement command
 * (`@ref LLP 0133#one-surface`). Runs the same five-step sequence whether
 * invoked standalone or as the wizard's `configure_command` (LLP 0131),
 * re-checking each step's own already-done state first so a bailed sudo
 * prompt converges on re-run without repeating completed work
 * (`@ref LLP 0131#idempotent-rerun`).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} cmdCtx
 * @param {{ sectionConfig: Record<string, unknown>, credential: AnthropicCredentialCapability, stateDir: string, spawnSyncImpl?: typeof spawnSync, managedPlistPath?: string }} opts
 * @returns {Promise<number>}
 */
export async function runInstall(argv, cmdCtx, opts) {
  const printCommands = argv.includes('--print-commands')
  const spawnImpl = opts.spawnSyncImpl ?? spawnSync
  const plistPath = opts.managedPlistPath ?? MANAGED_PLIST_PATH

  // Refused up front (@ref LLP 0133#consequences): an ephemeral gateway
  // listen can never back a stable managed profile, so there is no point
  // running the login/helper/residue steps only to refuse at the plist
  // write. resolveInputs throws exactly this check.
  /** @type {ProfileInputs} */
  let inputs
  try {
    inputs = resolveInputs(opts.sectionConfig, opts.credential, cmdCtx, opts.stateDir)
  } catch (err) {
    cmdCtx.stderr.write(`claude-desktop install: refused: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  /** @type {InstallStepOutcome[]} */
  const steps = []

  steps.push(await ensureCredentialLogin(cmdCtx, opts.credential))
  steps.push(await ensureHelperWritten(cmdCtx))
  steps.push(clearResidue(cmdCtx.env, opts.stateDir))
  steps.push(ensurePlistWritten(cmdCtx, inputs, { printCommands, spawnImpl, plistPath }))
  steps.push(promptRestart(cmdCtx, { printCommands, spawnImpl }))

  for (const step of steps) {
    const marker = step.status === 'done' ? '✓' : step.status === 'skipped' ? '-' : '✗'
    cmdCtx.stdout.write(`  ${marker} ${step.step}${step.detail ? `: ${step.detail}` : ''}\n`)
  }

  const failed = steps.filter((s) => s.status === 'failed')
  if (failed.length > 0) {
    cmdCtx.stdout.write(
      `claude-desktop install: incomplete (${failed.map((s) => s.step).join(', ')}); `
      + "re-run 'hyp claude-desktop install' to finish, or use --print-commands\n",
    )
    return 1
  }
  cmdCtx.stdout.write("claude-desktop install: done. Run 'hyp claude-desktop verify' after Desktop restarts.\n")
  return 0
}

/**
 * Step 1: credential login chain (LLP 0117). `org_key` mode is fleet-
 * provided and needs no sign-in. Subscription mode re-checks sign-in
 * state through `claude-account status` before ever running `login`, so
 * a re-run never re-triggers the browser OAuth flow once signed in.
 *
 * @param {CommandRunContext} cmdCtx
 * @param {AnthropicCredentialCapability} credential
 * @returns {Promise<InstallStepOutcome>}
 */
async function ensureCredentialLogin(cmdCtx, credential) {
  const step = 'credential login'
  if (credential.mode === 'org_key') {
    return { step, status: 'skipped', detail: 'org_key mode: fleet-provided key, no sign-in needed' }
  }
  const statusCode = await cmdCtx.commands.run('claude-account status', [])
  if (statusCode === 0) {
    return { step, status: 'skipped', detail: 'already signed in' }
  }
  if (!cmdCtx.stdin) {
    return {
      step,
      status: 'failed',
      detail: "needs an interactive terminal; run 'hyp claude-account login' yourself, then re-run",
    }
  }
  const loginCode = await cmdCtx.commands.run('claude-account login', [])
  if (loginCode !== 0) {
    return { step, status: 'failed', detail: "sign-in did not complete; re-run 'hyp claude-desktop install' to retry" }
  }
  return { step, status: 'done' }
}

/**
 * Step 2: helper write (LLP 0116). Delegates to the already-registered,
 * already-idempotent `claude-desktop install-helper` command rather than
 * re-implementing the write, so there is exactly one place that renders
 * the wrapper script.
 *
 * @param {CommandRunContext} cmdCtx
 * @returns {Promise<InstallStepOutcome>}
 */
async function ensureHelperWritten(cmdCtx) {
  const step = 'credential helper'
  const code = await cmdCtx.commands.run('claude-desktop install-helper', [])
  if (code !== 0) {
    return { step, status: 'failed', detail: 'failed to write the credential helper wrapper' }
  }
  return { step, status: 'done' }
}

/**
 * Step 3: residue check. Runs unconditionally on every install, solo and
 * fleet (`@ref LLP 0133#dialog-residue`): a silent shadowed plist is a
 * per-machine no-op at fleet scale. Backs the directory up under the
 * plugin state dir (never re-writing into a TCC-protected location) before
 * removing it, so re-running when nothing is there is a plain skip.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} stateDir
 * @returns {InstallStepOutcome}
 */
function clearResidue(env, stateDir) {
  const step = 'dialog residue'
  const residueDir = residueDirPath(env)
  if (!fs.existsSync(residueDir)) {
    return { step, status: 'skipped', detail: 'no Claude-3p dialog residue found' }
  }
  const backupDir = path.join(stateDir, 'claude-desktop-3p-residue-backups', `backup-${Date.now()}`)
  try {
    fs.mkdirSync(path.dirname(backupDir), { recursive: true })
    fs.cpSync(residueDir, backupDir, { recursive: true })
    fs.rmSync(residueDir, { recursive: true, force: true })
  } catch (err) {
    return {
      step,
      status: 'failed',
      detail: `could not back up and clear ${residueDir}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return { step, status: 'done', detail: `backed up to ${backupDir} and cleared` }
}

/**
 * Step 4: managed-preferences plist write via an inline sudo prompt
 * (`@ref LLP 0133#solo-sudo`). Re-checks the file's current content
 * first, so a plist that already matches never re-prompts for sudo.
 * `--print-commands` renders the same command sequence the real path
 * runs, without invoking any of it (the no-sudo escape hatch,
 * `@ref LLP 0133#solo-sudo`).
 *
 * @param {CommandRunContext} cmdCtx
 * @param {ProfileInputs} inputs
 * @param {{ printCommands: boolean, spawnImpl: typeof spawnSync, plistPath: string }} opts
 * @returns {InstallStepOutcome}
 */
function ensurePlistWritten(cmdCtx, inputs, opts) {
  const step = 'managed plist'
  const desired = computeDesiredPlistContent(inputs)
  if (plistUpToDate(opts.plistPath, desired)) {
    return { step, status: 'skipped', detail: `${opts.plistPath} already up to date` }
  }

  const tmpPath = path.join(os.tmpdir(), `claude-desktop-managed-${process.pid}-${Date.now()}.plist`)
  fs.writeFileSync(tmpPath, desired)
  const commands = buildPlistWriteCommands(tmpPath, opts.plistPath)

  if (opts.printCommands) {
    for (const command of commands) cmdCtx.stdout.write(`${formatCommand(command)}\n`)
    return { step, status: 'skipped', detail: 'printed the privileged commands only (--print-commands)' }
  }

  cmdCtx.stdout.write('writing the managed profile needs sudo; you may be prompted for your password\n')
  for (const command of commands) {
    const result = opts.spawnImpl(command.cmd, command.args, { stdio: 'inherit' })
    if (result.status !== 0) {
      return {
        step,
        status: 'failed',
        detail: `'${formatCommand(command)}' did not succeed; re-run 'hyp claude-desktop install' to retry, or use --print-commands`,
      }
    }
  }
  try { fs.unlinkSync(tmpPath) } catch { /* best-effort cleanup */ }
  return { step, status: 'done', detail: opts.plistPath }
}

/**
 * Step 5: desktop restart prompt. `killall cfprefsd` flushes the macOS
 * preferences cache so the app picks up the new plist without a full
 * reboot; a full app quit-and-reopen is still needed and is printed as a
 * hint, never assumed. Never fails the install: a machine with no
 * `cfprefsd` running (or no `killall`) is not a broken install, just an
 * app that will pick up the plist on its own next relaunch.
 *
 * @param {CommandRunContext} cmdCtx
 * @param {{ printCommands: boolean, spawnImpl: typeof spawnSync }} opts
 * @returns {InstallStepOutcome}
 */
function promptRestart(cmdCtx, opts) {
  const step = 'desktop restart'
  const command = { cmd: 'killall', args: ['cfprefsd'] }
  if (opts.printCommands) {
    cmdCtx.stdout.write(`${formatCommand(command)}\n`)
    return { step, status: 'skipped', detail: 'printed only (--print-commands); quit and reopen Claude Desktop yourself' }
  }
  opts.spawnImpl(command.cmd, command.args, { stdio: 'ignore' })
  cmdCtx.stdout.write('Quit and reopen Claude Desktop to pick up the new configuration.\n')
  return { step, status: 'done', detail: 'ran killall cfprefsd; relaunch Claude Desktop by hand' }
}

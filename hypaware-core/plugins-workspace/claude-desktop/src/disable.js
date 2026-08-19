// @ts-check

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

/** @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js' */

/**
 * The managed-preferences file older HypAware releases wrote to put Claude
 * Desktop into third-party-inference mode. Inlined here rather than imported
 * from the deleted installer: this path is now recovery knowledge, and the
 * manifest's `contributes.client.retired.residue_path` must agree with it so
 * `hyp status` can report the residue without booting this plugin.
 *
 * @ref LLP 0296#status-surface [implements]: the residue path is declared once here and mirrored in the manifest
 */
export const MANAGED_PLIST_PATH = '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist'

/**
 * Quote a single argv token for display or `/bin/sh -c` use.
 *
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Remove the managed profile written by the retired gateway capture path.
 * This is deliberately attended: the file is root-owned, and a daemon must
 * never raise an unexpected sudo prompt during boot.
 *
 * @ref LLP 0296#existing-installs [implements]: recovery removes only the exact managed plist and leaves unrelated Claude state untouched
 * The spawn seam declares only what this module calls, not `typeof
 * spawnSync`. The real function carries five overloads keyed on its options
 * shape, so naming it here makes every test double satisfy all five to be
 * assignable, which is friction for a seam that only ever runs
 * `(cmd, args, { stdio })` and only ever reads `status`.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} cmdCtx
 * @param {{
 *   managedPlistPath?: string,
 *   platform?: string,
 *   spawnSyncImpl?: (
 *     command: string,
 *     args: readonly string[],
 *     options: { stdio: 'inherit' | 'ignore' }
 *   ) => { status: number | null },
 * }} [opts]
 * @returns {Promise<number>}
 */
export async function runDisable(argv, cmdCtx, opts = {}) {
  const printCommands = argv.includes('--print-commands')
  const unknown = argv.filter((arg) => arg !== '--print-commands')
  if (unknown.length > 0) {
    cmdCtx.stderr.write(`claude-desktop disable: unknown argument '${unknown[0]}'\n`)
    return 1
  }

  const platform = opts.platform ?? process.platform
  if (!printCommands && platform !== 'darwin') {
    cmdCtx.stderr.write(`claude-desktop disable: refused: unsupported platform '${platform}' (only darwin is supported)\n`)
    return 1
  }

  const plistPath = opts.managedPlistPath ?? MANAGED_PLIST_PATH
  const removeCommand = { cmd: 'sudo', args: ['rm', '-f', plistPath] }
  if (printCommands) {
    cmdCtx.stdout.write(`${formatCommand(removeCommand)}\n`)
    cmdCtx.stdout.write('killall cfprefsd\n')
    return 0
  }

  if (!fs.existsSync(plistPath)) {
    cmdCtx.stdout.write(`claude-desktop disable: already disabled; no managed plist at ${plistPath}\n`)
    return 0
  }

  cmdCtx.stdout.write(`Removing ${plistPath} needs sudo; you may be prompted for your password.\n`)
  const spawnImpl = opts.spawnSyncImpl ?? spawnSync
  const removed = spawnImpl(removeCommand.cmd, removeCommand.args, { stdio: 'inherit' })
  if (removed.status !== 0) {
    cmdCtx.stderr.write(`claude-desktop disable: '${formatCommand(removeCommand)}' did not succeed\n`)
    return 1
  }
  if (fs.existsSync(plistPath)) {
    cmdCtx.stderr.write(`claude-desktop disable: ${plistPath} is still present\n`)
    return 1
  }

  spawnImpl('killall', ['cfprefsd'], { stdio: 'ignore' })
  cmdCtx.stdout.write('Claude Desktop gateway capture is disabled. Quit and reopen Claude Desktop to restore its normal account context.\n')
  return 0
}

/** @param {{ cmd: string, args: string[] }} command */
function formatCommand(command) {
  return [command.cmd, ...command.args].map(shellQuote).join(' ')
}

// @ts-check

import { runDisable } from './disable.js'

/** @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js' */

export const PLUGIN_NAME = '@hypaware/claude-desktop'

export { MANAGED_PLIST_PATH } from './disable.js'

/**
 * Claude Desktop gateway capture is removed, not flagged off: the picker
 * row, the installer, the consent gate, the helper writer and the verifier
 * are deleted. What is left is an attribution stub plus one recovery
 * command, and neither can enable capture.
 *
 * The plugin still exists only because deleting it would be worse. Its
 * manifest's `transcript_entrypoints` is what keeps the `@hypaware/claude`
 * backfill from importing Desktop sessions out of `~/.claude/projects` and
 * filing them under `claude`: `classifyTranscriptEntrypoint` fails OPEN on
 * an entrypoint no installed plugin claims.
 *
 * `disable` is registered `hidden` so it is absent from `hyp help` and
 * `hyp help client`. On a machine that never ran the old route Claude
 * Desktop does not exist; `hyp status` surfaces the command only when the
 * managed plist is actually on disk.
 *
 * @ref LLP 0296#kill-switch [implements]: nothing here registers a picker row, a gateway, a credential, or a visible command
 * @ref LLP 0296#attribution-stub [constrained-by]: the plugin survives to keep the transcript-entrypoint gate closed, not to capture
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.commands.register({
    name: 'client claude-desktop disable',
    aliases: ['claude-desktop disable'],
    plugin: PLUGIN_NAME,
    category: 'capture-movement',
    audience: 'everyday',
    hidden: true,
    summary: "Remove the old managed plist and restore Claude Desktop's normal account context",
    usage: 'hyp client claude-desktop disable [--print-commands]',
    help: 'Removes only the root-owned Claude Desktop managed-preferences plist written by older HypAware releases, flushes the macOS preferences cache, and asks you to restart the app. --print-commands changes nothing.',
    run: async (argv, cmdCtx) => runDisable(argv, cmdCtx),
  })
}

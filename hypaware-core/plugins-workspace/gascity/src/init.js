// @ts-check

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * `hyp init gascity`
 *
 * Prints the preset config payload that enables the gascity plugin
 * so callers can pipe it into a fresh config; it does not write to
 * disk itself. Since nothing is written, `--force` and `--dry-run` would
 * claim work this preset never does, so they refuse rather than pass
 * silently, and so does a positional argument it never reads (#2468).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function gascityInitPreset(argv, ctx) {
  const writerFlag = argv.find((t) => /^--(force|dry-run)(=|$)/.test(t))
  if (writerFlag !== undefined) {
    ctx.stderr.write(`hyp setup: ${writerFlag.split('=')[0]} is not supported with preset 'gascity'; it only prints a config and writes nothing\n`)
    return 2
  }
  const extra = argv.find((t) => !t.startsWith('-'))
  if (extra !== undefined) {
    ctx.stderr.write(`hyp setup: unexpected argument '${extra}' after preset 'gascity'\n`)
    return 2
  }
  const preset = {
    version: 2,
    plugins: [
      { name: '@hypaware/gascity', config: { cities: [] } },
    ],
  }
  ctx.stdout.write(JSON.stringify(preset, null, 2) + '\n')
  return 0
}

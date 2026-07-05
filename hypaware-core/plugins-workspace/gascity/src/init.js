// @ts-check

/**
 * @import { CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * `hyp init gascity`
 *
 * Prints the preset config payload that enables the gascity plugin
 * so callers can pipe it into a fresh config; it does not write to
 * disk itself.
 *
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function gascityInitPreset(_argv, ctx) {
  const preset = {
    version: 2,
    plugins: [
      { name: '@hypaware/gascity', config: { cities: [] } },
    ],
  }
  ctx.stdout.write(JSON.stringify(preset, null, 2) + '\n')
  return 0
}

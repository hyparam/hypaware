// @ts-check

/**
 * @import { CommandRunContext } from '../../../../collectivus-plugin-kernel-types'
 */

/**
 * `hyp init gascity`
 *
 * Drives a tmp config that enables the gascity plugin. The Phase 9
 * walkthrough will own the disk-write behavior; here we print the
 * preset payload so callers can pipe it into a fresh config.
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

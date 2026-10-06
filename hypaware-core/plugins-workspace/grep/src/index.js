// @ts-check

import { queryGrepVerb } from './grep_verb.js'

/**
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * @param {PluginActivationContext} ctx
 * @ref LLP 0413#plugin [implements]: grep is an ordinary plugin, never a core tool claimed on every host
 */
export async function activate(ctx) {
  ctx.verbs.register(queryGrepVerb)
}

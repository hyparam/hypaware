// @ts-check

import { SOURCE_NAME, createReplicaSource } from './replica_source.js'

/**
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/fastask'

/**
 * Activate `@hypaware/fastask`. Registers only the `team-graph-replica`
 * source, which keeps the team graph replica and its warm index in the
 * daemon. The plugin stays out of default activation, so this runs only for
 * an explicit `plugins[]` entry; commands, telemetry names and skill text
 * arrive with the enabling task.
 *
 * @ref LLP 0480#enablement [implements]: no commands before enablement; the source runs only behind an explicit plugins[] entry
 * @param {PluginActivationContext} ctx
 */
export function activate(ctx) {
  ctx.sources.register({
    name: SOURCE_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Team graph replica sync and warm index',
    start: createReplicaSource(),
  })
}

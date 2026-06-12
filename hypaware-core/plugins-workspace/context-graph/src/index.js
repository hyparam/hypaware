// @ts-check

import { runGraphCompact, runGraphProject } from './command.js'
import {
  EDGE_DATASET,
  graphDatasetRegistration,
  NODE_DATASET,
  PLUGIN_NAME,
} from './datasets.js'

/**
 * @import { PluginActivationContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Activate `@hypaware/context-graph`.
 *
 * Registers:
 *  - dataset `node` and dataset `edge` — derived graph tables, fronted by
 *    the kernel-managed Iceberg cache (populated by the projection command,
 *    not by a live source)
 *  - command `graph project` — runs the T0 deterministic projection over
 *    `ai_gateway_messages`
 *  - command `graph compact` — merges duplicate node/edge rows and
 *    rewrites affected partitions into sorted tables
 *
 * Registration only; the projection runs on demand via the command (no
 * snapshot/commit hook exists, and eventual freshness is acceptable —
 * see the design notes).
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.query.registerDataset(graphDatasetRegistration(NODE_DATASET))
  ctx.query.registerDataset(graphDatasetRegistration(EDGE_DATASET))

  ctx.commands.register({
    name: 'graph project',
    plugin: PLUGIN_NAME,
    summary: 'Project ai_gateway_messages into the node/edge activity graph',
    usage: 'hyp graph project [--dry-run]',
    run: runGraphProject,
  })

  ctx.commands.register({
    name: 'graph compact',
    plugin: PLUGIN_NAME,
    summary: 'Merge duplicate graph rows and rewrite affected partitions sorted',
    usage: 'hyp graph compact [--dry-run]',
    run: runGraphCompact,
  })
}

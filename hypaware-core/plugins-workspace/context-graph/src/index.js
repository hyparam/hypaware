// @ts-check

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runGraphCompact, runGraphProject } from './command.js'
import { graphNeighborsVerb } from './verb.js'
import { makeRowBuilders, nodeId, edgeId } from './contract-kit.js'
import { createContractRegistry } from './contract-registry.js'
import {
  EDGE_DATASET,
  graphDatasetRegistration,
  NODE_DATASET,
  PLUGIN_NAME,
} from './datasets.js'
import { setGraphRuntime } from './runtime.js'

/**
 * @import { PluginActivationContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ContextGraphCapability } from './types.d.ts'
 */

/** The capability version source plugins / connectors require to contribute a contract. */
const CAPABILITY_VERSION = '1.0.0'

/**
 * Activate `@hypaware/context-graph`.
 *
 * Registers:
 *  - capability `hypaware.context-graph@1.0.0` - source plugins (or a
 *    connector like `@hypaware/ai-gateway-graph`) call `registerContract` to
 *    contribute a projection contract, and build its rows with the shared
 *    `kit` (id recipe + provenance). The engine runs every registered contract.
 *  - dataset `node` and dataset `edge` - derived graph tables, fronted by
 *    the kernel-managed Iceberg cache (populated by the projection command,
 *    not by a live source)
 *  - command `graph project` - runs the T0 deterministic projection over
 *    every registered source contract
 *  - command `graph compact` - merges duplicate node/edge rows and
 *    rewrites affected partitions into sorted tables
 *  - command `graph neighbors` - walks the activity graph from a seed node out
 *    to N hops, reading the published node/edge datasets ([LLP 0026])
 *  - skill `hypaware-graph` - teaches AI clients (Claude, Codex) how to project
 *    and query the graph; installed by `hyp skills install` when this plugin is
 *    active
 *
 * Registration only; the projection runs on demand via the command (no
 * snapshot/commit hook exists, and eventual freshness is acceptable).
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0023#on-demand-projection [implements]: command-only projection keeps the plugin out of the daemon loop
 */
export async function activate(ctx) {
  // The contract registry source plugins contribute into, exposed via the
  // capability and read by `graph project` (through the runtime singleton,
  // since the command runs with a CommandRunContext, not this one).
  const registry = createContractRegistry({ log: ctx.log })
  setGraphRuntime({ registry })

  /** @type {ContextGraphCapability} */
  const capability = {
    registerContract: (contract) => registry.register(contract),
    kit: { nodeId, edgeId, makeRowBuilders },
  }
  ctx.provideCapability('hypaware.context-graph', CAPABILITY_VERSION, capability)

  ctx.query.registerDataset(graphDatasetRegistration(NODE_DATASET))
  ctx.query.registerDataset(graphDatasetRegistration(EDGE_DATASET))

  ctx.commands.register({
    name: 'graph project',
    plugin: PLUGIN_NAME,
    summary: 'Project every registered source contract into the node/edge activity graph',
    usage: 'hyp graph project [--source <dataset>] [--dry-run]',
    run: runGraphProject,
  })

  ctx.commands.register({
    name: 'graph compact',
    plugin: PLUGIN_NAME,
    summary: 'Merge duplicate graph rows and rewrite affected partitions sorted',
    usage: 'hyp graph compact [--dry-run]',
    run: runGraphCompact,
  })

  // `graph neighbors` is a verb (LLP 0034 §verbs): registering it projects
  // both the CLI command and the `graph_neighbors` MCP tool, so the tool
  // lights up wherever this plugin is active, with no core change.
  ctx.verbs.register(graphNeighborsVerb)

  // Teaches AI clients how to project and query the graph. Registered only
  // when this plugin is active, so `hyp skills install` copies it into
  // ~/.claude/skills and ~/.codex/skills only for installs that have the graph.
  ctx.skills.register({
    name: 'hypaware-graph',
    plugin: PLUGIN_NAME,
    clients: ['claude', 'codex'],
    sourceDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'hypaware-graph'),
  })
}

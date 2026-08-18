// @ts-check

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
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ContextGraphCapability } from './types.js'
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
 *    to N hops, reading the published node/edge datasets ([LLP 0064])
 *  - group `graph` - the namespace's own help, so `hyp graph --help` states the
 *    projection model instead of listing subcommands bare ([LLP 0214])
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

  // The group's own voice. `graph` has no bare command, so without this its
  // `--help` is a subcommand table with no prose, and the projection model
  // (derived, on demand, never live) has nowhere to be stated.
  // @ref LLP 0214#d2 [implements]: a plugin namespace describes itself instead of rendering a bare table
  ctx.commands.registerGroup({
    name: 'query graph',
    plugin: PLUGIN_NAME,
    summary: 'Build and walk the activity graph projected from recorded sessions',
    help: [
      'The graph is a derived projection of the recorded AI sessions: the same',
      'data `hyp query` reads as rows, read instead as relationships. Sessions',
      'connect to the apps, models, tools, files, skills, programs, repos, and',
      'commits they touched.',
      '',
      'It is built on demand and never updates itself. Run `hyp graph project`',
      'before querying, and again after new sessions are recorded; projection is',
      'idempotent, so re-running it is the cheap way to be current.',
      '',
      'Two ways to read it, and they answer different questions:',
      '  hyp query sql "... from node/edge ..."   counts, rankings, group-by',
      '  hyp query graph neighbors <node>         what connects to X, N hops',
      '',
      '`node` and `edge` are ordinary query datasets, so everything in',
      "`hyp query --help` applies to them, including --format and --output.",
    ].join('\n'),
  })

  ctx.commands.register({
    name: 'graph project',
    plugin: PLUGIN_NAME,
    category: 'additional',
    audience: 'operator',
    summary: 'Project every registered source contract into the node/edge activity graph',
    usage: 'hyp graph project [--source <dataset>] [--dry-run]',
    help: [
      'Reads every registered source contract and writes the node/edge tables.',
      'Idempotent: running it twice over unchanged recordings changes nothing,',
      'so re-projecting is always safe and is the fix for a stale answer.',
      '',
      'Prints `N node(s), M edge(s) - wrote ...` on success. An empty graph',
      'after a successful run means there are no recordings to project yet,',
      'not that the projection failed.',
      '',
      '  --source <dataset>  project only this source dataset',
      '  --dry-run           report what would be written, write nothing',
    ].join('\n'),
    run: runGraphProject,
  })

  ctx.commands.register({
    name: 'graph compact',
    plugin: PLUGIN_NAME,
    category: 'additional',
    audience: 'operator',
    summary: 'Merge duplicate graph rows and rewrite affected partitions sorted',
    usage: 'hyp graph compact [--dry-run]',
    help: [
      'Maintenance, not a projection step. Merges duplicate node/edge rows left',
      'by repeated projections and rewrites the affected partitions sorted.',
      'Querying does not require it; a large graph reads faster after it.',
      '',
      '  --dry-run  report what would be merged, write nothing',
    ].join('\n'),
    run: runGraphCompact,
  })

  // `graph neighbors` is a verb (LLP 0034 §verbs): registering it projects
  // both the CLI command and the `graph_neighbors` MCP tool, so the tool
  // lights up wherever this plugin is active, with no core change.
  ctx.verbs.register(graphNeighborsVerb)

  // No skill. `hypaware-graph` was retired into `hypaware-query` (LLP 0213
  // #d2): the graph is composed wherever the gateway is, and `hypaware-query`
  // ships only from the two adapters that require the gateway, so the merged
  // skill can never reach an install without the graph. What was mechanics
  // here now lives in this plugin's own `--help` (LLP 0214), which appears and
  // disappears with the commands it documents.
  // @ref LLP 0213#skill-implies-graph [constrained-by]: the merged skill's reach is bounded by the gateway, so a separate skill buys nothing
}

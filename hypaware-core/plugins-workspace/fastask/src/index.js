// @ts-check

import { EVIDENCE_USAGE, PLUGIN_NAME, queryEvidenceVerb, runQueryEvidence, runReplicaRefresh, runReplicaStatus } from './commands.js'
import { SOURCE_NAME, createReplicaSource } from './replica_source.js'
import { DISCOVER_USAGE, NEIGHBORS_USAGE, SEARCH_USAGE, runTeamGraphDiscover, runTeamGraphNeighbors, runTeamGraphSearch } from './team_graph.js'

/**
 * @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Activate `@hypaware/fastask`: the `team-graph-replica` source that keeps
 * the team graph replica and its warm index in the daemon, and the commands
 * that read it. The plugin stays out of default activation, so all of this
 * exists only behind an explicit `plugins[]` entry until the enabling task;
 * no skill text advertises it yet.
 *
 * @ref LLP 0480#enablement [implements]: commands register on the integration branch only behind an explicit plugins[] entry; skills and default activation wait for enablement
 * @ref LLP 0480#command-tree [implements]: graph replica sits beside graph project and compact; query evidence and query team-graph under query
 * @param {PluginActivationContext} ctx
 */
export function activate(ctx) {
  const pluginDir = ctx.paths.stateDir
  ctx.sources.register({
    name: SOURCE_NAME,
    plugin: PLUGIN_NAME,
    summary: 'Team graph replica sync and warm index',
    start: createReplicaSource(),
  })

  // @ref LLP 0488#planner-deferred [implements]: hyp fastask is not registered; runFastask stays for a later, separately validated evaluation

  ctx.commands.registerGroup({
    name: 'graph replica',
    plugin: PLUGIN_NAME,
    summary: 'The team graph replica this machine keeps for the default remote',
    help: [
      'A copy of the team graph from the default remote, kept by the daemon for',
      'hyp query team-graph. It is teammates\' data: never exported or forwarded.',
      '',
      '  hyp graph replica status    one line: state and how old the data is',
      '  hyp graph replica refresh   ask the daemon to check for a newer graph now',
    ].join('\n'),
  })

  ctx.commands.register({
    name: 'graph replica status',
    plugin: PLUGIN_NAME,
    category: 'additional',
    audience: 'operator',
    summary: 'Show the team graph replica state and the age of its data',
    usage: 'hyp graph replica status [--json]',
    help: 'One line in every state, with the age of the data held. Reads the daemon when it runs, else the record on disk.\n\n  --json  the status fields',
    run: (argv, runCtx) => runReplicaStatus(argv, runCtx, { pluginDir }),
  })

  ctx.commands.register({
    name: 'graph replica refresh',
    plugin: PLUGIN_NAME,
    category: 'additional',
    audience: 'operator',
    summary: 'Ask the daemon to check the team graph replica now',
    usage: 'hyp graph replica refresh',
    help: 'Starts a check in the running daemon, coalesced with any in flight, and returns without waiting.',
    run: (argv, runCtx) => runReplicaRefresh(argv, runCtx, { pluginDir }),
  })

  // The command first, so the verb registration keeps only the tool slot:
  // the CLI needs repeated JSON --session values the verb codec cannot take.
  ctx.commands.register({
    name: 'query evidence',
    plugin: PLUGIN_NAME,
    category: queryEvidenceVerb.category,
    audience: queryEvidenceVerb.audience,
    summary: queryEvidenceVerb.summary,
    usage: EVIDENCE_USAGE,
    help: [
      'Reads original session text from a team server through its session_evidence',
      'tool. hyp query team-graph search prints these commands for its hits.',
      'Without --remote it is a usage error: the evidence lives on the server.',
    ].join('\n'),
    run: runQueryEvidence,
  })
  ctx.verbs.register(queryEvidenceVerb)

  // @ref LLP 0487#decision [implements]: discover, neighbors and search are agent-callable operations under the query journey, beside query evidence
  ctx.commands.registerGroup({
    name: 'query team-graph',
    plugin: PLUGIN_NAME,
    summary: "Explore the team graph yourself: discover, neighbors, search, then query evidence",
    help: [
      "Operations over the team's activity graph for an agent that chooses its own",
      'path: discover files and the sessions that touched them, follow neighbors,',
      'search text inside candidate sessions, then read the original conversation',
      'with hyp query evidence. Every --json result names its source (team graph',
      'replica warm or cold, team server, or local captures), the replica state and',
      'how old its data is, and carries the ids the next operation takes.',
      '',
      '  hyp query team-graph discover <term>...       files and sessions, paged',
      '  hyp query team-graph neighbors <node-id>...   one hop from given nodes',
      '  hyp query team-graph search --session <id>... <term>...   text in sessions',
    ].join('\n'),
  })

  const remoteHelp = [
    '  --remote <target>  team server to read (default: the default remote)',
    '  --org <label>      organization to read on the server',
    '  --json             the stable document, with follow-up commands',
  ]

  ctx.commands.register({
    name: 'query team-graph discover',
    plugin: PLUGIN_NAME,
    category: 'explore-share',
    audience: 'everyday',
    summary: 'Team graph files matching your terms, and the sessions that touched them',
    usage: DISCOVER_USAGE,
    help: [
      'Terms are used as written (file names, paths, identifiers): no question',
      'parsing. Files in this repository rank first; suffix and absolute-path',
      'matches are marked as candidates, not proven identity.',
      '',
      '  --term <t>         a term; repeatable, as are positional terms (12 at most)',
      '  --file <path>      a file to anchor on; repeatable',
      '  --repo <path>      repository to prefer (default: this one)',
      '  --limit <n>        sessions per page, 1 to 40 (default 8)',
      '  --offset <n>       sessions to skip: the next page starts at next_offset',
      ...remoteHelp,
    ].join('\n'),
    run: (argv, runCtx) => runTeamGraphDiscover(argv, runCtx, { pluginDir }),
  })

  ctx.commands.register({
    name: 'query team-graph neighbors',
    plugin: PLUGIN_NAME,
    category: 'explore-share',
    audience: 'everyday',
    summary: 'One hop from team graph nodes: what touched them, or what they touched',
    usage: NEIGHBORS_USAGE,
    help: [
      'Start from node ids (from discover or an earlier neighbors) or --key natural',
      'keys. Bounded: 20,000 edge visits shared across the starts, newest first;',
      'truncation is reported. Without a replica, the server answers through',
      'hyp query graph neighbors --remote.',
      '',
      '  --key <key>        a start node by natural key; repeatable',
      '  --direction <d>    in, out or both (default both)',
      '  --edge-type <t>    only this edge type; repeatable',
      '  --limit <n>        neighbors to return, 1 to 500 (default 50)',
      '  --max-visits <n>   edge visits, at most 20,000',
      ...remoteHelp,
    ].join('\n'),
    run: (argv, runCtx) => runTeamGraphNeighbors(argv, runCtx, { pluginDir }),
  })

  ctx.commands.register({
    name: 'query team-graph search',
    plugin: PLUGIN_NAME,
    category: 'explore-share',
    audience: 'everyday',
    summary: 'Find text inside candidate sessions on the team server',
    usage: SEARCH_USAGE,
    help: [
      'Up to 16 sessions and 12 terms (any term matches, case-insensitive). Each',
      'session is reported on its own, with its own truncation. Each hit carries',
      'the query evidence command that reads the conversation around it.',
      '',
      '  --session <id>     a session id; repeatable, required',
      '  --term <t>         a term; repeatable, as are positional terms',
      '  --hits <n>         hits per session, 1 to 50 (default 10)',
      '  --chars <n>        excerpt characters per hit, 40 to 2000 (default 400)',
      ...remoteHelp,
    ].join('\n'),
    run: (argv, runCtx) => runTeamGraphSearch(argv, runCtx, { pluginDir }),
  })
}

// @ts-check

import { FASTASK_USAGE, EVIDENCE_USAGE, PLUGIN_NAME, queryEvidenceVerb, runFastask, runQueryEvidence, runReplicaRefresh, runReplicaStatus } from './commands.js'
import { SOURCE_NAME, createReplicaSource } from './replica_source.js'

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
 * @ref LLP 0480#command-tree [implements]: fastask is a top-level journey beside ask; graph replica sits beside graph project and compact; query evidence under query
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

  ctx.commands.register({
    name: 'fastask',
    plugin: PLUGIN_NAME,
    category: 'explore-share',
    audience: 'everyday',
    summary: "Find the team's sessions behind a question: leads with original text, fast",
    usage: FASTASK_USAGE,
    help: [
      'Answers with leads, not an answer: the sessions that touched the files the',
      'question names, why each was chosen, a few excerpts of their original text,',
      'and commands to read further. Every result names its source: the team graph',
      'replica (warm through the daemon, or cold from disk), the team server (slow),',
      'or local captures only.',
      '',
      '  --remote <target>  team server to read (default: the default remote)',
      '  --org <label>      organization to read on the server',
      '  --repo <path>      repository the question is about (default: this one)',
      '  --file <path>      a file to anchor on; repeatable',
      '  --budget-ms <n>    time budget in milliseconds (default 2000)',
      '  --leads <n>        leads to return, 1 to 40 (default 8)',
      '  --json             the fastask/1 document',
      '',
      'Exit 0 with leads or an explicit "no leads", 1 when nothing could be read,',
      '2 on a usage error.',
    ].join('\n'),
    run: (argv, runCtx) => runFastask(argv, runCtx, { pluginDir }),
  })

  ctx.commands.registerGroup({
    name: 'graph replica',
    plugin: PLUGIN_NAME,
    summary: 'The team graph replica this machine keeps for the default remote',
    help: [
      'A copy of the team graph from the default remote, kept by the daemon for',
      'hyp fastask. It is teammates\' data: never exported or forwarded.',
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
      'tool. fastask prints these commands as follow-ups and continuations.',
      'Without --remote it is a usage error: the evidence lives on the server.',
    ].join('\n'),
    run: runQueryEvidence,
  })
  ctx.verbs.register(queryEvidenceVerb)
}

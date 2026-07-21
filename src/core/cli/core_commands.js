// @ts-check

import { runBackfill, runBackfillList, runBackfillPlan } from '../commands/backfill.js'
import { runRemoteAdd, runRemoteList, runRemoteLogin, runRemoteRemove } from './remote_commands.js'
import { runReportDelete, runReportGet, runReportList, runReportPublish } from './report_commands.js'
import { CORE_VERBS } from './core_verbs.js'
import { verbToCommand } from './verb_command.js'
import { makeGroupCommand } from './group_help.js'
import { runStatus } from '../commands/status.js'
import {
  runQueryMaintain,
  runQueryRefresh,
  runQuerySchema,
  runQueryStatus,
} from '../commands/query.js'
import {
  runPluginDoctor,
  runPluginInfo,
  runPluginInstall,
  runPluginList,
  runPluginNew,
  runPluginOutdated,
  runPluginRemove,
  runPluginUpdate,
} from '../commands/plugin.js'
import { runConfigValidate } from '../commands/config.js'
import {
  runDaemonInstall,
  runDaemonRestart,
  runDaemonRun,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUninstall,
} from '../commands/daemon.js'
import { runMcp } from '../commands/mcp.js'
import { runSmoke, runVersion } from '../commands/misc.js'
import { runSinkForce, runSinkMaintain } from '../commands/sink.js'
import { runInit } from '../commands/init.js'
import { runJoin, runLeave } from '../commands/central.js'
import { runPurge } from '../commands/purge.js'
import {
  runAgentsInstall,
  runAttach,
  runDetach,
  runIgnore,
  runSkillsInstall,
  runUnignore,
} from '../commands/clients.js'
import { runPolicyList, runPolicySet, runPolicyShow, runPolicyUnset } from '../commands/policy.js'

/**
 * @import { CommandRegistration } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CommandRegistryExtended } from '../../../src/core/cli/types.js'
 */

/**
 * Register the V1 core command set onto the supplied registry. These
 * commands are NOT plugin contributions: they ship with the kernel
 * (per Phase 3 plan §Built-In Commands and the V1 Parity Table).
 *
 * Phase 3 implementations are deliberately thin: each command emits the
 * right spans/logs so the dispatcher's behavior is observable, but the
 * underlying subsystems (query cache, plugin install path, etc.) land
 * in later phases. Future phases swap in real bodies without changing
 * the registry shape.
 *
 * @param {CommandRegistryExtended} registry
 */
export function registerCoreCommands(registry) {
  for (const cmd of buildCoreCommands(registry)) {
    registry.register(cmd)
  }
  // Project the intrinsic core verbs (query_sql) as CLI commands here too,
  // so `hyp --help` (rendered before the kernel boots) lists `query sql`.
  // The kernel verb registry re-projects them idempotently during boot and
  // owns the MCP tool surface (LLP 0034 §verbs).
  for (const verb of CORE_VERBS) {
    if (!registry.get(verb.name)) registry.register(verbToCommand(verb))
  }
}

/**
 * @param {CommandRegistryExtended} registry
 * @returns {CommandRegistration[]}
 */
function buildCoreCommands(registry) {
  return [
    {
      name: 'status',
      summary: 'Show kernel status (active plugins, sources, sinks, cache)',
      usage: 'hyp status [--json]',
      run: runStatus,
    },
    makeGroupCommand({
      registry,
      name: 'query',
      summary: 'Query the local cache (sql, schema, status, ...)',
      help:
        'Query-executing subcommands (e.g. sql) accept kernel control flags:\n' +
        '  --format <fmt>    --output <file>    --max-cell <n>    --max-bytes <n>\n' +
        '  --remote [target] run against a remote MCP target instead of the local\n' +
        '                    cache (bare --remote uses query.default_remote, else the\n' +
        "                    shipped default; manage targets with 'hyp remote').\n" +
        "See 'hyp query <subcommand> --help' for which flags a subcommand supports\n" +
        '(status/schema/refresh/maintain are local-only and ignore --remote).',
    }),
    {
      name: 'query schema',
      summary: 'Print the schema for a dataset',
      usage: 'hyp query schema <dataset>',
      run: runQuerySchema,
    },
    {
      name: 'query status',
      summary: 'Show cache freshness and dataset registration state',
      usage: 'hyp query status',
      run: runQueryStatus,
    },
    {
      name: 'query refresh',
      summary: 'Force a cache refresh for a dataset',
      usage: 'hyp query refresh [dataset]',
      run: runQueryRefresh,
    },
    {
      name: 'query maintain',
      summary: 'Run cache maintenance (legacy migration, snapshot expiration, compaction)',
      usage: 'hyp query maintain [dataset] [--dry-run] [--force] [--compact-only] [--expire-only]',
      run: runQueryMaintain,
    },
    {
      name: 'backfill',
      summary: 'Import client history from backfill providers',
      usage: 'hyp backfill [provider...] [--since <iso>] [--until <iso>] [--retention-days <n>] [--dry-run] [--json]',
      run: runBackfill,
    },
    {
      name: 'backfill list',
      summary: 'List registered backfill providers',
      usage: 'hyp backfill list [--json]',
      run: runBackfillList,
    },
    {
      name: 'backfill plan',
      summary: 'Show what each backfill provider would scan without writing rows',
      usage: 'hyp backfill plan [provider...] [--retention-days <n>] [--json]',
      run: runBackfillPlan,
    },
    makeGroupCommand({
      registry,
      name: 'plugin',
      summary: 'Manage plugins (install, list, update, remove, ...)',
    }),
    {
      name: 'plugin install',
      summary: 'Install a plugin from name, git URL, or local directory',
      usage: 'hyp plugin install <source> [--ref <ref>] [--path <subdir>] [--yes]',
      run: runPluginInstall,
    },
    {
      name: 'plugin list',
      summary: 'List active (bundled) and installed plugins',
      usage: 'hyp plugin list [--json]',
      run: runPluginList,
    },
    {
      name: 'plugin info',
      summary: 'Show details for an installed plugin',
      usage: 'hyp plugin info <plugin>',
      run: runPluginInfo,
    },
    {
      name: 'plugin outdated',
      summary: 'List plugins with updates available',
      usage: 'hyp plugin outdated [--json]',
      run: runPluginOutdated,
    },
    {
      name: 'plugin update',
      summary: 'Update an installed plugin',
      usage: 'hyp plugin update [plugin] [--yes]',
      run: runPluginUpdate,
    },
    {
      name: 'plugin remove',
      summary: 'Remove an installed plugin',
      usage: 'hyp plugin remove <plugin>',
      run: runPluginRemove,
    },
    {
      name: 'plugin doctor',
      summary: 'Diagnose a plugin in development (static checks + dry-run activate)',
      usage: 'hyp plugin doctor [dir] [--json]',
      run: runPluginDoctor,
    },
    {
      name: 'plugin new',
      summary: 'Scaffold a new plugin',
      usage: 'hyp plugin new <name> [--kind source|sink|dataset] [--dir <path>]',
      run: runPluginNew,
    },
    makeGroupCommand({
      registry,
      name: 'config',
      summary: 'Inspect or validate the HypAware config',
    }),
    {
      name: 'config validate',
      summary: 'Load and cross-validate the active config file',
      usage: 'hyp config validate [--path <file>]',
      run: runConfigValidate,
    },
    {
      name: 'init',
      summary: 'Initialize a new HypAware install (interactive walkthrough or preset)',
      usage: 'hyp init [preset]',
      run: runInit,
    },
    {
      name: 'join',
      summary: 'Join a centrally-managed fleet (write seed config + install daemon)',
      usage: 'hyp join <url> [token] [--token-file <path>] [--bin <path>] [--no-daemon]',
      help: 'Token sources (pick one): positional argument, --token-file, or stdin.\nA bare argv token lands in shell history; scripts should prefer\n--token-file or stdin.',
      run: runJoin,
    },
    {
      name: 'leave',
      summary: 'Leave the centrally-managed fleet (stop forwarding + config pull, undo org-driven attaches)',
      usage: 'hyp leave',
      help: 'Disconnects this machine from its central server: stops forwarding and\nconfig pull, undoes org-driven client attaches, and removes the forward\ncredential. Keeps query sessions, the local config, and the daemon service.',
      run: runLeave,
    },
    {
      name: 'attach',
      summary: 'Attach an AI client to the local gateway',
      usage: 'hyp attach [client] [--client <name>] [--dry-run] [--json]',
      run: runAttach,
    },
    {
      name: 'detach',
      summary: 'Detach an AI client from the local gateway',
      usage: 'hyp detach [client] [--client <name>] [--dry-run] [--json]',
      aliases: ['unattach'],
      run: runDetach,
    },
    {
      name: 'ignore',
      summary: 'Exclude a folder subtree from recording or forwarding',
      usage: 'hyp ignore [path] [--check] [--json] [--local-only | --private | --sync]',
      help: [
        'Writes a .hypignore so HypAware never records this folder subtree.',
        'With --local-only, keeps recording locally but withholds the subtree',
        'from forwarding (machine-local, never written into the repo). With',
        '--private, marks the subtree ignore in the same machine-local store',
        'instead of writing a dotfile - never recorded, and never a repo',
        'breadcrumb. With --sync, marks the subtree as explicitly synced (the',
        'implicit default made durable, so it is not asked about again). With',
        '--check, reports the current status - class and governing source -',
        'without writing anything.',
        '',
        'Deprecated: the --local-only/--private/--sync/--check flags now live as',
        'hyp policy set/show; use hyp policy instead. Bare hyp ignore [path]',
        '(the .hypignore dotfile author) is not deprecated.',
      ].join('\n'),
      run: runIgnore,
    },
    {
      name: 'unignore',
      summary: 'Resume recording for a previously ignored folder',
      usage: 'hyp unignore [path] [--local-only | --private | --sync]',
      help: [
        'Removes the governing .hypignore. With --local-only, --private, or',
        '--sync, removes machine-local entries of that class instead',
        '(symmetric with the matching hyp ignore flag).',
        '',
        'Deprecated: the --local-only/--private/--sync flags now live as',
        'hyp policy unset; use hyp policy instead. Bare hyp unignore [path]',
        '(the .hypignore remover) is not deprecated.',
      ].join('\n'),
      run: runUnignore,
    },
    makeGroupCommand({
      registry,
      name: 'policy',
      summary: 'Mark a folder machine-local usage class (sync, local-only, ignore)',
      help: [
        'The class-neutral successor to the hyp ignore --sync/--local-only/--private',
        'flags: writes to the same machine-local, class-per-entry store (never a',
        '.hypignore dotfile). set/show/unset act on one path; list enumerates every',
        'machine-local entry on this machine.',
      ].join('\n'),
    }),
    {
      name: 'policy set',
      summary: 'Mark a folder machine-local sync, local-only, or ignore',
      usage: 'hyp policy set <path> sync|local-only|ignore',
      run: runPolicySet,
    },
    {
      name: 'policy show',
      summary: 'Report the usage class governing a folder and its source',
      usage: 'hyp policy show [path] [--json]',
      run: runPolicyShow,
    },
    {
      name: 'policy unset',
      summary: 'Remove machine-local markings governing a folder (optionally scoped to one class)',
      usage: 'hyp policy unset <path> [sync|local-only|ignore]',
      help: [
        'With no trailing class token, removes every machine-local entry governing',
        '<path> (class-neutral: back to the implicit default). With a trailing',
        'sync/local-only/ignore token, removes only entries of that class.',
      ].join('\n'),
      run: runPolicyUnset,
    },
    {
      name: 'policy list',
      summary: 'Enumerate machine-local usage-class entries',
      usage: 'hyp policy list [--json]',
      run: runPolicyList,
    },
    {
      name: 'purge',
      summary: 'Delete already-cached rows from the local cache (destructive)',
      usage: 'hyp purge <path> | --session <id> | --ignored | --all [--yes] [--json]',
      help: [
        'Permanently deletes recorded rows from THIS machine\'s local cache.',
        'Never contacts a sink or the remote and never deletes exported copies.',
        'Exactly one target is required:',
        '  <path>          rows whose cwd equals or descends from the path',
        '  --session <id>  one session\'s rows',
        '  --ignored       every row whose directory currently resolves to ignore',
        '  --all           every recorded row, wholesale',
        'Marking (hyp ignore) stays non-destructive; purge is the separate step.',
        'Prompts on a TTY; pass --yes to delete non-interactively.',
      ].join('\n'),
      run: runPurge,
    },
    makeGroupCommand({
      registry,
      name: 'skills',
      summary: 'Manage skills for AI clients',
    }),
    {
      name: 'skills install',
      summary: 'Install registered skills into AI client directories',
      usage: 'hyp skills install [--client <name>]',
      run: runSkillsInstall,
    },
    makeGroupCommand({
      registry,
      name: 'agents',
      summary: 'Manage subagents for AI clients',
    }),
    {
      name: 'agents install',
      summary: 'Install registered subagents into AI client directories',
      usage: 'hyp agents install [--client <name>]',
      run: runAgentsInstall,
    },
    makeGroupCommand({
      registry,
      name: 'daemon',
      summary: 'Manage the HypAware daemon (install, start, stop, status, ...)',
    }),
    {
      name: 'daemon install',
      summary: 'Install the persistent user service (launchd / systemd)',
      usage: 'hyp daemon install [--config <path>] [--bin <path>] [--dry-run [--json]]',
      run: runDaemonInstall,
    },
    {
      name: 'daemon uninstall',
      summary: 'Uninstall the persistent user service (keeps config, recordings, logs)',
      usage: 'hyp daemon uninstall',
      run: runDaemonUninstall,
    },
    {
      name: 'daemon run',
      summary: 'Run the HypAware daemon in the foreground',
      usage: 'hyp daemon run --foreground [--config <path>]',
      run: runDaemonRun,
    },
    {
      name: 'daemon start',
      summary: 'Start the installed daemon service',
      usage: 'hyp daemon start',
      run: runDaemonStart,
    },
    {
      name: 'daemon status',
      summary: 'Print the running daemon’s health snapshot',
      usage: 'hyp daemon status [--json]',
      run: runDaemonStatus,
    },
    {
      name: 'daemon stop',
      summary: 'Signal the running daemon to shut down',
      usage: 'hyp daemon stop',
      run: runDaemonStop,
    },
    {
      name: 'daemon restart',
      summary: 'Stop the daemon (and direct the operator to relaunch)',
      usage: 'hyp daemon restart',
      run: runDaemonRestart,
    },
    makeGroupCommand({
      registry,
      name: 'sink',
      summary: 'Manage sink instances (force, maintain)',
    }),
    {
      name: 'sink force',
      summary: 'Force the sink driver to fire a tick now (optionally for one instance)',
      usage: 'hyp sink force [instance]',
      run: runSinkForce,
    },
    {
      name: 'sink maintain',
      summary: 'Run export maintenance (snapshot expiration; data-file compaction with --compact) on table-format sinks',
      usage: 'hyp sink maintain [instance] [--compact] [--dry-run]',
      run: runSinkMaintain,
    },
    {
      name: 'mcp',
      summary: 'Serve this host\'s verbs as an MCP server for AI clients',
      usage: 'hyp mcp [--remote <target>]',
      run: runMcp,
    },
    makeGroupCommand({
      registry,
      name: 'remote',
      summary: 'Manage remote MCP query targets and tokens',
    }),
    {
      name: 'remote add',
      summary: 'Register a remote MCP query target in local config',
      usage: 'hyp remote add <name> <url>',
      run: runRemoteAdd,
    },
    {
      name: 'remote login',
      summary: 'Store the query-scoped token for a remote target (0600)',
      usage: 'hyp remote login <name> [--token-file <path>] [--no-forward] [--no-daemon]',
      help: [
        'Browser sign-in by default; --token-file/stdin for a static token,',
        '--org <name> to select an org, --no-browser to print the URL,',
        '--host <label> to override the forwarding host label (default: hostname),',
        '--no-forward to sign in for queries only (no fleet enrollment),',
        '--no-daemon to provision the sink without installing the service.',
      ].join('\n'),
      run: runRemoteLogin,
    },
    {
      name: 'remote list',
      summary: 'List remote targets and token status (never the token)',
      usage: 'hyp remote list [--json]',
      run: runRemoteList,
    },
    {
      name: 'remote remove',
      summary: 'Remove a remote target and its stored token',
      usage: 'hyp remote remove <name>',
      run: runRemoteRemove,
    },
    // @ref LLP 0111#not-verbs [constrained-by]: report subcommands stay REST commands, never ctx.verbs; MCP report tools are the server's to register
    makeGroupCommand({
      registry,
      name: 'report',
      summary: "Publish and read reports on a remote server's reports plane",
      help:
        "Reports are server-hosted (there is no local reports plane); every\n" +
        'subcommand takes --remote <target> and defaults to the default remote\n' +
        "target, the same resolution as bare --remote on queries. Reads use\n" +
        'your login session; publish and delete need the publisher role (or an\n' +
        "operator-minted publish token stored via 'hyp remote login <target>\n" +
        "--token-file <path>').",
    }),
    {
      name: 'report publish',
      summary: "Publish a report (single .html/.md file, or a folder bundle) to the org's reports plane",
      usage: 'hyp report publish <file-or-dir> --kind <kind> --period <period> [--title <title>] [--org <org>] [--remote <target>]',
      help: [
        'A file publishes a single document; a folder publishes a bundle (its',
        'root must contain report.html or report.md, built with the system',
        "tar as --format=ustar). kind names the report family (e.g.",
        "usage-review); period is the covered slice (e.g. 2026-W29).",
        '--org applies only with the operator admin token, which must name',
        'its org explicitly.',
      ].join('\n'),
      run: runReportPublish,
    },
    {
      name: 'report list',
      summary: "List the org's published reports (newest first)",
      usage: 'hyp report list [--kind <kind>] [--period <period>] [--limit <n>] [--before <publishedAt>] [--org <org>] [--json] [--remote <target>]',
      run: runReportList,
    },
    {
      name: 'report get',
      summary: "Fetch a report's entry document (or one artifact) to stdout or --output",
      usage: 'hyp report get <kind> <period> <id> [path] [--output <file>] [--org <org>] [--remote <target>]',
      run: runReportGet,
    },
    {
      name: 'report delete',
      summary: "Delete a published report from the org's reports plane (destructive)",
      usage: 'hyp report delete <kind> <period> <id> [--yes] [--org <org>] [--remote <target>]',
      help: 'Org-wide and permanent: the report disappears for every member.\nPrompts on a TTY; pass --yes to delete non-interactively.',
      run: runReportDelete,
    },
    {
      name: 'version',
      summary: 'Print version and environment info',
      usage: 'hyp version',
      run: runVersion,
    },
    {
      name: 'smoke',
      summary: 'Run a smoke flow under a fresh tmp HYP_HOME (internal)',
      usage: 'hyp smoke <flow-name>',
      hidden: true,
      run: runSmoke,
    },
  ]
}

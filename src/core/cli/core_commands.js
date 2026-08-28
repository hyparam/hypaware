// @ts-check

import { runBackfill, runBackfillList, runBackfillPlan } from '../commands/backfill.js'
import { runRemoteAdd, runRemoteList, runRemoteLogin, runRemoteMint, runRemoteRemove } from './remote_commands.js'
import { runReportDelete, runReportGet, runReportList, runReportPublish, runReportRender } from './report_commands.js'
import { coreUsage } from './command_args.js'
import { CORE_VERBS } from './core_verbs.js'
import { verbToCommand } from './verb_command.js'
import { makeGroupCommand } from './group_help.js'
import { runClientStatus, runStatus } from '../commands/status.js'
import {
  runQueryMaintain,
  runQueryOverview,
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
import { runAsk } from '../commands/ask.js'
import { runUpdate } from '../commands/update.js'
import { runMcp } from '../commands/mcp.js'
import { runSmoke, runVersion } from '../commands/misc.js'
import { runSinkMaintain } from '../commands/sink.js'
import { runSync } from '../commands/sync.js'
import { runInit } from '../commands/init.js'
import { runJoin, runLeave } from '../commands/central.js'
import { runPurge } from '../commands/purge.js'
import {
  runAttach,
  runDetach,
  runIgnore,
  runSkillsInstall,
  runUnignore,
} from '../commands/clients.js'
import { runPolicyClient, runPolicyFolders, runPolicyList, runPolicySet, runPolicyShow, runPolicyUnset } from '../commands/policy.js'

/**
 * @import { CommandGroupRegistration, CommandRegistration } from '../../../hypaware-plugin-kernel-types.js'
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
  for (const group of CORE_COMMAND_GROUPS) {
    registry.registerGroup(group)
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
 * Descriptions for the core groups that exist only as a shared prefix. A
 * group whose bare command `makeGroupCommand` built speaks for itself; these
 * three have no bare command, so without a registered description their
 * `--help` opens on a naked `usage:` line and a table, and the reader is
 * never told what the group is for.
 *
 * @type {CommandGroupRegistration[]}
 * @ref LLP 0214#d2 [implements]: the group registry is where a bare-command-less group keeps its voice, core groups included
 */
const CORE_COMMAND_GROUPS = [
  {
    name: 'cache',
    summary: 'Inspect and maintain the local query cache',
    help: [
      'The cache is the local Iceberg store every query reads. These',
      'subcommands report how fresh it is, force a refresh for one dataset,',
      'and run its maintenance routines. They are local-only: none of them',
      'answers about a remote target.',
      '',
      'The same three routines also answer to their former query spellings',
      '(query status/refresh/maintain).',
    ].join('\n'),
  },
  {
    name: 'client history',
    summary: 'Import past sessions from AI clients on this machine',
    help: [
      'Backfill reads history a client wrote before HypAware was capturing,',
      'from the transcript files the client keeps on disk. Start with plan,',
      'which reports what each provider would scan without writing a row.',
    ].join('\n'),
  },
  {
    name: 'dev plugin',
    summary: 'Scaffold and diagnose plugins under development',
  },
]

/**
 * @param {CommandRegistryExtended} registry
 * @returns {CommandRegistration[]}
 */
function buildCoreCommands(registry) {
  return [
    {
      name: 'status',
      category: 'getting-started',
      audience: 'everyday',
      bootProfile: 'none',
      summary: 'Check capture, clients, storage, and health',
      usage: coreUsage('status'),
      help: [
        'The entry point for "is it working?". Reports the config path, daemon',
        'state, active plugins, sources, sinks, per-client attach state, cache',
        'location/retention/size, recent error count, and any pending first-sync',
        'deadline. When something is wrong it adds a diagnostics section whose',
        'repair: lines are commands you can run directly.',
        '',
        '--json prints the stable machine shape; prefer it for scripting.',
      ].join('\n'),
      run: runStatus,
    },
    makeGroupCommand({
      registry,
      name: 'client',
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Manage AI clients and history',
    }),
    makeGroupCommand({
      registry,
      name: 'session',
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Pause or resume this live session',
      help: 'Session controls are supplied by the active AI gateway plugin. They affect future capture in the live gateway and do not delete existing rows.',
    }),
    makeGroupCommand({
      registry,
      name: 'dev',
      category: 'additional',
      audience: 'developer',
      summary: 'Build plugins and run development smoke flows',
    }),
    makeGroupCommand({
      registry,
      name: 'query',
      category: 'explore-share',
      audience: 'everyday',
      summary: 'Explore recorded datasets',
      help:
        'Query-executing subcommands (e.g. sql) accept kernel control flags:\n' +
        '  --format <fmt>    --output <file>    --max-cell <n>    --max-bytes <n>\n' +
        '  --remote [target] run against a remote MCP target instead of the local\n' +
        '                    cache (bare --remote uses query.default_remote, else the\n' +
        "                    shipped default; manage targets with 'hyp remote').\n" +
        "See 'hyp query <subcommand> --help' for which flags a subcommand supports\n" +
        '(overview and schema, and the cache routines behind the query status/\n' +
        'refresh/maintain aliases, are local-only; query status rejects --remote\n' +
        'with exit 2 rather than answering about the wrong host).',
    }),
    {
      name: 'query overview',
      summary: 'Show recorded AI traffic: tokens per model, activity per day, repos, and tools',
      usage: 'hyp query overview [--json] [--sql] [--days <n>] [--include-local-only]',
      run: runQueryOverview,
    },
    {
      name: 'query schema',
      summary: 'Print the schema for a dataset',
      usage: coreUsage('query schema'),
      run: runQuerySchema,
    },
    {
      name: 'cache status',
      aliases: ['query status'],
      category: 'additional',
      audience: 'operator',
      summary: 'Show cache freshness and dataset registration state',
      usage: coreUsage('cache status'),
      run: runQueryStatus,
    },
    {
      name: 'cache refresh',
      aliases: ['query refresh'],
      category: 'additional',
      audience: 'operator',
      summary: 'Force a cache refresh for a dataset',
      usage: coreUsage('cache refresh'),
      run: runQueryRefresh,
    },
    {
      name: 'cache maintain',
      aliases: ['query maintain'],
      category: 'additional',
      audience: 'operator',
      summary: 'Run cache maintenance (legacy migration, snapshot expiration, compaction)',
      usage: 'hyp cache maintain [dataset] [--dry-run] [--force] [--compact-only] [--expire-only]',
      run: runQueryMaintain,
    },
    {
      name: 'client history import',
      aliases: ['backfill'],
      summary: 'Import client history from backfill providers',
      usage: 'hyp client history import [provider...] [--since <iso>] [--until <iso>] [--retention-days <n>] [--dry-run] [--json]',
      run: runBackfill,
    },
    {
      name: 'client history providers',
      aliases: ['backfill list'],
      summary: 'List registered backfill providers',
      usage: coreUsage('client history providers'),
      run: runBackfillList,
    },
    {
      name: 'client history plan',
      aliases: ['backfill plan'],
      summary: 'Show what each backfill provider would scan without writing rows',
      usage: 'hyp client history plan [provider...] [--retention-days <n>] [--json]',
      run: runBackfillPlan,
    },
    makeGroupCommand({
      registry,
      name: 'plugin',
      category: 'additional',
      audience: 'operator',
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
      usage: coreUsage('plugin list'),
      run: runPluginList,
    },
    {
      name: 'plugin info',
      summary: 'Show details for an installed plugin',
      usage: coreUsage('plugin info'),
      run: runPluginInfo,
    },
    {
      name: 'plugin outdated',
      summary: 'List plugins with updates available',
      usage: coreUsage('plugin outdated'),
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
      usage: coreUsage('plugin remove'),
      run: runPluginRemove,
    },
    {
      name: 'dev plugin doctor',
      aliases: ['plugin doctor'],
      audience: 'developer',
      summary: 'Diagnose a plugin in development (static checks + dry-run activate)',
      usage: 'hyp dev plugin doctor [dir] [--json]',
      run: runPluginDoctor,
    },
    {
      name: 'dev plugin new',
      aliases: ['plugin new'],
      audience: 'developer',
      summary: 'Scaffold a new plugin',
      usage: 'hyp dev plugin new <name> [--kind source|sink|dataset] [--dir <path>]',
      run: runPluginNew,
    },
    makeGroupCommand({
      registry,
      name: 'config',
      category: 'additional',
      audience: 'operator',
      summary: 'Inspect or validate the HypAware config',
    }),
    {
      name: 'config validate',
      summary: 'Load and cross-validate the active config file',
      usage: 'hyp config validate [--path <file>]',
      run: runConfigValidate,
    },
    {
      name: 'setup',
      aliases: ['init'],
      category: 'getting-started',
      audience: 'everyday',
      bootProfile: 'all-available',
      summary: 'Install, reconfigure, or maintain HypAware',
      usage: 'hyp setup [preset] [flags]',
      help: [
        'With no arguments, runs the interactive walkthrough: pick which clients',
        'and sources to capture, an export strategy, and a retention window, then',
        'write the config, install the daemon, and attach the selected clients.',
        '',
        'Pass a preset name to skip the walkthrough. Passing any flag below also',
        'skips it: the non-interactive path is chosen by the presence of a flag,',
        'so --yes is a way to ask for it with no other options, not a prefix the',
        'other flags need.',
        '',
        '  --yes, -y              accept the defaults (captures claude + otel',
        '                         when no --source is given)',
        '  --client <name>        client to attach: claude, codex (repeatable)',
        '  --source <name>        source to capture (repeatable)',
        '  --export <choice>      keep-local | local-parquet | configure-later',
        '  --retention-days <n>   how long to keep cached rows',
        '  --from-file <path>     write a v2 config read from this JSON file,',
        '                         skipping the picker entirely',
        '  --no-daemon            write the config but do not install the daemon',
        '  --dry-run              report what would be written, write nothing',
        '  --force                replace an existing config (backed up first)',
        '  --bin <path>           hyp binary to record in the daemon unit',
      ].join('\n'),
      run: runInit,
    },
    {
      name: 'ask',
      category: 'explore-share',
      audience: 'everyday',
      summary: 'Ask an AI client about recorded activity',
      usage: coreUsage('ask'),
      help: [
        'With no argument, offers a short list of questions worth asking of what',
        'HypAware has recorded, and starts an attached client on the one you',
        'pick: the client takes over the terminal and opens on that question.',
        '',
        'With a question, skips the menu and starts straight on it:',
        '  hyp ask "which sessions touched the auth module last week"',
        '',
        '  --list   print the suggested questions and exit, launching nothing',
        '',
        'Only clients that are attached (hyp status) and whose CLI is on your',
        'PATH can be started. Claude Desktop has no prompt argument, so it is',
        'never offered here.',
      ].join('\n'),
      run: runAsk,
    },
    {
      name: 'join',
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Connect this machine to a central server',
      usage: 'hyp join <url> [token] [--token-file <path>] [--bin <path>] [--no-daemon]',
      help: 'Token sources (pick one): positional argument, --token-file, or stdin.\nA bare argv token lands in shell history; scripts should prefer\n--token-file or stdin.',
      run: runJoin,
    },
    {
      name: 'leave',
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Disconnect central management, keep local history',
      usage: 'hyp leave',
      help: 'Disconnects this machine from its central server: stops forwarding and\nconfig pull, undoes org-driven client attaches, and removes the forward\ncredential. Keeps query sessions, the local config, and the daemon service.',
      run: runLeave,
    },
    {
      name: 'client attach',
      aliases: ['attach'],
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Attach an AI client to HypAware capture',
      usage: 'hyp client attach [client] [--client <name>] [--dry-run] [--json]',
      help: [
        'Configures an AI client for HypAware capture by writing managed settings',
        'into that client\'s own config file. Claude Code exports OTEL telemetry',
        'and raw body files; gateway-backed clients use the local gateway.',
        'Idempotent: re-running is a no-op. Reversible with hyp client detach, which',
        'removes only the managed settings.',
        '',
        'hyp client attach codex covers Codex Desktop as well as the Codex CLI - both',
        'read the ~/.codex/config.toml this writes and both write the',
        '~/.codex/sessions history hyp client history import codex imports. HypAware never',
        'parses the opaque ~/Library/Application Support/Codex app container,',
        'and loses no Desktop history by not doing so. Claude Desktop has no',
        'such settings file: its configuration surface is a root-owned',
        'managed-preferences plist. Set it up with hyp client claude-desktop install',
        '(attended, with a sudo prompt) and check it with hyp client claude-desktop',
        'verify, when that plugin is active.',
        '',
        'Run hyp status to see which clients are configured and attached.',
        '--dry-run reports what would change without writing.',
      ].join('\n'),
      run: runAttach,
    },
    {
      name: 'client status',
      category: 'capture-movement',
      audience: 'everyday',
      bootProfile: 'none',
      summary: 'Show configured, attached, and recently active AI clients',
      usage: coreUsage('client status'),
      run: runClientStatus,
    },
    {
      name: 'client detach',
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Detach an AI client from HypAware capture',
      usage: 'hyp client detach [client] [--client <name>] [--dry-run] [--purge] [--json]',
      help: [
        'Removes the HypAware-managed settings hyp client attach wrote, leaving the',
        'client\'s own configuration otherwise intact. hyp unattach is an alias.',
        '',
        'Detaching stops future capture for that client; it does not delete',
        'anything already recorded (see hyp privacy purge for that).',
        'A detach keeps the local interception CA, and any OS trust store',
        'grant an earlier release was given: no attach re-creates that grant,',
        'so it is a leftover rather than a convenience being held for you.',
        '--purge removes the CA and that trust as well.',
        '--dry-run reports what would change without writing.',
      ].join('\n'),
      aliases: ['detach', 'unattach'],
      run: runDetach,
    },
    {
      name: 'privacy ignore',
      aliases: ['ignore'],
      summary: 'Exclude a folder subtree from recording or forwarding',
      usage: 'hyp privacy ignore [path] [--check] [--json] [--local-only | --private | --sync]',
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
        'The --local-only/--private/--sync/--check controls also have explicit',
        'forms under hyp privacy set/show. Bare hyp privacy ignore [path]',
        '(the .hypignore dotfile author) is not deprecated.',
      ].join('\n'),
      run: runIgnore,
    },
    {
      name: 'privacy unignore',
      aliases: ['unignore'],
      summary: 'Resume recording for a previously ignored folder',
      usage: 'hyp privacy unignore [path] [--local-only | --private | --sync]',
      help: [
        'Removes the governing .hypignore. With --local-only, --private, or',
        '--sync, removes machine-local entries of that class instead',
        '(symmetric with the matching hyp privacy ignore flag).',
        '',
        'The --local-only/--private/--sync controls also have an explicit',
        'form under hyp privacy unset. Bare hyp privacy unignore [path]',
        '(the .hypignore remover) is not deprecated.',
      ].join('\n'),
      run: runUnignore,
    },
    makeGroupCommand({
      registry,
      name: 'privacy',
      aliases: ['policy'],
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Control recording, synchronization, deletion',
      help: [
        'Use set/show/unset for machine-local usage classes without writing a',
        '.hypignore dotfile. list enumerates every machine-local entry on this',
        'machine. client and folders set the two',
        'standing preferences (which clients sync, and whether new folders are',
        'asked about at all).',
      ].join('\n'),
    }),
    {
      name: 'privacy set',
      aliases: ['policy set'],
      summary: 'Mark a folder machine-local sync, local-only, or ignore',
      usage: 'hyp privacy set <path> sync|local-only|ignore',
      run: runPolicySet,
    },
    {
      name: 'privacy show',
      aliases: ['policy show'],
      summary: 'Report the usage class governing a folder and its source',
      usage: 'hyp privacy show [path] [--json]',
      run: runPolicyShow,
    },
    {
      name: 'privacy unset',
      aliases: ['policy unset'],
      summary: 'Remove machine-local markings governing a folder (optionally scoped to one class)',
      usage: 'hyp privacy unset <path> [sync|local-only|ignore]',
      help: [
        'With no trailing class token, removes every machine-local entry governing',
        '<path> (class-neutral: back to the implicit default). With a trailing',
        'sync/local-only/ignore token, removes only entries of that class.',
      ].join('\n'),
      run: runPolicyUnset,
    },
    {
      name: 'privacy list',
      aliases: ['policy list'],
      summary: 'Enumerate machine-local usage-class entries',
      usage: 'hyp privacy list [--json]',
      run: runPolicyList,
    },
    {
      name: 'privacy client',
      aliases: ['policy client'],
      summary: 'Keep a client local-only, or return it to the sync-by-default',
      usage: 'hyp privacy client [<name>] [sync|local-only] [--json]',
      help: [
        'On a machine connected to a server, every configured client syncs by',
        'default. `privacy client <name> local-only` keeps that client\'s rows on',
        'this machine; `privacy client <name> sync` removes the opt-out (future',
        'rows only - rows withheld while local-only are never uploaded). Clients',
        'your fleet config carries always sync and cannot be opted out. With no',
        'arguments, lists the opted-out clients.',
      ].join('\n'),
      run: runPolicyClient,
    },
    {
      name: 'privacy folders',
      aliases: ['policy folders'],
      summary: 'Let new folders sync (default), or be asked once about each',
      usage: 'hyp privacy folders [ask|sync] [--json]',
      help: [
        'On a machine connected to a server, folders you have not marked sync',
        'without asking. `privacy folders ask` turns on the per-folder question:',
        'a session opened somewhere new asks once how to handle it. `privacy',
        'folders sync` returns to the default. With no argument, reports the',
        'current setting; `hyp setup` asks for it in its own step.',
        '',
        'This gates the question only. Folders you already marked keep their class,',
        'and .hypignore files are unaffected, in either setting.',
      ].join('\n'),
      run: runPolicyFolders,
    },
    {
      name: 'privacy purge',
      aliases: ['purge'],
      summary: 'Delete already-cached rows from the local cache (destructive)',
      usage: 'hyp privacy purge <path> | --session <id> | --ignored | --all [--yes] [--json]',
      help: [
        'Permanently deletes recorded rows from THIS machine\'s local cache.',
        'Never contacts a sink or the remote and never deletes exported copies.',
        'Exactly one target is required:',
        '  <path>          rows whose cwd equals or descends from the path',
        '  --session <id>  one session\'s rows',
        '  --ignored       every row whose directory currently resolves to ignore',
        '  --all           every recorded row, wholesale',
        'Marking (hyp privacy ignore) stays non-destructive; purge is the separate step.',
        'Prompts on a TTY; pass --yes to delete non-interactively.',
      ].join('\n'),
      run: runPurge,
    },
    makeGroupCommand({
      registry,
      name: 'client skills',
      aliases: ['skills'],
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Manage skills and subagents for AI clients',
    }),
    {
      // Subagents install here too. The split into a second `agents install`
      // was an implementation shape (directory copy vs file copy), not a
      // distinction a user asking for their helpers makes.
      // @ref LLP 0138#one-command [implements]: one install command for both
      //   kinds of client asset; no separate agents verb.
      name: 'client skills install',
      aliases: ['skills install'],
      summary: 'Install registered skills and subagents into AI client directories',
      usage: 'hyp client skills install [--client <name>]',
      run: runSkillsInstall,
    },
    makeGroupCommand({
      registry,
      name: 'daemon',
      category: 'additional',
      audience: 'operator',
      bootProfile: 'none',
      summary: 'Manage the HypAware daemon (install, start, stop, status, ...)',
    }),
    {
      name: 'daemon install',
      bootProfile: 'none',
      summary: 'Install the persistent user service (launchd / systemd)',
      usage: 'hyp daemon install [--config <path>] [--bin <path>] [--dry-run [--json]]',
      run: runDaemonInstall,
    },
    {
      name: 'daemon uninstall',
      bootProfile: 'none',
      summary: 'Uninstall the persistent user service and detach its clients (keeps config, recordings, logs)',
      usage: coreUsage('daemon uninstall'),
      help: [
        'Removes the launchd / systemd service, then detaches every attached',
        'client so none is left pointing at a gateway port that no longer',
        'answers. Config, recordings, and logs stay.',
      ].join('\n'),
      run: runDaemonUninstall,
    },
    {
      name: 'daemon run',
      bootProfile: 'none',
      summary: 'Run the HypAware daemon in the foreground',
      usage: 'hyp daemon run --foreground [--config <path>]',
      run: runDaemonRun,
    },
    {
      name: 'daemon start',
      bootProfile: 'none',
      summary: 'Start the installed daemon service',
      usage: coreUsage('daemon start'),
      run: runDaemonStart,
    },
    {
      name: 'daemon status',
      bootProfile: 'none',
      summary: 'Print the running daemon’s health snapshot',
      usage: coreUsage('daemon status'),
      run: runDaemonStatus,
    },
    {
      name: 'daemon stop',
      bootProfile: 'none',
      summary: 'Signal the running daemon to shut down',
      usage: coreUsage('daemon stop'),
      run: runDaemonStop,
    },
    {
      name: 'daemon restart',
      bootProfile: 'none',
      summary: 'Stop the daemon (and direct the operator to relaunch)',
      usage: coreUsage('daemon restart'),
      run: runDaemonRestart,
    },
    {
      name: 'sync',
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Send captured data to destinations now',
      usage: 'hyp sync [instance] [--yes] [--dry-run]',
      help: [
        'Exports now instead of waiting for the sink schedule. Prints what would',
        'leave this machine and asks before sending; --yes skips the prompt and',
        '--dry-run shows the plan without sending anything.',
        '',
        'On a newly enrolled machine the first sync is held until a printed',
        'deadline so you can review the captured history first (hyp status shows',
        'the deadline). Running hyp sync releases that hold early, and the hold',
        'is all-or-nothing: it cannot be released for one sink instance only.',
      ].join('\n'),
      run: runSync,
    },
    makeGroupCommand({
      registry,
      name: 'sink',
      category: 'additional',
      audience: 'operator',
      summary: 'Maintain sink instances (to export now, see `hyp sync`)',
    }),
    {
      name: 'sink maintain',
      summary: 'Run export maintenance (snapshot expiration; data-file compaction with --compact) on table-format sinks',
      usage: 'hyp sink maintain [instance] [--compact] [--dry-run]',
      run: runSinkMaintain,
    },
    {
      name: 'mcp serve',
      aliases: ['mcp'],
      category: 'additional',
      audience: 'operator',
      summary: 'Serve this host\'s verbs as an MCP server for AI clients',
      usage: 'hyp mcp serve [--remote <target>]',
      run: runMcp,
    },
    makeGroupCommand({
      registry,
      name: 'remote',
      category: 'additional',
      audience: 'operator',
      summary: 'Manage remote MCP query targets and tokens',
    }),
    {
      name: 'remote add',
      summary: 'Register a remote MCP query target in local config',
      usage: coreUsage('remote add'),
      run: runRemoteAdd,
    },
    {
      name: 'remote login',
      summary: 'Store the query-scoped token for a remote target (0600)',
      usage: coreUsage('remote login'),
      help: [
        'Browser sign-in by default; --token-file/stdin for a static token,',
        '--org <name> to select an org, --no-browser to print the URL,',
        '--host <label> to override the forwarding host label (default: hostname),',
        '--no-forward to sign in for queries only (no organization enrollment),',
        '--no-daemon to provision the sink without installing the service.',
      ].join('\n'),
      run: runRemoteLogin,
    },
    {
      name: 'remote mint',
      summary: 'Mint a CI enrollment token for one shared gateway (printed once)',
      usage: coreUsage('remote mint'),
      help: [
        'Requires a logged-in session (hyp remote login). The token enrolls CI',
        'runs under one shared gateway via `hyp join`; default expiry 365 days',
        '(--expires-days <n>), --label names the gateway.',
      ].join('\n'),
      run: runRemoteMint,
    },
    {
      name: 'remote list',
      summary: 'List remote targets and token status (never the token)',
      usage: coreUsage('remote list'),
      run: runRemoteList,
    },
    {
      name: 'remote remove',
      summary: 'Remove a remote target and its stored token',
      usage: coreUsage('remote remove'),
      run: runRemoteRemove,
    },
    // @ref LLP 0155#not-verbs [constrained-by]: report subcommands stay REST commands, never ctx.verbs; MCP report tools are the server's to register
    makeGroupCommand({
      registry,
      name: 'report',
      category: 'explore-share',
      audience: 'everyday',
      summary: 'Render and manage reports',
      help:
        "'render' is a LOCAL build step: it turns a reports tree's Markdown into\n" +
        'a static HTML site and takes no --remote and no credential.\n' +
        '\n' +
        'The rest talk to the server. Reports are server-hosted (there is no\n' +
        'local reports plane), so publish/list/get/delete each take --remote\n' +
        '<target> and default to the default remote target, the same resolution\n' +
        'as bare --remote on queries. Reads use your login session; publish and\n' +
        'delete need the publisher role (or an operator-minted publish token\n' +
        "stored via 'hyp remote login <target> --token-file <path>').",
    }),
    {
      // @ref LLP 0196#mechanics-as-code [implements]: local, credential-free build step in the report group; see runReportRender for why it lives here
      name: 'report render',
      summary: 'Build the static HTML site for a local reports tree (no server involved)',
      usage: coreUsage('report render'),
      help: [
        'Renders every top-level <slug>.md (plus its optional <slug>/ section',
        'directory) into html/<slug>/, and refreshes the shared assets. <dir>',
        'defaults to ~/hypaware-reports.',
        '',
        'html/ is wiped and rebuilt every run, so a deleted or renamed report',
        'never leaves stale HTML behind. Report .md sources are never modified,',
        'and assets/theme.css is yours: it is copied into each page but never',
        'overwritten. Pass --no-refresh-assets to leave the other assets alone',
        'too.',
      ].join('\n'),
      run: runReportRender,
    },
    {
      name: 'report publish',
      summary: "Publish a report (single .html/.md file, or a folder bundle) to the org's reports plane",
      usage: coreUsage('report publish'),
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
      usage: coreUsage('report list'),
      run: runReportList,
    },
    {
      name: 'report get',
      summary: "Fetch a report's entry document (or one artifact) to stdout or --output",
      usage: coreUsage('report get'),
      run: runReportGet,
    },
    {
      name: 'report delete',
      summary: "Delete a published report from the org's reports plane (destructive)",
      usage: coreUsage('report delete'),
      help: 'Org-wide and permanent: the report disappears for every member.\nPrompts on a TTY; pass --yes to delete non-interactively.',
      run: runReportDelete,
    },
    {
      name: 'version',
      category: 'additional',
      audience: 'operator',
      bootProfile: 'none',
      summary: 'Print version and environment info',
      usage: coreUsage('version'),
      run: runVersion,
    },
    {
      name: 'update',
      category: 'additional',
      audience: 'operator',
      bootProfile: 'none',
      summary: 'Update HypAware to the latest release now',
      usage: coreUsage('update'),
      help: 'Checks the npm registry, installs a newer release with npm install -g,\nand restarts the installed daemon so the running code matches.',
      run: runUpdate,
    },
    {
      name: 'dev smoke',
      aliases: ['smoke'],
      category: 'dev',
      audience: 'developer',
      bootProfile: 'none',
      summary: 'Run a smoke flow under a fresh tmp HYP_HOME (internal)',
      usage: 'hyp dev smoke <flow-name>',
      hidden: true,
      run: runSmoke,
    },
  ]
}

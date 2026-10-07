// @ts-check

import { runBackfill, runBackfillList } from '../commands/backfill.js'
import { runRemoteAdd, runRemoteList, runRemoteLogin, runRemoteMint, runRemoteRemove } from './remote_commands.js'
import { runReportDelete, runReportFix, runReportGet, runReportGenerate, runReportList, runReportMark, runReportPublish, runReportRecommend, runReportSave } from './report_commands.js'
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
import { runTelemetry } from '../product_telemetry/commands.js'

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
 * groups have no bare command, so without a registered description their
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
      name: 'telemetry',
      category: 'privacy',
      audience: 'everyday',
      bootProfile: 'none',
      summary: 'Inspect and control optional product telemetry',
      usage: coreUsage('telemetry'),
      help: 'Off by default on a standalone install; automatic for an enrolled organization unless a preference is saved. Local mode retains a bounded preview queue. Organization mode uses the existing enrolled gateway. Vendor sharing and standalone registration are unavailable. Preview prints the exact next queued payload. Off removes pending copies, not records already accepted remotely.',
      run: runTelemetry,
    },
    {
      name: 'status',
      category: 'getting-started',
      audience: 'everyday',
      bootProfile: 'none',
      summary: 'Check capture, clients, storage, and health',
      usage: coreUsage('status'),
      help: [
        'Check daemon health, storage, and each configured client\'s sharing policy.',
        'Problems and next steps appear under Attention. Sync describes policy,',
        'not confirmation that data was delivered.',
        '--verbose includes plugins, paths, proxy trust, maintenance, and setup history.',
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
      summary: 'Manage AI clients',
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
        '  --org <label|*>   with --remote, read one org by label or every org this\n' +
        '                    account may read; operator-only, and each read is\n' +
        "                    recorded in that org's audit trail.\n" +
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
    // @ref LLP 0447#surface [implements]: backfill is the sole import spelling
    {
      name: 'backfill',
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Import client history from backfill providers',
      usage: 'hyp backfill [provider...] [--since <iso>] [--until <iso>] [--retention-days <n>] [--dry-run] [--json]',
      help: [
        'Backfill reads session history a client kept on disk but the live',
        'capture lane never saw: sessions from before HypAware attached, or',
        'that ran outside the proxy. Start with list, which names every',
        'registered provider, then run one with --dry-run: it scans and',
        'projects exactly as an import would, reports what it found, and',
        'writes no row.',
      ].join('\n'),
      run: runBackfill,
    },
    {
      name: 'backfill list',
      aliases: ['client history providers'],
      summary: 'List registered backfill providers',
      usage: coreUsage('backfill list'),
      run: runBackfillList,
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
      summary: 'List active plugins and their provenance, plus installed plugins',
      usage: coreUsage('plugin list'),
      run: runPluginList,
    },
    {
      name: 'plugin info',
      summary: 'Show details for an installed or bundled plugin',
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
      usage: 'hyp config validate [file]',
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
        'On a terminal, runs the walkthrough: choose local or cloud collection',
        'and which clients to record, then write config, install the daemon,',
        'and attach clients. Export and retention use pathway defaults.',
        'Without a terminal, prints a guide for an agent to ask the person',
        'and run unattended setup. The guide prints on stdout and exits 0.',
        '  --guide                print that guide even on a terminal; use alone',
        '',
        'Pass a preset name to skip the walkthrough. Passing any flag below also',
        'skips it: the non-interactive path is chosen by the presence of a flag,',
        'so --yes is a way to ask for it with no other options, not a prefix the',
        'other flags need.',
        '',
        '  --yes, -y              accept the defaults (captures claude + otel',
        '                         when no --source and no --client is given)',
        '  --client <name>        client to capture: claude, claude-desktop, codex,',
        '                         cursor, opencode, pi (repeatable)',
        '  --source <name>        source to capture (repeatable)',
        '  --github               enable GitHub collection (separate opt-in);',
        '                         then run hyp github login to sign in',
        '  --no-backfill          skip optional one-time history imports;',
        '                         scheduled recovery imports still run',
        '  --export <choice>      keep-local | local-parquet | configure-later',
        '  --retention-days <n>   how long to keep cached rows',
        '  --from-file <path>     write a v2 config read from this JSON file,',
        '                         skipping the picker entirely',
        '  --no-daemon            write the config but do not install the daemon',
        '  --dry-run              report what would be written, write nothing',
        '  --force                replace an existing config (backed up first);',
        '                         allow a temporary CLI if global installation fails',
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
        'With no argument, asks the one question worth asking first: which skill',
        'would be the most useful to add. HypAware looks through the last 30 days',
        'itself for what you type again and again and what your agent then ran,',
        'writes that evidence into $HYP_HOME/ask (one folder, rewritten each',
        'time), and starts a recorded client in that folder so the session',
        'stays out of whatever repo you ran it from. The client answers with',
        'one skill and offers to write it.',
        '',
        'With a question, skips all of that and starts straight on it:',
        '  hyp ask "which sessions touched the auth module last week"',
        '',
        'Only clients HypAware is recording (hyp status) and whose CLI is on',
        'your PATH can be started: recording means attached, or configured with',
        'no attach marker to write, as codex is in its transcript mode. Claude',
        'Desktop has no prompt argument, and only Claude Code and Codex are',
        'shipped the skills the questions rely on, so no other recorded client',
        'is started here. The refusal names yours when that is why it stopped.',
      ].join('\n'),
      run: runAsk,
    },
    {
      name: 'join',
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Connect this machine to a HypAware server',
      usage: 'hyp join <url> [token] [--token-file <path>] [--bin <path>] [--no-daemon] [--force]',
      help: 'Token sources (pick one): positional argument, --token-file, or stdin.\nA bare argv token lands in shell history; scripts should prefer\n--token-file or stdin.\n--force allows the existing CLI path if global installation fails.',
      run: runJoin,
    },
    {
      name: 'leave',
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Disconnect central management, keep local history',
      usage: 'hyp leave',
      help: 'Disconnects this machine from a HypAware server: stops forwarding\nand config pull, undoes org-driven client attaches, and removes the\nforward credential. Keeps query sessions, the local config, and the\ndaemon service.',
      run: runLeave,
    },
    {
      name: 'client attach',
      aliases: ['attach'],
      category: 'capture-movement',
      audience: 'everyday',
      summary: 'Attach an AI client to HypAware capture',
      usage: 'hyp client attach [client] [--dry-run] [--json]',
      help: [
        'Configures an AI client for HypAware capture by writing managed settings',
        'into that client\'s own config file. Claude Code exports OTEL telemetry',
        'and raw body files; gateway-backed clients use the local gateway.',
        'Idempotent: re-running is a no-op. Reversible with hyp client detach, which',
        'removes only the managed settings.',
        '',
        'hyp client attach codex covers Codex Desktop as well as the Codex CLI - both',
        'read the ~/.codex/config.toml this writes and both write the',
        '~/.codex/sessions history hyp backfill codex imports. HypAware never',
        'parses the opaque ~/Library/Application Support/Codex app container,',
        'and loses no Desktop history by not doing so. Claude Desktop also needs',
        'no attach: selecting it in hyp init enables a scheduled import of its',
        'local transcripts. Its managed-profile install commands are an optional',
        'live-route experiment, not the normal capture path.',
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
      usage: 'hyp client detach [client] [--dry-run] [--purge] [--json]',
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
      usage: 'hyp privacy ignore [path]',
      help: 'Writes a .hypignore so HypAware never records this folder subtree.\nUse hyp privacy set/show/unset for machine-local policy.',
      run: runIgnore,
    },
    {
      name: 'privacy unignore',
      aliases: ['unignore'],
      summary: 'Resume recording for a previously ignored folder',
      usage: 'hyp privacy unignore [path]',
      help: 'Removes the governing .hypignore.\nUse hyp privacy unset to remove machine-local markings.',
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
        'On a machine connected to a HypAware server, every configured client',
        'syncs by default. `privacy client <name> local-only` keeps that',
        'client\'s rows on this machine; `privacy client <name> sync` removes',
        'the opt-out for future rows. It then names `hyp sync --history <name>`',
        'when you deliberately want to upload retained history too. Clients',
        'set by your team always sync and cannot be opted out. With no',
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
        'On a machine connected to a HypAware server, folders you have not',
        'marked sync without asking. `privacy folders ask` turns on the',
        'per-folder question: a session opened somewhere new asks once how to',
        'handle it. `privacy folders sync` returns to the default. With no',
        'argument, reports the current setting; `hyp setup` asks for it in its',
        'own step.',
        '',
        'This gates the question only. Folders you already marked keep their class,',
        'and .hypignore files are unaffected, in either setting.',
      ].join('\n'),
      run: runPolicyFolders,
    },
    {
      name: 'privacy purge',
      aliases: ['purge'],
      summary: 'Delete recorded rows; session purges include configured servers',
      usage: 'hyp privacy purge <path> | --session <id> [--remote <target> | --local-only] | --ignored | --all [--yes] [--json]',
      help: [
        'Position-deletes recorded rows from this machine\'s local cache.',
        'Session purges also exclude future recording and drain pending spool rows.',
        'Session purges automatically include configured and signed-in remotes and enrolled servers.',
        '--remote <target> limits the remote scope to one server; --local-only skips servers.',
        'Remote deletion requires the session owner or an organization admin.',
        'Physical files remain until compaction; copies in derived reports are not covered.',
        'Remote failures return a nonzero exit status; retry to finish incomplete purges.',
        'Non-session targets only purge locally.',
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
      usage: 'hyp client skills install [--client <name>] [--attached]',
      help: 'Use --attached to install only for clients with a current HypAware attach marker.',
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
      usage: 'hyp daemon install [--config <path>] [--bin <path>] [--force] [--dry-run [--json]]',
      help: '--force allows the existing CLI path if global installation fails; removing that directory can break capture.',
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
      usage: 'hyp daemon run [--config <path>]',
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
      usage: 'hyp sync [instance] [--history <client>] [--yes] [--dry-run]',
      help: [
        'Exports now instead of waiting for the sink schedule. Prints what would',
        'leave this machine and asks before sending; --yes skips the prompt and',
        '--dry-run shows the plan without sending anything.',
        '',
        'On a newly enrolled machine the first sync is held until a printed',
        'deadline so you can review the captured history first (hyp status shows',
        'the deadline). Running hyp sync releases that hold early, and the hold',
        'is all-or-nothing: it cannot be released for one sink instance only.',
        '',
        '`hyp sync --history <client>` previews and replays locally retained',
        'history for a client that is already syncing. Only replay-safe',
        'destinations participate, and ordinary sink watermarks are unchanged.',
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
      usage: 'hyp mcp serve [--remote <target> [--org <label|*>]]',
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
        '--no-daemon to provision the sink without installing the service,',
        '--force to allow the existing CLI path if global installation fails.',
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
      summary: 'Generate and manage reports',
      help:
        "'generate' starts a recorded AI client with the report skill in the\n" +
        "current directory. Optional instructions set its period and focus.\n" +
        "'save' moves the finished folder into $HYP_HOME/reports, where 'list'\n" +
        "shows it and 'publish' takes it by name.\n\n" +
        'The rest talk to the remote. Reports are hosted there (there is no\n' +
        'local reports plane), so publish/recommend/list/get/fix/mark/delete each\n' +
        'take --remote <target> and default to the default remote target, the same\n' +
        'resolution as bare --remote on queries. Reads use your login session;\n' +
        'publish, recommend, mark and delete need the publisher role (or an\n' +
        "operator-minted publish token stored via 'hyp remote login <target>\n" +
        "--token-file <path>').",
    }),
    {
      name: 'report generate',
      summary: 'Start a recorded AI client to generate a local report',
      usage: coreUsage('report generate'),
      help: [
        'Starts a recorded client with the hypaware-report skill in the current',
        'working directory. Recorded means attached, or configured with no attach',
        'marker to write, as codex is in its transcript mode. Optional quoted',
        'instructions can specify the reporting period and focus; the skill',
        'defaults to the previous calendar month. Publishing requires an explicit',
        'request. If more than one recorded client has the skill, asks which on a',
        'terminal; otherwise starts one without asking. The client takes over the',
        'terminal with its normal permissions and is recorded under the current',
        'directory\'s own usage class. This is not session isolation: excerpts it',
        'reads out of local-only history are quoted into a transcript that syncs',
        'if this directory does. No remote login is required. The skill drafts',
        "here and finishes with 'hyp report save', which moves the folder into",
        '$HYP_HOME/reports.',
      ].join('\n'),
      run: runReportGenerate,
    },
    {
      name: 'report save',
      summary: 'Move a finished report folder into $HYP_HOME/reports, where list and publish find it',
      usage: coreUsage('report save'),
      help: [
        'The folder must hold report.md and only the pages publish accepts',
        '(usage.md, work.md, health.md, recommendation-<slug>.md), so the store',
        'never holds working notes, raw logs, or stray files; anything else is',
        'refused before a byte moves. The folder keeps its name, with -2, -3,',
        '... if the name is taken. By default the source folder is removed once',
        'its pages are copied (only those pages are removed, never a file that',
        'appeared since); --keep leaves it. The receipt names the saved folder',
        "and the 'hyp report publish <name> ...' that shares it. This is the step",
        'the hypaware-report skill ends with, so an agent never writes under',
        'your home directory itself.',
      ].join('\n'),
      run: runReportSave,
    },
    {
      name: 'report publish',
      summary: "Publish Markdown report sources for the remote to render and share with the org",
      usage: coreUsage('report publish'),
      help: [
        'Upload a .md/.markdown file, or a folder containing report.md plus',
        'usage.md, work.md, health.md, and recommendation-<slug>.md pages',
        '(the legacy change-<slug>.md spelling is also accepted). A slug is',
        'lowercase and matches [a-z0-9][a-z0-9-]*. Folders must contain only',
        'supported Markdown files. HTML, raw HTML inside Markdown, images,',
        'and client assets are not accepted. Put HTML examples in code',
        'fences. A bare name that is no path here publishes the saved report',
        "of that name from $HYP_HOME/reports ('hyp report list --local' shows",
        'them). The remote renders the report for the team; no local',
        'rendering step is needed. Folder uploads use system tar',
        "with --format=ustar. kind names the report family (e.g.",
        "usage-review); period is the covered slice (e.g. 2026-W29).",
        '--org applies only with the operator admin token, which must name',
        'its org explicitly.',
      ].join('\n'),
      run: runReportPublish,
    },
    {
      name: 'report recommend',
      summary: 'Publish one recommendation page on its own, with no report around it',
      usage: coreUsage('report recommend'),
      help: [
        'Upload a single recommendation page (.md/.markdown), written like a',
        "recommendation-<slug>.md page inside a report: the first '# ' heading is",
        'the title (--title overrides it) and the bold paragraph under it the',
        "thesis. The remote wraps it in a report of kind 'recommendation' whose",
        'period is the publish date, mints its hyprec- id, and renders it; the',
        "receipt prints the id and the 'hyp report get <id>' that reads it.",
        'Repeat uploads of the same content answer with the existing id. Needs',
        'the publisher role, like publish.',
      ].join('\n'),
      run: runReportRecommend,
    },
    {
      name: 'report list',
      summary: "List the org's published reports (newest first) and this machine's saved ones",
      usage: coreUsage('report list'),
      help: [
        "Saved reports ($HYP_HOME/reports, as 'hyp report save' leaves them) follow",
        'the published ones in their own section, newest first by report.md',
        'mtime, at most 100 with the rest counted. --local lists that section',
        'alone, with no remote read, and takes no remote filter. When nothing',
        'selects or filters the remote and it cannot be read, saved reports are',
        'still listed under a warning; --json keeps the failure instead.',
        'Under each report, one line per recommendation: id, [state], page, and',
        'title. The state is open, in_progress, applied, or dismissed; a',
        "recommendation nobody has marked is open. --recommendations lists the",
        'recommendations themselves, flat across reports (a standalone one says',
        "'standalone' where its report would be); --status <state,...> filters",
        "them and implies --recommendations. --json prints the remote's records whole",
        'and nothing else; --local --json prints the saved reports.',
      ].join('\n'),
      run: runReportList,
    },
    {
      name: 'report get',
      summary: "Fetch a report's entry document (or one artifact) to stdout or --output",
      usage: coreUsage('report get'),
      help: [
        "Given a recommendation id instead (hyprec-0123456789abcdef, as 'hyp report",
        "list' prints under each report), fetches that recommendation's page",
        'with the evidence it cites and the queries the report ran to reach it',
        'appended. This is the read to make when asked to fix a recommendation',
        'by id from inside an AI client session.',
      ].join('\n'),
      run: runReportGet,
    },
    {
      name: 'report fix',
      summary: "Start a recorded AI client on one of a report's recommendations, here",
      usage: coreUsage('report fix'),
      help: [
        "The id is a recommendation's, as 'hyp report list' prints under each",
        'report (hyprec-0123456789abcdef). HypAware checks the recommendation still',
        'exists and starts a recorded client in the current directory with',
        "instructions to read it through 'hyp report get <id>' and make the",
        'change here; nothing is written to disk. Recorded means attached, or',
        'configured with no attach marker to write, as codex is in its transcript',
        'mode. With no id on a terminal, pick a report (newest first), then one',
        'of its recommendations (--kind, --period and --limit narrow which',
        'reports). If more than one recorded client could be started, it asks',
        'which on a terminal; an id given off a terminal starts one without',
        'asking. The client takes over the terminal; nothing is pre-authorised.',
      ].join('\n'),
      run: runReportFix,
    },
    {
      name: 'report mark',
      summary: 'Record what became of a recommendation: open, in_progress, applied, or dismissed',
      usage: coreUsage('report mark'),
      help: [
        "The id is a recommendation's, as 'hyp report list' prints. The state is",
        "the remote's vocabulary; any state may follow any other, so marking one",
        'open again is the same verb. --reason is required for dismissed and',
        'is what the next reader sees in place of the change; --link (repeatable)',
        'takes absolute http(s) URLs, the pull request that landed it most of all.',
        "'hyp report get <id>' shows the current state and the history. Needs the",
        'publisher role, like publish.',
      ].join('\n'),
      run: runReportMark,
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

// @ts-check

import { runBackfill, runBackfillList, runBackfillPlan } from '../commands/backfill.js'
import { runRemoteAdd, runRemoteList, runRemoteLogin, runRemoteRemove } from './remote_commands.js'
import { runReportDelete, runReportGet, runReportList, runReportPublish, runReportRender } from './report_commands.js'
import { CORE_VERBS } from './core_verbs.js'
import { verbToCommand } from './verb_command.js'
import { makeGroupCommand } from './group_help.js'
import { runStatus } from '../commands/status.js'
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
      name: 'query',
      summary: 'Query the local cache (sql, schema, status, ...)',
      help:
        'Query-executing subcommands (e.g. sql) accept kernel control flags:\n' +
        '  --format <fmt>    --output <file>    --max-cell <n>    --max-bytes <n>\n' +
        '  --remote [target] run against a remote MCP target instead of the local\n' +
        '                    cache (bare --remote uses query.default_remote, else the\n' +
        "                    shipped default; manage targets with 'hyp remote').\n" +
        "See 'hyp query <subcommand> --help' for which flags a subcommand supports\n" +
        '(overview/schema/refresh/maintain are local-only; query status rejects\n' +
        '--remote with exit 2 rather than answering about the wrong host).',
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
      usage: 'hyp init [preset] [flags]',
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
      summary: 'Start your AI client on a question about your recorded sessions',
      usage: 'hyp ask ["question"] [--list]',
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
      help: [
        'Points an AI client at the local gateway so its traffic is captured, by',
        'writing HypAware-managed settings into that client\'s own config file.',
        'Idempotent: re-running is a no-op. Reversible with hyp detach, which',
        'removes only the managed settings.',
        '',
        'hyp attach codex covers Codex Desktop as well as the Codex CLI - both',
        'read the ~/.codex/config.toml this writes and both write the',
        '~/.codex/sessions history hyp backfill codex imports. HypAware never',
        'parses the opaque ~/Library/Application Support/Codex app container,',
        'and loses no Desktop history by not doing so. Claude Desktop has no',
        'such settings file: its configuration surface is a root-owned',
        'managed-preferences plist. Set it up with hyp claude-desktop install',
        '(attended, with a sudo prompt) and check it with hyp claude-desktop',
        'verify, when that plugin is active.',
        '',
        'Run hyp status to see which clients are configured and attached.',
        '--dry-run reports what would change without writing.',
      ].join('\n'),
      run: runAttach,
    },
    {
      name: 'detach',
      summary: 'Detach an AI client from the local gateway',
      usage: 'hyp detach [client] [--client <name>] [--dry-run] [--purge] [--json]',
      help: [
        'Removes the HypAware-managed settings hyp attach wrote, leaving the',
        'client\'s own configuration otherwise intact. hyp unattach is an alias.',
        '',
        'Detaching stops future capture for that client; it does not delete',
        'anything already recorded (see hyp purge for that).',
        'A proxy-mode detach keeps the local interception CA and its keychain',
        'trust so a later re-attach needs no new password dialog; --purge',
        'removes both as well.',
        '--dry-run reports what would change without writing.',
      ].join('\n'),
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
        'machine-local entry on this machine; client and folders set the two',
        'standing preferences (which clients sync, and whether new folders are',
        'asked about at all).',
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
      name: 'policy client',
      summary: 'Keep a client local-only, or return it to the sync-by-default',
      usage: 'hyp policy client [<name>] [sync|local-only] [--json]',
      help: [
        'On a machine connected to a server, every configured client syncs by',
        'default. `policy client <name> local-only` keeps that client\'s rows on',
        'this machine; `policy client <name> sync` removes the opt-out (future',
        'rows only - rows withheld while local-only are never uploaded). Clients',
        'your fleet config carries always sync and cannot be opted out. With no',
        'arguments, lists the opted-out clients.',
      ].join('\n'),
      run: runPolicyClient,
    },
    {
      name: 'policy folders',
      summary: 'Let new folders sync (default), or be asked once about each',
      usage: 'hyp policy folders [ask|sync] [--json]',
      help: [
        'On a machine connected to a server, folders you have not marked sync',
        'without asking. `policy folders ask` turns on the per-folder question:',
        'a session opened somewhere new asks once how to handle it. `policy',
        'folders sync` returns to the default. With no argument, reports the',
        'current setting; `hyp init` asks for it in its own step.',
        '',
        'This gates the question only. Folders you already marked keep their class,',
        'and .hypignore files are unaffected, in either setting.',
      ].join('\n'),
      run: runPolicyFolders,
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
      summary: 'Manage skills and subagents for AI clients',
    }),
    {
      // Subagents install here too. The split into a second `agents install`
      // was an implementation shape (directory copy vs file copy), not a
      // distinction a user asking for their helpers makes.
      // @ref LLP 0138#one-command [implements]: one install command for both
      //   kinds of client asset; no separate agents verb.
      name: 'skills install',
      summary: 'Install registered skills and subagents into AI client directories',
      usage: 'hyp skills install [--client <name>]',
      run: runSkillsInstall,
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
      summary: 'Uninstall the persistent user service and detach its clients (keeps config, recordings, logs)',
      usage: 'hyp daemon uninstall',
      help: [
        'Removes the launchd / systemd service, then detaches every attached',
        'client so none is left pointing at a gateway port that no longer',
        'answers. Config, recordings, and logs stay.',
      ].join('\n'),
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
    {
      name: 'sync',
      summary: 'Send captured data to its destinations now, after confirming what leaves',
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
      summary: 'Maintain sink instances (to export now, see `hyp sync`)',
    }),
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
    // @ref LLP 0155#not-verbs [constrained-by]: report subcommands stay REST commands, never ctx.verbs; MCP report tools are the server's to register
    makeGroupCommand({
      registry,
      name: 'report',
      summary: "Build reports locally, and publish or read them on a server's reports plane",
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
      usage: 'hyp report render [<dir>] [--no-refresh-assets]',
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

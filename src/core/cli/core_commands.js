// @ts-check

import { runBackfill, runBackfillList, runBackfillPlan } from '../commands/backfill.js'
import { runRemoteAdd, runRemoteHelp, runRemoteList, runRemoteLogin, runRemoteRemove } from './remote_commands.js'
import { CORE_VERBS } from './core_verbs.js'
import { verbToCommand } from './verb_command.js'
import { runStatus } from '../commands/status.js'
import {
  runQuery,
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
import { runConfig, runConfigValidate } from '../commands/config.js'
import {
  runDaemonHelp,
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
import { runSinkForce, runSinkHelp, runSinkMaintain } from '../commands/sink.js'
import { runInit } from '../commands/init.js'
import { runJoin, runLeave } from '../commands/central.js'
import {
  runAgentsInstall,
  runAttach,
  runDetach,
  runIgnore,
  runSkillsInstall,
  runUnignore,
} from '../commands/clients.js'

/**
 * @import { CommandRegistration } from '../../../collectivus-plugin-kernel-types.js'
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
  for (const cmd of buildCoreCommands()) {
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

/** @returns {CommandRegistration[]} */
function buildCoreCommands() {
  return [
    {
      name: 'status',
      summary: 'Show kernel status (active plugins, sources, sinks, cache)',
      usage: 'hyp status [--json]',
      run: runStatus,
    },
    {
      name: 'query',
      summary: 'Query the local cache (see subcommands: schema, status, sql, refresh, maintain)',
      usage: 'hyp query <subcommand> [args...]',
      run: runQuery,
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
      summary: 'Import client history from registered backfill providers',
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
    {
      name: 'config',
      summary: 'Inspect or operate on the HypAware config (subcommand: validate)',
      usage: 'hyp config <subcommand> [args...]',
      run: runConfig,
    },
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
      run: runJoin,
    },
    {
      name: 'leave',
      summary: 'Leave the centrally-managed fleet (stop forwarding + config pull, undo org-driven attaches)',
      usage: 'hyp leave',
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
      summary: 'Write a .hypignore so HypAware never records this folder subtree (--check reports status)',
      usage: 'hyp ignore [path] [--check] [--json]',
      run: runIgnore,
    },
    {
      name: 'unignore',
      summary: 'Remove the governing .hypignore so HypAware records this folder subtree again',
      usage: 'hyp unignore [path]',
      run: runUnignore,
    },
    {
      name: 'skills install',
      summary: 'Install registered skills into AI client directories',
      usage: 'hyp skills install [--client <name>]',
      run: runSkillsInstall,
    },
    {
      name: 'agents install',
      summary: 'Install registered subagents into AI client directories',
      usage: 'hyp agents install [--client <name>]',
      run: runAgentsInstall,
    },
    {
      name: 'daemon',
      summary: 'Manage the HypAware daemon (subcommands: install, uninstall, run, start, stop, restart, status)',
      usage: 'hyp daemon <subcommand> [args...]',
      run: runDaemonHelp,
    },
    {
      name: 'daemon install',
      summary: 'Install the persistent user service (launchd / systemd)',
      usage: 'hyp daemon install [--config <path>] [--dry-run [--json]]',
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
    {
      name: 'sink',
      summary: 'Manage sink instances (subcommands: force, maintain)',
      usage: 'hyp sink <subcommand> [args...]',
      run: runSinkHelp,
    },
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
      summary: 'Serve this host\'s verbs as an MCP server over stdio (for AI clients)',
      usage: 'hyp mcp [--remote <target>]',
      run: runMcp,
    },
    {
      name: 'remote',
      summary: 'Manage remote MCP query targets and their tokens (subcommands: add, login, list, remove)',
      usage: 'hyp remote <subcommand> [args...]',
      run: runRemoteHelp,
    },
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

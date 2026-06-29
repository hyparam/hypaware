// @ts-check

import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { migrateLegacyPartitions } from '../cache/migrate.js'
import { readObservabilityEnv } from '../observability/env.js'
import { defaultConfigPath, loadConfigFile, prepareLocalConfigWrite } from '../config/schema.js'
import { centralSeedPath, resetCentralLayerToSeed } from '../config/apply.js'
import { runWalkthrough, runPickerWalkthrough } from './walkthrough.js'
import { select } from './tui/index.js'
import { isPromptCancelledError } from './tui/runtime.js'
import { shouldUseTui } from './tui-router.js'
import { mergeInstalledManifestsIntoKnown, validateConfig } from '../config/validate.js'
import { discoverInstalledPlugins } from '../runtime/installed.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { isWithinDir } from '../runtime/contribution_names.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { collectHypAwareStatus } from '../daemon/status.js'
import { renderSchema, schemaForDataset } from '../query/schema.js'
import { createMcpServer } from '../mcp/server.js'
import { serveStdio } from '../mcp/stdio.js'
import { buildOperationContext } from './verb_command.js'
import { runBackfill, runBackfillList, runBackfillPlan, runBackfillProvider } from '../commands/backfill.js'
import {
  runRemoteAdd,
  runRemoteHelp,
  runRemoteList,
  runRemoteLogin,
  runRemoteRemove,
} from './remote_commands.js'
import { CORE_VERBS } from './core_verbs.js'
import { verbToCommand } from './verb_command.js'

// `query sql` migrated to a verb (LLP 0034 §verbs): it is registered by
// `registerCoreVerbs` and projected into both a CLI command and an MCP
// tool, so its parsing/output no longer lives in this command set. The
// output builder and the render-control defaults moved to their canonical
// homes; re-export them here for the tests that import them by this path.
export { buildQuerySqlOutput } from '../query/format.js'
export { DEFAULT_QUERY_MAX_CELL, DEFAULT_QUERY_MAX_BYTES } from './verb_codec.js'
import {
  installPlugin,
  listInstalledPlugins,
  loadLock,
  removePlugin,
  updatePlugin,
} from '../plugin_install/install.js'
import {
  buildTtyPrompt,
  buildWarnings,
  decideConfirmation,
  renderConfirmationSummary,
} from '../plugin_install/confirm.js'
import { diagnosePlugin } from '../plugin_doctor/diagnose.js'
import { renderReport } from '../plugin_doctor/render.js'
import { SCAFFOLD_KINDS, scaffoldPlugin } from '../plugin_doctor/scaffold.js'

/**
 * @import { AiGatewayCapability, CommandRegistration, CommandRunContext, HypAwareV2Config, PluginName } from '../../../collectivus-plugin-kernel-types.js'
 * @import { ClientDescriptor } from '../plugin_catalog.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { PluginMetadata } from '../../../src/core/config/types.js'
 * @import { DaemonInstallOptions, HypAwareStatusReport, ServiceState } from '../../../src/core/daemon/types.js'
 * @import { ExportMaintenanceDatasetReport } from '../../../hypaware-core/plugins-workspace/format-iceberg/src/types.js'
 * @import { ConfirmInstall } from '../../../src/core/plugin_install/types.js'
 * @import { LoadedManifest } from '../../../src/core/types.js'
 * @import { ExtendedSinkRegistry, ExtendedSourceRegistry } from '../../../src/core/registry/types.js'
 * @import { CommandRegistryExtended, InitFlags, PickerBackfillRunner, PickerExport, PickerExportOrigin } from '../../../src/core/cli/types.js'
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
      name: 'collect',
      summary: 'Collect rows from a registered source (see subcommands: list, remove)',
      usage: 'hyp collect <subcommand> [args...]',
      run: runCollect,
    },
    {
      name: 'collect list',
      summary: 'List configured collectors',
      usage: 'hyp collect list',
      run: runCollectList,
    },
    {
      name: 'collect remove',
      summary: 'Remove a configured collector',
      usage: 'hyp collect remove <name>',
      run: runCollectRemove,
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
      name: 'attach',
      summary: 'Attach an AI client to the local gateway',
      usage: 'hyp attach [client] [--client <name>] [--dry-run] [--json] [--yes]',
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
      summary: 'Mark the current session as ignored by recording sources',
      usage: 'hyp ignore',
      run: runIgnore,
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
      usage: 'hyp remote login <name> [--token-file <path>]',
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

/* ---------- status ---------- */

/**
 * `hyp status [--json]`
 *
 * Renders the V1 install state (config path, daemon install/run
 * state, active plugins, source/sink/client status, cache + retention
 * window, recent error count) and any diagnostics + repair
 * suggestions surfaced by the Phase 8 collector.
 *
 * Span: `status.render`. Attributes match the bead contract
 * (`source_count`, `sink_count`, `cache_size_bytes`,
 * `oldest_partition_date`, `daemon_state`, `diagnostics_count`) and
 * also carry the legacy attributes (`client_count`, `retention_days`)
 * that earlier smokes assert on.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runStatus(argv, ctx) {
  const json = argv.includes('--json')

  /** @type {ExtendedSourceRegistry} */
  const sources = /** @type {any} */ (ctx.sources)
  /** @type {ExtendedSinkRegistry} */
  const sinks = /** @type {any} */ (ctx.sinks)

  const runtimeClientNames = listClientNames(ctx.capabilities)

  const report = await collectHypAwareStatus({
    env: ctx.env,
    runtime: {
      sources,
      sinks,
      capabilities: ctx.capabilities,
      query: ctx.query,
      storage: ctx.storage,
    },
  })

  // Source/sink lists from the report are the canonical set. The
  // walkthrough smoke checks for plugin names in stdout, so we lean
  // on the report's `sources`/`sinks` arrays which include both
  // contributions and running state.
  const sourceRows = report.sources
  const sinkRows = report.sinks
  const clientNames = runtimeClientNames.length > 0
    ? runtimeClientNames
    : report.clients
      .filter((c) => c.configured)
      .map((c) => c.name)
      .sort()
  const registeredDatasets = ctx.query.listDatasets()
  const datasets = registeredDatasets.length > 0
    ? registeredDatasets
    : inferDatasetsFromPlugins(report.activePlugins)

  return withSpan(
    'status.render',
    {
      [Attr.COMPONENT]: 'status',
      [Attr.OPERATION]: 'status.render',
      source_count: sourceRows.length,
      sink_count: sinkRows.length,
      client_count: clientNames.length,
      dataset_count: datasets.length,
      cache_size_bytes: report.cache.totalBytes,
      oldest_partition_date: report.cache.oldestDate ?? '',
      retention_days: report.retention.days,
      active_plugin_count: report.activePlugins.length,
      daemon_state: report.daemon.state ?? (report.daemon.running ? 'running' : 'stopped'),
      diagnostics_count: report.diagnostics.length,
      overall: report.overall,
      format: json ? 'json' : 'text',
      status: 'ok',
    },
    async () => {
      if (json) {
        const payload = renderStatusJson({
          report,
          clientNames,
          datasets,
          cacheRoot: ctx.storage.cacheRoot,
        })
        ctx.stdout.write(JSON.stringify(payload, null, 2) + '\n')
        return 0
      }
      renderStatusText({
        report,
        clientNames,
        datasets,
        cacheRoot: ctx.storage.cacheRoot,
        stdout: ctx.stdout,
      })
      return 0
    },
    { component: 'status' }
  )
}

/**
 * Render the V1 status report as a stable JSON shape. Consumers may
 * pin keys without dispatching on platform; missing values surface as
 * `null` rather than being omitted, so smoke assertions can probe
 * specific fields directly.
 *
 * Excludes any `@hypaware/central` and `@hypaware/gascity` keys per
 * V1 contract (Phase 8 bead): the V1 surface must not require either.
 *
 * @param {{
 *   report: HypAwareStatusReport,
 *   clientNames: string[],
 *   datasets: { name: string, plugin: string }[],
 *   cacheRoot: string,
 * }} args
 */
export function renderStatusJson({ report, clientNames, datasets, cacheRoot }) {
  return {
    overall: report.overall,
    config: {
      path: report.configPath,
      exists: report.configExists,
      valid: report.configValid,
    },
    // V1 stable shape: array of `{name}` so consumers can pin keys
    // without needing to know the version. The collector currently
    // does not track per-plugin version (Phase 2 set version on each
    // entry but it was always 'unknown'); keeping the field reserved
    // lets later phases populate it without breaking smokes. On a
    // centrally-managed host each entry also carries its layer
    // provenance (LLP 0031).
    active_plugins: report.activePlugins.map((name) => ({
      name,
      ...(report.layered
        ? { provenance: report.layered.centralPlugins.includes(name) ? 'central' : 'local' }
        : {}),
    })),
    daemon: {
      installed: report.daemon.installed,
      loaded: report.daemon.loaded,
      running: report.daemon.running,
      state: report.daemon.state ?? 'unknown',
      pid: report.daemon.pid ?? null,
      mode: report.daemon.mode ?? null,
      run_id: report.daemon.runId ?? null,
      platform: report.daemon.platform,
      ...(report.daemon.error ? { error: report.daemon.error } : {}),
    },
    sources: report.sources.map((s) => ({
      name: s.name,
      plugin: s.plugin,
      state: s.state,
      ...(report.layered
        ? { provenance: report.layered.centralPlugins.includes(s.plugin) ? 'central' : 'local' }
        : {}),
      ...(s.error ? { error: s.error } : {}),
    })),
    sinks: report.sinks.map((s) => ({
      instance: s.instance,
      plugin: s.plugin,
      kind: s.kind,
      ...(report.layered
        ? { provenance: report.layered.centralSinks.includes(s.instance) ? 'central' : 'local' }
        : {}),
      ...(s.lastTickAt ? { last_tick_at: s.lastTickAt } : {}),
      ...(s.lastSuccessAt ? { last_success_at: s.lastSuccessAt } : {}),
    })),
    // Backwards-compatible shape: array of registered client names.
    // Phase 8 attach detail lives under `client_attach`.
    clients: clientNames,
    client_attach: report.clients.map((c) => ({
      name: c.name,
      configured: c.configured,
      attached: c.attached,
      ...(report.layered
        ? { provenance: report.layered.centralPlugins.includes(c.plugin) ? 'central' : 'local' }
        : {}),
      ...(c.settingsPath ? { settings_path: c.settingsPath } : {}),
      ...(c.version ? { version: c.version } : {}),
      ...(c.port ? { port: c.port } : {}),
      ...(c.error ? { error: c.error } : {}),
    })),
    datasets: datasets.map((d) => ({ name: d.name, plugin: d.plugin })),
    cache: {
      dir: cacheRoot,
      retention_days: report.retention.days,
      retention_source: report.retention.source,
      size_bytes: report.cache.totalBytes,
      oldest_partition_date: report.cache.oldestDate,
    },
    recent_error_count: report.recentErrorCount,
    // Two-layer provenance (LLP 0031). Null on a host that never joined,
    // so the V1 JSON shape is unchanged for ordinary installs.
    config_layers: report.layered
      ? {
        central: true,
        central_plugins: report.layered.centralPlugins,
        central_sinks: report.layered.centralSinks,
        central_query_ignored: report.layered.centralQueryIgnored,
        local_not_applied: report.layered.drops.map((d) => ({
          section: d.section,
          key: d.key,
          reason: d.reason,
          ...(d.detail ? { detail: d.detail } : {}),
        })),
      }
      : null,
    // Remote-config apply state (LLP 0025). All-null until the gateway
    // applies its first centrally-served config.
    remote_config: report.remoteConfig
      ? {
        running_etag: report.remoteConfig.runningEtag,
        probation: report.remoteConfig.probation
          ? {
            etag: report.remoteConfig.probation.etag,
            applied_at: report.remoteConfig.probation.applied_at,
            until: report.remoteConfig.probation.until,
          }
          : null,
        last_rollback: report.remoteConfig.lastRollback,
        bad_etag: report.remoteConfig.badEtag,
      }
      : null,
    // Client-action reconciler state (LLP 0036 / 0041). Null until a
    // backfill-on-join target is configured or a pass has run; a `failed`
    // entry is informational and never affects `overall`.
    client_actions: report.clientActions
      ? report.clientActions.actions.map((a) => ({
        kind: a.kind,
        request_key: a.requestKey,
        state: a.state,
        ...(a.rows !== undefined ? { rows: a.rows } : {}),
        ...(a.at ? { at: a.at } : {}),
        ...(a.reason ? { reason: a.reason } : {}),
        ...(a.lastAttempt ? { last_attempt: a.lastAttempt } : {}),
        ...(a.attempts !== undefined ? { attempts: a.attempts } : {}),
      }))
      : null,
    diagnostics: report.diagnostics.map((d) => ({
      severity: d.severity,
      kind: d.kind,
      message: d.message,
      repair: d.repair,
      ...(d.pointer ? { pointer: d.pointer } : {}),
    })),
  }
}

/**
 * Render the V1 status report as human-friendly text. Mirrors the
 * JSON shape but groups sections and surfaces diagnostics + repair
 * suggestions at the bottom.
 *
 * @param {{
 *   report: HypAwareStatusReport,
 *   clientNames: string[],
 *   datasets: { name: string, plugin: string }[],
 *   cacheRoot: string,
 *   stdout: { write(chunk: string): unknown },
 * }} args
 */
export function renderStatusText({ report, clientNames, datasets, cacheRoot, stdout }) {
  stdout.write('hypaware\n')
  stdout.write(`  overall:  ${report.overall}\n`)
  const configState = report.configExists
    ? (report.configValid ? 'ok' : 'invalid')
    : 'missing'
  stdout.write(`  config:   ${report.configPath} (${configState})\n`)

  const daemonLine = describeDaemon(report.daemon)
  stdout.write(`  daemon:   ${daemonLine}\n`)

  stdout.write('  active plugins:\n')
  if (report.activePlugins.length === 0) {
    stdout.write('    (none - no config or no plugins selected)\n')
  } else {
    for (const name of report.activePlugins) {
      stdout.write(`    - ${name}${provenanceTag(report.layered, isCentralPlugin(report.layered, name))}\n`)
    }
  }

  stdout.write('  sources:\n')
  if (report.sources.length === 0) {
    stdout.write('    (none)\n')
  } else {
    for (const s of report.sources) {
      stdout.write(`    - ${s.name}  (${s.plugin})  [${s.state}]${provenanceTag(report.layered, isCentralPlugin(report.layered, s.plugin))}\n`)
    }
  }

  stdout.write('  sinks:\n')
  if (report.sinks.length === 0) {
    stdout.write('    (none - keeping captured data local only)\n')
  } else {
    for (const s of report.sinks) {
      stdout.write(`    - ${s.instance}  (${s.plugin}, ${s.kind})${provenanceTag(report.layered, isCentralSink(report.layered, s.instance))}\n`)
    }
  }

  stdout.write('  clients:\n')
  if (clientNames.length === 0 && report.clients.every((c) => !c.configured)) {
    stdout.write('    (none)\n')
  } else {
    // Surface the union of registered clients (from the gateway) and
    // configured/attached clients (from the report). Each line shows
    // configured + attached state so a missing attach jumps out.
    const seen = new Set()
    for (const c of report.clients) {
      seen.add(c.name)
      const state = []
      state.push(c.configured ? 'configured' : 'not in config')
      state.push(c.attached ? 'attached' : 'not attached')
      stdout.write(`    - ${c.name}  [${state.join(', ')}]${provenanceTag(report.layered, isCentralPlugin(report.layered, c.plugin))}\n`)
    }
    for (const name of clientNames) {
      if (seen.has(name)) continue
      stdout.write(`    - ${name}  [registered]\n`)
    }
  }

  stdout.write(`  cache:           ${cacheRoot}\n`)
  stdout.write(
    `  cache retention: ${report.retention.days} days${
      report.retention.source === 'default' ? ' (default)' : ''
    }\n`
  )
  stdout.write(`  cache size:      ${report.cache.totalBytes} bytes\n`)
  stdout.write(`  datasets:        ${datasets.length}\n`)
  stdout.write(`  recent errors:   ${report.recentErrorCount}\n`)

  // Local entries the central layer overrides (LLP 0031): dropped at
  // merge, listed here with their reason. Loud, but not an outage signal.
  // The gateway runs fine on the central config.
  if (report.layered && (report.layered.drops.length > 0 || report.layered.centralQueryIgnored)) {
    stdout.write('  local config (not applied):\n')
    for (const d of report.layered.drops) {
      const why = d.detail
        ? `${d.reason.replace(/_/g, ' ')}: ${d.detail.replace(/_/g, ' ')}`
        : d.reason.replace(/_/g, ' ')
      stdout.write(`    - ${d.section}.${d.key}  (${why})\n`)
    }
    if (report.layered.centralQueryIgnored) {
      stdout.write('    - central query block ignored (query is local-only)\n')
    }
  }

  // Remote-config section appears only once the gateway has state to
  // show. A never-joined install keeps the V1 status surface.
  const rc = report.remoteConfig
  if (rc && (rc.runningEtag || rc.probation || rc.lastRollback || rc.badEtag)) {
    stdout.write('  remote config:\n')
    if (rc.runningEtag) stdout.write(`    running etag:  ${rc.runningEtag}\n`)
    if (rc.probation) {
      stdout.write(`    probation:     ${rc.probation.etag} until ${rc.probation.until}\n`)
    }
    if (rc.lastRollback) {
      stdout.write(`    last rollback: ${rc.lastRollback.etag} at ${rc.lastRollback.at} (${rc.lastRollback.reason})\n`)
    }
    if (rc.badEtag) {
      stdout.write(`    bad etag:      ${rc.badEtag.etag} (${rc.badEtag.reason})\n`)
    }
  }

  // Client-action reconciler section (LLP 0036 / 0041). Appears only once a
  // backfill-on-join target is configured or a pass has run; a `failed`
  // line is loud but informational. It never degrades `overall`.
  if (report.clientActions && report.clientActions.actions.length > 0) {
    stdout.write('  client actions:\n')
    for (const a of report.clientActions.actions) {
      let detail = ''
      if (a.state === 'done') {
        const bits = []
        if (a.rows !== undefined) bits.push(`${a.rows} rows`)
        if (a.at) bits.push(`at ${a.at}`)
        if (bits.length > 0) detail = `  (${bits.join(', ')})`
      } else if (a.state === 'failed') {
        const bits = []
        if (a.reason) bits.push(a.reason)
        if (a.lastAttempt) bits.push(`last attempt ${a.lastAttempt}`)
        if (a.attempts !== undefined) bits.push(`${a.attempts} attempt${a.attempts === 1 ? '' : 's'}`)
        if (bits.length > 0) detail = `  (${bits.join(', ')})`
      }
      stdout.write(`    - ${a.kind} ${a.requestKey}  [${a.state}]${detail}\n`)
    }
  }

  if (report.diagnostics.length > 0) {
    stdout.write('  diagnostics:\n')
    for (const d of report.diagnostics) {
      const tag = d.severity === 'error' ? 'ERROR' : 'WARN '
      stdout.write(`    [${tag}] ${d.kind}: ${d.message}\n`)
      for (const repair of d.repair) {
        stdout.write(`        repair: ${repair}\n`)
      }
    }
  }
}

/**
 * Per-entry layer provenance tag for `hyp status` text. Empty on a host
 * that never joined (no central layer → the V1 surface is unchanged);
 * otherwise `[central · locked]` for entries the central layer owns and
 * `[local]` for the user's additive entries. Used for plugin, source,
 * sink, and client lines. Sources and clients inherit their owning
 * plugin's layer.
 *
 * @param {HypAwareStatusReport['layered']} layered
 * @param {boolean} isCentral
 * @returns {string}
 * @ref LLP 0031#status-provenance [implements]: every active plugin/source/sink/client line tagged central·locked or local
 */
function provenanceTag(layered, isCentral) {
  if (!layered) return ''
  return isCentral ? '  [central · locked]' : '  [local]'
}

/**
 * @param {HypAwareStatusReport['layered']} layered
 * @param {string} plugin
 * @returns {boolean}
 */
function isCentralPlugin(layered, plugin) {
  return !!layered && layered.centralPlugins.includes(plugin)
}

/**
 * @param {HypAwareStatusReport['layered']} layered
 * @param {string} instance
 * @returns {boolean}
 */
function isCentralSink(layered, instance) {
  return !!layered && layered.centralSinks.includes(instance)
}

/**
 * @param {ServiceState} daemon
 */
function describeDaemon(daemon) {
  const parts = []
  parts.push(daemon.installed ? 'installed' : 'not installed')
  if (daemon.installed) parts.push(daemon.loaded ? 'loaded' : 'not loaded')
  parts.push(daemon.running ? 'running' : 'not running')
  if (daemon.state) parts.push(`state=${daemon.state}`)
  if (daemon.pid) parts.push(`pid=${daemon.pid}`)
  if (daemon.mode) parts.push(`mode=${daemon.mode}`)
  if (daemon.error) parts.push(`error=${daemon.error}`)
  return parts.join(', ')
}

/**
 * @param {CommandRunContext['capabilities']} capabilities
 * @returns {string[]}
 */
function listClientNames(capabilities) {
  if (!capabilities.has('hypaware.ai-gateway')) return []
  /** @type {AiGatewayCapability} */
  const gateway = capabilities.require('hyp-core/status', 'hypaware.ai-gateway', '^2.0.0')
  return gateway.listClients().map((c) => c.name).sort()
}

/**
 * `hyp status` intentionally avoids activating configured plugins so
 * the command does not bind local listeners just to render a report.
 * When no live query registry exists, infer the V1 bundled datasets
 * from the config-backed active plugin set.
 *
 * @param {string[]} activePlugins
 * @returns {{ name: string, plugin: string }[]}
 */
function inferDatasetsFromPlugins(activePlugins) {
  const active = new Set(activePlugins)
  /** @type {{ name: string, plugin: string }[]} */
  const datasets = []
  if (active.has('@hypaware/ai-gateway')) {
    datasets.push({ name: 'ai_gateway_messages', plugin: '@hypaware/ai-gateway' })
  }
  if (active.has('@hypaware/otel')) {
    datasets.push(
      { name: 'logs', plugin: '@hypaware/otel' },
      { name: 'metrics', plugin: '@hypaware/otel' },
      { name: 'traces', plugin: '@hypaware/otel' }
    )
  }
  return datasets.sort((a, b) => a.name.localeCompare(b.name))
}

// `measureCacheRoot` / `walkCacheRoot` / `loadRetentionDays` moved into
// `src/core/daemon/status.js` as part of the Phase 8 status collector
// (`collectHypAwareStatus`). Callers route through that helper now so
// disk probes happen once per `hyp status` invocation.

/* ---------- query ---------- */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQuery(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp query <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: schema, status, sql, refresh, maintain\n')
    return 0
  }
  ctx.stderr.write(`hyp query: unknown subcommand '${argv[0]}'\n`)
  ctx.stderr.write('  expected one of: schema, status, sql, refresh, maintain\n')
  return 2
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQuerySchema(argv, ctx) {
  const dataset = argv[0]
  if (!dataset) {
    ctx.stderr.write('usage: hyp query schema <dataset>\n')
    return 2
  }
  return withSpan(
    'query.resolve_tables',
    {
      [Attr.COMPONENT]: 'query',
      [Attr.OPERATION]: 'resolve_tables',
      [Attr.DATASET]: dataset,
      status: 'ok',
    },
    async () => {
      const schema = schemaForDataset(ctx.query, dataset)
      if (!schema) {
        ctx.stdout.write(`dataset: ${dataset}\n`)
        ctx.stdout.write('  (no dataset registered - install a plugin that contributes it)\n')
        return 0
      }
      ctx.stdout.write(renderSchema(dataset, schema))
      return 0
    },
    { component: 'query' }
  )
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runQueryStatus(_argv, ctx) {
  const { cacheStatus } = await import('../cache/maintenance.js')
  const datasets = ctx.query.listDatasets()
  const report = await cacheStatus({ cacheRoot: ctx.storage.cacheRoot })
  ctx.stdout.write(`cache:    ${report.cacheRoot}\n`)
  ctx.stdout.write(`pending:  ${report.pendingSpoolBytes} bytes\n`)
  ctx.stdout.write(`datasets: ${datasets.length} registered\n`)
  for (const dataset of datasets) {
    ctx.stdout.write(`  ${dataset.name}  (${dataset.plugin})\n`)
  }
  if (report.partitions.length > 0) {
    ctx.stdout.write(`partitions: ${report.partitions.length}\n`)
    for (const p of report.partitions) {
      const partKey = Object.entries(p.partition).map(([k, v]) => `${k}=${v}`).join('/')
      const label = `${p.dataset}/${partKey || 'all'}`
      if (p.layout === 'source-table') {
        const extras = []
        if (p.deleteFileCount) extras.push(`deletes=${p.deleteFileCount}`)
        if (p.lastRetentionCutoffDate) extras.push(`retention_cutoff=${p.lastRetentionCutoffDate}`)
        ctx.stdout.write(`  ${label}  source-table  rows=${p.rowCount}  files=${p.dataFileCount}  snapshots=${p.snapshotCount}  metadata=${p.metadataBytes}B${extras.length ? '  ' + extras.join('  ') : ''}\n`)
      } else {
        ctx.stdout.write(`  ${label}  epoch=${p.epoch}  rows=${p.rowCount}  files=${p.dataFileCount}  snapshots=${p.snapshotCount}  metadata=${p.metadataBytes}B\n`)
      }
    }
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQueryRefresh(argv, ctx) {
  const target = argv[0]
  const datasets = ctx.query.listDatasets()
  const filtered = target ? datasets.filter((d) => d.name === target) : datasets
  if (target && filtered.length === 0) {
    ctx.stderr.write(`hyp query refresh: unknown dataset '${target}'\n`)
    return 1
  }
  let total = 0
  for (const dataset of filtered) {
    if (typeof dataset.refreshPartition !== 'function') continue
    const partitions = await dataset.discoverPartitions({
      config: ctx.config,
      scope: { limit: 1_000_000 },
      cacheDir: ctx.storage.cacheRoot,
    })
    for (const partition of partitions) {
      const result = await dataset.refreshPartition(partition, {
        cacheDir: ctx.storage.cacheRoot,
        force: true,
        log: {
          debug() {},
          info() {},
          warn() {},
          error() {},
        },
        storage: ctx.storage,
      })
      const storage = /** @type {typeof ctx.storage & { flushTable?: (tablePath: string, opts?: { force?: boolean, reason?: string }) => Promise<unknown> }} */ (ctx.storage)
      if (partition.tablePath && typeof storage.flushTable === 'function') {
        await storage.flushTable(partition.tablePath, { force: true, reason: 'query_refresh' })
      }
      if (result.status === 'written') total += result.rows
    }
  }
  ctx.stdout.write(`refreshed ${filtered.length} dataset(s), wrote ${total} row(s)\n`)
  return 0
}


/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQueryMaintain(argv, ctx) {
  const { maintainCache } = await import('../cache/maintenance.js')
  const parsed = parseQueryMaintainArgv(argv)
  if (parsed.error) {
    ctx.stderr.write(`hyp query maintain: ${parsed.error}\n`)
    return 2
  }
  const { dataset, force, dryRun, compactOnly, expireOnly } = /** @type {{ dataset?: string, dryRun: boolean, force: boolean, compactOnly: boolean, expireOnly: boolean }} */ (parsed)
  if (!compactOnly && !expireOnly && !dryRun) {
    const migrationResult = await migrateLegacyPartitions({
      cacheRoot: ctx.storage.cacheRoot,
      force,
    })
    if (migrationResult.migrated > 0) {
      ctx.stdout.write(`migrate: ${migrationResult.migrated} legacy partition(s), ${migrationResult.rowsMigrated} row(s)\n`)
    }
  }
  const maintenanceConfig = ctx.config?.query?.cache?.maintenance
  const report = await maintainCache({
    cacheRoot: ctx.storage.cacheRoot,
    dataset,
    force,
    dryRun,
    compactOnly,
    expireOnly,
    config: maintenanceConfig,
    // @ref LLP 0027#re-settle-sweep: `hyp query maintain` re-settles
    // committed fallback rows too, so a manual sweep also closes the race.
    storage: ctx.storage,
    getSettleHook: (dataset) => ctx.query.getDataset(dataset)?.resettleBatch,
  })
  if (report.dryRun) {
    ctx.stdout.write('[dry-run]\n')
  }
  for (const p of report.partitions) {
    const partKey = Object.entries(p.partition).map(([k, v]) => `${k}=${v}`).join('/')
    const label = `${p.dataset}/${partKey || 'all'}`
    const actions = []
    if (p.snapshotsExpired > 0) actions.push(`expired ${p.snapshotsExpired} snapshots`)
    if (p.compacted) actions.push(`compacted epoch=${p.newEpoch ?? '?'} (${p.dataFilesBefore} -> ${p.dataFilesAfter} files)`)
    if (actions.length > 0) {
      ctx.stdout.write(`  ${label}: ${actions.join(', ')}\n`)
    }
  }
  ctx.stdout.write(`maintenance: ${report.totalSnapshotsExpired} snapshots expired, ${report.totalCompacted} partitions compacted (${report.elapsedMs}ms)\n`)
  return 0
}

/**
 * @param {string[]} argv
 * @returns {{ dataset?: string, dryRun: boolean, force: boolean, compactOnly: boolean, expireOnly: boolean, error?: undefined } | { error: string }}
 */
function parseQueryMaintainArgv(argv) {
  /** @type {string | undefined} */
  let dataset
  let dryRun = false
  let force = false
  let compactOnly = false
  let expireOnly = false
  for (const arg of argv) {
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--force') { force = true; continue }
    if (arg === '--compact-only') { compactOnly = true; continue }
    if (arg === '--expire-only') { expireOnly = true; continue }
    if (arg === '--help' || arg === '-h') {
      return { error: 'usage: hyp query maintain [dataset] [--dry-run] [--force] [--compact-only] [--expire-only]' }
    }
    if (arg.startsWith('--')) {
      return { error: `unknown flag '${arg}'` }
    }
    if (dataset === undefined) { dataset = arg; continue }
    return { error: `unexpected argument '${arg}'` }
  }
  if (compactOnly && expireOnly) {
    return { error: '--compact-only and --expire-only are mutually exclusive' }
  }
  return { dataset, dryRun, force, compactOnly, expireOnly }
}

/* ---------- collect ---------- */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runCollect(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp collect <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: list, remove\n')
    return 0
  }
  ctx.stderr.write(`hyp collect: unknown subcommand '${argv[0]}'\n`)
  return 2
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runCollectList(_argv, ctx) {
  ctx.stdout.write('No collectors configured.\n')
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runCollectRemove(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp collect remove <name>\n')
    return 2
  }
  ctx.stdout.write(`(collect remove lands in Phase 5; would remove '${argv[0]}')\n`)
  return 0
}

/* ---------- plugin ---------- */

/**
 * Resolve the kernel state directory the plugin install commands
 * write into. Mirrors `readObservabilityEnv` so `HYP_HOME` flows
 * through to plugin install just like it does for the cache.
 *
 * @param {CommandRunContext} ctx
 */
function pluginStateDir(ctx) {
  return readObservabilityEnv(ctx.env).stateDir
}

/**
 * Build the `knownPlugins` map and `knownDatasets` set used by
 * `validateConfig`. Discovers bundled and installed plugin manifests
 * and derives capability metadata from the manifests themselves via
 * `buildPluginCatalog`, so config validation runs against the actual
 * declared capabilities rather than a hardcoded table.
 *
 * Discovery failures are absorbed silently: `hyp config validate`
 * keeps working when the lock is missing or any installed manifest is
 * corrupt; the underlying discovery layer logs its own diagnostics.
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<{ knownPlugins: Map<import('../../../collectivus-plugin-kernel-types.d.ts').PluginName, import('../config/types.d.ts').PluginMetadata>, knownDatasets: Set<string> }>}
 */
async function buildKnownPluginsForCtx(ctx) {
  /** @type {LoadedManifest[]} */
  let bundledLoaded = []
  /** @type {LoadedManifest[]} */
  let installedLoaded = []
  try {
    const bundled = await discoverBundledPlugins()
    bundledLoaded = [...bundled.loaded, ...bundled.excluded]
  } catch { /* bundled discovery failure is non-fatal */ }
  try {
    const stateDir = pluginStateDir(ctx)
    const installed = await discoverInstalledPlugins({ stateDir })
    installedLoaded = installed.loaded
  } catch { /* installed discovery failure is non-fatal */ }
  const catalog = buildPluginCatalog(bundledLoaded, installedLoaded)
  return { knownPlugins: catalog.pluginMetadata, knownDatasets: catalog.knownDatasets }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginInstall(argv, ctx) {
  const parsed = parsePluginInstallArgs(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp plugin install: ${parsed.message}\n`)
    return parsed.code
  }
  const stateDir = pluginStateDir(ctx)
  const confirm = buildPluginInstallConfirm({
    yes: parsed.yes,
    ctx,
    headerKind: 'install',
  })
  const result = await installPlugin({
    rawSource: parsed.rawSource,
    stateDir,
    cwd: ctx.cwd,
    opts: { ref: parsed.ref, subdir: parsed.subdir },
    confirm,
  })
  if (!result.ok) {
    ctx.stderr.write(`hyp plugin install: ${result.message}\n`)
    return result.errorKind === 'remote_install_confirmation_required' ? 2 : 1
  }
  ctx.stdout.write(
    `installed ${result.entry.name}@${result.entry.version} from ${result.entry.source.kind}\n`
  )
  ctx.stdout.write(`  install_dir: ${result.entry.install_dir}\n`)
  if (result.entry.resolved_ref) {
    ctx.stdout.write(`  resolved_ref: ${result.entry.resolved_ref}\n`)
  }
  return 0
}

/**
 * Build the install-time trust gate. The factory is shared between the
 * install and update CLI commands so both produce the same prompt and
 * the same telemetry outcomes.
 *
 * @param {{
 *   yes: boolean,
 *   ctx: CommandRunContext,
 *   headerKind: 'install' | 'update',
 * }} args
 * @returns {ConfirmInstall}
 */
function buildPluginInstallConfirm({ yes, ctx, headerKind }) {
  const stderr = ctx.stderr
  return async function confirm(staged) {
    const summary = renderConfirmationSummary(
      {
        manifest: staged.manifest,
        source: staged.source,
        resolvedRef: staged.resolvedRef,
        contentHash: staged.contentHash,
        manifestHash: staged.manifestHash,
      },
      {
        ...(staged.previous ? { previous: staged.previous } : {}),
        headerKind,
      }
    )
    const warnings = buildWarnings({
      manifest: staged.manifest,
      source: staged.source,
      resolvedRef: staged.resolvedRef,
      contentHash: staged.contentHash,
      manifestHash: staged.manifestHash,
    })
    for (const w of warnings) stderr.write(`${w}\n`)
    stderr.write(summary)
    // Prompt on stderr so stdout stays parseable. We require both
    // stderr and stdin to be a TTY before asking: piping either
    // direction means "no human watching, prompt is useless."
    const tty = isTty(stderr) && isTty(process.stdin)
    const ask = tty
      ? buildTtyPrompt({
        stdin: process.stdin,
        stdout: /** @type {NodeJS.WritableStream} */ (stderr),
      })
      : undefined
    const decision = await decideConfirmation({ yes, tty, ...(ask ? { ask } : {}) })
    return decision
  }
}

/**
 * Parse `hyp plugin install <source> [--ref <ref>] [--path <subdir>] [--yes]`.
 * Flags accept both `--flag value` and `--flag=value` forms. The
 * function does NOT verify mutual exclusion of `--ref` with a URL
 * fragment. That lives in the resolver so the same rule applies to
 * programmatic callers.
 *
 * @param {string[]} argv
 * @returns {(
 *   { ok: true, rawSource: string, ref?: string, subdir?: string, yes: boolean }
 *   | { ok: false, code: number, message: string }
 * )}
 */
function parsePluginInstallArgs(argv) {
  /** @type {string | undefined} */
  let rawSource
  /** @type {string | undefined} */
  let ref
  /** @type {string | undefined} */
  let subdir
  let yes = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') {
      yes = true
      continue
    }
    if (arg === '--ref' || arg === '--path') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, code: 2, message: `flag ${arg} requires a value` }
      }
      // Block `-X` style values too: `applyGitSourceFlags` enforces
      // the same rule but rejecting at the CLI layer gives a friendlier
      // error before the install span opens.
      if (value.startsWith('-')) {
        return { ok: false, code: 2, message: `flag ${arg} value must not start with '-'` }
      }
      if (arg === '--ref') ref = value
      else subdir = value
      i += 1
      continue
    }
    if (arg.startsWith('--ref=')) {
      const value = arg.slice('--ref='.length)
      if (value.startsWith('-')) {
        return { ok: false, code: 2, message: `flag --ref value must not start with '-'` }
      }
      ref = value
      continue
    }
    if (arg.startsWith('--path=')) {
      const value = arg.slice('--path='.length)
      if (value.startsWith('-')) {
        return { ok: false, code: 2, message: `flag --path value must not start with '-'` }
      }
      subdir = value
      continue
    }
    if (rawSource === undefined) {
      rawSource = arg
      continue
    }
    return { ok: false, code: 2, message: `unexpected argument '${arg}'` }
  }
  if (!rawSource) {
    return { ok: false, code: 2, message: 'usage: hyp plugin install <source> [--ref <ref>] [--path <subdir>] [--yes]' }
  }
  return { ok: true, rawSource, ref, subdir, yes }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginList(argv, ctx) {
  const json = argv.includes('--json')
  const stateDir = pluginStateDir(ctx)
  const installed = await listInstalledPlugins(stateDir)
  const active = ctx.plugins ?? []

  if (json) {
    const installedByName = new Map(installed.map((e) => [e.name, e]))
    const activeByName = new Map(active.map((p) => [p.name, p]))
    const allNames = new Set([
      ...installedByName.keys(),
      ...activeByName.keys(),
    ])
    /** @type {Array<{name: string, version: string, source: 'bundled'|'installed', active: boolean, installed_at?: string, update?: unknown}>} */
    const plugins = []
    for (const name of Array.from(allNames).sort()) {
      const inst = installedByName.get(name)
      const act = activeByName.get(name)
      const version = act?.version ?? inst?.version ?? ''
      plugins.push({
        name,
        version,
        source: inst ? 'installed' : 'bundled',
        active: !!act,
        ...(inst ? { installed_at: inst.installed_at } : {}),
        ...(inst?.update !== undefined ? { update: inst.update } : {}),
      })
    }
    ctx.stdout.write(JSON.stringify({ plugins }, null, 2) + '\n')
    return 0
  }

  if (active.length === 0 && installed.length === 0) {
    ctx.stdout.write('No plugins active or installed.\n')
    return 0
  }
  if (active.length > 0) {
    ctx.stdout.write('Active plugins (from current boot):\n')
    for (const p of active) {
      ctx.stdout.write(`  ${p.name}@${p.version}  (bundled)\n`)
    }
  }
  if (installed.length > 0) {
    ctx.stdout.write('Installed plugins:\n')
    for (const entry of installed) {
      const available = entry.update?.available ? '  (update available)' : ''
      ctx.stdout.write(`  ${entry.name}@${entry.version}${available}\n`)
    }
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginInfo(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp plugin info <plugin>\n')
    return 2
  }
  const name = argv[0]
  const stateDir = pluginStateDir(ctx)
  const lock = await loadLock(stateDir)
  const entry = lock.plugins[name]
  if (!entry) {
    ctx.stderr.write(`hyp plugin info: '${name}' is not installed\n`)
    return 1
  }
  ctx.stdout.write(`${entry.name}@${entry.version}\n`)
  ctx.stdout.write(`  source:        ${entry.source.kind} (${entry.source.raw})\n`)
  ctx.stdout.write(`  install_dir:   ${entry.install_dir}\n`)
  ctx.stdout.write(`  content_hash:  ${entry.content_hash}\n`)
  ctx.stdout.write(`  manifest_hash: ${entry.manifest_hash}\n`)
  ctx.stdout.write(`  installed_at:  ${entry.installed_at}\n`)
  if (entry.update) {
    ctx.stdout.write(`  update_check:  ${entry.update.checked_at}\n`)
    ctx.stdout.write(`  available:     ${entry.update.available}\n`)
    if (entry.update.latest_version) {
      ctx.stdout.write(`  latest:        ${entry.update.latest_version}\n`)
    }
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginOutdated(argv, ctx) {
  const json = argv.includes('--json')
  const stateDir = pluginStateDir(ctx)
  const entries = await listInstalledPlugins(stateDir)
  const outdated = entries.filter((e) => e.update?.available === true)
  if (json) {
    ctx.stdout.write(
      JSON.stringify(
        {
          plugins: outdated.map((e) => ({
            name: e.name,
            version: e.version,
            latest_version: e.update?.latest_version,
            checked_at: e.update?.checked_at,
          })),
        },
        null,
        2
      ) + '\n'
    )
    return 0
  }
  if (outdated.length === 0) {
    ctx.stdout.write('All plugins up to date.\n')
    return 0
  }
  for (const entry of outdated) {
    const latest = entry.update?.latest_version ?? '?'
    ctx.stdout.write(`  ${entry.name}: ${entry.version} -> ${latest}\n`)
  }
  return 0
}

/**
 * `hyp plugin update <plugin>` runs the full fetch → validate → diff →
 * confirm → swap pipeline for an installed plugin. The bare form
 * `hyp plugin update` (no plugin name) keeps the legacy "refresh
 * update_check state for every plugin" behavior so users have a way
 * to refresh the `outdated` view without committing to a re-install.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginUpdate(argv, ctx) {
  const parsed = parsePluginUpdateArgs(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp plugin update: ${parsed.message}\n`)
    return parsed.code
  }
  const stateDir = pluginStateDir(ctx)
  if (parsed.target) {
    const confirm = buildPluginInstallConfirm({
      yes: parsed.yes,
      ctx,
      headerKind: 'update',
    })
    const result = await updatePlugin({ name: parsed.target, stateDir, confirm })
    if (!result.ok) {
      ctx.stderr.write(`hyp plugin update: ${result.message}\n`)
      return result.errorKind === 'remote_install_confirmation_required' ? 2 : 1
    }
    ctx.stdout.write(
      `updated ${result.entry.name}@${result.entry.version}\n`
    )
    if (result.entry.resolved_ref) {
      ctx.stdout.write(`  resolved_ref: ${result.entry.resolved_ref}\n`)
    }
    ctx.stdout.write(`  content_hash: ${result.entry.content_hash}\n`)
    return 0
  }

  // No target: keep the "refresh update-check state for all" behavior so
  // users still have a way to recompute `outdated` without re-installing.
  const { checkForPluginUpdate } = await import('../plugin_install/update_check.js')
  const { upsertEntry, writeLock } = await import('../plugin_install/lock.js')
  const lock = await loadLock(stateDir)
  const entries = Object.values(lock.plugins)
  let next = lock
  for (const entry of entries) {
    const probeInput = { ...entry, update: undefined }
    const state = await checkForPluginUpdate({ entry: probeInput })
    next = upsertEntry(next, { ...entry, update: state })
  }
  await writeLock(stateDir, next)
  ctx.stdout.write(`refreshed update state for ${entries.length} plugin(s)\n`)
  return 0
}

/**
 * Parse `hyp plugin update [plugin] [--yes]`.
 *
 * @param {string[]} argv
 * @returns {(
 *   { ok: true, target?: string, yes: boolean }
 *   | { ok: false, code: number, message: string }
 * )}
 */
function parsePluginUpdateArgs(argv) {
  /** @type {string | undefined} */
  let target
  let yes = false
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') {
      yes = true
      continue
    }
    if (arg.startsWith('--')) {
      return { ok: false, code: 2, message: `unknown flag '${arg}'` }
    }
    if (target === undefined) {
      target = arg
      continue
    }
    return { ok: false, code: 2, message: `unexpected argument '${arg}'` }
  }
  return target ? { ok: true, target, yes } : { ok: true, yes }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginRemove(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp plugin remove <plugin>\n')
    return 2
  }
  const name = argv[0]
  const stateDir = pluginStateDir(ctx)
  const result = await removePlugin({ name, stateDir })
  if (!result.ok) {
    ctx.stderr.write(`hyp plugin remove: ${result.message}\n`)
    return 1
  }
  ctx.stdout.write(`removed ${name}\n`)
  return 0
}

/* ---------- plugin doctor / new ---------- */

/**
 * Diagnose a plugin directory in development: static manifest/entrypoint
 * checks plus a sandboxed dry-run `activate()` that confirms the code
 * registers what the manifest declares. Aggregates every finding into a
 * single report (human or `--json`). Exit 0 when there are no
 * error-severity diagnostics (warnings allowed), 1 otherwise.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginDoctor(argv, ctx) {
  /** @type {string|undefined} */
  let dir
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--json') json = true
    else if (token === '--help' || token === '-h') {
      ctx.stdout.write('usage: hyp plugin doctor [dir] [--json]\n')
      return 0
    } else if (token.startsWith('-')) {
      ctx.stderr.write(`hyp plugin doctor: unknown flag '${token}'\n`)
      return 2
    } else if (dir === undefined) {
      dir = token
    } else {
      ctx.stderr.write(`hyp plugin doctor: unexpected argument '${token}'\n`)
      return 2
    }
  }

  const rootDir = path.resolve(ctx.cwd ?? process.cwd(), dir ?? '.')
  const { knownPlugins } = await buildKnownPluginsForCtx(ctx)
  const knownCapabilities = capabilitiesFromMetadata(knownPlugins)

  const report = await diagnosePlugin(rootDir, { knownCapabilities })

  getLogger('plugin-doctor').info('plugin.doctor', {
    component: 'plugin-doctor',
    operation: 'plugin.doctor',
    status: report.ok ? 'ok' : 'error',
    [Attr.PLUGIN]: report.pluginName ?? '',
    error_count: report.errorCount,
    warn_count: report.warnCount,
  })

  if (json) {
    ctx.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    ctx.stdout.write(renderReport(report))
  }
  return report.ok ? 0 : 1
}

/**
 * Map every capability name any known plugin provides to the versions
 * provided, used to resolve a plugin's `requires.capabilities` against
 * their declared semver ranges (not just by name).
 *
 * @param {Map<PluginName, PluginMetadata>} knownPlugins
 * @returns {Map<string, string[]>}
 */
function capabilitiesFromMetadata(knownPlugins) {
  /** @type {Map<string, string[]>} */
  const caps = new Map()
  for (const meta of knownPlugins.values()) {
    if (!meta.provides) continue
    for (const [name, version] of Object.entries(meta.provides)) {
      if (typeof version !== 'string') continue
      const versions = caps.get(name)
      if (versions) versions.push(version)
      else caps.set(name, [version])
    }
  }
  return caps
}

/**
 * Scaffold a new plugin directory that passes `hyp plugin doctor`
 * out of the box.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginNew(argv, ctx) {
  /** @type {string|undefined} */
  let name
  let kind = 'source'
  /** @type {string|undefined} */
  let dirFlag
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--kind') {
      kind = argv[i + 1]
      i += 1
      if (!kind) {
        ctx.stderr.write('hyp plugin new: --kind expects a value\n')
        return 2
      }
    } else if (token === '--dir') {
      dirFlag = argv[i + 1]
      i += 1
      if (!dirFlag) {
        ctx.stderr.write('hyp plugin new: --dir expects a path\n')
        return 2
      }
    } else if (token === '--help' || token === '-h') {
      ctx.stdout.write('usage: hyp plugin new <name> [--kind source|sink|dataset] [--dir <path>]\n')
      return 0
    } else if (token.startsWith('-')) {
      ctx.stderr.write(`hyp plugin new: unknown flag '${token}'\n`)
      return 2
    } else if (name === undefined) {
      name = token
    } else {
      ctx.stderr.write(`hyp plugin new: unexpected argument '${token}'\n`)
      return 2
    }
  }

  if (!name) {
    ctx.stderr.write('usage: hyp plugin new <name> [--kind source|sink|dataset] [--dir <path>]\n')
    return 2
  }
  if (!SCAFFOLD_KINDS.includes(/** @type {any} */ (kind))) {
    ctx.stderr.write(`hyp plugin new: unknown kind '${kind}' (expected ${SCAFFOLD_KINDS.join('|')})\n`)
    return 2
  }

  const targetDir = path.resolve(ctx.cwd ?? process.cwd(), dirFlag ?? '.')
  try {
    const result = await scaffoldPlugin({ name, kind: /** @type {any} */ (kind), targetDir })
    ctx.stdout.write(`created ${result.pluginName} (${kind}) at ${result.pluginDir}\n`)
    for (const file of result.files) {
      ctx.stdout.write(`  ${path.relative(targetDir, file)}\n`)
    }
    ctx.stdout.write(`\nnext: hyp plugin doctor ${result.pluginDir}\n`)
    return 0
  } catch (err) {
    ctx.stderr.write(`hyp plugin new: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

/* ---------- config ---------- */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runConfig(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp config <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: validate\n')
    return 0
  }
  ctx.stderr.write(`hyp config: unknown subcommand '${argv[0]}'\n`)
  ctx.stderr.write('  expected one of: validate\n')
  return 2
}

/**
 * Load and cross-validate the active config file. Emits `config.load`
 * and `config.validate` spans with `config_path`, `plugin_count`,
 * `sink_count`, and `error_kind` per the Phase 6 contract; per-error
 * logs are written by the schema/validate modules themselves so
 * smoke assertions can grep `error_kind` straight off the logs JSONL.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runConfigValidate(argv, ctx) {
  const parsed = parseConfigValidateArgv(argv, ctx.env)
  if (parsed.error !== undefined) {
    ctx.stderr.write(parsed.error + '\n')
    return 2
  }

  const loadResult = await loadConfigFile(parsed.configPath)
  if (!loadResult.ok) {
    ctx.stderr.write(`hyp config validate: ${loadResult.message}\n`)
    return 1
  }

  const { knownPlugins, knownDatasets } = await buildKnownPluginsForCtx(ctx)
  const result = await validateConfig(loadResult.config, { knownPlugins, knownDatasets })
  if (!result.ok) {
    ctx.stderr.write(
      `hyp config validate: ${result.errors.length} error(s) in ${loadResult.configPath}\n`
    )
    for (const err of result.errors) {
      ctx.stderr.write(`  [${err.errorKind}] ${err.pointer || '<root>'}: ${err.message}\n`)
    }
    return 1
  }

  ctx.stdout.write(
    `config ok: ${loadResult.configPath} (plugins=${result.pluginCount}, sinks=${result.sinkCount})\n`
  )
  return 0
}

/**
 * Resolve the config path. Precedence:
 *
 *  1. `--path <file>` on the command line.
 *  2. `HYP_CONFIG` env var.
 *  3. `<HYP_HOME>/hypaware-config.json` (falling back to `$HOME/.hyp`
 *     when `HYP_HOME` is unset, matching `readObservabilityEnv`).
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ configPath: string, error?: undefined } | { error: string, configPath?: undefined }}
 */
function parseConfigValidateArgv(argv, env) {
  /** @type {string|undefined} */
  let pathFlag
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--path') {
      pathFlag = argv[i + 1]
      if (!pathFlag) return { error: 'hyp config validate: --path expects a file path' }
      i += 1
    } else if (token === '--help' || token === '-h') {
      return { error: 'usage: hyp config validate [--path <file>]' }
    } else {
      return { error: `hyp config validate: unexpected argument '${token}'` }
    }
  }
  if (pathFlag) return { configPath: path.resolve(pathFlag) }
  if (env.HYP_CONFIG) return { configPath: path.resolve(env.HYP_CONFIG) }
  const hypHome = env.HYP_HOME || path.join(env.HOME || '', '.hyp')
  return { configPath: defaultConfigPath(hypHome) }
}

/* ---------- daemon ---------- */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonHelp(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp daemon <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: install, uninstall, run, start, stop, restart, status\n')
    return 0
  }
  ctx.stderr.write(`hyp daemon: unknown subcommand '${argv[0]}'\n`)
  ctx.stderr.write('  expected one of: install, uninstall, run, start, stop, restart, status\n')
  return 2
}

/**
 * `hyp daemon run --foreground [--config <path>]`: boot the kernel as a daemon and
 * tend it in the current process until SIGTERM/SIGINT. Phase 3
 * intentionally only supports `--foreground`; the detached run path
 * lands with the Phase 4 launchd/systemd installers, so a no-flag
 * call surfaces a deterministic error instead of attempting to
 * background ourselves and silently failing.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonRun(argv, ctx) {
  const parsed = parseDaemonRunArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`hyp daemon run: ${parsed.error}\n`)
    return 2
  }
  if (!parsed.foreground) {
    ctx.stderr.write(
      'hyp daemon run: --foreground is required in Phase 3 (detached run lands with the Phase 4 installer)\n'
    )
    return 2
  }
  const { runDaemon } = await import('../daemon/runtime.js')
  const hypHome = ctx.env.HYP_HOME || path.join(ctx.env.HOME || '', '.hyp')
  try {
    const handle = await runDaemon({
      hypHome,
      ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
      env: ctx.env,
      runId: ctx.env.DEV_RUN_ID,
      foreground: parsed.foreground,
    })
    ctx.stdout.write(`daemon: running (pid=${process.pid})\n`)
    const exitCode = await handle.done
    ctx.stdout.write('daemon: stopped\n')
    return exitCode
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon run: ${message}\n`)
    return 1
  }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonStatus(argv, ctx) {
  const json = argv.includes('--json')
  const { readStatusFile } = await import('../daemon/status.js')
  const { readPidFile, processIsAlive } = await import('../daemon/pid.js')
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const status = readStatusFile(stateDir)
  const pidEntry = readPidFile(stateDir)
  const running = !!(pidEntry && processIsAlive(pidEntry.pid))
  if (!status) {
    if (json) {
      ctx.stdout.write(JSON.stringify({ running: false, state: 'unknown' }, null, 2) + '\n')
      return 0
    }
    ctx.stdout.write('daemon: not started (no status file)\n')
    return 0
  }
  const liveUptimeMs = running && status.healthyAt
    ? Math.max(0, Date.now() - Date.parse(status.healthyAt))
    : status.uptimeMs
  if (json) {
    const payload = { running, ...status, uptimeMs: liveUptimeMs }
    ctx.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return 0
  }
  ctx.stdout.write(`daemon: ${status.state}${running ? '' : ' (no live process)'}\n`)
  ctx.stdout.write(`  pid:        ${status.pid}\n`)
  ctx.stdout.write(`  startedAt:  ${status.startedAt}\n`)
  if (status.healthyAt) ctx.stdout.write(`  healthyAt:  ${status.healthyAt}\n`)
  if (status.stoppedAt) ctx.stdout.write(`  stoppedAt:  ${status.stoppedAt}\n`)
  ctx.stdout.write(`  uptime_ms:  ${liveUptimeMs}\n`)
  ctx.stdout.write('  sources:\n')
  if (status.sources.length === 0) {
    ctx.stdout.write('    (none)\n')
  } else {
    for (const source of status.sources) {
      ctx.stdout.write(`    - ${source.name} (${source.plugin}): ${source.state}${source.error ? ' - ' + source.error : ''}\n`)
    }
  }
  ctx.stdout.write('  sinks:\n')
  if (status.sinks.length === 0) {
    ctx.stdout.write('    (none)\n')
  } else {
    for (const sink of status.sinks) {
      ctx.stdout.write(`    - ${sink.instance} (${sink.plugin}, ${sink.kind})\n`)
    }
  }
  return 0
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonStop(_argv, ctx) {
  const { requestDaemonStop } = await import('../daemon/runtime.js')
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const outcome = await requestDaemonStop({ stateRoot: stateDir })
  if (outcome === 'not_running') {
    ctx.stdout.write('daemon: not running\n')
    return 0
  }
  if (outcome === 'timed_out') {
    ctx.stderr.write('daemon: stop signal sent but daemon did not exit within 5s\n')
    return 1
  }
  ctx.stdout.write('daemon: stopped\n')
  return 0
}

/**
 * `hyp daemon restart`: restart the installed service if present,
 * otherwise fall back to a stop + operator-relaunch hint for the
 * foreground path.
 *
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonRestart(_argv, ctx) {
  const { restartServiceDaemon, serviceDaemonStatus } = await import('../daemon/install.js')
  const homeDir = ctx.env.HOME
  const status = await serviceDaemonStatus({ homeDir })
  if (status.installed) {
    try {
      await restartServiceDaemon({ homeDir })
      ctx.stdout.write('daemon: restarted\n')
      return 0
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.stderr.write(`hyp daemon restart: ${message}\n`)
      return 1
    }
  }
  const code = await runDaemonStop([], ctx)
  if (code !== 0) return code
  ctx.stdout.write('daemon restart: stopped. No installed service found;\n')
  ctx.stdout.write('  re-run `hyp daemon run --foreground` to bring it back up,\n')
  ctx.stdout.write('  or `hyp daemon install` to set up the persistent service first.\n')
  return 0
}

/**
 * `hyp daemon install`: install the persistent platform service.
 * Supports `--dry-run [--json]` to render the planned plist / unit
 * file without touching disk.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonInstall(argv, ctx) {
  const parsed = parseDaemonInstallArgs(argv)
  if (parsed.help) {
    ctx.stdout.write('usage: hyp daemon install [--config <path>] [--bin <path>] [--dry-run [--json]]\n')
    return 0
  }
  if (parsed.error) {
    ctx.stderr.write(`hyp daemon install: ${parsed.error}\n`)
    return 2
  }

  const { renderDaemonInstall, installDaemon, daemonKindLabel } = await import('../daemon/install.js')
  const homeDir = ctx.env.HOME
  const binPath = parsed.binPath ?? (process.argv[1] ?? '')
  if (!binPath) {
    ctx.stderr.write('hyp daemon install: cannot determine binPath; pass --bin <path>\n')
    return 2
  }

  /** @type {DaemonInstallOptions} */
  const options = {
    binPath,
    ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
    ...(homeDir !== undefined ? { homeDir } : {}),
    ...(parsed.platform !== undefined ? { platform: parsed.platform } : {}),
  }

  if (parsed.dryRun) {
    const plan = renderDaemonInstall(options)
    if (parsed.json) {
      ctx.stdout.write(JSON.stringify(plan, null, 2) + '\n')
      return 0
    }
    ctx.stdout.write(`platform:    ${plan.platform}\n`)
    ctx.stdout.write(`service:     ${plan.serviceKind}\n`)
    ctx.stdout.write(`target:      ${plan.targetPath}\n`)
    ctx.stdout.write(`bin:         ${plan.binPath}\n`)
    ctx.stdout.write(`config:      ${plan.configPath}\n`)
    ctx.stdout.write(`log dir:     ${plan.logDir}\n`)
    ctx.stdout.write('--- content ---\n')
    ctx.stdout.write(plan.content)
    if (!plan.content.endsWith('\n')) ctx.stdout.write('\n')
    return 0
  }

  try {
    const plan = await installDaemon(options)
    ctx.stdout.write(`✓ Daemon installed (${daemonKindLabel(plan.platform)})\n`)
    ctx.stdout.write(`  target:  ${plan.targetPath}\n`)
    ctx.stdout.write(`  config:  ${plan.configPath}\n`)
    ctx.stdout.write(`  logs:    ${plan.logDir}/daemon.out.log\n`)
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon install: ${message}\n`)
    return 1
  }
}

/**
 * `hyp daemon uninstall`: remove the persistent service while
 * leaving config, recordings, and logs in place.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonUninstall(argv, ctx) {
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      ctx.stdout.write('usage: hyp daemon uninstall\n')
      return 0
    }
    ctx.stderr.write(`hyp daemon uninstall: unexpected argument '${token}'\n`)
    return 2
  }
  const { uninstallDaemon, daemonKindLabel } = await import('../daemon/install.js')
  const homeDir = ctx.env.HOME
  try {
    await uninstallDaemon({ ...(homeDir !== undefined ? { homeDir } : {}) })
    ctx.stdout.write(`✓ Daemon removed (${daemonKindLabel()})\n`)
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon uninstall: ${message}\n`)
    return 1
  }
}

/**
 * `hyp daemon start`: start (kickstart) the installed service.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonStart(argv, ctx) {
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      ctx.stdout.write('usage: hyp daemon start\n')
      return 0
    }
    ctx.stderr.write(`hyp daemon start: unexpected argument '${token}'\n`)
    return 2
  }
  const { startServiceDaemon, serviceDaemonStatus } = await import('../daemon/install.js')
  const homeDir = ctx.env.HOME
  const status = await serviceDaemonStatus({ ...(homeDir !== undefined ? { homeDir } : {}) })
  if (!status.installed) {
    ctx.stderr.write('hyp daemon start: service not installed (run `hyp daemon install` first)\n')
    return 1
  }
  try {
    await startServiceDaemon({ ...(homeDir !== undefined ? { homeDir } : {}) })
    ctx.stdout.write('daemon: started\n')
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon start: ${message}\n`)
    return 1
  }
}

/**
 * @param {string[]} argv
 * @returns {{ help?: boolean, error?: string, dryRun?: boolean, json?: boolean, configPath?: string, binPath?: string, platform?: NodeJS.Platform }}
 */
function parseDaemonInstallArgs(argv) {
  /** @type {{ help?: boolean, error?: string, dryRun?: boolean, json?: boolean, configPath?: string, binPath?: string, platform?: NodeJS.Platform }} */
  const r = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--help' || token === '-h') { r.help = true; return r }
    if (token === '--dry-run') { r.dryRun = true; continue }
    if (token === '--json') { r.json = true; continue }
    if (token === '--config' || token.startsWith('--config=')) {
      const value = token === '--config' ? argv[++i] : token.slice('--config='.length)
      if (!value) { r.error = '--config requires a path'; return r }
      r.configPath = value
      continue
    }
    if (token === '--bin' || token.startsWith('--bin=')) {
      const value = token === '--bin' ? argv[++i] : token.slice('--bin='.length)
      if (!value) { r.error = '--bin requires a path'; return r }
      r.binPath = value
      continue
    }
    if (token === '--platform' || token.startsWith('--platform=')) {
      const value = token === '--platform' ? argv[++i] : token.slice('--platform='.length)
      if (value !== 'darwin' && value !== 'linux') {
        r.error = `--platform must be 'darwin' or 'linux' (got '${value}')`
        return r
      }
      r.platform = value
      continue
    }
    r.error = `unexpected argument '${token}'`
    return r
  }
  if (r.json && !r.dryRun) {
    r.error = '--json requires --dry-run'
  }
  return r
}

/**
 * @param {string[]} argv
 * @returns {{ foreground: boolean, configPath?: string, error?: string }}
 */
function parseDaemonRunArgs(argv) {
  /** @type {{ foreground: boolean, configPath?: string, error?: string }} */
  const r = { foreground: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--foreground' || token === '-f') {
      r.foreground = true
      continue
    }
    if (token === '--config' || token.startsWith('--config=')) {
      const value = token === '--config' ? argv[++i] : token.slice('--config='.length)
      if (!value) {
        r.error = '--config requires a path'
        return r
      }
      r.configPath = value
      continue
    }
    if (token === '--help' || token === '-h') {
      r.error = 'usage: hyp daemon run --foreground [--config <path>]'
      return r
    }
    r.error = `unexpected argument '${token}'`
    return r
  }
  return r
}

/* ---------- mcp ---------- */

/**
 * `hyp mcp`: serve this host's verbs as an MCP server. The tool surface is
 * assembled dynamically from the verbs the active plugins registered (LLP
 * 0034): a bare host offers `query_sql`; add `@hypaware/context-graph` and
 * `graph_neighbors` appears. Local stdio is local-user trust (same as
 * running `hyp query` at the terminal), so no auth and operator tools are
 * exposed.
 *
 * stdout is the JSON-RPC channel; the lifecycle line and all logs go to
 * stderr/telemetry, never stdout.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 * @ref LLP 0034#kernel-wide-not-server-only [implements]: a local gateway exposes its own active plugins' tools to a local AI client
 */
async function runMcp(argv, ctx) {
  const parsed = parseMcpArgv(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp mcp: ${parsed.error}\n`)
    return 2
  }
  if (parsed.http) {
    ctx.stderr.write('hyp mcp: --http is a follow-up; only stdio is supported in V1 (LLP 0034 §implementation-sequencing)\n')
    return 2
  }
  if (parsed.remote) {
    // Fallback for clients without remote-MCP support: a stdio proxy that
    // injects the stored query-scoped credential (LLP 0034 §proxy-fallback).
    const { runMcpProxy } = await import('../mcp/proxy.js')
    return runMcpProxy({ target: parsed.remote, ctx })
  }

  const require = createRequire(import.meta.url)
  const { version } = require('../../../package.json')
  const server = createMcpServer({
    verbs: ctx.verbs,
    query: ctx.query,
    runTool: (verb, params) => Promise.resolve(verb.operation(params, buildOperationContext(ctx, 'auto'))),
    transport: 'stdio',
    allowOperator: true,
    serverVersion: version,
  })

  const tools = server.listTools()
  const log = getLogger('mcp')
  log.info('mcp.serve_start', {
    [Attr.COMPONENT]: 'mcp',
    [Attr.OPERATION]: 'mcp.serve',
    transport: 'stdio',
    tool_count: tools.length,
  })
  // Lifecycle line to stderr (stdout is reserved for the protocol).
  ctx.stderr.write(`hyp mcp: serving ${tools.length} tool(s) over stdio${tools.length ? ` (${tools.map((t) => t.name).join(', ')})` : ''}\n`)

  const stdin = /** @type {NodeJS.ReadableStream} */ (ctx.stdin ?? process.stdin)
  await serveStdio({
    server,
    stdin,
    stdout: ctx.stdout,
    onError: (err) => log.error('mcp.handler_error', {
      [Attr.COMPONENT]: 'mcp',
      [Attr.ERROR_KIND]: 'handler_threw',
      message: err instanceof Error ? err.message : String(err),
    }),
  })
  log.info('mcp.serve_stop', { [Attr.COMPONENT]: 'mcp', [Attr.OPERATION]: 'mcp.serve' })
  return 0
}

/**
 * Parse `hyp mcp` flags: `--remote <target>` (stdio proxy), `--http` /
 * `--port <n>` (reserved follow-up).
 *
 * @param {string[]} argv
 * @returns {{ ok: true, remote: string | undefined, http: boolean, port: number | undefined } | { ok: false, error: string }}
 */
export function parseMcpArgv(argv) {
  /** @type {string | undefined} */
  let remote
  let http = false
  /** @type {number | undefined} */
  let port
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--remote') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return { ok: false, error: '--remote expects a target name' }
      remote = value
      i += 1
    } else if (token === '--http') {
      http = true
    } else if (token === '--port') {
      const value = argv[i + 1]
      const n = Number(value)
      if (value === undefined || !Number.isInteger(n) || n <= 0) return { ok: false, error: `--port expects a positive integer (got ${value ?? '<missing>'})` }
      port = n
      i += 1
    } else if (token === '--help' || token === '-h') {
      return { ok: false, error: 'usage: hyp mcp [--remote <target>]' }
    } else {
      return { ok: false, error: `unexpected argument '${token}'` }
    }
  }
  return { ok: true, remote, http, port }
}

/* ---------- version ---------- */

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runVersion(_argv, ctx) {
  const require = createRequire(import.meta.url)
  const { version } = require('../../../package.json')
  const { hypHome } = readObservabilityEnv(ctx.env)
  ctx.stdout.write(`hypaware ${version}\n`)
  ctx.stdout.write(`  node:     ${process.version}\n`)
  ctx.stdout.write(`  platform: ${process.platform} ${process.arch}\n`)
  ctx.stdout.write(`  hyp_home: ${hypHome}\n`)
  return 0
}

/* ---------- smoke ---------- */

/**
 * `hyp smoke <flow>`: internal developer command.
 *
 * The smoke harness owns a fresh tmp `HYP_HOME` and installs its own
 * observability against that tmpdir. Installing observability in the
 * parent dispatch (which is required to emit `command.run` for this
 * invocation) would lock the tracer to the parent's `HYP_HOME` before
 * the harness can swap it. We resolve that by spawning a subprocess
 * dedicated to the flow: the parent emits its `command.run` span, the
 * child boots a clean observability instance against the harness
 * tmpdir, and the child's exit code is propagated back.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runSmoke(argv, ctx) {
  const flow = argv[0]
  if (!flow) {
    ctx.stderr.write('usage: hyp smoke <flow-name>\n')
    return 2
  }
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const binPath = fileURLToPath(new URL('../../../bin/hypaware.js', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [binPath, '__smoke_internal', flow],
    {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: ctx.env,
      cwd: ctx.cwd,
    }
  )
  if (result.error) {
    ctx.stderr.write(`hyp smoke: ${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
}

/* ---------- sink ---------- */

/**
 * `hyp sink` group landing: no default behavior, just usage.
 *
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runSinkHelp(_argv, ctx) {
  ctx.stdout.write('usage: hyp sink <subcommand> [args...]\n')
  ctx.stdout.write('  subcommands:\n')
  ctx.stdout.write('    force [instance]        Run a sink tick now, ignoring schedules\n')
  ctx.stdout.write('    maintain [instance]      Run export maintenance (snapshot expiration)\n')
  return 0
}

/**
 * `hyp sink force [instance]`
 *
 * Drives one tick of the sink driver immediately, bypassing each
 * sink's cron schedule. The optional `instance` argument restricts
 * the tick to a single sink (useful when an operator just wants to
 * flush one configured destination without waking the others.
 *
 * The driver writes the same `sink.export_batch` span and outbox
 * artifacts it does on a scheduled tick. The only difference is the
 * trigger.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runSinkForce(argv, ctx) {
  const instance = argv[0]
  const obsEnv = readObservabilityEnv(ctx.env)
  const { createSinkDriver } = await import('../sinks/driver.js')
  const driver = createSinkDriver({
    sinkRegistry: /** @type {any} */ (ctx.sinks),
    queryRegistry: ctx.query,
    storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
    stateRoot: obsEnv.stateDir,
    config: ctx.config,
  })
  const tickOpts = { now: new Date(), force: true, source: /** @type {'manual'} */ ('manual') }
  if (instance) /** @type {any} */ (tickOpts).sinkInstance = instance
  const report = await driver.tick(tickOpts)
  if (report.sinks.length === 0) {
    if (instance) {
      ctx.stderr.write(`hyp sink force: no sink named '${instance}' was instantiated\n`)
      return 1
    }
    ctx.stdout.write('no sinks instantiated; nothing to do\n')
    return 0
  }
  for (const r of report.sinks) {
    ctx.stdout.write(
      `${r.instance}: ${r.status} (partitions=${r.partitionsExported}, bytes=${r.bytesWritten}${
        r.error ? `, error=${r.error}` : ''
      })\n`
    )
  }
  return report.sinks.some((r) => r.status === 'failed') ? 1 : 0
}

/**
 * `hyp sink maintain [instance] [--compact] [--dry-run]`
 *
 * Runs export maintenance on table-format (Iceberg) sink instances:
 * snapshot expiration on exported tables, and (only with `--compact`)
 * a data-file rewrite via icebird's `icebergRewrite`.
 *
 * @ref LLP 0022#compaction: rewrites are out-of-band only: this manual
 * CLI invocation is the one place they may run. The daemon loop and the
 * sink tick never compact.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runSinkMaintain(argv, ctx) {
  let instance = /** @type {string | undefined} */ (undefined)
  let dryRun = false
  let compact = false
  for (const arg of argv) {
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--compact') { compact = true; continue }
    if (arg === '--help' || arg === '-h') {
      ctx.stdout.write('usage: hyp sink maintain [instance] [--compact] [--dry-run]\n')
      return 0
    }
    if (arg.startsWith('--')) {
      ctx.stderr.write(`hyp sink maintain: unknown flag '${arg}'\n`)
      return 2
    }
    if (instance === undefined) { instance = arg; continue }
    ctx.stderr.write(`hyp sink maintain: unexpected argument '${arg}'\n`)
    return 2
  }

  // Indirect the specifier so the declaration build (rootDir=src) does not
  // pull this hypaware-core runtime module under src's emit root (TS6059).
  // The module is loaded lazily and only when `sink maintain` runs.
  const maintenanceModule = '../../../hypaware-core/plugins-workspace/format-iceberg/src/maintenance.js'
  const { maintainExportTables } = await import(maintenanceModule)

  const allHandles = /** @type {any} */ (ctx.sinks).listHandles?.() ?? []
  const tableFormatHandles = allHandles.filter(
    /** @param {any} h */
    (h) => h.kind === 'table-format' && h.tableFormat === 'iceberg' && h.blobStore
  )

  if (instance) {
    const match = tableFormatHandles.find(/** @param {any} h */ (h) => h.instanceName === instance)
    if (!match) {
      ctx.stderr.write(`hyp sink maintain: no iceberg table-format sink named '${instance}'\n`)
      const available = tableFormatHandles.map(/** @param {any} h */ (h) => h.instanceName)
      if (available.length > 0) {
        ctx.stderr.write(`  available: ${available.join(', ')}\n`)
      }
      return 1
    }
  }

  const targets = instance
    ? tableFormatHandles.filter(/** @param {any} h */ (h) => h.instanceName === instance)
    : tableFormatHandles

  if (targets.length === 0) {
    ctx.stdout.write('no iceberg table-format sinks instantiated; nothing to maintain\n')
    return 0
  }

  if (dryRun) ctx.stdout.write('[dry-run]\n')

  let totalExpired = 0
  let totalCompacted = 0
  let rewriteErrors = 0
  for (const handle of targets) {
    const config = handle.config ?? {}
    const prefix = typeof config.prefix === 'string' && config.prefix.length > 0
      ? config.prefix
      : 'iceberg/datasets'

    const report = await maintainExportTables({
      blobStore: handle.blobStore,
      prefix,
      config: typeof config.maintenance === 'object' ? config.maintenance : undefined,
      compact,
      dryRun,
    })

    for (const d of report.datasets) {
      const actions = []
      if (d.snapshotsExpired > 0) actions.push(`expired ${d.snapshotsExpired} snapshots (was ${d.snapshotsBefore})`)
      if (d.compacted) actions.push(`compacted ${d.dataFilesBefore} -> ${d.dataFilesAfter} data files`)
      else if (compact) actions.push(describeCompactionSkip(d))
      if (actions.length === 0) actions.push('nothing to do')
      ctx.stdout.write(`  ${handle.instanceName}/${d.dataset}: ${actions.join(', ')}\n`)
      if (d.compactionReason === 'error') rewriteErrors += 1
    }
    totalExpired += report.totalSnapshotsExpired
    totalCompacted += report.totalTablesCompacted

    if (report.datasets.length === 0) {
      ctx.stdout.write(`  ${handle.instanceName}: no exported datasets found\n`)
    }
  }

  ctx.stdout.write(
    compact
      ? `sink maintain: ${totalExpired} snapshots expired, ${totalCompacted} tables compacted\n`
      : `sink maintain: ${totalExpired} snapshots expired` +
        ' (data-file compaction is out-of-band: re-run with --compact, see LLP 0022)\n'
  )
  if (rewriteErrors > 0) {
    ctx.stderr.write(`sink maintain: ${rewriteErrors} rewrite(s) failed\n`)
    return 1
  }
  return 0
}

/**
 * Render the precise reason a requested compaction did not commit, so the
 * operator can tell an idle table from a failed rewrite (LLP 0022). The
 * `compactionReason` discriminant comes from `compactExportTable`.
 *
 * @param {ExportMaintenanceDatasetReport} d
 * @returns {string}
 */
function describeCompactionSkip(d) {
  switch (d.compactionReason) {
    case 'below-threshold':
      return 'compaction_skipped (below compact_file_count)'
    case 'above-byte-cap':
      return 'compaction_skipped (table exceeds compact_max_bytes; raise the cap and the heap to rewrite)'
    case 'no-table':
      return 'compaction_skipped (no table metadata)'
    case 'conflict':
      return 'compaction_conflict (concurrent commit won the race; staged files cleaned up - re-run to retry from fresh metadata)'
    case 'error':
      return `compaction_failed (${d.compactionError ?? 'unknown error'})`
    default:
      return 'compaction_skipped'
  }
}

/* ---------- misc ---------- */

/**
 * Build the onboarding backfill runner the picker finale uses to import
 * a picked client's local history right after writing config. Wraps the
 * shared `runBackfillProvider` path so finale-imported rows land in the
 * exact same per-source tables as `hyp backfill <provider>` and live
 * capture. `available` lists registered provider names so the finale can
 * intersect them with the picked clients.
 *
 * @param {CommandRunContext} ctx
 * @returns {PickerBackfillRunner}
 */
function buildPickerBackfillRunner(ctx) {
  return {
    available: ctx.backfills.list().map((p) => p.name),
    async run({ provider, dryRun, retentionDays, until }) {
      const result = await runBackfillProvider({ ctx, provider, dryRun, retentionDays, until })
      return {
        provider,
        dryRun,
        ok: result.ok,
        scanned: result.scanned,
        rowsWritten: result.rowsWritten,
        skipped: result.skipped,
      }
    },
  }
}

/**
 * `hyp init [preset]`
 *
 * Without arguments runs the interactive walkthrough (TTY only; when
 * stdout is not a TTY the command prints the available presets and
 * exits non-zero so scripts get a deterministic failure instead of
 * blocking on stdin).
 *
 * With a `<preset>` argument resolves the preset through the kernel
 * `InitPresetRegistry` and invokes its `run(argv, ctx)`. Unknown
 * presets land on stderr with the list of available names.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
/**
 * No-arg / `hyp init` entry gate for an already-configured install.
 *
 * Re-running `hypaware` on a working install used to jump straight into
 * the first-run picker as if starting fresh. Instead, when a valid config
 * is present, print a short friendly summary of what's set up and offer a
 * small menu: reconfigure, see full status, or quit (the default; a bare
 * enter changes nothing).
 *
 * @ref LLP 0011#returning-to-a-configured-install [implements]: the picker
 *   stays the first-run path; this gate only fronts it once a config exists.
 *
 * Returns:
 *  - `'first-run'`: no valid config; caller runs the walkthrough as before
 *  - `'reconfigure'`: user chose to re-run the picker
 *  - `'done'`: user quit or viewed status; caller should exit 0
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<'first-run' | 'reconfigure' | 'done'>}
 */
async function runConfiguredEntry(ctx) {
  const report = await collectHypAwareStatus({
    env: ctx.env,
    runtime: {
      sources: /** @type {any} */ (ctx.sources),
      sinks: /** @type {any} */ (ctx.sinks),
      capabilities: ctx.capabilities,
      query: ctx.query,
      storage: ctx.storage,
    },
  })

  // No config, or one that won't validate → treat as first run and let
  // the walkthrough own the experience (it can repair a missing file).
  if (!report.configExists || !report.configValid) return 'first-run'

  // A centrally-managed (fleet-joined) config is locked locally, so
  // reconfiguring here would be a no-op: drop that option and say so.
  const locked = !!(report.layered && report.layered.hasCentral)
  renderConfigSummary({ report, locked, stdout: ctx.stdout })

  const options = buildConfiguredMenuOptions(locked)
  const choice = await promptConfiguredAction(ctx, options)
  if (choice === 'reconfigure') return 'reconfigure'
  if (choice === 'status') {
    ctx.stdout.write('\n')
    await runStatus([], ctx)
  }
  return 'done'
}

/**
 * Build the action menu for the configured-install entry. `Quit` is
 * always present and is the default; `Reconfigure` is omitted when the
 * config is centrally managed (locked), since a local re-run is a no-op.
 *
 * @param {boolean} locked
 * @returns {{ value: string, label: string, summary?: string }[]}
 */
export function buildConfiguredMenuOptions(locked) {
  /** @type {{ value: string, label: string, summary?: string }[]} */
  const options = []
  if (!locked) {
    options.push({
      value: 'reconfigure',
      label: 'Reconfigure',
      summary: 'Re-run the setup picker and rewrite the config.',
    })
  }
  options.push({ value: 'status', label: 'See full status', summary: 'Print the detailed status report.' })
  options.push({ value: 'quit', label: 'Quit', summary: 'Leave the current setup untouched.' })
  return options
}

/**
 * Single-select action menu for the configured-install entry. Uses the
 * arrow-navigable TUI on a real TTY (matching the picker's look) and a
 * numbered readline fallback otherwise. A cancel (Ctrl-C / EOF) or an
 * unparseable choice resolves to `'quit'`, so nothing is changed.
 *
 * @param {CommandRunContext} ctx
 * @param {{ value: string, label: string, summary?: string }[]} options
 * @returns {Promise<string>}
 */
async function promptConfiguredAction(ctx, options) {
  if (shouldUseTui({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env })) {
    try {
      const choice = await select({
        title: 'What would you like to do?',
        options,
        default: 'quit',
        clearOnResolve: true,
        stdin: ctx.stdin ?? process.stdin,
        stdout: /** @type {any} */ (ctx.stdout),
        env: ctx.env,
      })
      return String(choice)
    } catch (err) {
      if (isPromptCancelledError(err)) return 'quit'
      throw err
    }
  }
  return legacyConfiguredActionPrompt(ctx, options)
}

/**
 * Numbered readline menu used when the TUI is unavailable (HYP_NO_TUI=1
 * or a non-TTY stdin). Mirrors the legacy walkthrough prompts: an empty
 * answer takes the default (Quit), an out-of-range answer also quits.
 *
 * @param {CommandRunContext} ctx
 * @param {{ value: string, label: string, summary?: string }[]} options
 * @returns {Promise<string>}
 */
export async function legacyConfiguredActionPrompt(ctx, options) {
  const input = /** @type {NodeJS.ReadableStream} */ (ctx.stdin ?? process.stdin)
  const output = /** @type {NodeJS.WritableStream} */ (/** @type {any} */ (ctx.stdout))
  const defaultIdx = Math.max(0, options.findIndex((o) => o.value === 'quit'))
  const rl = readline.createInterface({ input, output, terminal: false })
  try {
    output.write('What would you like to do?\n')
    options.forEach((opt, i) => output.write(`  ${i + 1}) ${opt.label}\n`))
    const answer = await rl.question(`Choose [1-${options.length}, default ${defaultIdx + 1}]: `)
    const trimmed = answer.trim()
    if (trimmed === '') return options[defaultIdx]?.value ?? 'quit'
    const n = Number.parseInt(trimmed, 10)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value
    return 'quit'
  } finally {
    rl.close()
  }
}

const FRIENDLY_CLIENT_LABELS = /** @type {Record<string, string>} */ ({
  claude: 'Claude',
  codex: 'Codex',
})

const FRIENDLY_SINK_LABELS = /** @type {Record<string, string>} */ ({
  '@hypaware/format-parquet': 'local Parquet files',
  '@hypaware/format-jsonl': 'local JSONL files',
  '@hypaware/local-fs': 'local files',
  '@hypaware/central': 'central fleet sink',
})

/**
 * Compact, friendly one-screen summary of an existing install. The full
 * diagnostic surface stays in `hyp status`; this is just enough to
 * recognise the setup before deciding whether to reconfigure.
 *
 * @param {{ report: HypAwareStatusReport, locked: boolean, stdout: CommandRunContext['stdout'] }} args
 */
export function renderConfigSummary({ report, locked, stdout }) {
  stdout.write(locked ? 'HypAware is set up (managed by your fleet).\n\n' : 'HypAware is set up.\n\n')
  stdout.write(`  Collecting:  ${summariseCollecting(report)}\n`)
  stdout.write(`  Saving to:   ${summariseSinks(report)}\n`)
  stdout.write(`  Daemon:      ${summariseDaemon(report.daemon)}\n`)
  stdout.write(
    `  Cache:       ${formatBytesShort(report.cache.totalBytes)} · ${report.retention.days}-day retention\n`
  )
  if (locked) stdout.write('\n  Settings are locked here and managed centrally.\n')
  stdout.write('\n')
}

/**
 * What's being collected, in human terms: configured AI clients first
 * (Claude, Codex), falling back to raw source names (OTEL, proxies).
 *
 * @param {HypAwareStatusReport} report
 * @returns {string}
 */
function summariseCollecting(report) {
  const clients = report.clients
    .filter((c) => c.configured)
    .map((c) => FRIENDLY_CLIENT_LABELS[c.name] ?? c.name.charAt(0).toUpperCase() + c.name.slice(1))
  if (clients.length > 0) return clients.join(', ')
  const sources = report.sources.map((s) => s.name)
  if (sources.length > 0) return sources.join(', ')
  return 'nothing yet'
}

/**
 * Where captured data lands. Dedupes friendly per-plugin labels; when no
 * sink is configured the local query cache is the only durable store.
 *
 * @param {HypAwareStatusReport} report
 * @returns {string}
 */
function summariseSinks(report) {
  if (report.sinks.length === 0) return 'local query cache only'
  /** @type {string[]} */
  const labels = []
  for (const s of report.sinks) {
    const label = FRIENDLY_SINK_LABELS[s.plugin] ?? s.instance
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.join(' + ')
}

/**
 * One-word daemon state for the summary; `hyp status` carries the detail.
 *
 * @param {HypAwareStatusReport['daemon']} daemon
 * @returns {string}
 */
function summariseDaemon(daemon) {
  if (daemon.running) return 'running'
  if (daemon.installed) return 'installed, not running'
  return 'not installed'
}

/**
 * Short human byte count for the cache line (e.g. `65 MB`). Rounds to
 * whole MB/KB so the summary stays glanceable.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytesShort(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes)} B`
}

async function runInit(argv, ctx) {
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    const presetName = argv[0]
    const preset = ctx.initPresets.get(presetName)
    if (!preset) {
      const available = ctx.initPresets.list()
      ctx.stderr.write(`hyp init: unknown preset '${presetName}'\n`)
      if (available.length === 0) {
        ctx.stderr.write('  no presets registered - install a plugin that contributes one\n')
      } else {
        ctx.stderr.write('  available:\n')
        for (const p of available) {
          ctx.stderr.write(`    ${p.name}  (${p.plugin})  - ${p.summary}\n`)
        }
      }
      return 1
    }
    return preset.run(argv.slice(1), ctx)
  }

  // Phase 5: non-interactive flags. Detected by the presence of any
  // recognized init flag in argv. When absent, fall through to the
  // legacy preset/walkthrough dispatcher below.
  if (hasInitFlags(argv)) {
    const parsed = parseInitFlags(argv)
    if (parsed.error) {
      ctx.stderr.write(`hyp init: ${parsed.error}\n`)
      return 2
    }
    return runPickerInit(parsed.flags, ctx)
  }

  if (argv.length === 0) {
    if (isTty(ctx.stdout)) {
      // Already configured? Show a short friendly summary + menu rather
      // than dropping straight into the first-run picker as if starting
      // fresh. A bare enter quits, so re-running `hypaware` on a working
      // install never reconfigures by accident. First-run (no/invalid
      // config) returns 'first-run' and falls through unchanged.
      const entry = await runConfiguredEntry(ctx)
      if (entry === 'done') return 0
      const result = await runPickerWalkthrough({
        capabilities: ctx.capabilities,
        sources: /** @type {any} */ (ctx.sources),
        skills: /** @type {any} */ (ctx.skills),
        agents: /** @type {any} */ (ctx.agents),
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        env: ctx.env,
        backfill: buildPickerBackfillRunner(ctx),
        finale: {},
      })
      return result.exitCode
    }
    const available = ctx.initPresets.list()
    ctx.stderr.write('hyp init: stdin is not a TTY - pass a preset name or non-interactive flags.\n')
    ctx.stderr.write('  non-interactive: hyp init --yes [--client claude] [--source otel] [--force] ...\n')
    if (available.length === 0) {
      ctx.stderr.write('  no presets registered\n')
    } else {
      ctx.stderr.write('  presets:\n')
      for (const p of available) {
        ctx.stderr.write(`    ${p.name}  (${p.plugin})  - ${p.summary}\n`)
      }
    }
    return 2
  }

  const presetName = argv[0]
  const preset = ctx.initPresets.get(presetName)
  if (!preset) {
    const available = ctx.initPresets.list()
    ctx.stderr.write(`hyp init: unknown preset '${presetName}'\n`)
    if (available.length === 0) {
      ctx.stderr.write('  no presets registered - install a plugin that contributes one\n')
    } else {
      ctx.stderr.write('  available:\n')
      for (const p of available) {
        ctx.stderr.write(`    ${p.name}  (${p.plugin})  - ${p.summary}\n`)
      }
    }
    return 1
  }
  return preset.run(argv.slice(1), ctx)
}

/**
 * Recognized init flag names (Phase 5). Used as a fast-path detector
 * so legacy preset-name invocations still flow through the existing
 * dispatcher.
 *
 * @type {Set<string>}
 */
const INIT_FLAG_NAMES = new Set([
  '--yes', '-y',
  '--no-daemon',
  '--dry-run',
  '--client', '--source', '--export',
  '--retention-days', '--from-file',
  '--bin', '--force',
])

/**
 * @param {string[]} argv
 */
function hasInitFlags(argv) {
  return argv.some((t) => {
    if (INIT_FLAG_NAMES.has(t)) return true
    for (const name of INIT_FLAG_NAMES) {
      if (t.startsWith(`${name}=`)) return true
    }
    return false
  })
}

/**
 * @param {string[]} argv
 * @returns {{ flags: InitFlags, error?: string }}
 */
function parseInitFlags(argv) {
  /** @type {InitFlags} */
  const flags = {
    yes: false,
    noDaemon: false,
    dryRun: false,
    clients: [],
    sources: [],
    exportChoice: undefined,
    retentionDays: 30,
    force: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') { flags.yes = true; continue }
    if (arg === '--no-daemon') { flags.noDaemon = true; continue }
    if (arg === '--dry-run') { flags.dryRun = true; continue }
    if (arg === '--force') { flags.force = true; continue }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (value !== 'claude' && value !== 'codex') {
        return { flags, error: `--client: expected claude or codex (got "${value ?? ''}")` }
      }
      if (!flags.clients.includes(value)) flags.clients.push(value)
      continue
    }
    if (arg === '--source' || arg.startsWith('--source=')) {
      const value = arg === '--source' ? argv[++i] : arg.slice('--source='.length)
      const allowed = ['claude', 'codex', 'raw-anthropic', 'raw-openai', 'otel']
      if (!allowed.includes(value ?? '')) {
        return { flags, error: `--source: expected one of ${allowed.join(', ')} (got "${value ?? ''}")` }
      }
      const typed = /** @type {'claude'|'codex'|'raw-anthropic'|'raw-openai'|'otel'} */ (value)
      if (!flags.sources.includes(typed)) flags.sources.push(typed)
      continue
    }
    if (arg === '--export' || arg.startsWith('--export=')) {
      const value = arg === '--export' ? argv[++i] : arg.slice('--export='.length)
      const allowed = ['keep-local', 'local-parquet', 'configure-later']
      if (!allowed.includes(value ?? '')) {
        return { flags, error: `--export: expected one of ${allowed.join(', ')} (got "${value ?? ''}")` }
      }
      flags.exportChoice = /** @type {'keep-local'|'local-parquet'|'configure-later'} */ (value)
      continue
    }
    if (arg === '--retention-days' || arg.startsWith('--retention-days=')) {
      const value = arg === '--retention-days' ? argv[++i] : arg.slice('--retention-days='.length)
      const parsed = Number.parseInt(value ?? '', 10)
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { flags, error: `--retention-days: expected non-negative integer (got "${value ?? ''}")` }
      }
      flags.retentionDays = parsed
      continue
    }
    if (arg === '--from-file' || arg.startsWith('--from-file=')) {
      const value = arg === '--from-file' ? argv[++i] : arg.slice('--from-file='.length)
      if (!value) return { flags, error: '--from-file: requires a path' }
      flags.fromFile = value
      continue
    }
    if (arg === '--bin' || arg.startsWith('--bin=')) {
      const value = arg === '--bin' ? argv[++i] : arg.slice('--bin='.length)
      if (!value) return { flags, error: '--bin: requires a path' }
      flags.binPath = value
      continue
    }
    return { flags, error: `unknown argument: ${arg}` }
  }
  return { flags }
}

/**
 * Resolve the export choice for non-interactive `hyp init`. When
 * `--export` is omitted the default is `local-parquet`, matching the
 * interactive wizard so equivalent source selections produce the same
 * durable-files-out-of-the-box config whether the operator used flags or
 * the TUI. `origin` lets telemetry tell an explicit `--export` pick from a
 * defaulted one. Pass `--export keep-local` for cache-only.
 *
 * @param {InitFlags} flags
 * @returns {{ exportChoice: PickerExport, origin: PickerExportOrigin }}
 * @ref LLP 0011#autodetect-vs-default [implements]: export defaults to local Parquet, a fixed pick not derived from system state
 */
export function resolveInitExportChoice(flags) {
  if (flags.exportChoice) {
    return { exportChoice: flags.exportChoice, origin: 'user' }
  }
  return { exportChoice: 'local-parquet', origin: 'default' }
}

/**
 * Non-interactive Phase 5 init. Composes picks from CLI flags,
 * optionally seeds the config from a file (`--from-file`), and
 * delegates to {@link runPickerWalkthrough}.
 *
 * @param {InitFlags} flags
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 * @ref LLP 0011#non-interactive-entry [implements]: flags / preset / --from-file path that bypasses the interactive TUI
 */
async function runPickerInit(flags, ctx) {
  // --from-file short-circuits the picker entirely. The supplied
  // config is validated and written to the canonical location;
  // walkthrough.start / walkthrough.write_config / walkthrough.finish
  // spans are still emitted so the smoke contract holds.
  if (flags.fromFile) {
    return runInitFromFile(flags, ctx)
  }

  // Default sources when `--yes` is the only signal: capture Claude +
  // OTEL. (Export defaults separately, below.)
  // @ref LLP 0002#v1-acceptance-criteria-summary [implements]: --yes default install captures Claude + OTEL
  const sources = flags.sources.slice()
  if (sources.length === 0) {
    if (flags.yes) {
      sources.push('claude', 'otel')
    } else {
      ctx.stderr.write('hyp init: no sources selected - pass --source <kind> or --yes\n')
      return 2
    }
  }
  // Folding clients into sources, so `--client claude` alone is
  // sufficient even without an explicit `--source claude`.
  for (const c of flags.clients) {
    if (!sources.includes(c)) sources.push(c)
  }

  // Export defaults to local-parquet whenever `--export` is omitted, so
  // flag-driven init matches the interactive wizard rather than diverging
  // to a conservative keep-local default for the same source selection.
  const { exportChoice, origin: exportOrigin } = resolveInitExportChoice(flags)

  const result = await runPickerWalkthrough({
    capabilities: ctx.capabilities,
    sources: /** @type {any} */ (ctx.sources),
    skills: /** @type {any} */ (ctx.skills),
    agents: /** @type {any} */ (ctx.agents),
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    env: ctx.env,
    picks: {
      sources,
      exportChoice,
      retentionDays: flags.retentionDays,
    },
    exportOrigin,
    force: flags.force,
    backfill: buildPickerBackfillRunner(ctx),
    finale: {
      skipDaemon: flags.noDaemon,
      dryRun: flags.dryRun,
      ...(flags.binPath ? { binPath: flags.binPath } : {}),
    },
  })
  return result.exitCode
}

/**
 * `hyp init --from-file <path>`: read a v2 config from disk, validate
 * it, and write it to the canonical location. Still emits the
 * walkthrough spans so the smoke pipeline observes a consistent
 * lifecycle.
 *
 * @param {InitFlags} flags
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runInitFromFile(flags, ctx) {
  const { withSpan, Attr } = await import('../observability/index.js')
  const { readObservabilityEnv } = await import('../observability/env.js')
  let raw
  try {
    raw = await fs.readFile(/** @type {string} */ (flags.fromFile), 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp init: --from-file: ${message}\n`)
    return 1
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp init: --from-file: invalid JSON: ${message}\n`)
    return 1
  }
  const catalogCtx = await buildKnownPluginsForCtx(ctx)
  const validation = await validateConfig(/** @type {any} */ (parsed), { knownPlugins: catalogCtx.knownPlugins, knownDatasets: catalogCtx.knownDatasets })
  if (!validation.ok) {
    for (const err of validation.errors) {
      ctx.stderr.write(
        `hyp init: --from-file: [${err.errorKind}] ${err.pointer || '<root>'}: ${err.message}\n`
      )
    }
    return 1
  }

  await withSpan(
    'walkthrough.start',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.start',
      sources_available: 0,
      exports_available: 0,
      from_file: true,
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  const obsEnv = readObservabilityEnv(ctx.env)
  const targetPath = ctx.env.HYP_CONFIG
    ? path.resolve(ctx.env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)

  // `init` writes the user-owned local layer, so guard against silently
  // clobbering a working config (the non-destructive half of #111).
  // `--from-file` is non-interactive: refuse unless `--force`, and back
  // up before replacing.
  const guard = await prepareLocalConfigWrite({ targetPath, force: flags.force })
  if (!guard.proceed) {
    ctx.stderr.write(`hyp init: ${guard.message}\n`)
    return 1
  }
  if (guard.backupPath) {
    ctx.stdout.write(`  backed up existing config to ${guard.backupPath}\n`)
  }

  await withSpan(
    'walkthrough.write_config',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.write_config',
      config_path: targetPath,
      from_file: true,
      ...(guard.backupPath ? { config_backed_up: true } : {}),
      status: 'ok',
    },
    async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
    },
    { component: 'walkthrough' }
  )

  await withSpan(
    'walkthrough.finish',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.finish',
      from_file: true,
      config_path: targetPath,
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  ctx.stdout.write(`✓ Wrote ${targetPath}\n`)
  return 0
}

/**
 * `hyp join <url> [token]`: join a centrally-managed fleet. Pure
 * sugar over two existing steps: write the seed config (an ordinary v2
 * config containing exactly the central plugin) and run the
 * non-interactive daemon install. Doing those two steps by hand is
 * specified to be exactly equivalent.
 *
 * Because a policy token is a multi-use fleet-wide credential, the
 * token can (and for MDM scripts, should) arrive via `--token-file`
 * or stdin instead of argv. A bare argv token lands in shell history
 * and process listings. The seed config is written mode 0600.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0025#seed-config-mode [implements]: join = write-seed-config + daemon install; a wrapper, not a second code path
 */
async function runJoin(argv, ctx) {
  const parsed = parseJoinArgs(argv)
  if (parsed.help) {
    ctx.stdout.write('usage: hyp join <url> [token] [--token-file <path>] [--bin <path>] [--no-daemon]\n')
    ctx.stdout.write('  token sources (pick one): positional argument, --token-file, or stdin\n')
    return 0
  }
  if (parsed.error) {
    ctx.stderr.write(`hyp join: ${parsed.error}\n`)
    return 2
  }

  try {
    const url = new URL(/** @type {string} */ (parsed.url))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.stderr.write(`hyp join: url must be http(s); got ${url.protocol}\n`)
      return 2
    }
  } catch {
    ctx.stderr.write(`hyp join: not a valid URL: ${parsed.url}\n`)
    return 2
  }

  /** @type {string | undefined} */
  let token = parsed.token
  if (token === undefined && parsed.tokenFile !== undefined) {
    try {
      token = (await fs.readFile(parsed.tokenFile, 'utf8')).trim()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.stderr.write(`hyp join: --token-file: ${message}\n`)
      return 1
    }
  }
  if (token === undefined) {
    if (isTty(ctx.stdin)) {
      ctx.stderr.write('hyp join: no token given - pass it as an argument, via --token-file, or on stdin\n')
      return 2
    }
    token = (await readAllStdin(ctx.stdin)).trim()
  }
  if (token.length === 0) {
    ctx.stderr.write('hyp join: token is empty\n')
    return 2
  }

  /** @type {HypAwareV2Config} */
  const seed = {
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    sinks: {
      central: {
        plugin: '@hypaware/central',
        config: {
          url: /** @type {string} */ (parsed.url),
          identity: { bootstrap_token: token },
        },
      },
    },
  }

  const catalogCtx = await buildKnownPluginsForCtx(ctx)
  const validation = await validateConfig(seed, {
    knownPlugins: catalogCtx.knownPlugins,
    knownDatasets: catalogCtx.knownDatasets,
  })
  if (!validation.ok) {
    for (const err of validation.errors) {
      ctx.stderr.write(`hyp join: [${err.errorKind}] ${err.pointer || '<root>'}: ${err.message}\n`)
    }
    return 1
  }

  // The seed is the initial *central* layer. It is written to a
  // dedicated central-seed file under `config-control/`, never to
  // `hypaware-config.json`, which is the user-owned local layer. This is
  // the #111 fix: `join` augments a working install instead of
  // destroying it.
  // @ref LLP 0031#physical-layout [implements]: join writes only the central seed, never the local layer
  const obsEnv = readObservabilityEnv(ctx.env)
  const seedPath = centralSeedPath(obsEnv.stateDir)

  return withSpan(
    'join.run',
    {
      [Attr.COMPONENT]: 'join',
      [Attr.OPERATION]: 'join.run',
      config_path: seedPath,
      install_daemon: !parsed.noDaemon,
      status: 'ok',
    },
    async (span) => {
      // The token is the only credential on disk until the first
      // bootstrap, so the seed write is atomic and mode 0600.
      await fs.mkdir(path.dirname(seedPath), { recursive: true })
      const tmp = `${seedPath}.tmp.${process.pid}.${Date.now()}`
      await fs.writeFile(tmp, JSON.stringify(seed, null, 2) + '\n', { mode: 0o600 })
      await fs.rename(tmp, seedPath)
      ctx.stdout.write(`✓ Wrote seed config ${seedPath}\n`)

      // A re-enrollment (identity broke, operator re-runs `join`) writes a
      // fresh bootstrap token into the seed, but a prior enrollment may
      // have left a stale active config slot that boot resolution prefers
      // over the seed, silently shadowing the new token, so identity
      // bootstrap keeps failing with no explanation (#139). Reset to
      // seed-config mode so the freshly written token is honored; on a
      // first join (no slot) this is a no-op.
      // @ref LLP 0031#physical-layout [implements]: join supersedes a stale active slot so the fresh seed wins
      const reset = resetCentralLayerToSeed(obsEnv.stateDir)
      span.setAttribute('superseded_active_slot', reset.supersededActiveSlot)
      if (reset.supersededActiveSlot) {
        ctx.stdout.write('  superseded a stale applied config so the new join token takes effect\n')
      }

      if (parsed.noDaemon) {
        ctx.stdout.write('  daemon install skipped (--no-daemon); run `hyp daemon install` to finish joining\n')
        return 0
      }

      const installArgv = parsed.binPath !== undefined ? ['--bin', parsed.binPath] : []
      const code = await runDaemonInstall(installArgv, ctx)
      if (code !== 0) {
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'daemon_install_failed')
        return code
      }
      ctx.stdout.write('✓ Joined - the daemon will pull its configuration from the server\n')
      return 0
    },
    { component: 'join' }
  )
}

/**
 * @param {string[]} argv
 * @returns {{ help?: boolean, error?: string, url?: string, token?: string, tokenFile?: string, binPath?: string, noDaemon?: boolean }}
 */
function parseJoinArgs(argv) {
  /** @type {{ help?: boolean, error?: string, url?: string, token?: string, tokenFile?: string, binPath?: string, noDaemon?: boolean }} */
  const r = {}
  /** @type {string[]} */
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--help' || token === '-h') { r.help = true; return r }
    if (token === '--no-daemon') { r.noDaemon = true; continue }
    if (token === '--token-file' || token.startsWith('--token-file=')) {
      const value = token === '--token-file' ? argv[++i] : token.slice('--token-file='.length)
      if (!value) return { error: '--token-file: requires a path' }
      r.tokenFile = value
      continue
    }
    if (token === '--bin' || token.startsWith('--bin=')) {
      const value = token === '--bin' ? argv[++i] : token.slice('--bin='.length)
      if (!value) return { error: '--bin: requires a path' }
      r.binPath = value
      continue
    }
    if (token.startsWith('-') && token !== '-') {
      return { error: `unknown argument: ${token}` }
    }
    positional.push(token)
  }
  if (positional.length === 0) return { error: 'missing <url> (see hyp join --help)' }
  if (positional.length > 2) return { error: `unexpected argument: ${positional[2]}` }
  r.url = positional[0]
  // '-' as the token positional means "read from stdin", same as
  // omitting it on a piped invocation.
  if (positional.length === 2 && positional[1] !== '-') r.token = positional[1]
  if (r.token !== undefined && r.tokenFile !== undefined) {
    return { error: 'pass the token either as an argument or via --token-file, not both' }
  }
  return r
}

/**
 * @param {unknown} stdin
 * @returns {Promise<string>}
 */
async function readAllStdin(stdin) {
  const stream = /** @type {AsyncIterable<Buffer | string> | undefined} */ (stdin)
  if (!stream || typeof (/** @type {any} */ (stream))[Symbol.asyncIterator] !== 'function') return ''
  let out = ''
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  }
  return out
}

/** @param {unknown} stream */
function isTty(stream) {
  return !!stream && typeof stream === 'object' && /** @type {{ isTTY?: boolean }} */ (stream).isTTY === true
}

/**
 * `hyp attach [client] [--client <name>] [--yes]`
 *
 * Resolves the `hypaware.ai-gateway` capability, looks up the named
 * client adapter, and dispatches to the adapter's `attach()`. Each
 * adapter emits its own `client.attach` span; this router only
 * threads stdout/stderr and the gateway's `localEndpoint()` into the
 * adapter context.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runAttach(argv, ctx) {
  return runClientLifecycle('attach', argv, ctx)
}

/**
 * `hyp detach [client] [--client <name>]`
 *
 * Resolves the gateway capability, looks up the named client, and
 * dispatches to its `detach()`. `detach()` is invoked with the
 * adapter's config slice (currently empty until per-adapter config
 * lands) plus stdout/stderr.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDetach(argv, ctx) {
  return runClientLifecycle('detach', argv, ctx)
}

/**
 * @param {'attach'|'detach'} action
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runClientLifecycle(action, argv, ctx) {
  const parsed = parseClientArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }

  if (!ctx.capabilities.has('hypaware.ai-gateway')) {
    await withSpan(
      `client.${action}`,
      {
        [Attr.COMPONENT]: `cmd-${action}`,
        [Attr.OPERATION]: `client.${action}`,
        client_name: parsed.client,
        hyp_client: parsed.client,
        dry_run: parsed.dryRun === true,
        status: 'failed',
        error_kind: 'cap_missing',
      },
      async () => {
        const message =
          `${action} requires the @hypaware/ai-gateway plugin to be installed and activated`
        if (parsed.json) {
          ctx.stdout.write(
            JSON.stringify({
              status: 'failed',
              action,
              client: parsed.client,
              dry_run: parsed.dryRun === true,
              error_kind: 'cap_missing',
              error: message,
            }) + '\n'
          )
        } else {
          ctx.stderr.write(`error: ${message}\n`)
        }
      },
      { component: `cmd-${action}` }
    )
    return 1
  }
  /** @type {AiGatewayCapability} */
  const gateway = ctx.capabilities.require('hyp-core', 'hypaware.ai-gateway', '^2.0.0')

  const clientNames = expandClientName(parsed.client, gateway)
  if (clientNames.length === 0) {
    ctx.stderr.write(
      `error: unknown client '${parsed.client}'. Registered clients: ${
        gateway.listClients().map((c) => c.name).join(', ') || '(none)'
      }\n`
    )
    return 1
  }

  let exitCode = 0
  for (const name of clientNames) {
    const client = gateway.getClient(name)
    if (!client) {
      ctx.stderr.write(`error: unknown client '${name}'\n`)
      exitCode = 1
      continue
    }
    try {
      if (action === 'attach') {
        // In dry-run mode the gateway source may not be started yet,
        // so `localEndpoint()` could throw. Fall back to a placeholder
        // endpoint (adapters are expected to short-circuit before
        // touching it.
        let endpoint
        if (parsed.dryRun) {
          try {
            endpoint = gateway.localEndpoint()
          } catch {
            endpoint = configuredGatewayEndpoint(ctx.config) ?? 'http://127.0.0.1:0'
          }
        } else {
          try {
            endpoint = gateway.localEndpoint()
          } catch (err) {
            const configured = configuredGatewayEndpoint(ctx.config)
            if (!configured) throw err
            endpoint = configured
          }
        }
        await client.attach({
          endpoint,
          config: {},
          stdout: ctx.stdout,
          stderr: ctx.stderr,
          dryRun: parsed.dryRun,
          json: parsed.json,
        })
      } else {
        await client.detach({
          config: {},
          stdout: ctx.stdout,
          stderr: ctx.stderr,
          dryRun: parsed.dryRun,
          json: parsed.json,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.stderr.write(`error: ${action} client '${name}' failed: ${message}\n`)
      exitCode = 1
    }
  }
  return exitCode
}

/**
 * Resolve the gateway endpoint from the active config when the gateway
 * source is not live in this process yet. This is the normal shape for
 * commands like `hyp attach`, which only need to write client settings
 * to the same fixed port the daemon will bind later.
 *
 * @param {HypAwareV2Config} config
 * @returns {string | undefined}
 */
function configuredGatewayEndpoint(config) {
  const entry = config.plugins?.find((p) => p.name === '@hypaware/ai-gateway')
  const cfg = entry?.config
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return undefined
  const listen = /** @type {Record<string, unknown>} */ (cfg).listen
  if (typeof listen !== 'string') return undefined
  return endpointFromListen(listen)
}

/**
 * @param {string} listen
 * @returns {string | undefined}
 */
function endpointFromListen(listen) {
  const idx = listen.lastIndexOf(':')
  if (idx === -1) return undefined
  const rawHost = listen.slice(0, idx)
  const rawPort = listen.slice(idx + 1)
  const port = Number.parseInt(rawPort, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort) {
    return undefined
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost
  if (host.length === 0) return undefined
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${formattedHost}:${port}`
}

/**
 * Parse an optional positional client name plus `--client <name>`,
 * `--yes` / `-y`, `--dry-run`, and `--json` from argv.
 * @param {string[]} argv
 */
function parseClientArgs(argv) {
  /** @type {{ client: string, yes: boolean, dryRun: boolean, json: boolean, error?: string }} */
  const r = { client: 'claude', yes: false, dryRun: false, json: false }
  /** @type {string | undefined} */
  let requestedClient
  /**
   * @param {string | undefined} value
   * @param {'--client'|'positional'} source
   * @returns {boolean}
   */
  function setClient(value, source) {
    if (!value || value.startsWith('-')) {
      r.error = source === '--client'
        ? '--client requires a name'
        : 'client name is required'
      return false
    }
    if (requestedClient && requestedClient !== value) {
      r.error = `client specified multiple times (${requestedClient}, ${value})`
      return false
    }
    requestedClient = value
    r.client = value
    return true
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') {
      r.yes = true
      continue
    }
    if (arg === '--dry-run') {
      r.dryRun = true
      continue
    }
    if (arg === '--json') {
      r.json = true
      continue
    }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!setClient(value, '--client')) return r
      continue
    }
    if (!arg.startsWith('-')) {
      if (!setClient(arg, 'positional')) return r
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * Resolve `--client all` to every registered client name; otherwise
 * return the requested name verbatim.
 *
 * @param {string} requested
 * @param {AiGatewayCapability} gateway
 */
function expandClientName(requested, gateway) {
  if (requested === 'all') {
    return gateway.listClients().map((c) => c.name)
  }
  return [requested]
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runIgnore(_argv, ctx) {
  ctx.stdout.write('(session ignore is contributed by recording-source plugins)\n')
  return 0
}

/**
 * `hyp skills install [--client <name>]`
 *
 * Walks the kernel skill registry and materializes each contribution
 * into the right per-client skill directory. The skill source tree
 * (a directory with `SKILL.md`) is copied recursively; existing
 * installations are replaced (idempotent).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runSkillsInstall(argv, ctx) {
  const parsed = parseSkillsArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }

  const skills = ctx.skills.list()
  if (skills.length === 0) {
    ctx.stdout.write('(no skills registered)\n')
    return 0
  }

  const homeDir = ctx.env.HOME ?? process.env.HOME ?? ''
  if (!homeDir) {
    ctx.stderr.write('error: HOME is not set; cannot resolve skill install paths\n')
    return 1
  }

  const descriptorMap = await buildClientDescriptorMap()

  let count = 0
  for (const skill of skills) {
    for (const targetClient of skill.clients) {
      if (parsed.client !== 'all' && parsed.client !== targetClient) continue
      const skillDir = descriptorMap.get(targetClient)?.skillDir
      if (!skillDir) {
        ctx.stderr.write(`warning: skill '${skill.name}' targets unknown client '${targetClient}'\n`)
        continue
      }
      const dest = path.join(homeDir, skillDir, skill.name)
      try {
        await fs.rm(dest, { recursive: true, force: true })
        await copyDir(skill.sourceDir, dest)
        ctx.stdout.write(`installed skill '${skill.name}' → ${dest}\n`)
        count += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.stderr.write(`warning: skill '${skill.name}' for ${targetClient} failed: ${message}\n`)
      }
    }
  }
  ctx.stdout.write(`installed ${count} skill copy(ies)\n`)
  return 0
}

/**
 * `hyp agents install [--client <name>]`
 *
 * Mirrors `hyp skills install` for subagent contributions. Each agent
 * is a single markdown definition file materialized flat into the
 * per-client agent directory as `<agent_dir>/<name>.md`; existing
 * installations are replaced (idempotent). Clients without an
 * `agent_dir` in their manifest are skipped with a warning.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runAgentsInstall(argv, ctx) {
  const parsed = parseSkillsArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }

  const agents = ctx.agents.list()
  if (agents.length === 0) {
    ctx.stdout.write('(no agents registered)\n')
    return 0
  }

  const homeDir = ctx.env.HOME ?? process.env.HOME ?? ''
  if (!homeDir) {
    ctx.stderr.write('error: HOME is not set; cannot resolve agent install paths\n')
    return 1
  }

  const descriptorMap = await buildClientDescriptorMap()

  let count = 0
  for (const agent of agents) {
    for (const targetClient of agent.clients) {
      if (parsed.client !== 'all' && parsed.client !== targetClient) continue
      const agentDir = descriptorMap.get(targetClient)?.agentDir
      if (!agentDir) {
        ctx.stderr.write(`warning: agent '${agent.name}' targets client '${targetClient}' without an agent directory\n`)
        continue
      }
      const baseDir = path.join(homeDir, agentDir)
      const dest = path.join(baseDir, `${agent.name}.md`)
      // Defense in depth: registration rejects traversal names, but the
      // agent dir comes from a plugin manifest, so re-check containment.
      if (!isWithinDir(dest, baseDir)) {
        ctx.stderr.write(`warning: agent '${agent.name}' for ${targetClient} resolves outside ${baseDir}; skipped\n`)
        continue
      }
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.copyFile(agent.sourceFile, dest)
        ctx.stdout.write(`installed agent '${agent.name}' → ${dest}\n`)
        count += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.stderr.write(`warning: agent '${agent.name}' for ${targetClient} failed: ${message}\n`)
      }
    }
  }
  ctx.stdout.write(`installed ${count} agent copy(ies)\n`)
  return 0
}

/**
 * Build a map from client name to client descriptor by reading plugin
 * manifests. This avoids hardcoding `.claude/skills` / `.codex/skills`
 * / `.claude/agents` in core.
 *
 * @returns {Promise<Map<string, ClientDescriptor>>}
 */
async function buildClientDescriptorMap() {
  /** @type {Map<string, ClientDescriptor>} */
  const map = new Map()
  try {
    const bundled = await discoverBundledPlugins()
    const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
    for (const [clientName, descriptor] of catalog.clientDescriptors) {
      map.set(clientName, descriptor)
    }
  } catch { /* discovery failure → empty map → warnings per contribution */ }
  return map
}

/** @param {string[]} argv */
function parseSkillsArgs(argv) {
  /** @type {{ client: string, error?: string }} */
  const r = { client: 'all' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!value) { r.error = '--client requires a name'; return r }
      r.client = value
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<void>}
 */
async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(from, to)
    } else if (entry.isFile()) {
      await fs.copyFile(from, to)
    }
  }
}

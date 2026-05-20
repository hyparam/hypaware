// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { defaultConfigPath, loadConfigFile } from '../config/schema.js'
import { runWalkthrough } from './walkthrough.js'
import { validateConfig } from '../config/validate.js'
import { renderResult } from '../query/format.js'
import { renderSchema, schemaForDataset } from '../query/schema.js'
import { executeQuerySql } from '../query/sql.js'
import {
  installPlugin,
  listInstalledPlugins,
  loadLock,
  removePlugin,
} from '../plugin_install/install.js'
import { checkForPluginUpdate } from '../plugin_install/update_check.js'
import { upsertEntry, writeLock } from '../plugin_install/lock.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').CommandRegistration} CommandRegistration */
/** @typedef {import('../../../collectivus-plugin-kernel-types').CommandRunContext} CommandRunContext */
/** @typedef {ReturnType<typeof import('../registry/commands.js').createCommandRegistry>} CommandRegistryExtended */
/** @typedef {import('../query/sql.js').RefreshMode} RefreshMode */
/** @typedef {import('../query/format.js').QueryFormat} QueryFormat */

/**
 * Register the V1 core command set onto the supplied registry. These
 * commands are NOT plugin contributions — they ship with the kernel
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
}

/** @returns {CommandRegistration[]} */
function buildCoreCommands() {
  return [
    {
      name: 'status',
      summary: 'Show kernel status (sources, sinks, cache)',
      usage: 'hyp status',
      run: runStatus,
    },
    {
      name: 'query',
      summary: 'Query the local cache (see subcommands: schema, status, sql, refresh)',
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
      name: 'query sql',
      summary: 'Run a SQL query against registered datasets',
      usage: 'hyp query sql <sql> [--refresh <mode>] [--format <fmt>]',
      run: runQuerySql,
    },
    {
      name: 'query refresh',
      summary: 'Force a cache refresh for a dataset',
      usage: 'hyp query refresh [dataset]',
      run: runQueryRefresh,
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
      usage: 'hyp plugin install <source>',
      run: runPluginInstall,
    },
    {
      name: 'plugin list',
      summary: 'List installed plugins',
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
      usage: 'hyp plugin update [plugin]',
      run: runPluginUpdate,
    },
    {
      name: 'plugin remove',
      summary: 'Remove an installed plugin',
      usage: 'hyp plugin remove <plugin>',
      run: runPluginRemove,
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
      name: 'attach',
      summary: 'Attach an AI client to the local gateway',
      usage: 'hyp attach --client <name>',
      run: runAttach,
    },
    {
      name: 'detach',
      summary: 'Detach an AI client from the local gateway',
      usage: 'hyp detach --client <name>',
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
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runStatus(_argv, ctx) {
  /** @type {import('../registry/sources.js').ExtendedSourceRegistry} */
  const sources = /** @type {any} */ (ctx.sources)
  /** @type {import('../registry/sinks.js').ExtendedSinkRegistry} */
  const sinks = /** @type {any} */ (ctx.sinks)

  const sourceContributions = sources.list()
  const sinkContributions = sinks.listContributions().map((c) => c.contribution)
  const clientNames = listClientNames(ctx.capabilities)
  const datasets = ctx.query.listDatasets()
  const cacheStats = await measureCacheRoot(ctx.storage.cacheRoot)

  const retention = await loadRetentionDays(ctx.env)

  return withSpan(
    'status.render',
    {
      [Attr.COMPONENT]: 'status',
      [Attr.OPERATION]: 'status.render',
      source_count: sourceContributions.length,
      sink_count: sinkContributions.length,
      client_count: clientNames.length,
      dataset_count: datasets.length,
      cache_size_bytes: cacheStats.totalBytes,
      oldest_partition_date: cacheStats.oldestDate ?? '',
      retention_days: retention.days,
      status: 'ok',
    },
    async () => {
      ctx.stdout.write('hypaware\n')
      ctx.stdout.write('  sources:\n')
      if (sourceContributions.length === 0) {
        ctx.stdout.write('    (none)\n')
      } else {
        for (const s of sourceContributions) {
          ctx.stdout.write(`    - ${s.name}  (${s.plugin})${s.summary ? `  — ${s.summary}` : ''}\n`)
        }
      }
      ctx.stdout.write('  sinks:\n')
      if (sinkContributions.length === 0) {
        ctx.stdout.write('    (none — keeping captured data local only)\n')
      } else {
        for (const s of sinkContributions) {
          ctx.stdout.write(`    - ${s.name}  (${s.plugin})\n`)
        }
      }
      ctx.stdout.write('  clients:\n')
      if (clientNames.length === 0) {
        ctx.stdout.write('    (none)\n')
      } else {
        for (const name of clientNames) {
          ctx.stdout.write(`    - ${name}\n`)
        }
      }
      ctx.stdout.write(`  cache:           ${ctx.storage.cacheRoot}\n`)
      ctx.stdout.write(`  cache retention: ${retention.days} days${retention.source === 'default' ? ' (default)' : ''}\n`)
      ctx.stdout.write(`  datasets:        ${datasets.length}\n`)
      return 0
    },
    { component: 'status' }
  )
}

/**
 * @param {CommandRunContext['capabilities']} capabilities
 * @returns {string[]}
 */
function listClientNames(capabilities) {
  if (!capabilities.has('hypaware.ai-gateway')) return []
  /** @type {import('../../../collectivus-plugin-kernel-types').AiGatewayCapability} */
  const gateway = capabilities.require('hyp-core/status', 'hypaware.ai-gateway', '^1.0.0')
  return gateway.listClients().map((c) => c.name).sort()
}

/**
 * Walk the cache root and return a best-effort size + oldest-partition
 * date. Both values land on the `status.render` span; the smoke checks
 * the structured attribute, not the printed line.
 *
 * @param {string} cacheRoot
 * @returns {Promise<{ totalBytes: number, oldestDate: string|null }>}
 */
async function measureCacheRoot(cacheRoot) {
  /** @type {{ totalBytes: number, oldestMs: number|null }} */
  const acc = { totalBytes: 0, oldestMs: null }
  await walkCacheRoot(cacheRoot, acc)
  const oldestDate = acc.oldestMs === null ? null : new Date(acc.oldestMs).toISOString().slice(0, 10)
  return { totalBytes: acc.totalBytes, oldestDate }
}

/**
 * @param {string} dir
 * @param {{ totalBytes: number, oldestMs: number|null }} acc
 */
async function walkCacheRoot(dir, acc) {
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkCacheRoot(full, acc)
    } else if (entry.isFile()) {
      const stat = await fs.stat(full)
      acc.totalBytes += stat.size
      if (acc.oldestMs === null || stat.mtimeMs < acc.oldestMs) acc.oldestMs = stat.mtimeMs
    }
  }
}

/**
 * Load `query.cache.retention.default_days` from the config file when
 * present. Falls back to 30 days. Used by `hyp status` to print the
 * retention window the user will actually see; reading the config here
 * avoids forcing every dispatcher caller to pre-load it.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ days: number, source: 'config'|'default' }>}
 */
async function loadRetentionDays(env) {
  const hypHome = env.HYP_HOME || path.join(env.HOME || '', '.hyp')
  const configPath = env.HYP_CONFIG ? path.resolve(env.HYP_CONFIG) : defaultConfigPath(hypHome)
  const loaded = await loadConfigFile(configPath)
  if (!loaded.ok) return { days: 30, source: 'default' }
  const days = loaded.config?.query?.cache?.retention?.default_days
  if (typeof days === 'number' && Number.isFinite(days) && days >= 0) {
    return { days, source: 'config' }
  }
  return { days: 30, source: 'default' }
}

/* ---------- query ---------- */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQuery(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp query <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: schema, status, sql, refresh\n')
    return 0
  }
  ctx.stderr.write(`hyp query: unknown subcommand '${argv[0]}'\n`)
  ctx.stderr.write('  expected one of: schema, status, sql, refresh\n')
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
        ctx.stdout.write('  (no dataset registered — install a plugin that contributes it)\n')
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
  const datasets = ctx.query.listDatasets()
  ctx.stdout.write(`cache:    ${ctx.storage.cacheRoot}\n`)
  ctx.stdout.write(`datasets: ${datasets.length} registered\n`)
  for (const dataset of datasets) {
    ctx.stdout.write(`  ${dataset.name}  (${dataset.plugin})\n`)
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQuerySql(argv, ctx) {
  const parsed = parseQuerySqlArgv(argv)
  if (parsed.error) {
    ctx.stderr.write(parsed.error + '\n')
    return 2
  }
  try {
    const result = await executeQuerySql({
      query: parsed.sql,
      registry: ctx.query,
      storage: ctx.storage,
      refresh: parsed.refresh,
      config: ctx.config,
    })
    ctx.stdout.write(renderResult({ columns: result.columns, rows: result.rows }, parsed.format))
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp query sql: ${message}\n`)
    return 1
  }
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
      if (result.status === 'written') total += result.rows
    }
  }
  ctx.stdout.write(`refreshed ${filtered.length} dataset(s), wrote ${total} row(s)\n`)
  return 0
}

/**
 * Parse the `hyp query sql` argv tail. Accepts the positional SQL string and
 * `--refresh` / `--format` flags in any order. Returns `{ sql, refresh,
 * format }` on success or `{ error }` on failure.
 *
 * @param {string[]} argv
 */
function parseQuerySqlArgv(argv) {
  /** @type {string[]} */
  const positional = []
  /** @type {RefreshMode} */
  let refresh = 'auto'
  /** @type {QueryFormat} */
  let format = 'table'

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--refresh') {
      const value = argv[i + 1]
      if (value !== 'never' && value !== 'auto' && value !== 'always') {
        return { error: `hyp query sql: --refresh expects one of never|auto|always (got ${value ?? '<missing>'})` }
      }
      refresh = value
      i += 1
    } else if (token === '--format') {
      const value = argv[i + 1]
      if (value !== 'table' && value !== 'json' && value !== 'jsonl' && value !== 'markdown') {
        return { error: `hyp query sql: --format expects one of table|json|jsonl|markdown (got ${value ?? '<missing>'})` }
      }
      format = value
      i += 1
    } else {
      positional.push(token)
    }
  }

  if (positional.length === 0) {
    return { error: 'usage: hyp query sql <sql> [--refresh <mode>] [--format <fmt>]' }
  }
  const sql = positional.join(' ')
  return { sql, refresh, format }
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
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginInstall(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp plugin install <source>\n')
    return 2
  }
  const rawSource = argv[0]
  const stateDir = pluginStateDir(ctx)
  const result = await installPlugin({ rawSource, stateDir, cwd: ctx.cwd })
  if (!result.ok) {
    ctx.stderr.write(`hyp plugin install: ${result.message}\n`)
    return 1
  }
  ctx.stdout.write(
    `installed ${result.entry.name}@${result.entry.version} from ${result.entry.source.kind}\n`
  )
  ctx.stdout.write(`  install_dir: ${result.entry.install_dir}\n`)
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginList(argv, ctx) {
  const json = argv.includes('--json')
  const stateDir = pluginStateDir(ctx)
  const entries = await listInstalledPlugins(stateDir)
  if (json) {
    const plugins = entries.map((e) => ({
      name: e.name,
      version: e.version,
      source: e.source,
      installed_at: e.installed_at,
      update: e.update,
    }))
    ctx.stdout.write(JSON.stringify({ plugins }, null, 2) + '\n')
    return 0
  }
  if (entries.length === 0) {
    ctx.stdout.write('No plugins installed.\n')
    return 0
  }
  for (const entry of entries) {
    const available = entry.update?.available ? '  (update available)' : ''
    ctx.stdout.write(`  ${entry.name}@${entry.version}${available}\n`)
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
 * Re-probe one (or every) installed plugin's upstream and write the
 * fresh `update` state back to the lock. Phase 7 does not yet pull
 * down a new artifact — that comes when fetch.js learns the non-local
 * source kinds in Phase 8. For now `hyp plugin update` is "refresh the
 * update_check state."
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginUpdate(argv, ctx) {
  const stateDir = pluginStateDir(ctx)
  const lock = await loadLock(stateDir)
  const entries = Object.values(lock.plugins)
  const target = argv[0]
  const subjects = target ? entries.filter((e) => e.name === target) : entries
  if (target && subjects.length === 0) {
    ctx.stderr.write(`hyp plugin update: '${target}' is not installed\n`)
    return 1
  }
  let next = lock
  for (const entry of subjects) {
    // Force a probe by clearing the last checked_at; rate-limit logic
    // is keyed off `entry.update.checked_at`.
    const probeInput = { ...entry, update: undefined }
    const state = await checkForPluginUpdate({ entry: probeInput })
    next = upsertEntry(next, { ...entry, update: state })
  }
  await writeLock(stateDir, next)
  if (target) {
    ctx.stdout.write(`refreshed update state for ${target}\n`)
  } else {
    ctx.stdout.write(`refreshed update state for ${subjects.length} plugin(s)\n`)
  }
  return 0
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
  if (parsed.error) {
    ctx.stderr.write(parsed.error + '\n')
    return 2
  }

  const loadResult = await loadConfigFile(parsed.configPath)
  if (!loadResult.ok) {
    ctx.stderr.write(`hyp config validate: ${loadResult.message}\n`)
    return 1
  }

  const result = await validateConfig(loadResult.config)
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
 * @returns {{ configPath: string } | { error: string }}
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

/* ---------- smoke ---------- */

/**
 * `hyp smoke <flow>` — internal developer command.
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

/* ---------- misc ---------- */

/**
 * `hyp init [preset]`
 *
 * Without arguments runs the interactive walkthrough (TTY only — when
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
async function runInit(argv, ctx) {
  if (argv.length === 0) {
    if (isTty(ctx.stdout)) {
      const result = await runWalkthrough({
        sources: /** @type {any} */ (ctx.sources),
        sinks: /** @type {any} */ (ctx.sinks),
        capabilities: ctx.capabilities,
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        env: ctx.env,
      })
      return result.exitCode
    }
    const available = ctx.initPresets.list()
    ctx.stderr.write('hyp init: stdin is not a TTY — pass a preset name.\n')
    if (available.length === 0) {
      ctx.stderr.write('  no presets registered\n')
    } else {
      ctx.stderr.write('  presets:\n')
      for (const p of available) {
        ctx.stderr.write(`    ${p.name}  (${p.plugin})  — ${p.summary}\n`)
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
      ctx.stderr.write('  no presets registered — install a plugin that contributes one\n')
    } else {
      ctx.stderr.write('  available:\n')
      for (const p of available) {
        ctx.stderr.write(`    ${p.name}  (${p.plugin})  — ${p.summary}\n`)
      }
    }
    return 1
  }
  return preset.run(argv.slice(1), ctx)
}

/** @param {unknown} stream */
function isTty(stream) {
  return !!stream && typeof stream === 'object' && /** @type {{ isTTY?: boolean }} */ (stream).isTTY === true
}

/**
 * `hyp attach --client <name> [--yes]`
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
 * `hyp detach --client <name>`
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
    ctx.stderr.write(
      `error: ${action} requires the @hypaware/ai-gateway plugin to be installed and activated\n`
    )
    return 1
  }
  /** @type {import('../../../collectivus-plugin-kernel-types').AiGatewayCapability} */
  const gateway = ctx.capabilities.require('hyp-core', 'hypaware.ai-gateway', '^1.0.0')

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
        const endpoint = gateway.localEndpoint()
        await client.attach({
          endpoint,
          config: {},
          stdout: ctx.stdout,
          stderr: ctx.stderr,
        })
      } else {
        await client.detach({
          config: {},
          stdout: ctx.stdout,
          stderr: ctx.stderr,
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
 * Parse `--client <name>` and `--yes` / `-y` from argv.
 * @param {string[]} argv
 */
function parseClientArgs(argv) {
  /** @type {{ client: string, yes: boolean, error?: string }} */
  const r = { client: 'claude', yes: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') {
      r.yes = true
      continue
    }
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
 * Resolve `--client all` to every registered client name; otherwise
 * return the requested name verbatim.
 *
 * @param {string} requested
 * @param {import('../../../collectivus-plugin-kernel-types').AiGatewayCapability} gateway
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

  let count = 0
  for (const skill of skills) {
    for (const targetClient of skill.clients) {
      if (parsed.client !== 'all' && parsed.client !== targetClient) continue
      const dest = path.join(homeDir, clientSkillDir(targetClient), skill.name)
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

/** @param {string[]} argv */
function parseSkillsArgs(argv) {
  /** @type {{ client: 'all' | 'claude' | 'codex', error?: string }} */
  const r = { client: 'all' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!value) { r.error = '--client requires a name'; return r }
      if (value !== 'all' && value !== 'claude' && value !== 'codex') {
        r.error = `--client: expected all, claude, or codex (got "${value}")`
        return r
      }
      r.client = value
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/** @param {'claude'|'codex'|'all'} client */
function clientSkillDir(client) {
  if (client === 'claude') return '.claude/skills'
  if (client === 'codex') return '.codex/skills'
  throw new Error(`clientSkillDir: '${client}' has no per-client directory`)
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

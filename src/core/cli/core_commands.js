// @ts-check

import path from 'node:path'

import { Attr, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { defaultConfigPath, loadConfigFile } from '../config/schema.js'
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
  ]
}

/* ---------- status ---------- */

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runStatus(_argv, ctx) {
  const datasetCount = ctx.query.listDatasets().length
  ctx.stdout.write('hypaware (kernel)\n')
  ctx.stdout.write(`  plugins:       ${ctx.plugins.length}\n`)
  ctx.stdout.write(`  capabilities:  ${ctx.capabilities.list().length}\n`)
  ctx.stdout.write(`  sources:       0  (Phase 5)\n`)
  ctx.stdout.write(`  sinks:         0  (Phase 5)\n`)
  ctx.stdout.write(`  cache:         ${ctx.storage.cacheRoot}\n`)
  ctx.stdout.write(`  datasets:      ${datasetCount}\n`)
  return 0
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

/* ---------- misc ---------- */

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runInit(_argv, ctx) {
  ctx.stdout.write('(init walkthrough lands in Phase 9)\n')
  return 0
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runAttach(_argv, ctx) {
  ctx.stdout.write('(client attach is contributed by client adapter plugins, Phase 8.4)\n')
  return 0
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runDetach(_argv, ctx) {
  ctx.stdout.write('(client detach is contributed by client adapter plugins, Phase 8.4)\n')
  return 0
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
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runSkillsInstall(_argv, ctx) {
  ctx.stdout.write('(skill install lands when client adapter plugins ship skills, Phase 8.4)\n')
  return 0
}

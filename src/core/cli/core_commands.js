// @ts-check

import { Attr, withSpan } from '../observability/index.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').CommandRegistration} CommandRegistration */
/** @typedef {import('../../../collectivus-plugin-kernel-types').CommandRunContext} CommandRunContext */
/** @typedef {ReturnType<typeof import('../registry/commands.js').createCommandRegistry>} CommandRegistryExtended */

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
  ctx.stdout.write('hypaware (kernel)\n')
  ctx.stdout.write(`  plugins:       ${ctx.plugins.length}\n`)
  ctx.stdout.write(`  capabilities:  ${ctx.capabilities.list().length}\n`)
  ctx.stdout.write(`  sources:       0  (Phase 5)\n`)
  ctx.stdout.write(`  sinks:         0  (Phase 5)\n`)
  ctx.stdout.write(`  cache:         intrinsic local (Phase 4)\n`)
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
      ctx.stdout.write(`dataset: ${dataset}\n`)
      ctx.stdout.write('  (dataset registry lands in Phase 4 — no schema registered yet)\n')
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
  ctx.stdout.write('cache:    not yet implemented (Phase 4)\n')
  ctx.stdout.write('datasets: 0 registered\n')
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQuerySql(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp query sql <sql> [--refresh <mode>] [--format <fmt>]\n')
    return 2
  }
  ctx.stdout.write('(query execution lands in Phase 4)\n')
  return 0
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runQueryRefresh(_argv, ctx) {
  ctx.stdout.write('(query refresh lands in Phase 4)\n')
  return 0
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
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginInstall(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp plugin install <source>\n')
    return 2
  }
  ctx.stdout.write(`(plugin install lands in Phase 7; would install '${argv[0]}')\n`)
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginList(argv, ctx) {
  const json = argv.includes('--json')
  const plugins = ctx.plugins.map((p) => ({ name: p.name, version: p.version }))
  if (json) {
    ctx.stdout.write(JSON.stringify({ plugins }, null, 2) + '\n')
  } else if (plugins.length === 0) {
    ctx.stdout.write('No plugins installed.\n')
  } else {
    for (const p of plugins) ctx.stdout.write(`  ${p.name}@${p.version}\n`)
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
  ctx.stdout.write(`(plugin info lands in Phase 7; '${argv[0]}' not installed)\n`)
  return 0
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runPluginUpdate(_argv, ctx) {
  ctx.stdout.write('(plugin update lands in Phase 7)\n')
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
  ctx.stdout.write(`(plugin remove lands in Phase 7; would remove '${argv[0]}')\n`)
  return 0
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

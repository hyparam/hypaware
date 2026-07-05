// @ts-check

import path from 'node:path'
import { parseCommandArgv } from '../cli/verb_codec.js'

import { defaultConfigPath, loadConfigFile } from '../config/schema.js'
import { validateConfig } from '../config/validate.js'
import { buildKnownPluginsForCtx } from './plugin.js'

/**
 * @import { CommandRunContext } from '../../../collectivus-plugin-kernel-types.js'
 */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runConfig(argv, ctx) {
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
export async function runConfigValidate(argv, ctx) {
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
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: { path: { type: 'string' } },
  })
  if ('help' in parsed) return { error: 'usage: hyp config validate [--path <file>]' }
  if (!parsed.ok) return { error: `hyp config validate: ${parsed.error}` }
  const p = /** @type {{ path?: string }} */ (parsed.params)
  if (p.path) return { configPath: path.resolve(p.path) }
  if (env.HYP_CONFIG) return { configPath: path.resolve(env.HYP_CONFIG) }
  const hypHome = env.HYP_HOME || path.join(env.HOME || '', '.hyp')
  return { configPath: defaultConfigPath(hypHome) }
}

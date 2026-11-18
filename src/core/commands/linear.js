// @ts-check

import { isDeepStrictEqual } from 'node:util'
import { parseCoreCommandArgv } from '../cli/command_args.js'
import { isTty } from '../cli/tui-router.js'
import { multiselect } from '../cli/tui/index.js'
import { isPromptCancelledError } from '../cli/tui/runtime.js'
import { readLocalPluginLayers, updateLocalPluginSelection } from '../config/local_plugin_selection.js'
import { readObservabilityEnv } from '../observability/env.js'
import { getLogger } from '../observability/index.js'
import { resolveConfigPath } from '../runtime/boot.js'
import { pluginStateDir } from '../runtime/paths.js'
import { sanitizeLabel } from '../util/json_util.js'

/** @import { CommandRunContext, HypAwareV2Config, JsonObject } from '../../../hypaware-plugin-kernel-types.js' */

const LINEAR = '@hypaware/linear'
const GRAPH = '@hypaware/context-graph'

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0608#connect [implements]: explicit post-install setup reuses Linear OAuth and saves the selected scope into the local config
 */
export async function runLinearConnect(argv, ctx) {
  const args = parseCoreCommandArgv('linear connect', argv, ctx)
  if (!args.ok) return args.code
  const requested = /** @type {string[] | undefined} */ (args.params.team)
  // URL specifiers keep the bundled plugin out of the core declaration build
  // (rootDir=src), which a literal import would pull in (TS6059).
  const [{ authorizeLinear }, { validateLinearConfig }, { createLinearClient, listLinearTeams }] = await Promise.all([
    import(new URL('../../../hypaware-core/plugins-workspace/linear/src/commands.js', import.meta.url).href),
    import(new URL('../../../hypaware-core/plugins-workspace/linear/src/config.js', import.meta.url).href),
    import(new URL('../../../hypaware-core/plugins-workspace/linear/src/client.js', import.meta.url).href),
  ])
  const explicit = validateLinearConfig({ teams: requested })
  if (!explicit.config) {
    ctx.stderr.write(`hyp linear connect: ${explicit.errors?.[0]?.message}\n`)
    return 2
  }

  const { stateDir: stateRoot, hypHome } = readObservabilityEnv(ctx.env)
  const configPath = resolveConfigPath({ env: ctx.env, hypHome })
  const log = getLogger('linear')
  const abort = new AbortController()
  const cancel = () => abort.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  let step = 'read_config'
  try {
    const layers = await readLocalPluginLayers(stateRoot, configPath)
    const centralLinear = layers.centralConfig?.plugins?.find(plugin => plugin.name === LINEAR)
    const linear = centralLinear ?? layers.localConfig?.plugins?.find(plugin => plugin.name === LINEAR)
    const centralGraph = layers.centralConfig?.plugins?.find(plugin => plugin.name === GRAPH)
    const validated = validateLinearConfig(linear?.config)
    if (!validated.config) throw new Error(`invalid Linear config in ${configPath}`)
    const { config } = validated
    if (centralGraph?.enabled === false || (centralLinear && (centralLinear.enabled === false || !config.teams.length || requested))) {
      throw new Error('your organization manages the Linear or context graph settings. Ask your administrator to enable collection and select the teams.')
    }

    step = 'authenticate'
    const connection = { config, stateDir: pluginStateDir(stateRoot, LINEAR), env: ctx.env, signal: abort.signal }
    const account = ctx.env[config.token_env]?.trim()
      ? await createLinearClient(connection).identity()
      : await authorizeLinear(connection, ctx.stdout, args.params['no-browser'] === true, abort.signal)
    ctx.stdout.write(`Connected to Linear workspace ${account.workspace}.\n`)
    log.info('linear.connect_authenticated', { operation: 'linear.connect', status: 'ok' })

    step = 'select_teams'
    let teams = requested ? explicit.config.teams : /** @type {string[] | undefined} */ (linear?.config?.teams) ?? []
    if (!teams.length) {
      const available = await listLinearTeams(connection, account.workspace_id)
      const options = available.map(({ id, key, name }) => ({ value: id, label: `${key} · ${sanitizeLabel(name) ?? key}` }))
      if (!options.length) throw new Error('no teams are available in this Linear workspace')
      if (options.length === 1) teams = [options[0].value]
      else if (ctx.stdin && isTty(ctx.stdin) && isTty(ctx.stdout)) {
        teams = (await multiselect({ title: 'Which Linear teams should HypAware collect?', options, stdin: ctx.stdin,
          stdout: /** @type {NodeJS.WritableStream} */ (/** @type {unknown} */ (ctx.stdout)), env: ctx.env })).map(String)
      } else {
        ctx.stderr.write(`hyp linear connect: choose teams with --team in a non-interactive terminal. Available teams: ${available.map(team => team.key).join(', ')}\n`)
        log.info('linear.connect_finished', { operation: 'linear.connect', status: 'selection_required' })
        return 2
      }
      if (!teams.length) {
        ctx.stdout.write('No teams selected. Run `hyp linear connect` to finish setup.\n')
        log.info('linear.connect_finished', { operation: 'linear.connect', status: 'no_selection' })
        return 0
      }
      if (!validateLinearConfig({ teams }).ok) throw new Error('select at most 100 Linear teams')
      const selected = new Set(teams)
      ctx.stdout.write(`Selected teams: ${available.filter(team => selected.has(team.id)).map(team => team.key).join(', ')}\n`)
    }

    step = 'save_config'
    abort.signal.throwIfAborted()
    const changed = !centralLinear && await saveLinearSelection({ stateRoot, configPath, teams, before: layers })
    log.info('linear.connect_configured', { operation: 'linear.connect', status: 'ok', team_count: teams.length, config_changed: changed })
    ctx.stdout.write('Linear collection is configured. Run `hyp linear status` to check it.\n')
    if (changed) {
      step = 'restart_daemon'
      const { serviceDaemonStatus, restartServiceDaemon } = await import('../daemon/install.js')
      const options = { homeDir: ctx.env.HOME, platform: ctx.platform }
      const status = await serviceDaemonStatus(options)
      if (status.active || status.pid) await restartServiceDaemon(options)
      else if (status.unreachable) throw new Error('could not check the running daemon')
    }
    return 0
  } catch (err) {
    if (abort.signal.aborted || isPromptCancelledError(err)) {
      log.info('linear.connect_finished', { operation: 'linear.connect', status: 'cancelled', step })
      return 130
    }
    const errorKind = /** @type {{ hypErrorKind?: string }} */ (err)?.hypErrorKind ?? `linear_connect_${step}`
    log.warn('linear.connect_failed', { operation: 'linear.connect', status: 'error', error_kind: errorKind, step })
    const detail = step === 'restart_daemon' ? 'settings were saved. Run `hyp daemon restart` to load them.'
      : step === 'save_config' ? 'could not save settings. Check the config file and run `hyp linear connect` again.'
      : err instanceof Error ? err.message : 'could not connect to Linear'
    ctx.stderr.write(`hyp linear connect: ${detail}\n`)
    return 1
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}

/** @param {{ stateRoot: string, configPath: string, teams: string[], before: Awaited<ReturnType<typeof readLocalPluginLayers>> }} args */
function saveLinearSelection({ stateRoot, configPath, teams, before }) {
  return updateLocalPluginSelection({ stateRoot, configPath, select(config, current) {
    const relevant = (/** @type {HypAwareV2Config | null} */ layer) => layer?.plugins?.filter(plugin => plugin.name === LINEAR || plugin.name === GRAPH) ?? []
    for (const layer of ['centralConfig', 'localConfig']) {
      if (!isDeepStrictEqual(relevant(current[layer]), relevant(before[layer]))) throw new Error('Linear or context graph config changed during sign-in')
    }
    const plugins = config.plugins ??= []
    const addOrEnable = (/** @type {typeof LINEAR | typeof GRAPH} */ name, /** @type {JsonObject | undefined} */ changes) => {
      if (current.centralConfig?.plugins?.some(plugin => plugin.name === name)) return
      const existing = plugins.find(plugin => plugin.name === name)
      const entry = existing ?? { name }
      if (!existing) plugins.push(entry)
      if (entry.enabled === false) entry.enabled = true
      if (changes) entry.config = { ...entry.config, ...changes }
    }
    addOrEnable(GRAPH, undefined)
    addOrEnable(LINEAR, { teams })
  } })
}

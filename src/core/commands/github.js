// @ts-check

import { parseCoreCommandArgv } from '../cli/command_args.js'
import { enableGithubCollection, GITHUB_COLLECTION_PLUGINS } from '../cli/wizard/pick.js'
import { updateLocalPluginSelection } from '../config/local_plugin_selection.js'
import { readObservabilityEnv } from '../observability/env.js'
import { Attr, withSpan } from '../observability/index.js'
import { resolveConfigPath } from '../runtime/boot.js'

/** @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js' */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0615#connect [implements]: the standalone opt-in enables config before invoking the existing device login
 */
export async function runGithubConnect(argv, ctx) {
  const args = parseCoreCommandArgv('github connect', argv, ctx)
  if (!args.ok) return args.code

  const { stateDir: stateRoot, hypHome } = readObservabilityEnv(ctx.env)
  const configPath = resolveConfigPath({ env: ctx.env, hypHome })
  return withSpan('github.connect', { [Attr.OPERATION]: 'github.connect' }, async span => {
    let step = 'save_config'
    try {
      const changed = await updateLocalPluginSelection({ stateRoot, configPath, select(config, { centralConfig }) {
        const locked = new Set()
        for (const plugin of centralConfig?.plugins ?? []) {
          if (!GITHUB_COLLECTION_PLUGINS.includes(plugin.name)) continue
          if (plugin.enabled === false) throw new Error(`${plugin.name} is disabled by your organization. Ask your administrator to enable it.`)
          locked.add(plugin.name)
        }
        enableGithubCollection(config, locked)
      } })
      span.setAttribute('config_changed', changed)

      step = 'login'
      const code = await ctx.commands.run('github login', args.params['no-browser'] === true ? ['--no-browser'] : [])
      if (code !== 0) {
        span.setAttribute('status', code === 130 ? 'cancelled' : 'error')
        span.setAttribute(Attr.ERROR_KIND, 'github_login_incomplete')
        ctx.stderr.write('GitHub collection is configured. Re-run `hyp github connect` to finish sign-in and load the settings.\n')
        return code
      }

      step = 'restart_daemon'
      const { serviceDaemonStatus, restartServiceDaemon } = await import('../daemon/install.js')
      const options = { homeDir: ctx.env.HOME, platform: ctx.platform }
      const status = await serviceDaemonStatus(options)
      if (status.unreachable) throw new Error('could not check the running daemon')
      if (status.active || status.pid) await restartServiceDaemon(options)
      ctx.stdout.write('GitHub collection is configured. Run `hyp github status` to check it.\n')
      span.setAttribute('status', 'ok')
      return 0
    } catch (err) {
      span.setAttribute('status', 'error')
      span.setAttribute(Attr.ERROR_KIND, `github_connect_${step}`)
      const message = step === 'restart_daemon' ? 'Sign-in succeeded. Run `hyp daemon restart` to load the settings.'
        : step === 'login' ? 'GitHub collection is configured. Re-run `hyp github connect` to finish sign-in and load the settings.'
        : err instanceof Error ? err.message : 'could not save the GitHub settings'
      ctx.stderr.write(`hyp github connect: ${message}\n`)
      return 1
    }
  }, { component: 'github' })
}

// @ts-check

import fs from 'node:fs/promises'
import { Attr, withSpan } from '../../observability/index.js'
import { isTty } from '../tui-router.js'
import { isPromptCancelledError } from '../tui/runtime.js'
import { defaultConfirmSelectPromptFactory } from '../walkthrough.js'
import { commitWizardPickedConfig } from './pick.js'

/**
 * @import { RunWizardGithubOptions } from '../../../../src/core/cli/wizard/types.js'
 * @import { CommandRunContext, HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * @param {RunWizardGithubOptions} opts
 * @returns {Promise<'yes' | 'no' | 'cancelled'>}
 */
// @ref LLP 0411#offer [implements]: express setup still asks separately before enabling GitHub
export async function offerWizardGithub(opts) {
  if (!opts.interactive || (!opts.confirm && !(isTty(opts.stdin ?? process.stdin) && isTty(opts.stdout)))) return 'no'
  const confirm = opts.confirm ?? defaultConfirmSelectPromptFactory(opts)
  return withSpan('wizard.github.offer', {
    [Attr.COMPONENT]: 'wizard', [Attr.OPERATION]: 'wizard.github.offer',
  }, async (span) => {
    try {
      const answer = await confirm({
        title: 'Would you like to collect GitHub information from your AI sessions so HypAware can query repositories, pull requests, and more?',
        options: [
          { value: 'yes', label: 'Yes, connect GitHub', summary: 'Opens GitHub in your browser to sign in. GitHub asks for repo access, including private repositories; HypAware only reads.' },
          { value: 'no', label: 'Not now' },
        ],
        default: 'yes',
        eofValue: 'no',
      })
      span.setAttribute('status', answer === 'yes' ? 'accepted' : 'declined')
      return answer === 'yes' ? 'yes' : 'no'
    } catch (err) {
      if (!isPromptCancelledError(err)) throw err
      span.setAttribute('status', 'cancelled')
      return 'cancelled'
    }
  }, { component: 'wizard' })
}

/**
 * The command seam activates newly configured plugins from disk on demand.
 * OAuth, browser opening, cancellation and token storage belong to that verb.
 * @param {{ stderr: RunWizardGithubOptions['stderr'], ctx: Pick<CommandRunContext, 'commands'> }} opts
 * @returns {Promise<void>}
 */
// @ref LLP 0411#login [implements]: reuse browser login after enabling GitHub in the completed setup
export async function loginWizardGithub(opts) {
  await withSpan('wizard.github.login', {
    [Attr.COMPONENT]: 'wizard', [Attr.OPERATION]: 'wizard.github.login',
  }, async (span) => {
    let ok = false
    try {
      ok = await opts.ctx.commands.run('github login', []) === 0
    } catch {
      // The standalone login reports its own details. Keep setup recoverable.
    }
    span.setAttribute('status', ok ? 'ok' : 'error')
    if (!ok) {
      span.setAttribute(Attr.ERROR_KIND, 'github_login_incomplete')
      opts.stderr.write('GitHub sign-in did not finish. Setup will continue; run `hyp github login` to try again.\n')
    }
  }, { component: 'wizard' })
}

/**
 * @param {{ stdout: RunWizardGithubOptions['stdout'], stderr: RunWizardGithubOptions['stderr'], ctx: Pick<CommandRunContext, 'commands'>, configPath: string, restartDaemon: boolean }} opts
 * @returns {Promise<HypAwareV2Config | undefined>}
 */
// @ref LLP 0411#activation [implements]: extend the saved config after upload, preserving changes made during setup
export async function connectWizardGithub(opts) {
  return withSpan('wizard.github.connect', {
    [Attr.COMPONENT]: 'wizard', [Attr.OPERATION]: 'wizard.github.connect',
  }, async (span) => {
    /** @type {HypAwareV2Config} */
    let config
    try {
      config = JSON.parse(await fs.readFile(opts.configPath, 'utf8'))
      const plugins = config.plugins ??= []
      for (const name of ['@hypaware/context-graph', '@hypaware/github']) {
        const existing = plugins.find((plugin) => plugin.name === name)
        if (existing) existing.enabled = true
        else plugins.push({ name })
      }
      const committed = await commitWizardPickedConfig({
        ...opts, config, interactive: false, force: true,
      })
      if (!committed.ok) throw new Error('config write refused')
    } catch {
      span.setAttribute('status', 'error')
      span.setAttribute(Attr.ERROR_KIND, 'github_config_write_failed')
      opts.stderr.write('Could not enable GitHub collection. Re-run `hyp setup` to try again.\n')
      return undefined
    }
    await loginWizardGithub(opts)
    if (opts.restartDaemon) {
      try {
        if (await opts.ctx.commands.run('daemon restart', []) !== 0) throw new Error('restart failed')
      } catch {
        span.setAttribute('status', 'error')
        span.setAttribute(Attr.ERROR_KIND, 'github_daemon_restart_failed')
        opts.stderr.write('GitHub collection is configured. Run `hyp daemon restart` to start it.\n')
        return config
      }
    }
    span.setAttribute('status', 'ok')
    return config
  }, { component: 'wizard' })
}

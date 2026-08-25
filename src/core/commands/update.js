// @ts-check

import { parseCoreCommandArgv } from '../cli/command_args.js'
import { readObservabilityEnv } from '../observability/env.js'
import { readSelfPackageIdentity, runSelfUpdatePass } from '../update/self_update.js'
import { processIsAlive, readPidFile } from '../daemon/pid.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * `hyp update`: check the registry and apply a newer HypAware release
 * now. The manual lane beside the daemon's automatic one, and the
 * repair path when auto-update is off, degraded, or skipped by the
 * provenance guard.
 *
 * @ref LLP 0309#cli-surface [implements]: applies immediately, then restarts the daemon so running code matches
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runUpdate(argv, ctx) {
  const parsed = parseCoreCommandArgv('update', argv, ctx)
  if (!parsed.ok) return parsed.code

  const stateRoot = readObservabilityEnv(ctx.env).stateDir
  const identity = readSelfPackageIdentity()
  const result = await runSelfUpdatePass({
    stateRoot,
    env: ctx.env,
    force: true,
  })

  if (result.action === 'checked' && !result.reason) {
    ctx.stdout.write(`hypaware ${identity.version} is up to date\n`)
    return 0
  }
  if (result.reason === 'probe_failed') {
    ctx.stderr.write('hyp update: could not reach the npm registry; try again later\n')
    return 1
  }
  if (result.reason === 'checkout' || result.reason === 'npx') {
    const how = result.reason === 'checkout' ? 'a source checkout' : 'an npx cache'
    ctx.stderr.write(
      `hyp update: ${result.latest} is available but this install runs from ${how}, ` +
      `which never self-updates. Install with 'npm install -g ${identity.name}' instead.\n`
    )
    return 1
  }
  if (result.action !== 'updated') {
    ctx.stderr.write(
      `hyp update: install of ${result.latest ?? 'the update'} failed ` +
      `(${result.reason ?? 'unknown error'}). ` +
      `Run 'npm install -g ${identity.name}@latest' manually.\n`
    )
    return 1
  }

  ctx.stdout.write(`hypaware updated: ${identity.version} -> ${result.latest}\n`)
  return restartDaemonIfRunning(ctx, result.latest ?? '')
}

/**
 * After a manual update the running daemon is still the old code, so
 * finish by restarting it when one is present. A missing daemon is not
 * an error; a foreground daemon cannot be relaunched from here, so it
 * gets a hint instead.
 *
 * @param {CommandRunContext} ctx
 * @param {string} version
 * @returns {Promise<number>}
 */
async function restartDaemonIfRunning(ctx, version) {
  const { restartServiceDaemon, serviceDaemonStatus } = await import('../daemon/install.js')
  const status = await serviceDaemonStatus({ homeDir: ctx.env.HOME })
  if (status.installed) {
    try {
      await restartServiceDaemon({ homeDir: ctx.env.HOME })
      ctx.stdout.write(`daemon: restarted on ${version}\n`)
      return 0
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.stderr.write(`hyp update: installed ${version} but the daemon restart failed: ${message}\n`)
      ctx.stderr.write("  run 'hyp daemon restart' to finish\n")
      return 1
    }
  }
  const stateRoot = readObservabilityEnv(ctx.env).stateDir
  const pid = readPidFile(stateRoot)
  if (pid && processIsAlive(pid.pid)) {
    ctx.stdout.write(
      `daemon: running in the foreground on the old version; restart it to load ${version}\n`
    )
  }
  return 0
}


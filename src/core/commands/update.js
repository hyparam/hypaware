// @ts-check

import { parseCoreCommandArgv } from '../cli/command_args.js'
import { readObservabilityEnv } from '../observability/env.js'
import { readSelfPackageIdentity, runSelfUpdatePass } from '../update/self_update.js'
import { processIsAlive, readPidFile } from '../daemon/pid.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { restartServiceDaemon as restartServiceDaemonFn } from '../../../src/core/daemon/install.js'
 * @import { serviceDaemonStatus as serviceDaemonStatusFn } from '../../../src/core/daemon/install.js'
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
  // The daemon's own lane may be mid-`npm install -g` right now, and that
  // briefly leaves this package root without a package.json. Unguarded,
  // `hyp update` would die on a raw ENOENT instead of reaching the
  // apply-lock message that explains what is actually happening.
  /** @type {{ name: string, version: string }} */
  let identity
  try {
    identity = readSelfPackageIdentity()
  } catch {
    identity = { name: 'hypaware', version: 'unknown' }
  }

  // Load the restart helpers *before* the install runs. `npm install -g`
  // replaces this very package directory underneath the running process,
  // so a dynamic import issued afterwards can resolve a path that no
  // longer exists - failing exactly between a successful install and the
  // restart that makes it take effect, the one window where a crash
  // leaves the daemon on stale code with no message saying so.
  const daemonInstall = await import('../daemon/install.js')

  const result = await runSelfUpdatePass({
    stateRoot,
    env: ctx.env,
    force: true,
    // The pass never throws: an unexpected failure (an unwritable run
    // directory, a lock this machine cannot take) collapses into a bare
    // `unexpected_error` reason that names nothing an operator can act
    // on, and the daemon's file log is not where a hand-typed command
    // reports. Pass the diagnostic events through; the routine ones are
    // already this command's own output.
    log: (event, fields) => {
      if (event !== 'self_update.error' && event !== 'self_update.registry_override_ignored') return
      try { ctx.stderr.write(`${event} ${JSON.stringify(fields ?? {})}\n`) } catch { /* stderr gone */ }
    },
  })

  if (result.action === 'checked' && !result.reason) {
    ctx.stdout.write(`hypaware ${identity.version} is up to date\n`)
    return 0
  }
  if (result.reason === 'apply_locked') {
    ctx.stderr.write(
      "hyp update: another update is already running (the daemon's own check, most likely); " +
      'try again in a minute\n'
    )
    return 1
  }
  if (result.reason === 'probe_failed') {
    ctx.stderr.write('hyp update: could not reach the npm registry; try again later\n')
    return 1
  }
  // Not an install failure: the updater declined to install at all,
  // because npm_config_registry names somewhere it will not fetch a
  // tarball from and installing from anywhere else would swap this
  // package's supply out from under whoever configured that registry.
  // The generic branch below would blame the install and tell the
  // operator to rerun npm by hand with the same variable still set.
  //
  // Two refusals land on this one reason: an override the updater will
  // not fetch a tarball from, and two spellings of the variable that
  // disagree (`registry_ambiguous` in the log). Naming plain http as the
  // cause, and "an https URL" as the repair, is false and unactionable
  // for the second, whose two values are usually https already; the
  // `self_update.registry_override_ignored` line already on stderr says
  // which of the two happened.
  if (result.reason === 'registry_untrusted') {
    ctx.stderr.write(
      `hyp update: ${result.latest ?? 'an update'} is available, but npm_config_registry does not ` +
      'name a registry this updater will install from, and it will not silently install from a ' +
      'different one instead.\n' +
      "  point it at a single https URL, or configure the registry in .npmrc, " +
      "then run 'hyp update' again\n"
    )
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
  return restartDaemonIfRunning(ctx, result.latest ?? '', daemonInstall)
}

/**
 * After a manual update the running daemon is still the old code, so
 * finish by restarting it when one is present. A missing daemon is not
 * an error; a foreground daemon cannot be relaunched from here, so it
 * gets a hint instead.
 *
 * @param {CommandRunContext} ctx
 * @param {string} version
 * @param {{
 *   restartServiceDaemon: typeof restartServiceDaemonFn,
 *   serviceDaemonStatus: typeof serviceDaemonStatusFn,
 * }} daemonInstall
 * @returns {Promise<number>}
 */
async function restartDaemonIfRunning(ctx, version, daemonInstall) {
  const { restartServiceDaemon, serviceDaemonStatus } = daemonInstall
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


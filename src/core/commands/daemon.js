// @ts-check

import path from 'node:path'
import { parseCommandArgv } from '../cli/verb_codec.js'
import process from 'node:process'

import { readObservabilityEnv } from '../observability/env.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { DaemonInstallOptions } from '../../../src/core/daemon/types.js'
 * @import { uninstallDaemon as uninstallDaemonFn } from '../../../src/core/daemon/install.js'
 */

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
export async function runDaemonRun(argv, ctx) {
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
export async function runDaemonStatus(argv, ctx) {
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
export async function runDaemonStop(_argv, ctx) {
  const { requestDaemonStop } = await import('../daemon/runtime.js')
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const outcome = await requestDaemonStop({ stateRoot: stateDir })
  if (outcome === 'not_running') {
    ctx.stdout.write('daemon: not running\n')
    return 0
  }
  if (outcome === 'timed_out') {
    // `hyp daemon stop:`, not the bare `daemon:` the success lines use: this
    // is a failure (exit 1), and the `hyp <cmd>:` shape is what every other
    // daemon subcommand's errors already use - and what marks it as one.
    ctx.stderr.write('hyp daemon stop: stop signal sent but the daemon did not exit within 5s\n')
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
export async function runDaemonRestart(_argv, ctx) {
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
export async function runDaemonInstall(argv, ctx) {
  const parsed = parseDaemonInstallArgs(argv)
  if (parsed.help) {
    ctx.stdout.write(
      'usage: hyp daemon install [--config <path>] [--bin <path>] [--dry-run [--json] [--platform darwin|linux]]\n'
    )
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
    // An explicit --bin is the escape hatch: installDaemon must keep it
    // verbatim. A default binPath from process.argv[1] under npx points
    // into the _npx cache, so installDaemon upgrades it to a durable
    // global bin (LLP 0025: join stays a wrapper over this same path).
    binExplicit: parsed.binPath !== undefined,
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
 * `hyp daemon uninstall`: remove the persistent service and detach the
 * clients it was serving, while leaving config, recordings, and logs in
 * place.
 *
 * The detach sweep is the exception to "each connection level exits with its
 * own verb" (LLP 0063 #connection-levels): an attached client points at the
 * local gateway port, and once the service is gone that port answers nothing,
 * so leaving the attach in place leaves every attached client broken rather
 * than merely unmonitored.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @param {{ uninstallDaemon?: typeof uninstallDaemonFn }} [deps] test seam for the service teardown
 * @ref LLP 0206#d1 [implements]: uninstall reaches down to level 1 so it cannot leave clients pointed at a dead port
 */
export async function runDaemonUninstall(argv, ctx, deps = {}) {
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      ctx.stdout.write('usage: hyp daemon uninstall\n')
      return 0
    }
    ctx.stderr.write(`hyp daemon uninstall: unexpected argument '${token}'\n`)
    return 2
  }
  const { uninstallDaemon, daemonKindLabel } = await import('../daemon/install.js')
  const { detachAllClientsFromDisk } = await import('./clients.js')
  const homeDir = ctx.env.HOME
  try {
    await (deps.uninstallDaemon ?? uninstallDaemon)({ ...(homeDir !== undefined ? { homeDir } : {}) })
    ctx.stdout.write(`✓ Daemon removed (${daemonKindLabel()})\n`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon uninstall: ${message}\n`)
    return 1
  }
  // Only reached once the service is actually gone: a failed uninstall leaves a
  // daemon still serving that port, and detaching from it would break capture
  // for no reason.
  /** @type {Awaited<ReturnType<typeof detachAllClientsFromDisk>>} */
  let sweep
  try {
    sweep = await detachAllClientsFromDisk(ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon uninstall: could not detach clients: ${message}\n`)
    ctx.stderr.write("  the service is gone; run 'hyp detach <client>' for each attached client by hand\n")
    return 1
  }
  for (const client of sweep.detached) {
    ctx.stdout.write(
      `  Detached ${client.name}${client.settingsPath !== undefined ? ` (${client.settingsPath})` : ''}\n`
    )
    // The undo ran quiet, so these lines exist nowhere else: a warning here
    // ("overridden externally; leaving in place") is the difference between a
    // detach that finished and one the user still has to finish by hand.
    if (client.removed !== undefined) ctx.stdout.write(`    Removed ${client.removed}\n`)
    if (client.restoredValue !== undefined) ctx.stdout.write(`    Restored ${client.restoredValue}\n`)
    for (const restoredPath of client.restoredPaths ?? []) {
      ctx.stdout.write(`    Restored ${restoredPath} from the marker's malformed-block backup\n`)
    }
    if (client.warning !== undefined) ctx.stdout.write(`    warning: ${client.warning}\n`)
  }
  for (const line of sweep.purgeLines ?? []) {
    ctx.stdout.write(`  ${line}\n`)
  }
  for (const failure of sweep.failed) {
    ctx.stderr.write(`hyp daemon uninstall: detach '${failure.name}' failed: ${failure.message}\n`)
    ctx.stderr.write(`  run 'hyp detach ${failure.name}' to finish reversing it\n`)
  }
  if (sweep.failed.length > 0) {
    // Exit 1 here means the sweep, not the teardown: without this line a
    // partly-failed sweep reads as an uninstall that did not happen.
    ctx.stderr.write('  the service itself was removed; only the client detach needs finishing\n')
    return 1
  }
  return 0
}

/**
 * `hyp daemon start`: start (kickstart) the installed service.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runDaemonStart(argv, ctx) {
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
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      config: { type: 'string' },
      bin: { type: 'string' },
      platform: { type: 'string', enum: ['darwin', 'linux'] },
    },
  })
  if ('help' in parsed) return { help: true }
  if (!parsed.ok) return { error: parsed.error }
  const p = /** @type {{ 'dry-run': boolean, json: boolean, config?: string, bin?: string, platform?: NodeJS.Platform }} */ (parsed.params)
  if (p.json && !p['dry-run']) return { error: '--json requires --dry-run' }
  // A real install writes into the host's own service directory and then calls
  // that host's service manager, so a cross-platform install is never anything
  // but a broken one. The flag stays public for rendering the other platform's
  // unit, and is refused everywhere else.
  // @ref LLP 0265#platform-is-a-render-override [implements]: --platform is accepted only alongside --dry-run
  if (p.platform !== undefined && !p['dry-run']) return { error: '--platform requires --dry-run' }
  return { dryRun: p['dry-run'], json: p.json, configPath: p.config, binPath: p.bin, platform: p.platform }
}

/**
 * @param {string[]} argv
 * @returns {{ foreground: boolean, configPath?: string, error?: string }}
 */
function parseDaemonRunArgs(argv) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      foreground: { type: 'boolean', default: false },
      config: { type: 'string' },
    },
  }, { aliases: { '-f': '--foreground' } })
  if ('help' in parsed) return { foreground: false, error: 'usage: hyp daemon run --foreground [--config <path>]' }
  if (!parsed.ok) return { foreground: false, error: parsed.error }
  const p = /** @type {{ foreground: boolean, config?: string }} */ (parsed.params)
  return { foreground: p.foreground, configPath: p.config }
}

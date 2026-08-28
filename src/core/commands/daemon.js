// @ts-check

import os from 'node:os'
import path from 'node:path'
import { parseCoreCommandArgv } from '../cli/command_args.js'
import { parseCommandArgv } from '../cli/verb_codec.js'
import process from 'node:process'

import { readObservabilityEnv } from '../observability/env.js'
import { sanitizeLabel } from '../util/json_util.js'

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
  // @ref LLP 0300#home-resolution [implements]: env.HOME wins, os.homedir() is the fallback; '' is never a home (it would put the daemon's state root at ./.hyp)
  const hypHome = ctx.env.HYP_HOME || path.join(ctx.env.HOME || os.homedir(), '.hyp')
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
 * How much of an `error=` line a hostile status file may spend. Wider than a
 * label's 120, because unlike a name this carries a real error message -
 * typically an fs error naming a full path - and the clamp exists to stop the
 * line being bloated, not to bound an identifier.
 */
const MAX_ERROR_CHARS = 400

/**
 * A value out of `status.json` on its way to the terminal, made safe to print.
 *
 * `hyp status` cleans what it reads back out of this same file at the last
 * point before render, for a reason that is a property of the file and not of
 * that command: `status.json` is a *file*, and core cannot assume the daemon
 * that wrote it was this version, this build, or well behaved
 * (LLP 0164#status-reads-it-from-the-status-file). Nothing validates a field
 * on read, so a raw value can carry an escape sequence that repaints the
 * operator's screen or a newline that forges a plausible extra status line.
 *
 * Cleaning happens here rather than in `readStatusFile` because the reader
 * also feeds `--json`, which is the machine copy and must stay byte-exact:
 * escaping is a render's job, never a read's (LLP 0225).
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 * @ref LLP 0164#status-reads-it-from-the-status-file [constrained-by]: what core reads back out of status.json is cleaned at the last point before render, on every surface that prints it
 */
function printable(value, max) {
  return sanitizeLabel(value, max) ?? ''
}

/**
 * A field `DaemonStatus` types as a number, printed as itself when the file
 * really holds one and cleaned as a label when it does not. `String` is safe
 * over anything `JSON.parse` produced, so a wrong-typed field still shows
 * *something* rather than vanishing into an empty column.
 *
 * @param {unknown} value
 * @returns {string}
 */
function printableNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return printable(String(value))
}

/**
 * A `sources` / `sinks` entry list out of the status file. Anything that is
 * not an array is no list at all: the walk below would throw straight out
 * through the CLI, which is the same raw-stack failure the read is guarded
 * against.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>[]}
 */
function entryList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => !!entry && typeof entry === 'object')
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runDaemonStatus(argv, ctx) {
  const parsed = parseCoreCommandArgv('daemon status', argv, ctx)
  if (!parsed.ok) return parsed.code
  const json = parsed.params.json === true
  const { readStatusFile } = await import('../daemon/status.js')
  const { readPidFile, processIsAlive } = await import('../daemon/pid.js')
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  /** @type {ReturnType<typeof readStatusFile>} */
  let status
  /** @type {ReturnType<typeof readPidFile>} */
  let pidEntry
  try {
    status = readStatusFile(stateDir)
    pidEntry = readPidFile(stateDir)
  } catch (err) {
    // Both readers throw on a file they cannot make sense of, and
    // `JSON.parse`'s message quotes an excerpt of the input verbatim. Left
    // uncaught that reached the operator as a raw stack trace carrying the
    // file's own bytes: useless as a diagnosis, and the one path on which the
    // file reached the terminal entirely unfiltered.
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon status: ${printable(message, MAX_ERROR_CHARS)}\n`)
    return 1
  }
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
  // Everything below this line came out of the file and is going to a
  // terminal, so everything below this line is cleaned on the way.
  ctx.stdout.write(`daemon: ${printable(status.state)}${running ? '' : ' (no live process)'}\n`)
  ctx.stdout.write(`  pid:        ${printableNumber(status.pid)}\n`)
  ctx.stdout.write(`  startedAt:  ${printable(status.startedAt)}\n`)
  if (status.healthyAt) ctx.stdout.write(`  healthyAt:  ${printable(status.healthyAt)}\n`)
  if (status.stoppedAt) ctx.stdout.write(`  stoppedAt:  ${printable(status.stoppedAt)}\n`)
  ctx.stdout.write(`  uptime_ms:  ${printableNumber(liveUptimeMs)}\n`)
  const sources = entryList(status.sources)
  const sinks = entryList(status.sinks)
  ctx.stdout.write('  sources:\n')
  if (sources.length === 0) {
    ctx.stdout.write('    (none)\n')
  } else {
    for (const source of sources) {
      const error = printable(source.error, MAX_ERROR_CHARS)
      ctx.stdout.write(`    - ${printable(source.name)} (${printable(source.plugin)}): ${printable(source.state)}${error ? ' - ' + error : ''}\n`)
    }
  }
  ctx.stdout.write('  sinks:\n')
  if (sinks.length === 0) {
    ctx.stdout.write('    (none)\n')
  } else {
    for (const sink of sinks) {
      ctx.stdout.write(`    - ${printable(sink.instance)} (${printable(sink.plugin)}, ${printable(sink.kind)})\n`)
    }
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runDaemonStop(argv, ctx) {
  const parsed = parseCoreCommandArgv('daemon stop', argv, ctx)
  if (!parsed.ok) return parsed.code
  const { requestDaemonStop } = await import('../daemon/runtime.js')
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  // The requester-side control-dir warnings (a chmod it could not apply)
  // land on stderr; they do not change the exit code.
  const outcome = await requestDaemonStop({
    stateRoot: stateDir,
    log: {
      warn: (event, fields) => {
        const message = fields && typeof fields.message === 'string' ? `: ${fields.message}` : ''
        ctx.stderr.write(`hyp daemon stop: warning: ${event}${message}\n`)
      },
    },
  })
  if (outcome === 'not_running') {
    ctx.stdout.write('daemon: not running\n')
    return 0
  }
  if (outcome === 'timed_out') {
    // `hyp daemon stop:`, not the bare `daemon:` the success lines use: this
    // is a failure (exit 1), and the `hyp <cmd>:` shape is what every other
    // daemon subcommand's errors already use - and what marks it as one.
    // The transport differs per platform (win32 writes a stop.request file
    // and deliberately leaves it for the daemon to consume), so the message
    // names the one actually used.
    const detail = process.platform === 'win32'
      ? 'stop request written but the daemon did not exit within 5s; the request file is left for it to consume'
      : 'stop signal sent but the daemon did not exit within 5s'
    ctx.stderr.write(`hyp daemon stop: ${detail}\n`)
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
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runDaemonRestart(argv, ctx) {
  const parsed = parseCoreCommandArgv('daemon restart', argv, ctx)
  if (!parsed.ok) return parsed.code
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
    ctx.stdout.write('usage: hyp daemon install [--config <path>] [--bin <path>] [--dry-run [--json]]\n')
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
  const parsed = parseCoreCommandArgv('daemon uninstall', argv, ctx)
  if (!parsed.ok) return parsed.code
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
    ctx.stderr.write("  the service is gone; run 'hyp client detach <client>' for each attached client by hand\n")
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
    ctx.stderr.write(`  run 'hyp client detach ${failure.name}' to finish reversing it\n`)
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
  const parsed = parseCoreCommandArgv('daemon start', argv, ctx)
  if (!parsed.ok) return parsed.code
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

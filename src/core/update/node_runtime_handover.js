// @ts-check

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { atomicWriteFileSync } from '../util/fs_atomic.js'
import { withFileLock } from '../util/file_lock.js'
import { defaultPlistDir, defaultUnitDir, plistFileName, unitFileName } from '../daemon/platform.js'
import { quoteExecArg } from '../daemon/linux.js'
import { runServiceCommand } from '../daemon/service_ops.js'
import { nodeRuntimePaths } from './node_runtime.js'

/** @import { LaunchctlAdapter } from '../../../src/core/daemon/types.js' */

/** @param {string} value */
function decodeXml(value) {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
}

/** @param {string} value */
function realpath(value) {
  try { return fs.realpathSync(value) } catch { return path.resolve(value) }
}

/**
 * @param {string} content
 * @param {string} platform
 * @param {string} oldNodePath
 * @param {string} nodePath
 * @param {string} binPath
 * @ref LLP 0555#daemon-handover [implements]: replace only the interpreter; preserve custom arguments, environment, log paths and unit settings
 */
export function replaceServiceNode(content, platform, oldNodePath, nodePath, binPath) {
  const pattern = platform === 'darwin'
    ? /(<key>ProgramArguments<\/key>\s*<array>\s*<string>)([^<]*)(<\/string>\s*<string>)([^<]*)(<\/string>)/
    : /^(ExecStart=)("(?:[^"\\]|\\.)*"|[^\s]+)(\s+)("(?:[^"\\]|\\.)*"|[^\s]+)([^\r\n]*)/m
  if (platform !== 'darwin' && platform !== 'linux') throw new Error('node_runtime.unsupported_service')
  const match = pattern.exec(content)
  if (!match) throw new Error('node_runtime.unrecognized_service: cannot identify the installed daemon command')
  const decode = platform === 'darwin' ? decodeXml : (/** @type {string} */ value) => value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value
  if (realpath(decode(match[4])) !== realpath(binPath)) throw new Error('node_runtime.service_mismatch: the installed service runs another CLI')
  if (decode(match[2]) === nodePath) return content
  if (realpath(decode(match[2])) !== realpath(oldNodePath)) throw new Error('node_runtime.service_mismatch: the installed interpreter changed')
  const replacement = platform === 'darwin'
    ? nodePath.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    : quoteExecArg(nodePath)
  return content.replace(pattern, () => match[1] + replacement + match[3] + match[4] + match[5])
}

/** @param {NodeJS.ProcessEnv} env @param {string} platform */
function servicePath(env, platform) {
  const home = env.HOME || os.homedir()
  return platform === 'darwin' ? path.join(defaultPlistDir(home), plistFileName()) : path.join(defaultUnitDir(home), unitFileName())
}

/** @param {string} file */
function readService(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('node_runtime.unsafe_service_file')
  return { content: fs.readFileSync(file, 'utf8'), mode: stat.mode & 0o777 }
}

/** @param {string} platform @param {string} nodePath @param {string[]} args */
export function nodeRuntimeHandoverCommand(platform, nodePath, args) {
  // systemd kills the entire old control group on stop, even after setsid.
  // A scope inherits our environment but lives outside that service's group.
  return platform === 'linux'
    ? { command: 'systemd-run', args: ['--user', '--scope', '--quiet', '--collect', '--', nodePath, ...args] }
    : { command: nodePath, args }
}

/**
 * @param {{ nodePath: string, binPath: string, oldNodePath: string, env: NodeJS.ProcessEnv, log: (event: string, fields?: Record<string, unknown>) => void }} opts
 * @returns {Promise<number | undefined>}
 */
export async function handOverNodeRuntime(opts) {
  const original = readService(servicePath(opts.env, process.platform)).content
  if (replaceServiceNode(original, process.platform, opts.oldNodePath, opts.nodePath, opts.binPath) === original) return 75
  const pending = path.join(nodeRuntimePaths(opts.env).root, 'handover.pending')
  try {
    if (Date.now() - fs.lstatSync(pending).mtimeMs < 120_000) {
      opts.log('node_runtime.handover_deferred', { status: 'deferred', error_kind: 'recent_handover_attempt' })
      return undefined
    }
  } catch { /* first attempt */ }
  atomicWriteFileSync(pending, '', { mode: 0o600 })
  opts.log('node_runtime.handover', { status: 'starting' })
  const worker = nodeRuntimeHandoverCommand(process.platform, opts.nodePath, [opts.binPath, '__node_runtime_repoint', opts.oldNodePath, String(process.pid)])
  // @ref LLP 0555#daemon-handover [implements]: an independent process group (launchd) or scope (systemd) survives stopping the bootstrap service
  const child = spawn(worker.command, worker.args, {
    env: opts.env, detached: true, stdio: ['ignore', 'inherit', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve(0) : reject(new Error('node_runtime.service_handover_failed')))
  })
}

/** @param {string} stateRoot @param {number} oldPid @param {number} began */
async function waitForDaemon(stateRoot, oldPid, began) {
  const { readStatusFile } = await import('../daemon/status.js')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const status = readStatusFile(stateRoot)
      if (status && status.pid !== oldPid && Date.parse(status.healthyAt ?? '') >= began &&
          (status.state === 'healthy' || status.state === 'degraded')) return
    } catch { /* boot can briefly leave no readable status */ }
    await delay(200)
  }
  throw new Error('node_runtime.daemon_not_ready: replacement did not publish a fresh heartbeat')
}

/**
 * @param {{
 *   oldNodePath: string, oldPid: number, binPath: string, nodePath?: string,
 *   env?: NodeJS.ProcessEnv, platform?: string, file?: string,
 *   stop?: () => Promise<void>, start?: () => Promise<void>, reload?: () => Promise<void>,
 *   healthy?: (began: number) => Promise<void>,
 *   log?: (event: string, fields?: Record<string, unknown>) => void,
 * }} opts
 */
export async function repointNodeRuntime(opts) {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const paths = nodeRuntimePaths(env)
  const file = opts.file ?? servicePath(env, platform)
  const homeDir = env.HOME || os.homedir()
  const log = opts.log ?? ((event, fields) => process.stderr.write(`${event} ${JSON.stringify(fields ?? {})}\n`))
  const macos = platform === 'darwin' ? await import('../daemon/macos.js') : undefined
  const linux = platform === 'linux' ? await import('../daemon/linux.js') : undefined
  if (!macos && !linux) throw new Error('node_runtime.unsupported_service')
  let serviceDeadline = Date.now() + 30_000
  const command = (/** @type {string} */ bin, /** @type {string[]} */ args) => {
    const remaining = serviceDeadline - Date.now()
    if (remaining <= 0) throw new Error('node_runtime.service_timeout')
    return runServiceCommand(bin, args, { timeoutMs: Math.min(15_000, remaining) })
  }
  /** @type {LaunchctlAdapter} */
  const launchctl = {
    print: args => command('launchctl', ['print', ...args]),
    bootout: args => command('launchctl', ['bootout', ...args]),
    bootstrap: args => command('launchctl', ['bootstrap', ...args]),
    kickstart: args => command('launchctl', ['kickstart', ...args]),
  }
  const systemctl = linux && {
    ...linux.realSystemctl,
    start: unit => command('systemctl', ['--user', 'start', unit]),
    stop: unit => command('systemctl', ['--user', 'stop', unit]),
    daemonReload: () => command('systemctl', ['--user', 'daemon-reload']),
  }
  const stop = opts.stop ?? (() => macos ? macos.stopLaunchAgent({ launchctl }) : /** @type {NonNullable<typeof linux>} */ (linux).stopSystemdUnit({ systemctl }))
  const start = opts.start ?? (() => macos ? macos.startLaunchAgent({ homeDir, launchctl }) : /** @type {NonNullable<typeof linux>} */ (linux).startSystemdUnit({ systemctl }))
  const reload = opts.reload ?? (async () => {
    if (systemctl) {
      const result = await systemctl.daemonReload()
      if (result.exitCode !== 0) throw new Error('node_runtime.service_reload_failed')
    }
  })
  return withFileLock(path.join(paths.root, 'handover.lock'), async () => {
    serviceDeadline = Date.now() + 30_000
    const original = readService(file)
    const updated = replaceServiceNode(original.content, platform, opts.oldNodePath, opts.nodePath ?? paths.nodePath, opts.binPath)
    if (updated === original.content) return
    let written = false
    try {
      atomicWriteFileSync(file, updated, { mode: original.mode })
      written = true
      await stop()
      await reload()
      const began = Date.now()
      await start()
      await (opts.healthy ?? (time => waitForDaemon(path.dirname(paths.root), opts.oldPid, time)))(began)
      try { fs.rmSync(path.join(paths.root, 'handover.pending'), { force: true }) } catch { /* stale marker expires; a healthy daemon must not be rolled back */ }
      log('node_runtime.daemon_repointed', { status: 'ok' })
    } catch (error) {
      if (written) {
        atomicWriteFileSync(file, original.content, { mode: original.mode })
        serviceDeadline = Date.now() + 30_000
        try {
          await stop()
          await reload()
          await start()
          log('node_runtime.handover_restored', { status: 'restored' })
        } catch { log('node_runtime.handover_restore_failed', { status: 'failed' }) }
      }
      log('node_runtime.handover_failed', { status: 'failed' })
      throw error
    }
  }, { staleMs: 120_000 })
}

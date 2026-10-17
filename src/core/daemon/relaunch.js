// @ts-check

import { spawn } from 'node:child_process'
import os from 'node:os'
import process from 'node:process'
import { setTimeout as delayFor } from 'node:timers/promises'

import { SELF_UPDATE_RESTART_EXIT_CODE } from '../update/self_update.js'

/**
 * @import { EventEmitter } from 'node:events'
 * @import { ChildProcess } from 'node:child_process'
 */

/** Relaunches allowed inside one window before the run gives up. */
export const RELAUNCH_LIMIT = 5

/** The window the relaunch count is kept over. */
export const RELAUNCH_WINDOW_MS = 10 * 60_000

/** The stop signals a service manager or `docker stop` sends, plus reload. */
const FORWARDED_SIGNALS = /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])

/**
 * The wait before the nth relaunch of a window: none for the first, so an
 * ordinary config apply costs no downtime, then 1s, 2s, 4s, 8s.
 *
 * @param {number} n zero-based relaunch index inside the window
 * @returns {number}
 */
export function relaunchDelayMs(n) {
  return n === 0 ? 0 : 1000 * 2 ** (n - 1)
}

/**
 * Whether a Node parent launched this process over an IPC channel. Such a
 * parent (an earlier foreground run, or a process manager like pm2) already
 * owns the relaunch, so the run hands its exit code back to it instead.
 *
 * @returns {boolean}
 */
export function hasLauncher() {
  return typeof process.send === 'function'
}

/**
 * Keep an unsupervised `hyp daemon run` serving across the staged restarts
 * its own config applies ask for. The run that asked has already stopped
 * cleanly; this relaunches the same command as a child with the same argv,
 * env, cwd and stdio, so container logs stay attached, and waits for it. A
 * child that exits 75 again comes back here to be relaunched, so at most two
 * processes exist at once and nothing accumulates across relaunches but the
 * window's count.
 *
 * Bounded: after RELAUNCH_LIMIT relaunches inside RELAUNCH_WINDOW_MS, with a
 * growing wait between them, the run stops relaunching and exits 75 itself,
 * naming the staged config, so a config that fails every apply cannot
 * hot-loop.
 *
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   stdout: { write(chunk: string): unknown },
 *   stderr: { write(chunk: string): unknown },
 *   stagedConfigPath: () => string,
 *   command?: string,
 *   args?: string[],
 *   cwd?: string,
 *   spawn?: (command: string, args: string[], options: object) => ChildProcess,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>,
 *   now?: () => number,
 *   signals?: Pick<EventEmitter, 'on' | 'off'>,
 * }} opts
 * @returns {Promise<number>} the exit code the run should end with
 * @ref LLP 0529#bounded [implements]: 5 relaunches per 10 minutes with backoff, then a real exit 75 naming the staged config
 * @ref LLP 0529#signals [implements]: stop signals end the loop, SIGHUP is relaunched as a reload
 */
export async function relaunchForeground(opts) {
  const spawnChild = opts.spawn ?? spawn
  const sleep = opts.sleep ?? ((/** @type {number} */ ms, /** @type {AbortSignal} */ signal) => delayFor(ms, undefined, { signal }))
  const now = opts.now ?? Date.now
  const signals = opts.signals ?? process
  const command = opts.command ?? process.execPath
  const args = opts.args ?? [...process.execArgv, ...process.argv.slice(1)]
  const cwd = opts.cwd ?? process.cwd()

  /** @type {ChildProcess | undefined} */
  let child
  let stopping = false
  // Aborted by a stop, so a stop during a wait ends it at once.
  const waits = new AbortController()
  /** @type {Array<[NodeJS.Signals, () => void]>} */
  const handlers = FORWARDED_SIGNALS.map(signal => [signal, () => {
    // SIGHUP is a reload: the child exits 75 and is relaunched as any other.
    if (signal !== 'SIGHUP') {
      stopping = true
      waits.abort()
    }
    child?.kill(signal)
  }])
  for (const [signal, handler] of handlers) signals.on(signal, handler)

  let windowStart = now()
  let count = 0
  try {
    while (true) {
      if (now() - windowStart >= RELAUNCH_WINDOW_MS) {
        windowStart = now()
        count = 0
      }
      if (count >= RELAUNCH_LIMIT) {
        opts.stderr.write(
          `hyp daemon run: restarted ${RELAUNCH_LIMIT} times in ${RELAUNCH_WINDOW_MS / 60_000} minutes without staying up; ` +
          `exiting ${SELF_UPDATE_RESTART_EXIT_CODE}. Check the staged config: ${opts.stagedConfigPath()}\n`
        )
        return SELF_UPDATE_RESTART_EXIT_CODE
      }
      const delay = relaunchDelayMs(count)
      count += 1
      if (delay > 0) await sleep(delay, waits.signal).catch(() => {})
      if (stopping) return 0
      opts.stdout.write('daemon: relaunching to apply the staged config\n')
      const running = spawnChild(command, args, { cwd, env: opts.env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
      child = running
      /** @type {{ code: number, failed?: boolean }} */
      const ended = await new Promise(resolve => {
        // A relaunch that cannot start ends the run with the code it would
        // have exited with anyway, so an outer loop still sees the restart.
        running.once('error', error => {
          opts.stderr.write(`hyp daemon run: relaunch failed: ${error.message}\n`)
          resolve({ code: SELF_UPDATE_RESTART_EXIT_CODE, failed: true })
        })
        running.once('exit', (exitCode, signal) => {
          resolve({ code: exitCode ?? 128 + (signal ? os.constants.signals[signal] : 0) })
        })
      })
      child = undefined
      if (ended.failed || ended.code !== SELF_UPDATE_RESTART_EXIT_CODE || stopping) return ended.code
    }
  } finally {
    for (const [signal, handler] of handlers) signals.off(signal, handler)
  }
}

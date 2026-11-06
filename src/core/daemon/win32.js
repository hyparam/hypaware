// @ts-check

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { WIN32_TASK_FOLDER, defaultLogDir } from './platform.js'
import { ServiceOpError, defaultSleep, ensureFsOp, ensureOk, runServiceCommand } from './service_ops.js'

/**
 * @import {
 *   SchtasksResult,
 *   SchtasksAdapter,
 *   BuildTaskXmlOptions,
 *   PlanTaskInstallOptions,
 *   TaskInstallPlan,
 * } from '../../../src/core/daemon/types.js'
 */

export class ScheduledTaskError extends ServiceOpError {
  /**
   * @param {string} message
   * @param {{ exitCode?: number, stderr?: string }} [opts]
   */
  constructor(message, opts) {
    super(message, opts)
    this.name = 'ScheduledTaskError'
  }
}

/** @type {SchtasksAdapter} */
export const realSchtasks = {
  create(taskName, xmlPath) { return runServiceCommand('schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F']) },
  delete(taskName) { return runServiceCommand('schtasks', ['/Delete', '/TN', taskName, '/F']) },
  run(taskName) { return runServiceCommand('schtasks', ['/Run', '/TN', taskName]) },
  end(taskName) { return runServiceCommand('schtasks', ['/End', '/TN', taskName]) },
  query(taskName) { return runServiceCommand('schtasks', ['/Query', '/TN', taskName, '/FO', 'CSV', '/NH', '/V']) },
}

/**
 * @param {SchtasksResult} res
 * @param {string} what
 * @returns {SchtasksResult}
 */
function ensure(res, what) {
  return ensureOk(res, what, ScheduledTaskError)
}

/**
 * @template T
 * @param {() => T} fn
 * @param {string} what
 * @returns {T}
 */
function ensureFs(fn, what) {
  return ensureFsOp(fn, what, ScheduledTaskError)
}

/**
 * The current user's SID, resolved synchronously so the plan stays sync like
 * its POSIX siblings. `whoami /user /fo csv /nh` prints one line,
 * `"domain\user","S-1-5-21-..."`; the SID is the part no rename can spoof.
 *
 * A read, not a mutation, so it does not go through the service-manager
 * sandbox guard (that guards `schtasks`, the thing that touches the host).
 * Any failure - not win32, `whoami` absent, a `--dry-run --platform win32`
 * from another OS - falls back to a syntactically valid placeholder so a
 * preview still renders; the real install always resolves the true SID on
 * the win32 host.
 *
 * @returns {string}
 */
function resolveSidSync() {
  try {
    const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
    const m = /"(S-1-[0-9-]+)"/.exec(out)
    if (m) return m[1]
  } catch { /* fall through to the placeholder */ }
  return 'S-1-5-21-0-0-0-1000'
}

/**
 * The per-user task path, `\hypaware\<SID>`. The Task Scheduler library is
 * machine-wide with no per-user domain, so the SID keys the leaf.
 * @ref LLP 0584#naming [implements]: keyed per-user by SID
 * @param {string} sid
 * @returns {string}
 */
export function taskNameForSid(sid) {
  return `\\${WIN32_TASK_FOLDER}\\${sid}`
}

/**
 * The JavaScript entry node runs directly. The durable bin on win32 is the
 * npm `.cmd` shim, which only cmd.exe can run; the task spawns node straight
 * at the JS behind it (LLP 0584 #exec), resolved from npm's stable global
 * layout (`<prefix>\node_modules\hypaware\bin\hypaware.js`). An explicit
 * `--bin` already naming a `.js` is used as-is.
 *
 * @ref LLP 0584#exec [implements]: node points at the JS entry, never the .cmd shim
 * @param {string} binPath
 * @returns {string}
 */
export function resolveTaskJsEntry(binPath) {
  if (/\.(?:c|m)?js$/i.test(binPath)) return binPath
  if (/\.(?:cmd|bat)$/i.test(binPath)) {
    return path.win32.join(path.win32.dirname(binPath), 'node_modules', 'hypaware', 'bin', 'hypaware.js')
  }
  return binPath
}

/**
 * @param {string} value
 * @returns {string}
 */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Build the Task Scheduler task definition XML.
 *
 * Deterministic for the same inputs so tests compare against fixed strings. A
 * logon trigger bound to the user's SID, a least-privilege interactive-token
 * principal (no elevation), single-instance, no execution time limit (the
 * daemon runs until stopped), and restart-on-failure - the win32 equivalent
 * of launchd `KeepAlive` / systemd `Restart=always`, whose floor is one
 * minute (LLP 0584 #supervision). The action runs node at the JS entry with
 * `--supervised`, the marker `detectSupervisor` reads (LLP 0584 #supervision).
 *
 * @ref LLP 0584#task [implements]: per-user logon task, least-privilege, restart-on-failure
 * @param {BuildTaskXmlOptions} options
 * @returns {string}
 */
export function buildTaskXml(options) {
  const { nodePath, jsEntry, configPath, logDir, sid } = options
  if (!nodePath || typeof nodePath !== 'string') throw new ScheduledTaskError('nodePath is required')
  if (!jsEntry || typeof jsEntry !== 'string') throw new ScheduledTaskError('jsEntry is required')
  if (!configPath || typeof configPath !== 'string') throw new ScheduledTaskError('configPath is required')
  if (!logDir || typeof logDir !== 'string') throw new ScheduledTaskError('logDir is required')
  if (!sid || typeof sid !== 'string') throw new ScheduledTaskError('sid is required')

  const description = options.description ?? 'HypAware daemon'
  const restart = options.restart !== false
  const interval = options.restartIntervalIso ?? 'PT1M'
  const enabledAtLogon = options.runAtLoad !== false
  // The command line node receives: the JS entry, then `daemon run`, the
  // config, and the supervised marker. Quoted so a path with spaces survives
  // the argv split; the quotes are XML-escaped but Task Scheduler unescapes
  // before building the command line, so they reach node intact.
  const args = `"${jsEntry}" daemon run --config "${configPath}" --supervised`
  const restartBlock = restart
    ? [
      '    <RestartOnFailure>',
      `      <Interval>${interval}</Interval>`,
      '      <Count>999</Count>',
      '    </RestartOnFailure>',
    ]
    : []

  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlEscape(description)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${xmlEscape(sid)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(sid)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    `    <Enabled>${enabledAtLogon ? 'true' : 'false'}</Enabled>`,
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    ...restartBlock,
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(nodePath)}</Command>`,
    `      <Arguments>${xmlEscape(args)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n')
}

/**
 * Build the install plan without touching disk. Synchronous like the POSIX
 * planners; the SID is resolved synchronously (or injected via `options.sid`).
 *
 * @param {PlanTaskInstallOptions} options
 * @returns {TaskInstallPlan}
 * @ref LLP 0584#task [implements]: the task points node at the durable global JS entry, never an npx path
 */
export function planTaskInstall(options) {
  const sid = options.sid ?? resolveSidSync()
  const taskName = options.taskName ?? taskNameForSid(sid)
  const logDir = options.logDir ?? defaultLogDir(options.homeDir)
  const nodePath = options.nodePath ?? process.execPath
  const jsEntry = resolveTaskJsEntry(options.binPath)
  const content = buildTaskXml({
    nodePath,
    jsEntry,
    configPath: options.configPath,
    logDir,
    sid,
    description: options.description,
    env: options.env,
    restart: options.restart,
    runAtLoad: options.runAtLoad,
  })
  return {
    platform: 'win32',
    label: taskName,
    taskName,
    // The task lives in the Task Scheduler store, not on disk; the target is
    // its library path. The XML is written to a temp file only transiently.
    targetPath: taskName,
    content,
    binPath: jsEntry,
    configPath: options.configPath,
    logDir,
    nodePath,
    manageCommands: [
      ['schtasks', '/Create', '/TN', taskName, '/XML', '<task.xml>', '/F'],
      ['schtasks', '/Run', '/TN', taskName],
      ['schtasks', '/End', '/TN', taskName],
      ['schtasks', '/Query', '/TN', taskName],
      ['schtasks', '/Delete', '/TN', taskName, '/F'],
    ],
  }
}

const SPAWN_POLL_ATTEMPTS = 20 // ~2s ceiling at 100ms each
const SPAWN_POLL_INTERVAL_MS = 100

/**
 * Poll `schtasks /Query` until the task's running state is `running`, or the
 * bound elapses: install waits for up, restart for down. Best-effort: the
 * status string is localized, so a confirmed
 * "Running" means up, but an unconfirmed poll is not treated as a failed
 * install - `schtasks /Run` returning 0 means Task Scheduler started it, and
 * the daemon's own heartbeat (LLP 0348), read by `hyp daemon status`, is the
 * authoritative ongoing liveness. (This is the one place win32 is softer than
 * the POSIX installers, which read a real MainPID; Task Scheduler exposes no
 * child pid and a localized status cannot be the hard gate.)
 *
 * @param {SchtasksAdapter} schtasks
 * @param {string} taskName
 * @param {(ms: number) => Promise<void>} sleep
 * @param {boolean} running
 * @returns {Promise<boolean>} whether the wanted state was observed
 */
async function waitForTaskState(schtasks, taskName, sleep, running) {
  for (let i = 0; i < SPAWN_POLL_ATTEMPTS; i += 1) {
    const res = await schtasks.query(taskName)
    if (res.exitCode === 0 && /\bRunning\b/i.test(res.stdout) === running) return true
    await sleep(SPAWN_POLL_INTERVAL_MS)
  }
  return false
}

/**
 * Install or refresh the HypAware per-user Scheduled Task. Writes the task
 * XML to a temp file (UTF-16LE with a BOM, which `schtasks /XML` requires),
 * creates the task with `/F` so a reinstall replaces the prior one, then runs
 * it unless `runAtLoad` is false.
 *
 * @param {PlanTaskInstallOptions & { schtasks?: SchtasksAdapter, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<TaskInstallPlan>}
 * @ref LLP 0317#install-means-running [implements]: the task is run and confirmed before the install returns (best-effort on win32; see waitForTaskState)
 */
export async function installTask(options) {
  const plan = planTaskInstall(options)
  const schtasks = options.schtasks ?? realSchtasks
  const sleep = options.sleep ?? defaultSleep

  ensureFs(function() { fs.mkdirSync(plan.logDir, { recursive: true }) }, `create ${plan.logDir}`)

  // schtasks /XML reads UTF-16LE; a UTF-8 file is rejected as malformed. The
  // temp file is this process's own, removed once the task is created.
  const xmlPath = path.join(os.tmpdir(), `hypaware-task-${process.pid}-${plan.taskName.replace(/[^A-Za-z0-9]/g, '')}.xml`)
  ensureFs(
    function() { fs.writeFileSync(xmlPath, Buffer.from('﻿' + plan.content, 'utf16le'), { mode: 0o600 }) },
    `write ${xmlPath}`,
  )
  try {
    ensure(await schtasks.create(plan.taskName, xmlPath), `create scheduled task ${plan.taskName}`)
  } finally {
    try { fs.unlinkSync(xmlPath) } catch { /* best-effort cleanup of our own temp file */ }
  }

  if (options.runAtLoad !== false) {
    ensure(await schtasks.run(plan.taskName), `run scheduled task ${plan.taskName}`)
    await waitForTaskState(schtasks, plan.taskName, sleep, true)
  }

  return plan
}

/**
 * Delete the HypAware task, tolerating one already gone. Removes only the
 * task; config, recordings, and logs are untouched.
 *
 * @param {{ label?: string, sid?: string, taskName?: string, homeDir?: string, schtasks?: SchtasksAdapter }} options
 * @returns {Promise<void>}
 */
export async function uninstallTask(options) {
  const schtasks = options.schtasks ?? realSchtasks
  const taskName = resolveTaskName(options)
  const res = await schtasks.delete(taskName)
  // schtasks /Delete on a missing task exits nonzero with "cannot find"; that
  // is already-gone, not a failure, so uninstall stays idempotent.
  if (res.exitCode !== 0 && !/cannot find|does not exist|ERROR: The system cannot find/i.test(res.stderr + res.stdout)) {
    throw new ScheduledTaskError(`failed to delete scheduled task ${taskName}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      { exitCode: res.exitCode, stderr: res.stderr })
  }
}

/**
 * Run the installed task now (on-demand start).
 * @param {{ label?: string, sid?: string, taskName?: string, schtasks?: SchtasksAdapter }} options
 * @returns {Promise<void>}
 */
export async function startTask(options) {
  const schtasks = options.schtasks ?? realSchtasks
  const taskName = resolveTaskName(options)
  ensure(await schtasks.run(taskName), `run scheduled task ${taskName}`)
}

/**
 * End the running task. This is `TerminateProcess` on the daemon - the hard
 * stop a graceful `hyp daemon stop` escalates to only after its file-channel
 * request times out (LLP 0584 #stop), never the routine path.
 * @param {{ label?: string, sid?: string, taskName?: string, schtasks?: SchtasksAdapter }} options
 * @returns {Promise<void>}
 */
export async function stopTask(options) {
  const schtasks = options.schtasks ?? realSchtasks
  const taskName = resolveTaskName(options)
  ensure(await schtasks.end(taskName), `end scheduled task ${taskName}`)
}

/**
 * Restart the task: stop the daemon gracefully, then run the task again.
 *
 * The stop is the same file-channel request `hyp daemon stop` sends, so the
 * daemon flushes and exits 0 and the task, which relaunches only on a failure
 * exit, stays down until the `/Run` below. `schtasks /End` (a
 * `TerminateProcess`) is reached only when that request is not consumed in
 * time, or when no pid file names a live daemon: then there is nothing a
 * graceful request could reach, and the `/End` clears any task instance the
 * single-instance policy (`IgnoreNew`) would otherwise let swallow the
 * `/Run`.
 *
 * `requestStop` is a seam; the default resolves the state root the way
 * `hyp daemon stop` does (`HYP_HOME`, else `<home>/.hyp`) and loads the
 * runtime only on this path.
 *
 * @param {{ label?: string, sid?: string, taskName?: string, homeDir?: string, schtasks?: SchtasksAdapter, sleep?: (ms: number) => Promise<void>, requestStop?: () => Promise<'stopped'|'not_running'|'timed_out'> }} options
 * @returns {Promise<void>}
 * @ref LLP 0584#stop [implements]: restart is a graceful stop followed by /Run; /End only when the graceful request cannot land
 */
export async function restartTask(options) {
  const schtasks = options.schtasks ?? realSchtasks
  const sleep = options.sleep ?? defaultSleep
  const taskName = resolveTaskName(options)
  const requestStop = options.requestStop ?? await defaultRequestStop(options.homeDir)
  const outcome = await requestStop()
  if (outcome !== 'stopped') {
    await schtasks.end(taskName).catch(function() { /* best-effort; it may not be running */ })
  }
  // The daemon process is gone once the stop returns, but the task can read
  // Running for a moment longer, and `IgnoreNew` drops a `/Run` that lands
  // in that window. Bounded like the install poll.
  await waitForTaskState(schtasks, taskName, sleep, false)
  ensure(await schtasks.run(taskName), `run scheduled task ${taskName}`)
}

/**
 * @param {string | undefined} homeDir
 * @returns {Promise<() => Promise<'stopped'|'not_running'|'timed_out'>>}
 */
async function defaultRequestStop(homeDir) {
  const { requestDaemonStop } = await import('./runtime.js')
  const { stateRootFromEnv } = await import('../runtime/paths.js')
  const stateRoot = stateRootFromEnv(process.env, homeDir)
  return function() { return requestDaemonStop({ stateRoot, platform: 'win32' }) }
}

/**
 * Whether the task exists in the Task Scheduler library.
 * @param {{ label?: string, sid?: string, taskName?: string, schtasks?: SchtasksAdapter }} options
 * @returns {Promise<boolean>}
 */
export async function isTaskInstalled(options) {
  const schtasks = options.schtasks ?? realSchtasks
  try {
    const res = await schtasks.query(resolveTaskName(options))
    return res.exitCode === 0
  } catch {
    // Unlike the POSIX installed-check (a bare `fs.existsSync` on the unit /
    // plist), a scheduled task has no file to stat - existence is a schtasks
    // query, which can fail to spawn at all (no schtasks, or the test-runner
    // sandbox refusal). Treat that as not installed so `serviceDaemonStatus`
    // keeps its never-raises contract (LLP 0017 #status-queries-never-raise).
    return false
  }
}

/**
 * Query installed + running state of the task via `schtasks /Query`.
 *
 * A nonzero exit on a task that is not present is "not installed"; it never
 * raises (the installer-facing `serviceDaemonStatus` degrades it to
 * `unreachable`, LLP 0545). `active` reflects whether the task is currently
 * Running, the supervision signal `hyp daemon stop` reads.
 *
 * @param {{ label?: string, sid?: string, taskName?: string, schtasks?: SchtasksAdapter }} options
 * @returns {Promise<{ loaded: boolean, active?: boolean, unreachable?: boolean }>}
 */
export async function taskStatus(options) {
  const schtasks = options.schtasks ?? realSchtasks
  const res = await schtasks.query(resolveTaskName(options))
  if (res.exitCode !== 0) {
    // A missing task (`cannot find`) is simply not loaded; any other failure
    // is a Query that could not answer.
    if (/cannot find|does not exist|cannot find the (file|path)/i.test(res.stderr + res.stdout)) return { loaded: false }
    return { loaded: false, unreachable: true }
  }
  return { loaded: true, active: /\bRunning\b/i.test(res.stdout) }
}

/**
 * The task name for an operation: an explicit `taskName`, else one built from
 * an explicit `sid`, else from the SID resolved on this host.
 * @param {{ label?: string, sid?: string, taskName?: string }} options
 * @returns {string}
 */
function resolveTaskName(options) {
  if (options.taskName) return options.taskName
  if (options.label && options.label.startsWith('\\')) return options.label
  return taskNameForSid(options.sid ?? resolveSidSync())
}

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @import { SchtasksAdapter } from '../../src/core/daemon/types.js'
 * @import { TestContext } from 'node:test'
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

import {
  buildTaskXml,
  planTaskInstall,
  resolveTaskJsEntry,
  taskNameForSid,
  installTask,
  uninstallTask,
  startTask,
  stopTask,
  restartTask,
  isTaskInstalled,
  taskStatus,
} from '../../src/core/daemon/win32.js'
import { planDaemonInstall, renderDaemonInstall, serviceDaemonStatus } from '../../src/core/daemon/install.js'
import { platformIsSupported, setupPlatformIsSupported, daemonKindLabel } from '../../src/core/daemon/platform.js'
import { detectSupervisor } from '../../src/core/update/self_update.js'
import { runDaemonStop } from '../../src/core/commands/daemon.js'

const SID = 'S-1-5-21-1111-2222-3333-1001'
const BIN = 'C:\\Users\\kenny\\AppData\\Roaming\\npm\\hypaware.cmd'
const JS = 'C:\\Users\\kenny\\AppData\\Roaming\\npm\\node_modules\\hypaware\\bin\\hypaware.js'
const CONFIG = 'C:\\Users\\kenny\\.hyp\\hypaware-config.json'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'

/**
 * A recording fake Task Scheduler. `query` reports Running by default so the
 * install-means-running poll settles at once; override any verb per test.
 * @param {Partial<SchtasksAdapter>} [overrides]
 */
function fakeSchtasks(overrides = {}) {
  /** @type {Array<{ verb: string, taskName: string, xmlPath?: string, xmlBytes?: Buffer }>} */
  const calls = []
  const ok = { exitCode: 0, stdout: '', stderr: '' }
  /** @type {SchtasksAdapter} */
  const adapter = {
    async create(taskName, xmlPath) { calls.push({ verb: 'create', taskName, xmlPath, xmlBytes: fs.readFileSync(xmlPath) }); return ok },
    async delete(taskName) { calls.push({ verb: 'delete', taskName }); return ok },
    async run(taskName) { calls.push({ verb: 'run', taskName }); return ok },
    async end(taskName) { calls.push({ verb: 'end', taskName }); return ok },
    async query(taskName) { calls.push({ verb: 'query', taskName }); return { exitCode: 0, stdout: '"HOST","\\hypaware\\sid","N/A","Running",...', stderr: '' } },
    ...overrides,
  }
  return { calls, adapter }
}

const BASE = { binPath: BIN, configPath: CONFIG, nodePath: NODE, sid: SID, logDir: 'C:\\Users\\kenny\\.hyp\\hypaware\\logs' }

test('resolveTaskJsEntry points at the JS behind the .cmd shim, and leaves a .js as-is', () => {
  assert.equal(resolveTaskJsEntry(BIN), JS)
  assert.equal(resolveTaskJsEntry('C:\\apps\\hypaware.CMD'), 'C:\\apps\\node_modules\\hypaware\\bin\\hypaware.js')
  assert.equal(resolveTaskJsEntry(JS), JS)
  assert.equal(resolveTaskJsEntry('C:\\custom\\entry.mjs'), 'C:\\custom\\entry.mjs')
})

test('taskNameForSid keys the task per-user by SID under the hypaware folder', () => {
  assert.equal(taskNameForSid(SID), `\\hypaware\\${SID}`)
})

// @ref LLP 0584#task [tests]: logon trigger, least-privilege principal, single instance, no time limit, restart-on-failure
// @ref LLP 0584#exec [tests]: node runs the JS entry directly with --supervised
test('buildTaskXml encodes the decisions: logon/SID, least-privilege, restart-on-failure, node->JS --supervised', () => {
  const xml = buildTaskXml({ nodePath: NODE, jsEntry: JS, configPath: CONFIG, logDir: BASE.logDir, sid: SID })
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/)
  assert.match(xml, /<LogonTrigger>[\s\S]*<UserId>S-1-5-21-1111-2222-3333-1001<\/UserId>[\s\S]*<\/LogonTrigger>/)
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/)
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/)
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/)
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/)
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>/)
  // node runs the JS entry directly (not the .cmd), with the supervised marker.
  assert.match(xml, new RegExp(`<Command>${NODE.replace(/\\/g, '\\\\')}</Command>`))
  assert.match(xml, /<Arguments>&quot;.*hypaware\.js&quot; daemon run --config &quot;.*hypaware-config\.json&quot; --supervised<\/Arguments>/)
  assert.doesNotMatch(xml, /\.cmd/)
  // restart:false drops the block entirely.
  assert.doesNotMatch(buildTaskXml({ nodePath: NODE, jsEntry: JS, configPath: CONFIG, logDir: BASE.logDir, sid: SID, restart: false }), /RestartOnFailure/)
})

test('planTaskInstall resolves the JS entry as binPath and names the task from the SID', () => {
  const plan = planTaskInstall(BASE)
  assert.equal(plan.platform, 'win32')
  assert.equal(plan.taskName, `\\hypaware\\${SID}`)
  assert.equal(plan.binPath, JS, 'the plan reports the JS entry node actually runs')
  assert.equal(plan.configPath, CONFIG)
  assert.match(plan.content, /--supervised/)
  assert.ok(plan.manageCommands.some(c => c[0] === 'schtasks' && c.includes('/Create')))
})

test('installTask writes UTF-16LE XML, creates the task with /F, runs it, and polls for running', async () => {
  const { calls, adapter } = fakeSchtasks()
  const plan = await installTask({ ...BASE, schtasks: adapter, sleep: async () => {} })
  assert.equal(plan.taskName, `\\hypaware\\${SID}`)
  const create = calls.find(c => c.verb === 'create')
  assert.ok(create, 'create was called')
  assert.equal(create.taskName, `\\hypaware\\${SID}`)
  // schtasks /XML requires UTF-16LE; assert the BOM and that it decodes to the XML.
  const bytes = /** @type {Buffer} */ (create.xmlBytes)
  assert.equal(bytes[0], 0xff, 'UTF-16LE BOM byte 0')
  assert.equal(bytes[1], 0xfe, 'UTF-16LE BOM byte 1')
  assert.match(bytes.toString('utf16le').replace(/^\ufeff/, ''), /<Task version="1\.2"/)
  assert.deepEqual(calls.map(c => c.verb), ['create', 'run', 'query'])
  // The temp XML is cleaned up.
  assert.equal(fs.existsSync(/** @type {string} */ (create.xmlPath)), false)
})

test('installTask with runAtLoad:false creates but does not run the task', async () => {
  const { calls, adapter } = fakeSchtasks()
  await installTask({ ...BASE, runAtLoad: false, schtasks: adapter, sleep: async () => {} })
  assert.deepEqual(calls.map(c => c.verb), ['create'])
})

test('a failed create surfaces as a ScheduledTaskError and never runs the task', async () => {
  const { calls, adapter } = fakeSchtasks({
    async create(taskName) { calls.push({ verb: 'create', taskName }); return { exitCode: 1, stdout: '', stderr: 'ERROR: Access is denied.' } },
  })
  await assert.rejects(installTask({ ...BASE, schtasks: adapter, sleep: async () => {} }), /Access is denied/)
  assert.deepEqual(calls.map(c => c.verb), ['create'], 'create was attempted but run was never reached')
})

test('uninstallTask deletes the task and tolerates one already gone', async () => {
  const present = fakeSchtasks()
  await uninstallTask({ sid: SID, schtasks: present.adapter })
  assert.deepEqual(present.calls.map(c => c.verb), ['delete'])

  const missing = fakeSchtasks({ async delete() { return { exitCode: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' } } })
  await uninstallTask({ sid: SID, schtasks: missing.adapter }) // does not throw
})

test('start/stop map to run and end', async () => {
  const s = fakeSchtasks(); await startTask({ sid: SID, schtasks: s.adapter })
  assert.deepEqual(s.calls.map(c => c.verb), ['run'])
  const e = fakeSchtasks(); await stopTask({ sid: SID, schtasks: e.adapter })
  assert.deepEqual(e.calls.map(c => c.verb), ['end'])
})

const RUNNING = { exitCode: 0, stdout: '"HOST","\\hypaware\\sid","N/A","Running",...', stderr: '' }
const READY = { exitCode: 0, stdout: '"HOST","\\hypaware\\sid","N/A","Ready",...', stderr: '' }
const noSleep = async () => {}

/**
 * A fake Task Scheduler whose recorded `query` answers from `answer(n)`, n
 * counting from 1.
 * @param {(n: number) => { exitCode: number, stdout: string, stderr: string }} answer
 */
function fakeQuerying(answer) {
  const fake = fakeSchtasks()
  let n = 0
  fake.adapter.query = async function(taskName) { n += 1; fake.calls.push({ verb: 'query', taskName }); return answer(n) }
  return fake
}

// @ref LLP 0584#stop [tests]: restart stops through the file channel and never Ends a daemon that stopped gracefully
test('restartTask: a graceful stop is followed by Run, with no End', async () => {
  const r = fakeQuerying(() => READY)
  /** @type {string[]} */
  const order = []
  await restartTask({ sid: SID, schtasks: r.adapter, sleep: noSleep, requestStop: async () => { order.push('requestStop'); return 'stopped' } })
  assert.deepEqual(order, ['requestStop'])
  assert.deepEqual(r.calls.map(c => c.verb), ['query', 'run'])
})

// @ref LLP 0584#stop [tests]: /End is the escalation when the graceful request goes unconsumed
test('restartTask: a timed-out stop escalates to End, then Run', async () => {
  const r = fakeQuerying(() => READY)
  await restartTask({ sid: SID, schtasks: r.adapter, sleep: noSleep, requestStop: async () => 'timed_out' })
  assert.deepEqual(r.calls.map(c => c.verb), ['end', 'query', 'run'])
})

test('restartTask: with no live daemon to ask, End clears the task instance before Run', async () => {
  const r = fakeQuerying(() => READY)
  await restartTask({ sid: SID, schtasks: r.adapter, sleep: noSleep, requestStop: async () => 'not_running' })
  assert.deepEqual(r.calls.map(c => c.verb), ['end', 'query', 'run'])
})

test('restartTask: Run waits (bounded) for the task to leave Running, so IgnoreNew cannot drop it', async () => {
  const r = fakeQuerying(n => n < 3 ? RUNNING : READY)
  await restartTask({ sid: SID, schtasks: r.adapter, sleep: noSleep, requestStop: async () => 'stopped' })
  assert.deepEqual(r.calls.map(c => c.verb), ['query', 'query', 'query', 'run'])

  // A task stuck reading Running still gets its Run after the bound.
  const stuck = fakeSchtasks()
  await restartTask({ sid: SID, schtasks: stuck.adapter, sleep: noSleep, requestStop: async () => 'stopped' })
  assert.equal(stuck.calls.filter(c => c.verb === 'query').length, 20)
  assert.equal(stuck.calls.at(-1)?.verb, 'run')
})

/**
 * A staged HOME and the context `hyp daemon stop` runs against it with.
 * @param {TestContext} t
 */
function stageStopCtx(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-win32-stop-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  let out = ''
  let err = ''
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout: { write(/** @type {unknown} */ chunk) { out += String(chunk); return true } },
    stderr: { write(/** @type {unknown} */ chunk) { err += String(chunk); return true } },
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
  }))
  return { ctx, out: () => out, err: () => err }
}

// @ref LLP 0584#stop [tests]: an unconsumed stop request force-stops an installed task and says so
test('hyp daemon stop on win32: a timed-out stop of an installed task Ends it and prints the forced-stop line', async (t) => {
  const staged = stageStopCtx(t)
  const s = fakeSchtasks()
  const code = await runDaemonStop([], staged.ctx, { service: { platform: 'win32', sid: SID, schtasks: s.adapter }, requestStop: async () => 'timed_out' })
  assert.equal(code, 0)
  assert.deepEqual(s.calls.filter(c => c.verb !== 'query').map(c => c.verb), ['end'])
  assert.match(staged.err(), /^hyp daemon stop: the daemon did not stop within 10s, so it was force-stopped; anything it had not saved yet may be lost\n$/)
})

test('hyp daemon stop on win32: with no task installed a timeout is reported and nothing is Ended', async (t) => {
  const staged = stageStopCtx(t)
  const s = fakeSchtasks({ async query() { return { exitCode: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' } } })
  const code = await runDaemonStop([], staged.ctx, { service: { platform: 'win32', sid: SID, schtasks: s.adapter }, requestStop: async () => 'timed_out' })
  assert.equal(code, 1)
  assert.equal(s.calls.filter(c => c.verb === 'end').length, 0)
  assert.match(staged.err(), /stop signal sent but the daemon did not exit within 10s/)
})

test('hyp daemon stop on win32: a graceful stop never touches the task', async (t) => {
  const staged = stageStopCtx(t)
  const s = fakeSchtasks()
  const code = await runDaemonStop([], staged.ctx, { service: { platform: 'win32', sid: SID, schtasks: s.adapter }, requestStop: async () => 'stopped' })
  assert.equal(code, 0)
  assert.equal(s.calls.filter(c => c.verb !== 'query').length, 0)
  assert.equal(staged.out(), 'daemon: stopped\n')
})

test('taskStatus reads Running as active, Ready as loaded-not-active, and a missing task as not loaded', async () => {
  const running = fakeSchtasks()
  assert.deepEqual(await taskStatus({ sid: SID, schtasks: running.adapter }), { loaded: true, active: true })

  const ready = fakeSchtasks({ async query() { return { exitCode: 0, stdout: '"HOST","\\hypaware\\sid","N/A","Ready",...', stderr: '' } } })
  assert.deepEqual(await taskStatus({ sid: SID, schtasks: ready.adapter }), { loaded: true, active: false })

  const gone = fakeSchtasks({ async query() { return { exitCode: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' } } })
  assert.deepEqual(await taskStatus({ sid: SID, schtasks: gone.adapter }), { loaded: false })

  const broken = fakeSchtasks({ async query() { return { exitCode: 1, stdout: '', stderr: 'ERROR: Access is denied.' } } })
  assert.deepEqual(await taskStatus({ sid: SID, schtasks: broken.adapter }), { loaded: false, unreachable: true })

  assert.equal(await isTaskInstalled({ sid: SID, schtasks: running.adapter }), true)
  assert.equal(await isTaskInstalled({ sid: SID, schtasks: gone.adapter }), false)
})

// @ref LLP 0584#task [tests]: the generic dispatcher reaches the win32 backend
test('install.js dispatches win32 through the task backend', () => {
  const plan = planDaemonInstall({ platform: 'win32', binPath: BIN, configPath: CONFIG, sid: SID, nodePath: NODE, logDir: BASE.logDir })
  assert.equal(plan.platform, 'win32')
  const rendered = renderDaemonInstall({ platform: 'win32', binPath: BIN, configPath: CONFIG, sid: SID, nodePath: NODE, logDir: BASE.logDir })
  assert.equal(rendered.platform, 'win32')
  assert.equal(rendered.taskName, `\\hypaware\\${SID}`)
  assert.equal(rendered.serviceKind, 'Scheduled Task: \\hypaware')
})

test('serviceDaemonStatus reports the win32 task state through the adapter', async () => {
  const { adapter } = fakeSchtasks()
  const status = await serviceDaemonStatus({ platform: 'win32', sid: SID, schtasks: adapter })
  assert.equal(status.platform, 'win32')
  assert.equal(status.installed, true)
  assert.equal(status.loaded, true)
  assert.equal(status.active, true)
})

// @ref LLP 0584#gate [tests]: the daemon service family opens on win32; the setup wizard does not
test('the platform gate splits: service family includes win32, setup wizard does not', () => {
  assert.equal(platformIsSupported('win32'), true)
  assert.equal(platformIsSupported('darwin'), true)
  assert.equal(platformIsSupported('linux'), true)
  assert.equal(setupPlatformIsSupported('win32'), false)
  assert.equal(setupPlatformIsSupported('darwin'), true)
  assert.equal(daemonKindLabel('win32'), 'Scheduled Task: \\hypaware')
})

// @ref LLP 0584#supervision [tests]: the task's --supervised marker makes detectSupervisor true on win32
test('detectSupervisor honors the HYP_SUPERVISED marker the win32 task sets', () => {
  assert.equal(detectSupervisor({ HYP_SUPERVISED: '1' }), true)
  assert.equal(detectSupervisor({}), false)
  assert.equal(detectSupervisor({ HYP_SUPERVISED: '0' }), false)
})

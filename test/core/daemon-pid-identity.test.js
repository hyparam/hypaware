// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { claimDaemonStart } from '../../src/core/daemon/gateway.js'
import {
  clearStalePidFile,
  isDaemonProcess,
  processIsAlive,
  readPidFile,
  readProcessCmdline,
  writePidFile,
} from '../../src/core/daemon/pid.js'
import { pidFilePath } from '../../src/core/runtime/paths.js'

const GATEWAY_URL = pathToFileURL(path.resolve('src/core/daemon/gateway.js')).href

/** @param {import('node:test').TestContext} t */
function makeStateRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-pid-identity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A running child that has already exec'd. Right after spawn returns, the
 * child can still be between fork and exec, when its command line reads as
 * the parent's or as empty, so wait for it to say it is running (#2922).
 *
 * @param {import('node:test').TestContext} t
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function liveChild(t, args) {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("r"); setInterval(() => {}, 1000)', ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
  if (!child.pid) throw new Error('child did not start')
  t.after(() => child.kill('SIGKILL'))
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
  })
  return /** @type {number} */ (child.pid)
}

/**
 * isDaemonProcess, read again while it answers null. Null is the fail-closed
 * answer for a command line that could not be read, and on Windows the first
 * read can overrun its timeout while a cold PowerShell starts (#2922).
 *
 * @param {number} pid
 */
function identify(pid) {
  let answer = isDaemonProcess(pid)
  for (let i = 0; answer === null && i < 2; i++) answer = isDaemonProcess(pid)
  return answer
}

function spawnSyncPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(child.stdout)
}

/** @param {number} pid */
function entry(pid) {
  return { pid, startedAt: new Date().toISOString(), runId: `test-${pid}`, mode: /** @type {const} */ ('foreground') }
}

test('a live process without `daemon run` arguments is not the daemon (#2583)', async (t) => {
  const pid = await liveChild(t, [])
  assert.equal(processIsAlive(pid), true)
  assert.equal(identify(pid), false)
})

test('a `daemon run` command line is the daemon, whatever the program is called', async (t) => {
  const pid = await liveChild(t, ['daemon', 'run'])
  assert.equal(identify(pid), true)
})

test('an unreadable command line stays fail-closed', () => {
  assert.equal(readProcessCmdline(4194304), null)
  assert.equal(isDaemonProcess(4194304), null)
})

test('a pid file naming a reused pid does not block the start, and the holder is left running', async (t) => {
  const stateRoot = makeStateRoot(t)
  const foreign = await liveChild(t, [])
  writePidFile(stateRoot, entry(foreign))
  claimDaemonStart(stateRoot, path.join(stateRoot, 'processing'), entry(process.pid))
  assert.equal(readPidFile(stateRoot)?.pid, process.pid)
  assert.equal(processIsAlive(foreign), true)
})

test('a pid file naming this process is a previous incarnation\'s', (t) => {
  const stateRoot = makeStateRoot(t)
  writePidFile(stateRoot, { ...entry(process.pid), runId: 'previous' })
  claimDaemonStart(stateRoot, path.join(stateRoot, 'processing'), entry(process.pid))
  assert.equal(readPidFile(stateRoot)?.runId, `test-${process.pid}`)
})

test('a live daemon still refuses the start', async (t) => {
  const stateRoot = makeStateRoot(t)
  const daemon = await liveChild(t, ['daemon', 'run'])
  writePidFile(stateRoot, entry(daemon))
  assert.throws(
    () => claimDaemonStart(stateRoot, path.join(stateRoot, 'processing'), entry(process.pid)),
    /daemon already running/
  )
  assert.equal(readPidFile(stateRoot)?.pid, daemon)
})

test('a start in progress elsewhere refuses rather than racing it', async (t) => {
  const stateRoot = makeStateRoot(t)
  const holder = await liveChild(t, [])
  const pidFile = pidFilePath(stateRoot)
  const lock = path.join(path.dirname(pidFile), `.${path.basename(pidFile)}.mutation-lock`)
  fs.mkdirSync(lock, { recursive: true })
  fs.writeFileSync(path.join(lock, `${holder}-00000000-0000-4000-8000-000000000000`), '')
  assert.throws(
    () => claimDaemonStart(stateRoot, path.join(stateRoot, 'processing'), entry(process.pid)),
    /daemon start already in progress/
  )
  assert.equal(readPidFile(stateRoot), null)
})

test('a stale clear leaves the pid file to a start that holds the guard', async (t) => {
  const stateRoot = makeStateRoot(t)
  const dead = spawnSyncPid()
  writePidFile(stateRoot, entry(dead))
  const holder = await liveChild(t, [])
  const pidFile = pidFilePath(stateRoot)
  const lock = path.join(path.dirname(pidFile), `.${path.basename(pidFile)}.mutation-lock`)
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, `${holder}-00000000-0000-4000-8000-000000000000`), '')
  clearStalePidFile(stateRoot)
  assert.equal(readPidFile(stateRoot)?.pid, dead)
  fs.rmSync(lock, { recursive: true })
  clearStalePidFile(stateRoot)
  assert.equal(readPidFile(stateRoot), null)
})

test('concurrent starts over a stale pid file produce exactly one winner', async (t) => {
  const stateRoot = makeStateRoot(t)
  writePidFile(stateRoot, entry(await liveChild(t, [])))
  const go = path.join(stateRoot, 'go')
  // Each starter looks like a daemon to the others and outlives every claim.
  const script = `
    import fs from 'node:fs'
    import path from 'node:path'
    import { claimDaemonStart } from ${JSON.stringify(GATEWAY_URL)}
    const [stateRoot, go] = process.argv.slice(1, 3)
    while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 2))
    let out
    try {
      claimDaemonStart(stateRoot, path.join(stateRoot, 'processing'), { pid: process.pid, startedAt: new Date().toISOString(), runId: 'race-' + process.pid, mode: 'foreground' })
      out = 'won'
    } catch (err) {
      out = err.message
    }
    process.stdout.write(out + '\\n')
    setTimeout(() => {}, 1500)
  `
  const starters = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, stateRoot, go, 'daemon', 'run'], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', reject)
    child.on('exit', () => resolve({ pid: child.pid, out: out.trim() }))
  }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  fs.writeFileSync(go, '')
  const results = /** @type {Array<{ pid: number, out: string }>} */ (await Promise.all(starters))
  const winners = results.filter((r) => r.out === 'won')
  assert.equal(winners.length, 1, JSON.stringify(results))
  for (const r of results) {
    if (r.out !== 'won') assert.match(r.out, /daemon already running|daemon start already in progress/)
  }
  assert.equal(readPidFile(stateRoot)?.pid, winners[0].pid)
})

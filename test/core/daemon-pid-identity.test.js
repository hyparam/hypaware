// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  clearPidFile,
  isDaemonProcess,
  processIsAlive,
  readPidFile,
  readProcessCmdline,
  writePidFile,
} from '../../src/core/daemon/pid.js'

function makeStateRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-pid-identity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function sleepChild() {
  const child = spawn('sleep', ['600'], { stdio: 'ignore' })
  if (!child.pid) throw new Error('sleep did not start')
  return { child, pid: child.pid }
}

test('reused pid held by an unrelated process is not our daemon (#2583)', (t) => {
  const { child, pid } = sleepChild()
  t.after(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  })
  assert.equal(processIsAlive(pid), true)
  assert.equal(isDaemonProcess(pid), false)
})

test('stale pid file pointing at a reused pid is cleared', (t) => {
  const stateRoot = makeStateRoot(t)
  const { child, pid } = sleepChild()
  t.after(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  })
  writePidFile(stateRoot, {
    pid,
    startedAt: new Date().toISOString(),
    runId: 'test-run',
    mode: 'foreground',
  })
  const previous = readPidFile(stateRoot)
  assert.ok(previous)
  // gateway decision: alive but not ours -> clear and start
  assert.equal(processIsAlive(previous.pid), true)
  assert.equal(isDaemonProcess(previous.pid), false)
  clearPidFile(stateRoot)
  assert.equal(readPidFile(stateRoot), null)
})

test('a hypaware daemon command line is recognized', (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    argv0: 'hypaware daemon probe',
    stdio: 'ignore',
  })
  if (!child.pid) throw new Error('probe did not start')
  t.after(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  })
  assert.equal(processIsAlive(child.pid), true)
  if (process.platform === 'linux') {
    assert.equal(isDaemonProcess(child.pid), true)
  } else {
    // No /proc: identity unreadable, stays fail-closed (null, never false).
    assert.equal(isDaemonProcess(child.pid), null)
  }
})

test('unknown identity stays fail-closed', () => {
  // No such process: cmdline unreadable -> null, never false.
  assert.equal(readProcessCmdline(4194304), null)
  assert.equal(isDaemonProcess(4194304), null)
  assert.equal(processIsAlive(4194304), false)
})

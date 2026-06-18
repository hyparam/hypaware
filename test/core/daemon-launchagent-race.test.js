// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installLaunchAgent } from '../../src/core/daemon/macos.js'

const EIO = { exitCode: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
const OK = { exitCode: 0, stdout: '', stderr: '' }

/**
 * Fake launchctl driven by per-method result queues (last entry repeats).
 * @param {{ print?: number[], bootstrap?: Array<{exitCode:number,stdout:string,stderr:string}> }} script
 */
function fakeLaunchctl(script) {
  const calls = []
  const printQ = script.print ?? [1]
  const bootQ = script.bootstrap ?? [OK]
  let pi = 0
  let bi = 0
  return {
    calls,
    print(args) { calls.push(['print', ...args]); const code = printQ[Math.min(pi++, printQ.length - 1)]; return Promise.resolve({ exitCode: code, stdout: '', stderr: '' }) },
    bootout(args) { calls.push(['bootout', ...args]); return Promise.resolve(OK) },
    bootstrap(args) { calls.push(['bootstrap', ...args]); return Promise.resolve(bootQ[Math.min(bi++, bootQ.length - 1)]) },
    kickstart(args) { calls.push(['kickstart', ...args]); return Promise.resolve(OK) },
  }
}

function opts(homeDir, launchctl) {
  return {
    homeDir,
    binPath: '/x/bin/hypaware.js',
    nodePath: '/x/node',
    configPath: path.join(homeDir, 'hypaware-config.json'),
    launchctl,
    userDomain: 'gui/501',
    sleep: async () => {}, // no real waiting in tests
  }
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-la-race-'))
const count = (calls, verb) => calls.filter((c) => c[0] === verb).length

test('reinstall over a loaded agent boots out, waits for unload, then bootstraps cleanly', async () => {
  const home = tmpHome()
  // pre-check: loaded (0); after bootout the wait-loop sees it gone (1)
  const lc = fakeLaunchctl({ print: [0, 1], bootstrap: [OK] })
  const plan = await installLaunchAgent(opts(home, lc))

  assert.equal(count(lc.calls, 'bootout'), 1, 'booted out the live agent')
  assert.equal(count(lc.calls, 'bootstrap'), 1, 'bootstrapped once after it unloaded')
  assert.ok(fs.existsSync(plan.targetPath), 'plist written')
})

test('transient EIO (error 5) on bootstrap is retried until it succeeds', async () => {
  const home = tmpHome()
  // not loaded (skip bootout); bootstrap fails with EIO once, then succeeds
  const lc = fakeLaunchctl({ print: [1], bootstrap: [EIO, OK] })
  await installLaunchAgent(opts(home, lc))

  assert.equal(count(lc.calls, 'bootout'), 0, 'nothing to boot out')
  assert.equal(count(lc.calls, 'bootstrap'), 2, 'retried the transient EIO')
})

test('a persistent bootstrap failure still throws (no infinite retry)', async () => {
  const home = tmpHome()
  const lc = fakeLaunchctl({ print: [1], bootstrap: [EIO] }) // always EIO
  await assert.rejects(
    () => installLaunchAgent(opts(home, lc)),
    (err) => err instanceof Error && /failed to bootstrap/.test(err.message)
  )
  // 1 initial + 3 bounded retries
  assert.equal(count(lc.calls, 'bootstrap'), 4, 'bounded retry, then gives up')
})

test('a non-transient bootstrap failure is not retried', async () => {
  const home = tmpHome()
  const hardFail = { exitCode: 78, stdout: '', stderr: 'Load failed: 78: Function not implemented' }
  const lc = fakeLaunchctl({ print: [1], bootstrap: [hardFail] })
  await assert.rejects(() => installLaunchAgent(opts(home, lc)), /failed to bootstrap/)
  assert.equal(count(lc.calls, 'bootstrap'), 1, 'a genuine error fails fast, no retry')
})

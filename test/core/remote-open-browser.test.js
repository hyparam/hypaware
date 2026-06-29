// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { openBrowser } from '../../src/core/remote/open_browser.js'

/**
 * A spawn stub that records the command and returns a child resembling a real
 * ChildProcess (an EventEmitter with `unref`).
 */
function stubSpawn() {
  /** @type {{ command: string, args: string[] }[]} */
  const calls = []
  /** @type {any[]} */
  const children = []
  const spawnImpl = /** @type {any} */ ((/** @type {string} */ command, /** @type {string[]} */ args) => {
    calls.push({ command, args })
    const child = Object.assign(new EventEmitter(), { unref() {} })
    children.push(child)
    return child
  })
  return { spawnImpl, calls, children }
}

test('darwin uses `open`', () => {
  const { spawnImpl, calls } = stubSpawn()
  const ok = openBrowser('https://x/auth', { platform: 'darwin', spawnImpl })
  assert.equal(ok, true)
  assert.equal(calls[0].command, 'open')
  assert.deepEqual(calls[0].args, ['https://x/auth'])
})

test('linux uses `xdg-open`', () => {
  const { spawnImpl, calls } = stubSpawn()
  openBrowser('https://x/auth', { platform: 'linux', spawnImpl })
  assert.equal(calls[0].command, 'xdg-open')
})

test('win32 uses `cmd /c start`', () => {
  const { spawnImpl, calls } = stubSpawn()
  openBrowser('https://x/auth', { platform: 'win32', spawnImpl })
  assert.equal(calls[0].command, 'cmd')
  assert.deepEqual(calls[0].args, ['/c', 'start', '', 'https://x/auth'])
})

test('a synchronous spawn throw returns false (caller prints the URL)', () => {
  const spawnImpl = /** @type {any} */ (() => { throw new Error('EACCES') })
  const ok = openBrowser('https://x/auth', { platform: 'linux', spawnImpl })
  assert.equal(ok, false)
})

test('an async spawn ENOENT (missing opener) does not crash the process', async () => {
  // Real spawn delivers a missing-binary failure as an async "error" event,
  // not a synchronous throw. openBrowser must attach a listener so that event
  // cannot become an uncaught exception.
  const { spawnImpl, children } = stubSpawn()
  const ok = openBrowser('https://x/auth', { platform: 'linux', spawnImpl })
  assert.equal(ok, true) // best-effort: it spawned without throwing
  let crashed = false
  const onUnhandled = () => { crashed = true }
  process.once('uncaughtException', onUnhandled)
  // Emit the async failure the way a missing xdg-open would.
  children[0].emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }))
  await new Promise((r) => setTimeout(r, 10))
  process.removeListener('uncaughtException', onUnhandled)
  assert.equal(crashed, false)
})

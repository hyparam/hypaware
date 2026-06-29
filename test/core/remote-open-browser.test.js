// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { openBrowser } from '../../src/core/remote/open_browser.js'

/** A spawn stub that records the command and returns a fake unref-able child. */
function stubSpawn() {
  /** @type {{ command: string, args: string[] }[]} */
  const calls = []
  const spawnImpl = /** @type {any} */ ((/** @type {string} */ command, /** @type {string[]} */ args) => {
    calls.push({ command, args })
    return { unref() {} }
  })
  return { spawnImpl, calls }
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

test('a spawn failure returns false (caller prints the URL)', () => {
  const spawnImpl = /** @type {any} */ (() => { throw new Error('ENOENT') })
  const ok = openBrowser('https://x/auth', { platform: 'linux', spawnImpl })
  assert.equal(ok, false)
})

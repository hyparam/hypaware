// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'
import { daemonIncompleteNote } from '../../src/core/daemon/platform.js'

/**
 * The local pathway's daemon-install failure (#1383). `installDaemon` throws
 * `DaemonInstallError` on a platform with no service manager and the finale
 * let it out, so a local-only `hyp setup` on win32 exited 1 with the config
 * already committed and attach, client assets and backfill never run. The
 * team pathway's `skipDaemonInstall` does not cover it: only a join sets it.
 *
 * Driven through `runPickerWalkthrough` with `process.platform` stubbed, so
 * the real `installDaemon` rather than the injectable seam is what throws.
 */

/** @returns {{ write(chunk: string): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * Run `fn` with `process.platform` reporting `platform`.
 *
 * @template T
 * @param {NodeJS.Platform} platform
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await fn()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

test('a local-pathway setup on a platform with no service manager finishes attach and backfill', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-finale-win32-'))
  const env = { HOME: home, HYP_HOME: path.join(home, '.hyp') }
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {string[]} */
  const attached = []
  /** @type {string[]} */
  const backfilled = []

  const result = await withPlatform('win32', () => runPickerWalkthrough({
    capabilities: /** @type {any} */ ({
      has: (/** @type {string} */ id) => id === 'hypaware.ai-gateway',
      require: () => ({
        getClient: (/** @type {string} */ name) =>
          name === 'claude'
            ? { attach: async () => { attached.push(name) } }
            : undefined,
        localEndpoint: () => 'http://127.0.0.1:4317',
      }),
    }),
    stdout,
    stderr,
    env,
    picks: { sources: ['claude'], exportChoice: 'keep-local', retentionDays: 14 },
    backfill: {
      available: ['claude'],
      /** @param {{ provider: string, dryRun: boolean, retentionDays: number, until: string }} args */
      async run(args) {
        backfilled.push(args.provider)
        return { provider: args.provider, dryRun: args.dryRun, ok: true, scanned: 1, rowsWritten: 1, skipped: 0 }
      },
    },
    // The local pathway: no join, so nothing sets `skipDaemonInstall` and the
    // finale reaches the real installer.
    finale: {},
  }))

  assert.equal(result.exitCode, 0, 'the run finishes rather than throwing out to the CLI')
  assert.equal(result.finale?.daemonInstall.failed, true, 'the install step is recorded as failed, not as a clean skip')
  assert.match(stderr.text(), /win32 has no background service to install/)
  assert.doesNotMatch(stderr.text(), /hyp daemon install/, 'a platform with no service manager is not told to run the installer')
  assert.deepEqual(attached, ['claude'], 'client attach still runs; it needs no service manager')
  assert.deepEqual(backfilled, ['claude'], 'backfill still runs; it is a local file import')
  assert.deepEqual(result.finale?.attach, [{ client: 'claude', dryRun: false, ok: true }])

  await fs.rm(home, { recursive: true, force: true })
})

test('daemonIncompleteNote without a context clause names the missing service and nothing else', () => {
  assert.equal(
    daemonIncompleteNote('win32'),
    'note: win32 has no background service to install - nothing is captured on this machine\n'
  )
  assert.equal(
    daemonIncompleteNote('darwin'),
    "note: the daemon install did not finish - run 'hyp daemon install'\n"
  )
})

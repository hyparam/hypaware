// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'

import { GlobalInstallError } from '../../src/core/cli/global_install.js'
import { runPickerFinale, runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'
import { SystemdUnitError } from '../../src/core/daemon/linux.js'
import { LaunchAgentError } from '../../src/core/daemon/macos.js'
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

// The other half of the same defect, and the one every real user is exposed
// to: `installDaemon` reaches darwin/linux and the service manager itself
// fails. LLP 0317 D1 makes the platform installers raise their `ServiceOpError`
// subclass when no pid appears, which is not a `DaemonInstallError`, so a catch
// on that class alone would leave the run dying after the config commit exactly
// as #1383 describes. The team pathway has never died here: `runDaemonInstall`
// turns every install failure into exit 1 and the login lane reads that as
// `daemon_incomplete` (#978).

/**
 * @param {string} home
 * @param {string[]} events
 * @param {{ write(chunk: string): boolean, text(): string }} stderr
 */
function finaleArgs(home, events, stderr) {
  return {
    finale: { dryRun: false, skipDaemonRestart: true },
    retentionDays: 30,
    interactive: false,
    clientsPicked: ['claude'],
    capabilities: /** @type {any} */ ({
      has: (/** @type {string} */ id) => id === 'hypaware.ai-gateway',
      require: () => ({
        getClient: (/** @type {string} */ name) =>
          name === 'claude' ? { attach: async () => { events.push('attach') } } : undefined,
        localEndpoint: () => 'http://127.0.0.1:4317',
      }),
    }),
    config: /** @type {any} */ ({
      version: 2,
      plugins: [{ name: '@hypaware/ai-gateway', config: { upstreams: [], proxy_mode: true } }],
    }),
    configPath: path.join(home, '.hyp', 'hypaware-config.json'),
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    stdout: makeBuf(),
    stderr,
    waitForCaFn: async () => {
      events.push('ca-wait')
      return { ready: true }
    },
  }
}

test('a launchd/systemd install failure on a supported platform finishes the finale too', async () => {
  for (const Err of [LaunchAgentError, SystemdUnitError]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-finale-svcop-'))
    /** @type {string[]} */
    const events = []
    const stderr = makeBuf()
    const summary = await runPickerFinale(/** @type {any} */ ({
      ...finaleArgs(home, events, stderr),
      installDaemonFn: async () => { throw new Err('launchctl bootstrap exited 5') },
    }))
    assert.equal(summary.daemonInstall.failed, true, `${Err.name} is recorded as a failed install`)
    assert.match(stderr.text(), /^daemon install failed: launchctl bootstrap exited 5\n/, 'the service manager\'s own diagnosis reaches the user, not just the span')
    assert.match(stderr.text(), /the daemon install did not finish - run 'hyp daemon install'/)
    assert.deepEqual(events, ['attach'], 'no CA can appear without a daemon, so the wait is skipped and attach still runs')
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('an error that is not an install failure still escapes the finale', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-finale-bug-'))
  /** @type {string[]} */
  const events = []
  const stderr = makeBuf()
  await assert.rejects(
    () => runPickerFinale(/** @type {any} */ ({
      ...finaleArgs(home, events, stderr),
      installDaemonFn: async () => { throw new TypeError('a bug in this lane') },
    })),
    /a bug in this lane/,
    'the catch is install failures only; anything else is a bug and propagates'
  )
  assert.deepEqual(events, [], 'nothing after the install step ran')
  await fs.rm(home, { recursive: true, force: true })
})

// The last two ways `installDaemon` could still kill the finale after the
// config commit (#1386). Neither is a service-manager failure, so neither is a
// `ServiceOpError`, and both are ordinary environment failures rather than
// bugs: `npx hypaware setup` cannot reach the registry, or the plist/unit
// directory cannot be written.

test('a failed npx durable-bin upgrade finishes the finale too', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-finale-npx-'))
  /** @type {string[]} */
  const events = []
  const stderr = makeBuf()
  const summary = await runPickerFinale(/** @type {any} */ ({
    ...finaleArgs(home, events, stderr),
    installDaemonFn: async () => {
      throw new GlobalInstallError(
        "npx detected, but npm install -g hypaware@1.0.0 failed: EACCES. Run 'npm install -g hypaware@1.0.0' manually"
      )
    },
  }))
  assert.equal(summary.daemonInstall.failed, true, 'the global install failure is a failed daemon install')
  assert.match(
    stderr.text(),
    /^daemon install failed: npx detected, but npm install -g hypaware@1\.0\.0 failed: EACCES\./,
    'the npm diagnosis is actionable, so it reaches the user rather than only the span'
  )
  assert.match(stderr.text(), /the daemon install did not finish - run 'hyp daemon install'/)
  assert.deepEqual(events, ['attach'], 'attach still runs; it needs no daemon')
  await fs.rm(home, { recursive: true, force: true })
})

// Skipped as root, who is refused by no mode bits: the mkdir would succeed and
// the run would fail further along on something this test does not describe.
test('an unwritable unit directory finishes the finale too', { skip: process.getuid?.() === 0 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-finale-eacces-'))
  const systemdDir = path.join(home, '.config', 'systemd')
  await fs.mkdir(systemdDir, { recursive: true })
  // Only the unit directory's parent is sealed: the rest of the finale keeps
  // writing under HOME, and this failure must not stand in for those.
  await fs.chmod(systemdDir, 0o500)
  /** @type {string[]} */
  const events = []
  const stderr = makeBuf()
  try {
    // The real installer, not the seam: the throw has to come from the
    // filesystem write inside `installSystemdUnit` itself.
    const summary = await withPlatform('linux', () => runPickerFinale(/** @type {any} */ (
      finaleArgs(home, events, stderr)
    )))
    assert.equal(summary.daemonInstall.failed, true, 'an EACCES on the unit directory is a failed install')
    assert.match(stderr.text(), /^daemon install failed: failed to create .*systemd\/user: EACCES/, 'the system error names the path and the reason')
    assert.match(stderr.text(), /the daemon install did not finish - run 'hyp daemon install'/)
    assert.deepEqual(events, ['attach'], 'attach still runs; it needs no daemon')
  } finally {
    // Restored whatever happened: a failed assertion would otherwise leave a
    // 0500 directory that `fs.rm` cannot empty.
    await fs.chmod(systemdDir, 0o700)
    await fs.rm(home, { recursive: true, force: true })
  }
})

// @ts-check

import test from 'node:test'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installLaunchAgent } from '../../src/core/daemon/macos.js'
import { installSystemdUnit } from '../../src/core/daemon/linux.js'
import { startServiceDaemon, stopServiceDaemon, restartServiceDaemon, serviceDaemonStatus } from '../../src/core/daemon/install.js'
import { runDaemonStop, runDaemonUninstall } from '../../src/core/commands/daemon.js'
import { clearStalePidFile, pidFilePath, processIsAlive, processingStateRoot, writePidFile } from '../../src/core/daemon/pid.js'

/** @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js' */

// Regression for #1036: `hyp daemon install` over a running daemon booted the
// old instance out, bootstrapped the label back in, and then trusted
// `RunAtLoad` to spawn it. launchd can register the job and leave the initial
// spawn pended forever (`pended nondemand spawn = speculative`, `runs = 0`),
// so the installer printed success while the daemon was down and every
// proxy-attached client was left pointing at a dead 127.0.0.1 port.

const OK = { exitCode: 0, stdout: '', stderr: '' }
const RUNNING_PID = 4242

/**
 * A launchd that models the two states the installer has to tell apart:
 * *loaded* (bootstrapped, `print` succeeds) and *running* (has a pid).
 * `spawnOnBootstrap: false` is the pended-spawn state from #1036.
 *
 * `pidAtStart: 0` is the third state, and the only one that tells the two
 * apart: launchd holding the label with nothing running under it, which is
 * what a throttled respawn and a pended spawn both look like.
 *
 * @param {{ loadedAtStart?: boolean, pidAtStart?: number, spawnOnBootstrap?: boolean, spawnOnKickstart?: boolean, kickstartStderr?: string }} [opts]
 */
function fakeLaunchd(opts) {
  const { loadedAtStart = false, spawnOnBootstrap = false, spawnOnKickstart = true, kickstartStderr } = opts ?? {}
  /** @type {string[][]} */
  const calls = []
  let loaded = loadedAtStart
  let pid = opts?.pidAtStart ?? (loadedAtStart ? RUNNING_PID : 0)
  return {
    calls,
    /** @param {string[]} args */
    print(args) {
      calls.push(['print', ...args])
      if (!loaded) {
        return Promise.resolve({ exitCode: 113, stdout: '', stderr: 'Could not find service' })
      }
      const stdout = pid > 0
        ? `state = running\n\tpid = ${pid}\n`
        : 'state = not running\n\truns = 0\n\tpended nondemand spawn = speculative\n'
      return Promise.resolve({ exitCode: 0, stdout, stderr: '' })
    },
    /** @param {string[]} args */
    bootout(args) {
      calls.push(['bootout', ...args])
      loaded = false
      pid = 0
      return Promise.resolve(OK)
    },
    /** @param {string[]} args */
    bootstrap(args) {
      calls.push(['bootstrap', ...args])
      loaded = true
      if (spawnOnBootstrap) pid = RUNNING_PID
      return Promise.resolve(OK)
    },
    /** @param {string[]} args */
    kickstart(args) {
      calls.push(['kickstart', ...args])
      if (spawnOnKickstart) pid = RUNNING_PID
      if (kickstartStderr !== undefined) {
        return Promise.resolve({ exitCode: 3, stdout: '', stderr: kickstartStderr })
      }
      return Promise.resolve(OK)
    },
  }
}

/**
 * A systemd that accepts every job but only reports a MainPID once the unit
 * has actually been spawned. `spawnOnRestart: false` is the `Type=simple`
 * shape where `restart` exits 0 and no process ends up running.
 *
 * @param {{ spawnOnRestart?: boolean, spawnOnStart?: boolean, startStderr?: string }} [opts]
 */
function fakeSystemd(opts) {
  const { spawnOnRestart = true, spawnOnStart = true, startStderr } = opts ?? {}
  /** @type {string[][]} */
  const calls = []
  let pid = 0
  let stopped = false
  return {
    calls,
    daemonReload() { calls.push(['daemon-reload']); return Promise.resolve(OK) },
    /** @param {string} unit */
    enable(unit) { calls.push(['enable', unit]); return Promise.resolve(OK) },
    /** @param {string} unit */
    disable(unit) { calls.push(['disable', unit]); return Promise.resolve(OK) },
    /** @param {string} unit */
    start(unit) {
      calls.push(['start', unit])
      stopped = false
      if (spawnOnStart) pid = RUNNING_PID
      if (startStderr !== undefined) {
        return Promise.resolve({ exitCode: 5, stdout: '', stderr: startStderr })
      }
      return Promise.resolve(OK)
    },
    /** @param {string} unit */
    stop(unit) { calls.push(['stop', unit]); pid = 0; stopped = true; return Promise.resolve(OK) },
    /** @param {string} unit */
    restart(unit) {
      calls.push(['restart', unit])
      stopped = false
      if (spawnOnRestart) pid = RUNNING_PID
      return Promise.resolve(OK)
    },
    /** @param {string} unit */
    status(unit) { calls.push(['status', unit]); return Promise.resolve(OK) },
    /** @param {string} unit */
    show(unit) {
      calls.push(['show', unit])
      // A stopped unit stays `loaded` and goes `inactive`; a unit systemd is
      // still bringing up reports `activating` with no MainPID, which is the
      // `Restart=` gap a crash loop spends most of its time in.
      const state = stopped ? 'inactive' : pid > 0 ? 'active' : 'activating'
      return Promise.resolve({
        exitCode: 0,
        stdout: `LoadState=loaded\nActiveState=${state}\nMainPID=${pid}\n`,
        stderr: '',
      })
    },
  }
}

const tmpHome = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `hyp-${tag}-`))

for (const platform of ['darwin', 'linux']) {
  test(`${platform}: stop preserves the installation and start/restart brings it back`, async (t) => {
    const home = tmpHome('service-stop')
    t.after(() => fs.rmSync(home, { recursive: true, force: true }))
    const launchctl = fakeLaunchd()
    const systemctl = fakeSystemd()
    const adapter = platform === 'darwin' ? launchctl : systemctl
    const options = platform === 'darwin'
      ? { ...darwinOpts(home, launchctl), platform: /** @type {const} */ ('darwin') }
      : { ...linuxOpts(home, systemctl), platform: /** @type {const} */ ('linux') }
    const plan = platform === 'darwin'
      ? await installLaunchAgent(options)
      : await installSystemdUnit(options)
    const content = fs.readFileSync(plan.targetPath, 'utf8')
    for (const resume of [startServiceDaemon, restartServiceDaemon]) {
      adapter.calls.length = 0
      await stopServiceDaemon(options)
      await stopServiceDaemon(options)
      const stopped = await serviceDaemonStatus(options)
      assert.equal(stopped.installed, true)
      assert.equal(stopped.pid, undefined)
      assert.equal(fs.readFileSync(plan.targetPath, 'utf8'), content)
      assert.equal(count(adapter.calls, 'disable'), 0)
      assert.equal(count(adapter.calls, 'kickstart'), 0)
      assert.equal(count(adapter.calls, 'start'), 0)
      await resume(options)
      assert.equal((await serviceDaemonStatus(options)).pid, RUNNING_PID)
    }
  })
}

// What `hyp daemon stop` gates on: is the service manager supervising this
// daemon right now. Neither "a unit is on disk" nor "a pid exists" answers it.
// `Restart=always` / `KeepAlive` means a crashing daemon has no pid for the
// whole throttle gap and is still coming back, so a stop routed past the
// manager during that gap is a stop that does not happen - which is the bug
// this PR exists to fix, reached from the other side.
test('a unit systemd will respawn reads as supervised, a stopped one does not', async () => {
  const home = tmpHome('supervised')
  const systemctl = fakeSystemd()
  const options = { ...linuxOpts(home, systemctl), platform: /** @type {const} */ ('linux') }
  try {
    await installSystemdUnit(options)
    const running = await serviceDaemonStatus(options)
    assert.equal(running.active, true)
    assert.equal(running.pid, RUNNING_PID)

    // The crash-loop gap: `ActiveState=activating`, no MainPID. A pid gate
    // would send this stop to the control file and report `not running`.
    systemctl.show = async (unit) => {
      systemctl.calls.push(['show', unit])
      return { exitCode: 0, stdout: 'LoadState=loaded\nActiveState=activating\nMainPID=0\n', stderr: '' }
    }
    const respawning = await serviceDaemonStatus(options)
    assert.equal(respawning.pid, undefined, 'no pid during the RestartSec gap')
    assert.equal(respawning.active, true, 'but systemd is still going to bring it back')

    // And the stop this PR preserves: still `loaded`, so `hyp daemon start`
    // and `restart` recover it, but no longer supervised, so a foreground
    // `hyp daemon run` beside it is reached by the control file instead.
    systemctl.show = async (unit) => {
      systemctl.calls.push(['show', unit])
      return { exitCode: 0, stdout: 'LoadState=loaded\nActiveState=inactive\nMainPID=0\n', stderr: '' }
    }
    const idle = await serviceDaemonStatus(options)
    assert.equal(idle.installed, true)
    assert.equal(idle.loaded, true, 'a stopped unit stays loaded, which is why loaded cannot be the gate')
    assert.equal(idle.active, false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// A refused bootout is told from an accepted one by what it left behind, not
// by its exit code: the service is still loaded after the wait. Its stderr is
// still what the operator needs, so it rides the failure.
test('service stop surfaces manager failures', async () => {
  const failed = { exitCode: 5, stdout: '', stderr: 'permission denied' }
  const launchctl = fakeLaunchd({ loadedAtStart: true })
  launchctl.bootout = async () => failed
  await assert.rejects(
    stopServiceDaemon({ ...darwinOpts('/unused', launchctl), platform: /** @type {const} */ ('darwin') }),
    /permission denied/,
  )
  const systemctl = fakeSystemd()
  systemctl.stop = async () => failed
  await assert.rejects(stopServiceDaemon({ platform: 'linux', systemctl }), /permission denied/)
})

// #1036 again, reached the other way. `hyp daemon start` after a stop has to
// bootstrap the label back in, and a label bootstrapped seconds after an
// instance of it was booted out is exactly where launchd leaves the initial
// spawn pended: bootstrap and kickstart both exit 0 with nothing running.
// `hyp status` recommends this command after a stop, so `daemon: started`
// over a dead machine is the same lie the installer stopped telling.
test('macOS start proves a pid for the label it had to bootstrap', async () => {
  const launchctl = fakeLaunchd({ spawnOnKickstart: false })
  await assert.rejects(
    startServiceDaemon({ ...darwinOpts('/unused', launchctl), platform: /** @type {const} */ ('darwin') }),
    /never started it/,
  )
  assert.equal(count(launchctl.calls, 'bootstrap'), 1)
  // The other arm is unchanged, and `pidAtStart: 0` is what makes that an
  // assertion rather than a coincidence: this job is loaded with nothing
  // running under it, so it would fail the pid proof if the proof reached it.
  // It kickstarts, reports, and is believed, as it was before stop existed.
  const loaded = fakeLaunchd({ loadedAtStart: true, pidAtStart: 0, spawnOnKickstart: false })
  await startServiceDaemon({ ...darwinOpts('/unused', loaded), platform: /** @type {const} */ ('darwin') })
  assert.equal(count(loaded.calls, 'bootstrap'), 0)
  assert.equal(count(loaded.calls, 'print'), 1, 'no pid poll on the arm launchd was already holding')
})

// The other half of that pid gate, and the same race `hyp daemon stop` hit on
// bootout: the plist a start bootstraps carries `RunAtLoad`, so launchd can
// spawn the job before the kickstart lands and answer the kickstart with
// `3: No such process`. `installLaunchAgent` has never read that exit code
// (see 'a kickstart that errors over a job launchd did start'), and the arm
// that just bootstrapped must not either, or `hyp daemon start` after a stop
// exits 1 over a daemon that is running.
test('macOS start after a stop is not failed by a kickstart that lost the race', async () => {
  const launchctl = fakeLaunchd({
    spawnOnBootstrap: true,
    spawnOnKickstart: false,
    kickstartStderr: 'Operation already in progress',
  })
  await startServiceDaemon({ ...darwinOpts('/unused', launchctl), platform: /** @type {const} */ ('darwin') })
  assert.equal(count(launchctl.calls, 'bootstrap'), 1)
  assert.equal(count(launchctl.calls, 'kickstart'), 1, 'forced the spawn without raising on its exit code')
  assert.match((await launchctl.print(['gui/501/com.hyperparam.hypaware'])).stdout, /pid = 4242/)
})

// launchd answers a teardown it has not finished with `36: Operation now in
// progress`, and one the job completed a moment before bootout ran with `3:
// No such process`. Both are stops that worked, and the second is a race the
// print above cannot close. Reading either as a failure would have made
// `hyp daemon stop` exit 1 over its own happy path on a real Mac, which no
// fake that returns 0 from bootout can show.
test('macOS stop reads the unload, not bootout\'s exit code', async () => {
  for (const booted of [
    { exitCode: 36, stdout: '', stderr: 'Boot-out failed: 36: Operation now in progress' },
    { exitCode: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' },
  ]) {
    const launchctl = fakeLaunchd({ loadedAtStart: true })
    const real = launchctl.bootout
    launchctl.bootout = async (args) => { await real(args); return booted }
    await stopServiceDaemon({ ...darwinOpts('/unused', launchctl), platform: /** @type {const} */ ('darwin') })
    assert.equal((await launchctl.print(['gui/501/com.hyperparam.hypaware'])).exitCode, 113)
  }
})

test('macOS stop waits for asynchronous unload and rejects a stuck service', async () => {
  const launchctl = fakeLaunchd({ loadedAtStart: true })
  const options = darwinOpts('/unused', launchctl)
  const { stopLaunchAgent } = await import('../../src/core/daemon/macos.js')
  launchctl.bootout = async () => OK
  await assert.rejects(stopLaunchAgent(options), /service did not unload/)
  assert.ok(count(launchctl.calls, 'print') < 100, 'unload polling is bounded')
  const print = launchctl.print
  let remaining = 2
  launchctl.print = async (args) => --remaining > 0
    ? print(args)
    : { exitCode: 113, stdout: '', stderr: 'Could not find service' }
  await stopLaunchAgent(options)
})

/** @param {string[][]} calls @param {string} verb */
const count = (calls, verb) => calls.filter((c) => c[0] === verb).length
/** @param {string[][]} calls @param {string} verb */
const indexOfVerb = (calls, verb) => calls.findIndex((c) => c[0] === verb)

/**
 * @param {string} homeDir
 * @param {ReturnType<typeof fakeLaunchd>} launchctl
 * @param {Record<string, unknown>} [extra]
 */
function darwinOpts(homeDir, launchctl, extra) {
  return {
    homeDir,
    binPath: '/x/bin/hypaware.js',
    nodePath: '/x/node',
    configPath: path.join(homeDir, 'hypaware-config.json'),
    launchctl,
    userDomain: 'gui/501',
    sleep: async function() {}, // never wait for real time in tests
    ...(extra ?? {}),
  }
}

/**
 * @param {string} homeDir
 * @param {ReturnType<typeof fakeSystemd>} systemctl
 */
function linuxOpts(homeDir, systemctl) {
  return {
    homeDir,
    binPath: '/x/bin/hypaware.js',
    nodePath: '/x/node',
    configPath: path.join(homeDir, 'hypaware-config.json'),
    unitDir: path.join(homeDir, 'systemd'),
    systemctl,
    sleep: async function() {},
  }
}

test('install kickstarts the bootstrapped agent instead of trusting RunAtLoad', async () => {
  const home = tmpHome('la-pended')
  // The #1036 host: bootstrap registers the job, launchd pends the spawn.
  const lc = fakeLaunchd({ loadedAtStart: true, spawnOnBootstrap: false })

  await installLaunchAgent(darwinOpts(home, lc))

  const bootstrapAt = indexOfVerb(lc.calls, 'bootstrap')
  const kickstartAt = indexOfVerb(lc.calls, 'kickstart')
  assert.ok(bootstrapAt >= 0, 'bootstrapped the new plist')
  assert.ok(kickstartAt > bootstrapAt, 'kickstarted the label after bootstrapping it')
  // Never `-k`: the job may already be running from RunAtLoad, and killing
  // what we just started would drop every attached client's connection.
  assert.deepEqual(
    lc.calls.filter((c) => c[0] === 'kickstart').filter((c) => c.includes('-k')),
    [],
    'kickstart forces the pended spawn without killing a live process',
  )
  // And it only reports success once launchd shows a pid.
  const lastPrint = lc.calls.filter((c) => c[0] === 'print').length
  assert.ok(lastPrint > 0, 'verified the running state through launchctl print')
})

test('install fails loudly when launchd never spawns the agent', async () => {
  const home = tmpHome('la-dead')
  // Bootstrap and kickstart both answer; nothing ever runs. launchctl's own
  // complaint is the only clue there is, so it has to reach the user.
  const lc = fakeLaunchd({
    spawnOnBootstrap: false,
    spawnOnKickstart: false,
    kickstartStderr: 'Could not find service "com.hyperparam.hypaware" in domain for user',
  })

  await assert.rejects(
    () => installLaunchAgent(darwinOpts(home, lc)),
    (err) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /never started it/)
      // The CLI prints the message and nothing else, so the message is where
      // "why" and "here is the log that says more" both have to live.
      assert.match(err.message, /Could not find service/)
      assert.match(err.message, /daemon\.err\.log/)
      // A kickstart that really did fail still reports its code: only the
      // meaningless `exitCode: 0` is dropped.
      assert.equal(/** @type {{ exitCode?: number }} */ (err).exitCode, 3)
      return true
    },
  )
  assert.equal(count(lc.calls, 'kickstart'), 1, 'tried to force the spawn before giving up')
})

test('a kickstart that errors over a job launchd did start is not a failed install', async () => {
  const home = tmpHome('la-kick-noisy')
  // kickstart exits non-zero and complains, but RunAtLoad already spawned the
  // job. The pid is the gate, not the kickstart's exit code, so this installs.
  const lc = fakeLaunchd({
    spawnOnBootstrap: true,
    spawnOnKickstart: false,
    kickstartStderr: 'Operation already in progress',
  })

  const plan = await installLaunchAgent(darwinOpts(home, lc))

  assert.ok(fs.existsSync(plan.targetPath), 'plist written')
  assert.equal(count(lc.calls, 'kickstart'), 1, 'forced the spawn without raising on its exit code')
})

test('an agent RunAtLoad already spawned installs cleanly and is not killed', async () => {
  const home = tmpHome('la-live')
  const lc = fakeLaunchd({ spawnOnBootstrap: true })

  const plan = await installLaunchAgent(darwinOpts(home, lc))

  assert.ok(fs.existsSync(plan.targetPath), 'plist written')
  assert.deepEqual(
    lc.calls.filter((c) => c[0] === 'kickstart').filter((c) => c.includes('-k')),
    [],
    'never restarts the process the install just started',
  )
})

test('RunAtLoad=false leaves the starting to launchd, and demands no pid', async () => {
  const home = tmpHome('la-dormant')
  const lc = fakeLaunchd({ spawnOnBootstrap: false, spawnOnKickstart: false })

  await installLaunchAgent(darwinOpts(home, lc, { runAtLoad: false }))

  assert.equal(count(lc.calls, 'kickstart'), 0, 'the installer never overrides the flag it was handed')
})

test('systemd install fails loudly when the started unit has no MainPID', async () => {
  const home = tmpHome('sd-dead')
  const sc = fakeSystemd({ spawnOnRestart: false, spawnOnStart: false, startStderr: 'Unit hypaware.service not found.' })

  await assert.rejects(
    () => installSystemdUnit(linuxOpts(home, sc)),
    (err) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /never reported a running process/)
      assert.match(err.message, /Unit hypaware\.service not found/)
      assert.match(err.message, /daemon\.err\.log/)
      // A start that really did fail still reports its code.
      assert.equal(/** @type {{ exitCode?: number }} */ (err).exitCode, 5)
      return true
    },
  )
  assert.ok(count(sc.calls, 'show') > 0, 'verified the running state through systemctl show')
  assert.equal(count(sc.calls, 'start'), 1, 'spent its one retry before giving up')
})

test('systemd install accepts a unit that only comes up on the retried start', async () => {
  const home = tmpHome('sd-retry')
  const sc = fakeSystemd({ spawnOnRestart: false, spawnOnStart: true })

  const plan = await installSystemdUnit(linuxOpts(home, sc))

  assert.ok(fs.existsSync(plan.targetPath), 'unit written')
  assert.equal(count(sc.calls, 'start'), 1, 'one retried start was enough')
})

test('systemd install issues no extra start when restart already brought it up', async () => {
  const home = tmpHome('sd-live')
  const sc = fakeSystemd({ spawnOnRestart: true })

  await installSystemdUnit(linuxOpts(home, sc))

  assert.equal(count(sc.calls, 'restart'), 1, 'restarted once')
  assert.equal(count(sc.calls, 'start'), 0, 'no redundant start on a healthy unit')
})

// Deferred findings from the review of #1039 (issue #1041, items 3 and 4):
// the "install never came up" failure has to point somewhere that actually
// has an answer, and must not label itself with a success exit code.

test('a launchd install that never spawned names launchctl print as the second place to look', async () => {
  const home = tmpHome('la-where')
  // The pended-spawn shape: every command exits 0, nothing ever runs, and
  // daemon.err.log has no fresh line in it because the process never started.
  // The log pointer alone can only show stale output from a previous run.
  const lc = fakeLaunchd({ spawnOnBootstrap: false, spawnOnKickstart: false })

  await assert.rejects(
    () => installLaunchAgent(darwinOpts(home, lc)),
    (err) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /daemon\.err\.log/)
      // `StandardErrorPath` appends, so the log is never truncated: on a
      // reinstall over a label that ran before, it is not empty, it is stale.
      // Telling the operator it "stays empty when the job never ran" would
      // send them to read a previous run's crash as if it were this one's.
      assert.doesNotMatch(err.message, /stays empty/)
      // The probe ends the message so it can be copy-pasted: a trailing `)`
      // would ride along and launchctl would reject the target.
      assert.match(err.message, /ask launchd itself: launchctl print gui\/501\/\S+$/)
      return true
    },
  )
})

test('a launchd install that never spawned carries no exit code when launchctl exited 0', async () => {
  const home = tmpHome('la-exit0')
  const lc = fakeLaunchd({ spawnOnBootstrap: false, spawnOnKickstart: false })

  await assert.rejects(
    () => installLaunchAgent(darwinOpts(home, lc)),
    (err) => {
      assert.ok(err instanceof Error)
      // A thrown install error tagged `exitCode: 0` reads as success to any
      // caller that forwards the field as a process exit status. The kickstart
      // really did exit 0, which is why there is no exit code to report here.
      assert.equal(/** @type {{ exitCode?: number }} */ (err).exitCode, undefined)
      return true
    },
  )
})

test('a systemd install that never spawned names systemctl status as the second place to look', async () => {
  const home = tmpHome('sd-where')
  const sc = fakeSystemd({ spawnOnRestart: false, spawnOnStart: false })

  await assert.rejects(
    () => installSystemdUnit(linuxOpts(home, sc)),
    (err) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /daemon\.err\.log/)
      // `StandardError=append:` never truncates either, so the same stale-log
      // trap applies on Linux.
      assert.doesNotMatch(err.message, /stays empty/)
      assert.match(err.message, /ask systemd itself: systemctl --user status \S+\.service$/)
      return true
    },
  )
})

test('a systemd install that never spawned carries no exit code when systemctl exited 0', async () => {
  const home = tmpHome('sd-exit0')
  const sc = fakeSystemd({ spawnOnRestart: false, spawnOnStart: false })

  await assert.rejects(
    () => installSystemdUnit(linuxOpts(home, sc)),
    (err) => {
      assert.ok(err instanceof Error)
      assert.equal(/** @type {{ exitCode?: number }} */ (err).exitCode, undefined)
      return true
    },
  )
})

// The reason clause is now followed by a sentence, not by ` (see ...)`, so a
// service manager that ends its stderr with a period used to leave `..` in the
// middle of the one message the operator has to read carefully.

test('a systemd reason that ends in a period does not double up the sentence break', async () => {
  const home = tmpHome('sd-dot')
  // Verbatim shape of a real `systemctl --user start` failure: it ends in a period.
  const sc = fakeSystemd({
    spawnOnRestart: false,
    spawnOnStart: false,
    startStderr: 'Failed to start hypaware.service: Unit hypaware.service not found.',
  })

  await assert.rejects(
    () => installSystemdUnit(linuxOpts(home, sc)),
    (err) => {
      assert.ok(err instanceof Error)
      // The reason still arrives whole apart from the punctuation.
      assert.match(err.message, /Unit hypaware\.service not found/)
      assert.doesNotMatch(err.message, /\.\./)
      return true
    },
  )
})

test('a launchd reason that ends in a period does not double up the sentence break', async () => {
  const home = tmpHome('la-dot')
  const lc = fakeLaunchd({
    spawnOnBootstrap: false,
    spawnOnKickstart: false,
    kickstartStderr: 'Could not find service "com.hyperparam.hypaware" in domain for user.',
  })

  await assert.rejects(
    () => installLaunchAgent(darwinOpts(home, lc)),
    (err) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /in domain for user/)
      assert.doesNotMatch(err.message, /\.\./)
      return true
    },
  )
})

/**
 * A systemd-installed daemon, the systemctl standing in for the service
 * manager, and the context `hyp daemon stop` runs against them with.
 *
 * @param {string} home
 */
async function stageServiceDaemon(home) {
  let out = ''
  let err = ''
  const systemctl = fakeSystemd()
  const options = { ...linuxOpts(home, systemctl), platform: /** @type {const} */ ('linux') }
  await installSystemdUnit(options)
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout: { write(/** @type {unknown} */ chunk) { out += String(chunk); return true } },
    stderr: { write(/** @type {unknown} */ chunk) { err += String(chunk); return true } },
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
  }))
  return {
    systemctl,
    options,
    ctx,
    stateRoot: path.join(home, '.hyp', 'hypaware'),
    out: () => out,
    err: () => err,
  }
}

/**
 * A pid file the daemon never got to clear, as a hard kill leaves it.
 *
 * @param {string} stateRoot
 * @param {number} pid
 */
function stageAbandonedPidFile(stateRoot, pid) {
  writePidFile(stateRoot, { pid, startedAt: new Date().toISOString(), runId: 'hard-kill', mode: 'foreground' })
}

// Issue #2266. A manager that had to hard-kill a wedged daemon gave it no
// shutdown to run, so the pid file the daemon clears for itself on an orderly
// stop is still on disk naming a process that is gone while `hyp daemon stop`
// reports `daemon: stopped`. The control-file transport clears exactly that
// file on a confirmed exit.
//
// The unit here is in the state such a kill leaves - no MainPID, still
// `Restart=always` - which is also the throttle gap the gate must keep reading
// as supervised rather than as "not running" (#2261), so the stop going
// through systemctl is asserted alongside the file.
test('a service stop clears the pid file a hard-killed daemon left behind', async () => {
  const home = tmpHome('stale-pid')
  try {
    const staged = await stageServiceDaemon(home)
    hardKilled(staged.systemctl)
    const deadPid = 999999
    assert.equal(processIsAlive(deadPid), false, 'the fixture needs a pid no process holds')
    stageAbandonedPidFile(staged.stateRoot, deadPid)

    const code = await runDaemonStop([], staged.ctx, { service: staged.options })

    assert.equal(code, 0, staged.err())
    assert.equal(count(staged.systemctl.calls, 'stop'), 1, 'the stop still went through the service manager')
    assert.match(staged.out(), /daemon: stopped/)
    const pidFile = pidFilePath(staged.stateRoot)
    assert.ok(
      !fs.existsSync(pidFile) || staged.out().includes(pidFile),
      `the stale pid file was neither removed nor named: ${JSON.stringify(staged.out())}`,
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// The property that makes the clear safe: the file goes only when the pid it
// names is gone. Both managers return from the stop with the process already
// gone, so the live pid this keeps a file for is somebody else's: a foreground
// `hyp daemon run` that claimed it while the unit sat in its restart gap, or
// one the OS has reissued. A stop that deleted it would blind every liveness
// check to a process that is running.
test('a service stop leaves the pid file of a daemon that is still alive', async (t) => {
  const home = tmpHome('live-pid')
  try {
    const staged = await stageServiceDaemon(home)
    // A live pid that is not the runner's own: a regression that signalled or
    // killed what the pid file names would otherwise take the suite with it,
    // and read as a crash rather than as this assertion.
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
    t.after(() => live.kill('SIGKILL'))
    assert.ok(live.pid, 'the fixture needs a spawned pid, never the runner\'s own')
    stageAbandonedPidFile(staged.stateRoot, live.pid)
    const before = fs.readFileSync(pidFilePath(staged.stateRoot), 'utf8')

    const code = await runDaemonStop([], staged.ctx, { service: staged.options })

    assert.equal(code, 0, staged.err())
    assert.equal(fs.readFileSync(pidFilePath(staged.stateRoot), 'utf8'), before, 'a live daemon keeps its pid file')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * Put the unit in the state a hard kill leaves it in: still loaded, no MainPID.
 *
 * @param {ReturnType<typeof fakeSystemd>} systemctl
 */
function hardKilled(systemctl) {
  systemctl.show = async (unit) => {
    systemctl.calls.push(['show', unit])
    return { exitCode: 0, stdout: 'LoadState=loaded\nActiveState=activating\nMainPID=0\n', stderr: '' }
  }
}

// Issue #2288, the other half of #2266. The supervised processing child keeps
// its own pid file below `processing/`, and a kill of the daemon's control
// group strands that one too: the child never ran a shutdown either. Nothing
// reads it today and the next processing boot overwrites it, so the stale file
// misleads only a human reading the state dir - which is reason to reconcile
// it on the same stop, not to leave a second dead pid on disk.
test('a service stop clears the processing pid file a hard-killed daemon left behind', async () => {
  const home = tmpHome('stale-processing-pid')
  try {
    const staged = await stageServiceDaemon(home)
    hardKilled(staged.systemctl)
    const deadPid = 999999
    assert.equal(processIsAlive(deadPid), false, 'the fixture needs a pid no process holds')
    const processingRoot = processingStateRoot(staged.stateRoot)
    stageAbandonedPidFile(processingRoot, deadPid)

    const code = await runDaemonStop([], staged.ctx, { service: staged.options })

    assert.equal(code, 0, staged.err())
    assert.equal(count(staged.systemctl.calls, 'stop'), 1, 'the stop still went through the service manager')
    assert.match(staged.out(), /daemon: stopped/)
    const pidFile = pidFilePath(processingRoot)
    assert.ok(
      !fs.existsSync(pidFile) || staged.out().includes(pidFile),
      `the stale processing pid file was neither removed nor named: ${JSON.stringify(staged.out())}`,
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// The same guard the gateway file gets, against a real spawned child rather
// than a stubbed liveness function: what is under test is what the live OS
// says about a running pid. Never `process.pid`, or a regression that deleted
// the file would still pass while a stop that signalled it took the suite out.
test('a service stop leaves a live processing pid file byte-identical', async (t) => {
  const home = tmpHome('live-processing-pid')
  try {
    const staged = await stageServiceDaemon(home)
    hardKilled(staged.systemctl)
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
    t.after(() => live.kill('SIGKILL'))
    assert.ok(live.pid, 'the fixture needs a spawned pid, never the runner\'s own')
    const processingRoot = processingStateRoot(staged.stateRoot)
    stageAbandonedPidFile(processingRoot, live.pid)
    const before = fs.readFileSync(pidFilePath(processingRoot), 'utf8')

    const code = await runDaemonStop([], staged.ctx, { service: staged.options })

    assert.equal(code, 0, staged.err())
    assert.equal(
      fs.readFileSync(pidFilePath(processingRoot), 'utf8'),
      before,
      'a live processing daemon keeps its pid file',
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * Run `fn` with `process.kill` raising `code` for `pid`, so the branch under
 * test is reached whatever this host's process table happens to look like.
 * Restored in a `finally` rather than in a `t.after`, because the stubbed
 * region is synchronous: the real `process.kill` is back before any other
 * test or hook can observe it.
 *
 * @param {number} pid
 * @param {string} code
 * @param {() => void} fn
 */
function withSignalError(pid, code, fn) {
  const real = process.kill
  process.kill = (target, signal) => {
    if (target !== pid) return real.call(process, target, signal)
    throw Object.assign(new Error(`kill ${code}`), { code, syscall: 'kill' })
  }
  try {
    fn()
  } finally {
    process.kill = real
  }
}

// Issue #2301. The safety of the stale clear turns on one branch of
// `processIsAlive`: a pid the runner may not signal is a pid somebody still
// holds, so reading `EPERM` as dead would unlink the pid file of a live,
// reissued pid and blind every later liveness check to it. The reading has
// been argued the other way in this codebase before (#2289).
//
// The signal is stubbed rather than probed, because the ambient case is not
// available everywhere: in a container whose pid 1 is owned by the test uid
// nothing the runner can name raises `EPERM`, and a test that only read the
// real process table would pass there without reaching the branch.
test('a pid file naming a pid the runner may not signal survives the stale clear', (t) => {
  const home = tmpHome('eperm-pid')
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const stateRoot = path.join(home, '.hyp', 'hypaware')
  const unsignalable = 424242
  stageAbandonedPidFile(stateRoot, unsignalable)
  const before = fs.readFileSync(pidFilePath(stateRoot), 'utf8')

  withSignalError(unsignalable, 'EPERM', () => {
    assert.equal(processIsAlive(unsignalable), true, 'a pid we may not signal is one somebody holds')
    clearStalePidFile(stateRoot)
  })

  assert.equal(fs.readFileSync(pidFilePath(stateRoot), 'utf8'), before, 'the clear left a live pid file alone')
})

// The other half of the same decision: `ESRCH` is the only reading that lets
// a pid file go, so a catch that answered alive for every error would strand
// every stale one.
test('a pid file naming a pid nothing holds is what the stale clear removes', (t) => {
  const home = tmpHome('esrch-pid')
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const stateRoot = path.join(home, '.hyp', 'hypaware')
  const gone = 424243
  stageAbandonedPidFile(stateRoot, gone)

  withSignalError(gone, 'ESRCH', () => {
    assert.equal(processIsAlive(gone), false, 'a pid no process holds is dead')
    clearStalePidFile(stateRoot)
  })

  assert.equal(fs.existsSync(pidFilePath(stateRoot)), false, 'the clear removed the stale pid file')
})

// The same property against the real signal table: pid 1 belongs to root and
// the runner does not, so signal 0 to it is the unsignalable-but-live case
// the OS itself produces. Signal 0 only, never a pid this suite could kill.
// Skipped where the host does not offer the case, so the assertion can never
// pass for the wrong reason.
test('the OS agrees: a live pid this uid may not signal keeps its pid file', (t) => {
  /** @type {unknown} */
  let thrown
  try {
    process.kill(1, 0)
  } catch (err) {
    thrown = err
  }
  const code = thrown && /** @type {NodeJS.ErrnoException} */ (thrown).code
  if (code !== 'EPERM') {
    return t.skip(`kill(1, 0) ${thrown ? `raised ${String(code)}` : 'succeeded'} here, so pid 1 is not unsignalable`)
  }

  const home = tmpHome('eperm-pid1')
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const stateRoot = path.join(home, '.hyp', 'hypaware')
  assert.equal(processIsAlive(1), true, 'pid 1 is running, whether or not this uid may signal it')
  stageAbandonedPidFile(stateRoot, 1)
  const before = fs.readFileSync(pidFilePath(stateRoot), 'utf8')

  clearStalePidFile(stateRoot)

  assert.equal(fs.readFileSync(pidFilePath(stateRoot), 'utf8'), before, 'the clear left pid 1\'s file alone')
})

// Issue #2299. `hyp daemon uninstall` stranded the same two pid files a stop
// does, and for a stronger reason: the teardown unlinks the plist / unit, so
// nothing will ever rewrite them.

/**
 * `hyp daemon uninstall` against a staged install, with the service teardown
 * stubbed through its deps seam so no real launchd or systemd domain is
 * reached.
 *
 * @param {Awaited<ReturnType<typeof stageServiceDaemon>>} staged
 */
async function uninstallThroughSeam(staged) {
  return await runDaemonUninstall([], staged.ctx, { uninstallDaemon: async function() {} })
}

test('an uninstall clears both stale pid files the torn-down daemon left behind', async () => {
  const home = tmpHome('uninstall-stale-pid')
  try {
    const staged = await stageServiceDaemon(home)
    const deadPid = 999999
    assert.equal(processIsAlive(deadPid), false, 'the fixture needs a pid no process holds')
    const processingRoot = processingStateRoot(staged.stateRoot)
    stageAbandonedPidFile(staged.stateRoot, deadPid)
    stageAbandonedPidFile(processingRoot, deadPid)

    const code = await uninstallThroughSeam(staged)

    assert.equal(code, 0, staged.err())
    assert.match(staged.out(), /Daemon removed/)
    assert.equal(fs.existsSync(pidFilePath(staged.stateRoot)), false, 'the stale gateway pid file outlived the uninstall')
    assert.equal(fs.existsSync(pidFilePath(processingRoot)), false, 'the stale processing pid file outlived the uninstall')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// The guard that makes the clear safe, against a real spawned child rather
// than a stubbed liveness function. Never `process.pid`, which a regression
// that signalled the file's pid would take out with the suite.
test('an uninstall leaves the pid files of a live process byte-identical', async (t) => {
  const home = tmpHome('uninstall-live-pid')
  try {
    const staged = await stageServiceDaemon(home)
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' })
    t.after(() => live.kill('SIGKILL'))
    assert.ok(live.pid, 'the fixture needs a spawned pid, never the runner\'s own')
    const processingRoot = processingStateRoot(staged.stateRoot)
    stageAbandonedPidFile(staged.stateRoot, live.pid)
    stageAbandonedPidFile(processingRoot, live.pid)
    const gatewayBefore = fs.readFileSync(pidFilePath(staged.stateRoot), 'utf8')
    const processingBefore = fs.readFileSync(pidFilePath(processingRoot), 'utf8')

    const code = await uninstallThroughSeam(staged)

    assert.equal(code, 0, staged.err())
    assert.equal(fs.readFileSync(pidFilePath(staged.stateRoot), 'utf8'), gatewayBefore, 'a live gateway pid keeps its file')
    assert.equal(fs.readFileSync(pidFilePath(processingRoot), 'utf8'), processingBefore, 'a live processing pid keeps its file')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// The same property against the real signal table: pid 1 belongs to root and
// the runner does not, so signal 0 to it is the unsignalable-but-live case the
// OS itself produces. Skipped where the host does not offer it, so the
// assertion can never pass for the wrong reason.
test('the OS agrees: an uninstall keeps the file of a live pid this uid may not signal', async (t) => {
  /** @type {unknown} */
  let thrown
  try {
    process.kill(1, 0)
  } catch (err) {
    thrown = err
  }
  const code = thrown && /** @type {NodeJS.ErrnoException} */ (thrown).code
  if (code !== 'EPERM') {
    return t.skip(`kill(1, 0) ${thrown ? `raised ${String(code)}` : 'succeeded'} here, so pid 1 is not unsignalable`)
  }

  const home = tmpHome('uninstall-eperm-pid1')
  try {
    const staged = await stageServiceDaemon(home)
    assert.equal(processIsAlive(1), true, 'pid 1 is running, whether or not this uid may signal it')
    stageAbandonedPidFile(staged.stateRoot, 1)
    const before = fs.readFileSync(pidFilePath(staged.stateRoot), 'utf8')

    assert.equal(await uninstallThroughSeam(staged), 0, staged.err())

    assert.equal(fs.readFileSync(pidFilePath(staged.stateRoot), 'utf8'), before, 'the uninstall left pid 1\'s file alone')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// Best-effort, and each file on its own. The teardown the user asked for has
// already happened, so a pid file that cannot be removed is no reason to call
// a completed uninstall a failure, and no reason to skip the other root: the
// shape #2300 records on the stop path.
test('a gateway pid file that cannot be removed fails neither the uninstall nor the other root', async (t) => {
  const home = tmpHome('uninstall-unremovable-pid')
  const staged = await stageServiceDaemon(home)
  const runDir = path.dirname(pidFilePath(staged.stateRoot))
  t.after(() => {
    fs.chmodSync(runDir, 0o755)
    fs.rmSync(home, { recursive: true, force: true })
  })
  if (process.getuid?.() === 0) {
    return t.skip('root ignores the directory mode, so the unlink cannot be made to fail')
  }
  const deadPid = 999999
  const processingRoot = processingStateRoot(staged.stateRoot)
  stageAbandonedPidFile(staged.stateRoot, deadPid)
  stageAbandonedPidFile(processingRoot, deadPid)
  // Readable but unlinkable: the unlink raises EACCES, the error
  // `clearPidFile` rethrows rather than swallows.
  fs.chmodSync(runDir, 0o555)

  const code = await uninstallThroughSeam(staged)

  assert.equal(code, 0, staged.err())
  assert.match(staged.out(), /Daemon removed/)
  assert.equal(fs.existsSync(pidFilePath(staged.stateRoot)), true, 'the fixture needs an unremovable file')
  assert.equal(fs.existsSync(pidFilePath(processingRoot)), false, 'the second root was skipped by the first one failing')
})

// The order the clear sits in, which nothing else observes. Before the
// teardown the plist / unit is still on disk, so the manager still holds
// `KeepAlive` / `Restart=always` and a daemon inside its restart gap is about
// to be brought back (#2261): the pid it then writes is the one an early
// clear would have deleted out from under it. The deps seam is the only
// vantage point that can see which ran first, so it is where the order is
// pinned.
test('the stale clear runs after the service teardown, never before it', async () => {
  const home = tmpHome('uninstall-clear-after-teardown')
  try {
    const staged = await stageServiceDaemon(home)
    stageAbandonedPidFile(staged.stateRoot, 999999)
    /** @type {boolean | undefined} */
    let pidFileWhenTornDown

    const code = await runDaemonUninstall([], staged.ctx, {
      uninstallDaemon: async function() {
        pidFileWhenTornDown = fs.existsSync(pidFilePath(staged.stateRoot))
      },
    })

    assert.equal(code, 0, staged.err())
    assert.equal(pidFileWhenTornDown, true, 'the clear ran while the respawn policy was still installed')
    assert.equal(fs.existsSync(pidFilePath(staged.stateRoot)), false, 'the clear did not run after the teardown either')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// The other side of that order. A teardown that threw left the plist / unit
// on disk with its respawn policy intact, so the daemon the clear would read
// as dead is one the manager is still about to bring back: the file stays,
// and the command still reports the failure the operator has to act on.
test('a teardown that failed clears nothing, because the respawn policy is still installed', async () => {
  const home = tmpHome('uninstall-failed-teardown')
  try {
    const staged = await stageServiceDaemon(home)
    stageAbandonedPidFile(staged.stateRoot, 999999)
    stageAbandonedPidFile(processingStateRoot(staged.stateRoot), 999999)

    const code = await runDaemonUninstall([], staged.ctx, {
      uninstallDaemon: async function() { throw new Error('bootout refused') },
    })

    assert.equal(code, 1)
    assert.match(staged.err(), /bootout refused/)
    assert.equal(fs.existsSync(pidFilePath(staged.stateRoot)), true, 'a failed teardown cleared the gateway pid file anyway')
    assert.equal(fs.existsSync(pidFilePath(processingStateRoot(staged.stateRoot))), true, 'a failed teardown cleared the processing pid file anyway')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

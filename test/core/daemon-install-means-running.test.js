// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installLaunchAgent } from '../../src/core/daemon/macos.js'
import { installSystemdUnit } from '../../src/core/daemon/linux.js'
import { startServiceDaemon, stopServiceDaemon, restartServiceDaemon, serviceDaemonStatus } from '../../src/core/daemon/install.js'

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

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installLaunchAgent } from '../../src/core/daemon/macos.js'
import { installSystemdUnit } from '../../src/core/daemon/linux.js'

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
 * @param {{ loadedAtStart?: boolean, spawnOnBootstrap?: boolean, spawnOnKickstart?: boolean, kickstartStderr?: string }} [opts]
 */
function fakeLaunchd(opts) {
  const { loadedAtStart = false, spawnOnBootstrap = false, spawnOnKickstart = true, kickstartStderr } = opts ?? {}
  /** @type {string[][]} */
  const calls = []
  let loaded = loadedAtStart
  let pid = loadedAtStart ? RUNNING_PID : 0
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
      if (spawnOnStart) pid = RUNNING_PID
      if (startStderr !== undefined) {
        return Promise.resolve({ exitCode: 5, stdout: '', stderr: startStderr })
      }
      return Promise.resolve(OK)
    },
    /** @param {string} unit */
    stop(unit) { calls.push(['stop', unit]); pid = 0; return Promise.resolve(OK) },
    /** @param {string} unit */
    restart(unit) {
      calls.push(['restart', unit])
      if (spawnOnRestart) pid = RUNNING_PID
      return Promise.resolve(OK)
    },
    /** @param {string} unit */
    status(unit) { calls.push(['status', unit]); return Promise.resolve(OK) },
    /** @param {string} unit */
    show(unit) {
      calls.push(['show', unit])
      const state = pid > 0 ? 'active' : 'activating'
      return Promise.resolve({
        exitCode: 0,
        stdout: `LoadState=loaded\nActiveState=${state}\nMainPID=${pid}\n`,
        stderr: '',
      })
    },
  }
}

const tmpHome = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `hyp-${tag}-`))
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

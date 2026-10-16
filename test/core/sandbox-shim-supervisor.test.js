// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  SHIM,
  shim,
  sandboxRoot,
  waitForBody,
  writePlist,
  waitForPid,
  unreapedPid,
  isAlive,
  recordedPid,
} from '../helpers/sandbox_shim.js'

/**
 * The launchd half of the shim under `HYP_SANDBOX_SPAWN=1`: the detached
 * supervisor the mock starts for a KeepAlive job, and what bootout, kickstart
 * and setenv do to it while it runs. Split from `sandbox-shim.test.js` so
 * these seconds-long waits do not sit on one file's critical path.
 */

test('launchctl mock: kickstart bounces the job only when -k asks it to', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1' }
  const plist = writePlist(root, label, ['/bin/sh', '-c', 'exec sleep 30'])

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)
  const first = await waitForPid(root, target, env)
  assert.ok(first, 'the supervisor started the program')

  // `installLaunchAgent` and `startLaunchAgent` (`src/core/daemon/macos.js`)
  // kickstart without `-k` and then poll for a pid. Real launchctl starts an
  // idle job and leaves a running one alone, so a mock that always killed
  // would report a successful start having just taken the daemon down.
  assert.equal(shim(root, 'launchctl', ['kickstart', target], env).code, 0)
  await new Promise((resolve) => setTimeout(resolve, 200))
  const printed = shim(root, 'launchctl', ['print', target], env)
  assert.match(printed.stdout, /\bstate = running/)
  assert.match(printed.stdout, new RegExp(`\\bpid = ${first}\\b`), 'a plain kickstart is a no-op on a running job')

  // `restartLaunchAgent` passes `-k`, and that one does bounce it.
  assert.equal(shim(root, 'launchctl', ['kickstart', '-k', target], env).code, 0)
  const second = await waitForPid(root, target, env, first)
  assert.ok(second, 'kickstart -k restarts the job')
  assert.notEqual(second, first)
})

test('launchctl mock: bootout does not return until the job has exited', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1' }
  // A real HypAware daemon drains before it exits, so the program here does
  // not die the instant it is signalled either. Against a program that dies
  // on the spot this test would pass without the wait and prove nothing.
  const plist = writePlist(root, label, [
    '/bin/sh', '-c', 'trap "sleep 1; exit 0" TERM; while :; do sleep 0.1; done',
  ])

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)
  const pid = await waitForPid(root, target, env)
  assert.ok(pid, 'the supervisor started the program')

  assert.equal(shim(root, 'launchctl', ['bootout', target], env).code, 0)
  // The instant bootout returns, the domain entry is gone and `print` answers
  // 113, which is all `waitUntilUnloaded` waits for. Anything still alive here
  // would still hold the gateway's listen port when the bootstrap that
  // follows a restart or reinstall tries to bind it.
  assert.equal(shim(root, 'launchctl', ['print', target], env).code, 113)
  assert.equal(isAlive(/** @type {number} */ (pid)), false, 'the job is gone, not merely signalled')
})

test('launchctl mock: a setenv after bootstrap reaches the next launch', async (t) => {
  const { root, label } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1', SANDBOX_PROBE: '' }
  const seen = path.join(root, 'probe.txt')
  // KeepAlive plus a program that exits is the restart cycle `hyp attach`
  // relies on: it setenvs and *then* lets the daemon come back to pick the
  // value up, so a domain snapshotted at bootstrap would never deliver it.
  const plist = writePlist(root, label, ['/bin/sh', '-c', `printf '[%s]\\n' "$SANDBOX_PROBE" >> ${seen}`])

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)
  // Match the first line rather than the whole body: KeepAlive relaunches the
  // job every `throttleMs`, so an equality here would also be asserting that
  // the poll read the file before the second launch appended to it, which is
  // the kind of clock dependence this test was just rid of.
  assert.match(await waitForBody(seen), /^\[\]\n/, 'the first launch saw an unset variable')

  assert.equal(shim(root, 'launchctl', ['setenv', 'SANDBOX_PROBE', 'on'], env).code, 0)
  const body = await waitForBody(seen, (written) => written.includes('[on]'))
  assert.match(body, /\[on\]/, 'a restart after the setenv carries the domain value')
})

test('launchctl mock: a program that cannot be started is recorded, not swallowed', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1' }
  // `spawn` reports an unlaunchable program as an `error` event and no
  // `exit`; unhandled, that takes the supervisor down with it and the run has
  // nothing to say about why the daemon never appeared.
  const plist = writePlist(root, label, [path.join(root, 'no-such-program')], { keepAlive: false })

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)

  const callsPath = path.join(root, 'state', 'calls.jsonl')
  let notes = []
  for (let attempt = 0; attempt < 120; attempt += 1) {
    notes = fs.readFileSync(callsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.args[0] === '(supervisor)')
      .map((entry) => entry.note)
    if (notes.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(notes.length, 1)
  assert.match(notes[0], /could not start .*no-such-program/)
  assert.equal(shim(root, 'launchctl', ['print', target], env).stdout.includes('state = running'), false)
})

test('launchctl mock: a setenv during a bootout survives the bootout', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1' }
  // `bootout` blocks until the job it signalled has actually drained. The
  // domain it writes back when it returns has to be re-read after that wait,
  // not the copy it read before: `hyp attach` setenvs NODE_USE_SYSTEM_CA and
  // the daemon's reconciler runs on its own clock, so a setenv landing inside
  // the wait is exactly the traffic this mock is here to model. Writing back
  // the stale copy erases it, `getenv` then reports it unset, and the run
  // blames HypAware for a value the mock threw away. `writeState`'s rename
  // does not cover this: it stops torn reads, not lost updates.
  const plist = writePlist(root, label, [
    '/bin/sh', '-c', 'trap "sleep 1; exit 0" TERM; while :; do sleep 0.1; done',
  ])

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)
  assert.ok(await waitForPid(root, target, env), 'the supervisor started the program')

  const bootout = spawn(process.execPath, [SHIM, 'launchctl', 'bootout', target], {
    env: { ...process.env, HYP_SANDBOX_ROOT: root, ...env },
    stdio: 'ignore',
  })
  const booted = new Promise((resolve) => bootout.on('exit', resolve))
  // Well inside the ~1s the trapped program spends draining.
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.equal(shim(root, 'launchctl', ['setenv', 'NODE_USE_SYSTEM_CA', '1'], env).code, 0)
  // Without this the test passes vacuously whenever the setenv lands after the
  // bootout has already written back: the pre-fix shim is green at that end of
  // the window, so a timing shift on a slow host would quietly stop testing
  // anything. `exitCode` is null only while the child is still running.
  assert.equal(bootout.exitCode, null, 'the bootout was still waiting when the setenv committed')
  assert.equal(
    shim(root, 'launchctl', ['getenv', 'NODE_USE_SYSTEM_CA'], env).stdout,
    '1\n',
    'the setenv committed'
  )

  assert.equal(await booted, 0, 'the bootout succeeded')
  assert.equal(
    shim(root, 'launchctl', ['getenv', 'NODE_USE_SYSTEM_CA'], env).stdout,
    '1\n',
    'the bootout did not write back the domain it read before it waited'
  )
  assert.equal(shim(root, 'launchctl', ['print', target], env).code, 113, 'the bootout still unloaded')
})

test('hyp-sandbox: stopping does not wait on, or warn about, an unreaped pid', async (t) => {
  const sandboxCli = fileURLToPath(new URL('../../scripts/sandbox/hyp-sandbox', import.meta.url))
  const zombiePid = await unreapedPid(t)
  if (zombiePid === null) {
    t.skip('this host cannot produce an unreaped pid to stop')
    return
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-sandbox-stop-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'state', 'launchd.json'),
    `${JSON.stringify({ services: { 'com.example.gone': { pid: zombiePid } }, env: {} }, null, 2)}\n`
  )

  const started = Date.now()
  const reset = spawnSync('bash', [sandboxCli, '--root', root, 'reset'], {
    encoding: 'utf8',
    input: 'y\n',
    timeout: 60_000,
  })
  const elapsed = Date.now() - started

  assert.equal(reset.status, 0, reset.stderr)
  // Positive control: without it, a `stop_everything` that stopped reading
  // `launchd.json` at all would satisfy every assertion below by doing nothing.
  assert.match(
    reset.stdout,
    /stopped 1 sandbox process/,
    'the pid in the domain was actually read and signalled'
  )
  // `stop_everything` probes with signal 0 alone unless it also checks for an
  // unreaped pid, and a corpse answers that probe forever. The visible cost is
  // a reset that spends its whole 5s SIGTERM budget plus its 2s SIGKILL budget
  // on a process that had already exited, then warns about survivors that are
  // not there - the sandbox reporting a confident wrong answer about its own
  // teardown, which is the one thing it must not do.
  assert.doesNotMatch(
    reset.stdout,
    /still running after SIGKILL/,
    'a pid that has already exited is gone, not a survivor to warn about'
  )
  assert.ok(elapsed < 5000, `reset spent ${elapsed}ms waiting on a pid that had already exited`)
  assert.equal(fs.existsSync(root), false, 'the root is deleted once nothing is running')
})

test('launchctl mock: a bootout leaves alone a supervisor started while it waited', async (t) => {
  const { root, label, target } = sandboxRoot(t)
  const env = { HYP_SANDBOX_SPAWN: '1' }
  // The supervisor dies on the first SIGTERM while its program is still
  // draining, so for the whole of that wait the domain holds a dead pid and a
  // `kickstart` (which is what `startLaunchAgent` and `hyp daemon restart`
  // issue) installs a replacement. A bootout that deletes by label alone then
  // removes the replacement it never killed: `print` answers 113 while that
  // supervisor is live, the next `bootstrap` puts a second daemon on the port,
  // and `stop_everything` cannot reach it because it enumerates the domain.
  const plist = writePlist(root, label, [
    '/bin/sh', '-c', 'trap "sleep 2; exit 0" TERM; while :; do sleep 0.1; done',
  ])

  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist], env).code, 0)
  assert.ok(await waitForPid(root, target, env), 'the supervisor started the program')
  const first = recordedPid(root, 'launchd.json', 'services', label)

  const bootout = spawn(process.execPath, [SHIM, 'launchctl', 'bootout', target], {
    env: { ...process.env, HYP_SANDBOX_ROOT: root, ...env },
    stdio: 'ignore',
  })
  const booted = new Promise((resolve) => bootout.on('exit', resolve))
  // Well inside the ~2s the trapped program spends draining.
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(shim(root, 'launchctl', ['kickstart', target], env).code, 0)
  const second = recordedPid(root, 'launchd.json', 'services', label)
  assert.ok(second && second !== first, 'the kickstart installed a replacement supervisor')

  await booted
  assert.equal(
    recordedPid(root, 'launchd.json', 'services', label),
    second,
    'the bootout deleted the instance it killed, not the one that replaced it'
  )
  assert.ok(
    isAlive(/** @type {number} */ (second)),
    'the replacement is still running, so leaving it in the domain is what keeps it reachable'
  )
  // The domain entry is only half of staying reachable. `killService` also
  // clears the child pid file, and that file is where `print` reads the
  // `pid = N` line `waitUntilRunning` and `hyp status` branch on, so clearing
  // the replacement's entry would report a live daemon as `not running`.
  assert.match(
    shim(root, 'launchctl', ['print', target], env).stdout,
    /\bpid = \d+/,
    'print still reports the daemon the replacement is running'
  )
})

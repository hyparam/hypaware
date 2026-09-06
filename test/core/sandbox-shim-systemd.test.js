// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { SHIM, shim, systemdRoot, isAlive, recordedPid } from '../helpers/sandbox_shim.js'

/**
 * The systemd half of the shim: `systemctl --user` against a unit under a
 * sandboxed HOME, and the supervisor its restart delay leaves behind. Split
 * from `sandbox-shim.test.js` for the same reason as its siblings.
 */

test('systemctl mock: --spawn starts the unit and reports its MainPID', async (t) => {
  const { root, home, unit } = systemdRoot(t)
  const env = { HOME: home, HYP_SANDBOX_SPAWN: '1' }

  assert.equal(shim(root, 'systemctl', ['--user', 'restart', unit], env).code, 0)

  let shown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    shown = shim(root, 'systemctl', [
      '--user', 'show', unit, '--property=LoadState,ActiveState,MainPID',
    ], env)
    if (/^MainPID=[1-9]\d*$/m.test(shown.stdout)) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(shown.code, 0)
  assert.match(shown.stdout, /^MainPID=[1-9]\d*$/m)
  assert.match(shown.stdout, /^ActiveState=active$/m)
})

test('systemctl mock: a start while the unit is between restarts does not add a second supervisor', async (t) => {
  const { root, home, unit } = systemdRoot(t)
  const env = { HOME: home, HYP_SANDBOX_SPAWN: '1' }
  // A supervisor waiting out `RestartSec` has already removed its child's pid
  // file, so a liveness check that only asks `childPid` calls the unit stopped
  // and starts a second supervisor for it. Only the newer pid reaches
  // `systemd.json`, and both `stop` and `hyp-sandbox`'s `stop_everything` kill
  // only what it records, so the older one survives teardown.
  fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', unit), [
    '[Service]',
    'Type=simple',
    'ExecStart=/bin/sh -c "sleep 0.2"',
    'Restart=always',
    'RestartSec=2',
    '',
  ].join('\n'))

  assert.equal(shim(root, 'systemctl', ['--user', 'start', unit], env).code, 0)
  const first = recordedPid(root, 'systemd.json', 'units', unit)
  assert.ok(first, 'the unit got a supervisor')

  // Long enough for the program to exit and the supervisor to be sitting in
  // its restart delay with no child pid file on disk.
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(shim(root, 'systemctl', ['--user', 'start', unit], env).code, 0)
  assert.equal(
    recordedPid(root, 'systemd.json', 'units', unit),
    first,
    'the second start reused the running supervisor rather than adding one'
  )

  assert.equal(shim(root, 'systemctl', ['--user', 'stop', unit], env).code, 0)
  assert.equal(
    isAlive(/** @type {number} */ (first)),
    false,
    'stop reached every supervisor the unit had'
  )
})

test('systemctl mock: a stop says when it kept the instance that replaced the one it killed', async (t) => {
  const { root, home, unit } = systemdRoot(t)
  const env = { HOME: home, HYP_SANDBOX_SPAWN: '1' }
  // The supervisor exits on the first SIGTERM while its program is still
  // draining, so a `start` (or the start half of a `restart`) landing in that
  // window installs a replacement. The stop that follows still exits 0, which
  // is deliberate - stranding the replacement is worse - but `calls.jsonl` has
  // to say so, or the record claims the unit was stopped while it is live.
  const drain = path.join(root, 'drain.sh')
  fs.writeFileSync(drain, 'trap "sleep 2; exit 0" TERM\nwhile :; do sleep 0.1; done\n')
  fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', unit), [
    '[Service]',
    'Type=simple',
    `ExecStart=/bin/sh ${drain}`,
    'Restart=always',
    'RestartSec=1',
    '',
  ].join('\n'))

  assert.equal(shim(root, 'systemctl', ['--user', 'start', unit], env).code, 0)
  const first = recordedPid(root, 'systemd.json', 'units', unit)
  assert.ok(first, 'the unit got a supervisor')
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (/MainPID=[1-9]/.test(shim(root, 'systemctl', ['--user', 'show', unit], env).stdout)) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  const stopping = spawn(process.execPath, [SHIM, 'systemctl', '--user', 'stop', unit], {
    env: { ...process.env, HYP_SANDBOX_ROOT: root, ...env },
    stdio: 'ignore',
  })
  const stopped = new Promise((resolve) => stopping.on('exit', resolve))
  // Well inside the ~2s the trapped program spends draining.
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(shim(root, 'systemctl', ['--user', 'start', unit], env).code, 0)
  const second = recordedPid(root, 'systemd.json', 'units', unit)
  assert.ok(second && second !== first, 'the start installed a replacement supervisor')

  assert.equal(await stopped, 0)
  assert.equal(
    recordedPid(root, 'systemd.json', 'units', unit),
    second,
    'the stop cleared the instance it killed, not the one that replaced it'
  )
  const notes = fs.readFileSync(path.join(root, 'state', 'calls.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line).note)
  assert.ok(
    notes.includes(`stop ${unit} (kept the instance that replaced it)`),
    `the stop said it left a live supervisor behind, got ${JSON.stringify(notes)}`
  )
})

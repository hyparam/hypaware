// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  SHIM,
  shim,
  sandboxRoot,
  systemdRoot,
  lockPathFor,
  waitForLockToken,
  lockEvents,
  supervisorNotes,
} from '../helpers/sandbox_shim.js'

/**
 * The shim's state file: the lock two shims contend for, what `calls.jsonl`
 * records about it, and the reads that survive a transient errno. Split from
 * `sandbox-shim.test.js` for the same reason as its siblings.
 */

test('state lock: a holder whose lock was broken does not delete its successor lock', async (t) => {
  const { root } = sandboxRoot(t)
  const lockPath = lockPathFor(root, 'launchd.json')
  const base = { ...process.env, HYP_SANDBOX_ROOT: root }

  // A takes the lock and parks inside the critical section, the way a shim
  // killed mid-update or descheduled under load would.
  const holder = spawn(process.execPath, [SHIM, 'launchctl', 'setenv', 'FROM_A', '1'], {
    env: { ...base, HYP_SANDBOX_TEST_HOLD_MS: '2500' },
    stdio: 'ignore',
  })
  const holderExit = new Promise((resolve) => holder.on('exit', resolve))
  const tokenA = await waitForLockToken(lockPath, null)
  assert.ok(tokenA, 'A took the lock')

  // B waits out its budget, breaks A's lock, takes it for itself, and is still
  // holding it when A wakes up. Releasing by name alone would then have A
  // delete a lock B is inside, and hand the read-change-write to a third shim
  // underneath it - which is the lost update the lock exists to stop.
  const successor = spawn(process.execPath, [SHIM, 'launchctl', 'setenv', 'FROM_B', '1'], {
    env: { ...base, HYP_SANDBOX_TEST_LOCK_WAIT_MS: '200', HYP_SANDBOX_TEST_HOLD_MS: '4000' },
    stdio: 'ignore',
  })
  const successorExit = new Promise((resolve) => successor.on('exit', resolve))
  const tokenB = await waitForLockToken(lockPath, tokenA)
  assert.ok(tokenB, 'B broke the lock at its budget and took it')
  assert.notEqual(tokenB, tokenA, 'B wrote its own ownership token')

  assert.equal(await holderExit, 0, 'A finished its update')
  assert.equal(fs.existsSync(lockPath), true, 'A did not remove the lock B is holding')
  assert.equal(fs.readFileSync(lockPath, 'utf8'), tokenB, 'the lock still names B as its owner')

  assert.equal(await successorExit, 0, 'B finished its update')
  assert.equal(fs.existsSync(lockPath), false, 'B released the lock it owned')
})

test('state lock: breaking a lock at the wait budget is recorded in calls.jsonl', async (t) => {
  const { root } = sandboxRoot(t)
  const lockPath = lockPathFor(root, 'launchd.json')
  const base = { ...process.env, HYP_SANDBOX_ROOT: root }

  const holder = spawn(process.execPath, [SHIM, 'launchctl', 'setenv', 'FROM_A', '1'], {
    env: { ...base, HYP_SANDBOX_TEST_HOLD_MS: '1500' },
    stdio: 'ignore',
  })
  const holderExit = new Promise((resolve) => holder.on('exit', resolve))
  assert.ok(await waitForLockToken(lockPath, null), 'A took the lock')

  const broke = shim(root, 'launchctl', ['setenv', 'FROM_B', '1'], { HYP_SANDBOX_TEST_LOCK_WAIT_MS: '200' })
  assert.equal(broke.code, 0, 'the waiter gave up on the lock rather than deadlocking')

  // A run that broke a lock and a run that never contended are different
  // worlds for anyone reading back why a state file lost an update, and
  // `calls.jsonl` is the only account the sandbox can give of itself.
  const events = lockEvents(root)
  assert.equal(events.length, 1, 'exactly one lock event')
  assert.equal(events[0].lock.event, 'broke-budget')
  assert.equal(events[0].lock.file, 'launchd.json')
  assert.ok(events[0].lock.waitedMs >= 200, 'it records how long it waited first')
  assert.match(events[0].note, /state lock/)

  await holderExit
})

test('state lock: breaking a stale lock is recorded in calls.jsonl', (t) => {
  const { root } = sandboxRoot(t)
  const lockPath = lockPathFor(root, 'launchd.json')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  // A lock left behind by a shim that was killed mid-update.
  fs.writeFileSync(lockPath, '999999.abandoned\n')
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lockPath, old, old)

  assert.equal(shim(root, 'launchctl', ['setenv', 'FOO', '1']).code, 0)

  const events = lockEvents(root)
  assert.equal(events.length, 1, 'exactly one lock event')
  assert.equal(events[0].lock.event, 'broke-stale')
  // A null age here would mean the record was written without ever reading
  // the lock it claims to have broken.
  assert.notEqual(events[0].lock.ageMs, null, 'it measured the lock before breaking it')
  assert.ok(Number(events[0].lock.ageMs) >= 60_000, 'it records how old the lock it broke was')
})

test('state lock: proceeding unlocked after losing the retake is recorded in calls.jsonl', (t) => {
  const { root } = sandboxRoot(t)
  const lockPath = lockPathFor(root, 'launchd.json')
  // A lock path the shim can neither take nor remove, which is what losing
  // the retake to a third shim looks like from inside `acquireStateLock`: it
  // fails to get the lock back and does the update unlocked. Nothing was
  // evicted on the way there, because the removal failed too, so the only
  // line is the one saying this run went unlocked.
  fs.mkdirSync(lockPath, { recursive: true })

  assert.equal(
    shim(root, 'launchctl', ['setenv', 'FOO', '1'], { HYP_SANDBOX_TEST_LOCK_WAIT_MS: '0' }).code,
    0,
    'a mock that deadlocks is worse than one that races, so it still proceeds'
  )
  assert.equal(shim(root, 'launchctl', ['getenv', 'FOO']).stdout, '1\n', 'the update still landed')

  assert.deepEqual(
    lockEvents(root).map((entry) => entry.lock.event),
    ['degraded-unlocked'],
    'the unlocked update is on the record, and nothing claims a break that did not happen'
  )
})

test('state lock: an eviction is recorded from the removal, not from an age it could not read', (t) => {
  const { root } = sandboxRoot(t)
  const lockPath = lockPathFor(root, 'launchd.json')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  // A lock path the take refuses and the age check cannot measure: `wx` fails
  // EEXIST on the link itself, `statSync` follows it to nothing. It stands in
  // for the race no age read can see - a holder releasing between the failed
  // take and the stat, and a successor taking the lock again before the rm -
  // where the removal evicts something the age said was not there. Deciding
  // from the age alone drops that eviction off the record, and the record is
  // the only account the sandbox can give of a lost update.
  fs.symlinkSync(path.join(root, 'state', 'no-such-lock-target'), lockPath)

  assert.equal(
    shim(root, 'launchctl', ['setenv', 'FOO', '1'], { HYP_SANDBOX_TEST_LOCK_WAIT_MS: '0' }).code,
    0
  )
  assert.equal(shim(root, 'launchctl', ['getenv', 'FOO']).stdout, '1\n', 'the update still landed')

  const events = lockEvents(root)
  assert.deepEqual(events.map((entry) => entry.lock.event), ['broke-budget'], 'the eviction is on the record')
  assert.equal(events[0].lock.ageMs, null, 'and says the age of what it removed could not be read')
})

// Root reads through mode 000 (CAP_DAC_OVERRIDE), so the EACCES this case is
// built on does not happen there and the shim would legitimately succeed.
test('state lock: an unreadable state file is not committed as an empty domain', {
  skip: process.getuid?.() === 0 && 'chmod does not deny root the read this case needs',
}, (t) => {
  const { root, plist, target } = sandboxRoot(t)
  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist]).code, 0)
  const file = path.join(root, 'state', 'launchd.json')
  // EACCES stands in for any read that fails for a reason other than the file
  // not being there (EMFILE under a fanned-out install is the likely one).
  // Treating it as an empty domain does not just misreport this call: the
  // update commits the empty state under the lock and the mock domain is gone.
  fs.chmodSync(file, 0o000)
  t.after(() => { try { fs.chmodSync(file, 0o600) } catch { /* already restored */ } })

  const setenv = shim(root, 'launchctl', ['setenv', 'NODE_USE_SYSTEM_CA', '1'])
  // `code` is `spawnSync`'s `status`, which is `null` for a child that died on
  // a signal, and `notEqual(code, 0)` counts that `null` as the error it went
  // looking for. This read leaves through `main`'s catch, which is exit 70 and
  // nothing else for a `launchctl` the shim recognises, so that is what the
  // assertion names.
  assert.equal(setenv.code, 70, 'a state file it cannot read is an error, not an empty domain')
  // The exit code alone cannot tell a read that failed from a shim that broke
  // on the way to reporting one. Naming the errno is the whole of what this
  // error is for, and asserting only `code !== 0` let a ReferenceError raised
  // inside the shim stand in for the EACCES it was supposed to describe.
  assert.match(
    setenv.stderr,
    /EACCES/,
    'and says which errno stopped the read, not which binding stopped the shim'
  )

  fs.chmodSync(file, 0o600)
  assert.equal(shim(root, 'launchctl', ['print', target]).code, 0, 'the bootstrapped service survived')
})

// A read that fails a bounded number of times and then does not is something
// no filesystem offers on demand, so the failure is injected from outside the
// shim: a preloaded module patches `fs.readFileSync` for one path and counts
// the calls. The shim itself is untouched and knows nothing about the
// injection, which is the point.
//
// The retry had never run once before this case existed. Its two constants
// were declared below the module's top-level dispatch, so every non-ENOENT
// read evaluated them inside their temporal dead zone and threw a
// ReferenceError naming a binding rather than retrying or naming the errno.
// Counting the attempts is what keeps that from coming back: an assertion on
// the exit code cannot tell a retried read from one that never happened.
//
// A count on its own still leaves unpinned the two halves the retry is shaped
// around, and the hoist is what put both of them into service for the first
// time. A retry that does not wait between tries spends its whole budget
// inside the microsecond that raised EMFILE, before anything has had a chance
// to close a descriptor, so the attempts are timed as well as counted. A
// retry that does not consult `TRANSIENT_READ_CODES` sits three poll
// intervals on an EACCES that waiting cannot clear, so a permanent errno is
// injected too and asserted to be reported on the first read.
test('state read: a transient errno is retried on a poll interval, a permanent one is not', (t) => {
  const { root, plist } = sandboxRoot(t)
  assert.equal(shim(root, 'launchctl', ['bootstrap', 'gui/501', plist]).code, 0)
  const target = path.join(root, 'state', 'launchd.json')
  const injector = path.join(root, 'inject-read-failure.mjs')
  fs.writeFileSync(injector, [
    "import fs from 'node:fs'",
    "import process from 'node:process'",
    '',
    'const target = process.env.INJECT_TARGET',
    'const counter = process.env.INJECT_COUNTER',
    'const fails = Number(process.env.INJECT_FAILS)',
    'const errno = process.env.INJECT_ERRNO',
    'const readFileSync = fs.readFileSync',
    'const appendFileSync = fs.appendFileSync',
    'let seen = 0',
    '',
    'fs.readFileSync = (file, ...rest) => {',
    '  if (String(file) !== target) return readFileSync(file, ...rest)',
    '  seen += 1',
    '  appendFileSync(counter, `${process.hrtime.bigint()}\\n`)',
    '  if (seen > fails) return readFileSync(file, ...rest)',
    '  const err = new Error(`${errno}: injected read failure, open \'${target}\'`)',
    '  err.code = errno',
    '  throw err',
    '}',
    '',
  ].join('\n'))

  /**
   * Run one `setenv` whose first `fails` reads of the state file raise `errno`.
   *
   * Every injected read stamps the counter with `process.hrtime.bigint()`, so
   * the gap between the first attempt and the last says whether the shim
   * waited between tries or spun straight through its budget. All four stamps
   * come from the one child process, so a monotonic clock is comparable
   * across them, and unlike `Date.now()` it cannot step backwards inside the
   * measured window and report a wait that happened as a wait that did not.
   *
   * @param {number} fails
   * @param {string} [errno]
   */
  function setenvThrough(fails, errno = 'EMFILE') {
    const counter = path.join(root, `read-attempts-${errno}-${fails}.log`)
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(injector).href, SHIM, 'launchctl', 'setenv', 'FOO', '1'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HYP_SANDBOX_ROOT: root,
          INJECT_TARGET: target,
          INJECT_COUNTER: counter,
          INJECT_FAILS: String(fails),
          INJECT_ERRNO: errno,
        },
      }
    )
    const log = fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : ''
    const stamps = log.split('\n').filter(Boolean).map(BigInt)
    const spanNs = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0n
    const spanMs = Number(spanNs) / 1e6
    return { code: result.status, stderr: result.stderr, attempts: stamps.length, spanMs }
  }

  const recovered = setenvThrough(2)
  assert.equal(recovered.code, 0, 'two EMFILEs in a row are waited out rather than reported')
  assert.equal(recovered.attempts, 3, 'because the read is tried again, and the third try is the one that reads')
  assert.equal(shim(root, 'launchctl', ['getenv', 'FOO']).stdout, '1\n', 'and the update landed on the real state')

  const exhausted = setenvThrough(99)
  // `code` is `spawnSync`'s `status`, which is `null` when the child died on a
  // signal, and `notEqual(code, 0)` is satisfied by that `null`. A read the
  // shim gave up on leaves through `main`'s catch, which is exit 70 and
  // nothing else, so that is what the assertion names.
  assert.equal(exhausted.code, 70, 'an errno that never clears is reported as an error, not survived')
  assert.equal(exhausted.attempts, 4, 'tried once and retried three times, then given up on')
  assert.match(exhausted.stderr, /EMFILE/, 'and the error names the errno it gave up on')
  // Three waits of `STOP_POLL_MS` is 75ms. The floor sits well under that
  // because what is being asserted is that there was a wait at all, and the
  // two outcomes are nowhere near it: with the sleep, ten idle runs spanned
  // 75.6 to 76.7ms; with the sleep deleted, the span is under a millisecond,
  // because `Atomics.wait` cannot return early and four reads with nothing
  // between them land inside one.
  //
  // There is deliberately no ceiling to go with this floor. A ceiling is the
  // assertion that would catch an inflated `STOP_POLL_MS` or a wait added to
  // the retry, and measurement says it cannot do that and stay honest. Under
  // a 48-core box oversubscribed 20-fold (load average 484 to 863) this same
  // span was observed at 167ms, which is past what a doubled `STOP_POLL_MS`
  // would produce. Any ceiling loose enough to survive that contention no
  // longer separates a healthy run from the change it was added for, and one
  // tight enough to separate them fails runs that waited exactly right. The
  // floor survives the same load untouched, because scheduler delay only ever
  // pushes the span the safe way.
  assert.ok(
    exhausted.spanMs >= 50,
    `four attempts spanned ${exhausted.spanMs.toFixed(1)}ms, too little for a poll interval between tries`
  )

  const refused = setenvThrough(99, 'EACCES')
  assert.equal(refused.code, 70, 'an errno that waiting cannot clear is that same reported error')
  assert.equal(refused.attempts, 1, 'but it is reported on the first read, not sat on for three poll intervals')
  assert.match(refused.stderr, /EACCES/, 'and it is that errno the error names')

  // The arms above pin one member of `TRANSIENT_READ_CODES` and one errno
  // outside it, which leaves the other four members free to be dropped: the
  // set narrows, the retry stops covering the case it was written for, and
  // nothing says so. Each of them gets one read that fails and one that does
  // not.
  for (const code of ['ENFILE', 'EAGAIN', 'EBUSY', 'EINTR']) {
    const waited = setenvThrough(1, code)
    assert.equal(waited.code, 0, `a single ${code} is waited out rather than reported`)
    assert.equal(waited.attempts, 2, `because ${code} is transient too, and the second try is the one that reads`)
  }
})

test('supervisor: a definition file it cannot read leaves a note rather than dying silently', (t) => {
  const { root, label } = sandboxRoot(t)
  const { root: systemdRootDir, unit } = systemdRoot(t)
  // Both supervisors run detached with stdio ignored, so a throw at the read
  // that opens them is a KeepAlive supervisor gone without a word while the
  // `bootstrap` or `start` that spawned it recorded a pid and exit 0. It is
  // reachable without the file ever being corrupt: `kickstart` respawns from
  // the path the domain remembers, and re-reads nothing before it does.
  const missing = path.join(root, 'gone.plist')
  const supervised = shim(root, '__supervise', [label, missing])
  assert.equal(supervised.code, 0, 'the launchd supervisor exits rather than throwing')

  const missingUnit = path.join(systemdRootDir, 'gone.service')
  const supervisedUnit = shim(systemdRootDir, '__supervise_systemd', [unit, missingUnit])
  assert.equal(supervisedUnit.code, 0, 'the systemd supervisor exits rather than throwing')

  // `hyp-sandbox calls` renders each line as `<tool> <args>`, so the lane a
  // supervisor note came from is only legible if the note carries the tool
  // that lane mocks. A systemd note filed under `launchctl` reads as a call
  // to a binary this run never invoked, on a host that may not have one.
  for (const [where, name, expected] of [
    [root, missing, 'launchctl'],
    [systemdRootDir, missingUnit, 'systemctl'],
  ]) {
    const notes = supervisorNotes(where)
    assert.equal(notes.length, 1, `one supervisor note for ${name}`)
    assert.match(notes[0].note, /could not read/, 'the note says the read is what failed')
    assert.match(notes[0].note, /ENOENT/, 'and names the errno, which is the whole of what it can say')
    assert.equal(notes[0].tool, expected, `the note for ${name} is filed under the lane's own tool`)
  }
})

test('state lock: a no-op update does not materialise a state file', (t) => {
  const { root, home, unit } = systemdRoot(t)
  fs.rmSync(path.join(home, '.config', 'systemd', 'user', unit))

  const started = shim(root, 'systemctl', ['--user', 'start', unit], { HOME: home, HYP_SANDBOX_SPAWN: '1' })
  assert.equal(started.code, 5, 'systemd fails a start of a unit that is not installed')

  // `hyp-sandbox state` prints `(empty)` for a file that is not there and the
  // file's contents when it is, so an error path that writes one reports a
  // domain the mock never actually created.
  assert.equal(
    fs.existsSync(path.join(root, 'state', 'systemd.json')),
    false,
    'the failed start left no state file behind'
  )
})

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  clearControlRequests,
  controlDirPath,
  controlRequestPath,
  watchControlRequests,
  writeControlRequest,
} from '../../src/core/daemon/control.js'
import { requestDaemonStop, runDaemon } from '../../src/core/daemon/runtime.js'
import { pidFilePath, writePidFile, readPidFile } from '../../src/core/daemon/pid.js'
import { resolveHypHome } from '../../src/core/cli/walkthrough.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/**
 * Poll until `predicate` returns true, or fail after `timeoutMs`. The
 * watcher's dispatch rides fs.watch, so tests must wait for the event
 * rather than assert synchronously.
 *
 * @param {() => boolean} predicate
 * @param {string} label
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${label}`)
}

test('watchControlRequests dispatches a stop request and consumes the file', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-stop-'))
  let stops = 0
  const watcher = watchControlRequests(stateRoot, {
    onStop: () => { stops += 1 },
    onReload: () => assert.fail('reload dispatched for a stop request'),
    // Fast poll: the suite must not depend on fs.watch delivery, which can
    // drop events under load, and the POSIX backstop default is slow.
    pollIntervalMs: 50,
  })
  try {
    writeControlRequest(stateRoot, 'stop')
    await waitFor(() => stops === 1, 'stop dispatch')
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'stop')), false)
  } finally {
    watcher.close()
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('watchControlRequests dispatches a reload request and consumes the file', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-reload-'))
  let reloads = 0
  const watcher = watchControlRequests(stateRoot, {
    onStop: () => assert.fail('stop dispatched for a reload request'),
    onReload: () => { reloads += 1 },
    pollIntervalMs: 50,
  })
  try {
    writeControlRequest(stateRoot, 'reload')
    await waitFor(() => reloads === 1, 'reload dispatch')
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'reload')), false)
  } finally {
    watcher.close()
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0300#stop-wins [tests]: both requests present consumes both files and dispatches stop only
test('when stop and reload are both pending, stop wins and both are consumed', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-both-'))
  // Written before the watcher exists, so its install-time scan sees both at
  // once (also proving a request written before the watch is not lost).
  writeControlRequest(stateRoot, 'stop')
  writeControlRequest(stateRoot, 'reload')
  let stops = 0
  const watcher = watchControlRequests(stateRoot, {
    onStop: () => { stops += 1 },
    onReload: () => assert.fail('reload dispatched although stop was pending'),
    pollIntervalMs: 50,
  })
  try {
    // The install-time scan is deferred: the daemon stores the returned
    // handle to close the channel during shutdown, so a dispatch before the
    // return would run shutdown against a watcher it cannot see.
    assert.equal(stops, 0, 'no dispatch before the handle is returned')
    await waitFor(() => stops === 1, 'stop dispatch')
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'stop')), false)
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'reload')), false)
  } finally {
    watcher.close()
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// One request file failing to unlink must never swallow the other's
// dispatch: reload.request exists as a directory here, so consuming it
// throws (EPERM/EISDIR, standing in for the win32 EPERM/EBUSY the module
// documents), and the stop must still dispatch.
test('a stop request still dispatches when consuming the reload file fails', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-consume-fail-'))
  let stops = 0
  /** @type {string[]} */
  const warnings = []
  fsSync.mkdirSync(controlRequestPath(stateRoot, 'reload'), { recursive: true })
  const watcher = watchControlRequests(stateRoot, {
    onStop: () => { stops += 1 },
    onReload: () => assert.fail('reload dispatched for an unconsumable file'),
    log: { warn: (event) => { warnings.push(event) } },
    pollIntervalMs: 50,
  })
  try {
    writeControlRequest(stateRoot, 'stop')
    await waitFor(() => stops === 1, 'stop dispatch despite reload consume failure')
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'stop')), false)
    assert.ok(warnings.includes('daemon.control_scan_failed'))
  } finally {
    watcher.close()
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// The mirror case: while the stop file is unconsumable, the reload must not
// be unlinked either (nothing is deleted that will not be dispatched), and
// once the stop clears, the pending reload dispatches.
test('a pending reload survives while the stop file is unconsumable', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-stop-stuck-'))
  let reloads = 0
  fsSync.mkdirSync(controlRequestPath(stateRoot, 'stop'), { recursive: true })
  const watcher = watchControlRequests(stateRoot, {
    onStop: () => assert.fail('stop dispatched for an unconsumable file'),
    onReload: () => { reloads += 1 },
    pollIntervalMs: 50,
  })
  try {
    writeControlRequest(stateRoot, 'reload')
    // Several polls' worth of time: the reload must still be on disk,
    // undispatched, because stop-wins means this pass may not act on it.
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(reloads, 0)
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'reload')), true)
    // Unblock the stop: the untouched reload now dispatches.
    fsSync.rmdirSync(controlRequestPath(stateRoot, 'stop'))
    await waitFor(() => reloads === 1, 'reload dispatch after the stop unblocks')
  } finally {
    watcher.close()
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0300#boot-clears-stale [tests]: a leftover the clear could not remove is consumed without dispatch; a fresh request still dispatches
test('a stale request handed over by the boot clear never dispatches, a fresh one does', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-stale-'))
  let stops = 0
  writeControlRequest(stateRoot, 'stop')
  const staleContent = fsSync.readFileSync(controlRequestPath(stateRoot, 'stop'), 'utf8')
  const watcher = watchControlRequests(stateRoot, {
    onStop: () => { stops += 1 },
    onReload: () => assert.fail('reload dispatched with none written'),
    pollIntervalMs: 50,
    staleRequests: { stop: { content: staleContent, message: 'EBUSY (simulated)' } },
  })
  try {
    await waitFor(() => !fsSync.existsSync(controlRequestPath(stateRoot, 'stop')), 'stale request consumed')
    assert.equal(stops, 0, 'a stale leftover must not stop a fresh boot')
    // A fresh request carries new bytes (the payload nonce guarantees it,
    // even inside the same millisecond), so it no longer matches the
    // recorded leftover and dispatches normally.
    writeControlRequest(stateRoot, 'stop')
    await waitFor(() => stops === 1, 'fresh stop dispatch after the stale one')
  } finally {
    watcher.close()
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// The unreadable-recording case: the clear could neither remove nor read the
// leftover (content null). A live request written after boot must still
// dispatch - requestedAt orders it after the boot - while a leftover
// stamped before boot is discarded even though the recording matches
// nothing. And once the marker's file is observed absent, the marker is
// dropped, so it can never eat a later request.
test('a null-content stale marker never eats a live post-boot request', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-stale-null-'))
  let stops = 0
  /** @type {string[]} */
  const warnings = []
  // A leftover stamped a minute before this "boot", unreadable at clear time.
  fsSync.mkdirSync(controlDirPath(stateRoot), { recursive: true })
  fsSync.writeFileSync(
    controlRequestPath(stateRoot, 'stop'),
    JSON.stringify({ requestedAt: new Date(Date.now() - 60_000).toISOString(), pid: 12345 })
  )
  const watcher = watchControlRequests(stateRoot, {
    onStop: () => { stops += 1 },
    onReload: () => assert.fail('reload dispatched with none written'),
    log: { warn: (event) => { warnings.push(event) } },
    pollIntervalMs: 50,
    staleRequests: { stop: { content: null, message: 'EACCES (simulated)' } },
    bootedAtMs: Date.now(),
  })
  try {
    await waitFor(() => !fsSync.existsSync(controlRequestPath(stateRoot, 'stop')), 'pre-boot leftover consumed')
    assert.equal(stops, 0, 'a pre-boot leftover must not dispatch, matching recording or not')
    assert.ok(warnings.includes('daemon.control_stale_discarded'), 'the discard is named in the log')
    // A genuine request stamped after boot dispatches even though the
    // recording was unreadable.
    writeControlRequest(stateRoot, 'stop')
    await waitFor(() => stops === 1, 'post-boot stop dispatch')
  } finally {
    watcher.close()
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// The failure latch resets on absence, so the second stuck request of a
// daemon's life still warns instead of staying mute.
test('a second stuck request warns after the first one vanishes', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-relatch-'))
  /** @type {string[]} */
  const warnings = []
  fsSync.mkdirSync(controlRequestPath(stateRoot, 'reload'), { recursive: true })
  const watcher = watchControlRequests(stateRoot, {
    onStop: () => assert.fail('stop dispatched with none written'),
    onReload: () => assert.fail('reload dispatched for an unconsumable file'),
    log: { warn: (event) => { warnings.push(event) } },
    pollIntervalMs: 25,
  })
  const failedWarns = () => warnings.filter((w) => w === 'daemon.control_scan_failed').length
  try {
    await waitFor(() => failedWarns() === 1, 'first stuck warn')
    fsSync.rmdirSync(controlRequestPath(stateRoot, 'reload'))
    await waitFor(() => warnings.includes('daemon.control_scan_recovered'), 'recovery warn on absence')
    fsSync.mkdirSync(controlRequestPath(stateRoot, 'reload'))
    await waitFor(() => failedWarns() === 2, 'second stuck warn')
  } finally {
    watcher.close()
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

test('clearControlRequests clears per file and reports what it could not remove', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-clear-partial-'))
  try {
    // stop.request is a directory (unremovable by unlink); reload.request a
    // normal file. One file's failure must not skip the sibling.
    fsSync.mkdirSync(controlRequestPath(stateRoot, 'stop'), { recursive: true })
    writeControlRequest(stateRoot, 'reload')
    const uncleared = clearControlRequests(stateRoot)
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'reload')), false)
    assert.ok(uncleared.stop, 'the unremovable stop is reported')
    assert.equal(uncleared.reload, undefined)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0300#boot-clears-stale [tests]: a leftover request must not survive the boot-time clear
test('clearControlRequests removes leftover requests and tolerates none', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-clear-'))
  try {
    clearControlRequests(stateRoot) // nothing there: must not throw
    writeControlRequest(stateRoot, 'stop')
    writeControlRequest(stateRoot, 'reload')
    clearControlRequests(stateRoot)
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'stop')), false)
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'reload')), false)
    assert.equal(fsSync.existsSync(controlDirPath(stateRoot)), true)
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0300#posix-keeps-signals [tests]: the win32 lane writes the request file and never signals
test('requestDaemonStop on win32 writes stop.request instead of signaling', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-win32-'))
  // Point the PID file at a throwaway child, not the test runner: a
  // regression into the SIGTERM branch then kills the child (the wait sees
  // it die and reports 'stopped', failing the assertion below) instead of
  // taking the whole suite down with it.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    assert.ok(child.pid, 'child process spawned')
    writePidFile(stateRoot, {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      runId: 'control-test',
      mode: 'foreground',
    })
    const outcome = await requestDaemonStop({
      stateRoot,
      platform: 'win32',
      timeoutMs: 200,
      pollIntervalMs: 20,
    })
    // No daemon is watching, so the wait must report the truth: timed out,
    // with the request file left for a live daemon (or the next boot's
    // stale-clear) to consume.
    assert.equal(outcome, 'timed_out')
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'stop')), true)
  } finally {
    child.kill('SIGKILL')
    await fs.rm(stateRoot, { recursive: true, force: true })
  }
})

// The timeout turns a watcher that never dispatches into a failure instead
// of a hung run: `handle.done` only resolves when the control file is seen.
test('a running daemon stops end-to-end on a stop.request control file', { timeout: 30_000 }, async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-control-e2e-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  /** @type {Awaited<ReturnType<typeof runDaemon>> | undefined} */
  let handle
  try {
    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [] }))

    handle = await runDaemon({
      hypHome,
      configPath,
      env: { ...process.env, HYP_HOME: hypHome },
      runId: 'control-e2e-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })
    assert.equal(readPidFile(stateRoot)?.pid, process.pid)

    writeControlRequest(stateRoot, 'stop')
    const exitCode = await handle.done
    handle = undefined
    assert.equal(exitCode, 0)
    assert.equal(fsSync.existsSync(pidFilePath(stateRoot)), false)
    assert.equal(fsSync.existsSync(controlRequestPath(stateRoot, 'stop')), false)
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// @ref LLP 0300#home-resolution [tests]: env.HOME wins, os.homedir() is the fallback, '' is never a home
test('resolveHypHome prefers HYP_HOME, then HOME, then os.homedir()', () => {
  const home = path.join(os.tmpdir(), 'control-test-home')
  assert.equal(resolveHypHome({ HYP_HOME: '/explicit/hyp', HOME: home }), '/explicit/hyp')
  assert.equal(resolveHypHome({ HOME: home }), path.join(home, '.hyp'))
  // '' is never a home: an empty HOME must fall through to os.homedir(),
  // not produce a cwd-relative '.hyp'.
  assert.equal(resolveHypHome({ HOME: '' }), path.join(os.homedir(), '.hyp'))
  const fallback = resolveHypHome({})
  assert.equal(fallback, path.join(os.homedir(), '.hyp'))
  assert.equal(path.isAbsolute(fallback), true)
})

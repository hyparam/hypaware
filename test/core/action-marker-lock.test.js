// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createActionReconciler,
  clearClientActionMarker,
  withClientActionLock,
} from '../../src/core/config/action_reconciler.js'
import { withFileLock } from '../../src/core/util/file_lock.js'

/**
 * @import { ChildProcessWithoutNullStreams } from 'node:child_process'
 * @import { ActionHandler } from '../../src/core/config/types.d.ts'
 */

// The client-action marker store has writers in more than one process: the
// daemon's reconciler and the `hyp attach` / `hyp detach` / `hyp leave` CLI.
// Every test here runs the competing writers as separate node processes
// against the real store on disk, held at a barrier, so the interleaving under
// test is the one the lock has to survive, not one a single event loop
// happens to serialize (#224).

const RECONCILER_URL = new URL('../../src/core/config/action_reconciler.js', import.meta.url).href
const FILE_LOCK_URL = new URL('../../src/core/util/file_lock.js', import.meta.url).href
const CLIENTS_URL = new URL('../../src/core/commands/clients.js', import.meta.url).href
const DETACH_DISK_URL = new URL('../../src/core/config/client_detach_disk.js', import.meta.url).href

const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} }

const INPUT = {
  config: /** @type {any} */ ({ version: 2, plugins: [] }),
  backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
  env: process.env,
}

/**
 * What every worker runs first: the reconciler module, its JSON arguments, and
 * a line barrier on stdin (`waitFor`) and stdout (`say`).
 */
const PRELUDE = `
import readline from 'node:readline'
import * as R from ${JSON.stringify(RECONCILER_URL)}
const args = JSON.parse(process.argv[1])
const inbox = []
let wake = () => {}
readline.createInterface({ input: process.stdin }).on('line', (line) => { inbox.push(line); wake() })
async function waitFor(word) {
  for (;;) {
    const i = inbox.indexOf(word)
    if (i >= 0) { inbox.splice(i, 1); return }
    await new Promise((resolve) => { wake = resolve })
  }
}
function say(word) { process.stdout.write(word + '\\n') }
function finish(word) { process.stdout.write(word + '\\n', () => process.exit(0)) }
const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} }
const INPUT = { config: { version: 2, plugins: [] }, backfills: { register() {}, get() {}, list() { return [] } }, env: process.env }
`

/**
 * @param {string} body
 * @param {Record<string, unknown>} args
 */
function worker(body, args) {
  /** @type {ChildProcessWithoutNullStreams} */
  const child = spawn(process.execPath, ['--input-type=module', '-e', PRELUDE + body, JSON.stringify(args)])
  /** @type {string[]} */
  const lines = []
  let stderr = ''
  let partial = ''
  /** @type {Array<() => void>} */
  let waiters = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    partial += chunk
    const parts = partial.split('\n')
    partial = parts.pop() ?? ''
    lines.push(...parts)
    for (const w of waiters) w()
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  /** @type {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} */
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return {
    child,
    lines,
    stderr: () => stderr,
    /** @param {string} word */
    send(word) { child.stdin.write(word + '\n') },
    /**
     * Resolve once the worker has said `word`; reject if it exits first.
     * @param {string} word
     */
    async heard(word) {
      while (!lines.includes(word)) {
        const done = await Promise.race([
          new Promise((resolve) => { waiters.push(() => resolve(false)) }),
          exited.then(() => true),
        ])
        waiters = []
        if (done && !lines.includes(word)) {
          throw new Error(`worker exited before saying "${word}": ${stderr}`)
        }
      }
    },
    /** Resolve on a clean exit, reject with the worker's stderr otherwise. */
    async ok() {
      const { code, signal } = await exited
      assert.equal(code, 0, `worker exited ${code ?? signal}: ${stderr}`)
    },
    exited,
  }
}

async function makeFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-action-marker-lock-'))
  return { tmp, stateRoot: path.join(tmp, 'hypaware') }
}

/** @param {string} stateRoot */
function storePath(stateRoot) {
  return path.join(stateRoot, 'config-control', 'client-actions.json')
}

/**
 * @param {string} stateRoot
 * @param {Record<string, Record<string, Record<string, unknown>>>} store
 */
function seedStore(stateRoot, store) {
  fs.mkdirSync(path.dirname(storePath(stateRoot)), { recursive: true })
  fs.writeFileSync(storePath(stateRoot), JSON.stringify(store, null, 2))
}

/** @param {string} stateRoot */
function readStore(stateRoot) {
  return JSON.parse(fs.readFileSync(storePath(stateRoot), 'utf8'))
}

/**
 * @param {string} stateRoot
 * @param {string} kind
 * @param {string} requestKey
 */
function keyLockPath(stateRoot, kind, requestKey) {
  return path.join(stateRoot, 'config-control', 'client-action-locks', `${kind}-${requestKey}.lock`)
}

/** A reconcile pass whose run-once backfill blocks at a barrier mid-perform. */
const BLOCKING_BACKFILL_PASS = `
const handler = {
  kind: 'backfill',
  desired: () => [{ requestKey: 'b1' }],
  async perform() { say('performing'); await waitFor('go'); return { status: 'done', rows: 3 } },
}
const reconciler = R.createActionReconciler({ stateRoot: args.stateRoot, handlers: [handler], log: NOOP_LOG })
await reconciler.reconcile(INPUT)
finish('reconciled')
`

// The #224 shape: a pass reads the store, runs a long backfill, and used to
// write back its whole snapshot, resurrecting the attach marker a `hyp
// detach` had cleared in the meantime (the #217 stuck state).
// @ref LLP 0523#merge-not-snapshot [tests]: a pass that read the store before a detach does not write the cleared marker back
test('a pass that read the store before a detach does not resurrect the cleared attach marker', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    seedStore(stateRoot, { attach: { claude: { status: 'done', request_key: 'claude', at: '2026-10-17T00:00:00.000Z' } } })
    const pass = worker(BLOCKING_BACKFILL_PASS, { stateRoot })
    await pass.heard('performing')

    const detach = worker(`
await R.withClientActionLock({ stateRoot: args.stateRoot, kind: 'attach', requestKey: 'claude' }, () =>
  R.clearClientActionMarker({ stateRoot: args.stateRoot, kind: 'attach', requestKey: 'claude' }))
finish('cleared')
`, { stateRoot })
    await detach.ok()
    assert.equal(readStore(stateRoot).attach, undefined, 'the detach cleared the marker while the pass was mid-backfill')

    pass.send('go')
    await pass.ok()
    const store = readStore(stateRoot)
    assert.equal(store.attach, undefined, 'the pass must not write the cleared attach marker back')
    assert.equal(store.backfill.b1.status, 'done', 'the pass still committed its own key')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// @ref LLP 0523#merge-not-snapshot [tests]: a re-arm that lands mid-pass survives the pass's commit to another namespace
test('a re-arm that lands mid-pass survives the pass committing an unrelated namespace', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    seedStore(stateRoot, {
      attach: { claude: { status: 'refused', request_key: 'claude', reason: 'conflict', at: '2026-10-17T00:00:00.000Z', rearm_generation: 1 } },
    })
    const pass = worker(BLOCKING_BACKFILL_PASS, { stateRoot })
    await pass.heard('performing')

    const rearm = worker(`
const rearmed = await R.withClientActionLock({ stateRoot: args.stateRoot, kind: 'attach', requestKey: 'claude' }, () =>
  R.rearmRefusedActionMarker({ stateRoot: args.stateRoot, kind: 'attach', requestKey: 'claude' }))
finish(String(rearmed))
`, { stateRoot })
    await rearm.ok()
    assert.ok(rearm.lines.includes('true'), 'the re-arm dropped the refused marker')

    pass.send('go')
    await pass.ok()
    const store = readStore(stateRoot)
    assert.equal(store.attach, undefined, 'the refused marker stays re-armed after the pass commits')
    assert.equal(store.backfill.b1.status, 'done')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// An attach the reconciler is still performing and a `hyp detach` of the same
// client must not interleave: the detach waits (and says so) until the attach
// has committed its marker, then reverses and clears it, so the marker never
// disagrees with the settings on disk.
// @ref LLP 0523#two-locks [tests]: the key lock serializes an attach in flight against a detach of the same client
test('a detach waits for an in-flight attach of the same client, then clears its committed marker', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    const attach = worker(`
const handler = {
  kind: 'attach',
  desired: () => [{ requestKey: 'claude' }],
  async perform() { say('performing'); await waitFor('go'); return { status: 'done', detail: { installed_assets: ['/x/skill'] } } },
  async reverse() { return { status: 'done' } },
}
const reconciler = R.createActionReconciler({ stateRoot: args.stateRoot, handlers: [handler], log: NOOP_LOG })
await reconciler.reconcile(INPUT)
finish('attached')
`, { stateRoot })
    await attach.heard('performing')

    const detach = worker(`
await R.withClientActionLock(
  { stateRoot: args.stateRoot, kind: 'attach', requestKey: 'claude', onWait: () => say('waiting') },
  async () => {
    const marker = R.readClientActionStatus({ stateRoot: args.stateRoot }).byKind.attach?.claude
    say('saw:' + (marker?.status ?? 'none'))
    await R.clearClientActionMarker({ stateRoot: args.stateRoot, kind: 'attach', requestKey: 'claude' })
  })
finish('cleared')
`, { stateRoot })
    await detach.heard('waiting')
    assert.equal(detach.lines.includes('cleared'), false, 'the detach is held while the attach is mid-perform')

    attach.send('go')
    await attach.ok()
    await detach.ok()
    assert.ok(detach.lines.includes('saw:done'), 'the detach acted on the marker the attach committed')
    assert.equal(fs.existsSync(storePath(stateRoot)) ? readStore(stateRoot).attach : undefined, undefined)
    assert.deepEqual(fs.readdirSync(path.dirname(keyLockPath(stateRoot, 'attach', 'claude'))), [], 'both holders released')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// `hyp attach` on a client that already looks attached takes a fast exit that
// re-arms and reports success. That look is taken before the key lock, so a
// reverse holding the lock can undo the settings while the attach waits; the
// exit must re-check under the lock rather than report an attach that is no
// longer on disk (review of #224).
// @ref LLP 0523#two-locks [tests]: the already-current attach exit decides under the key lock
test('an already-attached hyp attach that waited out a reverse does not report the undone attach', async () => {
  const { tmp } = await makeFixture()
  const home = path.join(tmp, 'home')
  const stateRoot = path.join(home, '.hyp', 'hypaware')
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ _hypaware: { version: '2.0.0', port: 60680 } }))
    seedStore(stateRoot, { attach: { claude: { status: 'done', request_key: 'claude', at: '2026-10-17T00:00:00.000Z' } } })

    const reverse = worker(`
const { detachClientFromDisk } = await import(${JSON.stringify(DETACH_DISK_URL)})
await R.withClientActionLock({ stateRoot: args.stateRoot, kind: 'attach', requestKey: 'claude' }, async () => {
  say('held')
  await waitFor('go')
  await detachClientFromDisk({
    descriptor: { plugin: '@hypaware/claude', name: 'claude', attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' } },
    homeDir: args.home,
    env: { HOME: args.home },
  })
  await R.clearClientActionMarker({ stateRoot: args.stateRoot, kind: 'attach', requestKey: 'claude' })
})
finish('reversed')
`, { stateRoot, home })
    await reverse.heard('held')

    const attach = worker(`
const { runAttach } = await import(${JSON.stringify(CLIENTS_URL)})
let out = ''
let calls = 0
const gateway = {
  localEndpoint() { throw new Error('unbound') },
  getClient(name) { return { name, async attach() { calls++ } } },
  listClients() { return [{ name: 'claude' }] },
}
const code = await runAttach(['claude', '--json'], {
  cwd: args.home,
  env: { HOME: args.home, HYP_HOME: args.hypHome },
  config: { version: 2 },
  capabilities: { has: () => true, require: () => gateway },
  stdout: { write(s) { out += s; return true } },
  stderr: { write(s) { if (String(s).includes('waiting for another')) say('waiting'); return true } },
})
say('result:' + JSON.stringify({ code, out, calls }))
finish('done')
`, { home, hypHome: path.join(home, '.hyp') })
    await attach.heard('waiting')

    reverse.send('go')
    await reverse.ok()
    await attach.ok()
    const line = attach.lines.find((l) => l.startsWith('result:'))
    assert.ok(line, attach.stderr())
    const { code, out } = JSON.parse(line.slice('result:'.length))
    const reported = JSON.parse(out.trim().split('\n').pop() ?? '{}')
    assert.notEqual(reported.attached, true, 'attach must not report the settings the reverse removed')
    assert.equal(code, 1, 'with no endpoint to attach at, the re-run fails instead of claiming success')
    assert.equal(reported.error_kind, 'no_endpoint')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')), {})
    assert.equal(readStore(stateRoot).attach, undefined)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// Two processes removing different markers at once (say a `hyp detach claude`
// and a `hyp leave` dropping codex) each rewrite the whole file, so without the
// store lock one removal is lost to the other's stale copy.
// @ref LLP 0523#two-locks [tests]: concurrent removals of different keys both stick
test('concurrent removals from two processes both stick', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    const N = 25
    /** @type {Record<string, Record<string, unknown>>} */
    const attach = {}
    for (let i = 0; i < N; i++) {
      for (const side of ['a', 'b']) {
        attach[`${side}${i}`] = { status: 'refused', request_key: `${side}${i}`, reason: 'conflict', at: '2026-10-17T00:00:00.000Z' }
      }
    }
    seedStore(stateRoot, { attach: { ...attach, keep: { status: 'done', request_key: 'keep' } } })

    const REMOVER = `
await waitFor('go')
for (let i = 0; i < args.n; i++) {
  const requestKey = args.side + i
  if (i % 2 === 0) await R.clearClientActionMarker({ stateRoot: args.stateRoot, kind: 'attach', requestKey })
  else await R.rearmRefusedActionMarker({ stateRoot: args.stateRoot, kind: 'attach', requestKey })
}
finish('removed')
`
    const a = worker(REMOVER, { stateRoot, side: 'a', n: N })
    const b = worker(REMOVER, { stateRoot, side: 'b', n: N })
    a.send('go')
    b.send('go')
    await Promise.all([a.ok(), b.ok()])
    assert.deepEqual(Object.keys(readStore(stateRoot).attach), ['keep'], 'every removal stuck and the untouched key survived')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// A holder killed mid-section (a daemon SIGKILLed during an attach, a CLI
// interrupted mid-detach) leaves its lock file behind. The next caller waits a
// bounded time, breaks it by age, and proceeds; nothing is wedged.
// @ref LLP 0523#bounded-wait [tests]: a dead holder's key lock costs a bounded wait, then breaks
test('a key lock left by a SIGKILLed holder breaks after the stale age instead of wedging the next caller', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    const holder = worker(`
await R.withClientActionLock({ stateRoot: args.stateRoot, kind: 'attach', requestKey: 'claude' }, async () => {
  say('held')
  await new Promise(() => {})
})
`, { stateRoot })
    await holder.heard('held')
    holder.child.kill('SIGKILL')
    await holder.exited
    const lockPath = keyLockPath(stateRoot, 'attach', 'claude')
    assert.ok(fs.existsSync(lockPath), 'the killed holder left its lock behind')

    let waited = 0
    const started = Date.now()
    const value = await withClientActionLock(
      { stateRoot, kind: 'attach', requestKey: 'claude', staleMs: 300, onWait: () => { waited += 1 } },
      async () => 'acquired'
    )
    assert.equal(value, 'acquired')
    assert.equal(waited, 1, 'the caller reported the wait once')
    assert.ok(Date.now() - started < 600, 'the wait stayed inside twice the stale age')
    assert.equal(fs.existsSync(lockPath), false, 'the new holder released')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// The same dead holder, at the production stale age: the next daemon pass and
// the next CLI detach both proceed once the orphan is a minute old. The mtime is
// backdated to stand for the minute passing.
// @ref LLP 0523#bounded-wait [tests]: the next daemon pass and the next detach both get past a dead holder's lock
test('the next daemon pass and the next detach get past a dead holder at the default stale age', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    seedStore(stateRoot, { attach: { claude: { status: 'done', request_key: 'claude' } } })
    for (const lock of [keyLockPath(stateRoot, 'attach', 'claude'), keyLockPath(stateRoot, 'attach', 'codex'), `${storePath(stateRoot)}.lock`]) {
      const holder = worker(`
const { withFileLock } = await import(args.fileLockUrl)
await withFileLock(args.lock, async () => {
  say('held')
  await new Promise(() => {})
})
`, { stateRoot, lock, fileLockUrl: FILE_LOCK_URL })
      await holder.heard('held')
      holder.child.kill('SIGKILL')
      await holder.exited
      const old = new Date(Date.now() - 61_000)
      fs.utimesSync(lock, old, old)
    }

    // The daemon pass: attach codex (desired, behind its dead key lock) and
    // reverse claude (not desired, behind its own), both through the dead
    // store lock.
    /** @type {string[]} */
    const waits = []
    /** @type {ActionHandler} */
    const handler = {
      kind: 'attach',
      desired: () => [{ requestKey: 'codex' }],
      async perform() { return { status: 'done' } },
      async reverse() { return { status: 'done' } },
    }
    const log = { ...NOOP_LOG, info(/** @type {string} */ event) { if (event === 'client_action.lock_wait') waits.push(event) } }
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log })
    const report = await reconciler.reconcile(INPUT)
    assert.deepEqual(
      report.results.map((r) => [r.requestKey, r.outcome]).sort(),
      [['claude', 'reversed'], ['codex', 'done']]
    )
    assert.equal(waits.length, 2, 'each dead key lock was reported as a wait')
    assert.deepEqual(Object.keys(readStore(stateRoot).attach), ['codex'])

    // The next detach: clears through a fresh dead store lock.
    const lock = `${storePath(stateRoot)}.lock`
    fs.writeFileSync(lock, 'dead-nonce')
    const old = new Date(Date.now() - 61_000)
    fs.utimesSync(lock, old, old)
    assert.equal(await clearClientActionMarker({ stateRoot, kind: 'attach', requestKey: 'codex' }), true)
    assert.equal(readStore(stateRoot).attach, undefined)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// @ref LLP 0523#two-locks [tests]: an effect that throws releases the key lock
test('a perform that throws releases the key lock and records a failed marker', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    /** @type {ActionHandler} */
    const handler = {
      kind: 'attach',
      desired: () => [{ requestKey: 'claude' }],
      async perform() { throw new Error('boom') },
      async reverse() { return { status: 'done' } },
    }
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })
    const report = await reconciler.reconcile(INPUT)
    assert.equal(report.results[0].outcome, 'failed')
    assert.equal(readStore(stateRoot).attach.claude.status, 'failed')
    assert.equal(fs.existsSync(keyLockPath(stateRoot, 'attach', 'claude')), false)
    assert.equal(fs.existsSync(`${storePath(stateRoot)}.lock`), false)

    await assert.rejects(
      withClientActionLock({ stateRoot, kind: 'attach', requestKey: 'claude' }, async () => { throw new Error('mid-section') }),
      /mid-section/
    )
    assert.equal(fs.existsSync(keyLockPath(stateRoot, 'attach', 'claude')), false, 'a throw inside the section releases')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

// The commit builds its undo record from the store as it is when the commit
// runs, not from the pass's opening read: assets another process recorded
// while this pass waited for the key are carried into this pass's marker.
// @ref LLP 0523#merge-not-snapshot [tests]: installed_assets carry forward from the fresh marker, not the snapshot
test('a failed re-perform carries forward installed_assets another process committed after the pass began', async () => {
  const { tmp, stateRoot } = await makeFixture()
  try {
    const other = worker(`
const handler = {
  kind: 'attach',
  desired: () => [{ requestKey: 'claude' }],
  async perform() { say('performing'); await waitFor('go'); return { status: 'done', detail: { installed_assets: ['/skills/a'] } } },
  async reverse() { return { status: 'done' } },
}
const reconciler = R.createActionReconciler({ stateRoot: args.stateRoot, handlers: [handler], log: NOOP_LOG })
await reconciler.reconcile(INPUT)
finish('attached')
`, { stateRoot })
    await other.heard('performing')

    /** @type {ActionHandler} */
    const handler = {
      kind: 'attach',
      desired: () => [{ requestKey: 'claude' }],
      isCurrent: () => false,
      async perform() { return { status: 'failed', reason: 'gateway down' } },
      async reverse() { return { status: 'done' } },
    }
    const reconciler = createActionReconciler({ stateRoot, handlers: [handler], log: NOOP_LOG })
    // This pass reads an empty store, then waits on the key the other holds.
    const pass = reconciler.reconcile(INPUT)
    await new Promise((resolve) => setTimeout(resolve, 100))
    other.send('go')
    await other.ok()
    const report = await pass
    assert.equal(report.results[0].outcome, 'failed')
    const marker = readStore(stateRoot).attach.claude
    assert.equal(marker.status, 'failed')
    assert.deepEqual(marker.installed_assets, ['/skills/a'], 'the undo record committed while this pass waited survives')
    assert.equal(marker.prior_done, true)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('withFileLock reports a held lock once and honors a caller stale age', async () => {
  const { tmp } = await makeFixture()
  try {
    fs.mkdirSync(tmp, { recursive: true })
    const lockPath = path.join(tmp, 'x.lock')
    let waits = 0
    /** @type {() => void} */
    let release = () => {}
    const holding = withFileLock(lockPath, () => new Promise((resolve) => { release = () => resolve(undefined) }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const contender = withFileLock(lockPath, async () => 'second', { onWait: () => { waits += 1 }, staleMs: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    release()
    await holding
    assert.equal(await contender, 'second')
    assert.equal(waits, 1, 'onWait runs once however many retries the wait takes')

    // A caller stale age breaks an orphan that the default minute would not.
    fs.writeFileSync(lockPath, 'dead')
    const old = new Date(Date.now() - 1000)
    fs.utimesSync(lockPath, old, old)
    assert.equal(await withFileLock(lockPath, async () => 'broke', { staleMs: 500 }), 'broke')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

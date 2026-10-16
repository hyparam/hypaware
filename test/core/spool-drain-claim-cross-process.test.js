// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createQueryStorageService } from '../../src/core/cache/storage.js'

/**
 * @import { ChildProcess } from 'node:child_process'
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'msg', type: 'STRING', nullable: false },
]

const storageUrl = pathToFileURL(path.resolve('src/core/cache/storage.js')).href
const partitionUrl = pathToFileURL(path.resolve('src/core/cache/partition.js')).href

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-drain-xproc-'))
}

/**
 * @param {string} script
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function runChild(script, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    proc.stdout.on('data', (chunk) => { out += chunk })
    proc.on('error', reject)
    proc.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`child exited ${code}`)))
  })
}

/**
 * A child process whose append to `active.jsonl` stops just before it writes:
 * it signals `paused` in `signals` and waits for `go`. With `torn`, it first
 * writes half the line, signals `torn` instead, and never finishes, so the
 * parent can kill it mid-append. With `atMarker`, it stops earlier, with its
 * marker created empty and the write that would fill it still to come.
 *
 * @param {string} cacheRoot
 * @param {string} signals
 * @param {{ id: number, torn?: boolean, atMarker?: boolean }} opts
 */
function spawnStalledAppend(cacheRoot, signals, { id, torn = false, atMarker = false }) {
  const script = `
    import fs from 'node:fs/promises'
    import fsSync from 'node:fs'
    import path from 'node:path'
    import { createQueryStorageService } from ${JSON.stringify(storageUrl)}
    const [cacheRoot, signals, id, torn, atMarker] = process.argv.slice(1)
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
    const writeMarker = fs.writeFile
    fs.writeFile = async (file, data, opts) => {
      if (atMarker !== '1' || !String(file).includes('/.append-')) return writeMarker(file, data, opts)
      await writeMarker(file, '', opts)
      fsSync.writeFileSync(path.join(signals, 'paused'), '')
      while (!fsSync.existsSync(path.join(signals, 'go'))) await sleep(5)
      return writeMarker(file, data)
    }
    const open = fs.open
    fs.open = async (file, flags) => {
      const handle = await open(file, flags)
      if (atMarker === '1' || !String(file).endsWith('active.jsonl')) return handle
      const writeFile = handle.writeFile.bind(handle)
      handle.writeFile = async (data, encoding) => {
        if (torn === '1') {
          const bytes = Buffer.from(data, encoding)
          await handle.write(bytes.subarray(0, bytes.length >> 1))
          await handle.sync()
          fsSync.writeFileSync(path.join(signals, 'torn'), '')
          for (;;) await sleep(1000)
        }
        fsSync.writeFileSync(path.join(signals, 'paused'), '')
        while (!fsSync.existsSync(path.join(signals, 'go'))) await sleep(5)
        return writeFile(data, encoding)
      }
      return handle
    }
    const svc = createQueryStorageService({ cacheRoot })
    await svc.appendRows(svc.cacheTablePath('demo', ['all']), ${JSON.stringify(COLS)}, [{ id: Number(id), msg: 'stalled' }])
  `
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script, cacheRoot, signals, String(id), torn ? '1' : '0', atMarker ? '1' : '0'], { stdio: ['ignore', 'ignore', 'inherit'] })
  /** @type {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} */
  const exited = new Promise((resolve, reject) => {
    proc.on('error', reject)
    proc.on('exit', (code, signal) => resolve({ code, signal }))
  })
  return { proc, exited }
}

/**
 * @param {string} file
 */
async function waitFor(file) {
  for (let i = 0; i < 2000 && !fsSync.existsSync(file); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(fsSync.existsSync(file), `${path.basename(file)} was signalled`)
}

/**
 * @param {string} dir
 * @param {string} prefix
 */
async function spoolNames(dir, prefix) {
  return (await fs.readdir(dir)).filter((name) => name.startsWith(prefix))
}

/**
 * Every committed id in the demo dataset, in commit order.
 *
 * @param {ReturnType<typeof createQueryStorageService>} svc
 */
async function committedIds(svc) {
  /** @type {number[]} */
  const ids = []
  const partitions = await svc.discoverCachePartitions({ datasets: ['demo'] })
  if (partitions.length === 0) return ids
  for await (const item of svc.readRowsSince(partitions[0].path, { includeLegacy: true })) {
    if ('row' in item && item.row) ids.push(Number(item.row.id))
  }
  return ids
}

// Real processes: the in-process flush lock already serializes flushes within
// one process, so only separate processes can take the same rotated file.
// Each child stands in for the daemon or a `hyp query --refresh always`
// force-flushing a spool that already holds rotated files. Issue #2580.
//
// Every row is spooled and rotated before any child starts, so this proves
// drain against drain only. An append that spans another process's rotation
// is covered by the append-marker tests below (issue #2654).
test('concurrent forced flushes in separate processes commit every spooled row exactly once', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    const dir = path.join(tablePath, '_hypaware_spool')
    const batches = 40
    for (let batch = 0; batch < batches; batch++) {
      await svc.appendRows(tablePath, COLS, Array.from({ length: 4 }, (_, i) => ({ id: batch * 4 + i, msg: 'b' + batch })))
      // The name a rotation gives it, so every child lists the same files.
      if (batch < batches - 1) await fs.rename(path.join(dir, 'active.jsonl'), path.join(dir, `flush-${batch}-0-test.jsonl`))
    }
    const go = path.join(cacheRoot, 'go')
    const child = `
      import fs from 'node:fs'
      import { createQueryStorageService } from ${JSON.stringify(storageUrl)}
      const [cacheRoot, go] = process.argv.slice(1)
      const svc = createQueryStorageService({ cacheRoot })
      const tablePath = svc.cacheTablePath('demo', ['all'])
      while (!fs.existsSync(go)) await new Promise(resolve => setTimeout(resolve, 2))
      // A busy partition guard is the contention callers already retry.
      for (let attempt = 0; ; attempt++) {
        try {
          await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
          break
        } catch (error) {
          if (error?.error_kind !== 'cache_partition_mutation_busy' || attempt >= 200) throw error
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
    `
    const children = 4
    const runs = Array.from({ length: children }, () => runChild(child, [cacheRoot, go]))
    await new Promise(resolve => setTimeout(resolve, 300))
    await fs.writeFile(go, '')
    await Promise.all(runs)

    const ids = await committedIds(svc)
    assert.equal(new Set(ids).size, ids.length, `${ids.length - new Set(ids).size} rows were committed more than once`)
    assert.equal(ids.length, batches * 4, 'every spooled row is committed')
    const spool = await fs.readdir(dir)
    assert.deepEqual(spool.filter((name) => name.startsWith('flush-') || name.endsWith('.mutation-lock')), [], 'no rotated file or claim is left behind')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a drain claim left by a killed process does not wedge the next flush', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    await svc.appendRows(tablePath, COLS, [{ id: 1, msg: 'waiting' }])

    // A pid that was alive a moment ago and is not now, published the way a
    // holder publishes itself.
    const deadPid = Number(await runChild('process.stdout.write(String(process.pid))', []))
    const claim = path.join(tablePath, '_hypaware_spool', '.drain.mutation-lock')
    await fs.mkdir(claim)
    await fs.writeFile(path.join(claim, `${deadPid}-${randomUUID()}`), '')

    const result = await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.equal(result.rowCount, 1)
    assert.deepEqual(await committedIds(svc), [1])
    await assert.rejects(fs.stat(claim), { code: 'ENOENT' }, 'the dead holder\'s claim is reclaimed and released')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a forced flush waits out a live holder instead of returning before its rows commit', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    await svc.appendRows(tablePath, COLS, [{ id: 1, msg: 'waiting' }])

    const key = path.join(tablePath, '_hypaware_spool', 'drain')
    const holder = runChild(`
      import { withPartitionMutationLock } from ${JSON.stringify(partitionUrl)}
      await withPartitionMutationLock(process.argv[1], async () => {
        process.stdout.write('held')
        await new Promise(resolve => setTimeout(resolve, 400))
      })
    `, [key])
    const claim = path.join(tablePath, '_hypaware_spool', '.drain.mutation-lock')
    while (!(await fs.stat(claim).then(() => true, () => false))) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    // Measured when the flush settles, not after joining the holder, or an
    // unclaimed flush that returned at once would pass too.
    const started = Date.now()
    const result = await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    const waited = Date.now() - started
    assert.equal(await holder, 'held')
    assert.ok(waited >= 200, `the flush waited for the holder to let go (settled after ${waited} ms)`)
    assert.equal(result.rowCount, 1)
    assert.deepEqual(await committedIds(svc), [1])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// A spool that is missing when a flush starts holds nothing that flush owes,
// and one another process creates a moment later is that process's to drain
// under its own claim. Draining it here, unclaimed, raced the other drainer
// for the same batch.
test('a flush that finds no spool does not drain one another process creates meanwhile', async () => {
  const cacheRoot = await makeTmpDir()
  const exists = fsSync.existsSync
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    const dir = path.join(tablePath, '_hypaware_spool')
    const child = `
      import { createQueryStorageService } from ${JSON.stringify(storageUrl)}
      const svc = createQueryStorageService({ cacheRoot: process.argv[1] })
      await svc.appendRows(svc.cacheTablePath('demo', ['all']), ${JSON.stringify(COLS)}, [{ id: 1, msg: 'other process' }])
    `
    let crossed = false
    fsSync.existsSync = (p) => {
      const result = exists(p)
      if (!crossed && p === dir && !result) {
        crossed = true
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', child, cacheRoot], { stdio: 'inherit' })
        assert.equal(run.status, 0)
      }
      return result
    }
    const result = await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    fsSync.existsSync = exists
    assert.ok(crossed, 'the spool was created after the flush looked for it')
    assert.equal(result.rowCount, 0)
    assert.deepEqual(await committedIds(svc), [])
    assert.ok((await svc.pendingInfo(tablePath)).pending, 'the row waits for a claimed drain')
  } finally {
    fsSync.existsSync = exists
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// Issue #2654: another process's append opened `active.jsonl` before this
// flush rotated it and writes after the drain read it. The rotated file used
// to be unlinked under it and the acknowledged row was gone. Now the drain
// commits what it read and keeps the file while the append still holds it,
// and rotation never waits: a later append and flush go straight through.
test('an append in another process that spans a rotation is committed exactly once', async () => {
  const cacheRoot = await makeTmpDir()
  /** @type {ChildProcess | undefined} */
  let child
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    const dir = path.join(tablePath, '_hypaware_spool')
    await svc.appendRows(tablePath, COLS, [{ id: 1, msg: 'before' }])

    const { proc, exited } = spawnStalledAppend(cacheRoot, cacheRoot, { id: 2 })
    child = proc
    await waitFor(path.join(cacheRoot, 'paused'))

    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.deepEqual(await committedIds(svc), [1])
    assert.equal((await spoolNames(dir, 'flush-')).filter((name) => name.endsWith('.jsonl')).length, 1, 'the file the append holds is kept')

    // The stalled writer blocks nothing that is not its own file.
    await svc.appendRows(tablePath, COLS, [{ id: 3, msg: 'while stalled' }])
    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.deepEqual((await committedIds(svc)).sort(), [1, 3])
    assert.equal((await spoolNames(dir, 'flush-')).filter((name) => name.endsWith('.jsonl')).length, 1, 'only the stalled writer\'s file is held')

    await fs.writeFile(path.join(cacheRoot, 'go'), '')
    assert.deepEqual(await exited, { code: 0, signal: null })
    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })

    const ids = await committedIds(svc)
    assert.deepEqual([...ids].sort(), [1, 2, 3], 'the spanning append is committed, and nothing twice')
    assert.deepEqual(await spoolNames(dir, 'flush-'), [], 'the held file is released once the append lets go')
    assert.deepEqual(await spoolNames(dir, '.append-'), [], 'no append marker is left behind')
  } finally {
    // A failed assertion would otherwise leave the stalled writer running.
    child?.kill('SIGKILL')
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// A writer killed mid-append never writes again, so the file it held is
// released by the next drain, its torn half-line is dropped with it, and its
// marker is cleared rather than holding the file forever.
test('a writer killed mid-append holds its file only until the next drain', async () => {
  const cacheRoot = await makeTmpDir()
  /** @type {ChildProcess | undefined} */
  let child
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    const dir = path.join(tablePath, '_hypaware_spool')
    await svc.appendRows(tablePath, COLS, [{ id: 1, msg: 'before' }])

    const { proc, exited } = spawnStalledAppend(cacheRoot, cacheRoot, { id: 2, torn: true })
    child = proc
    await waitFor(path.join(cacheRoot, 'torn'))

    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.deepEqual(await committedIds(svc), [1])
    assert.equal((await spoolNames(dir, 'flush-')).filter((name) => name.endsWith('.jsonl')).length, 1, 'held while the writer lives')

    proc.kill('SIGKILL')
    assert.equal((await exited).signal, 'SIGKILL')
    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.deepEqual(await committedIds(svc), [1], 'the torn half-line is not read as a row')
    assert.deepEqual(await spoolNames(dir, 'flush-'), [], 'the dead writer\'s file is released')
    assert.deepEqual(await spoolNames(dir, '.append-'), [], 'the dead writer\'s marker is cleared')

    await svc.appendRows(tablePath, COLS, [{ id: 3, msg: 'after' }])
    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.deepEqual(await committedIds(svc), [1, 3])
  } finally {
    // A failed assertion would otherwise leave the stalled writer running.
    child?.kill('SIGKILL')
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// A drain that cannot list the markers cannot rule out a writer, so it
// commits what it read and keeps every rotated file for a later pass.
test('a drain that cannot list the append markers keeps the rotated file it read', async () => {
  const cacheRoot = await makeTmpDir()
  /** @type {ChildProcess | undefined} */
  let child
  const readdirSync = fsSync.readdirSync
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    const dir = path.join(tablePath, '_hypaware_spool')
    await svc.appendRows(tablePath, COLS, [{ id: 1, msg: 'before' }])

    const { proc, exited } = spawnStalledAppend(cacheRoot, cacheRoot, { id: 2 })
    child = proc
    await waitFor(path.join(cacheRoot, 'paused'))

    // Only the marker listing is a bare `readdirSync(dir)`; the spool's file
    // listings pass `withFileTypes`.
    let failed = 0
    fsSync.readdirSync = /** @type {typeof readdirSync} */ ((/** @type {fsSync.PathLike} */ p, /** @type {unknown[]} */ ...rest) => {
      if (String(p) === dir && rest.length === 0 && failed++ === 0) {
        throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
      }
      return /** @type {Function} */ (readdirSync)(p, ...rest)
    })
    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    fsSync.readdirSync = readdirSync
    assert.equal(failed, 1, 'the marker listing failed once')
    assert.deepEqual(await committedIds(svc), [1])
    assert.equal((await spoolNames(dir, 'flush-')).filter((name) => name.endsWith('.jsonl')).length, 1, 'the file is kept')

    await fs.writeFile(path.join(cacheRoot, 'go'), '')
    assert.deepEqual(await exited, { code: 0, signal: null })
    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.deepEqual((await committedIds(svc)).sort(), [1, 2], 'the acknowledged row is committed, and nothing twice')
    assert.deepEqual(await spoolNames(dir, 'flush-'), [])
  } finally {
    fsSync.readdirSync = readdirSync
    child?.kill('SIGKILL')
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// Each storage service has its own write lock, so two in one process can
// span each other's rotation the same way two processes can.
test('an append in another storage service in the same process that spans a rotation is committed', async () => {
  const cacheRoot = await makeTmpDir()
  const open = fs.open
  /** @type {() => void} */
  let release = () => undefined
  /** @type {Promise<unknown> | undefined} */
  let pending
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const writer = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    const dir = path.join(tablePath, '_hypaware_spool')
    await svc.appendRows(tablePath, COLS, [{ id: 1, msg: 'before' }])

    /** @type {Promise<void>} */
    const gate = new Promise((resolve) => { release = resolve })
    /** @type {() => void} */
    let entered = () => undefined
    /** @type {Promise<void>} */
    const paused = new Promise((resolve) => { entered = resolve })
    fs.open = /** @type {typeof open} */ (async (/** @type {string} */ file, /** @type {string} */ flags) => {
      const handle = await open(file, flags)
      if (!String(file).endsWith('active.jsonl')) return handle
      const writeFile = handle.writeFile.bind(handle)
      handle.writeFile = /** @type {typeof writeFile} */ (async (/** @type {string} */ data, /** @type {BufferEncoding} */ encoding) => {
        entered()
        await gate
        return writeFile(data, encoding)
      })
      return handle
    })
    pending = writer.appendRows(tablePath, COLS, [{ id: 2, msg: 'stalled' }])
    await paused
    fs.open = open

    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.deepEqual(await committedIds(svc), [1])
    assert.equal((await spoolNames(dir, 'flush-')).filter((name) => name.endsWith('.jsonl')).length, 1, 'the file the append holds is kept')

    release()
    await pending
    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.deepEqual((await committedIds(svc)).sort(), [1, 2], 'the acknowledged row is committed, and nothing twice')
    assert.deepEqual(await spoolNames(dir, 'flush-'), [])
    assert.deepEqual(await spoolNames(dir, '.append-'), [])
  } finally {
    fs.open = open
    release()
    await pending?.catch(() => undefined)
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// A writer stalled the moment its marker exists holds the one file its
// marker names: the marker says which file before any drain can see it, so
// later rotations are unlinked as they drain instead of piling up.
test('a writer stalled at its marker holds one rotated file however many flushes follow', async () => {
  const cacheRoot = await makeTmpDir()
  /** @type {ChildProcess | undefined} */
  let child
  try {
    const svc = createQueryStorageService({ cacheRoot })
    const tablePath = svc.cacheTablePath('demo', ['all'])
    const dir = path.join(tablePath, '_hypaware_spool')
    await svc.appendRows(tablePath, COLS, [{ id: 1, msg: 'before' }])

    const { proc, exited } = spawnStalledAppend(cacheRoot, cacheRoot, { id: 2, atMarker: true })
    child = proc
    await waitFor(path.join(cacheRoot, 'paused'))

    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    for (const id of [3, 4, 5]) {
      await svc.appendRows(tablePath, COLS, [{ id, msg: 'while stalled' }])
      await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
      assert.equal((await spoolNames(dir, 'flush-')).filter((name) => name.endsWith('.jsonl')).length, 1, `one file held after id ${id}`)
    }

    await fs.writeFile(path.join(cacheRoot, 'go'), '')
    assert.deepEqual(await exited, { code: 0, signal: null })
    await svc.flushTable(tablePath, { force: true, reason: 'query_always' })
    assert.deepEqual((await committedIds(svc)).sort(), [1, 2, 3, 4, 5], 'every row once')
    assert.deepEqual(await spoolNames(dir, 'flush-'), [])
    assert.deepEqual(await spoolNames(dir, '.append-'), [])
  } finally {
    child?.kill('SIGKILL')
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

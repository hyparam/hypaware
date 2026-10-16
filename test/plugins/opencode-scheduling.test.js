import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const source = await fs.readFile(new URL('../../hypaware-core/plugins-workspace/opencode/assets/hypaware.js', import.meta.url), 'utf8')

async function harness() {
  let now = 0
  const timers = new Map()
  const reads = []
  const uploads = []
  let read = async (id, signal) => ({ data: { id, directory: '/work' } })
  let upload = async (signal) => ({ body: { cancel() {} } })
  const context = vm.createContext({
    Date: { now: () => now },
    process: { env: {} },
    AbortController,
    AbortSignal: {
      any: AbortSignal.any,
      timeout(ms) {
        const controller = new AbortController()
        context.setTimeout(() => controller.abort(new Error('timeout')), ms)
        return controller.signal
      },
    },
    setTimeout(fn, ms) {
      const timer = { unref() {} }
      timers.set(timer, { at: now + ms, fn })
      return timer
    },
    clearTimeout(timer) { timers.delete(timer) },
    async fetch(url, options) {
      uploads.push(JSON.parse(options.body))
      return upload(options.signal)
    },
  })
  vm.runInContext(source.replace('export const HypAware =', 'globalThis.HypAware ='), context)
  const hooks = await context.HypAware({
    directory: '/work',
    client: { session: {
      get({ path, signal }) { reads.push(path.id); return read(path.id, signal) },
      async messages() { return { data: [] } },
    } },
  })
  async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return {
    hooks, reads, uploads,
    setRead(fn) { read = fn },
    setUpload(fn) { upload = fn },
    event(id = 'session', type = 'message.part.updated') {
      return hooks.event({ event: { type, properties: { sessionID: id } } })
    },
    async tick(ms) {
      await settle()
      const until = now + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        void next[1].fn()
        await settle()
      }
      now = until
      await settle()
    },
  }
}

test('streaming bursts coalesce, rate-limit full snapshots, and retain the latest trigger', async () => {
  const h = await harness()
  for (let i = 0; i < 100; i++) assert.equal(h.event(), undefined)
  await h.tick(25)
  assert.equal(h.uploads.length, 1)
  for (let i = 0; i < 10; i++) {
    h.event()
    await h.tick(50)
  }
  h.event('session', 'session.idle')
  assert.equal(h.reads.length, 1)
  await h.tick(499)
  assert.equal(h.reads.length, 1)
  await h.tick(1)
  assert.equal(h.uploads.length, 2)
  assert.equal(h.uploads[1].trigger, 'session.idle')
  await h.tick(10000)
  assert.equal(h.reads.length, 2)
})

test('an isolated burst keeps the original debounce rather than taking intermediate snapshots', async () => {
  const h = await harness()
  for (let i = 0; i < 100; i++) {
    h.event()
    await h.tick(1)
  }
  assert.equal(h.reads.length, 0)
  await h.tick(25)
  assert.equal(h.reads.length, 1)
  await h.tick(10000)
  assert.equal(h.reads.length, 1)
})

test('events during I/O retain one trailing refresh and other sessions run in FIFO order', async () => {
  const h = await harness()
  let finish
  h.setUpload(() => new Promise(resolve => { finish = resolve }))
  h.event('first')
  await h.tick(25)
  h.event('second')
  for (let i = 0; i < 100; i++) h.event('first')
  await h.tick(2000)
  assert.deepEqual(h.reads, ['first'])
  h.setUpload(async () => ({ body: null }))
  finish({ body: null })
  await h.tick(25)
  assert.deepEqual(h.reads, ['first', 'second'])
  await h.tick(1000)
  assert.deepEqual(h.reads, ['first', 'second', 'first'])
})

test('SDK timeout releases the queue and disposal aborts I/O and cancels trailing work', async () => {
  const h = await harness()
  let active
  h.setRead((id, signal) => new Promise((resolve, reject) => {
    active = signal
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  h.event('stuck')
  await h.tick(25)
  h.event('next')
  await h.tick(5000)
  assert.equal(active.aborted, true)
  h.setRead(async id => ({ data: { id } }))
  await h.tick(25)
  assert.deepEqual(h.reads, ['stuck', 'next'])
  assert.equal(h.uploads.length, 1)
  h.setUpload(signal => new Promise((resolve, reject) => {
    active = signal
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  h.event('dispose')
  await h.tick(1000)
  h.event('pending')
  h.hooks.dispose()
  assert.equal(active.aborted, true)
  h.event('after-dispose')
  await h.tick(10000)
  assert.deepEqual(h.reads, ['stuck', 'next', 'dispose'])
})

test('pending-session memory is bounded and fresh sessions survive queue saturation', async () => {
  const h = await harness()
  for (let i = 0; i < 200; i++) h.event(`session-${i}`)
  await h.tick(130000)
  assert.equal(h.reads.length, 128)
  assert.equal(h.reads[0], 'session-72')
  assert.equal(h.reads.at(-1), 'session-199')
})

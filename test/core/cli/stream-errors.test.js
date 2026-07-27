// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installStreamErrorHandlers } from '../../../src/core/cli/stream_errors.js'

// Asynchronous stdout/stderr failures bypass every try/catch in the
// process. Unlistened they crash a command that had already done its work.
// @ref LLP 0135#first-look [tests]: nothing in the block may fail a run that succeeded

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const HANDLER = path.join(REPO_ROOT, 'src/core/cli/stream_errors.js')

test('installStreamErrorHandlers: EPIPE is swallowed without a word', () => {
  const stream = /** @type {any} */ (new EventEmitter())
  /** @type {string[]} */
  const said = []
  installStreamErrorHandlers([stream], (m) => said.push(m))
  // A reader that closed the pipe is the normal end of `| head`, not a
  // failure of the command, and an unlistened 'error' would throw here.
  stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  assert.deepEqual(said, [])
})

test('installStreamErrorHandlers: any other failure is reported once', () => {
  const out = /** @type {any} */ (new EventEmitter())
  const err = /** @type {any} */ (new EventEmitter())
  /** @type {string[]} */
  const said = []
  installStreamErrorHandlers([out, err], (m) => said.push(m))
  out.emit('error', Object.assign(new Error('nope'), { code: 'ENOSPC' }))
  // Once a stream is broken every later write fails the same way; saying so
  // repeatedly would bury whatever the command was actually reporting.
  out.emit('error', Object.assign(new Error('nope'), { code: 'ENOSPC' }))
  err.emit('error', Object.assign(new Error('nope'), { code: 'ENOSPC' }))
  assert.equal(said.length, 1)
  assert.match(said[0], /output stream failed \(ENOSPC\)/)
})

test('installStreamErrorHandlers: the returned detach removes the listeners', () => {
  const stream = /** @type {any} */ (new EventEmitter())
  const detach = installStreamErrorHandlers([stream])
  detach()
  assert.equal(stream.listenerCount('error'), 0)
})

/**
 * Run a child that writes `bytes` to stdout, with the handler installed or
 * not, against a reader that walks away after the first chunk.
 *
 * A real pipe, not a stub whose `write` throws: EPIPE is delivered as an
 * asynchronous 'error' event, and a synchronous stub proves nothing about
 * whether that path is survivable.
 *
 * @param {{ install: boolean, bytes: number }} opts
 */
function writeIntoAClosedPipe({ install, bytes }) {
  const body = `process.stdout.write('x'.repeat(${bytes}));setTimeout(()=>process.exit(7),200)`
  const script = install
    ? `import(${JSON.stringify(HANDLER)}).then(m=>{m.installStreamErrorHandlers([process.stdout,process.stderr]);${body}})`
    : body
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.stdout.once('data', () => child.stdout.destroy())
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

test('a write past the pipe buffer survives a reader that walked away', async () => {
  // 400 KB, well past the ~64 KiB pipe buffer. Under that, the write
  // completes before the reader's exit can matter, which is why small
  // outputs never showed this. `hyp query overview --json` is unbounded by
  // design - the counts behind the fold lines have to be exact - so it can
  // cross it on a large cache.
  const withHandler = await writeIntoAClosedPipe({ install: true, bytes: 400_000 })
  // The command's own exit code, and nothing on stderr: the reader leaving
  // is not this command's failure to report.
  assert.equal(withHandler.code, 7)
  assert.equal(withHandler.stderr, '')
})

test('the same write without the handler is what we are protecting against', async () => {
  // Pins that the test above is testing something: unlistened, the async
  // 'error' is fatal and the command's exit code is lost.
  const bare = await writeIntoAClosedPipe({ install: false, bytes: 400_000 })
  assert.equal(bare.code, 1)
  assert.match(bare.stderr, /EPIPE|Unhandled 'error' event/)
})

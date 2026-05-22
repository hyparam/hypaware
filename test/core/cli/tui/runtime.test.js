// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import {
  multiselect,
  select,
  text,
  confirm,
  PromptCancelledError,
} from '../../../../src/core/cli/tui/index.js'

const ENV = { NO_COLOR: '1' }

/**
 * Build a pair of PassThrough streams that look enough like a TTY for
 * the runtime to accept them. `stdin.setRawMode` is stubbed so the
 * runtime can flip modes without crashing.
 */
function makeTty() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.defineProperty(stdin, 'isTTY', { value: true })
  Object.defineProperty(stdout, 'isTTY', { value: true })
  // @ts-expect-error — PassThrough does not declare setRawMode but the runtime probes for it.
  stdin.setRawMode = () => {}
  // Collect stdout writes so tests can assert on what was rendered.
  /** @type {string[]} */
  const writes = []
  stdout.on('data', (chunk) => writes.push(String(chunk)))
  return { stdin, stdout, output: () => writes.join('') }
}

/**
 * Run the previously-spawned prompt promise to settlement after
 * writing the given sequence of bytes to stdin (one chunk per tick).
 *
 * @param {PassThrough} stdin
 * @param {string[]} chunks
 */
async function feed(stdin, chunks) {
  for (const c of chunks) {
    stdin.write(c)
    // Let the keypress parser flush before sending the next chunk.
    await new Promise((r) => setImmediate(r))
  }
}

test('runtime: multiselect happy path returns selected values in order', async () => {
  const io = makeTty()
  const promise = multiselect({
    title: 'pick',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' },
    ],
    stdin: io.stdin,
    stdout: io.stdout,
  })
  // space (toggle A) → down → down → space (toggle C) → enter
  await feed(io.stdin, [' ', '\x1b[B', '\x1b[B', ' ', '\r'])
  const result = await promise
  assert.deepEqual(result, ['a', 'c'])
})

test('runtime: multiselect cancel via ctrl+c throws PromptCancelledError', async () => {
  const io = makeTty()
  const promise = multiselect({
    title: 'pick',
    options: [{ value: 'a', label: 'A' }],
    stdin: io.stdin,
    stdout: io.stdout,
  })
  // Attach the rejection assertion BEFORE feeding the cancel byte so the
  // unhandled-rejection detector never fires.
  const rejection = assert.rejects(promise, (err) => err instanceof PromptCancelledError)
  await feed(io.stdin, ['\x03'])
  await rejection
})

test('runtime: multiselect bounds rejection retains active state until satisfied', async () => {
  const io = makeTty()
  const promise = multiselect({
    title: 'pick',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    bounds: { min: 1 },
    stdin: io.stdin,
    stdout: io.stdout,
  })
  // enter with zero selections → error, stays active
  // then toggle A, enter → resolves with ['a']
  await feed(io.stdin, ['\r', ' ', '\r'])
  const result = await promise
  assert.deepEqual(result, ['a'])
  assert.match(io.output(), /select at least 1/)
})

test('runtime: select returns the value at the cursor on enter', async () => {
  const io = makeTty()
  const promise = select({
    title: 'choose',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    stdin: io.stdin,
    stdout: io.stdout,
  })
  await feed(io.stdin, ['\x1b[B', '\r'])
  const result = await promise
  assert.equal(result, 'b')
})

test('runtime: select cancel throws PromptCancelledError', async () => {
  const io = makeTty()
  const promise = select({
    title: 'choose',
    options: [{ value: 'a', label: 'A' }],
    stdin: io.stdin,
    stdout: io.stdout,
  })
  const rejection = assert.rejects(promise, (err) => err instanceof PromptCancelledError)
  await feed(io.stdin, ['\x1b'])
  await rejection
})

test('runtime: text returns the typed buffer on enter', async () => {
  const io = makeTty()
  const promise = text({
    title: 'name',
    stdin: io.stdin,
    stdout: io.stdout,
  })
  await feed(io.stdin, ['p', 'h', 'i', 'l', '\r'])
  const result = await promise
  assert.equal(result, 'phil')
})

test('runtime: text empty + default returns default on enter', async () => {
  const io = makeTty()
  const promise = text({
    title: 'name',
    default: 'phil',
    stdin: io.stdin,
    stdout: io.stdout,
  })
  await feed(io.stdin, ['\r'])
  const result = await promise
  assert.equal(result, 'phil')
})

test('runtime: text validate-rejected enter stays active until valid', async () => {
  const io = makeTty()
  const promise = text({
    title: 'name',
    validate: (v) => (v.length < 2 ? 'too short' : null),
    stdin: io.stdin,
    stdout: io.stdout,
  })
  await feed(io.stdin, ['x', '\r', 'y', '\r'])
  const result = await promise
  assert.equal(result, 'xy')
  assert.match(io.output(), /too short/)
})

test('runtime: confirm resolves true on y and false on n', async () => {
  {
    const io = makeTty()
    const promise = confirm({ title: 'go?', stdin: io.stdin, stdout: io.stdout })
    await feed(io.stdin, ['y'])
    assert.equal(await promise, true)
  }
  {
    const io = makeTty()
    const promise = confirm({ title: 'go?', stdin: io.stdin, stdout: io.stdout })
    await feed(io.stdin, ['n'])
    assert.equal(await promise, false)
  }
})

test('runtime: confirm enter resolves with the default value', async () => {
  {
    const io = makeTty()
    const promise = confirm({ title: 'go?', default: true, stdin: io.stdin, stdout: io.stdout })
    await feed(io.stdin, ['\r'])
    assert.equal(await promise, true)
  }
  {
    const io = makeTty()
    const promise = confirm({ title: 'go?', default: false, stdin: io.stdin, stdout: io.stdout })
    await feed(io.stdin, ['\r'])
    assert.equal(await promise, false)
  }
})

test('runtime: cursor-hide is written on entry and cursor-show on resolve', async () => {
  const io = makeTty()
  const promise = confirm({ title: 'go?', stdin: io.stdin, stdout: io.stdout })
  await feed(io.stdin, ['y'])
  await promise
  const out = io.output()
  assert.ok(out.includes('\x1b[?25l'), 'cursor-hide escape not emitted')
  assert.ok(out.includes('\x1b[?25h'), 'cursor-show escape not emitted on resolve')
})

test('runtime: cursor-show is written even on cancel', async () => {
  const io = makeTty()
  const promise = confirm({ title: 'go?', stdin: io.stdin, stdout: io.stdout })
  const rejection = assert.rejects(promise)
  await feed(io.stdin, ['\x03'])
  await rejection
  assert.ok(io.output().includes('\x1b[?25h'), 'cursor-show escape not emitted on cancel')
})

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
import { isPromptCancelledError, countPhysicalRows } from '../../../../src/core/cli/tui/runtime.js'

const ENV = { NO_COLOR: '1' }

/**
 * Parse the cursor-up row count (`\x1b[<n>A`) the runtime emits at the
 * start of a redraw frame. Returns 0 when the chunk has no cursor-up
 * (the very first frame).
 *
 * @param {string} chunk
 * @returns {number}
 */
function cursorUpCount(chunk) {
  const m = /\x1b\[(\d+)A/.exec(chunk)
  return m ? Number.parseInt(m[1], 10) : 0
}

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
  Object.defineProperty(stdin, 'isRaw', { value: false, writable: true })
  // @ts-expect-error: PassThrough does not declare setRawMode but the runtime probes for it.
  stdin.setRawMode = (enabled) => {
    /** @type {any} */ (stdin).isRaw = enabled
  }
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

test('runtime: prompt cancellation predicate recognizes PromptCancelledError', () => {
  const direct = new PromptCancelledError()
  const wrapped = new Error('wrapped cancel')
  wrapped.name = 'PromptCancelledError'

  assert.equal(isPromptCancelledError(direct), true)
  assert.equal(isPromptCancelledError(wrapped), true)
  assert.equal(isPromptCancelledError(new Error('other')), false)
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

test('runtime: cleanup restores paused stdin after prompt completion', async () => {
  const io = makeTty()
  io.stdin.pause()
  assert.equal(io.stdin.readableFlowing, false)

  const promise = confirm({ title: 'go?', stdin: io.stdin, stdout: io.stdout })
  await feed(io.stdin, ['y'])
  assert.equal(await promise, true)

  assert.equal(io.stdin.readableFlowing, false)
  assert.equal(io.stdin.isPaused(), true)
  assert.equal(/** @type {any} */ (io.stdin).isRaw, false)
})

test('runtime: cleanup preserves previously flowing stdin after prompt completion', async () => {
  const io = makeTty()
  io.stdin.resume()
  assert.equal(io.stdin.readableFlowing, true)

  const promise = confirm({ title: 'go?', stdin: io.stdin, stdout: io.stdout })
  await feed(io.stdin, ['y'])
  assert.equal(await promise, true)

  assert.equal(io.stdin.readableFlowing, true)
  assert.equal(/** @type {any} */ (io.stdin).isRaw, false)
})

test('runtime: render failures during keypress reject and clean up', async () => {
  const io = makeTty()
  const originalWrite = io.stdout.write.bind(io.stdout)
  let writes = 0
  io.stdout.write = /** @type {any} */ ((chunk, ...args) => {
    writes += 1
    if (writes >= 3) throw new Error('render failed')
    return originalWrite(chunk, ...args)
  })

  const promise = confirm({ title: 'go?', stdin: io.stdin, stdout: io.stdout })
  const rejection = assert.rejects(promise, /render failed/)
  await feed(io.stdin, ['y'])
  await rejection

  assert.equal(io.stdin.readableFlowing, false)
  assert.equal(/** @type {any} */ (io.stdin).isRaw, false)
})

test('countPhysicalRows: counts each logical line once when nothing wraps', () => {
  // 'a\nb\nc\n' → three rows, trailing newline contributes none.
  assert.equal(countPhysicalRows('a\nb\nc\n', 80), 3)
})

test('countPhysicalRows: empty lines still occupy one row', () => {
  assert.equal(countPhysicalRows('a\n\nb\n', 80), 3)
})

test('countPhysicalRows: a line wider than the terminal counts its wrapped rows', () => {
  // 25 visible chars at width 10 → ceil(25/10) = 3 physical rows.
  const line = 'x'.repeat(25)
  assert.equal(countPhysicalRows(line + '\n', 10), 3)
})

test('countPhysicalRows: a line exactly the terminal width stays one row', () => {
  assert.equal(countPhysicalRows('x'.repeat(10) + '\n', 10), 1)
  assert.equal(countPhysicalRows('x'.repeat(11) + '\n', 10), 2)
})

test('countPhysicalRows: ANSI style codes do not inflate the width', () => {
  // 10 visible chars wrapped in color codes still fit one row at width 10.
  const styled = '\x1b[36m' + 'x'.repeat(10) + '\x1b[0m'
  assert.equal(countPhysicalRows(styled + '\n', 10), 1)
})

test('countPhysicalRows: defaults to 80 columns for non-TTY widths', () => {
  assert.equal(countPhysicalRows('x'.repeat(81) + '\n', 0), 2)
})

test('runtime: redraw moves up by physical (wrapped) rows on a narrow terminal', async () => {
  // Regression for the "moving the cursor duplicates the question"
  // bug: long option summaries wrap to multiple physical rows, so the
  // redraw must move the cursor up by the wrapped row count, not by the
  // number of '\n' written.
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.defineProperty(stdin, 'isTTY', { value: true })
  Object.defineProperty(stdout, 'isTTY', { value: true })
  Object.defineProperty(stdout, 'columns', { value: 24 })
  Object.defineProperty(stdin, 'isRaw', { value: false, writable: true })
  // @ts-expect-error: PassThrough has no setRawMode; the runtime probes for it.
  stdin.setRawMode = (enabled) => { /** @type {any} */ (stdin).isRaw = enabled }
  /** @type {string[]} */
  const chunks = []
  stdout.on('data', (chunk) => chunks.push(String(chunk)))

  const promise = multiselect({
    title: 'What do you want to collect?',
    options: [
      { value: 'a', label: 'capture A', summary: 'A long summary that is certainly wider than twenty-four columns.' },
      { value: 'b', label: 'capture B', summary: 'Another summary long enough to wrap across several rows.' },
    ],
    stdin,
    stdout,
  })
  // 'z' is ignored by the reducer but still triggers a redraw, then enter resolves.
  await feed(stdin, ['z', '\r'])
  await promise

  // The first frame is the first chunk carrying the title; the redraw is
  // the next chunk that begins with a cursor-up move. (The CURSOR_HIDE
  // escape is written as its own chunk before the first frame.)
  const firstFrame = chunks.find((c) => c.includes('What do you want'))
  const redrawFrame = chunks.find((c) => /\x1b\[\d+A/.test(c))
  assert.ok(firstFrame, 'first frame not captured')
  assert.ok(redrawFrame, 'redraw frame not captured')
  // The redraw's cursor-up count must equal the wrapped row count of the
  // first frame, otherwise stale rows are left on screen (duplication).
  assert.equal(cursorUpCount(redrawFrame), countPhysicalRows(firstFrame, 24))
  // And that count must exceed the naive newline count, proving wrapping
  // actually occurred in this fixture.
  const newlineCount = (firstFrame.match(/\n/g) ?? []).length
  assert.ok(
    countPhysicalRows(firstFrame, 24) > newlineCount,
    'fixture should wrap; otherwise the regression is not exercised',
  )
})

/**
 * The settle-erase the runtime emits on cleanup is a standalone
 * cursor-up + clear-to-end (`\x1b[<n>A\r\x1b[J`) with no frame appended.
 * Redraw frames share the same prefix but carry rendered content after
 * it, so an exact match isolates the cleanup erase from redraws.
 *
 * @param {string[]} chunks
 * @returns {string[]}
 */
function settleErases(chunks) {
  return chunks.filter((c) => /^\x1b\[\d+A\r\x1b\[J$/.test(c))
}

/**
 * Spawn a prompt over a fresh fake TTY and capture every stdout chunk so
 * tests can assert on the exact cleanup sequence.
 */
function makeChunkCapture() {
  const io = makeTty()
  /** @type {string[]} */
  const chunks = []
  io.stdout.on('data', (c) => chunks.push(String(c)))
  return { ...io, chunks }
}

test('runtime: clearOnResolve erases the settled frame on resolve', async () => {
  const io = makeChunkCapture()
  const promise = confirm({ title: 'go?', stdin: io.stdin, stdout: io.stdout, clearOnResolve: true })
  await feed(io.stdin, ['y'])
  assert.equal(await promise, true)

  const erases = settleErases(io.chunks)
  assert.equal(erases.length, 1, 'expected exactly one settle-erase on resolve')
  // The erase moves up by the rendered frame's physical row count, and
  // the cursor is restored afterwards.
  assert.ok(cursorUpCount(erases[0]) > 0, 'erase must move the cursor up')
  const eraseIdx = io.chunks.indexOf(erases[0])
  assert.ok(
    io.chunks.slice(eraseIdx + 1).some((c) => c.includes('\x1b[?25h')),
    'cursor must be shown again after the erase',
  )
})

test('runtime: clearOnResolve erases the settled frame on cancel', async () => {
  const io = makeChunkCapture()
  const promise = confirm({ title: 'go?', stdin: io.stdin, stdout: io.stdout, clearOnResolve: true })
  const rejection = assert.rejects(promise, (err) => err instanceof PromptCancelledError)
  await feed(io.stdin, ['\x03'])
  await rejection

  assert.equal(settleErases(io.chunks).length, 1, 'cancel path must also erase the settled frame')
})

test('runtime: without clearOnResolve the settled frame is left in place', async () => {
  const io = makeChunkCapture()
  const promise = confirm({ title: 'go?', stdin: io.stdin, stdout: io.stdout })
  await feed(io.stdin, ['y'])
  assert.equal(await promise, true)

  assert.equal(settleErases(io.chunks).length, 0, 'no settle-erase when clearOnResolve is off')
})

test('runtime: overlapping prompts are rejected', async () => {
  const first = makeTty()
  const second = makeTty()
  const promise = confirm({ title: 'first?', stdin: first.stdin, stdout: first.stdout })

  await assert.rejects(
    confirm({ title: 'second?', stdin: second.stdin, stdout: second.stdout }),
    /TUI prompt already active/,
  )

  await feed(first.stdin, ['y'])
  assert.equal(await promise, true)
})

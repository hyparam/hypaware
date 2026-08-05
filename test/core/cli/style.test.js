// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { ANSI, colorizeStderr, paintChunk, paintLine } from '../../../src/core/cli/style.js'

// The CLI severity palette (LLP 0189). Colour is applied once, where
// `dispatch` binds stderr, so these tests pin two things: which leading word
// means which colour, and that a stream which should not be coloured comes
// back byte-identical.

/** A stderr-shaped sink. `isTTY` decides whether `colorizeStderr` wraps it. */
function fakeStream(isTTY) {
  /** @type {string[]} */
  const chunks = []
  return {
    isTTY,
    columns: 80,
    chunks,
    /** @param {string} s */
    write(s) {
      chunks.push(s)
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}

const RED = ANSI.red
const YELLOW = ANSI.yellow
const DIM = ANSI.dim
const OFF = ANSI.reset

// Literal escape codes, deliberately NOT bound from the module under test:
// every other assertion here reads RED/YELLOW/DIM off `ANSI`, so swapping
// two palette values would repaint the whole CLI while this file stayed
// green. These three pin the actual bytes.
// @ref LLP 0189#palette [tests]: the palette bytes themselves, pinned literally
test('the palette maps severities to the standard SGR codes, pinned as bytes', () => {
  assert.equal(paintLine('error: x'), '\x1b[31merror:\x1b[0m x')
  assert.equal(paintLine('warning: x'), '\x1b[33mwarning:\x1b[0m x')
  assert.equal(paintLine('note: x'), '\x1b[2mnote:\x1b[0m x')
})

// @ref LLP 0189#rules [tests]: ordered first-match, not best-match
test('rule order is observable: the continuation rule outranks failed: on an indented line', () => {
  // '  attach claude failed: boom' matches BOTH the continuation rule and
  // the failed: rule (`[^:]*` happily eats the leading spaces), so only
  // the ordering keeps it plain. Hoisting the failed: rule to the top of
  // RULES paints this line red and fails here - the mutation the previous
  // version of this test could not see.
  assert.equal(paintLine('  attach claude failed: boom'), '  attach claude failed: boom')
})

// @ref LLP 0189#rules [tests]: every rule's `^` is load-bearing, not decoration
test('a severity word mid-line is not a prefix, so the line stays plain', () => {
  // `paintLine` paints `match[1]` and then slices that many characters off
  // the *front* of the line, so a rule that matched anywhere but index 0
  // would eat unrelated leading text instead of colouring the word it found:
  // dropping the `^` from /^(error:)/i turns the first line below into
  // '\x1b[31merror:\x1b[0mg config error: EACCES' - 'readin' gone.
  // One line per anchored rule, each shaped so that only an unanchored
  // version of that rule can match it. Plain strings on both sides, so these
  // stay true whatever the palette says.
  assert.equal(paintLine('reading config error: EACCES'), 'reading config error: EACCES')
  assert.equal(paintLine('logged one warning: none fatal'), 'logged one warning: none fatal')
  assert.equal(paintLine('see the note: at the end'), 'see the note: at the end')
  assert.equal(paintLine('and a tip: too'), 'and a tip: too')
  assert.equal(paintLine('print usage: on a bad flag'), 'print usage: on a bad flag')
  assert.equal(paintLine('then run hyp status: it explains'), 'then run hyp status: it explains')
  // A ':' before 'failed:' is what keeps the anchored `[^:]*` from reaching
  // it, so this line exercises the anchor rather than the character class.
  assert.equal(paintLine('restart: the stop step failed: EBUSY'), 'restart: the stop step failed: EBUSY')
})

test('errors are red and warnings are yellow', () => {
  assert.equal(paintLine('error: could not write /tmp/x'), `${RED}error:${OFF} could not write /tmp/x`)
  assert.equal(paintLine('warning: sink not materialized'), `${YELLOW}warning:${OFF} sink not materialized`)
})

test('the shouted and thrown spellings classify the same as the lowercase ones', () => {
  // `WARNING:` is the plugin-install confirmation's spelling for broad
  // permissions and unpinned branches - the warnings that most need yellow.
  assert.equal(paintLine('WARNING: plugin requests broad permissions: network'),
    `${YELLOW}WARNING:${OFF} plugin requests broad permissions: network`)
  // `Error:` reaches stderr from a thrown exception's own message.
  assert.equal(paintLine('Error: boom'), `${RED}Error:${OFF} boom`)
})

test('note, tip and usage are dim, not coloured', () => {
  assert.equal(paintLine('note: --org is ignored with a static token'),
    `${DIM}note:${OFF} --org is ignored with a static token`)
  assert.equal(paintLine('tip: purge that exact spelling too'), `${DIM}tip:${OFF} purge that exact spelling too`)
  assert.equal(paintLine('usage: hyp remote add <name> <url>'), `${DIM}usage:${OFF} hyp remote add <name> <url>`)
})

test('a `hyp <cmd>:` diagnostic is red, at every depth of subcommand', () => {
  assert.equal(paintLine("hyp: unknown command 'wat'"), `${RED}hyp:${OFF} unknown command 'wat'`)
  assert.equal(paintLine('hyp init: unknown flag'), `${RED}hyp init:${OFF} unknown flag`)
  assert.equal(paintLine('hyp report publish: no such file or directory: /x'),
    `${RED}hyp report publish:${OFF} no such file or directory: /x`)
})

test('a cancellation is not an error', () => {
  // Non-zero exit, but the user chose it; red would claim something broke.
  assert.equal(paintLine('hyp init: cancelled'), 'hyp init: cancelled')
})

test('`... failed:` diagnostics without a hyp prefix are red too', () => {
  assert.equal(paintLine('daemon restart failed: no such service'),
    `${RED}daemon restart failed:${OFF} no such service`)
  assert.equal(paintLine('Joining failed: an admin needs to grant access'),
    `${RED}Joining failed:${OFF} an admin needs to grant access`)
})

test('only the prefix is painted, never the message body', () => {
  const line = paintLine('error: could not write /a/b: EACCES')
  assert.equal(line.indexOf(OFF), RED.length + 'error:'.length)
  assert.equal(line.slice(line.indexOf(OFF) + OFF.length), ' could not write /a/b: EACCES')
})

test('continuation lines keep the severity of the line above by staying plain', () => {
  assert.equal(paintLine('  → this host has not joined a fleet'), '  → this host has not joined a fleet')
  assert.equal(paintLine('  repair: add {"name": "x"} to plugins[]'), '  repair: add {"name": "x"} to plugins[]')
  assert.equal(paintLine('  expected one of: a, b'), '  expected one of: a, b')
})

test('unclassified output is left alone rather than guessed at', () => {
  assert.equal(paintLine('waiting for the daemon to attach clients (up to 30s)'),
    'waiting for the daemon to attach clients (up to 30s)')
  assert.equal(paintLine('[hypaware:cmd-dispatch] INFO command.run {}'),
    '[hypaware:cmd-dispatch] INFO command.run {}')
  assert.equal(paintLine(''), '')
})

test('every line of a multi-line chunk is classified', () => {
  const out = paintChunk('error: a\nwarning: b\n', true)
  assert.equal(out, `${RED}error:${OFF} a\n${YELLOW}warning:${OFF} b\n`)
})

test('a chunk that resumes mid-line is not re-classified as a new diagnostic', () => {
  // `error: ` here is the tail of a sentence the previous write started, not
  // a fresh prefix.
  assert.equal(paintChunk('error: still the same line\n', false), 'error: still the same line\n')
})

test('a non-TTY stream is returned untouched, byte for byte', () => {
  const sink = fakeStream(false)
  const wrapped = colorizeStderr(sink, {})
  assert.equal(wrapped, sink)
  wrapped.write('error: plain\n')
  assert.equal(sink.text(), 'error: plain\n')
})

test('NO_COLOR wins over a TTY', () => {
  const sink = fakeStream(true)
  const wrapped = colorizeStderr(sink, { NO_COLOR: '1' })
  assert.equal(wrapped, sink)
  wrapped.write('error: plain\n')
  assert.equal(sink.text(), 'error: plain\n')
})

test('a TTY stream is wrapped, and paints across separate writes', () => {
  const sink = fakeStream(true)
  const wrapped = colorizeStderr(sink, {})
  wrapped.write('error: one\n')
  wrapped.write('warning: two\n')
  assert.equal(sink.text(), `${RED}error:${OFF} one\n${YELLOW}warning:${OFF} two\n`)
})

test('a write that does not end in a newline leaves the next write mid-line', () => {
  const sink = fakeStream(true)
  const wrapped = colorizeStderr(sink, {})
  wrapped.write('note: ')
  wrapped.write('error: not a new diagnostic\n')
  assert.equal(sink.text(), `${DIM}note:${OFF} error: not a new diagnostic\n`)
})

test('the wrap preserves the rest of the stream surface', () => {
  // `isTty(stderr)` gates the plugin-install prompt, and the TUI reads
  // `columns`. A wrap that hid either would silently degrade them.
  const sink = fakeStream(true)
  const wrapped = colorizeStderr(sink, {})
  assert.equal(wrapped.isTTY, true)
  assert.equal(wrapped.columns, 80)
})

test('non-string chunks pass through unexamined', () => {
  const sink = fakeStream(true)
  const wrapped = colorizeStderr(sink, {})
  const buf = Buffer.from('error: raw bytes\n')
  wrapped.write(/** @type {any} */ (buf))
  assert.equal(sink.chunks[0], buf)
})

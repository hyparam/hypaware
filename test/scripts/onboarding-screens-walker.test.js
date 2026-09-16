// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { Terminal } from '../../scripts/onboarding-screens/terminal.js'
import { choicesFor, parsePrompt } from '../../scripts/onboarding-screens/driver.js'

test('terminal replays a redraw the way the TUI runtime draws one', () => {
  const t = new Terminal(80)
  t.write('intro\r\n')
  t.write('\x1b[?25l')
  t.write('title\nup/down · enter pick · esc cancel\n\n> One\n  Two\n')
  // The runtime moves up over the previous frame and clears to the end.
  t.write('\x1b[5A\r\x1b[J')
  t.write('title\nup/down · enter pick · esc cancel\n\n  One\n> Two\n')
  t.write('\x1b[?25h')
  assert.deepEqual(t.lines(), ['intro', 'title', 'up/down · enter pick · esc cancel', '', '  One', '> Two', ''])
})

test('terminal soft-wraps at the column count and rewrites a spinner line in place', () => {
  const t = new Terminal(10)
  t.write('abcdefghijkl\n')
  assert.deepEqual(t.lines().slice(0, 2), ['abcdefghij', 'kl'])
  const s = new Terminal(40)
  s.write('⠋ Waiting... (1s)')
  s.write('\r\x1b[2K⠙ Waiting... (2s)')
  assert.equal(s.text(), '⠙ Waiting... (2s)')
})

test('parsePrompt reads a select with its position line and cursor', () => {
  const lines = [
    'earlier output',
    'Step 2 of 5 · Choose what to collect',
    'What now?',
    'up/down · enter pick · esc back',
    '',
    '  First',
    '    a summary',
    '> Second',
    '',
  ]
  const p = parsePrompt(lines)
  assert.ok(p)
  assert.equal(p.kind, 'select')
  assert.equal(p.title, 'What now?')
  assert.equal(p.progress, 'Step 2 of 5 · Choose what to collect')
  assert.equal(p.allowBack, true)
  assert.equal(p.cursor, 1)
  assert.deepEqual(p.options.map((o) => o.label), ['First', 'Second'])
  const choices = choicesFor(p)
  assert.deepEqual(choices.map((c) => c.label), ['First', 'Second', 'esc back'])
  assert.deepEqual(choices[0].keys, ['\x1b[A', '\r'])
  assert.deepEqual(choices[1].keys, ['\r'])
})

test('parsePrompt reads a checklist, a boxed select, and a y/n line', () => {
  const multi = parsePrompt([
    'What do you want to collect?',
    'space toggle · a all · enter confirm · esc back',
    '',
    '> [x] Claude Code · detected',
    '      Records your Claude Code conversations.',
    '  [ ] OpenTelemetry',
    '',
    '  [ Submit ]',
  ])
  assert.ok(multi)
  assert.equal(multi.kind, 'multiselect')
  assert.deepEqual(multi.options.map((o) => [o.label, o.checked]), [['Claude Code · detected', true], ['OpenTelemetry', false]])
  assert.deepEqual(choicesFor(multi).map((c) => c.label), ['enter (keep defaults)', 'esc back'])

  const boxed = parsePrompt([
    'first look output',
    '┌──────────────────────────────────┐',
    '│ Suggest a skill?                 │',
    '│ up/down · enter pick · esc cancel│',
    '│                                  │',
    '│ > Yes                            │',
    '│   No                             │',
    '└──────────────────────────────────┘',
  ])
  assert.ok(boxed)
  assert.equal(boxed.kind, 'select')
  assert.equal(boxed.title, 'Suggest a skill?')
  assert.deepEqual(boxed.options.map((o) => o.label), ['Yes', 'No'])

  const line = parsePrompt(['This config will be rewritten.', '', 'Continue? [Y/n]: '])
  assert.ok(line)
  assert.equal(line.kind, 'line')
  assert.equal(line.title, 'Continue?')
  assert.equal(line.hint, 'Y/n')
  assert.deepEqual(choicesFor(line).map((c) => c.keys.join('')), ['y\r', 'n\r'])

  assert.equal(parsePrompt(['plain output', 'still running...']), null)
})

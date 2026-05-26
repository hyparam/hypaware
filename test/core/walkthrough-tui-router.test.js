// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { shouldUseTui, isTty } from '../../src/core/cli/tui-router.js'

/**
 * @param {boolean} isTtyValue
 */
function makeStream(isTtyValue) {
  const s = new PassThrough()
  if (isTtyValue) {
    Object.defineProperty(s, 'isTTY', { value: true })
  }
  return s
}

/**
 * Restore HYP_NO_TUI after each scenario regardless of throw/return.
 *
 * @param {string | undefined} value
 * @param {() => void} fn
 */
function withHypNoTui(value, fn) {
  const prev = process.env.HYP_NO_TUI
  try {
    if (value === undefined) delete process.env.HYP_NO_TUI
    else process.env.HYP_NO_TUI = value
    fn()
  } finally {
    if (prev === undefined) delete process.env.HYP_NO_TUI
    else process.env.HYP_NO_TUI = prev
  }
}

test('shouldUseTui returns true when stdin and stdout are TTYs and HYP_NO_TUI unset', () => {
  withHypNoTui(undefined, () => {
    const stdin = makeStream(true)
    const stdout = makeStream(true)
    assert.equal(shouldUseTui({ stdin, stdout }), true)
  })
})

test('shouldUseTui returns false when HYP_NO_TUI=1 even with both TTYs', () => {
  withHypNoTui('1', () => {
    const stdin = makeStream(true)
    const stdout = makeStream(true)
    assert.equal(shouldUseTui({ stdin, stdout }), false)
  })
})

test('shouldUseTui returns false when stdin is non-TTY', () => {
  withHypNoTui(undefined, () => {
    const stdin = makeStream(false)
    const stdout = makeStream(true)
    assert.equal(shouldUseTui({ stdin, stdout }), false)
  })
})

test('shouldUseTui returns false when stdout is non-TTY', () => {
  withHypNoTui(undefined, () => {
    const stdin = makeStream(true)
    const stdout = makeStream(false)
    assert.equal(shouldUseTui({ stdin, stdout }), false)
  })
})

test('shouldUseTui returns false when stdout is a duck-typed write sink (no isTTY)', () => {
  withHypNoTui(undefined, () => {
    const stdin = makeStream(true)
    const stdout = { write: () => true }
    assert.equal(shouldUseTui({ stdin, stdout }), false)
  })
})

test('shouldUseTui falls back to process.stdin when opts.stdin is omitted', () => {
  withHypNoTui(undefined, () => {
    // process.stdin in a `node --test` child rarely reports isTTY=true, so
    // the router must treat that as the legacy path.
    const stdout = makeStream(true)
    assert.equal(shouldUseTui({ stdout }), !!(/** @type {{ isTTY?: boolean }} */ (process.stdin).isTTY))
  })
})

test('shouldUseTui treats HYP_NO_TUI=0 as not-set (only the literal "1" disables)', () => {
  withHypNoTui('0', () => {
    const stdin = makeStream(true)
    const stdout = makeStream(true)
    assert.equal(shouldUseTui({ stdin, stdout }), true)
  })
})

test('shouldUseTui honors opts.env over process.env when both are set', () => {
  withHypNoTui(undefined, () => {
    const stdin = makeStream(true)
    const stdout = makeStream(true)
    // process.env says yes-to-TUI but injected env says no.
    assert.equal(shouldUseTui({ stdin, stdout, env: { HYP_NO_TUI: '1' } }), false)
  })
})

test('shouldUseTui ignores process.env.HYP_NO_TUI when opts.env is supplied without it', () => {
  withHypNoTui('1', () => {
    const stdin = makeStream(true)
    const stdout = makeStream(true)
    // process.env says no-TUI, but the injected env that overrides it
    // doesn't carry HYP_NO_TUI, so the TUI path should win.
    assert.equal(shouldUseTui({ stdin, stdout, env: {} }), true)
  })
})

test('isTty rejects undefined, null, and primitives', () => {
  assert.equal(isTty(undefined), false)
  assert.equal(isTty(null), false)
  assert.equal(isTty('stdout'), false)
  assert.equal(isTty(0), false)
})

test('isTty accepts only objects with isTTY === true (not truthy)', () => {
  assert.equal(isTty({ isTTY: true }), true)
  assert.equal(isTty({ isTTY: 1 }), false)
  assert.equal(isTty({ isTTY: false }), false)
  assert.equal(isTty({}), false)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createWarningLedger } from '../src/warning_ledger.js'

test('createWarningLedger: emits the first warning for a provider+cause pair', () => {
  const emitted = []
  const ledger = createWarningLedger({ emit: (record) => emitted.push(record) })

  const wasEmitted = ledger.warn({ provider: 'anthropic-vertex', cause: 'deferred', session: 'sess-1' })

  assert.equal(wasEmitted, true)
  assert.equal(emitted.length, 1)
  assert.deepEqual(emitted[0], {
    component: 'openclaw-steering-plugin',
    operation: 'before_model_resolve',
    status: 'uncaptured',
    provider: 'anthropic-vertex',
    cause: 'deferred',
    session: 'sess-1',
  })
})

test('createWarningLedger: suppresses a repeat within the window, keyed by provider+cause', () => {
  const emitted = []
  let now = 0
  const ledger = createWarningLedger({ emit: (r) => emitted.push(r), now: () => now, windowMs: 1000 })

  assert.equal(ledger.warn({ provider: 'anthropic', cause: 'no_credential' }), true)
  now = 500
  assert.equal(ledger.warn({ provider: 'anthropic', cause: 'no_credential' }), false)
  assert.equal(emitted.length, 1)
})

test('createWarningLedger: re-emits once the window elapses', () => {
  const emitted = []
  let now = 0
  const ledger = createWarningLedger({ emit: (r) => emitted.push(r), now: () => now, windowMs: 1000 })

  assert.equal(ledger.warn({ provider: 'anthropic', cause: 'no_credential' }), true)
  now = 1000
  assert.equal(ledger.warn({ provider: 'anthropic', cause: 'no_credential' }), true)
  assert.equal(emitted.length, 2)
})

test('createWarningLedger: a different cause for the same provider is a distinct key', () => {
  const emitted = []
  const ledger = createWarningLedger({ emit: (r) => emitted.push(r) })

  ledger.warn({ provider: 'anthropic', cause: 'no_credential' })
  ledger.warn({ provider: 'anthropic', cause: 'no_preset' })

  assert.equal(emitted.length, 2)
})

test('createWarningLedger: a different provider for the same cause is a distinct key', () => {
  const emitted = []
  const ledger = createWarningLedger({ emit: (r) => emitted.push(r) })

  ledger.warn({ provider: 'anthropic', cause: 'no_preset' })
  ledger.warn({ provider: 'openai', cause: 'no_preset' })

  assert.equal(emitted.length, 2)
})

test('createWarningLedger: defaults to console.warn when no emit is supplied', () => {
  const original = console.warn
  const calls = []
  console.warn = (...args) => calls.push(args)
  try {
    const ledger = createWarningLedger()
    ledger.warn({ provider: 'anthropic', cause: 'no_preset' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], '[hypaware-openclaw-steering] uncaptured provider turn')
  } finally {
    console.warn = original
  }
})

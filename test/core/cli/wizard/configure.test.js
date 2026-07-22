// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { runConfigurePhase } from '../../../../src/core/cli/wizard/configure.js'

// The wizard configure phase (LLP 0135 #configure, LLP 0131). Each picked
// `needs_setup` descriptor's `configure_command` runs one at a time
// through the `ctx.commands.run` seam (LLP 0130 #configure-command); a
// non-zero exit or a throw drops that source with a printed catch-up hint
// and the phase continues with the rest.
// @ref LLP 0131#drop-on-failure [tests]:
// @ref LLP 0131#attended-only [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * A fake `ctx.commands.run` recording every invocation. `plan` maps a
 * command name to either a number (its exit code) or an Error to throw.
 * @param {Record<string, number | Error>} plan
 */
function fakeCommands(plan) {
  /** @type {{ name: string, argv: string[] }[]} */
  const calls = []
  return {
    calls,
    ctx: {
      commands: {
        /** @param {string} name @param {string[]} argv */
        async run(name, argv) {
          calls.push({ name, argv })
          const outcome = plan[name]
          if (outcome instanceof Error) throw outcome
          return typeof outcome === 'number' ? outcome : 0
        },
      },
    },
  }
}

/**
 * @param {Partial<import('../../../../src/core/types.js').PickerDescriptor>} over
 */
function descriptor(over = {}) {
  return /** @type {any} */ ({
    plugin: '@hypaware/claude-desktop',
    id: 'claude-desktop',
    label: 'Claude Desktop',
    needsSetup: true,
    configureCommand: 'claude-desktop install',
    ...over,
  })
}

// --- success branch ---

test('runConfigurePhase: a zero exit keeps the source and records ok', async () => {
  const stdout = makeBuf()
  const { calls, ctx } = fakeCommands({ 'claude-desktop install': 0 })
  const out = await runConfigurePhase(
    { descriptors: [descriptor()] },
    /** @type {any} */ ({ stdout, ctx })
  )
  assert.deepEqual(out.results, [{ id: 'claude-desktop', ok: true, exitCode: 0 }])
  assert.deepEqual(calls, [{ name: 'claude-desktop install', argv: [] }])
  assert.match(stdout.text(), /Setting up Claude Desktop/)
  assert.doesNotMatch(stdout.text(), /Finish later/)
})

test('runConfigurePhase: only needs_setup descriptors with a configure_command run', async () => {
  const stdout = makeBuf()
  const { calls, ctx } = fakeCommands({ 'claude-desktop install': 0 })
  const out = await runConfigurePhase(
    {
      descriptors: [
        descriptor(),
        descriptor({ id: 'claude', label: 'Claude Code', needsSetup: false, configureCommand: undefined }),
        descriptor({ id: 'no-cmd', label: 'No Command', needsSetup: true, configureCommand: undefined }),
      ],
    },
    /** @type {any} */ ({ stdout, ctx })
  )
  assert.deepEqual(out.results, [{ id: 'claude-desktop', ok: true, exitCode: 0 }])
  assert.deepEqual(calls.map((c) => c.name), ['claude-desktop install'])
})

// --- drop-on-nonzero-exit branch ---

test('runConfigurePhase: a non-zero exit drops the source and prints the catch-up hint', async () => {
  const stdout = makeBuf()
  const { ctx } = fakeCommands({ 'claude-desktop install': 3 })
  const out = await runConfigurePhase(
    { descriptors: [descriptor()] },
    /** @type {any} */ ({ stdout, ctx })
  )
  assert.deepEqual(out.results, [{ id: 'claude-desktop', ok: false, exitCode: 3 }])
  assert.match(stdout.text(), /Finish later with `hyp claude-desktop install`/)
})

test('runConfigurePhase: a drop does not abort the phase; later sources still run', async () => {
  const stdout = makeBuf()
  const { calls, ctx } = fakeCommands({ 'a setup': 1, 'b setup': 0 })
  const out = await runConfigurePhase(
    {
      descriptors: [
        descriptor({ id: 'a', label: 'A', configureCommand: 'a setup' }),
        descriptor({ id: 'b', label: 'B', configureCommand: 'b setup' }),
      ],
    },
    /** @type {any} */ ({ stdout, ctx })
  )
  assert.deepEqual(out.results, [
    { id: 'a', ok: false, exitCode: 1 },
    { id: 'b', ok: true, exitCode: 0 },
  ])
  assert.deepEqual(calls.map((c) => c.name), ['a setup', 'b setup'])
})

// --- drop-on-throw branch ---

test('runConfigurePhase: a thrown configure drops the source without rethrowing', async () => {
  const stdout = makeBuf()
  const { ctx } = fakeCommands({ 'claude-desktop install': new Error('sudo bailed') })
  const out = await runConfigurePhase(
    { descriptors: [descriptor()] },
    /** @type {any} */ ({ stdout, ctx })
  )
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].id, 'claude-desktop')
  assert.equal(out.results[0].ok, false)
  assert.match(String(out.results[0].error), /sudo bailed/)
  assert.match(stdout.text(), /Finish later with `hyp claude-desktop install`/)
})

// --- --print-commands passthrough ---

test('runConfigurePhase: --print-commands threads onto the invoked command argv', async () => {
  const stdout = makeBuf()
  const { calls, ctx } = fakeCommands({ 'claude-desktop install': 0 })
  await runConfigurePhase(
    { descriptors: [descriptor()] },
    /** @type {any} */ ({ stdout, ctx, printCommands: true })
  )
  assert.deepEqual(calls, [{ name: 'claude-desktop install', argv: ['--print-commands'] }])
})

// --- attended-only guard ---

test('runConfigurePhase: never runs off a non-interactive opts.picks path', async () => {
  const stdout = makeBuf()
  const { calls, ctx } = fakeCommands({ 'claude-desktop install': 0 })
  const out = await runConfigurePhase(
    { descriptors: [descriptor()] },
    /** @type {any} */ ({ stdout, ctx, picks: {} })
  )
  assert.deepEqual(out.results, [])
  assert.deepEqual(calls, [])
  assert.equal(stdout.text(), '')
})

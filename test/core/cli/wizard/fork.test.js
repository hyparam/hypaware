// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  buildForkOptions,
  buildReturningGateOptions,
  evaluateReturningGate,
  legacyForkPrompt,
  legacyReturningGatePrompt,
  runWizardFork,
} from '../../../../src/core/cli/wizard/fork.js'

// The wizard fork phase (LLP 0129 #fork) and the returning gate
// (LLP 0129 #returning-gate, amended by LLP 0182 to one Reconfigure for
// every machine). Both prompts drive the legacy readline fallback here
// (HYP_NO_TUI=1 / non-TTY stdout), matching the pattern
// `test/core/init-configured-entry.test.js` already uses for the
// pre-amendment gate.
// @ref LLP 0129#fork [tests]:
// @ref LLP 0182#one-reconfigure [tests]:

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/** @param {string} input */
function ctxWithStdin(input) {
  const stdout = /** @type {any} */ (makeBuf())
  return {
    opts: /** @type {any} */ ({
      stdin: Readable.from([input]),
      stdout,
      stderr: makeBuf(),
      env: { HYP_NO_TUI: '1' },
    }),
    stdout,
  }
}

/**
 * @param {{ configExists?: boolean, configValid?: boolean, hasCentral?: boolean }} over
 */
function fixtureReport(over = {}) {
  const { configExists = true, configValid = true, hasCentral = false } = over
  return /** @type {any} */ ({
    configExists,
    configValid,
    layered: hasCentral
      ? { hasCentral: true, centralPlugins: [], centralSinks: [], drops: [], centralQueryIgnored: false }
      : null,
  })
}

// --- runWizardFork / buildForkOptions ---

test('buildForkOptions: team, local, quit, in that order', () => {
  const values = buildForkOptions().map((o) => o.value)
  assert.deepEqual(values, ['team', 'local', 'quit'])
})

test('runWizardFork: a bare enter takes the default (quit)', async () => {
  const { opts, stdout } = ctxWithStdin('\n')
  const choice = await runWizardFork(opts)
  assert.equal(choice, 'quit')
  assert.match(stdout.text(), /1\) Join a team/)
  assert.match(stdout.text(), /2\) Local install and configuration/)
  assert.match(stdout.text(), /3\) Quit/)
})

test('runWizardFork: choosing 1 forks to the team pathway', async () => {
  const { opts } = ctxWithStdin('1\n')
  const choice = await runWizardFork(opts)
  assert.equal(choice, 'team')
})

test('runWizardFork: choosing 2 forks to the local pathway', async () => {
  const { opts } = ctxWithStdin('2\n')
  const choice = await runWizardFork(opts)
  assert.equal(choice, 'local')
})

test('runWizardFork: an out-of-range answer quits rather than guessing', async () => {
  const { opts } = ctxWithStdin('9\n')
  const choice = await runWizardFork(opts)
  assert.equal(choice, 'quit')
})

test('legacyForkPrompt: matches runWizardFork on the same input (direct call, no TUI routing)', async () => {
  const { opts } = ctxWithStdin('1\n')
  const choice = await legacyForkPrompt(opts, buildForkOptions())
  assert.equal(choice, 'team')
})

// --- buildReturningGateOptions ---

// One menu for both machine kinds (LLP 0182): the builder takes no
// `managed` argument at all, so there is no branch left to drift.
test('buildReturningGateOptions: one Reconfigure, the same three rows for every machine', () => {
  const values = buildReturningGateOptions().map((o) => o.value)
  assert.deepEqual(values, ['reconfigure', 'status', 'quit'])
  assert.equal(buildReturningGateOptions.length, 0)
})

// --- evaluateReturningGate ---

test('evaluateReturningGate: no config yet is the first-run path, not the gate', async () => {
  const { opts } = ctxWithStdin('\n')
  opts.collectStatus = async () => fixtureReport({ configExists: false })
  const gate = await evaluateReturningGate(opts)
  assert.equal(gate.action, 'first-run')
  assert.equal(gate.managed, false)
})

test('evaluateReturningGate: an invalid config is also first-run', async () => {
  const { opts } = ctxWithStdin('\n')
  opts.collectStatus = async () => fixtureReport({ configValid: false })
  const gate = await evaluateReturningGate(opts)
  assert.equal(gate.action, 'first-run')
})

// A central layer that stops merging cleanly (a server-side config change,
// client/server schema drift) must not relabel the machine as unmanaged:
// the caller reads `managed` to decide whether to lock the org's rows, and
// an editable org row composes into the local layer.
// @ref LLP 0129#join-before-picker [tests]:
test('evaluateReturningGate: a managed machine with an invalid config is still managed on the first-run path', async () => {
  const { opts } = ctxWithStdin('\n')
  opts.collectStatus = async () => fixtureReport({ configValid: false, hasCentral: true })
  const gate = await evaluateReturningGate(opts)
  assert.equal(gate.action, 'first-run')
  assert.equal(gate.managed, true)
})

// Defensive coverage of the guard's *other* branch, not a state the
// collector emits: `collectHypAwareStatus` sets `configExists` from a
// non-null effective config, and `mergeConfigLayers` always returns one
// once a central layer loaded, so on a real machine `hasCentral` implies
// `configExists`. Pinned so a future rewrite of the `||` cannot make
// `managed` depend on `configExists` again.
test('evaluateReturningGate: a managed machine with no config at all is still managed', async () => {
  const { opts } = ctxWithStdin('\n')
  opts.collectStatus = async () => fixtureReport({ configExists: false, hasCentral: true })
  const gate = await evaluateReturningGate(opts)
  assert.equal(gate.action, 'first-run')
  assert.equal(gate.managed, true)
})

test('evaluateReturningGate: managed machine, Reconfigure is the same row it is on a solo machine', async () => {
  const { opts, stdout } = ctxWithStdin('1\n')
  opts.collectStatus = async () => fixtureReport({ hasCentral: true })
  const gate = await evaluateReturningGate(opts)
  assert.equal(gate.action, 'reconfigure')
  // Still reported: the orchestrator locks the org's picker rows off it.
  assert.equal(gate.managed, true)
  assert.match(stdout.text(), /1\) Reconfigure/)
  assert.doesNotMatch(stdout.text(), /Adjust/)
})

test('evaluateReturningGate: managed machine, a bare enter still quits (never reconfigures by accident)', async () => {
  const { opts } = ctxWithStdin('\n')
  opts.collectStatus = async () => fixtureReport({ hasCentral: true })
  const gate = await evaluateReturningGate(opts)
  assert.equal(gate.action, 'quit')
})

test('evaluateReturningGate: solo machine, Reconfigure re-enters the full fork', async () => {
  const { opts, stdout } = ctxWithStdin('1\n')
  opts.collectStatus = async () => fixtureReport({ hasCentral: false })
  const gate = await evaluateReturningGate(opts)
  assert.equal(gate.action, 'reconfigure')
  assert.equal(gate.managed, false)
  assert.match(stdout.text(), /1\) Reconfigure/)
})

test('evaluateReturningGate: solo machine, a bare enter takes the default (quit)', async () => {
  const { opts } = ctxWithStdin('\n')
  opts.collectStatus = async () => fixtureReport({ hasCentral: false })
  const gate = await evaluateReturningGate(opts)
  assert.equal(gate.action, 'quit')
})

test('evaluateReturningGate: either machine kind can still choose status', async () => {
  const managed = ctxWithStdin('2\n')
  managed.opts.collectStatus = async () => fixtureReport({ hasCentral: true })
  assert.equal((await evaluateReturningGate(managed.opts)).action, 'status')

  const solo = ctxWithStdin('2\n')
  solo.opts.collectStatus = async () => fixtureReport({ hasCentral: false })
  assert.equal((await evaluateReturningGate(solo.opts)).action, 'status')
})

test('legacyReturningGatePrompt: default title is the plain "what would you like to do" prompt', async () => {
  const { opts, stdout } = ctxWithStdin('\n')
  const choice = await legacyReturningGatePrompt(opts, buildReturningGateOptions())
  assert.equal(choice, 'quit')
  assert.match(stdout.text(), /What would you like to do\?/)
})

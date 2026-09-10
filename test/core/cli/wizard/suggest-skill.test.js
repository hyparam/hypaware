// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'

import { runWizardSuggestSkill } from '../../../../src/core/cli/wizard/suggest_skill.js'

const VERB = /Run `hyp ask` any time: HypAware suggests the one skill worth adding first/

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * A child that exits with `code` once its handlers are wired, or fails to
 * start when `code` is null.
 * @param {number | null} code
 */
function childExiting(code) {
  /** @type {{ cmd: string, args: string[], opts: any }[]} */
  const calls = []
  return {
    calls,
    fn: /** @type {any} */ ((/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
      calls.push({ cmd, args, opts })
      /** @type {Record<string, (arg: any) => void>} */
      const handlers = {}
      queueMicrotask(() => {
        if (code === null) handlers.error?.(new Error('ENOENT'))
        else handlers.close?.(code)
      })
      return { on: (/** @type {string} */ event, /** @type {any} */ fn) => { handlers[event] = fn } }
    }),
  }
}

test('runWizardSuggestSkill: an empty cache states why there is nothing to suggest yet', async () => {
  // @ref LLP 0198#empty-cache [tests]: no rows means no launch, and the reason is stated
  const stdout = makeBuf()
  const child = childExiting(0)
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, hasRows: false,
    confirm: async () => 'yes', spawnFn: child.fn,
  })
  assert.deepEqual(result, { asked: false, reason: 'no-rows' })
  assert.equal(child.calls.length, 0)
  assert.match(stdout.text(), /Nothing recorded yet: HypAware captures from your next session onward/)
  assert.match(stdout.text(), /Once you have some history, run `hyp ask`/)
})

test('runWizardSuggestSkill: a run that cannot prompt names the verb and starts nothing', async () => {
  const stdout = makeBuf()
  const child = childExiting(0)
  // No confirm seam and a buffer for stdout: not a terminal on either end.
  const result = await runWizardSuggestSkill({ stdout, env: {}, interactive: true, spawnFn: child.fn })
  assert.deepEqual(result, { asked: false, reason: 'not-interactive' })
  assert.equal(child.calls.length, 0)
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: interactive false never asks, even with a prompt seam', async () => {
  const stdout = makeBuf()
  let asked = 0
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: false,
    confirm: async () => { asked += 1; return 'yes' },
  })
  assert.deepEqual(result, { asked: false, reason: 'not-interactive' })
  assert.equal(asked, 0)
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: yes runs `hyp ask` as a child that inherits the terminal', async () => {
  // @ref LLP 0398#setup-offer [tests]: the offer taken is the ask itself
  const stdout = makeBuf()
  const child = childExiting(0)
  /** @type {any} */
  let question
  const result = await runWizardSuggestSkill({
    stdout, env: { HYP_HOME: '/h' }, interactive: true, hasRows: true,
    confirm: async (q) => { question = q; return 'yes' },
    spawnFn: child.fn,
  })
  assert.deepEqual(result, { asked: true, launched: true })
  assert.equal(question.title, 'Would you like HypAware to suggest a skill?')
  assert.equal(question.default, 'yes')
  // The default acts, so a spent stdin must decline (LLP 0299 #eof-declines).
  assert.equal(question.eofValue, 'no')
  assert.equal(child.calls.length, 1)
  assert.equal(child.calls[0].cmd, process.execPath)
  assert.equal(child.calls[0].args.at(-1), 'ask')
  assert.equal(child.calls[0].opts.stdio, 'inherit')
  assert.equal(child.calls[0].opts.env.HYP_HOME, '/h')
  // The child owns the closing screen; nothing is added after it.
  assert.doesNotMatch(stdout.text(), VERB)
})

test('runWizardSuggestSkill: no names the verb and starts nothing', async () => {
  const stdout = makeBuf()
  const child = childExiting(0)
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, confirm: async () => 'no', spawnFn: child.fn,
  })
  assert.deepEqual(result, { asked: true, launched: false, reason: 'declined' })
  assert.equal(child.calls.length, 0)
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: a cancelled prompt is "not now", not a failed run', async () => {
  const stdout = makeBuf()
  const child = childExiting(0)
  const cancelled = Object.assign(new Error('cancelled'), { name: 'PromptCancelledError' })
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, confirm: async () => { throw cancelled }, spawnFn: child.fn,
  })
  assert.deepEqual(result, { asked: true, launched: false, reason: 'declined' })
  assert.equal(child.calls.length, 0)
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: a child that could not start degrades to the verb', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const result = await runWizardSuggestSkill({
    stdout, stderr, env: {}, interactive: true, confirm: async () => 'yes', spawnFn: childExiting(null).fn,
  })
  assert.deepEqual(result, { asked: true, launched: false, reason: 'spawn-failed' })
  assert.match(stderr.text(), /Could not start hyp ask: ENOENT/)
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: a child that exits non-zero has said why; only the verb is added', async () => {
  const stdout = makeBuf()
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, confirm: async () => 'yes', spawnFn: childExiting(1).fn,
  })
  assert.deepEqual(result, { asked: true, launched: false, reason: 'child-failed' })
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: an unforeseen throw is contained', async () => {
  const stdout = makeBuf()
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, confirm: async () => { throw new TypeError('boom') },
  })
  assert.deepEqual(result, { asked: false, reason: 'error' })
  assert.match(stdout.text(), VERB)
})

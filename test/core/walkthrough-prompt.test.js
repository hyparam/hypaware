// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { defaultPromptFactory, runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'

test('picker prompt prints context under source options and defaults export to local-parquet', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-walkthrough-prompt-'))
  const input = new PassThrough()
  // Only the source question is asked; export defaults to local-parquet
  // and retention takes its default without a prompt (LLP 0137).
  const stdout = answerDrivenOutput(input, ['3\n'])
  const stderr = makeBuf()

  const result = await runPickerWalkthrough({
    capabilities: /** @type {any} */ ({}),
    stdout,
    stderr,
    stdin: /** @type {any} */ (input),
    env: {
      HOME: tmp,
      HYP_HOME: path.join(tmp, '.hyp'),
    },
  })

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.sourcesPicked, ['raw-anthropic'])
  assert.equal(result.exportPicked, 'local-parquet')

  const text = stdout.text()
  assert.match(text, /3\) Anthropic API\n     For apps you manually point at HypAware/)
  // The export question is no longer rendered.
  assert.doesNotMatch(text, /keep local query cache only/)
  assert.doesNotMatch(text, /Where should HypAware export/)
  // Neither is the retention question (LLP 0137).
  assert.doesNotMatch(text, /Cache retention/)
  assert.equal(stderr.text(), '')
})

// The numbered fallback's checked-state opt-in (LLP 0190 #sync-gate): a
// question with `enterKeepsChecked` renders each row's [x]/[ ] state and a
// bare enter returns the checked values, matching the TUI multiselect's
// enter (disabled-checked rows included; callers filter locked rows
// regardless). Without the flag the historical semantics stand: no state
// rendered, bare enter selects nothing.
// @ref LLP 0190#sync-gate [tests]:

/** Mirrors the sync menu's shape: a locked lead row, then candidates. */
function syncMenuQuestion(/** @type {Record<string, unknown>} */ extra = {}) {
  return /** @type {any} */ ({
    pickType: 'clients',
    title: 'Choose what syncs - unchecked sources stay on this machine.',
    options: [
      { value: 'claude', label: 'capture claude · managed by your fleet', checked: true, disabled: true },
      { value: 'openclaw', label: 'capture openclaw', checked: true },
      { value: 'hermes', label: 'capture hermes' },
    ],
    allowBack: true,
    ...extra,
  })
}

/**
 * Ask one question through the real legacy prompt (non-TTY streams force
 * the fallback) with a single scripted answer line.
 *
 * @param {any} question
 * @param {string} answer
 */
async function askLegacy(question, answer) {
  const input = new PassThrough()
  let text = ''
  const stdout = {
    /** @param {string} chunk */
    write(chunk) {
      text += String(chunk)
      if (String(chunk).startsWith('select')) {
        input.write(answer)
        input.end()
      }
      return true
    },
  }
  const ask = defaultPromptFactory({ stdin: /** @type {any} */ (input), stdout: /** @type {any} */ (stdout), env: {} })
  const picked = await ask(question)
  return { picked, text }
}

test('enterKeepsChecked: the fallback renders the checked state and a bare enter keeps it', async () => {
  const { picked, text } = await askLegacy(syncMenuQuestion({ enterKeepsChecked: true }), '\n')

  assert.match(text, /1\) \[x\] capture claude · managed by your fleet \(locked\)/)
  assert.match(text, /2\) \[x\] capture openclaw/)
  assert.match(text, /3\) \[ \] capture hermes/)
  assert.match(text, /select \(e\.g\. 1,3, "all", enter keeps \[x\], or b to go back\): /)
  assert.deepEqual(picked, ['claude', 'openclaw'], 'enter returns the checked set, not none')
})

test('enterKeepsChecked: typed indices still replace the checked set', async () => {
  const { picked } = await askLegacy(syncMenuQuestion({ enterKeepsChecked: true }), '3\n')
  assert.deepEqual(picked, ['hermes'])
})

// A malformed answer ("y", "0", an out-of-range index) names no row, so
// it used to read as "select nothing" - in the sync menu that silently
// opted every candidate out. The opted-in question now says so and
// re-asks, but only once, and never waits on a stream that cannot
// answer: an endless pipe of garbage must terminate and EOF must
// resolve. Nothing else about the fallback moves.
// @ref LLP 0190#sync-gate [tests]:

/**
 * Ask one question through the real legacy prompt with the whole answer
 * script handed over in a single chunk, the way a pipe delivers it.
 * Readline emits every line of that chunk synchronously, so a re-ask
 * that registers its listener a microtask later would never see the
 * correction.
 *
 * @param {any} question
 * @param {string} chunk
 * @param {{ eof?: boolean }} [opts]
 */
async function askPiped(question, chunk, opts = {}) {
  const input = new PassThrough()
  let text = ''
  const stdout = {
    /** @param {string} c */
    write(c) {
      text += String(c)
      return true
    },
  }
  if (chunk) input.write(chunk)
  if (opts.eof !== false) input.end()
  const ask = defaultPromptFactory({ stdin: /** @type {any} */ (input), stdout: /** @type {any} */ (stdout), env: {} })
  const picked = await ask(question)
  input.end()
  return { picked, text }
}

/**
 * Answer every prompt with the same never-valid line, forever, and never
 * close the stream: the shape of `{ printf '2\n'; yes; } | hyp init`.
 * The prompt must stop asking on its own.
 *
 * @param {any} question
 * @param {string} answer
 */
async function askEndless(question, answer) {
  const input = new PassThrough()
  let prompts = 0
  let text = ''
  const stdout = {
    /** @param {string} c */
    write(c) {
      text += String(c)
      if (String(c).startsWith('select')) {
        prompts += 1
        // A real `yes` is unbounded; the test needs a fuse so a
        // regression fails loudly instead of hanging the suite.
        assert.ok(prompts <= 10, `the prompt re-asked ${prompts} times; it must be bounded`)
        input.write(answer)
      }
      return true
    },
  }
  const ask = defaultPromptFactory({ stdin: /** @type {any} */ (input), stdout: /** @type {any} */ (stdout), env: {} })
  const picked = await ask(question)
  input.end()
  return { picked, text, prompts }
}

test('enterKeepsChecked: an answer naming no row re-asks once, and a correction in the same chunk still wins', async () => {
  const { picked, text } = await askPiped(syncMenuQuestion({ enterKeepsChecked: true }), 'y\n3\n')

  assert.match(text, /nothing matched 'y' - enter numbers like 1,3, "all", or "none"/)
  assert.deepEqual(picked, ['hermes'], 'the correction delivered in the same chunk is not lost')
})

test('enterKeepsChecked: endless invalid input stops after one re-ask instead of looping', async () => {
  const { picked, prompts } = await askEndless(syncMenuQuestion({ enterKeepsChecked: true }), 'y\n')

  assert.equal(prompts, 2, 'one ask plus one re-ask, then the fallback')
  assert.deepEqual(picked, [], 'the historical empty selection stands once the budget is spent')
})

test('enterKeepsChecked: an invalid answer then EOF resolves with the checked defaults instead of hanging', async () => {
  const { picked } = await askPiped(syncMenuQuestion({ enterKeepsChecked: true }), 'y\n')

  assert.deepEqual(picked, ['claude', 'openclaw'], 'an unanswerable question takes the default, it does not wait')
})

test('EOF with no answer at all resolves on both paths', async () => {
  const kept = await askPiped(syncMenuQuestion({ enterKeepsChecked: true }), '')
  assert.deepEqual(kept.picked, ['claude', 'openclaw'])

  const none = await askPiped(syncMenuQuestion(), '')
  assert.deepEqual(none.picked, [], 'without the opt-in an unanswerable question is still none')
})

test('"none" is the explicit empty selection on both paths', async () => {
  const kept = await askPiped(syncMenuQuestion({ enterKeepsChecked: true }), 'none\n')
  assert.deepEqual(kept.picked, [])

  const plain = await askPiped(syncMenuQuestion(), 'none\n')
  assert.deepEqual(plain.picked, [])
})

test('enterKeepsChecked: a partially valid answer wins without a re-ask', async () => {
  const { picked, text } = await askPiped(syncMenuQuestion({ enterKeepsChecked: true }), '0,3\n')

  assert.deepEqual(picked, ['hermes'])
  assert.doesNotMatch(text, /nothing matched/)
})

test('without enterKeepsChecked an answer naming no row still selects nothing, asked exactly once', async () => {
  const { picked, text, prompts } = await askEndless(syncMenuQuestion(), 'y\n')

  assert.equal(prompts, 1, 'callers that did not opt in never re-ask')
  assert.deepEqual(picked, [], 'the historical semantics are untouched')
  assert.doesNotMatch(text, /nothing matched/)
})

test('back and all survive on both paths', async () => {
  await assert.rejects(askPiped(syncMenuQuestion({ enterKeepsChecked: true }), 'b\n'), /back/i)
  await assert.rejects(askPiped(syncMenuQuestion(), 'b\n'), /back/i)

  const kept = await askPiped(syncMenuQuestion({ enterKeepsChecked: true }), 'all\n')
  assert.deepEqual(kept.picked, ['claude', 'openclaw', 'hermes'])

  const plain = await askPiped(syncMenuQuestion(), 'all\n')
  assert.deepEqual(plain.picked, ['claude', 'openclaw', 'hermes'])
})

test('without enterKeepsChecked a bare enter still selects nothing and no state is rendered', async () => {
  const { picked, text } = await askLegacy(syncMenuQuestion(), '\n')

  assert.match(text, /2\) capture openclaw/, 'no [x]/[ ] markers without the opt-in')
  assert.doesNotMatch(text, /\[x\]|\[ \]/)
  assert.match(text, /select \(e\.g\. 1,3, "all", or b to go back\): /, 'the historical prompt line is byte-identical')
  assert.deepEqual(picked, [], 'the historical enter-selects-none stands')
})

/**
 * @param {PassThrough} input
 * @param {string[]} answers
 */
function answerDrivenOutput(input, answers) {
  let value = ''
  return {
    write(chunk) {
      const text = String(chunk)
      value += text
      if (text.includes('select (e.g. 1,3 or "all"): ')) {
        const answer = answers.shift()
        if (answer !== undefined) input.write(answer)
        if (answers.length === 0) input.end()
      }
    },
    text() {
      return value
    },
  }
}

function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
    },
    text() {
      return value
    },
  }
}

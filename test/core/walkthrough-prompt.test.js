// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import {
  WALKTHROUGH_CANCEL_EXIT_CODE,
  defaultPromptFactory,
  runPickerWalkthrough,
} from '../../src/core/cli/walkthrough.js'
import { isPromptCancelledError } from '../../src/core/cli/tui/runtime.js'

test('picker prompt prints context under source options and defaults export to local-parquet', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-walkthrough-prompt-'))
  const input = new PassThrough()
  // Only the source question is asked; export defaults to local-parquet
  // and retention takes its default without a prompt (LLP 0137).
  const stdout = answerDrivenOutput(input, ['4\n'])
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
  // Row 4 is otel: the client rows come first in PICKER_DISPLAY_ORDER
  // (claude, codex, opencode), and the raw API rows sort between them and
  // otel but are `hidden`, so they never render (LLP 0202).
  assert.deepEqual(result.sourcesPicked, ['otel'])
  assert.equal(result.exportPicked, 'local-parquet')

  const text = stdout.text()
  assert.match(text, /4\) OpenTelemetry\n     Records logs, traces, and metrics your tools send over local OTLP HTTP/)
  assert.doesNotMatch(text, /Anthropic API/)
  assert.doesNotMatch(text, /OpenAI API/)
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
    title: 'Choose what syncs. Unchecked sources stay on this machine.',
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
  assert.match(text, /select \(e\.g\. 1,3, "all", "none", enter keeps \[x\], or b to go back\): /)
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
  assert.deepEqual(picked, ['claude', 'openclaw'], 'the spent budget lands on the same default enter takes')
})

test('enterKeepsChecked: an invalid answer then EOF resolves with the checked defaults instead of hanging', async () => {
  const { picked } = await askPiped(syncMenuQuestion({ enterKeepsChecked: true }), 'y\n')

  assert.deepEqual(picked, ['claude', 'openclaw'], 'an unanswerable question takes the default, it does not wait')
})

test('EOF with no answer at all settles rather than hanging, on both paths', async () => {
  const kept = await askPiped(syncMenuQuestion({ enterKeepsChecked: true }), '')
  assert.deepEqual(kept.picked, ['claude', 'openclaw'])

  // Without the opt-in there is no stated default to land on, so an
  // unanswerable question is a cancel; see the dropped-terminal tests
  // below for why it must not resolve as "picked nothing".
  await assert.rejects(askPiped(syncMenuQuestion(), ''), isPromptCancelledError)
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

// Spending the re-ask budget is a fallback, not a decision. Falling
// through to the empty selection here would re-create issue #634 one
// answer later (in the sync menu it opts every candidate out), and
// doing it silently is worse than the papercut it replaced. And a
// closed stdin on a question that did NOT opt in is a dropped terminal,
// not "the user chose nothing": it cancels, the way ctrl+c does, rather
// than advancing the wizard into the daemon install with no sources.
// @ref LLP 0190#sync-gate [tests]:

test('enterKeepsChecked: a spent re-ask budget keeps the checked rows and says which', async () => {
  const { picked, text } = await askPiped(syncMenuQuestion({ enterKeepsChecked: true }), 'y\ny\n')

  assert.deepEqual(picked, ['claude', 'openclaw'], 'the spent budget falls back to the checked set, not to none')
  assert.equal(
    (text.match(/nothing matched/g) ?? []).length,
    2,
    'the last failure is announced too; the fallback is never silent'
  )
  assert.match(text, /keeping the checked rows: claude, openclaw/, 'the fallback names what it fell back to')
})

test('enterKeepsChecked: a spent budget with nothing checked says the selection is empty', async () => {
  const question = syncMenuQuestion({ enterKeepsChecked: true })
  for (const opt of question.options) delete opt.checked
  const { picked, text } = await askPiped(question, 'y\ny\n')

  assert.deepEqual(picked, [])
  assert.match(text, /nothing was checked, so nothing is selected/)
})

test('without enterKeepsChecked a closed stdin cancels instead of selecting nothing', async () => {
  await assert.rejects(askPiped(syncMenuQuestion(), ''), isPromptCancelledError)
})

test('a dropped terminal at the source picker cancels the run instead of installing with no sources', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-walkthrough-eof-'))
  const input = new PassThrough()
  input.end()
  const stdout = makeBuf()
  const stderr = makeBuf()

  const result = await runPickerWalkthrough({
    capabilities: /** @type {any} */ ({}),
    stdout,
    stderr,
    stdin: /** @type {any} */ (input),
    env: { HOME: tmp, HYP_HOME: path.join(tmp, '.hyp') },
  })

  assert.equal(result.exitCode, WALKTHROUGH_CANCEL_EXIT_CODE, 'EOF aborts the run, it does not complete it')
  assert.equal(result.configPath, '')
  assert.match(stderr.text(), /cancelled/)
  await assert.rejects(
    fs.access(path.join(tmp, '.hyp', 'hypaware-config.json')),
    'a cancelled run writes no config'
  )
})

test('every later ask on a spent stdin settles instead of hanging', { timeout: 20_000 }, async () => {
  const input = new PassThrough()
  input.write('3\n')
  input.end()
  const stdout = { write() { return true } }
  const ask = defaultPromptFactory({ stdin: /** @type {any} */ (input), stdout: /** @type {any} */ (stdout), env: {} })
  const question = syncMenuQuestion({ enterKeepsChecked: true })

  assert.deepEqual(await ask(question), ['hermes'], 'the one queued answer is read')
  // Readline registers its `end` listener on construction, so an
  // interface built over an already-ended stream never fires `close` and
  // the ask would wait forever. Each of these is a separate interface.
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(await ask(question), ['claude', 'openclaw'], `ask ${i + 2} settles on the default`)
  }
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

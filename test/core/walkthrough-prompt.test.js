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

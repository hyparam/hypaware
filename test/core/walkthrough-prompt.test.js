// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'

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

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
  // Only the source question and the retention prompt are asked; the
  // export question was removed in favour of the local-parquet default.
  const stdout = answerDrivenOutput(input, ['3\n', '\n'])
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
  assert.match(text, /3\) capture raw Anthropic API traffic\n     Advanced API proxy mode/)
  // The export question is no longer rendered.
  assert.doesNotMatch(text, /keep local query cache only/)
  assert.doesNotMatch(text, /Where should HypAware export/)
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
      if (text.includes('select (e.g. 1,3 or "all"): ') || text.includes('Cache retention (days)')) {
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

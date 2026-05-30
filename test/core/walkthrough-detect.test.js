// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'

function makeBuf() {
  let s = ''
  return {
    write(/** @type {string} */ c) { s += c; return true },
    text() { return s },
  }
}

async function tmpEnv() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-wt-detect-'))
  return { HOME: tmp, HYP_HOME: path.join(tmp, '.hyp') }
}

test('picker pre-checks detected sources, labels them, and defaults export to local-parquet', async () => {
  /** @type {import('../../src/core/cli/types.d.ts').WalkthroughQuestion[]} */
  const seen = []
  /** @type {import('../../src/core/cli/types.d.ts').AsyncPickPrompt} */
  const prompt = async (question) => {
    seen.push(question)
    // Confirm whatever is pre-checked, mirroring a user pressing enter.
    return question.options.filter((o) => o.checked).map((o) => o.value)
  }

  const result = await runPickerWalkthrough({
    capabilities: /** @type {any} */ ({}),
    stdout: makeBuf(),
    stderr: makeBuf(),
    env: await tmpEnv(),
    detect: async () => new Set(['claude']),
    prompt,
    retentionPrompt: async (_p, d) => d,
  })

  const sources = seen.find((q) => q.pickType === 'sources')
  assert.ok(sources, 'sources question asked')
  const claude = sources.options.find((o) => o.value === 'claude')
  const codex = sources.options.find((o) => o.value === 'codex')
  assert.equal(claude?.checked, true)
  assert.match(claude?.label ?? '', /· detected$/)
  assert.notEqual(codex?.checked, true)
  assert.doesNotMatch(codex?.label ?? '', /detected/)

  // The export question is no longer asked — local-parquet is the
  // unconditional default.
  assert.equal(seen.find((q) => q.pickType === 'sinks'), undefined, 'export question must not be asked')

  // The confirmed picks reflect the preselected state.
  assert.deepEqual(result.sourcesPicked, ['claude'])
  assert.equal(result.exportPicked, 'local-parquet')
})

test('nothing detected → no source pre-checked, export still defaults to local-parquet', async () => {
  /** @type {import('../../src/core/cli/types.d.ts').WalkthroughQuestion[]} */
  const seen = []
  /** @type {import('../../src/core/cli/types.d.ts').AsyncPickPrompt} */
  const prompt = async (question) => {
    seen.push(question)
    return question.options.filter((o) => o.checked).map((o) => o.value)
  }

  const result = await runPickerWalkthrough({
    capabilities: /** @type {any} */ ({}),
    stdout: makeBuf(),
    stderr: makeBuf(),
    env: await tmpEnv(),
    detect: async () => new Set(),
    prompt,
    retentionPrompt: async (_p, d) => d,
  })

  const sources = seen.find((q) => q.pickType === 'sources')
  assert.ok(sources)
  assert.equal(sources.options.some((o) => o.checked), false)
  assert.equal(sources.options.some((o) => /detected/.test(o.label)), false)
  assert.deepEqual(result.sourcesPicked, [])
  assert.equal(result.exportPicked, 'local-parquet')
})

test('non-interactive picks skip detection entirely', async () => {
  let detectCalled = false

  const result = await runPickerWalkthrough({
    capabilities: /** @type {any} */ ({}),
    stdout: makeBuf(),
    stderr: makeBuf(),
    env: await tmpEnv(),
    picks: { sources: ['otel'], exportChoice: 'keep-local', retentionDays: 30 },
    detect: async () => { detectCalled = true; return new Set(['claude', 'codex']) },
  })

  assert.equal(detectCalled, false, 'detector must not run when picks are supplied')
  assert.deepEqual(result.sourcesPicked, ['otel'])
  assert.equal(result.exportPicked, 'keep-local')
})

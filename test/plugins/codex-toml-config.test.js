// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isManagedAttached,
  prepareAttach,
  prepareDetach,
} from '../../hypaware-core/plugins-workspace/codex/src/toml-config.js'

test('prepareAttach inserts managed Codex provider blocks and preserves previous provider', () => {
  const initial = [
    'model_provider = "openai"',
    '',
    '[profiles.default]',
    'model = "gpt-5"',
    '',
  ].join('\n')

  const result = prepareAttach(initial, 4388, '0.2.0', {
    baseUrl: 'http://127.0.0.1:4388/backend-api/codex',
    providerName: 'HypAware ChatGPT Gateway',
  })

  assert.equal(result.prevValue, 'openai')
  assert.equal(isManagedAttached(result.content), true)
  assert.match(result.content, /# BEGIN hypaware codex model_provider/)
  assert.match(result.content, /# previous_model_provider = "openai"/)
  assert.match(result.content, /model_provider = "hypaware"/)
  assert.match(result.content, /\[model_providers\.hypaware\]/)
  assert.match(result.content, /base_url = "http:\/\/127\.0\.0\.1:4388\/backend-api\/codex"/)
  assert.match(result.content, /\[profiles\.default\]\nmodel = "gpt-5"/)
})

test('prepareAttach is idempotent for an already managed config', () => {
  const once = prepareAttach('', 4388, '0.2.0')
  const twice = prepareAttach(once.content, 4388, '0.2.0')

  assert.equal(twice.content.match(/# BEGIN hypaware codex model_provider/g)?.length, 1)
  assert.equal(twice.content.match(/# BEGIN hypaware codex provider/g)?.length, 1)
  assert.equal(isManagedAttached(twice.content), true)
})

test('prepareDetach removes managed Codex blocks and restores previous provider', () => {
  const attached = prepareAttach('model_provider = "openai"\n', 4388, '0.2.0')
  const detached = prepareDetach(attached.content)

  assert.equal(detached.changed, true)
  assert.equal(detached.restoredValue, 'openai')
  assert.equal(detached.removed, 'http://127.0.0.1:4388/v1')
  assert.equal(isManagedAttached(detached.content), false)
  assert.equal(detached.content, 'model_provider = "openai"\n')
})

test('prepareDetach is a no-op when HypAware did not manage the config', () => {
  assert.deepEqual(prepareDetach('model_provider = "openai"\n'), { changed: false })
})

test('managed marker parsing rejects unterminated blocks', () => {
  assert.throws(
    () => isManagedAttached('# BEGIN hypaware codex model_provider\nmodel_provider = "hypaware"\n'),
    /unterminated hypaware-managed Codex config block/
  )
})

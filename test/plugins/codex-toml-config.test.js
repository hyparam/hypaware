// @ts-check

import { CODEX_LEGACY_PROVIDER } from '../../src/core/config/client_detach_disk.js'
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
    providerName: 'HypAware Codex Gateway',
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

// T1 (LLP 0045/0046): the codex `# BEGIN/END hypaware` marked block is a
// self-describing undo record, the block is self-delimiting and records
// the prior `model_provider` as `# previous_model_provider`, so the
// format-aware core undo (task 4) can strip the block and restore the
// pointer without loading the codex plugin.
test('prepareAttach records the prior model_provider in the marked block undo record', () => {
  const result = prepareAttach('model_provider = "openai"\n', 4388, '0.2.0')

  // Self-delimiting marked blocks (what the core undo strips by format).
  assert.match(result.content, /# BEGIN hypaware codex model_provider/)
  assert.match(result.content, /# END hypaware codex model_provider/)
  assert.match(result.content, /# BEGIN hypaware codex provider/)
  assert.match(result.content, /# END hypaware codex provider/)
  // The prior pointer (the restore target) lives inside the root block.
  assert.match(result.content, /# previous_model_provider = "openai"/)
  assert.equal(result.prevValue, 'openai')
})

test('re-attach keeps the original previous_model_provider, not the managed one', () => {
  const once = prepareAttach('model_provider = "openai"\n', 4388, '0.2.0')
  // A second attach observes our managed `model_provider = "hypaware"`
  // live, but must keep the marked block's recorded original.
  const twice = prepareAttach(once.content, 4388, '0.2.0')

  assert.equal(twice.prevValue, 'openai')
  assert.equal(twice.content.match(/# previous_model_provider = "openai"/g)?.length, 1)
  assert.equal(twice.content.match(/# previous_model_provider = "hypaware"/g) ?? null, null)
})

test('prepareDetach removes managed Codex blocks and restores previous provider', () => {
  const attached = prepareAttach('model_provider = "openai"\n', 4388, '0.2.0')
  const detached = prepareDetach(attached.content)

  assert.equal(detached.changed, true)
  assert.equal(detached.restoredValue, 'openai')
  assert.equal(detached.removed, 'http://127.0.0.1:4388/backend-api/codex')
  assert.equal(isManagedAttached(detached.content), false)
  assert.equal(detached.content, 'model_provider = "openai"\n' + CODEX_LEGACY_PROVIDER)
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

// Both paths use this transform, including disk detach after plugin unload.
test('detach preserves user settings and an explicit provider choice inside markers', () => {
  const attached = prepareAttach('model_provider = "openai"\n', 4388, 'old').content
    .replace('model_provider = "hypaware"', 'model_provider = "custom"\nmodel = "gpt-test"')
    .replace('# END hypaware codex provider', '[desktop]\nfoo = true\n[features]\nbar = false\n[projects."/tmp/customer"]\ntrust_level = "trusted"\n# END hypaware codex provider')
  const result = prepareDetach(attached)
  assert.equal(result.changed, true)
  if (!result.changed) return
  assert.match(result.content, /model_provider = "custom"/)
  assert.match(result.content, /model = "gpt-test"/)
  assert.match(result.content, /\[desktop\]\nfoo = true\n\[features\]\nbar = false/)
  assert.match(result.content, /trust_level = "trusted"/)
  assert.equal(result.content.includes('base_url'), false)
  assert.equal(result.content.includes('# BEGIN'), false)
  assert.deepEqual(prepareDetach(result.content), { changed: false })
})

test('gateway reattach retains unrelated tables serialized inside the markers', () => {
  const attached = prepareAttach('', 4388, 'old').content
    .replace('# END hypaware codex provider', '[desktop]\nfoo = true\n# END hypaware codex provider')
  assert.match(prepareAttach(attached, 4389, 'new').content, /\[desktop\]\nfoo = true/)
})

test('detach leaves unmarked user providers and marker-looking multiline strings alone', () => {
  const custom = '[model_providers.hypaware]\nname = "custom"\nbase_url = "https://example.test/v1"\n'
  assert.deepEqual(prepareDetach(custom), { changed: false })
  const text = 'instructions = """\n# BEGIN hypaware codex provider\n[model_providers.hypaware]\n# END hypaware codex provider\n"""\n'
  assert.deepEqual(prepareDetach(text), { changed: false })
})

test('quoted owned keys cannot leave gateway routing behind', () => {
  const attached = prepareAttach('', 4388, 'old').content.replace('base_url =', '"base_url" =')
  const result = prepareDetach(attached)
  assert.ok(result.changed)
  if (result.changed) assert.equal(result.content.includes('base_url'), false)
})

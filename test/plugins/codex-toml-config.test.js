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
  assert.ok(detached.content.startsWith('model_provider = "openai"\n'))
  assert.match(detached.content, /\[model_providers.hypaware\]/)
})

test('prepareDetach repairs a markerless existing config', () => {
  assert.equal(prepareDetach('model_provider = "openai"\n').changed, true)
})

test('managed marker parsing rejects unterminated blocks', () => {
  assert.throws(
    () => isManagedAttached('# BEGIN hypaware codex model_provider\nmodel_provider = "hypaware"\n'),
    /unterminated hypaware-managed Codex config block/
  )
})

test('migration keeps saved hypaware providers resolvable without the gateway', () => {
  const attached = prepareAttach('model_provider = "custom"\n[model_providers.custom]\nname = "Private"\nbase_url = "https://example.invalid/v1"\nenv_key = "PRIVATE_KEY"\n', 4388, '1.37.0')
  const result = prepareDetach(attached.content)
  assert.equal(result.changed, true)
  assert.match(result.content, /\[model_providers.hypaware\]/)
  assert.match(result.content, /requires_openai_auth = true/)
  assert.doesNotMatch(result.content, /127.0.0.1|BEGIN hypaware/)
  assert.match(result.content, /model_provider = "custom"/)
  assert.match(result.content, /env_key = "PRIVATE_KEY"/)
  assert.deepEqual(prepareDetach(result.content), { changed: false })
})

test('repair an already migrated config without changing its default or user provider', () => {
  const original = 'model_provider = "custom"\n[model_providers.custom]\nname = "Private"\n'
  const repair = prepareDetach(original)
  assert.equal(repair.changed, true)
  assert.ok(repair.content.startsWith(original))
  assert.match(repair.content, /\[model_providers.hypaware\]/)
  const userOwned = '[model_providers.hypaware]\nname = "User owned"\nbase_url = "https://example.invalid"\n'
  assert.deepEqual(prepareDetach(userOwned), { changed: false })
})

test('Codex edits inside markers survive migration and gateway reattach', () => {
  const attached = prepareAttach('', 4388, '1.37.0').content
    .replace('# END hypaware codex model_provider', 'service_tier = "fast"\n[desktop]\ntheme = "dark"\n# END hypaware codex model_provider')
    .replace('# END hypaware codex provider', '[features]\nfast_mode = true\n[hooks.trust."/tmp/project"]\ntrusted = true\n# END hypaware codex provider')
  for (const result of [prepareDetach(attached), prepareAttach(attached, 4389, 'patched')]) {
    assert.ok('content' in result)
    assert.match(result.content, /service_tier = "fast"/)
    assert.match(result.content, /\[desktop\]\ntheme = "dark"/)
    assert.match(result.content, /\[features\]\nfast_mode = true/)
    assert.match(result.content, /\[hooks.trust."\/tmp\/project"\]\ntrusted = true/)
  }
})

for (const userOwned of [
  '["model_providers"."hypaware"]\nname = "Mine"\n',
  'model_providers.hypaware = { name = "Mine", wire_api = "responses" }\n',
  '[model_providers]\nhypaware = { name = "Mine", wire_api = "responses" }\n',
  'model_providers = { hypaware = { name = "Mine", wire_api = "responses" } }\n',
]) {
  test(`preserve user-owned provider syntax: ${userOwned.split('\n')[0]}`, () => {
    assert.deepEqual(prepareDetach(userOwned), { changed: false })
  })
}

test('marker-looking text inside multiline settings is preserved literally', () => {
  const original = 'instructions = """\n# BEGIN hypaware codex model_provider\n# previous_model_provider = "fake"\nmodel_provider = "hypaware"\n# END hypaware codex model_provider\n"""\n'
  const attached = prepareAttach(original, 4388, 'old')
  const detached = prepareDetach(attached.content)
  assert.equal(detached.changed, true)
  assert.ok(detached.content.startsWith(original))
  assert.equal(detached.restoredValue, undefined)
})

test('partial marker ownership preserves an existing user provider and external default', () => {
  const original = '# BEGIN hypaware codex model_provider\n# previous_model_provider = "openai"\nmodel_provider = "custom"\n# END hypaware codex model_provider\n[model_providers.hypaware]\nname = "Mine"\nbase_url = "https://example.invalid"\n'
  const detached = prepareDetach(original)
  assert.equal(detached.changed, true)
  assert.match(detached.content, /model_provider = "custom"/)
  assert.match(detached.content, /name = "Mine"/)
  assert.match(detached.warning ?? '', /changed externally/)
})

for (const key of ['model_providers', '"model_providers"', "'model_providers'"]) {
  test(`repair an inline ${key} map without changing custom settings`, () => {
    const custom = 'custom = { name = "Private, {provider}", wire_api = "responses", http_headers = { "X-Note" = "},[" }, env_key = "PRIVATE_KEY" }'
    const original = `model_provider = "custom"\n${key} = { ${custom} } # keep this comment\nservice_tier = "fast"\n`
    const result = prepareDetach(original)
    assert.equal(result.changed, true)
    assert.ok(result.content.includes(`${key}.${custom}`))
    assert.match(result.content, /# keep this comment\nservice_tier = "fast"/)
    assert.match(result.content, /^model_provider = "custom"\n/)
    assert.match(result.content, /\[model_providers.hypaware\]/)
    assert.deepEqual(prepareDetach(result.content), { changed: false })
    const gateway = prepareAttach(result.content, 4388, 'new')
    assert.ok(gateway.content.includes(`${key}.${custom}`))
    assert.match(gateway.content, /base_url = "http:\/\/127.0.0.1:4388/)
  })
}

test('inline maps handle empty maps, quoted keys, nested arrays and multiline strings', () => {
  for (const content of [
    'model_providers = {} # empty\n',
    "model_providers = { 'custom.name' = { name = 'Literal }, comma,', wire_api = 'responses' }, second.name = \"Second\", second.wire_api = \"responses\" }\n",
    'model_providers = { custom = { name = """first\nsecond }, comma,\nthird""", wire_api = "responses" } }\n',
    'model_providers = { custom = { name = "Escaped \\\"}, comma,", extra = [1, { nested = [2, 3] }], wire_api = "responses" } }\n',
  ]) {
    const result = prepareDetach(content)
    assert.equal(result.changed, true)
    assert.match(result.content, /\[model_providers.hypaware\]/)
    assert.deepEqual(prepareDetach(result.content), { changed: false })
  }
  assert.deepEqual(prepareDetach('model_providers = { "hypaware".name = "Mine", "hypaware".wire_api = "responses" }\n'), { changed: false })
})

test('gateway attach replaces an inline compatibility provider without duplicating it', () => {
  const content = 'model_providers = { custom = { name = "Private" }, hypaware = { name = "OpenAI", wire_api = "responses" } }\n'
  const attached = prepareAttach(content, 4388, 'new')
  assert.match(attached.content, /model_providers.custom = \{ name = "Private" \}/)
  assert.doesNotMatch(attached.content, /hypaware = \{/)
  const detached = prepareDetach(attached.content)
  assert.equal(detached.changed, true)
  assert.match(detached.content, /model_providers.custom = \{ name = "Private" \}/)
})

test('nested multiline values cannot claim provider ownership or contain real markers', () => {
  const value = 'custom = { name = """first\n[model_providers.hypaware]\n# BEGIN hypaware codex provider\n# END hypaware codex provider\nlast""", wire_api = "responses" }'
  const repaired = prepareDetach(`model_providers = { ${value} }\n`)
  assert.equal(repaired.changed, true)
  assert.ok(repaired.content.includes(`model_providers.${value}`))
  assert.deepEqual(prepareDetach(repaired.content), { changed: false })
  assert.ok(prepareAttach(repaired.content, 4388, 'new').content.includes(`model_providers.${value}`))
})

test('provider fields after END still belong to the managed table', () => {
  const base = 'base_url = "http://127.0.0.1:4388/backend-api/codex"'
  const content = prepareAttach('', 4388, 'old').content
    .replace(base + '\n', '')
    .replace('# END hypaware codex provider', '# END hypaware codex provider\n' + base)
  const result = prepareDetach(content)
  assert.equal(result.changed, true)
  assert.doesNotMatch(result.content, /base_url|127.0.0.1/)
})

for (const escape of ['\\u0061', '\\U00000061']) {
  const namespace = `"model_providers"`.replace('o', escape.replace('61', '6f'))
  const provider = `"hypaware"`.replace('a', escape)
  for (const content of [
    `[${namespace}.${provider}]\nname = "Mine"\nwire_api = "responses"\n`,
    `${namespace}.${provider} = { name = "Mine", wire_api = "responses" }\n`,
    `[${namespace}]\n${provider} = { name = "Mine", wire_api = "responses" }\n`,
    `${namespace} = { ${provider} = { name = "Mine", wire_api = "responses" } }\n`,
    `${namespace} = { ${provider}.name = "Mine", ${provider}.wire_api = "responses" }\n`,
  ]) {
    test(`escaped user-owned provider remains byte-for-byte untouched: ${content.split('\n')[0]}`, () => {
      assert.deepEqual(prepareDetach(content), { changed: false })
    })
  }
  test(`escaped inline namespace repairs a missing provider: ${escape}`, () => {
    const original = `${namespace} = { custom = { name = "Private", wire_api = "responses" } }\n`
    const result = prepareDetach(original)
    assert.equal(result.changed, true)
    assert.match(result.content, /\[model_providers.hypaware\]/)
    assert.ok(result.content.includes(`${namespace}.custom = { name = "Private", wire_api = "responses" }`))
    assert.deepEqual(prepareDetach(result.content), { changed: false })
  })
}

for (const header of ['[model_providers.hypaware.http_headers]', '["model_providers"."hyp\\U00000061ware".http_headers]']) {
  test(`managed descendant beyond END is replaced without retaining credentials: ${header}`, () => {
    const unrelated = '[features]\nfast_mode = true\n[model_providers.custom]\nname = "Private"\nwire_api = "responses"\n'
    const content = prepareAttach('', 4388, 'old').content + unrelated
      + `${header}\nAuthorization = "synthetic-secret"\n`
    const result = prepareDetach(content)
    assert.equal(result.changed, true)
    assert.ok(result.content.includes(unrelated))
    assert.match(result.content, /\[model_providers.hypaware\]\nname = "OpenAI"\nrequires_openai_auth = true\nwire_api = "responses"\nsupports_websockets = true/)
    assert.doesNotMatch(result.content, /http_headers|synthetic-secret|base_url/)
    assert.deepEqual(prepareDetach(result.content), { changed: false })
  })
}

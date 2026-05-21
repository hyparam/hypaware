// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createConfigRegistry,
  defaultConfigPath,
  parseConfigShape,
} from '../../src/core/config/schema.js'
import {
  diagnoseV1Config,
  isCronExpression,
  validateConfig,
} from '../../src/core/config/validate.js'

test('defaultConfigPath resolves the v2 config basename under HYP_HOME', () => {
  assert.equal(defaultConfigPath('/tmp/hyp-home'), '/tmp/hyp-home/hypaware-config.json')
})

test('parseConfigShape accepts the supported v2 config shape', () => {
  const result = parseConfigShape({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          upstreams: [{ name: 'chatgpt', base_url: 'https://chatgpt.com', provider: 'chatgpt' }],
        },
      },
      { name: '@hypaware/codex', enabled: true },
      { name: '@hypaware/format-parquet' },
      { name: '@hypaware/local-fs' },
    ],
    sinks: {
      local: {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
        config: { schedule: '0 * * * *' },
      },
      central: {
        plugin: '@hypaware/central',
        config: { schedule: '*/5 * * * *' },
      },
    },
    query: {
      cache: {
        dir: './cache',
        retention: {
          default_days: 7,
          datasets: { ai_gateway_messages: 3 },
        },
      },
    },
    disambiguate: {
      'hypaware.blob-store': '@hypaware/local-fs',
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.config.plugins?.length, 4)
  assert.equal(result.config.sinks?.local?.writer, '@hypaware/format-parquet')
  assert.equal(result.config.query?.cache?.retention?.datasets?.ai_gateway_messages, 3)
})

test('parseConfigShape reports stable pointers for malformed config', () => {
  const result = parseConfigShape({
    version: 1,
    plugins: [{ name: '', enabled: 'yes' }],
    sinks: {
      mixed: {
        plugin: '@hypaware/central',
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
      },
    },
    extra: true,
  })

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.errors.map((error) => error.pointer).sort(),
    ['/extra', '/plugins/0/name', '/sinks/mixed', '/version']
  )
})

test('validateConfig catches cross-plugin and schedule errors', async () => {
  const result = await validateConfig({
    version: 2,
    plugins: [
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/local-fs' },
    ],
    sinks: {
      bad: {
        writer: '@hypaware/central',
        destination: '@hypaware/local-fs',
        config: { schedule: '@hourly' },
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.pluginCount, 2)
  assert.equal(result.sinkCount, 1)
  assert.deepEqual(
    result.errors.map((error) => error.errorKind).sort(),
    ['duplicate_plugin', 'sink_pair_incompatible', 'sink_schedule_invalid']
  )
})

test('validateConfig dispatches plugin-specific section validators', async () => {
  const registry = createConfigRegistry()
  registry.registerSection({
    plugin: '@hypaware/codex',
    section: 'codex',
    validate(config, ctx) {
      assert.equal(ctx.pluginName, '@hypaware/codex')
      if (config && typeof config === 'object' && Reflect.get(config, 'enabled') === true) {
        return { ok: true }
      }
      return {
        ok: false,
        errors: [{ pointer: ctx.pointer, message: 'codex.enabled must be true' }],
      }
    },
  })

  const result = await validateConfig(
    {
      version: 2,
      plugins: [{ name: '@hypaware/codex', config: { enabled: false } }],
    },
    { configRegistry: registry }
  )

  assert.equal(result.ok, false)
  assert.equal(result.errors[0].errorKind, 'config_section_invalid')
  assert.equal(result.errors[0].pointer, '/plugins/<@hypaware/codex>/config')
})

test('isCronExpression accepts narrow standard cron and rejects aliases', () => {
  assert.equal(isCronExpression('0 * * * *'), true)
  assert.equal(isCronExpression('*/15 8-17 * 1,6 1-5'), true)
  assert.equal(isCronExpression('@hourly'), false)
  assert.equal(isCronExpression('0 0 1 1'), false)
  assert.equal(isCronExpression('60 * * * *'), false)
})

test('diagnoseV1Config reports advisory product wiring gaps', () => {
  const diagnostics = diagnoseV1Config({
    version: 2,
    plugins: [
      { name: '@hypaware/codex' },
      { name: '@hypaware/local-fs' },
    ],
    sinks: {
      local: { writer: '@hypaware/format-parquet', destination: '@hypaware/local-fs' },
    },
  })

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.kind).sort(),
    ['client_without_gateway', 'sink_missing_encoder']
  )
})

test('diagnoseV1Config treats ChatGPT as a valid Codex upstream', () => {
  const diagnostics = diagnoseV1Config({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          upstreams: [
            { name: 'chatgpt', base_url: 'https://chatgpt.com', provider: 'chatgpt' },
          ],
        },
      },
      { name: '@hypaware/codex' },
    ],
  })

  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.kind === 'gateway_missing_openai_upstream'),
    false
  )
})

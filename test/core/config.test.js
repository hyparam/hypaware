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
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

/**
 * @import { BlobSinkConfigInstance } from '../../collectivus-plugin-kernel-types.d.ts'
 */

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
  const localSink = /** @type {BlobSinkConfigInstance | undefined} */ (result.config.sinks?.local)
  assert.equal(localSink?.writer, '@hypaware/format-parquet')
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
  // `@hypaware/central` is a request-sink plugin (provides
  // hypaware.http-endpoint, not hypaware.encoder or hypaware.table-format)
  // so using it as a blob-sink writer trips `sink_writer_invalid`.
  assert.deepEqual(
    result.errors.map((error) => error.errorKind).sort(),
    ['duplicate_plugin', 'sink_schedule_invalid', 'sink_writer_invalid']
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

test('diagnoseV1Config reports advisory product wiring gaps', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])

  const diagnostics = diagnoseV1Config(
    {
      version: 2,
      plugins: [
        { name: '@hypaware/codex' },
        { name: '@hypaware/local-fs' },
      ],
      sinks: {
        local: { writer: '@hypaware/format-parquet', destination: '@hypaware/local-fs' },
      },
    },
    {
      clientDescriptors: catalog.clientDescriptors,
      knownPlugins: catalog.pluginMetadata,
    }
  )

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.kind).sort(),
    ['client_without_gateway', 'sink_missing_encoder']
  )
})

test('buildPluginCatalog derives capability metadata from bundled manifests', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])

  const central = catalog.pluginMetadata.get('@hypaware/central')
  assert.ok(central, 'catalog must include @hypaware/central from excluded bundled set')
  assert.deepEqual(central.provides, { 'hypaware.http-endpoint': '1.0.0' })

  const localFs = catalog.pluginMetadata.get('@hypaware/local-fs')
  assert.ok(localFs)
  assert.deepEqual(localFs.provides, { 'hypaware.blob-store': '1.0.0' })

  const iceberg = catalog.pluginMetadata.get('@hypaware/format-iceberg')
  assert.ok(iceberg)
  assert.deepEqual(iceberg.provides, { 'hypaware.table-format': '1.0.0' })
  assert.deepEqual(iceberg.requires, {
    'hypaware.blob-store': '^1.0.0',
    'hypaware.encoder': '^1.0.0',
  })
})

test('buildPluginCatalog extracts client descriptors from manifests', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])

  assert.ok(catalog.clientDescriptors.has('claude'))
  const claude = catalog.clientDescriptors.get('claude')
  assert.equal(claude?.plugin, '@hypaware/claude')
  assert.equal(claude?.skillDir, '.claude/skills')
  assert.equal(claude?.attachProbe?.format, 'json')
  assert.equal(claude?.attachProbe?.marker_key, '_hypaware')
  assert.deepEqual(claude?.requiredUpstreams, ['anthropic'])

  assert.ok(catalog.clientDescriptors.has('codex'))
  const codex = catalog.clientDescriptors.get('codex')
  assert.equal(codex?.plugin, '@hypaware/codex')
  assert.equal(codex?.skillDir, '.codex/skills')
  assert.equal(codex?.attachProbe?.format, 'toml')
  assert.deepEqual(codex?.requiredUpstreams, ['openai', 'chatgpt'])
})

test('buildPluginCatalog collects known datasets from manifest contributions', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])

  assert.ok(catalog.knownDatasets.has('ai_gateway_messages'))
  assert.ok(catalog.knownDatasets.has('logs'))
  assert.ok(catalog.knownDatasets.has('traces'))
  assert.ok(catalog.knownDatasets.has('metrics'))
  assert.ok(
    catalog.knownDatasets.has('gascity_messages'),
    'catalog includes gascity_messages from excluded plugin manifest'
  )
})

test('buildPluginCatalog includes excluded gascity plugin as a catalog entry', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])

  const entry = catalog.plugins.get('@hypaware/gascity')
  assert.ok(entry, 'gascity must be in catalog when excluded manifests are included')
  assert.equal(entry.name, '@hypaware/gascity')
  assert.ok(entry.contributes, 'gascity catalog entry must carry its contributions')
  assert.ok(
    entry.contributes.sources?.some((s) => s.name === 'gascity'),
    'gascity contributes a "gascity" source'
  )
  assert.ok(
    entry.contributes.commands?.some((c) => c.name === 'gascity attach'),
    'gascity contributes a "gascity attach" command'
  )
  assert.ok(
    entry.contributes.init_presets?.some((p) => p.name === 'gascity'),
    'gascity contributes a "gascity" init preset'
  )
  assert.ok(
    entry.contributes.skills?.some((s) => s.name === 'hypaware-gascity'),
    'gascity contributes the hypaware-gascity skill'
  )
})

test('validateConfig uses catalog-derived metadata for sink validation', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])

  const result = await validateConfig(
    {
      version: 2,
      plugins: [
        { name: '@hypaware/format-parquet' },
        { name: '@hypaware/local-fs' },
      ],
      sinks: {
        local: {
          writer: '@hypaware/format-parquet',
          destination: '@hypaware/local-fs',
          config: { schedule: '0 * * * *' },
        },
      },
    },
    { knownPlugins: catalog.pluginMetadata, knownDatasets: catalog.knownDatasets }
  )

  assert.equal(result.ok, true)
})

test('validateConfig with catalog rejects @hypaware/central as blob-sink writer', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])

  const result = await validateConfig(
    {
      version: 2,
      plugins: [
        { name: '@hypaware/central' },
        { name: '@hypaware/local-fs' },
      ],
      sinks: {
        bad: {
          writer: '@hypaware/central',
          destination: '@hypaware/local-fs',
          config: { schedule: '0 * * * *' },
        },
      },
    },
    { knownPlugins: catalog.pluginMetadata }
  )

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.errorKind === 'sink_writer_invalid'))
})

test('validateConfig with catalog accepts @hypaware/central as request sink', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])

  const result = await validateConfig(
    {
      version: 2,
      plugins: [{ name: '@hypaware/central' }],
      sinks: {
        fwd: {
          plugin: '@hypaware/central',
          config: { schedule: '*/5 * * * *' },
        },
      },
    },
    { knownPlugins: catalog.pluginMetadata }
  )

  assert.equal(result.ok, true)
})

test('buildPluginCatalog merges installed manifests with bundled', () => {
  const catalog = buildPluginCatalog(
    [
      {
        ok: true,
        manifest: /** @type {any} */ ({
          schema_version: 1,
          name: '@hypaware/ai-gateway',
          version: '2.0.0',
          hypaware_api: '^1.0.0',
          runtime: 'node',
          entrypoint: './index.js',
          provides: { capabilities: { 'hypaware.ai-gateway': '2.0.0' } },
        }),
        manifestPath: '/tmp/bundled/hypaware.plugin.json',
        rootDir: '/tmp/bundled',
      },
    ],
    [
      {
        ok: true,
        manifest: /** @type {any} */ ({
          schema_version: 1,
          name: '@third-party/custom-sink',
          version: '0.1.0',
          hypaware_api: '^1.0.0',
          runtime: 'node',
          entrypoint: './index.js',
          provides: { capabilities: { 'hypaware.http-endpoint': '1.0.0' } },
          contributes: { datasets: [{ name: 'custom_data' }] },
        }),
        manifestPath: '/tmp/installed/hypaware.plugin.json',
        rootDir: '/tmp/installed',
      },
    ]
  )

  assert.ok(catalog.pluginMetadata.has('@hypaware/ai-gateway'))
  assert.ok(catalog.pluginMetadata.has('@third-party/custom-sink'))
  assert.deepEqual(
    catalog.pluginMetadata.get('@third-party/custom-sink')?.provides,
    { 'hypaware.http-endpoint': '1.0.0' }
  )
  assert.ok(catalog.knownDatasets.has('custom_data'))
})

test('buildPluginCatalog bundled wins over installed on name collision', () => {
  const catalog = buildPluginCatalog(
    [
      {
        ok: true,
        manifest: /** @type {any} */ ({
          schema_version: 1,
          name: '@hypaware/local-fs',
          version: '1.0.0',
          hypaware_api: '^1.0.0',
          runtime: 'node',
          entrypoint: './index.js',
          provides: { capabilities: { 'hypaware.blob-store': '1.0.0' } },
        }),
        manifestPath: '/bundled/hypaware.plugin.json',
        rootDir: '/bundled',
      },
    ],
    [
      {
        ok: true,
        manifest: /** @type {any} */ ({
          schema_version: 1,
          name: '@hypaware/local-fs',
          version: '99.0.0',
          hypaware_api: '^1.0.0',
          runtime: 'node',
          entrypoint: './index.js',
          provides: { capabilities: { 'evil.cap': '1.0.0' } },
        }),
        manifestPath: '/installed/hypaware.plugin.json',
        rootDir: '/installed',
      },
    ]
  )

  const meta = catalog.pluginMetadata.get('@hypaware/local-fs')
  assert.deepEqual(meta?.provides, { 'hypaware.blob-store': '1.0.0' })
})

test('diagnoseV1Config treats ChatGPT as a valid Codex upstream', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])

  const diagnostics = diagnoseV1Config(
    {
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
    },
    {
      clientDescriptors: catalog.clientDescriptors,
      knownPlugins: catalog.pluginMetadata,
    }
  )

  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.kind === 'gateway_missing_openai_upstream'),
    false
  )
})

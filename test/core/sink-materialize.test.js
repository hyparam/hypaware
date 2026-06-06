// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

import { createCapabilityRegistry } from '../../src/core/registry/capabilities.js'
import { createSinkRegistry } from '../../src/core/registry/sinks.js'
import { createQueryRegistry } from '../../src/core/registry/datasets.js'
import { createSourceRegistry } from '../../src/core/registry/sources.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createConfigRegistry } from '../../src/core/config/schema.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { createBackfillMaterializerRegistry, createBackfillRegistry } from '../../src/core/registry/backfills.js'
import { materializeSinks } from '../../src/core/sinks/materialize.js'

/**
 * @import {
 *   ActivePlugin,
 *   BlobStore,
 *   HypAwareV2Config,
 *   PluginActivationContext,
 *   PluginLogger,
 *   PluginPaths,
 *   Sink,
 *   SinkEncoder,
 *   TableFormatProvider,
 * } from '../../collectivus-plugin-kernel-types.d.ts'
 * @import { KernelRuntime } from '../../src/core/runtime/activation.d.ts'
 */

function makeNoopLogger() {
  return /** @type {PluginLogger} */ ({
    debug() {}, info() {}, warn() {}, error() {},
  })
}

/**
 * @param {string} name
 * @returns {ActivePlugin}
 */
function makePlugin(name) {
  return {
    name, version: '1.0.0',
    manifest: {
      schema_version: 1, name, version: '1.0.0',
      hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './src/index.js',
    },
    rootDir: '/fake',
  }
}

/** @returns {PluginPaths} */
function makePaths() {
  return { rootDir: '/fake', stateDir: '/fake/state', cacheDir: '/fake/cache', tempDir: '/fake/tmp' }
}

/** @returns {SinkEncoder} */
function makeEncoder() {
  return {
    format: 'parquet', extension: 'parquet', supports: ['queryable'],
    async encodePartition(partition) {
      const bytes = new TextEncoder().encode(`${partition.dataset}-bytes`)
      return { filename: `${partition.dataset}.parquet`, bytes, bytesWritten: bytes.byteLength, rowCount: 1 }
    },
  }
}

/** @returns {BlobStore} */
function makeBlobStore() {
  /** @type {Map<string, Uint8Array>} */
  const objects = new Map()
  return {
    kind: 'memory',
    async putObject(input) {
      const bytes = input.body instanceof Uint8Array ? input.body : new Uint8Array()
      objects.set(input.key, bytes)
      return { key: input.key }
    },
    async getObject(input) {
      const bytes = objects.get(input.key)
      if (!bytes) return null
      return { body: Readable.from([bytes]), contentLength: bytes.byteLength }
    },
    listObjects() { return { async *[Symbol.asyncIterator]() {} } },
    async deleteObject() {},
  }
}

/** @returns {TableFormatProvider} */
function makeTableFormatProvider() {
  return {
    format: 'iceberg', supports: ['queryable'],
    async createSink(ctx) {
      return /** @type {Sink} */ ({
        async exportBatch() { return { status: 'exported', partitionsExported: 0, bytesWritten: 0 } },
        async close() {},
      })
    },
  }
}

/** @returns {Sink} */
function makeSink() {
  return {
    async exportBatch() { return { status: 'exported', partitionsExported: 0, bytesWritten: 0 } },
    async close() {},
  }
}

/**
 * @param {Partial<KernelRuntime>} [overrides]
 * @returns {KernelRuntime}
 */
function makeRuntime(overrides = {}) {
  const tmpDir = path.join(os.tmpdir(), `hyp-test-materialize-${Date.now()}`)
  const cacheRoot = path.join(tmpDir, 'cache')
  return /** @type {KernelRuntime} */ ({
    capabilities: overrides.capabilities ?? createCapabilityRegistry(),
    commands: createCommandRegistry(),
    configRegistry: createConfigRegistry(),
    sources: createSourceRegistry(),
    sinks: overrides.sinks ?? createSinkRegistry(),
    query: createQueryRegistry(),
    storage: createQueryStorageService({ cacheRoot }),
    cacheRoot,
    skills: { register() {}, list() { return [] } },
    agents: { register() {}, list() { return [] } },
    initPresets: { register() {}, get() { return undefined }, list() { return [] } },
    backfills: createBackfillRegistry(),
    backfillMaterializers: createBackfillMaterializerRegistry(),
    activationContexts: overrides.activationContexts ?? new Map(),
  })
}

/**
 * @param {string} pluginName
 * @param {KernelRuntime} runtime
 * @returns {PluginActivationContext}
 */
function registerActivationContext(pluginName, runtime) {
  const plugin = makePlugin(pluginName)
  const ctx = /** @type {PluginActivationContext} */ ({
    plugin,
    config: {},
    env: process.env,
    paths: makePaths(),
    log: makeNoopLogger(),
    permissions: { has() { return false }, require() {}, request() { return Promise.resolve(false) } },
    capabilities: runtime.capabilities,
    commands: runtime.commands,
    configRegistry: runtime.configRegistry,
    sources: runtime.sources,
    sinks: runtime.sinks,
    query: runtime.query,
    storage: runtime.storage,
    skills: runtime.skills,
    agents: runtime.agents,
    initPresets: runtime.initPresets,
    backfills: runtime.backfills,
    backfillMaterializers: runtime.backfillMaterializers,
    requireCapability(name) { return runtime.capabilities.require(pluginName, name) },
    provideCapability(name, version, value) { runtime.capabilities.provide(pluginName, name, version, value) },
  })
  runtime.activationContexts.set(pluginName, ctx)
  return ctx
}


// ----- fromProvider capability tests -----

test('fromProvider returns the capability value from the specified provider', () => {
  const registry = createCapabilityRegistry()
  registry.provide('plugin-a', 'hypaware.encoder', '1.0.0', { format: 'a' })
  registry.provide('plugin-b', 'hypaware.encoder', '1.0.0', { format: 'b' })

  const a = registry.fromProvider('plugin-a', 'hypaware.encoder')
  const b = registry.fromProvider('plugin-b', 'hypaware.encoder')

  assert.deepStrictEqual(a, { format: 'a' })
  assert.deepStrictEqual(b, { format: 'b' })
})

test('fromProvider returns undefined when the provider has not registered the capability', () => {
  const registry = createCapabilityRegistry()
  registry.provide('plugin-a', 'hypaware.encoder', '1.0.0', { format: 'a' })

  const result = registry.fromProvider('plugin-b', 'hypaware.encoder')
  assert.strictEqual(result, undefined)
})

test('fromProvider respects semver range', () => {
  const registry = createCapabilityRegistry()
  registry.provide('plugin-a', 'hypaware.encoder', '2.0.0', { format: 'v2' })

  assert.strictEqual(registry.fromProvider('plugin-a', 'hypaware.encoder', '^1.0.0'), undefined)
  assert.deepStrictEqual(registry.fromProvider('plugin-a', 'hypaware.encoder', '^2.0.0'), { format: 'v2' })
})


// ----- materializeSinks tests -----

test('materializeSinks returns empty when config has no sinks', async () => {
  const runtime = makeRuntime()
  const result = await materializeSinks(runtime, { version: 2 }, { stateRoot: '/tmp', runId: 'test' })
  assert.deepStrictEqual(result, { handles: [], errors: [] })
})

test('materializeSinks returns empty when config is null', async () => {
  const runtime = makeRuntime()
  const result = await materializeSinks(runtime, null, { stateRoot: '/tmp', runId: 'test' })
  assert.deepStrictEqual(result, { handles: [], errors: [] })
})

test('materializeSinks materializes a request sink from a plugin with one contribution', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/central', runtime)

  runtime.sinks.register({
    name: 'central-http',
    plugin: '@hypaware/central',
    supports: [],
    create: async () => makeSink(),
  })

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'my-central': { plugin: '@hypaware/central', config: { schedule: '* * * * *' } },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 0)
  assert.strictEqual(result.handles.length, 1)
  assert.strictEqual(result.handles[0].instanceName, 'my-central')
  assert.strictEqual(result.handles[0].kind, 'request')
})

test('materializeSinks errors when request sink plugin is not active', async () => {
  const runtime = makeRuntime()

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'my-central': { plugin: '@hypaware/central' },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 1)
  assert.strictEqual(result.errors[0].instance, 'my-central')
  assert.strictEqual(result.errors[0].errorKind, 'sink_plugin_not_active')
})

test('materializeSinks errors when request sink plugin has no contributions', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/central', runtime)

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'my-central': { plugin: '@hypaware/central' },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 1)
  assert.strictEqual(result.errors[0].errorKind, 'sink_contribution_missing')
})

test('materializeSinks errors when request sink plugin has multiple contributions', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/central', runtime)

  runtime.sinks.register({
    name: 'http-a',
    plugin: '@hypaware/central',
    supports: [],
    create: async () => makeSink(),
  })
  runtime.sinks.register({
    name: 'http-b',
    plugin: '@hypaware/central',
    supports: [],
    create: async () => makeSink(),
  })

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'my-central': { plugin: '@hypaware/central' },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 1)
  assert.strictEqual(result.errors[0].errorKind, 'sink_contribution_ambiguous')
})

test('materializeSinks materializes a blob sink (encoder writer + destination)', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/format-parquet', runtime)
  registerActivationContext('@hypaware/local-fs', runtime)

  runtime.capabilities.provide('@hypaware/format-parquet', 'hypaware.encoder', '1.0.0', makeEncoder())
  runtime.capabilities.provide('@hypaware/local-fs', 'hypaware.blob-store', '1.0.0', makeBlobStore())
  runtime.sinks.register({
    name: 'local-fs',
    plugin: '@hypaware/local-fs',
    supports: ['queryable'],
    create: async () => makeSink(),
  })

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'local-parquet': {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
        config: { schedule: '* * * * *' },
      },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 0)
  assert.strictEqual(result.handles.length, 1)
  assert.strictEqual(result.handles[0].instanceName, 'local-parquet')
  assert.strictEqual(result.handles[0].kind, 'blob')
  assert.strictEqual(result.handles[0].writer, '@hypaware/format-parquet')
  assert.strictEqual(result.handles[0].destination, '@hypaware/local-fs')
})

test('materializeSinks materializes a table-format sink', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/format-iceberg', runtime)
  registerActivationContext('@hypaware/format-parquet', runtime)
  registerActivationContext('@hypaware/local-fs', runtime)

  runtime.capabilities.provide('@hypaware/format-iceberg', 'hypaware.table-format', '1.0.0', makeTableFormatProvider())
  runtime.capabilities.provide('@hypaware/local-fs', 'hypaware.blob-store', '1.0.0', makeBlobStore())
  runtime.capabilities.provide('@hypaware/format-parquet', 'hypaware.encoder', '1.0.0', makeEncoder())

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'iceberg-local': {
        writer: '@hypaware/format-iceberg',
        destination: '@hypaware/local-fs',
        config: { schedule: '0 * * * *' },
      },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 0)
  assert.strictEqual(result.handles.length, 1)
  assert.strictEqual(result.handles[0].instanceName, 'iceberg-local')
  assert.strictEqual(result.handles[0].kind, 'table-format')
  assert.strictEqual(result.handles[0].writer, '@hypaware/format-iceberg')
  assert.strictEqual(result.handles[0].destination, '@hypaware/local-fs')
})

test('materializeSinks table-format sink uses config.encoder pin', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/format-iceberg', runtime)
  registerActivationContext('@hypaware/format-jsonl', runtime)
  registerActivationContext('@hypaware/local-fs', runtime)

  runtime.capabilities.provide('@hypaware/format-iceberg', 'hypaware.table-format', '1.0.0', makeTableFormatProvider())
  runtime.capabilities.provide('@hypaware/local-fs', 'hypaware.blob-store', '1.0.0', makeBlobStore())
  const jsonlEncoder = { ...makeEncoder(), format: 'jsonl', extension: 'jsonl' }
  runtime.capabilities.provide('@hypaware/format-jsonl', 'hypaware.encoder', '1.0.0', jsonlEncoder)

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'iceberg-jsonl': {
        writer: '@hypaware/format-iceberg',
        destination: '@hypaware/local-fs',
        config: { encoder: '@hypaware/format-jsonl', schedule: '0 * * * *' },
      },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 0)
  assert.strictEqual(result.handles[0].encoder?.format, 'jsonl')
})

test('materializeSinks errors when writer plugin is not active', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/local-fs', runtime)

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'broken': {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
      },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 1)
  assert.strictEqual(result.errors[0].errorKind, 'sink_plugin_not_active')
  assert.ok(result.errors[0].message.includes('writer'))
})

test('materializeSinks errors when destination plugin is not active', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/format-parquet', runtime)
  runtime.capabilities.provide('@hypaware/format-parquet', 'hypaware.encoder', '1.0.0', makeEncoder())

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'broken': {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
      },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 1)
  assert.strictEqual(result.errors[0].errorKind, 'sink_plugin_not_active')
  assert.ok(result.errors[0].message.includes('destination'))
})

test('materializeSinks errors when writer provides neither encoder nor table-format', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/format-parquet', runtime)
  registerActivationContext('@hypaware/local-fs', runtime)

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'broken': {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
      },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 1)
  assert.strictEqual(result.errors[0].errorKind, 'sink_capability_missing')
})

test('materializeSinks errors when table-format destination has no blob-store', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/format-iceberg', runtime)
  registerActivationContext('@hypaware/local-fs', runtime)
  registerActivationContext('@hypaware/format-parquet', runtime)

  runtime.capabilities.provide('@hypaware/format-iceberg', 'hypaware.table-format', '1.0.0', makeTableFormatProvider())
  runtime.capabilities.provide('@hypaware/format-parquet', 'hypaware.encoder', '1.0.0', makeEncoder())

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'broken': {
        writer: '@hypaware/format-iceberg',
        destination: '@hypaware/local-fs',
      },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 1)
  assert.strictEqual(result.errors[0].errorKind, 'sink_capability_missing')
  assert.ok(result.errors[0].message.includes('blob-store'))
})

test('materializeSinks errors when table-format encoder pin is not active', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/format-iceberg', runtime)
  registerActivationContext('@hypaware/local-fs', runtime)

  runtime.capabilities.provide('@hypaware/format-iceberg', 'hypaware.table-format', '1.0.0', makeTableFormatProvider())
  runtime.capabilities.provide('@hypaware/local-fs', 'hypaware.blob-store', '1.0.0', makeBlobStore())

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'broken': {
        writer: '@hypaware/format-iceberg',
        destination: '@hypaware/local-fs',
        config: { encoder: '@hypaware/format-jsonl' },
      },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 1)
  assert.strictEqual(result.errors[0].errorKind, 'sink_capability_missing')
  assert.ok(result.errors[0].message.includes('format-jsonl'))
})

test('materializeSinks continues past failures and reports all errors', async () => {
  const runtime = makeRuntime()

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'bad-a': { plugin: '@hypaware/central' },
      'bad-b': { plugin: '@hypaware/webhook' },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 2)
  assert.strictEqual(result.handles.length, 0)
  assert.strictEqual(result.errors[0].instance, 'bad-a')
  assert.strictEqual(result.errors[1].instance, 'bad-b')
})

test('materializeSinks destination contribution missing for blob sink', async () => {
  const runtime = makeRuntime()
  registerActivationContext('@hypaware/format-parquet', runtime)
  registerActivationContext('@hypaware/local-fs', runtime)
  runtime.capabilities.provide('@hypaware/format-parquet', 'hypaware.encoder', '1.0.0', makeEncoder())

  const config = /** @type {HypAwareV2Config} */ ({
    version: 2,
    sinks: {
      'no-contrib': {
        writer: '@hypaware/format-parquet',
        destination: '@hypaware/local-fs',
      },
    },
  })

  const result = await materializeSinks(runtime, config, { stateRoot: '/tmp', runId: 'test' })
  assert.strictEqual(result.errors.length, 1)
  assert.strictEqual(result.errors[0].errorKind, 'sink_contribution_missing')
})

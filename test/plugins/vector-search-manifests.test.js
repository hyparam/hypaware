// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadManifests } from '../../src/core/manifest.js'
import {
  V1_BUNDLED_PLUGIN_ALLOWLIST,
  V1_EXCLUDED_FROM_DEFAULT,
} from '../../src/core/runtime/bundled.js'
import { parseVectorSearchArgv } from '../../hypaware-core/plugins-workspace/vector-search/src/commands.js'

const WORKSPACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hypaware-core/plugins-workspace'
)

test('embedder-openai and vector-search manifests load and validate', async () => {
  const { loaded, failed } = await loadManifests([
    path.join(WORKSPACE, 'embedder-openai'),
    path.join(WORKSPACE, 'vector-search'),
  ])
  assert.equal(failed.length, 0, failed.map((f) => f.message).join('; '))
  assert.equal(loaded.length, 2)

  const embedder = loaded.find((l) => l.manifest.name === '@hypaware/embedder-openai')
  assert.ok(embedder)
  assert.deepEqual(embedder.manifest.provides?.capabilities, { 'hypaware.embedder': '1.0.0' })
  assert.deepEqual(embedder.manifest.permissions, ['network', 'read_env'])

  const vector = loaded.find((l) => l.manifest.name === '@hypaware/vector-search')
  assert.ok(vector)
  assert.deepEqual(vector.manifest.provides?.capabilities, { 'hypaware.vector-search': '1.0.0' })
  assert.deepEqual(vector.manifest.requires?.capabilities, { 'hypaware.embedder': '^1.0.0' })
})

test('both plugins are bundled but excluded from default activation', () => {
  assert.ok(V1_EXCLUDED_FROM_DEFAULT.has('@hypaware/embedder-openai'))
  assert.ok(V1_EXCLUDED_FROM_DEFAULT.has('@hypaware/vector-search'))
  assert.ok(!V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/embedder-openai'))
  assert.ok(!V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/vector-search'))
})

test('parseVectorSearchArgv parses flags in any order and joins the query', () => {
  const parsed = parseVectorSearchArgv(['how', 'do', 'I', '--top-k', '5', '--no-refresh', '--format', 'json'])
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.query, 'how do I')
  assert.equal(parsed.topK, 5)
  assert.equal(parsed.refresh, 'never')
  assert.equal(parsed.format, 'json')
})

test('parseVectorSearchArgv rejects a missing query and bad flags', () => {
  assert.equal(parseVectorSearchArgv([]).ok, false)
  assert.equal(parseVectorSearchArgv(['q', '--top-k', '0']).ok, false)
  assert.equal(parseVectorSearchArgv(['q', '--format', 'yaml']).ok, false)
  assert.equal(parseVectorSearchArgv(['q', '--index']).ok, false)
})

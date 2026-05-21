// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateManifest } from '../../src/core/manifest.js'
import { matchesSemverRange } from '../../src/core/semver.js'

test('validateManifest accepts the plugin manifest fields the kernel consumes', () => {
  const result = validateManifest({
    schema_version: 1,
    name: '@hypaware/example',
    version: '1.2.3',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
    description: 'Example plugin',
    requires: {
      plugins: { '@hypaware/ai-gateway': '^1.0.0' },
      capabilities: { 'hypaware.blob-store': '^1.0.0' },
    },
    provides: {
      capabilities: { 'hypaware.encoder': '1.0.0' },
    },
    permissions: ['network'],
    contributes: {
      commands: [],
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.manifest.name, '@hypaware/example')
})

test('validateManifest rejects malformed nested maps', () => {
  const result = validateManifest({
    schema_version: 1,
    name: '@hypaware/example',
    version: '1.2.3',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
    provides: {
      capabilities: { 'hypaware.encoder': 1 },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'manifest_invalid')
  assert.equal(result.message, 'provides.capabilities must be a map of capability name -> version')
})

test('matchesSemverRange covers exact, wildcard, caret, tilde, and comparisons', () => {
  assert.equal(matchesSemverRange('1.2.3', '1.2.3'), true)
  assert.equal(matchesSemverRange('1.2.3', '*'), true)
  assert.equal(matchesSemverRange('1.4.0', '^1.2.3'), true)
  assert.equal(matchesSemverRange('2.0.0', '^1.2.3'), false)
  assert.equal(matchesSemverRange('1.2.9', '~1.2.3'), true)
  assert.equal(matchesSemverRange('1.3.0', '~1.2.3'), false)
  assert.equal(matchesSemverRange('1.2.4', '>1.2.3'), true)
  assert.equal(matchesSemverRange('1.2.3', '>1.2.3'), false)
  assert.equal(matchesSemverRange('1.2.3', '<=1.2.3'), true)
})

test('matchesSemverRange preserves zero-major caret behavior', () => {
  assert.equal(matchesSemverRange('0.2.5', '^0.2.3'), true)
  assert.equal(matchesSemverRange('0.3.0', '^0.2.3'), false)
  assert.equal(matchesSemverRange('0.0.3', '^0.0.3'), true)
  assert.equal(matchesSemverRange('0.0.4', '^0.0.3'), false)
})

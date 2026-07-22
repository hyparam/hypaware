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

/** Minimal valid manifest scaffold for picker-contribution cases. */
function baseManifest(contributes) {
  return {
    schema_version: 1,
    name: '@hypaware/example',
    version: '1.2.3',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
    contributes,
  }
}

test('validateManifest accepts a picker array with all three probe variants', () => {
  const result = validateManifest(
    baseManifest({
      picker: [
        { label: 'Claude Code', summary: 'capture conversations', detect: { settings_file: '.claude/settings.json' } },
        { label: 'Claude Desktop', detect: { app_bundle: '/Applications/Claude.app' }, needs_setup: true, configure_command: 'claude-desktop install' },
        { label: 'Hermes', detect: { path: '~/.hermes' } },
      ],
    })
  )
  assert.equal(result.ok, true)
})

test('validateManifest accepts a picker row without a detect probe', () => {
  const result = validateManifest(baseManifest({ picker: [{ label: 'OTEL export' }] }))
  assert.equal(result.ok, true)
})

test('validateManifest keeps unknown picker fields opaque (e.g. compose)', () => {
  const result = validateManifest(
    baseManifest({
      picker: [{ label: 'raw Anthropic', compose: { plugin: '@hypaware/claude', requires_gateway: true } }],
    })
  )
  assert.equal(result.ok, true)
})

test('validateManifest rejects a non-array picker', () => {
  const result = validateManifest(baseManifest({ picker: { label: 'nope' } }))
  assert.equal(result.ok, false)
  assert.equal(result.message, 'contributes.picker must be an array when present')
})

test('validateManifest rejects a picker row missing a label', () => {
  const result = validateManifest(baseManifest({ picker: [{ summary: 'no label' }] }))
  assert.equal(result.ok, false)
  assert.equal(result.message, 'contributes.picker entries require a label (string)')
})

test('validateManifest rejects a detect probe with no recognized variant', () => {
  const result = validateManifest(baseManifest({ picker: [{ label: 'x', detect: { bogus: 'y' } }] }))
  assert.equal(result.ok, false)
  assert.equal(
    result.message,
    'contributes.picker detect must set exactly one of settings_file, app_bundle, path'
  )
})

test('validateManifest rejects a detect probe with more than one variant', () => {
  const result = validateManifest(
    baseManifest({ picker: [{ label: 'x', detect: { app_bundle: '/A.app', path: '~/.a' } }] })
  )
  assert.equal(result.ok, false)
  assert.equal(
    result.message,
    'contributes.picker detect must set exactly one of settings_file, app_bundle, path'
  )
})

test('validateManifest rejects a non-string probe path', () => {
  const result = validateManifest(baseManifest({ picker: [{ label: 'x', detect: { path: 5 } }] }))
  assert.equal(result.ok, false)
  assert.equal(result.message, 'contributes.picker detect.path must be a non-empty string')
})

test('validateManifest rejects a non-boolean needs_setup', () => {
  const result = validateManifest(baseManifest({ picker: [{ label: 'x', needs_setup: 'yes' }] }))
  assert.equal(result.ok, false)
  assert.equal(result.message, 'contributes.picker needs_setup must be a boolean when present')
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

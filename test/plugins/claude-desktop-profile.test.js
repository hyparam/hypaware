// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { compileConfig } from '../../hypaware-core/plugins-workspace/ai-gateway/src/config.js'
import { validateClaudeDesktopConfig } from '../../hypaware-core/plugins-workspace/claude-desktop/src/config.js'
import {
  DEFAULT_MODELS,
  STABLE_DEFAULT_LISTEN,
  buildManagedProfile,
  renderCredentialHelperScript,
  renderManagedPreferencesPlist,
  resolveGatewayBaseUrl,
} from '../../hypaware-core/plugins-workspace/claude-desktop/src/profile.js'

/** @import { HypAwareV2Config } from '../../hypaware-plugin-kernel-types.js' */

/**
 * @param {Record<string, unknown> | undefined} gatewayConfig
 * @returns {HypAwareV2Config}
 */
function hypConfigWithGateway(gatewayConfig) {
  return {
    version: 2,
    plugins: [
      { name: /** @type {never} */ ('@hypaware/ai-gateway'), config: /** @type {any} */ (gatewayConfig) },
      { name: /** @type {never} */ ('@hypaware/claude') },
    ],
  }
}

const MINIMAL_UPSTREAMS = { anthropic: { base_url: 'https://api.anthropic.com' } }

test('the duplicated stable default listen matches the ai-gateway default (parity)', () => {
  const compiled = compileConfig({ upstreams: MINIMAL_UPSTREAMS })
  assert.equal(compiled.listen, STABLE_DEFAULT_LISTEN)
  assert.equal(compiled.listenConfigured, false)
})

test('resolveGatewayBaseUrl uses the fixed default when the fleet sets no listen', () => {
  assert.equal(
    resolveGatewayBaseUrl({ hypConfig: hypConfigWithGateway(undefined), sectionConfig: {} }),
    `http://${STABLE_DEFAULT_LISTEN}`,
  )
  assert.equal(
    resolveGatewayBaseUrl({ hypConfig: { version: 2 }, sectionConfig: {} }),
    `http://${STABLE_DEFAULT_LISTEN}`,
  )
})

test('resolveGatewayBaseUrl honors an explicit fleet listen', () => {
  assert.equal(
    resolveGatewayBaseUrl({
      hypConfig: hypConfigWithGateway({ listen: '127.0.0.1:9999' }),
      sectionConfig: {},
    }),
    'http://127.0.0.1:9999',
  )
})

test('resolveGatewayBaseUrl refuses an ephemeral listen', () => {
  assert.throws(
    () => resolveGatewayBaseUrl({
      hypConfig: hypConfigWithGateway({ listen: '127.0.0.1:0' }),
      sectionConfig: {},
    }),
    /stable port/,
  )
  assert.throws(
    () => resolveGatewayBaseUrl({
      hypConfig: hypConfigWithGateway(undefined),
      sectionConfig: { endpoint: 'http://127.0.0.1:0' },
    }),
    /stable port/,
  )
})

test('resolveGatewayBaseUrl honors and normalizes the endpoint override', () => {
  assert.equal(
    resolveGatewayBaseUrl({
      hypConfig: hypConfigWithGateway({ listen: '127.0.0.1:9999' }),
      sectionConfig: { endpoint: 'http://10.0.0.5:18521/' },
    }),
    'http://10.0.0.5:18521',
  )
  assert.throws(
    () => resolveGatewayBaseUrl({
      hypConfig: hypConfigWithGateway(undefined),
      sectionConfig: { endpoint: 'ftp://nope' },
    }),
    /http\(s\)/,
  )
})

test('buildManagedProfile renders the app schema and carries no secret material', () => {
  const profile = buildManagedProfile({
    baseUrl: `http://${STABLE_DEFAULT_LISTEN}`,
    authScheme: 'bearer',
    models: [...DEFAULT_MODELS],
    helperPath: '/Users/x/.hyp/hypaware/plugins/@hypaware/claude-desktop/credential-helper.sh',
    bundleId: 'com.anthropic.claudefordesktop',
  })
  assert.deepEqual(profile, {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: 'http://127.0.0.1:18521',
    inferenceGatewayAuthScheme: 'bearer',
    inferenceModels: [
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
      'claude-fable-5',
    ],
    inferenceCredentialKind: 'helper-script',
    inferenceCredentialHelper: '/Users/x/.hyp/hypaware/plugins/@hypaware/claude-desktop/credential-helper.sh',
  })
  const serialized = JSON.stringify(profile)
  assert.ok(!/sk-ant|api[_-]?key['":]/i.test(serialized), 'profile must not embed credentials')
})

test('org_key mode renders under the x-api-key scheme', () => {
  const profile = buildManagedProfile({
    baseUrl: `http://${STABLE_DEFAULT_LISTEN}`,
    authScheme: 'x-api-key',
    models: ['claude-sonnet-5'],
    helperPath: '/usr/local/hyp/credential-helper.sh',
    bundleId: 'com.anthropic.claudefordesktop',
  })
  assert.equal(profile.inferenceGatewayAuthScheme, 'x-api-key')
  assert.equal(profile.inferenceCredentialKind, 'helper-script')
})

test('renderCredentialHelperScript wraps the credential command via the absolute interpreter, no args', () => {
  const script = renderCredentialHelperScript({
    nodeBin: '/usr/local/bin/node',
    hypBin: '/usr/local/bin/hyp.js',
    args: ['claude-account', 'credential'],
  })
  assert.ok(script.startsWith('#!/bin/sh\n'))
  assert.ok(script.includes('exec /usr/local/bin/node /usr/local/bin/hyp.js claude-account credential'))
})

test('renderCredentialHelperScript shell-quotes a path with spaces', () => {
  const script = renderCredentialHelperScript({
    nodeBin: '/usr/local/bin/node',
    hypBin: '/Applications/My App/hyp.js',
    args: ['claude-account', 'credential'],
  })
  assert.ok(script.includes("exec /usr/local/bin/node '/Applications/My App/hyp.js' claude-account credential"))
})

test('renderCredentialHelperScript embeds a non-default HYP env, omits an empty one', () => {
  const withEnv = renderCredentialHelperScript({
    nodeBin: '/usr/local/bin/node',
    hypBin: '/usr/local/bin/hyp.js',
    args: ['claude-account', 'credential'],
    env: { HYP_HOME: '/opt/hyp home', HYP_CONFIG: '/etc/hyp/config.json', UNRELATED: 'x' },
  })
  assert.ok(withEnv.includes("export HYP_HOME='/opt/hyp home'"))
  assert.ok(withEnv.includes('export HYP_CONFIG=/etc/hyp/config.json'))
  assert.ok(!withEnv.includes('UNRELATED'))
  assert.ok(withEnv.indexOf('export HYP_HOME') < withEnv.indexOf('exec '))

  const noEnv = renderCredentialHelperScript({
    nodeBin: '/usr/local/bin/node',
    hypBin: '/usr/local/bin/hyp.js',
    args: ['claude-account', 'credential'],
    env: {},
  })
  assert.ok(!noEnv.includes('export HYP_'))
})

test('renderManagedPreferencesPlist emits a well-formed dict', () => {
  const profile = buildManagedProfile({
    baseUrl: 'http://127.0.0.1:18521',
    authScheme: 'bearer',
    models: ['claude-sonnet-5', 'claude-opus-4-8'],
    helperPath: '/path/with <angle>/credential-helper.sh',
    bundleId: 'com.anthropic.claudefordesktop',
  })
  const plist = renderManagedPreferencesPlist(profile)
  assert.ok(plist.startsWith('<?xml version="1.0"'))
  assert.ok(plist.includes('<key>inferenceProvider</key>'))
  assert.ok(plist.includes('<string>gateway</string>'))
  assert.ok(plist.includes('<string>claude-opus-4-8</string>'))
  assert.ok(plist.includes('&lt;angle&gt;'), 'XML-escapes helper path')
  assert.ok(!plist.includes('<angle>'))
})

test('validateClaudeDesktopConfig accepts valid shapes and rejects typos', () => {
  assert.deepEqual(validateClaudeDesktopConfig(undefined), { ok: true })
  assert.deepEqual(validateClaudeDesktopConfig({}), { ok: true })
  assert.deepEqual(
    validateClaudeDesktopConfig({
      models: ['claude-sonnet-5'],
      endpoint: 'http://127.0.0.1:18521',
      helper_path: '/usr/local/bin/hyp',
      bundle_id: 'com.anthropic.claudefordesktop',
    }),
    { ok: true },
  )
  for (const bad of [{ models: [] }, { models: ['ok', 3] }, { endpoint: '' }, { modles: ['x'] }]) {
    const result = validateClaudeDesktopConfig(bad)
    assert.equal(result.ok, false, JSON.stringify(bad))
  }
})

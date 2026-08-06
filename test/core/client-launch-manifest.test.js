// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

// The manifest half of the first ask (LLP 0195#split): a client declares
// how to start it on a question, and a spec that cannot carry the
// question is not a launch spec.
// @ref LLP 0195#split [tests]:

/**
 * @param {unknown} launch
 * @returns {any}
 */
function manifestWithLaunch(launch) {
  return {
    manifest: {
      name: '@test/client',
      version: '1.0.0',
      contributes: {
        client: { name: 'testclient', skill_dir: '.test/skills', launch },
      },
    },
  }
}

test('the bundled CLI clients declare a launch spec; each carries {prompt}', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  for (const name of ['claude', 'codex']) {
    const launch = catalog.clientDescriptors.get(name)?.launch
    assert.ok(launch, `${name} should be launchable`)
    assert.equal(launch.bin, name)
    assert.ok(launch.args.some((a) => a.includes('{prompt}')), `${name} launch args must carry {prompt}`)
    assert.ok(launch.label, `${name} should name itself for the menu`)
  }
})

test('a launch spec without {prompt} is dropped: launchable and mute is worse than not launchable', () => {
  const catalog = buildPluginCatalog([manifestWithLaunch({ bin: 'x', args: ['--interactive'] })])
  assert.equal(catalog.clientDescriptors.get('testclient')?.launch, undefined)
})

test('a malformed launch spec is dropped, and never fails catalog construction', () => {
  for (const bad of [
    { bin: '', args: ['{prompt}'] },
    { bin: 'x' },
    { bin: 'x', args: '{prompt}' },
    { bin: 'x', args: [42] },
    null,
    'claude',
  ]) {
    const catalog = buildPluginCatalog([manifestWithLaunch(bad)])
    const descriptor = catalog.clientDescriptors.get('testclient')
    assert.ok(descriptor, 'the client itself still registers')
    assert.equal(descriptor.launch, undefined, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})

test('a client with no launch spec stays unlaunchable (Claude Desktop has no prompt argument)', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const desktop = catalog.clientDescriptors.get('claude-desktop')
  if (desktop) assert.equal(desktop.launch, undefined)
})

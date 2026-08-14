// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

// The manifest half of the first ask (LLP 0198#split): a client declares
// how to start it on a question, and a spec that cannot carry the
// question is not a launch spec.
// @ref LLP 0198#split [tests]:

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

/**
 * The stems of the flags that widen what a launched client may do.
 *
 * A pattern rather than a list of whole flags, because the decision it
 * pins says "or any equivalent" and the equivalents are open-ended: the
 * same permission is granted by `--permission-mode acceptEdits`, by
 * `--dangerously-bypass-approvals-and-sandbox`, by `--yolo`, and by an
 * `=true` suffixed form of any of them. Matched unanchored so a flag
 * embedded in a larger argument string is caught too. A false positive
 * here is a loud test failure someone reads; a false negative is a
 * session that silently starts pre-authorized.
 *
 * These are string literals to assert the absence of. Nothing here
 * passes any of them to anything.
 */
const PREAUTH_FLAG = /(-{1,2})(dangerously|allowedTools|permission-mode|full-auto|yolo|sandbox|ask-for-approval)/i

// Short forms are too short to pattern-match by stem, but they still take
// the attached-value shapes clap accepts: codex reads -a=never and -anever
// as the same thing as -a never. Prefix-matching denies all three, and any
// future short flag starting -a, which is the same loud-failure trade the
// long form already makes.
const PREAUTH_SHORT_FLAG = /^-a/

/**
 * @param {string} arg
 * @returns {boolean}
 */
function isPreauthFlag(arg) {
  return PREAUTH_FLAG.test(arg) || PREAUTH_SHORT_FLAG.test(arg)
}

// The launched session gets no more permission than the user would grant
// it by hand: HypAware never widens what the client may do just because
// it started the session. Asserted as literal string absence, not as a
// claim about what the flags do.
// @ref LLP 0198#no-preauth [tests]: the bundled launch specs never carry a permission-widening flag
test('the bundled CLI clients\' launch args never carry a permission-widening flag', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  for (const name of ['claude', 'codex']) {
    const launch = catalog.clientDescriptors.get(name)?.launch
    // Keeps the assertion from passing vacuously: a client that lost its
    // launch block has no args to scan, and would otherwise sail through.
    assert.ok(launch, `${name} should be launchable`)
    for (const arg of launch.args) {
      assert.ok(!isPreauthFlag(arg), `${name} launch args must not carry ${arg}`)
    }
  }
})

// The denylist's own reach, pinned by example. The assertion above is
// only as good as what this matches, and its first form was an exact
// two-entry list that `--yolo` and `--permission-mode acceptEdits` would
// have walked straight past.
// @ref LLP 0198#no-preauth [tests]: "or any equivalent" is the load-bearing half
test('the permission-widening denylist covers the documented equivalents', () => {
  for (const flag of [
    '--allowedTools',
    '--dangerously-skip-permissions',
    '--dangerously-skip-permissions=true',
    '--dangerously-bypass-approvals-and-sandbox',
    '--permission-mode',
    '--permission-mode=acceptEdits',
    '--full-auto',
    '--yolo',
    '--sandbox',
    '--sandbox=danger-full-access',
    '--ask-for-approval',
    '-a=never',
    '-anever',
    '-a',
  ]) {
    assert.ok(isPreauthFlag(flag), `${flag} should be denied`)
  }
  // And does not flag the ordinary shape of a launch spec, so a client
  // that grows a legitimate argument is not blocked by superstition.
  for (const benign of ['{prompt}', '--print', '--model', 'exec', '-p', 'chat']) {
    assert.ok(!isPreauthFlag(benign), `${benign} should not be denied`)
  }
})

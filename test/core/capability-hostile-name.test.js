// @ts-check

// `CapabilityRegistry.provide` pushed `{ provider, name, version, value }`
// onto its list with no check on `name` or `version`, and
// `ctx.provideCapability` forwards a plugin's arguments to it untouched.
// `list()` then rebuilt `{ name, version, provider }` out of the stored
// values, so whatever a plugin passed came back out under fields
// `CapabilityRegistration` declares `string` - a non-string capability name
// reached every consumer of the listing, the plugin doctor's
// `RegisteredSnapshot.capabilities` (`string[]`) included (issue #1559).
// Capabilities were the one channel on the activation context with no such
// check; every sibling registry refuses a non-string non-empty name.
//
// Driven through a real boot, because the value has to arrive the way a
// plugin sends it: `ctx.provideCapability` inside `activate()`. Each case
// boots a well-behaved neighbour alongside the offender, so a refusal that
// emptied the whole listing would fail here too.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { resolveDependencies } from '../../src/core/dep_graph.js'
import { bootKernel } from '../../src/core/runtime/boot.js'

const HOSTILE = '@hypaware/local-fs'
const NEIGHBOUR = '@hypaware/format-jsonl'

/**
 * Write one bundled-plugin fixture into a synthetic workspace. The names have
 * to be real bundled names: discovery buckets on a fixed name set.
 *
 * @param {{ workspaceDir: string, dir: string, name: string, body: string }} args
 */
async function writeFixture({ workspaceDir, dir, name, body }) {
  const rootDir = path.join(workspaceDir, dir)
  await fs.mkdir(rootDir, { recursive: true })
  await fs.writeFile(
    path.join(rootDir, 'hypaware.plugin.json'),
    JSON.stringify({
      schema_version: 1,
      name,
      version: '2.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './index.js',
    })
  )
  await fs.writeFile(path.join(rootDir, 'index.js'), body)
}

/** The neighbour: an ordinary provide, the one every assertion below expects to survive. */
const NEIGHBOUR_BODY = [
  'export async function activate(ctx) {',
  "  ctx.provideCapability('hypaware.neighbour', '1.0.0', { ok: true })",
  '}',
  '',
].join('\n')

/**
 * Boot the two fixtures and hand back the boot plus the capability listing.
 *
 * @param {string} label
 * @param {string} hostileBody
 */
async function bootWith(label, hostileBody) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), `hyp-cap-${label}-`))
  const workspaceDir = path.join(hypHome, 'workspace')
  await writeFixture({ workspaceDir, dir: 'local-fs', name: HOSTILE, body: hostileBody })
  await writeFixture({ workspaceDir, dir: 'format-jsonl', name: NEIGHBOUR, body: NEIGHBOUR_BODY })
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(
    configPath,
    JSON.stringify({ version: 2, plugins: [HOSTILE, NEIGHBOUR].map((name) => ({ name, config: {} })) })
  )
  const boot = await bootKernel({
    hypHome,
    configPath,
    workspaceDir,
    mode: 'smoke',
    runId: `cap-hostile-${label}`,
    env: { ...process.env, HYP_HOME: hypHome },
  })
  return { boot, hypHome, listed: boot.runtime.capabilities.list() }
}

/**
 * @param {{ ok: boolean, plugin: { name: string }, errorKind?: string, message?: string }[]} activations
 * @param {string} name
 */
function activationOf(activations, name) {
  const found = activations.find((r) => r.plugin.name === name)
  assert.ok(found, `no activation record for ${name}`)
  return found
}

test('a capability name that is not a string never reaches capabilities.list()', async () => {
  // The issue's repro: a name whose only stringification throws. Nothing here
  // asks it to stringify, which is the point - it is stored and republished.
  const { boot, hypHome, listed } = await bootWith('name', [
    'export async function activate(ctx) {',
    "  ctx.provideCapability({ toString() { throw new Error('boom') } }, '1.0.0', {})",
    '}',
    '',
  ].join('\n'))
  try {
    assert.deepEqual(
      listed.map((c) => typeof c.name),
      listed.map(() => 'string'),
      'capabilities.list() handed a consumer a name that is not a string'
    )
    // What a consumer actually sees: the neighbour's capability, and only it.
    assert.deepEqual(
      listed.map((c) => c.name),
      ['hypaware.neighbour'],
      'the refusal took the well-behaved neighbour down with it'
    )
    assert.equal(boot.runtime.capabilities.has('hypaware.neighbour'), true)

    const hostile = activationOf(boot.activations, HOSTILE)
    assert.equal(hostile.ok, false, 'the offending plugin activated anyway')
    assert.equal(hostile.errorKind, 'activate_failed')
    assert.match(String(hostile.message), /name must be a non-empty string/)
    assert.equal(activationOf(boot.activations, NEIGHBOUR).ok, true)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('an empty capability name never reaches capabilities.list()', async () => {
  const { boot, hypHome, listed } = await bootWith('empty', [
    'export async function activate(ctx) {',
    "  ctx.provideCapability('', '1.0.0', {})",
    '}',
    '',
  ].join('\n'))
  try {
    assert.deepEqual(listed.map((c) => c.name), ['hypaware.neighbour'])
    assert.equal(activationOf(boot.activations, HOSTILE).ok, false)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a capability version that is not a string never reaches capabilities.list()', async () => {
  // `requireCapability` with no range matches this registration outright:
  // `matchesSemverRange` answers `true` for an absent range without ever
  // reading the version, so an object version resolved and then travelled out
  // through `list()` and the `cap.require_satisfied` record.
  const { boot, hypHome, listed } = await bootWith('version', [
    'export async function activate(ctx) {',
    "  ctx.provideCapability('hypaware.hostile-version', { major: 1 }, {})",
    '}',
    '',
  ].join('\n'))
  try {
    assert.deepEqual(
      listed.map((c) => typeof c.version),
      listed.map(() => 'string'),
      'capabilities.list() handed a consumer a version that is not a string'
    )
    assert.deepEqual(listed.map((c) => c.name), ['hypaware.neighbour'])
    assert.equal(
      boot.runtime.capabilities.has('hypaware.hostile-version'),
      false,
      'an unversioned registration is still resolvable by a require with no range'
    )
    const hostile = activationOf(boot.activations, HOSTILE)
    assert.equal(hostile.ok, false)
    assert.match(String(hostile.message), /version must be a non-empty string/)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a manifest declaring an empty capability name resolves instead of failing the boot', async () => {
  // `dep_graph` provides from `provides.capabilities` before arbitrating
  // duplicate providers, and `bootKernel` does not catch a throw from
  // `resolveDependencies`. The manifest validator admits a map of strings
  // without requiring them non-empty, so the refusal above has to not reach
  // this lane: one plugin's malformed declaration must cost that declaration,
  // never the whole boot.
  /** @type {any[]} */
  const manifests = [
    {
      schema_version: 1, name: 'a', version: '1.0.0', hypaware_api: '^1.0.0',
      runtime: 'node', entrypoint: './i.js', provides: { capabilities: { '': '1.0.0' } },
    },
    {
      schema_version: 1, name: 'b', version: '1.0.0', hypaware_api: '^1.0.0',
      runtime: 'node', entrypoint: './i.js', provides: { capabilities: { '': '2.0.0', 'cap.real': '1.0.0' } },
    },
  ]

  const resolution = await resolveDependencies(manifests)

  assert.deepEqual(resolution.order, ['a', 'b'], 'a malformed declaration eliminated a plugin')
  assert.deepEqual(
    resolution.unsatisfied,
    [],
    'two plugins naming no capability were arbitrated as clashing providers of the empty name'
  )
  assert.deepEqual(
    resolution.registry.list().map((c) => c.name),
    ['cap.real'],
    'the empty name reached the capability listing'
  )
})

test('an empty capability version never reaches capabilities.list()', async () => {
  // The other half of the version guard. An empty version is not "unversioned":
  // `matchesSemverRange('', undefined)` answers `true` before it reads the
  // version at all, so a require with no range resolved this registration
  // outright, exactly as the object version above did.
  const { boot, hypHome, listed } = await bootWith('emptyversion', [
    'export async function activate(ctx) {',
    "  ctx.provideCapability('hypaware.hostile-version', '', {})",
    '}',
    '',
  ].join('\n'))
  try {
    assert.deepEqual(listed.map((c) => c.name), ['hypaware.neighbour'])
    assert.equal(
      boot.runtime.capabilities.has('hypaware.hostile-version'),
      false,
      'an empty-versioned registration is still resolvable by a require with no range'
    )
    const hostile = activationOf(boot.activations, HOSTILE)
    assert.equal(hostile.ok, false)
    assert.match(String(hostile.message), /version must be a non-empty string/)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

test('a manifest declaring an empty capability version resolves instead of failing the boot', async () => {
  // The version half of the same skip. `isStringMap` holds the values of
  // `provides.capabilities` to strings but not to non-empty ones, so a
  // manifest that validates can declare `''` here too, and the refusal above
  // would take the whole boot with it rather than the declaration.
  /** @type {any[]} */
  const manifests = [
    {
      schema_version: 1, name: 'a', version: '1.0.0', hypaware_api: '^1.0.0',
      runtime: 'node', entrypoint: './i.js',
      provides: { capabilities: { 'cap.unversioned': '', 'cap.real': '1.0.0' } },
    },
  ]

  const resolution = await resolveDependencies(manifests)

  assert.deepEqual(resolution.order, ['a'], 'a malformed declaration eliminated a plugin')
  assert.deepEqual(resolution.unsatisfied, [])
  assert.deepEqual(
    resolution.registry.list().map((c) => c.name),
    ['cap.real'],
    'the empty version reached the capability listing'
  )
})

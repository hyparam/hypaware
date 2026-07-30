// @ts-check

/**
 * @import { ClientDescriptor } from '../../src/core/types.js'
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyContainerSession,
  classifyTranscriptEntrypoint,
  resolveEntrypointOwners,
  sessionEntrypoint,
} from '../../src/core/backfill/entrypoint_owner.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'

/**
 * @param {string} name
 * @param {string} plugin
 * @param {string[]} [entrypoints]
 * @returns {ClientDescriptor}
 */
function client(name, plugin, entrypoints) {
  return {
    plugin: /** @type {any} */ (plugin),
    name,
    skillDir: `.${name}/skills`,
    ...(entrypoints ? { transcriptEntrypoints: entrypoints } : {}),
  }
}

/** @returns {Promise<Map<string, ClientDescriptor>>} */
async function realClientDescriptors() {
  const bundled = await discoverBundledPlugins()
  return buildPluginCatalog([...bundled.loaded, ...bundled.excluded]).clientDescriptors
}

test('resolveEntrypointOwners maps each declared entrypoint to its owning client', () => {
  const owners = resolveEntrypointOwners(
    [client('claude', '@hypaware/claude', ['cli']), client('desk', '@hypaware/desk', ['a', 'b'])],
    () => true
  )
  assert.deepEqual([...owners.keys()], ['cli', 'a', 'b'])
  assert.equal(owners.get('a')?.client, 'desk')
  assert.equal(owners.get('a')?.plugin, '@hypaware/desk')
})

test('resolveEntrypointOwners records whether each owning plugin is configured', () => {
  const owners = resolveEntrypointOwners(
    [client('claude', '@hypaware/claude', ['cli']), client('desk', '@hypaware/desk', ['dk'])],
    (p) => p === '@hypaware/claude'
  )
  assert.equal(owners.get('cli')?.configured, true)
  assert.equal(owners.get('dk')?.configured, false)
})

test('resolveEntrypointOwners ignores clients declaring no entrypoints', () => {
  const owners = resolveEntrypointOwners([client('codex', '@hypaware/codex')], () => true)
  assert.equal(owners.size, 0)
})

test('resolveEntrypointOwners is first-declaration-wins on a contested entrypoint', () => {
  const owners = resolveEntrypointOwners(
    [client('first', '@hypaware/first', ['x']), client('second', '@hypaware/second', ['x'])],
    () => true
  )
  assert.equal(owners.get('x')?.client, 'first')
})

// The consent case: an entrypoint claimed by a client the user has not
// enabled must not be imported, or history for a client they never opted
// into enters the cache (and then forwards to a server).
// @ref LLP 0140#gate-before-projection [tests]: a claimed-but-unconfigured entrypoint is skipped
test('classifyTranscriptEntrypoint skips an entrypoint owned by an unconfigured client', () => {
  const owners = resolveEntrypointOwners([client('desk', '@hypaware/desk', ['dk'])], () => false)
  const verdict = classifyTranscriptEntrypoint('dk', owners, 'claude')
  assert.equal(verdict.import, false)
  assert.equal(verdict.owner?.client, 'desk')
})

test('classifyTranscriptEntrypoint attributes an owned+configured entrypoint to its owner, not the scanner', () => {
  const owners = resolveEntrypointOwners([client('desk', '@hypaware/desk', ['dk'])], () => true)
  const verdict = classifyTranscriptEntrypoint('dk', owners, 'claude')
  assert.equal(verdict.import, true)
  assert.equal(verdict.clientName, 'desk', 'rows belong to the owning client')
})

// Fail-open is deliberate: a strict allowlist would silently drop real
// history the first time a client ships a new entrypoint value, and under-
// importing without saying so is worse than importing under a slightly
// wrong client.
// @ref LLP 0140#fail-open-on-unknown [tests]: unknown and absent entrypoints import under the scanning client
test('classifyTranscriptEntrypoint fails open on an unclaimed entrypoint', () => {
  const owners = resolveEntrypointOwners([client('desk', '@hypaware/desk', ['dk'])], () => false)
  const verdict = classifyTranscriptEntrypoint('something-new', owners, 'claude')
  assert.equal(verdict.import, true)
  assert.equal(verdict.clientName, 'claude')
  assert.equal(verdict.owner, undefined)
})

test('classifyTranscriptEntrypoint fails open on an absent entrypoint', () => {
  const owners = resolveEntrypointOwners([client('desk', '@hypaware/desk', ['dk'])], () => false)
  for (const value of [undefined, '']) {
    const verdict = classifyTranscriptEntrypoint(value, owners, 'claude')
    assert.equal(verdict.import, true)
    assert.equal(verdict.clientName, 'claude')
  }
})

test('classifyTranscriptEntrypoint with an empty owner map imports everything (pre-gate behavior)', () => {
  const verdict = classifyTranscriptEntrypoint('claude-desktop', new Map(), 'claude')
  assert.equal(verdict.import, true)
  assert.equal(verdict.clientName, 'claude')
})

// A foreign container's sessions are admitted by ROOT, never by the value
// found inside them: the value classifier's fail-open direction is exactly
// wrong over another client's private directory.
// @ref LLP 0140#container-root-owns [tests]: container admission keys on the owning plugin's config membership, not the entrypoint value
test('classifyContainerSession imports as the owner when its plugin is configured', () => {
  const owners = resolveEntrypointOwners([client('desk', '@hypaware/desk', ['dk'])], () => true)
  const verdict = classifyContainerSession(owners, { client: 'desk', plugin: /** @type {any} */ ('@hypaware/desk') })
  assert.equal(verdict.import, true)
  assert.equal(verdict.clientName, 'desk')
})

test('classifyContainerSession gates when the owning plugin is unconfigured', () => {
  const owners = resolveEntrypointOwners([client('desk', '@hypaware/desk', ['dk'])], () => false)
  const verdict = classifyContainerSession(owners, { client: 'desk', plugin: /** @type {any} */ ('@hypaware/desk') })
  assert.equal(verdict.import, false)
  assert.equal(verdict.owner.client, 'desk')
})

test('classifyContainerSession gates on an empty owners map, unlike the value classifier', () => {
  const verdict = classifyContainerSession(new Map(), { client: 'desk', plugin: /** @type {any} */ ('@hypaware/desk') })
  assert.equal(verdict.import, false)
  assert.equal(verdict.owner.configured, false, 'owner is synthesized for the gate log')
})

test('sessionEntrypoint takes the first non-empty value across a session', () => {
  assert.equal(sessionEntrypoint([{}, { entrypoint: '' }, { entrypoint: 'cli' }]), 'cli')
  assert.equal(sessionEntrypoint([{}, {}]), undefined)
  assert.equal(sessionEntrypoint([]), undefined)
})

// --- against the real bundled manifests ---

// Regression: Claude Desktop writes its sessions into `~/.claude/projects`
// beside Claude Code's, so the `@hypaware/claude` backfill imported them
// regardless of whether Desktop was ever configured, attributed to `claude`.
// @ref LLP 0140#manifest-declares-ownership [tests]: the real Desktop manifest claims its transcript entrypoints
test('the real claude-desktop manifest claims every observed entrypoint value', async () => {
  const descriptors = await realClientDescriptors()
  const desktop = descriptors.get('claude-desktop')
  assert.ok(desktop, 'claude-desktop client descriptor exists')
  // 'claude-desktop' = un-attached Desktop in the shared tree;
  // 'claude-desktop-3p' = attached, earlier build. The current attached
  // build's 'local-agent' is deliberately NOT claimed: it names a CLI mode,
  // not a client, and its sessions live in the 3p container, which is owned
  // by root (LLP 0140#container-root-owns), not by value.
  assert.deepEqual(desktop.transcriptEntrypoints, ['claude-desktop', 'claude-desktop-3p'])
})

// `cli` must be claimed too, else every ordinary Claude Code session takes
// the unknown-entrypoint path. That is harmless for import (fail-open) but
// means the gate is doing nothing for the common case and the run logs an
// unclaimed value per session.
test('the real claude manifest claims cli and sdk-cli', async () => {
  const descriptors = await realClientDescriptors()
  assert.deepEqual(descriptors.get('claude')?.transcriptEntrypoints, ['cli', 'sdk-cli'])
})

test('real manifests: Desktop entrypoints gate off when only @hypaware/claude is configured', async () => {
  const descriptors = await realClientDescriptors()
  const owners = resolveEntrypointOwners(descriptors.values(), (p) => p === '@hypaware/claude')

  for (const ep of ['claude-desktop', 'claude-desktop-3p']) {
    assert.equal(classifyTranscriptEntrypoint(ep, owners, 'claude').import, false, `${ep} skipped`)
  }
  for (const ep of ['cli', 'sdk-cli']) {
    const verdict = classifyTranscriptEntrypoint(ep, owners, 'claude')
    assert.equal(verdict.import, true, `${ep} imported`)
    assert.equal(verdict.clientName, 'claude')
  }
})

test('real manifests: Desktop entrypoints import as claude-desktop once it is configured', async () => {
  const descriptors = await realClientDescriptors()
  const configured = new Set(['@hypaware/claude', '@hypaware/claude-desktop'])
  const owners = resolveEntrypointOwners(descriptors.values(), (p) => configured.has(p))

  for (const ep of ['claude-desktop', 'claude-desktop-3p']) {
    const verdict = classifyTranscriptEntrypoint(ep, owners, 'claude')
    assert.equal(verdict.import, true, `${ep} imported`)
    assert.equal(verdict.clientName, 'claude-desktop', `${ep} attributed to claude-desktop`)
  }
})

test('real manifests: the 3p container gates off until claude-desktop is configured, whatever the tag', async () => {
  const descriptors = await realClientDescriptors()
  const containerOwner = { client: 'claude-desktop', plugin: /** @type {any} */ ('@hypaware/claude-desktop') }

  const cliOnly = resolveEntrypointOwners(descriptors.values(), (p) => p === '@hypaware/claude')
  assert.equal(classifyContainerSession(cliOnly, containerOwner).import, false)

  const both = new Set(['@hypaware/claude', '@hypaware/claude-desktop'])
  const configured = resolveEntrypointOwners(descriptors.values(), (p) => both.has(p))
  const verdict = classifyContainerSession(configured, containerOwner)
  assert.equal(verdict.import, true)
  assert.equal(verdict.clientName, 'claude-desktop')
})

// Every entrypoint value observed in real SHARED-TREE transcripts should be
// claimed by some bundled client, so the fail-open path stays an exception
// rather than the norm. Container-only values ('local-agent') are excluded
// on purpose: their sessions are owned by root, not by claim. Update this
// list when a new entrypoint is observed in the wild.
test('every known real-world shared-tree entrypoint value is claimed by a bundled client', async () => {
  const descriptors = await realClientDescriptors()
  const owners = resolveEntrypointOwners(descriptors.values(), () => true)
  for (const ep of ['cli', 'sdk-cli', 'claude-desktop', 'claude-desktop-3p']) {
    assert.ok(owners.has(ep), `entrypoint '${ep}' is claimed by a bundled client manifest`)
  }
})

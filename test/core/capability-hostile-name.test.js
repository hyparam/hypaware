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
import { installLoggerProvider } from '../../src/core/observability/logger.js'
import { readObservabilityEnv } from '../../src/core/observability/index.js'
import { LoggerProvider, logs } from '../../src/core/observability/runtime.js'
// The mirror writes to the real `process.stderr` (LLP 0329#consequences), so
// the capture that stands in front of that descriptor is the shared one.
import { stderrTextFrom } from '../helpers/stderr_lines.js'

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

/**
 * Collect the log records emitted while `fn` runs, then put the global
 * provider slot back the way the rest of this file expects it.
 *
 * @param {() => Promise<void>|void} fn
 * @returns {Promise<any[]>}
 */
async function recordsFrom(fn) {
  /** @type {any[]} */
  const records = []
  const provider = new LoggerProvider({
    resource: { attributes: { service_name: 'hypaware-test' } },
    exporters: [{ exportBatch: (/** @type {any[]} */ batch) => { records.push(...batch) } }],
  })
  logs.setGlobalLoggerProvider(provider)
  try {
    await fn()
  } finally {
    await provider.shutdown()
  }
  return records
}

/**
 * The three manifests both skip tests resolve: two malformed halves and the
 * consumer that pays for one of them.
 *
 * Rebuilt per call rather than shared, so neither test can observe the other
 * having mutated one.
 *
 * @returns {any[]}
 */
function skipManifests() {
  return [
    {
      schema_version: 1, name: 'empty-version', version: '1.0.0', hypaware_api: '^1.0.0',
      runtime: 'node', entrypoint: './i.js', provides: { capabilities: { 'cap.real': '' } },
    },
    {
      schema_version: 1, name: 'empty-name', version: '1.0.0', hypaware_api: '^1.0.0',
      runtime: 'node', entrypoint: './i.js', provides: { capabilities: { '': '1.0.0' } },
    },
    {
      schema_version: 1, name: 'consumer', version: '1.0.0', hypaware_api: '^1.0.0',
      runtime: 'node', entrypoint: './i.js', requires: { capabilities: { 'cap.real': '*' } },
    },
  ]
}

test('a skipped capability declaration names the plugin that wrote it', async () => {
  // The skip costs someone else their activation: the consumer requiring the
  // capability is eliminated and reported with `cap_missing`, while the
  // provider whose manifest is malformed activates. Without a signal naming
  // the provider, the report points an operator at the innocent plugin
  // (issue #1870). Both halves of the skip, and the resolution output
  // alongside the signal, because the signal has to be purely additive.
  const manifests = skipManifests()

  /** @type {any} */
  let resolution = null
  const records = await recordsFrom(async () => {
    resolution = await resolveDependencies(manifests)
  })

  // Unchanged by the signal: the provider still activates, and the consumer is
  // still the one the report names.
  assert.deepEqual(resolution.order, ['empty-name', 'empty-version'])
  assert.deepEqual(resolution.unsatisfied, [
    { plugin: 'consumer', errorKind: 'cap_missing', detail: 'capability cap.real@*' },
  ])

  assert.deepEqual(
    records
      .filter((r) => r.body === 'dep_graph.capability_skipped')
      .map((r) => ({
        severity: r.severityText,
        plugin: r.attributes.hyp_plugin,
        capability: r.attributes.hyp_capability,
        version: r.attributes.hyp_capability_version,
        errorKind: r.attributes.error_kind,
      })),
    [
      { severity: 'WARN', plugin: 'empty-version', capability: 'cap.real', version: '', errorKind: 'cap_malformed' },
      { severity: 'WARN', plugin: 'empty-name', capability: '', version: '1.0.0', errorKind: 'cap_malformed' },
    ],
    'a skipped declaration left the operator with only the consumer to blame'
  )
})

// @ref LLP 0362#absence-not-refusal [tests]: the skip report reaches stderr with no provider installed, and the healthy resolve stays silent.
test('a skipped capability declaration reaches an install with no telemetry configured', async () => {
  // The signal issue #1870 asked for was emitted through `getLogger` alone,
  // and on a shipped install that is nowhere: `installLoggerProvider` attaches
  // no exporter without `HYP_DEV_TELEMETRY` or `OTEL_EXPORTER_OTLP_ENDPOINT`,
  // so the record was built and dropped and the operator was left with the
  // consumer's `cap_missing` again (issue #1889). Run on that substrate, with
  // both variables stripped and no provider installed, so the only channel
  // that can carry the two lines is the one a stock install has.
  const savedDev = process.env.HYP_DEV_TELEMETRY
  const savedOtlp = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.HYP_DEV_TELEMETRY
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  logs.setGlobalLoggerProvider(/** @type {any} */ (null))
  try {
    const installed = installLoggerProvider({
      env: readObservabilityEnv(),
      resource: { attributes: { service_name: 'hypaware-test' } },
    })
    assert.equal(installed.provider, null, 'the shipped-install substrate installs no logger provider')

    /** @type {any} */
    let resolution = null
    const text = await stderrTextFrom(async () => {
      resolution = await resolveDependencies(skipManifests())
    })

    // Byte-identical to the resolution without the report: the provider still
    // activates, the consumer is still the only elimination, and the report is
    // purely additive.
    assert.deepEqual(resolution.order, ['empty-name', 'empty-version'])
    assert.deepEqual(resolution.unsatisfied, [
      { plugin: 'consumer', errorKind: 'cap_missing', detail: 'capability cap.real@*' },
    ])

    const lines = text.split('\n').filter((line) => line.includes('dep_graph.capability_skipped'))
    assert.equal(lines.length, 2, 'both malformed halves are named on a channel the install keeps')
    for (const line of lines) {
      assert.match(line, /WARN/, 'a skip is a warning, not the rejection of a plugin that still activates')
      assert.match(line, /"error_kind":"cap_malformed"/)
    }
    assert.match(lines[0], /"hyp_plugin":"empty-version"/)
    assert.match(lines[0], /"hyp_capability":"cap.real"/)
    assert.match(lines[0], /"hyp_capability_version":""/)
    assert.match(lines[1], /"hyp_plugin":"empty-name"/)
    assert.match(lines[1], /"hyp_capability":""/)
    assert.match(lines[1], /"hyp_capability_version":"1.0.0"/)

    // The other direction, which LLP 0329#testable requires of any mirrored
    // line: a well-formed declaration prints nothing at all.
    const healthy = await stderrTextFrom(async () => {
      await resolveDependencies(/** @type {any} */ ([
        {
          schema_version: 1, name: 'provider', version: '1.0.0', hypaware_api: '^1.0.0',
          runtime: 'node', entrypoint: './i.js', provides: { capabilities: { 'cap.real': '1.0.0' } },
        },
        {
          schema_version: 1, name: 'consumer', version: '1.0.0', hypaware_api: '^1.0.0',
          runtime: 'node', entrypoint: './i.js', requires: { capabilities: { 'cap.real': '*' } },
        },
      ]))
    })
    assert.equal(healthy, '', 'an ordinary resolve stays as quiet as it was')
  } finally {
    logs.setGlobalLoggerProvider(/** @type {any} */ (null))
    if (savedDev === undefined) delete process.env.HYP_DEV_TELEMETRY
    else process.env.HYP_DEV_TELEMETRY = savedDev
    if (savedOtlp === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedOtlp
  }
})

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { diagnosePlugin } from '../../src/core/plugin_doctor/diagnose.js'

/**
 * Write a plugin fixture (manifest + entrypoint) into a fresh temp dir
 * and return its root. Each fixture gets a unique dir so dynamic
 * import() of the entrypoint never hits a stale module cache.
 *
 * @param {object} args
 * @param {Record<string, unknown>} args.manifest
 * @param {string} [args.index] Contents of src/index.js (omit to skip the file).
 */
async function fixture({ manifest, index }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-fix-'))
  await fs.writeFile(path.join(root, 'hypaware.plugin.json'), JSON.stringify(manifest, null, 2))
  if (index !== undefined) {
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'index.js'), index)
  }
  return root
}

/** @param {Partial<Record<string, unknown>>} [overrides] */
function baseManifest(overrides = {}) {
  return {
    schema_version: 1,
    name: '@test/example',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
    ...overrides,
  }
}

test('clean source plugin reports no issues', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.sources.register({ name: 'demo', plugin: '@test/example', async start() { return { async stop() {} } } })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
  assert.equal(report.diagnostics.length, 0)
  assert.equal(report.pluginName, '@test/example')
})

test('missing activate export is flagged', async () => {
  const root = await fixture({
    manifest: baseManifest(),
    index: `export const notActivate = () => {}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  assert.ok(report.diagnostics.some((d) => d.kind === 'activate_missing'))
})

test('declared-but-unregistered contribution is the headline error', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'ghost' }] } }),
    index: `export async function activate() { /* forgot to register */ }\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  const finding = report.diagnostics.find((d) => d.kind === 'contribution_not_registered')
  assert.ok(finding)
  assert.match(finding.message, /ghost/)
  assert.ok(finding.repair.some((r) => r.includes('ctx.sources.register')))
})

test('activate that throws is reported as activate_threw', async () => {
  const root = await fixture({
    manifest: baseManifest(),
    index: `export async function activate() { throw new Error('boom') }\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  const finding = report.diagnostics.find((d) => d.kind === 'activate_threw')
  assert.ok(finding)
  assert.match(finding.message, /boom/)
})

test('unresolved required capability is an error', async () => {
  const root = await fixture({
    manifest: baseManifest({ requires: { capabilities: { 'hypaware.nonexistent': '^1.0.0' } } }),
    index: `export async function activate() {}\n`,
  })
  const report = await diagnosePlugin(root, { knownCapabilities: new Map([['hypaware.blob-store', ['1.0.0']]]) })
  assert.equal(report.ok, false)
  assert.ok(report.diagnostics.some((d) => d.kind === 'capability_unresolved'))
})

test('required capability resolves when a provider is known', async () => {
  const root = await fixture({
    manifest: baseManifest({ requires: { capabilities: { 'hypaware.blob-store': '^1.0.0' } } }),
    index: `export async function activate() {}\n`,
  })
  const report = await diagnosePlugin(root, { knownCapabilities: new Map([['hypaware.blob-store', ['1.2.0']]]) })
  assert.ok(!report.diagnostics.some((d) => d.kind === 'capability_unresolved'))
})

test('required capability with a known name but unsatisfied range is unresolved', async () => {
  const root = await fixture({
    manifest: baseManifest({ requires: { capabilities: { 'hypaware.blob-store': '^9.0.0' } } }),
    index: `export async function activate() {}\n`,
  })
  const report = await diagnosePlugin(root, { knownCapabilities: new Map([['hypaware.blob-store', ['1.0.0']]]) })
  assert.equal(report.ok, false)
  const finding = report.diagnostics.find((d) => d.kind === 'capability_unresolved')
  assert.ok(finding)
  assert.match(finding.message, /\^9\.0\.0/)
  assert.match(finding.message, /1\.0\.0/)
})

test('requireCapability and using its handle during activate does not false-fail', async () => {
  // Mirrors the real adapter pattern: fetch the capability handle, then
  // call methods on it during activate() (e.g. gateway.registerClient).
  // The seeded stub must absorb those calls so the source still registers.
  const root = await fixture({
    manifest: baseManifest({
      requires: { capabilities: { 'hypaware.ai-gateway': '^2.0.0' } },
      contributes: { sources: [{ name: 'demo' }] },
    }),
    index:
      `export async function activate(ctx) {\n` +
      `  const gateway = ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')\n` +
      `  gateway.registerUpstreamPreset({ name: 'x' })\n` +
      `  gateway.registerClient({ name: 'y' }).whatever()\n` +
      `  ctx.sources.register({ name: 'demo', plugin: '@test/example', async start() { return { async stop() {} } } })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root, { knownCapabilities: new Map([['hypaware.ai-gateway', ['2.1.0']]]) })
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
  assert.ok(!report.diagnostics.some((d) => d.kind === 'activate_threw'))
  assert.ok(!report.diagnostics.some((d) => d.kind === 'contribution_not_registered'))
})

test('malformed contributes entry is flagged as contributes_malformed', async () => {
  const missingName = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ summary: 'x' }] } }),
    index: `export async function activate() {}\n`,
  })
  const r1 = await diagnosePlugin(missingName)
  assert.equal(r1.ok, false)
  const f1 = r1.diagnostics.find((d) => d.kind === 'contributes_malformed')
  assert.ok(f1)
  assert.equal(f1.location, '/contributes/sources/0')

  const notArray = await fixture({
    manifest: baseManifest({ contributes: { sources: {} } }),
    index: `export async function activate() {}\n`,
  })
  const r2 = await diagnosePlugin(notArray)
  assert.equal(r2.ok, false)
  const f2 = r2.diagnostics.find((d) => d.kind === 'contributes_malformed')
  assert.ok(f2)
  assert.equal(f2.location, '/contributes/sources')
})

test('malformed config_sections entry is flagged as contributes_malformed', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { config_sections: [{ summary: 'no section' }] } }),
    index: `export async function activate() {}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  const finding = report.diagnostics.find((d) => d.kind === 'contributes_malformed')
  assert.ok(finding)
  assert.equal(finding.location, '/contributes/config_sections/0')
  assert.match(finding.message, /section/)
})

test('declared-but-never-provided capability is a warning', async () => {
  const root = await fixture({
    manifest: baseManifest({ provides: { capabilities: { 'hypaware.thing': '1.0.0' } } }),
    index: `export async function activate() { /* never calls provideCapability */ }\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
  const warn = report.diagnostics.find((d) => d.kind === 'capability_unprovided')
  assert.ok(warn)
  assert.equal(warn.severity, 'warn')
  assert.match(warn.message, /hypaware\.thing/)
})

test('a syntax error in the entrypoint surfaces as entrypoint_import_failed', async () => {
  const root = await fixture({
    manifest: baseManifest(),
    index: `export async function activate(ctx) { this is not valid javascript }\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  const finding = report.diagnostics.find((d) => d.kind === 'entrypoint_import_failed')
  assert.ok(finding)
  assert.equal(finding.location, '/entrypoint')
})

test('invalid semver and missing entrypoint are caught statically', async () => {
  const root = await fixture({
    manifest: baseManifest({ version: 'not-semver', entrypoint: './src/missing.js' }),
    // no index.js written
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  assert.ok(report.diagnostics.some((d) => d.kind === 'semver_invalid' && d.location === '/version'))
  assert.ok(report.diagnostics.some((d) => d.kind === 'entrypoint_missing'))
})

test('an invalid manifest short-circuits with manifest_invalid', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-fix-'))
  await fs.writeFile(path.join(root, 'hypaware.plugin.json'), '{ not valid json')
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  assert.equal(report.diagnostics.length, 1)
  assert.equal(report.diagnostics[0].kind, 'manifest_invalid')
  assert.equal(report.pluginName, undefined)
})

test('registered-but-undeclared contribution is a warning, not an error', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.sources.register({ name: 'demo', plugin: '@test/example', async start() { return { async stop() {} } } })\n` +
      `  ctx.commands.register({ name: 'demo extra', plugin: '@test/example', summary: 's', usage: 'u', run: async () => 0 })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
  const warn = report.diagnostics.find((d) => d.kind === 'contribution_undeclared')
  assert.ok(warn)
  assert.equal(warn.severity, 'warn')
})

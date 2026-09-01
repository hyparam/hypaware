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

test('a summary that differs between the manifest and the registration is an error', async () => {
  const root = await fixture({
    manifest: baseManifest({
      contributes: { commands: [{ name: 'demo run', summary: 'Run the demo end to end' }] },
    }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.commands.register({ name: 'demo run', plugin: '@test/example', summary: 'Run the demo', usage: 'u', run: async () => 0 })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  const finding = report.diagnostics.find((d) => d.kind === 'command_help_drift')
  assert.ok(finding)
  assert.equal(finding.severity, 'error')
  assert.match(finding.message, /Run the demo end to end/)
  assert.match(finding.message, /Run the demo'/)
})

test('a verb-projected command is compared like any other command', async () => {
  // A verb registers one declaration that the kernel projects into a CLI
  // command, so the manifest still has to match the verb's summary.
  const root = await fixture({
    manifest: baseManifest({
      contributes: { commands: [{ name: 'demo count', summary: 'Count the demo rows' }] },
    }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.verbs.register({\n` +
      `    name: 'demo count', tool: 'demo_count', plugin: '@test/example',\n` +
      `    summary: 'Counts rows', inputSchema: { type: 'object', properties: {} },\n` +
      `    operation: async () => ({}), render: () => '',\n` +
      `  })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  const finding = report.diagnostics.find((d) => d.kind === 'command_help_drift')
  assert.ok(finding, JSON.stringify(report.diagnostics))
  assert.match(finding.message, /Counts rows/)
})

test('an undeclared hidden command is reported like any missing manifest contribution', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { commands: [{ name: 'demo run', summary: 'Run the demo' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.commands.register({ name: 'demo run', plugin: '@test/example', summary: 'Run the demo', usage: 'u', run: async () => 0 })\n` +
      `  ctx.commands.register({ name: 'demo-hook fire', plugin: '@test/example', summary: 'Internal', usage: 'u', hidden: true, run: async () => 0 })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
  const finding = report.diagnostics.find((d) => d.kind === 'contribution_undeclared')
  assert.ok(finding)
  assert.match(finding.message, /demo-hook fire/)
})

test('a command hidden in both manifest and registration agrees', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { commands: [{ name: 'demo run', summary: 'Run the demo', hidden: true }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.commands.register({ name: 'demo run', plugin: '@test/example', summary: 'Run the demo', usage: 'u', hidden: true, run: async () => 0 })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
  assert.equal(report.diagnostics.length, 0)
})

test('manifest and registration visibility drift is an error', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { commands: [{ name: 'demo run', summary: 'Run the demo' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.commands.register({ name: 'demo run', plugin: '@test/example', summary: 'Run the demo', usage: 'u', hidden: true, run: async () => 0 })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  const finding = report.diagnostics.find((d) => d.kind === 'command_help_drift')
  assert.ok(finding)
  assert.match(finding.message, /different visibility/)
})

test('a manifest-hidden command registered visible is also visibility drift', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { commands: [{ name: 'demo run', summary: 'Run the demo', hidden: true }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.commands.register({ name: 'demo run', plugin: '@test/example', summary: 'Run the demo', usage: 'u', run: async () => 0 })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  const finding = report.diagnostics.find((d) => d.kind === 'command_help_drift')
  assert.ok(finding)
  assert.match(finding.message, /manifest marks it hidden/)
  assert.match(finding.message, /registers it as visible/)
})

test('a group description with no declared subcommand is a warning', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { commands: [{ name: 'demo run', summary: 'Run the demo' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.commands.register({ name: 'demo run', plugin: '@test/example', summary: 'Run the demo', usage: 'u', run: async () => 0 })\n` +
      `  ctx.commands.registerGroup({ name: 'ghost', plugin: '@test/example', summary: 'A group nothing lists' })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
  const warn = report.diagnostics.find((d) => d.kind === 'command_help_drift')
  assert.ok(warn)
  assert.equal(warn.severity, 'warn')
  assert.match(warn.message, /ghost/)
})

test('a dry run does not start a source the plugin starts from activate()', async () => {
  // `@hypaware/otel` starts its OTLP source from `activate()`, which binds a
  // real port. A diagnostic pass must not take one, or the doctor fails on any
  // host where the daemon already holds it.
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.sources.register({\n` +
      `    name: 'demo', plugin: '@test/example',\n` +
      `    async start() { throw new Error('start() must not run during a dry run') },\n` +
      `  })\n` +
      `  await ctx.sources.start('demo', ctx)\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

test('a manifest command entry with no summary names the blank, not two wordings', async () => {
  // `summary` is optional on a manifest command entry, so this is the shape a
  // plugin author most often lands on. It is still drift (top-level help lists
  // the command with no description), but the message has to say which side is
  // missing or the author goes looking for a second wording that is not there.
  const root = await fixture({
    manifest: baseManifest({ contributes: { commands: [{ name: 'demo run' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.commands.register({ name: 'demo run', plugin: '@test/example', summary: 'Run the demo', usage: 'u', run: async () => 0 })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, false)
  const finding = report.diagnostics.find((d) => d.kind === 'command_help_drift')
  assert.ok(finding)
  assert.match(finding.message, /has no summary in the manifest/)
  assert.equal(finding.message.includes('two different summaries'), false)
  assert.ok(finding.repair.some((r) => r.includes('"summary": "Run the demo"')))
})

test('a multi-word group whose subcommands are declared is not warned about', async () => {
  // Group prefixes are not single tokens: dispatch resolves `hyp query cache
  // --help` through the longest declared prefix, so `registerGroup({ name:
  // 'query cache' })` is correct and must not be reported as describing a
  // group nothing lists.
  const root = await fixture({
    manifest: baseManifest({
      contributes: {
        commands: [
          { name: 'query cache list', summary: 'List cached datasets' },
          { name: 'query cache purge', summary: 'Purge the cache' },
        ],
      },
    }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.commands.register({ name: 'query cache list', plugin: '@test/example', summary: 'List cached datasets', usage: 'u', run: async () => 0 })\n` +
      `  ctx.commands.register({ name: 'query cache purge', plugin: '@test/example', summary: 'Purge the cache', usage: 'u', run: async () => 0 })\n` +
      `  ctx.commands.registerGroup({ name: 'query cache', plugin: '@test/example', summary: 'Query cache maintenance' })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
  assert.equal(report.diagnostics.length, 0, JSON.stringify(report.diagnostics))
})

test('a legacy undeclared all-hidden group gets only the contribution warning', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { commands: [{ name: 'demo run', summary: 'Run the demo' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.commands.register({ name: 'demo run', plugin: '@test/example', summary: 'Run the demo', usage: 'u', run: async () => 0 })\n` +
      `  ctx.commands.register({ name: 'demo-hook fire', plugin: '@test/example', summary: 'Internal', usage: 'u', hidden: true, run: async () => 0 })\n` +
      `  ctx.commands.registerGroup({ name: 'demo-hook', plugin: '@test/example', summary: 'Internal hooks' })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
  assert.equal(report.diagnostics.length, 1, JSON.stringify(report.diagnostics))
  assert.equal(report.diagnostics[0].kind, 'contribution_undeclared')
})

test('a group with a visible command under it is still warned about', async () => {
  // The all-hidden exemption must not swallow the case the warning is for: one
  // visible command under the namespace and nothing declaring it means top
  // level help never lists the group the description belongs to.
  const root = await fixture({
    manifest: baseManifest({ contributes: { commands: [{ name: 'demo run', summary: 'Run the demo' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.commands.register({ name: 'demo run', plugin: '@test/example', summary: 'Run the demo', usage: 'u', run: async () => 0 })\n` +
      `  ctx.commands.register({ name: 'ghost fire', plugin: '@test/example', summary: 'Visible', usage: 'u', hidden: true, run: async () => 0 })\n` +
      `  ctx.commands.register({ name: 'ghost show', plugin: '@test/example', summary: 'Visible', usage: 'u', run: async () => 0 })\n` +
      `  ctx.commands.registerGroup({ name: 'ghost', plugin: '@test/example', summary: 'A group nothing lists' })\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  const warn = report.diagnostics.find((d) => d.kind === 'command_help_drift' && d.severity === 'warn')
  assert.ok(warn, JSON.stringify(report.diagnostics))
  assert.match(warn.message, /ghost/)
})

test('a dry run points HYP_HOME at its throwaway root', async () => {
  // `ctx.env` defaults to `process.env`, and `@hypaware/local-fs` mkdirs
  // `<HYP_HOME>/exports` from `activate()`: without the redirect, diagnosing a
  // plugin wrote into the caller's real install, and the bundled agreement
  // test did it for the whole workspace on every `npm test`.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-home-'))
  const root = await fixture({
    manifest: baseManifest({ contributes: { commands: [{ name: 'demo run', summary: 'Run the demo' }] } }),
    index:
      `import fs from 'node:fs'\n` +
      `import path from 'node:path'\n` +
      `export async function activate(ctx) {\n` +
      `  fs.mkdirSync(path.join(ctx.env.HYP_HOME, 'exports'), { recursive: true })\n` +
      `  ctx.commands.register({ name: 'demo run', plugin: '@test/example', summary: 'Run the demo', usage: 'u', run: async () => 0 })\n` +
      `}\n`,
  })
  const prior = process.env.HYP_HOME
  process.env.HYP_HOME = home
  try {
    const report = await diagnosePlugin(root)
    assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
  } finally {
    if (prior === undefined) delete process.env.HYP_HOME
    else process.env.HYP_HOME = prior
  }
  assert.deepEqual(await fs.readdir(home), [], 'the dry run wrote into the caller\'s HYP_HOME')
})

test('a source started during a dry run can be reloaded and inspected', async () => {
  // The inert registry must neuter `start()` without pretending the source
  // never started: a plugin that starts one of its own sources from
  // `activate()` and then reloads it works under the real kernel, so the
  // doctor must not report `activate_threw` against it.
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index:
      `export async function activate(ctx) {\n` +
      `  ctx.sources.register({\n` +
      `    name: 'demo', plugin: '@test/example',\n` +
      `    async start() { throw new Error('start() must not run during a dry run') },\n` +
      `  })\n` +
      `  await ctx.sources.start('demo', ctx)\n` +
      `  await ctx.sources.reload('demo', ctx)\n` +
      `  if (await ctx.sources.status('demo') === undefined) throw new Error('status() lost the started source')\n` +
      `}\n`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// A source contribution is not always an object literal. A plugin may hand
// `ctx.sources.register` a class instance, and the doctor's inert registry
// read `start` through the prototype chain but stored a spread, which carries
// own enumerable properties and nothing else. The two disagreed: the object
// the real `register` went on to validate had lost every field the class
// supplies from its prototype, so the doctor invented an `activate_threw`
// about a missing `name` against a plugin the kernel registers and starts
// without complaint.
test('a class-instance source contribution keeps what its prototype supplies', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
class DemoSource {
  get name() { return 'demo' }
  get plugin() { return '@test/example' }
  get configSection() { return 'demo' }
  async start() { throw new Error('start() must not run during a dry run') }
}

export async function activate(ctx) {
  const contribution = new DemoSource()
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the class instance registered under no name')
  if (stored.plugin !== '@test/example') throw new Error('the stored contribution lost plugin')
  if (stored.configSection !== 'demo') throw new Error('the stored contribution lost configSection')
  if (typeof stored.start !== 'function') throw new Error('the stored contribution has no start()')
  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// The over-fixing control. Whatever the inert registry hands the real one, an
// ordinary object-literal contribution still registers under its declared
// name, still gets its `start()` neutered, and comes back out of `activate()`
// exactly as the plugin wrote it.
test('a plain-object source contribution still registers and is still neutered', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
export async function activate(ctx) {
  const contribution = {
    name: 'demo',
    plugin: '@test/example',
    configSection: 'demo',
    async start() { throw new Error('start() must not run during a dry run') },
  }
  const own = contribution.start
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the plain object registered under no name')
  if (stored.plugin !== '@test/example') throw new Error('the stored contribution lost plugin')
  if (stored.configSection !== 'demo') throw new Error('the stored contribution lost configSection')
  if (contribution.start !== own) throw new Error('the doctor mutated the caller\\'s contribution')
  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// Freezing the object you register is ordinary defensive style, and the real
// registry takes it. A proxy may not answer a non-writable, non-configurable
// own property with anything but the target's real value, so shadowing `start`
// on the contribution itself made the read inside `register` throw, and the
// doctor invented the same `activate_threw` the inert registry exists to
// avoid.
test('a frozen source contribution still registers and is still neutered', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
export async function activate(ctx) {
  ctx.sources.register(Object.freeze({
    name: 'demo',
    plugin: '@test/example',
    configSection: 'demo',
    async start() { throw new Error('start() must not run during a dry run') },
  }))
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the frozen object registered under no name')
  if (stored.configSection !== 'demo') throw new Error('the stored contribution lost configSection')
  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

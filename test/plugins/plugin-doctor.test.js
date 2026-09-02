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
// The stand-in the frozen case proxies instead has no own properties, so the
// enumeration assertions below are what keeps it from storing a contribution
// that reads back as `{}`.
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
  const keys = Object.keys(stored).sort().join(',')
  if (keys !== 'configSection,name,plugin,start') throw new Error('the stored contribution enumerates as [' + keys + ']')
  const copy = { ...stored }
  if (copy.name !== 'demo' || typeof copy.start !== 'function') throw new Error('a spread of the stored contribution lost fields')
  // The kernel hands the frozen object itself back, so reshaping it fails
  // loudly. A stand-in that took the define or the delete onto a target of
  // its own would report a success the kernel never gives.
  let defined = true
  try { Object.defineProperty(stored, 'meta', { value: 1 }) } catch { defined = false }
  if (defined) throw new Error('a define onto a frozen contribution was accepted')
  let deleted = true
  try { delete stored.name } catch { deleted = false }
  if (deleted) throw new Error('a delete on a frozen contribution was accepted')
  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// The frozen branch proxies a stand-in target instead of the contribution, and
// `defineProperty`/`deleteProperty` were left untrapped, so they landed on that
// target. The define succeeded there while the `get` trap kept answering from
// the contribution, which never got the property, so the next read threw the
// proxy invariant: a fabricated `activate_threw` against a plugin the real
// kernel accepts. `delete` diverged the other way and silently no-opped where
// the kernel removes the property.
test('a contribution with a frozen start() takes a define and a delete as the kernel does', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
export async function activate(ctx) {
  const contribution = { name: 'demo', plugin: '@test/example', configSection: 'demo' }
  // Own, non-writable and non-configurable, so the stand-in takes its frozen
  // branch, on an object the kernel still lets a plugin reshape.
  Object.defineProperty(contribution, 'start', {
    value: async () => { throw new Error('start() must not run during a dry run') },
    enumerable: true,
  })
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  Object.defineProperty(stored, 'meta', { value: 1 })
  if (stored.meta !== 1) throw new Error('the defined property read back as ' + String(stored.meta))
  if (contribution.meta !== 1) throw new Error('the define never reached the contribution')
  const desc = Object.getOwnPropertyDescriptor(stored, 'meta')
  if (!desc || desc.value !== 1) throw new Error('the defined property reports no descriptor')
  const copy = { ...stored }
  if (copy.name !== 'demo' || typeof copy.start !== 'function') throw new Error('a spread of the stored contribution lost fields')

  // The mirrored property is non-configurable on the contribution, so the
  // kernel refuses the delete. The stand-in has to refuse it too: mirroring a
  // define onto a target of its own must not turn a refusal into a success.
  let removed = true
  try { delete stored.meta } catch { removed = false }
  if (removed) throw new Error('a delete of a non-configurable property was accepted')
  if (stored.meta !== 1) throw new Error('the refused delete lost the property')

  delete stored.configSection
  if ('configSection' in contribution) throw new Error('the delete never reached the contribution')
  if (stored.configSection !== undefined) throw new Error('the deleted property still reads back')
  // And a define after that delete lands on the contribution again.
  Object.defineProperty(stored, 'configSection', { value: 'other', enumerable: true })
  if (stored.configSection !== 'other' || contribution.configSection !== 'other') throw new Error('a define after a delete did not reach the contribution')

  // The kernel takes a redefine of the frozen start() to its own value as the
  // no-op it is. A stand-in that pinned start() onto a target of its own could
  // only pin the inert value it answers reads with, so the redefine would be
  // judged incompatible with that target and throw.
  Object.defineProperty(stored, 'start', { value: contribution.start })
  if (typeof stored.start !== 'function') throw new Error('start() stopped reading back after a redefine')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// `Object.freeze`/`Object.seal` run `[[PreventExtensions]]` before
// `[[OwnPropertyKeys]]`, so a stand-in whose `ownKeys` trap answers from the
// contribution while its own target holds nothing threw `trap returned extra
// keys but proxy target is non-extensible` the moment a plugin hardened what
// it had registered. `Object.isFrozen(stored)` answered from that empty target
// too, so the ordinary `if (!Object.isFrozen(x)) Object.freeze(x)` guard walked
// straight into the throw, and the doctor invented an `activate_threw` against
// a plugin the kernel freezes without complaint.
test('a plugin that freezes the contribution it registered is not failed for it', async () => {
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
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')
  if (Object.isFrozen(stored)) throw new Error('an unfrozen contribution reported frozen')
  if (!Object.isExtensible(stored)) throw new Error('an extensible contribution reported non-extensible')

  if (!Object.isFrozen(stored)) Object.freeze(stored)

  if (!Object.isFrozen(contribution)) throw new Error('the freeze never reached the contribution')
  if (!Object.isFrozen(stored)) throw new Error('the frozen contribution reports unfrozen')
  if (Object.isExtensible(stored)) throw new Error('the frozen contribution reports extensible')
  if (typeof stored.start !== 'function') throw new Error('start() stopped reading back after the freeze')
  if (stored.configSection !== 'demo') throw new Error('the frozen contribution lost configSection')
  const keys = Object.keys(stored).sort().join(',')
  if (keys !== 'configSection,name,plugin,start') throw new Error('the frozen contribution enumerates as [' + keys + ']')
  if (Object.getPrototypeOf(stored) !== Object.prototype) throw new Error('the frozen contribution reports the wrong prototype')
  if (!('name' in stored)) throw new Error('the frozen contribution lost a key from \`in\`')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// The same defect one rung down the integrity ladder, on the branch that
// proxies a stand-in target rather than the contribution: `preventExtensions`
// hardened that target and left the contribution extensible, so the kernel and
// the doctor disagreed about the object the plugin still holds, and `seal`
// threw the same `ownKeys` invariant `freeze` did.
test('preventExtensions and seal on the stored contribution reach the contribution', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
export async function activate(ctx) {
  const contribution = { name: 'demo', plugin: '@test/example' }
  // Own, non-writable and non-configurable: the shape whose read through
  // the stand-in threw the proxy invariant this whole stand-in exists to
  // avoid, and the one the branch that survives hardening had to cover.
  Object.defineProperty(contribution, 'start', {
    value: async () => { throw new Error('start() must not run during a dry run') },
    enumerable: true,
  })
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  Object.preventExtensions(stored)
  if (Object.isExtensible(contribution)) throw new Error('preventExtensions never reached the contribution')
  if (Object.isExtensible(stored)) throw new Error('the stored contribution still reports extensible')

  Object.seal(stored)
  if (!Object.isSealed(contribution)) throw new Error('the seal never reached the contribution')
  if (!Object.isSealed(stored)) throw new Error('the sealed contribution reports unsealed')
  // Sealed, not frozen: the kernel still lets a write through, and so must
  // the stand-in.
  stored.name = 'demo'
  const keys = Object.keys(stored).sort().join(',')
  if (keys !== 'name,plugin,start') throw new Error('the sealed contribution enumerates as [' + keys + ']')
  if (typeof stored.start !== 'function') throw new Error('start() stopped reading back after the seal')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// The stand-in sampled `start()`'s descriptor once, at registration, and took
// the direct-proxy branch for a contribution that was still soft. A plugin
// that hardens its own reference afterwards, the defensive style the comment
// above endorses, left that proxy targeting an object whose `start` had since
// become read-only and non-configurable, so the next read of it threw the
// `get` invariant: a fabricated `activate_threw` against a plugin the kernel
// accepts. Nothing re-decides the target once the proxy exists, so the branch
// that survives hardening has to be the only branch.
test('a contribution frozen after register() still reads back', async () => {
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
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  Object.freeze(contribution)

  if (typeof stored.start !== 'function') throw new Error('start() stopped reading back after the contribution froze')
  if (stored.configSection !== 'demo') throw new Error('the frozen contribution lost configSection')
  const copy = { ...stored }
  if (copy.name !== 'demo' || typeof copy.start !== 'function') throw new Error('a spread of the frozen contribution lost fields')
  if (Object.isExtensible(stored)) throw new Error('the stored contribution still reports extensible')
  const desc = Object.getOwnPropertyDescriptor(stored, 'name')
  if (!desc || desc.configurable !== false) throw new Error('the frozen contribution reports name configurable')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// `setPrototypeOf` went untrapped, so it reparented the stand-in target and
// left the contribution where it was. That is the one direction a dry run
// must not take: on a contribution the plugin had hardened, the kernel
// refuses the reparent outright and the stand-in accepted it quietly, passing
// a plugin the kernel throws at.
test('setPrototypeOf on the stored contribution reaches the contribution', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
export async function activate(ctx) {
  const contribution = {
    name: 'demo',
    plugin: '@test/example',
    async start() { throw new Error('start() must not run during a dry run') },
  }
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  const proto = { tag: 'p' }
  Object.setPrototypeOf(stored, proto)
  if (Object.getPrototypeOf(contribution) !== proto) throw new Error('the reparent never reached the contribution')
  if (Object.getPrototypeOf(stored) !== proto) throw new Error('the stored contribution reports the wrong prototype')
  if (stored.tag !== 'p') throw new Error('the new prototype does not read through')

  Object.freeze(contribution)
  let refused = false
  try { Object.setPrototypeOf(stored, null) } catch { refused = true }
  if (!refused) throw new Error('a reparent the kernel refuses was accepted')
  if (Object.getPrototypeOf(contribution) !== proto) throw new Error('the refused reparent still moved the contribution')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// Reporting an own accessor `start` as a data property changed the kind
// `Object.freeze` reads back before it redefines: told the property was data,
// freeze sent `writable: false`, the contribution's accessor refused it, and
// the doctor invented an `activate_threw` for the freeze the kernel completes.
// The substitute getter keeps the kind without making the real start()
// reachable through it.
test('a contribution whose own start is an accessor still freezes', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
export async function activate(ctx) {
  const real = async () => { throw new Error('start() must not run during a dry run') }
  const contribution = { name: 'demo', plugin: '@test/example' }
  Object.defineProperty(contribution, 'start', { get: () => real, enumerable: true, configurable: false })
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  Object.freeze(stored)

  if (!Object.isFrozen(contribution)) throw new Error('the freeze never reached the contribution')
  if (!Object.isFrozen(stored)) throw new Error('the frozen contribution reports unfrozen')
  if (stored.start === real) throw new Error('the real start() reads back off the stand-in')
  if (typeof stored.start !== 'function') throw new Error('start() stopped reading back after the freeze')
  const desc = Object.getOwnPropertyDescriptor(stored, 'start')
  if (!desc || typeof desc.get !== 'function') throw new Error('an accessor start was reported as a data property')
  if (desc.get() === real) throw new Error('the reported getter hands back the real start()')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// Mirroring the contribution's shape onto the stand-in target is a snapshot,
// and a plugin holding its own reference can move the shape afterwards: a
// `preventExtensions` leaves properties configurable, so a later delete left
// `ownKeys` under-reporting what the hardened target still held, and a later
// freeze left the descriptor trap reporting non-writable against a writable
// target. Both threw a proxy invariant at a plugin the kernel is fine with.
test('a contribution reshaped after the stand-in hardened still reads back', async () => {
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
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  // Two keys the stand-in mirrors onto its target from a define, one of
  // them dropped through the plugin's own reference before anything hardens
  // the mirror.
  Object.defineProperty(stored, 'dropped', { value: 1, writable: true, enumerable: true, configurable: true })
  Object.defineProperty(stored, 'kept', { value: 2, writable: true, enumerable: true, configurable: true })
  if (contribution.dropped !== 1 || contribution.kept !== 2) throw new Error('a define never reached the contribution')
  delete contribution.dropped

  Object.preventExtensions(stored)
  delete contribution.configSection
  const keys = Object.keys(stored).sort().join(',')
  if (keys !== 'kept,name,plugin,start') throw new Error('the reshaped contribution enumerates as [' + keys + ']')

  Object.freeze(contribution)
  const desc = Object.getOwnPropertyDescriptor(stored, 'name')
  if (!desc || desc.writable !== false) throw new Error('the frozen contribution reports name writable')
  if (!Object.isFrozen(stored)) throw new Error('the frozen contribution reports unfrozen')
  if (typeof stored.start !== 'function') throw new Error('start() stopped reading back')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// A `start` descriptor read back off the stand-in names the inert function,
// and the trap forwarded it to the contribution verbatim, so the ordinary
// no-op round-trip left the plugin's own object holding this module's
// function instead of its own `start()`. The stand-in is a read-through,
// not a rewrite: it writes nothing to the object the plugin handed over.
test('a start descriptor read back off the stand-in is not written into the contribution', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
export async function activate(ctx) {
  const real = async function pluginStart() { throw new Error('start() must not run during a dry run') }
  const contribution = { name: 'demo', plugin: '@test/example', start: real }
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  Object.defineProperty(stored, 'start', Object.getOwnPropertyDescriptor(stored, 'start'))
  if (contribution.start !== real) throw new Error("the round-trip overwrote the plugin's own start()")
  if (stored.start === real) throw new Error('the real start() reads back off the stand-in')

  // Again once the freeze has pinned start() onto the stand-in's target,
  // which is where a define-then-read has to keep holding every invariant.
  Object.freeze(stored)
  Object.defineProperty(stored, 'start', Object.getOwnPropertyDescriptor(stored, 'start'))
  if (contribution.start !== real) throw new Error('the pinned round-trip overwrote start()')
  if (typeof stored.start !== 'function') throw new Error('start() stopped reading back')
  if (!Object.isFrozen(stored)) throw new Error('the frozen contribution reports unfrozen')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// A define through the stand-in mirrors that property onto its target,
// non-configurable and all, while the target itself is still extensible. The
// reconcile skipped exactly those keys (it ran only once the target had been
// hardened), so the plugin tightening the same property through its own
// reference left the descriptor trap reporting non-writable against a
// writable target: a proxy invariant thrown at a pair the kernel takes.
test('a property pinned through the stand-in tracks the contribution tightening it', async () => {
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
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  // Pins 'name' onto the stand-in's target. Nothing here hardens the object,
  // so the target stays extensible and the contribution stays extensible too.
  Object.defineProperty(stored, 'name', { configurable: false })
  if (Object.getOwnPropertyDescriptor(contribution, 'name').configurable !== false) {
    throw new Error('the pin never reached the contribution')
  }
  if (!Object.isExtensible(stored)) throw new Error('a pin should not harden the contribution')

  // Tightened through the plugin's own reference, the half the stand-in
  // never sees coming.
  Object.defineProperty(contribution, 'name', { writable: false })
  const desc = Object.getOwnPropertyDescriptor(stored, 'name')
  if (!desc || desc.writable !== false || desc.configurable !== false) {
    throw new Error('the tightened property reports back as ' + JSON.stringify(desc))
  }
  if (Object.keys(stored).sort().join(',') !== 'configSection,name,plugin,start') {
    throw new Error('the tightened contribution stopped enumerating')
  }

  // The same for 'start', whose pin carries the inert function rather than
  // the plugin's own.
  Object.defineProperty(stored, 'start', { configurable: false })
  Object.defineProperty(contribution, 'start', { writable: false })
  const startDesc = Object.getOwnPropertyDescriptor(stored, 'start')
  if (!startDesc || startDesc.writable !== false) throw new Error('the tightened start() reports writable')
  if (typeof stored.start !== 'function') throw new Error('start() stopped reading back')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// The inert function is swapped back out of a `start` descriptor coming the
// other way only when `start` is still the kind it was read as. A plugin that
// turns its own `start` into an accessor in between got the stand-in's own
// function written onto its object instead, the same leak in reverse the
// round-trip closes.
test('a stale start descriptor is not written into a contribution that changed its kind', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
export async function activate(ctx) {
  const real = async function pluginStart() { throw new Error('start() must not run during a dry run') }
  const contribution = { name: 'demo', plugin: '@test/example', start: real }
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  const stale = Object.getOwnPropertyDescriptor(stored, 'start')
  function pluginStartGetter() { return real }
  Object.defineProperty(contribution, 'start', { get: pluginStartGetter, enumerable: true, configurable: true })
  Object.defineProperty(stored, 'start', stale)

  const own = Object.getOwnPropertyDescriptor(contribution, 'start')
  if (own.get !== pluginStartGetter || own.value !== undefined) {
    throw new Error("the stale round-trip overwrote the plugin's own start()")
  }
  if (stored.start === real) throw new Error('the real start() reads back off the stand-in')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// `Object.defineProperty(c, 'k', { value })` leaves `k` non-configurable, so
// an ordinary contribution can hold one without ever hardening the object.
// The descriptor trap reported every such property configurable, because the
// stand-in's target carried nothing to back an honest report, and re-applying
// the descriptor the plugin had just read was then refused by the
// contribution: a fabricated failure against the no-op the kernel performs.
test('a descriptor round-trip on a non-configurable property is a no-op', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
export async function activate(ctx) {
  const contribution = {
    plugin: '@test/example',
    async start() { throw new Error('start() must not run during a dry run') },
  }
  Object.defineProperty(contribution, 'name', { value: 'demo', enumerable: true })
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  const desc = Object.getOwnPropertyDescriptor(stored, 'name')
  if (!desc || desc.configurable !== false) {
    throw new Error('a non-configurable property reports back as ' + JSON.stringify(desc))
  }
  Object.defineProperty(stored, 'name', desc)
  if (stored.name !== 'demo') throw new Error('the round-trip lost the name')
  if (Object.getOwnPropertyDescriptor(contribution, 'name').configurable !== false) {
    throw new Error('the round-trip made a non-configurable property configurable')
  }

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// `in` was the one operation left answering off the stand-in's own target.
// A define mirrors the key there, and dropping it through the plugin's own
// reference left `in` insisting on a key `Object.keys`, the descriptor and the
// read all agreed was gone: the store-a-different-shape divergence this
// stand-in exists to close, for a plugin that guards with `in`.
test('in agrees with the rest of the stand-in about what the contribution holds', async () => {
  const root = await fixture({
    manifest: baseManifest({ contributes: { sources: [{ name: 'demo' }] } }),
    index: `
export async function activate(ctx) {
  const contribution = {
    name: 'demo',
    plugin: '@test/example',
    async start() { throw new Error('start() must not run during a dry run') },
  }
  ctx.sources.register(contribution)
  const stored = ctx.sources.get('demo')
  if (!stored) throw new Error('the contribution registered under no name')

  Object.defineProperty(stored, 'temp', { value: 1, writable: true, enumerable: true, configurable: true })
  if (!('temp' in stored)) throw new Error('a defined property is missing from in')
  delete contribution.temp
  if ('temp' in stored) throw new Error('a dropped property is still reported by in')
  if (Object.keys(stored).includes('temp')) throw new Error('a dropped property still enumerates')

  // A key the contribution only inherits still answers, as it does under the
  // kernel, and hardening does not change any of it.
  if (!('toString' in stored)) throw new Error('an inherited key is missing from in')
  Object.freeze(stored)
  if (!('name' in stored) || !('start' in stored)) throw new Error('the frozen contribution lost a key from in')
  if ('temp' in stored) throw new Error('the frozen contribution regained a dropped key')

  await ctx.sources.start('demo', ctx)
  if (await ctx.sources.status('demo') === undefined) throw new Error('the started source was lost')
}
`,
  })
  const report = await diagnosePlugin(root)
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics))
})

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createStartSource, mergeUpstreams } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'
import { compileUpstreams } from '../../hypaware-core/plugins-workspace/ai-gateway/src/config.js'
import { pathMatchesPrefix } from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */
/** @import { GatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/types.js' */

// The `gateway_idle_no_upstreams` diagnostic. Letting an upstream-less gateway
// idle rather than fail its start (#649, LLP 0120) is right for the config
// that wants it - hermes composes the gateway plugin for its materializer and
// contributes no upstream - but the same idle path swallows a real
// misconfiguration: upstreams that were configured and then dropped whole by
// `compileUpstreams` (an entry missing either `name` or `base_url`) leave the
// source `started`, the daemon `healthy`, and the user's client with
// ECONNREFUSED. `details.upstreams_configured` counts what the config asked
// for whatever shape it was in, so it tells the two apart even when there is
// no name left to print; `details.upstreams` carries the raw names alongside
// it, to make the warning concrete when they exist. The diagnostic is
// non-degrading: a correct hermes-only install must stay healthy and quiet.
// @ref LLP 0114#fallback-is-visible [tests]: an idle gateway that was meant to be listening is readable from hyp status, not only from a log line

async function makeHome() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-status-idle-'))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({ version: 2, plugins: [] }) + '\n')
  return { hypHome, stateRoot }
}

/**
 * Simulate a live daemon: a pid file naming this (alive) test process, and a
 * status snapshot whose gateway source carries the given details.
 *
 * @param {string} stateRoot
 * @param {Record<string, unknown>} details
 */
function writeRunningDaemon(stateRoot, details) {
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'test-run', mode: 'foreground' }))
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'running',
    sources: [{ name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started', details }],
    sinks: [],
  }))
}

/**
 * @param {string} hypHome
 * @returns {CollectStatusOptions}
 */
function collectOpts(hypHome) {
  // Stub out the launch-agent probe so the machine's real daemon install
  // cannot leak into the report; daemon liveness then comes from the pid
  // file written above.
  return {
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
  }
}

test('an idle gateway that was configured with upstreams warns', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // The shape a `url = "..."` typo produces: the name survives into
  // `details.upstreams`, the entry never survives `compileUpstreams`, so
  // nothing is bound and no port is advertised.
  writeRunningDaemon(stateRoot, { listening: false, upstreams: ['anthropic'], registered_presets: [] })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams')
  assert.ok(diag, 'gateway_idle_no_upstreams diagnostic is emitted')
  assert.equal(diag.severity, 'warning')
  assert.match(diag.message, /anthropic/, 'the message names the upstream that went missing')
  assert.match(diag.message, /base_url/, 'and points at the field that drops an entry')
  // The repair has to be one that changes something. `hyp config validate`
  // prints `config ok` for exactly this config: `@hypaware/ai-gateway`
  // registers no config section, so nothing checks upstream shape, and the
  // v1 diagnoser matches an anthropic upstream by its `provider` field.
  assert.ok(
    !diag.repair.some((r) => /^\s*hyp config validate/.test(r)),
    'no repair step tells the user to run a command that calls this config fine',
  )
  assert.ok(
    diag.repair.some((r) => r.includes(path.join(hypHome, 'hypaware-config.json'))),
    'it names the file to edit',
  )
})

// `name` drops an entry exactly as silently as `base_url` does, and an entry
// with no usable name contributes nothing to `details.upstreams`, so the names
// alone cannot see this config at all. `upstreams_configured` counts the
// entries the config listed, whatever shape they were in, which is the only
// signal that separates "one upstream asked for, none survived" from
// "hermes-only". `hyp config validate` affirms this config, because its
// `gateway_missing_*_upstream` check matches on the `provider` field the entry
// still has.
test('an idle gateway whose configured upstream has no name warns', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // `provider = "anthropic", base_url = "..."` and no `name`: one upstream was
  // configured, `compileUpstreams` dropped it, and no name reaches status.
  writeRunningDaemon(stateRoot, {
    listening: false,
    upstreams: [],
    upstreams_configured: 1,
    registered_presets: [],
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams')
  assert.ok(diag, 'gateway_idle_no_upstreams diagnostic is emitted with no names to print')
  assert.equal(diag.severity, 'warning')
  assert.match(diag.message, /1 upstream/, 'the message falls back to the count it does have')
  assert.match(diag.message, /name/, "and names the field that made it nameless")
  assert.equal(report.overall, 'healthy', 'still non-degrading')
})

test('an idle gateway whose configured upstream has an empty name warns', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // `name = ""` reaches core the same way a missing `name` does: counted, not
  // named.
  writeRunningDaemon(stateRoot, {
    listening: false,
    upstreams: [],
    upstreams_configured: 2,
    registered_presets: [],
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams')
  assert.ok(diag)
  assert.match(diag.message, /2 upstreams are configured/, 'plural reads correctly')
})

test('an idle gateway with no configured upstreams stays quiet and healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // The hermes-only shape: the config asked for no upstream, so idling is the
  // outcome it wanted and there is nothing to report.
  writeRunningDaemon(stateRoot, {
    listening: false,
    upstreams: [],
    upstreams_configured: 0,
    registered_presets: [],
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'), undefined)
  assert.equal(report.overall, 'healthy', 'a deliberately idle gateway is a working install')
})

// No `upstreams` key at all is the other hermes-only shape (the source omits
// nothing, but a status file written by another build might), and a `upstreams`
// that is not a list at all is a config someone mangled. Neither is evidence
// that an upstream was lost, so both stay quiet rather than guessing.
test('an idle gateway with no upstreams key at all stays quiet and healthy', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, { listening: false, registered_presets: [] })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'), undefined)
  assert.equal(report.overall, 'healthy')
})

test('a degenerate upstreams detail does not crash or warn', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, {
    listening: false,
    upstreams: 'anthropic',
    upstreams_configured: 'lots',
    registered_presets: [],
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'), undefined)
  assert.equal(report.overall, 'healthy')
})

// A status file written by a build from before `upstreams_configured` existed
// still carries the names, and a dropped `base_url` is still visible in them.
test('a status file with names but no count still warns', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, { listening: false, upstreams: ['anthropic'], registered_presets: [] })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams')
  assert.ok(diag, 'the names carry the signal on their own')
  assert.match(diag.message, /anthropic/)
})

test('a listening gateway never warns, however many upstreams it has', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, { host: '127.0.0.1', port: 18521, upstreams: ['anthropic'] })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'), undefined)
})

test('the idle warning does not degrade overall health', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, { listening: false, upstreams: ['anthropic'] })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.ok(report.diagnostics.some((d) => d.kind === 'gateway_idle_no_upstreams'))
  // Same call as `gateway_port_fallback`: loud in the diagnostics list, but it
  // does not flip `overall`, which is reserved for what makes an install
  // unusable rather than misrouted.
  assert.equal(report.overall, 'healthy')
})

test('a stopped daemon does not warn off a stale status snapshot', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeStatusFile(stateRoot, /** @type {any} */ ({
    state: 'stopped',
    sources: [{
      name: 'ai-gateway',
      plugin: '@hypaware/ai-gateway',
      state: 'stopped',
      details: { listening: false, upstreams: ['anthropic'] },
    }],
    sinks: [],
  }))

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'), undefined)
})

// ---------------------------------------------------------------------------
// The partial loss, which the all-dropped check above could not see: with two
// upstreams configured and one valid, `mergeUpstreams` is non-empty, the proxy
// binds, `listening` is never set, and a user who typo'd one provider gets a
// working gateway that routes nothing for it. The signal that catches both is
// the same one - what the config asked for, against what compiled - so these
// go through the *real* gateway source and the *real* `compileUpstreams`
// rather than hand-written details, which is what makes them fail if the drop
// rule and the reported count ever disagree.
// @ref LLP 0195#visible-when-unintended [tests]: one configured-vs-compiled comparison covers the partial loss as well as the total one
// ---------------------------------------------------------------------------

/** An upstream that compiles. Never connected to; the proxy only routes to it. */
const VALID_UPSTREAM = { name: 'anthropic', base_url: 'http://127.0.0.1:1', path_prefix: '/anthropic' }

/**
 * The `details` the real gateway source publishes for a config, via a real
 * start/status/stop cycle.
 *
 * @param {unknown[]} upstreams
 * @param {GatewayState} [state]
 *   Defaults to a fresh state with no registered presets, matching every
 *   other caller here. Pass one already carrying a preset to exercise the
 *   backfill path in `mergeUpstreams`.
 * @returns {Promise<Record<string, unknown>>}
 */
async function realGatewayDetails(upstreams, state = createGatewayState()) {
  const ctx = /** @type {any} */ ({
    config: { listen: '127.0.0.1:0', upstreams },
    storage: {
      cacheTablePath: (/** @type {string} */ dataset) => dataset,
      async appendRows() {},
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const source = await createStartSource(state)(ctx)
  try {
    assert.ok(source.status, 'source exposes status()')
    const status = await source.status()
    assert.ok(status.details, 'the gateway source publishes status details')
    return /** @type {Record<string, unknown>} */ (status.details)
  } finally {
    await source.stop()
  }
}

test('a gateway that lost one of two configured upstreams warns while listening', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // `url` where `base_url` was meant: `compileUpstreams` drops the entry and
  // says nothing, so openai traffic is never proxied while anthropic is.
  const details = await realGatewayDetails([
    VALID_UPSTREAM,
    { name: 'openai', url: 'https://api.openai.com', path_prefix: '/openai' },
  ])
  assert.equal(details.upstreams_configured, 2, 'both entries are counted as configured')
  assert.equal(details.upstreams_dropped, 1, 'one of them never compiled to a route')
  assert.ok(details.port, 'and the gateway is listening, which is why this was invisible')
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag, 'a partial upstream loss is reported')
  assert.equal(diag.severity, 'warning')
  assert.match(diag.message, /1 of its 2 configured upstreams/, 'the message counts the loss')
  assert.match(diag.message, /openai/, 'and names the upstream that went missing')
  assert.doesNotMatch(diag.message, /anthropic/, 'not the one that is routing fine')
  assert.ok(
    diag.repair.some((r) => r.includes(path.join(hypHome, 'hypaware-config.json'))),
    'the repair names the file to edit',
  )
  // Non-degrading, exactly like the all-dropped case and `gateway_port_fallback`:
  // a gateway that routes three providers and misses a fourth is still a
  // working install, and whether a *fully* broken one should flip `overall` is
  // a separate, deliberately unanswered question.
  assert.equal(report.overall, 'healthy')
  assert.equal(
    report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'),
    undefined,
    'and the idle kind does not double-report: the gateway is bound',
  )
})

// `readConfiguredUpstreams` compares the raw config entry count against
// `compileUpstreams`'s output, and knows nothing about `state.presets`. But
// `mergeUpstreams` (what actually builds the routing table) backfills any
// registered adapter preset whose name is not already in the *compiled*
// config table - so a config entry that drops for shape reasons can still be
// proxied, just via the preset's default endpoint instead of the user's
// override. The count-based warning still has to fire (the override silently
// did not take effect), but its message must not claim the name is entirely
// uncaptured when a preset is quietly covering it.
//
// This is also the only path that reaches `dropped === configured === 1`, so
// it is where the singular wording gets exercised.
test('a dropped upstream whose name matches a registered adapter preset is still proxied, so the warning does not claim silence', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const state = createGatewayState()
  // Stands in for what `@hypaware/claude` registers at activation: a preset
  // named `anthropic` with its own default endpoint.
  createAiGatewayApi(state).registerUpstreamPreset({
    name: 'anthropic',
    base_url: 'http://127.0.0.1:1',
    path_prefix: '/anthropic',
  })
  const details = await realGatewayDetails(
    // `url` where `base_url` was meant: this entry never compiles, but its
    // name collides with the preset above, so the preset backfills the same
    // slot and the gateway still binds.
    [{ name: 'anthropic', url: 'https://api.anthropic.com', path_prefix: '/anthropic' }],
    state,
  )
  assert.equal(details.upstreams_configured, 1, 'one entry was configured')
  assert.equal(details.upstreams_dropped, 1, 'and it never compiled to a route')
  assert.ok(details.port, 'the preset backfilled the slot, so the gateway still binds')
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag, 'the override silently not taking effect is still worth a warning')
  assert.equal(
    report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'),
    undefined,
    'the gateway is bound, via the preset, so this is not the total-loss kind',
  )
  // `dropped === configured === 1` here, unlike the two-upstream case above:
  // reachable only through this preset-backfill path, which is exactly what
  // exercises the singular branch the idle message already had.
  assert.match(diag.message, /1 of its 1 configured upstream[^s]/, 'singular reads correctly')
  assert.doesNotMatch(
    diag.message,
    /nothing is proxied or captured/,
    'wrong: an adapter preset is still proxying this name, just not to the address the user configured',
  )
  // The daemon publishes `registered_presets`, so the message settles the
  // question instead of hedging over both answers (issue #676 item 1).
  assert.match(
    diag.message,
    /anthropic is still proxied by the adapter preset registered under the same name/,
    'it says which of the two things happened',
  )
  assert.equal(report.overall, 'healthy')
})

test('a partial loss with no usable name still warns off the count', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // `name` drops an entry as silently as `base_url` does, and a nameless entry
  // contributes nothing to `details.upstreams`, so the names alone cannot see
  // this config at all.
  const details = await realGatewayDetails([
    VALID_UPSTREAM,
    { provider: 'openai', base_url: 'https://api.openai.com', path_prefix: '/openai' },
  ])
  assert.equal(details.upstreams_dropped, 1)
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag, 'the count carries the warning with no name to print')
  assert.match(diag.message, /1 of its 2 configured upstreams did not compile/)
  assert.equal(report.overall, 'healthy')
})

test('a total loss still warns, through the same comparison', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const details = await realGatewayDetails([
    { name: 'anthropic', url: 'https://api.anthropic.com' },
    { name: 'openai', url: 'https://api.openai.com' },
  ])
  assert.equal(details.upstreams_dropped, 2)
  assert.equal(details.listening, false, 'nothing compiled, so nothing bound')
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams')
  assert.ok(diag, 'the all-dropped case keeps its own kind and its own message')
  assert.match(diag.message, /listening on nothing/, 'which says the thing only it can say')
  assert.match(diag.message, /connection refused/)
  assert.equal(
    report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped'),
    undefined,
    'the two kinds are mutually exclusive',
  )
  assert.equal(report.overall, 'healthy')
})

test('a fully valid gateway config stays quiet', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const details = await realGatewayDetails([
    VALID_UPSTREAM,
    { name: 'openai', base_url: 'https://api.openai.com', path_prefix: '/openai' },
  ])
  assert.equal(details.upstreams_dropped, 0, 'nothing was dropped')
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped'), undefined)
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'), undefined)
  assert.equal(report.overall, 'healthy')
})

test('a hermes-only gateway stays quiet through the same comparison', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const details = await realGatewayDetails([])
  assert.equal(details.listening, false, 'idle, as hermes-only asked for')
  assert.equal(details.upstreams_dropped, 0, 'and nothing was lost getting there')
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams'), undefined)
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped'), undefined)
  assert.equal(report.overall, 'healthy')
})

// A status file written by a build from before `upstreams_dropped` existed
// cannot answer the partial question at all: it recorded a bound gateway and
// the names it was configured with, and those names include the dropped entry.
// Guessing a loss from that would warn about every install whose adapter
// presets outnumber its config entries, so the older file stays quiet here and
// starts reporting the moment the daemon restarts on this build.
test('a status file without the dropped count does not guess at a partial loss', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, {
    host: '127.0.0.1',
    port: 18521,
    upstreams: ['anthropic', 'openai'],
    upstreams_configured: 2,
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  assert.equal(report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped'), undefined)
  assert.equal(report.overall, 'healthy')
})

// ---------------------------------------------------------------------------
// Issue #676 item 1: the bound-gateway message hedged ("unless an adapter
// preset already covers the same name") over a question the daemon already
// publishes the answer to. `details.registered_presets` lists every preset an
// adapter plugin registered at activation, and `mergeUpstreams` backfills one
// exactly when its name is absent from the compiled config table - which is
// what a dropped entry's name is, by definition. So the intersection of the
// dropped names with the registered presets decides, per name, between "still
// proxied, just not to the address you configured" and "silent". The hedge
// survives only where the daemon genuinely did not say: a status file with no
// preset list, or a drop this build could attach no name to.
//
// Issue #676 item 2: the names used to ride in a parenthetical attached to the
// configured-upstreams noun ("1 of its 2 configured upstreams (openai)"),
// which reads for a moment as the configured set rather than the dropped one.
// They now sit at the consequence they belong to.
// @ref LLP 0195#visible-when-unintended [tests]: the same configured-vs-compiled comparison, reported against the preset table the daemon already publishes
// ---------------------------------------------------------------------------

test('a dropped upstream covered by no preset is reported as silent, definitively', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const details = await realGatewayDetails([
    VALID_UPSTREAM,
    { name: 'openai', url: 'https://api.openai.com', path_prefix: '/openai' },
  ])
  assert.deepEqual(details.registered_presets, [], 'no adapter plugin registered anything')
  assert.deepEqual(details.upstreams_dropped_names, ['openai'], 'and the drop is attributable')
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag)
  assert.doesNotMatch(
    diag.message,
    /unless an adapter preset/,
    'the daemon published the preset list, so there is nothing left to hedge about',
  )
  assert.match(
    diag.message,
    /nothing is proxied or captured under the name openai/,
    'it says outright that this name has no route',
  )
})

test('a dropped upstream a registered preset covers is reported as still proxied, definitively', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const state = createGatewayState()
  createAiGatewayApi(state).registerUpstreamPreset({
    name: 'anthropic',
    base_url: 'http://127.0.0.1:1',
    path_prefix: '/anthropic',
  })
  const details = await realGatewayDetails(
    [{ name: 'anthropic', url: 'https://api.anthropic.com', path_prefix: '/anthropic' }],
    state,
  )
  assert.deepEqual(details.registered_presets, ['anthropic'], 'the preset the drop collides with')
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag, 'an override that silently did not take effect is still worth a warning')
  assert.doesNotMatch(diag.message, /unless an adapter preset/, 'no hedge: the answer is known')
  assert.match(
    diag.message,
    /still proxied by the adapter preset/,
    'it says which of the two things actually happened',
  )
  assert.match(diag.message, /base_url/, 'and that the configured address is the part that was lost')
  assert.doesNotMatch(
    diag.message,
    /nothing is proxied or captured/,
    'because that is the other case, and it is not this one',
  )
})

test('a mixed drop separates the covered name from the silent one', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const state = createGatewayState()
  createAiGatewayApi(state).registerUpstreamPreset({
    name: 'anthropic',
    base_url: 'http://127.0.0.1:1',
    path_prefix: '/anthropic',
  })
  // Two typo'd overrides. Only one of them has a preset behind it.
  const details = await realGatewayDetails(
    [
      { name: 'anthropic', url: 'https://api.anthropic.com', path_prefix: '/anthropic' },
      { name: 'openai', url: 'https://api.openai.com', path_prefix: '/openai' },
    ],
    state,
  )
  assert.equal(details.upstreams_dropped, 2)
  assert.ok(details.port, 'the preset backfill keeps the gateway bound')
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag)
  assert.match(diag.message, /nothing is proxied or captured under the name openai/, 'openai has no route')
  assert.match(diag.message, /anthropic is still proxied by the adapter preset/, 'anthropic is not')
})

test('the dropped names do not read as the configured set', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const details = await realGatewayDetails([
    VALID_UPSTREAM,
    { name: 'openai', url: 'https://api.openai.com', path_prefix: '/openai' },
  ])
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag)
  // "1 of its 2 configured upstreams (openai)" lists the dropped name against
  // the configured noun. Whatever the sentence does with the name, it must not
  // hang it off that phrase.
  assert.doesNotMatch(
    diag.message,
    /configured upstreams? \(/,
    'no parenthetical hangs the dropped names off the configured-upstreams noun',
  )
  assert.match(diag.message, /1 of its 2 configured upstreams did not compile/)
})

// The hedge is not deleted, it is confined to the case that still earns it: a
// status file from a build that never wrote `registered_presets` cannot be
// intersected with anything, and inventing "no preset covers this" from a
// missing field would turn an unknown into a false assertion of silence.
test('a status file with no preset list keeps the hedge', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, {
    host: '127.0.0.1',
    port: 18521,
    upstreams: ['anthropic'],
    upstreams_configured: 2,
    upstreams_dropped: 1,
    upstreams_dropped_names: ['openai'],
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag)
  assert.match(
    diag.message,
    /unless an adapter preset already covers the same name/,
    'unknown stays hedged rather than being guessed either way',
  )
  assert.match(diag.message, /\(dropped: openai\)/, 'and the name is labelled as the dropped one')
})

// A drop this build could attach no name to cannot be intersected either, even
// though the preset list is right there: the entry that lost its `name` is
// exactly the one whose destination is unknowable from status.
test('an unattributable drop keeps the hedge even with a preset list', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const details = await realGatewayDetails([
    VALID_UPSTREAM,
    { provider: 'openai', base_url: 'https://api.openai.com', path_prefix: '/openai' },
  ])
  assert.deepEqual(details.registered_presets, [], 'the preset list is present, and empty')
  assert.equal(details.upstreams_dropped, 1)
  assert.equal(details.upstreams_dropped_names, undefined, 'with no name to attribute it to')
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag)
  assert.match(diag.message, /unless an adapter preset already covers the same name/)
})

// ---------------------------------------------------------------------------
// Review of #678: both definitive clauses are claims about a *name*, and the
// gateway routes by `path_prefix` and `match()`. Neither the status file nor
// this module has the compiled prefixes, so neither clause may be read as a
// claim about a path. These two pin the routing facts that bound the wording,
// so a later edit that reaches for "traffic for openai is dead" or "only the
// base_url was lost" fails here rather than in front of an operator.
// @ref LLP 0195#visible-when-unintended [tests]: the warning reports which fate each dropped *name* met, which is all the configured-vs-compiled comparison can see
// ---------------------------------------------------------------------------

test('a silent dropped name is not reported as a dead path, because a surviving catch-all still takes its traffic', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // A surviving upstream written with no `path_prefix` compiles to '/', which
  // matches every path there is, so the dropped entry's traffic is proxied and
  // recorded - under anthropic's name, not openai's.
  assert.equal(pathMatchesPrefix('/openai/v1/chat/completions', '/'), true, 'the catch-all takes it')
  const details = await realGatewayDetails([
    { name: 'anthropic', base_url: 'http://127.0.0.1:1' },
    { name: 'openai', url: 'https://api.openai.com', path_prefix: '/openai' },
  ])
  assert.equal(compileUpstreams(/** @type {any} */ ([{ name: 'anthropic', base_url: 'http://127.0.0.1:1' }]))[0].path_prefix, '/', 'an absent path_prefix compiles to the catch-all')
  assert.deepEqual(details.upstreams_dropped_names, ['openai'])
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag)
  assert.match(
    diag.message,
    /nothing is proxied or captured under the name openai/,
    'the claim is about the name, which is the part status can settle',
  )
  assert.match(
    diag.message,
    /falls through to whatever surviving route its path matches/,
    'and it does not deny the fall-through that the catch-all above actually performs',
  )
})

test('a covered dropped name is reported as losing its path_prefix too, not only its base_url', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const state = createGatewayState()
  createAiGatewayApi(state).registerUpstreamPreset({
    name: 'anthropic',
    base_url: 'http://127.0.0.1:1',
    path_prefix: '/v1/messages',
  })
  // The operator's entry asked for a different prefix. It never compiled, so
  // the preset's whole entry is what backfills: a client still pointed at
  // /claude gets a 404 from a gateway that is otherwise proxying "anthropic".
  const configured = [{ name: 'anthropic', url: 'https://proxy.internal', path_prefix: '/claude' }]
  const merged = mergeUpstreams(compileUpstreams(/** @type {any} */ (configured)), state)
  assert.deepEqual(
    merged.map((u) => [u.name, u.path_prefix]),
    [['anthropic', '/v1/messages']],
    'the operator path_prefix is gone, not just the base_url',
  )
  const details = await realGatewayDetails(configured, state)
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag)
  assert.match(diag.message, /still proxied by the adapter preset/)
  assert.match(
    diag.message,
    /own base_url and path_prefix are what is in force/,
    'both fields reverted, and the message names both',
  )
})

// Two presets, two dropped names: one preset noun and one "the same name"
// would describe two different endpoints as though they were one.
test('two covered names read as two presets', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  api.registerUpstreamPreset({ name: 'anthropic', base_url: 'http://127.0.0.1:1', path_prefix: '/v1/messages' })
  api.registerUpstreamPreset({ name: 'openai', base_url: 'http://127.0.0.1:2', path_prefix: '/v1' })
  const details = await realGatewayDetails(
    [
      { name: 'anthropic', url: 'https://api.anthropic.com', path_prefix: '/anthropic' },
      { name: 'openai', url: 'https://api.openai.com', path_prefix: '/openai' },
    ],
    state,
  )
  assert.equal(details.upstreams_dropped, 2)
  writeRunningDaemon(stateRoot, details)

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_upstreams_dropped')
  assert.ok(diag)
  assert.match(
    diag.message,
    /anthropic, openai are still proxied by the adapter presets registered under the same names/,
    'plural presets, plural names',
  )
  assert.match(diag.message, /each preset's own base_url and path_prefix/)
  assert.doesNotMatch(diag.message, /nothing is proxied or captured/, 'neither of them is silent')
})

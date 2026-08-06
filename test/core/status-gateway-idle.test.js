// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createStartSource } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'

/** @import { CollectStatusOptions } from '../../src/core/daemon/types.js' */

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
// @ref LLP 0193#visible-when-unintended [tests]: one configured-vs-compiled comparison covers the partial loss as well as the total one
// ---------------------------------------------------------------------------

/** An upstream that compiles. Never connected to; the proxy only routes to it. */
const VALID_UPSTREAM = { name: 'anthropic', base_url: 'http://127.0.0.1:1', path_prefix: '/anthropic' }

/**
 * The `details` the real gateway source publishes for a config, via a real
 * start/status/stop cycle.
 *
 * @param {unknown[]} upstreams
 * @returns {Promise<Record<string, unknown>>}
 */
async function realGatewayDetails(upstreams) {
  const ctx = /** @type {any} */ ({
    config: { listen: '127.0.0.1:0', upstreams },
    storage: {
      cacheTablePath: (/** @type {string} */ dataset) => dataset,
      async appendRows() {},
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const source = await createStartSource(createGatewayState())(ctx)
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

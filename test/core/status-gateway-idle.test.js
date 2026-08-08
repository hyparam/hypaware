// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectHypAwareStatus, writeStatusFile } from '../../src/core/daemon/status.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

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

// The names in this warning are read out of `status.json`, which is a *file*:
// core cannot assume the daemon that wrote it was this version, this build, or
// well behaved, and the value is about to be printed to a terminal. The
// `recent clients` list is read back out of the same file through
// `sanitizeLabel` and a count cap for exactly that reason (LLP 0164); these
// names were going to the terminal raw. All three ways a name can be hostile
// are answered below - control and invisible bytes, unbounded length, and
// unbounded count.
// @ref LLP 0164#status-reads-it-from-the-status-file [tests]: what core reads back out of status.json is cleaned at the last point before render, whichever list it came from
test('a hostile upstream name cannot drive the terminal from the warning', async () => {
  const { hypHome, stateRoot } = await makeHome()
  writeRunningDaemon(stateRoot, {
    listening: false,
    // An escape sequence that erases the line and forges a plausible second
    // status line, and a zero-width run that hides inside a name on screen.
    upstreams: ['anthropic\u001b[2K\nhyp: all good', 'open\u200b\u200bai'],
    upstreams_configured: 2,
  })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams')
  assert.ok(diag)
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(diag.message), 'no control byte reaches the message')
  assert.ok(!diag.message.includes('\u200b'), 'and no zero-width run does either')
  assert.match(diag.message, /anthropic/, 'the printable part of a name still names it')
  assert.match(diag.message, /openai/, 'a hidden run is closed up, not made to drop the name')
})

test('an unbounded upstream name is clamped in the warning', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const long = 'a'.repeat(5000)
  writeRunningDaemon(stateRoot, { listening: false, upstreams: [long], upstreams_configured: 1 })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams')
  assert.ok(diag)
  assert.ok(!diag.message.includes(long), 'the raw name is not printed whole')
  // `sanitizeLabel`'s 120-character clamp, truncation marker included.
  assert.ok(diag.message.includes('a'.repeat(117) + '...'), 'it is clamped, and marked truncated')
})

test('an unbounded number of upstream names is capped, and the rest counted', async () => {
  const { hypHome, stateRoot } = await makeHome()
  const many = Array.from({ length: 50 }, (_, i) => `up-${i}`)
  writeRunningDaemon(stateRoot, { listening: false, upstreams: many, upstreams_configured: 50 })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams')
  assert.ok(diag)
  assert.match(diag.message, /nothing: 50 upstreams \(/, 'the count is still the true one')
  assert.equal(
    many.filter((name) => diag.message.includes(`${name},`) || diag.message.includes(`${name})`)).length,
    8,
    'only the capped number of names is spelled out',
  )
  // A truncated list that reads as a complete one would be worse than no list.
  assert.match(diag.message, /\+42 more/, 'and the names held back are counted, not dropped')
})

// The sanitizer and the cap bound what is *printed*. Neither may revise the
// count, which is the whole signal separating a dropped upstream from a
// legitimately upstream-less gateway - including on a status file too old to
// carry `upstreams_configured`, where the raw name list is the only count
// there is.
test('an older status file counts every name it holds, capped or not', async () => {
  const { hypHome, stateRoot } = await makeHome()
  // 20 names, two of which sanitize away to nothing: past the cap, so the cap
  // cannot be what makes the count 20, and holding names the printer refuses,
  // so the sanitizer cannot be either. Counting either filter's leavings would
  // report 18 or 8 upstreams for a config that asked for 20.
  const older = Array.from({ length: 20 }, (_, i) => (i === 3 || i === 11 ? '\u200b\u200b' : `up-${i}`))
  writeRunningDaemon(stateRoot, { listening: false, upstreams: older })

  const report = await collectHypAwareStatus(collectOpts(hypHome))
  const diag = report.diagnostics.find((d) => d.kind === 'gateway_idle_no_upstreams')
  assert.ok(diag)
  assert.match(diag.message, /nothing: 20 upstreams \(/, 'the fallback count is the raw one')
  // 20 held, 8 printed: the 12 the line does not show are all accounted for,
  // whichever filter withheld them.
  assert.match(diag.message, /\+12 more/, 'and every name it does not print is counted back')
})

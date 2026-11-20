// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { temporaryDirectory } from '../../../helpers/temp_dir.js'
import {
  USAGE_SOURCES,
  anyClientLaunchable,
  recordedAskClientLaunchable,
  runWizardSuggestSkill,
  usageSessionsRecorded,
} from '../../../../src/core/cli/wizard/suggest_skill.js'

const VERB = /Run `hyp usage` any time: HypAware shows what your AI usage went into, by task/

function makeBuf() {
  let value = ''
  return {
    /** @param {string} chunk */
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

/**
 * A child that exits with `code` once its handlers are wired, or fails to
 * start when `code` is null.
 * @param {number | null} code
 */
function childExiting(code) {
  /** @type {{ cmd: string, args: string[], opts: any }[]} */
  const calls = []
  return {
    calls,
    fn: /** @type {any} */ ((/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
      calls.push({ cmd, args, opts })
      /** @type {Record<string, (arg: any) => void>} */
      const handlers = {}
      queueMicrotask(() => {
        if (code === null) handlers.error?.(new Error('ENOENT'))
        else handlers.close?.(code)
      })
      return { on: (/** @type {string} */ event, /** @type {any} */ fn) => { handlers[event] = fn } }
    }),
  }
}

test('runWizardSuggestSkill: an empty cache states why there is nothing to suggest yet', async () => {
  // @ref LLP 0198#empty-cache [tests]: no rows means no launch, and the reason is stated
  const stdout = makeBuf()
  const child = childExiting(0)
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, hasRows: false,
    confirm: async () => 'yes', spawnFn: child.fn,
  })
  assert.deepEqual(result, { asked: false, reason: 'no-rows' })
  assert.equal(child.calls.length, 0)
  assert.match(stdout.text(), /Nothing recorded yet: HypAware captures from your next session onward/)
  assert.match(stdout.text(), /Once you have some history, run `hyp usage`/)
})

// @ref LLP 0398#setup-offer [tests]: nothing launchable means no offer and no mention of the verb
test('runWizardSuggestSkill: with nothing launchable the step is silent and never asks', async () => {
  const stdout = makeBuf()
  const child = childExiting(0)
  let asked = 0
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, hasRows: true, launchable: false,
    confirm: async () => { asked += 1; return 'yes' }, spawnFn: child.fn,
  })
  assert.deepEqual(result, { asked: false, reason: 'no-launcher' })
  assert.equal(asked, 0)
  assert.equal(child.calls.length, 0)
  assert.equal(stdout.text(), '')
})

test('runWizardSuggestSkill: an empty cache with nothing launchable keeps the note and drops the verb', async () => {
  const stdout = makeBuf()
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, hasRows: false, launchable: false,
  })
  // Still `no-rows`: the empty-cache rate is measured whatever is on PATH.
  assert.deepEqual(result, { asked: false, reason: 'no-rows' })
  assert.match(stdout.text(), /Nothing recorded yet: HypAware captures from your next session onward/)
  assert.doesNotMatch(stdout.text(), /hyp usage/)
})

test('runWizardSuggestSkill: rows with no Claude Code or Codex session make no offer and print nothing', async () => {
  const stdout = makeBuf()
  const child = childExiting(0)
  let asked = 0
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, hasRows: true, usageRows: false, launchable: true,
    confirm: async () => { asked += 1; return 'yes' }, spawnFn: child.fn,
  })
  assert.deepEqual(result, { asked: false, reason: 'no-usage-rows' })
  assert.equal(asked, 0)
  assert.equal(child.calls.length, 0)
  assert.equal(stdout.text(), '')
})

test('usageSessionsRecorded: one bounded query over the last 30 days, false on no row, undefined when it cannot tell', async () => {
  /** @type {string[]} */
  const seen = []
  /** @param {Record<string, unknown>[]} rows */
  const runner = (rows) => ({ hasDataset: () => true, async run(/** @type {string} */ sql) { seen.push(sql); return { columns: [], rows } } })
  const now = new Date('2026-11-20T00:30:00Z')
  assert.equal(await usageSessionsRecorded(runner([{ n: 1 }]), now), true)
  assert.equal(seen[0], "select 1 as n from ai_gateway_messages where date >= '2026-10-22' and conversation_source in ('claude_code', 'claude', 'claude-desktop', 'codex') limit 1")
  assert.equal(await usageSessionsRecorded(runner([]), now), false)
  assert.equal(await usageSessionsRecorded(undefined, now), undefined)
  const failing = { hasDataset: () => true, async run() { throw new Error('cache unreadable') } }
  assert.equal(await usageSessionsRecorded(failing, now), undefined)
  // A query that outlives its budget is abandoned, and setup goes on. `unref`
  // so the abandoned query does not hold the test runner open.
  const stalled = { hasDataset: () => true, run: () => new Promise(() => { setTimeout(() => {}, 5000).unref() }) }
  assert.equal(await usageSessionsRecorded(/** @type {any} */ (stalled), now, 20), undefined)
})

test('USAGE_SOURCES matches the sources the usage digest charts', async () => {
  const digest = await fs.readFile(path.join(import.meta.dirname, '../../../../hypaware-core/usage/hypaware-usage-by-task/scripts/digest.mjs'), 'utf8')
  const listed = digest.match(/conversation_source IN \(([^)]*)\)/)
  assert.ok(listed, 'digest.mjs no longer filters on conversation_source IN (...)')
  assert.deepEqual(listed[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')), USAGE_SOURCES)
})

test('anyClientLaunchable: true when a launch binary resolves, false when none does, undefined when it cannot tell', async () => {
  const descriptors = /** @type {any} */ (new Map([
    ['claude', { name: 'claude', launch: { bin: 'claude', args: ['{prompt}'] } }],
    // Detectable and recorded, but nothing to start: no `launch` block.
    ['claude-desktop', { name: 'claude-desktop' }],
  ]))
  assert.equal(await anyClientLaunchable({}, { descriptors, resolve: async (bin) => `/bin/${bin}` }), true)
  assert.equal(await anyClientLaunchable({}, { descriptors, resolve: async () => undefined }), false)
  assert.equal(await anyClientLaunchable({}, { descriptors: new Map() }), undefined)
})

/**
 * A finale summary with the given attach rows and nothing else run.
 * @param {any[]} attach
 * @param {Record<string, any>} [over]
 */
function finaleSummary(attach, over = {}) {
  return /** @type {any} */ ({
    daemonInstall: { skipped: true, dryRun: false },
    globalInstall: { skipped: true, installed: false },
    attach,
    skillsInstalled: [],
    agentsInstalled: [],
    daemonRestart: { skipped: true, dryRun: false, ok: false },
    backfill: [],
    ...over,
  })
}

test('recordedAskClientLaunchable: none recorded, recorded but unverified, and verified', async () => {
  const home = await temporaryDirectory('hyp-ask-pointer-')
  const env = { HOME: home }
  const descriptors = /** @type {any} */ (new Map([
    ['claude', { name: 'claude', skillDir: '.claude/skills', launch: { bin: 'claude', args: ['{prompt}'] } }],
    ['claude-desktop', { name: 'claude-desktop', skillDir: '.claude/skills' }],
  ]))
  const onPath = { descriptors, resolve: async (/** @type {string} */ bin) => `/bin/${bin}` }
  const attached = finaleSummary([{ client: 'claude', dryRun: false, ok: true }])

  // None recorded: no attach row, a failed or dry-run attach, a client the
  // run left not recording, and a client with nothing to start.
  assert.equal(await recordedAskClientLaunchable(undefined, env, onPath), false)
  assert.equal(await recordedAskClientLaunchable(finaleSummary([]), env, onPath), false)
  for (const row of [
    { client: 'claude', dryRun: false, ok: false },
    { client: 'claude', dryRun: false, ok: false, activationFailed: true },
    { client: 'claude', dryRun: true, ok: true },
    { client: 'claude', dryRun: false, ok: true, skipped: true, notRecording: true },
    { client: 'claude-desktop', dryRun: false, ok: true, noAdapter: true },
  ]) {
    assert.equal(await recordedAskClientLaunchable(finaleSummary([row]), env, onPath), false, JSON.stringify(row))
  }

  // Recorded but unverified: attached, yet the query skill is not on disk,
  // or it is and the CLI does not resolve.
  assert.equal(await recordedAskClientLaunchable(attached, env, onPath), false)
  const skill = path.join(home, '.claude', 'skills', 'hypaware-query', 'SKILL.md')
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.writeFile(skill, '# query\n')
  assert.equal(await recordedAskClientLaunchable(attached, env, { descriptors, resolve: async () => undefined }), false)

  // Verified: attached (or already attached on the team pathway), the CLI
  // resolves, and the skill is installed.
  assert.equal(await recordedAskClientLaunchable(attached, env, onPath), true)
  const alreadyAttached = finaleSummary([{ client: 'claude', dryRun: false, ok: true, skipped: true }])
  assert.equal(await recordedAskClientLaunchable(alreadyAttached, env, onPath), true)

  // A failed daemon install withholds the pointer even then.
  const failedInstall = finaleSummary(attached.attach, { daemonInstall: { skipped: false, dryRun: false, failed: true } })
  assert.equal(await recordedAskClientLaunchable(failedInstall, env, onPath), false)
})

test('runWizardSuggestSkill: a run that cannot prompt names the verb and starts nothing', async () => {
  const stdout = makeBuf()
  const child = childExiting(0)
  // No confirm seam and a buffer for stdout: not a terminal on either end.
  const result = await runWizardSuggestSkill({ stdout, env: {}, interactive: true, spawnFn: child.fn })
  assert.deepEqual(result, { asked: false, reason: 'not-interactive' })
  assert.equal(child.calls.length, 0)
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: interactive false never asks, even with a prompt seam', async () => {
  const stdout = makeBuf()
  let asked = 0
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: false,
    confirm: async () => { asked += 1; return 'yes' },
  })
  assert.deepEqual(result, { asked: false, reason: 'not-interactive' })
  assert.equal(asked, 0)
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: yes runs `hyp usage` as a child that inherits the terminal', async () => {
  // @ref LLP 0398#setup-offer-usage [tests]: the offer taken is `hyp usage` itself
  const stdout = makeBuf()
  const child = childExiting(0)
  /** @type {any} */
  let question
  const result = await runWizardSuggestSkill({
    stdout, env: { HYP_HOME: '/h' }, interactive: true, hasRows: true,
    confirm: async (q) => { question = q; return 'yes' },
    spawnFn: child.fn,
  })
  assert.deepEqual(result, { asked: true, launched: true })
  assert.equal(question.title, 'See what your AI usage went into?')
  assert.equal(question.default, 'yes')
  // The default acts, so a spent stdin must decline (LLP 0299 #eof-declines).
  assert.equal(question.eofValue, 'no')
  assert.equal(child.calls.length, 1)
  assert.equal(child.calls[0].cmd, process.execPath)
  assert.equal(child.calls[0].args.at(-1), 'usage')
  assert.equal(child.calls[0].opts.stdio, 'inherit')
  assert.equal(child.calls[0].opts.env.HYP_HOME, '/h')
  // The child owns the closing screen; nothing is added after it.
  assert.doesNotMatch(stdout.text(), VERB)
})

test('runWizardSuggestSkill: no names the verb and starts nothing', async () => {
  const stdout = makeBuf()
  const child = childExiting(0)
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, confirm: async () => 'no', spawnFn: child.fn,
  })
  assert.deepEqual(result, { asked: true, launched: false, reason: 'declined' })
  assert.equal(child.calls.length, 0)
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: a cancelled prompt is "not now", not a failed run', async () => {
  const stdout = makeBuf()
  const child = childExiting(0)
  const cancelled = Object.assign(new Error('cancelled'), { name: 'PromptCancelledError' })
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, confirm: async () => { throw cancelled }, spawnFn: child.fn,
  })
  assert.deepEqual(result, { asked: true, launched: false, reason: 'declined' })
  assert.equal(child.calls.length, 0)
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: a child that could not start degrades to the verb', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const result = await runWizardSuggestSkill({
    stdout, stderr, env: {}, interactive: true, confirm: async () => 'yes', spawnFn: childExiting(null).fn,
  })
  assert.deepEqual(result, { asked: true, launched: false, reason: 'spawn-failed' })
  assert.match(stderr.text(), /Could not start hyp usage: ENOENT/)
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: a child that exits non-zero has said why; only the verb is added', async () => {
  const stdout = makeBuf()
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, confirm: async () => 'yes', spawnFn: childExiting(1).fn,
  })
  assert.deepEqual(result, { asked: true, launched: false, reason: 'child-failed' })
  assert.match(stdout.text(), VERB)
})

test('runWizardSuggestSkill: an unforeseen throw is contained', async () => {
  const stdout = makeBuf()
  const result = await runWizardSuggestSkill({
    stdout, env: {}, interactive: true, confirm: async () => { throw new TypeError('boom') },
  })
  assert.deepEqual(result, { asked: false, reason: 'error' })
  assert.match(stdout.text(), VERB)
})

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { buildWalkthroughClientDescriptorMap } from '../../../../src/core/cli/walkthrough.js'
import { materializeClientAssets } from '../../../../src/core/runtime/client_assets.js'
import { temporaryDirectory } from '../../../helpers/temp_dir.js'
import {
  anyClientLaunchable,
  recordedReportClientLaunchable,
  runWizardSuggestSkill,
} from '../../../../src/core/cli/wizard/suggest_skill.js'

const VERB = /Run `hyp ask` any time: HypAware suggests a skill based on your recent sessions/

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
  assert.match(stdout.text(), /Once you have some history, run `hyp ask`/)
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
  assert.doesNotMatch(stdout.text(), /hyp ask/)
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

test('recordedReportClientLaunchable: none recorded, recorded but unverified, and verified', async () => {
  const home = await temporaryDirectory('hyp-report-pointer-')
  const env = { HOME: home }
  const descriptors = /** @type {any} */ (new Map([
    ['claude', { name: 'claude', skillDir: '.claude/skills', agentDir: '.claude/agents', launch: { bin: 'claude', args: ['{prompt}'] } }],
    ['claude-desktop', { name: 'claude-desktop', skillDir: '.claude/skills' }],
    ['codex', { name: 'codex', skillDir: '.codex/skills', launch: { bin: 'codex', args: ['{prompt}'] } }],
  ]))
  const onPath = { descriptors, resolve: async (/** @type {string} */ bin) => `/bin/${bin}` }
  const attached = finaleSummary([{ client: 'claude', dryRun: false, ok: true }])

  // None recorded: no attach row, a failed or dry-run attach, a client the
  // run left not recording, and a client with nothing to start.
  assert.equal(await recordedReportClientLaunchable(undefined, env, onPath), false)
  assert.equal(await recordedReportClientLaunchable(finaleSummary([]), env, onPath), false)
  for (const row of [
    { client: 'claude', dryRun: false, ok: false },
    { client: 'claude', dryRun: false, ok: false, activationFailed: true },
    { client: 'claude', dryRun: true, ok: true },
    { client: 'claude', dryRun: false, ok: true, skipped: true, notRecording: true },
    { client: 'claude-desktop', dryRun: false, ok: true, noAdapter: true },
  ]) {
    assert.equal(await recordedReportClientLaunchable(finaleSummary([row]), env, onPath), false, JSON.stringify(row))
  }

  // Recorded but unverified: attached, yet the report skill is not on disk,
  // or it is and the CLI does not resolve.
  assert.equal(await recordedReportClientLaunchable(attached, env, onPath), false)
  const skill = path.join(home, '.claude', 'skills', 'hypaware-report', 'SKILL.md')
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.writeFile(skill, '# report\n')
  assert.equal(await recordedReportClientLaunchable(attached, env, { descriptors, resolve: async () => undefined }), false)

  // The skill alone is not enough where the client has subagents: the report
  // skill delegates to `hypaware-analyst`, so a missing worker, or one whose
  // directory could not be created, leaves the client unverified.
  assert.equal(await recordedReportClientLaunchable(attached, env, onPath), false)
  const agentsDir = path.join(home, '.claude', 'agents')
  await fs.writeFile(agentsDir, 'not a directory\n')
  assert.equal(await recordedReportClientLaunchable(attached, env, onPath), false)
  await fs.rm(agentsDir)
  await fs.mkdir(agentsDir)
  await fs.writeFile(path.join(agentsDir, 'hypaware-analyst.md'), '# analyst\n')

  // Verified: attached (or already attached on the team pathway), the CLI
  // resolves, and the skill and its worker are installed.
  assert.equal(await recordedReportClientLaunchable(attached, env, onPath), true)
  const alreadyAttached = finaleSummary([{ client: 'claude', dryRun: false, ok: true, skipped: true }])
  assert.equal(await recordedReportClientLaunchable(alreadyAttached, env, onPath), true)

  // A failed daemon install withholds the pointer even then.
  const failedInstall = finaleSummary(attached.attach, { daemonInstall: { skipped: false, dryRun: false, failed: true } })
  assert.equal(await recordedReportClientLaunchable(failedInstall, env, onPath), false)

  // A client with no subagent directory needs only its skill.
  const codexSkill = path.join(home, '.codex', 'skills', 'hypaware-report', 'SKILL.md')
  await fs.mkdir(path.dirname(codexSkill), { recursive: true })
  await fs.writeFile(codexSkill, '# report\n')
  const codex = finaleSummary([{ client: 'codex', dryRun: false, ok: true }])
  assert.equal(await recordedReportClientLaunchable(codex, env, onPath), true)
})

test('recordedReportClientLaunchable: a Claude install whose analyst copy failed is not ready', async () => {
  const home = await temporaryDirectory('hyp-report-worker-')
  const descriptors = await buildWalkthroughClientDescriptorMap()
  const claude = /** @type {any} */ (descriptors.get('claude'))
  const plugin = fileURLToPath(new URL('../../../../hypaware-core/plugins-workspace/claude/', import.meta.url))
  const options = /** @type {any} */ ({
    clients: ['claude'],
    descriptors,
    homeDir: home,
    skills: { list: () => [{ name: 'hypaware-report', clients: ['claude'], plugin: '@hypaware/claude', sourceDir: path.join(plugin, 'skills', 'hypaware-report') }] },
    agents: { list: () => [{ name: 'hypaware-analyst', clients: ['claude'], plugin: '@hypaware/claude', sourceFile: path.join(plugin, 'agents', 'hypaware-analyst.md') }] },
    stderr: { write: () => true },
  })
  const env = { HOME: home }
  const deps = { descriptors, resolve: async (/** @type {string} */ bin) => `/bin/${bin}` }
  const attached = finaleSummary([{ client: 'claude', dryRun: false, ok: true }])

  // A file where the agents directory belongs: the skill copies, the
  // analyst does not, and the materializer carries on.
  const agentsDir = path.join(home, claude.agentDir)
  await fs.mkdir(path.dirname(agentsDir), { recursive: true })
  await fs.writeFile(agentsDir, 'not a directory\n')
  const mixed = await materializeClientAssets(options)
  assert.deepEqual(mixed.installed.map((/** @type {any} */ a) => `${a.kind}:${a.name}`), ['skill:hypaware-report'])
  assert.equal(await recordedReportClientLaunchable(attached, env, deps), false)

  // The same install once the analyst lands.
  await fs.rm(agentsDir)
  await materializeClientAssets(options)
  assert.equal(await recordedReportClientLaunchable(attached, env, deps), true)
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

test('runWizardSuggestSkill: yes runs `hyp ask` as a child that inherits the terminal', async () => {
  // @ref LLP 0398#setup-offer [tests]: the offer taken is the ask itself
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
  assert.equal(question.title, 'Suggest a new skill?')
  assert.equal(question.default, 'yes')
  // The default acts, so a spent stdin must decline (LLP 0299 #eof-declines).
  assert.equal(question.eofValue, 'no')
  assert.equal(child.calls.length, 1)
  assert.equal(child.calls[0].cmd, process.execPath)
  assert.equal(child.calls[0].args.at(-1), 'ask')
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
  assert.match(stderr.text(), /Could not start hyp ask: ENOENT/)
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

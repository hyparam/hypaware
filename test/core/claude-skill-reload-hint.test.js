// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPickerFinale, writeWalkthroughRunSummary } from '../../src/core/cli/walkthrough.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { CLAUDE_SKILL_RELOAD_HINT } from '../../src/core/runtime/client_assets.js'

// Issue #394: a run that actually copies Claude Code skills says how to make a
// running Claude Code session see them, once. Every other outcome (Codex
// copies, agents only, a failed copy, nothing to do, a dry run) says nothing.

const HINT = 'If the skills are not visible, run /reload-skills in Claude Code, or start a new session.'

function makeBuf() {
  let value = ''
  return {
    write(/** @type {string} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/** @param {string} text */
function hintCount(text) {
  return text.split('\n').filter((line) => line === HINT).length
}

/** @param {string} prefix */
async function tmpHome(prefix) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const sourceDir = path.join(home, 'src-skill')
  await fs.mkdir(sourceDir, { recursive: true })
  await fs.writeFile(path.join(sourceDir, 'SKILL.md'), 'skill body\n', 'utf8')
  const sourceFile = path.join(home, 'src-agent.md')
  await fs.writeFile(sourceFile, '---\nname: test-analyst\n---\nbody\n', 'utf8')
  return { home, sourceDir, sourceFile, env: { HOME: home, HYP_HOME: path.join(home, '.hyp') } }
}

function kernelAndRegistry() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  return { kernel, registry }
}

/**
 * @param {{ skills?: { name: string, clients: string[], sourceDir: string }[], agents?: { name: string, clients: string[], sourceFile: string }[], env: Record<string, string> }} args
 */
async function skillsInstall({ skills = [], agents = [], env }) {
  const { kernel, registry } = kernelAndRegistry()
  for (const s of skills) kernel.skills.register({ ...s, plugin: /** @type {any} */ ('@hypaware/claude'), clients: /** @type {any} */ (s.clients) })
  for (const a of agents) kernel.agents.register({ ...a, plugin: /** @type {any} */ ('@hypaware/claude'), clients: /** @type {any} */ (a.clients) })
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['skills', 'install'], { stdout, stderr, env, registry, kernel })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

test('the hint is the decided sentence, with no em dash', () => {
  assert.equal(CLAUDE_SKILL_RELOAD_HINT, HINT)
  assert.doesNotMatch(CLAUDE_SKILL_RELOAD_HINT, /—/)
})

test('hyp skills install prints the hint once after Claude skill copies, also beside other clients', async () => {
  const { sourceDir, sourceFile, env } = await tmpHome('hypaware-reload-hint-')
  const run = await skillsInstall({
    skills: [
      { name: 'one', clients: ['claude', 'codex'], sourceDir },
      { name: 'two', clients: ['claude'], sourceDir },
    ],
    agents: [{ name: 'test-analyst', clients: ['claude'], sourceFile }],
    env,
  })
  assert.equal(run.code, 0)
  assert.match(run.stdout, /installed 3 skill copy\(ies\), 1 agent copy\(ies\)\n/)
  assert.equal(hintCount(run.stdout), 1, 'one line for the bulk run, not one per copy')
  assert.ok(run.stdout.endsWith(`${HINT}\n`), 'the hint follows the count line')
})

test('hyp skills install prints no hint for Codex-only skills', async () => {
  const { sourceDir, env } = await tmpHome('hypaware-reload-hint-codex-')
  const run = await skillsInstall({ skills: [{ name: 'one', clients: ['codex'], sourceDir }], env })
  assert.equal(run.code, 0)
  assert.match(run.stdout, /installed 1 skill copy\(ies\), 0 agent copy\(ies\)/)
  assert.equal(hintCount(run.stdout), 0)
})

test('hyp skills install prints no hint when only agents are copied', async () => {
  const { sourceFile, env } = await tmpHome('hypaware-reload-hint-agent-')
  const run = await skillsInstall({ agents: [{ name: 'test-analyst', clients: ['claude'], sourceFile }], env })
  assert.equal(run.code, 0)
  assert.match(run.stdout, /installed 0 skill copy\(ies\), 1 agent copy\(ies\)/)
  assert.equal(hintCount(run.stdout), 0)
})

test('hyp skills install prints no hint when the Claude skill copy fails', async () => {
  const { home, sourceFile, env } = await tmpHome('hypaware-reload-hint-fail-')
  const run = await skillsInstall({
    skills: [{ name: 'broken', clients: ['claude'], sourceDir: path.join(home, 'missing') }],
    agents: [{ name: 'test-analyst', clients: ['claude'], sourceFile }],
    env,
  })
  assert.equal(run.code, 0)
  assert.match(run.stderr, /skill 'broken' for claude failed/)
  assert.equal(hintCount(run.stdout), 0)
})

test('hyp skills install prints no hint when there is nothing to install', async () => {
  const { env } = await tmpHome('hypaware-reload-hint-noop-')
  const run = await skillsInstall({ env })
  assert.equal(run.code, 0)
  assert.match(run.stdout, /\(nothing to install\)/)
  assert.equal(hintCount(run.stdout), 0)
})

const capabilities = /** @type {any} */ ({
  has: (/** @type {string} */ name) => name === 'hypaware.ai-gateway',
  require: () => ({
    getClient: () => ({ attach: async () => {} }),
    localEndpoint: () => 'http://127.0.0.1:4317',
  }),
})

/**
 * Run the finale the way a scripted setup does, then its run summary, and
 * return everything printed.
 * @param {{ clientsPicked: string[], skillClients: string[], dryRun: boolean, prefix: string }} args
 */
async function scriptedSetup({ clientsPicked, skillClients, dryRun, prefix }) {
  const { sourceDir, env } = await tmpHome(prefix)
  const skills = { list: () => [{ name: 'one', clients: /** @type {any} */ (skillClients), sourceDir }] }
  const stdout = makeBuf()
  const stderr = makeBuf()
  const configPath = path.join(env.HYP_HOME, 'hypaware-config.json')
  const finaleSummary = await runPickerFinale({
    capabilities,
    skills,
    stdout,
    stderr,
    env,
    clientsPicked,
    config: { version: 2, plugins: clientsPicked.map((c) => ({ name: `@hypaware/${c}` })) },
    configPath,
    retentionDays: 30,
    interactive: false,
    finale: { skipDaemon: true, dryRun },
  })
  assert.notEqual(finaleSummary.cancelled, true)
  writeWalkthroughRunSummary({ stdout, configPath, finaleSummary, dryRun })
  return stdout.text()
}

test('a scripted setup that copies Claude skills prints the hint once across the finale and run summary', async () => {
  const text = await scriptedSetup({
    clientsPicked: ['claude', 'codex'],
    skillClients: ['claude', 'codex'],
    dryRun: false,
    prefix: 'hypaware-reload-hint-setup-',
  })
  assert.match(text, /^✓ Installed skills for claude and codex$/m)
  assert.match(text, /^skills: 2 copied$/m, 'the run summary also reported the copies')
  assert.equal(hintCount(text), 1)
})

test('a scripted setup that copies only Codex skills prints no hint', async () => {
  const text = await scriptedSetup({
    clientsPicked: ['codex'],
    skillClients: ['codex'],
    dryRun: false,
    prefix: 'hypaware-reload-hint-setup-codex-',
  })
  assert.match(text, /^skills: 1 copied$/m)
  assert.equal(hintCount(text), 0)
})

test('a dry-run setup never claims the planned Claude copies happened', async () => {
  const text = await scriptedSetup({
    clientsPicked: ['claude'],
    skillClients: ['claude'],
    dryRun: true,
    prefix: 'hypaware-reload-hint-setup-dry-',
  })
  assert.match(text, /^\(dry-run\) would install skills for claude$/m)
  assert.equal(hintCount(text), 0)
})

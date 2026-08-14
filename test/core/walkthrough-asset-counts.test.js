// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'

// The finale's client-asset step reports counts per client, not one line per
// copy: a two-client install copies a dozen trees, and a dozen paths on the
// last screen of onboarding bury the step's one fact under output the user
// did not choose and cannot act on.

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

/** @param {string} prefix */
async function tmpEnv(prefix) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  return { HOME: tmp, HYP_HOME: path.join(tmp, '.hyp') }
}

const capabilities = /** @type {any} */ ({
  has: (/** @type {string} */ name) => name === 'hypaware.ai-gateway',
  require: () => ({
    getClient: () => ({ attach: async () => {} }),
    localEndpoint: () => 'http://127.0.0.1:4317',
  }),
})

// Two skills for both clients, one claude-only skill, one agent. Dry-run, so
// the source directories are never read.
const skills = {
  list: () => [
    { name: 'a', clients: /** @type {('claude'|'codex')[]} */ (['claude', 'codex']), sourceDir: '/nonexistent/a' },
    { name: 'b', clients: /** @type {('claude'|'codex')[]} */ (['claude', 'codex']), sourceDir: '/nonexistent/b' },
    { name: 'c', clients: /** @type {('claude'|'codex')[]} */ (['claude']), sourceDir: '/nonexistent/c' },
  ],
}
const agents = {
  list: () => [
    { name: 'analyst', clients: /** @type {('claude'|'codex')[]} */ (['claude']), sourceFile: '/nonexistent/analyst.md' },
  ],
}

test('the finale reports asset counts per client, never a line per copy', async () => {
  const env = await tmpEnv('hypaware-asset-counts-')
  const stdout = makeBuf()
  const stderr = makeBuf()

  const result = await runPickerWalkthrough({
    capabilities,
    skills,
    agents,
    stdout,
    stderr,
    env,
    picks: { sources: ['claude', 'codex'], exportChoice: 'keep-local', retentionDays: 30 },
    finale: { skipDaemon: true, dryRun: true },
  })

  assert.equal(result.exitCode, 0)
  const text = stdout.text()
  // Counted per client: claude took all three skills and the agent, codex two
  // skills and no agent. The sum (five copies) is true of neither client.
  assert.match(text, /\(dry-run\) would install 3 skills and 1 agent for claude\n/)
  assert.match(text, /\(dry-run\) would install 2 skills for codex\n/)
  // No per-copy line, and no destination paths.
  assert.doesNotMatch(text, /install skill 'a'/)
  assert.doesNotMatch(text, /skills\/a/)
})

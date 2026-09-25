// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPickerWalkthrough } from '../../src/core/cli/walkthrough.js'

// The finale's client-asset step reports one line naming the clients, not one
// line per copy: a two-client install copies a dozen trees, and a dozen paths
// on the last screen of onboarding bury the step's one fact under output the
// user did not choose and cannot act on. The install counts are left out too:
// they describe the packaging, not anything the user picked.

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

test('the finale reports one install line naming the clients, never a line per copy', async () => {
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
  // One line for both clients, and "agents" because claude took one.
  assert.match(text, /^\(dry-run\) would install skills and agents for claude and codex$/m)
  assert.equal(text.match(/would install/g)?.length, 1, 'one install line, not one per client')
  // No per-copy line, and no destination paths.
  assert.doesNotMatch(text, /install skill 'a'/)
  assert.doesNotMatch(text, /skills\/a/)
})

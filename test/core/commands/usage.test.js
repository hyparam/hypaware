// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { USAGE_INSTRUCTIONS, runUsage, usagePrompt } from '../../../src/core/commands/usage.js'

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-usage-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  /** @type {any[]} */ const launches = []
  const ctx = /** @type {any} */ ({
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    cwd: path.join(home, 'some-repo'),
    stdin: { isTTY: false },
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  const deps = /** @type {any} */ ({
    collectStatus: async () => ({ clients: [{ name: 'claude', attached: true }] }),
    resolveLaunchers: async () => [{ client: 'claude', label: 'Claude Code', bin: 'claude', binPath: '/bin/claude', args: ['{prompt}'] }],
    launchClient: async (/** @type {any} */ args) => { launches.push(args); return { ok: true, code: 0 } },
  })
  return { ctx, deps, out, err, launches, home }
}

test('the instructions and every script they name ship in the package', async () => {
  for (const file of Object.values(USAGE_INSTRUCTIONS)) await fs.access(file)
  const chat = path.dirname(USAGE_INSTRUCTIONS.chat)
  const page = path.dirname(USAGE_INSTRUCTIONS.page)
  for (const f of ['references/labels.md', 'scripts/digest.mjs', 'scripts/chart.mjs', 'scripts/messages.mjs', 'scripts/model.mjs']) {
    await fs.access(path.join(chat, f))
  }
  for (const f of ['scripts/render.mjs', 'scripts/build.mjs']) await fs.access(path.join(page, f))
  // The page scripts import the chat view's grouping by relative path, so
  // the two folders must stay siblings under these names.
  const render = await fs.readFile(path.join(page, 'scripts', 'render.mjs'), 'utf8')
  assert.match(render, /hypaware-usage-by-task\/scripts\/model\.mjs/)
})

test('usage starts a recorded client on the bundled instructions, in a folder under HYP_HOME', async (t) => {
  const { ctx, deps, launches, home } = await fixture(t)
  assert.equal(await runUsage(['the last 14 days'], ctx, deps), 0)
  assert.equal(launches.length, 1)
  const { prompt, cwd } = launches[0]
  assert.ok(prompt.includes(JSON.stringify(USAGE_INSTRUCTIONS.chat)))
  assert.ok(!prompt.includes(JSON.stringify(USAGE_INSTRUCTIONS.page)))
  assert.ok(prompt.endsWith('the last 14 days'))
  // Not the caller's directory: setup runs this, and the session must not be
  // rooted wherever setup was typed.
  assert.equal(cwd, path.join(home, '.hyp', 'usage'))
  assert.ok((await fs.stat(cwd)).isDirectory())
})

test('usage --page starts the client on the page instructions', async (t) => {
  const { ctx, deps, launches } = await fixture(t)
  assert.equal(await runUsage(['--page'], ctx, deps), 0)
  assert.ok(launches[0].prompt.includes(JSON.stringify(USAGE_INSTRUCTIONS.page)))
  assert.doesNotMatch(launches[0].prompt, /Additional instructions/)
  assert.equal(usagePrompt({ page: true }), launches[0].prompt)
})

test('usage refuses with a repair when no recorded client can be started, and reports a failed spawn', async (t) => {
  const { ctx, deps, err, launches } = await fixture(t)
  assert.equal(await runUsage([], ctx, { ...deps, resolveLaunchers: async () => [] }), 1)
  assert.equal(launches.length, 0)
  assert.match(err.join(''), /hyp usage: no recorded client can be started/)
  assert.match(err.join(''), /hyp client attach/)
  assert.equal(await runUsage([], ctx, { ...deps, launchClient: async () => ({ ok: false, error: 'ENOENT' }) }), 1)
  assert.match(err.join(''), /could not start claude: ENOENT/)
})

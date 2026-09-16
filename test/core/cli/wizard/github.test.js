// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { temporaryDirectory } from '../../../helpers/temp_dir.js'
import { offerWizardGithub, loginWizardGithub, connectWizardGithub } from '../../../../src/core/cli/wizard/github.js'

function options() {
  let output = ''
  const stream = { write(/** @type {string} */ text) { output += text } }
  return { stdout: stream, stderr: stream, env: {}, interactive: true, output: () => output }
}

test('GitHub offer requires its own yes and declines EOF', async () => {
  const opts = options()
  assert.equal(await offerWizardGithub({ ...opts, confirm: async (q) => {
    assert.match(q.title, /AI sessions.*repositories, pull requests/)
    assert.equal(q.default, 'yes')
    assert.equal(q.eofValue, 'no')
    return 'yes'
  } }), 'yes')
  assert.equal(await offerWizardGithub({ ...opts, confirm: async () => 'no' }), 'no')
})

test('GitHub offer never asks on unattended or non-terminal runs', async () => {
  const opts = options()
  assert.equal(await offerWizardGithub(opts), 'no')
  assert.equal(await offerWizardGithub({ ...opts, interactive: false, confirm: async () => {
    assert.fail('unattended run asked for login')
  } }), 'no')
})

test('GitHub login invokes the existing command with browser opening enabled', async () => {
  const opts = options()
  let called = false
  await loginWizardGithub({ ...opts, ctx: { commands: { run: async (name, args) => {
    called = true
    assert.equal(name, 'github login')
    assert.deepEqual(args, [])
    return 0
  } } } })
  assert.equal(called, true)
  assert.equal(opts.output(), '')
})

for (const failure of ['nonzero', 'throw']) {
  test(`GitHub login ${failure} leaves a retry hint and does not block setup`, async () => {
    const opts = options()
    await loginWizardGithub({ ...opts, ctx: { commands: { run: async () => {
      if (failure === 'throw') throw new Error('fixture')
      return 1
    } } } })
    assert.match(opts.output(), /Setup will continue; run `hyp github login`/)
  })
}

test('closing GitHub connection preserves saved setup changes and restarts after login', async () => {
  const home = await temporaryDirectory('hyp-github-closing-')
  const configPath = path.join(home, 'config.json')
  const config = { version: 2, plugins: [{ name: '@hypaware/context-graph' }], query: { remotes: { team: { url: 'https://example.test' } } } }
  await fs.writeFile(configPath, JSON.stringify(config))
  const calls = []
  const result = await connectWizardGithub({ ...options(), configPath, restartDaemon: true,
    ctx: { commands: { run: async (name) => {
      calls.push(name)
      const saved = JSON.parse(await fs.readFile(configPath, 'utf8'))
      assert.deepEqual(saved.query, config.query)
      assert.equal(saved.plugins.filter((p) => p.name === '@hypaware/context-graph').length, 1)
      assert.equal(saved.plugins.filter((p) => p.name === '@hypaware/github').length, 1)
      return 0
    } } },
  })
  assert.deepEqual(calls, ['github login', 'daemon restart'])
  assert.deepEqual(result?.query, config.query)
})

test('closing GitHub connection does not log in when config cannot be saved', async () => {
  const home = await temporaryDirectory('hyp-github-closing-missing-')
  const opts = options()
  const result = await connectWizardGithub({ ...opts, configPath: path.join(home, 'missing.json'), restartDaemon: true,
    ctx: { commands: { run: async () => assert.fail('missing config started login') } },
  })
  assert.equal(result, undefined)
  assert.match(opts.output(), /Could not enable GitHub collection/)
})

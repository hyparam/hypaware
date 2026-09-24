// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'

test('test and smoke client environments discard inherited settings and history paths', () => {
  const inherited = { HOME: '/live', CODEX_HOME: '/live/codex', HYP_CONFIG: '/live/hyp.json', CLAUDE_CONFIG_DIR: '/live/claude', PI_CODING_AGENT_SESSION_DIR: '/live/pi', XDG_CONFIG_HOME: '/live/config', PATH: '/bin' }
  const env = isolatedClientEnv(inherited, '/fixture')
  assert.equal(env.HOME, '/fixture')
  assert.equal(env.USERPROFILE, '/fixture')
  assert.equal(env.CODEX_HOME, undefined)
  assert.equal(env.HYP_CONFIG, undefined)
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, undefined)
  assert.equal(env.XDG_CONFIG_HOME, path.join('/fixture', '.config'))
  assert.equal(env.PATH, '/bin')
  assert.equal(inherited.CODEX_HOME, '/live/codex')
})

test('smoke harness replaces inherited Codex home before importing the flow', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-smoke-isolation-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const harnessPath = fileURLToPath(new URL('../../hypaware-core/smoke/lib/harness.js', import.meta.url))
  const script = `
    import { runFlow } from ${JSON.stringify(harnessPath)}
    import os from 'node:os'
    const result = await runFlow('core_boot_noop')
    console.log(JSON.stringify({ tmpDir: result.tmpDir, home: os.homedir(), codex: process.env.CODEX_HOME }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: root, CODEX_HOME: path.join(root, 'live-codex'), HYP_CONFIG: path.join(root, 'live-config.json'), TMPDIR: root, TMP: root, TEMP: root },
  })
  assert.equal(result.status, 0, result.stderr)
  const state = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')
  assert.equal(state.home, path.join(state.tmpDir, 'home'))
  assert.equal(state.codex, undefined)
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('live-')), false)
})

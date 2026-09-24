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

test('core Claude detach stays inside isolated HOME despite inherited CLAUDE_HOME', async t => {
  const { detachClientFromDisk } = await import('../../src/core/config/client_detach_disk.js')
  const manifest = JSON.parse(await fs.readFile(new URL('../../hypaware-core/plugins-workspace/claude/hypaware.plugin.json', import.meta.url), 'utf8'))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-isolation-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const external = path.join(root, 'external-claude')
  const local = path.join(home, '.claude', 'settings.json')
  const fixture = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4388' }, _hypaware: { managed: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4388' } }, previous: { env: {} } } })
  await fs.mkdir(path.dirname(local), { recursive: true })
  await fs.mkdir(external)
  await fs.writeFile(local, fixture)
  await fs.writeFile(path.join(external, 'settings.json'), fixture)
  const result = await detachClientFromDisk({
    descriptor: { name: manifest.contributes.client.name, plugin: manifest.name, skillDir: manifest.contributes.client.skill_dir, attachProbe: manifest.contributes.client.attach_probe },
    env: isolatedClientEnv({ CLAUDE_HOME: external }, home), homeDir: home,
  })
  assert.equal(result.settingsPath, local)
  assert.equal(result.changed, true)
  assert.equal(await fs.readFile(path.join(external, 'settings.json'), 'utf8'), fixture)
  assert.equal(JSON.parse(await fs.readFile(local, 'utf8'))._hypaware, undefined)
})

test('isolation clears concrete generic client HOME overrides and preserves toolchain paths', () => {
  const env = isolatedClientEnv({ CLAUDE_HOME: '/external/claude', CODEX_HOME: '/external/codex', OPENCLAW_HOME: '/external/openclaw', HERMES_HOME: '/external/hermes', JAVA_HOME: '/tools/java' }, '/fixture')
  for (const key of ['CLAUDE_HOME', 'CODEX_HOME', 'OPENCLAW_HOME', 'HERMES_HOME']) assert.equal(env[key], undefined, key)
  assert.equal(env.JAVA_HOME, '/tools/java')
})

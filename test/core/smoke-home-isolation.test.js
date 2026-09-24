// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

test('smoke harness replaces inherited HOME and CODEX_HOME before activating a flow', async () => {
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-external-home-'))
  try {
    const codexHome = path.join(external, 'custom-codex')
    await fs.mkdir(codexHome)
    const sentinel = '# BEGIN hypaware codex provider\n[model_providers.hypaware]\nbase_url = "http://127.0.0.1:1"\n# END hypaware codex provider\n'
    const configPath = path.join(codexHome, 'config.toml')
    await fs.writeFile(configPath, sentinel)
    const harnessUrl = new URL('../../hypaware-core/smoke/lib/harness.js', import.meta.url).href
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runFlow } from ${JSON.stringify(harnessUrl)}
      const h = await runFlow('core_boot_noop')
      console.log(JSON.stringify({ root: h.tmpDir, home: process.env.HOME,
        codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR,
        config: process.env.HYP_CONFIG }))
      process.exit(0)
    `], { encoding: 'utf8', timeout: 30000, env: {
      ...process.env, HOME: external, USERPROFILE: external,
      CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: external, HYP_CONFIG: '/external/config.json',
    } })
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '{}')
    assert.equal(result.home, result.root)
    assert.equal(result.codex, path.join(result.root, '.codex'))
    assert.equal(result.claude, path.join(result.root, '.claude'))
    assert.notEqual(result.config, '/external/config.json')
    assert.equal(await fs.readFile(configPath, 'utf8'), sentinel)
    await fs.rm(result.root, { recursive: true, force: true })
  } finally { await fs.rm(external, { recursive: true, force: true }) }
})

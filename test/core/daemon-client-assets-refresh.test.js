// @ts-check

// Ordinary daemon boots do not install client assets.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { defaultConfigPath } from '../../src/core/config/schema.js'
import { runDaemon } from '../../src/core/daemon/runtime.js'
import {
  clientAssetStateRoot,
  digestClientAsset,
  readClientAssetLedger,
  writeClientAssetLedger,
} from '../../src/core/runtime/client_asset_ledger.js'

test('daemon boot leaves stale, edited, and missing skills and their ledger unchanged', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-refresh-home-'))
  const hypHome = path.join(home, '.hyp')
  const env = { ...process.env, HOME: home, HYP_HOME: hypHome }
  const stateRoot = clientAssetStateRoot(env, home)
  let handle
  try {
    const skillsDir = path.join(home, '.claude', 'skills')
    const stale = path.join(skillsDir, 'hypaware-query')
    const edited = path.join(skillsDir, 'hypaware-reference')
    const never = path.join(skillsDir, 'hypaware-privacy')
    await fs.mkdir(stale, { recursive: true })
    await fs.mkdir(edited, { recursive: true })
    await fs.writeFile(path.join(stale, 'SKILL.md'), 'stale copy from an older package', 'utf8')
    await fs.writeFile(path.join(edited, 'SKILL.md'), 'the user rewrote this one', 'utf8')

    // The ledger says both are ours. The stale one's digest matches what is
    // on disk (we wrote it, and nobody touched it since); the edited one's
    // record names bytes that are no longer there.
    const staleDigest = await digestClientAsset(stale)
    assert.ok(staleDigest)
    await writeClientAssetLedger(stateRoot, [
      { kind: 'skill', name: 'hypaware-query', client: 'claude', dest: stale, digest: staleDigest },
      { kind: 'skill', name: 'hypaware-reference', client: 'claude', dest: edited, digest: 'sha256-of-what-we-installed' },
    ])

    // The bundled gateway plus the claude adapter, so the claude plugin
    // activates and registers its skills from inside the package. Local
    // config only: no central layer, so the org reconciler stays a no-op and
    // no attach action should install the skills.
    const configPath = defaultConfigPath(hypHome)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      plugins: [
        {
          name: '@hypaware/ai-gateway',
          config: {
            listen: '127.0.0.1:0',
            upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/' }],
          },
        },
        { name: '@hypaware/claude' },
      ],
    }) + '\n')

    handle = await runDaemon({
      hypHome,
      configPath,
      env,
      runId: 'client-assets-refresh-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })

    assert.equal(handle.snapshot().state, 'healthy', 'exercise a complete daemon boot')
    assert.ok(handle.runtime.skills.list().some((skill) => skill.name === 'hypaware-query'))
    assert.equal(await fs.readFile(path.join(stale, 'SKILL.md'), 'utf8'), 'stale copy from an older package')
    assert.equal(
      await fs.readFile(path.join(edited, 'SKILL.md'), 'utf8'),
      'the user rewrote this one',
      'an edited copy is left alone'
    )
    await assert.rejects(fs.stat(never), 'a skill with no ledger record is not installed on startup')

    const ledger = await readClientAssetLedger(stateRoot)
    const record = ledger.find((r) => r.dest === stale)
    assert.equal(record?.digest, staleDigest, 'an ordinary boot does not rewrite the ledger')
    assert.equal(ledger.find((r) => r.dest === edited)?.digest, 'sha256-of-what-we-installed')
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(home, { recursive: true, force: true })
  }
})

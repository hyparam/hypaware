// @ts-check

// The boot-time refresh through the real daemon (LLP 0397 #refresh-at-boot):
// a home whose installed copy of a bundled claude skill is stale gets the
// package's current bytes when the daemon boots, a copy the user edited is
// left alone, and a skill with no ledger record is not installed. The
// function-level cases are in client-assets-refresh.test.js; this proves the
// daemon threads the right inputs and actually runs it.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultConfigPath } from '../../src/core/config/schema.js'
import { runDaemon } from '../../src/core/daemon/runtime.js'
import {
  clientAssetStateRoot,
  digestClientAsset,
  readClientAssetLedger,
  writeClientAssetLedger,
} from '../../src/core/runtime/client_asset_ledger.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLAUDE_SKILLS = path.join(REPO, 'hypaware-core', 'plugins-workspace', 'claude', 'skills')

/** @param {() => boolean} predicate @param {number} [timeoutMs] */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timed out')
}

test('daemon boot refreshes a stale installed skill, keeps an edited one, and installs nothing new', async () => {
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
    // the refresh is the only thing that can touch the copies.
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

    const current = await digestClientAsset(path.join(CLAUDE_SKILLS, 'hypaware-query'))
    assert.ok(current)
    /** @type {string | undefined} */
    let onDisk
    await waitFor(() => {
      void digestClientAsset(stale).then((d) => { onDisk = d })
      return onDisk === current
    })
    assert.equal(onDisk, current, 'the stale copy now holds the package bytes')
    assert.equal(
      await fs.readFile(path.join(edited, 'SKILL.md'), 'utf8'),
      'the user rewrote this one',
      'an edited copy is left alone'
    )
    await assert.rejects(fs.stat(never), 'a skill with no ledger record is not installed by a refresh')

    const ledger = await readClientAssetLedger(stateRoot)
    const record = ledger.find((r) => r.dest === stale)
    assert.equal(record?.digest, current, 'the ledger digest follows the refreshed copy')
    assert.equal(ledger.find((r) => r.dest === edited)?.digest, 'sha256-of-what-we-installed')
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a boot that only heals a stale record says so in daemon.log', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-heal-home-'))
  const hypHome = path.join(home, '.hyp')
  const env = { ...process.env, HOME: home, HYP_HOME: hypHome }
  const stateRoot = clientAssetStateRoot(env, home)
  let handle
  try {
    const dest = path.join(home, '.claude', 'skills', 'hypaware-query')
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.cp(path.join(CLAUDE_SKILLS, 'hypaware-query'), dest, { recursive: true })

    // The state a pass killed between the swap and its one ledger write
    // leaves: the copy already holds the package's current bytes, the record
    // still names the bytes that copy replaced. Nothing is rewritten on the
    // boot that repairs it, so `refreshed` and `skipped` are both empty and
    // the summary would be silent about the ledger it just rewrote.
    await writeClientAssetLedger(stateRoot, [
      { kind: 'skill', name: 'hypaware-query', client: 'claude', dest, digest: 'sha256-of-what-we-installed' },
    ])

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
      runId: 'client-assets-heal-test',
      tickIntervalMs: 0,
      installSignalHandlers: false,
    })

    const current = await digestClientAsset(dest)
    assert.ok(current)
    /** @type {string | undefined} */
    let recorded
    await waitFor(() => {
      void readClientAssetLedger(stateRoot).then((l) => { recorded = l[0]?.digest })
      return recorded === current
    })
    assert.equal(recorded, current, 'the stale record is healed to the bytes already on disk')

    const logPath = path.join(stateRoot, 'logs', 'daemon.log')
    /** @type {Record<string, unknown> | undefined} */
    let line
    await waitFor(() => {
      const text = fs.readFile(logPath, 'utf8')
      void text.then((t) => {
        line = t.split('\n').filter(Boolean)
          .map((l) => JSON.parse(l))
          .find((r) => r.event === 'daemon.client_assets_refreshed')
      })
      return line !== undefined
    })
    assert.ok(line, 'the heal-only boot writes a daemon.log line rather than passing in silence')
    assert.equal(line.healed, 1)
    assert.deepEqual(line.refreshed, [])
    assert.deepEqual(line.skipped, [])
  } finally {
    if (handle) {
      await handle.stop()
      await handle.done
    }
    await fs.rm(home, { recursive: true, force: true })
  }
})

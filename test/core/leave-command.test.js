// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { centralSeedPath, resolveCentralLayerPath } from '../../src/core/config/apply.js'

/**
 * `hyp leave` — the level-3 exit verb (LLP 0063 §prerequisites): removes the
 * central config layer, reverses org-driven attaches via the one core undo,
 * and drops the forward identity — while leaving the query-session store, the
 * user-owned local layer, and the daemon service untouched.
 */

/** @param {string} home */
function stateRootFor(home) {
  return path.join(home, 'hypaware')
}

function makeBuf() {
  let value = ''
  return {
    write(/** @type {unknown} */ chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

async function makeDispatchOpts() {
  // HOME is sandboxed too: leave inspects the daemon service and client
  // settings under HOME, and the test must never touch the real ones.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-leave-test-'))
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {any} */
  const stdin = { isTTY: true }
  return {
    home,
    stateRoot: stateRootFor(home),
    stdout,
    stderr,
    opts: {
      stdout,
      stderr,
      stdin,
      env: { ...process.env, HOME: home, HYP_HOME: home, HYP_CONFIG: '', CLAUDE_HOME: '' },
    },
  }
}

test('leave when not connected is a friendly no-op', async () => {
  const { stdout, opts } = await makeDispatchOpts()
  const code = await dispatch(['leave'], opts)
  assert.equal(code, 0)
  assert.match(stdout.text(), /not connected to a central server/)
})

test('leave after join removes the seed and reports the server', async () => {
  const { stateRoot, stdout, opts } = await makeDispatchOpts()
  assert.equal(
    await dispatch(['join', 'https://central.example', 'policy-token-1', '--no-daemon'], opts),
    0
  )
  await fs.stat(centralSeedPath(stateRoot))

  const code = await dispatch(['leave'], opts)
  assert.equal(code, 0, stdout.text())

  assert.match(stdout.text(), /leaving https:\/\/central\.example/)
  assert.match(stdout.text(), /removed the central config layer/)
  assert.match(stdout.text(), /left https:\/\/central\.example/)
  assert.match(stdout.text(), /kept: query sessions/)
  await assert.rejects(fs.stat(centralSeedPath(stateRoot)))
  assert.equal(resolveCentralLayerPath({ stateRoot }), null)
})

test('leave clears an applied central slot, not just the seed', async () => {
  const { stateRoot, stdout, opts } = await makeDispatchOpts()
  const controlDir = path.join(stateRoot, 'config-control')
  await fs.mkdir(controlDir, { recursive: true })

  // A joined host past its first apply: the seed is retired and the central
  // layer lives in an active slot (LLP 0031 physical layout).
  const applied = {
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    sinks: {
      central: {
        plugin: '@hypaware/central',
        config: { url: 'https://central.example', identity: {} },
      },
    },
  }
  await fs.writeFile(path.join(controlDir, 'config.a.json'), JSON.stringify(applied, null, 2) + '\n')
  await fs.writeFile(path.join(controlDir, 'config.a.etag'), 'etag-1\n')
  await fs.symlink('config.a.json', path.join(controlDir, 'active'))

  const code = await dispatch(['leave'], opts)
  assert.equal(code, 0, stdout.text())

  assert.equal(resolveCentralLayerPath({ stateRoot }), null)
  await assert.rejects(fs.lstat(path.join(controlDir, 'active')))
  await assert.rejects(fs.stat(path.join(controlDir, 'config.a.json')))
})

test('leave reverses org-driven attaches and drops the forward identity', async () => {
  const { home, stateRoot, stdout, opts } = await makeDispatchOpts()
  assert.equal(
    await dispatch(['join', 'https://central.example', 'policy-token-1', '--no-daemon'], opts),
    0
  )

  // A centrally-attached claude: settings carry the self-describing undo
  // record attach() writes, and the reconciler recorded a `done` marker.
  const settingsPath = path.join(home, '.claude', 'settings.json')
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(
    settingsPath,
    JSON.stringify(
      {
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4388' },
        _hypaware: {
          managed: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4388' }, hooks: [] },
        },
      },
      null,
      2
    ) + '\n'
  )
  const controlDir = path.join(stateRoot, 'config-control')
  await fs.writeFile(
    path.join(controlDir, 'client-actions.json'),
    JSON.stringify(
      {
        attach: {
          claude: { status: 'done', request_key: 'claude' },
          // A failed marker never applied an effect: leave just drops it.
          codex: { status: 'failed', request_key: 'codex', reason: 'boom', attempts: 1 },
        },
        // Backfill is run-once by design: its marker survives leave.
        backfill: { 'claude:default': { status: 'done', request_key: 'claude:default' } },
      },
      null,
      2
    ) + '\n'
  )

  // The forward identity minted at bootstrap/login, at the default path.
  const identityPath = path.join(stateRoot, 'plugins', '@hypaware/central', 'identity.json')
  await fs.mkdir(path.dirname(identityPath), { recursive: true })
  await fs.writeFile(
    identityPath,
    JSON.stringify({ jwt: 'x', expires_at: 1, gateway_id: 'gw-1' }) + '\n'
  )

  const code = await dispatch(['leave'], opts)
  assert.equal(code, 0, stdout.text())

  // The org-driven attach is reversed on disk: marker key stripped, managed
  // env removed (no prior value to restore).
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
  assert.equal('_hypaware' in settings, false)
  assert.equal(settings.env?.ANTHROPIC_BASE_URL, undefined)

  // Attach markers are gone (done reversed, failed dropped); backfill stays.
  const markers = JSON.parse(await fs.readFile(path.join(controlDir, 'client-actions.json'), 'utf8'))
  assert.equal(markers.attach, undefined)
  assert.equal(markers.backfill['claude:default'].status, 'done')

  // The credential is gone.
  await assert.rejects(fs.stat(identityPath))
  assert.match(stdout.text(), /removed the forward identity/)
})

test('leave never edits the local layer, and says so when a local central sink exists', async () => {
  const { home, stdout, opts } = await makeDispatchOpts()
  const localPath = path.join(home, 'hypaware-config.json')
  const localConfig = {
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    sinks: {
      central: {
        plugin: '@hypaware/central',
        config: { url: 'https://self-hosted.example', identity: {} },
      },
    },
  }
  await fs.writeFile(localPath, JSON.stringify(localConfig, null, 2) + '\n')

  // Not fleet-enrolled (no central layer): leave is a no-op but points at
  // the hand-authored sink instead of leaving the user mystified.
  const code = await dispatch(['leave'], opts)
  assert.equal(code, 0)
  assert.match(stdout.text(), /not connected to a central server/)
  assert.match(stdout.text(), /local config defines a '@hypaware\/central' sink \('central'\)/)
  assert.match(stdout.text(), /never edits the local layer/)

  // Byte-for-byte untouched (#111 doctrine applies to leave too).
  const after = JSON.parse(await fs.readFile(localPath, 'utf8'))
  assert.deepEqual(after, localConfig)
})

test('leave after join also warns about a local central sink that keeps forwarding', async () => {
  const { home, stdout, opts } = await makeDispatchOpts()
  const localPath = path.join(home, 'hypaware-config.json')
  await fs.writeFile(
    localPath,
    JSON.stringify(
      {
        version: 2,
        plugins: [{ name: '@hypaware/central' }],
        sinks: {
          mirror: {
            plugin: '@hypaware/central',
            config: { url: 'https://self-hosted.example', identity: {} },
          },
        },
      },
      null,
      2
    ) + '\n'
  )
  assert.equal(
    await dispatch(['join', 'https://central.example', 'policy-token-1', '--no-daemon'], opts),
    0
  )

  const code = await dispatch(['leave'], opts)
  assert.equal(code, 0, stdout.text())
  assert.match(stdout.text(), /left https:\/\/central\.example/)
  assert.match(stdout.text(), /local config defines a '@hypaware\/central' sink \('mirror'\) targeting https:\/\/self-hosted\.example/)
})

test('leave is idempotent: a second leave is the not-connected no-op', async () => {
  const { opts, stdout } = await makeDispatchOpts()
  assert.equal(
    await dispatch(['join', 'https://central.example', 'policy-token-1', '--no-daemon'], opts),
    0
  )
  assert.equal(await dispatch(['leave'], opts), 0)
  assert.equal(await dispatch(['leave'], opts), 0)
  assert.match(stdout.text(), /not connected to a central server/)
})

test('leave help exits 0 and rejects unknown arguments', async () => {
  {
    const { stdout, opts } = await makeDispatchOpts()
    assert.equal(await dispatch(['leave', '--help'], opts), 0)
    assert.match(stdout.text(), /usage: hyp leave/)
    assert.match(stdout.text(), /Keeps query sessions/)
  }
  {
    const { stderr, opts } = await makeDispatchOpts()
    assert.equal(await dispatch(['leave', '--force'], opts), 2)
    assert.match(stderr.text(), /unknown argument: --force/)
  }
})

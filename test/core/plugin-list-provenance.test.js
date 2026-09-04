// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPluginList } from '../../src/core/commands/plugin.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/**
 * @param {string} name
 * @param {string} version
 */
function activePlugin(name, version) {
  return /** @type {any} */ ({
    name,
    version,
    rootDir: `/fixtures/${name}`,
    manifest: { schema_version: 1, name, version, hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './index.js' },
  })
}

// `hyp plugin list` printed "(bundled)" for every active plugin, so an
// installed copy running in a bundled name's place (or any active installed
// plugin) was labelled as shipped code. Provenance now comes from the install
// lock, the same source the `--json` branch already used for `source`.
test('plugin list labels an active plugin as installed when the install lock holds it', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-plugin-list-'))
  try {
    const stateDir = path.join(hypHome, 'hypaware')
    await fs.mkdir(stateDir, { recursive: true })
    const installDir = path.join(stateDir, 'plugins', '@third-party', 'echo')
    await writeLock(stateDir, {
      schema_version: 1,
      plugins: {
        '@third-party/echo': {
          name: '@third-party/echo',
          version: '0.2.0',
          source: { kind: 'local-dir', raw: installDir, path: installDir },
          install_dir: installDir,
          content_hash: 'a'.repeat(64),
          manifest_hash: 'b'.repeat(64),
          installed_at: '2026-09-01T00:00:00.000Z',
        },
      },
    })
    const ctx = /** @type {any} */ ({
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      stdout: makeBuf(),
      stderr: makeBuf(),
      plugins: [activePlugin('@hypaware/claude', '1.0.0'), activePlugin('@third-party/echo', '0.2.0')],
    })

    assert.equal(await runPluginList([], ctx), 0)
    const text = ctx.stdout.text()
    assert.match(text, /^  @hypaware\/claude@1\.0\.0  \(bundled\)$/m)
    assert.match(text, /^  @third-party\/echo@0\.2\.0  \(installed\)$/m)
    assert.equal(text.includes('@third-party/echo@0.2.0  (bundled)'), false)

    // The JSON branch says the same thing through `source`.
    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const byName = new Map(json.plugins.map((/** @type {{ name: string }} */ p) => [p.name, p]))
    assert.equal(byName.get('@hypaware/claude')?.source, 'bundled')
    assert.equal(byName.get('@third-party/echo')?.source, 'installed')
    assert.equal(byName.get('@third-party/echo')?.active, true)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

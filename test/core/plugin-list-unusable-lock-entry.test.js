// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPluginList, runPluginOutdated } from '../../src/core/commands/plugin.js'
import { pluginLockPath } from '../../src/core/plugin_install/paths.js'

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/**
 * Stage a hand-edited `plugin-lock.json` holding one healthy entry plus every
 * row shape that is not a readable install record, and return the HYP_HOME.
 *
 * @param {string} prefix
 */
async function stageLock(prefix) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const stateDir = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateDir, { recursive: true })
  const installDir = path.join(stateDir, 'plugins', '@third-party', 'echo')
  await fs.writeFile(pluginLockPath(stateDir), JSON.stringify({
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
        update: { checked_at: '2026-09-02T00:00:00.000Z', latest_version: '0.3.0', available: true },
      },
      '@third-party/nulled': null,
      '@third-party/stringed': 'not-an-entry',
      '@third-party/numbered': 7,
      '@third-party/booled': true,
      '@third-party/arrayed': [],
      '@third-party/no-install-dir': { name: '@third-party/no-install-dir', version: '0.1.0' },
      '@third-party/no-name': { version: '0.1.0', install_dir: installDir },
      '@third-party/numeric-name': { name: 7, version: '0.1.0', install_dir: installDir },
    },
  }, null, 2) + '\n')
  return hypHome
}

const UNUSABLE = [
  '@third-party/arrayed',
  '@third-party/booled',
  '@third-party/no-install-dir',
  '@third-party/no-name',
  '@third-party/nulled',
  '@third-party/numbered',
  '@third-party/numeric-name',
  '@third-party/stringed',
]

// `listInstalledPlugins` handed the raw lock values to `plugin list`, which
// read `.name` off each one. A row hand-edited to `null` therefore exited 1 on
// "Cannot read properties of null (reading 'name')" and listed nothing at all,
// the healthy entries included: one bad row took out the whole listing, on a
// command `hyp status` names as the repair surface (issue #1966).
test('plugin list lists the healthy entry and marks every unusable lock row', async () => {
  const hypHome = await stageLock('hyp-plugin-list-unusable-')
  try {
    const ctx = /** @type {any} */ ({
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      stdout: makeBuf(),
      stderr: makeBuf(),
      plugins: [],
    })

    assert.equal(await runPluginList([], ctx), 0)
    const text = ctx.stdout.text()
    // The point of the fix: the healthy row is actually printed.
    assert.match(text, /^ {2}@third-party\/echo@0\.2\.0 {2}\(update available\)$/m)
    for (const name of UNUSABLE) {
      assert.match(text, new RegExp(`^ {2}${name} {2}\\(unreadable lock entry; hyp plugin remove ${name}\\)$`, 'm'))
    }

    // The JSON branch says the same thing, and never reports a fabricated name.
    ctx.stdout = makeBuf()
    assert.equal(await runPluginList(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    const byName = new Map(json.plugins.map((/** @type {{ name: string }} */ p) => [p.name, p]))
    assert.equal(byName.get('@third-party/echo')?.version, '0.2.0')
    assert.equal(byName.get('@third-party/echo')?.lock_entry_invalid, undefined)
    for (const name of UNUSABLE) {
      assert.equal(byName.get(name)?.lock_entry_invalid, true, name)
      assert.equal(byName.get(name)?.version, '', name)
    }
    // No row invents an identity: the lock key carries every one of them.
    for (const row of json.plugins) assert.equal(typeof row.name === 'string' && row.name.length > 0, true)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The same raw values reached `plugin outdated`, which read `.update` off them
// and died one field later. It has no version to compare for a row it cannot
// read, so it skips them; `plugin list` and `hyp status` are the two surfaces
// that name them.
test('plugin outdated reports the healthy entry instead of dying on an unusable row', async () => {
  const hypHome = await stageLock('hyp-plugin-outdated-unusable-')
  try {
    const ctx = /** @type {any} */ ({
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      stdout: makeBuf(),
      stderr: makeBuf(),
      plugins: [],
    })
    assert.equal(await runPluginOutdated(['--json'], ctx), 0)
    const json = JSON.parse(ctx.stdout.text())
    assert.deepEqual(json.plugins.map((/** @type {{ name: string }} */ p) => p.name), ['@third-party/echo'])
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

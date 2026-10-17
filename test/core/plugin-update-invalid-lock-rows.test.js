// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runPluginUpdate } from '../../src/core/commands/plugin.js'
import { pluginLockPath } from '../../src/core/plugin_install/paths.js'

function makeBuf() {
  let value = ''
  return { write(/** @type {string} */ chunk) { value += String(chunk); return true }, text() { return value } }
}

/**
 * A healthy local-dir lock row for `name`.
 *
 * @param {string} name
 * @param {string} installDir
 */
function healthy(name, installDir) {
  return {
    name,
    version: '0.2.0',
    source: { kind: 'local-dir', raw: installDir, path: installDir },
    install_dir: installDir,
    content_hash: 'a'.repeat(64),
    manifest_hash: 'b'.repeat(64),
    installed_at: '2026-09-01T00:00:00.000Z',
    update: { checked_at: '2026-09-02T00:00:00.000Z', latest_version: '0.3.0', available: true },
  }
}

/**
 * The 1-based line of `text` on which the plugins key `key` is written,
 * found from the text itself so the test does not share the scanner's logic.
 *
 * @param {string} text
 * @param {string} key
 */
function lineOfKey(text, key) {
  const found = text.split('\n').findIndex((l) => l.trimStart().startsWith(`${JSON.stringify(key)}:`))
  assert.notEqual(found, -1, `key ${JSON.stringify(key)} is in the file`)
  return found + 1
}

/**
 * Stage `plugins` as a hand-edited lock under a fresh HYP_HOME and run the
 * no-target `hyp plugin update` against it.
 *
 * @param {string} prefix
 * @param {(installDir: string) => Record<string, unknown>} build
 * @param {(text: string) => string} [edit] hand edit of the written text
 */
async function runBulkUpdate(prefix, build, edit = (text) => text) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const stateDir = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateDir, { recursive: true })
  const installDir = path.join(stateDir, 'plugins', 'echo')
  const lockPath = pluginLockPath(stateDir)
  const plugins = build(installDir)
  const text = edit(JSON.stringify({ schema_version: 1, plugins }, null, 2) + '\n')
  await fs.writeFile(lockPath, text)
  const ctx = /** @type {any} */ ({
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    stdout: makeBuf(),
    stderr: makeBuf(),
    plugins: [],
  })
  const code = await runPluginUpdate([], ctx)
  const afterText = await fs.readFile(lockPath, 'utf8')
  const after = JSON.parse(afterText)
  // The line in the file as the command left it, which is the one an
  // operator opens: writeLock sorts the keys.
  /** @param {string} key */
  const skipped = (key) => `hyp plugin update: skipped the entry on line ${lineOfKey(afterText, key)} of ${lockPath}`
  return { hypHome, lockPath, plugins, text, afterText, skipped, code, stdout: ctx.stdout.text(), stderr: ctx.stderr.text(), after }
}

// The bulk refresh read `.name` off every row and upserted the result under
// that name: a null row threw before anything was written, and a row with no
// `name` was written back a second time under the key "undefined" (#2120).
test('plugin update refreshes the valid row and reports the invalid one by line', async () => {
  const run = await runBulkUpdate('hyp-plugin-update-one-bad-', (dir) => ({
    '@third-party/broken': { version: '0.1.0', install_dir: dir },
    '@third-party/echo': healthy('@third-party/echo', dir),
  }))
  try {
    assert.equal(run.code, 0)
    assert.equal(run.stdout, 'refreshed update state for 1 plugin(s)\n')
    assert.equal(run.stderr, `${run.skipped('@third-party/broken')}: no usable name\n`)
    assert.deepEqual(Object.keys(run.after.plugins).sort(), ['@third-party/broken', '@third-party/echo'])
    assert.deepEqual(run.after.plugins['@third-party/broken'], run.plugins['@third-party/broken'])
    const echo = run.after.plugins['@third-party/echo']
    assert.equal(echo.update.available, false)
    assert.notEqual(echo.update.checked_at, '2026-09-02T00:00:00.000Z')
    assert.equal(Object.hasOwn(run.after.plugins, 'undefined'), false)
  } finally {
    await fs.rm(run.hypHome, { recursive: true, force: true })
  }
})

test('plugin update over a mixed lock keeps every key and every invalid value', async () => {
  const run = await runBulkUpdate('hyp-plugin-update-mixed-', (dir) => ({
    '@third-party/echo': healthy('@third-party/echo', dir),
    '@third-party/nulled': null,
    '@third-party/stringed': 'not-an-entry',
    '@third-party/numbered': 7,
    '@third-party/no-name': { version: '0.1.0', install_dir: dir },
    '@third-party/no-source': { name: '@third-party/no-source', version: '0.1.0', install_dir: dir },
    '@third-party/mismatch': healthy('@third-party/other', dir),
    '@third-party/foxtrot': healthy('@third-party/foxtrot', dir),
  }))
  try {
    assert.equal(run.code, 0)
    assert.equal(run.stdout, 'refreshed update state for 2 plugin(s)\n')
    assert.deepEqual(run.stderr.split('\n').filter(Boolean), [
      `${run.skipped('@third-party/nulled')}: not an object`,
      `${run.skipped('@third-party/stringed')}: not an object`,
      `${run.skipped('@third-party/numbered')}: not an object`,
      `${run.skipped('@third-party/no-name')}: no usable name`,
      `${run.skipped('@third-party/no-source')}: no usable source`,
      `${run.skipped('@third-party/mismatch')}: its name does not match its key`,
    ])
    assert.deepEqual(Object.keys(run.after.plugins).sort(), Object.keys(run.plugins).sort())
    for (const key of ['@third-party/nulled', '@third-party/stringed', '@third-party/numbered',
      '@third-party/no-name', '@third-party/no-source', '@third-party/mismatch']) {
      assert.deepEqual(run.after.plugins[key], run.plugins[key], key)
    }
    for (const key of ['@third-party/echo', '@third-party/foxtrot']) {
      assert.equal(run.after.plugins[key].update.available, false, key)
    }
    assert.equal(Object.hasOwn(run.after.plugins, 'undefined'), false)
    assert.equal(Object.hasOwn(run.after.plugins, '@third-party/other'), false)
  } finally {
    await fs.rm(run.hypHome, { recursive: true, force: true })
  }
})

// Object.keys lists integer-like keys first, so a position taken from it would
// name the healthy row above a malformed "42" (#2115 review, same flaw here).
test('plugin update names a skipped integer-like key by its own line', async () => {
  const run = await runBulkUpdate('hyp-plugin-update-numeric-', (dir) => ({
    '@third-party/echo': healthy('@third-party/echo', dir),
  }), (text) => text.replace(/\n  \}\n\}\n$/, ',\n    "42": null\n  }\n}\n'))
  try {
    assert.ok(lineOfKey(run.text, '42') > lineOfKey(run.text, '@third-party/echo'))
    assert.equal(run.code, 0)
    assert.equal(run.stdout, 'refreshed update state for 1 plugin(s)\n')
    assert.equal(run.stderr, `${run.skipped('42')}: not an object\n`)
    assert.equal(run.after.plugins['42'], null)
    assert.equal(run.after.plugins['@third-party/echo'].update.available, false)
  } finally {
    await fs.rm(run.hypHome, { recursive: true, force: true })
  }
})

// A line read before the write named another row once writeLock sorted the
// keys: "zhealthy" then "abroken" reported line 2, which after the write held
// "zhealthy" (#2679 review). The reported line is checked in the final file.
test('plugin update names a skipped row by its line in the file it leaves behind', async () => {
  const run = await runBulkUpdate('hyp-plugin-update-resorted-', (dir) => ({
    zhealthy: healthy('zhealthy', dir),
    abroken: null,
  }))
  try {
    assert.ok(lineOfKey(run.text, 'abroken') > lineOfKey(run.text, 'zhealthy'))
    assert.ok(lineOfKey(run.afterText, 'abroken') < lineOfKey(run.afterText, 'zhealthy'))
    assert.equal(run.code, 0)
    assert.equal(run.stderr, `${run.skipped('abroken')}: not an object\n`)
    const line = Number(/line (\d+)/.exec(run.stderr)?.[1])
    assert.match(run.afterText.split('\n')[line - 1], /^\s*"abroken": null,?$/)
  } finally {
    await fs.rm(run.hypHome, { recursive: true, force: true })
  }
})

// An empty key with an empty name passed the key/name match and was refreshed
// and counted, though partitionEntries already rejects it (#2679 review).
test('plugin update skips an empty key whose name is empty', async () => {
  const run = await runBulkUpdate('hyp-plugin-update-empty-key-', (dir) => ({
    '': healthy('', dir),
    '@third-party/echo': healthy('@third-party/echo', dir),
  }))
  try {
    assert.equal(run.code, 0)
    assert.equal(run.stdout, 'refreshed update state for 1 plugin(s)\n')
    assert.equal(run.stderr, `${run.skipped('')}: no usable name\n`)
    assert.deepEqual(run.after.plugins[''], run.plugins[''])
  } finally {
    await fs.rm(run.hypHome, { recursive: true, force: true })
  }
})

/**
 * Stage a lock file `text` and run the bulk update, returning the result and
 * the file's bytes afterwards.
 *
 * @param {string} prefix
 * @param {string} text
 * @param {number} [mode]
 */
async function runOnLockText(prefix, text, mode) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const stateDir = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateDir, { recursive: true })
  const lockPath = pluginLockPath(stateDir)
  await fs.writeFile(lockPath, text)
  if (mode !== undefined) await fs.chmod(lockPath, mode)
  const ctx = /** @type {any} */ ({
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    stdout: makeBuf(),
    stderr: makeBuf(),
    plugins: [],
  })
  const code = await runPluginUpdate([], ctx)
  if (mode !== undefined) await fs.chmod(lockPath, 0o600)
  const after = await fs.readFile(lockPath, 'utf8')
  return { hypHome, code, stdout: ctx.stdout.text(), stderr: ctx.stderr.text(), after }
}

// loadLock reads an unreadable lock as empty, and the bulk refresh then wrote
// that empty lock over the file with exit 0 (#2679 review, older than #2120).
test('plugin update leaves an unparseable lock alone and exits 1', async () => {
  const text = '{"schema_version": 1, "plugins": {"@third-party/echo": {'
  const run = await runOnLockText('hyp-plugin-update-bad-json-', text)
  try {
    assert.equal(run.code, 1)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /^hyp plugin update: plugin-lock\.json is not valid JSON/)
    assert.equal(run.after, text)
  } finally {
    await fs.rm(run.hypHome, { recursive: true, force: true })
  }
})

test('plugin update leaves an unreadable lock alone and exits 1', { skip: process.getuid?.() === 0 && 'root reads a mode-000 file' }, async () => {
  const text = JSON.stringify({ schema_version: 1, plugins: { '@third-party/echo': healthy('@third-party/echo', '/x') } }, null, 2) + '\n'
  const run = await runOnLockText('hyp-plugin-update-eacces-', text, 0o000)
  try {
    assert.equal(run.code, 1)
    assert.match(run.stderr, /^hyp plugin update: .*EACCES/)
    assert.equal(run.after, text)
  } finally {
    await fs.rm(run.hypHome, { recursive: true, force: true })
  }
})

test('plugin update over a lock with no valid row refreshes nothing and changes nothing', async () => {
  const run = await runBulkUpdate('hyp-plugin-update-all-bad-', (dir) => ({
    '@third-party/nulled': null,
    '@third-party/no-name': { version: '0.1.0', install_dir: dir },
  }))
  try {
    assert.equal(run.code, 0)
    assert.equal(run.stdout, 'refreshed update state for 0 plugin(s)\n')
    assert.equal(run.stderr.split('\n').filter(Boolean).length, 2)
    assert.deepEqual(run.after, { schema_version: 1, plugins: run.plugins })
  } finally {
    await fs.rm(run.hypHome, { recursive: true, force: true })
  }
})

// @ts-check

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  HANDOFF_ENV,
  NO_HANDOFF_ENV,
  SELF_BIN_PATH,
  handoffTarget,
  liveEntrypoint,
  readEntrypoint,
} from '../../src/core/runtime/entrypoint.js'

const BIN = fileURLToPath(new URL('../../bin/hypaware.js', import.meta.url))

/** @param {(dir: string) => Promise<void> | void} fn */
async function withTemp(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-entrypoint-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A stand-in owner CLI: records its argv and the hand-off marker to `out`,
 * echoes stdin, and exits with `code`.
 *
 * @param {string} dir
 * @param {number} code
 * @returns {{ bin: string, out: string }}
 */
function fakeOwner(dir, code) {
  const bin = path.join(dir, 'owner', 'bin', 'hypaware.js')
  const out = path.join(dir, 'owner-out.json')
  mkdirSync(path.dirname(bin), { recursive: true })
  writeFileSync(bin, `import fs from 'node:fs'
const stdin = fs.readFileSync(0, 'utf8')
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), handoff: process.env.${HANDOFF_ENV}, stdin }))
process.exit(${code})
`)
  return { bin, out }
}

/**
 * Write the local config with `entrypoint` set (or absent), plus a key the
 * claim and release must leave alone.
 *
 * @param {string} home
 * @param {unknown} [entrypoint]
 */
function writeConfig(home, entrypoint) {
  mkdirSync(home, { recursive: true })
  writeFileSync(configPath(home), JSON.stringify({ version: 2, auto_update: false, ...(entrypoint === undefined ? {} : { entrypoint }) }))
}

/** @param {string} home */
function configPath(home) {
  return path.join(home, 'hypaware-config.json')
}

/** @param {string} home */
function envFor(home) {
  return { ...process.env, HYP_HOME: home, [HANDOFF_ENV]: '', [NO_HANDOFF_ENV]: '' }
}

test('no config, a malformed config, no key, or a relative bin reads as no entry point', async () => {
  await withTemp((home) => {
    const env = envFor(home)
    assert.equal(readEntrypoint(env), undefined)
    writeFileSync(configPath(home), '{not json')
    assert.equal(readEntrypoint(env), undefined)
    writeConfig(home)
    assert.equal(readEntrypoint(env), undefined)
    writeConfig(home, { bin: 'relative/hypaware.js' })
    assert.equal(readEntrypoint(env), undefined)
    assert.equal(handoffTarget(['status'], env), undefined)
  })
})

test('the entry point is read from the config the invocation names', async () => {
  await withTemp((home) => {
    const env = envFor(home)
    const { bin } = fakeOwner(home, 0)
    const other = path.join(home, 'other-config.json')
    writeFileSync(other, JSON.stringify({ version: 2, entrypoint: { bin } }))
    assert.equal(readEntrypoint(env), undefined)
    assert.deepEqual(readEntrypoint(env, ['daemon', 'run', '--config', other]), { bin })
    assert.deepEqual(readEntrypoint(env, [`--config=${other}`]), { bin })
    assert.deepEqual(readEntrypoint({ ...env, HYP_CONFIG: other }), { bin })
  })
})

// @ref LLP 0621#front-door [tests]: hand off to a live, different copy only
test('hand off only to a live entry point that is not this copy', async () => {
  await withTemp((home) => {
    const env = envFor(home)
    const { bin } = fakeOwner(home, 0)

    writeConfig(home, { bin })
    assert.deepEqual(handoffTarget(['status'], env), { bin })

    // The guards: the child of a hand-off, the developer escape, and the
    // command an installer claims with.
    assert.equal(handoffTarget(['status'], { ...env, [HANDOFF_ENV]: '1' }), undefined)
    assert.equal(handoffTarget(['status'], { ...env, [NO_HANDOFF_ENV]: '1' }), undefined)
    assert.equal(handoffTarget(['entrypoint', 'claim'], env), undefined)

    // This copy, directly or through a symlink.
    writeConfig(home, { bin: SELF_BIN_PATH })
    assert.equal(handoffTarget(['status'], env), undefined)
    const link = path.join(home, 'hyp-link.js')
    symlinkSync(SELF_BIN_PATH, link)
    writeConfig(home, { bin: link })
    assert.equal(handoffTarget(['status'], env), undefined)

    // Dead: the copy it names is gone.
    writeConfig(home, { bin: path.join(home, 'gone', 'bin', 'hypaware.js') })
    assert.equal(liveEntrypoint(env), undefined)
    assert.equal(handoffTarget(['status'], env), undefined)
  })
})

test('runHandoff passes argv, stdin, and the exit code through, and marks the child', async () => {
  await withTemp((home) => {
    const { bin, out } = fakeOwner(home, 7)
    // Run in a child so the inherited stdin is a pipe this test controls.
    const script = `import { runHandoff } from ${JSON.stringify(new URL('../../src/core/runtime/entrypoint.js', import.meta.url).href)}
process.exit(runHandoff({ bin: ${JSON.stringify(bin)} }, ['claude-hook', 'classify-cwd']))`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: '{"cwd":"/x"}' })
    assert.equal(result.status, 7)
    const seen = JSON.parse(readFileSync(out, 'utf8'))
    assert.deepEqual(seen.argv, ['claude-hook', 'classify-cwd'])
    assert.equal(seen.handoff, '1')
    assert.equal(seen.stdin, '{"cwd":"/x"}')
  })
})

test('the CLI hands a command to the entry point and runs nothing itself', async () => {
  await withTemp((home) => {
    const env = envFor(home)
    const { bin, out } = fakeOwner(home, 3)
    writeConfig(home, { bin, node: process.execPath, owner: 'Test.app' })

    const result = spawnSync(process.execPath, [BIN, 'daemon', 'run'], { env, input: '' })
    assert.equal(result.status, 3)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).argv, ['daemon', 'run'])
    // Nothing of this copy's daemon lane ran: no pid or status written.
    assert.equal(existsSync(path.join(home, 'hypaware', 'run', 'hypaware.pid')), false)
  })
})

// @ref LLP 0621#claim [tests]: claim records the invoked copy; release refuses a non-owner without --force
test('hyp entrypoint claim, show, and release', async () => {
  await withTemp((home) => {
    const env = envFor(home)
    /** @param {string[]} args */
    const hyp = (args) => spawnSync(process.execPath, [BIN, 'entrypoint', ...args], { env, encoding: 'utf8' })

    let r = hyp(['--json'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).entrypoint, null)

    // Another copy owns it: claim still runs here (never handed off).
    const { bin, out } = fakeOwner(home, 0)
    writeConfig(home, { bin })
    r = hyp(['release'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--force/)
    r = hyp(['claim', '--owner', 'HypAware.app'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(out), false, 'claim is never handed off')
    const record = readEntrypoint(env)
    assert.equal(record?.bin, SELF_BIN_PATH)
    assert.equal(record?.node, process.execPath)
    assert.equal(record?.owner, 'HypAware.app')

    r = hyp(['--json'])
    assert.equal(JSON.parse(r.stdout).is_self, true)

    const afterClaim = JSON.parse(readFileSync(configPath(home), 'utf8'))
    assert.equal(afterClaim.auto_update, false, 'claim keeps the rest of the config')

    r = hyp(['release'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readEntrypoint(env), undefined)
    const afterRelease = JSON.parse(readFileSync(configPath(home), 'utf8'))
    assert.deepEqual(afterRelease, { version: 2, auto_update: false }, 'release removes only the key')
  })
})

// @ref LLP 0621#config-key [tests]: the key validates, and only the local layer sets it
test('the config schema accepts entrypoint, rejects a bad one, and the merge keeps it local', async () => {
  const { parseConfigShape } = await import('../../src/core/config/schema.js')
  const { mergeConfigLayers } = await import('../../src/core/config/merge.js')

  const good = parseConfigShape({ version: 2, entrypoint: { bin: '/app/bin/hypaware.js', node: '/app/node', owner: 'HypAware.app' } })
  assert.equal(good.ok, true)
  if (good.ok) assert.deepEqual(good.config.entrypoint, { bin: '/app/bin/hypaware.js', node: '/app/node', owner: 'HypAware.app' })

  const bad = parseConfigShape({ version: 2, entrypoint: { bin: 'relative.js' } })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.deepEqual(bad.errors.map((e) => e.pointer), ['/entrypoint'])

  const local = { version: 2, entrypoint: { bin: '/app/bin/hypaware.js' } }
  const central = { version: 2, entrypoint: { bin: '/org/bin/hypaware.js' }, auto_update: true }
  const merged = mergeConfigLayers(/** @type {any} */ (central), /** @type {any} */ (local))
  assert.deepEqual(merged.effective.entrypoint, { bin: '/app/bin/hypaware.js' })
  const centralOnly = mergeConfigLayers(/** @type {any} */ (central), /** @type {any} */ ({ version: 2 }))
  assert.equal(centralOnly.effective.entrypoint, undefined, 'a central entry point is ignored')
})

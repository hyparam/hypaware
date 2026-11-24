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
  entrypointPath,
  handoffTarget,
  liveEntrypoint,
  readEntrypoint,
  runHandoff,
  writeEntrypoint,
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

/** @param {string} home */
function envFor(home) {
  return { ...process.env, HYP_HOME: home, [HANDOFF_ENV]: '', [NO_HANDOFF_ENV]: '' }
}

test('no file, a malformed file, or a relative bin reads as no entry point', async () => {
  await withTemp((home) => {
    const env = envFor(home)
    assert.equal(readEntrypoint(env), undefined)
    mkdirSync(path.dirname(entrypointPath(env)), { recursive: true })
    writeFileSync(entrypointPath(env), '{not json')
    assert.equal(readEntrypoint(env), undefined)
    writeFileSync(entrypointPath(env), JSON.stringify({ bin: 'relative/hypaware.js' }))
    assert.equal(readEntrypoint(env), undefined)
    assert.equal(handoffTarget(['status'], env), undefined)
  })
})

// @ref LLP 0621#front-door [tests]: hand off to a live, different copy only
test('hand off only to a live entry point that is not this copy', async () => {
  await withTemp((home) => {
    const env = envFor(home)
    const { bin } = fakeOwner(home, 0)

    writeEntrypoint({ bin }, env)
    assert.deepEqual(handoffTarget(['status'], env), { bin })

    // The guards: the child of a hand-off, the developer escape, and the
    // command an installer claims with.
    assert.equal(handoffTarget(['status'], { ...env, [HANDOFF_ENV]: '1' }), undefined)
    assert.equal(handoffTarget(['status'], { ...env, [NO_HANDOFF_ENV]: '1' }), undefined)
    assert.equal(handoffTarget(['entrypoint', 'claim'], env), undefined)

    // This copy, directly or through a symlink.
    writeEntrypoint({ bin: SELF_BIN_PATH }, env)
    assert.equal(handoffTarget(['status'], env), undefined)
    const link = path.join(home, 'hyp-link.js')
    symlinkSync(SELF_BIN_PATH, link)
    writeEntrypoint({ bin: link }, env)
    assert.equal(handoffTarget(['status'], env), undefined)

    // Dead: the copy it names is gone.
    writeEntrypoint({ bin: path.join(home, 'gone', 'bin', 'hypaware.js') }, env)
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
    writeEntrypoint({ bin, node: process.execPath, owner: 'Test.app' }, env)

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
    writeEntrypoint({ bin }, env)
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

    r = hyp(['release'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readEntrypoint(env), undefined)
  })
})

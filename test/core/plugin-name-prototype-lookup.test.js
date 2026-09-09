// @ts-check

// Every name an operator can hand a plugin command travels two unguarded plain
// object lookups: the alias map in `parseCommandArgv`, and the lock's `plugins`
// map. An `Object.prototype` member name ('constructor', 'toString', ...)
// resolved through the prototype in both, so `hyp plugin info constructor`
// died on `token.startsWith is not a function` before it ever reached the lock,
// and `hyp plugin remove toString` reported a removal it never made (issue
// #1601). These drive the real CLI: the defect is what an operator reads, and
// only a spawn proves the whole path from argv to the lock answers.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeLock } from '../../src/core/plugin_install/lock.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = path.join(REPO_ROOT, 'bin', 'hypaware.js')

const PROTOTYPE_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']

/**
 * Run the packaged CLI against `hypHome`, on a default install's footing: the
 * dev-telemetry, OTLP and config variables are stripped so nothing outside the
 * fixture reaches the boot.
 *
 * @param {string} hypHome
 * @param {string[]} argv
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCli(hypHome, argv) {
  /** @type {Record<string, string|undefined>} */
  const env = { ...process.env, HYP_HOME: hypHome }
  delete env.HYP_CONFIG
  delete env.HYP_DEV_TELEMETRY
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete env.DEV_RUN_ID
  const out = spawnSync(process.execPath, [BIN, ...argv], { env, encoding: 'utf8' })
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

/**
 * A HYP_HOME holding one real install record, so the prototype names below are
 * asked of a populated lock rather than an absent one.
 *
 * @param {string} prefix
 */
async function makeHome(prefix) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const stateDir = path.join(hypHome, 'hypaware')
  await fs.mkdir(stateDir, { recursive: true })
  await writeLock(stateDir, {
    schema_version: 1,
    plugins: {
      '@third-party/echo': {
        name: '@third-party/echo',
        version: '0.2.0',
        source: { kind: 'local-dir', raw: '/fixtures/echo', path: '/fixtures/echo' },
        install_dir: '/fixtures/echo',
        content_hash: 'a'.repeat(64),
        manifest_hash: 'b'.repeat(64),
        installed_at: '2026-09-01T00:00:00.000Z',
      },
    },
  })
  return hypHome
}

// The reported repro. The miss message is the point, not merely a non-crash:
// an internal `TypeError` is the wrong signpost in exactly the "what is this
// thing" investigation the command serves.
test('plugin info answers a prototype name with the ordinary miss message', async () => {
  const hypHome = await makeHome('hyp-plugin-proto-info-')
  try {
    for (const name of PROTOTYPE_NAMES) {
      const out = runCli(hypHome, ['plugin', 'info', name])
      assert.equal(out.status, 1, `${name}: expected exit 1, got ${out.status}: ${out.stderr}`)
      assert.equal(out.stdout, '', `${name}: expected no stdout`)
      assert.equal(
        out.stderr,
        `hyp plugin info: no plugin named '${name}' is installed or bundled with this package\n`
      )
    }
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The same hazard on the destructive command, where the wrong answer is worse
// than an opaque one: the inherited function read as an install record, so the
// command deleted a directory it derived from the name and then reported a
// removal that never happened.
test('plugin remove refuses a prototype name and leaves the lock alone', async () => {
  const hypHome = await makeHome('hyp-plugin-proto-remove-')
  const lockPath = path.join(hypHome, 'hypaware', 'plugin-lock.json')
  try {
    const before = await fs.readFile(lockPath, 'utf8')
    for (const name of PROTOTYPE_NAMES) {
      const out = runCli(hypHome, ['plugin', 'remove', name])
      assert.equal(out.status, 1, `${name}: expected exit 1, got ${out.status}: ${out.stderr}`)
      assert.equal(out.stdout, '', `${name}: expected no stdout`)
      assert.equal(out.stderr, `hyp plugin remove: plugin not installed: ${name}\n`)
    }
    assert.equal(await fs.readFile(lockPath, 'utf8'), before)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The flag half of the same lookup: a schema's `properties` is a plain object
// too, so `--constructor` resolved to Object.prototype's function and bound as
// a declared string property. LLP 0293's one refusal covers it like any other
// unknown flag.
test('a prototype-named flag refuses like any other unknown flag', async () => {
  const hypHome = await makeHome('hyp-plugin-proto-flag-')
  try {
    const out = runCli(hypHome, ['plugin', 'info', '--constructor=x', '@third-party/echo'])
    assert.equal(out.status, 2, `expected exit 2, got ${out.status}: ${out.stderr}`)
    assert.equal(out.stdout, '')
    assert.match(out.stderr, /^hyp plugin info: unknown flag --constructor$/m)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// The guards must not cost the lookup they guard: a real install record still
// answers, so nothing above passes by making every name a miss.
test('a real install record still answers plugin info', async () => {
  const hypHome = await makeHome('hyp-plugin-proto-real-')
  try {
    const out = runCli(hypHome, ['plugin', 'info', '@third-party/echo'])
    assert.equal(out.status, 0, `expected exit 0, got ${out.status}: ${out.stderr}`)
    assert.match(out.stdout, /^@third-party\/echo@0\.2\.0$/m)
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

// @ts-check

// A remote target name is printed inside the fixed-format enrollment notice
// (LLP 0100 R1a), so `remote add` refuses a name that could break or forge
// that notice: whitespace, a line break, terminal control or bidi reordering,
// or a URL. A name that already sits in a hand-edited or layered config is
// not bricked: it still logs in, and the notice names it neutrally (#414).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { firstSyncHoldMessage, remoteNameProblem, runRemoteAdd, runRemoteLogin, runRemoteRemove } from '../../src/core/cli/remote_commands.js'

const REFUSED = [
  ['empty', ''],
  ['a space', 'my prod'],
  ['a newline', 'prod\nforged line'],
  ['a tab', 'prod\tx'],
  ['an ESC sequence', 'prod\u001b[2J'],
  ['a bidi override', 'prod\u202Eevil'],
  ['a bidi isolate', '\u2066prod'],
  ['a line separator', 'prod\u2028x'],
  ['an https URL', 'https://x'],
  ['another scheme', 'ftp://hyp.internal'],
]

const ACCEPTED = ['prod', 'prodüktion-日本', 'hyp.internal', 'team_a-1', 'https']

/**
 * @param {{ remotes?: any }} [opts]
 */
async function makeCtx({ remotes = { prod: { url: 'https://hyp.internal/mcp' } } } = {}) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-remote-name-'))
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const configPath = path.join(hypHome, 'config.json')
  const config = { version: 2, query: { remotes } }
  await fs.writeFile(configPath, JSON.stringify(config))
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome, HYP_CONFIG: configPath },
    config,
    stdin: { isTTY: true },
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err, configPath }
}

test('remote add refuses a name that could break the notice, with exit 2 and no config change', async () => {
  for (const [label, name] of REFUSED) {
    const { ctx, out, err, configPath } = await makeCtx()
    const before = await fs.readFile(configPath, 'utf8')
    const code = await runRemoteAdd([`--name=${name}`, '--url=https://other.example/mcp'], ctx)
    assert.equal(code, 2, `${label} is refused as a usage error`)
    assert.equal(await fs.readFile(configPath, 'utf8'), before, `${label} leaves the config untouched`)
    assert.equal(out.join(''), '', `${label} reports no success`)
    const text = err.join('')
    // An empty name never reaches the check: the argv parser already refuses it.
    if (name === '') continue
    assert.match(text, /^hyp remote add: the remote name /)
    assert.ok(!text.includes(name), `${label} is not echoed back raw`)
    assert.doesNotMatch(text, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u2028\u2029]/, `${label} puts no control byte on stderr`)
    assert.equal(text.split('\n').length, 2, `${label} refusal is one line`)
  }
})

test('remote add keeps ordinary names, non-ASCII included, and still updates one', async () => {
  for (const name of ACCEPTED) {
    const { ctx, configPath } = await makeCtx()
    assert.equal(await runRemoteAdd([`--name=${name}`, '--url=https://other.example/mcp'], ctx), 0, `${name} is accepted`)
    const remotes = JSON.parse(await fs.readFile(configPath, 'utf8')).query.remotes
    assert.deepEqual(remotes[name], { url: 'https://other.example/mcp' })
  }
  const { ctx, configPath } = await makeCtx()
  assert.equal(await runRemoteAdd(['--name=prod', '--url=https://moved.example/mcp'], ctx), 0)
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')).query.remotes.prod, { url: 'https://moved.example/mcp' })
})

test('remote add still defines __proto__ as an own key', async () => {
  const { ctx, configPath } = await makeCtx({ remotes: {} })
  assert.equal(await runRemoteAdd(['--name=__proto__', '--url=https://p.example/mcp'], ctx), 0)
  const remotes = JSON.parse(await fs.readFile(configPath, 'utf8')).query.remotes
  assert.ok(Object.hasOwn(remotes, '__proto__'))
})

test('remoteNameProblem agrees with remote add on every case', () => {
  for (const [label, name] of REFUSED) assert.equal(typeof remoteNameProblem(name), 'string', label)
  for (const name of ACCEPTED) assert.equal(remoteNameProblem(name), undefined, name)
})

test('the first-sync notice names a valid server and neutrally labels a legacy bad name', () => {
  const deadline = Date.UTC(2026, 9, 20, 12)
  const good = firstSyncHoldMessage(deadline, 'prodüktion-日本')
  assert.match(good, /first sync to the 'prodüktion-日本' server is no later than/)

  for (const [label, name] of REFUSED) {
    if (name === '') continue
    const text = firstSyncHoldMessage(deadline, name)
    assert.ok(!text.includes(name), `${label} is not printed into the notice`)
    assert.match(text, /first sync to your configured server is no later than/)
    assert.match(text, /run 'hyp remote list' to see that server's URL/, `${label} keeps the lookup pointer`)
    // The notice keeps its fixed shape: the same lines as for a valid name.
    assert.equal(text.split('\n').length, good.split('\n').length, `${label} adds no line`)
  }
})

test('a hand-configured legacy bad name still logs in, and the forwarding line does not print it', async () => {
  const legacy = 'https://hyp.internal'
  const { ctx, out, err } = await makeCtx({ remotes: { [legacy]: { url: 'https://hyp.internal/mcp' } } })
  const login = /** @type {any} */ (async () => ({
    refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2999-01-01T00:00:00Z', org: 'acme',
    gateway: { jwt: 'gw-jwt', expiresAt: 1_920_000_000, gatewayId: 'gw-1' },
  }))
  // --no-daemon keeps the test off the real launchd/systemd install.
  const code = await runRemoteLogin([`--name=${legacy}`, '--no-daemon'], ctx, { login })
  assert.equal(code, 0, err.join(''))
  const text = out.join('')
  assert.match(text, /forwarding logs to your configured server\n/)
  assert.match(text, /run 'hyp remote list' to see its URL/)
  assert.doesNotMatch(text, /forwarding logs to the 'https:/)
})

test('a hand-configured legacy bad name can still be removed', async () => {
  const legacy = 'prod\nforged'
  const { ctx, configPath } = await makeCtx({ remotes: { [legacy]: { url: 'https://hyp.internal/mcp' } } })
  assert.equal(await runRemoteRemove([`--name=${legacy}`], ctx), 0)
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(configPath, 'utf8')).query.remotes, legacy), false)
})

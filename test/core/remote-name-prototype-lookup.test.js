// @ts-check

// An operator-typed remote target name is a map key, and every map the
// `remote` family keys by it is a plain object carrying `Object.prototype`.
// A name like `constructor` or `__proto__` therefore used to resolve an
// inherited member instead of missing, which put the wrong signpost on a
// typo, suppressed the not-configured nudge, reported a token that is not
// stored, and let `remote add` report success while recording nothing.
//
// The target name reaches the runners here as `--name=<value>`, the flag
// form the shared `remote` schemas already declare, and these cases call the
// runners directly. #1608 reported the bare positional form
// (`hyp remote mint constructor`); it lands on these same lookups once the
// argv tokenizer stops resolving a positional name off `Object.prototype`,
// which is #1601's own defect and whose guard landed separately in #1605.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runRemoteAdd, runRemoteList, runRemoteLogin, runRemoteMint, runRemoteRemove } from '../../src/core/cli/remote_commands.js'
import { writeToken } from '../../src/core/remote/credentials.js'

const PROTO_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-remote-proto-'))
}

/**
 * A ctx with captured streams over a real config file, the way the `remote`
 * family resolves targets.
 *
 * @param {{ hypHome: string, remotes?: any }} opts
 */
async function makeCtx({ hypHome, remotes = {} }) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const configPath = path.join(hypHome, 'config.json')
  const config = { version: 2, query: { remotes } }
  await fs.writeFile(configPath, JSON.stringify(config))
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: hypHome, HYP_CONFIG: configPath },
    config,
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err, configPath }
}

/** @param {string} configPath */
async function readRemotes(configPath) {
  return JSON.parse(await fs.readFile(configPath, 'utf8')).query.remotes
}

test('remote mint signposts a prototype-named target as unknown, not as a broken url', async () => {
  const hypHome = await tmpHome()
  for (const name of PROTO_NAMES) {
    const { ctx, err } = await makeCtx({ hypHome, remotes: { prod: { url: 'https://prod.example' } } })
    const code = await runRemoteMint([`--name=${name}`], ctx, {})
    assert.equal(code, 2, `${name} should be a usage miss`)
    assert.match(err.join(''), new RegExp(`unknown remote target '${name}'`))
    assert.doesNotMatch(err.join(''), /identity endpoint/)
  }
})

test('a configured __proto__ target does not answer lookups for every other name', async () => {
  // Assigning `__proto__` into the target map sets the map's prototype, so
  // `remotes.url` resolved the dropped entry's own `url` and an ordinary miss
  // got the broken-url signpost. The fixture is built with
  // `Object.fromEntries` because in an object literal `__proto__:` is the
  // prototype-setter syntax and creates no own key at all.
  const hypHome = await tmpHome()
  const { ctx, err } = await makeCtx({
    hypHome,
    remotes: Object.fromEntries([['__proto__', { url: 'https://poison.example' }], ['prod', { url: 'https://prod.example' }]]),
  })
  const code = await runRemoteMint(['--name=url'], ctx, {})
  assert.equal(code, 2)
  assert.match(err.join(''), /unknown remote target 'url'/)
})

test('remote add records a prototype-named target instead of reporting a phantom success', async () => {
  const hypHome = await tmpHome()
  for (const name of PROTO_NAMES) {
    const { ctx, out, configPath } = await makeCtx({ hypHome })
    const code = await runRemoteAdd([`--name=${name}`, '--url=https://added.example'], ctx)
    assert.equal(code, 0)
    assert.match(out.join(''), new RegExp(`added remote '${name}'`))
    const remotes = await readRemotes(configPath)
    assert.deepEqual(
      Object.hasOwn(remotes, name) ? remotes[name] : undefined,
      { url: 'https://added.example' },
      `${name} should be an own key of query.remotes`
    )
  }
})

test('remote add then list surfaces a prototype-named target', async () => {
  const hypHome = await tmpHome()
  const added = await makeCtx({ hypHome })
  assert.equal(await runRemoteAdd(['--name=__proto__', '--url=https://added.example'], added.ctx), 0)
  const shown = await makeCtx({ hypHome, remotes: await readRemotes(added.configPath) })
  assert.equal(await runRemoteList(['--json'], shown.ctx), 0)
  const listed = JSON.parse(shown.out.join(''))
  assert.deepEqual(
    listed.find((/** @type {any} */ r) => r.name === '__proto__'),
    { name: '__proto__', url: 'https://added.example', token: 'missing' }
  )
})

test('remote login still nudges when a prototype-named target is not configured', async () => {
  const hypHome = await tmpHome()
  const tokenFile = path.join(hypHome, 'token.txt')
  await fs.writeFile(tokenFile, 'tok-abc\n')
  for (const name of PROTO_NAMES) {
    const { ctx, err } = await makeCtx({ hypHome, remotes: { prod: { url: 'https://prod.example' } } })
    const code = await runRemoteLogin([`--name=${name}`, '--token-file', tokenFile], ctx)
    assert.equal(code, 0)
    assert.match(err.join(''), new RegExp(`'${name}' is not a configured target`))
  }
})

test('remote browser login refuses a prototype-named target instead of calling its url invalid', async () => {
  const hypHome = await tmpHome()
  const login = async () => {
    throw new Error('the browser flow must not start for an unconfigured target')
  }
  for (const name of PROTO_NAMES) {
    const { ctx, err } = await makeCtx({ hypHome, remotes: { prod: { url: 'https://prod.example' } } })
    const code = await runRemoteLogin([`--name=${name}`, '--browser'], ctx, { login: /** @type {any} */ (login) })
    assert.equal(code, 2)
    assert.match(err.join(''), new RegExp(`'${name}' is not a configured target`))
    assert.doesNotMatch(err.join(''), /invalid url/)
  }
})

test('remote list reports a prototype-named target as missing until a token is stored', async () => {
  const hypHome = await tmpHome()
  const remotes = { constructor: { url: 'https://ctor.example' }, prod: { url: 'https://prod.example' } }
  const first = await makeCtx({ hypHome, remotes })
  assert.equal(await runRemoteList([], first.ctx), 0)
  assert.match(first.out.join(''), /constructor\thttps:\/\/ctor\.example\ttoken: missing/)

  await writeToken(path.join(hypHome, 'hypaware'), 'constructor', 'tok-abc')
  const second = await makeCtx({ hypHome, remotes })
  assert.equal(await runRemoteList([], second.ctx), 0)
  assert.match(second.out.join(''), /constructor\thttps:\/\/ctor\.example\ttoken: stored/)
})

test('remote remove refuses a prototype-named target that was never configured', async () => {
  const hypHome = await tmpHome()
  for (const name of PROTO_NAMES) {
    const { ctx, err, out } = await makeCtx({ hypHome, remotes: { prod: { url: 'https://prod.example' } } })
    const code = await runRemoteRemove([`--name=${name}`], ctx)
    assert.equal(code, 1, `${name} should not report a removal`)
    assert.match(err.join(''), new RegExp(`no target or token named '${name}'`))
    assert.doesNotMatch(out.join(''), /removed remote/)
  }
})

test('an ordinary target name still adds, lists, logs in, mints and removes', async () => {
  // The guards must not turn every lookup into a miss.
  const hypHome = await tmpHome()
  const tokenFile = path.join(hypHome, 'token.txt')
  await fs.writeFile(tokenFile, 'tok-abc\n')

  const added = await makeCtx({ hypHome })
  assert.equal(await runRemoteAdd(['prod', 'https://prod.example'], added.ctx), 0)
  assert.deepEqual(await readRemotes(added.configPath), { prod: { url: 'https://prod.example' } })

  const loggedIn = await makeCtx({ hypHome, remotes: { prod: { url: 'https://prod.example' } } })
  assert.equal(await runRemoteLogin(['prod', '--token-file', tokenFile], loggedIn.ctx), 0)
  assert.doesNotMatch(loggedIn.err.join(''), /not a configured target/)

  const listed = await makeCtx({ hypHome, remotes: { prod: { url: 'https://prod.example' } } })
  assert.equal(await runRemoteList([], listed.ctx), 0)
  assert.match(listed.out.join(''), /prod\thttps:\/\/prod\.example\ttoken: stored/)

  // An ordinary unknown name keeps the ordinary signpost.
  const missed = await makeCtx({ hypHome, remotes: { prod: { url: 'https://prod.example' } } })
  assert.equal(await runRemoteMint(['--name=nosuchremote'], missed.ctx, {}), 2)
  assert.match(missed.err.join(''), /unknown remote target 'nosuchremote'/)

  const removed = await makeCtx({ hypHome, remotes: { prod: { url: 'https://prod.example' } } })
  assert.equal(await runRemoteRemove(['prod'], removed.ctx), 0)
  assert.match(removed.out.join(''), /removed remote 'prod'/)
  assert.deepEqual(await readRemotes(removed.configPath), {})
})

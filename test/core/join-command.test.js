// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { centralSeedPath } from '../../src/core/config/apply.js'

/** @param {string} hypHome */
function seedPathFor(hypHome) {
  return centralSeedPath(path.join(hypHome, 'hypaware'))
}

function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/** @param {string} [stdinText] */
async function makeDispatchOpts(stdinText) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-join-test-'))
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {any} */
  let stdin
  if (stdinText !== undefined) {
    stdin = {
      isTTY: false,
      async *[Symbol.asyncIterator]() { yield stdinText },
    }
  } else {
    stdin = { isTTY: true }
  }
  return {
    hypHome,
    stdout,
    stderr,
    opts: { stdout, stderr, stdin, env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' } },
  }
}

test('join writes the central seed (mode 0600) and skips daemon install with --no-daemon', async () => {
  const { hypHome, stdout, opts } = await makeDispatchOpts()
  const code = await dispatch(
    ['join', 'https://central.example', 'policy-token-1', '--no-daemon'],
    opts
  )
  assert.equal(code, 0, stdout.text())

  // The seed is the central layer — written under config-control/, never
  // to the user-owned hypaware-config.json (the #111 fix).
  const seedPath = seedPathFor(hypHome)
  const stat = await fs.stat(seedPath)
  assert.equal(stat.mode & 0o777, 0o600)

  const seed = JSON.parse(await fs.readFile(seedPath, 'utf8'))
  assert.equal(seed.version, 2)
  assert.deepEqual(seed.plugins, [{ name: '@hypaware/central' }])
  assert.equal(seed.sinks.central.plugin, '@hypaware/central')
  assert.equal(seed.sinks.central.config.url, 'https://central.example')
  assert.equal(seed.sinks.central.config.identity.bootstrap_token, 'policy-token-1')
  assert.match(stdout.text(), /daemon install skipped/)
})

test('join never touches an existing local config (#111 regression)', async () => {
  const { hypHome, opts } = await makeDispatchOpts()
  // A working local install: ai-gateway + client wiring the user owns.
  const localPath = path.join(hypHome, 'hypaware-config.json')
  const localConfig = {
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787' } },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
    ],
  }
  await fs.writeFile(localPath, JSON.stringify(localConfig, null, 2) + '\n')

  const code = await dispatch(
    ['join', 'https://central.example', 'policy-token-1', '--no-daemon'],
    opts
  )
  assert.equal(code, 0)

  // The local layer is byte-for-byte untouched; the seed lives elsewhere.
  const after = JSON.parse(await fs.readFile(localPath, 'utf8'))
  assert.deepEqual(after, localConfig)
  const stat = await fs.lstat(localPath)
  assert.ok(!stat.isSymbolicLink())
  await fs.stat(seedPathFor(hypHome))
})

test('join reads the token from --token-file', async () => {
  const { hypHome, opts } = await makeDispatchOpts()
  const tokenFile = path.join(hypHome, 'token.txt')
  await fs.writeFile(tokenFile, 'file-token\n')

  const code = await dispatch(
    ['join', 'https://central.example', '--token-file', tokenFile, '--no-daemon'],
    opts
  )
  assert.equal(code, 0)
  const seed = JSON.parse(await fs.readFile(seedPathFor(hypHome), 'utf8'))
  assert.equal(seed.sinks.central.config.identity.bootstrap_token, 'file-token')
})

test('join reads the token from stdin when piped', async () => {
  const { hypHome, opts } = await makeDispatchOpts('stdin-token\n')
  const code = await dispatch(['join', 'https://central.example', '--no-daemon'], opts)
  assert.equal(code, 0)
  const seed = JSON.parse(await fs.readFile(seedPathFor(hypHome), 'utf8'))
  assert.equal(seed.sinks.central.config.identity.bootstrap_token, 'stdin-token')
})

test('join rejects missing url, bad url, missing token, and conflicting token sources', async () => {
  {
    const { stderr, opts } = await makeDispatchOpts()
    assert.equal(await dispatch(['join'], opts), 2)
    assert.match(stderr.text(), /missing <url>/)
  }
  {
    const { stderr, opts } = await makeDispatchOpts()
    assert.equal(await dispatch(['join', 'ftp://x', 'tok', '--no-daemon'], opts), 2)
    assert.match(stderr.text(), /http\(s\)/)
  }
  {
    // TTY stdin and no token anywhere.
    const { stderr, opts } = await makeDispatchOpts()
    assert.equal(await dispatch(['join', 'https://central.example', '--no-daemon'], opts), 2)
    assert.match(stderr.text(), /no token given/)
  }
  {
    const { hypHome, stderr, opts } = await makeDispatchOpts()
    const tokenFile = path.join(hypHome, 'token.txt')
    await fs.writeFile(tokenFile, 'x')
    assert.equal(
      await dispatch(
        ['join', 'https://central.example', 'tok', '--token-file', tokenFile, '--no-daemon'],
        opts
      ),
      2
    )
    assert.match(stderr.text(), /not both/)
  }
})

test('join help exits 0 and documents token sources', async () => {
  const { stdout, opts } = await makeDispatchOpts()
  assert.equal(await dispatch(['join', '--help'], opts), 0)
  assert.match(stdout.text(), /--token-file/)
  assert.match(stdout.text(), /stdin/)
})

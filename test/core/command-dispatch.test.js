// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { dispatch } from '../../src/core/cli/dispatch.js'

test('Claude session-context hook exits 0 without configured plugins', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-'))
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(
    ['claude-hook', 'session-context', '--port', '8787'],
    {
      stdout,
      stderr,
      stdin: stdinFor(''),
      env: { ...process.env, HYP_HOME: hypHome },
    }
  )

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(stderr.text(), '')
})

test('Claude session-context hook posts cwd context to the local gateway endpoint', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-'))
  const stdout = makeBuf()
  const stderr = makeBuf()
  /** @type {Array<{ url: string | undefined, method: string | undefined, body: string }>} */
  const received = []
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      received.push({
        url: req.url,
        method: req.method,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await listen(server)
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')

  try {
    const code = await dispatch(
      ['claude-hook', 'session-context', '--port', String(addr.port)],
      {
        stdout,
        stderr,
        stdin: stdinFor({
          session_id: 'sess-hook',
          cwd: '/tmp/not-a-git-repo',
          hook_event_name: 'SessionStart',
        }),
        env: { ...process.env, HYP_HOME: hypHome },
      }
    )

    assert.equal(code, 0)
    assert.equal(stdout.text(), '')
    assert.equal(stderr.text(), '')
    assert.equal(received.length, 1)
    assert.equal(received[0].url, '/_hypaware/session-context')
    assert.equal(received[0].method, 'POST')
    assert.deepEqual(JSON.parse(received[0].body), {
      session_id: 'sess-hook',
      cwd: '/tmp/not-a-git-repo',
    })
  } finally {
    await closeServer(server)
  }
})

test('Claude session-context hook ignores events without session context', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-hook-'))
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(
    ['claude-hook', 'session-context', '--port', '8787'],
    {
      stdout,
      stderr,
      stdin: stdinFor({ cwd: '/tmp/not-a-git-repo' }),
      env: { ...process.env, HYP_HOME: hypHome },
    }
  )

  assert.equal(code, 0)
  assert.equal(stdout.text(), '')
  assert.equal(stderr.text(), '')
})

test('hidden Claude hook command is omitted from top-level help', async () => {
  const stdout = makeBuf()
  const stderr = makeBuf()

  const code = await dispatch(['--help'], { stdout, stderr })

  assert.equal(code, 0)
  assert.equal(stderr.text(), '')
  assert.equal(stdout.text().includes('claude-hook'), false)
})

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

/**
 * @param {unknown} value
 * @returns {NodeJS.ReadStream}
 */
function stdinFor(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return /** @type {NodeJS.ReadStream} */ (Readable.from([body]))
}

/**
 * @param {http.Server} server
 * @returns {Promise<void>}
 */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve())
    server.listen(0, '127.0.0.1')
  })
}

/**
 * @param {http.Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

import {
  OPENCODE_PLUGIN_MARKER,
  attachOpenCodePlugin,
  opencodePluginPath,
} from '../../hypaware-core/plugins-workspace/opencode/src/attach.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { probeClientAttachFromDescriptor } from '../../src/core/daemon/status.js'

/** @import { ClientDescriptor } from '../../src/core/types.js' */

/** @type {ClientDescriptor} */
const DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/opencode'),
  name: 'opencode',
  skillDir: '.config/opencode/skills',
  attachProbe: {
    format: 'managed_file',
    settings_file: '.config/opencode/plugins/hypaware.js',
    marker_text: OPENCODE_PLUGIN_MARKER,
  },
}

async function stageHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-opencode-attach-'))
}

test('OpenCode plugin path follows XDG_CONFIG_HOME and ignores invented OPENCODE_HOME', async () => {
  const home = await stageHome()
  const xdg = path.join(home, 'xdg')
  try {
    assert.equal(
      opencodePluginPath({ homeDir: home, env: { HOME: home } }),
      path.join(home, '.config', 'opencode', 'plugins', 'hypaware.js')
    )
    assert.equal(
      opencodePluginPath({ homeDir: home, env: { HOME: home, XDG_CONFIG_HOME: xdg } }),
      path.join(xdg, 'opencode', 'plugins', 'hypaware.js')
    )
    assert.equal(
      opencodePluginPath({ homeDir: home, env: { HOME: home, OPENCODE_HOME: path.join(home, 'invented') } }),
      path.join(home, '.config', 'opencode', 'plugins', 'hypaware.js')
    )
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('OpenCode attach installs, updates, and idempotently retains only the HypAware-owned JavaScript file', async () => {
  const home = await stageHome()
  try {
    const first = await attachOpenCodePlugin({
      endpoint: 'http://127.0.0.1:4320',
      version: '1.0.0',
      homeDir: home,
      env: { HOME: home },
    })
    assert.equal(first.changed, true)
    const installed = await fs.readFile(first.settingsPath, 'utf8')
    assert.match(installed, /^\/\/ HYPWARE_OPENCODE_PLUGIN v1/m)
    assert.match(installed, /HypAware adapter 1\.0\.0/)
    assert.match(installed, /http:\/\/127\.0\.0\.1:4320/)
    assert.equal(installed.includes('__HYPWARE_OPENCODE_ENDPOINT__'), false)

    const second = await attachOpenCodePlugin({
      endpoint: 'http://127.0.0.1:4320',
      version: '1.0.0',
      homeDir: home,
      env: { HOME: home },
    })
    assert.equal(second.changed, false)
    assert.equal(await fs.readFile(first.settingsPath, 'utf8'), installed)

    const updated = await attachOpenCodePlugin({
      endpoint: 'http://127.0.0.1:4321',
      version: '1.1.0',
      homeDir: home,
      env: { HOME: home },
    })
    assert.equal(updated.changed, true)
    const updatedBody = await fs.readFile(first.settingsPath, 'utf8')
    assert.match(updatedBody, /HypAware adapter 1\.1\.0/)
    assert.match(updatedBody, /http:\/\/127\.0\.0\.1:4321/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('OpenCode attach refuses an unowned collision and dry-run writes nothing', async () => {
  const home = await stageHome()
  const settingsPath = opencodePluginPath({ homeDir: home, env: { HOME: home } })
  try {
    const dry = await attachOpenCodePlugin({
      endpoint: 'http://127.0.0.1:4320',
      version: '1.0.0',
      homeDir: home,
      env: { HOME: home },
      dryRun: true,
    })
    assert.equal(dry.changed, true)
    await assert.rejects(fs.stat(settingsPath), { code: 'ENOENT' })

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, 'export const Mine = async () => ({})\n', 'utf8')
    await assert.rejects(
      attachOpenCodePlugin({
        endpoint: 'http://127.0.0.1:4320',
        version: '1.0.0',
        homeDir: home,
        env: { HOME: home },
      }),
      /not HypAware-owned/
    )
    assert.equal(await fs.readFile(settingsPath, 'utf8'), 'export const Mine = async () => ({})\n')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('managed-file probe and detach remove exactly the still-owned OpenCode plugin', async () => {
  const home = await stageHome()
  try {
    const attached = await attachOpenCodePlugin({
      endpoint: 'http://127.0.0.1:4320',
      version: '1.0.0',
      homeDir: home,
      env: { HOME: home },
    })
    assert.deepEqual(
      await probeClientAttachFromDescriptor({ descriptor: DESCRIPTOR, homeDir: home, env: { HOME: home } }),
      { attached: true, settingsPath: attached.settingsPath }
    )
    const detached = await detachClientFromDisk({ descriptor: DESCRIPTOR, homeDir: home, env: { HOME: home } })
    assert.equal(detached.changed, true)
    await assert.rejects(fs.stat(attached.settingsPath), { code: 'ENOENT' })
    assert.equal((await detachClientFromDisk({ descriptor: DESCRIPTOR, homeDir: home })).changed, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('detach retains a user replacement after the ownership marker is removed', async () => {
  const home = await stageHome()
  try {
    const settingsPath = opencodePluginPath({ homeDir: home, env: { HOME: home } })
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    const replacement = 'export const UserPlugin = async () => ({})\n'
    await fs.writeFile(settingsPath, replacement, 'utf8')

    const probe = await probeClientAttachFromDescriptor({ descriptor: DESCRIPTOR, homeDir: home, env: { HOME: home } })
    assert.equal(probe.attached, false)
    const detached = await detachClientFromDisk({ descriptor: DESCRIPTOR, homeDir: home, env: { HOME: home } })
    assert.equal(detached.changed, false)
    assert.match(String(detached.warning), /ownership marker is missing/)
    assert.equal(await fs.readFile(settingsPath, 'utf8'), replacement)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('the installed plugin reads the session through the SDK route contract and reports only complete snapshots', async () => {
  const home = await stageHome()
  const received = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const port = /** @type {any} */ (server.address()).port
  try {
    const installed = await attachOpenCodePlugin({
      endpoint: `http://127.0.0.1:${port}`,
      version: '1.0.0',
      env: { HOME: home },
      homeDir: home,
    })
    const module = await import(pathToFileURL(installed.settingsPath).href)

    // The generated OpenCode SDK client takes route parameters under `path`.
    // A bare `{ sessionID }` leaves `/session/{id}` unsubstituted, so the
    // server 500s and every snapshot carries an error envelope instead of a
    // session. Assert the call shape, not just that a call happened.
    const calls = []
    /** @param {unknown} data */
    const ok = (data) => ({ data, request: {}, response: {} })
    /** @type {any} */
    const client = {
      session: {
        async get(args) {
          calls.push(['get', args])
          return ok({ id: 'ses_1', directory: '/work/probe', time: { created: 1 } })
        },
        async messages(args) {
          calls.push(['messages', args])
          return ok([])
        },
      },
    }
    const hooks = await module.HypAware({ client, directory: '/work/probe', worktree: '/work/probe', project: { id: 'proj' } })
    hooks.event({ event: { type: 'message.part.updated', properties: { part: { sessionID: 'ses_1', id: 'part_1' } } } })
    await waitFor(() => received.length === 1)

    assert.deepEqual(calls, [
      ['get', { path: { id: 'ses_1' } }],
      ['messages', { path: { id: 'ses_1' } }],
    ])
    assert.equal(received[0].url, '/snapshot')
    assert.equal(received[0].body.session.id, 'ses_1')
    assert.equal(received[0].body.trigger, 'message.part.updated')

    // A failed SDK read is not a snapshot: shipping the error envelope would
    // reach the listener as a session with no directory and be miscounted as a
    // missing cwd rather than a failed read.
    client.session.get = async () => ({ error: { name: 'UnknownError' }, request: {}, response: {} })
    hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(received.length, 1)
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    await fs.rm(home, { recursive: true, force: true })
  }
})

/** @param {() => boolean} predicate */
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for the plugin to post a snapshot')
}

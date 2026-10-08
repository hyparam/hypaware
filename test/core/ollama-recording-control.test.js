// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createClientRecordingPolicyReader, writeClientRecording } from '../../src/core/config/client_recording.js'
import { confirmOllamaRecording, RECORDING_ROUTE, RECORDING_TIMEOUT_MS } from '../../src/core/control/client_recording.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { writeStatusFile } from '../../src/core/daemon/status.js'
import { dispatch } from '../../src/core/cli/dispatch.js'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ollama-policy-'))
  const configPath = path.join(root, 'hypaware-config.json')
  const stateRoot = path.join(root, 'hypaware')
  const control = path.join(stateRoot, 'config-control')
  const env = { HOME: root, HYP_HOME: root, HYP_CONFIG: configPath }
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/ollama' }] }))
  return { root, env, configPath, stateRoot, control, close: () => fs.rm(root, { recursive: true, force: true }) }
}

// @ref LLP 0474#recording [tests]: fresh strict owner policy preserves central precedence and refuses mutation before org policy is known
test('fresh policy follows enrollment, slot flips and disabled central ownership', async () => {
  const f = await fixture()
  try {
    const read = createClientRecordingPolicyReader({ env: f.env, plugin: '@hypaware/ollama' })
    assert.equal(read().recording, true)
    await fs.mkdir(f.control, { recursive: true })
    const seed = path.join(f.control, 'seed.json')
    await fs.writeFile(seed, JSON.stringify({ plugins: [{ name: '@hypaware/ollama', recording: false }] }))
    assert.deepEqual(read(), { recording: false, reason: 'recording_disabled' })
    await fs.writeFile(path.join(f.control, 'config.a.json'), JSON.stringify({ plugins: [{ name: '@hypaware/ollama', enabled: false }] }))
    await fs.symlink('config.a.json', path.join(f.control, 'active'))
    assert.deepEqual(read(), { recording: false, reason: 'owner_disabled' })
    await fs.writeFile(path.join(f.control, 'config.b.json'), JSON.stringify({ plugins: [{ name: '@hypaware/ollama' }] }))
    await fs.unlink(path.join(f.control, 'active'))
    await fs.symlink('config.b.json', path.join(f.control, 'active'))
    assert.equal(read().recording, true)
    const before = await fs.readFile(f.configPath, 'utf8')
    assert.equal((await writeClientRecording({ env: f.env, plugin: '@hypaware/ollama', recording: false })).status, 'central_managed')
    assert.equal(await fs.readFile(f.configPath, 'utf8'), before)
    await fs.writeFile(path.join(f.control, 'config.b.json'), '{')
    assert.deepEqual(read(), { recording: false, reason: 'policy_unreadable' })
    assert.equal((await writeClientRecording({ env: f.env, plugin: '@hypaware/ollama', recording: false })).status, 'failed')
    assert.equal(await fs.readFile(f.configPath, 'utf8'), before)
    await fs.unlink(seed)
    await fs.unlink(path.join(f.control, 'active'))
    await fs.writeFile(path.join(f.control, 'active'), 'not a slot link')
    assert.deepEqual(read(), { recording: false, reason: 'policy_unreadable' })
  } finally { await f.close() }
})

test('oversize, duplicate and malformed policies close only the strict Ollama reader', async () => {
  const f = await fixture()
  try {
    const read = createClientRecordingPolicyReader({ env: f.env, plugin: '@hypaware/ollama' })
    for (const document of [
      ' '.repeat(4 * 1024 * 1024 + 1), '{}', 'null',
      JSON.stringify({ plugins: [{ name: '@hypaware/ollama' }, { name: '@hypaware/ollama' }] }),
      JSON.stringify({ plugins: [{ name: '@hypaware/ollama', enabled: 'bad' }] }),
    ]) {
      await fs.writeFile(f.configPath, document)
      assert.equal(read().recording, false)
    }
    await fs.unlink(f.configPath)
    assert.deepEqual(read(), { recording: false, reason: 'owner_absent' })
  } finally { await f.close() }
})

test('proven stopped is confirmed, live uncertainty and malformed PID are unconfirmed', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await confirmOllamaRecording({ env: f.env, recording: false }), { confirmed: true, stopped: true })
    writeStatusFile(f.stateRoot, /** @type {any} */ ({ state: 'running', pid: process.pid }))
    assert.deepEqual(await confirmOllamaRecording({ env: f.env, recording: false }), { confirmed: false })
    await fs.writeFile(path.join(f.stateRoot, 'run', 'hypaware.pid'), '{')
    assert.deepEqual(await confirmOllamaRecording({ env: f.env, recording: false }), { confirmed: false })
  } finally { await f.close() }
})

/** @param {ReturnType<typeof fixture> extends Promise<infer T> ? T : never} f @param {number} port */
function advertise(f, port) {
  const startedAt = new Date().toISOString()
  writePidFile(f.stateRoot, { pid: process.pid, startedAt, runId: 'fixture', mode: 'foreground' })
  writeStatusFile(f.stateRoot, /** @type {any} */ ({ state: 'running', pid: process.pid, startedAt, runId: 'fixture', healthyAt: startedAt, uptimeMs: 0,
    sources: [{ name: 'ai-gateway', state: 'running', details: { listen_host: '::1', listen_port: port, control_routes: [RECORDING_ROUTE] } }],
  }))
}

test('CLI detach uses advertised actual host, confirms stop and preserves direct recipe', async () => {
  const f = await fixture()
  /** @type {any[]} */
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { requests.push({ path: req.url, body: JSON.parse(body) }); res.end('{"recording":false,"generation":"processor:2"}') })
  })
  try {
    await new Promise(resolve => server.listen(0, '::1', () => resolve(undefined)))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    advertise(f, address.port)
    let out = ''
    let err = ''
    const code = await dispatch(['client', 'detach', 'ollama'], { env: f.env, stdout: { write: value => { out += value; return true } }, stderr: { write: value => { err += value; return true } } })
    assert.equal(code, 0, err)
    assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins[0].recording, false)
    assert.deepEqual(requests, [{ path: '/_hypaware/recording/ollama', body: { recording: false } }])
    assert.match(out, /OLLAMA_HOST=.*11434/)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close() }
})

test('live missing control refuses success after saving off; retries remain off', async () => {
  const f = await fixture()
  try {
    advertise(f, 1)
    for (let index = 0; index < 2; index++) {
      let out = ''
      const code = await dispatch(['client', 'detach', 'ollama', '--json'], { env: f.env, stdout: { write: value => { out += value; return true } }, stderr: { write: () => true } })
      assert.equal(code, 1)
      assert.equal(JSON.parse(out).error_kind, 'recording_barrier_unconfirmed')
      assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins[0].recording, false)
    }
  } finally { await f.close() }
})

test('unresponsive or lost-ack HTTP is bounded by the real ten-second deadline', async () => {
  const f = await fixture()
  const server = http.createServer(req => req.resume())
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const at = Date.now()
    const result = await confirmOllamaRecording({ env: f.env, recording: false, endpoint: 'http://127.0.0.1:' + address.port })
    assert.deepEqual(result, { confirmed: false })
    assert.ok(Date.now() - at >= RECORDING_TIMEOUT_MS - 100)
    assert.ok(Date.now() - at < RECORDING_TIMEOUT_MS + 2000)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close() }
})

test('HTTP confirmation rejects malformed, oversize or mismatched receipts without growing retained bodies', async () => {
  const f = await fixture()
  let body = ''
  const server = http.createServer((req, res) => { req.resume(); res.end(body) })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const endpoint = 'http://127.0.0.1:' + address.port
    for (const ack of ['{', 'x'.repeat(1025), '{"recording":true,"generation":"a:1"}', '{"recording":false,"generation":""}', '{"recording":false,"generation":"SECRET invalid\\n"}']) {
      body = ack
      assert.deepEqual(await confirmOllamaRecording({ env: f.env, recording: false, endpoint }), { confirmed: false })
    }
    body = '{"recording":false,"generation":"processor:2"}'
    assert.deepEqual(await confirmOllamaRecording({ env: f.env, recording: false, endpoint }), { confirmed: true })
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close() }
})

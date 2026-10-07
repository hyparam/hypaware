// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'
import { checkOllamaReadiness, validateOllamaUpstream, routingRecipes, resolveOllamaRouting, runOllamaSetup } from '../../hypaware-core/plugins-workspace/ollama/src/setup.js'

async function fixture(t, handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

// @ref LLP 0474#setup [tests]: probes are direct discovery only, independent of executable evidence
test('readiness uses only version/tags at the preserved base and never executes PATH evidence', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ollama-ready-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  await fs.writeFile(path.join(home, 'ollama'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  const seen = []
  const root = await fixture(t, (req, res) => {
    seen.push([req.method, req.url])
    res.setHeader('content-type', 'application/json')
    res.end(req.url?.endsWith('/api/version') ? '{"version":"0.35.1"}' : '{"models":[{"name":"tiny:local"}]}')
  })
  const result = await checkOllamaReadiness({ upstream: `${root}/service/`, env: { PATH: home } })
  assert.equal(result.executable, true)
  assert.equal(result.service, 'ready')
  assert.equal(result.version, '0.35.1')
  assert.deepEqual(result.models, ['tiny:local'])
  assert.equal(result.inventory_complete, true)
  assert.deepEqual(seen, [['GET', '/service/api/version'], ['GET', '/service/api/tags']])
})

test('missing executable and empty model inventory are independent readiness states', async t => {
  const root = await fixture(t, (req, res) => res.end(req.url === '/api/version' ? '{"version":"0.35.1"}' : '{"models":[]}'))
  const result = await checkOllamaReadiness({ upstream: root, env: { PATH: '' } })
  assert.equal(result.executable, false)
  assert.equal(result.service, 'ready')
  assert.deepEqual(result.models, [])
  assert.equal(result.inventory_complete, true)
})

test('readiness caps/sanitizes inventory and reports truncation honestly', async t => {
  const root = await fixture(t, (req, res) => res.end(req.url === '/api/version'
    ? '{"version":"0.35.1"}'
    : JSON.stringify({ models: Array.from({ length: 25 }, (_, i) => ({ name: `model${i}\n\u001b[31m` })) })))
  const result = await checkOllamaReadiness({ upstream: root, env: { PATH: '' } })
  assert.equal(result.models.length, 20)
  assert.ok(result.models.every(s => !/[\r\n\u001b]/.test(s)))
  assert.equal(result.inventory_complete, false)
})

test('redirects and oversize bodies cannot advertise complete ready inventory', async t => {
  let redirected = false
  const root = await fixture(t, (req, res) => {
    if (req.url === '/redirected') { redirected = true; return res.end('{}') }
    res.writeHead(302, { location: '/redirected' }); res.end('{}')
  })
  const result = await checkOllamaReadiness({ upstream: root, env: { PATH: '' } })
  assert.equal(redirected, false)
  assert.notEqual(result.service, 'ready')
  const large = await fixture(t, (req, res) => res.end(req.url === '/api/version' ? '{"version":"0.35.1"}' : JSON.stringify({ models: [], junk: 'x'.repeat(1024 * 1024) })))
  const capped = await checkOllamaReadiness({ upstream: large, env: { PATH: '' } })
  assert.equal(capped.inventory_complete, false)
  assert.equal(capped.reason, 'probe_body_limit')
})

test('both probes and stalled bodies share one three-second deadline and close connections', async t => {
  const root = await fixture(t, (req, res) => { res.writeHead(200); res.write('{') })
  const before = Date.now()
  const result = await checkOllamaReadiness({ upstream: root, env: { PATH: '' } })
  assert.ok(Date.now() - before < 3800)
  assert.notEqual(result.service, 'ready')
  assert.equal(result.reason, 'probe_timeout')
})

test('version and tags share the deadline and aggregate retained byte limit', async t => {
  const delayed = await fixture(t, (req, res) => {
    const timer = setTimeout(() => res.end(req.url === '/api/version' ? '{"version":"0.35.1"}' : '{"models":[]}'), 1800)
    res.on('close', () => clearTimeout(timer))
  })
  const before = Date.now()
  const timed = await checkOllamaReadiness({ upstream: delayed, env: { PATH: '' } })
  assert.equal(timed.reason, 'probe_timeout')
  assert.ok(Date.now() - before < 3500)
  const large = await fixture(t, (req, res) => res.end(req.url === '/api/version'
    ? JSON.stringify({ version: '0.35.1', junk: 'x'.repeat(600000) })
    : JSON.stringify({ models: [], junk: 'x'.repeat(600000) })))
  const limited = await checkOllamaReadiness({ upstream: large, env: { PATH: '' } })
  assert.equal(limited.reason, 'probe_body_limit')
  assert.equal(limited.inventory_complete, false)
})

test('malformed and known self endpoints fail before probing, including loopback aliases', () => {
  for (const upstream of ['bad', 'ftp://localhost', 'http://user:password@localhost', 'http://localhost/path?token=x', 'http://localhost/path#x']) {
    assert.throws(() => validateOllamaUpstream(upstream, []), /upstream/)
  }
  for (const host of ['localhost', '127.0.0.1', '[::1]', '127.2.3.4', '[::ffff:127.0.0.1]']) {
    assert.throws(() => validateOllamaUpstream(`http://${host}:18521/ollama`, ['http://127.0.0.1:18521']), /collector/)
  }
  assert.equal(validateOllamaUpstream('http://localhost:21500/service/', ['http://127.0.0.1:18521']).href, 'http://localhost:21500/service/')
})

test('routing prints explicit capture root and preserved direct root for next CLI/SDK clients', () => {
  const result = routingRecipes('http://127.0.0.1:21522', 'http://localhost:21500/service/')
  assert.match(result.cli, /OLLAMA_HOST=.*21522\/ollama.*ollama run/)
  assert.match(result.sdk, /Client\(host=.*21522\/ollama/)
  assert.match(result.direct_cli, /OLLAMA_HOST=.*21500\/service\/.*ollama run/)
  assert.match(result.direct_sdk, /Client\(host=.*21500\/service\//)
})

async function installFixture(t, upstream = 'http://localhost:21500/service/') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ollama-setup-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const state = path.join(home, 'hypaware')
  await fs.mkdir(path.join(state, 'run'), { recursive: true })
  const config = /** @type {any} */ ({ version: 2, plugins: [
    { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:18521', upstreams: [{ name: 'ollama', base_url: upstream, path_prefix: '/api/chat', priority: 7 }] } },
    { name: '@hypaware/ollama', recording: false },
  ] })
  const configPath = path.join(home, 'config.json')
  await fs.writeFile(configPath, JSON.stringify(config))
  const env = { HOME: home, HYP_HOME: home, HYP_CONFIG: configPath, PATH: '' }
  const gateway = /** @type {any} */ ({ localEndpoint() { throw new Error('not bound') } })
  return { state, config, configPath, env, gateway }
}

async function setupCommand(f, argv) {
  let output = ''
  let error = ''
  const ctx = /** @type {any} */ ({ env: f.env, config: f.config,
    stdout: { write(value) { output += value } }, stderr: { write(value) { error += value } },
  })
  const code = await runOllamaSetup([...argv, '--json'], ctx, f.gateway)
  return { code, error, payload: output ? JSON.parse(output) : undefined }
}

test('attended not-ready setup retains selection, custom fields and off state without writes or inference', async t => {
  const requests = []
  const root = await fixture(t, (req, res) => { requests.push(req.url); res.writeHead(503); res.end('{}') })
  const f = await installFixture(t, `${root}/service/`)
  const before = await fs.readFile(f.configPath, 'utf8')
  const result = await setupCommand(f, [])
  assert.equal(result.code, 0)
  assert.equal(result.payload.recording, false)
  assert.equal(result.payload.service, 'unavailable')
  assert.equal(result.payload.confirmed, false)
  assert.equal(result.payload.next, 'hyp client attach ollama')
  assert.deepEqual(requests, ['/service/api/version'])
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before)
})

test('explicit upstream saves only the endpoint, preserves mode and backup, and reports restart required without a listener', async t => {
  const root = await fixture(t, (req, res) => res.end(req.url?.endsWith('/api/version') ? '{"version":"0.35.1"}' : '{"models":[]}'))
  const f = await installFixture(t)
  await fs.chmod(f.configPath, 0o640)
  const before = await fs.readFile(f.configPath, 'utf8')
  const result = await setupCommand(f, ['--upstream', `${root}/service/`])
  assert.equal(result.code, 0)
  assert.equal(result.payload.saved, true)
  assert.equal(result.payload.restart, 'required')
  assert.equal(result.payload.confirmed, false)
  assert.equal(result.payload.recording, false)
  assert.equal(await fs.readFile(result.payload.backup_path, 'utf8'), before)
  assert.equal((await fs.stat(f.configPath)).mode & 0o777, 0o640)
  const expected = structuredClone(f.config)
  expected.plugins[0].config.upstreams[0].base_url = `${root}/service/`
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')), expected)
  const again = await setupCommand(f, ['--upstream', `${root}/service/`])
  assert.equal(again.payload.saved, false)
  assert.equal(again.payload.backup_path, undefined)
})

test('invalid/self upstreams and corrupt current configuration fail without replacing bytes', async t => {
  const f = await installFixture(t)
  const before = await fs.readFile(f.configPath, 'utf8')
  for (const upstream of ['http://localhost:18521/ollama', 'http://user:private-token@localhost:21500', 'http://localhost:21500/?private-token=x']) {
    const result = await setupCommand(f, ['--upstream', upstream])
    assert.equal(result.code, 1)
    assert.equal(result.payload.saved, false)
    assert.equal(JSON.stringify(result).includes('private-token'), false)
    assert.equal(await fs.readFile(f.configPath, 'utf8'), before)
  }
  await fs.writeFile(f.configPath, '{broken')
  const result = await setupCommand(f, [])
  assert.equal(result.code, 1)
  assert.equal(await fs.readFile(f.configPath, 'utf8'), '{broken')
})

test('organization gateway ownership refuses an inert local upstream change', async t => {
  const f = await installFixture(t)
  await fs.mkdir(path.join(f.state, 'config-control'), { recursive: true })
  await fs.writeFile(path.join(f.state, 'config-control/seed.json'), JSON.stringify(f.config))
  const before = await fs.readFile(f.configPath, 'utf8')
  const result = await setupCommand(f, ['--upstream', 'http://localhost:22500/new'])
  assert.equal(result.code, 1)
  assert.match(result.payload.error, /Organization/)
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before)
})

test('native CLI parses fresh/add/repeat/from-file without attended probes and attach is explicit/idempotent', async t => {
  const f = await installFixture(t)
  await fs.rm(f.configPath)
  let probes = 0
  const root = await fixture(t, (req, res) => { probes++; res.end('{}') })
  const env = { ...isolatedClientEnv(process.env, f.env.HOME), HYP_HOME: f.env.HYP_HOME, HYP_CONFIG: f.configPath,
    PATH: '', HYP_NO_TUI: '1', OLLAMA_HOST: `${root}/ollama`,
  }
  const run = (argv) => promisify(execFile)(process.execPath, ['bin/hypaware.js', ...argv], { cwd: process.cwd(), env, timeout: 15000, maxBuffer: 1024 * 1024 })
  const flags = ['--no-daemon', '--no-backfill', '--force']
  const fresh = await run(['setup', '--source', 'ollama', '--export', 'keep-local', '--retention-days', '17', ...flags])
  assert.match(fresh.stdout, /Saved settings/)
  assert.doesNotMatch(fresh.stdout, /Ollama attached/)
  let config = JSON.parse(await fs.readFile(f.configPath, 'utf8'))
  assert.equal(config.plugins.find(p => p.name === '@hypaware/ai-gateway').config.upstreams.find(u => u.name === 'ollama').base_url, 'http://127.0.0.1:11434')
  config.plugins.find(p => p.name === '@hypaware/ollama').recording = false
  config.plugins.find(p => p.name === '@hypaware/ai-gateway').config.upstreams.find(u => u.name === 'ollama').base_url = `${root}/service/`
  config.plugins.push({ name: '@hypaware/otel' })
  config.auto_update = false
  await fs.writeFile(f.configPath, JSON.stringify(config))
  for (const argv of [['setup', '--source', 'ollama', ...flags], ['init', '--client', 'ollama', ...flags]]) {
    await run(argv)
    const next = JSON.parse(await fs.readFile(f.configPath, 'utf8'))
    assert.equal(next.plugins.find(p => p.name === '@hypaware/ollama').recording, false)
    assert.ok(next.plugins.some(p => p.name === '@hypaware/otel'))
    assert.equal(next.plugins.find(p => p.name === '@hypaware/ai-gateway').config.upstreams.find(u => u.name === 'ollama').base_url, `${root}/service/`)
    assert.equal(next.query.cache.retention.default_days, 17)
    assert.equal(next.auto_update, false)
  }
  const imported = path.join(f.env.HOME, 'supplied.json')
  await fs.writeFile(imported, JSON.stringify(config))
  await run(['setup', '--from-file', imported, ...flags])
  assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins.find(p => p.name === '@hypaware/ollama').recording, false)
  assert.equal(probes, 0, 'no readiness, inference, or discovery on unattended forms')
  for (let i = 0; i < 2; i++) {
    const attached = await run(['client', 'attach', 'ollama', '--json'])
    assert.match(attached.stdout, /"capture_root"/)
    assert.notEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')).plugins.find(p => p.name === '@hypaware/ollama').recording, false)
  }
  assert.equal(probes, 0, 'attach prints receipts without probing or inference')
  assert.equal(await fs.stat(path.join(f.env.HOME, '.ollama')).then(() => true, () => false), false, 'no client settings marker')
  const attended = JSON.parse((await run(['ollama', 'setup', '--json'])).stdout)
  assert.equal(attended.direct_root, `${root}/service/`, 'named upstream wins over ambient routed host')
  assert.equal(attended.recording, true)
  assert.equal(attended.confirmed, false)
  assert.equal(probes, 1, 'only attended discovery runs, malformed version stops without retry')
})

test('route confirmation needs a fresh matching gateway generation, actual port and exact transport', async t => {
  const f = await installFixture(t)
  const pid = { pid: process.pid, runId: 'test-generation', startedAt: new Date().toISOString() }
  const details = { host: '127.0.0.1', port: 21522, upstream_aliases: [{ name: 'ollama-native', canonical: 'ollama', path_prefix: '/ollama', base_url: 'http://localhost:21500/service/' }] }
  const snapshot = { ...pid, state: 'healthy', healthyAt: new Date().toISOString(), uptimeMs: 0, sources: [{ name: 'ai-gateway', state: 'started', details }] }
  await fs.writeFile(path.join(f.state, 'run/hypaware.pid'), JSON.stringify(pid))
  async function write(value) { await fs.writeFile(path.join(f.state, 'run/status.json'), JSON.stringify(value)) }
  await write(snapshot)
  assert.equal(resolveOllamaRouting(f.env, f.config, f.gateway).confirmed, true)
  assert.equal(resolveOllamaRouting(f.env, f.config, f.gateway).capture_root, 'http://127.0.0.1:21522/ollama')
  for (const changed of [
    { ...snapshot, runId: 'old-generation' },
    { ...snapshot, pid: process.pid + 100000 },
    { ...snapshot, healthyAt: new Date(Date.now() - 360000).toISOString() },
    { ...snapshot, state: 'stopped' },
    { ...snapshot, sources: [{ name: 'ai-gateway', state: 'started', details: { ...details, listening: false, upstream_aliases: [] } }] },
  ]) {
    await write(changed)
    assert.equal(resolveOllamaRouting(f.env, f.config, f.gateway).confirmed, false)
    assert.equal(resolveOllamaRouting(f.env, f.config, f.gateway).gateway_bound, false)
  }
  await write(snapshot)
  assert.equal(resolveOllamaRouting(f.env, f.config, /** @type {any} */ ({ localEndpoint: () => 'http://127.0.0.1:22222' })).confirmed, false)
  for (const upstream of ['http://localhost:21501/service/', 'http://localhost:21500/other/']) {
    const changed = structuredClone(f.config)
    changed.plugins[0].config.upstreams[0].base_url = upstream
    assert.equal(resolveOllamaRouting(f.env, changed, f.gateway).confirmed, false)
  }
  await fs.rm(path.join(f.state, 'run/hypaware.pid'))
  const absent = resolveOllamaRouting(f.env, f.config, f.gateway)
  assert.equal(absent.confirmed, false)
  assert.equal(absent.gateway_bound, false)
  assert.match(absent.direct_cli, /21500\/service\//)
})

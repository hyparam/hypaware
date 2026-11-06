// @ts-check

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

import { dispatch } from '../../../src/core/cli/dispatch.js'
import { runRemoteLogin } from '../../../src/core/cli/remote_commands.js'
import { verbToCommand } from '../../../src/core/cli/verb_command.js'
import { collectHypAwareStatus } from '../../../src/core/daemon/status.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { querySqlVerb } from '../../../src/core/query/verb.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { readCredentials, writeServiceRecord } from '../../../src/core/remote/credentials.js'
import { readKeptServiceToken } from '../../../src/core/remote/service_token.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { createSinkDriver } from '../../../src/core/sinks/driver.js'
import { writeOtelFixturePlugin } from './central_forward_outbox.js'

/**
 * @import { AddressInfo } from 'node:net'
 * @import { IncomingMessage } from 'node:http'
 * @import { ActivePlugin, ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Hermetic smoke for an org service-account collector (LLP 0547). One
 * in-process server plays central (identity bootstrap/refresh, ingest) and
 * the query surface (identity token, MCP).
 *
 * Collector lane, in a temp HYP_HOME: `hyp join <url> -` with an `hsa_`
 * secret keeps it in `service-token`; the real central sink bootstraps from
 * it and uploads a row; the server forgets the JWT and the sink recovers
 * with one re-bootstrap from the kept record, same gateway id; the server
 * answers `403 service_token_revoked` and the sink stops, persists the stop,
 * and sends nothing more; `hyp status` names the stop; `hyp leave` removes
 * the record.
 *
 * Remote lane: `hyp remote login --token-file` stores `kind: 'service'`, a
 * query attaches its JWT, and once the token is revoked the next exchange's
 * error names the code.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0547#verification [tests]: the collector and remote lanes end to end against a fake central
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('central_service_token_collector: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')
  }
  const server = await startFakeCentral()
  const origin = `http://127.0.0.1:${server.port}`
  const stateDir = harness.stateDir
  const recordPath = path.join(stateDir, 'plugins', '@hypaware/central', 'service-token')
  /** @type {Array<{ event: string, attrs: any }>} */
  const sinkLogs = []
  /**
   * @param {string} step
   * @param {() => Promise<void>} fn
   */
  const step = (step, fn) => runRoot('smoke.step', {
    [Attr.COMPONENT]: 'smoke',
    [Attr.OPERATION]: 'service_token_collector',
    [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: step,
    [Attr.DEV_RUN_ID]: harness.devRunId,
    status: 'ok',
  }, fn)

  try {
    // ----- smoke_step: join -----
    await step('join', async () => {
      const r = await cli(['join', origin, '-', '--no-daemon'], SECRET)
      expect.that('join: exits 0', r.code, (v) => v === 0)
      expect.that('join: the secret is never printed', r.out + r.err, (s) => !s.includes(SECRET))
      const kept = await readKeptServiceToken(recordPath)
      expect.that('join: service-token is kept beside identity.json', kept.state, (v) => v === 'ok')
      expect.that('join: service-token is 0600', (await fs.stat(recordPath)).mode & 0o777, (v) => v === 0o600)
    })

    const kernel = createKernelRuntime({ commandRegistry: createCommandRegistry(), cacheRoot: path.join(stateDir, 'cache') })
    const driver = createSinkDriver({ sinkRegistry: kernel.sinks, queryRegistry: kernel.query, storage: kernel.storage, stateRoot: stateDir })
    let tickAt = Date.parse('2026-02-15T10:00:00Z')
    const tick = async () => {
      tickAt += 60_000
      return driver.tick({ now: new Date(tickAt), force: true })
    }
    let rowSeq = 0
    const appendRow = () => kernel.storage.appendRows(kernel.storage.cacheTablePath('logs'), LOG_COLUMNS, [
      { dev_run_id: harness.devRunId, body: `row ${++rowSeq}` },
    ])

    // ----- smoke_step: upload -----
    await step('upload', async () => {
      await activateSink({ harness, kernel, url: origin, sinkLogs })
      const report = await tick()
      expect.that('upload: the sink exported', report.sinks[0]?.status, (v) => v === 'exported')
      expect.that('upload: one bootstrap, from the kept secret', server.bootstrapTokens(), (v) => v.length === 1 && v[0] === SECRET)
      expect.that('upload: one accepted ingest', server.acceptedIngests(), (v) => v === 1)
    })

    // ----- smoke_step: rebootstrap -----
    await step('rebootstrap', async () => {
      server.state.validJwt = ''
      await appendRow()
      const report = await tick()
      expect.that('rebootstrap: the sink exported after recovering', report.sinks[0]?.status, (v) => v === 'exported')
      expect.that('rebootstrap: exactly one more bootstrap, from the kept secret', server.bootstrapTokens(), (v) => v.length === 2 && v[1] === SECRET)
      expect.that('rebootstrap: the retried ingest was accepted', server.acceptedIngests(), (v) => v === 2)
      const identity = JSON.parse(await fs.readFile(path.join(stateDir, 'plugins', '@hypaware/central', 'identity.json'), 'utf8'))
      expect.that('rebootstrap: same gateway id', identity.gateway_id, (v) => v === GATEWAY_ID)
      expect.that('rebootstrap: recovery was logged', sinkLogs.map((l) => l.event), (v) => v.includes('central.identity.service_token_recover'))
    })

    // ----- smoke_step: revoke -----
    await step('revoke', async () => {
      server.state.collectorRevoked = true
      await appendRow()
      await tick()
      const kept = await readKeptServiceToken(recordPath)
      expect.that('revoke: the stop is persisted', kept.state === 'ok' ? kept.record.stopped_code : kept.state, (v) => v === 'service_token_revoked')
      expect.that('revoke: the stop was logged', sinkLogs.find((l) => l.event === 'central.identity.stopped')?.attrs?.error_kind, (v) => v === 'service_token_revoked')
      expect.that('revoke: no log carries the secret', JSON.stringify(sinkLogs), (s) => !s.includes(SECRET))
      const before = server.received.length
      await appendRow()
      await tick()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect.that('revoke: a stopped sink sends nothing more', server.received.length - before, (v) => v === 0)
    })

    // ----- smoke_step: status -----
    await step('status', async () => {
      const report = await collectHypAwareStatus({ env: process.env })
      const stopped = report.diagnostics.filter((d) => d.kind === 'central_service_token_stopped')
      expect.that('status: names the revoked token', stopped.map((d) => d.message), (v) => v.length === 1 && /stopped: service token revoked$/.test(v[0]))
    })

    // ----- smoke_step: leave -----
    await step('leave', async () => {
      const r = await cli(['leave'])
      expect.that('leave: exits 0', r.code, (v) => v === 0)
      expect.that('leave: service-token is removed', await fs.stat(recordPath).then(() => true, () => false), (v) => v === false)
    })

    // ----- smoke_step: remote_login -----
    const tokenFile = path.join(harness.tmpDir, 'service-token.txt')
    await fs.writeFile(tokenFile, `${SECRET}\n`, { mode: 0o600 })
    const remoteConfig = { version: 2, query: { remotes: { prod: { url: origin } } } }
    const remoteConfigPath = path.join(harness.tmpDir, 'remote-config.json')
    await fs.writeFile(remoteConfigPath, JSON.stringify(remoteConfig))
    await step('remote_login', async () => {
      const ctx = cmdCtx(remoteConfig, remoteConfigPath)
      const code = await runRemoteLogin(['prod', '--token-file', tokenFile], ctx.ctx)
      expect.that('remote_login: exits 0', code, (v) => v === 0)
      expect.that('remote_login: names the org', ctx.out.join(''), (s) => /stored service token for 'prod' \(org acme\)/.test(s))
      expect.that('remote_login: the secret is never printed', ctx.out.join('') + ctx.err.join(''), (s) => !s.includes(SECRET))
      expect.that('remote_login: stored as kind service', (await readCredentials(stateDir)).prod?.kind, (v) => v === 'service')
    })

    // ----- smoke_step: remote_query -----
    const query = verbToCommand(querySqlVerb)
    await step('remote_query', async () => {
      const ctx = cmdCtx(remoteConfig, remoteConfigPath)
      const code = await query.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], ctx.ctx)
      expect.that('remote_query: exits 0 with the service JWT', code, (v) => v === 0)
      expect.that('remote_query: rows returned', ctx.out.join(''), (s) => /"n":\s?1/.test(s))
    })

    // ----- smoke_step: remote_revoked -----
    await step('remote_revoked', async () => {
      server.state.remoteRevoked = true
      const rec = /** @type {any} */ ((await readCredentials(stateDir)).prod)
      await writeServiceRecord(stateDir, 'prod', { secret: rec.secret, accessJwt: rec.accessJwt, expiresAt: '2000-01-01T00:00:00Z', org: rec.org })
      const ctx = cmdCtx(remoteConfig, remoteConfigPath)
      const code = await query.run(['SELECT 1', '--remote', 'prod', '--format', 'json'], ctx.ctx)
      expect.that('remote_revoked: query exits nonzero', code, (v) => v !== 0)
      expect.that('remote_revoked: the error names the code', ctx.err.join(''), (s) => /refused the service token \(service_token_revoked\)/.test(s))
      expect.that('remote_revoked: the secret is never printed', ctx.err.join(''), (s) => !s.includes(SECRET))
    })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve(undefined)))
    await obs.shutdown()
  }

  const traces = await expect.traces()
  const steps = new Set(traces.filter((t) => t.name === 'smoke.step').map((t) => t.attributes?.smoke_step))
  for (const name of ['join', 'upload', 'rebootstrap', 'revoke', 'status', 'leave', 'remote_login', 'remote_query', 'remote_revoked']) {
    expect.that(`telemetry: smoke_step ${name} span emitted`, steps.has(name), (v) => v === true)
  }
}

const SECRET = `hsa_0123456789abcdef_${'S'.repeat(43)}`
const GATEWAY_ID = 'gw-svc'
/** @type {ColumnSpec[]} */
const LOG_COLUMNS = [
  { name: 'dev_run_id', type: 'STRING', nullable: false },
  { name: 'body', type: 'STRING', nullable: false },
]

/**
 * @param {string[]} argv
 * @param {string} [stdinText]
 */
async function cli(argv, stdinText) {
  let out = ''
  let err = ''
  /** @type {any} */
  const stdin = stdinText === undefined
    ? { isTTY: true }
    : { isTTY: false, async *[Symbol.asyncIterator]() { yield stdinText } }
  const code = await dispatch(argv, {
    stdout: { write: (/** @type {unknown} */ s) => { out += String(s); return true } },
    stderr: { write: (/** @type {unknown} */ s) => { err += String(s); return true } },
    stdin,
    env: process.env,
  })
  return { code, out, err }
}

/**
 * @param {object} config
 * @param {string} configPath
 */
function cmdCtx(config, configPath) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const ctx = /** @type {any} */ ({
    env: { HYP_HOME: process.env.HYP_HOME, HYP_CONFIG: configPath },
    config,
    query: {}, storage: {},
    stdin: { isTTY: true },
    stdout: { write: (/** @type {string} */ s) => { out.push(s) } },
    stderr: { write: (/** @type {string} */ s) => { err.push(s) } },
  })
  return { ctx, out, err }
}

/**
 * Activate the otel fixture and the real central plugin, then instantiate
 * the sink the way a joined daemon would: no bootstrap token in config, the
 * default identity path, so the kept record is what it enrolls from.
 *
 * @param {{ harness: any, kernel: any, url: string, sinkLogs: Array<{ event: string, attrs: any }> }} args
 */
async function activateSink({ harness, kernel, url, sinkLogs }) {
  const otelDir = path.join(harness.tmpDir, 'plugins', 'test-otel')
  await writeOtelFixturePlugin(otelDir, harness.devRunId)
  const centralDir = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace', 'central')
  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })
  const { loaded } = await loadManifests([otelDir, centralDir])
  await activatePlugins({
    plugins: loaded.map((l) => ({ manifest: l.manifest, rootDir: l.rootDir })),
    stateRoot: harness.stateDir,
    runId: harness.devRunId,
    runtime: kernel,
    tmpRoot,
  })
  const contribution = kernel.sinks.getContribution('@hypaware/central', 'forward')
  /** @type {ActivePlugin} */
  const plugin = {
    name: '@hypaware/central',
    version: '1.0.0',
    manifest: { schema_version: 1, name: '@hypaware/central', version: '1.0.0', hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './index.js' },
    rootDir: centralDir,
  }
  /** @param {string} event @param {any} [attrs] */
  const record = (event, attrs) => { sinkLogs.push({ event, attrs }) }
  await kernel.sinks.instantiate({
    kind: 'request',
    instanceName: 'forward',
    contribution,
    config: { schedule: '* * * * *', url, identity: {} },
    plugin,
    paths: {
      rootDir: centralDir,
      stateDir: path.join(harness.stateDir, 'plugins', '@hypaware/central'),
      cacheDir: path.join(harness.stateDir, 'cache', 'plugins', '@hypaware/central'),
      tempDir: path.join(tmpRoot, 'central'),
    },
    log: { debug: record, info: record, warn: record, error: record },
  })
}

/**
 * The fake central. Bootstrap mints for the one known secret with a stable
 * gateway id; refresh and ingest accept only the current JWT. Clearing
 * `validJwt` is a server-side expiry; the two `*Revoked` flags answer
 * `403 service_token_revoked` on their lane.
 *
 * @returns {Promise<http.Server & { port: number, state: any, received: Array<{ path: string, body: any }>, bootstrapTokens: () => string[], acceptedIngests: () => number }>}
 */
async function startFakeCentral() {
  const state = { jwtSeq: 0, validJwt: '', remoteJwt: '', collectorRevoked: false, remoteRevoked: false, accepted: 0 }
  /** @type {Array<{ path: string, body: any }>} */
  const received = []
  const FUTURE = Math.floor(Date.parse('2999-01-01T00:00:00Z') / 1000)
  const mint = () => fakeJwt(GATEWAY_ID, ++state.jwtSeq)

  const server = /** @type {any} */ (http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (/** @type {any} */ obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    const bearer = String(req.headers.authorization ?? '')
    readBody(req).then((body) => {
      received.push({ path: url.pathname, body })
      const revoked = () => json({ error: 'service_token_revoked' }, 403)
      if (url.pathname === '/v1/identity/bootstrap') {
        if (state.collectorRevoked) return revoked()
        if (body?.bootstrap_token !== SECRET) return json({ error: 'bootstrap_token_invalid' }, 401)
        state.validJwt = mint()
        return json({ jwt: state.validJwt, expires_at: FUTURE, org: 'acme' })
      }
      if (url.pathname === '/v1/identity/refresh') {
        if (state.collectorRevoked) return revoked()
        if (!state.validJwt || bearer !== `Bearer ${state.validJwt}`) return json({ error: 'token_expired' }, 401)
        state.validJwt = mint()
        return json({ jwt: state.validJwt, expires_at: FUTURE })
      }
      if (url.pathname.startsWith('/v1/ingest/')) {
        if (state.collectorRevoked) return revoked()
        if (!state.validJwt || bearer !== `Bearer ${state.validJwt}`) return json({ error: 'token_expired' }, 401)
        state.accepted += 1
        res.writeHead(202)
        return res.end()
      }
      if (url.pathname === '/v1/identity/token' && body?.grant_type === 'service_token') {
        if (state.remoteRevoked) return revoked()
        if (body.service_token !== SECRET) return json({ error: 'invalid_grant' }, 401)
        state.remoteJwt = `remote-${++state.jwtSeq}`
        return json({ access_jwt: state.remoteJwt, expires_at: FUTURE, org: 'acme' })
      }
      if (url.pathname === '/v1/mcp') {
        if (body?.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mcp-1' })
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }))
        }
        if (body?.method === 'notifications/initialized') {
          res.writeHead(202)
          return res.end()
        }
        if (body?.method === 'tools/call') {
          if (bearer !== `Bearer ${state.remoteJwt}`) return json({ jsonrpc: '2.0', id: body.id }, 401)
          return json({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { columns: ['n'], rows: [{ n: 1 }] }, isError: false } })
        }
        return json({ jsonrpc: '2.0', id: body?.id, error: { code: -32601, message: 'no' } })
      }
      return json({ error: 'not_found' }, 404)
    })
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  server.port = /** @type {AddressInfo} */ (server.address()).port
  server.state = state
  server.received = received
  server.bootstrapTokens = () => received.filter((r) => r.path === '/v1/identity/bootstrap').map((r) => r.body?.bootstrap_token)
  server.acceptedIngests = () => state.accepted
  return server
}

/**
 * A JWT the sink can decode for its gateway id (it never verifies one).
 *
 * @param {string} subject
 * @param {number} seq
 */
function fakeJwt(subject, seq) {
  const part = (/** @type {object} */ obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: subject, seq })}.sig`
}

/**
 * @param {IncomingMessage} req
 * @returns {Promise<any>}
 */
function readBody(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */ const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch {
        resolve(text)
      }
    })
  })
}

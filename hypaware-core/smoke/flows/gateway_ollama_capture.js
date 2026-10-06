// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

import { runGatewayDaemon } from '../../../src/core/daemon/gateway.js'
import { gatewaySourceDetails } from '../../../src/core/daemon/status.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { getLogger, installObservability } from '../../../src/core/observability/index.js'
import { SPOOL_DIR } from '../../../src/core/cache/spool.js'
import { CAPTURE_BYTES } from '../../plugins-workspace/ai-gateway/src/process_transport.js'

/** @import { AddressInfo } from 'node:net' */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
/** @param {() => unknown | Promise<unknown>} condition @param {string} label */
async function until(condition, label) {
  const deadline = Date.now() + 30_000
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`gateway_ollama_capture: timed out at ${label}`)
    await sleep(50)
  }
}

const message = (content, done = false) => ({ model: 'smoke-ollama', message: { role: 'assistant', content }, done })
const jsonResponse = JSON.stringify({ ...message('', true), done_reason: 'stop', prompt_eval_count: 16, prompt_eval_cached_count: 11, eval_count: 0 })
const streamResponse = [message('café '), { ...message('🙂', true), done_reason: 'length', prompt_eval_count: 16, prompt_eval_cached_count: 0, eval_count: 3 }].map(record => JSON.stringify(record)).join('\r\n')
const contextMessages = [{ role: 'system', content: '' }, { role: 'user', content: '' }, { role: 'assistant', content: '' }, { role: 'user', content: 'same' }, { role: 'user', content: 'same' }]

/**
 * Actual gateway and processing child, local fixture only. The adapter is
 * loaded from ordinary explicit config, never an in-process fake projector.
 * @ref LLP 0400#t2 [tests]: faithful native wire, persisted snapshots, actual JSONL reasons and reversible collector lifecycle
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const log = getLogger('smoke')
  const step = smoke_step => log.info('smoke.step', { dev_run_id: harness.devRunId, smoke_name: harness.smokeName, smoke_step })
  const upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const which = req.headers['x-smoke-case']
      if (which === 'error') {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end('{"error":"SECRET upstream message"}')
      } else if (which === 'abort') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(JSON.stringify(message('SECRET partial')) + '\n')
        const timer = setInterval(() => res.write(JSON.stringify(message(' partial')) + '\n'), 50)
        res.on('close', () => clearInterval(timer))
      } else if (which === 'stream' || which === 'malformed') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        const bytes = Buffer.from(which === 'stream' ? streamResponse : JSON.stringify(message('SECRET partial')) + '\n{"done":true')
        // Split every byte, including the accented character and emoji.
        for (let index = 0; index < bytes.length; index++) res.write(bytes.subarray(index, index + 1))
        res.end()
      } else if (which === 'usage') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ...message('invalid counter', true), done_reason: 'stop', prompt_eval_count: 16, eval_count: -1 }))
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(jsonResponse)
      }
    })
  })
  const configPath = path.join(harness.hypHome, 'hypaware-config.json')
  const env = { ...process.env, HOME: harness.tmpDir, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath, HYP_DEV_TELEMETRY: '1', DEV_RUN_ID: harness.devRunId }
  /** @type {Awaited<ReturnType<typeof runGatewayDaemon>> | undefined} */
  let handle
  const abort = new AbortController()
  try {
    step('fixture_start')
    await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', () => resolve(undefined)) })
    const direct = `http://127.0.0.1:${/** @type {AddressInfo} */ (upstream.address()).port}`
    /** @param {string} base */
    const configure = base => fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false, query: { cache: { maintenance: { enabled: false } } }, plugins: [
      { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:0', upstreams: [{ name: 'ollama', base_url: base, path_prefix: '/api/chat', provider: 'ollama' }] } },
      { name: '@hypaware/ollama' },
    ] }))
    /** @returns {Promise<string>} */
    const boot = async () => {
      handle = await runGatewayDaemon({ hypHome: harness.hypHome, configPath, env, runId: harness.devRunId, tickIntervalMs: 100, installSignalHandlers: false })
      await until(() => handle?.snapshot().processes?.processing.state === 'healthy', 'processor ready')
      assert.ok(handle.snapshot().processes?.processing.pid !== process.pid)
      const endpoint = gatewaySourceDetails(handle.snapshot().sources)
      assert.ok(endpoint)
      return `http://${endpoint.host}:${endpoint.port}`
    }
    await configure(direct)
    step('split_boot')
    let base = await boot()
    const processorPid = handle?.snapshot().processes?.processing.pid
    const body = JSON.stringify({ model: 'smoke-ollama', messages: contextMessages, stream: false })
    /** @param {string} target @param {string} which @param {string} payload */
    const post = (target, which, payload) => fetch(`${target}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hyp-dev-run-id': harness.devRunId, 'x-smoke-case': which }, body: payload })
    const processed = async () => (await expect.logs()).filter(record => record.body === 'aigw.exchange')
    const diagnostic = async event => (await expect.logs()).filter(record => record.body === event)
    const waitExchanges = count => until(async () => (await processed()).length >= count, `processed exchanges ${count}`)

    step('write_failure')
    // Block only a new disposable spool file; no production fault switch or fixture plugin.
    const table = handle?.runtime.storage.cacheTablePath('ai_gateway_messages', ['all'])
    assert.ok(table)
    const blockedFile = path.join(table, SPOOL_DIR, 'active.jsonl')
    await fs.mkdir(blockedFile, { recursive: true })
    const failedWrite = await post(base, 'json', body)
    assert.equal(failedWrite.status, 200)
    assert.equal(await failedWrite.text(), jsonResponse)
    await until(async () => (await diagnostic('aigw.exchange_write_failed')).length === 1, 'actual source write diagnostic')
    await fs.rmdir(blockedFile)

    step('json_snapshots')
    for (let index = 0; index < 2; index++) {
      const response = await post(base, 'json', body)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), jsonResponse)
      await waitExchanges(index + 1)
    }
    step('ndjson')
    const streamingBody = JSON.stringify({ model: 'smoke-ollama', messages: [{ role: 'user', content: 'stream' }] })
    const stream = await post(base, 'stream', streamingBody)
    assert.equal(stream.status, 200)
    assert.equal(await stream.text(), streamResponse)
    await waitExchanges(3)
    step('invalid_usage')
    const usage = await post(base, 'usage', JSON.stringify({ model: 'smoke-ollama', messages: [{ role: 'user', content: 'usage' }], stream: false }))
    assert.equal(usage.status, 200)
    assert.ok((await usage.text()).includes('invalid counter'))
    await waitExchanges(4)
    await until(async () => (await diagnostic('plugin.ollama.invalid_usage')).length === 1, 'actual adapter counter diagnostic')

    step('unsupported_and_failed')
    const unsupported = await post(base, 'json', JSON.stringify({ model: 'smoke-ollama', messages: [{ role: 'user', content: 'SECRET unsupported', images: ['SECRET image'] }], stream: false }))
    assert.equal(unsupported.status, 200)
    assert.equal(await unsupported.text(), jsonResponse)
    const malformed = await post(base, 'malformed', streamingBody)
    assert.equal(malformed.status, 200)
    assert.equal(await malformed.text(), JSON.stringify(message('SECRET partial')) + '\n{"done":true')
    const error = await post(base, 'error', body)
    assert.equal(error.status, 503)
    assert.equal(await error.text(), '{"error":"SECRET upstream message"}')
    const partial = await fetch(`${base}/api/chat`, { method: 'POST', body: streamingBody, headers: { 'x-smoke-case': 'abort', 'x-hyp-dev-run-id': harness.devRunId }, signal: abort.signal })
    assert.ok(partial.body)
    const reader = partial.body.getReader()
    assert.ok((await reader.read()).value?.length)
    abort.abort()
    await reader.cancel().catch(() => {})
    await waitExchanges(8)
    const drops = await diagnostic('plugin.ollama.capture_dropped')
    for (const reason of ['unsupported_shape', 'malformed_stream', 'http_error', 'transport_error']) assert.ok(drops.some(record => record.attributes.reason === reason), `missing ${reason}`)
    assert.doesNotMatch(JSON.stringify(drops), /SECRET|partial|unsupported.*image/)
    assert.ok(drops.every(record => record.attributes.component === 'ollama' && record.attributes.operation === 'project_exchange' && record.attributes.status === 'dropped' && /^[a-f0-9]{32}$/.test(record.attributes.exchange_id)))
    const files = await fs.readdir(harness.telemetryDir)
    assert.ok(files.includes(`logs-${processorPid}.jsonl`), 'processor did not inherit local JSONL diagnostics')
    const processorLogs = await fs.readFile(path.join(harness.telemetryDir, `logs-${processorPid}.jsonl`), 'utf8')
    assert.ok(processorLogs.includes('plugin.ollama.capture_dropped'))
    assert.ok(processorLogs.includes('plugin.ollama.invalid_usage'))
    assert.ok(processorLogs.includes('aigw.exchange_write_failed'))
    assert.ok(processorLogs.includes(harness.devRunId), 'processor diagnostics lack stable DEV_RUN_ID')

    step('capture_budget_abandonment')
    const large = await post(base, 'json', JSON.stringify({ model: 'smoke-ollama', messages: [{ role: 'user', content: 'x'.repeat(CAPTURE_BYTES) }], stream: false }))
    assert.equal(large.status, 200)
    assert.equal(await large.text(), jsonResponse)
    await until(() => Number(/** @type {Record<string, unknown> | undefined} */ (handle?.snapshot().sources.find(source => source.name === 'ai-gateway')?.details)?.capture_dropped ?? 0) > 0, 'transport capture drop count')
    const daemonLog = await fs.readFile(path.join(harness.stateDir, 'logs', 'daemon.log'), 'utf8')
    assert.ok(daemonLog.includes('gateway.capture_dropped'), 'transport drops must use gateway channel')

    step('persist')
    await handle?.stop()
    await handle?.done
    /** @returns {Promise<any[]>} */
    const query = async () => {
      let output = ''
      let errors = ''
      const sql = "select session_id, request_id, message_id, previous_message_id, message_index, part_index, content_text, role, provider, model, cwd, repo_root, attributes, raw_frame, status from ai_gateway_messages order by request_id, message_index, part_index"
      const code = await dispatch(['query', 'sql', sql, '--refresh', 'always', '--format', 'json'], { env, stdout: { write: value => { output += value; return true } }, stderr: { write: value => { errors += value; return true } } })
      assert.equal(code, 0, errors)
      assert.equal(errors, '')
      return JSON.parse(output)
    }
    const saved = await query()
    assert.equal(saved.length, 16, 'only two six-row snapshots, one stream and one invalid-counter exchange persist')
    const groups = Map.groupBy(saved, row => row.request_id)
    assert.equal(groups.size, 4)
    for (const [id, entries] of groups) {
      for (let index = 0; index < entries.length; index++) {
        const row = entries[index]
        assert.equal(row.provider, 'ollama')
        assert.equal(row.model, 'smoke-ollama')
        assert.equal(row.session_id, id)
        assert.equal(row.message_index, index)
        assert.equal(row.part_index, 0)
        assert.equal(row.cwd, null)
        assert.equal(row.repo_root, null)
        assert.deepEqual(asJson(row.previous_message_id), index ? [entries[index - 1].message_id] : [])
        assert.equal(asJson(row.attributes).gateway.exchange_id, id)
        if (index < entries.length - 1) assert.equal(asJson(row.attributes).usage, undefined)
      }
      if (entries.length === 6) {
        assert.deepEqual(entries.map(row => row.role), ['system', 'user', 'assistant', 'user', 'user', 'assistant'])
        assert.deepEqual(entries.map(row => row.content_text), [null, null, null, 'same', 'same', null])
        assert.deepEqual(asJson(entries[5].attributes).usage, { input_tokens: 5, cache_read_tokens: 11, output_tokens: 0 })
      }
    }
    const newStream = saved.find(row => row.content_text === 'café 🙂')
    assert.ok(newStream)
    assert.deepEqual(asJson(newStream.attributes).usage, { input_tokens: 16, cache_read_tokens: 0, output_tokens: 3 })
    assert.equal(asJson(newStream.status).finish_reason, 'length')
    const invalidCounter = saved.find(row => row.content_text === 'invalid counter')
    assert.ok(invalidCounter)
    assert.equal(asJson(invalidCounter.attributes).usage, undefined)
    assert.equal(asJson(invalidCounter.raw_frame).prompt_eval_count, 16)
    assert.equal(asJson(invalidCounter.raw_frame).eval_count, -1)

    step('refused_endpoint')
    const refused = http.createServer()
    await new Promise(resolve => refused.listen(0, '127.0.0.1', () => resolve(undefined)))
    const refusedPort = /** @type {AddressInfo} */ (refused.address()).port
    await new Promise(resolve => refused.close(resolve))
    await configure(`http://127.0.0.1:${refusedPort}`)
    base = await boot()
    const refusal = await post(base, 'json', body)
    assert.equal(refusal.status, 502)
    await refusal.text()
    await until(async () => (await diagnostic('plugin.ollama.capture_dropped')).some(record => record.attributes.reason === 'transport_error' && record.attributes.exchange_id !== drops.find(record => record.attributes.reason === 'transport_error')?.attributes.exchange_id), 'refused upstream diagnostic')
    await handle?.stop()
    await handle?.done
    assert.deepEqual(await query(), saved, 'failure/restart changed persisted snapshots')

    step('restart_same_home')
    await configure(direct)
    await boot()
    await handle?.stop()
    await handle?.done
    assert.deepEqual(await query(), saved, 'collector restart alone duplicated or lost rows')
    step('direct_after_stop')
    const directResult = await post(direct, 'json', body)
    assert.equal(directResult.status, 200)
    assert.equal(await directResult.text(), jsonResponse)
    assert.deepEqual(await query(), saved, 'direct request after stop was captured')
    step('complete')
    await obs.shutdown()
    expect.that('smoke records split lifecycle and completed direct request step', await expect.logs(), records => records.some(record => record.body === 'smoke.step' && record.attributes.smoke_step === 'direct_after_stop' && record.attributes.smoke_name === harness.smokeName))
  } finally {
    abort.abort()
    await handle?.stop()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
    await obs.shutdown()
  }
}

/** @param {any} value */
function asJson(value) { return typeof value === 'string' ? JSON.parse(value) : value }

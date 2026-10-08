// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

import { runGatewayDaemon } from '../../../src/core/daemon/gateway.js'
import { gatewaySourceDetails } from '../../../src/core/daemon/status.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { runWizardPick } from '../../../src/core/cli/wizard/pick.js'
import { discoverBundledPlugins } from '../../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../../src/core/plugin_catalog.js'
import { getLogger, installObservability } from '../../../src/core/observability/index.js'
import { SPOOL_DIR } from '../../../src/core/cache/spool.js'
import { CAPTURE_BYTES } from '../../plugins-workspace/ai-gateway/src/process_transport.js'
import { aiGatewayTablePath } from '../../plugins-workspace/ai-gateway/src/dataset.js'

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
 * loaded through ordinary setup/config, never an in-process fake projector.
 * @ref LLP 0475#t5 [tests]: normal setup, faithful native wire, committed verification and reversible collector lifecycle remain one existing flow
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const log = getLogger('smoke')
  const step = smoke_step => log.info('smoke.step', { dev_run_id: harness.devRunId, smoke_name: harness.smokeName, smoke_step })
  /** @type {Map<string, http.ServerResponse>} */
  const held = new Map()
  const upstream = http.createServer((req, res) => {
    let requestBody = ''
    if (req.url?.endsWith('/api/generate')) req.on('data', chunk => { if (requestBody.length < 1024 * 1024) requestBody += chunk })
    else req.resume()
    req.on('end', () => {
      const route = req.url?.replace(/^\/service/, '')
      if (route === '/api/version') { res.end('{"version":"0.35.1"}'); return }
      if (route === '/api/tags') { res.end('{"models":[{"name":"smoke-ollama"}]}'); return }
      if (route === '/v1/messages') {
        res.end(JSON.stringify({ id: 'msg-smoke-other', type: 'message', role: 'assistant', model: 'smoke-claude', content: [{ type: 'text', text: 'other client answer' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }))
        return
      }
      if (route === '/api/generate') {
        const request = JSON.parse(requestBody)
        const records = request.stream === false
          ? [{ model: 'smoke-ollama', response: 'generated answer', done: true, done_reason: 'stop', eval_count: 2 }]
          : [{ model: 'smoke-ollama', response: 'generated ', done: false }, { model: 'smoke-ollama', response: 'answer', done: true, done_reason: 'stop', eval_count: 2 }]
        res.setHeader('content-type', request.stream === false ? 'application/json' : 'application/x-ndjson')
        res.end(records.map(record => JSON.stringify(record)).join('\n'))
        return
      }
      const which = req.headers['x-smoke-case']
      if (typeof which === 'string' && which.startsWith('held_')) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(JSON.stringify(message('held answer')) + '\n')
        held.set(which, res)
      } else if (which === 'error') {
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
        // Split UTF-8 and CRLF without flooding the bounded IPC frame credits.
        const cuts = which === 'stream'
          ? [bytes.indexOf(Buffer.from('é')) + 1, bytes.indexOf(Buffer.from('\r\n')) + 1, bytes.indexOf(Buffer.from('🙂')) + 2, bytes.length]
          : [Math.floor(bytes.length / 2), bytes.length]
        let offset = 0
        for (const end of cuts) {
          res.write(bytes.subarray(offset, end))
          offset = end
        }
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
    const direct = `http://127.0.0.1:${/** @type {AddressInfo} */ (upstream.address()).port}/service/`
    /** @param {string[]} argv */
    const command = async argv => {
      let output = ''
      let errors = ''
      const code = await dispatch(argv, { env, cwd: harness.tmpDir, stdout: { write: value => { output += value; return true } }, stderr: { write: value => { errors += value; return true } } })
      assert.equal(code, 0, errors + output)
      return { output, errors }
    }
    // @ref LLP 0474#setup [tests]: normal picker command paths retain existing client/upstream settings and do not perform unattended inference
    step('fresh_picker')
    const bundled = await discoverBundledPlugins()
    const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
    const picked = await runWizardPick({ env, catalog, stdout: { write: () => true }, stderr: { write: () => true },
      prompt: async question => {
        assert.ok(question.options.some(option => option.value === 'ollama'), 'normal picker omitted Ollama')
        return ['ollama']
      },
    })
    assert.equal(picked.exitCode, 0)
    assert.ok(picked.sourcesPicked?.includes('ollama'))
    step('fresh_setup')
    const setupFlags = ['--no-daemon', '--no-backfill', '--force']
    await command(['setup', '--source', 'ollama', '--export', 'keep-local', '--retention-days', '17', ...setupFlags])
    const selected = JSON.parse(await fs.readFile(configPath, 'utf8'))
    assert.ok(selected.plugins.some(entry => entry.name === '@hypaware/ollama'))
    const gateway = selected.plugins.find(entry => entry.name === '@hypaware/ai-gateway')
    gateway.config.listen = '127.0.0.1:0'
    gateway.config.upstreams.find(entry => entry.name === 'ollama').base_url = direct
    gateway.config.upstreams.push({ name: 'echo-anthropic', base_url: direct, path_prefix: '/v1/messages', priority: 1000 })
    selected.plugins.push({ name: '@hypaware/claude' })
    selected.auto_update = false
    selected.query.cache.maintenance = { enabled: false }
    await fs.writeFile(configPath, JSON.stringify(selected))
    step('repeat_setup_preserves_other_client_and_custom_upstream')
    await command(['setup', '--source', 'ollama', ...setupFlags])
    const repeated = JSON.parse(await fs.readFile(configPath, 'utf8'))
    assert.ok(repeated.plugins.some(entry => entry.name === '@hypaware/claude'))
    assert.deepEqual(repeated.plugins.find(entry => entry.name === '@hypaware/ai-gateway').config.upstreams, gateway.config.upstreams)
    assert.equal(repeated.query.cache.retention.default_days, 17)
    const discovered = JSON.parse((await command(['ollama', 'setup', '--json'])).output)
    assert.equal(discovered.direct_root, direct)
    assert.equal(discovered.confirmed, false)
    assert.equal(discovered.service, 'ready')
    assert.deepEqual(discovered.models, ['smoke-ollama'])
    /** @param {string} directRoot */
    const configure = async directRoot => {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
      config.plugins.find(entry => entry.name === '@hypaware/ai-gateway').config.upstreams.find(entry => entry.name === 'ollama').base_url = directRoot
      await fs.writeFile(configPath, JSON.stringify(config))
    }
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
    const post = (target, which, payload) => fetch(`${target.replace(/\/+$/, '')}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hyp-dev-run-id': harness.devRunId, 'x-smoke-case': which }, body: payload })
    const processed = async () => (await expect.logs()).filter(record => record.body === 'aigw.exchange')
    const diagnostic = async event => (await expect.logs()).filter(record => record.body === event)
    const waitExchanges = count => until(async () => (await processed()).length >= count, `processed exchanges ${count}`)

    step('write_failure')
    // Block only a new disposable spool file; no production fault switch or fixture plugin.
    assert.ok(handle)
    const table = aiGatewayTablePath(handle.runtime.storage)
    const blockedFile = path.join(table, SPOOL_DIR, 'active.jsonl')
    await fs.mkdir(blockedFile, { recursive: true })
    const failedWrite = await post(base, 'json', body)
    assert.equal(failedWrite.status, 200)
    assert.equal(await failedWrite.text(), jsonResponse)
    await until(async () => (await diagnostic('aigw.exchange_write_failed')).length === 1, 'actual source write diagnostic')
    await until(() => /** @type {any} */ (handle?.snapshot().sources.find(source => source.name === 'ai-gateway')?.details)?.capture_outcomes?.some(entry => entry.reason === 'append_failure'), 'default append failure summary')
    assert.match((await command(['client', 'status', 'ollama', '--json'])).output, /append_failure/)
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
    const projected = await diagnostic('plugin.ollama.capture_projected')
    assert.equal(projected.length, 5, 'projection includes the failed append, so it cannot claim persistence')
    assert.ok(projected.every(record => record.attributes.status === 'ok' && record.attributes.reason === 'text'))

    step('unsupported_and_failed')
    const unsupported = await post(base, 'json', JSON.stringify({ model: 'smoke-ollama', messages: [{ role: 'user', content: 'SECRET unsupported', tool_calls: [{ function: { name: 'SECRET tool' } }] }], stream: false }))
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
    // @ref LLP 0021#the-attribute-contract [tests]: emitted status uses the logger's fixed vocabulary; dropped normalizes to failed
    assert.ok(drops.every(record => record.attributes.component === 'ollama' && record.attributes.operation === 'project_exchange' && record.attributes.status === 'failed' && /^[a-f0-9]{32}$/.test(record.attributes.exchange_id)))
    const files = await fs.readdir(harness.telemetryDir)
    assert.ok(files.includes(`logs-${processorPid}.jsonl`), 'processor did not inherit local JSONL diagnostics')
    const processorLogs = await fs.readFile(path.join(harness.telemetryDir, `logs-${processorPid}.jsonl`), 'utf8')
    assert.ok(processorLogs.includes('plugin.ollama.capture_dropped'))
    assert.ok(processorLogs.includes('plugin.ollama.invalid_usage'))
    assert.ok(processorLogs.includes('aigw.exchange_write_failed'))
    assert.ok(processorLogs.includes(harness.devRunId), 'processor diagnostics lack stable DEV_RUN_ID')

    step('capture_budget_abandonment')
    assert.equal(Number(/** @type {Record<string, unknown> | undefined} */ (handle?.snapshot().sources.find(source => source.name === 'ai-gateway')?.details)?.capture_dropped ?? 0), 0, 'unexpected transport loss before intentional budget overflow')
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
      const code = await dispatch(['query', 'sql', sql, '--refresh', 'always', '--format', 'json', '--max-bytes', '262144'], { env, stdout: { write: value => { output += value; return true } }, stderr: { write: value => { errors += value; return true } } })
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

    // @ref LLP 0475#t3 [tests]: real CLI, gateway HTTP, processing child generation and persisted cache across detach/attach/restart
    step('recording_held_off')
    base = await boot()
    const lifecycleBody = JSON.stringify({ model: 'smoke-ollama', messages: [{ role: 'user', content: 'lifecycle question' }] })
    /** @param {'attach' | 'detach'} action */
    const client = async action => {
      let output = ''
      let errors = ''
      const code = await dispatch(['client', action, 'ollama', '--json'], { env, stdout: { write: value => { output += value; return true } }, stderr: { write: value => { errors += value; return true } } })
      assert.equal(code, 0, errors + output)
      const receipt = JSON.parse(output)
      assert.equal(receipt.status, 'ok')
      return receipt
    }
    const heldOff = await post(base, 'held_off', lifecycleBody)
    await until(() => held.has('held_off'), 'held stream before off')
    await client('detach')
    held.get('held_off')?.end(JSON.stringify(message('', true)) + '\n')
    assert.match(await heldOff.text(), /held answer/)
    for (const route of ['/api/chat', '/ollama/api/chat']) {
      const passthrough = await fetch(base + route, { method: 'POST', body: lifecycleBody })
      assert.equal(passthrough.status, 200)
      assert.equal(await passthrough.text(), jsonResponse)
    }
    await client('detach')
    await handle?.stop()
    await handle?.done
    assert.deepEqual(await query(), saved, 'off receipt admitted late history')
    assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).plugins.find(entry => entry.name === '@hypaware/ollama').recording, false)

    step('recording_restart_off')
    base = await boot()
    assert.equal(/** @type {any} */ (handle?.snapshot().sources.find(source => source.name === 'ai-gateway')?.details)?.recording_enabled, false)
    const restartOff = await post(base, 'json', lifecycleBody)
    assert.equal(await restartOff.text(), jsonResponse)
    await client('attach')
    step('recording_held_reattach')
    const heldAttach = await fetch(base + '/ollama/api/chat', { method: 'POST', body: lifecycleBody, headers: { 'x-smoke-case': 'held_reattach' } })
    await until(() => held.has('held_reattach'), 'held stream before reattach')
    await client('detach')
    await client('attach')
    held.get('held_reattach')?.end(JSON.stringify(message('', true)) + '\n')
    assert.match(await heldAttach.text(), /held answer/)
    const fresh = await post(base, 'json', lifecycleBody)
    assert.equal(await fresh.text(), jsonResponse)
    await until(async () => (await diagnostic('plugin.ollama.capture_projected')).length >= projected.length + 1, 'fresh generation projected')
    await client('detach')
    await until(() => /** @type {any} */ (handle?.snapshot().sources.find(source => source.name === 'ai-gateway')?.details)?.capture_outcomes?.some(entry => entry.last_persisted && entry.persisted_id), 'processor persistence summary reached gateway status')
    const outcomes = /** @type {any[]} */ (/** @type {any} */ (handle?.snapshot().sources.find(source => source.name === 'ai-gateway')?.details)?.capture_outcomes ?? [])
    assert.ok(outcomes.length <= 32)
    assert.ok(outcomes.some(entry => entry.last_persisted && entry.persisted_id))
    await handle?.stop()
    await handle?.done
    const afterLifecycle = await query()
    assert.equal(afterLifecycle.length, saved.length + 2)
    const newRows = afterLifecycle.filter(row => !saved.some(old => old.message_id === row.message_id))
    assert.deepEqual(newRows.map(row => row.content_text), ['lifecycle question', null])
    assert.ok(afterLifecycle.every(row => row.content_text !== 'held answer'))
    step('recording_complete')

    // @ref LLP 0476#confirmation [tests]: tiny fresh capture without sinks proves service settlement and policy-visible committed verification
    step('live_setup_and_fresh_verify')
    base = await boot()
    await client('attach')
    const live = JSON.parse((await command(['ollama', 'setup', '--json'])).output)
    assert.equal(live.confirmed, true)
    assert.equal(live.capture_root, base + '/ollama')
    assert.equal(live.direct_root, direct)
    await until(() => /** @type {any} */ (handle?.snapshot().sources.find(source => source.name === 'ai-gateway')?.details)?.recording_enabled === true, 'recording status after attach')
    const verified = await command(['ollama', 'verify', '--model', 'smoke-ollama', '--json'])
    assert.match(verified.errors, /fixed prompt.*Configured sinks.*earlier and other-client/)
    const check = JSON.parse(verified.output)
    assert.equal(check.status, 'persisted')
    const confirmedRows = await query()
    const pair = confirmedRows.filter(row => row.request_id === check.request_id)
    assert.equal(pair.length, 2)
    assert.deepEqual(pair.map(row => row.role), ['user', 'assistant'])
    assert.equal(pair[0].content_text, 'Reply with OK. This is a HypAware capture check.')
    assert.match(asJson(pair[0].attributes).dev_run_id, /^ollama-check-/)

    step('native_generate_stream_and_nonstream')
    for (const stream of [false, true]) {
      const generated = await fetch(live.capture_root + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hyp-dev-run-id': harness.devRunId }, body: JSON.stringify({ model: 'smoke-ollama', prompt: `generate ${stream}`, think: false, stream }) })
      assert.equal(generated.status, 200)
      assert.match(await generated.text(), /generated/)
    }
    await client('detach')
    const generatedRows = await query()
    assert.equal(generatedRows.length, confirmedRows.length + 4)
    assert.equal(generatedRows.filter(row => row.content_text === 'generated answer').length, 2)

    step('other_client_records_while_ollama_off')
    const other = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'user-agent': 'claude-cli/1.0', 'x-hyp-dev-run-id': harness.devRunId }, body: JSON.stringify({ model: 'smoke-claude', messages: [{ role: 'user', content: 'other client question' }], max_tokens: 16, stream: false }) })
    assert.equal(other.status, 200)
    await other.text()
    await until(async () => (await diagnostic('aigw.exchange')).some(record => record.attributes.upstream === 'echo-anthropic'), 'other client processed while Ollama off')
    await handle?.stop()
    await handle?.done
    const withOther = await query()
    assert.deepEqual(withOther.filter(row => row.provider === 'ollama'), generatedRows)
    assert.ok(withOther.some(row => row.content_text === 'other client answer'))

    step('verified_history_survives_restart_without_growth')
    await boot()
    await handle?.stop()
    await handle?.done
    assert.deepEqual(await query(), withOther)
    step('direct_custom_host_after_final_stop')
    const recovered = await post(direct, 'json', body)
    assert.equal(recovered.status, 200)
    assert.equal(await recovered.text(), jsonResponse)
    assert.deepEqual(await query(), withOther)
    step('complete')
    await obs.shutdown()
    expect.that('native alias route reached real projector and append', await expect.logs(), records => records.some(record => record.body === 'aigw.exchange' && record.attributes.upstream === 'ollama-native' && record.attributes.path === '/ollama/api/generate' && record.attributes.rows_written === 2 && record.attributes.dev_run_id === harness.devRunId))
    expect.that('fresh verify records its exact committed exchange', await expect.logs(), records => records.some(record => record.body === 'plugin.ollama.verify' && record.attributes.reason === 'persisted' && record.attributes.exchange_id === check.request_id))
    expect.that('actual barriers suppress off and old-generation capture', await expect.logs(), records => ['recording_disabled', 'stale_generation'].every(reason => records.some(record => record.body === 'aigw.capture_outcome' && record.attributes.reason === reason && record.attributes.dev_run_id === harness.devRunId)))
    expect.that('ordinary cache append completed', await expect.traces(), records => records.some(record => record.name === 'cache.append' && record.attributes.hyp_dataset === 'ai_gateway_messages' && record.attributes.status === 'ok'))
    expect.that('smoke proves ordinary setup, fresh verification and another client preserved', await expect.logs(), records => ['fresh_picker', 'fresh_setup', 'live_setup_and_fresh_verify', 'other_client_records_while_ollama_off', 'verified_history_survives_restart_without_growth'].every(step => records.some(record => record.body === 'smoke.step' && record.attributes.smoke_step === step)))
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

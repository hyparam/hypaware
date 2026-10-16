// Throwaway parity experiment. No changes to the installed daemon or schema.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import assert from 'node:assert/strict'
import { fork, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'

const exec = promisify(execFile)
const root = path.resolve(import.meta.dirname, '../..')
const worker = path.join(import.meta.dirname, 'agent.mjs')

if (process.argv[2] === 'collector') {
  const { runDaemon } = await import('../../src/core/daemon/runtime.js')
  const handle = await runDaemon({ hypHome: process.env.HYP_HOME, configPath: process.env.HYP_CONFIG,
    env: process.env, runId: process.env.DEV_RUN_ID, installSignalHandlers: false })
  const source = handle.snapshot().sources.find(s => s.name === 'otlp')
  if (!source?.details?.listen_port) throw new Error('collector failed to bind')
  process.send({ port: source.details.listen_port })
  process.on('message', async () => {
    await handle.stop()
    await handle.done
    const { installObservability } = await import('../../src/core/observability/index.js')
    await installObservability().shutdown()
    process.exit(0)
  })
} else {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-langgraph-poc-'))
  const home = path.join(output, 'home')
  await fs.mkdir(home)
  const env = isolatedClientEnv(process.env, home)
  // Tracing is entirely local. Do not inherit a LangSmith/OTEL export target.
  for (const key of Object.keys(env)) {
    if (/^(LANGSMITH_|LANGCHAIN_|OTEL_)/.test(key)) delete env[key]
  }
  Object.assign(env, { LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false',
    LANGCHAIN_CALLBACKS_BACKGROUND: 'false', HYP_DEV_TELEMETRY: '1',
    DEV_RUN_ID: `langgraph-poc-${Date.now()}`, OTEL_SERVICE_NAME: 'hypaware-dev' })
  env.HYP_CONFIG = path.join(env.HYP_HOME, 'hypaware-config.json')
  await fs.mkdir(env.HYP_HOME, { recursive: true })
  const pending = path.join(output, 'pending')
  await fs.mkdir(pending)
  let collector
  let proxy
  let port = 0
  const findings = { devRunId: env.DEV_RUN_ID, output, scenarios: [], checks: [] }
  console.log(`Artifacts: ${output}`)
  async function record(step, detail) {
    await fs.appendFile(path.join(output, 'steps.jsonl'), JSON.stringify({
      dev_run_id: env.DEV_RUN_ID, smoke_name: 'langgraph_parity_poc', smoke_step: step, ...detail,
    }) + '\n')
    console.log(JSON.stringify({ step, ...detail }))
  }
  async function start() {
    await fs.writeFile(env.HYP_CONFIG, JSON.stringify({ version: 2,
      plugins: [{ name: '@hypaware/otel', config: { listen_host: '127.0.0.1', listen_port: port } }],
      query: { cache: { retention: { default_days: 30 } } },
    }))
    collector = fork(import.meta.filename, ['collector'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    for (const stream of [collector.stdout, collector.stderr]) {
      stream.on('data', data => fs.appendFile(path.join(output, 'collector.log'), data).catch(() => {}))
    }
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('collector startup timeout')), 30000)
      collector.once('message', msg => { clearTimeout(timer); resolve(msg.port) })
      collector.once('exit', code => { clearTimeout(timer); reject(new Error(`collector exited ${code}; inspect collector.log`)) })
      collector.once('error', reject)
    })
    await record('collector_started', { port })
  }
  async function stop(crash = false) {
    if (!collector || collector.exitCode !== null || collector.signalCode !== null) return
    const child = collector
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('collector stop timeout')) }, 20000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      if (crash) child.kill('SIGKILL')
      else child.send('stop')
    })
    collector = undefined
    await record(crash ? 'collector_killed' : 'collector_stopped', {})
  }
  async function agent(mode, scenario, destination = `http://127.0.0.1:${port}`) {
    const result = await exec(process.execPath, [worker, mode, pending, env.DEV_RUN_ID, scenario, destination], {
      env, timeout: 120000, maxBuffer: 1024 * 1024,
    })
    if (result.stderr) await fs.appendFile(path.join(output, 'agent.log'), result.stderr)
    const lines = result.stdout.trim().split('\n')
    if (lines.length > 1) await fs.appendFile(path.join(output, 'agent.log'), lines.slice(0, -1).join('\n') + '\n')
    const parsed = JSON.parse(lines.at(-1))
    await record(scenario, parsed)
    if (mode !== 'flush') findings.scenarios.push(parsed)
    return parsed
  }
  async function query(args) {
    const result = await exec(process.execPath, [path.join(root, 'bin/hypaware.js'), ...args], {
      env, timeout: 60000, maxBuffer: 5 * 1024 * 1024,
    })
    if (result.stderr) await fs.appendFile(path.join(output, 'query.log'), result.stderr)
    return result.stdout
  }
  try {
    await start()
    const online = await agent('fixture', 'online')
    assert.equal(online.delivery.pending, 0)
    await stop(true)
    // The agent completes and exits while delivery fails. Replay is a NEW process.
    const offline = await agent('fixture', 'outage')
    assert.equal(offline.delivery.sent, 0)
    assert.equal(offline.delivery.pending, offline.completedSpans)
    assert.equal(offline.toolAttempts, 3, 'one failed and two successful tool executions')
    await start()
    const recovered = await agent('flush', 'recovery')
    assert.equal(recovered.sent, offline.completedSpans)
    assert.equal(recovered.pending, 0)
    const repeated = await agent('flush', 'empty_replay')
    assert.equal(repeated.sent, 0)
    if (process.argv.includes('--live')) {
      assert.ok(env.OPENAI_API_KEY, '--live requires OPENAI_API_KEY')
      const live = await agent('live', 'live_models')
      assert.equal(live.delivery.pending, 0)
    }

    // Establish ambiguous delivery with one real batch, then sever only its ACK.
    let lostAckBatch
    proxy = http.createServer(async (req, res) => {
      try {
        const parts = []
        for await (const part of req) parts.push(part)
        lostAckBatch = JSON.parse(Buffer.concat(parts))
        const upstream = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(lostAckBatch), signal: AbortSignal.timeout(10000),
        })
        assert.equal(upstream.status, 200)
        await upstream.text()
        res.destroy()
      } catch (error) { res.destroy(error) }
    })
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const ambiguous = await agent('fixture', 'lost_ack', `http://127.0.0.1:${proxy.address().port}`)
    assert.ok(ambiguous.delivery.pending > 0)
    assert.ok(lostAckBatch)
    await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections() })
    proxy = undefined
    await agent('flush', 'retry_lost_ack')
    findings.acknowledgementLostSpans = lostAckBatch.resourceSpans[0].scopeSpans[0].spans.length
    await stop()

    await fs.writeFile(path.join(output, 'cache-status.txt'), await query(['cache', 'status']))
    await fs.writeFile(path.join(output, 'traces-schema.txt'), await query(['query', 'schema', 'traces']))
    const rows = JSON.parse(await query(['query', 'sql',
      `select * from traces where JSON_VALUE(attributes, '$.dev_run_id') = '${env.DEV_RUN_ID}'`,
      '--refresh', 'always', '--format', 'json', '--max-cell', '0', '--max-bytes', '0']))
    await fs.writeFile(path.join(output, 'captured-rows.json'), JSON.stringify(rows, null, 2))
    const byId = new Map(rows.map(r => [r.spanId, r]))
    for (const row of rows) {
      if (row.parentSpanId) {
        assert.ok(byId.has(row.parentSpanId), `missing parent for ${row.name}`)
        assert.equal(byId.get(row.parentSpanId).traceId, row.traceId)
      }
      assert.ok(row.durationMs >= 0)
      assert.ok(row.attributes['langsmith.metadata.thread_id'])
    }
    for (const scenario of findings.scenarios) {
      const expected = JSON.parse(await fs.readFile(path.join(output, `${scenario.scenario}-expected.json`)))
      const captured = rows.filter(r => r.attributes.smoke_step === scenario.scenario)
      const unique = [...new Map(captured.map(r => [r.spanId, r])).values()]
      assert.equal(unique.length, expected.completedSpans)
      assert.equal(unique.filter(r => !r.parentSpanId).length, 1, 'one supervisor root')
      assert.equal(new Set(unique.map(r => r.traceId)).size, 1, 'nested agents share their root trace')
      const models = unique.filter(r => r.attributes['langsmith.span.kind'] === 'llm')
      assert.equal(models.length, expected.outputs.length)
      const branches = new Set()
      for (const model of models) {
        const outputMessages = JSON.parse(model.attributes['gen_ai.output.messages'])
        assert.ok(outputMessages.every(m => expected.outputs.some(e => JSON.stringify(e) === JSON.stringify(m))),
          'callback messages survive the actual collector and SQL read')
        assert.ok(JSON.parse(model.attributes['gen_ai.input.messages']).length)
        assert.ok(model.attributes['gen_ai.usage.input_tokens'] > 0)
        assert.ok(model.attributes['gen_ai.usage.output_tokens'] > 0)
        let ancestor = model
        for (let depth = 0; ancestor && depth <= unique.length; depth++) {
          if (['researcher', 'reviewer'].includes(ancestor.name)) branches.add(ancestor.name)
          ancestor = byId.get(ancestor.parentSpanId)
          assert.ok(depth < unique.length, 'acyclic parent chain')
        }
      }
      assert.deepEqual([...branches].sort(), ['researcher', 'reviewer'])
      assert.equal(new Set(models.map(r => r.attributes['gen_ai.request.model'])).size, 2)
      assert.ok(unique.some(r => r.name === 'researcher'))
      assert.ok(unique.some(r => r.name === 'reviewer'))
      const tools = unique.filter(r => r.attributes['langsmith.span.kind'] === 'tool')
      assert.equal(tools.length, expected.toolAttempts)
      const toolCallIds = new Set(expected.outputs.flatMap(m => (m.tool_calls ?? []).map(t => t.id)))
      for (const tool of tools) assert.ok(toolCallIds.has(tool.attributes['gen_ai.tool.call.id']))
      for (const tool of tools.filter(r => r.status.code === 1)) {
        assert.equal(tool.attributes['gen_ai.tool.call.result'], '42')
        const args = JSON.parse(tool.attributes['gen_ai.tool.call.arguments'])
        assert.deepEqual(args, { a: 19, b: 23 })
        assert.ok(tool.attributes['gen_ai.tool.call.id'])
      }
      if (scenario.scenario === 'outage') assert.ok(tools.some(r => r.status.code === 2))
      const check = { scenario: scenario.scenario, spans: captured.length, uniqueSpans: unique.length,
        modelCalls: models.length, models: [...new Set(models.map(r => r.attributes['gen_ai.request.model']))],
        providers: [...new Set(models.map(r => r.attributes['gen_ai.provider.name']))],
        toolExecutions: tools.length, errors: unique.filter(r => r.status.code === 2).length }
      findings.checks.push(check)
    }
    const lost = findings.checks.find(r => r.scenario === 'lost_ack')
    findings.duplicateSpans = lost.spans - lost.uniqueSpans
    // This is an observed result, not an assumption that the receiver deduplicates.
    assert.equal(findings.duplicateSpans, findings.acknowledgementLostSpans)
    for (const check of findings.checks.filter(r => r.scenario !== 'lost_ack')) assert.equal(check.spans, check.uniqueSpans)
    findings.status = 'passed'
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(findings, null, 2))
    console.log(JSON.stringify(findings, null, 2))
  } catch (error) {
    await record('failed', { error: error.message })
    throw error
  } finally {
    if (proxy) { proxy.close(); proxy.closeAllConnections() }
    await stop()
  }
}

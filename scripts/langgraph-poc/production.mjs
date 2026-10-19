// Exercise the bundled plugin with real LangGraph callbacks in a child process.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import { fork, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { attachLangGraph } from '../../hypaware-core/plugins-workspace/langgraph/src/attach.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'
import { journalPath, pendingSlots, readSlot, publish } from '../../hypaware-core/plugins-workspace/langgraph/src/journal.js'
const exec = promisify(execFile)

if (process.argv[2] === 'collector') {
  const { runDaemon } = await import('../../src/core/daemon/runtime.js')
  const handle = await runDaemon({ env: process.env, installSignalHandlers: false })
  process.send?.('ready')
  process.on('message', async () => { await handle.stop(); await handle.done; process.exit(0) })
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-langgraph-production-'))
  const home = path.join(root, 'home')
  await fs.mkdir(home)
  const env = isolatedClientEnv(process.env, home)
  for (const key of Object.keys(env)) if (/^(LANGSMITH_|LANGCHAIN_|OTEL_)/.test(key)) delete env[key]
  const hypHome = path.join(home, '.hyp')
  const configPath = path.join(hypHome, 'hypaware-config.json')
  Object.assign(env, { HYP_HOME: hypHome, HYP_CONFIG: configPath, HYP_LANGGRAPH_PRODUCTION: '1',
    LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', HYP_DEV_TELEMETRY: '1', DEV_RUN_ID: `langgraph-production-${Date.now()}` })
  await fs.mkdir(hypHome, { recursive: true })
  const reserve = net.createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', () => resolve(undefined)))
  const port = /** @type {net.AddressInfo} */ (reserve.address()).port
  await new Promise(resolve => reserve.close(() => resolve(undefined)))
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/langgraph', config: { listen_port: port } }] }))
  const directory = journalPath(path.join(hypHome, 'hypaware'))
  const mode = process.argv.includes('--live') ? 'live' : 'fixture'
  const python = process.argv.includes('--python')
  const invocation = process.argv.includes('--async') ? 'async' : 'sync'
  const runId = env.DEV_RUN_ID ?? 'test'
  console.log(`Artifacts: ${root}`)
  const attached = python ? await attachLangGraph({ env }) : undefined
  const agent = await exec(python ? process.env.HYP_LANGGRAPH_PYTHON ?? '/tmp/hypaware-langgraph-python-deps/bin/python' : process.execPath,
    python ? [path.join(import.meta.dirname, 'python_agent.py'), mode, attached?.settingsPath ?? '', `${runId}:outage`, invocation]
      : [path.join(import.meta.dirname, 'agent.mjs'), mode, path.join(root, 'unused'), runId, 'outage', 'unused'],
    { env: { ...env, HYP_LANGGRAPH_NODE: process.execPath, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 180000, maxBuffer: 1024 * 1024 })
  await fs.writeFile(path.join(root, 'agent.log'), agent.stdout + agent.stderr)
  const result = JSON.parse(agent.stdout.trim().split('\n').at(-1) ?? '{}')
  assert.equal(result.recorder.dropped, 0)
  const saved = await Promise.all((await pendingSlots(directory)).map(s => readSlot(directory, s)))
  assert.ok(saved.length >= 6, 'producer exited leaving completed records for recovery')
  let collector
  async function start() {
    collector = fork(import.meta.filename, ['collector'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    collector.stdout.on('data', b => fs.appendFile(path.join(root, 'collector.log'), b).catch(() => {}))
    collector.stderr.on('data', b => fs.appendFile(path.join(root, 'collector.log'), b).catch(() => {}))
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('collector startup timeout')), 30000)
      collector.once('message', () => { clearTimeout(timer); resolve(undefined) })
      collector.once('exit', () => { clearTimeout(timer); reject(new Error('collector exited before ready')) })
    })
    for (let i = 0; i < 100 && (await pendingSlots(directory)).length; i++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await pendingSlots(directory)).length, 0)
  }
  async function stop() {
    const child = collector
    await new Promise(resolve => { child.once('exit', () => resolve(undefined)); child.send('stop') })
    collector = undefined
  }
  async function rows() {
    const output = await exec(process.execPath, [path.resolve(import.meta.dirname, '../../bin/hypaware.js'),
      'query', 'sql', 'select * from ai_gateway_messages', '--refresh', 'always', '--format', 'json'], { env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    return JSON.parse(output.stdout)
  }
  try {
    await start()
    await stop()
    const first = await rows()
    assert.ok(first.length >= 10)
    assert.equal(first.filter(r => r.attributes?.usage).length, 4)
    assert.ok(first.some(r => r.is_sidechain && r.parent_thread_id))
    assert.ok(first.some(r => r.tool_result_for && r.content_text === '42'))
    assert.ok(first.filter(r => r.tool_result_for).every(r => r.tool_args?.a === 19 && r.tool_args?.b === 23))
    assert.ok(first.every(r => r.cwd && r.tools?.length === 2))
    assert.ok(first.some(r => r.is_error))
    for (const projection of saved) await publish(directory, { version: 1, projection })
    await start()
    await stop()
    const replayed = await rows()
    assert.equal(replayed.length, first.length)
    const telemetryDir = path.join(hypHome, 'hypaware/dev-telemetry')
    const logs = (await Promise.all((await fs.readdir(telemetryDir)).filter(n => /^logs-.*\.jsonl$/.test(n))
      .map(n => fs.readFile(path.join(telemetryDir, n), 'utf8'))))
      .flatMap(body => body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
    const drains = logs.filter(l => l.body === 'langgraph.journal.drain' && l.attributes?.dev_run_id === runId)
    assert.ok(drains.some(l => Number(l.attributes.rows_written) === first.length), 'telemetry confirms recovery writes')
    assert.ok(drains.some(l => Number(l.attributes.rows_skipped) === first.length), 'telemetry confirms duplicate skips')
    const evidence = { status: 'passed', mode, language: python ? 'python' : 'javascript', invocation, records: first.length, usageRows: 4,
      telemetryVerified: true,
      models: [...new Set(first.map(r => r.model).filter(Boolean))],
      replayDuplicates: replayed.length - first.length, producer: result.recorder }
    await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence))
  } finally { if (collector) collector.kill('SIGKILL') }
}

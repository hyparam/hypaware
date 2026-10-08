// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { fork } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { temporaryDirectory } from '../helpers/temp_dir.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'
import { readStatusFile } from '../../src/core/daemon/status.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { aiGatewayDatasetRegistration, aiGatewayTablePath } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { executeQuerySql } from '../../src/core/query/sql.js'
import { requestOllamaVerification } from '../../src/core/control/client_recording.js'
/** @import { AddressInfo } from 'node:net' */

async function waitFor(check, timeout = 8000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('fixture condition did not arrive')
}
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch { return false }
}
async function retainedLocks(root) {
  return (await fs.readdir(root, { recursive: true })).filter(name => /(?:\.lock|lockfile)(?:\/|$)/.test(name)).sort()
}
async function service(t, split, blocked = false) {
  const home = temporaryDirectory('hyp-ollama-process-')
  const configPath = path.join(home, 'hypaware-config.json')
  const env = { ...isolatedClientEnv(process.env, home), HYP_HOME: home, HYP_CONFIG: configPath }
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/version') return res.end('{"version":"fixture"}')
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"tiny:local"}]}')
    req.resume()
    req.once('end', () => res.end('{"model":"tiny:local","done":true,"message":{"role":"assistant","content":"OK"}}'))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(undefined)))
  const upstreamPort = /** @type {AddressInfo} */ (upstream.address()).port
  await fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false, plugins: [
    { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:0', upstreams: [{ name: 'ollama', base_url: `http://127.0.0.1:${upstreamPort}` }] } }, { name: '@hypaware/ollama' },
  ] }))
  const preload = path.join(home, 'pause-checkpoint.mjs')
  await fs.writeFile(preload, `import fs from 'node:fs/promises'
const rename = fs.rename
fs.rename = async (from, to) => {
  if (String(to).endsWith('.progress.json')) {
    await fs.writeFile(${JSON.stringify(path.join(home, 'checkpoint-entered'))}, 'entered')
    await new Promise(() => {})
  }
  return rename(from, to)
}
`)
  const entry = pathToFileURL(path.resolve(split ? 'src/core/daemon/gateway.js' : 'src/core/daemon/runtime.js')).href
  const dataset = pathToFileURL(path.resolve('hypaware-core/plugins-workspace/ai-gateway/src/dataset.js')).href
  const script = path.join(home, 'run-service.mjs')
  await fs.writeFile(script, `import { ${split ? 'runGatewayDaemon' : 'runDaemon'} as run } from ${JSON.stringify(entry)}
import { aiGatewayTablePath } from ${JSON.stringify(dataset)}
const handle = await run({ hypHome: ${JSON.stringify(home)}, configPath: ${JSON.stringify(configPath)}, runId: 'fixture-live', tickIntervalMs: 0, installSignalHandlers: false, env: process.env${split && blocked ? `, processingExecArgv: ['--import', ${JSON.stringify(pathToFileURL(preload).href)}]` : ''} })
process.on('message', async message => {
  if (message === 'flush') void handle.runtime.storage.flushTable(aiGatewayTablePath(handle.runtime.storage), { force: true })
  if (message === 'stop') {
    await handle.stop()
    await handle.done
    process.exit(0)
  }
})
process.send?.('ready')
`)
  const child = fork(script, [], { env, execArgv: blocked ? ['--import', pathToFileURL(preload).href] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let exited = false
  child.once('exit', () => { exited = true })
  t.after(async () => {
    if (!exited && child.connected) child.send('stop')
    try { await waitFor(() => exited, 6000) } catch {
      child.kill('SIGKILL')
      await waitFor(() => exited)
    }
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(() => resolve(undefined)))
  })
  const state = path.join(home, 'hypaware')
  const status = await waitFor(() => {
    const snapshot = readStatusFile(state)
    const details = /** @type {any} */ (snapshot?.sources.find(s => s.name === 'ai-gateway')?.details)
    return snapshot?.state === 'healthy' && details?.capture_ready ? snapshot : undefined
  })
  const details = /** @type {any} */ (status.sources.find(s => s.name === 'ai-gateway')?.details)
  const root = `http://${details.host}:${details.port}`
  return { home, env, state, root, child, status, details, exited: () => exited }
}

// @ref LLP 0476#delivery [tests]: the actual supervisor and processor callback settle low-volume fresh capture through ordinary command dispatch
test('actual split daemon confirms fresh check and stops its processor without an orphan', async t => {
  const f = await service(t, true)
  const processor = f.status.processes.processing.pid
  let output = ''
  let error = ''
  const code = await dispatch(['ollama', 'verify', '--model', 'tiny:local', '--json'], { env: f.env, stdout: { write: value => { output += value } }, stderr: { write: value => { error += value } } })
  assert.equal(code, 0, error + output)
  assert.equal(JSON.parse(output).status, 'persisted')
  f.child.send('stop')
  await waitFor(f.exited, 6000)
  assert.equal(alive(processor), false)
})

async function stoppedCheckpoint(t, requested, split = false, lostSupervisor = false) {
  const f = await service(t, split, true)
  const processor = f.status.processes?.processing?.pid
  t.after(() => { if (processor && alive(processor)) process.kill(processor, 'SIGKILL') })
  await fetch(f.root + '/ollama/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"tiny:local","messages":[{"role":"user","content":"check"}],"stream":false,"think":false}' })
  // Observe actual durable append before both variants enter the same flush.
  const kernel = createKernelRuntime({ cacheRoot: path.join(f.state, 'cache') })
  kernel.query.registerDataset(aiGatewayDatasetRegistration())
  await waitFor(async () => (await kernel.storage.pendingInfo(aiGatewayTablePath(kernel.storage))).pending)
  let receipt
  if (requested) receipt = requestOllamaVerification({ endpoint: f.root, runId: f.status.runId, generation: f.details.recording_generation, operation: 'stop-check', deadline: Date.now() + 10000 })
  else f.child.send('flush')
  await waitFor(() => fs.stat(path.join(f.home, 'checkpoint-entered')).then(() => true, () => false))
  if (lostSupervisor) f.child.kill('SIGKILL')
  else f.child.send('stop')
  await waitFor(f.exited, 6000)
  if (processor) await waitFor(() => !alive(processor), 6000)
  if (receipt) assert.notEqual((await receipt).reason, 'settled')
  assert.equal(alive(f.child.pid), false)
  const query = async () => (await executeQuerySql({ query: 'select count(*) as n from ai_gateway_messages', registry: kernel.query, storage: kernel.storage, config: { version: 2 }, refresh: 'never', callerCwd: process.cwd() })).rows[0].n
  const committedBeforeRecovery = await query()
  const spoolDir = path.join(aiGatewayTablePath(kernel.storage), '_hypaware_spool')
  const names = await fs.readdir(spoolDir)
  const state = { committedBeforeRecovery, progress: names.filter(n => n.endsWith('.progress.json')).length,
    progressTemps: names.filter(n => n.includes('.progress.json.') && n.endsWith('.tmp')).length,
    pending: (await kernel.storage.pendingInfo(aiGatewayTablePath(kernel.storage))).pending, locks: await retainedLocks(kernel.cacheRoot) }
  await kernel.storage.flushTable(aiGatewayTablePath(kernel.storage), { force: true })
  return { ...state, committedAfterRecovery: await query(), pendingAfterRecovery: (await kernel.storage.pendingInfo(aiGatewayTablePath(kernel.storage))).pending }
}

// @ref LLP 0476#lifecycle [tests]: stop at the identical ordinary commit-before-checkpoint seam has baseline retained data/restart behavior
test('actual stop interrupts requested flush with the same durable/restart outcome as direct ordinary full flush', async t => {
  const baseline = await stoppedCheckpoint(t, false)
  const requested = await stoppedCheckpoint(t, true)
  assert.equal(baseline.committedBeforeRecovery, 2)
  assert.equal(baseline.pending, true)
  assert.deepEqual(requested, baseline)
  assert.equal(requested.pendingAfterRecovery, false)
  assert.deepEqual(requested.locks, [])
})

// @ref LLP 0476#lifecycle [tests]: supervisor loss and ordinary stop retain immediate processor exit, unconfirmed receipt and ordinary restart recovery
for (const lostSupervisor of [false, true]) test('split daemon interrupts requested flush without an orphan: supervisorLost=' + lostSupervisor, async t => {
  const state = await stoppedCheckpoint(t, true, true, lostSupervisor)
  assert.equal(state.committedBeforeRecovery, 2)
  assert.equal(state.pending, true)
  assert.deepEqual(state.locks, [])
  assert.equal(state.pendingAfterRecovery, false)
  // Existing commit-before-checkpoint recovery may replay already committed
  // native rows. Verification adds no claim of exactly-once crash recovery.
  assert.equal(state.committedAfterRecovery, 4)
})

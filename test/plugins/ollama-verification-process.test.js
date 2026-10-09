// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fork } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { removeTemporaryDirectory } from '../helpers/temp_dir.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'
import { processingStateRoot, readPidFile } from '../../src/core/daemon/pid.js'
import { readStatusFile, ollamaCaptureFromSnapshot } from '../../src/core/daemon/status.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { aiGatewayDatasetRegistration, aiGatewayTablePath } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { executeQuerySql } from '../../src/core/query/sql.js'
import { requestOllamaVerification } from '../../src/core/control/client_recording.js'
/** @import { AddressInfo } from 'node:net' */
/** @import { TestContext } from 'node:test' */

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
/**
 * A test's home for the daemons it starts. node:test runs a test's `after`
 * hooks in registration order and skips the rest once one throws, so a
 * separate directory-removal hook registered before the daemons' teardown
 * runs first, races a still-running daemon's writes (ENOTEMPTY), and its
 * throw then skips the teardown, leaving the daemon and its processor alive
 * to hold the runner open. One hook therefore does both, in order: stop every
 * daemon started in the home (newest first) and wait for each processor, then
 * remove the home whatever happened. A failed stop (a processor that outlived
 * its daemon) is thrown only after all of that, so it fails the test without
 * leaving anything running.
 * @param {TestContext} t
 */
function testHome(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'hyp-ollama-process-'))
  /** @type {Array<() => Promise<void>>} */
  const stops = []
  t.after(async () => {
    /** @type {unknown[]} */
    const errors = []
    try {
      for (const stop of [...stops].reverse()) {
        try { await stop() } catch (err) { errors.push(err) }
      }
    } finally {
      removeTemporaryDirectory(home)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} daemon teardowns failed`)
  })
  return { home, stops }
}
async function retainedLocks(root) {
  return (await fs.readdir(root, { recursive: true })).filter(name => /(?:\.lock|lockfile)(?:\/|$)/.test(name)).sort()
}
async function service(t, split, blocked = false, tickIntervalMs = 0, owner = testHome(t)) {
  const home = owner.home
  const configPath = path.join(home, 'hypaware-config.json')
  const env = { ...isolatedClientEnv(process.env, home), HYP_HOME: home, HYP_CONFIG: configPath }
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/version') return res.end('{"version":"fixture"}')
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"tiny:local"}]}')
    req.resume()
    req.once('end', () => res.end(req.url === '/api/generate'
      ? '{"model":"tiny:local","response":"","done":true,"done_reason":"load"}'
      : '{"model":"tiny:local","done":true,"message":{"role":"assistant","content":"OK"}}'))
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
const handle = await run({ hypHome: ${JSON.stringify(home)}, configPath: ${JSON.stringify(configPath)}, runId: 'fixture-live', tickIntervalMs: ${tickIntervalMs}, installSignalHandlers: false, env: process.env${split && blocked ? `, processingExecArgv: ['--import', ${JSON.stringify(pathToFileURL(preload).href)}]` : ''} })
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
  const state = path.join(home, 'hypaware')
  /** @type {number | undefined} */
  let processor
  owner.stops.push(async () => {
    /** @type {number[]} */
    const survivors = []
    let ended = 'stop'
    try {
      // The processor seen at start-up and the one of record now (a home's
      // status file is shared with a later daemon started in it).
      const processors = new Set([processor, readStatusFile(state)?.processes?.processing?.pid])
      if (!exited && child.connected) child.send('stop')
      else if (exited) ended = 'the test'
      try { await waitFor(() => exited, 6000) } catch {
        ended = 'SIGKILL'
        child.kill('SIGKILL')
        await waitFor(() => exited)
      }
      for (const pid of processors) {
        if (!pid || pid === process.pid || !alive(pid)) continue
        try { await waitFor(() => !alive(pid), 3000) } catch {
          // Bounded cleanup first, so nothing is left to hold the runner
          // open; the survivor still fails the test below.
          survivors.push(pid)
          process.kill(pid, 'SIGKILL')
          await waitFor(() => !alive(pid))
        }
      }
    } finally {
      upstream.closeAllConnections()
      await new Promise(resolve => upstream.close(() => resolve(undefined)))
    }
    // A processor alive 3 s after its daemon ended is a product orphan, not a
    // teardown detail: fail the test, after the cleanup above has finished.
    if (survivors.length) {
      throw new Error(`processor ${survivors.join(', ')} outlived its daemon (daemon ended by ${ended}); killed during teardown`)
    }
  })
  const status = await waitFor(() => {
    const snapshot = readStatusFile(state)
    const details = /** @type {any} */ (snapshot?.sources.find(s => s.name === 'ai-gateway')?.details)
    return snapshot?.state === 'healthy' && details?.capture_ready ? snapshot : undefined
  })
  processor = status.processes?.processing?.pid
  const details = /** @type {any} */ (status.sources.find(s => s.name === 'ai-gateway')?.details)
  const root = `http://${details.host}:${details.port}`
  return { home, owner, env, state, root, child, status, details, exited: () => exited }
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

async function command(f, argv) {
  let output = ''
  let error = ''
  const code = await dispatch(argv, { env: f.env, stdout: { write: value => { output += value } }, stderr: { write: value => { error += value } } })
  return { code, output, error }
}

// @ref LLP 0474#recording [tests]: processing-only source reload retains the live generation after explicit detach and reattach
test('actual split processing SIGHUP keeps resumed fresh capture and recording generations', async t => {
  const f = await service(t, true, false, 25)
  const verify = () => command(f, ['ollama', 'verify', '--model', 'tiny:local', '--json'])
  assert.equal((await verify()).code, 0)
  assert.equal((await command(f, ['client', 'detach', 'ollama'])).code, 0)
  const attached = await command(f, ['client', 'attach', 'ollama'])
  assert.equal(attached.code, 0, attached.error + attached.output)
  assert.equal((await verify()).code, 0)
  const live = await requestOllamaVerification({ endpoint: f.root, runId: f.status.runId, deadline: Date.now() + 1000 })
  const processor = f.status.processes.processing.pid
  const processorRoot = processingStateRoot(f.state)
  const recordingDetails = () => /** @type {any} */ (readStatusFile(processorRoot)?.sources.find(s => s.name === 'ai-gateway')?.details)
  const observed = () => recordingDetails()?.capture_outcomes.find(entry => entry.route === 'ollama-native')?.observed
  for (let i = 0; i < 3; i++) {
    // Wait for this source's actual observations, then its replacement's reset.
    // A status-file mtime alone can change before a reload completes.
    await waitFor(() => observed() > 0)
    process.kill(processor, 'SIGHUP')
    await waitFor(() => observed() === 0)
    const result = await verify()
    assert.equal(result.code, 0, result.error + result.output)
    assert.equal(JSON.parse(result.output).status, 'persisted')
    const details = recordingDetails()
    assert.equal(details.recording_generation, live.generation)
    assert.equal(details.recording_enabled, true)
    assert.equal(alive(processor), true)
    assert.equal(readStatusFile(f.state)?.processes?.processing.pid, processor)
  }
})

// @ref LLP 0474#recording [tests]: an unauthorized recording control cannot change a live gate or prevent fresh persistence
test('actual split recording control refuses browser Origin without mutating capture', async t => {
  const f = await service(t, true)
  const verify = () => command(f, ['ollama', 'verify', '--model', 'tiny:local', '--json'])
  assert.equal((await verify()).code, 0)
  const saved = await fs.readFile(f.env.HYP_CONFIG, 'utf8')
  const control = { endpoint: f.root, runId: f.status.runId, deadline: Date.now() + 1000 }
  const before = await requestOllamaVerification(control)
  const response = await fetch(f.root + '/_hypaware/recording/ollama', {
    method: 'POST', headers: { origin: 'http://untrusted.example', 'content-type': 'text/plain' }, body: '{"recording":false}',
  })
  const status = response.status
  await response.text()
  const after = await requestOllamaVerification({ ...control, deadline: Date.now() + 1000 })
  const result = await verify()
  assert.equal(after.reason, 'ready')
  assert.equal(after.generation, before.generation)
  assert.equal(await fs.readFile(f.env.HYP_CONFIG, 'utf8'), saved)
  assert.equal(result.code, 0, result.error + result.output)
  assert.equal(JSON.parse(result.output).status, 'persisted')
  assert.equal(status, 403)
  assert.equal((await command(f, ['client', 'detach', 'ollama'])).code, 0)
  assert.equal((await verify()).code, 1)
  assert.equal((await command(f, ['client', 'attach', 'ollama'])).code, 0)
  assert.equal((await verify()).code, 0)
})

// @ref LLP 0474#diagnostics [tests]: actual split status retains actionable failure while off, recovers only on new persistence and resets current evidence on service restart
test('actual split failure survives benign control and off, with persistence recovery and fresh restart evidence', async t => {
  const f = await service(t, true, false, 25)
  const capture = async fixture => ollamaCaptureFromSnapshot(JSON.parse(await fs.readFile(fixture.env.HYP_CONFIG, 'utf8')), readStatusFile(fixture.state), readPidFile(fixture.state))
  async function request(route, body) {
    const response = await fetch(f.root + '/ollama/api/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    await response.text()
  }
  await request('chat', { model: 'tiny:local', messages: [{ role: 'user', content: 'unsupported' }], think: true, stream: false })
  const failed = await waitFor(async () => { const state = await capture(f); return state.state === 'failed' && state.reason === 'unsupported_shape' ? state : undefined })
  await request('generate', { model: 'tiny:local', prompt: '', stream: false })
  await waitFor(() => /** @type {any} */ (readStatusFile(f.state)?.sources[0]?.details)?.capture_outcomes.find(entry => entry.route === 'ollama-native')?.reasons.load_unload === 1)
  const benign = await capture(f)
  assert.equal(benign.reason, 'unsupported_shape')
  assert.equal(benign.lastFailed, failed.lastFailed)
  assert.equal(benign.next, failed.next)
  assert.equal(benign.lastPersisted, null)
  assert.equal((await command(f, ['client', 'detach', 'ollama'])).code, 0)
  const off = await capture(f)
  assert.equal(off.state, 'disabled')
  assert.equal(off.historical, true)
  assert.equal(off.reason, 'unsupported_shape')
  assert.equal((await command(f, ['client', 'attach', 'ollama'])).code, 0)
  const verified = await command(f, ['ollama', 'verify', '--model', 'tiny:local', '--json'])
  assert.equal(verified.code, 0, verified.error + verified.output)
  await waitFor(async () => (await capture(f)).state === 'persisted')
  const recovered = await capture(f)
  assert.equal(recovered.reason, null)
  assert.ok(recovered.lastPersisted && failed.lastFailed && recovered.lastPersisted > failed.lastFailed)
  await request('chat', { messages: [{ role: 'user', content: 'invalid model' }], stream: false })
  const newer = await waitFor(async () => { const state = await capture(f); return state.state === 'failed' && state.reason === 'invalid_request' ? state : undefined })
  assert.ok(newer.lastFailed > recovered.lastPersisted)
  const historical = readStatusFile(f.state)
  const oldPid = readPidFile(f.state)
  const config = JSON.parse(await fs.readFile(f.env.HYP_CONFIG, 'utf8'))
  f.child.send('stop')
  await waitFor(f.exited, 6000)
  assert.equal(ollamaCaptureFromSnapshot(config, historical, oldPid).historical, true)
  const restarted = await service(t, true, false, 25, f.owner)
  const fresh = await capture(restarted)
  assert.equal(fresh.state, 'ready')
  assert.equal(fresh.reason, null)
  assert.equal(fresh.lastFailed, null)
  assert.equal(fresh.lastPersisted, null)
  assert.equal(fresh.historical, false)
})

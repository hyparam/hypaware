// @ts-check
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { checkOllamaReadiness, resolveOllamaRouting, probeJson } from './setup.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { resolveConfigPath, resolveLayeredConfigForDaemon } from '../../../../src/core/runtime/boot.js'
import { readStatusFile, ollamaCaptureFromSnapshot } from '../../../../src/core/daemon/status.js'
import { readPidFile } from '../../../../src/core/daemon/pid.js'
import { requestOllamaVerification } from '../../../../src/core/control/client_recording.js'
import { getLogger } from '../../../../src/core/observability/index.js'

/** @import { AiGatewayCapability, CommandRunContext } from '../../../../hypaware-plugin-kernel-types.js' */

export const OLLAMA_CHECK_PROMPT = 'Reply with OK. This is a HypAware capture check.'
export const OLLAMA_INFERENCE_MS = 30_000
export const OLLAMA_PERSISTENCE_MS = 30_000
export const OLLAMA_CHECK_READS = 6
const now = () => performance.timeOrigin + performance.now()
const DISCLOSURE = `This check sends the fixed prompt: ${JSON.stringify(OLLAMA_CHECK_PROMPT)}. Configured sinks may export this prompt and its response. Verification requests ordinary full refresh of the shared current gateway spool, including earlier and other-client pending rows.`

/** @param {unknown} value */
function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return undefined } }
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : undefined
}

// @ref LLP 0474#diagnostics [implements]: only the fresh, linked request and new assistant identify a persisted check
/** @param {Record<string, unknown>[]} rows @param {string} token @param {string} model @param {string} from */
export function persistedOllamaCheck(rows, token, model, from) {
  if (rows.length !== 2) return undefined
  const [request, response] = [...rows].sort((a, b) => Number(a.message_index) - Number(b.message_index))
  const id = request.request_id
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,80}$/.test(id) || response.request_id !== id) return undefined
  for (const row of [request, response]) {
    const attributes = object(row.attributes)
    const gateway = object(attributes?.gateway)
    const at = row.message_created_at instanceof Date ? row.message_created_at.getTime() : Date.parse(String(row.message_created_at))
    if (attributes?.dev_run_id !== token || row.provider !== 'ollama' || row.model !== model || row.part_index !== 0 || row.part_type !== 'text'
      || !Number.isFinite(at) || at < Date.parse(from) || gateway?.status_code !== 200) return undefined
  }
  let links = response.previous_message_id
  if (typeof links === 'string') { try { links = JSON.parse(links) } catch { return undefined } }
  if (request.role !== 'user' || request.message_index !== 0 || request.message_id !== id + ':request:0'
    || response.role !== 'assistant' || response.message_index !== 1 || response.message_id !== id + ':response'
    || !Array.isArray(links) || links.length !== 1 || links[0] !== request.message_id) return undefined
  return id
}

/** @param {string} token @param {string} from @param {string} to */
export function ollamaCheckSql(token, from, to) {
  if (!/^ollama-check-[a-zA-Z0-9-]{1,64}$/.test(token) || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) throw new Error('invalid_check_scope')
  return `select request_id, message_id, previous_message_id, message_index, part_index, part_type, role, provider, model, attributes, message_created_at from ai_gateway_messages where json_extract(attributes, '$.dev_run_id') = '${token}' and message_created_at >= '${new Date(from).toISOString()}' and message_created_at <= '${new Date(to).toISOString()}' order by message_index, part_index limit 3`
}

// @ref LLP 0474#diagnostics [implements]: one owned query process bounds startup and pre-scan IO as well as the six targeted reads
/** @param {{ env: NodeJS.ProcessEnv, cacheRoot: string, cwd: string, token: string, model: string, from: string, to: string, timeoutMs?: number, control?: { endpoint: string, runId: string, generation: string } }} args */
export async function awaitPersistedOllamaCheck(args) {
  const timeout = Math.min(OLLAMA_PERSISTENCE_MS, args.timeoutMs ?? OLLAMA_PERSISTENCE_MS)
  const deadline = now() + timeout
  /** @type {{ request_id?: string, reason: string, reads?: number }} */
  let result = { reason: 'query_unavailable' }
  let child
  try {
    child = fork(fileURLToPath(import.meta.url), [], { env: args.env, cwd: args.cwd, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    result = await new Promise(resolve => {
      let settled = false
      const finish = value => { if (!settled) { settled = true
        clearTimeout(timer)
        resolve(value) } }
      const timer = setTimeout(() => finish({ reason: 'persistence_timeout' }), Math.max(1, deadline - now()))
      child.once('error', () => finish({ reason: 'query_unavailable' }))
      child.once('exit', () => finish({ reason: 'query_unavailable' }))
      child.once('message', message => {
        const payload = object(message)
        if (now() >= deadline) { finish({ reason: 'persistence_timeout' })
          return }
        if (payload && ['persisted', 'query_unavailable', 'persistence_timeout', 'processor_unavailable', 'settlement_busy', 'settlement_failed', 'recording_disabled', 'policy_unreadable', 'stale_generation'].includes(String(payload.reason))
          && Number.isSafeInteger(payload.reads) && Number(payload.reads) <= OLLAMA_CHECK_READS
          && (payload.reason !== 'persisted' || typeof payload.request_id === 'string' && /^[a-zA-Z0-9:_-]{1,80}$/.test(payload.request_id))) finish(payload)
        else finish({ reason: 'query_unavailable' })
      })
      child.send({ cacheRoot: args.cacheRoot, cwd: args.cwd, token: args.token, model: args.model, from: args.from, to: args.to, control: args.control, deadline }, error => { if (error) finish({ reason: 'query_unavailable' }) })
    })
  } catch { /* Creation/IPC failure is unconfirmed, never inference success. */ }
  finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      // This process performs read-only queries. Wait for actual exit before
      // releasing the check, including timeout during pre-scan filesystem IO.
      await new Promise(resolve => { child.once('exit', resolve)
        child.kill('SIGKILL') })
    }
    child?.removeAllListeners()
  }
  return result
}

/** @param {string[]} argv @param {CommandRunContext} ctx @param {AiGatewayCapability} gateway */
export async function runOllamaVerify(argv, ctx, gateway) {
  const json = argv.includes('--json')
  let model
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') continue
    if (argv[i] === '--model' && !model && argv[i + 1] && !argv[i + 1].startsWith('--')) { model = argv[++i]
      continue }
    ctx.stderr.write('Usage: hyp ollama verify --model NAME [--json]\n')
    return 2
  }
  if (!model || model.length > 120 || /[\x00-\x1f\x7f]/.test(model)) { ctx.stderr.write('Usage: hyp ollama verify --model NAME [--json]\n')
    return 2 }
  // Disclosure precedes inference and stays on stderr in JSON mode.
  ctx.stderr.write(DISCLOSURE + '\n')
  let httpCompleted = false
  const report = (reason, requestId) => {
    const next = reason === 'recording_disabled' ? 'hyp client attach ollama'
      : reason === 'model_not_listed' || reason === 'not_ready' ? 'hyp ollama setup; choose an existing listed model'
      : reason === 'route_unconfirmed' || reason === 'processor_unavailable' ? 'hyp daemon restart; hyp ollama setup; retry verify'
      : reason === 'persisted' ? 'Route your next client using hyp client attach ollama'
      : 'Check hyp status --verbose and the daemon log; run hyp ollama setup, then retry verify'
    const status = reason === 'persisted' ? 'persisted' : ['query_unavailable', 'persistence_timeout', 'route_unconfirmed', 'processor_unavailable', 'settlement_busy', 'stale_generation', 'policy_unreadable'].includes(reason) ? 'unconfirmed' : 'failed'
    const payload = { action: 'verify', client: 'ollama', status, reason, http_completed: httpCompleted, ...(requestId ? { request_id: requestId } : {}), next }
    if (json) ctx.stdout.write(JSON.stringify(payload) + '\n')
    else (reason === 'persisted' ? ctx.stdout : ctx.stderr).write(`Ollama check: ${status}${requestId ? `; request_id ${requestId}` : ''}. HTTP ${httpCompleted ? 'completed' : 'not confirmed'}; ${reason}.\n${reason === 'persistence_timeout' ? 'Inference completed but storage confirmation timed out. Live collector work may finish; settings are unchanged.\n' : reason === 'processor_unavailable' && httpCompleted ? 'Inference completed; collection or verification was interrupted/unconfirmed.\n' : ''}Next: ${next}\n`)
    getLogger('ollama').info('plugin.ollama.verify', { component: 'ollama', operation: 'verify', status, reason, ...(requestId ? { exchange_id: requestId } : {}) })
    return reason === 'persisted' ? 0 : 1
  }
  try {
    const { hypHome, stateDir } = readObservabilityEnv(ctx.env)
    const layers = await resolveLayeredConfigForDaemon({ stateRoot: stateDir, configPath: resolveConfigPath({ env: ctx.env, hypHome }), migrateGrep: false })
    if (layers.localLoaded?.ok === false || layers.centralLoaded?.ok === false || !layers.effective) return report('not_ready')
    const config = layers.effective
    const plugin = config.plugins?.find(p => p.name === '@hypaware/ollama' && p.enabled !== false)
    if (!plugin) return report('not_ready')
    if (plugin.recording === false) return report('recording_disabled')
    const routing = resolveOllamaRouting(ctx.env, config, gateway)
    const capture = ollamaCaptureFromSnapshot(config, readStatusFile(stateDir), readPidFile(stateDir))
    if (!routing.confirmed || !capture.routeConfirmed) return report('route_unconfirmed')
    if (!capture.processorReady) return report('processor_unavailable')
    const ready = await checkOllamaReadiness({ upstream: routing.direct_root, env: ctx.env })
    if (ready.service !== 'ready') return report('not_ready')
    if (!ready.models.includes(model)) return report('model_not_listed')
    const livePid = readPidFile(stateDir)
    if (!livePid) return report('processor_unavailable')
    // @ref LLP 0476#control [constrained-by]: readiness cannot rotate the generation or suppress another active capture
    const live = await requestOllamaVerification({ endpoint: routing.capture_root, runId: livePid.runId, deadline: now() + 3000 })
    if (live.reason !== 'ready' || !live.generation) return report(live.reason)
    if (!ctx.query.getDataset('ai_gateway_messages')) return report('query_unavailable')
    const token = 'ollama-check-' + randomUUID()
    const from = new Date().toISOString()
    const to = new Date(Date.now() + OLLAMA_INFERENCE_MS + OLLAMA_PERSISTENCE_MS).toISOString()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), OLLAMA_INFERENCE_MS)
    try {
      const response = await probeJson(new URL(routing.capture_root), '/api/chat', abort.signal, { remaining: 1024 * 1024 }, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-hyp-dev-run-id': token },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: OLLAMA_CHECK_PROMPT }], stream: false, think: false, options: { num_predict: 16 } }),
      })
      if (response?.done !== true || response.model !== model || response.message?.role !== 'assistant' || typeof response.message.content !== 'string'
        || response.error || response.message.thinking || response.message.tool_calls?.length) return report('unsupported_response')
      httpCompleted = true
    } catch { return report(abort.signal.aborted ? 'inference_timeout' : 'inference_failed') }
    finally {
      clearTimeout(timer)
      abort.abort()
    }
    const persisted = await awaitPersistedOllamaCheck({ env: ctx.env, cacheRoot: ctx.storage.cacheRoot, cwd: ctx.cwd, token, model, from, to,
      control: { endpoint: routing.capture_root, runId: livePid.runId, generation: live.generation } })
    // The reader's final control check validates the service's original
    // PID/run/generation inside the persistence deadline. Avoid another
    // synchronous filesystem read after the bounded worker has returned.
    if (persisted.reason === 'persisted') return report('persisted', persisted.request_id)
    const latest = ollamaCaptureFromSnapshot(config, readStatusFile(stateDir), readPidFile(stateDir))
    // A route-level failure during the check is useful evidence but does not
    // identify this request; successful verification still requires the token.
    if (latest.lastFailed && latest.lastFailed >= from && latest.reason) return report(latest.reason)
    return report(persisted.reason)
  } catch { return report('not_ready') }
}

// Run only when this module is the owned IPC child, never during activation.
if (process.send && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once('disconnect', () => process.exit(1))
  process.once('message', async message => {
    const job = /** @type {any} */ (message)
    let reads = 0
    try {
      const { createKernelRuntime } = await import('../../../../src/core/runtime/activation.js')
      const { executeQuerySql } = await import('../../../../src/core/query/sql.js')
      const { aiGatewayDatasetRegistration } = await import('../../ai-gateway/src/dataset.js')
      const { hypHome, stateDir } = readObservabilityEnv(process.env)
      const layers = await resolveLayeredConfigForDaemon({ stateRoot: stateDir, configPath: resolveConfigPath({ env: process.env, hypHome }), migrateGrep: false })
      if (!layers.effective || layers.localLoaded?.ok === false || layers.centralLoaded?.ok === false) throw new Error('query_unavailable')
      if (!layers.effective.plugins?.some(p => p.name === '@hypaware/ai-gateway' && p.enabled !== false)
        || !layers.effective.plugins?.some(p => p.name === '@hypaware/ollama' && p.enabled !== false && p.recording !== false)) throw new Error('query_unavailable')
      const runtime = createKernelRuntime({ cacheRoot: job.cacheRoot })
      runtime.query.registerDataset(aiGatewayDatasetRegistration())
      const query = ollamaCheckSql(job.token, job.from, job.to)
      const start = now()
      for (; reads < OLLAMA_CHECK_READS && now() < job.deadline;) {
        if (job.control) {
          const receipt = await requestOllamaVerification({ ...job.control, operation: randomUUID(), deadline: job.deadline })
          if (receipt.reason !== 'settled') {
            process.send?.({ reason: receipt.reason, reads })
            return
          }
        }
        const read = ++reads
        const result = await executeQuerySql({ query, registry: runtime.query, storage: runtime.storage, config: layers.effective,
          scope: { from: job.from, to: job.to, limit: 3 }, refresh: 'never', callerCwd: job.cwd, maxHeapBytes: 32 * 1024 * 1024 })
        const requestId = persistedOllamaCheck(result.rows, job.token, job.model, job.from)
        if (requestId && now() < job.deadline) {
          if (job.control && (await requestOllamaVerification({ ...job.control, deadline: job.deadline })).reason !== 'ready') {
            process.send?.({ reason: 'stale_generation', reads })
            return
          }
          process.send?.({ reason: 'persisted', request_id: requestId, reads })
          return }
        if (result.freshnessMessages.some(line => line.includes('may be missing'))) throw new Error('query_unavailable')
        const interval = Math.max(0, (job.deadline - start - 100) / (OLLAMA_CHECK_READS - 1))
        const wait = read < OLLAMA_CHECK_READS ? Math.min(Math.max(0, start + read * interval - now()), job.deadline - now()) : 0
        if (wait > 0) await sleep(wait)
      }
      process.send?.({ reason: 'persistence_timeout', reads })
    } catch { process.send?.({ reason: 'query_unavailable', reads }) }
  })
}

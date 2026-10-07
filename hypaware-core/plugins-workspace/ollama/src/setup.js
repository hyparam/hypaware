// @ts-check

import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { isLoopbackHost } from '../../../../src/core/util/loopback.js'
import { sanitizeLabel } from '../../../../src/core/util/json_util.js'
import { atomicWriteJson } from '../../../../src/core/util/fs_atomic.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { getLogger } from '../../../../src/core/observability/index.js'
import { resolveConfigPath, resolveLayeredConfigFromDisk } from '../../../../src/core/runtime/boot.js'
import { configuredGatewayEndpoint, DEFAULT_GATEWAY_ENDPOINT } from '../../../../src/core/config/gateway_endpoint.js'
import { prepareLocalConfigWrite } from '../../../../src/core/config/schema.js'
import { validateConfig } from '../../../../src/core/config/validate.js'
import { buildKnownPluginsForCtx } from '../../../../src/core/commands/plugin.js'
import { readStatusFile, resolveLiveGatewayEndpointFromStatus, gatewaySourceDetails, daemonHeartbeatAgeMs, DAEMON_HEARTBEAT_STALE_MS } from '../../../../src/core/daemon/status.js'
import { endpointFromListen } from '../../../../src/core/config/gateway_endpoint.js'
import { readPidFile, processIsAlive } from '../../../../src/core/daemon/pid.js'

/**
 * @import { AiGatewayCapability, AiGatewayUpstreamAliasRoute, CommandRunContext, HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 */

const DEFAULT_UPSTREAM = 'http://127.0.0.1:11434'
const PROBE_BYTES = 1024 * 1024
const PROBE_MS = 3000
const PRIVACY = 'Configured sinks may export local-model conversations. Cwd/repository are unknown; directory exclusions cannot protect this lane. Media bytes are omitted; snapshots repeat submitted context. No history import or outage replay.'

/** @returns {AiGatewayUpstreamAliasRoute} */
export function ollamaNativeRoute() {
  return {
    path_prefix: '/ollama', provider: 'ollama', rewrite: { from: '/ollama', to: '/' },
    match: input => (input.method === 'HEAD' && (input.path === '/ollama' || input.path === '/ollama/'))
      || (input.method === 'GET' && (input.path === '/ollama/api/version' || input.path === '/ollama/api/tags'))
      || (input.method === 'POST' && (input.path === '/ollama/api/show' || input.path === '/ollama/api/chat' || input.path === '/ollama/api/generate')),
    captureMatch: input => input.method === 'POST' && (input.path === '/ollama/api/chat' || input.path === '/ollama/api/generate'),
  }
}

/** @param {string} upstream @param {string[]} collectors */
export function validateOllamaUpstream(upstream, collectors) {
  let url
  try { url = new URL(upstream) } catch { throw new Error('invalid Ollama upstream URL') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.href.length > 2048) {
    throw new Error('Ollama upstream must be an http(s) service root without credentials, query or fragment')
  }
  for (const endpoint of collectors) {
    let collector
    try { collector = new URL(endpoint) } catch { continue }
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    const collectorPort = collector.port || (collector.protocol === 'https:' ? '443' : '80')
    if (port === collectorPort && (url.hostname === collector.hostname
      || (isLoopbackHost(url.hostname, { hexMappedIpv4: true }) && isLoopbackHost(collector.hostname, { hexMappedIpv4: true }))
      || (['0.0.0.0', '[::]'].includes(collector.hostname) && isLoopbackHost(url.hostname, { hexMappedIpv4: true })))) {
      throw new Error('Ollama upstream points back at the collector; use the direct Ollama service root')
    }
  }
  return url
}

// @ref LLP 0474#setup [implements]: bounded discovery never executes Ollama, follows redirects, retries or loads a model
/** @param {{ upstream: string, env: NodeJS.ProcessEnv }} args */
export async function checkOllamaReadiness({ upstream, env }) {
  const url = validateOllamaUpstream(upstream, [])
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_MS)
  /** @type {{ executable: boolean, service: string, version?: string, models: string[], inventory_complete: boolean, reason?: string }} */
  const result = { executable: false, service: 'unavailable', models: [], inventory_complete: false }
  const budget = { remaining: PROBE_BYTES }
  try {
    // PATH may contain a stalled network mount. The evidence check stops
    // scheduling work on abort and never extends the overall deadline.
    let onAbort
    const timedEvidence = new Promise(resolve => {
      onAbort = () => resolve(false)
      abort.signal.addEventListener('abort', onAbort, { once: true })
    })
    try { result.executable = await Promise.race([executableOnPath(env, abort.signal), timedEvidence]) === true }
    finally { if (onAbort) abort.signal.removeEventListener('abort', onAbort) }
    abort.signal.throwIfAborted()
    const version = await probeJson(url, '/api/version', abort.signal, budget)
    if (!version || typeof version.version !== 'string' || !sanitizeLabel(version.version, 80)) throw new Error('probe_malformed')
    result.version = sanitizeLabel(version.version, 80)
    const tags = await probeJson(url, '/api/tags', abort.signal, budget)
    if (!tags || !Array.isArray(tags.models)) throw new Error('probe_malformed')
    let complete = tags.models.length <= 20
    for (const model of tags.models.slice(0, 20)) {
      const name = sanitizeLabel(model?.name, 120)
      if (name) result.models.push(name)
      else complete = false
      if (name !== model?.name) complete = false
    }
    result.service = 'ready'
    result.inventory_complete = complete
    if (!complete) result.reason = 'inventory_incomplete'
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    result.reason = abort.signal.aborted ? 'probe_timeout'
      : ['probe_malformed', 'probe_http_error', 'probe_body_limit'].includes(reason) ? reason : 'upstream_unavailable'
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
  return result
}

/** @param {URL} root @param {string} pathname @param {AbortSignal} signal @param {{ remaining: number }} budget */
async function probeJson(root, pathname, signal, budget) {
  const target = new URL(root)
  target.pathname = root.pathname.replace(/\/+$/, '') + pathname
  const response = await fetch(target, { signal, redirect: 'manual' })
  if (!response.ok) { await response.body?.cancel(); throw new Error('probe_http_error') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('probe_malformed')
  // Grow one buffer instead of retaining an unbounded number of tiny chunks.
  let buffer = Buffer.alloc(0)
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.byteLength > budget.remaining) throw new Error('probe_body_limit')
      budget.remaining -= value.byteLength
      const needed = bytes + value.byteLength
      if (needed > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(PROBE_BYTES, Math.max(4096, needed, buffer.length * 2)))
        buffer.copy(grown, 0, 0, bytes)
        buffer = grown
      }
      buffer.set(value, bytes)
      bytes = needed
    }
    try { return JSON.parse(buffer.toString('utf8', 0, bytes)) } catch { throw new Error('probe_malformed') }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** @param {NodeJS.ProcessEnv} env @param {AbortSignal} signal */
async function executableOnPath(env, signal) {
  for (const dir of (env.PATH ?? '').slice(0, 32768).split(path.delimiter).filter(Boolean).slice(0, 256)) {
    if (signal.aborted) return false
    const candidate = path.join(dir, process.platform === 'win32' ? 'ollama.exe' : 'ollama')
    try {
      if (!(await fs.stat(candidate)).isFile()) continue
      await fs.access(candidate, constants.X_OK)
      return true
    } catch { /* PATH evidence is best-effort, never an executable invocation. */ }
  }
  return false
}

/** @param {string} value */
function shellQuote(value) { return `'${value.replace(/'/g, `'"'"'`)}'` }

// @ref LLP 0474#routes [implements]: direct recovery explicitly uses the preserved root even when the collector is absent
/** @param {string} gatewayBase @param {string} direct */
export function routingRecipes(gatewayBase, direct) {
  const capture = gatewayBase.replace(/\/+$/, '') + '/ollama'
  return {
    capture_root: capture,
    cli: `OLLAMA_HOST=${shellQuote(capture)} ollama run <installed-model> --think=false`,
    sdk: `ollama.Client(host=${JSON.stringify(capture)})`,
    direct_cli: `OLLAMA_HOST=${shellQuote(direct)} ollama run <installed-model> --think=false`,
    direct_sdk: `ollama.Client(host=${JSON.stringify(direct)})`,
  }
}

/** @param {HypAwareV2Config} config */
function namedUpstream(config) {
  const upstreams = config.plugins?.find(p => p.name === '@hypaware/ai-gateway')?.config?.upstreams
  if (!Array.isArray(upstreams)) return undefined
  const upstream = upstreams.find(u => u && typeof u === 'object' && !Array.isArray(u) && u.name === 'ollama')
  return upstream && typeof upstream === 'object' && !Array.isArray(upstream) ? upstream : undefined
}

/** @param {NodeJS.ProcessEnv} env @param {HypAwareV2Config} config @param {AiGatewayCapability} gateway */
export function resolveOllamaRouting(env, config, gateway) {
  const { stateDir } = readObservabilityEnv(env)
  let localBase
  let directLive
  try { localBase = gateway.localEndpoint() } catch { /* No local listener is normal for a CLI boot. */ }
  let status
  let pid
  try { status = readStatusFile(stateDir); pid = readPidFile(stateDir) } catch { /* Unreadable evidence stays unconfirmed. */ }
  const age = daemonHeartbeatAgeMs(status, Date.now())
  // @ref LLP 0474#setup [implements]: only the gateway's matching live snapshot proves compilation, never processing-side desired config
  const current = pid && processIsAlive(pid.pid) && status?.pid === pid.pid && status.runId === pid.runId
    && status.startedAt === pid.startedAt && ['healthy', 'degraded'].includes(status.state)
    && age !== null && age >= 0 && age <= DAEMON_HEARTBEAT_STALE_MS
  const source = Array.isArray(status?.sources) ? status.sources.find(s => s.name === 'ai-gateway' && s.state === 'started') : undefined
  const details = /** @type {{ upstream_aliases?: unknown, listening?: boolean }} */ (source?.details ?? {})
  const bound = current && source && details.listening !== false ? gatewaySourceDetails([source]) : undefined
  const snapshotBase = bound ? endpointFromListen(`${bound.host}:${bound.port}`) : undefined
  const base = localBase ?? snapshotBase
  if (snapshotBase === base && Array.isArray(details.upstream_aliases)) {
    const alias = details.upstream_aliases.slice(0, 32).find(a => a && typeof a === 'object' && !Array.isArray(a) && a.name === 'ollama-native' && a.canonical === 'ollama' && a.path_prefix === '/ollama')
    if (alias && typeof alias === 'object' && !Array.isArray(alias) && typeof alias.base_url === 'string') directLive = alias.base_url
  }
  const configured = configuredGatewayEndpoint(config) ?? DEFAULT_GATEWAY_ENDPOINT
  const upstream = namedUpstream(config)
  const direct = typeof upstream?.base_url === 'string' ? upstream.base_url : DEFAULT_UPSTREAM
  validateOllamaUpstream(direct, [configured, ...(base ? [base] : [])])
  const confirmed = !!base && directLive === new URL(direct).href
  return { ...routingRecipes(base ?? configured, direct), direct_root: direct, confirmed, gateway_bound: !!base }
}

/** @param {string[]} argv @param {CommandRunContext} ctx @param {AiGatewayCapability} gateway */
export async function runOllamaSetup(argv, ctx, gateway) {
  const json = argv.includes('--json')
  let explicit
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json' || argv[i] === '--print-commands') continue
    if (argv[i] === '--upstream' && argv[i + 1] && !argv[i + 1].startsWith('--') && explicit === undefined) { explicit = argv[++i]; continue }
    ctx.stderr.write('Usage: hyp ollama setup [--upstream URL] [--json]\n')
    return 2
  }
  const { hypHome, stateDir } = readObservabilityEnv(ctx.env)
  const configPath = resolveConfigPath({ env: ctx.env, hypHome })
  let saved = false
  let backup
  let restart = 'not_requested'
  try {
    const known = await buildKnownPluginsForCtx(ctx)
    const layers = await resolveLayeredConfigFromDisk({ stateRoot: stateDir, configPath, ...known })
    if (layers.localLoaded?.ok === false || layers.centralLoaded?.ok === false || !layers.effective) throw new Error('Cannot read valid current configuration; no changes saved')
    let config = layers.effective
    const ollama = config.plugins?.find(p => p.name === '@hypaware/ollama')
    if (!ollama || ollama.enabled === false) throw new Error('Enable Ollama with hyp setup --source ollama, then run hyp ollama setup')
    if (explicit !== undefined) {
      const live = resolveLiveGatewayEndpointFromStatus({ stateRoot: stateDir })
      validateOllamaUpstream(explicit, [configuredGatewayEndpoint(config) ?? DEFAULT_GATEWAY_ENDPOINT, ...(live ? [live] : [])])
      if (layers.centralConfig?.plugins?.some(p => p.name === '@hypaware/ai-gateway')) throw new Error('Organization owns the gateway upstream; local endpoint changes would be inert')
      const stat = await fs.stat(configPath)
      const raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
      const entry = raw.plugins?.find(p => p.name === '@hypaware/ai-gateway')
      if (!entry || !entry.config || !Array.isArray(entry.config.upstreams)) throw new Error('Configure the Ollama gateway with hyp setup --source ollama first')
      const current = entry.config.upstreams.find(u => u.name === 'ollama')
      if (!current) throw new Error('Configure the named Ollama upstream with hyp setup --source ollama first')
      if (current.base_url !== explicit) {
        current.base_url = explicit
        const validation = await validateConfig(raw, known)
        if (!validation.ok) throw new Error('Updated Ollama configuration is invalid; no changes saved')
        const guard = await prepareLocalConfigWrite({ targetPath: configPath, force: true })
        if (!guard.proceed) throw new Error('Config backup refused; no changes saved')
        await atomicWriteJson(configPath, raw, { expectedMtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 })
        saved = true
        backup = guard.backupPath
        config = (await resolveLayeredConfigFromDisk({ stateRoot: stateDir, configPath, ...known })).effective ?? raw
      }
      // Saved preference and a live endpoint are different facts. Restart uses the established installed-daemon path.
      if (live && saved) {
        try {
          const { restartServiceDaemon } = await import('../../../../src/core/daemon/install.js')
          await restartServiceDaemon({ homeDir: ctx.env.HOME })
          const { waitForGatewayBind } = await import('../../../../src/core/cli/remote_commands.js')
          const result = await waitForGatewayBind({ env: ctx.env })
          restart = result.bound ? 'completed' : 'unconfirmed'
        } catch { restart = 'failed' }
      } else if (saved) restart = 'required'
    }
    const routing = resolveOllamaRouting(ctx.env, config, gateway)
    if (saved && restart === 'completed' && !routing.confirmed) restart = 'unconfirmed'
    const readiness = await checkOllamaReadiness({ upstream: routing.direct_root, env: ctx.env })
    let suggestion
    if (!namedUpstream(config) && ctx.env.OLLAMA_HOST) {
      try { suggestion = validateOllamaUpstream(ctx.env.OLLAMA_HOST, [configuredGatewayEndpoint(config) ?? DEFAULT_GATEWAY_ENDPOINT]).href } catch { /* Unsafe ambient values are never echoed or applied. */ }
    }
    const payload = { status: 'configured', action: 'setup', client: 'ollama', recording: ollama.recording !== false, saved, backup_path: backup, restart, ...routing, ...readiness,
      privacy: PRIVACY,
      ...(suggestion ? { upstream_suggestion: suggestion } : {}),
      next: ollama.recording === false ? 'hyp client attach ollama' : routing.confirmed ? 'Route your next client using this URL' : 'hyp daemon restart; hyp ollama setup',
    }
    getLogger('ollama').info('plugin.ollama.setup', { component: 'ollama', operation: 'setup', status: readiness.service, recording: payload.recording, route_confirmed: routing.confirmed, reason: readiness.reason ?? 'none' })
    if (json) ctx.stdout.write(JSON.stringify(payload) + '\n')
    else {
      ctx.stdout.write(`Ollama ${payload.recording ? 'configured' : 'not recording'}. PATH executable evidence: ${readiness.executable ? 'present' : 'not found in bounded check (SDK use is still possible)'}.\n`)
      ctx.stdout.write(`Direct upstream: ${routing.direct_root}\nService: ${readiness.service}${readiness.version ? ` (${readiness.version})` : ''}\n`)
      ctx.stdout.write(`Models${readiness.inventory_complete ? '' : ' (incomplete inventory)'}: ${readiness.models.join(', ') || (readiness.inventory_complete ? 'none installed' : 'unknown')}\n`)
      ctx.stdout.write(`Capture root${routing.confirmed ? ' (live)' : ' (unconfirmed)'}: ${routing.capture_root}\n`)
      if (saved) ctx.stdout.write(`Endpoint saved; restart ${restart}. Backup: ${backup}\n`)
      if (suggestion) ctx.stdout.write(`Initial OLLAMA_HOST suggestion (not applied): ${suggestion}. Confirm with hyp ollama setup --upstream ${shellQuote(suggestion)}\n`)
      ctx.stdout.write(`${PRIVACY}\nSupports Ollama CLI 0.35.1 and Python SDK 0.6.1: heartbeat, version/tags, show, chat and generate only.\n`)
      ctx.stdout.write(`Next: ${payload.next}\n${routing.cli}\n${routing.sdk}\nCollector outage or direct next launch:\n${routing.direct_cli}\n${routing.direct_sdk}\n`)
      if (readiness.service !== 'ready') ctx.stdout.write('Check your direct Ollama service and endpoint, then rerun hyp ollama setup. Setup does not start or load Ollama.\n')
      else if (readiness.inventory_complete && readiness.models.length === 0) ctx.stdout.write('No installed models reported. Arrange an existing model, then rerun hyp ollama setup.\n')
    }
    // Not-ready is a configuration-preserving attended result, never a dropped picker choice.
    return restart === 'failed' || restart === 'unconfirmed' ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ollama setup failed'
    if (json) ctx.stdout.write(JSON.stringify({ status: 'failed', action: 'setup', client: 'ollama', saved, restart, error: message }) + '\n')
    else ctx.stderr.write(`${message}${saved ? '; configuration saved, live route unconfirmed. Run hyp daemon restart, then hyp ollama setup' : ''}\n`)
    return 1
  }
}

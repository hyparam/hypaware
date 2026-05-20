import process from 'node:process'
import { readPackageVersion, resolveDefaultConfigPath } from './cli/common.js'
import { Collector } from './collector.js'
import { ConfigError, loadConfigAsync, parseConfig, resolveRuntimeSecrets } from './config.js'
import { resolveStandaloneGatewayId } from './gateway_id.js'
import { ConfigClient } from './gateway/config_client.js'
import { applyDiff, diffConfig } from './gateway/hot_reload.js'
import { IdentityClient } from './gateway/identity.js'
import { OutboxSink, defaultOutboxDir } from './gateway/outbox_sink.js'
import { IgnoreFilter } from './ignore.js'
import { Proxy } from './proxy.js'
import { Recorder } from './recorder.js'
import { defaultPidFilePath } from './runtime/paths.js'
import { removePidFile, writePidFile } from './runtime/pid_file.js'
import { ControlPlane } from './server/control_plane.js'
import { defaultSinkDir as defaultIngestSinkDir } from './server/ingest.js'
import { FileSink } from './sinks/file.js'
import { hasAwsCredentialSource } from './upload/aws_credentials.js'
import { isSupervised, selfUpdate } from './update.js'
import { createScheduler } from './upload/scheduler.js'

/**
 * Partition layout the parquet drain walks. Standalone and server modes share
 * the same shape now: `<sink_dir>/<gateway_id>/<signal>/<YYYY-MM-DD>.jsonl`.
 * Standalone resolves the id from `config.gateway_id` or the OS username;
 * server mode tags it from the authenticated JWT subject on every ingest.
 *
 * @type {ReadonlyArray<string>}
 */
const PARQUET_PARTITION_DIMENSIONS = ['gateway_id', 'signal']

/**
 * @import { Server } from 'node:http'
 * @import { CollectivusConfig, ListenerFactory, StartedListener } from './types.js'
 * @import { ConfigResult, ErrorResult, HotReloadWiring, LocalReloadWiring, ParseResult } from './cli/types.d.ts'
 * @import { ConfigChangedEvent } from './gateway/types.d.ts'
 * @import { IngestSignal } from './server/types.d.ts'
 */

const USAGE = `Usage:
  ctvs [--config <path|url>]                   Run with config file or http(s) URL
                                               (default: ~/.hyp/collectivus.json)
  ctvs --config-env <env-var>                  Run from config JSON in an environment variable
  ctvs --config-endpoint <url>                 Run from a central-server setup URL
  ctvs [--config <path|url>] --print-config    Load config, print resolved JSON, exit
  ctvs [--config <path|url>] --strict          Reject unknown top-level config keys
  ctvs --help                                  Show this help
  ctvs --version                               Print program version

Commands:
  ctvs install [--config <path|url>]           Install the background daemon
  ctvs uninstall                               Remove the daemon and detach attached clients
  ctvs attach [--config <path|url>] [--port <n>] [--client claude|codex|all]
                                               Point Claude Code or Codex at the local proxy
  ctvs detach [--client claude|codex|all]
                                               Restore Claude Code and/or Codex config
  ctvs status                                  Report daemon, config, recordings, attach state
  ctvs gascity <subcommand> [...]              Manage gascity supervisor capture sources
  ctvs export --config <path|url> [...]        Convert recorded JSONL to Parquet
  ctvs query <command> [...]                   Query local recordings through query cache
  ctvs collect <file.jsonl> --name <name>      Add external JSONL as a query table
  ctvs skills install [...]                    Install the Collectivus query LLM skill
  ctvs ignore <add|remove|list> [path]         Suppress Claude recording for a folder
  ctvs config <set|get|list|delete|bootstrap-token> ...
                                               Operator CLI for per-gateway configs
  ctvs rendezvous [--listen <host:port>] ...   Run the hosted-discovery rendezvous service
  ctvs join <join-code> --rendezvous <url>     Join a Central server through rendezvous

Run \`ctvs <subcommand> --help\` for subcommand-specific options.`

const DRAIN_TIMEOUT_MS = 5000
const SELF_UPDATE_TIME_UTC = '03:00'

/**
 * Parse CLI arguments into a structured result.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {ParseResult}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let configPath
  /** @type {string | undefined} */
  let configEndpoint
  /** @type {string | undefined} */
  let configEnv
  let printConfig = false
  let strict = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      return { mode: 'help' }
    }

    if (arg === '--version' || arg === '-V' || arg === '-v') {
      return { mode: 'version' }
    }

    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) return parseError('--config requires a path or URL')
      if (configEndpoint !== undefined) return parseError('--config and --config-endpoint are mutually exclusive')
      if (configEnv !== undefined) return parseError('--config and --config-env are mutually exclusive')
      configPath = value
      continue
    }

    if (arg === '--config-env' || arg.startsWith('--config-env=')) {
      const value = arg === '--config-env' ? argv[++i] : arg.slice('--config-env='.length)
      if (!value) return parseError('--config-env requires an environment variable name')
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return parseError('--config-env must be an environment variable name')
      if (configPath !== undefined || configEndpoint !== undefined) {
        return parseError('--config-env cannot be combined with --config or --config-endpoint')
      }
      configEnv = value
      continue
    }

    if (arg === '--config-endpoint' || arg.startsWith('--config-endpoint=')) {
      const value = arg === '--config-endpoint' ? argv[++i] : arg.slice('--config-endpoint='.length)
      if (!value) return parseError('--config-endpoint requires a URL')
      if (!isHttpUrl(value)) return parseError('--config-endpoint requires an http(s) URL')
      if (configPath !== undefined) return parseError('--config and --config-endpoint are mutually exclusive')
      if (configEnv !== undefined) return parseError('--config-endpoint and --config-env are mutually exclusive')
      configEndpoint = value
      configPath = value
      continue
    }

    if (arg === '--print-config') {
      printConfig = true
      continue
    }

    if (arg === '--strict') {
      strict = true
      continue
    }

    return parseError(`unknown argument: ${arg}`)
  }

  // Defer the "no config source" check to `run()` so it can fall back to
  // `~/.hyp/collectivus.json` when that file exists.
  /** @type {ConfigResult} */
  const result = { mode: 'config', printConfig, strict }
  if (configPath !== undefined) result.configPath = configPath
  if (configEnv !== undefined) result.configEnv = configEnv
  return result
}

/**
 * @param {string} message
 * @returns {ErrorResult}
 */
function parseError(message) {
  return { mode: 'error', message, exitCode: 2 }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  return /^https?:\/\//i.test(value)
}

/**
 * Run the CLI to completion.
 *
 * Resolves with the process exit code. Tests inject `hooks` to capture output
 * and trigger shutdown without sending real signals; production wires real
 * stdio and process signals.
 *
 * @param {string[]} argv CLI arguments (without node/script name).
 * @param {NodeJS.ProcessEnv} env Environment variables (read for upload credentials).
 * @param {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   onShutdownRequested?: (handler: (signal: string) => void) => void,
 *   onSighupRequested?: (handler: () => void) => void,
 *   isTTY?: boolean,
 *   runInit?: () => Promise<number>,
 *   identityPersistedPath?: string,
 *   pidFilePath?: string,
 *   homeDir?: string,
 * }} [hooks]
 * @returns {Promise<number>}
 */
export async function run(argv, env, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const onShutdownRequested = hooks.onShutdownRequested ?? defaultSignalWiring
  const isTTY = hooks.isTTY ?? Boolean(process.stdin.isTTY)

  // Bare `collectivus` on a real terminal launches the interactive walkthrough
  // that builds a config. Non-TTY (CI / piped stdin) keeps the existing
  // "--config required" error so scripts that depend on the exit code aren't
  // silently turned into a hung readline.
  if (argv.length === 0 && isTTY) {
    const runInitFn = hooks.runInit ?? (await import('./cli/init.js')).runInit
    return runInitFn()
  }

  const parsed = parseArgs(argv)

  if (parsed.mode === 'help') {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.mode === 'version') {
    stdout.write(readPackageVersion() + '\n')
    return 0
  }
  if (parsed.mode === 'error') {
    stderr.write(`error: ${parsed.message}\n\n${USAGE}\n`)
    return parsed.exitCode
  }

  if (parsed.configPath === undefined && parsed.configEnv === undefined) {
    const fallback = resolveDefaultConfigPath(hooks.homeDir)
    if (fallback) {
      parsed.configPath = fallback
    } else {
      stderr.write(
        'error: --config <path|url>, --config-env <env-var>, or --config-endpoint <url> is required\n\n' +
        USAGE + '\n'
      )
      return 2
    }
  }

  /** @type {CollectivusConfig} */
  let config
  try {
    if (parsed.configEnv) {
      config = loadConfigFromEnv(parsed.configEnv, env, { strict: parsed.strict, stderr })
    } else {
      if (!parsed.configPath) throw new ConfigError('config path is missing')
      config = await loadConfigAsync(parsed.configPath, { strict: parsed.strict, stderr })
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`config error: ${err.message}\n`)
      return 1
    }
    throw err
  }

  if (parsed.printConfig) {
    stdout.write(JSON.stringify(config, null, 2) + '\n')
    return 0
  }

  /** @type {Parameters<typeof runWithConfig>[2]} */
  const childHooks = {
    stdout,
    stderr,
    onShutdownRequested,
    identityPersistedPath: hooks.identityPersistedPath,
  }
  if (hooks.onSighupRequested !== undefined) childHooks.onSighupRequested = hooks.onSighupRequested
  if (hooks.pidFilePath !== undefined) childHooks.pidFilePath = hooks.pidFilePath
  // Only wire SIGHUP-driven reload when the daemon was started from a
  // re-readable config source. `--config-env` configs live in process env,
  // so a SIGHUP can't pick up new values without a restart anyway; the
  // gateway-mode reload path (configClient) covers `--config-endpoint`.
  if (parsed.configPath !== undefined && !isHttpUrl(parsed.configPath)) {
    childHooks.localConfigPath = parsed.configPath
  }
  return runWithConfig(config, env, childHooks)
}

/**
 * @param {string} envName
 * @param {NodeJS.ProcessEnv} env
 * @param {{ strict?: boolean, stderr?: { write: (s: string) => void } }} opts
 * @returns {CollectivusConfig}
 */
function loadConfigFromEnv(envName, env, opts) {
  const raw = env?.[envName]
  if (!raw) throw new ConfigError(`environment variable ${envName} is not set`)
  return parseConfig(raw, `env:${envName}`, opts)
}

/**
 * Run the normal listener/gateway lifecycle from an already constructed
 * config object. Callers use this when the config is intentionally in memory
 * only, such as `ctvs join` after resolving a hosted-discovery join code.
 *
 * @param {CollectivusConfig} config Validated Collectivus config.
 * @param {NodeJS.ProcessEnv} env Environment variables (read for upload credentials).
 * @param {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   onShutdownRequested?: (handler: (signal: string) => void) => void,
 *   onSighupRequested?: (handler: () => void) => void,
 *   identityPersistedPath?: string,
 *   localConfigPath?: string,
 *   pidFilePath?: string,
 * }} [hooks]
 *   `localConfigPath` (when set) enables SIGHUP-driven re-read of the local
 *   config file — the standard Unix "reload without restart" pattern. Used
 *   by `ctvs gascity attach/detach` to push a config edit live without
 *   bouncing the whole daemon.
 *   `pidFilePath` overrides where the daemon writes its PID; the default is
 *   `~/.collectivus/runtime/collectivus.pid`. The CLI reads it to find a
 *   live daemon for SIGHUP.
 * @returns {Promise<number>}
 */
export async function runWithConfig(config, env, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const onShutdownRequested = hooks.onShutdownRequested ?? defaultSignalWiring
  try {
    config = resolveRuntimeSecrets(config, env ?? {})
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`config error: ${err.message}\n`)
      return 1
    }
    throw err
  }

  // Fail at boot rather than at the first daily uploader tick when the upload
  // section is configured but no supported AWS credential source is available.
  if (config.upload && !hasAwsCredentialSource(env ?? {})) {
    stderr.write(
      'config error: upload.bucket is set but no AWS credential source is available; set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or run with an ECS task role.\n'
    )
    return 1
  }

  // role: gateway must hold a valid JWT before any listener binds. Acquire
  // here (eager, before runLifecycle) so a bad bootstrap token or unreachable
  // central server fails with a clean stderr line and exit 1, without ever
  // opening a port. The IdentityClient is then handed to buildConfigListeners
  // for future epics (B config vending, C log shipping) to consume.
  /** @type {IdentityClient | undefined} */
  let identityClient
  /** @type {ConfigClient | undefined} */
  let configClient
  if (config.role === 'gateway') {
    if (!config.central_server) {
      stderr.write('config error: role: gateway requires a central_server block (validator should have caught this).\n')
      return 1
    }
    identityClient = new IdentityClient(
      config.central_server,
      hooks.identityPersistedPath ? { persistedPath: hooks.identityPersistedPath } : {}
    )
    try {
      const source = await identityClient.acquire()
      const id = identityClient.identity
      stdout.write(`Identity ${source} for ${id ? id.gateway_id : 'gateway'}\n`)
    } catch (err) {
      stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    // ConfigClient runs in the background. It is a normal listener, wired
    // into stopAll via buildConfigListeners, so a SIGTERM stops the poll
    // timer the same way it stops the proxy. Construct here (after identity
    // has succeeded) rather than inside the factory so it's available to
    // any future listener that wants to subscribe to `config-changed`.
    configClient = new ConfigClient(config.central_server, identityClient, { stderr })
  }

  // Resolve the standalone gateway_id once at boot. Gateway and server roles
  // get their gateway_id from the JWT, so the value isn't used by their
  // listener factories, but we still resolve a placeholder for the unused
  // ctx field to keep the type concrete.
  /** @type {string} */
  let gatewayId
  try {
    gatewayId = config.role === 'standalone' || config.role === undefined
      ? resolveStandaloneGatewayId(config.gateway_id)
      : identityClient?.identity?.gateway_id ?? '_unknown'
  } catch (err) {
    stderr.write(`config error: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const ctx = { env, stderr, identityClient, configClient, gatewayId }
  /**
   * @param {CollectivusConfig} cfg
   * @returns {Map<string, ListenerFactory>}
   */
  function factoryBuilder(cfg) {
    return buildConfigListeners(cfg, ctx)
  }
  /** @type {HotReloadWiring | undefined} */
  const hotReload = configClient
    ? { initialConfig: config, configClient, factoryBuilder }
    : undefined

  /** @type {Parameters<typeof runLifecycle>[5]} */
  const extras = {}
  if (hooks.localConfigPath !== undefined && !hotReload) {
    const { localConfigPath } = hooks
    /** @type {LocalReloadWiring} */
    const localReload = {
      initialConfig: config,
      factoryBuilder,
      reload: async () => {
        const reloaded = await loadConfigAsync(localConfigPath, { stderr })
        return resolveRuntimeSecrets(reloaded, env ?? {})
      },
    }
    extras.localReload = localReload
    if (hooks.onSighupRequested !== undefined) extras.onSighupRequested = hooks.onSighupRequested
  }
  // Only the standalone daemon writes a PID file. Gateway/server roles
  // typically run under a supervisor that already tracks PIDs (launchd,
  // systemd, k8s) and an out-of-band PID file would just go stale.
  if (config.role !== 'gateway' && config.role !== 'server') {
    extras.pidFile = { path: hooks.pidFilePath ?? defaultPidFilePath() }
  }

  return runLifecycle(factoryBuilder(config), stdout, stderr, onShutdownRequested, hotReload, extras)
}

/**
 * @param {CollectivusConfig} config
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   stderr: { write: (s: string) => void },
 *   identityClient?: IdentityClient,
 *   configClient?: ConfigClient,
 *   gatewayId: string,
 * }} ctx
 *   `env` is forwarded to the uploader so its connector reads creds from the
 *   same env we pre-flighted in `run()`. `stderr` is consumed by the
 *   self-update factory for warning output. `identityClient` is set when
 *   `config.role === 'gateway'` and `run()` has already acquired the JWT;
 *   future epics (B config vending, C log shipping) will read this off `ctx`
 *   to authenticate to the central server. `configClient` is the gateway's
 *   background config-pull loop; the gateway lifecycle subscribes to its
 *   `config-changed` event and feeds it into `applyDiff` for hot reload.
 *   `gatewayId` is the first-level partition for sink writes; standalone
 *   resolves this from `config.gateway_id` or the OS username, while
 *   gateway/server roles take it from the JWT subject.
 * @returns {Map<string, ListenerFactory>} Section-keyed factory map.
 *   Section names: `otel`, `proxy`, `upload`, `server`, `configPoll`,
 *   `gascity`, `selfUpdate`. Insertion order is preserved by `Map`, which
 *   `runLifecycle` relies on to start listeners in dependency order
 *   (sink-owners before config-poll, config-poll before self-update).
 */
function buildConfigListeners(config, ctx) {
  /** @type {Map<string, ListenerFactory>} */
  const factories = new Map()

  if (config.otel) {
    const { listen } = config.otel
    const { gatewayId } = ctx
    if (config.role === 'gateway') {
      const outboxDir = resolveGatewayOutboxDir(config, ctx)
      factories.set('otel', async () => {
        const { host, port } = parseListen(listen)
        const rowSinks = {
          logs: createGatewayOutboxSink(config, ctx, 'logs'),
          traces: createGatewayOutboxSink(config, ctx, 'traces'),
          metrics: createGatewayOutboxSink(config, ctx, 'metrics'),
        }
        const collector = new Collector({ host, port, gatewayId, rowSinks })
        await collector.start()
        const effective = effectiveBinding(collector.server, host, port)
        return {
          description: `OTLP listener bound on ${effective}, spooling to ${outboxDir}/<signal> for Central ingest`,
          stop: async () => {
            await collector.stop()
            await Promise.all(Object.values(rowSinks).map((sink) => sink.close()))
          },
        }
      })
    } else {
      if (!config.sink) {
        throw new Error('otel is configured but sink is missing')
      }
      const outputDir = config.sink.dir
      factories.set('otel', async () => {
        const { host, port } = parseListen(listen)
        const collector = new Collector({ host, port, outputDir, gatewayId })
        await collector.start()
        const effective = effectiveBinding(collector.server, host, port)
        return {
          description: `OTLP listener bound on ${effective}, writing to ${outputDir}/${gatewayId}/<signal>/<UTC-date>.jsonl`,
          stop: () => collector.stop(),
        }
      })
    }
  }

  if (config.proxy) {
    const proxyConfig = config.proxy
    const { gatewayId } = ctx
    if (config.role === 'gateway') {
      const outboxDir = resolveGatewayOutboxDir(config, ctx)
      factories.set('proxy', async () => {
        const sink = createGatewayOutboxSink(config, ctx, 'proxy')
        const recorder = new Recorder({ sink, redactHeaders: proxyConfig.redact_headers })
        const proxy = new Proxy(proxyConfig, { recorder })
        await proxy.start()
        const effective = effectiveBinding(proxy.server, proxy.host, proxy.port)
        return {
          description: `Proxy listener bound on ${effective}, spooling to ${outboxDir}/proxy for Central ingest`,
          stop: async () => {
            await proxy.stop()
            await recorder.drain()
            await sink.close()
          },
        }
      })
    } else {
      if (!config.sink) {
        throw new Error('proxy is configured but sink is missing')
      }
      const sinkDir = config.sink.dir
      factories.set('proxy', async () => {
        const sink = new FileSink(sinkDir, gatewayId)
        const ignoreFilter = new IgnoreFilter()
        await ignoreFilter.load({ stderr: ctx.stderr })
        const recorder = new Recorder({ sink, redactHeaders: proxyConfig.redact_headers })
        const proxy = new Proxy(proxyConfig, { recorder, ignoreFilter })
        await proxy.start()
        const effective = effectiveBinding(proxy.server, proxy.host, proxy.port)
        return {
          description: `Proxy listener bound on ${effective}, recording to ${sinkDir}/${gatewayId}/proxy/<UTC-date>.jsonl`,
          // Stop accepting new connections, drain any in-flight exchanges (their
          // finalization can be async, e.g. a gzip decoder still flushing the
          // tail of an SSE stream), then flush+close the sink so the final
          // `exchange` row lands before exit.
          stop: async () => {
            await proxy.stop()
            await recorder.drain()
            await sink.close()
          },
        }
      })
    }
  }

  if (config.upload) {
    const uploadConfig = config.upload
    // Standalone and server share the same on-disk partition layout
    // (`<root>/<gateway_id>/<signal>/<date>.jsonl`); only the root differs.
    // Server points at the multi-tenant ingest spool; standalone points at
    // the per-process sink.dir, where the standalone Collector writes its
    // normalized rows.
    let outputDir
    if (config.role === 'server') {
      const serverConfig = config.server
      if (!serverConfig) {
        throw new Error('role: server requires server block (validator should have caught this)')
      }
      outputDir = serverConfig.sink_dir ?? defaultIngestSinkDir()
    } else {
      if (!config.sink) {
        throw new Error('upload is configured but sink is missing')
      }
      outputDir = config.sink.dir
    }
    const resolvedOutputDir = outputDir
    // Lazy import keeps the SigV4 / parquet code off the hot path for
    // installs that don't enable upload.
    factories.set('upload', async () => {
      const { createUploader } = await import('./upload/index.js')
      const uploader = createUploader({
        outputDir: resolvedOutputDir,
        options: { ...uploadConfig, partitionDimensions: PARQUET_PARTITION_DIMENSIONS },
        env: ctx.env,
      })
      await uploader.start()
      const time = uploadConfig.time ?? '00:10'
      const prefix = uploadConfig.prefix ?? 'collectivus'
      return {
        description: `Uploader scheduled for ${time} UTC, target s3://${uploadConfig.bucket}/${prefix}`,
        stop: () => uploader.stop(),
      }
    })
  }

  // role: server brings up the control-plane HTTP listener (identity,
  // future config-vending, future log ingest). Only `server` triggers it;
  // `gateway` is a client of this listener and `standalone` doesn't use it.
  // The validator guarantees `config.server` is set iff role === 'server'.
  if (config.role === 'server') {
    const serverConfig = config.server
    if (!serverConfig) {
      throw new Error('role: server requires server block (validator should have caught this)')
    }
    factories.set('server', async () => {
      const controlPlane = new ControlPlane(serverConfig)
      await controlPlane.start()
      const effective = effectiveBinding(controlPlane.server, controlPlane.host, controlPlane.port)
      return {
        description: `Control-plane listener bound on ${effective}`,
        stop: () => controlPlane.stop(),
      }
    })
  }

  // Background config-pull loop runs alongside the proxy/otel listeners on
  // gateways. We register it here so its lifetime is tied to the same
  // start/stop machinery; a SIGTERM stops the timer cleanly without leaving
  // an orphaned setTimeout in the event loop. The hot-reload pipeline
  // subscribes to `config-changed` events emitted by this client.
  if (config.role === 'gateway' && ctx.configClient) {
    const { configClient } = ctx
    const url = config.central_server?.url ?? 'central server'
    const poll = configClient.pollIntervalSeconds
    factories.set('configPoll', () => {
      configClient.start()
      return Promise.resolve({
        description: `Config poll loop active (${url} every ${poll}s)`,
        stop: async () => {
          configClient.stop()
          await configClient.whenIdle()
        },
      })
    })
  }

  // Gascity supervisor capture. Wired in standalone and server modes — it
  // reads from a remote supervisor and writes to its own sink root, so it
  // does not depend on `config.sink` like the proxy/otel sources do.
  // Disabled in gateway mode for now: a gateway with a remote supervisor
  // would need to flow gascity rows through the central-server outbox,
  // which is out of scope for the bead-1 skeleton.
  if (config.gascity !== undefined && config.role !== 'gateway') {
    const cities = config.gascity
    factories.set('gascity', async () => {
      const { startGascitySource } = await import('./gascity/index.js')
      return startGascitySource({ cities, stderr: ctx.stderr })
    })
  }

  // Only schedule the self-update tick when we have a real listener to keep
  // alive; an empty config should still surface "no listeners configured".
  if (factories.size > 0) {
    factories.set('selfUpdate', buildSelfUpdateFactory(ctx))
  }

  return factories
}

/**
 * @param {CollectivusConfig} config
 * @param {{ identityClient?: IdentityClient, stderr: { write: (s: string) => void } }} ctx
 * @param {IngestSignal} signal
 * @returns {OutboxSink}
 */
function createGatewayOutboxSink(config, ctx, signal) {
  const centralServer = config.central_server
  const { identityClient } = ctx
  if (!centralServer || !identityClient) {
    throw new Error('gateway outbox requires central_server and an acquired identity')
  }
  return new OutboxSink({
    outboxDir: defaultOutboxDir(centralServer),
    centralUrl: centralServer.url,
    identityClient,
    signal,
    stderr: ctx.stderr,
  })
}

/**
 * @param {CollectivusConfig} config
 * @param {{ identityClient?: IdentityClient }} ctx
 * @returns {string}
 */
function resolveGatewayOutboxDir(config, ctx) {
  if (!config.central_server || !ctx.identityClient) {
    throw new Error('gateway outbox requires central_server and an acquired identity')
  }
  return defaultOutboxDir(config.central_server)
}

/**
 * Build a listener factory for the daily self-update tick. The factory
 * starts a scheduler that runs once per UTC day at `SELF_UPDATE_TIME_UTC`;
 * each tick checks the npm registry and, if a newer version is published,
 * runs `npm install -g collectivus@<latest>` and (only when running under
 * a supervisor like launchd / systemd) sends SIGTERM so the supervisor
 * respawns the process on the new code.
 *
 * Robustness: the tick swallows everything so a failure never escalates
 * into the scheduler's fast-retry path; if anything goes wrong we just
 * wait until tomorrow's tick. The factory itself also swallows startup
 * errors and returns a no-op listener so a broken self-update path can
 * never take down the OTLP collector or proxy.
 *
 * @param {{ stderr: { write: (s: string) => void } }} ctx
 * @returns {ListenerFactory}
 */
function buildSelfUpdateFactory(ctx) {
  return async () => {
    try {
      const scheduler = createScheduler({
        time: SELF_UPDATE_TIME_UTC,
        skipInitialTick: true,
        tick: async () => {
          try {
            const installed = await selfUpdate()
            if (installed !== undefined && isSupervised()) {
              // Trigger graceful shutdown; supervisor will restart with new code.
              process.kill(process.pid, 'SIGTERM')
            }
          } catch (err) {
            ctx.stderr.write(`warning: self-update tick failed: ${formatError(err)}\n`)
          }
        },
      })
      await scheduler.start()
      return {
        description: `Self-update check scheduled daily at ${SELF_UPDATE_TIME_UTC} UTC`,
        stop: () => scheduler.stop(),
      }
    } catch (err) {
      ctx.stderr.write(`warning: self-update disabled (${formatError(err)})\n`)
      return {
        description: 'Self-update check disabled (failed to start)',
        stop: async () => {},
      }
    }
  }
}

/**
 * @param {Map<string, ListenerFactory>} factories
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @param {(handler: (signal: string) => void) => void} onShutdownRequested
 * @param {HotReloadWiring} [hotReload] When supplied, subscribe to
 *   `configClient.on('config-changed')` and route each event through
 *   `applyDiff`, mutating the running registry in place.
 * @param {{
 *   localReload?: LocalReloadWiring,
 *   pidFile?: { path: string },
 *   onSighupRequested?: (handler: () => void) => void,
 * }} [extras]
 *   `localReload` enables SIGHUP-driven config reread for the standalone
 *   daemon (used by `ctvs gascity attach/detach`). The handler re-reads the
 *   config from disk via the supplied callback, then runs the same diff/apply
 *   chain as the gateway hot-reload path. Gascity is special-cased to mutate
 *   its existing listener in place via `applyCityDiff` rather than tearing
 *   the whole source down.
 *   `pidFile` writes the daemon's PID at startup and removes it on shutdown
 *   so the CLI can find a live daemon for SIGHUP.
 *   `onSighupRequested` is overridable for tests; production wires
 *   `process.on('SIGHUP')`.
 * @returns {Promise<number>}
 */
async function runLifecycle(factories, stdout, stderr, onShutdownRequested, hotReload, extras = {}) {
  if (factories.size === 0) {
    stderr.write('error: no listeners configured\n')
    return 1
  }

  // Register the shutdown handler before starting listeners so a signal
  // arriving during bind doesn't fall through to Node's default (terminate).
  const shutdownPromise = new Promise((resolve) => {
    onShutdownRequested((signal) => {
      stdout.write(`Received ${signal}, shutting down...\n`)
      resolve(undefined)
    })
  })

  /** @type {Map<string, StartedListener>} */
  const started = new Map()
  for (const [name, factory] of factories) {
    try {
      const listener = await factory()
      stdout.write(listener.description + '\n')
      started.set(name, listener)
    } catch (err) {
      stderr.write(`error: failed to start listener: ${formatError(err)}\n`)
      await stopAll(started, stderr)
      return 1
    }
  }

  if (extras.pidFile) {
    try {
      await writePidFile(extras.pidFile.path)
    } catch (err) {
      stderr.write(`warning: failed to write pid file ${extras.pidFile.path}: ${formatError(err)}\n`)
    }
  }

  // Serialize hot-reload applications onto a single chain so concurrent
  // `'config-changed'` emits (in practice the ConfigClient ticks
  // sequentially, but defensive serialization keeps the invariant local)
  // can't interleave their stop/start operations and leak a listener.
  /** @type {Promise<void>} */
  let reloadChain = Promise.resolve()
  /** @type {CollectivusConfig | undefined} */
  let currentCfg = hotReload ? hotReload.initialConfig : extras.localReload?.initialConfig
  if (hotReload) {
    hotReload.configClient.on('config-changed', (/** @type {ConfigChangedEvent} */ event) => {
      reloadChain = reloadChain.then(async () => {
        const newCfg = event.newConfig
        if (currentCfg === undefined) currentCfg = newCfg
        const diff = diffConfig(currentCfg, newCfg)
        await applyDiff(diff, currentCfg, newCfg, started, hotReload.factoryBuilder, { stdout, stderr })
        await applyGascitySectionDiff(currentCfg, newCfg, started, hotReload.factoryBuilder, { stdout, stderr })
        currentCfg = newCfg
      }).catch((err) => {
        stderr.write(`hot reload: unexpected error: ${formatError(err)}\n`)
      })
    })
  }

  if (extras.localReload) {
    const { localReload } = extras
    const onSighupRequested = extras.onSighupRequested ?? defaultSighupWiring
    onSighupRequested(() => {
      reloadChain = reloadChain.then(async () => {
        /** @type {CollectivusConfig} */
        let newCfg
        try {
          newCfg = await localReload.reload()
        } catch (err) {
          stderr.write(`local reload: failed to re-read config: ${formatError(err)}\n`)
          return
        }
        if (currentCfg === undefined) currentCfg = newCfg
        stdout.write('local reload: applying config\n')
        const diff = diffConfig(currentCfg, newCfg)
        await applyDiff(diff, currentCfg, newCfg, started, localReload.factoryBuilder, { stdout, stderr })
        await applyGascitySectionDiff(currentCfg, newCfg, started, localReload.factoryBuilder, { stdout, stderr })
        currentCfg = newCfg
      }).catch((err) => {
        stderr.write(`local reload: unexpected error: ${formatError(err)}\n`)
      })
    })
  }

  await shutdownPromise
  // Drain any in-flight reload so its stop() lands before stopAll() races
  // it. The chain only does start/stop work, bounded and short.
  await reloadChain
  await stopAll(started, stderr)
  if (extras.pidFile) {
    try {
      await removePidFile(extras.pidFile.path)
    } catch (err) {
      stderr.write(`warning: failed to remove pid file ${extras.pidFile.path}: ${formatError(err)}\n`)
    }
  }
  stdout.write('Shutdown complete.\n')
  return 0
}

/**
 * Reload-time gascity diff.
 *
 * The standard `applyDiff` only handles otel/proxy/sink/upload — those
 * sections share a "stop the old, start the new" pattern. The gascity
 * source is different: each city carries an SSE connection plus a set of
 * active session workers, and we don't want a config edit that touches
 * one city (e.g. `ctvs gascity attach city2`) to retire the live workers
 * for unchanged cities. Instead we mutate the listener in place by
 * calling `applyCityDiff(newCities)` on the existing instance.
 *
 * Three transitions to handle:
 *   - oldGascity defined, newGascity defined → applyCityDiff
 *   - oldGascity undefined, newGascity defined → spin up via factory
 *   - oldGascity defined, newGascity undefined → stop and remove
 *
 * @param {CollectivusConfig} oldCfg
 * @param {CollectivusConfig} newCfg
 * @param {Map<string, StartedListener>} registry
 * @param {(cfg: CollectivusConfig) => Map<string, ListenerFactory>} factoryBuilder
 * @param {{ stdout: { write(s: string): void }, stderr: { write(s: string): void } }} log
 * @returns {Promise<void>}
 */
async function applyGascitySectionDiff(oldCfg, newCfg, registry, factoryBuilder, log) {
  const oldGascity = oldCfg.gascity
  const newGascity = newCfg.gascity
  if (oldGascity === undefined && newGascity === undefined) return
  if (gascityArraysEqual(oldGascity ?? [], newGascity ?? [])) return
  const existing = /** @type {(import('./types.js').StartedListener & { applyCityDiff?: (c: import('./gascity/types.d.ts').GascityCityConfig[]) => Promise<void> }) | undefined} */ (
    registry.get('gascity')
  )

  if (existing && newGascity !== undefined && typeof existing.applyCityDiff === 'function') {
    try {
      await existing.applyCityDiff(newGascity)
      log.stdout.write(`local reload: gascity diff applied (${newGascity.length} ${newGascity.length === 1 ? 'city' : 'cities'})\n`)
    } catch (err) {
      log.stderr.write(`local reload: gascity applyCityDiff failed: ${formatError(err)}\n`)
    }
    return
  }
  if (!existing && newGascity !== undefined) {
    const factory = factoryBuilder(newCfg).get('gascity')
    if (!factory) return
    try {
      const listener = await factory()
      registry.set('gascity', listener)
      log.stdout.write(`local reload: gascity started — ${listener.description}\n`)
    } catch (err) {
      log.stderr.write(`local reload: failed to start gascity: ${formatError(err)}\n`)
    }
    return
  }
  if (existing && newGascity === undefined) {
    try {
      await existing.stop()
      registry.delete('gascity')
      log.stdout.write('local reload: gascity stopped\n')
    } catch (err) {
      log.stderr.write(`local reload: failed to stop gascity: ${formatError(err)}\n`)
    }
  }
}

/**
 * Deep equality on two `gascity` arrays. Order matters because `[[gascity]]`
 * entries are compared positionally — a swap is a config-level change
 * intentionally, even when the set of names is identical.
 *
 * @param {readonly import('./gascity/types.d.ts').GascityCityConfig[]} a
 * @param {readonly import('./gascity/types.d.ts').GascityCityConfig[]} b
 * @returns {boolean}
 */
function gascityArraysEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ca = a[i]
    const cb = b[i]
    if (ca.name !== cb.name) return false
    if (ca.api_url !== cb.api_url) return false
    if (!stringListEqual(ca.include_templates, cb.include_templates)) return false
    if (!stringListEqual(ca.exclude_templates, cb.exclude_templates)) return false
  }
  return true
}

/**
 * @param {string[] | undefined} a
 * @param {string[] | undefined} b
 * @returns {boolean}
 */
function stringListEqual(a, b) {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Wire SIGHUP to the supplied handler. SIGHUP is the standard Unix signal
 * for "re-read config without restarting" — using it here means the
 * `ctvs gascity attach/detach` CLI just sends one signal and the daemon
 * handles the rest.
 *
 * @param {() => void} handler
 * @returns {void}
 */
function defaultSighupWiring(handler) {
  process.on('SIGHUP', handler)
}

/**
 * @param {Map<string, StartedListener>} started
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<void>}
 */
async function stopAll(started, stderr) {
  if (started.size === 0) return
  /** @type {Promise<void>[]} */
  const stops = []
  for (const l of started.values()) {
    stops.push((async () => {
      try {
        await l.stop()
      } catch (err) {
        stderr.write(`warning: error stopping listener: ${formatError(err)}\n`)
      }
    })())
  }
  /** @type {Promise<'timeout'>} */
  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS)
    if (typeof t.unref === 'function') t.unref()
  })
  const outcome = await Promise.race([Promise.all(stops).then(() => 'done'), timeout])
  if (outcome === 'timeout') {
    stderr.write(`warning: drain exceeded ${DRAIN_TIMEOUT_MS}ms; forcing exit\n`)
  }
}

/**
 * @param {(signal: string) => void} handler
 * @returns {void}
 */
function defaultSignalWiring(handler) {
  process.once('SIGINT', () => handler('SIGINT'))
  process.once('SIGTERM', () => handler('SIGTERM'))
}

/**
 * Parse a `host:port` listen string. Bracketed IPv6 addresses are unwrapped.
 *
 * @param {string} value
 * @returns {{ host: string, port: number }}
 */
function parseListen(value) {
  let host = ''
  let portStr = ''
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1) throw new Error(`invalid listen address: ${value}`)
    host = value.slice(1, close)
    if (value[close + 1] !== ':') throw new Error(`invalid listen address: ${value}`)
    portStr = value.slice(close + 2)
  } else {
    const colon = value.lastIndexOf(':')
    if (colon <= 0) throw new Error(`invalid listen address: ${value}`)
    host = value.slice(0, colon)
    portStr = value.slice(colon + 1)
  }
  const port = Number.parseInt(portStr, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port in listen address: ${value}`)
  }
  return { host, port }
}

/**
 * @param {Server | undefined} server
 * @param {string | undefined} configuredHost
 * @param {number} configuredPort
 * @returns {string}
 */
function effectiveBinding(server, configuredHost, configuredPort) {
  const addr = server?.address()
  if (addr && typeof addr === 'object') {
    const host = configuredHost ?? addr.address
    return `${formatHost(host)}:${addr.port}`
  }
  return `${formatHost(configuredHost ?? '0.0.0.0')}:${configuredPort}`
}

/**
 * @param {string} host
 * @returns {string}
 */
function formatHost(host) {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
  return host
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return `${err.code}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}

// @ts-check

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Attr, getLogger, withSpan } from '../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { createCodexBackfillProvider } from './backfill.js'
import { CODEX_CONFIG_SECTION, validateCodexConfig } from './config.js'
import { createCodexExchangeProjector } from './exchange-projector.js'
import { createRolloutCwdResolver } from './rollout-cwd.js'
import { attach, defaultConfigPath } from './settings.js'
import { runCodexClassifyHook } from './classify_hook.js'

/**
 * @import { AiGatewayCapability, AiGatewayClientAttachContext, AiGatewayRouteInput, PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/codex'
const CLIENT_NAME = 'codex'
const UPSTREAM_NAME = 'openai'
const CHATGPT_UPSTREAM_NAME = 'chatgpt'
// The API-key destination for Codex traffic that arrived on the neutral
// prefix. A name of its own, not a second copy of the `openai` preset: that
// name is a last-write-wins slot two adapters register (LLP 0161), so a rung
// written there is only as durable as the activation order.
// @ref LLP 0313#decision [implements]: the credential rung and the rewrite live on an upstream codex owns outright
const OPENAI_CODEX_UPSTREAM_NAME = 'openai-codex'
// The one prefix attach writes, in both auth modes. It says nothing about how
// the user logged in, so it cannot be wrong when they switch.
// @ref LLP 0313#the-neutral-prefix [implements]
const CODEX_ROUTE_PREFIX = '/backend-api/codex'
const CODEX_PROVIDER_NAME = 'HypAware Codex Gateway'
// OpenAI platform keys are the only credential the `/v1` upstream accepts and
// the only one `chatgpt.com` never will, so the prefix is the whole test.
// Compared against a lower-cased token: the question is "could these bytes be
// a platform key", and a case-sensitive miss forwards a real one to
// `chatgpt.com`.
const API_KEY_PREFIX = 'sk-'
// Gateway-local request metadata naming the real upstream a steering client
// wants, stripped before the request leaves for the provider (LLP 0109).
const UPSTREAM_HEADER = 'x-hypaware-upstream'

/**
 * The plugin's `config_sections` validator, surfaced as a side-effect-free
 * export so the kernel apply path can validate this plugin's `config` block
 * (the `backfill` policy) *before* the plugin is ever activated: e.g. a
 * central config that first introduces `@hypaware/codex`. It is the same
 * registration `activate()` hands `ctx.configRegistry.registerSection`;
 * importing this module never runs `activate()`, so discovery is safe.
 *
 * @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements]: the plugin owns + exposes its own `backfill` validator
 * @type {{ section: string, validate: typeof validateCodexConfig }}
 */
export const configSection = { section: CODEX_CONFIG_SECTION, validate: validateCodexConfig }

/**
 * Activate the `@hypaware/codex` adapter plugin.
 *
 * Resolves the `hypaware.ai-gateway` capability, registers the
 * OpenAI-compatible upstream preset, wires Codex's config.toml
 * `attach()`, and contributes the `hypaware-query`, `hypaware-reference`,
 * and `hypaware-privacy` skills for Codex installs.
 *
 * `attach()` emits a `client.attach` span tagged with `hyp_plugin`,
 * `client_name`, `status`, and `restored=true|false`. The reversing
 * detach is the single core disk-driven undo (LLP 0045 §Part 3), not a
 * per-adapter hook.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0016#knows-nothing-about-claude-or-codex [implements]: adapter requires the ai-gateway capability; registers client + upstream presets
 */
export async function activate(ctx) {
  // Validate the plugin's own `config` block: currently just the
  // optional `backfill` policy ({ on_join, window_days }) that drives
  // backfill-on-join. Registered so the kernel runs it via
  // `runPerPluginSectionValidators`; no top-level core schema change.
  // @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements]: the source plugin owns and validates its `backfill` config
  ctx.configRegistry.registerSection({
    plugin: PLUGIN_NAME,
    section: CODEX_CONFIG_SECTION,
    validate: validateCodexConfig,
  })

  /** @type {AiGatewayCapability} */
  const gateway = ctx.requireCapability('hypaware.ai-gateway', '^2.0.0')

  // `path_prefix` stays for the sort rank the compiled table derives from it;
  // `match()` reproduces that prefix exactly and adds the steering rung, so
  // this registration is self-sufficient rather than relying on a sibling
  // adapter having won the name-keyed preset slot (LLP 0016's presets are a
  // last-write-wins `Map.set` by name).
  // @ref LLP 0157#adapter-rework [implements]: the `x-hypaware-upstream` rung, so a steered turn selects this upstream per request
  gateway.registerUpstreamPreset({
    name: UPSTREAM_NAME,
    base_url: 'https://api.openai.com',
    path_prefix: '/v1',
    provider: 'openai',
    match: matchOpenaiUpstream,
  })
  // Reachable only by the credential rung: nothing is attached to this name
  // and no client sends this path with an `sk-` key by arrangement. It exists
  // so an API-key login that arrived on the neutral prefix reaches the wire it
  // is scoped for, at that wire's own path shape, without waiting for a
  // reconcile pass or a client restart.
  // @ref LLP 0313#decision [implements]: path and credential together select the upstream
  gateway.registerUpstreamPreset({
    name: OPENAI_CODEX_UPSTREAM_NAME,
    base_url: 'https://api.openai.com',
    path_prefix: CODEX_ROUTE_PREFIX,
    provider: 'openai',
    // Above every config entry, not merely above the `chatgpt` preset, and
    // that is load-bearing rather than decorative: the `hyp init` picker
    // writes a `chatgpt` upstream into operator config, config entries
    // compile at priority 0 and sort ahead of presets on equal rank, so at
    // the inherited rank this preset would lose the default install, which is
    // the install the fix is for.
    //
    // The cost, stated plainly because this comment used to deny it: an
    // operator who declares their own upstream on `/backend-api/codex` IS
    // outranked for requests carrying an api-key-shaped credential. Nothing
    // else is diverted (`match()` requires both the prefix and the
    // credential), but that one case is a real exception to "operator config
    // wins the routing question", taken deliberately because the alternative
    // is forwarding the key to a host that must never see it.
    priority: 10,
    match: matchOpenaiCodexUpstream,
    rewrite: { from: CODEX_ROUTE_PREFIX, to: '/v1' },
  })
  gateway.registerUpstreamPreset({
    name: CHATGPT_UPSTREAM_NAME,
    base_url: 'https://chatgpt.com',
    path_prefix: CODEX_ROUTE_PREFIX,
    provider: 'chatgpt',
    match: matchChatgptUpstream,
  })

  const homeDir = ctx.env.HOME ?? os.homedir()
  const codexHome = resolveCodexHome(ctx)
  // @ref LLP 0103 [implements]: thread the machine-local usage-policy list into
  // the capture-seam resolvers so a `--private` (machine-local `ignore`) dir
  // stops recording at capture, not just at the export seam. Without it the
  // resolvers fall back to a `.hypignore`-dotfile-only view blind to the list.
  // The list lives at the SHARED state root (`readObservabilityEnv(ctx.env).stateDir`),
  // the same path the export seam (activation.js) and query seam (visibility.js)
  // read, NOT the per-plugin `ctx.paths.stateDir` (`<stateRoot>/plugins/<name>`)
  // where the file never exists.
  const localOnlyList = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)

  // @ref LLP 0083 [implements]: give the live projector a rollout-based cwd
  // fallback for the ChatGPT-subscription route (which carries no in-band cwd),
  // reading the SAME session rollouts the backfill scans. Without it,
  // `.hypignore` fails open for that whole traffic class and its rows record
  // cwd = NULL.
  gateway.registerExchangeProjector(createCodexExchangeProjector({
    rolloutCwd: createRolloutCwdResolver({
      sessionsDir: path.join(codexHome, 'sessions'),
      // So the identity guard's refusal (a rollout whose `session_meta.payload.id`
      // is not the thread it was located for) is visible instead of silent: the
      // consequence is a row recorded with cwd = NULL, which otherwise looks
      // identical to a not-yet-written rollout.
      log: ctx.log,
    }),
    localOnlyListPath: localOnlyList,
  }))

  // Backfill provider: imports the local Codex session rollouts the
  // gateway never saw (history written before HypAware attached, or
  // outside the proxy) into `ai_gateway_messages` via `hyp backfill codex`.
  ctx.backfills.register(
    createCodexBackfillProvider({
      homeDir,
      codexHome,
      clientName: CLIENT_NAME,
      pluginName: PLUGIN_NAME,
      localOnlyListPath: localOnlyList,
    })
  )

  const logger = getLogger('plugin.codex')

  gateway.registerClient({
    name: CLIENT_NAME,
    defaultUpstream: UPSTREAM_NAME,
    /** @param {AiGatewayClientAttachContext} attachCtx */
    async attach(attachCtx) {
      const configPath = resolveConfigPath(ctx)

      return withSpan(
        'client.attach',
        {
          [Attr.PLUGIN]: PLUGIN_NAME,
          [Attr.OPERATION]: 'client.attach',
          client_name: CLIENT_NAME,
          hyp_client: CLIENT_NAME,
          dry_run: attachCtx.dryRun === true,
        },
        async (span) => {
          if (attachCtx.dryRun) {
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            const port = safeEndpointPort(attachCtx.endpoint)
            const route = port === undefined ? undefined : codexProviderRoute(port)
            writeAttachOutput(attachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: true,
              configPath,
              port,
              baseUrl: route?.baseUrl,
              changed: false,
            })
            return
          }
          const port = endpointPort(attachCtx.endpoint)
          try {
            const route = codexProviderRoute(port)
            const result = await attach({
              port,
              version: ctx.plugin.version,
              configPath,
              baseUrl: route.baseUrl,
              providerName: route.providerName,
            })
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            logger.info('client.attach.write', {
              hyp_plugin: PLUGIN_NAME,
              hyp_client: CLIENT_NAME,
              config_path: configPath,
              port,
              changed: result.changed === true,
            })
            writeAttachOutput(attachCtx, {
              status: 'ok',
              client: CLIENT_NAME,
              dryRun: false,
              configPath,
              port,
              baseUrl: route.baseUrl,
              changed: result.changed === true,
              prevValue: result.changed && result.prevValue !== undefined
                ? result.prevValue
                : undefined,
            })
          } catch (err) {
            span.setAttribute('status', 'failed')
            span.setAttribute('restored', false)
            throw err
          }
        },
        { component: 'plugin.codex' }
      )
    },
  })

  // @ref LLP 0106 [implements]: Codex's degraded classification prompt. Codex
  // has no SessionStart context-injection hook, so the "force" degrades to a
  // firm first-prompt nag this command emits; same decision, copy, and verbs
  // as Claude's blocking prompt.
  ctx.commands.register({
    name: 'codex-hook classify-cwd',
    summary: 'Internal Codex hook: nag to classify an unclassified folder on an enrolled machine',
    usage: 'hyp codex-hook classify-cwd',
    hidden: true,
    run: runCodexClassifyHook,
  })

  const skillsRoot = path.resolve(skillsRootDir(), 'skills')
  for (const skillName of [
    'hypaware-query',
    'hypaware-reference',
    'hypaware-privacy',
  ]) {
    ctx.skills.register({
      name: skillName,
      plugin: PLUGIN_NAME,
      clients: ['codex'],
      sourceDir: path.join(skillsRoot, skillName),
    })
  }
}

/**
 * Route an inbound request to the `openai` upstream.
 *
 * Two rungs, in precedence order:
 *
 *  1. The `x-hypaware-upstream` request metadata, when it names this
 *     preset's provider. A steering client can then reach this upstream on
 *     a path that carries no `/v1` at all (the bare gateway origin plus
 *     `/chat/completions`), which is otherwise unroutable: the gateway
 *     answers 404 and the caller's turn fails, which capture may never
 *     cause. No Codex or Claude traffic sends this header, so the rung is
 *     inert for every route that exists today.
 *  2. The `/v1` path anchor: byte-for-byte the same set of paths
 *     `pathMatchesPrefix(path, '/v1')` accepts, because a preset that
 *     declares `match()` never falls back to its `path_prefix`. Widening or
 *     narrowing this re-routes live Codex traffic.
 *
 * @ref LLP 0157#adapter-rework [implements]: upstream routing is per request, selected by the `x-hypaware-upstream` metadata via the gateway's existing header match functions
 * @ref LLP 0157#requirements [constrained-by]: R5 - the user's turn MUST NOT fail because of capture, so an unroutable steered turn is a defect
 * @param {AiGatewayRouteInput} input
 * @returns {boolean}
 */
function matchOpenaiUpstream(input) {
  if (headerValue(input.headers, UPSTREAM_HEADER) === 'openai') return true
  return input.path === '/v1' || input.path.startsWith('/v1/')
}

/**
 * Route an API-key request that arrived on the neutral Codex prefix to the
 * OpenAI platform wire.
 *
 * Attach writes one `base_url` in both auth modes, so the path no longer
 * claims which credential the user holds; the request itself does. An
 * `sk-` bearer is unambiguously an OpenAI platform key, and `chatgpt.com`
 * will never accept one, so the only route that can succeed is
 * `api.openai.com/v1/*` (the preset's `rewrite` supplies the path shape).
 *
 * Two rungs:
 *
 *  1. The neutral prefix plus an api-key-shaped credential selects this
 *     upstream, and nothing overrides that. An `x-hypaware-upstream` steer
 *     (LLP 0157) names a destination, and this rung is not a destination
 *     preference but a refusal: no steer may put a platform key on
 *     `chatgpt.com`. Letting the header decline this rung was a hole, because
 *     the presets it deferred to are exactly the ones operator config
 *     replaces (`hyp init` writes `openai` and `chatgpt`), so a steered key
 *     fell through to the unguarded `chatgpt` entry and left for the wrong
 *     host. Claiming it here costs a steered caller nothing it can want:
 *     this upstream is `api.openai.com`, the only host an `sk-` key can
 *     reach, at the `/v1` shape that host actually serves.
 *  2. Anything else declines, so an unrecognized or absent credential falls
 *     back to path routing, which is the behavior that exists today.
 *
 * @ref LLP 0313#decision [implements]: routing is per request, by path and credential
 * @ref LLP 0313#sk-never-reaches-chatgpt [implements]: this preset, not the second-line guard, is what makes the invariant true on a default install
 * @param {AiGatewayRouteInput} input
 * @returns {boolean}
 */
function matchOpenaiCodexUpstream(input) {
  if (!isCodexRoutePath(input.path)) return false
  return carriesApiKeyCredential(input.headers)
}

/**
 * Route the ChatGPT subscription wire, and refuse to carry an API key onto
 * it.
 *
 * The prefix half reproduces `pathMatchesPrefix(path, CODEX_ROUTE_PREFIX)`
 * exactly, because a preset that declares `match()` never falls back to its
 * `path_prefix`. The refusal half is the invariant: an `sk-` key is never
 * sent to `chatgpt.com`. It is second-line only. The `openai-codex` preset
 * above outranks this one and claims that request first; this rung is what
 * happens if it ever does not, and it fails the turn at the gateway with a
 * 404 rather than handing the user's platform key to a host that has no
 * business seeing it.
 *
 * Residual, and it is the ordinary case rather than an exotic one: the
 * `hyp init` picker writes an upstream named `chatgpt` into operator config,
 * config wins the routing question by name, and TOML can express no
 * credential rung. So on a DEFAULT install this guard is not in the routing
 * table at all, and the entry that replaced it routes on `path_prefix`
 * alone. That is why the invariant may not rest here: every request
 * `carriesApiKeyCredential` fails to recognise is one this guard would have
 * refused and that config entry forwards to `chatgpt.com`. `openai-codex`
 * is the mechanism that survives config, which is why its credential test is
 * deliberately the broader one.
 *
 * @ref LLP 0313#sk-never-reaches-chatgpt [implements]: the guard is second-line, behind the openai-codex preset
 * @param {AiGatewayRouteInput} input
 * @returns {boolean}
 */
function matchChatgptUpstream(input) {
  if (!isCodexRoutePath(input.path)) return false
  return !carriesApiKeyCredential(input.headers)
}

/**
 * Path-segment match on the neutral Codex prefix, the same set
 * `pathMatchesPrefix(path, CODEX_ROUTE_PREFIX)` accepts.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isCodexRoutePath(path) {
  return path === CODEX_ROUTE_PREFIX || path.startsWith(CODEX_ROUTE_PREFIX + '/')
}

/**
 * Could this request's `Authorization` header be carrying an OpenAI platform
 * key?
 *
 * Deliberately broader than a strict `Bearer <token>` parse, because the two
 * ways of being wrong are not symmetrical. A false positive sends a non-key
 * credential to `api.openai.com`, which answers 401. A false negative sends
 * a real platform key to `chatgpt.com`, which is the leak this whole change
 * exists to prevent, and on a default install nothing downstream catches it
 * (see `matchChatgptUpstream`). So a malformed scheme, a stray trailing
 * token and an upper-cased prefix all still count as a key.
 *
 * Prefix inspection only, and the value never leaves this function: the
 * gateway already reads and forwards `Authorization`, so testing its first
 * few characters adds no exposure, but nothing here may reach a log line, a
 * span attribute, or a stored row.
 *
 * @ref LLP 0313#credential-inspection [constrained-by]: the token is read, never recorded
 * @param {Record<string, string[]> | undefined} headers
 * @returns {boolean}
 */
function carriesApiKeyCredential(headers) {
  const auth = headerValue(headers, 'authorization')
  if (typeof auth !== 'string') return false
  const value = auth.trim()
  // A well-formed `Bearer <token>` yields the token; anything else is tested
  // whole, so a header that forgot its scheme is still recognised. A real
  // auth-scheme name (`Basic`, `Negotiate`, `Digest`) never begins `sk-`,
  // so testing the whole value adds no false positive.
  const bearer = /^bearer\s+/i.exec(value)
  const token = bearer ? value.slice(bearer[0].length) : value
  return token.toLowerCase().startsWith(API_KEY_PREFIX)
}

/**
 * First non-empty value for a header name, case-insensitively. The route
 * input's headers are already lowercased and array-valued, but the lookup
 * accepts the raw `IncomingHttpHeaders` shape too so it stays usable from a
 * caller that did not go through `buildRouteInput`.
 *
 * @param {Record<string, string | string[] | undefined> | undefined} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function headerValue(headers, name) {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      const found = value.find((entry) => typeof entry === 'string' && entry.length > 0)
      if (typeof found === 'string') return found
    }
  }
  return undefined
}

/**
 * @param {PluginActivationContext} ctx
 */
function resolveConfigPath(ctx) {
  const homeDir = ctx.env.HOME ?? os.homedir()
  return defaultConfigPath(ctx.env, homeDir)
}

/**
 * The one provider block attach writes, in both auth modes, permanently.
 *
 * Neither line names an upstream: the prefix keeps the shape the
 * subscription route already uses (so that route is forwarded byte for byte,
 * exactly as before) and the name is neutral, so nothing in the managed
 * block claims where traffic goes. The gateway resolves that per request,
 * from the credential.
 *
 * This is what makes a login switch a non-event. Nothing on disk encodes the
 * auth mode, so nothing on disk can go stale when the mode changes, and
 * there is no re-attach, reconcile pass, or `codex` restart in the loop.
 *
 * @ref LLP 0313#the-neutral-prefix [implements]: one base_url in both auth modes, so attach never reads auth.json
 * @param {number} port
 */
function codexProviderRoute(port) {
  return {
    baseUrl: `http://127.0.0.1:${port}${CODEX_ROUTE_PREFIX}`,
    providerName: CODEX_PROVIDER_NAME,
  }
}

/**
 * Resolve the Codex home directory the backfill provider scans for session
 * rollouts. Honors `CODEX_HOME` like the attach path, falling back to
 * `~/.codex`.
 *
 * @param {PluginActivationContext} ctx
 */
function resolveCodexHome(ctx) {
  const codexHome = ctx.env.CODEX_HOME
  if (typeof codexHome === 'string' && codexHome.length > 0) {
    return codexHome
  }
  return path.join(ctx.env.HOME ?? os.homedir(), '.codex')
}

function skillsRootDir() {
  const here = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(here), '..')
}

/**
 * @param {string} endpoint
 * @returns {number}
 */
function endpointPort(endpoint) {
  const url = new URL(endpoint)
  const port = Number.parseInt(url.port, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`@hypaware/codex: cannot derive port from endpoint '${endpoint}'`)
  }
  return port
}

/**
 * Like `endpointPort`, but tolerates the placeholder dry-run endpoint
 * (`http://127.0.0.1:0`) the dispatcher uses when the gateway source
 * is not yet started.
 *
 * @param {string} endpoint
 * @returns {number | undefined}
 */
function safeEndpointPort(endpoint) {
  try {
    const url = new URL(endpoint)
    const port = Number.parseInt(url.port, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
    return port
  } catch {
    return undefined
  }
}

/**
 * Render attach output: JSON when the attach context sets `json`,
 * otherwise the human prose the V0 adapter emitted.
 *
 * @param {AiGatewayClientAttachContext} attachCtx
 * @param {{
 *   status: 'ok' | 'failed',
 *   client: string,
 *   dryRun: boolean,
 *   configPath: string,
 *   port: number | undefined,
 *   baseUrl?: string,
 *   changed: boolean,
 *   prevValue?: string,
 * }} fields
 */
function writeAttachOutput(attachCtx, fields) {
  if (attachCtx.json) {
    /** @type {Record<string, unknown>} */
    const payload = {
      status: fields.status,
      action: 'attach',
      client: fields.client,
      dry_run: fields.dryRun,
      config_path: fields.configPath,
      changed: fields.changed,
    }
    if (fields.port !== undefined) {
      payload.port = fields.port
      payload.base_url = fields.baseUrl ?? `http://127.0.0.1:${fields.port}${CODEX_ROUTE_PREFIX}`
    }
    if (fields.prevValue !== undefined) payload.prev_value = fields.prevValue
    attachCtx.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  if (fields.dryRun) {
    attachCtx.stdout.write(`(dry-run) Would attach Codex via ${fields.configPath}\n`)
    attachCtx.stdout.write('  Would set model_provider = hypaware\n')
    if (fields.baseUrl !== undefined) {
      attachCtx.stdout.write(`  Would set base_url = ${fields.baseUrl}\n`)
    } else {
      attachCtx.stdout.write(`  Would set base_url to the local gateway endpoint ${CODEX_ROUTE_PREFIX}\n`)
    }
    return
  }
  attachCtx.stdout.write(`✓ Codex attached (${fields.configPath})\n`)
  attachCtx.stdout.write('  model_provider = hypaware\n')
  if (fields.baseUrl !== undefined) {
    attachCtx.stdout.write(`  base_url = ${fields.baseUrl}\n`)
  } else if (fields.port !== undefined) {
    attachCtx.stdout.write(`  base_url = http://127.0.0.1:${fields.port}${CODEX_ROUTE_PREFIX}\n`)
  }
  if (fields.prevValue !== undefined) {
    attachCtx.stdout.write(`  (previous model_provider was ${fields.prevValue})\n`)
  }
}


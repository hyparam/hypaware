// @ts-check

import fsp from 'node:fs/promises'
import os from 'node:os'

import { isOwnedProviderEntry } from '../../../../src/core/config/provider_entry_ownership.js'
import { resolveClientSettingsPath } from '../../../../src/core/daemon/client_settings_path.js'
import { Attr, getLogger, withSpan } from '../../../../src/core/observability/index.js'
import { atomicWriteFile, errCode, isPlainObject } from 'hypaware/core/util'

/**
 * @import { AiGatewayClientAttachContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { OpenclawAttachOptions, OpenclawAttachOutcome } from './types.js'
 */

const PLUGIN_NAME = '@hypaware/openclaw'
const CLIENT_NAME = 'openclaw'

/**
 * `settings_file` for the OpenClaw config, home-relative exactly as the
 * manifest declares it, so this write and the manifest's `attach_probe`
 * (and therefore `hyp status` / `hyp detach`) resolve the same file through
 * the same core seam, including the `$OPENCLAW_HOME` relocation.
 */
const SETTINGS_FILE = '.openclaw/openclaw.json'

/** The container the two entries live under, per LLP 0167#override-entries. */
const CONTAINER_KEYS = ['models', 'providers']

/** The probeable marker header the gateway's upstream precedence rung reads. */
const MARKER_HEADER = 'x-hypaware-upstream'

/**
 * The client-identity header the gateway-side exchange projector matches on
 * (`projector.js` `match()`: `x-hypaware-client: openclaw`, priority above
 * the Claude projector). Without it every OpenClaw exchange that reaches the
 * gateway is claimed by whichever lower-priority projector fits the wire
 * shape - the Claude projector for Anthropic Messages (misattribution, no
 * settlement, LLP 0175's duplication) - or by none at all (silent
 * passthrough, LLP 0176). The projector tolerates the header's absence for
 * matching purposes; attribution does not, so attach must write it.
 *
 * @ref LLP 0175#root-cause [implements]: attach writes the client header the
 *   projector's match() keys on
 */
const CLIENT_HEADER = 'x-hypaware-client'

/** The two provider keys attach owns, in write order. */
const PROVIDER_KEYS = ['anthropic', 'openai']

const RESTART_COMMAND = 'openclaw gateway restart'

/**
 * The instruction R4 requires both surfaces to end with. A running OpenClaw
 * gateway keeps routing turns at the old `baseUrl` until it is restarted
 * (verified on 2026.3.13, LLP 0167#verify-results item 4), so an attach that
 * does not say this reads as a silent no-op to the user.
 */
const RESTART_INSTRUCTION =
  `restart the OpenClaw gateway ('${RESTART_COMMAND}') to apply`

/**
 * Create the `openclaw` client's `attach()` effect.
 *
 * Writes the two `models.providers` entries of LLP 0167#override-entries into
 * `openclaw.json` and nothing else (R1). Attach never merges into a *user's*
 * entry: a value at either key that HypAware did not write means the user
 * deliberately routed that provider somewhere, and rerouting it silently is
 * the surprise R2 exists to prevent, so attach refuses and writes nothing.
 * An entry HypAware wrote is not that (it is self-identifying, and the same
 * ownership test core's detach applies before deleting one), so attach
 * overwrites its own: that is what makes re-attach-on-drift work, which
 * `action_attach.js`'s `isCurrent()` requires after an ephemeral-port rebind
 * (LLP 0086) or an asset-set change (LLP 0107).
 *
 * Never displacing a user value also means there is no undo record to write:
 * the entries themselves are the marker the manifest's `json_path`
 * `attach_probe` reads and core's detach reverses, and deletion is the whole
 * undo (LLP 0169).
 *
 * Split out of `index.js` rather than inlined into `registerClient()` the way
 * the Claude adapter's dry-run branch is, because the refuse-then-write
 * ordering R2 turns on is the thing worth testing directly, without an
 * activation around it.
 *
 * @param {OpenclawAttachOptions} opts
 * @returns {{ attach(attachCtx: AiGatewayClientAttachContext): Promise<OpenclawAttachOutcome> }}
 * @ref LLP 0167#attach-detach [implements]: attach writes exactly the two
 *   models.providers entries, refuses instead of merging when either key holds
 *   an entry HypAware did not write, and prints the restart instruction; no
 *   undo record beyond the entries themselves.
 */
export function createOpenclawAttach(opts) {
  const homeDir = opts.homeDir ?? os.homedir()
  const env = opts.env
  const fs = opts.fs ?? fsp
  const logger = opts.logger ?? getLogger('plugin.openclaw')

  return {
    /**
     * @param {AiGatewayClientAttachContext} attachCtx
     * @returns {Promise<OpenclawAttachOutcome>}
     */
    async attach(attachCtx) {
      return await withSpan(
        'client.attach',
        {
          [Attr.PLUGIN]: PLUGIN_NAME,
          [Attr.OPERATION]: 'client.attach',
          client_name: CLIENT_NAME,
          hyp_client: CLIENT_NAME,
          dry_run: attachCtx.dryRun === true,
        },
        async (span) => {
          /** @type {string} */
          let settingsPath
          try {
            settingsPath = resolveClientSettingsPath(CLIENT_NAME, SETTINGS_FILE, env, homeDir)
          } catch (err) {
            return fail(span, attachCtx, logger, undefined, errMessage(err), 'settings_path')
          }

          const endpoint = normalizeEndpoint(attachCtx.endpoint)
          if (endpoint === undefined) {
            return fail(
              span,
              attachCtx,
              logger,
              settingsPath,
              `attach needs the local gateway endpoint; got '${String(attachCtx.endpoint)}'`,
              'endpoint'
            )
          }

          // Read first, in every branch including dry-run: the refusal is a
          // property of what is on disk, so a dry run that skipped the read
          // would cheerfully report a write that the real run refuses. This is
          // the whole of "pure read-then-decide, no partial write" (R2): the
          // only write in this function is the single atomicWriteFile below,
          // and every refusal returns before reaching it.
          /** @type {{ value: Record<string, unknown>, existed: boolean, mtimeMs: number | undefined }} */
          let read
          try {
            read = await readOpenclawConfig(settingsPath, fs)
          } catch (err) {
            // A missing or unparseable file is a hard failure, not a refusal:
            // attach cannot reason about a config it cannot read, and writing
            // a fresh one would hand OpenClaw a config it never had.
            return fail(span, attachCtx, logger, settingsPath, errMessage(err), 'read')
          }

          const existing = conflictingProviderKeys(read.value)
          if (existing.length > 0) {
            const reason =
              `models.providers.${existing.join(' and models.providers.')} already ` +
              `exists in ${settingsPath} and was not written by HypAware; attach ` +
              `refuses to merge (LLP 0167#attach-detach). ` +
              `Remove it by hand or run 'hyp detach --client ${CLIENT_NAME}' first.`
            return refuse(span, attachCtx, logger, settingsPath, reason)
          }

          if (attachCtx.dryRun === true) {
            span.setAttribute('status', 'ok')
            span.setAttribute('restored', false)
            span.setAttribute('changed', false)
            writeAttachOutput(attachCtx, {
              status: 'ok',
              dryRun: true,
              settingsPath,
              endpoint,
              changed: false,
            })
            return { status: 'done' }
          }

          const next = withProviderEntries(read.value, endpoint)
          try {
            await atomicWriteFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, {
              fs,
              expectedMtimeMs: read.mtimeMs,
            })
          } catch (err) {
            return fail(span, attachCtx, logger, settingsPath, errMessage(err), 'write')
          }

          span.setAttribute('status', 'ok')
          span.setAttribute('restored', false)
          span.setAttribute('changed', true)
          logger.info('client.attach.write', {
            hyp_plugin: PLUGIN_NAME,
            hyp_client: CLIENT_NAME,
            settings_path: settingsPath,
            endpoint,
            changed: true,
            restart_required: true,
          })
          writeAttachOutput(attachCtx, {
            status: 'ok',
            dryRun: false,
            settingsPath,
            endpoint,
            changed: true,
          })
          return { status: 'done' }
        },
        { component: 'plugin.openclaw' }
      )
    },
  }
}

/**
 * The provider keys of {@link PROVIDER_KEYS} that are occupied by something
 * attach must not overwrite: present under `models.providers` and **not** an
 * entry HypAware itself wrote.
 *
 * Ownership, not bare presence. What R2 protects is a *user's* deliberate
 * routing decision, and HypAware's own entry is not one: it is self-identifying
 * (`baseUrl`, `headers['x-hypaware-upstream']` naming the key it sits at, the
 * empty `models` array), which is the same triple `detachJsonPathProviders`
 * already uses to decide what it may delete, imported rather than restated so
 * the two halves cannot drift.
 *
 * Refusing on bare presence made `attach()` non-idempotent, which
 * re-attach-on-drift needs it to be: `action_attach.js`'s `isCurrent()` returns
 * false whenever the daemon rebound to a new ephemeral port (LLP 0086) or the
 * contributed asset set changed (LLP 0107), and the reconciler then re-performs.
 * Every such re-perform refused over the entry the *previous* attach wrote, so
 * the marker churned to `failed` with `attempts` climbing, `hyp attach openclaw`
 * exited 1, and `openclaw.json` kept pointing at the dead port while the
 * `json_path` probe (which matches the marker header, not the base URL) still
 * reported `attached: true`. Anything that fails the ownership test still
 * refuses, including a bare `"anthropic": null`, a user entry that happens to
 * sit at the key, and a hand-edited one that merely kept the header.
 *
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 * @ref LLP 0086#re-attach-on-drift [constrained-by]: a done attach at a stale
 *   endpoint is re-performed, so the write it re-performs has to be idempotent
 *   over its own previous output
 */
function conflictingProviderKeys(config) {
  const container = readPath(config, CONTAINER_KEYS)
  if (!isPlainObject(container)) return []
  return PROVIDER_KEYS.filter(
    (key) =>
      Object.hasOwn(container, key) &&
      // No base-URL set: the endpoint has moved by the time a drift re-attach
      // runs, so our own entry carries the *old* origin. See the shared
      // predicate's note on why detach passes one and attach does not.
      !isOwnedProviderEntry(container[key], key, MARKER_HEADER, undefined)
  )
}

/**
 * The config with the two entries added, structurally shared down the
 * `models.providers` spine only: every other key of `models`, of
 * `models.providers`, and of the file's top level is carried through by
 * reference (R1, nothing else in `openclaw.json` is touched).
 *
 * The bare-origin/`+/v1` asymmetry is load-bearing and not a typo: OpenClaw's
 * Anthropic client appends `/v1/messages` to `baseUrl` itself and wants the
 * bare origin, while its OpenAI client appends only `/responses` or
 * `/chat/completions` and so needs the `/v1` prefix baked in. Both spellings
 * are schema-valid, so getting either wrong produces a config OpenClaw accepts
 * and silently fails to route through the gateway (LLP 0167#override-entries).
 *
 * @param {Record<string, unknown>} config
 * @param {string} endpoint  gateway base URL, already trailing-slash-normalized
 * @returns {Record<string, unknown>}
 */
function withProviderEntries(config, endpoint) {
  const models = isPlainObject(config.models) ? config.models : {}
  const providers = isPlainObject(models.providers) ? models.providers : {}
  return {
    ...config,
    models: {
      ...models,
      providers: {
        ...providers,
        anthropic: providerEntry(endpoint, 'anthropic'),
        openai: providerEntry(`${endpoint}/v1`, 'openai'),
      },
    },
  }
}

/**
 * One override entry. `models: []` is mandatory, not decorative: OpenClaw's
 * config schema types it as a required array and hard-refuses CLI commands on
 * a schema-invalid config, while an empty array validates without emptying the
 * built-in catalog.
 *
 * @param {string} baseUrl
 * @param {string} upstream
 * @returns {Record<string, unknown>}
 */
function providerEntry(baseUrl, upstream) {
  return {
    baseUrl,
    // Two headers, two readers: the marker names the upstream the gateway
    // forwards to; the client header is what the openclaw exchange projector
    // matches on, and it is what makes a captured exchange attribute (and
    // later settle) as openclaw rather than falling through to the Claude
    // projector. Ownership (isOwnedProviderEntry) keys on the marker alone,
    // so entries written before the client header existed still detach.
    headers: { [MARKER_HEADER]: upstream, [CLIENT_HEADER]: CLIENT_NAME },
    models: [],
  }
}

/**
 * Read and parse `openclaw.json`, with the `mtimeMs` the write is gated on so
 * a concurrent edit is detected rather than silently overwritten.
 *
 * Absent and unparseable are both thrown, not returned as an empty config:
 * step 1 of LLP 0172 §1.2 makes them hard failures.
 *
 * @param {string} settingsPath
 * @param {typeof fsp} fs
 * @returns {Promise<{ value: Record<string, unknown>, existed: boolean, mtimeMs: number | undefined }>}
 */
async function readOpenclawConfig(settingsPath, fs) {
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      throw new Error(
        `${settingsPath} does not exist; is OpenClaw installed? ` +
        'attach will not create an OpenClaw config it never had'
      )
    }
    throw new Error(`failed to read ${settingsPath}: ${errMessage(err)}`, { cause: err })
  }

  const stat = await fs.stat(settingsPath)

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`malformed JSON in ${settingsPath}: ${errMessage(err)}`, { cause: err })
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${settingsPath} is not a JSON object; refuse to modify`)
  }
  return { value: parsed, existed: true, mtimeMs: stat.mtimeMs }
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} keys
 * @returns {unknown}
 */
function readPath(value, keys) {
  /** @type {unknown} */
  let cursor = value
  for (const key of keys) {
    if (!isPlainObject(cursor)) return undefined
    cursor = cursor[key]
  }
  return cursor
}

/**
 * The gateway base URL with any trailing slash removed, so the `openai`
 * entry's `+ '/v1'` never produces a doubled separator.
 *
 * @param {unknown} endpoint
 * @returns {string | undefined}
 */
function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return undefined
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Record a refusal or hard failure on the span, the log, and the caller's
 * chosen output mode. Side effects only: the outcome shape is the caller's,
 * which is the whole reason this is split out of {@link fail}.
 *
 * Every one of these three surfaces reports `status: 'failed'` for a refusal
 * as much as for a hard failure, and deliberately so. `writeAttachOutput`'s
 * `--json` payload is a wire contract a scripted caller already parses, and
 * the terminal/transient distinction {@link refuse} draws is a fact about how
 * *the reconciler* should schedule a retry, not about what the user's attach
 * just did: from the CLI's side both did not apply, both print the same
 * actionable reason, and neither changed the file. The `errorKind` span
 * attribute is where the two stay distinguishable in telemetry.
 *
 * @param {{ setAttribute(key: string, value: unknown): void }} span
 * @param {AiGatewayClientAttachContext} attachCtx
 * @param {{ warn(event: string, fields: Record<string, unknown>): void }} logger
 * @param {string | undefined} settingsPath
 * @param {string} reason
 * @param {string} errorKind
 * @returns {void}
 */
function reportAttachFailure(span, attachCtx, logger, settingsPath, reason, errorKind) {
  span.setAttribute('status', 'failed')
  span.setAttribute('restored', false)
  span.setAttribute('changed', false)
  span.setAttribute(Attr.ERROR_KIND, errorKind)
  logger.warn('client.attach.refused', {
    hyp_plugin: PLUGIN_NAME,
    hyp_client: CLIENT_NAME,
    ...(settingsPath !== undefined ? { settings_path: settingsPath } : {}),
    [Attr.ERROR_KIND]: errorKind,
    reason,
  })
  writeAttachOutput(attachCtx, {
    status: 'failed',
    dryRun: attachCtx.dryRun === true,
    settingsPath,
    changed: false,
    reason,
  })
}

/**
 * A hard failure: something environmental went wrong (the settings path did
 * not resolve, the endpoint was absent, the read or the write threw) and a
 * later pass may well succeed, so the outcome is the transient
 * `{status:'failed', reason}` the reconciler records, warns about, and retries.
 *
 * Returning rather than throwing is what makes LLP 0169's join-safety clause
 * reachable: the generic `ActionOutcome` contract downgrades a `failed`
 * outcome to a recorded, retried warning that does not abort the join's other
 * actions, so the only obligation here is to never throw out of this path (and
 * to have written nothing before reaching it). Reaching that contract still
 * takes one translation: the kernel types the *registered* `attach()` as
 * `Promise<void>`, so `index.js`'s wrapper rethrows this outcome and
 * `perform()`'s catch turns it back into the same shape (LLP 0172 §1.3).
 *
 * @param {{ setAttribute(key: string, value: unknown): void }} span
 * @param {AiGatewayClientAttachContext} attachCtx
 * @param {{ warn(event: string, fields: Record<string, unknown>): void }} logger
 * @param {string | undefined} settingsPath
 * @param {string} reason
 * @param {string} errorKind  one of `settings_path`, `endpoint`, `read`, `write`
 * @returns {OpenclawAttachOutcome}
 * @ref LLP 0169#decision [implements]: a refuse during join warns and never
 *   fails the join, via the existing ActionOutcome 'failed' contract, not a
 *   new one.
 */
function fail(span, attachCtx, logger, settingsPath, reason, errorKind) {
  reportAttachFailure(span, attachCtx, logger, settingsPath, reason, errorKind)
  return { status: 'failed', reason }
}

/**
 * The ownership conflict of {@link conflictingProviderKeys}: a value HypAware
 * did not write already sits at a `models.providers` key attach owns. Reported
 * identically to a hard {@link fail} on every user-facing surface, but handed
 * back as the terminal `refused` outcome, because no number of reconciler
 * passes changes what is in the user's config. `failed` here is what produced
 * LLP 0184's forever-retried marker with `attempts` climbing; only the user
 * removing the entry (or `hyp detach`) fixes it, and only an explicit
 * `hyp attach` re-arms the marker.
 *
 * Its own function rather than a `status` argument to {@link fail} on purpose:
 * this is the sole refusal in the adapter, so there is no parameter for a
 * future call site to pass wrong, and the four `errorKind`s that stay
 * transient cannot drift into it by accident.
 *
 * @param {{ setAttribute(key: string, value: unknown): void }} span
 * @param {AiGatewayClientAttachContext} attachCtx
 * @param {{ warn(event: string, fields: Record<string, unknown>): void }} logger
 * @param {string} settingsPath
 * @param {string} reason
 * @returns {OpenclawAttachOutcome}
 * @ref LLP 0186#migration-who-calls-markactionrefused [implements]: the
 *   ownership-conflict call site alone returns 'refused'; the other four
 *   errorKinds keep returning 'failed' and keep retrying.
 */
function refuse(span, attachCtx, logger, settingsPath, reason) {
  reportAttachFailure(span, attachCtx, logger, settingsPath, reason, 'refused')
  return { status: 'refused', reason }
}

/**
 * Render attach output: one machine-readable JSON line when `json` is set on
 * the attach context, otherwise human prose. Both paths carry the restart
 * instruction whenever there is (or would be) something to apply, which is
 * what R4 asks for: `--json` callers are as blocked on the restart as a human
 * is, so hiding it behind the prose branch would make the automated path the
 * one that silently does not work.
 *
 * @param {AiGatewayClientAttachContext} attachCtx
 * @param {{
 *   status: 'ok' | 'failed',
 *   dryRun: boolean,
 *   settingsPath: string | undefined,
 *   endpoint?: string,
 *   changed: boolean,
 *   reason?: string,
 * }} fields
 */
function writeAttachOutput(attachCtx, fields) {
  // A refusal changed nothing, so there is nothing to restart for; saying
  // otherwise would send the user to bounce a gateway that is already
  // correct.
  const restart = fields.status === 'ok'
  if (attachCtx.json) {
    /** @type {Record<string, unknown>} */
    const payload = {
      status: fields.status,
      action: 'attach',
      client: CLIENT_NAME,
      dry_run: fields.dryRun,
      changed: fields.changed,
    }
    if (fields.settingsPath !== undefined) payload.settings_path = fields.settingsPath
    if (fields.endpoint !== undefined) payload.endpoint = fields.endpoint
    if (fields.reason !== undefined) payload.reason = fields.reason
    if (restart) {
      payload.providers = [...PROVIDER_KEYS]
      payload.restart_required = true
      payload.restart_command = RESTART_COMMAND
      payload.message = RESTART_INSTRUCTION
    }
    attachCtx.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  if (fields.status === 'failed') {
    attachCtx.stdout.write(`! OpenClaw attach did not apply: ${fields.reason ?? 'unknown reason'}\n`)
    return
  }
  const path = fields.settingsPath ?? '(unknown path)'
  if (fields.dryRun) {
    attachCtx.stdout.write(`(dry-run) Would attach OpenClaw via ${path}\n`)
  } else {
    attachCtx.stdout.write(`✓ OpenClaw attached (${path})\n`)
  }
  attachCtx.stdout.write(`  models.providers.anthropic baseUrl = ${fields.endpoint}\n`)
  attachCtx.stdout.write(`  models.providers.openai    baseUrl = ${fields.endpoint}/v1\n`)
  attachCtx.stdout.write(`  ${RESTART_INSTRUCTION}\n`)
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

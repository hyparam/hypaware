// @ts-check

import fsp from 'node:fs/promises'
import os from 'node:os'

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
 * `openclaw.json` and nothing else (R1). Attach is refuse + create-only: those
 * two keys are purely user-authored, so their presence means the user
 * deliberately routed that provider somewhere and a merge would silently
 * reroute it (R2). Create-only also means there is no undo record to write:
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
 *   models.providers entries, refuses instead of merging when either already
 *   exists, and prints the restart instruction; no undo record beyond the
 *   entries themselves.
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

          const existing = existingProviderKeys(read.value)
          if (existing.length > 0) {
            const reason =
              `models.providers.${existing.join(' and models.providers.')} already ` +
              `exists in ${settingsPath}; attach refuses to merge (LLP 0167#attach-detach). ` +
              `Remove it by hand or run 'hyp detach --client ${CLIENT_NAME}' first.`
            return fail(span, attachCtx, logger, settingsPath, reason, 'refused')
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
 * The provider keys of {@link PROVIDER_KEYS} already present under
 * `models.providers`. Presence, not type: these keys come off disk, and a
 * user's `"anthropic": null` is every bit as deliberate an override as a full
 * entry. Anything at the key is the user's.
 *
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 */
function existingProviderKeys(config) {
  const container = readPath(config, CONTAINER_KEYS)
  if (!isPlainObject(container)) return []
  return PROVIDER_KEYS.filter((key) => Object.hasOwn(container, key))
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
    headers: { [MARKER_HEADER]: upstream },
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
 * chosen output mode, and hand back the `{status:'failed', reason}` shape.
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
 * @param {string} errorKind
 * @returns {OpenclawAttachOutcome}
 * @ref LLP 0169#decision [implements]: a refuse during join warns and never
 *   fails the join, via the existing ActionOutcome 'failed' contract, not a
 *   new one.
 */
function fail(span, attachCtx, logger, settingsPath, reason, errorKind) {
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
  return { status: 'failed', reason }
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

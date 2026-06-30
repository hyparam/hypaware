// @ts-check

import { Attr } from '../observability/index.js'
import { readAttachPolicy } from './attach_policy.js'
import { detachClientFromDisk } from './client_detach_disk.js'

/**
 * @import {
 *   ActionContext,
 *   ActionHandler,
 *   ActionOutcome,
 *   ClientDetachFromDisk,
 *   CreateAttachHandlerOptions,
 *   DesiredAction,
 * } from './types.d.ts'
 * @import { JsonObject } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * The attach action handler — the reversible instance of the generic
 * client-action reconciler (LLP 0036 / LLP 0044). When a joined machine
 * confirms a central config that enables a client adapter, the daemon performs
 * that client's attach machine-effect (a bounded settings write, in-process —
 * *not* a subprocess like backfill); when the config later drops the client it
 * reverses it. It is the `action_backfill.js` twin, the first handler to
 * implement `reverse()`.
 *
 * Three roles split across two seams the daemon threads onto the context
 * (LLP 0045 §Part 1): `ctx.clientDescriptors` *enumerates* the client adapters
 * and their owning plugins (for `desired()` and the disk-driven undo's
 * `attachProbe`), while the runtime `ctx.clients` registry only *invokes* the
 * effect (`getClient(name).attach(...)`). The registry carries no owning-plugin
 * field, so descriptors are the source of truth for "is this client's plugin
 * enabled?"; the registry is consulted only to reach `perform()`.
 *
 * `perform()` is adapter-driven (it needs a live `attach()`); `reverse()` is
 * **disk-driven** — it runs after the staged restart has already unloaded the
 * adapter, so `ctx.clients` no longer has the dropped client and there is no
 * live `detach()` to call. The undo is the single core routine
 * `detachClientFromDisk` (LLP 0045 §Part 3), injectable so tests assert it runs
 * without a gateway.
 *
 * @param {CreateAttachHandlerOptions} [opts]
 * @returns {ActionHandler}
 * @ref LLP 0045#part-2--the-attach-handler-srccoreconfigaction_attachjs [implements] — createAttachHandler(opts) → ActionHandler { kind:'attach', desired/perform/reverse }, mirroring action_backfill.js
 * @ref LLP 0044 — client attach on join (the instance this realizes)
 */
export function createAttachHandler(opts = {}) {
  /** @type {ClientDetachFromDisk} */
  const detach = opts.detach ?? detachClientFromDisk

  return {
    kind: 'attach',

    /**
     * Enumerate the client adapters to attach. Pure: iterate
     * `ctx.clientDescriptors`, keep each descriptor whose owning `plugin` is
     * enabled in `ctx.config.plugins`, whose entry does not set
     * `attach.on_join: false` (read via `attach_policy.js`, the
     * `backfill_policy.js` twin), whose descriptor declares an `attachProbe`
     * (so the effect is reversible, see below), and whose client the runtime
     * registry has (`ctx.clients.getClient(name)` defined) so it never names a
     * client `perform()` cannot reach. The owning plugin comes from the
     * descriptor, not from `listClients()` (which omits it). Daemon-only by
     * construction: a plain CLI boot has neither `clientDescriptors` nor
     * `clients`, so the handler stays inert.
     *
     * @param {ActionContext} ctx
     * @returns {DesiredAction[]}
     * @ref LLP 0045#part-2--the-attach-handler-srccoreconfigaction_attachjs [implements] — desired() over clientDescriptors ∩ enabled plugins ∩ attach_policy, guarded on the runtime registry having the client
     * @ref LLP 0044#consent--join-implies-consent-default-on [constrained-by] — default-on; only `attach.on_join:false` in the locked central plugin entry opts out
     * @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [constrained-by]: attach-eligibility requires the `attachProbe` reverse() replays; a probe-less client could attach but never be undone, orphaning its settings on a config-drop (#212)
     */
    desired(ctx) {
      const descriptors = ctx.clientDescriptors
      const clients = ctx.clients
      // Daemon-only: with no client catalog or no gateway registry there is
      // nothing to attach (LLP 0045 §Part 1 — attach is daemon-only by
      // construction).
      if (!descriptors || !clients) return []

      const activePlugins = ctx.config.plugins ?? []
      const byPluginName = new Map(
        activePlugins
          .filter((p) => p && typeof p.name === 'string')
          .map((p) => [p.name, p])
      )

      /** @type {DesiredAction[]} */
      const desired = []
      for (const descriptor of descriptors.values()) {
        const entry = byPluginName.get(descriptor.plugin)
        // Plugin absent from config or explicitly disabled → not a target.
        if (!entry || entry.enabled === false) continue
        // Default-on: only an explicit `on_join: false` opts out.
        if (readAttachPolicy(entry).onJoin === false) continue
        // Attach-eligibility requires reverse-capability. reverse() undoes the
        // on-disk settings by replaying the descriptor's `attachProbe` (Part 3);
        // perform() needs no probe (it just calls the live adapter). A probe-less
        // client would therefore attach and mark `done` but could never be
        // reversed: on a config-drop the marker drops while the settings stay
        // written, orphaning them. Never name a client we cannot also undo (#212).
        if (!descriptor.attachProbe) continue
        // Never name a client the runtime registry can't reach.
        if (!clients.getClient(descriptor.name)) continue
        desired.push({
          requestKey: descriptor.name,
          params: { client: descriptor.name, plugin: descriptor.plugin },
        })
      }
      return desired
    },

    /**
     * Attach one client. In-process (a bounded settings write — LLP 0041
     * §Execution isolation), not a subprocess like backfill. Resolves the
     * runtime registration, calls `attach({ endpoint, config:{}, stdout,
     * stderr, json:true })`, parses the one-line JSON the adapter emits, and
     * records `settings_path` / `prev_value` as the marker detail. A throw
     * (file not writable, malformed settings) becomes a `failed` outcome the
     * reconciler records and retries next pass.
     *
     * @param {DesiredAction} action
     * @param {ActionContext} ctx
     * @returns {Promise<ActionOutcome>}
     * @ref LLP 0045#part-2--the-attach-handler-srccoreconfigaction_attachjs [implements] — perform() calls attach(json:true), parses the one-line JSON, records the marker detail (settings_path, prev_value)
     */
    async perform(action, ctx) {
      const params = action.params ?? {}
      const client =
        typeof params.client === 'string' && params.client.length > 0
          ? params.client
          : action.requestKey
      if (typeof client !== 'string' || client.length === 0) {
        return { status: 'failed', reason: 'attach action missing client name' }
      }

      const registration = ctx.clients?.getClient(client)
      if (!registration) {
        return { status: 'failed', reason: `no registered client '${client}' to attach` }
      }
      const endpoint = ctx.endpoint
      if (typeof endpoint !== 'string' || endpoint.length === 0) {
        return { status: 'failed', reason: 'attach action missing gateway endpoint' }
      }

      const stdout = captureStream()
      const stderr = captureStream()

      ctx.log.info('client_action.attach_perform', {
        [Attr.COMPONENT]: 'action-attach',
        [Attr.OPERATION]: 'client_action.perform',
        [Attr.PLUGIN]: typeof params.plugin === 'string' ? params.plugin : client,
        client,
        endpoint,
        [Attr.STATUS]: 'ok',
      })

      try {
        await registration.attach({ endpoint, config: {}, stdout, stderr, json: true })
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
      }

      const parsed = parseAttachOutput(stdout.text())
      // No throw = the attach applied. An unparseable / detail-less payload
      // still records `done` (mirroring backfill's "exit 0 is authoritative")
      // rather than re-running a successful attach — we just can't attach the
      // marker detail.
      if (!parsed) return { status: 'done' }

      /** @type {JsonObject} */
      const detail = {}
      if (typeof parsed.settings_path === 'string') detail.settings_path = parsed.settings_path
      if (typeof parsed.prev_value === 'string') detail.prev_value = parsed.prev_value
      return Object.keys(detail).length > 0 ? { status: 'done', detail } : { status: 'done' }
    },

    /**
     * Reverse a previously-applied attach whose request key the config no
     * longer names (the central config dropped the client, or flipped
     * `attach.on_join` to false). **Disk-driven, not adapter-driven**: the
     * headline reverse fires only after the staged restart has unloaded the
     * adapter, so `ctx.clients.getClient(client)` is `undefined` and there is
     * no live `detach()` to call. Instead it reads the descriptor's
     * `attachProbe` + the settings-file marker (the self-describing undo
     * record `attach()` wrote) and replays the single core undo
     * (`detachClientFromDisk`) — the same one `hyp detach` uses. It needs
     * `ctx.clientDescriptors` and the filesystem, **never** `ctx.clients`.
     *
     * A descriptor with **no `attachProbe`** cannot be honestly reversed: the
     * core undo returns `{ changed: false }` for "no probe" exactly as it does
     * for "already clean", so a `done` here would silently drop the marker while
     * the settings `attach()` wrote stay on disk, orphaned and invisible to a
     * later detach. Treat a missing probe as a **failed** (retryable, visible)
     * reverse instead. `desired()` already refuses to attach a probe-less client,
     * so this only fires for a marker applied out-of-band (e.g. manual
     * `hyp attach`, or a pre-fix marker).
     *
     * @param {string} requestKey  The client name whose attach to reverse.
     * @param {ActionContext} ctx
     * @returns {Promise<ActionOutcome>}
     * @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements]: reverse() invokes the single disk-driven core undo (detachClientFromDisk), not ctx.clients; a missing attachProbe is a failed reverse, not a no-op marker drop (#212)
     */
    async reverse(requestKey, ctx) {
      const descriptor = ctx.clientDescriptors?.get(requestKey)
      if (!descriptor) {
        // The descriptor normally survives a fleet-drop (only the config entry
        // goes away), so this is a real gap; keep the marker and retry.
        return { status: 'failed', reason: `no client descriptor for '${requestKey}' to reverse` }
      }
      if (!descriptor.attachProbe) {
        // No probe → the disk-driven undo can do nothing, but a marker exists
        // (that is why reverse fired). Returning `done` would drop it while the
        // settings stay written, orphaning them. Fail honestly so the marker
        // stays visible and retryable rather than silently dropped (#212).
        return {
          status: 'failed',
          reason: `client '${descriptor.name}' has no attach_probe; cannot reverse its on-disk settings - keeping the marker rather than orphaning them`,
        }
      }

      ctx.log.info('client_action.attach_reverse', {
        [Attr.COMPONENT]: 'action-attach',
        [Attr.OPERATION]: 'client_action.reverse',
        [Attr.PLUGIN]: descriptor.plugin,
        client: descriptor.name,
        [Attr.STATUS]: 'ok',
      })

      let result
      try {
        result = await detach({ descriptor, env: ctx.env })
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
      }

      if (result.warning) {
        // The managed value was overridden externally after we attached; the
        // undo left it in place. Surface it, but the undo itself succeeded.
        ctx.log.warn('client_action.attach_reverse_warning', {
          [Attr.COMPONENT]: 'action-attach',
          [Attr.OPERATION]: 'client_action.reverse',
          client: descriptor.name,
          [Attr.STATUS]: 'ok',
          detail: result.warning,
        })
      }

      // Idempotent: a no-op (file already clean / marker absent) is still a
      // successful undo — the reconciler drops the marker either way.
      return { status: 'done' }
    },
  }
}

/**
 * The default `attachHandler` the daemon registers the reconciler with — first
 * in the `[attachHandler, backfillHandler]` order so in-process live-capture
 * wiring starts ahead of the (possibly multi-minute) backfill subprocess
 * (LLP 0045 §Module / seam breakdown item 7). Uses the real
 * `detachClientFromDisk`; tests build their own via {@link createAttachHandler}
 * with an injected `detach`.
 *
 * @type {ActionHandler}
 */
export const attachHandler = createAttachHandler()

/* ------------------------------- Internals ------------------------------- */

/**
 * A capturing `WriteStream` — accumulates every `write(chunk)` so the handler
 * can parse the adapter's machine-readable `json: true` output after the
 * in-process `attach()` returns. (The real CLI hands the adapter `ctx.stdout`;
 * the handler instead captures it.)
 *
 * @returns {{ write(chunk: string): boolean, text(): string }}
 */
function captureStream() {
  /** @type {string[]} */
  const chunks = []
  return {
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    text() {
      return chunks.join('')
    },
  }
}

/**
 * Parse the one-line JSON object an adapter emits in `json: true` mode
 * (`{ status, action, client, dry_run, settings_path?, port?, changed?,
 * prev_value? }`). Tolerant: trims, and on a parse miss falls back to the last
 * non-empty line (in case prose leaked onto stdout). Returns `undefined` when
 * nothing parses to an object so the caller records `done` without detail
 * rather than re-running a successful attach.
 *
 * @param {string} stdout
 * @returns {Record<string, unknown> | undefined}
 */
function parseAttachOutput(stdout) {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return undefined

  let parsed = tryParseObject(trimmed)
  if (parsed === undefined) {
    const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    const last = lines[lines.length - 1]
    if (last !== undefined) parsed = tryParseObject(last)
  }
  return parsed
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | undefined}
 */
function tryParseObject(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined
}

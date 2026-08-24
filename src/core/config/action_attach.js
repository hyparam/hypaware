// @ts-check

import os from 'node:os'

import { Attr } from '../observability/index.js'
import { clientAssetStateRoot } from '../runtime/client_asset_ledger.js'
import {
  clientAssetBaseDirs,
  clientAssetsKey,
  materializeClientAssets,
  removeClientAssets,
} from '../runtime/client_assets.js'
import { readInstalledAssets } from './action_reconciler.js'
import { isActionRefused } from './action_refusal.js'
import { readAttachPolicy } from './attach_policy.js'
import { detachClientFromDisk } from './client_detach_disk.js'

/**
 * @import {
 *   ActionContext,
 *   ActionHandler,
 *   ActionMarker,
 *   ActionOutcome,
 *   ClientDetachFromDisk,
 *   CreateAttachHandlerOptions,
 *   DesiredAction,
 * } from './types.d.ts'
 * @import { MaterializeClientAssetsOptions } from '../../../src/core/runtime/types.js'
 * @import { JsonObject } from '../../../hypaware-plugin-kernel-types.d.ts'
 */

/**
 * The attach action handler: the reversible instance of the generic
 * client-action reconciler (LLP 0036 / LLP 0044). When a joined machine
 * confirms a central config that enables a client adapter, the daemon performs
 * that client's attach machine-effect (a bounded settings write, in-process:
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
 * **disk-driven**: it runs after the staged restart has already unloaded the
 * adapter, so `ctx.clients` no longer has the dropped client and there is no
 * live `detach()` to call. The undo is the single core routine
 * `detachClientFromDisk` (LLP 0045 §Part 3), injectable so tests assert it runs
 * without a gateway.
 *
 * @param {CreateAttachHandlerOptions} [opts]
 * @returns {ActionHandler}
 * @ref LLP 0045#part-2-the-attach-handler-srccoreconfigaction_attachjs [implements]: createAttachHandler(opts) → ActionHandler { kind:'attach', desired/perform/reverse }, mirroring action_backfill.js
 * @ref LLP 0044: client attach on join (the instance this realizes)
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
     * @ref LLP 0045#part-2-the-attach-handler-srccoreconfigaction_attachjs [implements]: desired() over clientDescriptors ∩ enabled plugins ∩ attach_policy, guarded on the runtime registry having the client
     * @ref LLP 0044#consent-join-implies-consent-default-on [constrained-by]: default-on; only `attach.on_join:false` in the locked central plugin entry opts out
     * @ref LLP 0045#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [constrained-by]: attach-eligibility requires the `attachProbe` reverse() replays; a probe-less client could attach but never be undone, orphaning its settings on a config-drop (#212)
     */
    desired(ctx) {
      const descriptors = ctx.clientDescriptors
      const clients = ctx.clients
      // Daemon-only: with no client catalog or no gateway registry there is
      // nothing to attach (LLP 0045 §Part 1, attach is daemon-only by
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
     * Attach one client. In-process (a bounded settings write: LLP 0041
     * §Execution isolation), not a subprocess like backfill. Resolves the
     * runtime registration, calls `attach({ endpoint, config:{}, stdout,
     * stderr, json:true })`, parses the one-line JSON the adapter emits, and
     * records `settings_path` / `prev_value` as the marker detail. A throw
     * (file not writable, malformed settings) becomes a `failed` outcome the
     * reconciler records and retries next pass, unless the adapter marked it
     * a permanent refusal (LLP 0186), which becomes a `refused` outcome the
     * reconciler short-circuits unconditionally instead.
     *
     * @param {DesiredAction} action
     * @param {ActionContext} ctx
     * @returns {Promise<ActionOutcome>}
     * @ref LLP 0045#part-2-the-attach-handler-srccoreconfigaction_attachjs [implements]: perform() calls attach(json:true), parses the one-line JSON, records the marker detail (settings_path, prev_value)
     */
    async perform(action, ctx) {
      const client = attachActionClient(action)
      if (typeof client !== 'string' || client.length === 0) {
        return { status: 'failed', reason: 'attach action missing client name' }
      }

      const registration = ctx.clients?.getClient(client)
      if (!registration) {
        return { status: 'failed', reason: `no registered client '${client}' to attach` }
      }
      const endpoint = ctx.endpoint
      if (
        registration.requiresEndpoint !== false &&
        (typeof endpoint !== 'string' || endpoint.length === 0)
      ) {
        return { status: 'failed', reason: 'attach action missing gateway endpoint' }
      }

      const stdout = captureStream()
      const stderr = captureStream()

      ctx.log.info('client_action.attach_perform', {
        [Attr.COMPONENT]: 'action-attach',
        [Attr.OPERATION]: 'client_action.perform',
        [Attr.PLUGIN]: typeof action.params?.plugin === 'string' ? action.params.plugin : client,
        client,
        ...(endpoint ? { endpoint } : {}),
        [Attr.STATUS]: 'ok',
      })

      try {
        await registration.attach({ ...(endpoint ? { endpoint } : {}), config: {}, stdout, stderr, json: true })
      } catch (err) {
        // A marked refusal (LLP 0186) is a permanent precondition failure only
        // the user can fix; anything else is the transient `failed` the
        // reconciler retries next pass.
        // @ref LLP 0186#markactionrefused--isactionrefused [implements]: perform()'s catch reads the marked-Error convention to tell a refusal from an environmental failure
        return {
          status: isActionRefused(err) ? 'refused' : 'failed',
          reason: err instanceof Error ? err.message : String(err),
        }
      }

      // Attach means "wire this client into HypAware", and the client's
      // registered skills and subagents are part of that wiring: without this
      // an enrolled machine gets capture but none of the helpers, including the
      // privacy-review skill the LLP 0100 flow depends on. Bytes come from
      // locally installed plugin packages, so this makes no server contact and
      // opens no channel for org config to author skill content.
      // Non-fatal: the attach itself applied, so a copy failure must not churn
      // the marker to `failed` and re-attach every pass.
      // @ref LLP 0107#every-attach [implements]: the reconciler attach
      //   materializes client assets, the same set a manual attach installs
      // @ref LLP 0138#one-materializer [implements]: skills and subagents
      //   through the one shared routine
      const installedAssets = await materializeAttachedAssets(client, ctx)

      const parsed = parseAttachOutput(stdout.text())
      // No throw = the attach applied. Record the endpoint we attached at on the
      // marker regardless of whether the adapter payload parsed: it is the
      // freshness key `isCurrent` compares against a later boot's live endpoint,
      // so a rebind to a new ephemeral port is a forward gap (re-attach) rather
      // than a permanent `done` (issue #277 / LLP 0086). settings_path /
      // prev_value / port are best-effort detail from the adapter's payload.
      // @ref LLP 0086#endpoint-aware-markers [implements]: perform() records the endpoint on the done marker so drift is representable
      /** @type {JsonObject} */
      const detail = endpoint ? { endpoint } : {}
      // Claude's adapter has exactly one successful attach mode. Record that
      // invariant from the requested client, not from best-effort stdout, so a
      // parse miss cannot leave the new marker stale and re-run attach forever.
      // @ref LLP 0262#migration [implements]: a successful Claude attach settles the proxy-to-OTEL migration even when its report payload is unavailable
      if (client === 'claude') detail.mode = 'otel'
      if (parsed) {
        if (typeof parsed.settings_path === 'string') detail.settings_path = parsed.settings_path
        if (typeof parsed.prev_value === 'string') detail.prev_value = parsed.prev_value
        if (client !== 'claude' && typeof parsed.mode === 'string') detail.mode = parsed.mode
      }
      // The undo record for the copies: reverse() removes exactly these paths,
      // so a user's own `hyp skills install` (which records no marker) survives
      // a leave (LLP 0107 §reversal).
      if (installedAssets.length > 0) detail.installed_assets = installedAssets
      // The other freshness key beside the endpoint: what this attach's asset
      // set was, so a later pass over a changed plugin set re-materializes
      // (see isCurrent). Recorded from the plan rather than from what landed,
      // because that is what isCurrent can recompute without touching disk; a
      // copy that failed is a degraded install to warn about, not a reason to
      // re-attach every pass (#failure-is-not-fatal).
      // @ref LLP 0107#currency [implements]: the marker carries the asset set,
      //   so a plugin the org adds later is a forward gap the reconciler closes
      const assetsKey = attachedAssetsKey(client, ctx)
      if (assetsKey !== undefined) detail.assets_key = assetsKey
      return { status: 'done', detail }
    },

    /**
     * Freshness predicate for a `done` attach marker (LLP 0086). Three things
     * can go stale, and each is checked against what the marker recorded.
     *
     * **The endpoint.** Returns `false` when the recorded endpoint no longer
     * matches the live gateway endpoint: the daemon rebound to a new ephemeral
     * port and this attach must re-fire. Two guards keep it from over-firing:
     *
     *  - No live `ctx.endpoint` this pass (the gateway never bound): return
     *    `true` (leave the existing attach in place). Re-performing would only
     *    fail `perform()`'s missing-endpoint guard and churn the marker to
     *    `failed`; a later proven-bound pass re-evaluates. This mirrors the seam
     *    invariant that auto-attach never records a URL for a port nothing bound
     *    (LLP 0045 §Part 1).
     *  - A pre-LLP-0086 marker recorded no endpoint (`marker.endpoint`
     *    undefined): `undefined !== live` → stale → re-attach exactly once,
     *    which records the endpoint and makes every later pass current. Backward
     *    compatible: an old marker never crashes and self-heals.
     *
     * **The asset set.** Attach installs the client's skills and subagents, so
     * an attach whose contributed set has changed is as stale as one at a moved
     * port. Endpoint alone does not cover it: adding a plugin to central config
     * restarts the daemon but leaves a pinned (or LLP 0114 well-known) port
     * exactly where it was, so an endpoint-only check would call every marker
     * current and the new skills would never land on an already-enrolled
     * machine. That is the scenario LLP 0107 §currency promises and rejected a
     * login one-shot for. Re-attaching to close it is cheap: `perform()` is
     * idempotent in both halves.
     *
     * The same two guards apply. No registries threaded this pass (a CLI boot,
     * where the install half is inert anyway): nothing to compare, stay current.
     * A pre-LLP-0138 marker recorded no key: stale exactly once, which records
     * one and self-heals.
     *
     * **The attach mode**, for `claude` only. The adapter has exactly one
     * desired mode (`otel`), and a proxy-era attach sits at the same gateway
     * endpoint with the same asset set, so neither key above can see it. A
     * marker recording anything other than `otel` (including a pre-LLP-0262
     * marker recording no mode at all) is stale, and re-performing it is the
     * migration itself: `attach()` releases the proxy keys and writes the OTEL
     * block. It self-heals the same way the other two do, because `perform()`
     * records the mode the adapter reports.
     *
     * @param {ActionMarker} marker
     * @param {DesiredAction} action
     * @param {ActionContext} ctx
     * @returns {boolean}
     * @ref LLP 0086#re-attach-on-drift [implements]: a done attach at a stale endpoint is not current; an unresolved endpoint leaves it alone
     * @ref LLP 0107#currency [implements]: a done attach whose asset set has changed is not current, so an org adding a plugin later re-materializes without a re-login
     * @ref LLP 0138#currency [implements]: the recorded digest is the freshness key, compared against what the live registries would produce
     */
    isCurrent(marker, action, ctx) {
      const client = attachActionClient(action)
      const registration = ctx.clients?.getClient(client)
      const live = ctx.endpoint
      if (registration?.requiresEndpoint !== false) {
        if (typeof live !== 'string' || live.length === 0) return true
        if (marker.endpoint !== live) return false
      }
      // A proxy-era marker at an unchanged gateway endpoint is still stale:
      // Claude's adapter now has one desired mode, and re-performing it is the
      // migration that releases the proxy settings and writes the OTEL block.
      // @ref LLP 0262#migration [implements]: attachment mode drift is a forward gap even when the gateway port did not move
      if (client === 'claude' && marker.mode !== 'otel') return false
      const assetsKey = attachedAssetsKey(client, ctx)
      if (assetsKey === undefined) return true
      return marker.assets_key === assetsKey
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
     * (`detachClientFromDisk`): the same one `hyp detach` uses. It needs
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
     * The skills and subagents this attach installed come off the marker's
     * `installed_assets` rather than off the registries: what to remove is what
     * *this* attach copied, not what the currently-loaded plugin set happens to
     * contribute now. A marker without the field (a pre-LLP-0138 attach) leaves
     * the assets alone, which is the same outcome as a manual install. Those
     * paths are persisted JSON, so they are re-checked against the descriptor's
     * own asset directories before any recursive removal runs.
     *
     * @param {string} requestKey  The client name whose attach to reverse.
     * @param {ActionContext} ctx
     * @param {ActionMarker} [marker]  The undo record `perform()` wrote.
     * @returns {Promise<ActionOutcome>}
     * @ref LLP 0045#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements]: reverse() invokes the single disk-driven core undo (detachClientFromDisk), not ctx.clients; a missing attachProbe is a failed reverse, not a no-op marker drop (#212)
     * @ref LLP 0107#reversal [implements]: org-driven asset copies reverse from the marker; unmarked (manual) ones stay
     */
    async reverse(requestKey, ctx, marker) {
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
        // No gateway fact is threaded in: every format's undo record lives in
        // the settings file itself (marker key, managed block, or the entry's
        // own signature), so reverse works even when the endpoint that
        // performed the attach no longer exists.
        // @ref LLP 0210#d1 [constrained-by]: reverse passes no origin; the json_path undo judges ownership by the entry's signature alone
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

      // A restore that fired rewrote a block of the user's settings file. On
      // the `hyp detach` path they read a line about it; here nobody is at a
      // terminal - this reverse is an org config drop - so the log is the only
      // place it can be said, and the failure half of the same replay is
      // already said one branch up. Silence here is the defect #500 finding 3
      // closed for the command, left open for the reconciler.
      //
      // Paths, never values: the backed-up block is where an API key ends up,
      // and this is exported telemetry (LLP 0163).
      // @ref LLP 0163#a-restore-that-happened-is-reported-by-path-and-never-by-value [implements]: the reconciler-driven undo reports a replayed backup too, by path
      if (result.restoredPaths !== undefined && result.restoredPaths.length > 0) {
        ctx.log.info('client_action.attach_reverse_restored', {
          [Attr.COMPONENT]: 'action-attach',
          [Attr.OPERATION]: 'client_action.reverse',
          client: descriptor.name,
          [Attr.STATUS]: 'ok',
          detail: `restored from the marker's malformed-block backup: ${result.restoredPaths.join(', ')}`,
        })
      }

      // Remove the client assets this attach installed, after the settings
      // undo: a failure here leaves files behind but the client is already
      // unwired, and re-running the whole reverse is safe (both halves are
      // idempotent), so keep the marker and retry rather than reporting done.
      const assets = readInstalledAssets(marker)
      if (assets.length > 0) {
        // Same HOME fallback the CLI undo uses (`detachClientViaCore`): two
        // readers of one field that disagree about where home is would disagree
        // about which recorded paths are removable, and the removal side is the
        // one that refuses when it cannot resolve them. The install side stays
        // deliberately inert without HOME (it writes nothing); the removal side
        // must not turn a missing HOME into a containment refusal over files
        // that are really there.
        const baseDirs = clientAssetBaseDirs(descriptor, ctx.env.HOME ?? os.homedir())
        const { failed } = await removeClientAssets(assets, baseDirs)
        const retryable = failed.filter((f) => f.retryable)
        if (retryable.length > 0) {
          const detail = failed.map((f) => `${f.dest} (${f.reason})`).join(', ')
          return {
            status: 'failed',
            reason: `client '${descriptor.name}' detached, but ${failed.length} installed asset(s) could not be removed: ${detail}`,
          }
        }
        if (failed.length > 0) {
          // Every failure is a refusal, and a refusal is deterministic: the
          // paths and the descriptor's directories are both fixed, so retrying
          // re-refuses forever. Keeping the marker for it would retain a `done`
          // attach whose settings are already reversed, which is the stale
          // marker a later join short-circuits on (#217), and no re-run would
          // ever clear it. Name the files in the log instead and let the marker
          // drop: the record moves from disk to the operator, which is the
          // strongest thing left when removal is not an option.
          // @ref LLP 0138#refusal-is-not-failure [implements]: a removal that
          //   can never succeed names what it leaves, and the marker goes
          ctx.log.warn('client_action.attach_reverse_assets_refused', {
            [Attr.COMPONENT]: 'action-attach',
            [Attr.OPERATION]: 'client_action.reverse',
            client: descriptor.name,
            [Attr.STATUS]: 'ok',
            [Attr.ERROR_KIND]: 'asset_removal_refused',
            detail: `left in place, remove by hand: ${failed.map((f) => `${f.dest} (${f.reason})`).join(', ')}`,
          })
        }
      }

      // Idempotent: a no-op (file already clean / marker absent) is still a
      // successful undo, the reconciler drops the marker either way.
      return { status: 'done' }
    },
  }
}

/**
 * The default `attachHandler` the daemon registers the reconciler with: first
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
 * The client one attach action names: the params when they carry one, the
 * request key otherwise. Both hooks resolve it here, because `isCurrent()`
 * resolving it any differently than `perform()` would digest one client's
 * assets against another's marker.
 *
 * @param {DesiredAction} action
 * @returns {string}
 */
function attachActionClient(action) {
  const client = (action.params ?? {}).client
  return typeof client === 'string' && client.length > 0 ? client : action.requestKey
}

/**
 * The materialization options for one attached client, or `undefined` when this
 * boot cannot materialize at all (no client catalog, no HOME, or neither
 * registry threaded - a CLI boot, where the install half of attach is inert by
 * construction). One builder, so the copy and the freshness digest taken over
 * it can never be computed from different inputs.
 *
 * @param {string} client
 * @param {ActionContext} ctx
 * @returns {MaterializeClientAssetsOptions | undefined}
 */
function attachedAssetOptions(client, ctx) {
  const descriptors = ctx.clientDescriptors
  const homeDir = ctx.env.HOME ?? ''
  if (!descriptors || homeDir.length === 0) return undefined
  if (!ctx.skills && !ctx.agents) return undefined
  return {
    clients: [client],
    descriptors,
    homeDir,
    stateRoot: clientAssetStateRoot(ctx.env, homeDir),
    ...(ctx.skills ? { skills: ctx.skills } : {}),
    ...(ctx.agents ? { agents: ctx.agents } : {}),
    // A daemon boot where one plugin threw in `activate()` still reconciles;
    // its attach copies what did activate and prunes nothing, because the
    // missing contributions are indistinguishable from retired ones.
    ...(ctx.failedPlugins?.length ? { failedPlugins: ctx.failedPlugins } : {}),
  }
}

/**
 * The digest of what this client's assets are right now, or `undefined` when
 * this boot cannot tell. Pure: no disk access, so `isCurrent()` can call it.
 *
 * @param {string} client
 * @param {ActionContext} ctx
 * @returns {string | undefined}
 */
function attachedAssetsKey(client, ctx) {
  const options = attachedAssetOptions(client, ctx)
  return options ? clientAssetsKey(options) : undefined
}

/**
 * Materialize one attached client's registered skills and subagents, returning
 * the destination paths for the marker. Never throws: the attach it follows has
 * already applied, and a copy failure is a degraded install (warned in the
 * daemon log) rather than an attach to redo. Inert when the daemon threaded no
 * registries or no HOME, which is also what a non-daemon boot looks like.
 *
 * @param {string} client
 * @param {ActionContext} ctx
 * @returns {Promise<string[]>}
 */
async function materializeAttachedAssets(client, ctx) {
  const options = attachedAssetOptions(client, ctx)
  if (!options) return []

  const warnings = {
    /** @param {string} chunk */
    write(chunk) {
      ctx.log.warn('client_action.attach_asset_skipped', {
        [Attr.COMPONENT]: 'action-attach',
        [Attr.OPERATION]: 'client_action.perform',
        client,
        [Attr.STATUS]: 'ok',
        detail: chunk.trim(),
      })
    },
  }

  try {
    const { installed } = await materializeClientAssets({ ...options, stderr: warnings })
    return installed.map((asset) => asset.dest)
  } catch (err) {
    ctx.log.warn('client_action.attach_assets_failed', {
      [Attr.COMPONENT]: 'action-attach',
      [Attr.OPERATION]: 'client_action.perform',
      client,
      [Attr.STATUS]: 'ok',
      [Attr.ERROR_KIND]: 'asset_install_failed',
      detail: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

/**
 * A capturing `WriteStream`, accumulates every `write(chunk)` so the handler
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
 * nothing parses to an object. The caller still records every freshness key it
 * owns independently of the payload, so a successful attach settles.
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

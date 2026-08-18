// @ts-check

import fs from 'node:fs/promises'
import { parseCommandArgv } from '../cli/verb_codec.js'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { discoverInstalledPlugins } from '../runtime/installed.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { materializeClientAssets } from '../runtime/client_assets.js'
import { clientAssetStateRoot } from '../runtime/client_asset_ledger.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { detachClientFromDisk } from '../config/client_detach_disk.js'
import { removeLaunchdEnv } from '../daemon/launchd_env.js'
import { defaultStateRoot, deleteLocalCa } from '../tls/ca.js'
import { removeCaTrust } from '../tls/darwin_trust.js'
import { clientAssetBaseDirs, removeClientAssets } from '../runtime/client_assets.js'
import {
  clearClientActionMarker,
  readClientActionStatus,
  readInstalledAssets,
  rearmRefusedActionMarker,
} from '../config/action_reconciler.js'
import { configuredGatewayEndpoint, portFromEndpoint } from '../config/gateway_endpoint.js'
import { defaultConfigPath, loadConfigFile } from '../config/schema.js'
import { enableClientAdapter } from '../config/client_enable.js'
import { enableGatewayProxyMode } from '../config/gateway_proxy_enable.js'
import { resolveLayeredConfigFromDisk } from '../runtime/boot.js'
import { resolveClientSettingsPath } from '../daemon/client_settings_path.js'
import { probeClientAttachFromDescriptor, resolveLiveGatewayEndpointFromStatus } from '../daemon/status.js'
import { askYesNo } from '../cli/confirm.js'
import { isTty } from '../cli/stdio.js'
import { defaultBackfillConsentPromptFactory, resolveSingleSourceEnablement } from '../cli/walkthrough.js'
import { resolveRetentionDays, runBackfillProvider } from './backfill.js'
import {
  CLASS_RANK,
  createUsagePolicyResolver,
  findRepoRoot,
  governingListEntry,
  localOnlyListPath,
  sameDirectory,
  scopeGoverns,
  readLocalOnlyEntries,
  writeLocalOnlyEntries,
} from '../usage-policy/index.js'
import { executeQuerySql } from '../query/sql.js'
import { pluginStateDir } from './plugin.js'

/**
 * @import { AiGatewayCapability, CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ClientDescriptor, LoadedManifest, PluginCatalog } from '../../../src/core/types.js'
 * @import { PolicyHumanVocabulary } from '../../../src/core/commands/types.js'
 * @import { ResolveResult, UsageClass } from '../../../src/core/usage-policy/types.js'
 * @import { ClientEnableResult, DetachFromDiskResult } from '../../../src/core/config/types.js'
 */

/**
 * `hyp attach [client] [--client <name>] [--dry-run] [--json]`
 *
 * Resolves the `hypaware.ai-gateway` capability, looks up the named
 * client adapter, and dispatches to the adapter's `attach()`. Each
 * adapter emits its own `client.attach` span; this router only
 * threads stdout/stderr and the gateway's `localEndpoint()` into the
 * adapter context.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runAttach(argv, ctx) {
  return runClientLifecycle('attach', argv, ctx)
}

/**
 * `hyp detach [client] [--client <name>]`
 *
 * Reverses a client's attach. Unlike `attach`, detach does **not**
 * dispatch to a per-adapter hook: it routes through the single core,
 * disk-driven undo (`detachClientFromDisk`), resolved per client via its
 * `clientDescriptor`. That one undo is shared with the daemon
 * reconciler's `reverse()`, so the two can never drift.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0045#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements]: manual detach routes through the one core undo via the clientDescriptor, not a per-adapter detach()
 */
export async function runDetach(argv, ctx) {
  return runClientLifecycle('detach', argv, ctx)
}

/**
 * @param {'attach'|'detach'} action
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runClientLifecycle(action, argv, ctx) {
  const parsed = parseClientArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }

  // Detach is the single core, disk-driven undo (LLP 0045 §Part 3): it reverses
  // an on-disk attach from the static client descriptor map (owning plugin +
  // attach_probe), never the live gateway registry. So it must keep working
  // with the @hypaware/ai-gateway capability absent/unloaded: resolve and
  // reverse here, AHEAD of the gateway gate. Attach genuinely needs the live
  // adapter, so it stays gated below.
  if (action === 'detach') {
    const clientDescriptors = await buildClientDescriptorMap(ctx)
    const clientNames = expandDetachClientNames(parsed.client, clientDescriptors)
    if (clientNames.length === 0) {
      const known = [...clientDescriptors.keys()]
      ctx.stderr.write(
        `error: unknown client '${parsed.client}'. Known clients: ${known.join(', ') || '(none)'}\n`
      )
      return 1
    }
    let exitCode = 0
    for (const name of clientNames) {
      try {
        const descriptor = clientDescriptors.get(name)
        if (!descriptor) {
          ctx.stderr.write(`error: unknown client '${name}'\n`)
          exitCode = 1
          continue
        }
        await detachClientViaCore({
          name,
          descriptor,
          dryRun: parsed.dryRun,
          json: parsed.json,
          ctx,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.stderr.write(`error: detach client '${name}' failed: ${message}\n`)
        exitCode = 1
      }
    }
    // Zero-residue exit for a user who wants it without uninstalling: routine
    // detach deliberately keeps the CA and its keychain trust so the password
    // dialog stays once-per-machine; `--purge` is the explicit opt-out.
    // @ref LLP 0238#ca-survives-detach [implements]: purge is the explicit removal path, never the default
    if (parsed.purge && !parsed.dryRun) {
      const purged = await purgeProxyTrustResidue({ ctx })
      if (!parsed.json) {
        for (const line of purged.lines) ctx.stdout.write(`${line}\n`)
      }
    }
    return exitCode
  }

  // Attach dispatches to the per-adapter attach() hook and threads the
  // gateway's localEndpoint(), so it requires the live @hypaware/ai-gateway
  // capability.
  // Tracks which single client name (if any) this invocation just enabled
  // through T9's accept path at THIS gate, so the loop below knows to offer
  // T10's backfill consent for it once its attach() actually succeeds.
  // `maybeInteractiveEnableAttach` already refuses `--client all`, so at
  // most one name can ever be set here.
  let capMissingActivatedName
  if (!ctx.capabilities.has('hypaware.ai-gateway')) {
    // The capability is absent exactly when no *enabled* plugin pulls the
    // gateway in, which for a catalog-known client means its adapter is not
    // enabled - not that the capability is missing from the install. Ask the
    // static catalog which of the two it is before choosing the wording.
    // @ref LLP 0174#detection [implements]: the capability gate is one of the
    // two failure sites that must report the enablement layer
    const enablement = await resolveAttachEnablementState({ name: parsed.client, ctx })
    // @ref LLP 0174#prompt [implements]: on `not_enabled` with a TTY and no
    // `--json`, offer to enable the adapter instead of failing outright; on
    // acceptance this falls through to the capability now being live
    const promptResult = await maybeInteractiveEnableAttach({ name: parsed.client, ctx, parsed, enablement })
    if (!promptResult.activated) {
      const errorKind = enablement.state === 'unknown' ? 'cap_missing' : enablement.errorKind
      await withSpan(
        `client.${action}`,
        {
          [Attr.COMPONENT]: `cmd-${action}`,
          [Attr.OPERATION]: `client.${action}`,
          client_name: parsed.client,
          hyp_client: parsed.client,
          dry_run: parsed.dryRun === true,
          status: 'failed',
          error_kind: errorKind,
        },
        async () => {
          const message = enablement.state === 'unknown'
            ? `${action} requires the @hypaware/ai-gateway plugin to be installed and activated`
            : enablement.message
          if (parsed.json) {
            ctx.stdout.write(
              JSON.stringify({
                status: 'failed',
                action,
                client: parsed.client,
                dry_run: parsed.dryRun === true,
                error_kind: errorKind,
                error: message,
              }) + '\n'
            )
          } else {
            ctx.stderr.write(`error: ${message}\n`)
          }
        },
        { component: `cmd-${action}` }
      )
      return 1
    }
    capMissingActivatedName = parsed.client
  }
  /** @type {AiGatewayCapability} */
  const gateway = ctx.capabilities.require('hyp-core', 'hypaware.ai-gateway', '^2.0.0')

  const clientNames = expandClientName(parsed.client, gateway)
  if (parsed.client === 'all' && !parsed.json) {
    // `hyp attach all` never prompts mid-run (a gauntlet of enable questions
    // inside a bulk command is the picker's job, badly reinvented); instead it
    // names every catalog-known client the live registry silently dropped, so
    // the fix is one `hyp attach <name>` away instead of a quiet no-op. The
    // diff is catalog keys minus live keys, so every name here is
    // catalog-known by construction: no `unknown` id can appear, so this
    // needs none of resolveAttachEnablementState's central-vs-local split.
    // Skipped under --json: every other attach path keeps stdout to the
    // single-line machine payload per client, and a bare `note:` line is not
    // that shape (see materializeAttachAssets's own --json stdout suppression
    // for the same convention).
    // @ref LLP 0174#detection [implements]: `hyp attach all` reports known-
    //   but-not-enabled clients as notes instead of dispatching only the
    //   live subset with no explanation
    const catalog = await buildAttachPluginCatalog(ctx)
    const liveNames = new Set(clientNames)
    for (const name of catalog.clientDescriptors.keys()) {
      if (!liveNames.has(name)) {
        ctx.stdout.write(
          `note: ${name} is a known client but its adapter is not enabled; run 'hyp attach ${name}' to enable it\n`
        )
      }
    }
  }
  if (clientNames.length === 0) {
    const enablement = await resolveAttachEnablementState({ name: parsed.client, ctx })
    if (enablement.state !== 'unknown') {
      reportAttachEnablement({ name: parsed.client, enablement, parsed, ctx })
      return 1
    }
    const known = gateway.listClients().map((c) => c.name)
    ctx.stderr.write(
      `error: unknown client '${parsed.client}'. Registered clients: ${known.join(', ') || '(none)'}\n`
    )
    return 1
  }

  let exitCode = 0
  /** @type {Map<string, ClientDescriptor> | undefined} */
  let descriptorMap
  for (const name of clientNames) {
    // Set true only when THIS name was activated via T9's accept path in
    // THIS invocation (either gate below), never for a client whose adapter
    // was already enabled coming into this command - that is what confines
    // T10's backfill offer to the accept branch, per its own scope.
    let activatedViaPrompt = name === capMissingActivatedName
    try {
      let client = gateway.getClient(name)
      if (!client) {
        // The gateway is live but this client never registered. That is the
        // second failure site the design names: some other gateway-using
        // plugin is enabled, this client's adapter is not, and reporting it as
        // "unknown" hides the enablement layer that actually explains it.
        // @ref LLP 0174#detection [implements]: a catalog-known but
        // unregistered client reports not_enabled / disabled_central, not unknown
        const enablement = await resolveAttachEnablementState({ name, ctx })
        // @ref LLP 0174#prompt [implements]: the same enable prompt as the
        // capability gate above, reached from the registry-miss site instead
        const promptResult = await maybeInteractiveEnableAttach({ name, ctx, parsed, enablement })
        if (promptResult.activated) {
          // The adapter's own activate() registers it with the SAME `gateway`
          // api object this closure already holds (it is `ctx.capabilities`'
          // live registration, not a snapshot), so re-reading it here sees
          // the just-activated client with no extra capability lookup.
          client = gateway.getClient(name)
          activatedViaPrompt = true
        }
        if (!client) {
          if (enablement.state !== 'unknown') {
            reportAttachEnablement({ name, enablement, parsed, ctx })
            exitCode = 1
            continue
          }
          ctx.stderr.write(`error: unknown client '${name}'\n`)
          exitCode = 1
          continue
        }
      }
      // Before the endpoint is resolved, because an accepted migration
      // restarts the daemon and may move the bound port; the resolution
      // below then discovers the fresh one. A migration failure never fails
      // the attach: base-URL attach is exactly what this install already
      // does, so it stays the fallback.
      // @ref LLP 0244#attach-offers [implements]: attach is the migration verb for a base-URL install whose client attaches by proxy
      if (action === 'attach') {
        try {
          await maybeOfferProxyModeMigration({ name, ctx, parsed })
        } catch (migrationErr) {
          ctx.stderr.write(
            `warning: proxy-mode migration failed (${migrationErr instanceof Error ? migrationErr.message : String(migrationErr)}); ` +
            `attaching by base URL instead\n`
          )
        }
      }
      // In dry-run mode the gateway source may not be started yet,
      // so `localEndpoint()` could throw. Fall back to a placeholder
      // endpoint: adapters are expected to short-circuit before
      // touching it.
      let endpoint
      if (parsed.dryRun) {
        try {
          endpoint = gateway.localEndpoint()
        } catch {
          endpoint = configuredGatewayEndpoint(ctx.config) ?? 'http://127.0.0.1:0'
        }
      } else {
        try {
          endpoint = gateway.localEndpoint()
        } catch {
          endpoint = configuredGatewayEndpoint(ctx.config)
          if (!endpoint) {
            // No gateway bound in this process and no configured `listen` to
            // fall back on: the default daemon-managed install (an unpinned
            // gateway binds the well-known default port, or its ephemeral
            // fallback when that port was taken - LLP 0114 - so only the
            // running daemon knows the proven port).
            // The daemon persists that bound port to status.json, so discover
            // it - guarded by a daemon-liveness check - instead of guessing or
            // reporting the internal endpoint error.
            // @ref LLP 0045#part-1-the-client-seam-in-the-reconcile-context: manual attach without a configured listen defers to the daemon; probe disk, don't guess a port
            // @ref LLP 0086#manual-attach-reads-the-live-port [implements]: hyp attach falls back to status.json sources[].details.port before giving up
            const stateRoot = readObservabilityEnv(ctx.env).stateDir
            const liveEndpoint = resolveLiveGatewayEndpointFromStatus({ stateRoot })
            descriptorMap ??= await buildClientDescriptorMap(ctx)
            const descriptor = descriptorMap.get(name)
            const homeDir = ctx.env.HOME ?? os.homedir()
            const probe = descriptor
              ? await probeClientAttachFromDescriptor({ descriptor, homeDir, env: ctx.env })
              : { attached: false, settingsPath: undefined, port: undefined }

            // "Already attached" now means attached AT THE LIVE PORT: validate
            // the recorded port against the live one rather than trusting marker
            // existence (#277). When no live endpoint is discoverable (daemon
            // not running) keep the pre-#277 behavior - a present marker is a
            // no-op success, an absent one the actionable error.
            // @ref LLP 0086#already-attached-validates-the-live-port [implements]: the already-attached branch compares recorded vs live port; a stale-port marker re-attaches
            const livePort = portFromEndpoint(liveEndpoint)
            const alreadyCurrent =
              probe.attached === true &&
              (liveEndpoint === undefined ||
                (probe.port !== undefined && probe.port === livePort))
            if (alreadyCurrent) {
              getLogger('cmd-attach').info('client.attach.daemon_managed', {
                [Attr.COMPONENT]: 'cmd-attach',
                [Attr.OPERATION]: 'client.attach',
                hyp_client: name,
                status: 'ok',
                changed: false,
                attached: true,
              })
              if (parsed.json) {
                ctx.stdout.write(
                  JSON.stringify({
                    status: 'ok',
                    action: 'attach',
                    client: name,
                    dry_run: false,
                    changed: false,
                    attached: true,
                    ...(probe.settingsPath !== undefined ? { settings_path: probe.settingsPath } : {}),
                  }) + '\n'
                )
              } else {
                ctx.stdout.write(
                  `${name} is already attached${probe.settingsPath !== undefined ? ` (${probe.settingsPath})` : ''}; ` +
                  `the daemon manages attach for this install, so only its assets are refreshed.\n`
                )
              }
              // The settings are already wired, but attach means settings *and*
              // assets, and this branch is the one an operator on a
              // daemon-managed install actually reaches. Short-circuiting past
              // the materialization below would make `hyp attach` install
              // nothing on exactly the install shape it is most often run on,
              // reintroducing the split this change removes. Idempotent and
              // cheap, so running it on a no-op attach costs a stat pass.
              // @ref LLP 0107#every-attach [implements]: every attach path
              //   materializes, including the one with nothing left to wire
              await materializeAttachAssets({ name, descriptorMap, ctx, dryRun: false, json: parsed.json })
              continue
            }
            if (liveEndpoint) {
              // A live daemon endpoint we can (re)attach at: either not attached,
              // or attached at a now-stale port. Fall through to client.attach,
              // which is idempotent and re-points the client at the live port.
              endpoint = liveEndpoint
            } else {
              // Which give-up message to show hinges on whether a daemon
              // service is installed at all: an install-but-unstarted daemon
              // just needs `hyp start`, but with no service installed that
              // command has nothing to start, so the message must also point
              // at `hyp daemon install` / `hyp daemon start`.
              // @ref LLP 0174#bootstrap-floor [implements]: "config exists but no daemon is installed" extends the endpoint give-up message instead of attach gaining daemon orchestration
              const { serviceDaemonStatus } = await import('../daemon/install.js')
              const daemonStatus = await serviceDaemonStatus({ homeDir })
              const message = daemonStatus.installed
                ? `cannot resolve the gateway endpoint: the gateway is not running in this ` +
                  `process and no ai-gateway 'listen' address is configured. Start the daemon ` +
                  `(hyp start) so it can attach clients, or set 'listen' in the ai-gateway config.`
                : `cannot resolve the gateway endpoint: the gateway is not running in this ` +
                  `process and no ai-gateway 'listen' address is configured, and no daemon ` +
                  `service is installed on this machine. Run 'hyp daemon install' then ` +
                  `'hyp daemon start' so it can attach clients, or set 'listen' in the ` +
                  `ai-gateway config.`
              getLogger('cmd-attach').warn('client.attach.no_endpoint', {
                [Attr.COMPONENT]: 'cmd-attach',
                [Attr.OPERATION]: 'client.attach',
                hyp_client: name,
                status: 'failed',
                error_kind: 'no_endpoint',
              })
              if (parsed.json) {
                ctx.stdout.write(
                  JSON.stringify({
                    status: 'failed',
                    action: 'attach',
                    client: name,
                    dry_run: false,
                    error_kind: 'no_endpoint',
                    error: message,
                  }) + '\n'
                )
                exitCode = 1
                continue
              }
              throw new Error(message)
            }
          }
        }
      }
      await client.attach({
        endpoint,
        config: {},
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        dryRun: parsed.dryRun,
        json: parsed.json,
      })
      // A successful manual attach is the only re-arm a `refused` marker gets
      // in this pass: after it, the next reconcile pass must stop
      // short-circuiting on the marker and re-`perform()` the request key.
      //
      // Scoped to a `refused` marker, and skipped on `--dry-run`, on purpose.
      // A `done` marker is the only record naming the files an org-driven
      // attach installed, so clearing it would strand them past any later
      // `hyp detach`, which reads exactly this marker to know what to remove
      // (LLP 0138#marker-undo). A `failed` marker needs no help: nothing
      // short-circuits it, so the next pass already retries it. And a dry run
      // must leave the marker store exactly as it found it, the same way the
      // detach path returns before its own clear under `--dry-run`.
      //
      // The re-arm itself is a drop only when the marker records no
      // `installed_assets`. One that carries them is the same undo record a
      // `done` marker is (a refusal on a re-`perform()` carries the earlier
      // successful attach's copies forward), so it is rewritten to `failed`
      // rather than dropped: same re-arm, record intact. That branch lives in
      // `rearmRefusedActionMarker` beside the store it rewrites.
      //
      // Best-effort: a marker-store I/O failure must never fail the attach that
      // just succeeded.
      // @ref LLP 0186#re-arm-explicit-hyp-attach-re-run-only [implements]: an explicit hyp attach re-arms a refused marker, and only that; the reconciler never re-arms one on its own
      if (parsed.dryRun !== true) {
        try {
          rearmRefusedActionMarker({
            stateRoot: readObservabilityEnv(ctx.env).stateDir,
            kind: 'attach',
            requestKey: name,
          })
        } catch (markerErr) {
          getLogger('cmd-attach').warn('client.attach.marker_retract_failed', {
            hyp_client: name,
            error_kind: 'marker_retract_failed',
            detail: markerErr instanceof Error ? markerErr.message : String(markerErr),
          })
        }
      }
      // Attach wires a client into HypAware, and its registered skills and
      // subagents are part of that wiring: manual attach skipping them was the
      // inconsistency, not the norm (the wizard has always treated
      // attach-plus-skills as one unit). No marker is recorded, so these copies
      // are the user's own and `hyp detach` leaves them in place.
      // @ref LLP 0107#every-attach [implements]: manual attach materializes the
      //   client's assets, the same set the reconciler's attach installs
      descriptorMap ??= await buildClientDescriptorMap(ctx)
      await materializeAttachAssets({
        name,
        descriptorMap,
        ctx,
        dryRun: parsed.dryRun === true,
        json: parsed.json,
      })
      // @ref LLP 0174#prompt [implements]: step 4, backfill consent, only for
      // a client T9's accept branch just enabled in this same invocation -
      // the registered-state attach path above (activatedViaPrompt false)
      // is completely unchanged
      if (activatedViaPrompt) {
        await maybeBackfillAfterEnable({ name, ctx })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.stderr.write(`error: ${action} client '${name}' failed: ${message}\n`)
      exitCode = 1
    }
  }
  return exitCode
}

/**
 * Resolve *why* `name` cannot be attached right now, so the failure names the
 * enablement layer instead of dead-ending on "unknown client".
 *
 * Three states, per design LLP 0174 #detection:
 * `unknown` (no bundled or installed plugin contributes this client at all -
 * keep whichever "unknown client" wording the calling gate already prints),
 * `not_enabled` (the static catalog knows the client but the effective config
 * never enabled its owning plugin, or disabled it in the *local* layer, which
 * the user can fix), and `disabled_central` (a fleet-managed central entry
 * names the plugin disabled, and LLP 0031's additive merge drops any local
 * entry with that name, so telling the user to edit their config would be a
 * lie).
 *
 * Reads the static bundled+installed catalog, never the live gateway registry:
 * this runs precisely when the registry cannot answer, either because the
 * `hypaware.ai-gateway` capability is absent or because the adapter that would
 * have registered the client never activated.
 *
 * `../cli/dispatch.js` is imported dynamically because it re-enters this module
 * through `./core_commands.js`; a static edge here would close that cycle for
 * every `hyp` invocation to serve one cold error path.
 *
 * @ref LLP 0174#detection [implements]: attach's failure paths distinguish
 * unknown client / known-but-not-enabled / registered, instead of reporting
 * every non-registered name as unknown
 * @param {{ name: string, ctx: CommandRunContext }} args
 * @returns {Promise<
 *   { state: 'unknown' } |
 *   { state: 'not_enabled' | 'disabled_central', errorKind: string, message: string }
 * >}
 */
async function resolveAttachEnablementState({ name, ctx }) {
  /** @type {PluginCatalog} */
  let catalog
  try {
    catalog = await buildAttachPluginCatalog(ctx)
  } catch {
    return { state: 'unknown' }
  }
  const descriptor = catalog.clientDescriptors.get(name)
  if (!descriptor) return { state: 'unknown' }

  const obsEnv = readObservabilityEnv(ctx.env)
  const configPath = ctx.env.HYP_CONFIG
    ? path.resolve(ctx.env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)
  /** @type {'absent' | 'disabled-local' | 'disabled-central'} */
  let inactive = 'absent'
  try {
    const { classifyInactiveState } = await import('../cli/dispatch.js')
    const layered = await resolveLayeredConfigFromDisk({
      stateRoot: obsEnv.stateDir,
      configPath,
      knownPlugins: catalog.pluginMetadata,
      knownDatasets: catalog.knownDatasets,
    })
    inactive = classifyInactiveState(layered, descriptor.plugin)
  } catch {
    // An unreadable/invalid config layer cannot prove the central layer
    // disabled anything, and the adapter is demonstrably not live: report the
    // fixable state, whose remedy ('hyp init') repairs a broken config too.
  }

  if (inactive === 'disabled-central') {
    return {
      state: 'disabled_central',
      errorKind: 'adapter_disabled_central',
      message:
        `the ${name} adapter is disabled by your fleet config; ` +
        `a local config cannot override the central-managed setting`,
    }
  }
  return {
    state: 'not_enabled',
    errorKind: 'adapter_not_enabled',
    message:
      `the ${name} adapter is not enabled on this install; enable it with 'hyp init', ` +
      `or add ${descriptor.plugin} to ${configPath} and run 'hyp daemon restart', ` +
      `then re-run attach`,
  }
}

/**
 * Report a resolved `not_enabled` / `disabled_central` attach refusal on the
 * two registry-miss sites, in the same `--json` payload shape every other
 * attach failure in this file uses (the capability gate renders its own
 * because it also owns the failure span).
 *
 * @param {{
 *   name: string,
 *   enablement: { state: 'not_enabled' | 'disabled_central', errorKind: string, message: string },
 *   parsed: { dryRun: boolean, json: boolean },
 *   ctx: CommandRunContext,
 * }} args
 * @returns {void}
 */
function reportAttachEnablement({ name, enablement, parsed, ctx }) {
  getLogger('cmd-attach').warn('client.attach.adapter_inactive', {
    [Attr.COMPONENT]: 'cmd-attach',
    [Attr.OPERATION]: 'client.attach',
    hyp_client: name,
    status: 'failed',
    [Attr.ERROR_KIND]: enablement.errorKind,
  })
  if (parsed.json) {
    ctx.stdout.write(
      JSON.stringify({
        status: 'failed',
        action: 'attach',
        client: name,
        dry_run: parsed.dryRun === true,
        error_kind: enablement.errorKind,
        error: enablement.message,
      }) + '\n'
    )
    return
  }
  ctx.stderr.write(`error: ${enablement.message}\n`)
}

/**
 * The `not_enabled` accept/decline gate, reached from both registry-miss
 * sites in `runClientLifecycle`'s attach branch. Interactive-only: every
 * other caller (scripts, `--json`, `hyp attach all`'s bulk loop, a
 * `disabled_central` refusal) must see the SAME failure it saw before this
 * task existed, so this returns `{ activated: false }` immediately for
 * anything that is not a bare, interactive, single-client `not_enabled` ask.
 *
 * Decline and every early return are zero-side-effect by construction: none
 * of them reach {@link enableClientAdapter}, so there is no write, no backup,
 * and no restart to undo.
 *
 * @ref LLP 0174#bootstrap-floor [implements]: no local config file at all
 * skips the prompt outright and falls through to the caller's existing
 * `not_enabled` refusal (which already names `hyp init`) rather than asking
 * a question with nothing on disk to add an entry to
 * @ref LLP 0174#prompt [implements]: the enable/attach accept path - guarded
 * write (T8), then this same process's own kernel picks up the newly written
 * plugin(s) through the activation seam so `attach()` still runs in one
 * invocation
 * @param {{
 *   name: string,
 *   ctx: CommandRunContext,
 *   parsed: { client: string, json: boolean, dryRun: boolean },
 *   enablement: { state: 'unknown' } | { state: 'not_enabled' | 'disabled_central', errorKind: string, message: string },
 * }} args
 * @returns {Promise<{ activated: boolean }>}
 */
async function maybeInteractiveEnableAttach({ name, ctx, parsed, enablement }) {
  // `disabled_central` never reaches this prompt (LLP 0174 #detection): a
  // fleet-managed disable has no local remedy, so asking would offer a fix
  // that cannot work. `unknown` means the catalog does not know this client
  // at all, which this prompt has nothing to enable either.
  if (enablement.state !== 'not_enabled') return { activated: false }
  // `hyp attach all` never prompts mid-run (see the call site's own comment);
  // a bare `--client all` reaching here would ask once per missing client
  // with no way to say "no" to the rest.
  if (parsed.client === 'all') return { activated: false }
  if (parsed.json || !isTty(ctx.stdin)) return { activated: false }
  // `--dry-run` is this command's "tell me, change nothing" mode (the same
  // promise `detachClientViaCore`'s own dry-run branch keeps), and the accept
  // path is the least dry thing in the file: a config write, a daemon
  // restart, and a real backfill import. Refuse the question rather than
  // offer one whose yes would break the flag - a dry run reports the guided
  // error, and the user re-runs without the flag to act on it.
  if (parsed.dryRun) return { activated: false }

  const obsEnv = readObservabilityEnv(ctx.env)
  const configPath = ctx.env.HYP_CONFIG
    ? path.resolve(ctx.env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)
  if (!(await configFileExists(configPath))) return { activated: false }

  const catalog = await buildAttachPluginCatalog(ctx)
  const descriptor = catalog.pickerDescriptors.get(name)
  if (!descriptor) return { activated: false }

  const { pluginNames, entries } = resolveSingleSourceEnablement(descriptor)
  if (entries.length === 0) return { activated: false }
  // The same "never prompt when there is nothing to add" floor the missing
  // config file establishes, applied to the two other shapes it takes on a
  // config that does exist. `enableClientAdapter`'s write is additive by
  // contract, so it appends nothing for a name already known to the config,
  // and neither shape below is repairable by an append - the question would
  // promise an enable the write cannot deliver, and land a no-op rewrite plus
  // a stray backup and an untrue "enabled the <name> adapter" line on the way
  // to the same refusal. Fall through to the caller's guided error instead,
  // which names `hyp init` (the flow that does rewrite an existing entry).
  // @ref LLP 0174#bootstrap-floor [constrained-by]: the prompt is only ever
  // offered where the additive write can actually change the outcome
  if (await enableWriteCannotDeliver({ ctx, configPath, catalog, pluginNames })) {
    return { activated: false }
  }
  const primary = descriptor.compose?.plugin?.name ?? descriptor.plugin
  const rest = pluginNames.filter((pluginName) => pluginName !== primary)
  const depSuffix = rest.length > 0 ? ` (and ${rest.join(', ')})` : ''

  // @ref LLP 0174#openclaw [implements]: OpenClaw's enable question names the
  // periodic sweep import up front instead of reusing the generic wording,
  // because enabling it is not attach-shaped like every other adapter here -
  // it also starts a background backfill the user has not consented to yet
  const question =
    name === 'openclaw'
      ? `The OpenClaw adapter is not enabled on this install. Enabling it starts a periodic sweep ` +
        `that will import existing OpenClaw session history within about 5 minutes. ` +
        `Enable ${primary}${depSuffix} now? [y/N] `
      : `The ${capitalizeClientLabel(name)} adapter is not enabled on this install. Attaching requires ` +
        `it. Enable ${primary}${depSuffix} now? [y/N] `

  const accepted = await askYesNo(ctx, question)
  if (!accepted) {
    getLogger('cmd-attach').info('client.attach.enable_prompt', {
      [Attr.COMPONENT]: 'cmd-attach',
      [Attr.OPERATION]: 'client.attach',
      hyp_client: name,
      status: 'ok',
      accepted: false,
    })
    return { activated: false }
  }

  const result = await enableClientAdapter({
    name,
    entries,
    ctx,
    knownPlugins: catalog.pluginMetadata,
    knownDatasets: catalog.knownDatasets,
  })
  if (!result.ok) {
    reportEnableFailure({ name, result, ctx })
    return { activated: false }
  }

  // The write and (if a daemon is installed) the restart already landed; what
  // remains is making THIS process's own kernel see the plugin(s) the config
  // now names, so `client.attach()` below runs in the same invocation instead
  // of asking the user to re-run the command.
  // @ref LLP 0139#seam-fresh-activation [constrained-by]: reuses the
  // dispatch-miss seam's activation primitive rather than adding a second one
  await ctx.activatePluginClosure(pluginNames)
  const allLive = pluginNames.every((pluginName) => ctx.plugins.some((p) => p.name === pluginName))
  if (!allLive) {
    ctx.stderr.write(
      `error: enabled the ${name} adapter (config updated${result.daemonInstalled ? ' and daemon restarted' : ''}), ` +
      `but could not activate it in this process; re-run 'hyp attach ${name}' to finish\n`
    )
    getLogger('cmd-attach').warn('client.attach.enable_activate_failed', {
      [Attr.COMPONENT]: 'cmd-attach',
      [Attr.OPERATION]: 'client.attach',
      hyp_client: name,
      status: 'failed',
      [Attr.ERROR_KIND]: 'activation_incomplete',
    })
    return { activated: false }
  }

  getLogger('cmd-attach').info('client.attach.enable_prompt', {
    [Attr.COMPONENT]: 'cmd-attach',
    [Attr.OPERATION]: 'client.attach',
    hyp_client: name,
    status: 'ok',
    accepted: true,
    added_plugins: result.addedPlugins.join(','),
  })
  return { activated: true }
}

/**
 * The LLP 0244 migration offer: a base-URL install whose client attaches by
 * proxy gets one yes/no question, and a yes switches the install before the
 * attach proceeds (config write, daemon restart, bind wait, CA wait, via
 * `enableGatewayProxyMode`). Everything that is not an interactive,
 * single-client, wet-run attach gets today's behavior, with one stderr note
 * naming the interactive command when the switch would have applied:
 * migration is a one-time human decision, not something automation acquires
 * (LLP 0233's "never by inference, by upgrade, or as a side effect").
 *
 * The offer is keyed on the *config*, not the CA: a stale CA with
 * `proxy_mode` off means an earlier proxy install was half-unwound, and the
 * config write is still the repair the gateway's own stale-CA warning asks
 * for.
 *
 * Never throws into the attach: the caller downgrades any escape to a
 * warning, because base-URL attach is what this install already does and
 * remains the working fallback.
 *
 * @ref LLP 0244#attach-offers [implements]: one consented question, default no, naming the config write, the restart, and the coming trust dialog
 * @ref LLP 0244#central-managed [implements]: a fleet-owned gateway block reports instead of prompting
 * @ref LLP 0244#non-interactive [implements]: non-TTY and --json attaches never migrate; they emit the one-line pointer
 * @param {{ name: string, ctx: CommandRunContext, parsed: { client: string, dryRun: boolean, json: boolean } }} args
 * @returns {Promise<void>}
 */
async function maybeOfferProxyModeMigration({ name, ctx, parsed }) {
  // A dry run changes nothing and promises nothing, so it says nothing.
  // `hyp attach all` never prompts mid-run either (same posture as
  // maybeInteractiveEnableAttach above), but it does not return here: it
  // falls through to the one-line pointer below, because LLP 0244
  // #non-interactive owes every non-migrating attach shape the line naming
  // what was skipped and the command that migrates.
  if (parsed.dryRun) return

  const catalog = await buildAttachPluginCatalog(ctx)
  const descriptor = catalog.pickerDescriptors.get(name)
  if (descriptor?.compose?.gateway_proxy_mode !== true) return

  // The effective config this process booted with decides whether there is
  // anything to offer. An entry the LLP 0174 enable path appended seconds ago
  // is not in `ctx.config`, but it is also a bare entry with no `proxy_mode`,
  // so the answer is the same either way and the enable function re-reads
  // disk before writing.
  const effectiveGateway = (ctx.config?.plugins ?? []).find(
    (entry) => entry.name === '@hypaware/ai-gateway'
  )
  if (effectiveGateway?.config?.proxy_mode === true) return

  const log = getLogger('cmd-attach')

  // A fleet-owned gateway block has no local remedy, so report instead of
  // asking a question whose yes cannot land (the same reason
  // `disabled_central` never reaches the enable prompt). Ownership is
  // decided by the central layer NAMING the gateway plugin: a local entry
  // can exist beside it and still be dropped by the LLP 0031 merge, so its
  // presence proves nothing. This note replaces the interactive-terminal
  // pointer too - pointing a fleet host at a terminal would promise a
  // migration the local CLI cannot deliver.
  // @ref LLP 0244#central-managed [implements]: a fleet-owned gateway block reports, never prompts, in every attach shape
  const obsEnv = readObservabilityEnv(ctx.env)
  const configPath = ctx.env.HYP_CONFIG
    ? path.resolve(ctx.env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)
  /** @type {Awaited<ReturnType<typeof resolveLayeredConfigFromDisk>> | undefined} */
  let layered
  try {
    // Same metadata the accept path hands `enableGatewayProxyMode`, so the
    // two resolutions of the same layers can never disagree about validity.
    // (Central *detection* reads the loaded central document, which needs no
    // metadata; the metadata keeps the merged `effective` view honest.)
    layered = await resolveLayeredConfigFromDisk({
      stateRoot: obsEnv.stateDir,
      configPath,
      knownPlugins: catalog.pluginMetadata,
      knownDatasets: catalog.knownDatasets,
    })
  } catch {
    // Unresolvable layers prove nothing; fall through to the local file view.
  }
  const centralGateway = (layered?.centralConfig?.plugins ?? []).find(
    (entry) => entry.name === '@hypaware/ai-gateway'
  )
  if (centralGateway) {
    ctx.stderr.write(
      `note: this install attaches ${name} by base URL, and its gateway config is ` +
      `centrally managed; enable proxy_mode in the fleet config to switch it\n`
    )
    return
  }

  if (parsed.client === 'all' || parsed.json || !isTty(ctx.stdin)) {
    ctx.stderr.write(
      `note: this install attaches ${name} by base URL; run 'hyp attach ${name}' in an ` +
      `interactive terminal to switch it to proxy mode\n`
    )
    return
  }

  const localLoaded = await loadConfigFile(configPath)
  const localGateway = localLoaded.ok
    ? (localLoaded.config.plugins ?? []).find((entry) => entry.name === '@hypaware/ai-gateway')
    : undefined
  if (!localGateway) {
    // No gateway in any layer: the attach ladder below owns that error.
    return
  }

  const accepted = await askYesNo(
    ctx,
    `${capitalizeClientLabel(name)} can attach through HypAware's local HTTPS proxy instead of a ` +
    `repointed base URL, which keeps Remote Control working. Switching writes proxy_mode ` +
    `into the local config and restarts the daemon; macOS will then ask to trust the ` +
    `HypAware Local CA. Switch this install to proxy mode now? [y/N] `
  )
  if (!accepted) {
    ctx.stderr.write(
      `keeping the base-URL attach; re-run 'hyp attach ${name}' to switch later\n`
    )
    log.info('client.attach.proxy_migration', {
      [Attr.COMPONENT]: 'cmd-attach',
      [Attr.OPERATION]: 'client.attach',
      hyp_client: name,
      status: 'ok',
      accepted: false,
    })
    return
  }

  const result = await enableGatewayProxyMode({
    ctx,
    knownPlugins: catalog.pluginMetadata,
    knownDatasets: catalog.knownDatasets,
  })
  log.info('client.attach.proxy_migration', {
    [Attr.COMPONENT]: 'cmd-attach',
    [Attr.OPERATION]: 'client.attach',
    hyp_client: name,
    status: result.ok ? 'ok' : 'failed',
    accepted: true,
    outcome: result.outcome,
    ...(result.failedStep ? { failed_step: result.failedStep } : {}),
  })
  if (result.ok && result.outcome === 'enabled') {
    if (result.daemonInstalled) {
      ctx.stdout.write(`✓ proxy mode enabled (config updated, daemon restarted)\n`)
    } else {
      ctx.stdout.write(
        `✓ proxy_mode written to ${result.configPath}; no daemon service is installed, so ` +
        `start one (hyp daemon install, hyp daemon start) and re-run 'hyp attach ${name}'\n`
      )
    }
    return
  }
  if (result.outcome === 'already') return
  ctx.stderr.write(
    `warning: could not switch to proxy mode` +
    `${result.message ? ` (${result.message})` : ''}` +
    `${result.backupPath ? `; the previous config was backed up at ${result.backupPath}` : ''}; ` +
    `attaching by base URL instead\n`
  )
}

/**
 * Step 4 of design LLP 0174 #prompt: after T9's accept path enables and
 * attaches a client in this same invocation, offer to import its local
 * history too, with the identical question the init finale asks (T5's
 * exported `defaultBackfillConsentPromptFactory`), so accepting "enable"
 * does not also silently skip "backfill". Only ever called for a client
 * `activatedViaPrompt` marked true - a client whose adapter was already
 * enabled coming into this command takes the unchanged registered-state
 * attach path and never reaches this function at all.
 *
 * No question is asked at all when there is nothing to run: OpenClaw is
 * excluded outright (its own enable question, LLP 0174 #openclaw, already
 * disclosed and started the periodic sweep that imports its history within
 * about 5 minutes - asking again here would contradict that disclosure
 * rather than reuse it), and any other client with no provider registered
 * in `ctx.backfills` has nothing this step could import. Declining, like
 * the finale's own decline, leaves history unimported with no further
 * action; a prompt failure (including a TUI cancel) degrades to the same
 * "leave it unimported" outcome rather than turning an attach that already
 * succeeded into a failed exit code. A run failure is reported to stderr
 * and swallowed for the same reason.
 *
 * @ref LLP 0174#prompt [implements]: step 4, "backfill consent", reusing
 * the finale's own question and `runBackfillProvider` path instead of a
 * second bespoke one
 * @ref LLP 0174#openclaw [constrained-by]: OpenClaw's step 4 is a
 * disclosure, not a question, so it never reaches this prompt
 * @param {{ name: string, ctx: CommandRunContext }} args
 * @returns {Promise<void>}
 */
async function maybeBackfillAfterEnable({ name, ctx }) {
  if (name === 'openclaw') return
  const provider = ctx.backfills?.get?.(name)
  if (!provider) return

  const retentionDays = resolveRetentionDays({ flag: undefined, config: ctx.config })
  const until = new Date().toISOString()
  const ask = defaultBackfillConsentPromptFactory({
    ...(ctx.stdin ? { stdin: ctx.stdin } : {}),
    stdout: ctx.stdout,
    env: ctx.env,
  })

  let consent = false
  try {
    consent = await ask({ providers: [name], retentionDays })
  } catch {
    consent = false
  }

  getLogger('cmd-attach').info('client.attach.backfill_prompt', {
    [Attr.COMPONENT]: 'cmd-attach',
    [Attr.OPERATION]: 'client.attach',
    hyp_client: name,
    status: 'ok',
    accepted: consent,
  })
  if (!consent) {
    ctx.stdout.write(`backfill ${name}: skipped (declined)\n`)
    return
  }

  try {
    ctx.stdout.write(`backfill ${name}: importing local history…\n`)
    const result = await runBackfillProvider({ ctx, provider: name, dryRun: false, retentionDays, until })
    ctx.stdout.write(
      `backfill ${name}: ${result.ok ? 'ok' : 'failed'} ` +
      `(scanned ${result.scanned}, wrote ${result.rowsWritten}, skipped ${result.skipped})\n`
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`backfill ${name} failed: ${message}\n`)
  }
}

/**
 * Same existence probe {@link prepareLocalConfigWrite} uses internally, so
 * the bootstrap floor (LLP 0174 #bootstrap-floor) and the guarded write agree
 * on what "no local config file" means.
 *
 * @param {string} configPath
 * @returns {Promise<boolean>}
 */
async function configFileExists(configPath) {
  try {
    await fs.access(configPath)
    return true
  } catch {
    return false
  }
}

/**
 * Whether the additive enable write would leave the config exactly as
 * inactive as it found it, in which case the prompt has nothing to offer.
 *
 * Two shapes, both of them "known but not enabled" states an *append* cannot
 * repair, and both judged against the same name set `enableClientAdapter`
 * skips on (the **effective** merge union the local file, so an entry the
 * merge dropped still counts as physically present):
 *
 * - **Present but `enabled: false`.** The entry exists, so nothing is
 *   appended and the flag keeping the plugin out of the boot selection
 *   survives untouched. Both layers count deliberately: a locally disabled
 *   entry and a centrally-disabled one alike. So does every requested name,
 *   not just the adapter - a disabled `@hypaware/ai-gateway` starves the
 *   adapter just as effectively.
 * - **Every requested name already present.** `toAppend` is empty, so the
 *   write is a byte-identical rewrite. The config already says what the
 *   prompt would make it say, and whatever is keeping the plugin from
 *   activating is not something attach can write its way out of.
 *
 * An unresolvable config layer answers `false`: it cannot prove either shape,
 * and `enableClientAdapter`'s own read is what refuses a write it cannot make
 * safely.
 *
 * @param {{
 *   ctx: CommandRunContext,
 *   configPath: string,
 *   catalog: PluginCatalog,
 *   pluginNames: string[],
 * }} args
 * @returns {Promise<boolean>}
 */
async function enableWriteCannotDeliver({ ctx, configPath, catalog, pluginNames }) {
  try {
    const layered = await resolveLayeredConfigFromDisk({
      stateRoot: readObservabilityEnv(ctx.env).stateDir,
      configPath,
      knownPlugins: catalog.pluginMetadata,
      knownDatasets: catalog.knownDatasets,
    })
    const wanted = new Set(pluginNames)
    const effectiveEntries = layered.effective?.plugins ?? []
    if (effectiveEntries.some((entry) => wanted.has(entry.name) && entry.enabled === false)) {
      return true
    }
    const localLoaded = await loadConfigFile(configPath)
    const present = new Set([
      ...effectiveEntries.map((entry) => entry.name),
      ...(localLoaded.ok ? (localLoaded.config.plugins ?? []).map((entry) => entry.name) : []),
    ])
    return pluginNames.every((pluginName) => present.has(pluginName))
  } catch {
    return false
  }
}

/**
 * @param {string} name
 * @returns {string}
 */
function capitalizeClientLabel(name) {
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name
}

/**
 * Report `enableClientAdapter`'s failure in the same `--json` / stderr shape
 * as the rest of this file's attach failures.
 *
 * Per design `#prompt`'s "each step reports its own failure" paragraph, the
 * two shapes are deliberately different:
 *
 * - **The write itself failed** (`failedStep === 'write'`, the default when
 *   `enableClientAdapter` returns no `failedStep` at all): nothing else was
 *   attempted, so the message says only that the write failed and that
 *   nothing changed. There is no `backupPath` to name here - a write that
 *   never landed never had anything worth backing up.
 * - **The write landed but a later step (`restart` / `wait`) did not**: the
 *   message names the failed step by name, states that the config change
 *   already persists, and names the `.bak-<ts>` backup path
 *   `enableClientAdapter` returned, so a re-run of `hyp attach <name>` knows
 *   it is resuming from real on-disk state, not repeating a no-op.
 *
 * @ref LLP 0174#prompt [implements]: per-step failure reporting and the
 * resumability instruction on a partial (write-succeeded) failure
 * @param {{ name: string, result: ClientEnableResult, ctx: CommandRunContext }} args
 * @returns {void}
 */
function reportEnableFailure({ name, result, ctx }) {
  const failedStep = result.failedStep ?? 'write'
  getLogger('cmd-attach').warn('client.attach.enable_failed', {
    [Attr.COMPONENT]: 'cmd-attach',
    [Attr.OPERATION]: 'client.attach',
    hyp_client: name,
    status: 'failed',
    [Attr.ERROR_KIND]: `enable_${failedStep}_failed`,
  })
  const detail = result.message ?? 'unknown error'
  const message = failedStep === 'write'
    ? `could not enable the ${name} adapter: the config write failed (${detail}); nothing changed`
    : `could not enable the ${name} adapter: the ${failedStep} step failed (${detail}). ` +
      `The config change already persists` +
      (result.backupPath ? ` (config backed up to ${result.backupPath})` : '') +
      `; re-running 'hyp attach ${name}' resumes from the new state.`
  ctx.stderr.write(`error: ${message}\n`)
}

/**
 * Materialize one manually attached client's skills and subagents. A thin wrap
 * of {@link materializeClientAssets} with `hyp attach`'s stream conventions,
 * called from both attach exits - the one that wired the settings and the
 * daemon-managed one that found nothing left to wire - so neither can quietly
 * become the path that installs no assets.
 *
 * @param {{
 *   name: string,
 *   descriptorMap: Map<string, ClientDescriptor>,
 *   ctx: CommandRunContext,
 *   dryRun: boolean,
 *   json: boolean,
 * }} args
 * @returns {Promise<void>}
 */
async function materializeAttachAssets({ name, descriptorMap, ctx, dryRun, json }) {
  const homeDir = ctx.env.HOME ?? os.homedir()
  await materializeClientAssets({
    clients: [name],
    descriptors: descriptorMap,
    homeDir,
    stateRoot: clientAssetStateRoot(ctx.env, homeDir),
    skills: ctx.skills,
    agents: ctx.agents,
    ...(ctx.failedPlugins?.length ? { failedPlugins: ctx.failedPlugins } : {}),
    dryRun,
    // Under --json the adapter's one-line machine payload stays the only thing
    // on stdout, so the per-copy progress lines are suppressed.
    ...(json ? {} : { stdout: ctx.stdout }),
    stderr: ctx.stderr,
  })
}

/**
 * Reverse a client's attach from disk: the single core undo
 * (`detachClientFromDisk`). The manual `hyp detach` command and the
 * daemon reconciler's `reverse()` both route through this one
 * implementation, resolved per client via its `descriptor` (owning
 * plugin + `attach_probe`), so there is no per-adapter detach for the
 * one undo to drift from. Emits a `client.detach` span and the same
 * `done`/`no-op` output shape callers grep.
 *
 * Reversing an attach is settings *and* assets: this routine drops the attach
 * marker, and that marker is the only record of the skills and subagents an
 * org-driven attach copied, so it removes them before it clears it. Every
 * caller gets that - the manual `hyp detach` and `hyp leave`'s per-client
 * reversal alike - because the read-then-remove lives here, next to the clear,
 * rather than in one caller (LLP 0138 #marker-undo).
 *
 * `quiet` suppresses this routine's own stdout prose, warnings included, and
 * hands the full result back instead: a quiet caller takes on the duty of
 * rendering `result.warning` and `result.restoredPaths` itself, because those
 * lines can be the only surviving copy of what the undo left behind. The
 * asset-refusal stderr writes stay unconditional either way.
 *
 * `quietNoop` is the narrower cut, for a caller that still wants the prose:
 * it suppresses only the human "nothing to do" line, for the callers that
 * reverse a whole set of markers rather than the one client a user named.
 * `hyp leave` runs this over every attach marker on disk, and a client with
 * nothing left to reverse must not narrate a settings file the user may never
 * have had (#627). It changes nothing else, and never the `--json` payload,
 * which carries `changed` for exactly this distinction. It is moot under
 * `quiet`, which already withholds every stdout line this routine writes.
 *
 * @param {{
 *   name: string,
 *   descriptor: ClientDescriptor | undefined,
 *   dryRun: boolean,
 *   json: boolean,
 *   quiet?: boolean,
 *   quietNoop?: boolean,
 *   ctx: CommandRunContext,
 * }} args
 * @returns {Promise<DetachFromDiskResult | undefined>}
 * @ref LLP 0045#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements]: manual detach is the disk-driven core undo, resolved via the clientDescriptor; one undo, shared with the reconciler reverse()
 */
export async function detachClientViaCore({ name, descriptor, dryRun, json, quiet, quietNoop, ctx }) {
  if (!descriptor) {
    throw new Error(`no client descriptor for '${name}'; cannot reverse its attach from disk`)
  }
  const homeDir = ctx.env.HOME ?? os.homedir()
  return withSpan(
    'client.detach',
    {
      [Attr.PLUGIN]: descriptor.plugin,
      [Attr.OPERATION]: 'client.detach',
      client_name: name,
      hyp_client: name,
      dry_run: dryRun === true,
    },
    async (span) => {
      if (dryRun) {
        span.setAttribute('status', 'ok')
        span.setAttribute('restored', false)
        const settingsPath = descriptor.attachProbe
          ? resolveClientSettingsPath(name, descriptor.attachProbe.settings_file, ctx.env, homeDir)
          : undefined
        if (json) {
          ctx.stdout.write(
            JSON.stringify({
              status: 'ok',
              action: 'detach',
              client: name,
              dry_run: true,
              ...(settingsPath !== undefined ? { settings_path: settingsPath } : {}),
              changed: false,
            }) + '\n'
          )
        } else {
          ctx.stdout.write(
            `(dry-run) Would detach ${name}${settingsPath !== undefined ? ` from ${settingsPath}` : ''}\n`
          )
        }
        return
      }
      try {
        const result = await detachClientFromDisk({
          descriptor,
          homeDir,
          env: ctx.env,
        })
        const restored = result.changed === true
        span.setAttribute('status', 'ok')
        span.setAttribute('restored', restored)
        if (restored) {
          getLogger('cmd-detach').info('client.detach.write', {
            hyp_client: name,
            hyp_plugin: descriptor.plugin,
            settings_path: result.settingsPath,
            changed: true,
          })
        }
        if (!quiet) writeCoreDetachOutput({ ctx, name, json, quietNoop, result })
        const stateRoot = readObservabilityEnv(ctx.env).stateDir

        // Retract the attach marker so the CLI undo and the marker store stay in
        // sync, mirroring the reconciler's reverse() after its own disk undo,
        // including reverse()'s probe-less exception. `changed:false` is
        // overloaded: for a probe-HAVING descriptor it means "settings already
        // clean" (safe to clear a stale marker over them); for a probe-LESS
        // descriptor it means "cannot reverse, no probe to replay" (#212). In
        // that probe-less case reverse() KEEPS the marker (records a failed
        // reverse) rather than orphaning the settings attach() wrote, so we gate
        // on `attachProbe` and do the same: only a probe-having client
        // (changed:true OR already-clean) has its marker cleared; a probe-less
        // one keeps it. Without this retraction a manual detach reverses the
        // settings but leaves an orphaned `done` attach marker, and the next
        // `hyp join`'s forward gap short-circuits on it and never re-attaches the
        // client (#217). Best-effort: a marker we cannot retract is a status
        // blemish, not a detach failure (the settings undo already landed).
        // @ref LLP 0045#part-3-reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements]: manual detach retracts its attach marker via the one core undo's store (probe-less keeps it, like reverse()), so CLI and reconciler reverse cannot drift (#212/#217)
        //
        // The skills and subagents an org-driven attach installed come off its
        // marker, and the retraction below clears that marker, so they have to
        // be read and removed first: a detach that dropped the marker without
        // them would strand the files with nothing left on disk naming them.
        // Removal is marker-driven, never registry-driven, so a user's own
        // `hyp attach` / `hyp skills install` copy (which records no marker)
        // survives. Gated on the same `attachProbe` the retraction is: a
        // probe-less client keeps its marker, and the reconciler's reverse()
        // likewise refuses to touch assets it cannot un-wire the settings for.
        // @ref LLP 0107#reversal [implements]: detach removes the assets the org
        //   installed, exactly as it reverses the settings edits
        //
        // A removal that failed and one that was refused are not the same
        // outcome, so they do not share a resolution. An I/O failure may
        // succeed next run: keep the marker, fail the command, say so. A
        // containment refusal is deterministic - the recorded path and the
        // client's directories are both fixed - so it re-refuses forever, and
        // keeping the marker for it would make the undo permanently
        // unfinishable while leaving a `done` marker whose settings effect is
        // already reversed, the stale marker that blocks a later re-attach
        // (#217). Refusals print the paths and let the marker go, the same
        // degradation `hyp leave` already makes when the plugin is gone and
        // there are no directories to bound a delete.
        // @ref LLP 0138#refusal-is-not-failure [implements]: keep the marker
        //   for a removal that can still succeed; name what it leaves when not
        let assetFailure = ''
        if (descriptor.attachProbe) {
          const marker = readClientActionStatus({ stateRoot }).byKind.attach?.[name]
          const installedAssets = readInstalledAssets(marker)
          if (installedAssets.length > 0) {
            const { removed, failed } = await removeClientAssets(
              installedAssets,
              clientAssetBaseDirs(descriptor, homeDir)
            )
            if (removed.length > 0 && !json && !quiet) {
              ctx.stdout.write(`  Removed ${removed.length} org-installed asset(s)\n`)
            }
            const detail = failed.map((f) => `${f.dest} (${f.reason})`).join(', ')
            if (failed.some((f) => f.retryable)) {
              assetFailure =
                `detached '${name}', but ${failed.length} installed asset(s) could not be removed: ${detail}` +
                ' - kept the attach marker so a re-run can retry them'
            } else if (failed.length > 0) {
              // stderr, and unconditionally: this is the last moment these
              // paths are named anywhere, and under --json stdout is the
              // machine payload alone.
              ctx.stderr.write(
                `warning: ${failed.length} recorded asset(s) refused and left in place - remove them by hand:\n`
              )
              for (const f of failed) ctx.stderr.write(`  ${f.dest} (${f.reason})\n`)
            }
          }
        }
        if (descriptor.attachProbe && assetFailure.length === 0) {
          try {
            clearClientActionMarker({
              stateRoot,
              kind: 'attach',
              requestKey: name,
            })
          } catch (markerErr) {
            getLogger('cmd-detach').warn('client.detach.marker_retract_failed', {
              hyp_client: name,
              hyp_plugin: descriptor.plugin,
              error_kind: 'marker_retract_failed',
              detail: markerErr instanceof Error ? markerErr.message : String(markerErr),
            })
          }
        }
        if (assetFailure.length > 0) throw new Error(assetFailure)
        return result
      } catch (err) {
        span.setAttribute('status', 'failed')
        span.setAttribute('restored', false)
        throw err
      }
    },
    { component: 'cmd-detach' }
  )
}

/**
 * Reverse every known client's attach from disk, quietly, and report only what
 * actually changed.
 *
 * This is the sweep `hyp daemon uninstall` runs. Removing the service strands
 * every attached client on a gateway port that stops answering, and a client
 * pointed at a dead `ANTHROPIC_BASE_URL` does not degrade to talking to
 * Anthropic directly - it fails every request. So the level-4 exit finishes the
 * level-1 exit rather than leaving the machine in that state.
 *
 * Every known client is asked, not just the ones this process can prove are
 * attached: the core undo is already an honest no-op on a client that was never
 * attached (`changed: false`), so asking is cheaper and more truthful than a
 * second probe, and the returned `detached` list is exactly the set that had
 * something to reverse. Per-client failures are collected rather than thrown so
 * one wedged client cannot strand the rest still attached.
 *
 * Each `detached` entry carries the undo's own `warning` and `restoredPaths`
 * forward. The sweep runs the undo quiet, so these fields are the only copy of
 * notices like "overridden externally; leaving in place" - a caller that drops
 * them reports a detach as clean when the user still has a file to fix.
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<{
 *   detached: { name: string, settingsPath?: string, removed?: string, restoredValue?: string, restoredPaths?: string[], warning?: string }[],
 *   failed: { name: string, message: string }[],
 *   purgeLines: string[],
 * }>}
 * @ref LLP 0206#d1 [implements]: uninstalling the service detaches the clients it was serving
 */
export async function detachAllClientsFromDisk(ctx) {
  /** @type {{ name: string, settingsPath?: string, removed?: string, restoredValue?: string, restoredPaths?: string[], warning?: string }[]} */
  const detached = []
  /** @type {{ name: string, message: string }[]} */
  const failed = []
  const descriptors = await buildClientDescriptorMap(ctx)
  for (const [name, descriptor] of descriptors) {
    try {
      const result = await detachClientViaCore({
        name,
        descriptor,
        dryRun: false,
        json: false,
        quiet: true,
        ctx,
      })
      if (result?.changed === true) {
        detached.push({
          name,
          ...(result.settingsPath !== undefined ? { settingsPath: result.settingsPath } : {}),
          ...(result.removed !== undefined ? { removed: result.removed } : {}),
          ...(result.restoredValue !== undefined ? { restoredValue: result.restoredValue } : {}),
          ...(result.restoredPaths !== undefined ? { restoredPaths: result.restoredPaths } : {}),
          ...(result.warning !== undefined ? { warning: result.warning } : {}),
        })
      }
    } catch (err) {
      failed.push({ name, message: err instanceof Error ? err.message : String(err) })
    }
  }
  // Uninstall is the exit that ends the machine's trust grant: routine detach
  // keeps the CA and its keychain trust, so this sweep is where both must go,
  // or an uninstalled machine is left trusting a signing key with no owner.
  // @ref LLP 0238#ca-survives-detach [implements]: uninstall removes what detach keeps
  const purged = await purgeProxyTrustResidue({ ctx })
  return { detached, failed, purgeLines: purged.lines }
}

/**
 * Render the core detach output: machine-readable JSON when `json` is
 * set, otherwise human prose. The shape mirrors the retired adapter
 * output (`status`/`action`/`client`/`settings_path`/`changed`) so
 * callers that grepped it keep working.
 *
 * @param {{
 *   ctx: CommandRunContext,
 *   name: string,
 *   json: boolean,
 *   quietNoop?: boolean,
 *   result: {
 *     changed: boolean,
 *     settingsPath?: string,
 *     removed?: string,
 *     restoredValue?: string,
 *     restoredPaths?: string[],
 *     warning?: string,
 *   },
 * }} args
 */
function writeCoreDetachOutput({ ctx, name, json, quietNoop, result }) {
  const settingsPath = result.settingsPath
  if (json) {
    /** @type {Record<string, unknown>} */
    const payload = {
      status: 'ok',
      action: 'detach',
      client: name,
      dry_run: false,
      changed: result.changed === true,
    }
    if (settingsPath !== undefined) payload.settings_path = settingsPath
    if (result.removed !== undefined) payload.removed = result.removed
    if (result.restoredValue !== undefined) payload.restored_value = result.restoredValue
    if (result.restoredPaths !== undefined) payload.restored_paths = result.restoredPaths
    if (result.warning !== undefined) payload.warning = result.warning
    ctx.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  if (result.changed === true) {
    ctx.stdout.write(`✓ Detached ${name}${settingsPath !== undefined ? ` (${settingsPath})` : ''}\n`)
    if (result.removed !== undefined) ctx.stdout.write(`  Removed ${result.removed}\n`)
    if (result.restoredValue !== undefined) ctx.stdout.write(`  Restored ${result.restoredValue}\n`)
    // Named by path, never by value: this is the block attach repaired, and a
    // malformed `env` is exactly where an API key ends up (LLP 0163). Silence
    // here meant a detach that rewrote a block said only "✓ Detached".
    for (const restoredPath of result.restoredPaths ?? []) {
      ctx.stdout.write(`  Restored ${restoredPath} from the marker's malformed-block backup\n`)
    }
    if (result.warning !== undefined) ctx.stdout.write(`  warning: ${result.warning}\n`)
  } else if (quietNoop !== true) {
    // `changed: false` from a disk-driven undo means "this client's settings
    // hold nothing of ours", which is an answer when the user named the client
    // and noise when a sweep is walking every marker it can find (#627). Only
    // the sweeps pass `quietNoop`; `hyp detach <client>` still reports, since
    // this line is the whole of its output on an already-clean client.
    ctx.stdout.write(
      `No HypAware marker found${settingsPath !== undefined ? ` in ${settingsPath}` : ''}; nothing to do.\n`
    )
  }
}

/**
 * Parse an optional positional client name plus `--client <name>`,
 * `--dry-run`, and `--json` from argv.
 * @param {string[]} argv
 */
function parseClientArgs(argv) {
  /** @type {{ client: string, dryRun: boolean, json: boolean, purge: boolean, error?: string }} */
  const r = { client: 'claude', dryRun: false, json: false, purge: false }
  /** @type {string | undefined} */
  let requestedClient
  /**
   * @param {string | undefined} value
   * @param {'--client'|'positional'} source
   * @returns {boolean}
   */
  function setClient(value, source) {
    if (!value || value.startsWith('-')) {
      r.error = source === '--client'
        ? '--client requires a name'
        : 'client name is required'
      return false
    }
    // Match client names case-insensitively. The products are branded
    // "Claude"/"Codex" with capitals, but adapters register lowercase names
    // (CLIENT_NAME = 'claude') and the `all` sentinel is lowercase, so
    // `hyp attach Claude` / `hyp detach Codex` / `hyp attach ALL` are plausible
    // user tokens. Normalizing the single user-supplied token here covers attach
    // (live gateway registry), detach (client-descriptor map), and the `all`
    // sentinel in one place; adapter registration is unchanged (#300).
    const normalized = value.toLowerCase()
    if (requestedClient && requestedClient !== normalized) {
      r.error = `client specified multiple times (${requestedClient}, ${normalized})`
      return false
    }
    requestedClient = normalized
    r.client = normalized
    return true
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      r.dryRun = true
      continue
    }
    if (arg === '--json') {
      r.json = true
      continue
    }
    if (arg === '--purge') {
      r.purge = true
      continue
    }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!setClient(value, '--client')) return r
      continue
    }
    if (!arg.startsWith('-')) {
      if (!setClient(arg, 'positional')) return r
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * Remove the proxy-mode trust residue routine detach keeps: the on-disk CA
 * and, on macOS, its login-keychain trust entry and the launchd environment
 * delivery. Called by `hyp detach --purge` and by the uninstall sweep - the
 * two paths allowed to end the once-per-machine trust grant.
 * @ref LLP 0238#ca-survives-detach [implements]
 *
 * Best-effort and idempotent: each failure becomes a line, never a throw, so
 * a keychain hiccup cannot fail an uninstall whose settings undo already
 * landed.
 *
 * @param {{ ctx: CommandRunContext }} args
 * @returns {Promise<{ lines: string[] }>}
 */
async function purgeProxyTrustResidue({ ctx }) {
  /** @type {string[]} */
  const lines = []
  const homeDir = ctx.env.HOME ?? os.homedir()
  try {
    const { removed } = await deleteLocalCa({ stateRoot: defaultStateRoot(ctx.env, homeDir) })
    if (removed.length > 0) lines.push('removed the local interception CA')
  } catch (err) {
    lines.push(
      `! the local CA could not be removed (${err instanceof Error ? err.message : String(err)}); ` +
      'delete it by hand'
    )
  }
  if (process.platform === 'darwin') {
    try {
      const trust = await removeCaTrust({ homeDir })
      if (trust.removed) lines.push('removed the HypAware Local CA keychain trust')
      else if (trust.detail) lines.push(`! keychain trust could not be removed (${trust.detail})`)
    } catch (err) {
      lines.push(
        `! keychain trust could not be removed (${err instanceof Error ? err.message : String(err)})`
      )
    }
    // The marker-driven undo releases the launchd environment (LLP 0239), but
    // only when it finds a proxy marker to read. A settings file the user
    // deleted, or a marker damaged past its `mode` field, skips that branch
    // and would leave `NODE_USE_SYSTEM_CA=1` plus its login LaunchAgent
    // re-applying it forever on a machine HypAware has been removed from.
    // Idempotent, so the ordinary path that already released it is unharmed.
    // @ref LLP 0239#launchctl-setenv [implements]: uninstall and purge release the env even with no marker to read
    try {
      const env = await removeLaunchdEnv({ homeDir })
      if (env.removedPlist) lines.push('removed the NODE_USE_SYSTEM_CA login agent')
      if (!env.unset && env.detail) {
        lines.push(
          `! NODE_USE_SYSTEM_CA could not be unset (${env.detail}); ` +
          'run `launchctl unsetenv NODE_USE_SYSTEM_CA` by hand'
        )
      }
    } catch (err) {
      lines.push(
        '! NODE_USE_SYSTEM_CA could not be released ' +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        'run `launchctl unsetenv NODE_USE_SYSTEM_CA` by hand'
      )
    }
  }
  return { lines }
}

/**
 * Resolve `--client all` to every registered client name; otherwise
 * return the requested name verbatim.
 *
 * @param {string} requested
 * @param {AiGatewayCapability} gateway
 */
function expandClientName(requested, gateway) {
  if (requested === 'all') {
    return gateway.listClients().map((c) => c.name)
  }
  return [requested]
}

/**
 * Resolve `--client all` to every known client name from the descriptor map
 * (bundled+installed) for the disk-driven detach; otherwise return the
 * requested name verbatim (validated against the map at the call site). Detach
 * must not consult the live gateway registry: a client whose adapter was
 * dropped/unloaded still has an on-disk attach to reverse (LLP 0045 §Part 3).
 *
 * @param {string} requested
 * @param {Map<string, ClientDescriptor> | undefined} descriptors
 * @returns {string[]}
 */
function expandDetachClientNames(requested, descriptors) {
  if (requested === 'all') return [...(descriptors?.keys() ?? [])]
  return [requested]
}

// Usage string shared by the parse-error path and the CLI help registry
// (LLP 0103 #cli): kept next to the parser so the two never drift apart.
const IGNORE_USAGE = 'hyp ignore [path] [--check] [--json] [--local-only | --private | --sync]'

/**
 * Parse `hyp ignore` / `hyp unignore` argv: an optional positional path, the
 * `--check` / `--json` flags (`--check` is meaningful for `ignore` only), and
 * the three machine-local marking flags (LLP 0103 #cli), mutually exclusive:
 * `--local-only` (unchanged since LLP 0072), `--private` (a machine-local
 * `ignore` entry), and `--sync` (an explicit machine-local `full` entry, this
 * task's pick for the explicit-sync spelling). Bare `hyp ignore <path>` with
 * none of the three keeps its LLP 0049 dotfile meaning.
 *
 * @ref LLP 0103#cli [implements]: `--private` / `--sync` flag parsing, mutually exclusive with `--local-only`
 * @param {string[]} argv
 * @returns {{ check: boolean, json: boolean, localOnly: boolean, private: boolean, sync: boolean, path?: string, error?: string }}
 */
function parseIgnoreArgs(argv) {
  const empty = { check: false, json: false, localOnly: false, private: false, sync: false }
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      path: { type: 'string' },
      check: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'local-only': { type: 'boolean', default: false },
      private: { type: 'boolean', default: false },
      sync: { type: 'boolean', default: false },
    },
    positional: ['path'],
  })
  if ('help' in parsed) return { ...empty, error: `usage: ${IGNORE_USAGE}` }
  if (!parsed.ok) return { ...empty, error: parsed.error }
  const p = /** @type {{ path?: string, check: boolean, json: boolean, 'local-only': boolean, private: boolean, sync: boolean }} */ (
    parsed.params
  )
  const markingFlags = [p['local-only'], p.private, p.sync].filter(Boolean).length
  if (markingFlags > 1) {
    return { ...empty, error: '--local-only, --private, and --sync are mutually exclusive' }
  }
  return { check: p.check, json: p.json, localOnly: p['local-only'], private: p.private, sync: p.sync, path: p.path }
}

/**
 * `hyp ignore [path] [--check] [--local-only | --private | --sync]`
 *
 * Without any flag, writes a self-documenting `.hypignore` (comment header +
 * `ignore` token) so HypAware stops recording the folder subtree. The file
 * lands at the git **repo root** when the target is inside a repo, else at the
 * target directory; an explicit `path` overrides the default (cwd) target. The
 * write is idempotent (LLP 0049 R5): a path already governed by an ancestor
 * `.hypignore` is left as-is. With `--check`, reports status without writing.
 * With one of the three machine-local flags, marks the target in the
 * machine-local class-per-entry store instead of touching a dotfile
 * (LLP 0103 #cli): see {@link runMarkMachineLocal}. The bare-path dotfile
 * meaning is unchanged from LLP 0049.
 *
 * @ref LLP 0049#cli [implements]: the `hyp ignore` verb: write the dotfile at the repo root, idempotent, with a prospective-only `--check`
 * @ref LLP 0103#cli [implements]: `--private` / `--sync` dispatch to the machine-local marking verb, alongside the existing `--local-only`
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runIgnore(argv, ctx) {
  const parsed = parseIgnoreArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }
  // Resolve a relative `path` arg against the command-context cwd (matching the
  // sibling verbs above), not the Node process cwd, so injected/remote/test
  // dispatch writes/removes/checks the tree the caller actually pointed at.
  const base = path.resolve(ctx.cwd ?? process.cwd(), parsed.path ?? '.')
  // @ref LLP 0111#aliases [implements]: the --check/--private/--local-only/--sync flag branches are deprecated compatibility aliases that delegate to exactly the hoisted internals the `policy` subcommands call, so alias behavior can never drift from the verb's; the flag forms' repo-root defaulting (repoRootDefaultTarget) is preserved here at the alias edge
  if (parsed.check) return runIgnoreCheck({ targetDir: base, ctx, json: parsed.json })
  if (parsed.private)
    return runMarkMachineLocal({
      targetDir: repoRootDefaultTarget(base, parsed.path),
      ctx,
      targetClass: 'ignore',
      component: 'cmd-ignore',
    })
  if (parsed.localOnly)
    return runMarkMachineLocal({
      targetDir: repoRootDefaultTarget(base, parsed.path),
      ctx,
      targetClass: 'local-only',
      component: 'cmd-ignore',
    })
  if (parsed.sync)
    return runMarkMachineLocal({
      targetDir: repoRootDefaultTarget(base, parsed.path),
      ctx,
      targetClass: 'full',
      component: 'cmd-ignore',
    })

  // Idempotent (R5): a fresh resolver reflects disk. Any governing ancestor
  // `.hypignore` already ignores `base` (V1 has no un-ignore directive, any
  // `.hypignore` resolves to `ignore`), so re-ignoring is a no-op success
  // rather than a redundant nested file.
  const existing = createUsagePolicyResolver().resolve(base)
  if (existing.governedBy) {
    ctx.stdout.write(`already ignored (governed by ${existing.governedBy})\n`)
    return 0
  }

  // Default target: the repo root when `base` is in a git repo, else `base`.
  // An explicit `path` overrides: write exactly where the caller pointed.
  const targetDir = repoRootDefaultTarget(base, parsed.path)
  const file = path.join(targetDir, '.hypignore')
  try {
    await fs.writeFile(file, HYPIGNORE_TEMPLATE)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`error: could not write ${file}: ${message}\n`)
    return 1
  }
  getLogger('usage-policy').info('usage_policy.ignore_write', {
    [Attr.COMPONENT]: 'cmd-ignore',
    [Attr.OPERATION]: 'usage_policy.ignore_write',
    status: 'ok',
  })
  // A running daemon holds its own usage-policy resolver, so this new file is
  // honored within the matcher's cache TTL, not instantly (matcher.js
  // CACHE_TTL_MS). Future enhancement: signal the daemon here to invalidate and
  // prime this cwd's cache entry so the drop applies with zero latency.
  ctx.stdout.write(`wrote ${file}\n`)
  return 0
}

/**
 * Shared target-resolution rule for the marking verbs that default to a git
 * repo root: an explicit `path` argument always wins (the caller pointed at
 * it directly), otherwise resolve `base` up to its containing repo root, or
 * `base` itself outside a repo. Shared by the `hyp ignore` bare-dotfile
 * branch and the deprecated `--private`/`--local-only`/`--sync` alias
 * branches so both keep one placement rule (LLP 0103 #cli). `policy set`
 * does not call this: it marks the resolved directory exactly as pointed at,
 * with no repo-root default (LLP 0111 #set); only the flag-alias edge needs
 * the legacy default preserved (LLP 0111 #aliases).
 *
 * @param {string} base
 * @param {string | undefined} explicitPath
 * @returns {string}
 */
function repoRootDefaultTarget(base, explicitPath) {
  return explicitPath ? base : (findRepoRoot(base) ?? base)
}

/**
 * The human wording the deprecated `hyp ignore` / `hyp unignore` flag aliases
 * print: internals verbatim, which is exactly what they printed before the
 * `hyp policy` verb existed. Keeping it as the default of the shared writers
 * is what makes the aliases output-identical by construction (LLP 0111
 * #aliases) while `policy` renders the public vocabulary (LLP 0111 #tokens).
 *
 * @ref LLP 0111#aliases [implements]: the alias spellings keep their exact stdout, internal class name and store path included
 * @type {PolicyHumanVocabulary}
 */
const INTERNAL_VOCABULARY = {
  className: (cls) => cls,
  governor: (governedBy) => governedBy,
  storeSuffix: (listPath) => ` (${listPath})`,
}

/**
 * `hyp ignore --private [path]` / `hyp ignore --local-only [path]` /
 * `hyp ignore --sync [path]`
 *
 * Marks `targetDir` with `targetClass` in the machine-local class-per-entry
 * store (LLP 0103) instead of writing a `.hypignore`: never writes into a
 * repo (LLP 0071 R4, LLP 0100 R6), so the target need not exist on disk or be
 * a git repo. Verb-agnostic: the caller decides `targetDir` (the deprecated
 * `--private`/`--local-only`/`--sync` flag branches resolve it via
 * {@link repoRootDefaultTarget}, matching plain `hyp ignore`'s placement
 * rule; `policy set` passes its already-resolved path with no repo-root
 * default, LLP 0111 #set), so this one implementation backs both spellings.
 *
 * - `ignore`: rows from the scope are never recorded (enforced at the
 *   capture seam, same as a dotfile `ignore`).
 * - `local-only`: rows stay recorded to the local cache (queryable) but are
 *   dropped at the export seam (LLP 0070), unchanged since LLP 0072.
 * - `full`: an explicit "asked; syncs" marker. It resolves identically to
 *   the implicit default, but, unlike an unlisted directory, is a
 *   recorded answer the classification hook (LLP 0106) can see, so it never
 *   asks about this directory again.
 *
 * Idempotent and non-destructive (LLP 0104 boundary: marking never touches
 * cached rows). A target already governed by a class at least as
 * restrictive (`ignore`/`local-only`), from either source, is a no-op
 * success naming the governor; a `full` mark is idempotent only against an
 * existing *explicit* machine-local `full` entry (the implicit default for
 * an unlisted directory is not "already answered", LLP 0103).
 *
 * @ref LLP 0103#cli [implements]: the shared machine-local marking verb behind `--private` / `--local-only` / `--sync`
 * @ref LLP 0111#surface [implements]: also the shared implementation behind `policy set`; the `component` attribute names the dispatching verb and `vocabulary` picks that verb's human wording
 * @param {{ targetDir: string, ctx: CommandRunContext, targetClass: UsageClass, component: string, vocabulary?: PolicyHumanVocabulary }} args
 * @returns {Promise<number>}
 */
export async function runMarkMachineLocal({ targetDir, ctx, targetClass, component, vocabulary = INTERNAL_VOCABULARY }) {
  const resolvedTarget = path.resolve(targetDir)
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const listPath = localOnlyListPath(stateDir)

  const existing = createUsagePolicyResolver({ localOnlyListPath: listPath }).resolve(resolvedTarget)
  const alreadyMarked =
    targetClass === 'full'
      ? existing.governedBy === listPath && existing.class === 'full'
      : CLASS_RANK[existing.class] >= CLASS_RANK[targetClass]
  if (alreadyMarked) {
    const governor = existing.governedBy ? vocabulary.governor(existing.governedBy, listPath) : '(implicit default)'
    ctx.stdout.write(`already ${vocabulary.className(existing.class)} (governed by ${governor})\n`)
    return 0
  }

  const entries = await readLocalOnlyEntries({ stateDir })
  // Upsert identity is "denotes the same directory", not "is the same string":
  // re-marking a directory through a different spelling must update its class,
  // not append a second entry that governs the same directory at a different
  // class (which would make the resolver's nearest-governs tie-break decide the
  // user's privacy for them).
  // @ref LLP 0050#canonicalization [implements]: one stored entry per directory, whichever spelling declared it
  const withoutTarget = entries.filter((entry) => !sameDirectory(entry.dir, resolvedTarget))
  await writeLocalOnlyEntries({ stateDir, entries: [...withoutTarget, { dir: resolvedTarget, class: targetClass }] })
  getLogger('usage-policy').info('usage_policy.mark', {
    [Attr.COMPONENT]: component,
    [Attr.OPERATION]: 'usage_policy.mark',
    class: targetClass,
    status: 'ok',
  })
  // Same latency caveat as the dotfile write: a running daemon's resolver
  // picks this up within the matcher's cache TTL, not instantly.
  ctx.stdout.write(`marked ${resolvedTarget} as ${vocabulary.className(targetClass)}${vocabulary.storeSuffix(listPath)}\n`)
  return 0
}

/**
 * `hyp unignore [path] [--local-only | --private | --sync]`
 *
 * Removes the nearest governing `.hypignore`, re-enabling recording for the
 * subtree. Idempotent (LLP 0049 R5): unignoring a path that no `.hypignore`
 * governs succeeds as a no-op. With one of the three machine-local flags,
 * removes every machine-local entry of that class that governs the target
 * instead (LLP 0103 #cli, symmetric with the `hyp ignore` marking verbs):
 * see {@link runUnmarkMachineLocal}.
 *
 * @ref LLP 0049#cli [implements]: the `hyp unignore` verb: remove the governing dotfile, idempotent
 * @ref LLP 0103#cli [implements]: `--private` / `--sync` dispatch to the symmetric machine-local unmarking verb
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runUnignore(argv, ctx) {
  const parsed = parseIgnoreArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }
  if (parsed.check) {
    ctx.stderr.write('error: --check is only valid for `hyp ignore`\n')
    return 2
  }
  if (parsed.json) {
    ctx.stderr.write('error: --json is only valid for `hyp ignore --check`\n')
    return 2
  }
  // Resolve a relative `path` arg against the command-context cwd (matching the
  // sibling verbs above), not the Node process cwd, so injected/remote/test
  // dispatch writes/removes/checks the tree the caller actually pointed at.
  const base = path.resolve(ctx.cwd ?? process.cwd(), parsed.path ?? '.')
  // @ref LLP 0111#aliases [implements]: the --private/--local-only/--sync flag branches are deprecated compatibility aliases that delegate to exactly the hoisted class-scoped unmark internal the `policy unset` runner calls; the flag forms' cwd-relative target (no repo-root default) is preserved here at the alias edge
  if (parsed.private) return runUnmarkMachineLocal({ targetDir: base, ctx, targetClass: 'ignore', component: 'cmd-unignore' })
  if (parsed.localOnly)
    return runUnmarkMachineLocal({ targetDir: base, ctx, targetClass: 'local-only', component: 'cmd-unignore' })
  if (parsed.sync) return runUnmarkMachineLocal({ targetDir: base, ctx, targetClass: 'full', component: 'cmd-unignore' })

  const { governedBy } = createUsagePolicyResolver().resolve(base)
  if (!governedBy) {
    ctx.stdout.write(`not ignored (no .hypignore governs ${base})\n`)
    return 0
  }
  try {
    await fs.rm(governedBy, { force: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`error: could not remove ${governedBy}: ${message}\n`)
    return 1
  }
  getLogger('usage-policy').info('usage_policy.unignore_remove', {
    [Attr.COMPONENT]: 'cmd-unignore',
    [Attr.OPERATION]: 'usage_policy.unignore_remove',
    status: 'ok',
  })
  ctx.stdout.write(`removed ${governedBy}\n`)
  return 0
}

/**
 * `hyp unignore --private [path]` / `hyp unignore --local-only [path]` /
 * `hyp unignore --sync [path]`
 *
 * Removes every machine-local entry that governs `targetDir`, equal to it,
 * or an ancestor of it (the same segment-aware rule the shared resolver
 * applies, reused here via {@link scopeGoverns} rather than
 * re-derived, R8), mirroring dotfile `unignore`'s "remove the governing
 * thing" semantics. When `targetClass` is given, removal is scoped to that
 * one class and entries of a different class are left alone (LLP 0104
 * boundary: unmarking is class-scoped and non-destructive of cached rows
 * either way): this is what the `--private`/`--local-only`/`--sync`
 * `hyp unignore` flag branches pass. When `targetClass` is omitted, removal
 * is class-neutral: every machine-local entry governing `targetDir`, of any
 * class, is removed - `policy unset <path>`'s "back to the implicit
 * default" default (LLP 0111 #unset). Idempotent either way: no governing
 * entry (of that class, or of any class) is a no-op success. Verb-agnostic:
 * the caller resolves `targetDir` (today the flag forms' cwd-relative
 * `base`, with no repo-root default) and supplies `component` to name the
 * dispatching verb in the structured log event.
 *
 * @ref LLP 0103#cli [implements]: symmetric class-scoped removal for `--private` / `--local-only` / `--sync`
 * @ref LLP 0111#unset [implements]: the class-neutral `targetClass === undefined` branch backing `policy unset <path>`
 * @param {{ targetDir: string, ctx: CommandRunContext, targetClass?: UsageClass, component: string, vocabulary?: PolicyHumanVocabulary }} args
 * @returns {Promise<number>}
 */
export async function runUnmarkMachineLocal({ targetDir, ctx, targetClass, component, vocabulary = INTERNAL_VOCABULARY }) {
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const entries = await readLocalOnlyEntries({ stateDir })
  const governing = entries.filter(
    (entry) =>
      (targetClass === undefined || entry.class === targetClass) &&
      scopeGoverns(targetDir, entry.dir, { component })
  )
  if (governing.length === 0) {
    if (targetClass === undefined) {
      ctx.stdout.write(`not governed (no machine-local entry governs ${targetDir})\n`)
    } else {
      const label = vocabulary.className(targetClass)
      ctx.stdout.write(`not ${label} (no machine-local ${label} entry governs ${targetDir})\n`)
    }
    return 0
  }

  const governingDirs = new Set(governing.map((entry) => entry.dir))
  const remaining = entries.filter((entry) => !governingDirs.has(entry.dir))
  await writeLocalOnlyEntries({ stateDir, entries: remaining })
  getLogger('usage-policy').info('usage_policy.unmark', {
    [Attr.COMPONENT]: component,
    [Attr.OPERATION]: 'usage_policy.unmark',
    class: targetClass ?? 'any',
    status: 'ok',
  })
  const entrySuffix = governing.length === 1 ? 'y' : 'ies'
  if (targetClass === undefined) {
    // Class-neutral: name each removed entry's own class since they can differ.
    const removedDescr = governing.map((entry) => `${entry.dir} (${vocabulary.className(entry.class)})`).join(', ')
    ctx.stdout.write(`removed ${governing.length} entr${entrySuffix}: ${removedDescr}\n`)
  } else {
    const removedDirs = governing.map((entry) => entry.dir)
    ctx.stdout.write(
      `removed ${governing.length} ${vocabulary.className(targetClass)} entr${entrySuffix}: ${removedDirs.join(', ')}\n`
    )
  }
  return 0
}

/**
 * `hyp ignore --check [path]`
 *
 * Reports whether `path` (default cwd) is currently ignored, the resolved
 * usage class, and which source governs it, a `.hypignore` dotfile, or a
 * machine-local class-per-entry (LLP 0103 #cli: `--check` names the
 * governing source explicitly, not just the file path, so a `--private`/
 * `--local-only`/`--sync` mark and a committed dotfile read distinctly even
 * though both resolve through the same `resolve()` call), and the residual
 * count of already-cached rows from the scope. This is prospective-only:
 * `--check` never purges; it just surfaces the residue so the rule stays
 * debuggable (LLP 0049 #prospective-only), pointing at `hyp purge` for
 * removing it. For a `local-only`-governed scope, the residual count reads
 * as "recorded locally, withheld from forwarding" rather than "never
 * recorded".
 *
 * Verb-agnostic: the caller resolves `targetDir` (the flag form's
 * cwd-relative `base`, no repo-root default; `policy show` resolves the same
 * way), so this one implementation backs both `hyp ignore --check` and
 * `policy show`.
 *
 * @ref LLP 0049#prospective-only [implements]: `--check` reports the residual already-cached row count; it never deletes
 * @ref LLP 0103#reporting [implements]: `--check` names which source governs (dotfile vs machine-local entry) and the entry's class
 * @ref LLP 0111#show [implements]: also the shared implementation behind `policy show`; `vocabulary` moves only the human lines, so `--json` stays byte-compatible with the `--check --json` field set
 * @param {{ targetDir: string, ctx: CommandRunContext, json: boolean, vocabulary?: PolicyHumanVocabulary }} args
 * @returns {Promise<number>}
 */
export async function runIgnoreCheck({ targetDir, ctx, json, vocabulary = INTERNAL_VOCABULARY }) {
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const listPath = localOnlyListPath(stateDir)
  const result = createUsagePolicyResolver({ localOnlyListPath: listPath }).resolve(targetDir)
  const ignored = result.class === 'ignore'
  const governed = result.class !== 'full'
  const scopeDir = governed ? await resolveCheckScopeDir({ result, base: targetDir, stateDir, listPath }) : targetDir
  const residual = governed ? await countResidualCachedRows(scopeDir, ctx) : 0
  // LLP 0103: name the governing source distinctly from the raw path, so a
  // machine-local mark and a committed dotfile read differently even though
  // both resolve through the same `resolve()` call.
  const source = !result.governedBy ? 'none' : result.governedBy === listPath ? 'machine-local' : 'dotfile'
  const purgeHint = residual ? ` (use 'hyp purge' to remove them)` : ''

  if (json) {
    ctx.stdout.write(
      JSON.stringify({
        path: targetDir,
        ignored,
        governedBy: result.governedBy,
        source,
        class: result.class,
        declared: result.declared,
        residualCachedRows: residual,
      }) + '\n'
    )
    return 0
  }

  // An unmarked directory resolves to the implicit `full` default (matcher.js),
  // which renders as the identical token a user's explicit `sync` mark would
  // (LLP 0111 #tokens): `class: sync` alone cannot be told apart from "I asked
  // and the user said sync". The privacy skill reads this line to decide
  // whether a directory has already been classified, so the implicit case
  // must say so; `implicitSuffix` defaults to a no-op so the deprecated
  // `--check` alias output is untouched (LLP 0111 #aliases).
  // @ref LLP 0111#show [implements]: the implicit-default class label is unmistakable, never confusable with an explicit user classification
  const implicitSuffix = result.governedBy ? '' : (vocabulary.implicitSuffix ?? (() => ''))()
  ctx.stdout.write(`path: ${targetDir}\n`)
  ctx.stdout.write(`ignored: ${ignored ? 'yes' : 'no'}\n`)
  ctx.stdout.write(`class: ${vocabulary.className(result.class)}${implicitSuffix}\n`)
  ctx.stdout.write(`source: ${source}\n`)
  ctx.stdout.write(`governed-by: ${result.governedBy ? vocabulary.governor(result.governedBy, listPath) : '(none)'}\n`)
  ctx.stdout.write(`residual-cached-rows: ${residual === null ? 'unknown' : residual}${purgeHint}\n`)
  return 0
}

/**
 * Resolve the directory whose residual cached rows `hyp ignore --check`
 * should count: the directory containing the governing `.hypignore` when
 * governed by a dotfile (unchanged from before the machine-local list
 * existed), or, when governed by the machine-local store
 * (`result.governedBy === listPath`), the entry the gate itself used, from
 * the shared {@link governingListEntry} selector rather than a second copy of
 * the selection rule (R8). The `resolve()` call already decided *whether*
 * something governs; this only identifies *which* listed directory did, for
 * display and scoping the residual count - so it has to make the same choice
 * the resolver made. Re-deriving it from `scopeGoverns` plus "longest declared
 * string" does not: once an entry can match through its canonical spelling,
 * the longest declared string and the deepest matching spelling are different
 * entries, and `--check` would scope its residual count to one while
 * reporting the other's class.
 *
 * @param {{ result: ResolveResult, base: string, stateDir: string, listPath: string }} args
 * @returns {Promise<string>}
 */
async function resolveCheckScopeDir({ result, base, stateDir, listPath }) {
  if (!result.governedBy) return base
  if (result.governedBy !== listPath) return path.dirname(result.governedBy)
  const entries = await readLocalOnlyEntries({ stateDir })
  const governing = governingListEntry(base, entries, { component: 'cmd-ignore-check' })
  return governing === null ? base : governing.dir
}

/**
 * Count already-cached `ai_gateway_messages` rows whose `cwd`/`repo_root` lies
 * under `scopeDir`: the residue an `ignore` does NOT purge (prospective-only).
 *
 * A LIKE pushes a *superset* filter into the scan (squirreling's LIKE treats
 * `_`/`%` as wildcards, so a path containing them can only over-match, never
 * under-match), then an exact `startsWith` refine in JS removes the false
 * positives so the reported count is precise. Best-effort: when the dataset is
 * not registered (the gateway plugin is inactive) or the cache cannot be read,
 * returns `null` so the caller renders `unknown` rather than failing.
 *
 * @param {string} scopeDir
 * @param {CommandRunContext} ctx
 * @returns {Promise<number | null>}
 */
async function countResidualCachedRows(scopeDir, ctx) {
  const lit = scopeDir.replace(/'/g, "''")
  const likePrefix = `${scopeDir}/`.replace(/'/g, "''")
  const sql =
    `SELECT cwd, repo_root FROM ai_gateway_messages ` +
    `WHERE cwd = '${lit}' OR cwd LIKE '${likePrefix}%' ` +
    `OR repo_root = '${lit}' OR repo_root LIKE '${likePrefix}%'`
  try {
    // Residual-row COUNT for `hyp ignore --check`: the whole point is to
    // count rows recorded under a directory the user is restricting, so the
    // LLP 0105 visibility filter is bypassed; only the count (never content)
    // reaches the local consent surface.
    const out = await executeQuerySql({
      query: sql,
      registry: ctx.query,
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      refresh: 'never',
      config: ctx.config,
      includeLocalOnly: true,
    })
    let n = 0
    for (const row of out.rows ?? []) {
      const cwd = row.cwd == null ? '' : String(row.cwd)
      const repoRoot = row.repo_root == null ? '' : String(row.repo_root)
      if (isUnderDir(cwd, scopeDir) || isUnderDir(repoRoot, scopeDir)) n += 1
    }
    return n
  } catch {
    return null
  }
}

/**
 * True when `p` is `dir` itself or a path strictly beneath it.
 *
 * @param {string} p
 * @param {string} dir
 * @returns {boolean}
 */
function isUnderDir(p, dir) {
  if (p === '') return false
  if (p === dir) return true
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  return p.startsWith(prefix)
}

/**
 * `hyp skills install [--client <name>|all]` (the parser defaults to `all`)
 *
 * Materializes every registered skill **and subagent** into the right
 * per-client directories. One command, because a user asking for their
 * helpers installed is not distinguishing a skill directory from a
 * subagent file; the two shapes are a detail of the copy
 * ({@link materializeClientAssets}), not of the request. Existing
 * installations are replaced (idempotent).
 *
 * The standalone manual path stays useful after LLP 0107 put the same
 * materialization on attach: it re-runs the copy without re-attaching,
 * which is what a user wants after editing or clobbering an installed
 * skill.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0138#one-command [implements]: skills and agents install together
 *   under `hyp skills install`; there is no second command for the agent half.
 */
export async function runSkillsInstall(argv, ctx) {
  const parsed = parseSkillsArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }

  const homeDir = ctx.env.HOME ?? process.env.HOME ?? ''
  if (!homeDir) {
    ctx.stderr.write('error: HOME is not set; cannot resolve skill install paths\n')
    return 1
  }

  const descriptors = await buildClientDescriptorMap(ctx)
  const { installed } = await materializeClientAssets({
    clients: parsed.client === 'all' ? 'all' : [parsed.client],
    descriptors,
    homeDir,
    stateRoot: clientAssetStateRoot(ctx.env, homeDir),
    skills: ctx.skills,
    agents: ctx.agents,
    ...(ctx.failedPlugins?.length ? { failedPlugins: ctx.failedPlugins } : {}),
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  })

  if (installed.length === 0) {
    ctx.stdout.write('(nothing to install)\n')
    return 0
  }
  const skillCount = installed.filter((a) => a.kind === 'skill').length
  const agentCount = installed.length - skillCount
  ctx.stdout.write(`installed ${skillCount} skill copy(ies), ${agentCount} agent copy(ies)\n`)
  return 0
}

/**
 * Build the full bundled+installed plugin catalog (`plugins`,
 * `pluginMetadata`, `knownDatasets`, `clientDescriptors`,
 * `pickerDescriptors`) by reading plugin manifests. This avoids
 * hardcoding `.claude/skills` / `.codex/skills` / `.claude/agents` in
 * core.
 *
 * Built from the same **bundled + installed** catalog that `boot.js` and
 * `status.js` use, so an installed (non-bundled) client adapter that can
 * attach-on-join is also resolvable here: its `hyp detach` / skill / agent
 * install must not silently miss the descriptor.
 *
 * @ref LLP 0174#detection [implements]: generalized from a
 * clientDescriptors-only map so the attach enablement-detection and
 * prompt flow can also read `pickerDescriptors` (dependency resolution)
 * and `pluginMetadata`/`knownDatasets` (layered config resolution) from
 * one catalog build instead of two.
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<PluginCatalog>}
 */
export async function buildAttachPluginCatalog(ctx) {
  /** @type {LoadedManifest[]} */
  let bundledLoaded = []
  /** @type {LoadedManifest[]} */
  let installedLoaded = []
  try {
    const bundled = await discoverBundledPlugins()
    bundledLoaded = [...bundled.loaded, ...bundled.excluded]
  } catch { /* bundled discovery failure is non-fatal */ }
  try {
    const stateDir = pluginStateDir(ctx)
    const installed = await discoverInstalledPlugins({ stateDir })
    installedLoaded = installed.loaded
  } catch { /* installed discovery failure is non-fatal */ }
  try {
    return buildPluginCatalog(bundledLoaded, installedLoaded)
  } catch {
    /* catalog build failure → empty catalog → warnings per contribution */
    return {
      plugins: new Map(),
      pluginMetadata: new Map(),
      knownDatasets: new Set(),
      clientDescriptors: new Map(),
      pickerDescriptors: new Map(),
    }
  }
}

/**
 * Build a map from client name to client descriptor. Reimplemented as a
 * thin projection of {@link buildAttachPluginCatalog}'s `clientDescriptors`
 * so callers that only need client lookup do not carry the full catalog.
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<Map<string, ClientDescriptor>>}
 */
export async function buildClientDescriptorMap(ctx) {
  return (await buildAttachPluginCatalog(ctx)).clientDescriptors
}

/** @param {string[]} argv */
function parseSkillsArgs(argv) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: { client: { type: 'string', default: 'all' } },
  })
  if ('help' in parsed) return { client: 'all', error: 'usage: hyp skills install [--client <name>|all]' }
  if (!parsed.ok) return { client: 'all', error: parsed.error }
  const p = /** @type {{ client: string }} */ (parsed.params)
  return { client: p.client }
}

// The body written by `hyp ignore`: a self-documenting `.hypignore` whose
// first meaningful token is the `ignore` usage class. The comment header
// explains the file to whoever finds it in a checkout; the matcher only ever
// reads the token (LLP 0049 #file-format).
const HYPIGNORE_TEMPLATE = `# HypAware usage policy (.hypignore)
#
# This folder and everything beneath it is IGNORED: AI gateway exchanges
# (Claude / Codex) whose working directory is at or under this directory are
# never written to the local HypAware cache, for live capture and backfill
# alike. Recording is suppressed at the capture seam; the live LLM call is
# untouched (LLP 0049 / LLP 0050).
#
# Managed by \`hyp ignore\` / \`hyp unignore\`; \`hyp ignore --check\` reports
# status. Removing this file re-enables recording for the subtree.
#
# The token below names the usage class. V1 implements only \`ignore\`.
ignore
`

// @ts-check

import fs from 'node:fs/promises'
import { parseCommandArgv } from '../cli/verb_codec.js'
import { copyDir } from '../util/fs_copy.js'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { discoverInstalledPlugins } from '../runtime/installed.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { isWithinDir } from '../runtime/contribution_names.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { detachClientFromDisk } from '../config/client_detach_disk.js'
import { clearClientActionMarker } from '../config/action_reconciler.js'
import { configuredGatewayEndpoint, portFromEndpoint } from '../config/gateway_endpoint.js'
import { resolveClientSettingsPath } from '../daemon/client_settings_path.js'
import { probeClientAttachFromDescriptor, resolveLiveGatewayEndpointFromStatus } from '../daemon/status.js'
import {
  CLASS_RANK,
  createUsagePolicyResolver,
  findRepoRoot,
  isEqualOrDescendant,
  localOnlyListPath,
  readLocalOnlyEntries,
  writeLocalOnlyEntries,
} from '../usage-policy/index.js'
import { executeQuerySql } from '../query/sql.js'
import { pluginStateDir } from './plugin.js'

/**
 * @import { AiGatewayCapability, CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ClientDescriptor, LoadedManifest } from '../../../src/core/types.js'
 * @import { ResolveResult, UsageClass } from '../../../src/core/usage-policy/types.js'
 */

/**
 * `hyp attach [client] [--client <name>] [--yes]`
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
 * @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements] — manual detach routes through the one core undo via the clientDescriptor, not a per-adapter detach()
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
  // with the @hypaware/ai-gateway capability absent/unloaded — resolve and
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
    return exitCode
  }

  // Attach dispatches to the per-adapter attach() hook and threads the
  // gateway's localEndpoint(), so it requires the live @hypaware/ai-gateway
  // capability.
  if (!ctx.capabilities.has('hypaware.ai-gateway')) {
    await withSpan(
      `client.${action}`,
      {
        [Attr.COMPONENT]: `cmd-${action}`,
        [Attr.OPERATION]: `client.${action}`,
        client_name: parsed.client,
        hyp_client: parsed.client,
        dry_run: parsed.dryRun === true,
        status: 'failed',
        error_kind: 'cap_missing',
      },
      async () => {
        const message =
          `${action} requires the @hypaware/ai-gateway plugin to be installed and activated`
        if (parsed.json) {
          ctx.stdout.write(
            JSON.stringify({
              status: 'failed',
              action,
              client: parsed.client,
              dry_run: parsed.dryRun === true,
              error_kind: 'cap_missing',
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
  /** @type {AiGatewayCapability} */
  const gateway = ctx.capabilities.require('hyp-core', 'hypaware.ai-gateway', '^2.0.0')

  const clientNames = expandClientName(parsed.client, gateway)
  if (clientNames.length === 0) {
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
    try {
      const client = gateway.getClient(name)
      if (!client) {
        ctx.stderr.write(`error: unknown client '${name}'\n`)
        exitCode = 1
        continue
      }
      // In dry-run mode the gateway source may not be started yet,
      // so `localEndpoint()` could throw. Fall back to a placeholder
      // endpoint — adapters are expected to short-circuit before
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
            // fall back on: the default ephemeral-port, daemon-managed install
            // (an unpinned gateway binds a port only the running daemon knows).
            // The daemon persists that bound port to status.json, so discover
            // it - guarded by a daemon-liveness check - instead of guessing or
            // reporting the internal endpoint error.
            // @ref LLP 0045#part-1--the-client-seam-in-the-reconcile-context: manual attach without a configured listen defers to the daemon; probe disk, don't guess a port
            // @ref LLP 0086#manual-attach-reads-the-live-port [implements] — hyp attach falls back to status.json sources[].details.port before giving up
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
            // @ref LLP 0086#already-attached-validates-the-live-port [implements] — the already-attached branch compares recorded vs live port; a stale-port marker re-attaches
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
                  `the daemon manages attach for this install, nothing to do.\n`
                )
              }
              continue
            }
            if (liveEndpoint) {
              // A live daemon endpoint we can (re)attach at: either not attached,
              // or attached at a now-stale port. Fall through to client.attach,
              // which is idempotent and re-points the client at the live port.
              endpoint = liveEndpoint
            } else {
              const message =
                `cannot resolve the gateway endpoint: the gateway is not running in this ` +
                `process and no ai-gateway 'listen' address is configured. Start the daemon ` +
                `(hyp start) so it can attach clients, or set 'listen' in the ai-gateway config.`
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.stderr.write(`error: ${action} client '${name}' failed: ${message}\n`)
      exitCode = 1
    }
  }
  return exitCode
}

/**
 * Reverse a client's attach from disk — the single core undo
 * (`detachClientFromDisk`). The manual `hyp detach` command and the
 * daemon reconciler's `reverse()` both route through this one
 * implementation, resolved per client via its `descriptor` (owning
 * plugin + `attach_probe`), so there is no per-adapter detach for the
 * one undo to drift from. Emits a `client.detach` span and the same
 * `done`/`no-op` output shape callers grep.
 *
 * @param {{
 *   name: string,
 *   descriptor: ClientDescriptor | undefined,
 *   dryRun: boolean,
 *   json: boolean,
 *   ctx: CommandRunContext,
 * }} args
 * @returns {Promise<void>}
 * @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements] — manual detach is the disk-driven core undo, resolved via the clientDescriptor; one undo, shared with the reconciler reverse()
 */
export async function detachClientViaCore({ name, descriptor, dryRun, json, ctx }) {
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
        const result = await detachClientFromDisk({ descriptor, homeDir, env: ctx.env })
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
        // @ref LLP 0045#part-3--reverse-runs-from-disk-the-marker-is-a-self-describing-undo-record [implements] — manual detach retracts its attach marker via the one core undo's store (probe-less keeps it, like reverse()), so CLI and reconciler reverse cannot drift (#212/#217)
        if (descriptor.attachProbe) {
          try {
            clearClientActionMarker({
              stateRoot: readObservabilityEnv(ctx.env).stateDir,
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
        writeCoreDetachOutput({ ctx, name, json, result })
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
 * Render the core detach output: machine-readable JSON when `json` is
 * set, otherwise human prose. The shape mirrors the retired adapter
 * output (`status`/`action`/`client`/`settings_path`/`changed`) so
 * callers that grepped it keep working.
 *
 * @param {{
 *   ctx: CommandRunContext,
 *   name: string,
 *   json: boolean,
 *   result: {
 *     changed: boolean,
 *     settingsPath?: string,
 *     removed?: string,
 *     restoredValue?: string,
 *     warning?: string,
 *   },
 * }} args
 */
function writeCoreDetachOutput({ ctx, name, json, result }) {
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
    if (result.warning !== undefined) payload.warning = result.warning
    ctx.stdout.write(JSON.stringify(payload) + '\n')
    return
  }
  if (result.changed === true) {
    ctx.stdout.write(`✓ Detached ${name}${settingsPath !== undefined ? ` (${settingsPath})` : ''}\n`)
    if (result.removed !== undefined) ctx.stdout.write(`  Removed ${result.removed}\n`)
    if (result.restoredValue !== undefined) ctx.stdout.write(`  Restored ${result.restoredValue}\n`)
    if (result.warning !== undefined) ctx.stdout.write(`  warning: ${result.warning}\n`)
  } else {
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
  /** @type {{ client: string, dryRun: boolean, json: boolean, error?: string }} */
  const r = { client: 'claude', dryRun: false, json: false }
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
    if (requestedClient && requestedClient !== value) {
      r.error = `client specified multiple times (${requestedClient}, ${value})`
      return false
    }
    requestedClient = value
    r.client = value
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
 * must not consult the live gateway registry — a client whose adapter was
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
 * (LLP 0103 #cli) — see {@link runMarkMachineLocal}. The bare-path dotfile
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
  if (parsed.check) return runIgnoreCheck(parsed, ctx)
  if (parsed.private) return runMarkMachineLocal(parsed, ctx, 'ignore')
  if (parsed.localOnly) return runMarkMachineLocal(parsed, ctx, 'local-only')
  if (parsed.sync) return runMarkMachineLocal(parsed, ctx, 'full')

  // Resolve a relative `path` arg against the command-context cwd (matching the
  // sibling verbs above), not the Node process cwd, so injected/remote/test
  // dispatch writes/removes/checks the tree the caller actually pointed at.
  const base = path.resolve(ctx.cwd ?? process.cwd(), parsed.path ?? '.')
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
  const targetDir = parsed.path ? base : (findRepoRoot(base) ?? base)
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
 * `hyp ignore --private [path]` / `hyp ignore --local-only [path]` /
 * `hyp ignore --sync [path]`
 *
 * Marks the resolved target with `targetClass` in the machine-local
 * class-per-entry store (LLP 0103) instead of writing a `.hypignore`: never
 * writes into a repo (LLP 0071 R4, LLP 0100 R6), so the target need not exist
 * on disk or be a git repo. Resolves the target the same way plain
 * `hyp ignore` does — the git repo root when `base` is inside one, else
 * `base`; an explicit `path` overrides.
 *
 * - `ignore`: rows from the scope are never recorded (enforced at the
 *   capture seam, same as a dotfile `ignore`).
 * - `local-only`: rows stay recorded to the local cache (queryable) but are
 *   dropped at the export seam (LLP 0070), unchanged since LLP 0072.
 * - `full`: an explicit "asked; syncs" marker. It resolves identically to
 *   the implicit default, but — unlike an unlisted directory — is a
 *   recorded answer the classification hook (LLP 0106) can see, so it never
 *   asks about this directory again.
 *
 * Idempotent and non-destructive (LLP 0104 boundary: marking never touches
 * cached rows). A target already governed by a class at least as
 * restrictive (`ignore`/`local-only`) — from either source — is a no-op
 * success naming the governor; a `full` mark is idempotent only against an
 * existing *explicit* machine-local `full` entry (the implicit default for
 * an unlisted directory is not "already answered", LLP 0103).
 *
 * @ref LLP 0103#cli [implements]: the shared machine-local marking verb behind `--private` / `--local-only` / `--sync`
 * @param {{ path?: string }} parsed
 * @param {CommandRunContext} ctx
 * @param {UsageClass} targetClass
 * @returns {Promise<number>}
 */
async function runMarkMachineLocal(parsed, ctx, targetClass) {
  // Resolve a relative `path` arg against the command-context cwd (matching the
  // sibling verbs above), not the Node process cwd, so injected/remote/test
  // dispatch adds/removes/checks the tree the caller actually pointed at.
  const base = path.resolve(ctx.cwd ?? process.cwd(), parsed.path ?? '.')
  // Default target: the repo root when `base` is in a git repo, else `base`.
  // An explicit `path` overrides: record exactly the directory the caller
  // pointed at, mirroring the dotfile verb's placement rule.
  const targetDir = parsed.path ? base : (findRepoRoot(base) ?? base)
  const resolvedTarget = path.resolve(targetDir)
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const listPath = localOnlyListPath(stateDir)

  const existing = createUsagePolicyResolver({ localOnlyListPath: listPath }).resolve(resolvedTarget)
  const alreadyMarked =
    targetClass === 'full'
      ? existing.governedBy === listPath && existing.class === 'full'
      : CLASS_RANK[existing.class] >= CLASS_RANK[targetClass]
  if (alreadyMarked) {
    ctx.stdout.write(`already ${existing.class} (governed by ${existing.governedBy ?? '(implicit default)'})\n`)
    return 0
  }

  const entries = await readLocalOnlyEntries({ stateDir })
  const withoutTarget = entries.filter((entry) => entry.dir !== resolvedTarget)
  await writeLocalOnlyEntries({ stateDir, entries: [...withoutTarget, { dir: resolvedTarget, class: targetClass }] })
  getLogger('usage-policy').info('usage_policy.mark', {
    [Attr.COMPONENT]: 'cmd-ignore',
    [Attr.OPERATION]: 'usage_policy.mark',
    class: targetClass,
    status: 'ok',
  })
  // Same latency caveat as the dotfile write: a running daemon's resolver
  // picks this up within the matcher's cache TTL, not instantly.
  ctx.stdout.write(`marked ${resolvedTarget} as ${targetClass} (${listPath})\n`)
  return 0
}

/**
 * `hyp unignore [path] [--local-only | --private | --sync]`
 *
 * Removes the nearest governing `.hypignore`, re-enabling recording for the
 * subtree. Idempotent (LLP 0049 R5): unignoring a path that no `.hypignore`
 * governs succeeds as a no-op. With one of the three machine-local flags,
 * removes every machine-local entry of that class that governs the target
 * instead (LLP 0103 #cli, symmetric with the `hyp ignore` marking verbs) —
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
  if (parsed.private) return runUnmarkMachineLocal(parsed, ctx, 'ignore')
  if (parsed.localOnly) return runUnmarkMachineLocal(parsed, ctx, 'local-only')
  if (parsed.sync) return runUnmarkMachineLocal(parsed, ctx, 'full')

  // Resolve a relative `path` arg against the command-context cwd (matching the
  // sibling verbs above), not the Node process cwd, so injected/remote/test
  // dispatch writes/removes/checks the tree the caller actually pointed at.
  const base = path.resolve(ctx.cwd ?? process.cwd(), parsed.path ?? '.')
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
 * Removes every machine-local entry of `targetClass` that governs the
 * target — equal to it, or an ancestor of it (the same segment-aware rule
 * the shared resolver applies, reused here via {@link isEqualOrDescendant}
 * rather than re-derived, R8) — mirroring dotfile `unignore`'s "remove the
 * governing thing" semantics. Entries of a different class are left alone
 * (LLP 0104 boundary: unmarking is class-scoped and non-destructive of
 * cached rows either way). Idempotent: no governing entry of that class is
 * a no-op success.
 *
 * @ref LLP 0103#cli [implements]: symmetric class-scoped removal for `--private` / `--local-only` / `--sync`
 * @param {{ path?: string }} parsed
 * @param {CommandRunContext} ctx
 * @param {UsageClass} targetClass
 * @returns {Promise<number>}
 */
async function runUnmarkMachineLocal(parsed, ctx, targetClass) {
  // Resolve a relative `path` arg against the command-context cwd (matching the
  // sibling verbs above), not the Node process cwd, so injected/remote/test
  // dispatch adds/removes/checks the tree the caller actually pointed at.
  const base = path.resolve(ctx.cwd ?? process.cwd(), parsed.path ?? '.')
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const entries = await readLocalOnlyEntries({ stateDir })
  const governing = entries.filter((entry) => entry.class === targetClass && isEqualOrDescendant(base, entry.dir))
  if (governing.length === 0) {
    ctx.stdout.write(`not ${targetClass} (no machine-local ${targetClass} entry governs ${base})\n`)
    return 0
  }

  const governingDirs = new Set(governing.map((entry) => entry.dir))
  const remaining = entries.filter((entry) => !governingDirs.has(entry.dir))
  await writeLocalOnlyEntries({ stateDir, entries: remaining })
  getLogger('usage-policy').info('usage_policy.unmark', {
    [Attr.COMPONENT]: 'cmd-unignore',
    [Attr.OPERATION]: 'usage_policy.unmark',
    class: targetClass,
    status: 'ok',
  })
  const removedDirs = governing.map((entry) => entry.dir)
  ctx.stdout.write(
    `removed ${governing.length} ${targetClass} entr${governing.length === 1 ? 'y' : 'ies'}: ${removedDirs.join(', ')}\n`
  )
  return 0
}

/**
 * `hyp ignore --check [path]`
 *
 * Reports whether `path` (default cwd) is currently ignored, the resolved
 * usage class, and which source governs it — a `.hypignore` dotfile, or a
 * machine-local class-per-entry (LLP 0103 #cli: `--check` names the
 * governing source explicitly, not just the file path, so a `--private`/
 * `--local-only`/`--sync` mark and a committed dotfile read distinctly even
 * though both resolve through the same `resolve()` call) — and the residual
 * count of already-cached rows from the scope. This is prospective-only:
 * `--check` never purges; it just surfaces the residue so the rule stays
 * debuggable (LLP 0049 #prospective-only), pointing at `hyp purge` for
 * removing it. For a `local-only`-governed scope, the residual count reads
 * as "recorded locally, withheld from forwarding" rather than "never
 * recorded".
 *
 * @ref LLP 0049#prospective-only [implements]: `--check` reports the residual already-cached row count; it never deletes
 * @ref LLP 0103#cli [implements]: `--check` names which source governs (dotfile vs machine-local entry) and the entry's class
 * @param {{ json: boolean, path?: string }} parsed
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runIgnoreCheck(parsed, ctx) {
  // Resolve a relative `path` arg against the command-context cwd (matching the
  // sibling verbs above), not the Node process cwd, so injected/remote/test
  // dispatch writes/removes/checks the tree the caller actually pointed at.
  const base = path.resolve(ctx.cwd ?? process.cwd(), parsed.path ?? '.')
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const listPath = localOnlyListPath(stateDir)
  const result = createUsagePolicyResolver({ localOnlyListPath: listPath }).resolve(base)
  const ignored = result.class === 'ignore'
  const governed = result.class !== 'full'
  const scopeDir = governed ? await resolveCheckScopeDir({ result, base, stateDir, listPath }) : base
  const residual = governed ? await countResidualCachedRows(scopeDir, ctx) : 0
  // LLP 0103: name the governing source distinctly from the raw path, so a
  // machine-local mark and a committed dotfile read differently even though
  // both resolve through the same `resolve()` call.
  const source = !result.governedBy ? 'none' : result.governedBy === listPath ? 'machine-local' : 'dotfile'
  const purgeHint = residual ? ` (use 'hyp purge' to remove them)` : ''

  if (parsed.json) {
    ctx.stdout.write(
      JSON.stringify({
        path: base,
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

  ctx.stdout.write(`path: ${base}\n`)
  ctx.stdout.write(`ignored: ${ignored ? 'yes' : 'no'}\n`)
  ctx.stdout.write(`class: ${result.class}\n`)
  ctx.stdout.write(`source: ${source}\n`)
  ctx.stdout.write(`governed-by: ${result.governedBy ?? '(none)'}\n`)
  ctx.stdout.write(`residual-cached-rows: ${residual === null ? 'unknown' : residual}${purgeHint}\n`)
  return 0
}

/**
 * Resolve the directory whose residual cached rows `hyp ignore --check`
 * should count: the directory containing the governing `.hypignore` when
 * governed by a dotfile (unchanged from before the machine-local list
 * existed), or — when governed by the machine-local store
 * (`result.governedBy === listPath`) — the most specific (longest) entry
 * that actually matches `base`, found via the shared
 * {@link isEqualOrDescendant} predicate rather than a second copy of path
 * logic (R8). The `resolve()` call already decided *whether* something
 * governs; this only identifies *which* listed directory did, for display
 * and scoping the residual count.
 *
 * @param {{ result: ResolveResult, base: string, stateDir: string, listPath: string }} args
 * @returns {Promise<string>}
 */
async function resolveCheckScopeDir({ result, base, stateDir, listPath }) {
  if (!result.governedBy) return base
  if (result.governedBy !== listPath) return path.dirname(result.governedBy)
  const entries = await readLocalOnlyEntries({ stateDir })
  const matches = entries.filter((entry) => isEqualOrDescendant(base, entry.dir))
  if (matches.length === 0) return base
  return matches.reduce((best, entry) => (entry.dir.length > best.dir.length ? entry : best)).dir
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
 * `hyp skills install [--client <name>]`
 *
 * Walks the kernel skill registry and materializes each contribution
 * into the right per-client skill directory. The skill source tree
 * (a directory with `SKILL.md`) is copied recursively; existing
 * installations are replaced (idempotent).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runSkillsInstall(argv, ctx) {
  const parsed = parseSkillsArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }

  const skills = ctx.skills.list()
  if (skills.length === 0) {
    ctx.stdout.write('(no skills registered)\n')
    return 0
  }

  const homeDir = ctx.env.HOME ?? process.env.HOME ?? ''
  if (!homeDir) {
    ctx.stderr.write('error: HOME is not set; cannot resolve skill install paths\n')
    return 1
  }

  const descriptorMap = await buildClientDescriptorMap(ctx)

  let count = 0
  for (const skill of skills) {
    for (const targetClient of skill.clients) {
      if (parsed.client !== 'all' && parsed.client !== targetClient) continue
      const skillDir = descriptorMap.get(targetClient)?.skillDir
      if (!skillDir) {
        ctx.stderr.write(`warning: skill '${skill.name}' targets unknown client '${targetClient}'\n`)
        continue
      }
      const baseDir = path.join(homeDir, skillDir)
      const dest = path.join(baseDir, skill.name)
      // Defense in depth: registration rejects traversal names, but the
      // skill dir comes from a plugin manifest, so re-check containment.
      if (!isWithinDir(dest, baseDir)) {
        ctx.stderr.write(`warning: skill '${skill.name}' for ${targetClient} resolves outside ${baseDir}; skipped\n`)
        continue
      }
      try {
        await fs.rm(dest, { recursive: true, force: true })
        await copyDir(skill.sourceDir, dest)
        ctx.stdout.write(`installed skill '${skill.name}' → ${dest}\n`)
        count += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.stderr.write(`warning: skill '${skill.name}' for ${targetClient} failed: ${message}\n`)
      }
    }
  }
  ctx.stdout.write(`installed ${count} skill copy(ies)\n`)
  return 0
}

/**
 * `hyp agents install [--client <name>]`
 *
 * Mirrors `hyp skills install` for subagent contributions. Each agent
 * is a single markdown definition file materialized flat into the
 * per-client agent directory as `<agent_dir>/<name>.md`; existing
 * installations are replaced (idempotent). Clients without an
 * `agent_dir` in their manifest are skipped with a warning.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runAgentsInstall(argv, ctx) {
  const parsed = parseSkillsArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }

  const agents = ctx.agents.list()
  if (agents.length === 0) {
    ctx.stdout.write('(no agents registered)\n')
    return 0
  }

  const homeDir = ctx.env.HOME ?? process.env.HOME ?? ''
  if (!homeDir) {
    ctx.stderr.write('error: HOME is not set; cannot resolve agent install paths\n')
    return 1
  }

  const descriptorMap = await buildClientDescriptorMap(ctx)

  let count = 0
  for (const agent of agents) {
    for (const targetClient of agent.clients) {
      if (parsed.client !== 'all' && parsed.client !== targetClient) continue
      const agentDir = descriptorMap.get(targetClient)?.agentDir
      if (!agentDir) {
        ctx.stderr.write(`warning: agent '${agent.name}' targets client '${targetClient}' without an agent directory\n`)
        continue
      }
      const baseDir = path.join(homeDir, agentDir)
      const dest = path.join(baseDir, `${agent.name}.md`)
      // Defense in depth: registration rejects traversal names, but the
      // agent dir comes from a plugin manifest, so re-check containment.
      if (!isWithinDir(dest, baseDir)) {
        ctx.stderr.write(`warning: agent '${agent.name}' for ${targetClient} resolves outside ${baseDir}; skipped\n`)
        continue
      }
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.copyFile(agent.sourceFile, dest)
        ctx.stdout.write(`installed agent '${agent.name}' → ${dest}\n`)
        count += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.stderr.write(`warning: agent '${agent.name}' for ${targetClient} failed: ${message}\n`)
      }
    }
  }
  ctx.stdout.write(`installed ${count} agent copy(ies)\n`)
  return 0
}

/**
 * Build a map from client name to client descriptor by reading plugin
 * manifests. This avoids hardcoding `.claude/skills` / `.codex/skills`
 * / `.claude/agents` in core.
 *
 * Built from the same **bundled + installed** catalog that `boot.js` and
 * `status.js` use, so an installed (non-bundled) client adapter that can
 * attach-on-join is also resolvable here — its `hyp detach` / skill / agent
 * install must not silently miss the descriptor.
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<Map<string, ClientDescriptor>>}
 */
export async function buildClientDescriptorMap(ctx) {
  /** @type {Map<string, ClientDescriptor>} */
  const map = new Map()
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
    const catalog = buildPluginCatalog(bundledLoaded, installedLoaded)
    for (const [clientName, descriptor] of catalog.clientDescriptors) {
      map.set(clientName, descriptor)
    }
  } catch { /* catalog build failure → empty map → warnings per contribution */ }
  return map
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

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
import { configuredGatewayEndpoint } from '../config/gateway_endpoint.js'
import { resolveClientSettingsPath } from '../daemon/client_settings_path.js'
import { probeClientAttachFromDescriptor } from '../daemon/status.js'
import { createUsagePolicyResolver, findRepoRoot } from '../usage-policy/index.js'
import { executeQuerySql } from '../query/sql.js'
import { pluginStateDir } from './plugin.js'

/**
 * @import { AiGatewayCapability, CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ClientDescriptor, LoadedManifest } from '../../../src/core/types.js'
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
          const configured = configuredGatewayEndpoint(ctx.config)
          if (!configured) {
            // No gateway bound in this process and no configured `listen`
            // to fall back on: the daemon-managed case (an unpinned
            // gateway binds an ephemeral port only the daemon knows, and
            // its reconciler performs attach itself). Report the on-disk
            // attach state instead of the internal endpoint error.
            // @ref LLP 0045#part-1--the-client-seam-in-the-reconcile-context: manual attach without a configured listen defers to the daemon; probe disk, don't guess a port
            descriptorMap ??= await buildClientDescriptorMap(ctx)
            const descriptor = descriptorMap.get(name)
            const homeDir = ctx.env.HOME ?? os.homedir()
            const probe = descriptor
              ? await probeClientAttachFromDescriptor({ descriptor, homeDir, env: ctx.env })
              : { attached: false, settingsPath: undefined }
            if (probe.attached) {
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
          endpoint = configured
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

/**
 * Parse `hyp ignore` / `hyp unignore` argv: an optional positional path and
 * the `--check` / `--json` flags (`--check` is meaningful for `ignore` only).
 *
 * @param {string[]} argv
 * @returns {{ check: boolean, json: boolean, path?: string, error?: string }}
 */
function parseIgnoreArgs(argv) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      path: { type: 'string' },
      check: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    positional: ['path'],
  })
  if ('help' in parsed) return { check: false, json: false, error: 'usage: hyp ignore [path] [--check] [--json]' }
  if (!parsed.ok) return { check: false, json: false, error: parsed.error }
  const p = /** @type {{ path?: string, check: boolean, json: boolean }} */ (parsed.params)
  return { check: p.check, json: p.json, path: p.path }
}

/**
 * `hyp ignore [path] [--check]`
 *
 * Without `--check`, writes a self-documenting `.hypignore` (comment header +
 * `ignore` token) so HypAware stops recording the folder subtree. The file
 * lands at the git **repo root** when the target is inside a repo, else at the
 * target directory; an explicit `path` overrides the default (cwd) target. The
 * write is idempotent (LLP 0049 R5): a path already governed by an ancestor
 * `.hypignore` is left as-is. With `--check`, reports status without writing.
 *
 * @ref LLP 0049#cli [implements]: the `hyp ignore` verb: write the dotfile at the repo root, idempotent, with a prospective-only `--check`
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
 * `hyp unignore [path]`
 *
 * Removes the nearest governing `.hypignore`, re-enabling recording for the
 * subtree. Idempotent (LLP 0049 R5): unignoring a path that no `.hypignore`
 * governs succeeds as a no-op.
 *
 * @ref LLP 0049#cli [implements]: the `hyp unignore` verb: remove the governing dotfile, idempotent
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
 * `hyp ignore --check [path]`
 *
 * Reports whether `path` (default cwd) is currently ignored, which
 * `.hypignore` governs, and the residual count of already-cached rows from the
 * scope. This is prospective-only: `--check` never purges; it just surfaces
 * the residue so the rule stays debuggable (LLP 0049 #prospective-only).
 *
 * @ref LLP 0049#prospective-only [implements]: `--check` reports the residual already-cached row count; it never deletes
 * @param {{ json: boolean, path?: string }} parsed
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runIgnoreCheck(parsed, ctx) {
  // Resolve a relative `path` arg against the command-context cwd (matching the
  // sibling verbs above), not the Node process cwd, so injected/remote/test
  // dispatch writes/removes/checks the tree the caller actually pointed at.
  const base = path.resolve(ctx.cwd ?? process.cwd(), parsed.path ?? '.')
  const result = createUsagePolicyResolver().resolve(base)
  const ignored = result.class === 'ignore'
  const scopeDir = result.governedBy ? path.dirname(result.governedBy) : base
  const residual = ignored ? await countResidualCachedRows(scopeDir, ctx) : 0

  if (parsed.json) {
    ctx.stdout.write(
      JSON.stringify({
        path: base,
        ignored,
        governedBy: result.governedBy,
        class: result.class,
        declared: result.declared,
        residualCachedRows: residual,
      }) + '\n'
    )
    return 0
  }

  ctx.stdout.write(`path: ${base}\n`)
  ctx.stdout.write(`ignored: ${ignored ? 'yes' : 'no'}\n`)
  ctx.stdout.write(`governed-by: ${result.governedBy ?? '(none)'}\n`)
  ctx.stdout.write(`residual-cached-rows: ${residual === null ? 'unknown' : residual}\n`)
  return 0
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
    const out = await executeQuerySql({
      query: sql,
      registry: ctx.query,
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      refresh: 'never',
      config: ctx.config,
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

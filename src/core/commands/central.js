// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { defaultConfigPath } from '../config/schema.js'
import { centralSeedPath, resetCentralLayerToSeed, resolveCentralLayerPath } from '../config/apply.js'
import { validateConfig } from '../config/validate.js'
import { atomicWriteJson } from '../util/fs_atomic.js'
import { clearClientActionMarker, readClientActionStatus } from '../config/action_reconciler.js'
import { readCentralSinkOrigins, seedLoginGateway } from '../remote/gateway_seed.js'
import { buildClientDescriptorMap, detachClientViaCore } from './clients.js'
import { runDaemonInstall } from './daemon.js'
import { buildKnownPluginsForCtx } from './plugin.js'
import { isTty, readAllStdin } from '../cli/stdio.js'

/**
 * @import { CommandRunContext, HypAwareV2Config } from '../../../collectivus-plugin-kernel-types.js'
 * @import { LoginGatewayCredential } from '../../../src/core/remote/types.js'
 */

/**
 * `hyp join <url> [token]`: join a centrally-managed fleet. Pure
 * sugar over two existing steps: write the seed config (an ordinary v2
 * config containing exactly the central plugin) and run the
 * non-interactive daemon install. Doing those two steps by hand is
 * specified to be exactly equivalent.
 *
 * Because a policy token is a multi-use fleet-wide credential, the
 * token can (and for MDM scripts, should) arrive via `--token-file`
 * or stdin instead of argv. A bare argv token lands in shell history
 * and process listings. The seed config is written mode 0600.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0025#seed-config-mode [implements]: join = write-seed-config + daemon install; a wrapper, not a second code path
 */
export async function runJoin(argv, ctx) {
  const parsed = parseJoinArgs(argv)
  if (parsed.help) {
    ctx.stdout.write('usage: hyp join <url> [token] [--token-file <path>] [--bin <path>] [--no-daemon]\n')
    ctx.stdout.write('  token sources (pick one): positional argument, --token-file, or stdin\n')
    return 0
  }
  if (parsed.error) {
    ctx.stderr.write(`hyp join: ${parsed.error}\n`)
    return 2
  }

  try {
    const url = new URL(/** @type {string} */ (parsed.url))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.stderr.write(`hyp join: url must be http(s); got ${url.protocol}\n`)
      return 2
    }
  } catch {
    ctx.stderr.write(`hyp join: not a valid URL: ${parsed.url}\n`)
    return 2
  }

  /** @type {string | undefined} */
  let token = parsed.token
  if (token === undefined && parsed.tokenFile !== undefined) {
    try {
      token = (await fs.readFile(parsed.tokenFile, 'utf8')).trim()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.stderr.write(`hyp join: --token-file: ${message}\n`)
      return 1
    }
  }
  if (token === undefined) {
    if (isTty(ctx.stdin)) {
      ctx.stderr.write('hyp join: no token given - pass it as an argument, via --token-file, or on stdin\n')
      return 2
    }
    token = (await readAllStdin(ctx.stdin)).trim()
  }
  if (token.length === 0) {
    ctx.stderr.write('hyp join: token is empty\n')
    return 2
  }

  /** @type {HypAwareV2Config} */
  const seed = {
    version: 2,
    plugins: [{ name: '@hypaware/central' }],
    sinks: {
      central: {
        plugin: '@hypaware/central',
        config: {
          url: /** @type {string} */ (parsed.url),
          identity: { bootstrap_token: token },
        },
      },
    },
  }

  const catalogCtx = await buildKnownPluginsForCtx(ctx)
  const validation = await validateConfig(seed, {
    knownPlugins: catalogCtx.knownPlugins,
    knownDatasets: catalogCtx.knownDatasets,
  })
  if (!validation.ok) {
    for (const err of validation.errors) {
      ctx.stderr.write(`hyp join: [${err.errorKind}] ${err.pointer || '<root>'}: ${err.message}\n`)
    }
    return 1
  }

  // The seed is the initial *central* layer. It is written to a
  // dedicated central-seed file under `config-control/`, never to
  // `hypaware-config.json`, which is the user-owned local layer. This is
  // the #111 fix: `join` augments a working install instead of
  // destroying it.
  // @ref LLP 0031#physical-layout [implements]: join writes only the central seed, never the local layer
  const obsEnv = readObservabilityEnv(ctx.env)
  const seedPath = centralSeedPath(obsEnv.stateDir)

  return withSpan(
    'join.run',
    {
      [Attr.COMPONENT]: 'join',
      [Attr.OPERATION]: 'join.run',
      config_path: seedPath,
      install_daemon: !parsed.noDaemon,
      status: 'ok',
    },
    async (span) => {
      // The token is the only credential on disk until the first
      // bootstrap, so the seed write is atomic and mode 0600.
      await atomicWriteJson(seedPath, seed, { mode: 0o600 })
      ctx.stdout.write(`✓ Wrote seed config ${seedPath}\n`)

      // A re-enrollment (identity broke, operator re-runs `join`) writes a
      // fresh bootstrap token into the seed, but a prior enrollment may
      // have left a stale active config slot that boot resolution prefers
      // over the seed, silently shadowing the new token, so identity
      // bootstrap keeps failing with no explanation (#139). Reset to
      // seed-config mode so the freshly written token is honored; on a
      // first join (no slot) this is a no-op.
      // @ref LLP 0031#physical-layout [implements]: join supersedes a stale active slot so the fresh seed wins
      const reset = resetCentralLayerToSeed(obsEnv.stateDir)
      span.setAttribute('superseded_active_slot', reset.supersededActiveSlot)
      if (reset.supersededActiveSlot) {
        ctx.stdout.write('  superseded a stale applied config so the new join token takes effect\n')
      }

      if (parsed.noDaemon) {
        ctx.stdout.write('  daemon install skipped (--no-daemon); run `hyp daemon install` to finish joining\n')
        return 0
      }

      const installArgv = parsed.binPath !== undefined ? ['--bin', parsed.binPath] : []
      const code = await runDaemonInstall(installArgv, ctx)
      if (code !== 0) {
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'daemon_install_failed')
        return code
      }
      ctx.stdout.write('✓ Joined - the daemon will pull its configuration from the server\n')
      return 0
    },
    { component: 'join' }
  )
}

/**
 * Enroll this machine from an attended `hyp remote login` (LLP 0063 D2/D5):
 * provision the `@hypaware/central` forward sink and finish exactly the way
 * `runJoin` finishes. This is join's enrollment minus the bootstrap token —
 * the login-minted gateway credential (LLP 0061), seeded here into the fresh
 * sink's `identity.json`, is the identity, so the written block carries no
 * `identity.bootstrap_token`. Written to the same central-seed layer join uses
 * (LLP 0031): this is server-authored config (server-minted credential,
 * server-owned org), not something the human typed, so provenance — not who
 * ran the command — picks the layer.
 *
 * @param {{ ctx: CommandRunContext, url: string, gateway: LoginGatewayCredential, noDaemon: boolean }} args
 * @returns {Promise<{ provisioned: boolean, connectedElsewhere?: string, daemonCode: number }>}
 * @ref LLP 0063#d2 [implements]: provision join's exact sink block (minus the bootstrap token) into the central-seed layer, then seed the login-minted identity into it
 * @ref LLP 0063#d5 [implements]: an enrolling login finishes with join's daemon install (join parity); --no-daemon prints the finish-by-hand command
 */
export async function enrollCentralSink({ ctx, url, gateway, noDaemon }) {
  const obsEnv = readObservabilityEnv(ctx.env)
  const stateRoot = obsEnv.stateDir
  const localPath = ctx.env.HYP_CONFIG ? path.resolve(ctx.env.HYP_CONFIG) : defaultConfigPath(obsEnv.hypHome)
  const targetOrigin = safeOrigin(url)

  // D4 re-check just before the write: if a central sink targeting a different
  // origin appeared since login's pre-auth gate (a concurrent first login to
  // another server), abort rather than provision a second enrollment. This is
  // the non-locked flavor of D4's seed-time check — it closes the common race;
  // the cross-process credentials lock (LLP 0065) is a follow-up.
  const connectedOrigins = await readCentralSinkOrigins({ stateDir: stateRoot, configPath: localPath })
  const elsewhere = connectedOrigins.find((o) => o !== targetOrigin)
  if (elsewhere) return { provisioned: false, connectedElsewhere: elsewhere, daemonCode: 0 }

  // Only actually write the seed when no same-origin central sink exists yet
  // (a same-origin sink present means a racing same-server login already
  // provisioned it; fall through to identity-seeding it, which is idempotent).
  if (targetOrigin === null || !connectedOrigins.includes(targetOrigin)) {
    // `identity: {}` (not absent): the central plugin's own validator requires
    // an identity object (`central.identity is required`), but bootstrap_token
    // is optional — the login-minted gateway seeded into identity.json is the
    // credential (LLP 0063 D2), so the block carries an empty identity, not a
    // token.
    /** @type {HypAwareV2Config} */
    const seed = {
      version: 2,
      plugins: [{ name: '@hypaware/central' }],
      sinks: { central: { plugin: '@hypaware/central', config: { url, identity: {} } } },
    }
    const seedPath = centralSeedPath(stateRoot)
    await atomicWriteJson(seedPath, seed, { mode: 0o600 })
    // Inherit join's #139 fix: supersede a stale applied slot so the fresh
    // enrollment is honored rather than silently shadowed.
    resetCentralLayerToSeed(stateRoot)
  }

  // Seed the login-minted gateway into the freshly written sink's identity
  // (LLP 0061). `seedLoginGateway` resolves sinks from the effective config,
  // which now includes this central seed, so it finds and seeds exactly it.
  //
  // The seed config is on disk but its credential is not, so a failure here
  // (throw, or nothing seeded) would leave a committed sink with no
  // identity.json — the daemon would then demand a `hyp join` bootstrap token
  // the login user does not have. Roll the seed back so the machine is cleanly
  // unenrolled rather than half-enrolled and broken.
  let seeded
  try {
    seeded = await seedLoginGateway({ stateDir: stateRoot, configPath: localPath, targetUrl: url, gateway })
  } catch (err) {
    await rollbackCentralSeed(stateRoot)
    throw err
  }
  if (seeded.length === 0) {
    await rollbackCentralSeed(stateRoot)
    throw new Error('provisioned the central sink but could not seed its forwarding identity')
  }

  if (noDaemon) return { provisioned: true, daemonCode: 0 }
  const daemonCode = await runDaemonInstall([], ctx)
  return { provisioned: true, daemonCode }
}

/**
 * A URL's origin, or `null` when unparseable (mirrors `gateway_seed`'s helper;
 * an unparseable url simply matches nothing).
 *
 * @param {string} url
 * @returns {string | null}
 */
function safeOrigin(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Undo a just-written central seed (best-effort): remove the seed file and
 * clear any applied slot, returning the machine to "no central layer". Used to
 * roll `enrollCentralSink` back when identity-seeding fails after the seed was
 * committed, so a partial enrollment never lingers on disk.
 *
 * @param {string} stateRoot
 */
async function rollbackCentralSeed(stateRoot) {
  await fs.rm(centralSeedPath(stateRoot), { force: true })
  resetCentralLayerToSeed(stateRoot)
}

/**
 * @param {string[]} argv
 * @returns {{ help?: boolean, error?: string, url?: string, token?: string, tokenFile?: string, binPath?: string, noDaemon?: boolean }}
 */
function parseJoinArgs(argv) {
  /** @type {{ help?: boolean, error?: string, url?: string, token?: string, tokenFile?: string, binPath?: string, noDaemon?: boolean }} */
  const r = {}
  /** @type {string[]} */
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--help' || token === '-h') { r.help = true; return r }
    if (token === '--no-daemon') { r.noDaemon = true; continue }
    if (token === '--token-file' || token.startsWith('--token-file=')) {
      const value = token === '--token-file' ? argv[++i] : token.slice('--token-file='.length)
      if (!value) return { error: '--token-file: requires a path' }
      r.tokenFile = value
      continue
    }
    if (token === '--bin' || token.startsWith('--bin=')) {
      const value = token === '--bin' ? argv[++i] : token.slice('--bin='.length)
      if (!value) return { error: '--bin: requires a path' }
      r.binPath = value
      continue
    }
    if (token.startsWith('-') && token !== '-') {
      return { error: `unknown argument: ${token}` }
    }
    positional.push(token)
  }
  if (positional.length === 0) return { error: 'missing <url> (see hyp join --help)' }
  if (positional.length > 2) return { error: `unexpected argument: ${positional[2]}` }
  r.url = positional[0]
  // '-' as the token positional means "read from stdin", same as
  // omitting it on a piped invocation.
  if (positional.length === 2 && positional[1] !== '-') r.token = positional[1]
  if (r.token !== undefined && r.tokenFile !== undefined) {
    return { error: 'pass the token either as an argument or via --token-file, not both' }
  }
  return r
}

/**
 * `hyp leave`: disconnect this machine from its central server — the
 * level-3 exit verb, the single inverse of both enrollment paths
 * (`hyp join` and an enrolling `hyp remote login`). Reverses what
 * enrollment did to the machine, in dependency order:
 *
 *   1. remove the central config layer — the join/login seed and any
 *      applied central slots (the inverse of join's seed write, reusing
 *      the #139 reset machinery);
 *   2. restart the installed daemon service, so the central sink — and
 *      with it the config-pull loop — stops before markers and
 *      credentials are torn down;
 *   3. reverse the centrally-driven client attaches through the single
 *      core disk undo (the LLP 0044 leave contract). Manual attaches
 *      write no marker, so a client the user attached by hand stays
 *      attached;
 *   4. remove the persisted forward identity so no live credential
 *      lingers on disk.
 *
 * Cascades down, never up: it does NOT log the human out (the
 * query-session store is theirs, not the fleet's), does NOT touch the
 * user-owned local config layer, and does NOT uninstall the daemon
 * service — local-only capture keeps working. Teardown is local-only:
 * the server-side gateway row is not revoked (the credential expires;
 * revocation is the operator's server-side act).
 *
 * Every step is best-effort and idempotent, so a plain re-run redoes
 * whatever did not finish - no resume bookkeeping. "Connected" is central
 * layer present OR an org-attach marker still on disk, so a leave that
 * failed mid-reversal still has work on re-run instead of short-circuiting
 * to "not connected". An org attach whose plugin is gone can't be reversed;
 * leave drops its marker (a stale `done` marker would block the next join's
 * re-attach, #217) and tells the user how to revert by hand.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @ref LLP 0063#prerequisites [implements]: minimal hyp leave (central-layer removal, attach reversal via the one core undo, identity drop); never touches sessions, the local layer, or the service; best-effort and idempotent so a re-run finishes a partial teardown
 * @ref LLP 0063#connection-levels [constrained-by]: leave cascades down (level 3 → org-driven level-1 attaches), never up to the session store or the daemon service
 */
export async function runLeave(argv, ctx) {
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      ctx.stdout.write('usage: hyp leave\n')
      ctx.stdout.write('  disconnect this machine from its central server: stop forwarding and\n')
      ctx.stdout.write('  config pull, undo org-driven client attaches, and remove the forward\n')
      ctx.stdout.write('  credential. Keeps query sessions, the local config, and the daemon service.\n')
      return 0
    }
    ctx.stderr.write(`hyp leave: unknown argument: ${arg}\n`)
    return 2
  }

  const obsEnv = readObservabilityEnv(ctx.env)
  const stateRoot = obsEnv.stateDir
  const localPath = ctx.env.HYP_CONFIG
    ? path.resolve(ctx.env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)
  const centralLayerPath = resolveCentralLayerPath({ stateRoot })
  const attachMarkers = readClientActionStatus({ stateRoot }).byKind.attach ?? {}
  const attachedNames = Object.keys(attachMarkers)

  // Nothing to tear down: no central layer AND no org-attach residue. A leave
  // that failed partway leaves its attach markers on disk, so a re-run still
  // lands here with work to do and finishes it - the marker is its own
  // "unfinished teardown" signal, no separate bookkeeping needed.
  if (centralLayerPath === null && attachedNames.length === 0) {
    ctx.stdout.write('hyp leave: this machine is not connected to a central server - nothing to do\n')
    // A hand-authored central sink in the LOCAL layer is not an enrollment,
    // and leave never edits the local layer (#111 doctrine) — but a user
    // running `leave` to stop forwarding deserves to know where it lives.
    writeLocalCentralSinkNote(ctx, await readCentralSinks(localPath, stateRoot), localPath)
    return 0
  }

  const centralSinks = centralLayerPath !== null ? await readCentralSinks(centralLayerPath, stateRoot) : []
  const urls = [...new Set(centralSinks.map((s) => s.url).filter((u) => u.length > 0))]

  return withSpan(
    'leave.run',
    {
      [Attr.COMPONENT]: 'leave',
      [Attr.OPERATION]: 'leave.run',
      central_urls: urls.join(','),
      status: 'ok',
    },
    async (span) => {
      let failures = 0
      ctx.stdout.write(`leaving ${urls.length > 0 ? urls.join(', ') : 'the central server'}\n`)

      // Every step below is best-effort and idempotent (force-rm, ENOENT-tolerant
      // unlink, idempotent detach), so a plain re-run of `hyp leave` redoes
      // whatever did not finish. There is no resume state to keep.

      // 1. Central layer teardown: drop the seed, then clear the applied
      // slots / pointer / apply state. With both gone the machine has no
      // central layer at all — the exact inverse of join's write.
      await fs.rm(centralSeedPath(stateRoot), { force: true })
      resetCentralLayerToSeed(stateRoot)
      ctx.stdout.write('✓ removed the central config layer\n')

      // 2. Restart the service so the running daemon reboots without the
      // central sink: forwarding and the config-pull loop stop here. Restart,
      // never uninstall — local-only capture keeps working.
      const { restartServiceDaemon, serviceDaemonStatus } = await import('../daemon/install.js')
      const svc = await serviceDaemonStatus({ homeDir: ctx.env.HOME })
      if (svc.installed) {
        try {
          await restartServiceDaemon({ homeDir: ctx.env.HOME })
          // Close the small race in which the old daemon's pull loop applied
          // a config slot between step 1 and the restart.
          await fs.rm(centralSeedPath(stateRoot), { force: true })
          resetCentralLayerToSeed(stateRoot)
          ctx.stdout.write('✓ restarted the daemon - forwarding and config pull are stopped\n')
        } catch (err) {
          failures += 1
          const message = err instanceof Error ? err.message : String(err)
          ctx.stderr.write(`hyp leave: daemon restart failed: ${message}\n`)
          ctx.stderr.write("  run 'hyp daemon restart' to stop the central sink\n")
        }
      } else {
        ctx.stdout.write('  no daemon service installed - nothing to restart\n')
      }

      // 3. Reverse the org-driven attaches. Only reconciler-applied attaches
      // carry a marker, so this touches exactly what the fleet touched; the
      // undo is the same core disk reversal `hyp detach` uses. Backfill
      // markers are run-once by design and stay (imported data stays too).
      if (attachedNames.length > 0) {
        const descriptors = await buildClientDescriptorMap(ctx)
        for (const name of attachedNames) {
          const marker = attachMarkers[name]
          if (!marker || marker.status === 'failed') {
            // A failed marker never applied an effect; just drop it,
            // mirroring the reconciler's own reverse pass.
            try {
              clearClientActionMarker({ stateRoot, kind: 'attach', requestKey: name })
            } catch { /* best-effort: a stale failed marker is a status blemish */ }
            continue
          }
          const descriptor = descriptors.get(name)
          if (!descriptor) {
            // Plugin's gone, so we cannot replay its undo - do the best we can:
            // drop the marker so a future join re-attaches cleanly instead of
            // short-circuiting on a stale `done` marker (#217). The local
            // gateway keeps running, so the client's settings still route
            // locally; nothing is broken.
            try {
              clearClientActionMarker({ stateRoot, kind: 'attach', requestKey: name })
            } catch { /* best-effort: a stale marker is a status blemish */ }
            ctx.stdout.write(`  '${name}' plugin not installed - dropped its attach marker (settings left as-is; reinstall + 'hyp detach ${name}' to revert)\n`)
            continue
          }
          try {
            await detachClientViaCore({ name, descriptor, dryRun: false, json: false, ctx })
          } catch (err) {
            failures += 1
            const message = err instanceof Error ? err.message : String(err)
            ctx.stderr.write(`hyp leave: detach '${name}' failed: ${message}\n`)
            ctx.stderr.write(`  run 'hyp detach ${name}' to finish reversing it\n`)
          }
        }
      }

      // 4. Drop the persisted forward identity (the login/bootstrap-minted
      // gateway credential). Paths resolve from the sink blocks the same way
      // seedLoginGateway resolves them, defaulting to the per-plugin state
      // path; with no readable sink block the default path still gets swept.
      const identityPaths = new Set(centralSinks.map((s) => s.persistedPath))
      if (identityPaths.size === 0) {
        identityPaths.add(path.join(stateRoot, 'plugins', '@hypaware/central', 'identity.json'))
      }
      let removedIdentity = false
      for (const identityPath of identityPaths) {
        try {
          await fs.unlink(identityPath)
          removedIdentity = true
        } catch (err) {
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
            failures += 1
            const message = err instanceof Error ? err.message : String(err)
            ctx.stderr.write(`hyp leave: could not remove forward identity ${identityPath}: ${message}\n`)
          }
        }
      }
      if (removedIdentity) {
        ctx.stdout.write('✓ removed the forward identity\n')
      }

      // Always surface a still-forwarding local sink, success or not: a machine
      // that keeps forwarding must never be left silent.
      writeLocalCentralSinkNote(ctx, await readCentralSinks(localPath, stateRoot), localPath)

      if (failures > 0) {
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', 'leave_partial')
        ctx.stderr.write(`hyp leave: ${failures} step(s) could not finish (see above); the per-step command above, or a plain re-run of 'hyp leave', will pick up the rest\n`)
        return 1
      }

      ctx.stdout.write(`✓ left${urls.length > 0 ? ` ${urls.join(', ')}` : ''} - this machine no longer forwards logs or pulls org config\n`)
      ctx.stdout.write('  kept: query sessions, your local config, and the daemon service (local-only capture keeps working)\n')
      return 0
    },
    { component: 'leave' }
  )
}

/**
 * Read a config layer file and list its `@hypaware/central` sink blocks:
 * instance name, target url, and the resolved forward-identity path (the
 * sink's `identity.persisted_path`, defaulting to the per-plugin state
 * path — the same resolution `seedLoginGateway` uses). Lenient: a missing
 * or malformed file is simply no sinks, because `leave` tears down
 * best-effort and must not wedge on a corrupt layer.
 *
 * @param {string} configFilePath
 * @param {string} stateRoot
 * @returns {Promise<Array<{ name: string, url: string, persistedPath: string }>>}
 */
async function readCentralSinks(configFilePath, stateRoot) {
  /** @type {Record<string, any>} */
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(configFilePath, 'utf8'))
  } catch {
    return []
  }
  const sinks = parsed && typeof parsed === 'object' ? parsed.sinks : undefined
  if (!sinks || typeof sinks !== 'object') return []
  /** @type {Array<{ name: string, url: string, persistedPath: string }>} */
  const out = []
  for (const [name, entry] of Object.entries(sinks)) {
    if (!entry || /** @type {any} */ (entry).plugin !== '@hypaware/central') continue
    const config = /** @type {Record<string, any>} */ (/** @type {any} */ (entry).config ?? {})
    const url = typeof config.url === 'string' ? config.url : ''
    const persistedPath = typeof config.identity?.persisted_path === 'string'
      ? config.identity.persisted_path
      : path.join(stateRoot, 'plugins', '@hypaware/central', 'identity.json')
    out.push({ name, url, persistedPath })
  }
  return out
}

/**
 * Tell a leaving user about central sinks in the user-owned LOCAL layer,
 * which `hyp leave` deliberately never edits: without this note, a machine
 * with a hand-authored sink would keep forwarding after a "successful"
 * leave with no explanation.
 *
 * @param {CommandRunContext} ctx
 * @param {Array<{ name: string, url: string }>} sinks
 * @param {string} localPath
 */
function writeLocalCentralSinkNote(ctx, sinks, localPath) {
  for (const sink of sinks) {
    ctx.stdout.write(
      `note: your local config defines a '@hypaware/central' sink ('${sink.name}')${sink.url ? ` targeting ${sink.url}` : ''}\n`
    )
    ctx.stdout.write(`  'hyp leave' never edits the local layer; remove it from ${localPath} to stop forwarding\n`)
  }
}

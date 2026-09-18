// @ts-check

import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

import { askYesNo } from '../cli/confirm.js'
import { parseCommandArgv, STRICT_SHORT_FLAGS } from '../cli/verb_codec.js'
import { isTty } from '../cli/stdio.js'
import { Attr, getLogger, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { purgeCache } from '../cache/purge.js'
import { createSessionPurgeStore } from '../cache/session-purges.js'
import { effectiveRemotes } from '../remote/builtin_remotes.js'
import { attachWithRefresh, deriveIdentityBase, deriveMcpEndpoint, readCredentials, remoteTokenEnvVar, resolveAccessJwt } from '../remote/credentials.js'
import { captureSpoolRoot, sweepCaptureSpool } from '../capture_spool.js'
import { createUsagePolicyResolver, localOnlyListPath } from '../usage-policy/index.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { PurgeSummary, PurgeTarget } from '../../../src/core/cache/types.js'
 * @import { UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 */

/**
 * `hyp purge <path> | --session <id> | --ignored | --all [--yes] [--json]`
 *
 * The destructive verb (LLP 0104): delete already-cached rows from this
 * machine's local query cache. Session targets include configured remotes
 * by default under LLP 0417. Exactly one target is required;
 * bare `hyp purge` errors (no implicit scope for a destructive verb). The
 * marking verbs (`hyp ignore` in any form) stay non-destructive; purge is the
 * separate capability the skill composes after marking (LLP 0104 boundary,
 * LLP 0100 R7).
 *
 * Deletion preserves surviving rows' `part_id` identity and every sink's
 * export watermark (see {@link purgeCache} / `deleteMatchingRows`), so a
 * purge-then-re-record is idempotent server-side and never resurrects rows via
 * a stale watermark.
 *
 * "Cache-only" describes where it reaches, not that rows are the only thing it
 * removes: it also empties the raw-body capture spool, which is a transit area
 * holding bodies no row has been made from yet (LLP 0253).
 *
 * @ref LLP 0104 [implements]: targeted confirmed deletion, with non-destructive marking left intact
 * @ref LLP 0417#operation [implements]: session purges include configured servers unless explicitly narrowed
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runPurge(argv, ctx) {
  const parsed = parseArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }

  const { hypHome, stateDir } = readObservabilityEnv(ctx.env)
  const resolver = createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(stateDir) })
  const target = buildTarget(parsed, ctx, resolver)
  let remotes
  try {
    remotes = await purgeRemotes(ctx, parsed, stateDir)
  } catch (error) {
    ctx.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  // Destructive verb: confirm on an interactive TTY, require --yes otherwise.
  if (!parsed.yes) {
    if (!isTty(ctx.stdin)) {
      ctx.stderr.write(
        'error: refusing to purge without confirmation - pass --yes to delete cached rows non-interactively\n'
      )
      return 2
    }
    const ok = await askYesNo(
      ctx,
      `Delete ${describeTarget(target)} from the local cache${remotes.size ? ` and remotes ${[...remotes.keys()].join(', ')}` : ''}? [y/N] `
    )
    if (!ok) {
      ctx.stdout.write('purge cancelled\n')
      return 0
    }
  }

  /** @type {PurgeSummary} */
  let summary = { rowsDeleted: 0, partitionsAffected: 0, purgedCwds: [], retainedAliasRows: 0, retainedAliasCwds: [] }
  let localError
  try {
    if (target.kind === 'session') {
      // @ref LLP 0417#operation [implements]: fence first, then drain waiting
      // rows through the fence before deleting committed rows.
      createSessionPurgeStore(ctx.storage.cacheRoot).add(target.id)
      const storage = /** @type {ExtendedQueryStorageService} */ (ctx.storage)
      if (storage.flushAll) await storage.flushAll({ reason: 'session_purge', force: true })
    }
    summary = await withSpan(
      'purge.run',
      {
        [Attr.COMPONENT]: 'cmd-purge',
        [Attr.OPERATION]: 'purge.run',
        target_kind: target.kind,
        // Hashed, never raw: dev telemetry must not carry a local path or a
        // session id (LLP 0080 #telemetry).
        target_hash: hashTargetToken(target),
        status: 'ok',
      },
      () => purgeCache({ cacheRoot: ctx.storage.cacheRoot, target }),
      { component: 'cache' }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    localError = message
    ctx.stderr.write(`error: purge failed: ${message}\n`)
    if (!remotes.size) return 1
  }

  // The capture spool, emptied whatever the target was. The files in it are
  // raw request and response bodies that have not been projected yet, so
  // leaving them would let the next batch write rows the user just deleted -
  // and a targeted purge cannot tell which of them belong to its target,
  // because a spooled body carries no cwd. They are transient by design and
  // recoverable from the client's own transcript, so emptying them costs
  // detail at worst.
  // @ref LLP 0253#purge-and-detach-sweep [implements]: `hyp purge` removes the
  //   spool directory's contents
  const swept = await sweepCaptureSpool(captureSpoolRoot(hypHome))
  /** @type {Map<string, { status?: string, session_id?: string, error?: string, physical_cleanup?: { status?: string } }>} */
  const remoteResults = new Map()
  let remoteError = false
  if (target.kind === 'session') {
    const registry = effectiveRemotes(ctx.config)
    for (const [name, url] of remotes) {
      try {
        if (!Object.hasOwn(registry, name)) {
          throw new Error('enrolled server has no named remote; add it with hyp remote add, sign in with hyp remote login, then retry the purge')
        }
        remoteResults.set(name, await purgeRemoteSession({ ctx, target: name, url, sessionId: target.id }))
      } catch (error) {
        remoteError = true
        const message = error instanceof Error ? error.message : String(error)
        remoteResults.set(name, { status: 'incomplete', error: message })
        ctx.stderr.write(`error: remote purge incomplete on '${name}': ${message}\n`)
      }
    }
  }

  getLogger('cache').info('purge.result', {
    [Attr.COMPONENT]: 'cmd-purge',
    [Attr.OPERATION]: 'purge.result',
    target_kind: target.kind,
    rows_deleted: summary.rowsDeleted,
    partitions_affected: summary.partitionsAffected,
    // Counts and bytes only: a spooled body's filename is the client's, and
    // its content is a raw prompt.
    spool_files_removed: swept.filesRemoved,
    spool_bytes_removed: swept.bytesRemoved,
    // A count, never a path. The near-miss decision is otherwise visible only
    // on stderr, so a smoke could assert the user-visible result without any
    // internal signal that the spelling predicate actually ran the branch.
    retained_alias_rows: summary.retainedAliasRows,
    status: localError || remoteError || swept.failed > 0 ? 'incomplete' : 'ok',
  })

  // Resurrection warning (LLP 0104 §resurrection): any purged directory that
  // still resolves `full` will be re-imported by the next backfill. An
  // `ignore`d subtree is durable (the capture seam blocks re-import), so the
  // `--ignored` sweep never warns. A session now has a persistent purge fence;
  // directory and all-row purges still warn from their deleted cwds.
  const resurrectable = (target.kind === 'session' ? [] : summary.purgedCwds)
    .filter((cwd) => resolver.resolve(cwd).class === 'full')
    .sort()

  const retainedAliases = [...summary.retainedAliasCwds].sort()

  if (parsed.json) {
    ctx.stdout.write(JSON.stringify({
      rowsDeleted: localError ? null : summary.rowsDeleted,
      partitionsAffected: localError ? null : summary.partitionsAffected,
      resurrectable,
      retainedAliasRows: summary.retainedAliasRows,
      retainedAliasCwds: retainedAliases,
      spoolFilesRemoved: swept.filesRemoved,
      ...(target.kind === 'session' ? { local: { status: localError ? 'incomplete' : 'completed',
        containment: localError ? 'incomplete' : 'completed', physical_cleanup: { status: summary.cacheCleanup?.length ? 'incomplete' : 'not_implemented' },
        cache_cleanup: (summary.cacheCleanup ?? []).map(job_id => ({ job_id, scope: 'cache_generations', status: 'pending' })),
        retained: ['historical_snapshots', 'original_data_and_metadata_files', 'search_sidecars', 'derived_copies_without_session_lineage', 'native_transcripts_and_backups'],
        ...(localError ? { error: localError } : {}) } } : localError ? { local: { status: 'incomplete', error: localError } } : {}),
      ...(remotes.size ? { remotes: Object.fromEntries(remoteResults) } : {}),
      ...(parsed.remote ? { remote: remoteResults.get(parsed.remote) } : {}),
    }) + '\n')
  } else {
    if (!localError) ctx.stdout.write(
      `purged ${summary.rowsDeleted} row${summary.rowsDeleted === 1 ? '' : 's'} ` +
      `from ${summary.partitionsAffected} partition${summary.partitionsAffected === 1 ? '' : 's'}\n`
    )
    // Reported only when it did something: a machine with no body-writing
    // client attached has an empty (or absent) spool on every purge, and a
    // standing "swept 0 files" line would train the reader to skip the line
    // that matters on the machine where it is not zero.
    if (swept.filesRemoved > 0) {
      ctx.stdout.write(
        `also emptied the capture spool: ${swept.filesRemoved} ` +
        `raw body file${swept.filesRemoved === 1 ? '' : 's'} deleted\n`
      )
    }
    if (summary.cacheCleanup?.length) ctx.stdout.write('cache file cleanup queued for background maintenance after its retirement grace\n')
    for (const [name, result] of remoteResults) {
      if (result.status === 'completed') ctx.stdout.write(`remote session rows position-deleted on '${name}'; physical cleanup: ${result.physical_cleanup?.status ?? 'unverified'}\n`)
    }
    if (target.kind === 'session') ctx.stdout.write('local physical erasure is not implemented; historical files and snapshots remain\n')
    if (target.kind === 'session') ctx.stdout.write('copied content in generated reports and other derivatives is not included\n')
  }

  if (swept.failed > 0) {
    ctx.stderr.write(
      `note: ${swept.failed} item${swept.failed === 1 ? '' : 's'} in the capture spool ` +
      `(${captureSpoolRoot(hypHome)}) could not be removed; delete the directory by hand\n`
    )
  }

  // The near-miss report (LLP 0104 #spellings). Purge reaches a row recorded
  // under a respelling of the target only when the filesystem proves the two
  // spellings are one directory; where it does not, those rows are genuinely
  // someone else's and stay. Saying so is the point: unreported, that outcome
  // is byte-identical to "that directory had nothing cached", which is exactly
  // how the pre-fix silent retention read.
  //
  // The wording claims only what was established, and the enumeration has to be
  // exhaustive or it is making the same kind of claim it exists to avoid.
  // `aliased` covers three outcomes and only the first is the filesystem
  // adjudicating: two live directories with two inodes; a `stat` that landed on
  // nothing because the spelling is no longer on disk (routine, and the common
  // case when the user purges a project directory they already deleted); or a
  // `stat` that could not be taken at all, because `sameDirectoryOnDisk`
  // returns `false` for *any* error, so an `EACCES` on an ancestor, an `ELOOP`
  // on a self-referential symlink and an `ENOTDIR` all land here too. Saying
  // "this filesystem reports it is a different directory" would assert a
  // verdict none of the last two produced; naming only the first two would
  // assert that the spelling is absent when it may be present and merely
  // unreadable. So the note states the retention and all three reasons. The
  // real `errno` stays in the `usage_policy.alias_probe_skipped` debug log
  // rather than on stderr: it is a diagnostic, and surfacing it would mean
  // plumbing a per-row cause through the deletion predicate for a message-only
  // gain. LLP 0104 #spellings names all three.
  if (retainedAliases.length > 0) {
    const rows = summary.retainedAliasRows
    const dirs = retainedAliases.length
    ctx.stderr.write(
      `note: ${rows} cached row${rows === 1 ? '' : 's'} under a similarly spelled ` +
      `director${dirs === 1 ? 'y' : 'ies'} ${rows === 1 ? 'was' : 'were'} left in place - ` +
      `this filesystem does not report ${dirs === 1 ? 'it' : 'them'} as the directory you named ` +
      `(genuinely different, no longer on disk, or could not be checked):\n`
    )
    for (const dir of retainedAliases) ctx.stderr.write(`  ${dir}\n`)
    ctx.stderr.write('tip: purge that exact spelling too if you meant it as well\n')
  }

  if (resurrectable.length > 0) {
    ctx.stderr.write(
      `warning: ${resurrectable.length} purged director${resurrectable.length === 1 ? 'y' : 'ies'} ` +
      `still record and will be re-imported by the next backfill:\n`
    )
    for (const dir of resurrectable) ctx.stderr.write(`  ${dir}\n`)
    ctx.stderr.write("tip: mark them ignored first with 'hyp privacy set <path> ignore' so the purge is durable\n")
  }

  return localError || remoteError || swept.failed > 0 ? 1 : 0
}

/**
 * @ref LLP 0417#operation [implements]: configured servers are the default scope, never the unused shipped default alone
 * @param {CommandRunContext} ctx
 * @param {{ session?: string, remote?: string, localOnly?: boolean }} parsed
 * @param {string} stateDir
 */
async function purgeRemotes(ctx, parsed, stateDir) {
  /** @type {Map<string, string>} */
  const targets = new Map()
  if (parsed.session === undefined || parsed.localOnly) return targets
  const registry = effectiveRemotes(ctx.config)
  if (parsed.remote) {
    if (!Object.hasOwn(registry, parsed.remote)) throw new Error('unknown remote target')
    targets.set(parsed.remote, registry[parsed.remote].url)
    return targets
  }
  const credentials = await readCredentials(stateDir)
  for (const [name, remote] of Object.entries(registry)) {
    if (Object.hasOwn(ctx.config?.query?.remotes ?? {}, name) ||
      ctx.config?.query?.default_remote === name || Object.hasOwn(credentials, name) || ctx.env[remoteTokenEnvVar(name)]) {
      targets.set(name, remote.url)
    }
  }
  const endpoints = new Set([...targets.values()].map(url => deriveMcpEndpoint(url)))
  const namesByEndpoint = new Map(Object.entries(registry).map(([name, remote]) => [deriveMcpEndpoint(remote.url), name]))
  // Enrollment may exist without a human login. Include it so missing
  // credentials become an explicit incomplete purge, never a local success.
  for (const [name, sink] of Object.entries(ctx.config?.sinks ?? {})) {
    if (!('plugin' in sink) || sink.plugin !== '@hypaware/central' || typeof sink.config?.url !== 'string') continue
    const url = sink.config.url
    const endpoint = deriveMcpEndpoint(url)
    if (endpoints.has(endpoint)) continue
    targets.set(namesByEndpoint.get(endpoint) ?? `sink:${name}`, url)
    endpoints.add(endpoint)
  }
  return targets
}

/**
 * @ref LLP 0417#authorization [implements]: human remote credentials, never the upload gateway bearer
 * @param {{ ctx: CommandRunContext, target: string, url: string, sessionId: string }} args
 */
async function purgeRemoteSession({ ctx, target, url, sessionId }) {
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const identityBase = deriveIdentityBase(url) ?? undefined
  const resolved = await resolveAccessJwt({ target, env: ctx.env, stateDir, identityBase })
  if (!resolved.ok) throw new Error(resolved.error)
  const endpoint = new URL(deriveMcpEndpoint(url))
  endpoint.pathname = endpoint.pathname.replace(/\/mcp$/, '/sessions/purge')
  const result = await attachWithRefresh({
    resolved,
    refresh: () => resolveAccessJwt({ target, env: ctx.env, stateDir, identityBase, forceRefresh: true }),
    async op(token) {
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      })
      return { authFailed: response.status === 401, value: response }
    },
  })
  if (!result.ok) throw new Error(result.error)
  if (!result.value.ok) throw new Error(`server returned HTTP ${result.value.status}; retry the same purge after resolving the server or authorization error`)
  const receipt = /** @type {{ status?: string, session_id?: string, physical_cleanup?: { status?: string } }} */ (await result.value.json())
  if (receipt?.status !== 'completed' || receipt?.session_id !== sessionId) throw new Error('server did not confirm session purge completion')
  return { ...receipt, physical_cleanup: receipt.physical_cleanup ?? { status: 'unverified' } }
}

/**
 * @param {{ path?: string, session?: string, ignored: boolean, all: boolean }} parsed
 * @param {CommandRunContext} ctx
 * @param {UsagePolicyResolver} resolver
 * @returns {PurgeTarget}
 */
function buildTarget(parsed, ctx, resolver) {
  if (parsed.path !== undefined) {
    // Resolve a relative path against the command-context cwd, matching the
    // sibling ignore/unignore verbs, so injected/remote/test dispatch targets
    // the tree the caller pointed at.
    return { kind: 'subtree', path: path.resolve(ctx.cwd ?? process.cwd(), parsed.path) }
  }
  if (parsed.session !== undefined) return { kind: 'session', id: parsed.session }
  if (parsed.ignored) return { kind: 'ignored', resolver }
  return { kind: 'all' }
}

/**
 * @param {PurgeTarget} target
 * @returns {string}
 */
function describeTarget(target) {
  switch (target.kind) {
    case 'subtree': return `all cached rows under ${target.path}`
    case 'session': return `all cached rows for session ${target.id}`
    case 'ignored': return 'all cached rows whose directory is currently ignored'
    case 'all': return 'ALL cached rows'
  }
}

/**
 * A short one-way digest of a purge target for dev telemetry, so a run can be
 * correlated without recording the raw path or session id.
 *
 * @param {PurgeTarget} target
 * @returns {string}
 */
function hashTargetToken(target) {
  const token =
    target.kind === 'subtree' ? target.path :
    target.kind === 'session' ? target.id :
    target.kind
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}


/**
 * @param {string[]} argv
 * @returns {{ path?: string, session?: string, remote?: string, localOnly?: boolean, ignored: boolean, all: boolean, yes: boolean, json: boolean, error?: string }}
 */
function parseArgs(argv) {
  const base = { ignored: false, all: false, yes: false, json: false }
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      path: { type: 'string' },
      session: { type: 'string' },
      remote: { type: 'string' },
      'local-only': { type: 'boolean', default: false },
      ignored: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    positional: ['path'],
  }, STRICT_SHORT_FLAGS)
  if ('help' in parsed) {
    return { ...base, error: USAGE }
  }
  if (!parsed.ok) return { ...base, error: parsed.error }
  const p = /** @type {{ path?: string, session?: string, remote?: string, 'local-only'?: boolean, ignored: boolean, all: boolean, yes: boolean, json: boolean }} */ (parsed.params)

  // Exactly one target selector. Bare `hyp purge` (no target) errors: a
  // destructive verb has no implicit scope (LLP 0104).
  const selectors = [
    p.path !== undefined,
    p.session !== undefined,
    p.ignored,
    p.all,
  ].filter(Boolean).length
  if (selectors === 0) {
    return { ...base, error: `a target is required.\n${USAGE}` }
  }
  if (selectors > 1) {
    return { ...base, error: `choose exactly one of <path>, --session, --ignored, --all.\n${USAGE}` }
  }
  if (p.remote !== undefined && (p.session === undefined || !p.remote.trim())) {
    return { ...base, error: '--remote requires a named target and --session' }
  }
  if (p['local-only'] && (p.session === undefined || p.remote !== undefined)) {
    return { ...base, error: '--local-only requires --session and cannot be combined with --remote' }
  }
  if (p.session !== undefined && (!p.session.trim() || Buffer.byteLength(p.session) > 4096)) {
    return { ...base, error: '--session requires a session id' }
  }

  return {
    path: p.path,
    session: p.session,
    remote: p.remote,
    localOnly: p['local-only'],
    ignored: p.ignored,
    all: p.all,
    yes: p.yes,
    json: p.json,
  }
}

const USAGE = 'usage: hyp purge <path> | --session <id> [--remote <target> | --local-only] | --ignored | --all [--yes] [--json]'

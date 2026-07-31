// @ts-check

import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'

import { askYesNo } from '../cli/confirm.js'
import { parseCommandArgv } from '../cli/verb_codec.js'
import { isTty } from '../cli/stdio.js'
import { Attr, getLogger, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { purgeCache } from '../cache/purge.js'
import { createUsagePolicyResolver, localOnlyListPath } from '../usage-policy/index.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { PurgeSummary, PurgeTarget } from '../../../src/core/cache/types.js'
 * @import { UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 */

/**
 * `hyp purge <path> | --session <id> | --ignored | --all [--yes] [--json]`
 *
 * The destructive verb (LLP 0104): delete already-cached rows from this
 * machine's local query cache, cache-only — purge never contacts a sink or the
 * remote and never deletes exported copies. Exactly one target is required;
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
 * @ref LLP 0104 [implements]: the `hyp purge` verb (targeted, cache-only, confirmed), with non-destructive marking left intact
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

  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const resolver = createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(stateDir) })
  const target = buildTarget(parsed, ctx, resolver)

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
      `Permanently delete ${describeTarget(target)} from the local cache? [y/N] `
    )
    if (!ok) {
      ctx.stdout.write('purge cancelled\n')
      return 0
    }
  }

  /** @type {PurgeSummary} */
  let summary
  try {
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
    ctx.stderr.write(`error: purge failed: ${message}\n`)
    return 1
  }

  getLogger('cache').info('purge.result', {
    [Attr.COMPONENT]: 'cmd-purge',
    [Attr.OPERATION]: 'purge.result',
    target_kind: target.kind,
    rows_deleted: summary.rowsDeleted,
    partitions_affected: summary.partitionsAffected,
    // A count, never a path. The near-miss decision is otherwise visible only
    // on stderr, so a smoke could assert the user-visible result without any
    // internal signal that the spelling predicate actually ran the branch.
    retained_alias_rows: summary.retainedAliasRows,
    status: 'ok',
  })

  // Resurrection warning (LLP 0104 §resurrection): any purged directory that
  // still resolves `full` will be re-imported by the next backfill. An
  // `ignore`d subtree is durable (the capture seam blocks re-import), so the
  // `--ignored` sweep never warns. Driven off the cwds actually deleted, not
  // the target shape, so `--session` / `--all` warn precisely.
  const resurrectable = summary.purgedCwds
    .filter((cwd) => resolver.resolve(cwd).class === 'full')
    .sort()

  const retainedAliases = [...summary.retainedAliasCwds].sort()

  if (parsed.json) {
    ctx.stdout.write(JSON.stringify({
      rowsDeleted: summary.rowsDeleted,
      partitionsAffected: summary.partitionsAffected,
      resurrectable,
      retainedAliasRows: summary.retainedAliasRows,
      retainedAliasCwds: retainedAliases,
    }) + '\n')
  } else {
    ctx.stdout.write(
      `purged ${summary.rowsDeleted} row${summary.rowsDeleted === 1 ? '' : 's'} ` +
      `from ${summary.partitionsAffected} partition${summary.partitionsAffected === 1 ? '' : 's'}\n`
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
    ctx.stderr.write("tip: mark them ignored first with 'hyp policy set <path> ignore' so the purge is durable\n")
  }

  return 0
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
 * @returns {{ path?: string, session?: string, ignored: boolean, all: boolean, yes: boolean, json: boolean, error?: string }}
 */
function parseArgs(argv) {
  const base = { ignored: false, all: false, yes: false, json: false }
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      path: { type: 'string' },
      session: { type: 'string' },
      ignored: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    positional: ['path'],
  })
  if ('help' in parsed) {
    return { ...base, error: USAGE }
  }
  if (!parsed.ok) return { ...base, error: parsed.error }
  const p = /** @type {{ path?: string, session?: string, ignored: boolean, all: boolean, yes: boolean, json: boolean }} */ (parsed.params)

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
  if (p.session !== undefined && p.session === '') {
    return { ...base, error: '--session requires a session id' }
  }

  return {
    path: p.path,
    session: p.session,
    ignored: p.ignored,
    all: p.all,
    yes: p.yes,
    json: p.json,
  }
}

const USAGE = 'usage: hyp purge <path> | --session <id> | --ignored | --all [--yes] [--json]'

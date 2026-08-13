// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { readClientActionStatus, readInstalledAssets } from '../config/action_reconciler.js'
import { Attr, getLogger } from '../observability/index.js'
import { copyDir } from '../util/fs_copy.js'
import {
  digestClientAsset,
  readClientAssetLedger,
  writeClientAssetLedger,
} from './client_asset_ledger.js'
import { isWithinDir } from './contribution_names.js'

/**
 * Materializing plugin-contributed **client assets** (skills and subagents)
 * into a client's configuration directories.
 *
 * Skills and agents are two shapes of one thing: a file tree a plugin wants
 * copied under `~/.claude` or `~/.codex` so the attached client can see it. The
 * shapes differ only in the copy (a directory for a skill, a single `.md` for an
 * agent) and the manifest key naming the destination (`skill_dir` / `agent_dir`).
 * Everything else - which clients are targeted, containment, idempotent replace,
 * what gets reported - is common, so it lives here once and every caller routes
 * through it: `hyp skills install`, the wizard finale, and attach (manual and
 * reconciler-driven alike).
 *
 * @ref LLP 0138#one-materializer [implements]: skills and agents are one
 *   materialization with two copy shapes, so the four divergent loops collapse
 *   to this module and cannot drift again.
 */

/**
 * @import {
 *   ClientAssetInstall,
 *   ClientAssetLedgerRecord,
 *   ClientAssetMaterialization,
 *   ClientAssetRemoval,
 *   MaterializeClientAssetsOptions,
 *   PlannedClientAsset,
 *   ResolvedClientAsset,
 * } from '../../../src/core/runtime/types.js'
 * @import { ClientDescriptor } from '../../../src/core/types.js'
 */

/**
 * Copy every registered skill and agent that targets one of `clients` into that
 * client's asset directories, replacing any existing copy (idempotent).
 *
 * Tolerant by construction: one contribution that cannot be resolved or copied
 * warns and is skipped rather than throwing, so a single bad plugin cannot abort
 * an onboarding run or an org-driven attach midway.
 *
 * The removals come back alongside the copies, not only as `stdout` lines,
 * because a caller is allowed to withhold `stdout` and one does: the wizard
 * finale suppresses the per-copy lines so a dozen paths do not bury its step
 * summary. Reporting only through the stream it withholds is how a `hyp init`
 * came to delete a skill and say nothing (LLP 0219 #automatic-not-gated).
 *
 * @param {MaterializeClientAssetsOptions} options
 * @returns {Promise<ClientAssetMaterialization>} the copies actually made (or,
 *   under `dryRun`, that would be made), and the retired destinations this run
 *   removed or left in place
 */
export async function materializeClientAssets(options) {
  const { dryRun = false, stdout, stderr } = options
  const planned = planClientAssets(options)
  /** @type {ClientAssetInstall[]} */
  const installed = []
  for (const { asset, client, dest } of planned) {
    if (dryRun) {
      stdout?.write(`(dry-run) Would install ${asset.kind} '${asset.name}' → ${dest}\n`)
    } else {
      try {
        await copyAsset(asset, dest)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        stderr?.write(`warning: ${asset.kind} '${asset.name}' for ${client} failed: ${message}\n`)
        continue
      }
      stdout?.write(`installed ${asset.kind} '${asset.name}' → ${dest}\n`)
    }
    installed.push({ kind: asset.kind, name: asset.name, client, dest, dryRun })
  }
  const { pruned, withheld } = await reconcileClientAssetLedger({ options, planned, installed })
  return { installed, pruned, withheld }
}

/**
 * The copies {@link materializeClientAssets} would make: every registered asset
 * resolved against the targeted clients, minus what cannot land (unknown
 * client, no directory for the kind, a destination escaping it). Synchronous
 * and, apart from the warnings it writes, side-effect free.
 *
 * Split out because the freshness check is not allowed to touch the disk: a
 * reconciler pass has to answer "would this attach copy a different set than
 * the marker recorded?" from the live registries alone, and answering it from a
 * second copy of this loop is exactly the drift {@link materializeClientAssets}
 * exists to prevent. Plan here, copy there, compare with
 * {@link clientAssetsKey}.
 *
 * @param {MaterializeClientAssetsOptions} options
 * @returns {PlannedClientAsset[]}
 * @ref LLP 0138#one-materializer [implements]: what would be copied is derived
 *   from the one loop, never from a parallel reimplementation of it.
 */
export function planClientAssets(options) {
  const { clients, descriptors, homeDir, stderr } = options
  /** @type {PlannedClientAsset[]} */
  const planned = []
  if (homeDir.length === 0 || (clients !== 'all' && clients.length === 0)) return planned

  // `'all'` installs for whatever the contributions name rather than for a
  // fixed list, so a contribution naming a client no manifest declares still
  // reaches the unknown-client warning below instead of being filtered out
  // silently. An explicit list filters, and never warns about what it excluded.
  const wanted = clients === 'all' ? undefined : new Set(clients)
  const everyClient = clients === 'all' ? [...descriptors.keys()] : clients
  for (const asset of resolveAssets(options.skills, options.agents)) {
    for (const client of expandAssetClients(asset, everyClient)) {
      if (wanted && !wanted.has(client)) continue
      const descriptor = descriptors.get(client)
      if (!descriptor) {
        stderr?.write(`warning: ${asset.kind} '${asset.name}' targets unknown client '${client}'\n`)
        continue
      }
      const assetDir = asset.kind === 'skill' ? descriptor.skillDir : descriptor.agentDir
      // A client with no directory for this kind is not an error: Codex has
      // skills but no subagent concept, so an agent contribution naming it
      // simply has nowhere to land. Silence beats a warning the user cannot act
      // on and would see on every attach.
      if (!assetDir) continue

      const baseDir = path.join(homeDir, assetDir)
      const dest = asset.kind === 'skill'
        ? path.join(baseDir, asset.name)
        : path.join(baseDir, `${asset.name}.md`)
      // Defense in depth: registration rejects traversal names, but the asset
      // directory comes from a plugin manifest, so re-check containment.
      if (!isWithinDir(dest, baseDir)) {
        stderr?.write(`warning: ${asset.kind} '${asset.name}' for ${client} resolves outside ${baseDir}; skipped\n`)
        continue
      }
      planned.push({ asset, client, dest })
    }
  }
  return planned
}

/**
 * A digest of the asset set an install would produce right now: kind, name,
 * client, and destination of every planned copy, order-independent.
 *
 * The freshness key for an attach marker. An org adding a plugin months after
 * enrollment changes what a client's attach would copy but need not change the
 * gateway endpoint (a pinned port, or the LLP 0114 default, is the same port
 * across the restart), so an endpoint-only currency check would call that
 * marker current forever and the new skills would never land. Comparing the
 * digest makes "the contributed set changed" a forward gap the reconciler
 * closes on its own, which is what LLP 0107 rejected a login one-shot for.
 *
 * Sorted, so plugin load order cannot make an unchanged set look changed.
 *
 * @param {MaterializeClientAssetsOptions} options
 * @returns {string}
 * @ref LLP 0107#currency [implements]: materialization re-runs when the plugin
 *   set changes what a client's assets are, not only when the endpoint moves.
 */
export function clientAssetsKey(options) {
  const lines = planClientAssets(options)
    .map(({ asset, client, dest }) => `${asset.kind}:${asset.name}:${client}:${dest}`)
    .sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

/**
 * The directories a client's assets are allowed to occupy: `<home>/<skill_dir>`
 * and, when the client declares one, `<home>/<agent_dir>`. Computed from the
 * same descriptor fields {@link materializeClientAssets} joins its destinations
 * from, so it is the removal side's allow-list for the paths a marker claims
 * were written.
 *
 * @param {ClientDescriptor} descriptor
 * @param {string} homeDir
 * @returns {string[]}
 */
export function clientAssetBaseDirs(descriptor, homeDir) {
  if (homeDir.length === 0) return []
  /** @type {string[]} */
  const dirs = []
  if (descriptor.skillDir) dirs.push(path.join(homeDir, descriptor.skillDir))
  if (descriptor.agentDir) dirs.push(path.join(homeDir, descriptor.agentDir))
  return dirs
}

/**
 * Remove previously materialized assets by destination path. The reversal half
 * of {@link materializeClientAssets}: the attach handler hands back the `dest`
 * list its own marker recorded, so an org-driven install reverses exactly what
 * it wrote and nothing else.
 *
 * Best-effort and idempotent - an already-absent path is a successful removal,
 * and a failure on one path never stops the rest.
 *
 * `baseDirs` is not optional and not a formality. Every dest here came out of
 * `client-actions.json`, a plain JSON file on disk that a hand edit or a
 * corrupt write can turn into `"/"` or `"$HOME"`, and the removal is a
 * recursive force-rm. The write side already re-checks containment even though
 * registration validated the name; the delete side needs it more, because its
 * input is persisted state rather than a live registry. A dest outside every
 * base is reported failed, never removed: the marker then survives for a human
 * to look at instead of the deletion being papered over as done. An empty
 * `baseDirs` refuses everything too, but says so as "no asset directories
 * resolved" rather than as a containment failure the caller cannot act on.
 *
 * Each failure says whether retrying it could ever help, because the two kinds
 * are not alike. An `fs.rm` that failed on a locked or permission-denied path
 * may succeed on the next run, so the caller keeps the undo record. A
 * containment refusal is pure string math over a recorded path and a
 * descriptor: it fails identically forever, so a caller that keeps the marker
 * for it makes the undo permanently unfinishable and leaves behind a `done`
 * marker whose settings effect is already reversed, which is the stale marker
 * that blocks a later re-attach (#217). Refusals are for the caller to name and
 * hand to the user, not to retry.
 *
 * @param {string[]} dests
 * @param {string[]} baseDirs  The directories a recorded dest must sit beneath
 *   (see {@link clientAssetBaseDirs}).
 * @returns {Promise<{
 *   removed: string[],
 *   failed: { dest: string, reason: string, retryable: boolean }[],
 * }>}
 * @ref LLP 0107#reversal [implements]: only marker-recorded (org-driven) copies
 *   are removed; a manual install carries no marker and survives detach.
 * @ref LLP 0138#refusal-is-not-failure [implements]: a refusal is reported as
 *   unretryable so the caller names the files instead of retaining the marker.
 */
export async function removeClientAssets(dests, baseDirs) {
  /** @type {string[]} */
  const removed = []
  /** @type {{ dest: string, reason: string, retryable: boolean }[]} */
  const failed = []
  // With no base directories nothing can be contained, so every dest would be
  // refused for "resolving outside" them - naming the wrong cause. The cause is
  // that this client resolved no asset directories at all: no home directory to
  // join them onto, or a descriptor declaring neither kind.
  if (baseDirs.length === 0) {
    return {
      removed,
      failed: dests.map((dest) => ({ dest, reason: NO_BASE_DIRS_REASON, retryable: false })),
    }
  }
  for (const dest of dests) {
    if (!isRemovableAsset(dest, baseDirs)) {
      failed.push({
        dest,
        reason: "resolves outside this client's asset directories; refusing to remove",
        retryable: false,
      })
      continue
    }
    try {
      await fs.rm(dest, { recursive: true, force: true })
      removed.push(dest)
    } catch (err) {
      failed.push({
        dest,
        reason: err instanceof Error ? err.message : String(err),
        retryable: true,
      })
    }
  }
  return { removed, failed }
}

/**
 * Take off the machine the client assets HypAware installed and this version's
 * plugin set no longer contributes, then re-record what it does contribute.
 *
 * An in-place upgrade that retires a skill deletes the *source*; the copy under
 * `~/.claude/skills` stays, still model-invocable, still carrying whatever bug
 * the retirement was for (#726, #660). Copying is therefore only half of
 * materialization, and the missing half belongs here rather than in a caller
 * for the same reason the copy does: four call sites re-deriving what is safe
 * to delete is four chances to get a recursive delete wrong
 * (LLP 0138 #one-materializer).
 *
 * **Nothing is removed on the strength of "no plugin declares it".** A skill
 * the user wrote is absent from the registries in exactly the same way a
 * retired one is, so absence is evidence of nothing. Four conditions must all
 * hold before a path is touched:
 *
 * 1. **HypAware's own record says it wrote that path** - the ledger, or (for
 *    an org-driven attach, including one made by a version that predates the
 *    ledger) the `installed_assets` list on the client's attach marker, which
 *    is already the record `hyp detach` acts on (LLP 0138 #marker-undo).
 * 2. **The path is not in this run's plan**, for *any* client - it is retired,
 *    not merely a copy that failed, and not a path another client in the same
 *    run is contributing to. Destinations are physical paths and two clients
 *    can declare the same asset directory (`claude` and `claude-desktop` both
 *    declare `.claude/skills`), so the check is over the whole run's plan.
 * 3. **It sits strictly inside this client's own asset directories**, checked
 *    here and again by {@link removeClientAssets}, whose input is persisted
 *    JSON either way.
 * 4. **The bytes are still the bytes we wrote**: the recorded digest matches
 *    what is on disk *now*. No recorded digest is not a match. A mismatch, or
 *    an absence, is the end of the evidence and the removal becomes a report
 *    (LLP 0219 #edited-assets-are-not-ours).
 *
 * The client scope is taken from what *landed*, not from what was asked for. A
 * run that copied nothing for a client - an empty registry, a `--client` filter
 * matching no contribution - cannot tell "these assets were retired" from "this
 * boot never saw them", and acting on the second reading would empty a working
 * install. That guard covers *total* failure only, and the loader's failure
 * mode is partial: `activatePlugins` catches per plugin and boot returns
 * normally, so one plugin throwing leaves the client in scope with the failed
 * plugin's assets missing from the plan and indistinguishable from retired
 * ones. `failedPlugins` is how the caller says so, and it stands down the whole
 * prune rather than trying to attribute candidates to plugins the ledger never
 * recorded (LLP 0219 #incomplete-activation-prunes-nothing).
 *
 * @param {{
 *   options: MaterializeClientAssetsOptions,
 *   planned: PlannedClientAsset[],
 *   installed: ClientAssetInstall[],
 * }} args
 * @returns {Promise<{ pruned: ClientAssetRemoval[], withheld: ClientAssetRemoval[] }>}
 * @ref LLP 0219#prune-on-materialize [implements]: the one materializer removes
 *   what this version no longer contributes, gated on its own install record.
 */
async function reconcileClientAssetLedger({ options, planned, installed }) {
  const { descriptors, homeDir, stateRoot, dryRun = false, stdout, stderr } = options
  /** @type {ClientAssetRemoval[]} */
  const pruned = []
  /** @type {ClientAssetRemoval[]} */
  const withheld = []
  if (!stateRoot || homeDir.length === 0) return { pruned, withheld }
  const ledger = await readClientAssetLedger(stateRoot)
  const scope = new Set(installed.map((item) => item.client))
  const landed = new Set(installed.map((item) => item.dest))
  // One plugin that threw in `activate()` is enough: this run's plan is missing
  // whatever that plugin contributes, and no candidate carries the plugin that
  // would let us exempt only those. Stand the prune down and keep every record.
  // @ref LLP 0219#incomplete-activation-prunes-nothing [implements]: the coarse
  //   rule is chosen over per-plugin attribution because this is a delete path
  const activationIncomplete = (options.failedPlugins?.length ?? 0) > 0

  // Every destination this run's plan contains, across every client. A dest is
  // a physical path, and two clients can share an asset directory, so "not in
  // the plan" has to be asked of the whole plan or a path one client is
  // contributing right now reads as another client's retired copy.
  const keepAll = new Set(planned.map(({ dest }) => dest))

  // A client this run did not install for keeps every record it had: this pass
  // learned nothing about it.
  /** @type {ClientAssetLedgerRecord[]} */
  const next = ledger.filter((record) => !scope.has(record.client))

  for (const client of scope) {
    const descriptor = descriptors.get(client)
    if (!descriptor) continue
    const baseDirs = clientAssetBaseDirs(descriptor, homeDir)
    if (baseDirs.length === 0) continue

    if (activationIncomplete) {
      // Untouched, not dropped: the record is what a later complete boot will
      // prune on, and losing it would leave the path unremovable forever. The
      // dests this run did land are re-recorded with a fresh digest below.
      for (const record of ledger) {
        if (record.client !== client || landed.has(record.dest)) continue
        next.push(record)
      }
    } else {
      /** @type {Map<string, ClientAssetLedgerRecord | undefined>} */
      const candidates = new Map()
      for (const record of ledger) {
        if (record.client !== client || keepAll.has(record.dest)) continue
        candidates.set(record.dest, record)
      }
      for (const dest of attachMarkerAssets(stateRoot, client)) {
        if (keepAll.has(dest) || candidates.has(dest)) continue
        candidates.set(dest, undefined)
      }

      for (const [dest, record] of candidates) {
        const outcome = await pruneOneAsset({ dest, record, client, baseDirs, dryRun, stdout, stderr })
        if (outcome.carried) next.push(outcome.carried)
        if (outcome.removal) (outcome.removed ? pruned : withheld).push(outcome.removal)
      }

      // A planned copy that failed is not retired and not re-recorded: keep the
      // record of the copy that is still sitting there from last time, or the
      // next run would read the path as never ours and leave it forever.
      //
      // Asked of the **whole run's** plan, exactly as the candidate loop above
      // is, and for the same reason: a dest is a physical path and two clients
      // can share an asset directory. Asked of this client's share alone, a dest
      // that moved to another client whose copy failed is neither a candidate
      // (the plan contains it) nor carried (this client no longer plans it), so
      // its record is dropped and the copy still sitting on disk becomes
      // permanently unprunable and unreportable - the leave-behind LLP 0219
      // exists to end. Two records for one dest under two clients is the price,
      // and it is no price at all: candidates are keyed by dest per client and
      // `fs.rm` is forced and idempotent.
      for (const record of ledger) {
        if (record.client !== client) continue
        if (!keepAll.has(record.dest) || landed.has(record.dest)) continue
        next.push(record)
      }
    }

    for (const item of installed) {
      if (item.client !== client) continue
      const digest = dryRun ? undefined : await digestClientAsset(item.dest)
      next.push({
        kind: item.kind,
        name: item.name,
        client,
        dest: item.dest,
        ...(digest ? { digest } : {}),
      })
    }
  }

  if (dryRun) return { pruned, withheld }
  await writeClientAssetLedger(stateRoot, next)
  return { pruned, withheld }
}

/**
 * Decide one stale candidate: what to carry forward in the ledger, and what to
 * report. A `carried` record means "still on disk, still ours to name later";
 * `undefined` means the path is gone, by our hand or someone else's. `removal`
 * is the line for the caller's summary, with `removed` saying which of the two
 * things happened to it; a candidate that was already absent produces neither,
 * because there is nothing to tell anyone about.
 *
 * @param {{
 *   dest: string,
 *   record: ClientAssetLedgerRecord | undefined,
 *   client: string,
 *   baseDirs: string[],
 *   dryRun: boolean,
 *   stdout?: { write(chunk: string): unknown },
 *   stderr?: { write(chunk: string): unknown },
 * }} args
 * @returns {Promise<{
 *   carried: ClientAssetLedgerRecord | undefined,
 *   removed: boolean,
 *   removal?: ClientAssetRemoval,
 * }>}
 */
async function pruneOneAsset({ dest, record, client, baseDirs, dryRun, stdout, stderr }) {
  const kind = record?.kind ?? (path.extname(dest) === '.md' ? 'agent' : 'skill')
  const name = record?.name ?? path.basename(dest, kind === 'agent' ? '.md' : '')
  /** @type {ClientAssetRemoval} */
  const removal = { kind, name, client, dest, dryRun }

  // A recorded path outside this client's directories is not this run's to act
  // on. Kept verbatim rather than dropped: the record is the only thing naming
  // it, and a home directory that moved back would make it actionable again.
  //
  // Said out loud, because this branch returns before {@link removeClientAssets}
  // and so fires none of its refusal reporting. A record naming `$HOME` or `/`
  // is the loudest signal available that the install record is corrupt, and a
  // silent refusal throws that signal away.
  if (!isRemovableAsset(dest, baseDirs)) {
    stderr?.write(
      `warning: recorded ${kind} '${name}' at ${dest} resolves outside ${client}'s asset ` +
        'directories; refusing to remove it - check the install record\n'
    )
    getLogger('client-assets').warn('client_assets.prune_refused', {
      [Attr.COMPONENT]: 'client-assets',
      [Attr.OPERATION]: 'client_assets.prune',
      hyp_client: client,
      [Attr.STATUS]: 'ok',
      [Attr.ERROR_KIND]: 'outside_asset_dirs',
      detail: dest,
    })
    return { carried: record, removed: false, removal }
  }

  // Belt and braces over the digest domains. `kind` says what we wrote there (a
  // skill is a directory, a subagent a single file), and an object of the other
  // shape is by definition not the thing the record describes, whatever the
  // hashes say. The digest already separates the two spaces; this refuses the
  // question a second time, from the one field the record carries that the
  // filesystem cannot forge.
  // @ref LLP 0219#edited-assets-are-not-ours [implements]: an object whose shape
  //   contradicts the record is not the asset we installed, so it is reported.
  const shape = await statShape(dest)
  if (record && shape && shape !== (record.kind === 'agent' ? 'file' : 'dir')) {
    stderr?.write(
      `warning: retired ${kind} '${name}' at ${dest} is a ${shape === 'dir' ? 'directory' : 'file'} where ` +
        `HypAware installed a ${record.kind === 'agent' ? 'file' : 'directory'}; left in place - ` +
        'remove it by hand if you no longer want it\n'
    )
    getLogger('client-assets').warn('client_assets.prune_withheld', {
      [Attr.COMPONENT]: 'client-assets',
      [Attr.OPERATION]: 'client_assets.prune',
      hyp_client: client,
      [Attr.STATUS]: 'ok',
      [Attr.ERROR_KIND]: 'asset_shape_changed',
      detail: dest,
    })
    return { carried: record, removed: false, removal }
  }

  const digest = await digestClientAsset(dest)
  // Already gone (removed by hand, or by an earlier pass whose ledger write
  // lost the race). Nothing to report and nothing left to record.
  if (!digest) return { carried: undefined, removed: false }

  // The user's own edit outranks the retirement. Overwriting a *contributed*
  // asset's edits is a documented part of `hyp skills install` (the copy is
  // idempotent replace, and the source is right there to re-copy from); a
  // retired asset has no source left, so a delete here is unrecoverable. Name
  // it and leave it: the file stays visible, and the record stays, so the same
  // report reappears until the user acts on it.
  //
  // A candidate with no recorded digest takes the same exit, and that is the
  // whole of the marker's demotion from a deletion source to a reporting one.
  // The marker records paths, never bytes, and `installed_assets` is unioned
  // across every rewrite and never shrinks, so a path that appears there once
  // is a candidate forever - including after HypAware itself removed it and the
  // user later authored something of their own under that name. Absence of
  // evidence is not evidence, so it may not read as a match.
  // @ref LLP 0219#edited-assets-are-not-ours [implements]: the removal proceeds
  //   only on a recorded digest that still matches; anything else is a report.
  if (record?.digest !== digest) {
    const reason = record?.digest
      ? 'changed since HypAware installed it'
      : 'has no recorded content digest, so nothing proves the bytes are ours'
    stderr?.write(
      `warning: retired ${kind} '${name}' at ${dest} ${reason}; ` +
        'left in place - remove it by hand if you no longer want it\n'
    )
    getLogger('client-assets').warn('client_assets.prune_withheld', {
      [Attr.COMPONENT]: 'client-assets',
      [Attr.OPERATION]: 'client_assets.prune',
      hyp_client: client,
      [Attr.STATUS]: 'ok',
      [Attr.ERROR_KIND]: record?.digest ? 'asset_modified' : 'digest_unrecorded',
      detail: dest,
    })
    return { carried: record, removed: false, removal }
  }

  if (dryRun) {
    stdout?.write(`(dry-run) Would remove retired ${kind} '${name}' → ${dest}\n`)
    return { carried: record, removed: true, removal }
  }

  const { removed, failed } = await removeClientAssets([dest], baseDirs)
  if (removed.length > 0) {
    stdout?.write(`removed retired ${kind} '${name}' → ${dest}\n`)
    getLogger('client-assets').info('client_assets.pruned', {
      [Attr.COMPONENT]: 'client-assets',
      [Attr.OPERATION]: 'client_assets.prune',
      hyp_client: client,
      [Attr.STATUS]: 'ok',
      detail: dest,
    })
    return { carried: undefined, removed: true, removal }
  }
  // Keep the record for a removal that can still succeed, exactly as the detach
  // path keeps its marker for one (LLP 0138 #refusal-is-not-failure). Here even
  // a refusal is worth keeping: it costs nothing but a line, and this ledger is
  // not a `done` marker that a later attach short-circuits on.
  for (const failure of failed) {
    stderr?.write(`warning: retired ${kind} '${name}' at ${failure.dest} could not be removed: ${failure.reason}\n`)
  }
  return { carried: record, removed: false, removal }
}

/**
 * Whether `dest` is a directory, a file, or something else (a symlink to
 * neither, a socket). `undefined` when it cannot be stat'd at all, which the
 * caller must not read as either shape.
 *
 * @param {string} dest
 * @returns {Promise<'dir' | 'file' | 'other' | undefined>}
 */
async function statShape(dest) {
  try {
    const stat = await fs.stat(dest)
    if (stat.isDirectory()) return 'dir'
    if (stat.isFile()) return 'file'
    return 'other'
  } catch {
    return undefined
  }
}

/**
 * The destinations an org-driven attach recorded for `client`, or none.
 *
 * The second evidence source, and the only one that reaches back before this
 * ledger existed: the attach marker has recorded `installed_assets` since
 * LLP 0138 and unions them across every rewrite. It names *paths*, never bytes,
 * so what it produces is a **reporting** candidate and never a deletion: the
 * digest gate in {@link pruneOneAsset} has nothing to match against and stops
 * every one of these at the warning. Detach acts on the same list destructively
 * because a human asked for exactly that, in one command, now; a prune runs
 * unattended on every attach, forever, over a list that never shrinks.
 *
 * Never throws: an unreadable marker store contributes no candidates.
 *
 * @param {string} stateRoot
 * @param {string} client
 * @returns {string[]}
 * @ref LLP 0138#marker-undo [constrained-by]: `installed_assets` never shrinks,
 *   so a path it names once is a candidate on every later run - which is why
 *   this source reports and does not delete.
 */
function attachMarkerAssets(stateRoot, client) {
  try {
    return readInstalledAssets(readClientActionStatus({ stateRoot }).byKind.attach?.[client])
  } catch {
    return []
  }
}

/* ------------------------------- Internals ------------------------------- */

/** Why a removal is refused when the client has no asset directories at all. */
const NO_BASE_DIRS_REASON =
  'no asset directories resolved for this client (no home directory, or none declared); refusing to remove'

/**
 * True when `dest` sits strictly beneath one of `baseDirs`. Strictly: a dest
 * equal to a base is the whole skills (or agents) directory, which no write
 * this module makes can produce, so treating it as removable would only ever
 * honour a corrupted marker.
 *
 * @param {string} dest
 * @param {string[]} baseDirs
 * @returns {boolean}
 */
function isRemovableAsset(dest, baseDirs) {
  const resolved = path.resolve(dest)
  return baseDirs.some(
    (baseDir) => resolved !== path.resolve(baseDir) && isWithinDir(resolved, baseDir)
  )
}

/**
 * Flatten the two registries into one ordered asset list. Skills come first so
 * the printed output keeps the order operators are used to from when these were
 * two commands.
 *
 * @param {MaterializeClientAssetsOptions['skills']} [skills]
 * @param {MaterializeClientAssetsOptions['agents']} [agents]
 * @returns {ResolvedClientAsset[]}
 */
function resolveAssets(skills, agents) {
  /** @type {ResolvedClientAsset[]} */
  const assets = []
  for (const skill of skills?.list() ?? []) {
    assets.push({ kind: 'skill', name: skill.name, clients: skill.clients, source: skill.sourceDir })
  }
  for (const agent of agents?.list() ?? []) {
    assets.push({ kind: 'agent', name: agent.name, clients: agent.clients, source: agent.sourceFile })
  }
  return assets
}

/**
 * The client names one asset targets. `PluginSkillClient` admits the literal
 * `'all'`, which means "every client this run is installing for" rather than a
 * client named `all`.
 *
 * @param {ResolvedClientAsset} asset
 * @param {string[]} clients
 * @returns {string[]}
 */
function expandAssetClients(asset, clients) {
  return asset.clients.includes('all') ? clients : asset.clients
}

/**
 * The one place the two copy shapes differ: a skill is a directory tree
 * replaced wholesale, an agent a single markdown file overwritten in place.
 *
 * @param {ResolvedClientAsset} asset
 * @param {string} dest
 * @returns {Promise<void>}
 */
async function copyAsset(asset, dest) {
  if (asset.kind === 'skill') {
    await fs.rm(dest, { recursive: true, force: true })
    await copyDir(asset.source, dest)
    return
  }
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(asset.source, dest)
}

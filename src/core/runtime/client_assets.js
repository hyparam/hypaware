// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { readClientActionStatus, readInstalledAssets } from '../config/action_reconciler.js'
import { Attr, getLogger } from '../observability/index.js'
import { copyDir } from '../util/fs_copy.js'
import {
  digestClientAsset,
  inspectClientAsset,
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
 *   ClientAssetRefresh,
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
  const { pruned, withheld } = await reconcileClientAssetLedger({ options, installed })
  return { installed, pruned, withheld }
}

/**
 * Re-copy every installed client asset whose source bytes have moved on since
 * the copy was made, and nothing else.
 *
 * The self-update replaces the package under an installed daemon, and with it
 * the skill sources inside the package, but the copies under `~/.claude` and
 * `~/.codex` are plain files that nothing re-reads. The org reconciler's
 * freshness key deliberately covers the asset *set* and not the bytes (LLP 0138
 * #currency), so an in-place rewrite of an existing skill never re-attaches,
 * and a machine that never joined an org has no reconciler at all. This is the
 * one place bytes are compared, and it runs where the new bytes first appear:
 * the boot of the daemon that the update restarted onto.
 *
 * Which clients are refreshed is read from the install ledger, never from the
 * live registries: a client with no ledger record has nothing HypAware wrote
 * for it, and installing for it here would turn a refresh into an attach the
 * user never asked for. Each planned copy that has a record is then decided by
 * two digests. The bytes on disk must still match a digest we recorded for the
 * path, or the user took the copy over and it is theirs to keep (the same
 * evidence that gates a prune, LLP 0219 #edited-assets-are-not-ours, matched
 * against every digest recorded for the path, LLP 0284). And the source must
 * digest differently from that record, or there is nothing to copy. A path
 * that is gone is not resurrected: removing it was a choice, and
 * `hyp skills install` is the way to reverse that choice.
 *
 * Never throws and never removes: a copy that fails is reported and the record
 * of the copy still sitting there is kept, exactly as an install failure is.
 *
 * @param {Omit<MaterializeClientAssetsOptions, 'clients' | 'dryRun'>} options
 * @returns {Promise<ClientAssetRefresh>}
 * @ref LLP 0397#ledger-decides [implements]: the ledger names the clients, and
 *   two digests (recorded versus on disk, then source versus recorded) decide
 *   each asset, so an update reaches the installed skills without a command.
 * @ref LLP 0397#edited-copies-are-kept [implements]: a copy whose bytes no
 *   longer match a recorded digest is skipped and named, never overwritten.
 */
export async function refreshClientAssets(options) {
  const { stateRoot, stderr } = options
  /** @type {ClientAssetRefresh} */
  const outcome = { refreshed: [], skipped: [], unchanged: 0 }
  if (!stateRoot) return outcome

  const ledger = await readClientAssetLedger(stateRoot)
  if (ledger.length === 0) return outcome

  // Every digest ever recorded for a path, across clients: two clients can
  // share one asset directory, and the copy made for one is the bytes the
  // other's record names.
  // @ref LLP 0284#digests-are-per-path [constrained-by]: the match is asked of
  //   every record naming the path, not of the one client's record.
  /** @type {Map<string, Set<string>>} */
  const recordedDigests = new Map()
  for (const record of ledger) {
    if (!record.digest) continue
    let digests = recordedDigests.get(record.dest)
    if (!digests) recordedDigests.set(record.dest, digests = new Set())
    digests.add(record.digest)
  }

  const clients = [...new Set(ledger.map((record) => record.client))].sort()
  const planned = planClientAssets({ ...options, clients })
  /** @type {Map<string, string>} */
  const rewritten = new Map()
  /** @type {Set<string>} */
  const decided = new Set()
  for (const { asset, client, dest } of planned) {
    // A shared destination is decided once; the second client's plan names
    // bytes the first already refreshed.
    if (decided.has(dest)) continue
    decided.add(dest)
    const recorded = recordedDigests.get(dest)
    if (!recorded) continue

    let inspected = await inspectClientAsset(dest)
    const stepped = `${dest}${REFRESH_OLD_SUFFIX}`
    if (inspected.missing) {
      // A refresh killed between {@link replaceAsset}'s two renames leaves the
      // copy beside the destination under the staging name, with `dest` itself
      // absent. That is not the user removing it, so it is put back before the
      // decision is made: read as `missing` instead, the copy would be skipped
      // on this boot and on every boot after it, and the installed skill would
      // be gone for good. A copy the user really did remove finds no copy
      // stepped aside beside it and stays gone.
      const restored = await fs.rename(stepped, dest).then(() => true, () => false)
      if (restored) inspected = await inspectClientAsset(dest)
    } else {
      // The destination is there, so anything still under a staging name is a
      // leftover: a stage abandoned inside `copyDir`, or a copy stepped aside
      // by a swap whose closing sweep failed. Each is a complete `SKILL.md`
      // sitting in the client's skills directory under a name no ledger record
      // covers, which the client loads as a second stale copy of the same skill
      // and no prune can ever remove. {@link replaceAsset} clears them only on
      // a boot that rewrites this asset, and for a source that never changes
      // again that boot never comes - so the sweep belongs here, where every
      // recorded destination is looked at once per boot. It also keeps the
      // restore above honest: a stepped aside copy that outlives its own boot
      // would otherwise resurrect a destination the user deleted on purpose.
      await fs.rm(stepped, { recursive: true, force: true }).catch(() => {})
      await fs.rm(`${dest}${REFRESH_STAGE_SUFFIX}`, { recursive: true, force: true }).catch(() => {})
    }
    const { digest: onDisk, missing } = inspected
    if (missing) {
      outcome.skipped.push({ kind: asset.kind, name: asset.name, client, dest, reason: 'missing' })
      continue
    }
    if (!onDisk || !recorded.has(onDisk)) {
      stderr?.write(onDisk
        ? `warning: ${asset.kind} '${asset.name}' at ${dest} has been edited since HypAware installed it; ` +
          'left as is - run `hyp skills install` to replace it\n'
        : `warning: ${asset.kind} '${asset.name}' at ${dest} could not be read; ` +
          'left as is - run `hyp skills install` to replace it\n'
      )
      getLogger('client-assets').warn('client_assets.refresh_skipped', {
        [Attr.COMPONENT]: 'client-assets',
        [Attr.OPERATION]: 'client_assets.refresh',
        hyp_client: client,
        [Attr.STATUS]: 'ok',
        [Attr.ERROR_KIND]: onDisk ? 'asset_edited' : 'digest_unreadable',
        detail: dest,
      })
      outcome.skipped.push({ kind: asset.kind, name: asset.name, client, dest, reason: onDisk ? 'edited' : 'unreadable' })
      continue
    }

    // The source is hashed in the same domain as the copy, so an unchanged
    // asset digests equal to the record and costs one read, no write.
    const sourceDigest = await digestClientAsset(asset.source)
    if (sourceDigest === onDisk) {
      outcome.unchanged += 1
      continue
    }
    // A source that cannot be read (a package mid-replacement, a plugin whose
    // files are gone) is not a changed source: nothing is copied and nothing
    // is touched, and the next boot asks again.
    if (!sourceDigest) {
      stderr?.write(`warning: ${asset.kind} '${asset.name}' for ${client} could not be refreshed: source ${asset.source} is unreadable\n`)
      getLogger('client-assets').warn('client_assets.refresh_failed', {
        [Attr.COMPONENT]: 'client-assets',
        [Attr.OPERATION]: 'client_assets.refresh',
        hyp_client: client,
        [Attr.STATUS]: 'error',
        [Attr.ERROR_KIND]: 'source_unreadable',
        detail: dest,
      })
      outcome.skipped.push({ kind: asset.kind, name: asset.name, client, dest, reason: 'copy_failed' })
      continue
    }

    try {
      await replaceAsset(asset, dest)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      stderr?.write(`warning: ${asset.kind} '${asset.name}' for ${client} could not be refreshed: ${message}\n`)
      getLogger('client-assets').warn('client_assets.refresh_failed', {
        [Attr.COMPONENT]: 'client-assets',
        [Attr.OPERATION]: 'client_assets.refresh',
        hyp_client: client,
        [Attr.STATUS]: 'error',
        [Attr.ERROR_KIND]: 'asset_copy_failed',
        detail: dest,
      })
      outcome.skipped.push({ kind: asset.kind, name: asset.name, client, dest, reason: 'copy_failed' })
      continue
    }
    const digest = await digestClientAsset(dest)
    if (digest) {
      rewritten.set(dest, digest)
    } else {
      // The bytes landed but the record cannot follow them, which is the same
      // degraded state a failed ledger write leaves below: from the next boot
      // on, the copy this pass just wrote matches no recorded digest and is
      // reported as a user edit. Say so, or the only trace is a summary line
      // claiming the refresh succeeded.
      getLogger('client-assets').warn('client_assets.refresh_digest_unread', {
        [Attr.COMPONENT]: 'client-assets',
        [Attr.OPERATION]: 'client_assets.refresh',
        hyp_client: client,
        [Attr.STATUS]: 'error',
        [Attr.ERROR_KIND]: 'digest_unreadable',
        detail: dest,
      })
    }
    outcome.refreshed.push({ kind: asset.kind, name: asset.name, client, dest })
  }

  if (rewritten.size > 0) {
    // Every record naming a rewritten path takes the new digest, whichever
    // client it belongs to, or the next run would read the other client's
    // record as a user edit.
    const wrote = await writeClientAssetLedger(stateRoot, ledger.map((record) => {
      const digest = rewritten.get(record.dest)
      return digest ? { ...record, digest } : record
    }))
    // A ledger we could not write costs an install nothing, but it costs a
    // refresh the file it just rewrote: the records still name the bytes this
    // pass replaced, so from the next boot on HypAware's own copy matches no
    // recorded digest and is reported as a user edit forever. Say so here,
    // because the write itself swallows the error and nothing downstream can
    // tell that "edited" was our own doing.
    if (!wrote) {
      getLogger('client-assets').warn('client_assets.refresh_ledger_unwritten', {
        [Attr.COMPONENT]: 'client-assets',
        [Attr.OPERATION]: 'client_assets.refresh',
        [Attr.STATUS]: 'error',
        [Attr.ERROR_KIND]: 'ledger_write_failed',
        detail: stateRoot,
      })
    }
  }
  return outcome
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
        reason:
          "resolves outside this client's asset directories, or deeper into them than HypAware " +
          'writes; refusing to remove',
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
 * 2. **No client contributes the path any more** - it is retired, not merely
 *    a copy that failed, and not a path another client is contributing to.
 *    Destinations are physical paths and two clients can declare the same asset
 *    directory (`claude` and `claude-desktop` both declare `.claude/skills`),
 *    so the question is asked of every client's contributions, re-planned here
 *    with `clients: 'all'`, and never of the scoped run's own share of them
 *    (LLP 0288 #candidacy-is-asked-of-every-client).
 * 3. **It is a direct child of one of this client's own asset directories** -
 *    the exact shape the copy side writes, and no deeper - checked here and
 *    again by {@link removeClientAssets}, whose input is persisted JSON either
 *    way.
 * 4. **The bytes are still the bytes we wrote**: the recorded digest matches
 *    what is on disk *now*. No recorded digest is not a match. A mismatch, or
 *    an absence, is the end of the evidence and the removal becomes a report
 *    (LLP 0219 #edited-assets-are-not-ours) - as does a copy we could not read
 *    at all, which is the one case that is neither a match nor a path that has
 *    already gone (LLP 0219 #unreadable-is-not-absent).
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
 *   installed: ClientAssetInstall[],
 * }} args
 * @returns {Promise<{ pruned: ClientAssetRemoval[], withheld: ClientAssetRemoval[] }>}
 * @ref LLP 0219#prune-on-materialize [implements]: the one materializer removes
 *   what this version no longer contributes, gated on its own install record.
 */
async function reconcileClientAssetLedger({ options, installed }) {
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

  // Every destination **any** client's contributions name, not only the ones
  // this run was scoped to install. A dest is a physical path, two clients can
  // share an asset directory, and every install path is client-scoped: the
  // reconciler's attach always passes `clients: [client]`, and `--client` does
  // the same by hand. Asked of the scoped run's plan, a path only
  // `claude-desktop` contributes is absent from a `claude` run's plan and so
  // reads as retired under `claude`'s record, and the prune deletes a copy
  // another client is contributing right now. Nothing re-copies it: the other
  // client's `assets_key` did not change, so `isCurrent()` still says its attach
  // is fresh and the deleted asset stays gone.
  //
  // Re-planning with `clients: 'all'` asks the retirement question of the same
  // live registries the scoped plan came from, so "retired" means "no client
  // contributes this path any more" rather than "this pass was not asked to".
  // Pure, no disk, and `stderr` is dropped because the scoped plan already
  // wrote whatever warnings it had to write.
  // @ref LLP 0288#candidacy-is-asked-of-every-client [implements]: retirement is
  //   a fact about a destination, so it is asked of every contribution, never of
  //   the share of the plan one scoped run happened to carry.
  const keepAll = new Set(planClientAssets({ ...options, clients: 'all', stderr: undefined }).map(({ dest }) => dest))

  // Every digest the ledger records **for a physical path**, whoever's record
  // holds it. The ledger is keyed on `(client, dest)` because one path
  // legitimately belongs to two clients at once, and that keying is what makes
  // a record go stale: a `claude-desktop`-scoped run rewrites
  // `~/.claude/skills/<name>` and re-records only its own digest, while the
  // `claude` record keeps the digest of bytes that are no longer there. Asked
  // of one record, the evidence gate below then reads HypAware's own rewrite as
  // the user taking the file over, and reports it that way.
  //
  // Which client's record carries the proof is an artifact of the key, not a
  // fact about the bytes: a digest recorded against a path says HypAware wrote
  // those bytes there, and that is the whole of what the gate needs to know.
  // So the digests are indexed by dest and asked as a set. This adds no
  // evidence the ledger did not already hold and re-records none - a path with
  // no recorded digest at all still fails the gate, exactly as before.
  // @ref LLP 0284#digests-are-per-path [implements]: the evidence gate matches
  //   the bytes against every digest recorded for that path, not only against
  //   the record whose client this pass happens to be walking.
  /** @type {Map<string, Set<string>>} */
  const recordedDigests = new Map()
  for (const record of ledger) {
    if (!record.digest) continue
    const known = recordedDigests.get(record.dest)
    if (known) known.add(record.digest)
    else recordedDigests.set(record.dest, new Set([record.digest]))
  }

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
        const outcome = await pruneOneAsset({
          dest,
          record,
          recorded: recordedDigests.get(dest) ?? EMPTY_DIGESTS,
          client,
          baseDirs,
          dryRun,
          stdout,
          stderr,
        })
        if (outcome.carried) next.push(outcome.carried)
        if (outcome.removal) (outcome.removed ? pruned : withheld).push(outcome.removal)
      }

      // A planned copy that failed is not retired and not re-recorded: keep the
      // record of the copy that is still sitting there from last time, or the
      // next run would read the path as never ours and leave it forever.
      //
      // Asked of **every client's** contributions, exactly as the candidate
      // loop above is, and for the same reason: a dest is a physical path and
      // two clients can share an asset directory. Asked of this client's share
      // alone, a dest that moved to another client whose copy failed is neither
      // a candidate (the plan contains it) nor carried (this client no longer
      // plans it), so
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
 *   recorded: Set<string>,
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
async function pruneOneAsset({ dest, record, recorded, client, baseDirs, dryRun, stdout, stderr }) {
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
        'directories, or deeper into them than HypAware writes; refusing to remove it - ' +
        'check the install record\n'
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

  const { digest, missing } = await inspectClientAsset(dest)
  // Already gone (removed by hand, or by an earlier pass whose ledger write
  // lost the race). Nothing to report and nothing left to record.
  if (missing) return { carried: undefined, removed: false }

  // Still there, and we could not read it: an `EACCES` on a file inside the
  // installed skill, a device error, a directory whose mode changed. Dropping
  // the record here (which is what reading "no digest" as "already gone" does)
  // takes away the only thing naming the path, and the copy becomes both
  // unprunable and unreportable forever - the leave-behind LLP 0219 exists to
  // end. So the record is carried **verbatim**: no digest is taken of what we
  // could not read, which keeps a later run's removal gated on the digest
  // recorded when we wrote the bytes and on nothing this run inferred.
  // @ref LLP 0226#unreadable-is-not-absent [implements]: unreadable is reported
  //   and kept, never mistaken for absent.
  if (!digest) {
    stderr?.write(
      `warning: retired ${kind} '${name}' at ${dest} could not be read to check whether the bytes are ` +
        'still ours; left in place - check its permissions\n'
    )
    getLogger('client-assets').warn('client_assets.prune_withheld', {
      [Attr.COMPONENT]: 'client-assets',
      [Attr.OPERATION]: 'client_assets.prune',
      hyp_client: client,
      [Attr.STATUS]: 'ok',
      [Attr.ERROR_KIND]: 'digest_unreadable',
      detail: dest,
    })
    return { carried: record, removed: false, removal }
  }

  // The user's own edit outranks the retirement. Overwriting a *contributed*
  // asset's edits is a documented part of `hyp skills install` (the copy is
  // idempotent replace, and the source is right there to re-copy from); a
  // retired asset has no source left, so a delete here is unrecoverable. Name
  // it and leave it: the file stays visible, and the record stays, so the same
  // report reappears until the user acts on it.
  //
  // A candidate no digest was ever recorded for takes the same exit, and that is
  // the whole of the marker's demotion from a deletion source to a reporting one.
  // The marker records paths, never bytes, and `installed_assets` is unioned
  // across every rewrite and never shrinks, so a path that appears there once
  // is a candidate forever - including after HypAware itself removed it and the
  // user later authored something of their own under that name. Absence of
  // evidence is not evidence, so it may not read as a match.
  // @ref LLP 0219#edited-assets-are-not-ours [implements]: the removal proceeds
  //   only on a recorded digest that still matches; anything else is a report.
  if (!recorded.has(digest)) {
    const reason = recorded.size > 0
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
      [Attr.ERROR_KIND]: recorded.size > 0 ? 'asset_modified' : 'digest_unrecorded',
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

/**
 * The evidence about a path no digest was ever recorded for. Shared and never
 * added to: {@link pruneOneAsset} only ever asks it questions.
 *
 * @type {Set<string>}
 */
const EMPTY_DIGESTS = new Set()

/**
 * Suffixes {@link replaceAsset} hangs off a destination while it swaps a
 * refreshed copy in: the new bytes, and the copy they replace. Fixed, so a
 * refresh killed mid-swap leaves names the next one recognizes rather than
 * pid-stamped trees nothing can attribute or clean.
 */
const REFRESH_STAGE_SUFFIX = '.hyp-refresh'
const REFRESH_OLD_SUFFIX = '.hyp-refresh-old'

/** Why a removal is refused when the client has no asset directories at all. */
const NO_BASE_DIRS_REASON =
  'no asset directories resolved for this client (no home directory, or none declared); refusing to remove'

/**
 * True when `dest` is a **direct child** of one of `baseDirs`. Strictly a
 * child: a dest equal to a base is the whole skills (or agents) directory,
 * which no write this module makes can produce, so treating it as removable
 * would only ever honour a corrupted record.
 *
 * Direct, because every write this module makes is `<base>/<name>` or
 * `<base>/<name>.md` over a name that registration has already forced to a
 * single safe segment (`isSafeContributionName`). A record naming anything
 * deeper is therefore a path we did not write, and admitting it lets one entry -
 * `<skills>/<a-skill-this-run-is-installing>/subdir` - take a subtree out of a
 * live asset on no authority but the record's. The removal is recursive, so the
 * predicate has to be as narrow as the writer.
 *
 * The equality term is kept rather than folded into the `dirname` comparison:
 * `path.dirname('/')` is `'/'`, so a degenerate base would otherwise match
 * itself, and this predicate is only ever allowed to shrink.
 *
 * `isWithinDir` is kept as a conjunct alongside the `dirname` check, not
 * dropped in its favour: `isWithinDir` refuses on a **prefix** test
 * (`rel.startsWith('..')`), so a basename beginning with `..`
 * (`<base>/..stash`) is refused by it even though `path.dirname` alone would
 * admit it as a direct child. Without the conjunct, a `..`-prefixed
 * user-authored directory name that the old predicate refused becomes
 * removable, which is a widening, not the narrowing this predicate exists to
 * be.
 *
 * @param {string} dest
 * @param {string[]} baseDirs
 * @returns {boolean}
 * @ref LLP 0226#only-direct-children [implements]: the delete side admits
 *   exactly the shape the copy side writes, and nothing beneath it, without
 *   widening what the prefix-based containment check already refused.
 */
function isRemovableAsset(dest, baseDirs) {
  const resolved = path.resolve(dest)
  return baseDirs.some((baseDir) => {
    const base = path.resolve(baseDir)
    return resolved !== base && path.dirname(resolved) === base && isWithinDir(resolved, base)
  })
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

/**
 * {@link copyAsset} for a destination that already holds a copy worth keeping:
 * the new bytes are staged beside it and renamed into place, so a copy that
 * fails partway (a source tree half-replaced by an update, a read error in
 * the middle of it) leaves the installed copy exactly as it was. The
 * install-path `rm`-then-copy would leave an empty directory instead, which
 * the next refresh reads as a user edit and never repairs.
 *
 * The stage is a sibling under the same asset directory, so the rename never
 * crosses a filesystem, and it is removed on every exit but the rename.
 *
 * Both staging names are fixed rather than process-scoped, and both are
 * cleared before use. A pid in the name would make every crashed refresh leave
 * a tree the next one cannot recognize: a complete `SKILL.md` sitting in the
 * client's skills directory under a name no ledger record covers, which the
 * client loads as a second stale copy and no prune can ever remove. Fixed
 * names make the leftovers recognizable: {@link refreshClientAssets} sweeps
 * them off every destination it still finds in place, and restores the one
 * that matters rather than leaving it orphaned. Nothing races over them: the
 * refresh is the only caller, and the daemon that runs it refuses to boot
 * beside a live one.
 *
 * @param {ResolvedClientAsset} asset
 * @param {string} dest
 * @returns {Promise<void>}
 * @ref LLP 0397#refresh-never-removes [implements]: a refresh that fails
 *   leaves the copy it found, so the stage is written first and the swap is a
 *   rename.
 */
async function replaceAsset(asset, dest) {
  const stage = `${dest}${REFRESH_STAGE_SUFFIX}`
  await fs.rm(stage, { recursive: true, force: true })
  try {
    if (asset.kind === 'skill') {
      await copyDir(asset.source, stage)
      // Two renames, not one: renaming over a non-empty directory fails on
      // every platform, so the old tree steps aside first. The window between
      // them is two renames wide, and a crash inside it leaves the old copy
      // under the `.hyp-refresh-old` name rather than deleted - which is why
      // the refresh restores that name before it reads an absent `dest` as a
      // copy the user removed.
      const old = `${dest}${REFRESH_OLD_SUFFIX}`
      await fs.rm(old, { recursive: true, force: true })
      await fs.rename(dest, old)
      try {
        await fs.rename(stage, dest)
      } catch (err) {
        await fs.rename(old, dest).catch(() => {})
        throw err
      }
      // The swap already landed, so a failure to sweep the old tree is not a
      // failed refresh. Thrown, it would be reported as `copy_failed` and the
      // new digest would go unrecorded, leaving the copy just written to read
      // as a user edit on every later boot.
      await fs.rm(old, { recursive: true, force: true }).catch(() => {})
      return
    }
    await fs.copyFile(asset.source, stage)
    await fs.rename(stage, dest)
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

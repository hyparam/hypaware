// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { copyDir } from '../util/fs_copy.js'
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
 *   MaterializeClientAssetsOptions,
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
 * @param {MaterializeClientAssetsOptions} options
 * @returns {Promise<ClientAssetInstall[]>} one entry per copy actually made
 *   (or, under `dryRun`, per copy that would be made)
 */
export async function materializeClientAssets(options) {
  const { clients, descriptors, homeDir, dryRun = false, stdout, stderr } = options
  /** @type {ClientAssetInstall[]} */
  const installed = []
  if (homeDir.length === 0 || (clients !== 'all' && clients.length === 0)) return installed

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
  }
  return installed
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
 * @param {string[]} dests
 * @param {string[]} baseDirs  The directories a recorded dest must sit beneath
 *   (see {@link clientAssetBaseDirs}).
 * @returns {Promise<{ removed: string[], failed: { dest: string, reason: string }[] }>}
 * @ref LLP 0107#reversal [implements]: only marker-recorded (org-driven) copies
 *   are removed; a manual install carries no marker and survives detach.
 */
export async function removeClientAssets(dests, baseDirs) {
  /** @type {string[]} */
  const removed = []
  /** @type {{ dest: string, reason: string }[]} */
  const failed = []
  // With no base directories nothing can be contained, so every dest would be
  // refused for "resolving outside" them - naming the wrong cause. The cause is
  // that this client resolved no asset directories at all: no home directory to
  // join them onto, or a descriptor declaring neither kind.
  if (baseDirs.length === 0) {
    return { removed, failed: dests.map((dest) => ({ dest, reason: NO_BASE_DIRS_REASON })) }
  }
  for (const dest of dests) {
    if (!isRemovableAsset(dest, baseDirs)) {
      failed.push({ dest, reason: "resolves outside this client's asset directories; refusing to remove" })
      continue
    }
    try {
      await fs.rm(dest, { recursive: true, force: true })
      removed.push(dest)
    } catch (err) {
      failed.push({ dest, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { removed, failed }
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

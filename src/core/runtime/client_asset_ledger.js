// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { atomicWriteJson, readJsonIfExists } from '../util/fs_atomic.js'
import { errCode } from '../util/json_util.js'

/**
 * The record of which client-asset paths HypAware itself wrote, and of what it
 * wrote there.
 *
 * Removing a retired skill needs an answer to "did we put this here?", and
 * neither the live registries nor the filesystem can give one: the registries
 * describe what the plugin set contributes *now* (a retired skill is absent
 * from them exactly like a skill the user wrote by hand), and a directory under
 * `~/.claude/skills` carries no provenance. LLP 0138 #marker-undo already
 * settled that question for the org-driven half by recording the destinations
 * on the attach marker, and said in the same breath why the manual half was out
 * of reach: `hyp skills install` copies "record no marker". This ledger is that
 * missing record, written by the one materializer for every install path.
 *
 * It stores a content digest per destination as well as the path, because the
 * two questions a destructive upgrade has to answer are different: *did we
 * write this* (the path) and *is what is there still ours* (the digest). Only a
 * recorded digest that still matches answers the second one. A mismatch is
 * positive evidence the user took the file over; a record with no digest is no
 * evidence at all. Both stop the removal, which is why a record whose digest
 * cannot be read is dropped rather than kept digest-less.
 *
 * @ref LLP 0219#ledger [implements]: the per-home record of what HypAware
 *   installed, which is the only evidence that a no-longer-contributed path is
 *   ours to delete.
 */

/**
 * @import { Hash } from 'node:crypto'
 * @import { Stats } from 'node:fs'
 * @import { ClientAssetLedgerRecord } from '../../../src/core/runtime/types.js'
 */

/** Basename under the state root. Sibling of `config-control/`, not inside it: this is not a control-plane marker. */
const LEDGER_BASENAME = 'client-assets.json'

/** Bumped only if the record shape changes incompatibly; an unknown version reads as an empty ledger. */
const LEDGER_VERSION = 1

/**
 * Where the ledger for assets installed under `homeDir` lives.
 *
 * Anchored on the home directory the assets themselves went to, not on
 * `os.homedir()`. The ledger's whole content is paths under `homeDir`, so a run
 * installing into one home must not read (or write) the record belonging to
 * another: an entry naming a path outside the current run's asset directories
 * is refused by the containment check anyway, but resolving to the wrong file
 * in the first place turns a correct refusal into a confusing one. `HYP_HOME`
 * still wins when set, matching every other state-root reader.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} homeDir
 * @returns {string}
 */
export function clientAssetStateRoot(env, homeDir) {
  // Same two segments `readObservabilityEnv` joins (`.hyp` / `hypaware`), with
  // `homeDir` in place of its `os.homedir()`.
  const hypHome = env.HYP_HOME || path.join(homeDir.length > 0 ? homeDir : os.homedir(), '.hyp')
  return path.join(hypHome, 'hypaware')
}

/**
 * Read the ledger. A missing, unreadable, or unrecognized file reads as no
 * records at all, which makes every later step a no-op: an unreadable ledger
 * must never widen what gets deleted.
 *
 * @param {string} stateRoot
 * @returns {Promise<ClientAssetLedgerRecord[]>}
 */
export async function readClientAssetLedger(stateRoot) {
  /** @type {unknown} */
  let raw
  try {
    raw = await readJsonIfExists(path.join(stateRoot, LEDGER_BASENAME))
  } catch {
    return []
  }
  if (!raw || typeof raw !== 'object') return []
  const doc = /** @type {{ version?: unknown, assets?: unknown }} */ (raw)
  if (doc.version !== LEDGER_VERSION || !Array.isArray(doc.assets)) return []
  /** @type {ClientAssetLedgerRecord[]} */
  const records = []
  for (const entry of doc.assets) {
    if (!entry || typeof entry !== 'object') continue
    const { kind, name, client, dest, digest } = /** @type {Record<string, unknown>} */ (entry)
    if (kind !== 'skill' && kind !== 'agent') continue
    if (typeof name !== 'string' || name.length === 0) continue
    if (typeof client !== 'string' || client.length === 0) continue
    if (typeof dest !== 'string' || dest.length === 0) continue
    // A `digest` that is present but not a non-empty string is a record we
    // cannot read, and a record we cannot read is dropped whole rather than
    // kept with its digest quietly discarded. Keeping it would hand the prune a
    // digest-less candidate built out of corruption, which is the one direction
    // an unreadable ledger is never allowed to move in.
    if (digest !== undefined && (typeof digest !== 'string' || digest.length === 0)) continue
    records.push({
      kind,
      name,
      client,
      dest,
      ...(typeof digest === 'string' ? { digest } : {}),
    })
  }
  return records
}

/**
 * Replace the ledger with `records`. Best-effort: a ledger we could not write
 * costs a later prune, never an install, so the caller is not failed over it.
 *
 * Deduplicated on `(client, dest)`, which is the key the prune actually asks
 * questions by: candidates are collected per client and keyed by destination.
 * The pair, not the destination alone, because one physical path legitimately
 * belongs to two clients at once (`claude` and `claude-desktop` both declare
 * `.claude/skills`), and collapsing those would drop a record that is the only
 * thing making the copy removable later.
 *
 * @param {string} stateRoot
 * @param {ClientAssetLedgerRecord[]} records
 * @returns {Promise<boolean>} whether the write landed
 */
export async function writeClientAssetLedger(stateRoot, records) {
  /** @type {Map<string, ClientAssetLedgerRecord>} */
  const unique = new Map()
  for (const record of records) unique.set(`${record.client}\n${record.dest}`, record)
  try {
    await atomicWriteJson(
      path.join(stateRoot, LEDGER_BASENAME),
      { version: LEDGER_VERSION, assets: [...unique.values()].sort(compareRecords) },
      { mkdir: true }
    )
    return true
  } catch {
    return false
  }
}

/**
 * A content digest of an installed asset: the bytes of a subagent file, or the
 * sorted relative paths and bytes of a skill directory tree.
 *
 * Paths are hashed alongside the bytes so adding or renaming a file inside an
 * installed skill registers as a change; entries that are neither a file nor a
 * directory (a symlink someone dropped in) contribute their name only, so they
 * likewise cannot be mistaken for the tree we copied.
 *
 * **The shape is hashed before anything else.** Without it the two branches
 * write into the same unframed byte stream and produce collisions across kinds:
 * an empty directory and an empty file are both the hash of nothing, and a
 * skill tree holding one `SKILL.md` of `body\n` hashes exactly like a file whose
 * bytes are `SKILL.md\nbody\n`. Either one is enough to let a file the user
 * authored inherit a digest we recorded for something else, and the digest is
 * the last thing standing between the prune and their files. Seeding the domain
 * (and marking each tree entry's own shape) makes the two spaces disjoint.
 *
 * @param {string} dest
 * @returns {Promise<string | undefined>} `undefined` when the path is gone or
 *   unreadable, which no caller may treat as a match
 * @ref LLP 0219#edited-assets-are-not-ours [implements]: a digest may only match
 *   what we actually wrote, so file-shaped and directory-shaped content are
 *   hashed in separate domains.
 */
export async function digestClientAsset(dest) {
  return (await inspectClientAsset(dest)).digest
}

/**
 * {@link digestClientAsset}, plus the one thing a caller that deletes needs and
 * a digest alone cannot say: whether "no digest" means the path is **gone** or
 * merely **unreadable**.
 *
 * The two are opposite facts about a retired asset. Gone is the end of the
 * story: there is nothing to remove and nothing to tell anyone about. Unreadable
 * (an `EACCES` on a file inside an installed skill, a device error, a directory
 * whose permissions changed) means the copy is still sitting there, still
 * model-invocable, and still ours to name later - so its record has to survive
 * and the user has to hear about it. Collapsing the second into the first drops
 * the only record naming the path, and the leave-behind becomes permanent and
 * silent, which is the failure LLP 0219 exists to end.
 *
 * Only `ENOENT` counts as gone. Every other errno carries the record forward,
 * because the safe direction of a wrong guess here is "remove less, report
 * more".
 *
 * The `missing` outcome is scoped to the top-level probe: `fs.stat(dest)` is
 * its own `try`, and only *that* call's `ENOENT` sets `missing`. A dangling
 * symlink *at* `dest` is this case: `fs.stat` follows it, finds nothing, and
 * `ENOENT` is exactly right there. Anything thrown while walking a directory
 * or reading a file (an `EACCES` three levels into a skill tree, a device
 * error, a file `readdir` just listed that a concurrent actor removes before
 * the following `readFile` reaches it) falls into a second, narrower `try`
 * that always reports `missing: false`, so a failure below `dest` can never
 * be mistaken for `dest` itself being gone. A dangling symlink *inside* the
 * tree never reaches either `try`'s error path at all: `hashTree` reads
 * `Dirent` shape from `readdir` without following the entry, so a symlink
 * whose target is gone hashes as an opaque `o:` entry by name, the same as
 * one whose target exists.
 *
 * @param {string} dest
 * @returns {Promise<{ digest?: string, missing: boolean }>} `missing` is true
 *   only for a path that is not there; a digest is present only when the whole
 *   asset was read
 * @ref LLP 0227#unreadable-is-not-absent [implements]: an unreadable asset is
 *   reported and kept on the books, never read as one that is already gone,
 *   including when the read failure happens below `dest` rather than at it.
 */
export async function inspectClientAsset(dest) {
  /** @type {Stats} */
  let stat
  try {
    stat = await fs.stat(dest)
  } catch (err) {
    return { missing: errCode(err) === 'ENOENT' }
  }
  const hash = createHash('sha256')
  try {
    if (stat.isDirectory()) {
      hash.update('dir\n')
      await hashTree(dest, dest, hash)
    } else {
      hash.update('file\n')
      hash.update(await fs.readFile(dest))
    }
  } catch {
    return { missing: false }
  }
  return { digest: hash.digest('hex'), missing: false }
}

/* ------------------------------- Internals ------------------------------- */

/**
 * @param {string} root
 * @param {string} dir
 * @param {Hash} hash
 * @returns {Promise<void>}
 */
async function hashTree(root, dir, hash) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    // The entry's shape leads its path, so a subdirectory named `x` and a file
    // named `x` cannot hash alike, and a file's bytes can never be read back as
    // the tree that would have followed a directory of the same name.
    hash.update(`${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'o'}:${path.relative(root, full)}\n`)
    if (entry.isDirectory()) await hashTree(root, full, hash)
    else if (entry.isFile()) hash.update(await fs.readFile(full))
  }
}

/**
 * @param {ClientAssetLedgerRecord} a
 * @param {ClientAssetLedgerRecord} b
 * @returns {number}
 */
function compareRecords(a, b) {
  return a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0
}

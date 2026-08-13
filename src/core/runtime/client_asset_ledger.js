// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { atomicWriteJson, readJsonIfExists } from '../util/fs_atomic.js'

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
 * write this* (the path) and *is what is there still ours* (the digest). A
 * digest that no longer matches is positive evidence the user edited or
 * replaced the file, which is the one case pruning must not act on.
 *
 * @ref LLP 0218#ledger [implements]: the per-home record of what HypAware
 *   installed, which is the only evidence that a no-longer-contributed path is
 *   ours to delete.
 */

/**
 * @import { Hash } from 'node:crypto'
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
    records.push({
      kind,
      name,
      client,
      dest,
      ...(typeof digest === 'string' && digest.length > 0 ? { digest } : {}),
    })
  }
  return records
}

/**
 * Replace the ledger with `records`. Best-effort: a ledger we could not write
 * costs a later prune, never an install, so the caller is not failed over it.
 *
 * @param {string} stateRoot
 * @param {ClientAssetLedgerRecord[]} records
 * @returns {Promise<boolean>} whether the write landed
 */
export async function writeClientAssetLedger(stateRoot, records) {
  try {
    await atomicWriteJson(
      path.join(stateRoot, LEDGER_BASENAME),
      { version: LEDGER_VERSION, assets: [...records].sort(compareRecords) },
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
 * @param {string} dest
 * @returns {Promise<string | undefined>} `undefined` when the path is gone or
 *   unreadable, which no caller may treat as a match
 */
export async function digestClientAsset(dest) {
  const hash = createHash('sha256')
  try {
    const stat = await fs.stat(dest)
    if (stat.isDirectory()) await hashTree(dest, dest, hash)
    else hash.update(await fs.readFile(dest))
  } catch {
    return undefined
  }
  return hash.digest('hex')
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
    hash.update(`${path.relative(root, full)}\n`)
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

// @ts-check

// A self-update rewrites the skill sources inside the package and restarts the
// daemon, and nothing re-read the copies under `~/.claude` / `~/.codex` until
// the user ran `hyp skills install`. The booted daemon now refreshes the copies
// the install ledger says are ours whose source bytes changed (LLP 0397). Each
// test here installs through the real materializer, moves the source or the
// copy, and runs the refresh over the same temp home.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { clientAssetStateRoot, digestClientAsset, readClientAssetLedger } from '../../src/core/runtime/client_asset_ledger.js'
import { compareStrings } from '../../src/core/util/compare_strings.js'
import { materializeClientAssets, refreshClientAssets } from '../../src/core/runtime/client_assets.js'

/** @import { ClientDescriptor } from '../../src/core/types.js' */

/** @type {Map<string, ClientDescriptor>} */
const descriptors = new Map([
  ['claude', /** @type {any} */ ({ name: 'claude', skillDir: '.claude/skills', agentDir: '.claude/agents' })],
  ['codex', /** @type {any} */ ({ name: 'codex', skillDir: '.codex/skills' })],
  // A second client whose skills land in claude's directory: the shared-dest
  // shape LLP 0284 is about.
  ['twin', /** @type {any} */ ({ name: 'twin', skillDir: '.claude/skills' })],
])

/** @returns {Promise<{ home: string, env: NodeJS.ProcessEnv, stateRoot: string }>} */
async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hypaware-refresh-'))
  const env = { HOME: home, HYP_HOME: path.join(home, '.hyp') }
  return { home, env, stateRoot: clientAssetStateRoot(env, home) }
}

/**
 * @param {string} root
 * @param {string} name
 * @param {string} body
 * @returns {Promise<string>}
 */
async function writeSkillSource(root, name, body) {
  const dir = path.join(root, 'sources', name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), body, 'utf8')
  return dir
}

/**
 * @param {{ name: string, sourceDir: string, clients?: string[] }[]} skills
 * @param {{ name: string, sourceFile: string, clients?: string[] }[]} [agents]
 */
function registries(skills, agents = []) {
  return {
    skills: { list: () => skills.map((s) => ({ name: s.name, clients: s.clients ?? ['claude'], sourceDir: s.sourceDir })) },
    agents: { list: () => agents.map((a) => ({ name: a.name, clients: a.clients ?? ['claude'], sourceFile: a.sourceFile })) },
  }
}

function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    /** @param {string} chunk */
    write(chunk) { chunks.push(chunk); return true },
    text: () => chunks.join(''),
  }
}

/**
 * @param {ReturnType<typeof makeHome> extends Promise<infer H> ? H : never} h
 * @param {ReturnType<typeof registries>} regs
 * @param {string[] | 'all'} [clients]
 */
async function install(h, regs, clients = ['claude']) {
  return materializeClientAssets({ clients, descriptors, homeDir: h.home, stateRoot: h.stateRoot, ...regs })
}

/**
 * @param {ReturnType<typeof makeHome> extends Promise<infer H> ? H : never} h
 * @param {ReturnType<typeof registries>} regs
 */
async function refresh(h, regs) {
  const stderr = makeBuf()
  const outcome = await refreshClientAssets({ descriptors, homeDir: h.home, stateRoot: h.stateRoot, ...regs, stderr })
  return { ...outcome, stderr: stderr.text() }
}

/** @param {string} p */
async function exists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

test('refresh with no ledger installs nothing', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const out = await refresh(h, registries([{ name: 'alpha', sourceDir: src }]))
  assert.deepEqual(out.refreshed, [])
  assert.deepEqual(out.skipped, [])
  assert.equal(out.unchanged, 0)
  assert.equal(await exists(path.join(h.home, '.claude/skills/alpha')), false)
})

test('an unchanged source is read and left alone', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const before = await readClientAssetLedger(h.stateRoot)
  // A rewrite of the ledger produces byte-identical content here, so the
  // records alone cannot say whether the pass wrote. Backdating the file makes
  // the write itself visible: healing rides the one post-loop write and must
  // not arm it on the copies that already match their record, or every steady
  // state boot rewrites the ledger for nothing (LLP 0400 #one-write).
  const ledgerPath = path.join(h.stateRoot, 'client-assets.json')
  await fs.utimes(ledgerPath, new Date(0), new Date(0))

  const out = await refresh(h, regs)
  assert.equal(out.unchanged, 1)
  assert.equal(out.healed, 0)
  assert.deepEqual(out.refreshed, [])
  assert.deepEqual(await readClientAssetLedger(h.stateRoot), before)
  assert.equal((await fs.stat(ledgerPath)).mtimeMs, 0)
})

test('a changed source is re-copied and the ledger digest follows it', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')

  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')
  const out = await refresh(h, regs)
  assert.equal(out.refreshed.length, 1)
  assert.equal(out.refreshed[0].dest, dest)
  assert.equal(out.stderr, '')
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'v2')
  const [record] = await readClientAssetLedger(h.stateRoot)
  assert.equal(record.digest, await digestClientAsset(dest))

  // Current again: the second pass reads and does not write.
  const again = await refresh(h, regs)
  assert.equal(again.unchanged, 1)
  assert.deepEqual(again.refreshed, [])
})

test('a source holding a symlink settles instead of re-copying on every boot', async () => {
  // `copyDir` skips a symlink, so the copy cannot hold one. Unless the digest
  // skips it too, the source never digests equal to its copy: every boot fails
  // the unchanged check, re-copies the tree, and rewrites the ledger with
  // identical content.
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  await fs.symlink('SKILL.md', path.join(src, 'alias.md'))
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')
  assert.deepEqual(await fs.readdir(dest), ['SKILL.md'])

  // Backdated, so a rewrite of identical content still shows as a write.
  const ledgerFile = path.join(h.stateRoot, 'client-assets.json')
  const backdated = new Date(Date.now() - 60_000)
  await fs.utimes(ledgerFile, backdated, backdated)
  const before = await fs.stat(ledgerFile)

  const out = await refresh(h, regs)
  assert.equal(out.unchanged, 1)
  assert.deepEqual(out.refreshed, [])
  assert.deepEqual(out.skipped, [])
  assert.equal((await fs.stat(ledgerFile)).mtimeMs, before.mtimeMs)
})

test('a copy the user edited is kept and named, even when the source moved on', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')
  await fs.writeFile(path.join(dest, 'SKILL.md'), 'mine', 'utf8')

  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')
  const out = await refresh(h, regs)
  assert.deepEqual(out.refreshed, [])
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0].reason, 'edited')
  assert.match(out.stderr, /alpha.*edited since HypAware installed it/)
  assert.match(out.stderr, /hyp skills install/)
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'mine')
})

test('a copy the user removed is not put back', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')
  await fs.rm(dest, { recursive: true })

  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')
  const out = await refresh(h, regs)
  assert.deepEqual(out.refreshed, [])
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0].reason, 'missing')
  assert.equal(out.stderr, '')
  assert.equal(await exists(dest), false)
})

test('a client with no ledger record gets nothing installed', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  // Registered for both clients, installed for claude only.
  const regs = registries([{ name: 'alpha', sourceDir: src, clients: ['claude', 'codex'] }])
  await install(h, regs, ['claude'])

  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')
  const out = await refresh(h, regs)
  assert.equal(out.refreshed.length, 1)
  assert.equal(out.refreshed[0].client, 'claude')
  assert.equal(await exists(path.join(h.home, '.codex/skills/alpha')), false)
})

test('two clients sharing one directory are refreshed once and both records follow', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src, clients: ['claude', 'twin'] }])
  await install(h, regs, ['claude', 'twin'])
  const dest = path.join(h.home, '.claude/skills/alpha')
  assert.equal((await readClientAssetLedger(h.stateRoot)).length, 2)

  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')
  const out = await refresh(h, regs)
  assert.equal(out.refreshed.length, 1)
  assert.deepEqual(out.skipped, [])
  const digest = await digestClientAsset(dest)
  for (const record of await readClientAssetLedger(h.stateRoot)) {
    assert.equal(record.dest, dest)
    assert.equal(record.digest, digest)
  }
  const again = await refresh(h, regs)
  assert.deepEqual(again.skipped, [])
  assert.deepEqual(again.refreshed, [])
})

test('an agent file refreshes the same way as a skill directory', async () => {
  const h = await makeHome()
  const sourceFile = path.join(h.home, 'sources', 'helper.md')
  await fs.mkdir(path.dirname(sourceFile), { recursive: true })
  await fs.writeFile(sourceFile, 'v1', 'utf8')
  const regs = registries([], [{ name: 'helper', sourceFile }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/agents/helper.md')

  await fs.writeFile(sourceFile, 'v2', 'utf8')
  const out = await refresh(h, regs)
  assert.equal(out.refreshed.length, 1)
  assert.equal(out.refreshed[0].kind, 'agent')
  assert.equal(await fs.readFile(dest, 'utf8'), 'v2')
})

test('a source that cannot be read leaves the installed copy byte-for-byte as it was', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')
  const [before] = await readClientAssetLedger(h.stateRoot)

  // A package mid-replacement: the source is gone. Its digest cannot be
  // taken, so nothing is staged and nothing is touched.
  await fs.rm(src, { recursive: true })
  const out = await refresh(h, regs)
  assert.deepEqual(out.refreshed, [])
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0].reason, 'copy_failed')
  assert.match(out.stderr, /could not be refreshed/)
  const [after] = await readClientAssetLedger(h.stateRoot)
  assert.deepEqual(after, before)
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'v1')

  // The next boot must not read the untouched copy as a user edit.
  const again = await refresh(h, regs)
  assert.equal(again.skipped[0]?.reason, 'copy_failed')
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'v1')
})

test('a copy that fails partway leaves the installed copy in place and no stage behind', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')

  // The source digests fine and differs from the copy, so a rewrite is due,
  // but the stage cannot be created: the asset directory is read-only. An
  // unstaged remove-then-copy would have deleted the copy before finding out.
  if (process.getuid?.() === 0) return // root writes anywhere; nothing to prove here
  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')
  const skillsDir = path.dirname(dest)
  await fs.chmod(skillsDir, 0o555)
  let out
  try {
    out = await refresh(h, regs)
  } finally {
    await fs.chmod(skillsDir, 0o755)
  }
  assert.deepEqual(out.refreshed, [])
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0].reason, 'copy_failed')
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'v1')
  const siblings = await fs.readdir(path.dirname(dest))
  assert.deepEqual(siblings, ['alpha'], 'no stage or old-copy directory is left beside the asset')
})

test('a successful refresh leaves no stage beside the asset', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')
  await refresh(h, regs)
  assert.deepEqual(await fs.readdir(path.join(h.home, '.claude/skills')), ['alpha'])
})

test('a refresh killed between the two renames restores the copy it stepped aside', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')

  // Exactly what a SIGKILL between `fs.rename(dest, old)` and
  // `fs.rename(stage, dest)` leaves behind. Read as `missing`, the copy would
  // be skipped on this boot and every boot after it, and the installed skill
  // would be gone for good.
  await fs.rename(dest, `${dest}.hyp-refresh-old`)
  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')

  const out = await refresh(h, regs)
  assert.deepEqual(out.skipped, [])
  assert.equal(out.refreshed.length, 1)
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'v2')
  assert.deepEqual(await fs.readdir(path.dirname(dest)), ['alpha'], 'nothing is left beside the asset')
})

test('a destination the user removed is still not put back when no stage sits beside it', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')
  await fs.rm(dest, { recursive: true })

  const out = await refresh(h, regs)
  assert.equal(out.skipped[0]?.reason, 'missing')
  assert.equal(await exists(dest), false)
})

test('a stage left by a crashed refresh is cleared rather than accumulating', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')

  // A tree left mid-copy by an earlier boot. It carries a complete SKILL.md,
  // so left in place the client would load it as a second, stale copy of the
  // same skill and no prune could ever remove it (no ledger record names it).
  await fs.mkdir(`${dest}.hyp-refresh`, { recursive: true })
  await fs.writeFile(path.join(`${dest}.hyp-refresh`, 'SKILL.md'), 'half-written', 'utf8')
  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')

  const out = await refresh(h, regs)
  assert.equal(out.refreshed.length, 1)
  assert.deepEqual(await fs.readdir(path.dirname(dest)), ['alpha'])
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'v2')
})

test('a copy that cannot be read is not reported to the user as one they edited', async () => {
  if (process.getuid?.() === 0) return // root reads anything
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')

  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')
  await fs.chmod(path.join(dest, 'SKILL.md'), 0o000)
  let out
  try {
    out = await refresh(h, regs)
  } finally {
    await fs.chmod(path.join(dest, 'SKILL.md'), 0o644)
  }
  assert.equal(out.skipped[0]?.reason, 'unreadable')
  assert.match(out.stderr, /could not be read/)
  assert.doesNotMatch(out.stderr, /has been edited/)
})

test('staging leftovers are swept even when the source never changes again', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')

  // A stage abandoned inside `copyDir`, and a copy stepped aside by a swap
  // whose closing sweep failed. Both are complete skill directories the client
  // would load as a second stale copy of `alpha`, and no ledger record names
  // either, so no prune can ever remove them. `replaceAsset` clears them only
  // on a boot that rewrites this asset, and the source here never changes.
  for (const suffix of ['.hyp-refresh', '.hyp-refresh-old']) {
    await fs.mkdir(`${dest}${suffix}`, { recursive: true })
    await fs.writeFile(path.join(`${dest}${suffix}`, 'SKILL.md'), 'stale', 'utf8')
  }

  const out = await refresh(h, regs)
  assert.equal(out.unchanged, 1)
  assert.deepEqual(await fs.readdir(path.dirname(dest)), ['alpha'])
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'v1')
})

test('a copy the user deleted is not resurrected by a leftover an earlier boot left', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')

  // The swap landed but its closing `fs.rm` did not, so the copy it replaced
  // is still sitting beside the destination when the boot ends.
  await fs.mkdir(`${dest}.hyp-refresh-old`, { recursive: true })
  await fs.writeFile(path.join(`${dest}.hyp-refresh-old`, 'SKILL.md'), 'v0-stale', 'utf8')
  await refresh(h, regs)

  // Only now does the user remove the skill. The next boot must read that as
  // the choice it is, not restore the tree the earlier boot failed to sweep.
  await fs.rm(dest, { recursive: true })
  const out = await refresh(h, regs)
  assert.equal(out.skipped[0]?.reason, 'missing')
  assert.equal(await exists(dest), false)
})

test('a refresh killed before the ledger write heals its own record on the next boot', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')
  const [stale] = await readClientAssetLedger(h.stateRoot)

  // Exactly what a SIGKILL after `replaceAsset` swapped the new bytes in but
  // before the one ledger write lands: the copy on disk is the new source, the
  // record still names the bytes the pass replaced. Read as an edit, the copy
  // is reported as the user's on this boot and on every boot after it, never
  // refreshed again and never prunable when the asset retires.
  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')
  await fs.rm(dest, { recursive: true })
  await fs.cp(src, dest, { recursive: true })

  const out = await refresh(h, regs)
  assert.deepEqual(out.skipped, [])
  assert.deepEqual(out.refreshed, [])
  assert.equal(out.unchanged, 1)
  // Counted as a heal as well, or the one boot that rewrites the ledger
  // without rewriting a copy is the one boot the daemon log says nothing
  // about: its caller has nothing else to tell it from a no-op pass.
  assert.equal(out.healed, 1)
  assert.equal(out.stderr, '')
  const [healed] = await readClientAssetLedger(h.stateRoot)
  assert.notEqual(healed.digest, stale.digest)
  assert.equal(healed.digest, await digestClientAsset(dest))

  // The record is evidence again, not merely un-warned: the next source move
  // is copied on that record rather than skipped as an edit.
  await fs.writeFile(path.join(src, 'SKILL.md'), 'v3', 'utf8')
  const again = await refresh(h, regs)
  assert.equal(again.refreshed.length, 1)
  assert.deepEqual(again.skipped, [])
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'v3')
})

/**
 * The digest a released hasher produced for a skill tree, before each entry
 * framed the length of its path and of its bytes (LLP 0402). Spelled out here
 * rather than derived from the shipped hasher: the migration's premise is that
 * a ledger written by the previous release no longer matches, and a stale value
 * taken from the current code would agree with itself whatever the code does.
 *
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function previousReleaseDigest(dir) {
  const hash = createHash('sha256')
  hash.update('dir\n')
  /** @param {string} at */
  const walk = async (at) => {
    const entries = await fs.readdir(at, { withFileTypes: true })
    entries.sort((a, b) => compareStrings(a.name, b.name))
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue
      const full = path.join(at, entry.name)
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${path.relative(dir, full)}\n`)
      if (entry.isDirectory()) await walk(full)
      else hash.update(await fs.readFile(full))
    }
  }
  await walk(dir)
  return hash.digest('hex')
}

/**
 * Rewrite every record's digest to `digest`, which is what a `client-assets.json`
 * left by the previous release holds once the hasher moves under it.
 *
 * @param {string} stateRoot
 * @param {string} digest
 */
async function backdateLedgerDigests(stateRoot, digest) {
  const file = path.join(stateRoot, 'client-assets.json')
  const doc = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const record of doc.assets) record.digest = digest
  await fs.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

// @ref LLP 0402#migration-is-the-boot-heal [tests]: the whole of the migration
//   for a ledger the framing invalidated, and the reason it needs no new field.
test('a ledger left by the previous hasher heals on the first boot instead of reporting an edit', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')

  // Exactly the upgrade: the copy on disk is untouched, and the record names
  // the same bytes under the digest the released hasher produced for them.
  const stale = await previousReleaseDigest(dest)
  assert.notEqual(stale, await digestClientAsset(dest), 'the framing has to move the digest, or there is nothing to migrate')
  await backdateLedgerDigests(h.stateRoot, stale)

  // Bytes equal to the current source are ownership evidence in their own
  // right (LLP 0400), so the first boot re-records rather than blaming the
  // user for a hasher we moved: no `asset_edited`, nothing re-copied.
  const out = await refresh(h, regs)
  assert.deepEqual(out.skipped, [])
  assert.deepEqual(out.refreshed, [])
  assert.equal(out.unchanged, 1)
  assert.equal(out.healed, 1)
  assert.equal(out.stderr, '')
  const [healed] = await readClientAssetLedger(h.stateRoot)
  assert.equal(healed.digest, await digestClientAsset(dest))

  // And the record is evidence again: the next source move is copied on it
  // rather than skipped, which is what "frozen forever" would have cost.
  await fs.writeFile(path.join(src, 'SKILL.md'), 'v2', 'utf8')
  const again = await refresh(h, regs)
  assert.equal(again.refreshed.length, 1)
  assert.deepEqual(again.skipped, [])
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'v2')
})

// @ref LLP 0402#no-silent-adoption [tests]: the half of the migration that has
//   to hold, or it is worse than the collision it closed.
test('the previous hasher\'s ledger does not hand the migration a copy the user edited', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')

  // Same upgrade, except the user took the copy over first. Re-recording
  // whatever is on disk would adopt their file as ours and hand the prune a
  // matching digest for it, which is worse than the collision being closed.
  await backdateLedgerDigests(h.stateRoot, await previousReleaseDigest(dest))
  await fs.writeFile(path.join(dest, 'SKILL.md'), 'mine', 'utf8')
  const before = await readClientAssetLedger(h.stateRoot)

  const out = await refresh(h, regs)
  assert.equal(out.skipped[0]?.reason, 'edited')
  assert.equal(out.healed, 0)
  assert.deepEqual(await readClientAssetLedger(h.stateRoot), before)
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'mine')
})

test('a copy the user edited to something the source never held is still theirs', async () => {
  const h = await makeHome()
  const src = await writeSkillSource(h.home, 'alpha', 'v1')
  const regs = registries([{ name: 'alpha', sourceDir: src }])
  await install(h, regs)
  const dest = path.join(h.home, '.claude/skills/alpha')
  const [before] = await readClientAssetLedger(h.stateRoot)

  // The bytes differ from the record and from the source, so healing has no
  // claim on them: only equality with the current source is evidence.
  await fs.writeFile(path.join(dest, 'SKILL.md'), 'mine', 'utf8')
  const out = await refresh(h, regs)
  assert.equal(out.skipped[0]?.reason, 'edited')
  assert.deepEqual(await readClientAssetLedger(h.stateRoot), [before])
  assert.equal(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'mine')
})

// @ts-check

// A self-update rewrites the skill sources inside the package and restarts the
// daemon, and nothing re-read the copies under `~/.claude` / `~/.codex` until
// the user ran `hyp skills install`. The booted daemon now refreshes the copies
// the install ledger says are ours whose source bytes changed (LLP 0397). Each
// test here installs through the real materializer, moves the source or the
// copy, and runs the refresh over the same temp home.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { clientAssetStateRoot, digestClientAsset, readClientAssetLedger } from '../../src/core/runtime/client_asset_ledger.js'
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

  const out = await refresh(h, regs)
  assert.equal(out.unchanged, 1)
  assert.deepEqual(out.refreshed, [])
  assert.deepEqual(await readClientAssetLedger(h.stateRoot), before)
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

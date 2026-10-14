// @ts-check

/**
 * `hyp client skills install` places the host-neutral skill tree for every client
 * that has no host-specific copy, and the tree carries nothing Claude- or
 * Codex-only.
 *
 * @ref LLP 0494#skills [tests]: Pi, OpenCode, Cursor and OpenClaw install the one neutral tree, every file of it
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { dispatch } from '../../src/core/cli/dispatch.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'
import { NEUTRAL_SKILLS_DIR, NEUTRAL_SKILL_NAMES } from '../../hypaware-core/skills/index.js'

const workspace = fileURLToPath(new URL('../../hypaware-core/plugins-workspace/', import.meta.url))

const NEUTRAL_CLIENTS = ['pi', 'opencode', 'cursor', 'openclaw']

/** Host-specific mechanics only the claude or codex tree may name. */
const HOST_ONLY = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', '~/.claude/projects', '~/.codex/sessions', 'hypaware-analyst']

/**
 * Every file under `dir`, relative to it.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesUnder(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort()
}

/** @param {string} client */
async function skillDir(client) {
  const manifest = JSON.parse(await fs.readFile(path.join(workspace, client, 'hypaware.plugin.json'), 'utf8'))
  return manifest.contributes.client.skill_dir
}

function makeBuf() {
  let value = ''
  return {
    /** @param {unknown} chunk */
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

test('client skills install places every neutral skill file under each client skill_dir', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-neutral-skills-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const env = isolatedClientEnv(process.env, home)
  const configPath = path.join(home, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    auto_update: false,
    plugins: [
      { name: '@hypaware/ai-gateway' },
      ...NEUTRAL_CLIENTS.map((client) => ({ name: `@hypaware/${client}` })),
    ],
  }))

  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(['client', 'skills', 'install'], { stdout, stderr, env: { ...env, HYP_CONFIG: configPath } })
  assert.equal(code, 0, stderr.text())

  for (const client of NEUTRAL_CLIENTS) {
    const base = path.join(home, await skillDir(client))
    assert.deepEqual((await fs.readdir(base)).sort(), [...NEUTRAL_SKILL_NAMES].sort(), `${client}: installed skill set`)
    for (const skill of NEUTRAL_SKILL_NAMES) {
      const source = path.join(NEUTRAL_SKILLS_DIR, skill)
      const dest = path.join(base, skill)
      const files = await filesUnder(source)
      assert.deepEqual(await filesUnder(dest), files, `${client}/${skill}: installed file set`)
      for (const rel of files) {
        assert.equal(await fs.readFile(path.join(dest, rel), 'utf8'), await fs.readFile(path.join(source, rel), 'utf8'), `${client}/${skill}/${rel}`)
      }
    }
    // The reference files, not only each SKILL.md, are what a client reads on demand.
    for (const rel of [
      'hypaware-query/reports.md',
      'hypaware-report/references/analyst-task.md',
      'hypaware-report/references/querying.md',
      'hypaware-report/references/report-contract.md',
    ]) {
      await fs.access(path.join(base, rel))
    }
  }
})

test('no neutral skill file names a Claude- or Codex-only mechanism', async () => {
  for (const rel of await filesUnder(NEUTRAL_SKILLS_DIR)) {
    if (!rel.endsWith('.md')) continue
    const text = await fs.readFile(path.join(NEUTRAL_SKILLS_DIR, rel), 'utf8')
    for (const name of HOST_ONLY) assert.ok(!text.includes(name), `${rel} names ${name}`)
  }
})

test('the neutral reports reference offers the MCP status tool only when the connected MCP lists it', async () => {
  const text = (await fs.readFile(path.join(NEUTRAL_SKILLS_DIR, 'hypaware-query/reports.md'), 'utf8')).replace(/\s+/g, ' ')
  assert.match(text, /`hyp report mark`/)
  const sentences = text.split(/(?<=\.)\s/).filter((s) => s.includes('`set_recommendation_status`'))
  assert.ok(sentences.length > 0, 'reports.md must name set_recommendation_status')
  for (const sentence of sentences) {
    assert.match(sentence, /when the connected MCP lists it/, `"${sentence}" must gate the MCP tool on the connected MCP listing it`)
  }
})

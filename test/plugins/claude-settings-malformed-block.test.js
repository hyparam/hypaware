// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { attach } from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'

/**
 * Issue #454 / LLP 0163: attach has to write into `env` and `hooks`, so a
 * block that is present on disk with the wrong JSON type has to be rebuilt.
 * It used to be rebuilt *silently* - no backup, no marker record, no warning,
 * and a success exit - which destroyed a hand-edit with nothing on disk to
 * recover it from. Attach now backs the displaced value up into the
 * `_hypaware` marker's `prev_malformed`, warns, and keeps succeeding; the core
 * undo restores it.
 *
 * Both directions are pinned here. Repairing too eagerly is the bug; refusing
 * (or warning about) an ordinary file is its own bug, so the absent and
 * well-formed cases assert silence just as hard.
 *
 * @ref LLP 0163#back-up-then-repair-not-refuse [tests]: the malformed value survives on the marker and the caller is told
 * @ref LLP 0163#detach-restores-the-backup [tests]: the round trip puts the user's original content back
 */

/** @import { ClientDescriptor } from '../../src/core/types.js' */

const ATTACH = { port: 4123, version: '0.2.0', stateFile: '/abs/session-context.jsonl' }

/** @type {ClientDescriptor} */
const CLAUDE_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/claude'),
  name: 'claude',
  skillDir: 'skills/claude',
  attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
}

/**
 * Stage a fake home with `.claude/settings.json`, so the same fixture serves
 * `attach()` (which takes an explicit path) and `detachClientFromDisk()`
 * (which resolves one from the descriptor).
 *
 * @param {unknown} settings
 * @returns {Promise<{ home: string, settingsPath: string }>}
 */
async function stageHome(settings) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-malformed-'))
  const settingsPath = path.join(home, '.claude', 'settings.json')
  await fs.mkdir(path.dirname(settingsPath), { recursive: true })
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return { home, settingsPath }
}

/**
 * @param {string} settingsPath
 * @returns {Promise<Record<string, any>>}
 */
async function readSettings(settingsPath) {
  return JSON.parse(await fs.readFile(settingsPath, 'utf8'))
}

/* -------------------- malformed: back up, repair, report ------------------- */

test('attach backs a non-object env up into the marker instead of discarding it', async () => {
  // The exact shape from the report: a hand-edit that put a string where the
  // object goes. Before the fix this became `{}` with nothing recording it.
  const { home, settingsPath } = await stageHome({ env: 'ANTHROPIC_API_KEY=sk-x' })
  try {
    const result = await attach({ ...ATTACH, settingsPath })
    assert.equal(result.changed, true)

    const attached = await readSettings(settingsPath)
    // Attach still succeeded and still owns the block it needs.
    assert.equal(attached.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4123')

    // The user's content survives, verbatim, on the marker.
    assert.deepEqual(attached._hypaware.prev_malformed, { env: 'ANTHROPIC_API_KEY=sk-x' })

    // ...and the user is told, naming the path.
    const warnings = result.changed ? result.warnings ?? [] : []
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /^env was not a JSON object;/)
    assert.match(warnings[0], /prev_malformed/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('attach backs a non-array hooks.<event> up into the marker instead of discarding it', async () => {
  const { home, settingsPath } = await stageHome({
    hooks: { SessionStart: 'echo mine', PreToolUse: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] },
  })
  try {
    const result = await attach({ ...ATTACH, settingsPath })

    const attached = await readSettings(settingsPath)
    assert.deepEqual(attached._hypaware.prev_malformed, { 'hooks.SessionStart': 'echo mine' })
    // The managed hooks were still installed on the rebuilt event.
    assert.ok(Array.isArray(attached.hooks.SessionStart))
    assert.ok(attached.hooks.SessionStart.length > 0)
    // An unrelated well-formed event is not touched and not reported.
    assert.deepEqual(attached.hooks.PreToolUse, [
      { hooks: [{ type: 'command', command: 'echo keep' }] },
    ])

    const warnings = result.changed ? result.warnings ?? [] : []
    assert.deepEqual(warnings.map((w) => w.split(' was not ')[0]), ['hooks.SessionStart'])
    assert.match(warnings[0], /was not a JSON array;/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('attach backs up a non-object hooks root, and a null block counts as present', async () => {
  // `null` is a value the user wrote, not a missing key - JSON cannot encode
  // `undefined`, so presence is the whole absent-vs-malformed test.
  const { home, settingsPath } = await stageHome({ env: null, hooks: 7 })
  try {
    const result = await attach({ ...ATTACH, settingsPath })

    const attached = await readSettings(settingsPath)
    assert.deepEqual(attached._hypaware.prev_malformed, { env: null, hooks: 7 })
    // The rebuilt hooks root still received the managed events, so attach is
    // functional and not merely non-destructive.
    assert.ok(Array.isArray(attached.hooks.SessionStart))

    const warnings = result.changed ? result.warnings ?? [] : []
    assert.equal(warnings.length, 2)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a re-attach keeps the first attach backup and stops warning about it', async () => {
  const { home, settingsPath } = await stageHome({ env: 'ANTHROPIC_API_KEY=sk-x' })
  try {
    await attach({ ...ATTACH, settingsPath })
    // The second attach sees a well-formed `env` - the one it wrote itself -
    // so it finds nothing malformed. The record of what the *first* one
    // displaced must not fall off the marker.
    const second = await attach({ ...ATTACH, settingsPath })

    const attached = await readSettings(settingsPath)
    assert.deepEqual(attached._hypaware.prev_malformed, { env: 'ANTHROPIC_API_KEY=sk-x' })
    assert.equal('warnings' in second, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* ---------------- well-formed and absent: no repair, no noise --------------- */

test('an absent env/hooks block attaches normally, with no backup and no warning', async () => {
  const { home, settingsPath } = await stageHome({})
  try {
    const result = await attach({ ...ATTACH, settingsPath })
    assert.equal(result.changed, true)
    assert.equal('warnings' in result, false)

    const attached = await readSettings(settingsPath)
    assert.equal('prev_malformed' in attached._hypaware, false)
    assert.equal(attached.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4123')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a present, well-formed but unusual env/hooks block is updated, not backed up', async () => {
  // "Unusual" on purpose: a JSON-boolean env value, an empty event array, and
  // an event hypaware does not manage. None of it is malformed, so none of it
  // may trip the new guard.
  const { home, settingsPath } = await stageHome({
    env: { ENABLE_TOOL_SEARCH: true, MY_KEY: 'mine' },
    hooks: { SessionStart: [], Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
  })
  try {
    const result = await attach({ ...ATTACH, settingsPath })
    assert.equal('warnings' in result, false)

    const attached = await readSettings(settingsPath)
    assert.equal('prev_malformed' in attached._hypaware, false)
    // The user's own values are still there, untouched.
    assert.equal(attached.env.ENABLE_TOOL_SEARCH, true)
    assert.equal(attached.env.MY_KEY, 'mine')
    assert.deepEqual(attached.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo bye' }] }])
    // ...and attach did its job on top.
    assert.equal(attached.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4123')
    assert.ok(attached.hooks.SessionStart.length > 0)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* ------------------------------- round trip -------------------------------- */

test('detach restores the backed-up env block from the marker', async () => {
  const { home, settingsPath } = await stageHome({ env: 'ANTHROPIC_API_KEY=sk-x' })
  try {
    await attach({ ...ATTACH, settingsPath })
    const detached = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(detached.changed, true)

    const after = await readSettings(settingsPath)
    assert.equal(after.env, 'ANTHROPIC_API_KEY=sk-x')
    assert.equal('_hypaware' in after, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('detach restores a backed-up hooks.<event>, recreating the emptied hooks root', async () => {
  const { home, settingsPath } = await stageHome({ hooks: { SessionStart: 'echo mine' } })
  try {
    await attach({ ...ATTACH, settingsPath })
    const detached = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(detached.changed, true)

    // Stripping the managed hooks empties and deletes the `hooks` root, so the
    // restore has to put the parent back before it can put the value back.
    const after = await readSettings(settingsPath)
    assert.deepEqual(after.hooks, { SessionStart: 'echo mine' })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('detach leaves a backed-up path alone, and reports it, when something else is using it now', async () => {
  const { home, settingsPath } = await stageHome({ env: 'ANTHROPIC_API_KEY=sk-x' })
  try {
    await attach({ ...ATTACH, settingsPath })
    // The user adds a real key after attaching. Restoring the string backup
    // over it would destroy their newer content - the exact failure the backup
    // exists to prevent, in the other direction.
    const attached = await readSettings(settingsPath)
    attached.env.MY_KEY = 'mine'
    await fs.writeFile(settingsPath, JSON.stringify(attached, null, 2) + '\n')

    const detached = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    const after = await readSettings(settingsPath)
    assert.deepEqual(after.env, { MY_KEY: 'mine' })
    assert.match(String(detached.warning), /^env is in use again;/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('detach of an attach that displaced nothing is unchanged by the restore step', async () => {
  const { home, settingsPath } = await stageHome({ env: { ANTHROPIC_API_KEY: 'sk-x' } })
  try {
    await attach({ ...ATTACH, settingsPath })
    const detached = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })

    const after = await readSettings(settingsPath)
    assert.deepEqual(after, { env: { ANTHROPIC_API_KEY: 'sk-x' } })
    assert.equal(detached.warning, undefined)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

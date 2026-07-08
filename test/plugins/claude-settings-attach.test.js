// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { attach } from '../../hypaware-core/plugins-workspace/claude/src/settings.js'

/**
 * T1 (LLP 0045/0046): the Claude `_hypaware` marker is a self-describing
 * undo record. `attach()` records everything the format-aware core undo
 * (task 4) needs to reverse the attach from disk alone — `prev_base_url`
 * (the restore target) plus the managed `env.ANTHROPIC_BASE_URL` and the
 * managed session-context hook entries — so reverse never depends on the
 * plugin being loaded. These tests assert the marker contents directly.
 */

/** @returns {Promise<{ dir: string, settingsPath: string }>} */
async function stage() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-settings-'))
  return { dir, settingsPath: path.join(dir, 'settings.json') }
}

/**
 * @param {string} settingsPath
 * @returns {Promise<Record<string, any>>}
 */
async function readMarker(settingsPath) {
  const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
  return parsed._hypaware
}

const ATTACH = { port: 4123, version: '0.2.0', stateFile: '/abs/session-context.jsonl' }

test('attach records the managed env + hook entries into the marker undo record', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-x' } }, null, 2))

    const result = await attach({ ...ATTACH, settingsPath })
    assert.equal(result.changed, true)

    // The gateway base URL is written live, and ENABLE_TOOL_SEARCH=true is set
    // so the non-first-party base URL doesn't make Claude Code eager-load every
    // tool schema.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4123')
    assert.equal(attached.env.ENABLE_TOOL_SEARCH, 'true')

    const marker = await readMarker(settingsPath)
    // Managed env values are what we wrote — the core undo matches the live
    // value against them before removing.
    assert.deepEqual(marker.managed.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
      ENABLE_TOOL_SEARCH: 'true',
    })

    // Every managed hook spec is recorded with its command, and the
    // PostToolUse entry carries its matcher so the undo strips exactly
    // what was installed.
    const events = marker.managed.hooks.map((/** @type {any} */ h) => h.event).sort()
    assert.deepEqual(events, ['CwdChanged', 'PostToolUse', 'SessionStart', 'UserPromptSubmit'])
    for (const hook of marker.managed.hooks) {
      assert.match(hook.command, /claude-hook session-context --state-file /)
    }
    const postToolUse = marker.managed.hooks.find((/** @type {any} */ h) => h.event === 'PostToolUse')
    assert.equal(postToolUse.matcher, 'Bash')
    const sessionStart = marker.managed.hooks.find((/** @type {any} */ h) => h.event === 'SessionStart')
    assert.equal(sessionStart.matcher, undefined)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach backs up a pre-existing foreign ANTHROPIC_BASE_URL as prev_base_url', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://foreign.example/api' } }, null, 2)
    )

    const result = await attach({ ...ATTACH, settingsPath })
    assert.equal(result.changed && result.prevValue, 'https://foreign.example/api')

    const marker = await readMarker(settingsPath)
    assert.equal(marker.prev_base_url, 'https://foreign.example/api')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach omits prev_base_url when there was no pre-existing base URL', async () => {
  const { dir, settingsPath } = await stage()
  try {
    const result = await attach({ ...ATTACH, settingsPath })
    assert.equal(result.changed, true)
    assert.equal('prevValue' in result, false)

    const marker = await readMarker(settingsPath)
    assert.equal('prev_base_url' in marker, false)
    // The managed undo record is still present so the core undo can
    // remove (not restore) the gateway URL and ENABLE_TOOL_SEARCH.
    assert.deepEqual(marker.managed.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
      ENABLE_TOOL_SEARCH: 'true',
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach leaves a user-owned ENABLE_TOOL_SEARCH untouched and unmanaged', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ env: { ENABLE_TOOL_SEARCH: 'false' } }, null, 2)
    )

    await attach({ ...ATTACH, settingsPath })

    // The user's own value is respected, not overwritten, and it is not
    // recorded as ours — so detach will never remove it.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env.ENABLE_TOOL_SEARCH, 'false')

    const marker = await readMarker(settingsPath)
    assert.deepEqual(marker.managed.env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123' })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('re-attach keeps managing an ENABLE_TOOL_SEARCH it owns', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await attach({ ...ATTACH, settingsPath })
    // Our own 'true' is now live; the second attach must recognize it as ours
    // (recorded in the prior marker) and keep managing it, not mistake it for a
    // user value to leave alone.
    await attach({ ...ATTACH, settingsPath })

    const marker = await readMarker(settingsPath)
    assert.deepEqual(marker.managed.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
      ENABLE_TOOL_SEARCH: 'true',
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('idempotent re-attach keeps the original prev_base_url, not the gateway URL', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://foreign.example/api' } }, null, 2)
    )

    await attach({ ...ATTACH, settingsPath })
    const second = await attach({ ...ATTACH, settingsPath })

    // The second attach observes our gateway URL live, but must report
    // and record the *original* foreign URL — not the gateway URL.
    assert.equal(second.changed && second.prevValue, 'https://foreign.example/api')
    const marker = await readMarker(settingsPath)
    assert.equal(marker.prev_base_url, 'https://foreign.example/api')
    assert.equal(marker.managed.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4123')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('idempotent re-attach does not invent a prev_base_url when none existed', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await attach({ ...ATTACH, settingsPath })
    const second = await attach({ ...ATTACH, settingsPath })

    assert.equal('prevValue' in second, false)
    const marker = await readMarker(settingsPath)
    assert.equal('prev_base_url' in marker, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('the marker undo record is stable across re-attach (modulo attached_at)', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await attach({ ...ATTACH, settingsPath })
    const first = await readMarker(settingsPath)
    await attach({ ...ATTACH, settingsPath })
    const second = await readMarker(settingsPath)

    delete first.attached_at
    delete second.attached_at
    assert.deepEqual(second, first)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

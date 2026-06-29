// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { probeClientAttachFromDescriptor } from '../../src/core/daemon/status.js'
// Adapter helpers are used only to *build* realistic fixtures. The core undo
// under test imports no plugin code — these prove the round-trip against what
// `attach()` actually wrote (LLP 0045 §Part 3, task T4).
import { attach as claudeAttach } from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { prepareAttach as codexPrepareAttach } from '../../hypaware-core/plugins-workspace/codex/src/toml-config.js'

/**
 * T4 (LLP 0045/0046): the single core undo (= detach). `client_detach_disk.js`
 * reverses a client's attach from disk alone — the descriptor's `attachProbe`
 * plus the settings-file marker, format-aware (json marker-key / toml
 * managed-block) but plugin-agnostic. These tests run the undo with **no plugin
 * loaded** at reverse time, proving it never depends on `ctx.clients`.
 */

/** @import { ClientDescriptor } from '../../src/core/types.js' */

/** @type {ClientDescriptor} */
const CLAUDE_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/claude'),
  name: 'claude',
  skillDir: 'skills/claude',
  attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
}

/** @type {ClientDescriptor} */
const CODEX_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/codex'),
  name: 'codex',
  skillDir: 'skills/codex',
  attachProbe: { format: 'toml', settings_file: '.codex/config.toml', marker_header: '[model_providers.hypaware]' },
}

const ATTACH = { port: 4123, version: '0.2.0', stateFile: '/abs/session-context.jsonl' }

/** @returns {Promise<string>} */
async function stageHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-detach-disk-'))
}

/**
 * @param {string} home
 * @param {string} content
 * @returns {Promise<string>}
 */
async function writeClaudeSettings(home, content) {
  const p = path.join(home, '.claude', 'settings.json')
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
  return p
}

/**
 * @param {string} home
 * @param {string} content
 * @returns {Promise<string>}
 */
async function writeCodexConfig(home, content) {
  const p = path.join(home, '.codex', 'config.toml')
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
  return p
}

/* -------------------------------- claude (json) -------------------------------- */

test('claude undo restores a pre-existing foreign base URL byte-for-byte', async () => {
  const home = await stageHome()
  try {
    const original = { env: { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'https://foreign.example/api' } }
    const originalText = JSON.stringify(original, null, 2) + '\n'
    const settingsPath = await writeClaudeSettings(home, originalText)

    // Build the fixture with the real adapter (test setup only).
    await claudeAttach({ ...ATTACH, settingsPath })

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(result.restoredValue, 'https://foreign.example/api')
    assert.equal(result.settingsPath, settingsPath)

    assert.equal(await fs.readFile(settingsPath, 'utf8'), originalText)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo of a no-pre-existing-URL attach round-trips to empty', async () => {
  const home = await stageHome()
  try {
    const originalText = JSON.stringify({}, null, 2) + '\n'
    const settingsPath = await writeClaudeSettings(home, originalText)
    await claudeAttach({ ...ATTACH, settingsPath })

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(result.removed, 'http://127.0.0.1:4123')
    assert.equal('restoredValue' in result, false)

    assert.equal(await fs.readFile(settingsPath, 'utf8'), originalText)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo strips marker + managed keys/hooks from a hand-written fixture (no plugin loaded)', async () => {
  const home = await stageHome()
  try {
    const command = "hyp claude-hook session-context --state-file '/abs/session-context.jsonl'"
    const fixture = {
      env: { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123' },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command }] }],
        CwdChanged: [{ hooks: [{ type: 'command', command }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }],
      },
      _hypaware: {
        attached_at: '2026-06-26T00:00:00.000Z',
        version: '0.2.0',
        port: 4123,
        state_file: '/abs/session-context.jsonl',
        managed: {
          env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123' },
          hooks: [
            { event: 'SessionStart', command },
            { event: 'CwdChanged', command },
            { event: 'UserPromptSubmit', command },
            { event: 'PostToolUse', matcher: 'Bash', command },
          ],
        },
        prev_base_url: 'https://foreign.example/api',
      },
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(result.restoredValue, 'https://foreign.example/api')

    const raw = await fs.readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal('_hypaware' in parsed, false)
    assert.equal('hooks' in parsed, false) // every managed hook group pruned
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://foreign.example/api')
    assert.equal(parsed.env.ANTHROPIC_API_KEY, 'sk-x')
    assert.equal(raw.includes('claude-hook'), false) // no orphaned hyp hooks
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo of a LEGACY pre-upgrade marker (no managed record) detaches fully', async () => {
  const home = await stageHome()
  try {
    // The old marker shape attach wrote before the self-describing `managed`
    // undo record existed: {attached_at,version,port,state_file} only, no
    // `managed`/`prev_base_url`. Reached by a manual `hyp detach` after upgrade.
    // The undo must fall back to the original convention — remove the gateway
    // base URL, strip the `claude-hook session-context` hooks — so nothing is
    // left orphaned (deleting the marker alone is non-retryable half-reversal).
    const command = "hyp claude-hook session-context --state-file '/abs/session-context.jsonl'"
    const fixture = {
      env: { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123' },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command }] }],
        CwdChanged: [{ hooks: [{ type: 'command', command }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }],
      },
      _hypaware: {
        attached_at: '2026-06-26T00:00:00.000Z',
        version: '0.2.0',
        port: 4123,
        state_file: '/abs/session-context.jsonl',
      },
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(result.removed, 'http://127.0.0.1:4123')
    assert.equal('restoredValue' in result, false) // legacy markers recorded no prior

    const raw = await fs.readFile(settingsPath, 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal('_hypaware' in parsed, false) // marker gone
    assert.equal('ANTHROPIC_BASE_URL' in (parsed.env ?? {}), false) // no orphaned base URL
    assert.equal(parsed.env.ANTHROPIC_API_KEY, 'sk-x') // unrelated env preserved
    assert.equal('hooks' in parsed, false) // every managed hook group pruned
    assert.equal(raw.includes('claude-hook'), false) // no orphaned hyp hooks
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo of a LEGACY marker preserves a user hook and an externally-overridden base URL', async () => {
  const home = await stageHome()
  try {
    const command = "hyp claude-hook session-context --state-file '/abs/session-context.jsonl'"
    const fixture = {
      env: { ANTHROPIC_BASE_URL: 'https://someone-else.example' }, // user re-pointed it
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo hello' }] }, // user's own
          { hooks: [{ type: 'command', command }] }, // ours (legacy-installed)
        ],
      },
      _hypaware: { version: '0.2.0', port: 4123 }, // legacy shape, no managed record
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.match(String(result.warning), /overridden externally/)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal('_hypaware' in parsed, false) // marker still removed
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://someone-else.example') // user value untouched
    assert.deepEqual(parsed.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo hello' }] }])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo leaves an externally-overridden base URL in place with a warning', async () => {
  const home = await stageHome()
  try {
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({}, null, 2) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    // The user re-points the base URL after we attached.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    attached.env.ANTHROPIC_BASE_URL = 'https://someone-else.example'
    await fs.writeFile(settingsPath, JSON.stringify(attached, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.match(String(result.warning), /overridden externally/)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal('_hypaware' in parsed, false) // marker still removed
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://someone-else.example') // user value untouched
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo preserves a user-owned non-managed hook for a managed event', async () => {
  const home = await stageHome()
  try {
    const command = "hyp claude-hook session-context --state-file '/abs/session-context.jsonl'"
    const fixture = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo hello' }] }, // user's own
          { hooks: [{ type: 'command', command }] }, // ours
        ],
      },
      _hypaware: {
        version: '0.2.0',
        port: 4123,
        managed: { env: {}, hooks: [{ event: 'SessionStart', command }] },
      },
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal('_hypaware' in parsed, false)
    assert.deepEqual(parsed.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo hello' }] }])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo is a no-op when the marker is absent', async () => {
  const home = await stageHome()
  try {
    const text = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-x' } }, null, 2) + '\n'
    const settingsPath = await writeClaudeSettings(home, text)

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, false)
    assert.equal(await fs.readFile(settingsPath, 'utf8'), text) // untouched
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo is a no-op when the settings file is absent', async () => {
  const home = await stageHome()
  try {
    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* -------------------------------- codex (toml) -------------------------------- */

test('codex undo strips the managed blocks and restores model_provider byte-for-byte', async () => {
  const home = await stageHome()
  try {
    const original = 'model_provider = "openai"\n'
    const attached = codexPrepareAttach(original, 4388, '0.2.0')
    const configPath = await writeCodexConfig(home, attached.content)

    const result = await detachClientFromDisk({ descriptor: CODEX_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(result.restoredValue, 'openai')
    assert.equal(result.removed, 'http://127.0.0.1:4388/v1')
    assert.equal(result.settingsPath, configPath)

    assert.equal(await fs.readFile(configPath, 'utf8'), original)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('codex undo of a no-previous-provider attach round-trips to empty', async () => {
  const home = await stageHome()
  try {
    const attached = codexPrepareAttach('', 4388, '0.2.0')
    const configPath = await writeCodexConfig(home, attached.content)

    const result = await detachClientFromDisk({ descriptor: CODEX_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal('restoredValue' in result, false)

    assert.equal(await fs.readFile(configPath, 'utf8'), '')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('codex undo preserves unrelated config alongside the restored provider', async () => {
  const home = await stageHome()
  try {
    const original = ['model_provider = "openai"', '', '[profiles.default]', 'model = "gpt-5"', ''].join('\n')
    const attached = codexPrepareAttach(original, 4388, '0.2.0')
    const configPath = await writeCodexConfig(home, attached.content)

    await detachClientFromDisk({ descriptor: CODEX_DESCRIPTOR, homeDir: home })

    const raw = await fs.readFile(configPath, 'utf8')
    assert.equal(raw.includes('# BEGIN hypaware'), false)
    assert.equal(raw.includes('[model_providers.hypaware]'), false)
    assert.match(raw, /model_provider = "openai"/)
    assert.match(raw, /\[profiles\.default\]\nmodel = "gpt-5"/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('codex undo strips a hand-written marked block (no plugin loaded)', async () => {
  const home = await stageHome()
  try {
    const fixture = [
      '# BEGIN hypaware codex model_provider',
      '# attached_at = "2026-06-26T00:00:00.000Z"',
      '# version = "0.2.0"',
      '# port = 4388',
      '# previous_model_provider = "openai"',
      'model_provider = "hypaware"',
      '# END hypaware codex model_provider',
      '',
      '# BEGIN hypaware codex provider',
      '[model_providers.hypaware]',
      'base_url = "http://127.0.0.1:4388/v1"',
      '# END hypaware codex provider',
      '',
    ].join('\n')
    const configPath = await writeCodexConfig(home, fixture)

    const result = await detachClientFromDisk({ descriptor: CODEX_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(result.restoredValue, 'openai')
    assert.equal(result.removed, 'http://127.0.0.1:4388/v1')

    assert.equal(await fs.readFile(configPath, 'utf8'), 'model_provider = "openai"\n')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('codex undo is a no-op when no managed block is present', async () => {
  const home = await stageHome()
  try {
    const text = 'model_provider = "openai"\n'
    const configPath = await writeCodexConfig(home, text)

    const result = await detachClientFromDisk({ descriptor: CODEX_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, false)
    assert.equal(await fs.readFile(configPath, 'utf8'), text)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* ----------------------------- shared / dispatch ----------------------------- */

test('undo clears exactly what probeClientAttached detects, for both formats', async () => {
  const home = await stageHome()
  try {
    // claude
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({}, null, 2) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })
    assert.equal((await probeClientAttachFromDescriptor({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })).attached, true)
    await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal((await probeClientAttachFromDescriptor({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })).attached, false)

    // codex
    const configPath = await writeCodexConfig(home, codexPrepareAttach('model_provider = "openai"\n', 4388, '0.2.0').content)
    void configPath
    assert.equal((await probeClientAttachFromDescriptor({ descriptor: CODEX_DESCRIPTOR, homeDir: home })).attached, true)
    await detachClientFromDisk({ descriptor: CODEX_DESCRIPTOR, homeDir: home })
    assert.equal((await probeClientAttachFromDescriptor({ descriptor: CODEX_DESCRIPTOR, homeDir: home })).attached, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('undo is a no-op for a descriptor without an attachProbe', async () => {
  const result = await detachClientFromDisk({
    descriptor: { plugin: /** @type {any} */ ('@x/none'), name: 'none', skillDir: 'skills/none' },
    homeDir: await stageHome(),
  })
  assert.equal(result.changed, false)
})

/* ------------------------- atomic-write temp cleanup ------------------------- */

/**
 * An `fs` double that delegates to the real `node:fs/promises` for everything
 * except the temp-file handle's `sync()`, which throws — simulating a
 * write/fsync failure *after* the uniquely-named temp file is created but
 * *before* the final rename. Used to prove the atomic writer never orphans the
 * temp file on a partial write.
 * @returns {any}
 */
function makeSyncFailingFs() {
  return /** @type {any} */ ({
    stat: (/** @type {string} */ p) => fs.stat(p),
    readFile: (/** @type {string} */ p, /** @type {any} */ enc) => fs.readFile(p, enc),
    mkdir: (/** @type {string} */ p, /** @type {any} */ opts) => fs.mkdir(p, opts),
    rename: (/** @type {string} */ a, /** @type {string} */ b) => fs.rename(a, b),
    rm: (/** @type {string} */ p, /** @type {any} */ opts) => fs.rm(p, opts),
    async open(/** @type {string} */ p, /** @type {any} */ flags, /** @type {any} */ mode) {
      const handle = await fs.open(p, flags, mode)
      return {
        writeFile: (/** @type {any} */ data, /** @type {any} */ enc) => handle.writeFile(data, enc),
        sync: async () => { throw new Error('boom: simulated fsync failure') },
        close: () => handle.close(),
      }
    },
  })
}

test('the atomic write unlinks the temp file on a partial write — no orphaned .tmp', async () => {
  const home = await stageHome()
  try {
    const original = { env: { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'https://foreign.example/api' } }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(original, null, 2) + '\n')
    // Real self-describing marker, so the undo proceeds all the way to the write.
    await claudeAttach({ ...ATTACH, settingsPath })

    const dir = path.dirname(settingsPath)
    const before = (await fs.readdir(dir)).sort()

    // The injected fs fails the fsync — after the temp file exists, before rename.
    await assert.rejects(
      detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home, fs: makeSyncFailingFs() }),
      /simulated fsync failure/
    )

    const after = (await fs.readdir(dir)).sort()
    // No uniquely-named temp file left behind by the failed write.
    assert.equal(after.some((e) => e.endsWith('.tmp')), false, `orphaned tmp files: ${after.join(', ')}`)
    // The rename never ran, so the directory is exactly as it was pre-write.
    assert.deepEqual(after, before)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

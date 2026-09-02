// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runDetach } from '../../src/core/commands/clients.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { probeClientAttachFromDescriptor } from '../../src/core/daemon/status.js'
// Adapter helpers are used only to *build* realistic fixtures. The core undo
// under test imports no plugin code: these prove the round-trip against what
// `attach()` actually wrote (LLP 0045 §Part 3, task T4).
import { attach as claudeAttach } from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { prepareAttach as codexPrepareAttach } from '../../hypaware-core/plugins-workspace/codex/src/toml-config.js'

/**
 * T4 (LLP 0045/0046): the single core undo (= detach). `client_detach_disk.js`
 * reverses a client's attach from disk alone: the descriptor's `attachProbe`
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

test('claude undo removes managed ENABLE_TOOL_SEARCH without stamping the restored base URL onto it', async () => {
  const home = await stageHome()
  try {
    // A pre-existing foreign base URL means prev_base_url is set. Detach must
    // restore ANTHROPIC_BASE_URL to it *and* drop ENABLE_TOOL_SEARCH - never
    // apply prev_base_url to the tool-search key.
    const original = { env: { ANTHROPIC_BASE_URL: 'https://foreign.example/api' } }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(original, null, 2) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    // Sanity: the fixture the adapter wrote actually set the tool-search key.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env.ENABLE_TOOL_SEARCH, 'true')

    await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://foreign.example/api')
    assert.equal('ENABLE_TOOL_SEARCH' in parsed.env, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// Issue #448 finding 1: the ownership guard used to test the *type* of the
// existing value, so a hand-written JSON boolean/number fell through it. Attach
// coerced the value and recorded the key in `managed.env`, and this undo - doing
// exactly what the record told it - then deleted a setting the user owned. The
// round trip is the assertion that matters: the bug needed attach and detach
// together to destroy data, so the test exercises both.
test('claude attach + undo leave a non-string user-owned env value byte-for-byte intact', async () => {
  const home = await stageHome()
  try {
    // Both managed keys, hand-written as non-strings. `0` is the sharper of the
    // two: it is the user deliberately turning the flag *off*, so coercing it to
    // '1' reverses their intent before the delete even happens.
    const original = {
      env: { ENABLE_TOOL_SEARCH: true, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: 0 },
    }
    const originalText = JSON.stringify(original, null, 2) + '\n'
    const settingsPath = await writeClaudeSettings(home, originalText)

    await claudeAttach({ ...ATTACH, settingsPath })

    // Attach must not coerce a user value, and must not claim it in the undo
    // record - the marker is what authorizes the undo to delete a key.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env.ENABLE_TOOL_SEARCH, true)
    assert.equal(attached.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, 0)
    assert.deepEqual(attached._hypaware.managed.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
    })

    await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })

    // Nothing of the user's survived-by-luck: the file is exactly what they wrote.
    assert.equal(await fs.readFile(settingsPath, 'utf8'), originalText)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo removes the managed _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL', async () => {
  const home = await stageHome()
  try {
    // Issue #437: attach declares the gateway first-party so Claude Code keeps
    // the model's real context window. Detach must take that declaration back
    // out, and never stamp the restored base URL onto it.
    const original = { env: { ANTHROPIC_BASE_URL: 'https://foreign.example/api' } }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(original, null, 2) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '1')

    await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://foreign.example/api')
    assert.equal('_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL' in parsed.env, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo leaves a user-owned ENABLE_TOOL_SEARCH in place', async () => {
  const home = await stageHome()
  try {
    // The user set ENABLE_TOOL_SEARCH themselves, so attach never managed it;
    // detach must not remove it.
    const original = { env: { ENABLE_TOOL_SEARCH: 'false' } }
    const originalText = JSON.stringify(original, null, 2) + '\n'
    const settingsPath = await writeClaudeSettings(home, originalText)
    await claudeAttach({ ...ATTACH, settingsPath })

    await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })

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
          hook_entries: [
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

test('claude undo still reads the pre-2.1.257 managed.hooks field', async () => {
  const home = await stageHome()
  try {
    const command = "hyp claude-hook session-context --state-file '/abs/session-context.jsonl'"
    const fixture = {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
      _hypaware: {
        attached_at: '2026-08-31T00:00:00.000Z',
        version: '1.29.0',
        port: 4123,
        mode: 'otel',
        managed: {
          env: {},
          hooks: [{ event: 'SessionStart', command }],
        },
      },
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal('_hypaware' in parsed, false)
    assert.equal('hooks' in parsed, false)
    assert.equal((await fs.readFile(settingsPath, 'utf8')).includes('claude-hook'), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo merges hook_entries with legacy hooks in a partially migrated marker', async () => {
  const home = await stageHome()
  try {
    const oldCommand = "hyp claude-hook session-context --state-file '/abs/old.jsonl'"
    const nextCommand = "hyp claude-hook classify-cwd --state-file '/abs/new.jsonl'"
    const fixture = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: oldCommand }] },
          { hooks: [{ type: 'command', command: nextCommand }] },
        ],
      },
      _hypaware: {
        port: 4123,
        managed: {
          env: {},
          hook_entries: [{ event: 'SessionStart', command: nextCommand }],
          hooks: [
            { event: 'SessionStart', command: oldCommand },
            { event: 'SessionStart', command: nextCommand },
          ],
        },
      },
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(Object.hasOwn(parsed, '_hypaware'), false)
    assert.equal(Object.hasOwn(parsed, 'hooks'), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo decodes and restores a malformed hook backup without leaving nested marker hooks', async () => {
  const home = await stageHome()
  try {
    const prior = { hooks: [{ type: 'command', command: 'echo old' }] }
    const settingsPath = await writeClaudeSettings(
      home,
      JSON.stringify({ hooks: { SessionStart: prior } }, null, 2) + '\n'
    )
    await claudeAttach({ ...ATTACH, settingsPath })

    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached._hypaware.prev_malformed_encoding, 'json')
    assert.equal(typeof attached._hypaware.prev_malformed, 'string')
    assert.deepEqual(JSON.parse(attached._hypaware.prev_malformed), {
      'hooks.SessionStart': prior,
    })

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.deepEqual(result.restoredPaths, ['hooks.SessionStart'])
    assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), {
      hooks: { SessionStart: prior },
    })
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
    // The undo must fall back to the original convention, remove the gateway
    // base URL, strip the `claude-hook session-context` hooks, so nothing is
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
    assert.equal(result.removed, 'http://127.0.0.1:4388/backend-api/codex')
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

test('codex undo warning carries the user value verbatim, so `warning` is never splittable', async () => {
  const home = await stageHome()
  try {
    // The `toml` undo shares `DetachFromDiskResult.warning` with the two
    // ` | `-joined branches, but it emits ONE unjoined notice that interpolates
    // the live `model_provider` straight from the user's config. That value is
    // an arbitrary TOML string, so it can contain the ` | ` separator itself.
    // This pins why the field is documented display-only: no separator is safe
    // field-wide, and a consumer that split on ` | ` would invent a second
    // bogus notice out of one user value.
    const attached = codexPrepareAttach('model_provider = "openai"\n', 4388, '0.2.0')
    // The user re-points model_provider outside the managed block after we
    // attached, to an ordinary TOML value that happens to contain a pipe.
    const configPath = await writeCodexConfig(home, attached.content + 'model_provider = "acme | prod"\n')

    const result = await detachClientFromDisk({ descriptor: CODEX_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(result.warning, 'model_provider was changed externally; leaving acme | prod in place')
    // One notice, yet it splits into two - the field is not machine-readable.
    assert.equal(String(result.warning).split(' | ').length, 2)

    // The protection itself holds: the user value survives the undo untouched.
    assert.match(await fs.readFile(configPath, 'utf8'), /model_provider = "acme \| prod"/)
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
 * except the temp-file handle's `sync()`, which throws, simulating a
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

test('the atomic write unlinks the temp file on a partial write - no orphaned .tmp', async () => {
  const home = await stageHome()
  try {
    const original = { env: { ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'https://foreign.example/api' } }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(original, null, 2) + '\n')
    // Real self-describing marker, so the undo proceeds all the way to the write.
    await claudeAttach({ ...ATTACH, settingsPath })

    const dir = path.dirname(settingsPath)
    const before = (await fs.readdir(dir)).sort()

    // The injected fs fails the fsync: after the temp file exists, before rename.
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

test('claude undo names EVERY externally-overridden managed key in the warning, not just the last', async () => {
  const home = await stageHome()
  try {
    // Issue #440 finding 2: `warning` was a single reassigned string inside the
    // per-key loop, so with two managed env keys overridden only the last key's
    // notice survived and the operator was never told about the first.
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({}, null, 2) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    // The user re-points both managed keys after we attached.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env.ENABLE_TOOL_SEARCH, 'true') // attach owns it
    attached.env.ANTHROPIC_BASE_URL = 'https://someone-else.example'
    attached.env.ENABLE_TOOL_SEARCH = 'false'
    await fs.writeFile(settingsPath, JSON.stringify(attached, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    const warning = String(result.warning)
    assert.match(warning, /ANTHROPIC_BASE_URL was overridden externally/)
    assert.match(warning, /ENABLE_TOOL_SEARCH was overridden externally/)
    // The join separator is part of the contract, not an accident: each notice
    // carries its own `; `, so only a distinct ` | ` keeps the boundary between
    // two notices readable. Pin the whole string so the separator cannot drift.
    assert.equal(
      warning,
      'ANTHROPIC_BASE_URL was overridden externally; leaving in place' +
        ' | ENABLE_TOOL_SEARCH was overridden externally; leaving in place'
    )

    // The protection itself is unchanged: both user values survive the undo.
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal('_hypaware' in parsed, false)
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://someone-else.example')
    assert.equal(parsed.env.ENABLE_TOOL_SEARCH, 'false')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('claude undo reports a single overridden key without the join separator', async () => {
  const home = await stageHome()
  try {
    // The one-notice shape is unchanged by the accumulation: no trailing or
    // leading `; ` when exactly one managed key was overridden.
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({}, null, 2) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    attached.env.ANTHROPIC_BASE_URL = 'https://someone-else.example'
    await fs.writeFile(settingsPath, JSON.stringify(attached, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.warning, 'ANTHROPIC_BASE_URL was overridden externally; leaving in place')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// Issue #448 finding 1, undo side. The attach guard now decides ownership by
// presence rather than by JSON type, which makes a hand-written boolean at a
// managed key a value the tree expects to meet. The undo's override notice was
// still type-gated (`typeof current === 'string'`), so it stayed silent about
// exactly that value: the key survived the detach - correctly - but the
// operator was never told a managed key was left behind on disk.
test('claude undo reports a managed key the user overrode with a non-string', async () => {
  const home = await stageHome()
  try {
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({}, null, 2) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    // The user re-points a key attach owns, writing JSON's own `false` rather
    // than the string Claude Code reads.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env.ENABLE_TOOL_SEARCH, 'true')
    attached.env.ENABLE_TOOL_SEARCH = false
    await fs.writeFile(settingsPath, JSON.stringify(attached, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.warning, 'ENABLE_TOOL_SEARCH was overridden externally; leaving in place')

    // Never-clobber is unchanged: the user's `false` survives untouched.
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(parsed.env.ENABLE_TOOL_SEARCH, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// The other side of that predicate: presence is the test, so a managed key the
// user *deleted* is not "left in place" and must not be reported. This is why
// the notice is gated on the key still being there and not on a bare `else`.
test('claude undo stays silent about a managed key the user deleted outright', async () => {
  const home = await stageHome()
  try {
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({}, null, 2) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    delete attached.env.ENABLE_TOOL_SEARCH
    await fs.writeFile(settingsPath, JSON.stringify(attached, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal('warning' in result, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// Round 2, third instance of the same bug class, in the legacy (pre-record)
// branch of this file. `detachLegacyJsonMarker` gated its never-clobber notice
// on `typeof current === 'string'`, so a legacy marker meeting an
// ANTHROPIC_BASE_URL the user had switched off with JSON's `false`/`null` left
// the key on disk - correctly - and said nothing. Legacy markers are reversed
// by convention rather than by a record, so they are exactly the case that
// meets settings this tree never wrote.
test('claude undo of a LEGACY marker reports a base URL the user overrode with a non-string', async () => {
  const home = await stageHome()
  try {
    const fixture = {
      env: { ANTHROPIC_BASE_URL: false, ANTHROPIC_API_KEY: 'sk-x' }, // user switched it off
      _hypaware: { version: '0.2.0', port: 4123 }, // legacy shape, no managed record
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.warning, 'ANTHROPIC_BASE_URL was overridden externally; leaving in place')

    // Never-clobber holds: the user's `false` is byte-identical afterwards.
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// The other direction on the legacy branch: absent is not "left in place".
// Pins the predicate against widening to a bare `else`.
test('claude undo of a LEGACY marker stays silent when the base URL is absent', async () => {
  const home = await stageHome()
  try {
    const fixture = {
      env: { ANTHROPIC_API_KEY: 'sk-x' }, // no base URL at all
      _hypaware: { version: '0.2.0', port: 4123 },
    }
    await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal('warning' in result, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// The record-driven undo reads its key names off disk, so the presence test has
// to be an *own*-property test. With `key in envObj` a marker recording a
// managed env key named after an `Object.prototype` member reported it as
// "left in place" while it was not on disk at all - the false report the
// presence test exists to prevent. Third-party plugins supply this record; core
// must not trust its key names.
test('claude undo does not report an Object.prototype-named managed key that is absent from settings', async () => {
  const home = await stageHome()
  try {
    const fixture = {
      env: { ANTHROPIC_API_KEY: 'sk-x' },
      _hypaware: { version: '0.2.0', managed: { env: { toString: 'x', constructor: 'y' } } },
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal('warning' in result, false)

    // Nothing was touched on the way past, either.
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.deepEqual(parsed.env, { ANTHROPIC_API_KEY: 'sk-x' })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// The round trip is the assertion that matters for the base-URL backup, the
// same way it was for the managed additions: the bug needed attach and detach
// together to destroy the value. Attach skipped the backup on JSON type, so the
// undo met a managed key with no prior and deleted a setting the user wrote.
// Byte-for-byte equality of the file is the strongest statement of the fix.
for (const prior of [8080, false, null, { hooks: [], url: 'https://foreign.example' }]) {
  test(`claude attach + undo restore a ${JSON.stringify(prior)} base URL byte-for-byte`, async () => {
    const home = await stageHome()
    try {
      const original = { env: { ANTHROPIC_BASE_URL: prior, ANTHROPIC_API_KEY: 'sk-x' } }
      const originalText = JSON.stringify(original, null, 2) + '\n'
      const settingsPath = await writeClaudeSettings(home, originalText)

      await claudeAttach({ ...ATTACH, settingsPath })
      // Attach really did repoint it - the round trip below is not a no-op.
      const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
      assert.equal(attached.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4123')

      const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
      assert.equal(result.changed, true)
      assert.equal('removed' in result, false) // restored, never removed
      assert.equal(result.restoredValue, String(prior)) // display field stays a string

      assert.equal(await fs.readFile(settingsPath, 'utf8'), originalText)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
}

// Re-attach is the second half of the base-URL backup rule, and it has its own
// type gate to get wrong: on re-attach the live value is *our* gateway URL, so
// the prior must be carried forward out of the existing marker. Reading that
// field by type dropped a non-string backup on the second attach, and the undo
// then deleted the user's value exactly as it did before the first fix - one
// attach later. Two attaches then a detach must still land byte-for-byte.
test('claude re-attach carries a non-string base URL backup forward, and undo restores it', async () => {
  const home = await stageHome()
  try {
    const original = { env: { ANTHROPIC_BASE_URL: false, ANTHROPIC_API_KEY: 'sk-x' } }
    const originalText = JSON.stringify(original, null, 2) + '\n'
    const settingsPath = await writeClaudeSettings(home, originalText)

    await claudeAttach({ ...ATTACH, settingsPath })
    await claudeAttach({ ...ATTACH, settingsPath })

    // The second attach must not have backed up its own gateway URL over the
    // user's value, nor dropped the record.
    const marker = JSON.parse(await fs.readFile(settingsPath, 'utf8'))._hypaware
    assert.equal(marker.prev_base_url_encoding, 'json')
    assert.equal(JSON.parse(marker.prev_base_url), false)

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(await fs.readFile(settingsPath, 'utf8'), originalText)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

/* ------------------------- issue #500: the undo's silences ------------------
 *
 * Three deferred findings from the review of #495 (`claude attach` backs a
 * malformed `env`/`hooks` block up onto the marker and repairs it, LLP 0163).
 * All three are about the undo *not saying* something, and two of them about it
 * dropping a backup while reporting success.
 * ------------------------------------------------------------------------- */

/**
 * Hand-edit `_hypaware.managed` out of an otherwise current marker, which is
 * the only way to reach {@link detachLegacyJsonMarker} with a marker that
 * carries backups. No attach writes this shape: `managed` goes onto the marker
 * in the same write that ever sets `prev_malformed`/`prev_base_url`, so the
 * state has to be constructed directly (issue #500, "reachability, verified by
 * execution"). It is still worth reversing honestly - the file it corrupts is
 * the user's `settings.json`, and the marker holds the only copy of what attach
 * displaced.
 *
 * @param {string} settingsPath
 */
async function breakManagedRecord(settingsPath) {
  const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
  delete parsed._hypaware.managed
  await fs.writeFile(settingsPath, JSON.stringify(parsed, null, 2) + '\n')
}

test('#500 finding 3: a restored malformed-block backup is reported by path, not silently', async () => {
  // The whole point of LLP 0163 is that attach's repair is reversible. A detach
  // that quietly rewrites the user's `env` block back tells them nothing: the
  // result carried no `removed`, no `restoredValue` and no `warning`, so
  // `hyp detach` printed only `✓ Detached claude` while it put a block back.
  const home = await stageHome()
  try {
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({ env: 'ANTHROPIC_API_KEY=sk-x' }) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { env: 'ANTHROPIC_API_KEY=sk-x' })
    assert.deepEqual(result.restoredPaths, ['env'])
    // Nothing went wrong, so nothing is warned about.
    assert.equal('warning' in result, false)
    // The path, never the value: a malformed `env` is exactly where an API key
    // ends up, and this is printed to the terminal and echoed into `--json`.
    // `settingsPath` is stripped first: it is `stageHome()`'s own mkdtemp path,
    // always present and never sensitive, and its random suffix can coincidentally
    // start with 'x' right after the fixed "...disk-" prefix, spelling "sk-x" with
    // no secret involved.
    assert.equal(JSON.stringify(result).replaceAll(settingsPath, '').includes('sk-x'), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('#500 finding 2: the delete-then-detach resurrection is announced, not silent', async () => {
  // Deleting the repaired block by hand and then detaching puts the original
  // malformed value back, where the sibling `prev_base_url` mechanism would
  // leave it deleted. That divergence is deliberately NOT changed here - two
  // reviewers and triage judged the restore defensible (nothing is lost, which
  // is the direction #454 was about) and flipping it would discard a value
  // instead. What is fixed is that it happened without a word.
  const home = await stageHome()
  try {
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({ env: 'SUPER-SECRET-ORIGINAL' }) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    delete attached.env
    await fs.writeFile(settingsPath, JSON.stringify(attached, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(JSON.parse(await fs.readFile(settingsPath, 'utf8')).env, 'SUPER-SECRET-ORIGINAL')
    assert.deepEqual(result.restoredPaths, ['env'])
    assert.equal(JSON.stringify(result).includes('SUPER-SECRET-ORIGINAL'), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('#500 finding 1: the legacy branch replays a prev_malformed backup instead of dropping it', async () => {
  // A `hooks` backup can go back down this branch, because the strip empties the
  // block: every managed handler is matched by its `hyp claude-hook …` command,
  // which is proof of ownership rather than a guess, so the widened pattern also
  // clears the `classify-cwd` entries the record would have named.
  const home = await stageHome()
  try {
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({ hooks: 'broken-by-hand' }) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })
    await breakManagedRecord(settingsPath)

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(parsed.hooks, 'broken-by-hand') // the user's value, back
    assert.deepEqual(result.restoredPaths, ['hooks'])
    assert.equal('_hypaware' in parsed, false)
    // No orphaned hyp hooks survive, including the ones the retired convention
    // predates.
    assert.equal((await fs.readFile(settingsPath, 'utf8')).includes('claude-hook'), false)
    // And the reversal says it was partial. The record that named the managed
    // env keys is what got damaged, so they are left in place (never clobber a
    // value we cannot prove is ours) and the user is told rather than left to
    // find them.
    assert.match(String(result.warning), /carried no readable undo record/)
    assert.equal(parsed.env.ENABLE_TOOL_SEARCH, 'true')
    assert.equal(parsed.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '1')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('#500 finding 1: the legacy branch reports a prev_malformed backup it cannot put back', async () => {
  // The `env` case is the one the leftovers block: the managed additions this
  // branch may not delete are still sitting at `env`, so the backup has nowhere
  // to go. It is then destroyed - the marker is deleted in the same write and
  // held the only copy - and the notice has to say so. Silently is what it did.
  const home = await stageHome()
  try {
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({ env: 'ANTHROPIC_API_KEY=sk-x' }) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })
    await breakManagedRecord(settingsPath)

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.match(String(result.warning), /env is in use again/)
    assert.match(String(result.warning), /discarded with the marker/)
    assert.equal('restoredPaths' in result, false)
    // See the sibling assertion above: `settingsPath` is stripped before the
    // leak check because its random mkdtemp suffix can coincidentally spell
    // "sk-x" against the fixed "...disk-" prefix.
    assert.equal(JSON.stringify(result).replaceAll(settingsPath, '').includes('sk-x'), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('#500 finding 1: the legacy branch restores prev_base_url rather than deleting the key', async () => {
  // The same silent drop, one field over: a marker reaching this branch with a
  // recorded prior had it thrown away and the key removed outright, so a detach
  // reporting success left the user without the base URL they had set.
  const home = await stageHome()
  try {
    const settingsPath = await writeClaudeSettings(
      home,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://mine.example' } }) + '\n'
    )
    await claudeAttach({ ...ATTACH, settingsPath })
    await breakManagedRecord(settingsPath)

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://mine.example')
    assert.equal(result.restoredValue, 'https://mine.example')
    assert.equal('removed' in result, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('#500 finding 1: a GENUINE pre-record marker is reversed exactly as before, and says nothing new', async () => {
  // The guard on the change above. A marker of the literal pre-upgrade shape
  // carries none of `managed`/`prev_base_url`/`prev_malformed`, so there is no
  // damaged record to report and no backup to replay - the branch must stay
  // silent, or every upgraded install gets a warning about nothing.
  const home = await stageHome()
  try {
    const command = "hyp claude-hook session-context --state-file '/abs/session-context.jsonl'"
    const fixture = {
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123' },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
      _hypaware: { attached_at: '2026-06-26T00:00:00.000Z', version: '0.2.0', port: 4123, state_file: '/abs/x' },
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.removed, 'http://127.0.0.1:4123')
    assert.equal('warning' in result, false)
    assert.equal('restoredPaths' in result, false)
    assert.equal('restoredValue' in result, false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('#500 finding 3: `hyp detach` prints the restored block, and never its contents', async () => {
  // The user-visible half. The core result is only worth setting if the command
  // renders it; before this, a detach that put a block back printed one line
  // saying it had detached and nothing else.
  const home = await stageHome()
  try {
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({ env: 'ANTHROPIC_API_KEY=sk-x' }) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    let out = ''
    let err = ''
    const ctx = /** @type {any} */ ({
      stdout: { write(/** @type {unknown} */ chunk) { out += String(chunk); return true } },
      stderr: { write(/** @type {unknown} */ chunk) { err += String(chunk); return true } },
      env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
      config: { version: 2 },
    })
    const code = await runDetach(['claude'], ctx)
    assert.equal(code, 0, err)
    assert.match(out, /Restored env from the marker's malformed-block backup/)
    // `out` legitimately echoes `settingsPath` (the "✓ Detached claude (<path>)"
    // line), so strip it before the leak check for the same reason as the
    // `result`-based assertions above: its random mkdtemp suffix can
    // coincidentally spell "sk-x" against the fixed "...disk-" prefix.
    assert.equal(out.replaceAll(settingsPath, '').includes('sk-x'), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('#500 finding 3: `hyp detach --json` echoes restored_paths, and never the contents', async () => {
  // The machine-readable half of the same report. `restored_paths` is a declared
  // field of the `hyp detach --json` payload (`ClientResult`), so a scripted
  // caller can see that a block went back - and the same paths-never-values rule
  // holds here, where the payload is the thing most likely to be logged.
  const home = await stageHome()
  try {
    const settingsPath = await writeClaudeSettings(home, JSON.stringify({ env: 'ANTHROPIC_API_KEY=sk-x' }) + '\n')
    await claudeAttach({ ...ATTACH, settingsPath })

    let out = ''
    let err = ''
    const ctx = /** @type {any} */ ({
      stdout: { write(/** @type {unknown} */ chunk) { out += String(chunk); return true } },
      stderr: { write(/** @type {unknown} */ chunk) { err += String(chunk); return true } },
      env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
      config: { version: 2 },
    })
    const code = await runDetach(['claude', '--json'], ctx)
    assert.equal(code, 0, err)
    const payload = JSON.parse(out.trim().split('\n').at(-1) ?? '{}')
    assert.equal(payload.changed, true)
    assert.deepEqual(payload.restored_paths, ['env'])
    // Same leak check as the prose assertion above, and the same reason for
    // stripping `settings_path` first.
    assert.equal(out.replaceAll(settingsPath, '').includes('sk-x'), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// #886 finding 2. The proxy-key reversal on the legacy branch exists for a
// *damaged current-shape* marker, but it was gated on the marker carrying a
// `port` - which every genuine pre-record legacy marker does. So a plain
// base-URL legacy detach ran it too, and told a user their own corporate
// `NODE_EXTRA_CA_CERTS` was HypAware residue of unknown provenance.
// @ref LLP 0275#legacy-proxy-reversal-needs-a-damaged-record [tests]
test('#886: a genuine LEGACY marker leaves the user own proxy env alone and unreported', async () => {
  const home = await stageHome()
  try {
    const fixture = {
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
        // The user's own corporate settings. HypAware never wrote either.
        NODE_EXTRA_CA_CERTS: '/etc/corp/ca.pem',
        HTTPS_PROXY: 'http://proxy.corp.example:3128',
      },
      _hypaware: { version: '0.2.0', port: 4123 }, // legacy shape, no managed record
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({ descriptor: CLAUDE_DESCRIPTOR, homeDir: home })
    assert.equal(result.changed, true)
    assert.equal(result.removed, 'http://127.0.0.1:4123')
    // Nothing to report: this attach never touched either key.
    assert.equal('warning' in result, false, `unexpected warning: ${result.warning}`)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(parsed.env.NODE_EXTRA_CA_CERTS, '/etc/corp/ca.pem')
    assert.equal(parsed.env.HTTPS_PROXY, 'http://proxy.corp.example:3128')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// The case the reversal *was* written for still runs: a current-shape proxy
// marker whose `managed` record has been corrupted away still carries the
// fields that route it here, and `HTTPS_PROXY` pointing at a gateway that is no
// longer attached breaks every HTTPS request the client makes.
// @ref LLP 0275#legacy-proxy-reversal-needs-a-damaged-record [tests]
test('#886: a DAMAGED proxy marker still has its proxy keys reversed', async () => {
  const home = await stageHome()
  try {
    const fixture = {
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
        HTTPS_PROXY: 'http://127.0.0.1:4123',
        NODE_EXTRA_CA_CERTS: '/somewhere/hypaware/tls/ca-cert.pem',
      },
      // `mode` survived; the `managed` undo record did not.
      _hypaware: { version: '0.2.0', port: 4123, mode: 'proxy' },
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({
      descriptor: CLAUDE_DESCRIPTOR,
      homeDir: home,
      platform: 'linux',
    })
    assert.equal(result.changed, true)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal('HTTPS_PROXY' in (parsed.env ?? {}), false, 'our gateway proxy URL is removed')
    // Provenance is unknowable without the record, so the CA path stays and is
    // reported rather than guessed at.
    assert.equal(parsed.env.NODE_EXTRA_CA_CERTS, '/somewhere/hypaware/tls/ca-cert.pem')
    assert.match(String(result.warning), /NODE_EXTRA_CA_CERTS was left in place/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// The same false-provenance claim, one case over: `recordDamaged` is true for a
// damaged marker in ANY mode (`mode` is itself one of the fields that routes a
// marker to the legacy branch as damaged), so a corrupted base-URL marker beside
// the user's own corporate bundle still reported it as HypAware residue. Only a
// proxy attach ever writes `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS`, and `mode`
// survived to say this was not one.
// @ref LLP 0275#legacy-proxy-reversal-needs-a-damaged-record [tests]
test('#886: a DAMAGED base-URL marker leaves the user own proxy env alone and unreported', async () => {
  const home = await stageHome()
  try {
    const fixture = {
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
        // The user's own corporate settings, beside a base-URL attach that
        // could not have written either.
        NODE_EXTRA_CA_CERTS: '/etc/corp/ca.pem',
        HTTPS_PROXY: 'http://proxy.corp.example:3128',
      },
      // `mode` survived; the `managed` undo record did not.
      _hypaware: { version: '0.2.0', port: 4123, mode: 'base_url' },
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({
      descriptor: CLAUDE_DESCRIPTOR,
      homeDir: home,
      platform: 'linux',
    })
    assert.equal(result.changed, true)
    assert.equal(result.removed, 'http://127.0.0.1:4123')

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(parsed.env.NODE_EXTRA_CA_CERTS, '/etc/corp/ca.pem')
    assert.equal(parsed.env.HTTPS_PROXY, 'http://proxy.corp.example:3128')
    // The damaged record is still reported (it is genuinely unreadable), but
    // never as a claim about these two keys.
    assert.doesNotMatch(String(result.warning ?? ''), /NODE_EXTRA_CA_CERTS/)
    assert.doesNotMatch(String(result.warning ?? ''), /HTTPS_PROXY/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

// Review round on #898. Narrowing the gate to `mode === 'proxy'` also removed
// the one *mutation* the branch exists for. A marker damaged badly enough to
// lose `mode` along with `managed` can still be a proxy one - it still holds
// `prev_env` - and skipping it leaves `HTTPS_PROXY` pointing at a gateway that
// no longer exists, which breaks every HTTPS request the client makes rather
// than merely its capture. The mutation is safe there because it only fires on
// a value that is still ours.
// @ref LLP 0275#legacy-proxy-reversal-needs-a-damaged-record [tests]
test('#898: a DAMAGED proxy marker that lost its mode still has HTTPS_PROXY reversed', async () => {
  const home = await stageHome()
  try {
    const fixture = {
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
        HTTPS_PROXY: 'http://127.0.0.1:4123',
      },
      // Neither `managed` nor `mode` survived; `prev_env` did, which is what
      // still routes this to the legacy branch as damaged.
      _hypaware: {
        version: '0.2.0',
        port: 4123,
        prev_env: { HTTPS_PROXY: 'http://proxy.corp.example:3128' },
      },
    }
    const settingsPath = await writeClaudeSettings(home, JSON.stringify(fixture, null, 2) + '\n')

    const result = await detachClientFromDisk({
      descriptor: CLAUDE_DESCRIPTOR,
      homeDir: home,
      platform: 'linux',
    })
    assert.equal(result.changed, true)

    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    // The recorded prior goes back rather than the dead gateway URL surviving.
    assert.equal(parsed.env.HTTPS_PROXY, 'http://proxy.corp.example:3128')
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

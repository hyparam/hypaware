// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { activate as activateClaude } from '../../hypaware-core/plugins-workspace/claude/src/index.js'
import { attach } from '../../hypaware-core/plugins-workspace/claude/src/settings.js'
import { isActionRefused } from '../../src/core/config/action_refusal.js'

/**
 * T1 (LLP 0045/0046): the Claude `_hypaware` marker is a self-describing
 * undo record. `attach()` records everything the format-aware core undo
 * (task 4) needs to reverse the attach from disk alone, `prev_base_url`
 * (the restore target) plus the managed `env.ANTHROPIC_BASE_URL` and the
 * managed session-context hook entries, so reverse never depends on the
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

    // The gateway base URL is written live, ENABLE_TOOL_SEARCH=true is set so
    // the non-first-party base URL doesn't make Claude Code eager-load every
    // tool schema, and the base URL is declared first-party so the assumed
    // context window is not cut to 200k.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4123')
    assert.equal(attached.env.ENABLE_TOOL_SEARCH, 'true')
    assert.equal(attached.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '1')

    const marker = await readMarker(settingsPath)
    // Managed env values are what we wrote: the core undo matches the live
    // value against them before removing.
    assert.deepEqual(marker.managed.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
      ENABLE_TOOL_SEARCH: 'true',
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
    })

    // Every managed hook spec is recorded with its command, and the
    // PostToolUse entry carries its matcher so the undo strips exactly
    // what was installed. session-context rides all four events; the
    // classify-cwd hook (LLP 0106) rides the two session-start events
    // (SessionStart, CwdChanged), so those events carry two entries each.
    // Claude Code 2.1.257 rejects any `hooks` key outside the root hooks block,
    // including undo metadata under `_hypaware.managed`. Keep the recorded
    // entries under a non-reserved name so the whole settings file still loads.
    assert.equal(Object.hasOwn(marker.managed, 'hooks'), false)
    const events = marker.managed.hook_entries.map((/** @type {any} */ h) => h.event).sort()
    assert.deepEqual(events, [
      'CwdChanged', 'CwdChanged', 'PostToolUse', 'SessionStart', 'SessionStart', 'UserPromptSubmit',
    ])
    for (const hook of marker.managed.hook_entries) {
      assert.match(hook.command, /claude-hook (session-context --state-file |classify-cwd)/)
    }
    // classify-cwd is installed exactly on SessionStart and CwdChanged.
    const classifyEvents = marker.managed.hook_entries
      .filter((/** @type {any} */ h) => /claude-hook classify-cwd\b/.test(h.command))
      .map((/** @type {any} */ h) => h.event)
      .sort()
    assert.deepEqual(classifyEvents, ['CwdChanged', 'SessionStart'])
    const postToolUse = marker.managed.hook_entries.find((/** @type {any} */ h) => h.event === 'PostToolUse')
    assert.equal(postToolUse.matcher, 'Bash')
    assert.match(postToolUse.command, /claude-hook session-context --state-file /)
    const sessionStartHooks = marker.managed.hook_entries.filter((/** @type {any} */ h) => h.event === 'SessionStart')
    for (const hook of sessionStartHooks) assert.equal(hook.matcher, undefined)
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
    // remove (not restore) the gateway URL and the added env keys.
    assert.deepEqual(marker.managed.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
      ENABLE_TOOL_SEARCH: 'true',
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
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
    // recorded as ours, so detach will never remove it.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env.ENABLE_TOOL_SEARCH, 'false')

    const marker = await readMarker(settingsPath)
    assert.deepEqual(marker.managed.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
    })
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
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// Issue #437: behind any non-`api.anthropic.com` base URL Claude Code assumes a
// 200k context window even for native-1M models, so an attached session reports
// a wildly inflated context percent (and warns/auto-compacts far too early)
// while the real token count is unchanged. The gateway is a byte-transparent
// pass-through to api.anthropic.com, so attach declares it first-party.
test('attach declares the gateway base URL first-party so the assumed context window is not cut', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await attach({ ...ATTACH, settingsPath })

    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '1')

    // Recorded as ours, so the core undo removes exactly what attach added.
    const marker = await readMarker(settingsPath)
    assert.equal(marker.managed.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '1')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach leaves a user-owned _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL untouched and unmanaged', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ env: { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '0' } }, null, 2)
    )

    await attach({ ...ATTACH, settingsPath })

    // Same never-clobber-a-user-value rule ENABLE_TOOL_SEARCH follows: the key
    // is only ever *added* when absent, so detach never removes a user's own.
    const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    assert.equal(attached.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '0')

    const marker = await readMarker(settingsPath)
    assert.deepEqual(marker.managed.env, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
      ENABLE_TOOL_SEARCH: 'true',
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// Issue #448 finding 1: ownership is decided by the key being present, not by
// the type of its value. settings.json is hand-edited, so a JSON boolean, number
// or null at one of these keys is still a user value. The old guard tested
// `typeof env[key] === 'string'` and so coerced anything else *and* recorded it
// as managed, handing detach a licence to delete it. See the round-trip proof in
// test/core/client-detach-disk.test.js.
for (const [label, userValue] of [
  ['boolean', true],
  ['number', 0],
  ['null', null],
]) {
  test(`attach leaves a user-owned ${label} env value untouched and unmanaged`, async () => {
    const { dir, settingsPath } = await stage()
    try {
      await fs.writeFile(
        settingsPath,
        JSON.stringify({ env: { ENABLE_TOOL_SEARCH: userValue } }, null, 2)
      )

      await attach({ ...ATTACH, settingsPath })

      const attached = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
      assert.equal(attached.env.ENABLE_TOOL_SEARCH, userValue)

      // Absent from the undo record is the load-bearing half: the marker is what
      // authorizes detach to remove a key.
      const marker = await readMarker(settingsPath)
      assert.deepEqual(marker.managed.env, {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123',
        _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
}

test('re-attach keeps managing a _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL it owns', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await attach({ ...ATTACH, settingsPath })
    await attach({ ...ATTACH, settingsPath })

    const marker = await readMarker(settingsPath)
    assert.equal(marker.managed.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '1')
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
    // and record the *original* foreign URL, not the gateway URL.
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

test('re-attach migrates the pre-2.1.257 nested hooks marker field', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await attach({ ...ATTACH, settingsPath })
    const value = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    const managed = value._hypaware.managed
    managed.hooks = managed.hook_entries ?? managed.hooks
    delete managed.hook_entries
    await fs.writeFile(settingsPath, JSON.stringify(value, null, 2) + '\n')

    await attach({ ...ATTACH, settingsPath })

    const marker = await readMarker(settingsPath)
    assert.equal(Object.hasOwn(marker.managed, 'hooks'), false)
    assert.ok(Array.isArray(marker.managed.hook_entries))
    assert.ok(marker.managed.hook_entries.length > 0)
    assert.equal(marker.settings_schema, 2)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('attach serializes malformed-hook backups so reserved hooks keys do not remain nested in settings', async () => {
  const { dir, settingsPath } = await stage()
  try {
    const prior = { hooks: [{ type: 'command', command: 'echo old' }] }
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ hooks: { SessionStart: prior } }, null, 2) + '\n'
    )

    await attach({ ...ATTACH, settingsPath })

    const marker = await readMarker(settingsPath)
    assert.equal(marker.prev_malformed_encoding, 'json')
    assert.equal(typeof marker.prev_malformed['hooks.SessionStart'], 'string')
    assert.deepEqual(JSON.parse(marker.prev_malformed['hooks.SessionStart']), prior)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// Round 2, issue #448's bug class on the key it never swept: the base URL. The
// managed additions have an ownership guard to fall through, so a type test
// there cost a value that was still on disk. Attach *always* repoints
// ANTHROPIC_BASE_URL, so here the backup is the only guard, and
// `typeof env.ANTHROPIC_BASE_URL === 'string'` skipped it for exactly the
// values a user writes on purpose - `null`/`false` to switch an override back
// off. Attach then recorded the key as managed with no prior, and the undo
// deleted it. Assert the backup is taken whatever the JSON type.
for (const prior of [8080, false, null, { url: 'x' }]) {
  test(`attach backs up a ${JSON.stringify(prior)} base URL into prev_base_url`, async () => {
    const { dir, settingsPath } = await stage()
    try {
      await fs.writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: prior } }, null, 2))

      const result = await attach({ ...ATTACH, settingsPath })
      assert.equal(result.changed, true)

      const marker = await readMarker(settingsPath)
      assert.equal('prev_base_url' in marker, true)
      assert.deepEqual(marker.prev_base_url, prior)
      // The display field stays a string; the marker keeps the real value.
      assert.equal(typeof (/** @type {any} */ (result).prevValue), 'string')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
}

// The other direction: no base URL on disk means no backup to invent. Pins the
// predicate against widening to an unconditional read.
test('attach records no prev_base_url when the base URL is absent, whatever else env holds', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-x' } }, null, 2))

    const result = await attach({ ...ATTACH, settingsPath })
    assert.equal('prevValue' in result, false)
    const marker = await readMarker(settingsPath)
    assert.equal('prev_base_url' in marker, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// LLP 0186/0187 T6: the JSONC throw site is marked as a permanent refusal,
// so the reconciler short-circuits instead of retrying an edit attach can
// never safely make (LLP 0184's field bug, under a different label).
test('attach refuses a JSONC settings.json and marks the error as refused', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(
      settingsPath,
      '{\n  // a JSONC comment, which JSON.parse cannot handle\n  "env": {}\n}\n'
    )

    await assert.rejects(
      () => attach({ ...ATTACH, settingsPath }),
      (/** @type {unknown} */ err) => {
        assert.equal(isActionRefused(err), true)
        assert.equal(/** @type {any} */ (err).code, 'JSONC')
        assert.match(/** @type {any} */ (err).message, /appears to be JSONC; refuse to modify/)
        return true
      }
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// Companion case: a plain malformed (non-JSONC) settings.json still throws
// ClaudeSettingsError, but is not marked as a permanent refusal, it is an
// environmental failure the reconciler is allowed to keep retrying.
test('attach on malformed non-JSONC JSON is not marked as refused', async () => {
  const { dir, settingsPath } = await stage()
  try {
    await fs.writeFile(settingsPath, '{ "env": ')

    await assert.rejects(
      () => attach({ ...ATTACH, settingsPath }),
      (/** @type {unknown} */ err) => {
        assert.equal(isActionRefused(err), false)
        assert.equal(/** @type {any} */ (err).code, 'MALFORMED_JSON')
        return true
      }
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The two tests above pin `settings.js`, but the mark only reaches the
// reconciler if it survives the registered `attach()` wrapper too: the kernel
// types that hook as `Promise<void>`, so `perform()`'s catch sees whatever
// object comes out of `activate()`'s registration, not what settings.js threw.
// `index.js` rethrows the original error and `withSpan` rethrows an Error
// unchanged, and this is what proves both, the way
// openclaw-client-registration.test.js proves OpenClaw's half. A wrapper that
// rewrapped the error would silently downgrade the refusal to a retried
// `failed` with nothing else failing.
// @ref LLP 0186#migration-who-calls-markactionrefused [tests]: Claude's JSONC
// refusal reaches the reconciler seam still marked
test('activate() attach() rethrows the JSONC refusal with the refusal mark intact', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-claude-activate-jsonc-'))
  try {
    await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true })
    await fs.writeFile(
      path.join(homeDir, '.claude', 'settings.json'),
      '{\n  // a JSONC comment, which JSON.parse cannot handle\n  "env": {}\n}\n'
    )

    /** @type {any} */
    const gateway = {
      registerUpstreamPreset() {},
      registerExchangeProjector() {},
      registerSettlementEnricher() {},
      /** @type {any} */
      client: undefined,
      registerClient(/** @type {any} */ client) { this.client = client },
    }
    const ctx = /** @type {any} */ ({
      env: { HOME: homeDir, HYP_HOME: path.join(homeDir, '.hyp') },
      paths: { stateDir: path.join(homeDir, '.hyp', 'plugins', 'claude') },
      plugin: { version: '0.0.0-test' },
      configRegistry: { registerSection() {} },
      requireCapability: () => gateway,
      backfills: { register() {} },
      commands: { register() {} },
      skills: { register() {} },
      agents: { register() {} },
      initPresets: { register() {} },
      query: { registerDataset() {} },
    })
    await activateClaude(ctx)

    const buf = { write() {} }
    await assert.rejects(
      () => gateway.client.attach({ endpoint: 'http://127.0.0.1:4388', stdout: buf, stderr: buf, json: true }),
      (/** @type {unknown} */ err) => {
        assert.match(/** @type {any} */ (err).message, /appears to be JSONC; refuse to modify/)
        assert.equal(isActionRefused(err), true, 'the wrapper must not strip the refusal mark')
        return true
      }
    )
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

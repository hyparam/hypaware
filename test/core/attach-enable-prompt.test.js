// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'

/**
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// T9 (LLP 0174/0175): on `not_enabled` with a TTY and no `--json`, the attach
// dispatch offers to enable the adapter instead of failing outright. These
// fixtures drive both the decline and accept paths through a real (bundled)
// plugin catalog, plus the OpenClaw-specific disclosure copy and the
// bootstrap floor that must skip the prompt entirely.
//
// @ref LLP 0174#prompt [tests]: decline is zero-side-effect, accept reaches
// client.attach() in the same invocation
// @ref LLP 0174#bootstrap-floor [tests]: no local config file skips the
// prompt and falls through to the existing not_enabled refusal

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * A stdin fixture that reports as a TTY and already carries the answer line,
 * so `askYesNo`'s `readline.createInterface` resolves without the test
 * blocking on real input.
 *
 * @param {string} answer
 */
function makeAnswerStdin(answer) {
  const stream = new PassThrough()
  Object.defineProperty(stream, 'isTTY', { value: true })
  stream.write(`${answer}\n`)
  return stream
}

/** @param {string} home */
function localConfigPath(home) {
  return path.join(home, '.hyp', 'hypaware-config.json')
}

/** @param {string} home */
function writeLocalConfig(home) {
  mkdirSync(path.dirname(localConfigPath(home)), { recursive: true })
  writeFileSync(localConfigPath(home), JSON.stringify({ version: 2, plugins: [] }))
}

/** @param {string} dir */
function backupsIn(dir) {
  return readdirSync(dir).filter((n) => n.includes('.bak-'))
}

/**
 * Build a CommandRunContext with no gateway-using plugin enabled (the
 * capability-gate failure site), a TTY stdin pre-loaded with `answer`, and an
 * `activatePluginClosure` stub that mimics real in-process activation: it
 * marks the requested plugin names live in `ctx.plugins` and registers the
 * client into the fake gateway, exactly what T9's real seam does via the
 * adapter's own `activate()`.
 *
 * @param {{ home: string, answer?: string, stdin?: boolean }} opts
 */
function makeCtx({ home, answer, stdin = true }) {
  /** @type {string[]} */
  const registered = []
  /** @type {{ name: string }[]} */
  const plugins = []
  const gateway = {
    localEndpoint() {
      return 'http://127.0.0.1:60680'
    },
    /** @param {string} name */
    getClient(name) {
      if (!registered.includes(name)) return undefined
      return {
        name,
        /** @param {{ endpoint: string }} args */
        async attach(args) {
          writeFileSync(
            path.join(home, `${name}-attached.json`),
            JSON.stringify({ endpoint: args.endpoint })
          )
        },
      }
    },
    listClients() {
      return registered.map((name) => ({ name }))
    },
  }
  const stdoutBuf = makeBuf()
  const stderrBuf = makeBuf()
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout: stdoutBuf,
    stderr: stderrBuf,
    ...(stdin ? { stdin: makeAnswerStdin(answer ?? 'n') } : {}),
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: { version: 2 },
    plugins,
    capabilities: {
      /** @param {string} id */
      has: (id) => (id === 'hypaware.ai-gateway' ? registered.length > 0 : false),
      require: () => gateway,
    },
    /** @param {string[]} names */
    activatePluginClosure: async (names) => {
      for (const name of names) {
        if (!plugins.some((p) => p.name === name)) plugins.push({ name })
      }
      if (names.includes('@hypaware/claude')) registered.push('claude')
      if (names.includes('@hypaware/openclaw')) registered.push('openclaw')
      return { activated: names, failed: [] }
    },
  }))
  return { ctx, stdout: stdoutBuf, stderr: stderrBuf }
}

/** @param {(home: string) => Promise<void> | void} fn */
async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-attach-enable-prompt-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('decline: exits 1 with zero side effects, no config or backup file written', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stderr } = makeCtx({ home, answer: 'n' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.match(stderr.text(), /Enable @hypaware\/claude \(and @hypaware\/ai-gateway\) now\? \[y\/N\] /)
    assert.match(stderr.text(), /the claude adapter is not enabled on this install/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
    assert.deepEqual(backupsIn(path.dirname(localConfigPath(home))), [])
  })
})

test('decline via a bare Enter (empty line) is treated as no', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    const { ctx } = makeCtx({ home, answer: '' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
  })
})

test('accept: enables the adapter and dispatches attach() in the same invocation', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    const { ctx, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())

    // The config write landed (additive: gateway + claude appended).
    const written = JSON.parse(readFileSync(localConfigPath(home), 'utf8'))
    const names = written.plugins.map((/** @type {{ name: string }} */ p) => p.name)
    assert.deepEqual(names.sort(), ['@hypaware/ai-gateway', '@hypaware/claude'])

    // The activation seam made both plugins live in this process...
    assert.ok(ctx.plugins.some((/** @type {{ name: string }} */ p) => p.name === '@hypaware/claude'))
    // ...and client.attach() ran in the SAME invocation, proving the crux
    // this task resolves: no second CLI run is needed to finish attaching.
    const attached = JSON.parse(readFileSync(path.join(home, 'claude-attached.json'), 'utf8'))
    assert.equal(attached.endpoint, 'http://127.0.0.1:60680')
  })
})

test('OpenClaw prompt names the periodic sweep import; Claude/Codex does not', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    const { ctx: claudeCtx, stderr: claudeStderr } = makeCtx({ home, answer: 'n' })
    await runAttach(['claude'], claudeCtx)
    assert.doesNotMatch(claudeStderr.text(), /periodic sweep/)
    assert.match(
      claudeStderr.text(),
      /^The Claude adapter is not enabled on this install\. Attaching requires it\. /
    )
  })
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    const { ctx: openclawCtx, stderr: openclawStderr } = makeCtx({ home, answer: 'n' })
    await runAttach(['openclaw'], openclawCtx)
    assert.match(
      openclawStderr.text(),
      /^The OpenClaw adapter is not enabled on this install\. Enabling it starts a periodic sweep that will import existing OpenClaw session history within about 5 minutes\. /
    )
    assert.match(openclawStderr.text(), /Enable @hypaware\/openclaw \(and @hypaware\/ai-gateway\) now\? \[y\/N\] /)
  })
})

test('bootstrap floor: no local config file at all skips the prompt entirely', async () => {
  await withTempHome(async (home) => {
    // Deliberately no writeLocalConfig(home): nothing exists to add an entry
    // to, so even with a TTY and an accepting answer queued up, the prompt
    // must never fire, and T3's existing `hyp init`-naming refusal stands.
    const { ctx, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.doesNotMatch(stderr.text(), /Enable @hypaware/)
    assert.doesNotMatch(stderr.text(), /\[y\/N\]/)
    assert.match(stderr.text(), /enable it with 'hyp init'/)
  })
})

test('non-interactive (no stdin/TTY) keeps the unchanged not_enabled refusal', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    const { ctx, stderr } = makeCtx({ home, stdin: false })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)
    assert.doesNotMatch(stderr.text(), /\[y\/N\]/)
    assert.match(stderr.text(), /the claude adapter is not enabled on this install/)
  })
})

test('--json never prompts even with a TTY', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    const { ctx, stdout, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['claude', '--json'], ctx)
    assert.equal(code, 1)
    assert.doesNotMatch(stderr.text(), /\[y\/N\]/)
    const payload = JSON.parse(stdout.text())
    assert.equal(payload.error_kind, 'adapter_not_enabled')
  })
})

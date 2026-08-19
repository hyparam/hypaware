// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'
import { installFakeDaemonService } from '../helpers/daemon_service_fixture.js'

/**
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// T11 (LLP 0174/0178): hardens T9's accept path with per-step failure
// reporting and resumability. Two things must hold:
//
// - a partial failure (config write landed, restart or wait step did not)
//   names the failed step, states that the config change persists, names the
//   `.bak-<ts>` backup path, and says a re-run resumes - and it must not
//   retry `enableClientAdapter` a second time within the same invocation;
// - a second `hyp client attach <name>` invocation after that partial failure must
//   not re-ask the enable question: the client is no longer `not_enabled`
//   once the write landed, so it falls through to the registered-client /
//   endpoint-give-up path (T7) instead of back to T9's prompt.
//
// @ref LLP 0174#prompt [tests]: per-step failure reporting and the resume
// instruction on a write-succeeded, restart-failed accept
// @ref LLP 0174#prompt [tests]: a config write that already landed means the
// next invocation never re-prompts, it falls through to the registered/
// endpoint-unreachable path
// @ref LLP 0174#prompt [tests]: "each step reports its own failure" means one
// report, so the pre-write guided error is not printed under a step report
// that already described the state the write left behind

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
 * Same enable-prompt ctx `attach-enable-prompt.test.js` uses: no gateway-using
 * plugin enabled yet (the capability-gate failure site), a TTY stdin
 * pre-loaded with `answer`, and an `activatePluginClosure` stub mimicking
 * real in-process activation.
 *
 * `activationFails` models the second partial-failure exit: the config write
 * lands, but this process's own kernel never brings the plugin up.
 *
 * @param {{ home: string, answer?: string, activationFails?: boolean }} opts
 */
function makeNotEnabledCtx({ home, answer, activationFails }) {
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
      return { name, async attach() {} }
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
    stdin: makeAnswerStdin(answer ?? 'y'),
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
      if (activationFails) return { activated: [], failed: names }
      for (const name of names) {
        if (!plugins.some((p) => p.name === name)) plugins.push({ name })
      }
      if (names.includes('@hypaware/claude')) registered.push('claude')
      return { activated: names, failed: [] }
    },
  }))
  return { ctx, stdout: stdoutBuf, stderr: stderrBuf }
}

/**
 * A "second invocation" ctx: the client's adapter is already registered (as
 * it would be on a fresh CLI boot against a config that now names it, after a
 * prior partial-failure write landed), but the gateway is not bound in this
 * process and there is nothing to fall back on - the registered-client /
 * endpoint-give-up shape T7 covers, never the not_enabled prompt.
 *
 * @param {{ home: string }} opts
 */
function makeAlreadyRegisteredCtx({ home }) {
  const gateway = {
    localEndpoint() {
      throw new Error('ai-gateway: localEndpoint() called before the gateway started')
    },
    /** @param {string} name */
    getClient(name) {
      return { name, async attach() {} }
    },
    listClients() {
      return [{ name: 'claude' }]
    },
  }
  const stdoutBuf = makeBuf()
  const stderrBuf = makeBuf()
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout: stdoutBuf,
    stderr: stderrBuf,
    // No stdin at all: a real second invocation may or may not be at a TTY,
    // but either way it must never reach a prompt from here, so absence must
    // not matter.
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: { version: 2 },
    capabilities: {
      has: () => true,
      require: () => gateway,
    },
  }))
  return { ctx, stdout: stdoutBuf, stderr: stderrBuf }
}

/** @param {(home: string) => Promise<void> | void} fn */
async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-attach-enable-resume-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('accept, write succeeds, restart fails: names the restart step, the backup path, and the resume instruction; does not retry the enable', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    // The marker makes `serviceDaemonStatus` report installed, so the flow goes
    // on to `restartServiceDaemon`. What makes that restart fail is the
    // test-runner guard in `runServiceCommand` refusing to spawn, NOT the
    // absence of a service-manager binary: see `installFakeDaemonService`.
    installFakeDaemonService(home)
    const { ctx, stderr } = makeNotEnabledCtx({ home, answer: 'y' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)

    const message = stderr.text()
    // Names the step that failed.
    assert.match(message, /the restart step failed/)
    // States the config change persists and names the backup path.
    assert.match(message, /config change already persists/)
    assert.match(message, /config backed up to (.+)\.bak-/)
    // Says a re-run resumes.
    assert.match(message, /re-running 'hyp client attach claude' resumes from the new state/)

    // The write itself really did land (additive: gateway + claude appended).
    const written = JSON.parse(readFileSync(localConfigPath(home), 'utf8'))
    const names = written.plugins.map((/** @type {{ name: string }} */ p) => p.name)
    assert.deepEqual(names.sort(), ['@hypaware/ai-gateway', '@hypaware/claude'])

    // Exactly one backup: enableClientAdapter ran (and failed) exactly once,
    // not retried within this invocation.
    assert.equal(backupsIn(path.dirname(localConfigPath(home))).length, 1)

    // And nothing contradicts it. The caller's guided refusal was computed
    // before the write and says the adapter "is not enabled ... add
    // @hypaware/claude to <config> and run 'hyp daemon restart'": under the
    // line above, it denies the write that just landed and instructs an edit
    // already made. One failure, one report.
    assert.doesNotMatch(message, /error: the claude adapter is not enabled on this install/)
    assert.doesNotMatch(message, /enable it with 'hyp init'/)
    assert.equal(
      (message.match(/error: /g) ?? []).length,
      1,
      `expected exactly one error line, got:\n${message}`
    )
  })
})

test('accept, write succeeds, in-process activation fails: the activation report is not contradicted either', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    // The other partial-failure exit below `enableClientAdapter`: the write
    // (and, with no daemon marker on disk, no restart at all) succeeded, and
    // this process could not activate what the config now names.
    const { ctx, stderr } = makeNotEnabledCtx({ home, answer: 'y', activationFails: true })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)

    const message = stderr.text()
    assert.match(message, /could not activate it in this process/)
    assert.match(message, /re-run 'hyp attach claude' to finish/)
    assert.doesNotMatch(message, /error: the claude adapter is not enabled on this install/)
    assert.equal(
      (message.match(/error: /g) ?? []).length,
      1,
      `expected exactly one error line, got:\n${message}`
    )
  })
})

test('second invocation after a partial failure: config already carries the entry, so attach never re-prompts', async () => {
  await withTempHome(async (home) => {
    // Simulates the state left behind by the failed first run: the local
    // config already names the client's adapter (and ai-gateway), and this
    // fresh CLI boot activated it in-process, so the client is registered -
    // even though the daemon itself never came back up (no fake service
    // marker, no bound endpoint, no configured listen).
    writeLocalConfig(home)
    const { ctx, stderr } = makeAlreadyRegisteredCtx({ home })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 1)

    const message = stderr.text()
    // Never the enable prompt again.
    assert.doesNotMatch(message, /\[y\/N\]/)
    assert.doesNotMatch(message, /Enable @hypaware/)
    assert.doesNotMatch(message, /not enabled on this install/)
    // Instead, T7's extended endpoint give-up message (no daemon installed).
    assert.match(message, /cannot resolve the gateway endpoint/)
    assert.match(message, /hyp daemon install/)
    assert.match(message, /hyp daemon start/)
  })
})

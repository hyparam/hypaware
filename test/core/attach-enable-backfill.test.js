// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'

/**
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

// T10 (LLP 0174/0175): after T9's accept path enables and attaches a client
// in the same invocation, offer the finale's own backfill consent question
// for that client's provider (if one is registered in `ctx.backfills`), and
// run it on yes. This never fires for a client whose adapter was already
// enabled - only `activatedViaPrompt` reaches it - and asks nothing at all
// when there is no registered provider to run.
//
// @ref LLP 0174#prompt [tests]: step 4, backfill consent, reusing the
// finale's own question and runner on T9's accept path
// @ref LLP 0174#openclaw [tests]: the OpenClaw variant never reaches this
// question (LLP 0174 #openclaw: its own enable disclosure already covers it)

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
 * A stdin fixture that reports as a TTY and feeds each queued answer line in
 * turn, so both the enable prompt's `askYesNo` and (if reached) the backfill
 * consent's legacy `readline` prompt each consume one line without the test
 * blocking on real input. Each answer after the first is written on a
 * `setTimeout`, not pre-buffered and not merely deferred a tick: a
 * `readline.Interface` that closes after `question()` resolves discards
 * anything left unread in the SAME data chunk, so writing every line up
 * front (or on the same microtask/`setImmediate` turn as the first
 * `readline.Interface` closing) loses every answer after the first one two
 * different `readline.createInterface` calls (one per question, as
 * `askYesNo` and the legacy backfill prompt each open their own) ever read.
 * A short real-time delay lets the async work between the two prompts
 * (config write, plugin activation, asset materialization) actually finish
 * before the next answer lands.
 *
 * @param {string[]} answers
 */
function makeAnswerStdin(answers) {
  const stream = new PassThrough()
  Object.defineProperty(stream, 'isTTY', { value: true })
  const [first, ...rest] = answers
  if (first !== undefined) stream.write(`${first}\n`)
  let delay = 0
  for (const answer of rest) {
    delay += 100
    setTimeout(() => stream.write(`${answer}\n`), delay)
  }
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

/**
 * A minimal `BackfillContribution`-shaped provider. Yields nothing, so
 * `runBackfillProvider`'s materialize/write/flush steps never run and no
 * further `ctx.storage`/`ctx.query` wiring is needed beyond `cacheRoot` -
 * only the `runCtx` threaded into `run()` matters for these fixtures.
 *
 * @param {string} name
 * @param {(runCtx: { retentionDays?: number, until?: string, dryRun: boolean }) => void} onRun
 */
function makeProvider(name, onRun) {
  return {
    name,
    plugin: `@hypaware/${name}`,
    datasets: ['ai_gateway_messages'],
    async *run(runCtx) {
      onRun(runCtx)
    },
  }
}

/**
 * Build a CommandRunContext with no gateway-using plugin enabled (so attach
 * takes T9's `not_enabled` accept path), a TTY stdin pre-loaded with the
 * enable answer plus (optionally) a backfill consent answer, and an
 * `activatePluginClosure` stub mimicking real in-process activation.
 *
 * @param {{
 *   home: string,
 *   answers: string[],
 *   backfillProvider?: ReturnType<typeof makeProvider>,
 * }} opts
 */
function makeCtx({ home, answers, backfillProvider }) {
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
  const backfills = {
    /** @param {string} name */
    get: (name) => (backfillProvider && backfillProvider.name === name ? backfillProvider : undefined),
    list: () => (backfillProvider ? [backfillProvider] : []),
  }
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout: stdoutBuf,
    stderr: stderrBuf,
    stdin: makeAnswerStdin(answers),
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: { version: 2 },
    storage: { cacheRoot: home },
    query: {},
    backfillMaterializers: { get: () => undefined },
    backfills,
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
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-attach-enable-backfill-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('accept-then-yes: the provider runs with the expected shape and its result is reported', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    /** @type {{ retentionDays?: number, until?: string, dryRun: boolean } | undefined} */
    let seenRunCtx
    const provider = makeProvider('claude', (runCtx) => {
      seenRunCtx = runCtx
    })
    const { ctx, stdout, stderr } = makeCtx({ home, answers: ['y', 'y'], backfillProvider: provider })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())

    assert.ok(seenRunCtx, 'expected the backfill provider run() to be invoked')
    assert.equal(seenRunCtx?.dryRun, false)
    assert.equal(typeof seenRunCtx?.retentionDays, 'number')
    assert.equal(typeof seenRunCtx?.until, 'string')

    assert.match(stdout.text(), /backfill claude: ok \(scanned 0, wrote 0, skipped 0\)/)
  })
})

test('accept-then-no: declining the backfill question runs no import', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    let ran = false
    const provider = makeProvider('claude', () => {
      ran = true
    })
    const { ctx, stdout, stderr } = makeCtx({ home, answers: ['y', 'n'], backfillProvider: provider })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())

    assert.equal(ran, false, 'expected the backfill provider run() not to be invoked')
    assert.match(stdout.text(), /backfill claude: skipped \(declined\)/)
  })
})

test('client with no registered backfill provider: the question is not asked at all', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    // No backfillProvider passed: ctx.backfills.get('claude') resolves
    // undefined, mirroring a hypothetical adapter with no backfill
    // contribution. Only ONE answer is queued (the enable prompt's); if the
    // implementation asked a second question it would consume this same
    // stream's end-of-input as an empty answer rather than hang, so the
    // absence of the prompt copy on stdout/stderr is the real assertion.
    const { ctx, stdout, stderr } = makeCtx({ home, answers: ['y'] })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())

    assert.doesNotMatch(stdout.text(), /Import local/)
    assert.doesNotMatch(stdout.text(), /backfill claude:/)
  })
})

test('OpenClaw never reaches the backfill question, even with a registered provider', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    let ran = false
    const provider = makeProvider('openclaw', () => {
      ran = true
    })
    // Only the enable answer is queued: OpenClaw's own enable prompt already
    // disclosed the periodic sweep (LLP 0174 #openclaw), so step 4 must not
    // ask a second question here.
    const { ctx, stdout, stderr } = makeCtx({ home, answers: ['y'], backfillProvider: provider })
    const code = await runAttach(['openclaw'], ctx)
    assert.equal(code, 0, stderr.text())

    assert.equal(ran, false)
    assert.doesNotMatch(stdout.text(), /Import local/)
  })
})

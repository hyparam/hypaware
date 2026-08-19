// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'
import { readClientActionStatus } from '../../src/core/config/action_reconciler.js'

/**
 * The daemon-managed "already attached at the live port" branch is a success
 * exit of `hyp client attach`, and it is the one an operator on a default install
 * actually reaches: the gateway is not bound in this CLI process, no `listen`
 * is configured, and the marker in the client's settings already names the
 * daemon's live port. It used to `continue` straight after materializing
 * assets, so it was the one attach path that reached neither tail below
 * `client.attach()`:
 *
 * - the `refused`-marker re-arm, which LLP 0186 makes the ONLY re-arm a
 *   refused marker gets, and whose sole trigger is exactly this explicit
 *   re-run;
 * - LLP 0174 step 4's backfill consent, the offer the accept path exists to
 *   reach, which the accept branch had just earned by enabling the adapter in
 *   this same invocation.
 *
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 *
 * @ref LLP 0295#both-success-exits [tests]: the explicit re-run re-arms a
 *   refused marker on the daemon-managed exit too, and does so ahead of the
 *   asset tail that can throw
 * @ref LLP 0174#prompt [tests]: step 4's backfill consent is reached from the
 *   attach exit the accept path actually lands on here
 */

/**
 * @param {{ onWrite?: (chunk: unknown) => void }} [opts]
 * @returns {{ write(chunk: unknown): boolean, text(): string }}
 */
function makeBuf(opts = {}) {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      opts.onWrite?.(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/**
 * A TTY stdin that feeds queued answers, the first pre-buffered and each later
 * one on demand. Same shape (and same reason) as
 * test/core/attach-enable-backfill.test.js's fixture: an answer written before
 * its own question's `readline.Interface` exists can be eaten by the previous
 * one.
 *
 * @param {string[]} answers
 * @returns {{ stream: PassThrough, feedNext(): void }}
 */
function makeAnswerStdin(answers) {
  const stream = new PassThrough()
  Object.defineProperty(stream, 'isTTY', { value: true })
  const queue = [...answers]
  const first = queue.shift()
  if (first !== undefined) stream.write(`${first}\n`)
  return {
    stream,
    feedNext() {
      const next = queue.shift()
      if (next !== undefined) stream.write(`${next}\n`)
    },
  }
}

/** @param {string} home */
function stateRoot(home) {
  return path.join(home, '.hyp', 'hypaware')
}

/** @param {string} home */
function writeLocalConfig(home) {
  const configPath = path.join(home, '.hyp', 'hypaware-config.json')
  mkdirSync(path.dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify({ version: 2, plugins: [] }))
}

/**
 * Seed the daemon run dir with a live pid file (this process, guaranteed
 * alive) and a status.json naming the gateway's bound port, plus the client
 * settings marker already at that same port. Together these are the
 * "daemon-managed, already current" state.
 *
 * @param {string} home
 * @param {number} port
 */
function seedDaemonManagedAttach(home, port) {
  const runDir = path.join(stateRoot(home), 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    path.join(runDir, 'hypaware.pid'),
    JSON.stringify({ pid: process.pid, runId: 'test-run', mode: 'foreground' })
  )
  writeFileSync(
    path.join(runDir, 'status.json'),
    JSON.stringify({
      state: 'healthy',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      uptimeMs: 0,
      runId: 'test-run',
      mode: 'foreground',
      sources: [
        {
          name: 'ai-gateway',
          plugin: '@hypaware/ai-gateway',
          state: 'started',
          details: { host: '127.0.0.1', port, upstreams: ['anthropic'] },
        },
      ],
      sinks: [],
    })
  )
  mkdirSync(path.join(home, '.claude'), { recursive: true })
  writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ _hypaware: { version: '2.0.0', port } })
  )
}

/**
 * Seed a `refused` attach marker, as `action_attach.js`'s `perform()` would
 * have recorded a permanent precondition refusal (LLP 0186): no `attempts`.
 *
 * @param {string} home
 */
function seedRefusedMarker(home) {
  const dir = path.join(stateRoot(home), 'config-control')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'client-actions.json'),
    JSON.stringify({
      attach: {
        claude: {
          status: 'refused',
          request_key: 'claude',
          reason: '~/.claude/settings.json appears to be JSONC; refuse to modify',
          at: '2026-08-01T00:00:00.000Z',
        },
      },
    }) + '\n'
  )
}

/**
 * A minimal `BackfillContribution`-shaped provider that yields nothing, so
 * only the fact that it ran matters.
 *
 * @param {string} name
 * @param {() => void} onRun
 */
function makeProvider(name, onRun) {
  return {
    name,
    plugin: `@hypaware/${name}`,
    datasets: ['ai_gateway_messages'],
    async *run() {
      onRun()
    },
  }
}

/**
 * A daemon-managed context: the gateway capability is present (or becomes
 * present via the enable prompt) but unbound in this process, so
 * `localEndpoint()` throws and attach falls through to the status.json port
 * discovery. `preEnabled` picks which of the two shapes this is: an adapter
 * already enabled coming in, or one the enable prompt turns on here.
 *
 * `brokenAssets` makes the asset tail throw rather than warn: the plan is read
 * through `skills.list()`, so a registry that cannot answer propagates out of
 * `materializeClientAssets` into attach's outer catch, the same way the
 * unguarded halves of the prune and digest passes would.
 *
 * @param {{
 *   home: string,
 *   preEnabled: boolean,
 *   answers?: string[],
 *   backfillProvider?: ReturnType<typeof makeProvider>,
 *   brokenAssets?: boolean,
 * }} opts
 */
function makeDaemonManagedCtx({ home, preEnabled, answers = [], backfillProvider, brokenAssets = false }) {
  /** @type {string[]} */
  const registered = preEnabled ? ['claude'] : []
  /** @type {{ name: string }[]} */
  const plugins = []
  /** @type {string[]} */
  const attachCalls = []
  const gateway = {
    localEndpoint() {
      throw new Error('ai-gateway: localEndpoint() called before the gateway started')
    },
    /** @param {string} name */
    getClient(name) {
      if (!registered.includes(name)) return undefined
      return {
        name,
        async attach() {
          attachCalls.push(name)
        },
      }
    },
    listClients() {
      return registered.map((name) => ({ name }))
    },
  }
  const stdin = makeAnswerStdin(answers)
  const stdout = makeBuf({
    onWrite: (chunk) => {
      if (String(chunk).includes('[Y/n]: ')) stdin.feedNext()
    },
  })
  const stderr = makeBuf({
    onWrite: (chunk) => {
      // The LLP 0244 proxy-migration question sits between the enable prompt
      // and the backfill consent; decline it directly so the queued answers
      // keep meaning [enable, backfill].
      if (String(chunk).includes('Switch this install to proxy mode now? [y/N] ')) {
        stdin.stream.write('n\n')
      }
    },
  })
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout,
    stderr,
    stdin: stdin.stream,
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config: { version: 2 },
    ...(brokenAssets
      ? {
        skills: {
          list() {
            throw new Error('asset registry unavailable')
          },
        },
      }
      : {}),
    storage: { cacheRoot: home },
    query: {},
    backfillMaterializers: { get: () => undefined },
    backfills: {
      /** @param {string} name */
      get: (name) => (backfillProvider && backfillProvider.name === name ? backfillProvider : undefined),
      list: () => (backfillProvider ? [backfillProvider] : []),
    },
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
      return { activated: names, failed: [] }
    },
  }))
  return { ctx, stdout, stderr, attachCalls }
}

/** @param {(home: string) => Promise<void> | void} fn */
async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-attach-daemon-tails-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('an explicit attach on a daemon-managed install re-arms a refused marker', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    seedDaemonManagedAttach(home, 55555)
    seedRefusedMarker(home)

    const { ctx, stdout, stderr, attachCalls } = makeDaemonManagedCtx({ home, preEnabled: true })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())

    // The branch under test, not some other exit: nothing was re-wired.
    assert.match(stdout.text(), /already attached/)
    assert.deepEqual(attachCalls, [], 'a marker already at the live port is a settings no-op')

    assert.equal(
      readClientActionStatus({ stateRoot: stateRoot(home) }).byKind.attach?.claude,
      undefined,
      'the explicit re-run is the only re-arm a refused marker gets, and this is the install shape it is run on'
    )
  })
})

test('the re-arm survives an asset tail that throws after it', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    seedDaemonManagedAttach(home, 55555)
    seedRefusedMarker(home)

    const { ctx, stderr } = makeDaemonManagedCtx({ home, preEnabled: true, brokenAssets: true })
    // The asset tail's throw is reported by attach's outer catch, so this run
    // is a failure overall. That is exactly the case the ordering is for.
    assert.equal(await runAttach(['claude'], ctx), 1)
    assert.match(stderr.text(), /asset registry unavailable/)

    // Ordered ahead of the asset tail: a failure there costs the assets, not
    // the one re-arm a refused marker will ever be offered.
    assert.equal(
      readClientActionStatus({ stateRoot: stateRoot(home) }).byKind.attach?.claude,
      undefined,
      'the re-arm must already have landed before the tail that failed'
    )
  })
})

test('a done marker still survives that same daemon-managed attach', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    seedDaemonManagedAttach(home, 55555)
    const dir = path.join(stateRoot(home), 'config-control')
    mkdirSync(dir, { recursive: true })
    const installed = [path.join(home, '.claude', 'skills', 'org-helper')]
    writeFileSync(
      path.join(dir, 'client-actions.json'),
      JSON.stringify({
        attach: {
          claude: {
            status: 'done',
            request_key: 'claude',
            at: '2026-07-01T00:00:00.000Z',
            installed_assets: installed,
          },
        },
      }) + '\n'
    )

    const { ctx, stderr } = makeDaemonManagedCtx({ home, preEnabled: true })
    assert.equal(await runAttach(['claude'], ctx), 0, stderr.text())

    // The re-arm is scoped to `refused`: a `done` marker is the only record
    // naming the files an org-driven attach installed (LLP 0138#marker-undo).
    const marker = readClientActionStatus({ stateRoot: stateRoot(home) })
      .byKind.attach?.claude
    assert.equal(marker?.status, 'done')
    assert.deepEqual(marker?.installed_assets, installed)
  })
})

test('the post-enable backfill offer is reached on the daemon-managed already-attached exit', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    // The concrete state: the config lost the Claude adapter, but the settings
    // marker still names the daemon's current port. The enable prompt turns
    // the adapter on, the probe then reports `alreadyCurrent`, and step 4's
    // offer must still be made for the client this invocation just enabled.
    seedDaemonManagedAttach(home, 55555)
    let ran = false
    const provider = makeProvider('claude', () => { ran = true })
    const { ctx, stdout, stderr } = makeDaemonManagedCtx({
      home,
      preEnabled: false,
      answers: ['y', 'y'],
      backfillProvider: provider,
    })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())

    assert.match(stdout.text(), /already attached/, 'the exit under test is the daemon-managed one')
    assert.equal(ran, true, 'the accept path must reach its own backfill offer on this exit too')
    assert.match(stdout.text(), /backfill claude: ok/)

    // The write really did land, so the enable half of the flow is genuine.
    const written = JSON.parse(readFileSync(path.join(home, '.hyp', 'hypaware-config.json'), 'utf8'))
    assert.ok(
      written.plugins.some((/** @type {{ name: string }} */ p) => p.name === '@hypaware/claude'),
      'the enable prompt wrote the adapter entry'
    )
  })
})

test('an adapter that was already enabled reaches no backfill offer on that exit', async () => {
  await withTempHome(async (home) => {
    writeLocalConfig(home)
    seedDaemonManagedAttach(home, 55555)
    let ran = false
    const provider = makeProvider('claude', () => { ran = true })
    // No enable prompt ran, so `activatedViaPrompt` is false and step 4 stays
    // confined to the accept branch it is scoped to.
    const { ctx, stdout, stderr } = makeDaemonManagedCtx({
      home,
      preEnabled: true,
      backfillProvider: provider,
    })
    assert.equal(await runAttach(['claude'], ctx), 0, stderr.text())

    assert.equal(ran, false)
    assert.doesNotMatch(stdout.text(), /backfill claude:/)
  })
})

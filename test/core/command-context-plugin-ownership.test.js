// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createActivationContext, createKernelRuntime } from '../../src/core/runtime/activation.js'
import { temporaryDirectory } from '../helpers/temp_dir.js'

/** @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js' */
/** @import { ExtendedSinkRegistry } from '../../src/core/registry/types.js' */

// `CommandRunContext` carried the kernel's own `capabilities`, `sources` and
// `sinks`, so contributing a command handed the contributing plugin a second,
// unfaceted context: whatever the activation facades refuse on `ctx`, the same
// plugin got for free inside its own `run()`. Everything #1961 measured and
// #1969 closed was reachable again one `hyp <command>` away, and through the
// `ctx.commands.run` seam a user reached it by picking a wizard row
// (issue #1970). Every case here drives the real `dispatch()`.

const A = '@fixture/sink-owner'
const B = '@fixture/squatter'

/**
 * A request sink contribution plus the record of what its live `Sink` was
 * asked to do, so a reach is measured at the destination rather than inferred
 * from the shape of the handle.
 */
function fixtureSink() {
  /** @type {{ exports: unknown[], closes: number, readers: number }} */
  const seen = { exports: [], closes: 0, readers: 0 }
  return {
    seen,
    contribution: /** @type {any} */ ({
      name: 'central',
      plugin: A,
      supports: ['queryable'],
      async create() {
        return {
          /** @param {unknown} batch */
          async exportBatch(batch) { seen.exports.push(batch); return { exported: true } },
          async close() { seen.closes += 1 },
          reader() { seen.readers += 1; return /** @type {any} */ ({ rows: 'ALL THE ROWS' }) },
        }
      },
    }),
  }
}

/** A source contribution, with the record of whether its lifecycle ran. */
function fixtureSource() {
  /** @type {{ starts: number, stops: number }} */
  const seen = { starts: 0, stops: 0 }
  return {
    seen,
    contribution: /** @type {any} */ ({
      name: 'owner-source',
      plugin: A,
      configSection: 'owner',
      async start() { seen.starts += 1; return { async stop() { seen.stops += 1 } } },
    }),
  }
}

/**
 * One real kernel, one real command registry with core's commands on it, and
 * the two activation contexts the fixture plugins reach it through. A's sink
 * contribution is registered and one instance materialized from config,
 * exactly as `materializeSinks` does at boot.
 */
async function stage() {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  /** @param {string} name */
  const contextFor = (name) => createActivationContext({
    runtime: kernel,
    plugin: /** @type {any} */ ({ name, version: '1.0.0', manifest: { name, permissions: [] }, rootDir: '/nowhere' }),
    paths: /** @type {any} */ ({ rootDir: '/nowhere', stateDir: '/nowhere', cacheDir: '/nowhere', tempDir: '/nowhere' }),
    config: {},
    env: {},
  })
  const ctxA = contextFor(A)
  const ctxB = contextFor(B)
  const sink = fixtureSink()
  const source = fixtureSource()
  ctxA.sinks.register(sink.contribution)
  ctxA.sources.register(source.contribution)
  const live = await /** @type {ExtendedSinkRegistry} */ (kernel.sinks).instantiate({
    kind: 'request',
    instanceName: 'org-central',
    contribution: sink.contribution,
    config: { schedule: '* * * * *', endpoint: 'https://central.example', token: 'SECRET-TOKEN' },
    plugin: /** @type {any} */ (ctxA.plugin),
    paths: /** @type {any} */ (ctxA.paths),
    log: /** @type {any} */ (ctxA.log),
  })
  return { registry, kernel, ctxA, ctxB, sink, source, live }
}

/** A stdout/stderr sink that keeps what a command wrote. */
function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return { write(/** @type {string} */ chunk) { chunks.push(chunk); return true }, text: () => chunks.join('') }
}

/**
 * Register `run` as a command owned by `ctx`'s plugin and dispatch it, the way
 * a user typing `hyp <name>` does.
 *
 * @param {Awaited<ReturnType<typeof stage>>} staged
 * @param {{ commands: any }} owner the activation context registering it
 * @param {string} name
 * @param {(argv: string[], cmdCtx: CommandRunContext) => Promise<number>} run
 */
function contributeCommand(staged, owner, name, run) {
  owner.commands.register({ name, summary: 'fixture', usage: `hyp ${name}`, run })
}

/**
 * @param {Awaited<ReturnType<typeof stage>>} staged
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env] what the invocation runs under, defaulting
 *   to this process's. Only the cases that dispatch a *real* core command pass
 *   one; the fixture commands touch no disk.
 */
async function invoke(staged, argv, env = process.env) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(argv, {
    stdout,
    stderr,
    env: { ...env },
    cwd: process.cwd(),
    registry: staged.registry,
    kernel: staged.kernel,
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

test('a plugin command cannot forge an export to a neighbour\'s configured destination', async () => {
  const staged = await stage()
  /** @type {unknown} */
  let refusal
  contributeCommand(staged, staged.ctxB, 'squat export', async (_argv, ctx) => {
    const handle = /** @type {any} */ (ctx.sinks.get('org-central'))
    try {
      await handle.sink.exportBatch({ partitions: [], batchId: 'forged' }, {})
      refusal = 'ACCEPTED'
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err)
    }
    return 0
  })

  const { code } = await invoke(staged, ['squat', 'export'])
  assert.equal(code, 0)
  assert.match(
    String(refusal),
    /not owned by '@fixture\/squatter'/,
    'a plugin command drove an export to another plugin\'s destination'
  )
  assert.deepEqual(staged.sink.seen.exports, [], 'forged rows reached the owner\'s destination')
})

test('a plugin command reads no instance config, so an inline token is not disclosed', async () => {
  const staged = await stage()
  /** @type {any} */
  let observed
  contributeCommand(staged, staged.ctxB, 'squat read', async (_argv, ctx) => {
    const handle = /** @type {any} */ (ctx.sinks.get('org-central'))
    observed = {
      isLive: handle === staged.live,
      config: handle?.config,
      keys: Object.keys(handle ?? {}).sort(),
      reader: typeof handle?.sink?.reader,
    }
    return 0
  })

  await invoke(staged, ['squat', 'read'])
  assert.equal(observed.isLive, false, 'a plugin command got the handle the sink driver calls')
  assert.equal(observed.config, undefined, 'a plugin command read the sink instance config')
  assert.deepEqual(observed.keys, ['name', 'plugin', 'sink', 'supports'])
  assert.equal(observed.reader, 'undefined', 'a plugin command reached the queryable sink\'s reader')
  assert.equal(staged.sink.seen.readers, 0, 'the owner\'s reader ran for a plugin command')
})

test('a plugin command cannot substitute the object the sink driver calls', async () => {
  const staged = await stage()
  const mine = { async exportBatch() { return { exported: true } }, async close() {} }
  /** @type {unknown} */
  let refusal
  contributeCommand(staged, staged.ctxB, 'squat substitute', async (_argv, ctx) => {
    const handle = /** @type {any} */ (ctx.sinks.get('org-central'))
    try {
      handle.sink = mine
      refusal = 'ACCEPTED'
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err)
    }
    return 0
  })

  await invoke(staged, ['squat', 'substitute'])
  assert.notEqual(String(refusal), 'ACCEPTED', 'a plugin command replaced the live sink on the handle')
  assert.notEqual(staged.live.sink, mine, 'the driver\'s handle carries a plugin command\'s object')
  await staged.live.sink.exportBatch(/** @type {any} */ ({ partitions: [], batchId: 'real' }), /** @type {any} */ ({}))
  assert.equal(staged.sink.seen.exports.length, 1, 'the owner\'s own export path stopped working')
})

test('a plugin command\'s closeAll leaves a neighbour\'s instance registered and running', async () => {
  const staged = await stage()
  contributeCommand(staged, staged.ctxB, 'squat closeall', async (_argv, ctx) => {
    await /** @type {any} */ (ctx.sinks).closeAll()
    return 0
  })

  await invoke(staged, ['squat', 'closeall'])
  assert.equal(staged.sink.seen.closes, 0, 'a plugin command\'s closeAll stopped another plugin\'s exports')
  assert.equal(
    /** @type {ExtendedSinkRegistry} */ (staged.kernel.sinks).get('org-central'),
    staged.live,
    'a plugin command removed the owner\'s instance from the registry'
  )
})

test('a plugin command cannot register a contribution claiming a neighbour\'s name', async () => {
  const staged = await stage()
  /** @type {Record<string, unknown>} */
  const refusals = {}
  contributeCommand(staged, staged.ctxB, 'squat register', async (_argv, ctx) => {
    try {
      ctx.sinks.register(/** @type {any} */ ({ name: 'liar', plugin: A, supports: [], async create() { return {} } }))
      refusals.sink = 'ACCEPTED'
    } catch (err) { refusals.sink = err instanceof Error ? err.message : String(err) }
    try {
      ctx.sources.register(/** @type {any} */ ({ name: 'liar-source', plugin: A, configSection: 'x', async start() { return {} } }))
      refusals.source = 'ACCEPTED'
    } catch (err) { refusals.source = err instanceof Error ? err.message : String(err) }
    return 0
  })

  await invoke(staged, ['squat', 'register'])
  assert.match(String(refusals.sink), /declares plugin '@fixture\/sink-owner'/, 'a sink contribution naming a neighbour was accepted from a command body')
  assert.match(String(refusals.source), /declares plugin '@fixture\/sink-owner'/, 'a source contribution naming a neighbour was accepted from a command body')
})

test('a plugin command cannot start, stop or reach a neighbour\'s source', async () => {
  const staged = await stage()
  /** @type {Record<string, unknown>} */
  const seen = {}
  contributeCommand(staged, staged.ctxB, 'squat source', async (_argv, ctx) => {
    const sources = /** @type {any} */ (ctx.sources)
    try {
      await sources.start('owner-source', {})
      seen.start = 'ACCEPTED'
    } catch (err) { seen.start = err instanceof Error ? err.message : String(err) }
    try {
      await sources.get('owner-source').start({})
      seen.contribution = 'ACCEPTED'
    } catch (err) { seen.contribution = err instanceof Error ? err.message : String(err) }
    return 0
  })

  await invoke(staged, ['squat', 'source'])
  assert.notEqual(seen.start, 'ACCEPTED', 'a plugin command started a neighbour\'s source')
  assert.equal(staged.source.seen.starts, 0, 'a neighbour\'s source ran under a plugin command\'s context')
  assert.match(
    String(seen.contribution),
    /carries no live start\(\)/,
    'get() handed a plugin command a neighbour\'s live start()'
  )
})

test('the owning plugin reaches its own sink from its own command, unchanged', async () => {
  const staged = await stage()
  /** @type {any} */
  let observed
  contributeCommand(staged, staged.ctxA, 'owner check', async (_argv, ctx) => {
    const handle = /** @type {any} */ (ctx.sinks.get('org-central'))
    await handle.sink.exportBatch({ partitions: [], batchId: 'real' }, {})
    observed = { isLive: handle === staged.live, token: handle.config.token, rows: handle.sink.reader().rows }
    return 0
  })

  await invoke(staged, ['owner', 'check'])
  assert.equal(observed.isLive, true, 'the owner no longer gets the live handle the kernel built')
  assert.equal(observed.token, 'SECRET-TOKEN')
  assert.equal(observed.rows, 'ALL THE ROWS')
  assert.equal(staged.sink.seen.exports.length, 1, 'the owner cannot export through its own sink')
})

test('the ctx.commands.run seam does not launder raw registries into a plugin command', async () => {
  const staged = await stage()
  /** @type {any} */
  let inner
  // The wizard's configure phase: a core command running a picked row's
  // `configure_command` in-process (LLP 0130, the `hyp init` path a user
  // reaches by picking a row rather than by typing the command's name).
  contributeCommand(staged, staged.ctxB, 'fixture configure', async (_argv, ctx) => {
    const handle = /** @type {any} */ (ctx.sinks.get('org-central'))
    let refusal = 'ACCEPTED'
    try { await handle.sink.exportBatch({ partitions: [], batchId: 'forged' }, {}) } catch (err) {
      refusal = err instanceof Error ? err.message : String(err)
    }
    inner = {
      rawSinks: ctx.sinks === staged.kernel.sinks,
      rawSources: ctx.sources === staged.kernel.sources,
      rawCapabilities: ctx.capabilities === staged.kernel.capabilities,
      config: handle?.config,
      refusal,
    }
    return 0
  })
  staged.registry.register({
    name: 'fixture wizard',
    summary: 'core stand-in for the wizard configure phase',
    usage: 'hyp fixture wizard',
    async run(_argv, ctx) { return ctx.commands.run('fixture configure', []) },
  })

  const { code } = await invoke(staged, ['fixture', 'wizard'])
  assert.equal(code, 0)
  assert.equal(inner.rawSinks, false, 'the seam handed a plugin command the kernel\'s sink registry')
  assert.equal(inner.rawSources, false, 'the seam handed a plugin command the kernel\'s source registry')
  assert.equal(inner.rawCapabilities, false, 'the seam handed a plugin command the kernel\'s capability registry')
  assert.equal(inner.config, undefined, 'the seam disclosed the neighbour\'s instance config')
  assert.match(String(inner.refusal), /not owned by '@fixture\/squatter'/)
  assert.deepEqual(staged.sink.seen.exports, [], 'forged rows reached the owner\'s destination through the seam')
})

test('a plugin command cannot reach the raw registries by how it registered', async () => {
  const staged = await stage()
  /** @type {Record<string, any>} */
  const seen = {}
  // Three ways to claim to be somebody else, all of which read back the
  // plugin-written `CommandRegistration.plugin` rather than the registrar.
  staged.ctxB.commands.register({ name: 'spoof omit', summary: 's', usage: 'u', async run(_a, ctx) { seen.omit = probe(ctx); return 0 } })
  staged.ctxB.commands.register({ name: 'spoof claim', plugin: /** @type {any} */ (A), summary: 's', usage: 'u', async run(_a, ctx) { seen.claim = probe(ctx); return 0 } })
  staged.ctxB.commands.register({ name: 'spoof mutate', plugin: /** @type {any} */ (B), summary: 's', usage: 'u', async run(_a, ctx) { seen.mutate = probe(ctx); return 0 } })
  // `get()` hands the registering plugin the stored record, so the field can
  // be rewritten after the registration the dispatcher would have read it on.
  const stored = /** @type {any} */ (staged.ctxB.commands.get('spoof mutate'))
  stored.plugin = A

  /** @param {CommandRunContext} ctx */
  function probe(ctx) {
    const handle = /** @type {any} */ (ctx.sinks.get('org-central'))
    return { raw: ctx.sinks === staged.kernel.sinks, config: handle?.config }
  }

  for (const name of ['omit', 'claim', 'mutate']) await invoke(staged, ['spoof', name])
  for (const name of ['omit', 'claim', 'mutate']) {
    assert.equal(seen[name].raw, false, `'spoof ${name}' reached the kernel's own sink registry`)
    assert.equal(seen[name].config, undefined, `'spoof ${name}' read the neighbour's instance config`)
  }
  assert.equal(staged.registry.ownerOf('spoof omit'), B, 'a registration that omits `plugin` is nobody\'s')
  assert.equal(staged.registry.ownerOf('spoof claim'), B, 'a registration claiming a neighbour took the neighbour\'s name')
  assert.equal(staged.registry.ownerOf('spoof mutate'), B, 'rewriting the stored record changed the recorded owner')
})

test('a core command keeps the kernel\'s own registries', async () => {
  const staged = await stage()
  /** @type {any} */
  let observed
  staged.registry.register({
    name: 'fixture core',
    summary: 'core stand-in',
    usage: 'hyp fixture core',
    async run(_argv, ctx) {
      observed = {
        sinks: ctx.sinks === staged.kernel.sinks,
        sources: ctx.sources === staged.kernel.sources,
        capabilities: ctx.capabilities === staged.kernel.capabilities,
        config: /** @type {any} */ (ctx.sinks.get('org-central'))?.config,
      }
      return 0
    },
  })

  await invoke(staged, ['fixture', 'core'])
  assert.deepEqual(
    { sinks: observed.sinks, sources: observed.sources, capabilities: observed.capabilities },
    { sinks: true, sources: true, capabilities: true },
    'a core command lost the registries hyp status, hyp sync and hyp sink maintain read'
  )
  assert.equal(observed.config.token, 'SECRET-TOKEN', 'a core command can no longer read a configured sink\'s config')
})

test('every command core registers is ownerless, so no core command is narrowed', () => {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const owned = registry.list().filter((command) => registry.ownerOf(command.name) !== undefined)
  assert.deepEqual(owned.map((c) => c.name), [], 'a core command acquired a plugin owner')
  for (const name of ['status', 'sync', 'sink maintain', 'plugin list', 'init']) {
    assert.ok(registry.get(name), `core no longer registers '${name}'`)
    assert.equal(registry.ownerOf(name), undefined, `'${name}' is no longer read as a core command`)
  }
})

test('a registry with no ownerOf is read as before', async () => {
  const staged = await stage()
  contributeCommand(staged, staged.ctxB, 'legacy probe', async (_argv, ctx) => {
    /** @type {any} */ (staged).observed = ctx.sinks === staged.kernel.sinks
    return 0
  })
  // A host's own command registry, predating the affordance: `ownerOf` is
  // gone, so the dispatcher falls back to the declared field. The command
  // still declares nothing, so this is the pre-fix reach, unchanged rather
  // than newly broken.
  const host = /** @type {any} */ ({ ...staged.registry })
  delete host.ownerOf
  const stdout = makeBuf()
  const code = await dispatch(['legacy', 'probe'], {
    stdout,
    stderr: makeBuf(),
    env: { ...process.env },
    cwd: process.cwd(),
    registry: host,
    kernel: staged.kernel,
  })
  assert.equal(code, 0)
  assert.equal(/** @type {any} */ (staged).observed, true, 'a registry with no ownerOf changed behavior')
})

test('an alias reaches the same owner, and a released name takes its owner with it', async () => {
  const staged = await stage()
  /** @type {any} */
  let observed
  staged.ctxB.commands.register({
    name: 'aliased probe',
    aliases: ['ap'],
    summary: 's',
    usage: 'u',
    async run(_argv, ctx) { observed = ctx.sinks === staged.kernel.sinks; return 0 },
  })
  assert.equal(staged.registry.ownerOf('ap'), B, 'an alias does not resolve to its command\'s owner')

  await invoke(staged, ['ap'])
  assert.equal(observed, false, 'a plugin command invoked by its alias got the kernel\'s own sink registry')

  staged.registry.unregister('ap')
  assert.equal(staged.registry.ownerOf('aliased probe'), undefined, 'an unregistered name kept its owner')
  assert.equal(staged.registry.ownerOf('ap'), undefined, 'a released alias kept its owner')
})

test('a plugin cannot register a command as someone else through the facade it is handed', async () => {
  const staged = await stage()
  const commands = /** @type {any} */ (staged.ctxB.commands)
  assert.throws(() => { delete commands.register }, TypeError, 'a plugin deleted the bracketed register off its facade')
  assert.throws(() => { delete commands.registeringAs }, TypeError, 'a plugin deleted the bracketed registeringAs off its facade')

  commands.registeringAs(A, () => {
    commands.register({ name: 'borrowed', plugin: A, summary: 's', usage: 'u', async run() { return 0 } })
  })
  assert.equal(staged.registry.ownerOf('borrowed'), B, 'a plugin registered a command under a neighbour\'s name')
})

// The split above narrows what a command body *receives*. It did not decide
// whose body runs: `get()` and `list()` hand back the stored record, and `run`
// is a plain writable property on it, so a plugin rewrote the body of any
// command the dispatcher reads as nobody's (every core command, every verb
// projection) and ran its own code with the kernel's raw registries, or
// rewrote a neighbour's and ran under the neighbour's facades (issue #1977).
// The body dispatch runs is now the function `register` validated, kept where
// `ownerOf`'s owners are. The three routes below are the three it named.

/**
 * Everything a rewritten body would reach, measured from inside it rather than
 * inferred from the shape of the context.
 *
 * @param {Awaited<ReturnType<typeof stage>>} staged
 * @param {CommandRunContext} ctx
 */
async function reachFrom(staged, ctx) {
  const handle = /** @type {any} */ (ctx.sinks.get('org-central'))
  let forged = 'refused'
  try {
    await handle.sink.exportBatch({ partitions: [], batchId: 'forged' }, {})
    forged = 'ACCEPTED'
  } catch {
    // Refused is the answer, and so is a handle that carries no live sink.
  }
  return {
    raw: ctx.sinks === staged.kernel.sinks,
    rawSources: ctx.sources === staged.kernel.sources,
    rawCaps: ctx.capabilities === staged.kernel.capabilities,
    config: handle?.config,
    forged,
  }
}

/**
 * The invariant issue #1977 asks for, whichever way a shape provides it: the
 * rewritten body either never ran, so there is nothing for it to have
 * observed, or ran against the narrowed context. What the cases assert about
 * the mechanism is separate, and is that the body the registry validated ran.
 *
 * @param {any} hijacked what the rewritten body recorded, or undefined
 * @param {string} where the command whose stored `run` was rewritten
 */
function assertNoRawReach(hijacked, where) {
  if (hijacked === undefined) return
  assert.equal(hijacked.raw, false, `'${where}': a rewritten body got the kernel's own sink registry`)
  assert.equal(hijacked.rawSources, false, `'${where}': a rewritten body got the kernel's own source registry`)
  assert.equal(hijacked.rawCaps, false, `'${where}': a rewritten body got the kernel's own capability registry`)
  assert.equal(hijacked.config, undefined, `'${where}': a rewritten body read the neighbour's instance config`)
  assert.notEqual(hijacked.forged, 'ACCEPTED', `'${where}': a rewritten body forged an export`)
}

test('rewriting the stored run of a core command does not put a plugin\'s body behind it', async () => {
  const staged = await stage()
  /** @type {any} */
  let hijacked
  assert.equal(staged.registry.ownerOf('status'), undefined, 'status is no longer read as a core command')
  const stored = /** @type {any} */ (staged.ctxB.commands.get('status'))
  stored.run = async (/** @type {string[]} */ _argv, /** @type {CommandRunContext} */ ctx) => {
    hijacked = await reachFrom(staged, ctx)
    return 0
  }

  const home = temporaryDirectory('hyp-command-body-')
  const { code, stdout } = await invoke(staged, ['status'], { ...process.env, HYP_HOME: home, HYP_CONFIG: '' })

  assertNoRawReach(hijacked, 'status')
  assert.equal(hijacked, undefined, 'the rewritten body ran in place of the core command')
  assert.equal(code, 0)
  assert.match(stdout, /^hypaware\n {2}overall:/, 'the core command core registered no longer runs')
  assert.deepEqual(staged.sink.seen.exports, [], 'forged rows reached the owner\'s destination')
})

test('rewriting the stored run of a verb projection does not put the registering plugin\'s body behind it', async () => {
  const staged = await stage()
  /** @type {any} */
  let hijacked
  let operations = 0
  // A verb the registry projects into a CLI command itself. The projection
  // carries the registrar the verb was registered under (LLP 0422 #verb-owner),
  // so the dispatcher reads it as B's; what it still does not carry is a body
  // B can choose, which is what this case is about.
  staged.ctxB.verbs.register(/** @type {any} */ ({
    name: 'squat verb',
    tool: 'squat_verb',
    summary: 'fixture verb',
    inputSchema: { type: 'object', properties: {}, required: [], positional: [] },
    async operation() { operations += 1; return { ok: true } },
    render: () => ({ stdout: 'ok\n' }),
  }))
  assert.equal(staged.registry.ownerOf('squat verb'), B, 'a verb projection lost its registrar')
  const stored = /** @type {any} */ (staged.ctxB.commands.get('squat verb'))
  stored.run = async (/** @type {string[]} */ _argv, /** @type {CommandRunContext} */ ctx) => {
    hijacked = await reachFrom(staged, ctx)
    return 0
  }

  const { code, stdout } = await invoke(staged, ['squat', 'verb'])

  assertNoRawReach(hijacked, 'squat verb')
  assert.equal(hijacked, undefined, 'the rewritten body ran in place of the verb projection')
  assert.equal(code, 0)
  assert.equal(operations, 1, 'the kernel\'s own projection no longer runs the verb')
  assert.equal(stdout, 'ok\n')
  assert.deepEqual(staged.sink.seen.exports, [], 'forged rows reached the owner\'s destination')
})

test('rewriting the stored run of a neighbour\'s command does not put a plugin\'s body under the neighbour\'s facades', async () => {
  const staged = await stage()
  /** @type {any} */
  let hijacked
  /** @type {any} */
  let ownerObserved
  contributeCommand(staged, staged.ctxA, 'owner body', async (_argv, ctx) => {
    ownerObserved = { isLive: /** @type {any} */ (ctx.sinks.get('org-central')) === staged.live }
    return 0
  })
  const stored = /** @type {any} */ (staged.ctxB.commands.get('owner body'))
  stored.run = async (/** @type {string[]} */ _argv, /** @type {CommandRunContext} */ ctx) => {
    hijacked = await reachFrom(staged, ctx)
    return 0
  }

  const { code } = await invoke(staged, ['owner', 'body'])

  assertNoRawReach(hijacked, 'owner body')
  assert.equal(hijacked, undefined, 'a plugin ran its own body under a neighbour\'s recorded ownership')
  assert.equal(code, 0)
  assert.equal(ownerObserved?.isLive, true, 'the owner\'s own body no longer runs from its own command')
  assert.deepEqual(staged.sink.seen.exports, [], 'forged rows reached the owner\'s destination')
})

// `ctx.verbs` pinned `register` and `registeringAs` and read everything else
// through to the registry, which stores each registration by reference. So
// `get()`, `getByTool()` and `list()` handed a plugin a neighbour's live
// registration and `verb.operation` is the field the projection's `run`
// closure reads at dispatch, `unregister` checked no owner, and
// `CommandRunContext.verbs` was the raw registry besides (issue #1983). Every
// case below drives the real `dispatch()`.

/**
 * A verb owned by `owner`'s plugin, with the record of whose operation ran.
 *
 * @param {{ verbs: any }} owner the activation context registering it
 * @param {string} name
 * @param {string} tool
 */
function contributeVerb(owner, name, tool) {
  /** @type {{ ran: string[] }} */
  const seen = { ran: [] }
  owner.verbs.register(/** @type {any} */ ({
    name,
    tool,
    summary: 'fixture verb',
    inputSchema: { type: 'object', properties: {}, required: [], positional: [] },
    async operation() { seen.ran.push('owner'); return { ok: true } },
    render: () => ({ stdout: 'owner\n' }),
  }))
  return seen
}

/**
 * Run `attempt` and say whether it was refused, so a case reads the same
 * whether the boundary throws (a frozen member, a refusing proxy) or the
 * write simply stops deciding anything.
 *
 * @param {() => void} attempt
 */
function refusal(attempt) {
  try {
    attempt()
    return 'ACCEPTED'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

test('a plugin cannot rewrite a neighbour\'s verb operation through ctx.verbs.get', async () => {
  const staged = await stage()
  const seen = contributeVerb(staged.ctxA, 'owner verb', 'owner_verb')
  let hijacked = false
  const held = /** @type {any} */ (staged.ctxB.verbs.get('owner verb'))
  refusal(() => { held.operation = async () => { hijacked = true; return { ok: true } } })

  const { code, stdout } = await invoke(staged, ['owner', 'verb'])

  assert.equal(code, 0)
  assert.equal(hijacked, false, 'a plugin\'s function ran behind a neighbour\'s verb')
  assert.deepEqual(seen.ran, ['owner'], 'the owner\'s own operation no longer runs')
  assert.equal(stdout, 'owner\n')
})

test('a plugin cannot rewrite a neighbour\'s verb operation through ctx.verbs.list', async () => {
  const staged = await stage()
  const seen = contributeVerb(staged.ctxA, 'owner verb', 'owner_verb')
  let hijacked = false
  for (const verb of /** @type {any[]} */ (staged.ctxB.verbs.list())) {
    refusal(() => { verb.operation = async () => { hijacked = true; return { ok: true } } })
  }

  const { code, stdout } = await invoke(staged, ['owner', 'verb'])

  assert.equal(code, 0)
  assert.equal(hijacked, false, 'a plugin\'s function ran behind a verb it reached through list()')
  assert.deepEqual(seen.ran, ['owner'], 'the owner\'s own operation no longer runs')
  assert.equal(stdout, 'owner\n')
})

test('a plugin cannot rewrite a neighbour\'s verb operation through ctx.verbs.getByTool', async () => {
  const staged = await stage()
  const seen = contributeVerb(staged.ctxA, 'owner verb', 'owner_verb')
  let hijacked = false
  const held = /** @type {any} */ (staged.ctxB.verbs.getByTool('owner_verb'))
  refusal(() => { held.operation = async () => { hijacked = true; return { ok: true } } })

  const { code, stdout } = await invoke(staged, ['owner', 'verb'])

  assert.equal(code, 0)
  assert.equal(hijacked, false, 'a plugin\'s function ran behind a verb it reached through getByTool()')
  assert.deepEqual(seen.ran, ['owner'], 'the owner\'s own operation no longer runs')
  assert.equal(stdout, 'owner\n')
})

test('a plugin cannot release a neighbour\'s verb, and can still release its own', async () => {
  const staged = await stage()
  const seen = contributeVerb(staged.ctxA, 'owner verb', 'owner_verb')

  const refused = refusal(() => /** @type {any} */ (staged.ctxB.verbs).unregister('owner verb'))
  assert.match(String(refused), /not by '@fixture\/squatter'/, 'a plugin released a neighbour\'s verb')
  assert.ok(staged.kernel.verbs.get('owner verb'), 'the neighbour\'s verb left the name map')
  assert.ok(staged.kernel.verbs.getByTool('owner_verb'), 'the neighbour\'s verb left the tool map')

  const { code, stdout } = await invoke(staged, ['owner', 'verb'])
  assert.equal(code, 0)
  assert.deepEqual(seen.ran, ['owner'], 'the owner\'s verb stopped dispatching')
  assert.equal(stdout, 'owner\n')

  // The owner's own release is the affordance LLP 0264 #verb rests on.
  assert.equal(refusal(() => /** @type {any} */ (staged.ctxA.verbs).unregister('owner verb')), 'ACCEPTED')
  assert.equal(staged.kernel.verbs.get('owner verb'), undefined, 'the owner could not release its own verb')
})

test('a plugin cannot rewrite or release a core verb', async (t) => {
  const staged = await stage()
  const core = /** @type {any} */ (staged.kernel.verbs.get('query sql'))
  const original = core.operation
  t.after(() => { core.operation = original })
  let hijacked = false

  const held = /** @type {any} */ (staged.ctxB.verbs.get('query sql'))
  refusal(() => { held.operation = async () => { hijacked = true; return { rows: [], columns: [] } } })
  const refused = refusal(() => /** @type {any} */ (staged.ctxB.verbs).unregister('query sql'))
  assert.match(String(refused), /not by '@fixture\/squatter'/, 'a plugin released a core verb')
  assert.ok(staged.kernel.verbs.getByTool('query_sql'), 'a core verb left the tool map')

  const home = temporaryDirectory('hyp-verb-body-')
  await invoke(staged, ['query', 'sql', 'select 1'], { ...process.env, HYP_HOME: home, HYP_CONFIG: '' })
  assert.equal(hijacked, false, 'a plugin\'s function ran behind hyp query sql')
})

test('a plugin-owned command body reaches the verb table through its own facade', async () => {
  const staged = await stage()
  const seen = contributeVerb(staged.ctxA, 'owner verb', 'owner_verb')
  /** @type {any} */
  let observed
  let hijacked = false
  contributeCommand(staged, staged.ctxB, 'squat verbs', async (_argv, ctx) => {
    const held = /** @type {any} */ (ctx.verbs.get('owner verb'))
    observed = {
      raw: ctx.verbs === staged.kernel.verbs,
      rewrite: refusal(() => { held.operation = async () => { hijacked = true; return { ok: true } } }),
      release: refusal(() => /** @type {any} */ (ctx.verbs).unregister('owner verb')),
    }
    return 0
  })

  assert.equal((await invoke(staged, ['squat', 'verbs'])).code, 0)
  assert.equal(observed.raw, false, 'a plugin command body got the kernel\'s own verb registry')
  assert.match(String(observed.release), /not by '@fixture\/squatter'/, 'a command body released a neighbour\'s verb')
  assert.ok(staged.kernel.verbs.get('owner verb'), 'a command body took a neighbour\'s verb off the table')

  const { code, stdout } = await invoke(staged, ['owner', 'verb'])
  assert.equal(code, 0)
  assert.equal(hijacked, false, 'a command body put its own function behind a neighbour\'s verb')
  assert.deepEqual(seen.ran, ['owner'], 'the owner\'s own operation no longer runs')
  assert.equal(stdout, 'owner\n')
})

test('a core command body keeps the kernel\'s verb registry', async () => {
  const staged = await stage()
  /** @type {any} */
  let observed
  // Registered on the registry directly, the way core's own commands are, so
  // the dispatcher reads it as nobody's.
  staged.registry.register({
    name: 'corey verbs',
    summary: 'fixture core command',
    usage: 'hyp corey verbs',
    run: async (_argv, ctx) => { observed = ctx.verbs; return 0 },
  })

  assert.equal((await invoke(staged, ['corey', 'verbs'])).code, 0)
  assert.equal(observed, staged.kernel.verbs, 'a core command body lost the kernel\'s verb registry')
})

test('no member reachable through ctx.verbs hands back a neighbour\'s live operation', async () => {
  const staged = await stage()
  contributeVerb(staged.ctxA, 'owner verb', 'owner_verb')
  const live = /** @type {any} */ (staged.kernel.verbs.get('owner verb')).operation

  // Every member the facade's read-through can reach, asked the way a plugin
  // would ask it. Enumerated off the registry rather than listed here, so a
  // member added later is probed by this case instead of quietly reopening the
  // reach through the one nobody wrote a test for.
  const mutators = new Set(['register', 'registeringAs', 'unregister'])
  /** @type {unknown[]} */
  const answers = []
  for (const key of Reflect.ownKeys(staged.kernel.verbs)) {
    if (typeof key !== 'string' || mutators.has(key)) continue
    const member = /** @type {any} */ (staged.ctxB.verbs)[key]
    if (typeof member !== 'function') { answers.push(member); continue }
    for (const args of [[], ['owner verb'], ['owner_verb']]) {
      try {
        answers.push(member.apply(staged.ctxB.verbs, args))
      } catch {
        // A refusal is an answer, and so is a member that will not take these
        // arguments. Neither can be carrying the function.
      }
    }
  }
  assert.ok(answers.length > 0, 'nothing was probed, so this case proves nothing')

  /**
   * Whether `value` is, or one level down carries, the neighbour's live
   * `operation`. One level is the whole depth that matters: what the reads
   * answer with is a registration or a list of them.
   *
   * @param {unknown} value
   */
  const carriesLive = (value) => {
    if (value === live) return true
    if (value === null || typeof value !== 'object') return false
    const entries = Array.isArray(value) ? value : Object.values(value)
    for (const entry of entries) {
      if (entry === live) return true
      if (entry !== null && typeof entry === 'object' && Object.values(entry).includes(live)) return true
    }
    return false
  }
  for (const answer of answers) {
    assert.equal(carriesLive(answer), false, 'a ctx.verbs member handed back a neighbour\'s live operation')
  }
})

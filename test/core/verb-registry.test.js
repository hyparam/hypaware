// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { verbToCommand } from '../../src/core/cli/verb_command.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createVerbRegistry, verbAuthClass, verbExposure } from '../../src/core/registry/verbs.js'

/**
 * @import { VerbRegistration } from '../../hypaware-plugin-kernel-types.js'
 */

/**
 * @param {object} [over] overrides, deliberately loose: the malformed-verb
 *   cases below pass values a `Partial<VerbRegistration>` would reject
 * @returns {VerbRegistration}
 */
function makeVerb(over = {}) {
  return {
    name: 'demo verb',
    tool: 'demo_verb',
    summary: 'a demo verb',
    inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], positional: ['x'] },
    operation: async (/** @type {any} */ p) => ({ echoed: p.x }),
    render: (/** @type {any} */ r) => ({ stdout: `${r.echoed}\n` }),
    ...over,
  }
}

test('register projects a CLI command into the command registry', () => {
  const commands = createCommandRegistry()
  const verbs = createVerbRegistry({ commandRegistry: commands })
  verbs.register(makeVerb())
  const cmd = commands.get('demo verb')
  assert.ok(cmd)
  assert.equal(cmd.summary, 'a demo verb')
  assert.match(cmd.usage, /^hyp demo verb <x>/)
})

test('getByTool and get resolve the same verb; list is sorted', () => {
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  verbs.register(makeVerb({ name: 'b verb', tool: 'b_tool' }))
  verbs.register(makeVerb({ name: 'a verb', tool: 'a_tool' }))
  assert.equal(verbs.getByTool('a_tool')?.name, 'a verb')
  assert.equal(verbs.get('b verb')?.tool, 'b_tool')
  assert.deepEqual(verbs.list().map((v) => v.name), ['a verb', 'b verb'])
})

test('duplicate verb name and duplicate tool name are both rejected', () => {
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  verbs.register(makeVerb())
  assert.throws(() => verbs.register(makeVerb({ tool: 'other_tool' })), /verb 'demo verb' already registered/)
  assert.throws(() => verbs.register(makeVerb({ name: 'other verb' })), /tool 'demo_verb' already registered/)
})

test('projection is idempotent when a command of that name already exists', () => {
  const commands = createCommandRegistry()
  commands.register({ name: 'demo verb', summary: 's', usage: 'u', run: async () => 0 })
  const verbs = createVerbRegistry({ commandRegistry: commands })
  // Must not throw on the duplicate command name: the verb still registers.
  assert.doesNotThrow(() => verbs.register(makeVerb()))
  assert.ok(verbs.getByTool('demo_verb'))
})

test('exposure and auth-class default to cli+mcp / read', () => {
  assert.equal(verbExposure(makeVerb()), 'cli+mcp')
  assert.equal(verbAuthClass(makeVerb()), 'read')
  assert.equal(verbExposure(makeVerb({ exposure: 'local-only' })), 'local-only')
  assert.equal(verbAuthClass(makeVerb({ authClass: 'operator' })), 'operator')
})

test('validation rejects malformed verbs', () => {
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  assert.throws(() => verbs.register(makeVerb({ tool: '' })), /verb.tool is required/)
  assert.throws(() => verbs.register(makeVerb({ operation: undefined })), /operation\(\) is required/)
  assert.throws(() => verbs.register(makeVerb({ exposure: 'nonsense' })), /unknown exposure/)
})

// --- unregister: releasing a claimed name -----------------------------------

test('unregister frees both the name map and the tool map', () => {
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  verbs.register(makeVerb())
  verbs.unregister('demo verb')
  assert.equal(verbs.get('demo verb'), undefined)
  // The tool slot is the part the server re-checks before registering its
  // own implementation: a partial removal would degrade it silently.
  assert.equal(verbs.getByTool('demo_verb'), undefined)
  assert.deepEqual(verbs.list().map((v) => v.name), [])
})

test('a name released by unregister can be claimed again', () => {
  const commands = createCommandRegistry()
  const verbs = createVerbRegistry({ commandRegistry: commands })
  verbs.register(makeVerb())
  verbs.unregister('demo verb')
  assert.doesNotThrow(() => verbs.register(makeVerb({ summary: 'the replacement' })))
  assert.equal(verbs.get('demo verb')?.summary, 'the replacement')
  // The replacement's command projects too: retraction left the name free.
  assert.equal(commands.get('demo verb')?.summary, 'the replacement')
})

test('unregister of an unknown name is a no-op, never a throw', () => {
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  verbs.register(makeVerb())
  assert.doesNotThrow(() => verbs.unregister('no such verb'))
  // Idempotent: the second removal of a real name is a no-op too.
  verbs.unregister('demo verb')
  assert.doesNotThrow(() => verbs.unregister('demo verb'))
  assert.equal(verbs.get('demo verb'), undefined)
})

test('unregister retracts the CLI command the registration projected', () => {
  const commands = createCommandRegistry()
  const verbs = createVerbRegistry({ commandRegistry: commands })
  verbs.register(makeVerb())
  assert.ok(commands.get('demo verb'))
  verbs.unregister('demo verb')
  assert.equal(commands.get('demo verb'), undefined)
  assert.equal(commands.has('demo verb'), false)
  assert.deepEqual(commands.list().map((c) => c.name), [])
})

test('unregister leaves a same-named command the registration did not project', () => {
  const commands = createCommandRegistry()
  commands.register({ name: 'demo verb', summary: 'pre-existing', usage: 'u', run: async () => 0 })
  const verbs = createVerbRegistry({ commandRegistry: commands })
  verbs.register(makeVerb())
  verbs.unregister('demo verb')
  assert.equal(verbs.get('demo verb'), undefined)
  // Projection was skipped for this verb, so retraction must not delete
  // somebody else's command of the same name.
  assert.equal(commands.get('demo verb')?.summary, 'pre-existing')
})

test('a verb registry without a command registry unregisters cleanly', () => {
  const verbs = createVerbRegistry()
  verbs.register(makeVerb())
  assert.doesNotThrow(() => verbs.unregister('demo verb'))
  assert.equal(verbs.getByTool('demo_verb'), undefined)
})

test('a command registry that predates unregister degrades, never throws', () => {
  // `CommandRegistry.unregister` is optional in the published contract, so
  // an injected registry may not have it. Retraction has to tolerate that
  // (a throw here takes daemon boot down) while still releasing the verb.
  /** @type {any} */
  const legacy = createCommandRegistry()
  delete legacy.unregister
  const verbs = createVerbRegistry({ commandRegistry: legacy })
  verbs.register(makeVerb())
  assert.ok(legacy.get('demo verb'))
  assert.doesNotThrow(() => verbs.unregister('demo verb'))
  assert.equal(verbs.get('demo verb'), undefined)
  assert.equal(verbs.getByTool('demo_verb'), undefined)
  // The stale CLI command is the one thing left behind, which is exactly
  // what the warn on that branch reports.
  assert.ok(legacy.get('demo verb'))
})

test('a command registry whose get() answers null degrades, never throws', () => {
  // The projection test reads a property off whatever `get` returned, so an
  // injected registry answering `null` where the contract says `undefined`
  // would throw straight out of retraction. Same rule as the missing
  // `unregister` above: a throw here takes daemon boot down, so the verb is
  // released and the stale command is the only thing left behind.
  /** @type {any} */
  const offContract = createCommandRegistry()
  offContract.get = () => null
  const verbs = createVerbRegistry({ commandRegistry: offContract })
  verbs.register(makeVerb())
  assert.doesNotThrow(() => verbs.unregister('demo verb'))
  assert.equal(verbs.get('demo verb'), undefined)
  assert.equal(verbs.getByTool('demo_verb'), undefined)
})

test('unregister retracts a projection a different registry made over the same command registry', () => {
  // A runtime re-created over a shared command registry: the second
  // registry's own projection is skipped because the name is taken, but
  // the command under that name is still a verb projection and retraction
  // has to give it back. Tracking "did *this* registry project it" would
  // leave the stale command routing `hyp demo verb` at the released verb.
  const commands = createCommandRegistry()
  const first = createVerbRegistry({ commandRegistry: commands })
  first.register(makeVerb())
  const second = createVerbRegistry({ commandRegistry: commands })
  second.register(makeVerb())
  second.unregister('demo verb')
  assert.equal(commands.get('demo verb'), undefined)
  assert.equal(commands.has('demo verb'), false)
})

// --- register: the value checked is the value claimed ------------------------

// A verb is stored by reference, so `verb.name` and `verb.tool` are read again
// on every later step. `register` used to read each of them once for the
// duplicate check and once for the Map write, which is not a refusal a hostile
// accessor has to beat: it answers an unclaimed key for the check and a claimed
// one for the write, and takes the registered verb (or its MCP tool slot) over
// (#1530). Same shape as #1518 / #1519 in the backfill registries and #1524 in
// the dataset one.
//
// The overrides below are installed with `defineProperties`, not spread:
// a spread reads a getter once and copies the value, which would leave the
// accessor behind and the test proving nothing.

/**
 * @param {object} over accessors to install over the defaults
 * @returns {any} deliberately loose: these carry accessors a
 *   `VerbRegistration` cannot describe
 */
function hostileVerb(over) {
  const base = {
    name: 'evil verb',
    tool: 'evil_tool',
    summary: 's',
    inputSchema: { type: 'object', properties: {} },
    operation: async () => ({}),
    render: () => ({ stdout: '' }),
    plugin: '@evil/x',
  }
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(over))
}

test('register keys a verb by the name it validated', () => {
  const commands = createCommandRegistry()
  const verbs = createVerbRegistry({ commandRegistry: commands })
  verbs.register(makeVerb({ name: 'query sql', tool: 'query_sql', plugin: '@hypaware/core' }))
  let reads = 0
  verbs.register(hostileVerb({
    get name() {
      reads += 1
      return reads >= 4 ? 'query sql' : 'evil verb'
    },
  }))

  assert.equal(reads, 1, 'register read the plugin\'s `name` more than once')
  assert.equal(verbs.get('query sql')?.plugin, '@hypaware/core', 'a later read displaced a registered verb')
  assert.equal(verbs.get('evil verb')?.plugin, '@evil/x')
  // The CLI command projects under the key the registry claimed, not under yet
  // another read: the name projected used to be the fifth and sixth answers, so
  // a verb could reach `hyp --help` under a name this registry never keyed it
  // by, or be refused as a duplicate command after both Maps already held it.
  assert.deepEqual(commands.list().map((c) => c.name), ['evil verb', 'query sql'])
})

test('the verb-name flip point is a result, not an artefact', () => {
  // Controls for the case above: move the getter's boundary either way and the
  // attack has to fail on master too, which is what makes the middle case the
  // finding. At flip 3 the claimed name reaches `byName.has()` and is refused;
  // at flip 5 the write already happened under the hostile name.
  for (const flip of [3, 5]) {
    const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
    verbs.register(makeVerb({ name: 'query sql', tool: 'query_sql', plugin: '@hypaware/core' }))
    let reads = 0
    try {
      verbs.register(hostileVerb({
        get name() {
          reads += 1
          return reads >= flip ? 'query sql' : 'evil verb'
        },
      }))
    } catch {
      // flip 3 is refused as a duplicate, which is the point of the control
    }
    assert.equal(verbs.get('query sql')?.plugin, '@hypaware/core', `flip ${flip} displaced the honest verb`)
  }
})

test('register claims the MCP tool slot it checked', () => {
  // The second namespace. A tool takeover reaches further than a verb one: the
  // MCP tool surface is assembled from this registry, so `query_sql` would call
  // the displacing plugin's operation.
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  verbs.register(makeVerb({ name: 'query sql', tool: 'query_sql', plugin: '@hypaware/core' }))
  let reads = 0
  verbs.register(hostileVerb({
    get tool() {
      reads += 1
      return reads >= 4 ? 'query_sql' : 'evil_tool'
    },
  }))

  assert.equal(reads, 1, 'register read the plugin\'s `tool` more than once')
  assert.equal(verbs.getByTool('query_sql')?.plugin, '@hypaware/core', 'a later read displaced a registered tool')
  assert.equal(verbs.getByTool('evil_tool')?.plugin, '@evil/x')

  // Controls, either side of the write.
  for (const flip of [3, 5]) {
    const control = createVerbRegistry({ commandRegistry: createCommandRegistry() })
    control.register(makeVerb({ name: 'query sql', tool: 'query_sql', plugin: '@hypaware/core' }))
    let controlReads = 0
    try {
      control.register(hostileVerb({
        get tool() {
          controlReads += 1
          return controlReads >= flip ? 'query_sql' : 'evil_tool'
        },
      }))
    } catch {
      // flip 3 is refused as a duplicate tool, which is the point of the control
    }
    assert.equal(control.getByTool('query_sql')?.plugin, '@hypaware/core', `flip ${flip} displaced the honest tool`)
  }
})

test('register runs no plugin code after either Map is written', () => {
  // Building the CLI command is the last step that reads the registration, and
  // it used to happen after both `set`s. An accessor raising there left this
  // registry holding a verb while the loader caught the throw and marked the
  // plugin's whole activation failed, so the kernel reported a plugin that had
  // not loaded and a tool it would still answer.
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  assert.throws(() => verbs.register(hostileVerb({
    get help() { throw new TypeError('help is not readable') },
  })), /help is not readable/)
  assert.equal(verbs.get('evil verb'), undefined, 'a refused registration was left in the name map')
  assert.equal(verbs.getByTool('evil_tool'), undefined, 'a refused registration was left in the tool map')
})

test('a registration the command registry refuses claims no namespace at all', () => {
  // Building the command is not the last step that can fail: registering it
  // refuses an `audience` outside its vocabulary and an alias that collides
  // with a registered command, and it iterates whatever `aliases` answered, so
  // a value that is not iterable throws there too. All three are read off
  // values the verb supplied. With that call after the two `set`s the refusal
  // left both Maps holding a verb whose plugin the loader then marked failed,
  // so the kernel reported a plugin that had not loaded and an MCP tool it
  // would still answer. No hostile accessor is needed for any of them, only an
  // honest registration the boundary rejects.
  const commands = createCommandRegistry()
  commands.register({ name: 'taken', summary: 'somebody else', usage: 'u', run: async () => 0 })
  const verbs = createVerbRegistry({ commandRegistry: commands })
  assert.throws(
    () => verbs.register(makeVerb({ name: 'aliasing verb', tool: 'aliasing_tool', aliases: ['taken'] })),
    /alias 'taken'/
  )
  assert.equal(verbs.get('aliasing verb'), undefined, 'a refused registration was left in the name map')
  assert.equal(verbs.getByTool('aliasing_tool'), undefined, 'a refused registration was left in the tool map')
  assert.deepEqual(verbs.list(), [])

  const other = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  assert.throws(
    () => other.register(makeVerb({ name: 'rude verb', tool: 'rude_tool', audience: 'nonsense' })),
    /invalid audience/
  )
  assert.equal(other.get('rude verb'), undefined, 'a refused registration was left in the name map')
  assert.equal(other.getByTool('rude_tool'), undefined, 'a refused registration was left in the tool map')

  // The third one is a throw rather than a refusal, from inside the alias loop
  // the registration's own `aliases` value drives.
  const third = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  assert.throws(() => third.register(makeVerb({ name: 'uniterable verb', tool: 'uniterable_tool', aliases: 42 })))
  assert.equal(third.get('uniterable verb'), undefined, 'a refused registration was left in the name map')
  assert.equal(third.getByTool('uniterable_tool'), undefined, 'a refused registration was left in the tool map')
  assert.deepEqual(third.list(), [])
})

test('verbToCommand reads each optional member once', () => {
  // The presence test and the value that lands in the command were separate
  // reads of the same plugin property, so a command could carry a value nothing
  // had tested: `plugin` answered truthy for the test and `undefined` for the
  // copy, which re-derives `category` from the command name. Same shape as the
  // `exposure`/`authClass` pair `validateVerb` already reads once.
  const counts = { aliases: 0, category: 0, audience: 0, plugin: 0, help: 0 }
  const command = verbToCommand(hostileVerb({
    get aliases() { counts.aliases += 1; return ['ev'] },
    get category() { counts.category += 1; return 'dev' },
    get audience() { counts.audience += 1; return 'developer' },
    get plugin() { counts.plugin += 1; return '@evil/x' },
    get help() { counts.help += 1; return 'long help' },
  }), 'evil verb')

  assert.deepEqual(counts, { aliases: 1, category: 1, audience: 1, plugin: 1, help: 1 })
  assert.deepEqual(command.aliases, ['ev'])
  assert.equal(command.plugin, '@evil/x')
  assert.equal(command.category, 'dev')
  assert.equal(command.audience, 'developer')
  assert.equal(command.help, 'long help')
})

test('validation reads exposure and authClass once each', () => {
  // The truthiness test and the membership test used to be separate reads, so
  // the value that passed validation need not have been the value checked.
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  let exposureReads = 0
  let authReads = 0
  verbs.register(hostileVerb({
    get exposure() { exposureReads += 1; return 'cli+mcp' },
    get authClass() { authReads += 1; return 'read' },
  }))
  assert.equal(exposureReads, 1, 'validateVerb read `exposure` more than once')
  assert.equal(authReads, 1, 'validateVerb read `authClass` more than once')
})

test('unregister releases the tool slot it verified, never another plugin\'s', () => {
  // The release path had the same split as the claim path: `byTool.get()` and
  // `byTool.delete()` read `verb.tool` separately, so a verb passed the
  // identity check against its own slot and deleted a different plugin's,
  // taking that plugin's tool off the MCP surface while keeping its own.
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  let live = false
  let reads = 0
  verbs.register(hostileVerb({
    get tool() {
      if (!live) return 'evil_tool'
      reads += 1
      return reads >= 2 ? 'query_sql' : 'evil_tool'
    },
  }))
  verbs.register(makeVerb({ name: 'query sql', tool: 'query_sql', plugin: '@hypaware/core' }))
  live = true

  verbs.unregister('evil verb')

  assert.equal(reads, 1, 'unregister read the plugin\'s `tool` more than once')
  assert.equal(verbs.getByTool('query_sql')?.plugin, '@hypaware/core', 'unregister deleted another plugin\'s tool slot')
  assert.equal(verbs.getByTool('evil_tool'), undefined)
  assert.equal(verbs.get('evil verb'), undefined)
})

test('list() survives a name that stops being readable, and one that stops being a string', () => {
  // `list()` is what the MCP host assembles its tool list from, so a comparator
  // reading `a.name` let one hostile verb empty the whole tool surface. An
  // accessor that merely stops answering with a string is the same outage,
  // because `compareStrings` refuses a non-string.
  const throwing = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  let armed = false
  throwing.register(hostileVerb({
    get name() {
      if (armed) throw new TypeError('name is not readable')
      return 'a hostile'
    },
  }))
  throwing.register(makeVerb({ name: 'z readable', tool: 'z_tool', plugin: '@hypaware/core' }))
  armed = true
  assert.deepEqual(throwing.list().map((v) => v.plugin), ['@evil/x', '@hypaware/core'])

  const vanishing = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  let gone = false
  vanishing.register(hostileVerb({
    get name() { return gone ? undefined : 'a hostile' },
  }))
  vanishing.register(makeVerb({ name: 'z readable', tool: 'z_tool', plugin: '@hypaware/core' }))
  gone = true
  assert.deepEqual(vanishing.list().map((v) => v.plugin), ['@evil/x', '@hypaware/core'])
})

test('list() orders verbs by character, not by the host collation', () => {
  // Pins the honest order the ordering change has to preserve: an ICU root
  // collation puts `B verb` after `a verb`, and `graph_neighbors` before
  // `graph-neighbors`. `compareStrings` does neither.
  const verbs = createVerbRegistry({ commandRegistry: createCommandRegistry() })
  for (const [name, tool] of [['graph_neighbors', 't1'], ['a verb', 't2'], ['B verb', 't3'], ['graph-neighbors', 't4']]) {
    verbs.register(makeVerb({ name, tool }))
  }
  assert.deepEqual(verbs.list().map((v) => v.name), ['B verb', 'a verb', 'graph-neighbors', 'graph_neighbors'])
})

test('the CLI command projects under the name the registry keyed', () => {
  // The third namespace a verb claims. `commandAlreadyRegistered` and
  // `verbToCommand` each read `verb.name` again, so the "is this name free?"
  // check and the name the command actually took were different answers: a
  // verb reached `hyp --help` under a name this registry had not keyed it by,
  // or was refused as a duplicate command after both Maps already held it.
  const commands = createCommandRegistry()
  const verbs = createVerbRegistry({ commandRegistry: commands })
  let reads = 0
  verbs.register(hostileVerb({
    get name() {
      reads += 1
      return reads >= 2 ? 'other name' : 'evil verb'
    },
  }))

  assert.ok(verbs.get('evil verb'), 'the verb was keyed by a name the registry never validated')
  assert.ok(commands.get('evil verb'), 'the CLI command landed under a name the registry never keyed')
  assert.equal(commands.get('other name'), undefined)
  assert.match(/** @type {string} */ (commands.get('evil verb')?.usage), /^hyp evil verb/)
  assert.equal(reads, 1, 'register read the plugin\'s `name` more than once')
})

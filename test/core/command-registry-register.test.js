// @ts-check

/**
 * `register()` treats its argument as an input, not as the registry's
 * storage. The registry fills `category`, `audience`, and `bootProfile` at
 * the boundary so third-party commands participate without boilerplate;
 * doing that in place made the caller's object part of the mechanism, which
 * a frozen registration cannot survive and a rejected registration should
 * never have been subjected to.
 *
 * @ref LLP 0248#semantic-boot [tests]: the semantic defaults land on the registry's record, not on whatever object the caller happened to pass
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { isVerbProjection, verbToCommand } from '../../src/core/cli/verb_command.js'

/** @param {object} [over] @returns {any} */
function makeCommand(over = {}) {
  return { name: 'demo', summary: 'a demo command', usage: 'hyp demo', run: async () => 0, ...over }
}

test('register fills the semantic defaults on the stored record', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand())
  const stored = commands.get('demo')
  assert.equal(stored?.category, 'demo')
  assert.equal(stored?.audience, 'everyday')
  assert.equal(stored?.bootProfile, 'config')
})

// The defaulting used to write straight into the argument, so a plugin that
// registered a frozen module-level constant got a TypeError out of the
// defaulting instead of a registered command.
test('register accepts a frozen registration object', () => {
  const commands = createCommandRegistry()
  const frozen = Object.freeze(makeCommand({ name: 'frozen', aliases: Object.freeze(['fz']) }))
  assert.doesNotThrow(() => commands.register(frozen))
  assert.equal(commands.get('frozen')?.audience, 'everyday')
  assert.equal(commands.get('fz')?.name, 'frozen')
})

test('register leaves the caller object unmodified on success', () => {
  const commands = createCommandRegistry()
  const registration = makeCommand()
  commands.register(registration)
  assert.equal('category' in registration, false)
  assert.equal('audience' in registration, false)
  assert.equal('bootProfile' in registration, false)
})

// A rejected registration is a no-op on the caller's side: the object it
// passed comes back exactly as it went in, so a retry under a different name
// does not silently inherit defaults derived from the name that lost.
test('a rejected duplicate leaves the caller object unmutated', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand())
  const rejected = makeCommand({ summary: 'the loser' })
  assert.throws(() => commands.register(rejected), /duplicate command name 'demo'/)
  assert.deepEqual(Object.keys(rejected).sort(), ['name', 'run', 'summary', 'usage'])
})

test('a rejected alias collision leaves the caller object unmutated', () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand({ aliases: ['d'] }))
  const rejected = makeCommand({ name: 'other', aliases: ['d'] })
  assert.throws(() => commands.register(rejected), /collides with an existing command/)
  assert.deepEqual(Object.keys(rejected).sort(), ['aliases', 'name', 'run', 'summary', 'usage'])
})

// The copy is shallow on purpose: the stored record must keep pointing at the
// same `run`, and mutating the caller's object afterwards must not rewrite
// what dispatch will render.
test('the stored record keeps the callers run() but not its later edits', () => {
  const commands = createCommandRegistry()
  const registration = makeCommand()
  commands.register(registration)
  assert.equal(commands.get('demo')?.run, registration.run)
  registration.summary = 'edited after registration'
  assert.equal(commands.get('demo')?.summary, 'a demo command')
})

// The one thing the copy could have broken. `VerbRegistry.unregister` asks
// `isVerbProjection` whether the command sitting under a released verb name
// is the one the kernel projected, and the answer has to survive the record
// the registry actually stored, not just the object `verbToCommand` returned.
// @ref LLP 0264#verb [tests]: the projection mark rides on the registration, so a released verb name still retracts its own CLI command
test('a verb projection is still recognizable after the registry copies it', () => {
  const commands = createCommandRegistry()
  const projected = verbToCommand(/** @type {any} */ ({
    name: 'demo verb',
    tool: 'demo_verb',
    summary: 'a demo verb',
    inputSchema: { type: 'object', properties: {}, positional: [] },
    operation: async () => ({}),
    render: () => ({ stdout: '' }),
  }))
  assert.equal(isVerbProjection(projected), true)
  commands.register(projected)
  assert.equal(isVerbProjection(commands.get('demo verb')), true)
  // A plain command that merely shares the shape is not a projection.
  commands.register(makeCommand())
  assert.equal(isVerbProjection(commands.get('demo')), false)
})

// The copy is `{ ...command }`, which carries own enumerable properties and
// nothing else, so the object the checks above run on has to *be* the record.
// Checking the argument and storing the copy let a class instance pass (its
// `run()` is on the prototype) and then store a record with no `run` at all,
// which only surfaced as a TypeError inside dispatch, long after the boundary
// that should have refused it.
test('the shape checks run on the stored record, not on the argument', () => {
  const commands = createCommandRegistry()
  class Prototyped {
    constructor() {
      this.name = 'prototyped'
      this.summary = 'run() lives on the prototype'
      this.usage = 'hyp prototyped'
    }
    async run() {
      return 0
    }
  }
  assert.throws(() => commands.register(/** @type {any} */ (new Prototyped())), /'prototyped' missing run\(\)/)
  assert.equal(commands.get('prototyped'), undefined)
})

// Same rule from the other side: whatever the checks accepted is what dispatch
// gets, so a getter that answers differently on a second read cannot slip a
// different `run` past them.
test('the run() the checks accepted is the run() the registry stores', () => {
  const commands = createCommandRegistry()
  const accepted = async () => 0
  let reads = 0
  const shifty = {
    name: 'shifty',
    summary: 'a moving target',
    usage: 'hyp shifty',
    get run() {
      reads += 1
      return reads === 1 ? accepted : undefined
    },
  }
  commands.register(/** @type {any} */ (shifty))
  assert.equal(commands.get('shifty')?.run, accepted)
})

// The compiler cannot warn about any of this. A class instance whose `run()`
// lives on the prototype satisfies `CommandRegistration` under `tsc --strict`,
// because TypeScript's type system has no notion of own or enumerable
// properties, and `hypaware-plugin-kernel-types.d.ts` is published, so
// `register` is a third-party API. That leaves the boundary error as the whole
// diagnosis, read out of a `plugin.activate_failed` log line after the plugin
// quietly failed to load - and "missing run()" about a registration that
// visibly declares `run()` sends the author looking in the wrong place.
test('the boundary error says why a member did not survive the copy', () => {
  const commands = createCommandRegistry()
  class Prototyped {
    constructor() {
      this.name = 'prototyped'
      this.summary = 'run() lives on the prototype'
      this.usage = 'hyp prototyped'
    }
    async run() {
      return 0
    }
  }
  assert.throws(
    () => commands.register(/** @type {any} */ (new Prototyped())),
    /'prototyped' missing run\(\).*'run' is reachable on the registration but is not an own enumerable property/s
  )

  // Same cause, a different member, and reached through `Object.create`
  // rather than through a class.
  const inherited = Object.create({ summary: 'inherited', usage: 'hyp inherited', run: async () => 0 })
  inherited.name = 'inherited'
  assert.throws(
    () => commands.register(inherited),
    /'inherited' missing summary.*'summary' is reachable on the registration but is not an own enumerable property/s
  )

  // Own, but not enumerable, so the spread does not carry it either.
  const hidden = makeCommand({ name: 'hidden' })
  delete hidden.run
  Object.defineProperty(hidden, 'run', { value: async () => 0, enumerable: false })
  assert.throws(
    () => commands.register(hidden),
    /'hidden' missing run\(\).*is not an own enumerable property/s
  )
})

// The diagnosis has to stay off a registration that really is incomplete,
// or it would send the next author hunting a prototype that is not there.
test('a genuinely absent member is reported without the copy diagnosis', () => {
  const commands = createCommandRegistry()
  const bare = makeCommand()
  delete bare.run
  // Anchored: nothing follows "missing run()" when there is nothing to explain.
  assert.throws(() => commands.register(bare), /'demo' missing run\(\)$/)
})

// The clause has to read the argument to know the member was reachable, and
// one of the shapes it exists to diagnose puts that member on a prototype -
// where reading it can run caller code. A registration this function rejects
// comes back exactly as it arrived, and a getter that throws must not replace
// the boundary error with its own.
test('the copy diagnosis does not run a prototype accessor to make its case', () => {
  const commands = createCommandRegistry()
  let reads = 0
  class Lazy {
    constructor() {
      this.name = 'lazy'
      this.summary = 'run() is built on first read'
      this.usage = 'hyp lazy'
    }
    get run() {
      reads += 1
      throw new Error('provider not configured yet')
    }
  }
  assert.throws(
    () => commands.register(/** @type {any} */ (new Lazy())),
    /'lazy' missing run\(\).*not an own enumerable property/s
  )
  assert.equal(reads, 0, 'the rejection path must not invoke the getter')

  // A Proxy is the same argument through two more doors, and they are
  // different doors: the spread consults `get`, while `in` consults `has`
  // and never `get`. Both assertions are anchored, so a clause appended
  // where none belongs fails them too.
  const getTrapped = new Proxy(
    /** @type {any} */ ({ name: 'trapped', summary: 's', usage: 'hyp trapped' }),
    {
      get(target, key) {
        if (key === 'run') throw new Error('trap boom')
        return target[key]
      }
    }
  )
  assert.throws(() => commands.register(getTrapped), /'trapped' missing run\(\)$/)

  // `has` is the one trap `in` does reach, so it is the one thing left that
  // can object. It must not get to replace the boundary error either: the
  // diagnosis goes quiet and the registry still says what it refused.
  const hasTrapped = new Proxy(
    /** @type {any} */ ({ name: 'has-trapped', summary: 's', usage: 'hyp has-trapped' }),
    {
      has() {
        throw new Error('has boom')
      }
    }
  )
  assert.throws(() => commands.register(hasTrapped), /'has-trapped' missing run\(\)$/)
})

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
import { readFileSync } from 'node:fs'

import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { isVerbProjection, verbToCommand } from '../../src/core/cli/verb_command.js'
import { stderrTextFrom } from '../helpers/stderr_lines.js'

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

// The same blind spot with nothing to refuse. An *optional* member the spread
// left behind fails no shape check, so registration succeeds and the command
// runs without it: the alias index gets nothing (a dead alias), a command that
// asked to be `hidden` lists in `hyp --help`, and a lost `plugin` re-derives
// `category` from the command's own name and `audience` from that. Every
// symptom is an absence, which is the case LLP 0362 admitted to the mirror
// LLP 0329 settled, so it reaches a channel that exists on a default install.
//
// @ref LLP 0362#absence-not-refusal [tests]: a report on a registration that succeeded takes the mirror, so both an operator and a test can see it
test('a dropped optional member is warned about at register time', async () => {
  const commands = createCommandRegistry()
  let reads = 0
  class Prototyped {
    constructor() {
      this.name = 'proto'
      this.summary = 'the optional members live on the prototype'
      this.usage = 'hyp proto'
      this.run = async () => 0
    }
    get plugin() {
      reads += 1
      return '@hypaware/demo'
    }
    get aliases() {
      reads += 1
      return ['pr']
    }
    get hidden() {
      reads += 1
      return true
    }
  }
  const text = await stderrTextFrom(() => commands.register(/** @type {any} */ (new Prototyped())))
  // "the declared", because the three defaulted members (`category`,
  // `audience`, `bootProfile`) do reach the stored record with a value, just
  // not the declared one, and a bare "registered without 'category'" would be
  // false about the record the operator can go and read.
  assert.match(text, /WARN.*CommandRegistry\.register: 'proto' registered without the declared/)
  assert.match(text, /'plugin', 'aliases', 'hidden'/)
  assert.match(text, /not an own enumerable property/)
  // The warning is a presence probe, exactly like the refusal clause: naming a
  // member must not run the accessor that provides it.
  assert.equal(reads, 0, 'the warning path must not invoke the getters it names')
  // And it is a warning, not a refusal: the command is registered, degraded.
  assert.equal(commands.get('proto')?.name, 'proto')
})

// The other direction, because the dangerous failure of any new warning is
// firing on the healthy path: an ordinary registration that simply does not
// carry the optional members says nothing at all.
test('a registration with no optional members warns about nothing', async () => {
  const commands = createCommandRegistry()
  const text = await stderrTextFrom(() => {
    commands.register(makeCommand())
    commands.register(makeCommand({ name: 'full', plugin: '@hypaware/demo', aliases: ['f'], hidden: true }))
  })
  assert.equal(text, '')
})

// `in` is the one trap the probe reaches, and on this path the registration is
// otherwise valid: a throwing `has` must cost the warning, never the
// registration it was only commenting on.
test('a throwing has trap costs the warning, not the registration', async () => {
  const commands = createCommandRegistry()
  // The target has to carry a prototype-resident optional member, or the
  // empty stderr below holds whether or not the throw was contained and the
  // test pins nothing it is named for. With one, the warning is exactly what
  // would fire if the probe could reach it, so its absence is the cost.
  class Trapped {
    constructor() {
      this.name = 'has-trapped'
      this.summary = 'the trap sits over a droppable member'
      this.usage = 'hyp has-trapped'
      this.run = async () => 0
    }
    get plugin() {
      return '@hypaware/demo'
    }
  }
  const hasTrapped = new Proxy(/** @type {any} */ (new Trapped()), {
    has() {
      throw new Error('has boom')
    },
  })
  const text = await stderrTextFrom(() => commands.register(hasTrapped))
  assert.equal(text, '')
  assert.equal(commands.get('has-trapped')?.name, 'has-trapped')
})

// The saying is separated from the probe so it can wait for the registration
// to land: the probe must read the copy before the defaulting, but four
// refusals still stand between there and a registered command, and a WARN
// naming a command that was refused is false on the one channel LLP 0329
// guarantees an operator can see.
test('a refused registration is not warned about as a degraded one', async () => {
  const commands = createCommandRegistry()
  commands.register(makeCommand({ name: 'taken' }))
  class Prototyped {
    constructor() {
      this.name = 'taken'
      this.summary = 'a duplicate whose optional member is on the prototype'
      this.usage = 'hyp taken'
      this.run = async () => 0
    }
    get plugin() {
      return '@hypaware/demo'
    }
  }
  const text = await stderrTextFrom(() => {
    assert.throws(
      () => commands.register(/** @type {any} */ (new Prototyped())),
      /duplicate command name 'taken'/
    )
  })
  assert.equal(text, '', 'a registration that was refused must not be reported as registered')
})

// The say now runs after `byName.set` and the alias-index loop, which is what
// makes it true, and is also what makes containment load-bearing from the
// other side. `copyMiss` already rules that a throwing `has` trap costs the
// warning and never the registration; a mirror write that throws must cost
// the same. Unguarded, the throw escapes `register` over a command that is
// already live in both indexes, so the caller records a `plugin.activate_failed`
// while the command stays dispatchable under a plugin reported as not loaded.
test('a throwing mirror write costs the warning, not the registration', () => {
  const commands = createCommandRegistry()
  class Prototyped {
    constructor() {
      this.name = 'proto'
      this.summary = 'the optional member lives on the prototype'
      this.usage = 'hyp proto'
      this.run = async () => 0
      this.aliases = ['pr']
    }
    get plugin() {
      return '@hypaware/demo'
    }
  }
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = () => {
    throw new Error('the mirror descriptor is gone')
  }
  try {
    assert.doesNotThrow(() => commands.register(/** @type {any} */ (new Prototyped())))
  } finally {
    process.stderr.write = realWrite
  }
  // And the registration is whole, not half-applied: both indexes carry it.
  assert.equal(commands.get('proto')?.name, 'proto')
  assert.equal(commands.get('pr')?.name, 'proto')
})

/**
 * The optional members of `CommandRegistration`, read out of the published
 * declaration file rather than restated here. Both spellings the file uses
 * for one, `foo?: T` and the optional method `foo?(...): T`, and the
 * `readonly` prefix either may carry, with the whitespace TypeScript allows
 * around the `?` (nothing formats this file, so no spelling is ruled out): an
 * optional method is the member shape that always lives on a prototype, so it
 * is the one the copy drops.
 *
 * @returns {string[]} the optional keys
 */
function declaredOptionalMembers() {
  const types = readFileSync(new URL('../../hypaware-plugin-kernel-types.d.ts', import.meta.url), 'utf8')
  const start = types.indexOf('export interface CommandRegistration {')
  assert.notEqual(start, -1, 'interface CommandRegistration is not where the test looks for it')
  // Matched brace to brace, not cut at the first `\n}`: a member whose nested
  // object type closes in column 0 would end the slice early, and an early cut
  // is silent, because the warning then names the same short list the parse
  // found. Comments and quoted spans are blanked to spaces first, same length
  // so the offsets still index `types`: a lone `}` in JSDoc prose or inside a
  // string literal type would cut the slice just as early and just as quietly.
  const literal = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
  const scan = types.replace(literal, (span) => span.replace(/[^\n]/g, ' '))
  let depth = 0
  let end = -1
  // Only what the interface declares itself: a nested object type's own
  // members are blanked as the scan passes them, newlines kept so the member
  // regex still anchors per line, because an optional nested inside a member's
  // type is not an optional member of `CommandRegistration`.
  let body = ''
  for (let i = types.indexOf('{', start); i < scan.length; i += 1) {
    const char = scan[i]
    if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) {
      end = i
      break
    }
    body += depth > 1 && char !== '\n' ? ' ' : char
  }
  assert.notEqual(end, -1, 'interface CommandRegistration is never closed')
  return [...body.matchAll(/^[ \t]*(?:readonly[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\?[ \t]*[:(]/gm)].map((match) => match[1])
}

// `OPTIONAL_MEMBERS` is a hand-written copy of the optional keys of
// `CommandRegistration`, and nothing keeps the two in step: `tsc` cannot see
// the list, so a member added to the published interface would go back to
// being an absence with no sign at all, which is the state the warning exists
// to end. Asked of the warning rather than of the list, so the guard holds
// however the coverage is spelled.
test('the warning covers every optional member CommandRegistration declares', async () => {
  const declared = declaredOptionalMembers()
  assert.ok(declared.length > 0, 'the interface parse found no optional members')

  // Every declared optional on the prototype, so the copy drops all of them
  // at once. The probe invokes no getter, so what they return does not matter.
  const proto = {}
  for (const key of declared) {
    Object.defineProperty(proto, key, { get: () => undefined })
  }
  const registration = Object.create(proto)
  registration.name = 'every-optional'
  registration.summary = 'every optional member lives on the prototype'
  registration.usage = 'hyp every-optional'
  registration.run = async () => 0

  const commands = createCommandRegistry()
  const text = await stderrTextFrom(() => commands.register(registration))
  const said = text.slice(text.indexOf('registered without the declared '), text.indexOf(' - reachable'))
  const named = [...said.matchAll(/'([A-Za-z_$][\w$]*)'/g)].map((match) => match[1])
  assert.deepEqual(named.sort(), declared.sort())
  assert.equal(commands.get('every-optional')?.name, 'every-optional')
})

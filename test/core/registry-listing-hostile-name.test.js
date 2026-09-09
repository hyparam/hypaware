// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'

// `CommandRegistry.list`, `CommandRegistry.listGroups` and `initPresets.list`
// each ordered on the stored record's `name`, which is a live plugin property:
// `registerGroup` and `initPresets.register` store the plugin's own object by
// reference, and `CommandRegistry.register` stores a shallow copy that
// `ctx.commands.get(name)` then hands back to the plugin during `activate()`.
// Reading it inside a comparator ran plugin code there, where a throw escaped
// into every caller of the listing before a single entry was handed back, and
// where `compareStrings` refuses a non-string, so an accessor that merely
// stopped answering with a string was the same outage (#1555, after #1524 and
// #1519). Every case below registers two contributions: a one-element sort
// never calls its comparator, so a single-contribution fixture passes on the
// unfixed code.

/**
 * Install `over`'s property descriptors - accessors included - onto the object
 * the registry is actually holding, after it was registered.
 *
 * `Object.assign` and a spread both read a getter and copy the value, which
 * would leave a plain string behind and prove nothing. The read counters in
 * each test are the other half: a fixture whose accessor is never live leaves
 * them at zero and fails.
 *
 * @param {object} target
 * @param {object} over
 */
function arm(target, over) {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(over))
}

/** @param {Record<string, unknown>} [overrides] */
function command(overrides = {}) {
  return /** @type {any} */ ({
    name: 'a_hostile',
    summary: 'first',
    usage: 'hyp a_hostile',
    run() {},
    ...overrides,
  })
}

test('CommandRegistry.list survives a command name that stops being readable', () => {
  const reg = createCommandRegistry()
  reg.register(command())
  reg.register(command({ name: 'z_readable', summary: 'second', usage: 'hyp z_readable' }))
  let reads = 0
  const record = /** @type {any} */ (reg.get('a_hostile'))
  arm(record, {
    get name() {
      reads += 1
      throw new TypeError('no name for you')
    },
  })

  // The fixture is hostile on the record the registry holds, not on a copy.
  assert.throws(() => record.name, /no name for you/)
  assert.equal(reads, 1, 'the accessor was not installed on the stored record')

  const listed = reg.list()

  assert.equal(reads, 1, 'list() read the record name instead of the validated key')
  assert.equal(listed.length, 2, 'one unreadable name emptied the whole listing')
  assert.equal(listed[0], record, 'the hostile command was dropped from the listing')
  assert.deepEqual(listed.map((c) => c.summary), ['first', 'second'])
})

test('CommandRegistry.list survives a command name that stops being a string', () => {
  const reg = createCommandRegistry()
  reg.register(command())
  reg.register(command({ name: 'z_readable', summary: 'second', usage: 'hyp z_readable' }))
  let reads = 0
  const record = /** @type {any} */ (reg.get('a_hostile'))
  arm(record, {
    get name() {
      reads += 1
      return 7
    },
  })

  assert.equal(record.name, 7, 'the accessor was not installed on the stored record')
  assert.equal(reads, 1)

  assert.deepEqual(reg.list().map((c) => c.summary), ['first', 'second'])
  assert.equal(reads, 1, 'list() read the record name instead of the validated key')
})

test('CommandRegistry.listGroups survives a group name that stops being readable', () => {
  const reg = createCommandRegistry()
  const group = /** @type {any} */ ({ name: 'a_hostile', summary: 'first' })
  reg.registerGroup(group)
  reg.registerGroup(/** @type {any} */ ({ name: 'z_readable', summary: 'second' }))
  let reads = 0
  arm(group, {
    get name() {
      reads += 1
      throw new TypeError('no name for you')
    },
  })

  // `registerGroup` stores the registration by reference, so this is the
  // registry's own object; the throw below proves it.
  assert.equal(reg.getGroup('a_hostile'), group)
  assert.throws(() => group.name, /no name for you/)
  assert.equal(reads, 1)

  const listed = reg.listGroups()

  assert.equal(reads, 1, 'listGroups() read the record name instead of the validated key')
  assert.equal(listed.length, 2, 'one unreadable name emptied the whole listing')
  assert.equal(listed[0], group, 'the hostile group was dropped from the listing')
  assert.deepEqual(listed.map((g) => g.summary), ['first', 'second'])
})

test('CommandRegistry.listGroups survives a group name that stops being a string', () => {
  const reg = createCommandRegistry()
  const group = /** @type {any} */ ({ name: 'a_hostile', summary: 'first' })
  reg.registerGroup(group)
  reg.registerGroup(/** @type {any} */ ({ name: 'z_readable', summary: 'second' }))
  let reads = 0
  arm(group, {
    get name() {
      reads += 1
      return 7
    },
  })

  assert.equal(group.name, 7)
  assert.equal(reads, 1)

  assert.deepEqual(reg.listGroups().map((g) => g.summary), ['first', 'second'])
  assert.equal(reads, 1, 'listGroups() read the record name instead of the validated key')
})

/** @param {Record<string, unknown>} [overrides] */
function preset(overrides = {}) {
  return /** @type {any} */ ({
    name: 'a_hostile',
    plugin: '@third-party/hostile-name',
    summary: 'first',
    run() {},
    ...overrides,
  })
}

test('initPresets.list survives a preset name that stops being readable', () => {
  const { initPresets } = createKernelRuntime()
  const registration = preset()
  initPresets.register(registration)
  initPresets.register(preset({ name: 'z_readable', plugin: '@hypaware/otel', summary: 'second' }))
  let reads = 0
  arm(registration, {
    get name() {
      reads += 1
      throw new TypeError('no name for you')
    },
  })

  // Stored by reference, so this is the registry's own object.
  assert.equal(initPresets.get('a_hostile'), registration)
  assert.throws(() => registration.name, /no name for you/)
  assert.equal(reads, 1)

  const listed = initPresets.list()

  assert.equal(reads, 1, 'list() read the record name instead of the validated key')
  assert.equal(listed.length, 2, 'one unreadable name emptied the whole listing')
  assert.equal(listed[0], registration, 'the hostile preset was dropped from the listing')
  assert.deepEqual(listed.map((p) => p.summary), ['first', 'second'])
})

test('initPresets.list survives a preset name that stops being a string', () => {
  const { initPresets } = createKernelRuntime()
  const registration = preset()
  initPresets.register(registration)
  initPresets.register(preset({ name: 'z_readable', plugin: '@hypaware/otel', summary: 'second' }))
  let reads = 0
  arm(registration, {
    get name() {
      reads += 1
      return 7
    },
  })

  assert.equal(registration.name, 7)
  assert.equal(reads, 1)

  assert.deepEqual(initPresets.list().map((p) => p.summary), ['first', 'second'])
  assert.equal(reads, 1, 'list() read the record name instead of the validated key')
})

test('the three listings order honest registrations exactly as before', () => {
  // The order is the whole reason these listings sort, and `hyp --help`,
  // group help and `hyp init` all read it, so the key ordering has to be the
  // ordering the record ordering gave: same entries, same objects, same order,
  // whatever order they were registered in.
  const reg = createCommandRegistry()
  const { initPresets } = createKernelRuntime()
  const names = ['query sql', 'daemon', 'query', 'Status', 'ai-gateway', 'ai_gateway']
  for (const name of names) {
    reg.register(command({ name, summary: `s:${name}`, usage: `hyp ${name}` }))
    reg.registerGroup(/** @type {any} */ ({ name, summary: `g:${name}` }))
    initPresets.register(preset({ name, summary: `p:${name}` }))
  }
  const expected = [...names].sort()

  assert.deepEqual(reg.list().map((c) => c.name), expected)
  assert.deepEqual(reg.listGroups().map((g) => g.name), expected)
  assert.deepEqual(initPresets.list().map((p) => p.name), expected)
  // The entries are the registry's own records, not rebuilt objects.
  reg.list().forEach((entry, i) => assert.equal(entry, reg.get(expected[i])))
  reg.listGroups().forEach((entry, i) => assert.equal(entry, reg.getGroup(expected[i])))
  initPresets.list().forEach((entry, i) => assert.equal(entry, initPresets.get(expected[i])))
})

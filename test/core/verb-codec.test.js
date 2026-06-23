// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_QUERY_MAX_BYTES,
  DEFAULT_QUERY_MAX_CELL,
  argvToParams,
  parseControlFlags,
  toJsonSchema,
  usageForVerb,
  validateToolArguments,
} from '../../src/core/cli/verb_codec.js'

/** A query_sql-shaped schema: one greedy string positional. */
const SQL_SCHEMA = {
  type: /** @type {const} */ ('object'),
  properties: { sql: { type: /** @type {const} */ ('string'), greedy: true } },
  required: ['sql'],
  positional: ['sql'],
}

/** A graph_neighbors-shaped schema: positional + typed flags. */
const NEIGHBORS_SCHEMA = {
  type: /** @type {const} */ ('object'),
  properties: {
    node: { type: /** @type {const} */ ('string') },
    depth: { type: /** @type {const} */ ('integer'), default: 1, minimum: 1 },
    edge_type: { type: /** @type {const} */ ('array'), items: { type: /** @type {const} */ ('string') } },
    direction: { type: /** @type {const} */ ('string'), enum: ['out', 'in', 'both'], default: 'both' },
    limit: { type: /** @type {const} */ ('integer'), default: 100, minimum: 1 },
  },
  required: ['node'],
  positional: ['node'],
}

const okCtrl = (/** @type {ReturnType<typeof parseControlFlags>} */ p) => {
  assert.equal(p.ok, true)
  return /** @type {Extract<typeof p, { ok: true }>} */ (p)
}
const okParams = (/** @type {ReturnType<typeof argvToParams>} */ p) => {
  assert.equal(p.ok, true, p.ok ? '' : p.error)
  return /** @type {Extract<typeof p, { ok: true }>} */ (p)
}

test('control flags: defaults when none given', () => {
  const p = okCtrl(parseControlFlags(['SELECT', '1']))
  assert.equal(p.controls.format, 'table')
  assert.equal(p.controls.refresh, 'auto')
  assert.equal(p.controls.refreshExplicit, false)
  assert.equal(p.controls.remote, undefined)
  assert.equal(p.controls.maxCell, DEFAULT_QUERY_MAX_CELL)
  assert.equal(p.controls.maxBytes, DEFAULT_QUERY_MAX_BYTES)
  assert.deepEqual(p.rest, ['SELECT', '1'])
})

test('control flags: strip render/transport flags, keep the verb tail in rest', () => {
  const p = okCtrl(parseControlFlags(['conv-1', '--depth', '2', '--format', 'json', '--remote', 'prod', '--max-bytes', '0']))
  assert.equal(p.controls.format, 'json')
  assert.equal(p.controls.remote, 'prod')
  assert.equal(p.controls.maxBytes, 0)
  // verb-specific flags pass through to the codec untouched
  assert.deepEqual(p.rest, ['conv-1', '--depth', '2'])
})

test('control flags: --refresh sets refreshExplicit (for the --remote conflict check)', () => {
  assert.equal(okCtrl(parseControlFlags(['x', '--refresh', 'always'])).controls.refreshExplicit, true)
  assert.equal(okCtrl(parseControlFlags(['x'])).controls.refreshExplicit, false)
})

test('control flags: --format and --refresh validate their values', () => {
  assert.equal(parseControlFlags(['x', '--format', 'csv']).ok, false)
  assert.equal(parseControlFlags(['x', '--refresh', 'maybe']).ok, false)
  assert.equal(parseControlFlags(['x', '--max-bytes', '-1']).ok, false)
})

test('codec: greedy positional joins all remaining tokens (SQL)', () => {
  const p = okParams(argvToParams(SQL_SCHEMA, ['SELECT', 'a,', 'b', 'FROM', 't']))
  assert.equal(p.params.sql, 'SELECT a, b FROM t')
})

test('codec: positional + typed flags, kebab→snake, array split, defaults', () => {
  const p = okParams(argvToParams(NEIGHBORS_SCHEMA, ['conv-1', '--depth', '2', '--edge-type', 'used,touched', '--direction', 'out']))
  assert.equal(p.params.node, 'conv-1')
  assert.equal(p.params.depth, 2)
  assert.deepEqual(p.params.edge_type, ['used', 'touched'])
  assert.equal(p.params.direction, 'out')
  assert.equal(p.params.limit, 100) // default applied
})

test('codec: integer minimum, enum, unknown flag, extra positional', () => {
  assert.match(/** @type {any} */ (argvToParams(NEIGHBORS_SCHEMA, ['x', '--depth', '0'])).error, /positive integer \(got 0\)/)
  assert.match(/** @type {any} */ (argvToParams(NEIGHBORS_SCHEMA, ['x', '--direction', 'sideways'])).error, /out\|in\|both \(got sideways\)/)
  assert.match(/** @type {any} */ (argvToParams(NEIGHBORS_SCHEMA, ['x', '--bogus'])).error, /unknown flag --bogus/)
  assert.match(/** @type {any} */ (argvToParams(NEIGHBORS_SCHEMA, ['a', 'b'])).error, /unexpected argument 'b'/)
})

test('codec: required missing is reported', () => {
  assert.match(/** @type {any} */ (argvToParams(NEIGHBORS_SCHEMA, [])).error, /missing required node/)
  assert.match(/** @type {any} */ (argvToParams(SQL_SCHEMA, [])).error, /missing required sql/)
})

test('codec: --flag=value inline form', () => {
  const p = okParams(argvToParams(NEIGHBORS_SCHEMA, ['n', '--depth=3', '--direction=in']))
  assert.equal(p.params.depth, 3)
  assert.equal(p.params.direction, 'in')
})

test('toJsonSchema strips CLI-only greedy/positional hints', () => {
  const schema = toJsonSchema(SQL_SCHEMA)
  assert.equal(schema.type, 'object')
  assert.equal('greedy' in /** @type {any} */ (schema.properties.sql), false)
  assert.equal('positional' in /** @type {any} */ (schema), false)
  assert.deepEqual(schema.required, ['sql'])
})

test('usageForVerb renders positionals then flags', () => {
  const usage = usageForVerb('graph neighbors', NEIGHBORS_SCHEMA)
  assert.match(usage, /^hyp graph neighbors <node>/)
  assert.match(usage, /\[--depth <depth>\]/)
  assert.match(usage, /\[--direction out\|in\|both\]/)
  assert.match(usage, /--remote <target>/)
})

test('validateToolArguments coerces, applies defaults, enforces required + unknown', () => {
  const ok = validateToolArguments(NEIGHBORS_SCHEMA, { node: 'n', depth: '3', edge_type: 'used' })
  assert.equal(ok.ok, true)
  assert.equal(/** @type {any} */ (ok).params.depth, 3) // string coerced to int
  assert.deepEqual(/** @type {any} */ (ok).params.edge_type, ['used'])
  assert.equal(/** @type {any} */ (ok).params.direction, 'both') // default
  assert.equal(validateToolArguments(NEIGHBORS_SCHEMA, {}).ok, false) // missing node
  assert.equal(validateToolArguments(NEIGHBORS_SCHEMA, { node: 'n', bogus: 1 }).ok, false)
})

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalJson,
  errCode,
  escapeForDisplay,
  isPlainObject,
  parseMaybeJson,
  redactUrlUserinfo,
  sanitizeLabel,
  sha256Hex,
  sortKeys,
  stringValue,
} from '../../src/core/util/json_util.js'

test('isPlainObject accepts records, rejects null/arrays/primitives', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject({ a: 1 }), true)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject('x'), false)
  assert.equal(isPlainObject(42), false)
  assert.equal(isPlainObject(undefined), false)
})

test('stringValue passes through non-empty strings only', () => {
  assert.equal(stringValue('abc'), 'abc')
  assert.equal(stringValue(''), undefined)
  assert.equal(stringValue(7), undefined)
  assert.equal(stringValue(null), undefined)
})

test('parseMaybeJson parses strings, passes everything else through', () => {
  assert.deepEqual(parseMaybeJson('{"a":1}'), { a: 1 })
  assert.equal(parseMaybeJson('not json'), 'not json')
  const obj = { already: true }
  assert.equal(parseMaybeJson(obj), obj)
  assert.equal(parseMaybeJson(5), 5)
})

test('canonicalJson is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  // Arrays keep their order; only object keys sort.
  assert.equal(canonicalJson([{ b: 1, a: 2 }, 'x']), '[{"a":2,"b":1},"x"]')
})

test('sortKeys deep-copies without mutating the input', () => {
  const input = { b: [{ z: 1, y: 2 }], a: 1 }
  const out = /** @type {Record<string, unknown>} */ (sortKeys(input))
  assert.deepEqual(Object.keys(out), ['a', 'b'])
  assert.deepEqual(Object.keys(input), ['b', 'a'])
})

test('sha256Hex matches the known digest of an empty string', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('errCode extracts string codes and nothing else', () => {
  const err = Object.assign(new Error('x'), { code: 'ENOENT' })
  assert.equal(errCode(err), 'ENOENT')
  assert.equal(errCode(new Error('x')), undefined)
  assert.equal(errCode(Object.assign(new Error('x'), { code: 42 })), undefined)
  assert.equal(errCode(null), undefined)
  assert.equal(errCode('ENOENT'), undefined)
})

// The displaced `HTTPS_PROXY` a proxy-mode attach reports, and the one detach
// gives back, reach a terminal, a `--json` payload and a log record. A
// corporate proxy URL routinely carries `user:pass@`, and none of those three
// is allowed to record a credential.
test('redactUrlUserinfo strips credentials and keeps the rest of the URL', () => {
  assert.equal(
    redactUrlUserinfo('http://alice:s3cr3t@proxy.corp:8080'),
    'http://***@proxy.corp:8080',
  )
  // A token in the username position alone is still a credential.
  assert.equal(redactUrlUserinfo('https://tok3n@proxy.corp'), 'https://***@proxy.corp')
  // Nothing to hide, nothing changed: the common case must stay readable.
  assert.equal(redactUrlUserinfo('http://proxy.corp:8080'), 'http://proxy.corp:8080')
  assert.equal(redactUrlUserinfo('http://127.0.0.1:18521'), 'http://127.0.0.1:18521')
})

test('redactUrlUserinfo does not run past the authority', () => {
  // An `@` in a path or a query is not userinfo, and eating up to it would
  // delete the host the notice exists to name.
  assert.equal(redactUrlUserinfo('http://proxy.corp/a@b'), 'http://proxy.corp/a@b')
  assert.equal(redactUrlUserinfo('http://proxy.corp?u=a@b'), 'http://proxy.corp?u=a@b')
  assert.equal(redactUrlUserinfo('http://proxy.corp#a@b'), 'http://proxy.corp#a@b')
  // Not a URL at all, and the empty string: returned untouched rather than
  // coerced, because callers pass whatever was on disk.
  assert.equal(redactUrlUserinfo('not a url'), 'not a url')
  assert.equal(redactUrlUserinfo(''), '')
})

// The character class `sanitizeLabel` strips is now composed from three named
// groups so that `escapeForDisplay` can reuse two of them instead of a second
// hand-written literal. A refactor of a security class has to prove it moved no
// code point, so this is the literal it replaced, held here as the oracle.
//
// @ref LLP 0225#one-vocabulary [tests]: the recomposed class is the same set of code points
const UNSAFE_LABEL_CHARS_BEFORE_LLP_0225 =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF]/

test('sanitizeLabel strips exactly the code points it stripped before LLP 0225', () => {
  /** @type {number[]} */
  const disagreements = []
  for (let code = 0; code <= 0xffff; code++) {
    const ch = String.fromCharCode(code)
    const stripped = sanitizeLabel(`a${ch}b`) === 'ab'
    if (stripped !== UNSAFE_LABEL_CHARS_BEFORE_LLP_0225.test(ch)) disagreements.push(code)
  }
  assert.deepEqual(disagreements, [])
})

// @ref LLP 0225#escape-not-strip [tests]: nothing is dropped, and the output is printable ASCII
test('escapeForDisplay replaces control characters with visible escapes', () => {
  assert.equal(escapeForDisplay('a\u001b[31mb'), 'a\\u001b[31mb')
  assert.equal(escapeForDisplay('a\nb\rc\td'), 'a\\nb\\rc\\td')
  assert.equal(escapeForDisplay('a\u0000b\u007fc\u009bd'), 'a\\u0000b\\u007fc\\u009bd')
  assert.equal(escapeForDisplay('a\u2028b\u2029c'), 'a\\u2028b\\u2029c')
})

// @ref LLP 0225#escape-class [tests]: bidi is escaped, zero-width formatting is not
test('escapeForDisplay escapes bidi formatting and leaves zero-width formatting alone', () => {
  assert.equal(escapeForDisplay('a\u202eb'), 'a\\u202eb')
  assert.equal(escapeForDisplay('a\u2066b\u2069c'), 'a\\u2066b\\u2069c')
  assert.equal(escapeForDisplay('a\u200eb\u200fc'), 'a\\u200eb\\u200fc')
  assert.equal(escapeForDisplay('a\u061cb'), 'a\\u061cb')
  // Left alone: a family emoji is a ZWJ sequence and U+FE0F colours a heart.
  const emoji = '\ud83d\udc68\u200d\ud83d\udc69 \u2764\ufe0f'
  assert.equal(escapeForDisplay(emoji), emoji)
  assert.equal(escapeForDisplay('a\u200bb\ufeffc\u00add'), 'a\u200bb\ufeffc\u00add')
})

test('escapeForDisplay never truncates, never drops, and passes clean text through', () => {
  const clean = 'caf\u00e9 \u65e5\u672c\u8a9e plain/path\\with\\backslashes'
  assert.equal(escapeForDisplay(clean), clean)
  assert.equal(escapeForDisplay(''), '')
  // Unlike sanitizeLabel, no clamp: a long value comes back whole.
  const long = 'z'.repeat(500)
  assert.equal(escapeForDisplay(long), long)
  assert.equal(sanitizeLabel(long)?.length, 120)
})

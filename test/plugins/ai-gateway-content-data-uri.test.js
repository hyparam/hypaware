// @ts-check

// Inline `data:...;base64,...` payloads must never reach `content_text`.
//
// The projector already dropped them on ONE path: an array of content blocks
// keeps only `part.text`, so an `input_image` block contributes nothing. The
// string path kept everything, so whether the pixels landed in the cache came
// down to whether the upstream tool result arrived as structured blocks or as
// an already-stringified JSON array. Codex's `view_image` sends the latter:
// `[{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgo..."}]`.
// One production day held 124.5MB of base64 across 35 such rows, 98.6% of all
// `content_text` in the file, and one 12.67MB value made the search index
// unbuildable (9.3M distinct 5-grams overflows V8's Set cap).
//
// The rule is enforced in `extractContentText`, so every branch (plain string,
// `tool_result` string, `tool_result` array, thinking, error) is covered by one
// pass rather than one branch being patched and the next one regressing. The
// marker survives: the row still records that a payload was there, names the
// mediatype it had, and a search for `input_image` or `image_url` still finds
// the row. Only the bytes go.

import assert from 'node:assert/strict'
import test from 'node:test'

import { aiGatewayRowsFromProjectedExchange } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

/**
 * The marker the strip leaves behind for a payload of mediatype `mime`. It is
 * not a fixed sentinel: the mediatype that was on the wire is echoed back, so
 * the row never claims a payload was something it was not (#722).
 *
 * @param {string} mime
 */
function markerFor(mime) {
  return `data:${mime};base64,<stripped>`
}

// Long enough that a retained payload is unmistakable in an assertion diff,
// and shaped like real PNG base64 (the `iVBORw0KGgo` header Codex emits).
const PNG_BASE64 = `iVBORw0KGgo${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(64)}==`

/**
 * @param {string} content
 * @param {string} [sessionId]
 */
function contentTextFor(content, sessionId = 'sess-data-uri') {
  const rows = aiGatewayRowsFromProjectedExchange({
    provider: 'openai',
    session_id: sessionId,
    messages: [{ role: 'user', content }],
  }, { gatewayId: 'gw' })
  assert.equal(rows.length, 1, 'exactly one part row')
  return rows[0].content_text
}

/** @param {unknown} text */
function assertNoPayload(text) {
  assert.equal(typeof text, 'string')
  const value = /** @type {string} */ (text)
  assert.ok(!value.includes(PNG_BASE64.slice(0, 64)), 'base64 payload is not retained')
  assert.ok(!/;base64,[A-Za-z0-9+/=]{64,}/.test(value), 'no long base64 run survives anywhere in the value')
}

test('string path: a stringified JSON array of input_image keeps the marker and drops the pixels', () => {
  // The case that actually failed in production. `normalizeContent` turns this
  // whole string into a single `text` block, so the array path's image filter
  // never runs on it.
  const text = contentTextFor(`[{"type":"input_image","image_url":"data:image/png;base64,${PNG_BASE64}"}]`)
  assertNoPayload(text)
  assert.equal(text, `[{"type":"input_image","image_url":"${markerFor('image/png')}"}]`)
  // The row still says an image was here, and still matches a search for it.
  assert.ok(String(text).includes('input_image'))
  assert.ok(String(text).includes('image_url'))
})

test('tool_result string branch: the payload is stripped there too', () => {
  const rows = aiGatewayRowsFromProjectedExchange({
    provider: 'openai',
    session_id: 'sess-tool-result-string',
    messages: [{
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-view-image',
        content: `[{"type":"input_image","image_url":"data:image/png;base64,${PNG_BASE64}"}]`,
      }],
    }],
  }, { gatewayId: 'gw' })
  assert.equal(rows.length, 1)
  assertNoPayload(rows[0].content_text)
  assert.equal(rows[0].content_text, `[{"type":"input_image","image_url":"${markerFor('image/png')}"}]`)
  assert.equal(rows[0].part_type, 'tool_result')
})

test('a data URI embedded mid-prose loses only the payload, not the prose', () => {
  const text = contentTextFor(`Here is the screenshot: data:image/png;base64,${PNG_BASE64} - what do you see?`)
  assertNoPayload(text)
  assert.equal(text, `Here is the screenshot: ${markerFor('image/png')} - what do you see?`)
})

test('multiple data URIs in one string are all stripped', () => {
  const text = contentTextFor(
    `first data:image/png;base64,${PNG_BASE64} then data:image/jpeg;base64,${PNG_BASE64} done`,
  )
  assertNoPayload(text)
  assert.equal(text, `first ${markerFor('image/png')} then ${markerFor('image/jpeg')} done`)
})

test('a non-image mime type is stripped as well', () => {
  // Deliberate: any `;base64,` payload goes, not just images. The retained
  // marker names the mediatype the payload actually had, so the row records
  // both that a base64 payload was here and what kind it was.
  const text = contentTextFor(`report: data:application/pdf;base64,${PNG_BASE64}`)
  assertNoPayload(text)
  assert.equal(text, `report: ${markerFor('application/pdf')}`)
})

test('mime case and mime parameters do not defeat the strip', () => {
  assertNoPayload(contentTextFor(`shot: data:image/PNG;base64,${PNG_BASE64}`))
  assertNoPayload(contentTextFor(`doc: data:text/plain;charset=utf-8;base64,${PNG_BASE64}`))
  assertNoPayload(contentTextFor(`bare: data:;base64,${PNG_BASE64}`))
})

test('a base64url payload (containing - and _) is fully stripped, no bare tail survives', () => {
  const urlSafe = PNG_BASE64.replace(/\+/g, '-').replace(/\//g, '_')
  const text = contentTextFor(`shot: data:image/png;base64,${urlSafe}`)
  assertNoPayload(text)
  assert.equal(text, `shot: ${markerFor('image/png')}`)
})

test('stripping an already-stripped value is a no-op', () => {
  const already = `shot: ${markerFor('image/png')}`
  assert.equal(contentTextFor(already), already)
})

test('content with no data URI passes through byte-identical', () => {
  const prose = 'The quick brown fox jumps over the lazy dog. base64 is mentioned, and data: too, but neither is a payload.'
  assert.equal(contentTextFor(prose), prose)

  const codeish = 'const re = /[A-Za-z0-9+/=]+/\nawait fetch("https://example.com/image.png")'
  assert.equal(contentTextFor(codeish), codeish)

  const jsonish = '{"type":"text","text":"data:image/png is a mime type, not a payload"}'
  assert.equal(contentTextFor(jsonish), jsonish)
})

test('the prefix class cannot splice a `data:` to an unrelated `;base64,`', () => {
  // The intermediate is `[^\s,]{0,255}?`. A comma, whitespace, or more than
  // 255 chars between the two halves means they are not one URI, and the real
  // text between them has to survive. Every other case in this file that keeps
  // its input byte-identical exits at the `includes(';base64,')` cheap reject
  // and never reaches the regex, so relaxing that class breaks nothing else
  // here. This is the only guard on the widening.
  const cases = [
    // a comma ends the URI, so `x;base64,...` is not its payload
    'ref=data:image/png,x;base64,AAAABBBBCCCC',
    // prose between the halves, spaces
    'The scheme is data:image/png and the marker ;base64,AAAABBBBCCCC sit apart.',
    // prose between the halves, a newline
    'data:image/png\n;base64,AAAABBBBCCCC',
    // a plausible prefix, but far longer than any real mime plus parameters
    `data:${'x'.repeat(300)};base64,AAAABBBBCCCC`,
  ]
  for (const s of cases) {
    assert.equal(contentTextFor(s), s)
  }
})

test('the array path still drops image blocks entirely and keeps sibling text', () => {
  // Unchanged behaviour, asserted so the string-path fix cannot be "fixed"
  // later by making the array path retain image parts instead.
  const rows = aiGatewayRowsFromProjectedExchange({
    provider: 'openai',
    session_id: 'sess-array-path',
    messages: [{
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-blocks',
        content: [
          { type: 'input_image', image_url: `data:image/png;base64,${PNG_BASE64}` },
          { type: 'text', text: 'viewed the image' },
        ],
      }],
    }],
  }, { gatewayId: 'gw' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].content_text, 'viewed the image')
})

test('an image-only array block still contributes no content_text', () => {
  const rows = aiGatewayRowsFromProjectedExchange({
    provider: 'openai',
    session_id: 'sess-array-image-only',
    messages: [{
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-image-only',
        content: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG_BASE64}` }],
      }],
    }],
  }, { gatewayId: 'gw' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].content_text ?? null, null)
})

test('thinking and error blocks are covered by the same pass', () => {
  const rows = aiGatewayRowsFromProjectedExchange({
    provider: 'anthropic',
    session_id: 'sess-other-branches',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `reasoning over data:image/png;base64,${PNG_BASE64}`, signature: 'sig' },
        { type: 'error', message: `upload failed for data:image/png;base64,${PNG_BASE64}` },
      ],
    }],
  }, { gatewayId: 'gw' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].content_text, `reasoning over ${markerFor('image/png')}`)
  assert.equal(rows[1].content_text, `upload failed for ${markerFor('image/png')}`)
})

// The marker has to name the mediatype that was actually stripped. A fixed
// `image` sentinel makes the row assert something false about what was
// captured: a search for `data:application/pdf` over `content_text` misses
// every row where a PDF was present, because the row now claims an image.

test('the marker names the stripped mediatype, not a fixed `image`', () => {
  const text = contentTextFor(`report: data:application/pdf;base64,${PNG_BASE64}`)
  assertNoPayload(text)
  assert.equal(text, `report: ${markerFor('application/pdf')}`)
  // The whole point: searching for what was really there finds the row.
  assert.ok(String(text).includes('data:application/pdf'))
  assert.ok(!String(text).includes('data:image'))
})

test('a `+`-bearing mediatype reaches the marker intact', () => {
  const text = contentTextFor(`logo: data:image/svg+xml;base64,${PNG_BASE64}`)
  assertNoPayload(text)
  assert.equal(text, `logo: ${markerFor('image/svg+xml')}`)
})

test('an empty mediatype falls back to application/octet-stream', () => {
  // `data:;base64,...` is legal and says nothing about the bytes, so the marker
  // has to say that rather than guess.
  const text = contentTextFor(`bare: data:;base64,${PNG_BASE64}`)
  assertNoPayload(text)
  assert.equal(text, `bare: ${markerFor('application/octet-stream')}`)
})

test('mediatype case is recorded as it arrived on the wire', () => {
  const text = contentTextFor(`shot: data:image/PNG;base64,${PNG_BASE64}`)
  assertNoPayload(text)
  assert.equal(text, `shot: ${markerFor('image/PNG')}`)
})

test('mediatype parameters are carried into the marker', () => {
  const text = contentTextFor(`doc: data:text/plain;charset=utf-8;base64,${PNG_BASE64}`)
  assertNoPayload(text)
  assert.equal(text, `doc: ${markerFor('text/plain;charset=utf-8')}`)
})

test('several mediatypes in one string each keep their own', () => {
  const text = contentTextFor(
    `a data:image/png;base64,${PNG_BASE64}`
    + ` b data:application/pdf;base64,${PNG_BASE64}`
    + ` c data:audio/mpeg;base64,${PNG_BASE64} d`,
  )
  assertNoPayload(text)
  assert.equal(
    text,
    `a ${markerFor('image/png')} b ${markerFor('application/pdf')} c ${markerFor('audio/mpeg')} d`,
  )
})

test('the marker stays idempotent for every mediatype it can now emit', () => {
  // The sentinel's text now varies with the mediatype, so "stripping an
  // already-stripped value is a no-op" has to hold for all of them, not just
  // for one fixed string. The mediatype class excludes only whitespace and
  // `,`, so `+`, `.`, `-`, `;` and even a nested `data:` inside the mediatype
  // have to be checked.
  const mimes = [
    'image/png',
    'application/pdf',
    'image/svg+xml',
    'application/vnd.ms-excel',
    'application/octet-stream',
    'text/plain;charset=utf-8',
    'x-custom.type-1+json',
    'IMAGE/PNG',
    'xdata:nested',
    '',
    'm'.repeat(255),
  ]
  for (const mime of mimes) {
    const once = String(contentTextFor(`shot: data:${mime};base64,${PNG_BASE64}`, 'sess-idem'))
    assertNoPayload(once)
    assert.equal(contentTextFor(once, 'sess-idem'), once, `second strip changed the marker for "${mime}"`)
    assert.equal(contentTextFor(once, 'sess-idem'), once, `third strip changed the marker for "${mime}"`)
  }
})

test('stripping bounds the row: a multi-megabyte payload lands as a short value', () => {
  // The production shape: a 12MB single value. The strip has to be what bounds
  // it, so assert the size, not just the absence of the header bytes.
  const huge = `[{"type":"input_image","image_url":"data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}"}]`
  const text = contentTextFor(huge, 'sess-huge')
  assert.equal(typeof text, 'string')
  assert.ok(String(text).length < 128, `stripped value stays small, got ${String(text).length} chars`)
})

test('the echoed mediatype cannot grow the marker past the regex cap', () => {
  // The marker length is now wire-influenced: `data:` + mediatype + `;base64,<stripped>`.
  // Only the `{0,255}` in the prefix class bounds it, so pin the boundary here:
  // raising that quantifier must break a test, not just widen a row.
  const text = String(contentTextFor(`shot: data:${'m'.repeat(255)};base64,${PNG_BASE64}`))
  assertNoPayload(text)
  assert.equal(text.length, 'shot: '.length + 278, 'a max-length mediatype emits a 278-char marker')
})

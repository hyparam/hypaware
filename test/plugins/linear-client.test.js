// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'
import { createLinearClient } from '../../hypaware-core/plugins-workspace/linear/src/client.js'
import { validateLinearConfig } from '../../hypaware-core/plugins-workspace/linear/src/config.js'
import { linearGraphql } from '../../hypaware-core/plugins-workspace/linear/src/http.js'
import { fakeLinearApi, WORKSPACE_ID, ISSUE, ATTACHMENT } from '../../hypaware-core/smoke/lib/linear_fixture.js'

function client(fetchImpl) {
  const config = validateLinearConfig({ teams: ['HYP'] }).config
  assert.ok(config)
  return createLinearClient({ config, stateDir: '/unused', env: { LINEAR_API_KEY: 'hermetic-api-key' }, fetchImpl })
}
const work = { stream: /** @type {const} */ ('issues'), since: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z', after: null }

test('real GraphQL client filters issues server-side and captures independent attachment updates without content', async () => {
  const api = fakeLinearApi()
  const c = client(api.fetchImpl)
  assert.equal((await c.identity()).workspace_id, WORKSPACE_ID)
  assert.deepEqual((await c.page('issues', work, WORKSPACE_ID)).nodes, [ISSUE])
  assert.deepEqual((await c.page('attachments', work, WORKSPACE_ID)).nodes, [ATTACHMENT])
  assert.deepEqual(api.calls[1].variables.filter.or, [{ team: { key: { eqIgnoreCase: 'hyp' } } }])
  for (const call of api.calls.slice(1)) {
    assert.match(call.query, /first: 50/)
    assert.match(call.query, /includeArchived: true/)
    assert.match(call.query, /orderBy: createdAt/)
    assert.doesNotMatch(call.query, /\b(title|description|body|metadata)\b/)
    assert.deepEqual(call.variables.filter.updatedAt, { gte: work.since, lte: work.until })
  }
})

test('GraphQL partial errors, rate limits, transport bodies and malformed responses never advance as success', async () => {
  for (const response of [
    { data: { issues: { nodes: [ISSUE] } }, errors: [{ message: 'private-provider-text' }] },
    { errors: [{ message: 'private-provider-text', extensions: { code: 'RATELIMITED' } }] },
    { data: { organization: { id: WORKSPACE_ID }, issues: { nodes: [ISSUE], pageInfo: { hasNextPage: true, endCursor: null } } } },
    { data: { organization: { id: WORKSPACE_ID }, issues: { nodes: [{ ...ISSUE, id: 'bad-id' }], pageInfo: { hasNextPage: false, endCursor: null } } } },
  ]) {
    await assert.rejects(client(async () => Response.json(response)).page('issues', work, WORKSPACE_ID), error => !String(error).includes('private-provider-text'))
  }
  await assert.rejects(linearGraphql('secret', 'query {}', {}, { fetchImpl: async () => new Response('private-provider-text', { status: 401 }) }), /HTTP 401/)
  await assert.rejects(linearGraphql('secret', 'query {}', {}, { fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /size limit/)
  await assert.rejects(linearGraphql('secret', 'query {}', {}, { fetchImpl: async () => { throw new Error('private-provider-text') } }), error => /API request failed/.test(String(error)) && !String(error).includes('private-provider-text'))
})

test('workspace changes and non-advancing pagination are refused before returning a page', async () => {
  const data = { organization: { id: WORKSPACE_ID }, issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } } }
  const c = client(async () => Response.json({ data }))
  await assert.rejects(c.page('issues', { ...work, after: 'cursor-1' }, WORKSPACE_ID), /pagination/)
  await assert.rejects(c.page('issues', work, 'another-workspace'), /workspace changed/)
})

test('request cancellation is respected without retrying or exposing credentials', async () => {
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(linearGraphql('secret', 'query {}', {}, { signal: abort.signal,
    fetchImpl: async () => { throw new Error('secret') } }), /cancelled/)
})

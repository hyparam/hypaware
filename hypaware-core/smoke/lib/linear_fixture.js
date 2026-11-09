// @ts-check

import http from 'node:http'
import { createHash } from 'node:crypto'

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
export const USER_ID = '22222222-2222-4222-8222-222222222222'
export const TEAM_ID = '33333333-3333-4333-8333-333333333333'
export const ISSUE_ID = '44444444-4444-4444-8444-444444444444'
export const ATTACHMENT_ID = '55555555-5555-4555-8555-555555555555'
export const IDENTITY = { user_id: USER_ID, workspace_id: WORKSPACE_ID, workspace: 'smoke' }
export const ISSUE = {
  id: ISSUE_ID, identifier: 'HYP-7', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  team: { id: TEAM_ID, key: 'HYP' }, state: { id: '66666666-6666-4666-8666-666666666666', type: 'started' },
  creator: { id: USER_ID }, assignee: null,
}
export const ATTACHMENT = {
  id: ATTACHMENT_ID, url: 'https://github.com/Acme/Widgets/pull/42',
  createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z', issue: ISSUE,
}

/** Pick a currently available registered loopback port for hermetic auth. */
export async function callbackUri() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing callback listener address')
  const uri = `http://127.0.0.1:${address.port}/callback`
  await new Promise(resolve => server.close(() => resolve(undefined)))
  return uri
}

/** @param {{ issues?: any[], attachments?: any[] }} [opts] */
export function fakeLinearApi(opts = {}) {
  const calls = []
  /** @type {string | null} */
  let challenge = null
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://api.linear.app') throw new Error('unexpected external request')
    if (url.pathname === '/oauth/token') {
      const body = new URLSearchParams(String(init?.body))
      if (body.get('grant_type') === 'authorization_code') {
        const digest = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url')
        if (digest !== challenge || body.get('code') !== 'hermetic-code' || body.has('client_secret')) throw new Error('invalid PKCE exchange')
      }
      return Response.json({ access_token: 'hermetic-access', refresh_token: 'hermetic-refresh', expires_in: 86400, token_type: 'Bearer', scope: 'read' })
    }
    if (url.pathname !== '/graphql') throw new Error('unexpected endpoint')
    const auth = new Headers(init?.headers).get('Authorization')
    if (auth !== 'Bearer hermetic-access' && auth !== 'hermetic-api-key') throw new Error('missing fixture credential')
    const request = JSON.parse(String(init?.body))
    calls.push(request)
    if (request.query.includes('HypAwareIdentity')) return Response.json({ data: { viewer: { id: USER_ID }, organization: { id: WORKSPACE_ID, urlKey: 'smoke' } } })
    const stream = request.query.includes('HypAwareAttachments') ? 'attachments' : 'issues'
    const nodes = (opts[stream] ?? (stream === 'issues' ? [ISSUE] : [ATTACHMENT])).filter(row => {
      const filter = request.variables.filter.updatedAt
      return (!filter.gte || row.updatedAt >= filter.gte) && row.updatedAt <= filter.lte
    })
    return Response.json({ data: { organization: { id: WORKSPACE_ID }, [stream]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } })
  }
  return {
    calls, fetchImpl,
    /** @param {string} value @param {typeof fetch} [callbackFetch] */
    async authorize(value, callbackFetch = fetch) {
      const url = new URL(value)
      challenge = url.searchParams.get('code_challenge')
      if (url.origin !== 'https://linear.app' || url.searchParams.get('scope') !== 'read' || url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('unexpected authorization request')
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '')
      callback.searchParams.set('code', 'hermetic-code')
      callback.searchParams.set('state', url.searchParams.get('state') ?? '')
      const response = await callbackFetch(callback)
      if (response.status !== 200) throw new Error('callback was refused')
      await response.text()
    },
  }
}

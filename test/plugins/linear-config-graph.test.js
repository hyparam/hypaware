// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'
import { validateLinearConfig, DEFAULT_REDIRECT_URI } from '../../hypaware-core/plugins-workspace/linear/src/config.js'
import { issueKey, pullRequestFromUrl, createLinearGraphContract } from '../../hypaware-core/plugins-workspace/linear/src/graph_contract.js'
import { makeRowBuilders, nodeId } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-kit.js'
import { createContractRegistry } from '../../hypaware-core/plugins-workspace/context-graph/src/contract-registry.js'
import { createGithubGraphContract } from '../../hypaware-core/plugins-workspace/github/src/graph_contract.js'
import { discoverBundledPlugins, V1_EXCLUDED_FROM_DEFAULT } from '../../src/core/runtime/bundled.js'
import { ISSUE_ID, WORKSPACE_ID, ATTACHMENT_ID } from '../../hypaware-core/smoke/lib/linear_fixture.js'

test('Linear is discoverable but capture remains an explicit plugin and team choice', async () => {
  const discovery = await discoverBundledPlugins()
  assert.ok(V1_EXCLUDED_FROM_DEFAULT.has('@hypaware/linear'))
  const plugin = discovery.excluded.find(p => p.manifest.name === '@hypaware/linear')
  assert.ok(plugin)
  assert.equal(plugin.manifest.requires?.capabilities?.['hypaware.context-graph'], '^1.1.0')
  const validated = validateLinearConfig(undefined)
  assert.ok(validated.ok && validated.config)
  assert.deepEqual(validated.config.teams, [])
  assert.equal(validated.config.redirect_uri, DEFAULT_REDIRECT_URI)
  assert.equal(validated.config.poll_interval, '24h')
})

test('Linear config normalizes teams and refuses credentials, unknown keys and unsafe redirects', () => {
  const valid = validateLinearConfig({ teams: ['HYP', 'hyp'], client_id: 'public-id', poll_interval: '10m' })
  assert.ok(valid.ok && valid.config)
  assert.deepEqual(valid.config.teams, ['hyp'])
  for (const value of [null, [], { token: 'secret' }, { teams: ['a/b'] }, { teams: 'HYP' },
    { token_env: 'lin_api_abcdefghijklmnop' }, { client_id: 'lin_oauth_secret' },
    { poll_interval: '1m' }, { poll_interval: '999999999999h' },
    ...['https://example.com/callback', 'http://127.0.0.1:42/callback?x=1', 'http://127.0.0.1:42/callback#x',
      'http://user@127.0.0.1:42/callback', 'http://127.0.0.2:42/callback', 'http://localhost/callback'].map(redirect_uri => ({ redirect_uri }))]) {
    assert.equal(validateLinearConfig(value).ok, false, JSON.stringify(value))
  }
})

test('only exact GitHub PR URLs become normalized graph targets', () => {
  assert.deepEqual(pullRequestFromUrl('https://github.com/Acme/Widgets/pull/42?tab=files#discussion'), { repo: 'acme/widgets', number: 42 })
  for (const url of ['https://evilgithub.com/acme/widgets/pull/42', 'https://github.com.evil/acme/widgets/pull/42',
    'http://github.com/acme/widgets/pull/42', 'https://secret@github.com/acme/widgets/pull/42',
    'https://github.com:444/acme/widgets/pull/42', 'https://github.com/acme/widgets/issues/42',
    'https://github.com/acme/widgets/pull/42/files', 'https://github.com/acme/widgets/pull/0',
    'https://github.com/acme/widgets/pull/9007199254740992', 'https://github.com/acme%2fother/widgets/pull/42']) assert.equal(pullRequestFromUrl(url), null)
})

test('Linear issue/PR references reuse GitHub identity without changing graph schema or claiming authorship', () => {
  const kit = { makeRowBuilders, nodeId }
  const contract = createLinearGraphContract(kit)
  const registry = createContractRegistry()
  registry.register(contract)
  const source = { workspace_id: WORKSPACE_ID, issue_id: ISSUE_ID, identifier: 'HYP-7', attachment_id: ATTACHMENT_ID,
    repo: 'Acme/Widgets', pr_number: 42n, created_at: '2026-10-01T00:00:00Z' }
  const rows = contract.rules.map(rule => rule.toRow(source))
  assert.ok(rows.every(Boolean))
  assert.equal(rows[0]?.node_id, nodeId('Issue', `linear:${WORKSPACE_ID}:${ISSUE_ID}`))
  assert.notEqual(issueKey(WORKSPACE_ID, ISSUE_ID), issueKey(ISSUE_ID, ISSUE_ID))
  assert.equal(issueKey('HYP', ISSUE_ID), null)
  const github = createGithubGraphContract(/** @type {any} */ (kit)).rules.find(r => r.kind === 'node' && r.type === 'PullRequest')
  assert.equal(rows[1]?.node_id, github?.toRow({ repo: 'acme/widgets', number: 42 })?.node_id)
  assert.equal(rows[2]?.dst_id, rows[1]?.node_id)
  assert.equal(rows[2]?.src_id, rows[0]?.node_id)
  assert.equal(rows[2]?.edge_type, 'references')
  assert.equal(rows[0]?.props, null, 'mutable status is retained in source snapshots')
  assert.deepEqual(rows[2]?.source_keys, { workspace_id: WORKSPACE_ID, issue_id: ISSUE_ID, attachment_id: ATTACHMENT_ID })
  assert.equal(contract.rules.some(r => r.type === 'Session'), false)
})

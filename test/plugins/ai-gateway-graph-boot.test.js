// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { bootKernel } from '../../src/core/runtime/boot.js'
import { requireGraphRuntime } from '../../hypaware-core/plugins-workspace/context-graph/src/runtime.js'

// Real-boot wiring test: activate the gateway → graph → connector chain over the
// bundled workspace and confirm the connector activates *after* the graph plugin
// and registers its contract through the capability.
//
// This guards the both-kinds-of-dependency requirement: the connector needs a
// *plugin* dependency on @hypaware/context-graph (not just the capability dep) so
// the resolver activates the provider first. Capability deps are interchangeable
// and do not pin activation order, so a capability-only connector would race ahead
// of the provider and `requireCapability` would throw here — which the stubbed
// activate unit test cannot catch.
test('the gateway+graph+connector chain activates in order and the connector registers its contract', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-graph-boot-'))
  try {
    const boot = await bootKernel({
      hypHome,
      runId: 'graph-boot-test',
      bootProfile: { activate: ['@hypaware/ai-gateway', '@hypaware/context-graph', '@hypaware/ai-gateway-graph'] },
    })

    const byName = new Map((boot.activations ?? []).map((r) => [r.plugin?.name, r]))

    assert.equal(byName.get('@hypaware/context-graph')?.ok, true, 'graph plugin activated')
    const conn = byName.get('@hypaware/ai-gateway-graph')
    assert.ok(conn, 'connector was selected for activation')
    assert.equal(conn.ok, true, `connector activated (failure: ${conn.ok ? 'none' : conn.message})`)

    const contracts = requireGraphRuntime().registry.list().map((c) => c.name)
    assert.ok(
      contracts.includes('ai-gateway-t0'),
      `connector registered its contract through the capability (saw: ${JSON.stringify(contracts)})`
    )
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
})

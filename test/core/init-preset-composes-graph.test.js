// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { activate as activateClaude } from '../../hypaware-core/plugins-workspace/claude/src/index.js'

/**
 * Regression (neutral review of PR #720, finding C): LLP 0213 says new
 * configs get the graph, and `hypaware-query` now tells the model `node` and
 * `edge` are there. `compose_with` is read in `composePickerConfig` alone,
 * so only the picker fold honors it: a preset that writes its plugin list
 * literally gets the graph only if it names the pair itself. Before this
 * test, `hyp init claude-and-otel-local` wrote a brand new gateway config
 * with no graph, on a shipped fresh-install path, while the skill installed
 * beside it asserted otherwise.
 *
 * @ref LLP 0213#d1 [tests]: a config the gateway reaches carries the graph, whichever path wrote it
 */

const GRAPH_PAIR = ['@hypaware/context-graph', '@hypaware/ai-gateway-graph']

/** Buffer standing in for a CLI stream. */
function makeBuf() {
  /** @type {string[]} */
  const chunks = []
  return {
    write(/** @type {string} */ s) { chunks.push(s) },
    text() { return chunks.join('') },
  }
}

/**
 * Run the claude plugin's registered `hyp init` preset in a temp HYP_HOME
 * and return the config it wrote.
 *
 * @returns {Promise<{ plugins?: { name: string }[] }>}
 */
async function runPreset() {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-init-graph-'))
  try {
    /** @type {any} */
    let preset
    /** @type {any} */
    const ctx = {
      env: { HYP_HOME: hypHome, HOME: hypHome },
      paths: { stateDir: path.join(hypHome, 'state') },
      plugin: { version: '0.0.0-test' },
      configRegistry: { registerSection() {} },
      requireCapability: () => ({
        registerUpstreamPreset() {},
        registerExchangeProjector() {},
        registerSettlementEnricher() {},
        registerClient() {},
      }),
      backfills: { register() {} },
      commands: { register() {} },
      skills: { register() {} },
      agents: { register() {} },
      initPresets: { register(/** @type {any} */ p) { preset = p } },
    }
    await activateClaude(ctx)
    assert.ok(preset, 'claude activate() registered the init preset')

    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await preset.run([], { env: ctx.env, stdout, stderr })
    assert.equal(code, 0, stderr.text())

    return JSON.parse(await fs.readFile(path.join(hypHome, 'hypaware-config.json'), 'utf8'))
  } finally {
    await fs.rm(hypHome, { recursive: true, force: true })
  }
}

test('the claude-and-otel-local preset composes the graph pair beside its gateway', async () => {
  const written = await runPreset()
  const names = (written.plugins ?? []).map((p) => p.name)
  assert.ok(names.includes('@hypaware/ai-gateway'), 'the preset composes the gateway')
  for (const plugin of GRAPH_PAIR) {
    assert.ok(
      names.includes(plugin),
      `${plugin} must ride the preset's gateway too, or hypaware-query points at a dataset this install does not have`
    )
  }
})

// The engine provides the `hypaware.context-graph` capability the connector
// requires, so a config that names the connector without the engine
// activates neither. Half the pair is worse than none.
test('the preset composes the graph engine before the connector that requires it', async () => {
  const written = await runPreset()
  const names = (written.plugins ?? []).map((p) => p.name)
  assert.ok(
    names.indexOf('@hypaware/context-graph') < names.indexOf('@hypaware/ai-gateway-graph'),
    'the capability provider precedes the consumer'
  )
})

// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { temporaryDirectory } from '../../../helpers/temp_dir.js'
import { discoverBundledPlugins } from '../../../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../../../src/core/plugin_catalog.js'
import { runWizardPick } from '../../../../src/core/cli/wizard/pick.js'
import { configureWizardCloud } from '../../../../src/core/cli/wizard/codex_cloud.js'
import { classifyClientProvenance } from '../../../../src/core/cli/wizard/provenance.js'

const output = () => ({ value: '', write(text) { this.value += text; return true } })
async function fixture() {
  const home = await temporaryDirectory('hyp-cloud-onboarding-')
  const env = { HOME: home, HYP_HOME: path.join(home, '.hyp') }
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const stateDir = path.join(env.HYP_HOME, 'hypaware/plugins/@hypaware/codex-cloud')
  return { env, catalog, stateDir, stdout: output(), stderr: output(), deferWrite: true }
}

test('express detects Codex Cloud alongside Codex and never automatically selects Work', async () => {
  const f = await fixture()
  const picked = await runWizardPick({ ...f, autoAccept: true, detect: async () => new Set(['codex', 'chatgpt-work']) })
  assert.deepEqual(picked.sourcesPicked, ['codex', 'codex-cloud'])
  assert.ok(picked.config.plugins?.some(p => p.name === '@hypaware/codex-cloud'))
  assert.doesNotMatch(f.stdout.value, /ChatGPT Work/)
})

test('Customize offers independent hosted choices without composing or attaching local Codex', async () => {
  for (const source of ['codex-cloud', 'chatgpt-work']) {
    const f = await fixture()
    const picked = await runWizardPick({ ...f, detect: async () => new Set(), prompt: async question => {
      assert.equal(question.options.find(o => o.value === 'codex-cloud')?.checked, undefined)
      const work = question.options.find(o => o.value === 'chatgpt-work')
      assert.match(work?.label ?? '', /^ChatGPT Work/)
      assert.equal(work?.checked, undefined)
      return [source]
    } })
    assert.deepEqual(picked.sourcesPicked, [source])
    assert.deepEqual(picked.clientsPicked, [])
    assert.ok(picked.config.plugins?.some(p => p.name === '@hypaware/codex-cloud'))
    assert.equal(picked.config.plugins?.some(p => p.name === '@hypaware/codex'), false)
    await assert.rejects(fs.access(path.join(f.stateDir, 'cloud-connection.json')))
  }
})

test('reconfigure reads each choice from its local grant and team activation never locks hosted access', async () => {
  const f = await fixture()
  const config = { version: /** @type {const} */ (2), plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/codex-cloud' }] }
  await fs.mkdir(f.stateDir, { recursive: true })
  await fs.writeFile(path.join(f.env.HYP_HOME, 'hypaware-config.json'), JSON.stringify(config))
  await fs.writeFile(path.join(f.stateDir, 'cloud-connection.json'), JSON.stringify({ version: 2, scope: 'account', accountHash: 'a'.repeat(64), origins: ['codex_cloud'] }))
  const picked = await runWizardPick({ ...f, autoAccept: true, locked: ['codex-cloud', 'chatgpt-work'], detect: async () => new Set(['codex']) })
  assert.deepEqual(picked.sourcesPicked, ['codex-cloud'])
  assert.deepEqual(picked.lockedSources, [])
  for (const id of ['codex-cloud', 'chatgpt-work']) {
    assert.equal(classifyClientProvenance(id, { effective: config, centralConfig: config }, f.catalog), 'local')
  }
})

test('hosted configure reports login failures without exposing their content', async () => {
  const f = await fixture()
  await configureWizardCloud({ ...f, sources: ['chatgpt-work'] }, { configure: async () => { throw new Error('secret') } })
  assert.match(f.stderr.value, /Hosted chat setup did not finish/)
  assert.doesNotMatch(f.stderr.value, /secret/)
})

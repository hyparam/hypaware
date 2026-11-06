// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { bootKernel } from '../../src/core/runtime/boot.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

/**
 * @import { GrepSearchResult } from '../../src/core/search/types.js'
 */

// @ref LLP 0413#server [tests]: an unselected local plugin cannot displace a host's grep_search
test('grep follows config activation and leaves a server host its own tool registration', async (t) => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-grep-boot-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  for (const enabled of [false, true]) {
    await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
      version: 2,
      plugins: [{ name: '@hypaware/grep', enabled }],
    }))
    const boot = await bootKernel({ hypHome, env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' } })
    const verb = boot.runtime.verbs.getByTool('grep_search')
    if (enabled) {
      assert.equal(verb?.plugin, '@hypaware/grep')
      assert.ok(boot.runtime.commands.get('query grep'))
      assert.ok(verb)
      const result = /** @type {GrepSearchResult} */ (await verb.operation({ query: 'needle' }, /** @type {any} */ ({
        storage: boot.runtime.storage,
      })))
      assert.deepEqual(result.hits, [])
      assert.equal(result.exhausted, true)
    } else {
      assert.equal(verb, undefined)
      assert.equal(boot.runtime.commands.get('query grep'), undefined)
      const serverSearch = async () => ({ hits: [], truncated: false, exhausted: true })
      boot.runtime.verbs.register({
        name: 'grep-search', tool: 'grep_search', summary: 'Server archive search',
        authClass: 'read', inputSchema: { type: 'object', properties: {} }, operation: serverSearch,
        render: () => ({ stdout: '', stderr: '', code: 0 }),
      })
      assert.equal(boot.runtime.verbs.getByTool('grep_search')?.operation, serverSearch)
    }
  }
})

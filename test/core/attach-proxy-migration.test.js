// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

/**
 * LLP 0262 retired proxy attach for `claude`: its picker row no longer
 * composes `gateway_proxy_mode` or an Anthropic upstream, so the LLP 0244
 * migration offer in `maybeOfferProxyModeMigration` has no bundled row left
 * to fire on. These tests pin that outcome from both ends, because a silent
 * offer is indistinguishable from a broken one:
 *
 *  - structurally, that no bundled picker row declares the flag the offer
 *    gates on, and
 *  - behaviorally, that a real `hyp client attach claude` against a
 *    base-URL-era config asks nothing, points at nothing, and writes nothing,
 *    in every attach shape that used to get a question or a pointer
 *    (interactive, `--json`, non-TTY, `all`).
 *
 * If a picker row ever declares `gateway_proxy_mode` again, the first test
 * fails on purpose: the offer becomes reachable, and the behavior pins it
 * needs (the consented question, the accept/decline writes, the fleet note,
 * the failure path) have to come back with it. They are in this file's git
 * history, at the commit before the LLP 0248 CLI rollover.
 *
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

const MIGRATION_QUESTION = 'Switch this install to proxy mode now? [y/N] '

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

/** @param {string} home */
function localConfigPath(home) {
  return path.join(home, '.hyp', 'hypaware-config.json')
}

/**
 * A pre-rollover install: a gateway with the Anthropic upstream and the claude
 * adapter proxied through it, and no `proxy_mode` key. This is exactly the
 * shape the migration offer existed to upgrade, so it is the shape that proves
 * the offer is gone rather than merely unexercised.
 *
 * @param {string} home
 */
function writeGatewayConfig(home) {
  mkdirSync(path.dirname(localConfigPath(home)), { recursive: true })
  writeFileSync(localConfigPath(home), JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' }],
        },
      },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
    ],
  }, null, 2) + '\n')
}

/**
 * A registered-claude attach context: the adapter is live, so the LLP 0174
 * enable prompt never fires and nothing but the migration offer could ask a
 * question. `answer` is pre-buffered so that a reached prompt trips the
 * assertions below instead of parking on an empty stdin.
 *
 * @param {{ home: string, answer?: string, tty?: boolean }} opts
 */
function makeCtx({ home, answer, tty = true }) {
  const registered = ['claude', 'codex']
  const gateway = {
    localEndpoint() {
      return 'http://127.0.0.1:60680'
    },
    /** @param {string} name */
    getClient(name) {
      if (!registered.includes(name)) return undefined
      return {
        name,
        /** @param {{ endpoint: string, dryRun?: boolean, json?: boolean, stdout: { write(chunk: unknown): boolean } }} args */
        async attach(args) {
          writeFileSync(
            path.join(home, `${name}-attached.json`),
            JSON.stringify({ endpoint: args.endpoint, dryRun: args.dryRun === true })
          )
          if (args.json === true) {
            args.stdout.write(
              JSON.stringify({ status: 'ok', action: 'attach', client: name, dry_run: args.dryRun === true }) + '\n'
            )
          }
        },
      }
    },
    listClients() {
      return registered.map((name) => ({ name }))
    },
  }
  const stdin = new PassThrough()
  if (tty) Object.defineProperty(stdin, 'isTTY', { value: true })
  if (answer !== undefined) stdin.write(`${answer}\n`)
  const stdoutBuf = makeBuf()
  const stderrBuf = makeBuf()
  const config = JSON.parse(readFileSync(localConfigPath(home), 'utf8'))
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout: stdoutBuf,
    stderr: stderrBuf,
    stdin,
    cwd: home,
    env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
    config,
    plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/claude' }],
    capabilities: {
      /** @param {string} id */
      has: (id) => id === 'hypaware.ai-gateway',
      require: () => gateway,
    },
    activatePluginClosure: async () => ({ activated: [], failed: [] }),
  }))
  return { ctx, stdout: stdoutBuf, stderr: stderrBuf }
}

/** @param {(home: string) => Promise<void> | void} fn */
async function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-attach-proxy-migration-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The offer's only gate is `descriptor.compose.gateway_proxy_mode === true`
 * (`maybeOfferProxyModeMigration`). Reading the real manifests keeps this
 * honest: a fixture would pass whatever the fixture said.
 *
 * @ref LLP 0262#migration [tests]: no bundled client composes proxy mode, so no attach reaches the LLP 0244 offer
 */
test('no bundled picker row declares the proxy attach the migration offer gates on', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const declaring = [...catalog.pickerDescriptors.entries()]
    .filter(([, descriptor]) => descriptor?.compose?.gateway_proxy_mode === true)
    .map(([name]) => name)
  assert.deepEqual(declaring, [], 'a row declaring proxy attach makes the offer reachable again')
})

test('interactive attach on a base-URL-era config asks nothing and writes nothing', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stdout, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION))
    assert.doesNotMatch(stderr.text(), /proxy mode/)
    assert.doesNotMatch(stdout.text(), /proxy_mode written/)
    const after = readFileSync(localConfigPath(home), 'utf8')
    assert.equal(after, before)
    assert.doesNotMatch(after, /proxy_mode/)
    const attached = JSON.parse(readFileSync(path.join(home, 'claude-attached.json'), 'utf8'))
    assert.equal(attached.endpoint, 'http://127.0.0.1:60680', 'the attach itself still lands')
  })
})

test('a client whose row does not declare proxy attach is never asked', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const { ctx, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['codex'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.equal(stderr.text(), '')
  })
})

test('--json on a TTY emits no migration pointer and stdout stays the attach payload', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stdout, stderr } = makeCtx({ home, tty: true, answer: 'y' })
    const code = await runAttach(['--client', 'claude', '--json'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.equal(stderr.text(), '', 'the pointer the offer used to print is gone with it')
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
    const stdoutText = stdout.text()
    assert.equal(stdoutText.split('\n').filter((line) => line.length > 0).length, 1)
    const payload = JSON.parse(stdoutText)
    assert.equal(payload.status, 'ok')
    assert.equal(payload.client, 'claude')
  })
})

test('non-TTY attach emits no migration pointer', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stderr } = makeCtx({ home, tty: false })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.equal(stderr.text(), '')
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test("'hyp client attach all' emits no migration pointer mid-run", async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['all'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION))
    assert.doesNotMatch(stderr.text(), /base URL/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

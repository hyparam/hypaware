// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'
import { centralSeedPath } from '../../src/core/config/apply.js'

/**
 * LLP 0244 #attach-offers: `hyp attach claude` on a base-URL install offers
 * the proxy-mode switch. These tests pin the offer's gates (interactive,
 * single-client, wet-run, config lacks the key) and both answers. The switch
 * machinery itself is covered by gateway-proxy-enable.test.js; here the
 * daemon is never installed (the test-runner guard refuses real service
 * managers anyway), so an accepted switch lands the write and reports that a
 * daemon start is the next step.
 *
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

const MIGRATION_QUESTION = 'Switch this install to proxy mode now? [y/N] '

/**
 * @param {{ onWrite?: (chunk: unknown) => void }} [opts]
 * @returns {{ write(chunk: unknown): boolean, text(): string }}
 */
function makeBuf(opts) {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      opts?.onWrite?.(chunk)
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
 * @param {string} home
 * @param {{ proxyMode?: boolean }} [opts]
 */
function writeGatewayConfig(home, opts) {
  mkdirSync(path.dirname(localConfigPath(home)), { recursive: true })
  writeFileSync(localConfigPath(home), JSON.stringify({
    version: 2,
    plugins: [
      {
        name: '@hypaware/ai-gateway',
        config: {
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' }],
          ...(opts?.proxyMode ? { proxy_mode: true } : {}),
        },
      },
      { name: '@hypaware/claude', config: { proxy: '@hypaware/ai-gateway' } },
    ],
  }, null, 2) + '\n')
}

/**
 * A registered-claude attach context: the adapter is live, so the LLP 0174
 * enable prompt never fires and the migration offer is the only question in
 * play. `answer` (when stdin is a TTY) is pre-buffered for it.
 *
 * @param {{ home: string, answer?: string, tty?: boolean, json?: boolean }} opts
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
        /** @param {{ endpoint: string, dryRun?: boolean }} args */
        async attach(args) {
          writeFileSync(
            path.join(home, `${name}-attached.json`),
            JSON.stringify({ endpoint: args.endpoint, dryRun: args.dryRun === true })
          )
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
  // The effective config the process booted with mirrors the local file, the
  // shape runAttach reads it in.
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

test('decline: the question is asked once, nothing is written, attach still lands', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stderr } = makeCtx({ home, answer: 'n' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(stderr.text().includes(MIGRATION_QUESTION))
    assert.match(stderr.text(), /keeping the base-URL attach/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
    const attached = JSON.parse(readFileSync(path.join(home, 'claude-attached.json'), 'utf8'))
    assert.equal(attached.endpoint, 'http://127.0.0.1:60680')
  })
})

test('accept: proxy_mode lands in the local config; with no daemon service the next step is named', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const { ctx, stdout, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    const after = JSON.parse(readFileSync(localConfigPath(home), 'utf8'))
    assert.equal(after.plugins[0].config.proxy_mode, true)
    // The test runner refuses real service managers (LLP 0181), which
    // degrades to "no daemon installed": the write is the whole job and the
    // output names the start + re-attach path.
    assert.match(stdout.text(), /proxy_mode written/)
    assert.match(stdout.text(), /hyp daemon install/)
    // Attach itself still ran (base-URL: no CA exists here).
    const attached = JSON.parse(readFileSync(path.join(home, 'claude-attached.json'), 'utf8'))
    assert.equal(attached.endpoint, 'http://127.0.0.1:60680')
  })
})

test('proxy_mode already in the config: no question, no note', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    const { ctx, stderr } = makeCtx({ home })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION))
    assert.doesNotMatch(stderr.text(), /proxy mode/)
  })
})

test('a client whose row does not declare proxy attach is never asked', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const { ctx, stderr } = makeCtx({ home })
    const code = await runAttach(['codex'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION))
    assert.equal(stderr.text(), '')
  })
})

// The live failure of 2026-08-17: a fleet host carries a central layer that
// also names the gateway, so the merge drops any local proxy_mode write.
// The offer must detect that from central NAMING the plugin (a local entry
// exists here too) and report instead of prompting, on a TTY included.
// @ref LLP 0244#central-managed [tests]: a fleet-owned gateway block reports, never prompts, even beside a local entry
test('centrally-managed gateway: no question even on a TTY, the fleet note instead, nothing written', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const seedPath = centralSeedPath(path.join(home, '.hyp', 'hypaware'))
    mkdirSync(path.dirname(seedPath), { recursive: true })
    writeFileSync(seedPath, JSON.stringify({
      version: 2,
      plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:18521' } }],
    }) + '\n')
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION))
    assert.match(stderr.text(), /centrally managed; enable proxy_mode in the fleet config/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

// @ref LLP 0244#non-interactive [tests]: no TTY means no migration and exactly the one-line pointer
test('non-TTY: no question, one pointer note, attach unchanged', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stderr } = makeCtx({ home, tty: false })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION))
    assert.match(stderr.text(), /run 'hyp attach claude' in an interactive terminal/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test('--dry-run: no question, no note, no write', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['claude', '--dry-run'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION))
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

test("'hyp attach all' never asks the migration question mid-run", async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['all'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION))
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

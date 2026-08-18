// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { runAttach } from '../../src/core/commands/clients.js'
import { centralSeedPath } from '../../src/core/config/apply.js'
import { deleteLocalCa, ensureLocalCa, readLocalCaInfo } from '../../src/core/tls/ca.js'

/**
 * LLP 0244 #attach-offers: `hyp attach claude` on a base-URL install offers
 * the proxy-mode switch. These tests pin the offer's gates (interactive,
 * single-client, wet-run, config lacks the key) and both answers. The switch
 * machinery itself is covered by gateway-proxy-enable.test.js; here the
 * daemon is never installed (the test-runner guard refuses real service
 * managers anyway), so an accepted switch lands the write and reports that a
 * daemon start is the next step.
 *
 * LLP 0259 adds the other side of the same gate: `proxy_mode: true` with no
 * CA on disk is the state `hyp detach claude --purge` leaves behind, and the
 * attach that follows it must not downgrade to base URL in silence.
 *
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

const MIGRATION_QUESTION = 'Switch this install to proxy mode now? [y/N] '
const REMINT_QUESTION = 'Restart the daemon and restore proxy mode now? [y/N] '

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

/** @param {string} home */
function stateRootOf(home) {
  return path.join(home, '.hyp', 'hypaware')
}

/**
 * What `hyp detach claude --purge` leaves behind: the CA is deleted (LLP 0238
 * #ca-survives-detach makes that purge's job alone) and `proxy_mode` stays
 * exactly where it was, because nothing on the detach path writes config.
 *
 * @param {string} home
 */
async function purgeTheCa(home) {
  const stateRoot = stateRootOf(home)
  await ensureLocalCa({ stateRoot, hosts: ['api.anthropic.com'] })
  const tls = path.join(stateRoot, 'tls')
  /** @type {Array<[string, Buffer]>} */
  const saved = ['ca-cert.pem', 'ca-key.pem'].map((f) => [f, readFileSync(path.join(tls, f))])
  await deleteLocalCa({ stateRoot })
  // Handed back so a test can put the same bytes down again synchronously,
  // which is how it stages the mint a daemon restart would do mid-run.
  return () => {
    mkdirSync(tls, { recursive: true })
    for (const [f, bytes] of saved) writeFileSync(path.join(tls, f), bytes)
  }
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
 * `unbound` swaps in the daemon-managed shape instead: the gateway is not
 * running in this CLI process, so `localEndpoint()` throws and the command
 * falls through to the status.json live-port discovery (LLP 0086). That is
 * the branch that owns the "already attached" no-op, so it is the only one
 * that can short-circuit past a repair. `onStderr` observes stderr as it is
 * written, which is how a test stages a mid-run change.
 *
 * @param {{
 *   home: string,
 *   answer?: string,
 *   tty?: boolean,
 *   unbound?: boolean,
 *   onStderr?: (chunk: unknown) => void,
 * }} opts
 */
function makeCtx({ home, answer, tty = true, unbound = false, onStderr }) {
  const registered = ['claude', 'codex']
  const gateway = {
    localEndpoint() {
      if (unbound) throw new Error('ai-gateway: localEndpoint() called before the gateway started')
      return 'http://127.0.0.1:60680'
    },
    /** @param {string} name */
    getClient(name) {
      if (!registered.includes(name)) return undefined
      return {
        name,
        /** @param {{ endpoint: string, dryRun?: boolean }} args */
        async attach(args) {
          // The mode a real adapter picks, decided the way LLP 0232
          // #proxy-attach-preflight decides it: from the CA on disk, never
          // from config. Recording it here is what makes a silent downgrade
          // visible to the test.
          const ca = await readLocalCaInfo({ stateRoot: stateRootOf(home) })
          writeFileSync(
            path.join(home, `${name}-attached.json`),
            JSON.stringify({
              endpoint: args.endpoint,
              dryRun: args.dryRun === true,
              mode: ca ? 'proxy' : 'base_url',
            })
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
  const stderrBuf = makeBuf(onStderr ? { onWrite: onStderr } : undefined)
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

// The migration offer decides from `ctx.config`, the effective config this
// process booted with, while `enableGatewayProxyMode` re-reads disk before it
// writes. So an accepted migration can come back `remint` when the key landed
// in between, and that outcome has to be reported the way every other
// no-daemon outcome is: nothing was written and nothing was restarted, so the
// install ladder is named instead of a repair claimed.
test('an accepted migration that turns out to be a re-mint never claims a restart that could not run', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const { ctx, stdout, stderr } = makeCtx({ home, answer: 'y' })
    // The layers move between the offer and the write.
    writeGatewayConfig(home, { proxyMode: true })
    const before = readFileSync(localConfigPath(home), 'utf8')
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.doesNotMatch(stdout.text(), /proxy mode restored/, 'no restart ran, so none is claimed')
    assert.match(stderr.text(), /no daemon service is installed, so nothing can re-mint the CA/)
    assert.match(stderr.text(), /hyp daemon install/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before, 'a re-mint writes no config')
  })
})

test('proxy_mode already in the config, with the CA on disk: no question, no note', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    await ensureLocalCa({ stateRoot: stateRootOf(home), hosts: ['api.anthropic.com'] })
    const { ctx, stderr } = makeCtx({ home })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION))
    assert.doesNotMatch(stderr.text(), /proxy mode/)
    const attached = JSON.parse(readFileSync(path.join(home, 'claude-attached.json'), 'utf8'))
    assert.equal(attached.mode, 'proxy')
  })
})

/* ------------------- the purge-then-attach downgrade (#819) ---------------- */

// The live macOS repro: `hyp detach claude --purge` deletes the CA and leaves
// `proxy_mode: true` set, and the attach that follows wrote a base-URL marker
// while reporting success - no warning, and `hyp status` showed nothing
// either. The attach may still land in base-URL mode (that is what the
// machine can serve), but it may never do so quietly.
// @ref LLP 0259#never-silent [tests]: the downgrade is named before anything else happens
test('detach --purge then attach: the downgrade is named, not silent', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    await purgeTheCa(home)
    const { ctx, stderr } = makeCtx({ home, answer: 'n' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.match(stderr.text(), /configured for proxy mode but has no local interception CA/)
    assert.match(stderr.text(), /writes a base-URL attach instead/)
    // And the base-URL attach it warned about is exactly what happened.
    const attached = JSON.parse(readFileSync(path.join(home, 'claude-attached.json'), 'utf8'))
    assert.equal(attached.mode, 'base_url')
  })
})

// @ref LLP 0259#repair-is-a-restart [tests]: the offer is the restart, and declining names the manual form
test('the repair is offered, and declining names the two commands that do it by hand', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    await purgeTheCa(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stderr } = makeCtx({ home, answer: 'n' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(stderr.text().includes(REMINT_QUESTION), stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION), 'this is a repair, not a migration')
    assert.match(stderr.text(), /hyp daemon restart/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before, 'nothing is written either way')
  })
})

// The write is skipped on this path, so an accepted repair changes no config
// at all. Under the test runner no service manager is reachable (LLP 0181),
// which degrades to "no daemon installed" - the one state where a restart
// cannot help, and the ladder has to be named instead of a repair claimed.
test('accepting the repair writes no config, and with no daemon service names the start ladder', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    await purgeTheCa(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stdout, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.match(stderr.text(), /no daemon service is installed, so nothing can re-mint the CA/)
    assert.match(stderr.text(), /hyp daemon install/)
    assert.doesNotMatch(stdout.text(), /proxy_mode written/, 'a repair never rewrites the config')
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

// The mirror of the re-mint-in-the-migration case: this function's gate reads
// `ctx.config`, `enableGatewayProxyMode` re-reads disk, and the two can
// disagree, so an accepted repair can come back as a write. A write that
// worked is not a failure and must not be reported as one.
test('a repair that comes back as a config write reports success, not a failure', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    await purgeTheCa(home)
    const { ctx, stdout, stderr } = makeCtx({ home, answer: 'y' })
    // The layers move between the gate and the write.
    writeGatewayConfig(home)
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.doesNotMatch(stderr.text(), /could not restore proxy mode/)
    assert.match(stdout.text(), /proxy_mode written/)
    assert.match(stdout.text(), /hyp daemon install/)
    const after = JSON.parse(readFileSync(localConfigPath(home), 'utf8'))
    assert.equal(after.plugins[0].config.proxy_mode, true)
  })
})

// @ref LLP 0259#never-silent [tests]: every attach shape says it, including the ones that may not act
test('non-TTY: the downgrade is still named, with the manual repair as the pointer', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    await purgeTheCa(home)
    const { ctx, stderr } = makeCtx({ home, tty: false })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.match(stderr.text(), /no local interception CA/)
    assert.match(stderr.text(), /run 'hyp daemon restart', then 'hyp attach claude'/)
    assert.ok(!stderr.text().includes(REMINT_QUESTION), 'automation is never asked and never restarted')
  })
})

// The one shape that keeps stdout machine-readable: the warning is on
// stderr, so naming the downgrade costs the JSON payload nothing.
// @ref LLP 0259#never-silent [tests]: --json is warned like every other non-acting shape
test('--json: the downgrade is named on stderr and stdout stays the machine payload', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    await purgeTheCa(home)
    const { ctx, stdout, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['claude', '--json'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.match(stderr.text(), /no local interception CA/)
    assert.match(stderr.text(), /run 'hyp daemon restart', then 'hyp attach claude'/)
    assert.ok(!stderr.text().includes(REMINT_QUESTION), '--json is never asked and never restarted')
    for (const line of stdout.text().split('\n')) {
      if (line.trim() === '') continue
      JSON.parse(line)
    }
  })
})

test("'hyp attach all' names the downgrade once for claude and never asks", async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    await purgeTheCa(home)
    const { ctx, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['all'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.match(stderr.text(), /attaching claude now writes a base-URL attach instead/)
    assert.ok(!stderr.text().includes(REMINT_QUESTION))
  })
})

test('--dry-run stays silent: it changes nothing and promises nothing', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    await purgeTheCa(home)
    const { ctx, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['claude', '--dry-run'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.equal(stderr.text(), '')
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

// LLP 0244 #non-interactive: `hyp attach all` never prompts mid-run, but it
// is not silent either - it owes the one-line pointer naming the command
// that migrates, or the habit of attaching everything at once means an old
// install never learns the migration exists.
test("'hyp attach all' never asks the migration question mid-run, but points at it", async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stderr } = makeCtx({ home, answer: 'y' })
    const code = await runAttach(['all'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(!stderr.text().includes(MIGRATION_QUESTION))
    assert.match(stderr.text(), /attaches claude by base URL/)
    assert.match(stderr.text(), /run 'hyp attach claude' in an interactive terminal/)
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before)
  })
})

// The catch that keeps LLP 0244's safety promise: a migration failure never
// fails the attach. The write step is driven into a real filesystem refusal;
// the attach must still land in base-URL mode with exit 0 and a warning that
// names the backup state.
test('a failed accepted migration warns and the attach still succeeds', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home)
    const before = readFileSync(localConfigPath(home), 'utf8')
    const { ctx, stdout, stderr } = makeCtx({ home, answer: 'y' })
    const hypDir = path.join(home, '.hyp')
    const { chmodSync } = await import('node:fs')
    chmodSync(hypDir, 0o555)
    try {
      const code = await runAttach(['claude'], ctx)
      assert.equal(code, 0, 'the attach exit code is untouched by the migration failure')
      assert.match(stderr.text(), /could not switch to proxy mode/)
      assert.doesNotMatch(stdout.text(), /proxy mode enabled/)
      const attached = JSON.parse(readFileSync(path.join(home, 'claude-attached.json'), 'utf8'))
      assert.equal(attached.endpoint, 'http://127.0.0.1:60680', 'base-URL attach still ran')
    } finally {
      chmodSync(hypDir, 0o755)
    }
    assert.equal(readFileSync(localConfigPath(home), 'utf8'), before, 'the config on disk is untouched')
  })
})

/**
 * The daemon-managed install: no `listen` in config, so only the running
 * daemon knows the bound port and it publishes it to status.json (LLP 0086).
 * Seeded with this process's own pid so the liveness gate passes.
 *
 * @param {string} home
 * @param {number} port
 */
function seedDaemonRun(home, port) {
  const runDir = path.join(home, '.hyp', 'hypaware', 'run')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    path.join(runDir, 'hypaware.pid'),
    JSON.stringify({ pid: process.pid, runId: 'test-run', mode: 'foreground' })
  )
  writeFileSync(
    path.join(runDir, 'status.json'),
    JSON.stringify({
      state: 'healthy',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      uptimeMs: 0,
      runId: 'test-run',
      mode: 'foreground',
      sources: [
        {
          name: 'ai-gateway',
          plugin: '@hypaware/ai-gateway',
          state: 'started',
          details: { host: '127.0.0.1', port, upstreams: ['anthropic'] },
        },
      ],
      sinks: [],
    })
  )
}

/**
 * A claude settings marker recorded at `port`, which is what makes the
 * LLP 0086 "already attached at the live port" no-op fire.
 *
 * @param {string} home
 * @param {number} port
 */
function seedClaudeMarker(home, port) {
  mkdirSync(path.join(home, '.claude'), { recursive: true })
  writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ _hypaware: { version: '2.0.0', port } })
  )
}

// The repair has to reach the client, not just the machine. On a
// daemon-managed install the attach short-circuits at "already attached"
// whenever the marker names the live port - and a restart keeps that port, so
// the marker still matches while the *mode* it records has just gone stale.
// Short-circuiting there prints the repair's success line over a client the
// repair never touched, which is the silent wrong outcome LLP 0259 exists to
// remove. The CA is staged into place as the downgrade warning is written,
// the same race the `already` branch is written for.
test('a repair that lands re-attaches the client instead of no-opping on its pre-repair marker', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    const remintTheCa = await purgeTheCa(home)
    seedDaemonRun(home, 55555)
    seedClaudeMarker(home, 55555)
    let staged = false
    const { ctx, stdout, stderr } = makeCtx({
      home,
      answer: 'y',
      unbound: true,
      onStderr: (chunk) => {
        if (staged || !String(chunk).includes('no local interception CA')) return
        staged = true
        // The daemon's restart lands mid-run and the gateway mints again.
        remintTheCa()
      },
    })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.ok(staged, 'the downgrade warning must be written before anything else')
    assert.ok(stderr.text().includes(REMINT_QUESTION))
    assert.match(stdout.text(), /the local CA is present again/)
    assert.doesNotMatch(
      stdout.text(),
      /already attached/,
      'a repair that landed must not be reported over a no-op'
    )
    const attached = JSON.parse(readFileSync(path.join(home, 'claude-attached.json'), 'utf8'))
    assert.equal(attached.mode, 'proxy', 'the client is rewritten in the mode the repair restored')
    assert.equal(attached.endpoint, 'http://127.0.0.1:55555')
  })
})

// The other half of the same gate: nothing moved, so the LLP 0086 no-op is
// still the right answer and must survive untouched.
test('a declined repair leaves the already-attached no-op exactly as it was', async () => {
  await withTempHome(async (home) => {
    writeGatewayConfig(home, { proxyMode: true })
    await purgeTheCa(home)
    seedDaemonRun(home, 55555)
    seedClaudeMarker(home, 55555)
    const { ctx, stdout, stderr } = makeCtx({ home, answer: 'n', unbound: true })
    const code = await runAttach(['claude'], ctx)
    assert.equal(code, 0, stderr.text())
    assert.match(stderr.text(), /no local interception CA/)
    assert.match(stdout.text(), /already attached/)
    assert.throws(
      () => readFileSync(path.join(home, 'claude-attached.json'), 'utf8'),
      'nothing changed, so the adapter is still left alone'
    )
  })
})

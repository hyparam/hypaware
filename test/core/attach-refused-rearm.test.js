// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { attach, HypAwareCommandError } from '../../src/core/cli/integration.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { createKernelRuntime } from '../../src/core/runtime/activation.js'
import { createActionReconciler, readClientActionStatus } from '../../src/core/config/action_reconciler.js'
import { createAttachHandler } from '../../src/core/config/action_attach.js'

/**
 * T8 (LLP 0186/0187 re-arm): a successful manual `hyp attach <client>` is the
 * only re-arm a `refused` marker gets in this pass (LLP 0186 explicitly
 * rejects any automatic re-arm here). After a successful manual attach, the
 * marker is CLEARED (not rewritten to `done`), so the very next reconcile
 * pass sees no marker at that request key and re-`perform()`s on its own,
 * writing a fresh `done` marker itself. A failed manual attach must leave the
 * refused marker exactly as it found it.
 *
 * Mirrors test/core/detach-rejoin-recovery.test.js's pattern for the
 * detach-side `clearClientActionMarker` call this one is symmetric with.
 *
 * @import { ClientDescriptor } from '../../src/core/types.js'
 *
 * @ref LLP 0186#re-arm-explicit-hyp-attach-re-run-only [tests]: explicit hyp
 *   attach clears a refused marker; the reconciler never re-arms one on its
 *   own in this pass
 */

/** A quiet logger so the reconciler doesn't spam stderr. */
const NOOP_LOG = { debug() {}, info() {}, warn() {}, error() {} }

/** @type {ClientDescriptor} */
const CLAUDE_DESCRIPTOR = {
  plugin: /** @type {any} */ ('@hypaware/claude'),
  name: 'claude',
  skillDir: 'skills/claude',
  attachProbe: { format: 'json', settings_file: '.claude/settings.json', marker_key: '_hypaware' },
}

/**
 * A fake `hypaware.ai-gateway` capability whose single `claude` client either
 * succeeds or throws, per `throwOnAttach`, mirroring
 * test/core/integration.test.js's `fakeClientKernel`.
 *
 * @param {{ throwOnAttach?: boolean }} [opts]
 */
function fakeClientKernel({ throwOnAttach = false } = {}) {
  const registry = createCommandRegistry()
  registerCoreCommands(registry)
  const kernel = createKernelRuntime({ commandRegistry: registry })
  /** @type {string[]} */
  const calls = []
  const registration = {
    name: 'claude',
    defaultUpstream: 'anthropic',
    /** @param {any} ctx */
    async attach(ctx) {
      calls.push('claude')
      if (throwOnAttach) {
        throw new Error(
          'models.providers.anthropic already exists in ~/.openclaw/openclaw.json and was not written by HypAware'
        )
      }
      if (ctx.json) {
        ctx.stdout.write(
          JSON.stringify({
            status: 'ok',
            action: 'attach',
            client: 'claude',
            dry_run: ctx.dryRun === true,
            settings_path: '/tmp/claude/settings.json',
            changed: true,
            port: 4388,
          }) + '\n'
        )
      }
    },
  }
  kernel.capabilities.provide('test', 'hypaware.ai-gateway', '2.0.0', {
    registerUpstreamPreset() {},
    registerClient() {},
    registerExchangeProjector() {},
    registerSettlementEnricher() {},
    localEndpoint() {
      return 'http://127.0.0.1:4388'
    },
    /** @param {string} name */
    getClient(name) {
      return name === 'claude' ? registration : undefined
    },
    listClients() {
      return [registration]
    },
  })
  return { registry, kernel, calls }
}

/** @param {string} stateRoot */
function readMarkers(stateRoot) {
  const p = path.join(stateRoot, 'config-control', 'client-actions.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/**
 * Pre-seed a `refused` attach marker, as if `action_attach.js`'s `perform()`
 * had already recorded a permanent precondition refusal for this client
 * (LLP 0186 §on-disk-shape): no `attempts`, `reason` + `at` like `failed`.
 *
 * @param {string} stateRoot
 * @param {string} requestKey
 */
function seedRefusedMarker(stateRoot, requestKey) {
  const dir = path.join(stateRoot, 'config-control')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'client-actions.json'),
    JSON.stringify(
      {
        attach: {
          [requestKey]: {
            status: 'refused',
            request_key: requestKey,
            reason:
              'models.providers.anthropic already exists in ~/.openclaw/openclaw.json and was not written by HypAware',
            at: '2026-08-01T00:00:00.000Z',
          },
        },
      },
      null,
      2
    ) + '\n'
  )
}

/**
 * A minimal reconcile input naming just `claude`, mirroring
 * test/core/attach-endpoint-drift.test.js's `reconcileInput` helper.
 *
 * @param {{ home: string, clients: any }} args
 */
function reconcileInput({ home, clients }) {
  return {
    config: /** @type {any} */ ({ version: 2, plugins: [{ name: '@hypaware/claude', enabled: true, config: {} }] }),
    backfills: /** @type {any} */ ({ register() {}, get() { return undefined }, list() { return [] } }),
    env: { HOME: home },
    clientDescriptors: new Map([[CLAUDE_DESCRIPTOR.name, CLAUDE_DESCRIPTOR]]),
    clients,
    endpoint: 'http://127.0.0.1:4388',
  }
}

test('a successful manual hyp attach clears a refused marker, and the next reconcile re-performs (LLP 0186 re-arm)', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-attach-rearm-'))
  const stateRoot = path.join(home, 'hypaware')
  try {
    seedRefusedMarker(stateRoot, 'claude')

    const { registry, kernel, calls } = fakeClientKernel()
    const result = await attach('claude', {
      hypHome: home,
      env: { ...process.env, HOME: home, HYP_HOME: home },
      // @ts-expect-error test-only kernel injection
      registry,
      kernel,
    })
    assert.equal(result.status, 'ok')
    assert.deepEqual(calls, ['claude'])

    // The re-arm is a CLEAR, not a rewrite: no entry left at that request key.
    assert.equal(
      readClientActionStatus({ stateRoot }).byKind.attach?.claude,
      undefined,
      'a successful manual attach clears the refused marker (LLP 0186 re-arm)'
    )

    // With no marker at all, the next reconcile pass treats `claude` as a
    // fresh target (existing lookup returns undefined) and re-`perform()`s,
    // writing its own fresh `done` marker - proving the CLI clear, not any
    // reconciler-side special-casing of `refused`, is what unblocks it.
    /** @type {string[]} */
    const reconcileCalls = []
    const reconcileClients = {
      /** @param {string} name */
      getClient(name) {
        if (name !== 'claude') return undefined
        return {
          name: 'claude',
          /** @param {any} ctx */
          async attach(ctx) {
            reconcileCalls.push('claude')
            ctx.stdout.write(JSON.stringify({ status: 'ok', changed: true }) + '\n')
          },
        }
      },
      listClients() {
        return []
      },
    }
    const reconciler = createActionReconciler({
      stateRoot,
      handlers: [createAttachHandler()],
      now: () => Date.parse('2026-08-04T00:00:00.000Z'),
      log: NOOP_LOG,
    })
    const report = await reconciler.reconcile(reconcileInput({ home, clients: reconcileClients }))

    assert.deepEqual(report.results.map((r) => r.outcome), ['done'])
    assert.deepEqual(
      reconcileCalls,
      ['claude'],
      're-arm let the reconciler re-perform() instead of staying short-circuited on a stale refused marker'
    )
    assert.equal(readMarkers(stateRoot).attach.claude.status, 'done', 'the reconciler writes a fresh done marker')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('a failed manual hyp attach leaves the refused marker in place (never cleared on failure)', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-attach-rearm-fail-'))
  const stateRoot = path.join(home, 'hypaware')
  try {
    seedRefusedMarker(stateRoot, 'claude')

    const { registry, kernel, calls } = fakeClientKernel({ throwOnAttach: true })
    await assert.rejects(
      attach('claude', {
        hypHome: home,
        env: { ...process.env, HOME: home, HYP_HOME: home },
        // @ts-expect-error test-only kernel injection
        registry,
        kernel,
      }),
      HypAwareCommandError
    )
    assert.deepEqual(calls, ['claude'])

    // The manual attach never got past client.attach() throwing, so the
    // clearClientActionMarker call below it in the success path never runs:
    // the refused marker set up before this attempt survives unchanged.
    const marker = readClientActionStatus({ stateRoot }).byKind.attach?.claude
    assert.equal(marker?.status, 'refused', 'a failed manual attach must never clear the refused marker')
    assert.equal(marker && 'attempts' in marker, false, 'a refused marker never carries attempts')
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

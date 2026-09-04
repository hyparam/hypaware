// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, installObservability, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { registerCoreCommands } from '../../../src/core/cli/core_commands.js'
import { createCommandRegistry } from '../../../src/core/registry/commands.js'
import { createKernelRuntime } from '../../../src/core/runtime/activation.js'
import { activatePlugins } from '../../../src/core/runtime/loader.js'
import { loadManifests } from '../../../src/core/manifest.js'
import { pluginStateDir } from '../../../src/core/runtime/paths.js'
import {
  AI_GATEWAY_SCHEMA_COLUMNS,
  aiGatewayTablePath,
} from '../../plugins-workspace/ai-gateway/src/dataset.js'
import {
  requireGithubRuntime,
  setGithubRuntime,
} from '../../plugins-workspace/github/src/runtime.js'

const WORKSPACE = path.resolve(import.meta.dirname, '..', '..', 'plugins-workspace')
const PLUGINS = ['@hypaware/ai-gateway', '@hypaware/context-graph', '@hypaware/github']
const CLEAN_REPO = 'acme/widgets'
const WITHHELD_REPO = 'acme/secrets'

/**
 * Hermetic proof of the withheld half of the session-evidence inventory: a
 * repository evidenced only by `local-only` sessions is never admitted, and a
 * repository already admitted is retired once its evidence becomes withheld.
 * The sibling `github_local_capture` proves the admitted half.
 *
 * Two kernel lifetimes over one install. A revalidation's trigger and its row
 * verdicts read different sources: `exportPolicyFingerprint()` re-reads the
 * list file every tick, so the trigger fires at once, while the drop verdicts
 * the pass consumes come from the usage-policy resolver's per-cwd cache
 * (`src/core/usage-policy/matcher.js`, 5s TTL). Within one lifetime the pass
 * therefore fires on the new policy but re-confirms the repository from stale
 * `full` verdicts and stamps the new fingerprint, latching the missed
 * retirement until the seven-day `stale` backstop (issue #1317). A second
 * lifetime gets a fresh resolver, which is both the deterministic way to
 * observe a policy written after the first tick and the realistic one: a
 * daemon restart is how the field reaches the same state. This flow asserts
 * the restart path only; #1317 is the uncovered one.
 *
 * @param {{ harness: any, expect: any }} args
 * @ref LLP 0360#inventory [tests]: withheld evidence does not expand the inventory, so no forwardable row is written for its repository
 * @ref LLP 0367#triggers [tests]: a machine-local policy change fires a re-derivation, which retires a repository whose only evidence is now withheld
 * @ref LLP 0367#conservative [tests]: retirement stops future capture only; rows already written are not retracted
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const cacheRoot = path.join(harness.stateDir, 'cache')
  const tmpRoot = path.join(harness.tmpDir, 'plugin-temp')
  await fs.mkdir(tmpRoot, { recursive: true })

  const cleanCwd = path.join(harness.tmpDir, 'clean-repo')
  const withheldCwd = path.join(harness.tmpDir, 'withheld-repo')
  await fs.mkdir(cleanCwd, { recursive: true })
  await fs.mkdir(withheldCwd, { recursive: true })

  const first = await step('activate', () => bootLifetime())

  // Marked before the first capture tick, so the evidence for the withheld
  // repository is never export-eligible: this is non-admission, not retirement.
  await step('mark_local_only', () => markLocalOnly(first, withheldCwd))

  await step('seed_session_evidence', async () => {
    const tablePath = aiGatewayTablePath(first.kernel.storage)
    await first.kernel.storage.appendRows(
      tablePath,
      [...AI_GATEWAY_SCHEMA_COLUMNS],
      [
        sessionRow({ id: 'clean', cwd: cleanCwd, remote: 'git@github.com:Acme/Widgets.git' }),
        sessionRow({ id: 'withheld', cwd: withheldCwd, remote: 'git@github.com:Acme/Secrets.git' }),
      ]
    )
    await first.kernel.storage.flushTable(tablePath, { force: true, reason: 'smoke_seed' })
  })

  await step('capture_admits_clean_only', async () => {
    const result = await dispatchText(['github', 'sync'], first)
    // stderr first: the `assertRepo` guard below reports an admitted-but-withheld
    // repository by throwing inside the command, which surfaces as stderr text and
    // only then as a nonzero exit. Checking the code first would report `value=1`
    // and discard the one line that names which repository escaped.
    expect.that('github sync: no stderr', result.stderr, (value) => value === '')
    expect.that('github sync: command exited 0', result.code, (value) => value === 0)
    expect.that(
      'github sync: only the export-eligible session admitted a repository',
      result.stdout,
      (value) => value.includes('1 event(s) across 1 repo(s)')
    )

    const inventory = await readInventory(harness)
    expect.that(
      'inventory: the local-only session did not admit its repository',
      inventory.repos,
      (value) => JSON.stringify(value) === JSON.stringify([CLEAN_REPO])
    )

    const withheldEvents = await sqlCount(
      `select count(*) as n from github_events where repo = '${WITHHELD_REPO}'`,
      first
    )
    expect.that(
      'github_events: no row exists for the withheld repository',
      withheldEvents,
      (value) => value === 0
    )
    const cleanEvents = await sqlCount(
      `select count(*) as n from github_events where repo = '${CLEAN_REPO}'`,
      first
    )
    expect.that('github_events: the admitted repository captured one row', cleanEvents, (value) => value === 1)

    // `local-only` withholds at the export seam, it does not stop recording.
    // Pinning both sides is what separates this flow from an `ignore` one:
    // every assertion above reads the same if the evidence were never stored.
    const withheldSession = `select count(*) as n from ai_gateway_messages where cwd = '${withheldCwd}'`
    expect.that(
      'ai_gateway_messages: the withheld session is still recorded locally',
      await sqlCount(withheldSession, first),
      (value) => value === 1
    )
    const exportView = await dispatchText(
      ['query', 'sql', withheldSession, '--refresh', 'always', '--format', 'json'],
      first
    )
    expect.that(
      'ai_gateway_messages: an export-stance caller sees no row and is told one was withheld',
      exportView,
      (value) =>
        value.code === 0 &&
        Number(JSON.parse(value.stdout)[0]?.n) === 0 &&
        /local-only: withheld 1 row\(s\)/.test(value.stderr)
    )
  })

  // Marking the remaining session's directory leaves the inventory with no
  // export-eligible evidence at all.
  await step('flip_policy', () => markLocalOnly(first, cleanCwd))

  // What retires the repository is this call, not which lifetime the sync below
  // is dispatched through. `github sync` resolves its index and storage from the
  // module-level runtime singleton at call time (`requireGithubRuntime()` in
  // github/src/commands.js), and each activation replaces that singleton, so
  // after this line `first`'s observed-repos index is simply orphaned: it is
  // unreachable from the command path and cannot write its pre-retirement set
  // back over the sidecar. `second` is still what the steps below name, because
  // reading the assertions should not require knowing about the singleton.
  const second = await step('restart', () => bootLifetime())

  await step('retire_on_policy_change', async () => {
    const result = await dispatchText(['github', 'sync'], second)
    expect.that('github sync: no stderr after the policy change', result.stderr, (value) => value === '')
    expect.that('github sync: command exited 0 after the policy change', result.code, (value) => value === 0)
    expect.that(
      'github sync: the retired repository is no longer captured',
      result.stdout,
      (value) => value.includes('0 event(s) across 0 repo(s)')
    )

    const inventory = await readInventory(harness)
    expect.that('inventory: the retired repository is gone from the persisted set', inventory.repos, (value) => Array.isArray(value) && value.length === 0)

    const cleanEvents = await sqlCount(
      `select count(*) as n from github_events where repo = '${CLEAN_REPO}'`,
      second
    )
    expect.that(
      'github_events: the row captured before retirement is not retracted',
      cleanEvents,
      (value) => value === 1
    )
  })

  await obs.shutdown()
  const logs = await expect.logs()
  expect.that(
    'telemetry: the first tick carried one candidate repository into capture',
    logs,
    (rows) => rows.some((row) =>
      row.body === 'github.inventory_resolved' &&
      row.attributes?.mode === 'session_repos' &&
      row.attributes?.candidates === 1 &&
      row.attributes?.selected_repos === 1
    )
  )
  const starts = logs.filter((row) => row.body === 'github.observed_repos_revalidation_started')
  expect.that(
    'telemetry: exactly one revalidation ran, and the policy change is what fired it',
    starts,
    (rows) => rows.length === 1 && rows[0]?.attributes?.trigger === 'policy_changed' && rows[0]?.attributes?.repos === 1
  )
  // `rows_read` is what separates the two ways `repos_confirmed` reaches 0: the
  // pass streamed both evidence rows and the export seam dropped each one, or it
  // streamed nothing at all and completed vacuously (an empty partition set makes
  // `paths.every(...)` true). Only the first retires for the reason under test.
  expect.that(
    'telemetry: the pass read both evidence rows, confirmed neither, and retired the repository',
    logs,
    (rows) => rows.some((row) =>
      row.body === 'github.observed_repos_revalidation_completed' &&
      row.attributes?.status === 'ok' &&
      row.attributes?.rows_read === 2 &&
      row.attributes?.repos_confirmed === 0 &&
      row.attributes?.repos_retired === 1
    )
  )
  expect.that(
    'telemetry: the post-retirement tick captured nothing and left no work pending',
    logs,
    (rows) => rows.some((row) =>
      row.body === 'github.capture_tick_completed' &&
      row.attributes?.mode === 'poll' &&
      row.attributes?.repos === 0 &&
      row.attributes?.pending === false &&
      row.attributes?.inventory_pending === false
    )
  )

  /**
   * Bring up one kernel lifetime over the shared install: fresh registries and
   * a fresh usage-policy resolver, the persisted observed-repos sidecar.
   */
  async function bootLifetime() {
    const registry = createCommandRegistry()
    registerCoreCommands(registry)
    const kernel = createKernelRuntime({ commandRegistry: registry, cacheRoot })
    const { loaded } = await loadManifests(
      PLUGINS.map((name) => path.join(WORKSPACE, path.basename(name)))
    )
    const byName = new Map(loaded.map((entry) => [entry.manifest.name, entry]))
    const entries = PLUGINS.map((name) => {
      const entry = byName.get(name)
      if (!entry) throw new Error(`missing bundled manifest ${name}`)
      return { manifest: entry.manifest, rootDir: entry.rootDir, config: {} }
    })
    const activated = await activatePlugins({
      plugins: entries,
      stateRoot: harness.stateDir,
      runId: harness.devRunId,
      runtime: kernel,
      tmpRoot,
    })
    expect.that(
      'activation: every bundled plugin activated',
      activated.results,
      (rows) => rows.length === PLUGINS.length && rows.every((row) => row.ok)
    )
    // Keep the real observed-repository index and cache storage the activation
    // installed, replacing only the network client.
    setGithubRuntime({ ...requireGithubRuntime(), clientFactory: () => fakeGithubClient() })
    return { kernel, registry }
  }

  /** @param {{ kernel: any, registry: any }} lifetime @param {string} dir */
  async function markLocalOnly(lifetime, dir) {
    const result = await dispatchText(['privacy', 'ignore', '--local-only', dir], lifetime)
    expect.that('privacy ignore --local-only: exited 0', result.code, (value) => value === 0)
    expect.that('privacy ignore --local-only: no stderr', result.stderr, (value) => value === '')
    expect.that(
      'privacy ignore --local-only: confirms the marked directory',
      result.stdout,
      (value) => value.includes(dir) && value.includes('local-only')
    )
  }

  /** @param {string} smokeStep @param {() => Promise<any>} fn */
  function step(smokeStep, fn) {
    return runRoot(
      `smoke.step.${smokeStep}`,
      {
        [Attr.COMPONENT]: 'smoke',
        [Attr.OPERATION]: 'smoke.step',
        [Attr.SMOKE_NAME]: harness.smokeName,
        [Attr.SMOKE_STEP]: smokeStep,
        [Attr.DEV_RUN_ID]: harness.devRunId,
        status: 'ok',
      },
      fn
    )
  }
}

/** Read the persisted observed-repos sidecar, the durable inventory itself. */
async function readInventory(harness) {
  const file = path.join(
    pluginStateDir(harness.stateDir, '@hypaware/github'),
    'github-observed-repos.json'
  )
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

function fakeGithubClient() {
  return {
    async listViewerRepos() { throw new Error('session inventory must not enumerate GitHub') },
    async listIssuesPage(owner, name) {
      assertRepo(owner, name)
      return { items: [{
        number: 7,
        state: 'open',
        created_at: '2026-09-02T12:00:00.000Z',
        user: { login: 'octocat', type: 'User' },
      }], next: null }
    },
    async listPullRequestsPage(owner, name) { assertRepo(owner, name); return { items: [], next: null } },
    async listPullRequestFilesPage() { return { items: [], next: null } },
    async listPullRequestReviewsPage() { return { items: [], next: null } },
    async listPullRequestCommitsPage() { return { items: [], next: null } },
    async listCommitsPage(owner, name) { assertRepo(owner, name); return { items: [], next: null } },
    async listCommitFilesPage() { return { items: [], next: null } },
    async listIssueCommentsPage() { return { items: [], next: null } },
  }
}

/**
 * A withheld repository must never reach the network at all, so an admitted
 * one fails here rather than only in a row count.
 *
 * @param {string} owner @param {string} name
 */
function assertRepo(owner, name) {
  const repo = `${owner}/${name}`.toLowerCase()
  if (repo !== CLEAN_REPO) {
    throw new Error(`withheld repository reached the GitHub client: ${repo}`)
  }
}

/** @param {{ id: string, cwd: string, remote: string }} args */
function sessionRow({ id, cwd, remote }) {
  const ts = '2026-09-02T12:00:00.000Z'
  return {
    gateway_id: 'gw-github-withhold-smoke',
    schema_version: 1,
    session_id: `github-withhold-${id}`,
    conversation_id: `github-withhold-${id}`,
    provider: 'openai',
    model: 'gpt-5',
    client_name: 'codex',
    cwd,
    git_remote: remote,
    git_branch: 'main',
    head_sha: '0123456789abcdef0123456789abcdef01234567',
    repo_root: cwd,
    user_id: 'user-smoke',
    conversation_started_at: ts,
    message_created_at: ts,
    message_id: `github-withhold-${id}-message`,
    message_index: 0,
    role: 'user',
    part_type: 'text',
    part_index: 0,
    part_id: `github-withhold-${id}-message#0`,
    content_text: 'test fixture',
    date: '2026-09-02',
  }
}

async function sqlCount(sql, lifetime) {
  const result = await dispatchText(
    ['query', 'sql', sql, '--refresh', 'always', '--include-local-only', '--format', 'json'],
    lifetime
  )
  if (result.code !== 0 || result.stderr !== '') {
    throw new Error(`query failed: ${result.stderr || result.stdout}`)
  }
  const rows = JSON.parse(result.stdout)
  return Number(rows[0]?.n)
}

/** @param {string[]} argv @param {{ kernel: any, registry: any }} lifetime */
async function dispatchText(argv, { kernel, registry }) {
  const stdout = makeBuf()
  const stderr = makeBuf()
  const code = await dispatch(argv, {
    stdout,
    stderr,
    kernel,
    registry,
    env: { ...process.env, HYP_HOME: process.env.HYP_HOME },
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

function makeBuf() {
  const chunks = []
  return {
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    },
    text() { return chunks.join('') },
  }
}

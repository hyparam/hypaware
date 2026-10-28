// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { registerCoreCommands } from '../../src/core/cli/core_commands.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { composePickerConfig } from '../../src/core/cli/walkthrough.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { readObservabilityEnv } from '../../src/core/observability/env.js'
import { isActionRefused } from '../../src/core/config/action_refusal.js'
import { detachClientFromDisk } from '../../src/core/config/client_detach_disk.js'
import { probeClientAttachFromDescriptor } from '../../src/core/daemon/status.js'
import { loadManifest } from '../../src/core/manifest.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { diagnosePlugin } from '../../src/core/plugin_doctor/diagnose.js'
import { createCommandRegistry } from '../../src/core/registry/commands.js'
import { createActivationContext, createKernelRuntime } from '../../src/core/runtime/activation.js'
import { resolveConfigPath } from '../../src/core/runtime/boot.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { writeLocalOnlyEntries } from '../../src/core/usage-policy/local_only.js'
import {
  ANTIGRAVITY_PLUGIN_MARKER,
  activate as activateAntigravityCli,
  attachAntigravityPlugin,
  CLI_TRAJECTORY_SOURCE,
  createAntigravityBackfillProvider,
  extractUserRequestText,
  listAntigravityConversations,
  projectAntigravityConversation,
  resolveCwdFromWorkspaceUris,
  startAntigravitySource,
  validateAntigravityConfig,
} from '../../hypaware-core/plugins-workspace/antigravity/src/index.js'
import {
  activate as activateAntigravityDesktop,
  DESKTOP_VARIANT,
} from '../../hypaware-core/plugins-workspace/antigravity-desktop/src/index.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const CLI_PLUGIN_DIR = path.resolve('hypaware-core/plugins-workspace/antigravity')
const DESKTOP_PLUGIN_DIR = path.resolve('hypaware-core/plugins-workspace/antigravity-desktop')

/**
 * Create a conversation_summaries.db file with the Antigravity schema and
 * insert the provided summary rows.
 *
 * @param {string} appDataDir
 * @param {Array<Record<string, unknown>>} rows
 */
async function seedSummariesDb(appDataDir, rows) {
  await fs.mkdir(appDataDir, { recursive: true })
  const dbPath = path.join(appDataDir, 'conversation_summaries.db')
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        step_count INTEGER,
        created_time TEXT,
        last_modified_time TEXT,
        workspace_uris TEXT,
        status TEXT,
        source TEXT,
        metadata TEXT,
        project_id TEXT,
        agent_name TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER DEFAULT 0,
        error_Message TEXT,
        last_user_input_time TEXT,
        last_user_input_step_index INTEGER DEFAULT 0,
        summary_pb BLOB,
        app_data_dir TEXT
      )
    `)
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO conversation_summaries (
        conversation_id,
        title,
        step_count,
        last_modified_time,
        workspace_uris,
        status,
        source,
        agent_name,
        parent_conversation_id,
        nesting_depth,
        last_user_input_time,
        app_data_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const r of /** @type {any[]} */ (rows)) {
      stmt.run(
        String(r.conversation_id),
        r.title ?? null,
        r.step_count ?? 0,
        r.last_modified_time ?? null,
        r.workspace_uris ?? null,
        r.status ?? 'CASCADE_RUN_STATUS_IDLE',
        r.source ?? 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
        r.agent_name ?? null,
        r.parent_conversation_id ?? null,
        r.nesting_depth ?? 0,
        r.last_user_input_time ?? null,
        r.app_data_dir ?? appDataDir
      )
    }
  } finally {
    db.close()
  }
}

/**
 * Write a transcript_full.jsonl file for a conversation under `appDataDir`.
 *
 * @param {string} appDataDir
 * @param {string} conversationId
 * @param {Array<Record<string, unknown>>} steps
 * @returns {Promise<string>}
 */
async function writeTranscript(appDataDir, conversationId, steps) {
  const logsDir = path.join(appDataDir, 'brain', conversationId, '.system_generated', 'logs')
  await fs.mkdir(logsDir, { recursive: true })
  const filePath = path.join(logsDir, 'transcript_full.jsonl')
  const body = steps.map((s) => JSON.stringify(s)).join('\n') + '\n'
  await fs.writeFile(filePath, body, 'utf8')
  return filePath
}

test('both @hypaware/antigravity and @hypaware/antigravity-desktop pass manifest validation and plugin doctor', async () => {
  for (const dir of [CLI_PLUGIN_DIR, DESKTOP_PLUGIN_DIR]) {
    const loaded = await loadManifest(dir)
    assert.equal(loaded.ok, true, `${dir} manifest failed to load`)
    const report = await diagnosePlugin(dir)
    // The shared ai_gateway_messages dataset is owned by @hypaware/ai-gateway.
    // Declaring it here would make this client a dataset owner and widen the
    // fail-closed arming set (LLP 0192), so it stays undeclared, as for droid,
    // opencode and cursor, and the doctor's one warning about it is expected.
    const unexpected = report.diagnostics.filter(
      (d) => !(d.kind === 'contribution_undeclared' && d.location === '/contributes/datasets' && d.message.includes("'ai_gateway_messages'"))
    )
    assert.deepEqual(unexpected, [], `${dir} reported doctor diagnostics: ${JSON.stringify(unexpected)}`)
  }
})

test('picker composes antigravity CLI and antigravity-desktop independently or together', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const d = catalog.pickerDescriptors

  assert.deepEqual(d.get('antigravity')?.detect, { settings_file: '.gemini/antigravity-cli/settings.json' })
  assert.deepEqual(d.get('antigravity-desktop')?.detect, { settings_file: '.gemini/antigravity/conversation_summaries.db' })

  const cliOnly = composePickerConfig({
    sources: ['antigravity'],
    descriptors: d,
    exportChoice: 'keep-local',
    retentionDays: 30,
    hypHome: '/tmp/hyp',
  })
  assert.deepEqual(cliOnly.plugins, [
    { name: '@hypaware/ai-gateway', config: { upstreams: [] } },
    { name: '@hypaware/antigravity' },
  ])

  const desktopOnly = composePickerConfig({
    sources: ['antigravity-desktop'],
    descriptors: d,
    exportChoice: 'keep-local',
    retentionDays: 30,
    hypHome: '/tmp/hyp',
  })
  assert.deepEqual(desktopOnly.plugins, [
    { name: '@hypaware/ai-gateway', config: { upstreams: [] } },
    { name: '@hypaware/antigravity-desktop' },
  ])

  const both = composePickerConfig({
    sources: ['antigravity', 'antigravity-desktop'],
    descriptors: d,
    exportChoice: 'keep-local',
    retentionDays: 30,
    hypHome: '/tmp/hyp',
  })
  assert.deepEqual(both.plugins, [
    { name: '@hypaware/ai-gateway', config: { upstreams: [] } },
    { name: '@hypaware/antigravity' },
    { name: '@hypaware/antigravity-desktop' },
  ])
})

test('validateAntigravityConfig accepts valid settings and rejects invalid keys or shapes', () => {
  assert.deepEqual(validateAntigravityConfig(undefined), { ok: true })
  assert.deepEqual(
    validateAntigravityConfig({
      enabled: true,
      app_data_dir: '~/.gemini/antigravity-cli',
      poll_interval: '15s',
      attach: { on_join: true },
      backfill: { on_join: true, window_days: 30 },
    }),
    { ok: true }
  )

  const bad = validateAntigravityConfig(
    {
      enabled: 'yes',
      app_data_dir: '',
      poll_interval: '0s',
      unknown_flag: 123,
    },
    'antigravity_desktop'
  )
  assert.equal(bad.ok, false)
  assert.equal(bad.errors?.length, 4)
  assert.ok(bad.errors?.some((i) => i.pointer === '/unknown_flag'))
  assert.ok(bad.errors?.some((i) => i.pointer === '/enabled'))
  assert.ok(bad.errors?.some((i) => i.pointer === '/app_data_dir'))
  assert.ok(bad.errors?.some((i) => i.pointer === '/poll_interval'))
})

test('attachAntigravityPlugin writes marker-owned plugin.json, probes attached, and detaches cleanly', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agy-attach-'))
  const env = { HOME: homeDir }

  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  const descriptor = catalog.clientDescriptors.get('antigravity')
  assert.ok(descriptor)

  // Initially not attached
  const beforeProbe = await probeClientAttachFromDescriptor({ descriptor, env, homeDir })
  assert.equal(beforeProbe.attached, false)

  // Attach writes the JSONC plugin.json with marker
  const firstAttach = await attachAntigravityPlugin({ version: '1.0.0', env, homeDir })
  assert.equal(firstAttach.changed, true)
  const raw = await fs.readFile(firstAttach.settingsPath, 'utf8')
  assert.ok(raw.startsWith(`${ANTIGRAVITY_PLUGIN_MARKER}\n`))

  // Re-attach is idempotent
  const secondAttach = await attachAntigravityPlugin({ version: '1.0.0', env, homeDir })
  assert.equal(secondAttach.changed, false)

  // Probe now reports attached
  const afterProbe = await probeClientAttachFromDescriptor({ descriptor, env, homeDir })
  assert.equal(afterProbe.attached, true)

  // Detach removes only the marker-owned file
  const detached = await detachClientFromDisk({
    descriptor,
    env,
    homeDir,
  })
  assert.equal(detached.changed, true)
  await assert.rejects(fs.access(firstAttach.settingsPath))

  // Foreign file without marker is refused with markActionRefused
  await fs.mkdir(path.dirname(firstAttach.settingsPath), { recursive: true })
  await fs.writeFile(firstAttach.settingsPath, '{"name":"custom"}\n', 'utf8')
  await assert.rejects(
    attachAntigravityPlugin({ version: '1.0.0', env, homeDir }),
    (err) => isActionRefused(err)
  )
})

test('listAntigravityConversations filters CLI-synced rows for Desktop while preserving CLI and unindexed brain dirs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agy-summaries-'))
  const desktopDir = path.join(root, '.gemini', 'antigravity')

  await seedSummariesDb(desktopDir, [
    {
      conversation_id: 'desktop-conv-1',
      title: 'Desktop conversation',
      step_count: 5,
      source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
    },
    {
      conversation_id: 'cli-synced-conv-2',
      title: 'CLI conversation synced into Desktop DB',
      step_count: 3,
      source: CLI_TRAJECTORY_SOURCE,
    },
  ])
  // Unindexed conversation folder on disk under brain/
  await writeTranscript(desktopDir, 'unindexed-conv-3', [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>hello</USER_REQUEST>', created_at: '2026-04-01T10:00:00Z' },
  ])

  // Desktop mode excludes `CORTEX_TRAJECTORY_SOURCE_CLI`
  const desktopListed = await listAntigravityConversations(desktopDir, {
    excludeCliSyncedSummaries: true,
  })
  assert.equal(desktopListed.available, true)
  assert.deepEqual(
    desktopListed.summaries.map((s) => s.conversation_id),
    ['desktop-conv-1', 'unindexed-conv-3']
  )

  // CLI mode keeps `CORTEX_TRAJECTORY_SOURCE_CLI`
  const cliListed = await listAntigravityConversations(desktopDir, {
    excludeCliSyncedSummaries: false,
  })
  assert.equal(cliListed.available, true)
  assert.deepEqual(
    cliListed.summaries.map((s) => s.conversation_id),
    ['cli-synced-conv-2', 'desktop-conv-1', 'unindexed-conv-3']
  )
})

test('projectAntigravityConversation projects user requests, thinking, tool calls, tool results, usage, and subagent linkage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agy-project-'))
  const workspaceDir = path.join(root, 'repo')
  await fs.mkdir(workspaceDir, { recursive: true })
  const workspaceUri = pathToFileURL(workspaceDir).href

  assert.equal(resolveCwdFromWorkspaceUris(JSON.stringify([workspaceUri])), workspaceDir)
  assert.equal(
    extractUserRequestText('<USER_SETTINGS_CHANGE>\nModel: foo\n</USER_SETTINGS_CHANGE>\n<USER_REQUEST>\nFix the bug\n</USER_REQUEST>'),
    'Fix the bug'
  )

  const transcriptPath = await writeTranscript(root, 'conv-child-1', [
    {
      step_index: 0,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      status: 'DONE',
      created_at: '2026-04-10T12:00:00.000Z',
      content: '<USER_SETTINGS_CHANGE>\n...\n</USER_SETTINGS_CHANGE>\n<USER_REQUEST>\nRun the tests\n</USER_REQUEST>',
    },
    {
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      created_at: '2026-04-10T12:00:02.000Z',
      completed_at: '2026-04-10T12:00:03.000Z',
      thinking: 'Let us run npm test.',
      content: 'Running the test suite now.',
      input_tokens: 1200,
      cache_read_tokens: 800,
      output_tokens: 45,
      tool_calls: [
        {
          name: 'default_api:run_command',
          args: { CommandLine: 'npm test' },
        },
      ],
    },
    {
      step_index: 5,
      type: 'GENERIC',
      source: 'MODEL',
      status: 'ERROR',
      created_at: '2026-04-10T12:00:04.000Z',
      error: 'Test failed: exit code 1',
    },
  ])

  const projected = await projectAntigravityConversation({
    summary: {
      conversation_id: 'conv-child-1',
      title: 'Test Runner Subagent',
      step_count: 6,
      last_modified_time: '2026-04-10T12:00:04.000Z',
      workspace_uris: JSON.stringify([workspaceUri]),
      status: 'CASCADE_RUN_STATUS_IDLE',
      source: CLI_TRAJECTORY_SOURCE,
      agent_name: 'Test Runner',
      parent_conversation_id: 'conv-parent-0',
      nesting_depth: 1,
      last_user_input_time: '2026-04-10T12:00:00.000Z',
      app_data_dir: root,
    },
    transcriptPath,
    clientName: 'antigravity',
    entrypoint: 'cli',
    deriveRepo: async () => ({
      git_remote: 'https://github.com/example/hypaware.git',
      repo_root: workspaceDir,
    }),
  })

  assert.ok(projected.item)
  const item = projected.item
  assert.equal(item.request_id, 'agy-conv-child-1')
  assert.equal(item.provider, 'google')
  assert.equal(item.client_name, 'antigravity')
  assert.equal(item.entrypoint, 'cli')
  assert.equal(item.session_id, 'conv-child-1')
  assert.equal(item.conversation_id, 'conv-child-1')
  assert.equal(item.parent_thread_id, 'conv-parent-0')
  assert.equal(item.agent_id, 'Test Runner')
  assert.equal(item.is_sidechain, true)
  assert.equal(item.cwd, workspaceDir)
  assert.equal(item.git_remote, 'https://github.com/example/hypaware.git')
  assert.equal(item.repo_root, workspaceDir)

  const msg0Content = /** @type {any[]} */ (item.messages[0].content)
  const msg1Content = /** @type {any[]} */ (item.messages[1].content)
  const msg2Content = /** @type {any[]} */ (item.messages[2].content)

  assert.equal(item.messages.length, 3)
  assert.equal(item.messages[0].role, 'user')
  assert.equal(msg0Content[0].text, 'Run the tests')

  assert.equal(item.messages[1].role, 'assistant')
  assert.equal(msg1Content.length, 3)
  assert.equal(msg1Content[0].type, 'thinking')
  assert.equal(msg1Content[1].type, 'tool_use')
  assert.equal(msg1Content[1].name, 'default_api:run_command')
  assert.equal(msg1Content[1].id, 'agy-conv-child-1-step-4-call-0')
  assert.equal(msg1Content[2].type, 'text')
  assert.deepEqual(item.messages[1].attributes, {
    usage: {
      input_tokens: 1200,
      output_tokens: 45,
      cache_read_tokens: 800,
    },
  })

  assert.equal(item.messages[2].role, 'tool')
  assert.equal(msg2Content[0].type, 'tool_result')
  assert.equal(msg2Content[0].tool_use_id, 'agy-conv-child-1-step-4-call-0')
  assert.equal(msg2Content[0].is_error, true)
  assert.equal(msg2Content[0].content, 'Test failed: exit code 1')
})

test('projectAntigravityConversation drops conversations whose cwd resolves to .hypignore', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agy-ignore-'))
  const secretDir = path.join(root, 'secret-project')
  await fs.mkdir(secretDir, { recursive: true })
  await fs.writeFile(path.join(secretDir, '.hypignore'), '*\n', 'utf8')

  const transcriptPath = await writeTranscript(root, 'conv-ignored', [
    {
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-04-10T12:00:00.000Z',
      content: '<USER_REQUEST>do not record me</USER_REQUEST>',
    },
  ])

  const ignoredSessions = new Set()
  const projected = await projectAntigravityConversation({
    summary: {
      conversation_id: 'conv-ignored',
      title: 'Secret',
      step_count: 1,
      last_modified_time: '2026-04-10T12:00:00.000Z',
      workspace_uris: JSON.stringify([pathToFileURL(secretDir).href]),
      status: 'CASCADE_RUN_STATUS_IDLE',
      source: CLI_TRAJECTORY_SOURCE,
      agent_name: null,
      parent_conversation_id: null,
      nesting_depth: 0,
      last_user_input_time: '2026-04-10T12:00:00.000Z',
      app_data_dir: root,
    },
    transcriptPath,
    resolver: /** @type {any} */ ({
      resolve() {
        return { class: 'ignore', governedBy: path.join(secretDir, '.hypignore'), warn: false }
      },
      clear() {},
    }),
    ignoredSessions,
  })

  assert.equal(projected.skipped, 'hypignore')
  // A path-level ignore is not a session opt-out: the set may persist markers
  assert.equal(ignoredSessions.has('conv-ignored'), false)
})

test('backfill provider collects, honors since window, and caches sweep fingerprints', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agy-backfill-'))
  const appDataDir = path.join(root, '.gemini', 'antigravity')
  const stateDir = path.join(root, 'state', 'antigravity-desktop')
  await fs.mkdir(stateDir, { recursive: true })

  await seedSummariesDb(appDataDir, [
    {
      conversation_id: 'old-conv',
      title: 'Old Desktop Session',
      step_count: 2,
      last_modified_time: '2026-01-01T00:00:00.000Z',
      source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
    },
    {
      conversation_id: 'recent-conv',
      title: 'Recent Desktop Session',
      step_count: 2,
      last_modified_time: '2026-04-15T00:00:00.000Z',
      source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
    },
    {
      conversation_id: 'cli-conv',
      title: 'Synced CLI Session',
      step_count: 2,
      last_modified_time: '2026-04-15T00:00:00.000Z',
      source: CLI_TRAJECTORY_SOURCE,
    },
  ])

  for (const id of ['old-conv', 'recent-conv', 'cli-conv']) {
    await writeTranscript(appDataDir, id, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-04-15T00:00:00.000Z',
        content: `<USER_REQUEST>hello from ${id}</USER_REQUEST>`,
      },
    ])
  }

  const provider = createAntigravityBackfillProvider({
    variant: DESKTOP_VARIANT,
    deriveRepo: async () => ({}),
  })

  const testPaths = { rootDir: root, stateDir, cacheDir: stateDir, tempDir: stateDir }
  const allItems = []
  for await (const item of provider.collect({
    config: { app_data_dir: appDataDir },
    env: { HOME: root },
    homeDir: root,
    paths: testPaths,
  })) {
    allItems.push(item)
  }
  // Excludes `cli-conv` because DESKTOP_VARIANT has excludeCliSyncedSummaries: true
  assert.deepEqual(allItems.map((i) => i.session_id).sort(), ['old-conv', 'recent-conv'])

  // `since` filter excludes `old-conv`
  const sinceItems = []
  for await (const item of provider.collect({
    config: { app_data_dir: appDataDir },
    env: { HOME: root },
    homeDir: root,
    since: '2026-03-01T00:00:00.000Z',
    paths: testPaths,
  })) {
    sinceItems.push(item)
  }
  assert.deepEqual(sinceItems.map((i) => i.session_id), ['recent-conv'])

  // Scheduled sweep caches fingerprints: first sweep yields 2, second sweep yields 0
  const firstSweep = []
  for await (const item of provider.collect({
    config: { app_data_dir: appDataDir },
    env: { HOME: root },
    homeDir: root,
    sweep: true,
    paths: testPaths,
  })) {
    firstSweep.push(item)
  }
  assert.equal(firstSweep.length, 2)

  const secondSweep = []
  for await (const item of provider.collect({
    config: { app_data_dir: appDataDir },
    env: { HOME: root },
    homeDir: root,
    sweep: true,
    paths: testPaths,
  })) {
    secondSweep.push(item)
  }
  assert.equal(secondSweep.length, 0)
})

test('startAntigravitySource materializes conversations into ai_gateway_messages and persists watermarks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agy-source-'))
  const appDataDir = path.join(root, '.gemini', 'antigravity-cli')
  const stateDir = path.join(root, 'state', 'antigravity')
  const cacheRoot = path.join(root, 'cache')
  await fs.mkdir(stateDir, { recursive: true })

  await seedSummariesDb(appDataDir, [
    {
      conversation_id: 'cli-session-1',
      title: 'CLI Session',
      step_count: 2,
      last_modified_time: '2026-04-15T10:00:00.000Z',
      source: CLI_TRAJECTORY_SOURCE,
    },
  ])
  await writeTranscript(appDataDir, 'cli-session-1', [
    {
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-04-15T10:00:00.000Z',
      content: '<USER_REQUEST>Hello CLI</USER_REQUEST>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-04-15T10:00:01.000Z',
      content: 'Hi from Antigravity CLI',
      input_tokens: 50,
      output_tokens: 10,
    },
  ])

  const cliManifestLoaded = await loadManifest(CLI_PLUGIN_DIR)
  assert.equal(cliManifestLoaded.ok, true)
  if (!cliManifestLoaded.ok) return

  const desktopManifestLoaded = await loadManifest(DESKTOP_PLUGIN_DIR)
  assert.equal(desktopManifestLoaded.ok, true)
  if (!desktopManifestLoaded.ok) return

  const runtime = createKernelRuntime({ cacheRoot })
  const ctx = createActivationContext({
    runtime,
    plugin: {
      name: '@hypaware/antigravity',
      version: '1.0.0',
      manifest: cliManifestLoaded.manifest,
      rootDir: CLI_PLUGIN_DIR,
    },
    paths: { rootDir: CLI_PLUGIN_DIR, stateDir, cacheDir: cacheRoot, tempDir: stateDir },
    config: { app_data_dir: appDataDir, poll_interval: '60s' },
    env: { HOME: root },
  })

  await activateAntigravityCli(ctx)

  // Also verify desktop activation on the same runtime succeeds without conflict
  const desktopCtx = createActivationContext({
    runtime,
    plugin: {
      name: '@hypaware/antigravity-desktop',
      version: '1.0.0',
      manifest: desktopManifestLoaded.manifest,
      rootDir: DESKTOP_PLUGIN_DIR,
    },
    paths: { rootDir: DESKTOP_PLUGIN_DIR, stateDir, cacheDir: cacheRoot, tempDir: stateDir },
    config: {},
    env: { HOME: root },
  })
  await activateAntigravityDesktop(desktopCtx)

  const handle = await startAntigravitySource(ctx, {
    deriveRepo: async () => ({}),
    setIntervalFn: /** @type {any} */ (() => ({ unref() {} })),
    clearIntervalFn: () => {},
  })

  // Wait for initial tick via reload
  await handle.reload?.(/** @type {any} */ ({ app_data_dir: appDataDir, poll_interval: '60s' }))
  const status = await handle.status?.()
  assert.equal(status?.state, 'ready')
  assert.equal(status?.details?.sessions_projected, 1)
  assert.equal(status?.details?.rows_materialized, 2)
  assert.equal(status?.details?.watermarked_sessions, 1)

  // Second reload with unchanged transcript does not re-project
  await handle.reload?.(/** @type {any} */ ({ app_data_dir: appDataDir, poll_interval: '60s' }))
  const secondStatus = await handle.status?.()
  assert.equal(secondStatus?.details?.sessions_projected, 1)

  const tablePath = runtime.storage.cacheTablePath('ai_gateway_messages', ['antigravity'])
  const rows = []
  for await (const row of runtime.storage.readRows(tablePath)) {
    rows.push(row)
  }
  assert.equal(rows.length, 2)
  assert.equal(rows[0].client_name, 'antigravity')
  assert.equal(rows[0].entrypoint, 'cli')
  assert.equal(rows[0].session_id, 'cli-session-1')

  await handle.stop()
  const stoppedStatus = await handle.status?.()
  assert.equal(stoppedStatus?.state, 'stopped')
})

test('backfill reads the kernel local-only list and saved session opt-outs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agy-policy-'))
  const env = { HOME: root, HYP_HOME: path.join(root, 'hyp') }
  const stateRoot = readObservabilityEnv(env).stateDir
  const appDataDir = path.join(root, '.gemini', 'antigravity-cli')
  const privateDir = path.join(root, 'private-repo')
  await fs.mkdir(privateDir, { recursive: true })

  await seedSummariesDb(appDataDir, [
    { conversation_id: 'kept-conv', step_count: 1, last_modified_time: '2026-04-15T00:00:00.000Z', source: CLI_TRAJECTORY_SOURCE },
    {
      conversation_id: 'private-conv',
      step_count: 1,
      last_modified_time: '2026-04-15T00:00:00.000Z',
      source: CLI_TRAJECTORY_SOURCE,
      workspace_uris: JSON.stringify([pathToFileURL(privateDir).href]),
    },
    { conversation_id: 'opted-out-conv', step_count: 1, last_modified_time: '2026-04-15T00:00:00.000Z', source: CLI_TRAJECTORY_SOURCE },
  ])
  for (const id of ['kept-conv', 'private-conv', 'opted-out-conv']) {
    await writeTranscript(appDataDir, id, [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-04-15T00:00:00.000Z', content: `<USER_REQUEST>hello ${id}</USER_REQUEST>` },
    ])
  }

  // `hyp usage local-only` writes under the kernel state root, not a plugin state dir
  await writeLocalOnlyEntries({ stateDir: stateRoot, entries: [{ dir: privateDir, class: 'local-only' }] })
  const ignoredSessions = new SessionIgnoreSet(stateRoot)
  // A marker written after the set loaded (another process) still applies on the next run
  new SessionIgnoreSet(stateRoot).add('opted-out-conv')

  const provider = createAntigravityBackfillProvider({ deriveRepo: async () => ({}), ignoredSessions })
  const items = []
  for await (const item of provider.collect({ config: { app_data_dir: appDataDir }, env, homeDir: root })) {
    items.push(item)
  }
  assert.deepEqual(items.map((i) => i.session_id).sort(), ['kept-conv', 'private-conv'])
  const privateItem = items.find((i) => i.session_id === 'private-conv')
  assert.equal(JSON.stringify(privateItem).includes('"usage_class":"local-only"'), true)
  const keptItem = items.find((i) => i.session_id === 'kept-conv')
  assert.equal(JSON.stringify(keptItem).includes('usage_class'), false)
})

test('startAntigravitySource skips saved session opt-outs and stays degraded when listing throws', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agy-source-fail-'))
  const env = { HOME: root, HYP_HOME: path.join(root, 'hyp') }
  const stateRoot = readObservabilityEnv(env).stateDir
  const appDataDir = path.join(root, '.gemini', 'antigravity-cli')
  const stateDir = path.join(root, 'state', 'plugins', 'antigravity')
  const cacheRoot = path.join(root, 'cache')
  await fs.mkdir(stateDir, { recursive: true })

  await seedSummariesDb(appDataDir, [
    { conversation_id: 'kept-conv', step_count: 1, last_modified_time: '2026-04-15T00:00:00.000Z', source: CLI_TRAJECTORY_SOURCE },
    { conversation_id: 'opted-out-conv', step_count: 1, last_modified_time: '2026-04-15T00:00:00.000Z', source: CLI_TRAJECTORY_SOURCE },
  ])
  for (const id of ['kept-conv', 'opted-out-conv']) {
    await writeTranscript(appDataDir, id, [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-04-15T00:00:00.000Z', content: `<USER_REQUEST>hello ${id}</USER_REQUEST>` },
    ])
  }

  const manifestLoaded = await loadManifest(CLI_PLUGIN_DIR)
  assert.equal(manifestLoaded.ok, true)
  if (!manifestLoaded.ok) return
  const runtime = createKernelRuntime({ cacheRoot })
  const ctx = createActivationContext({
    runtime,
    plugin: { name: '@hypaware/antigravity', version: '1.0.0', manifest: manifestLoaded.manifest, rootDir: CLI_PLUGIN_DIR },
    paths: { rootDir: CLI_PLUGIN_DIR, stateDir, cacheDir: cacheRoot, tempDir: stateDir },
    config: { app_data_dir: appDataDir, poll_interval: '60s' },
    env,
  })
  await activateAntigravityCli(ctx)
  assert.ok(runtime.commands.get('session ignore'))

  const ignoredSessions = new SessionIgnoreSet(stateRoot)
  new SessionIgnoreSet(stateRoot).add('opted-out-conv')
  const handle = await startAntigravitySource(ctx, {
    deriveRepo: async () => ({}),
    ignoredSessions,
    setIntervalFn: /** @type {any} */ (() => ({ unref() {} })),
    clearIntervalFn: () => {},
  })
  await handle.reload?.(/** @type {any} */ ({ app_data_dir: appDataDir, poll_interval: '60s' }))
  assert.equal((await handle.status?.())?.details?.sessions_projected, 1)
  const rows = []
  for await (const row of runtime.storage.readRows(runtime.storage.cacheTablePath('ai_gateway_messages', ['antigravity']))) {
    rows.push(row)
  }
  assert.deepEqual([...new Set(rows.map((r) => r.session_id))], ['kept-conv'])

  // A summaries db that cannot be opened fails the tick, not the daemon
  await fs.writeFile(path.join(appDataDir, 'conversation_summaries.db'), 'not a database')
  await handle.reload?.(/** @type {any} */ ({ app_data_dir: appDataDir, poll_interval: '60s' }))
  const failed = await handle.status?.()
  assert.equal(failed?.state, 'degraded')
  await handle.stop()
})

test('backfill provider takes its sweep cadence from backfill.sweep_cron and drops the sweep when on_join is false', () => {
  assert.deepEqual(createAntigravityBackfillProvider().sweep, { cron: '*/5 * * * *' })
  assert.deepEqual(createAntigravityBackfillProvider({ config: { backfill: { sweep_cron: '0 * * * *' } } }).sweep, { cron: '0 * * * *' })
  assert.equal(createAntigravityBackfillProvider({ config: { backfill: { on_join: false } } }).sweep, undefined)
})

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) { value += String(chunk); return true },
    text() { return value },
  }
}

test('attach output names the restart, the skills and subagent, and a missing install', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agy-attach-out-'))
  try {
    const manifestLoaded = await loadManifest(CLI_PLUGIN_DIR)
    assert.equal(manifestLoaded.ok, true)
    if (!manifestLoaded.ok) return
    const runtime = createKernelRuntime({ cacheRoot: path.join(root, 'cache') })
    const stateDir = path.join(root, 'state')
    const ctx = createActivationContext({
      runtime,
      plugin: { name: '@hypaware/antigravity', version: '1.0.0', manifest: manifestLoaded.manifest, rootDir: CLI_PLUGIN_DIR },
      paths: { rootDir: CLI_PLUGIN_DIR, stateDir, cacheDir: stateDir, tempDir: stateDir },
      config: {},
      env: { HOME: root, HYP_HOME: path.join(root, 'hypaware') },
    })
    await activateAntigravityCli(ctx)
    const client = runtime.clients.getClient('antigravity')
    assert.ok(client)

    const dry = makeBuf()
    await client.attach(/** @type {any} */ ({ stdout: dry, stderr: makeBuf(), dryRun: true, json: false }))
    assert.match(dry.text(), /Dry run: nothing was written\.\n  Antigravity CLI not found at .*antigravity-cli\.\n$/)

    const first = makeBuf()
    await client.attach(/** @type {any} */ ({ stdout: first, stderr: makeBuf(), dryRun: false, json: false }))
    assert.match(first.text(), /Installed .*plugin\.json\. Restart Antigravity to load it\./)
    assert.match(first.text(), /It adds the hypaware-query, hypaware-reference and hypaware-privacy skills and the hypaware-analyst subagent in .*hypaware\.\n/)
    assert.match(first.text(), /Antigravity CLI not found at .*antigravity-cli; the plugin will load once it is installed\./)

    await fs.mkdir(path.join(root, '.gemini', 'antigravity-cli'), { recursive: true })
    await fs.writeFile(path.join(root, '.gemini', 'antigravity-cli', 'settings.json'), '{}\n')
    const second = makeBuf()
    await client.attach(/** @type {any} */ ({ stdout: second, stderr: makeBuf(), dryRun: false, json: false }))
    assert.equal(second.text(), `Antigravity plugin already current at ${path.join(root, '.gemini', 'config', 'plugins', 'hypaware', 'plugin.json')}.\n`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('detaching one variant names the still-recording sibling that shared its plugin manifest', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-agy-detach-sibling-'))
  const env = { ...process.env, HOME: home, HYP_HOME: home, HYP_CONFIG: '' }
  try {
    const configPath = resolveConfigPath({ env, hypHome: home })
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      version: 2,
      plugins: [
        { name: '@hypaware/antigravity', enabled: true, config: {} },
        { name: '@hypaware/antigravity-desktop', enabled: true, config: {} },
      ],
    }, null, 2) + '\n')
    await attachAntigravityPlugin({ version: '1.0.0', env, homeDir: home })

    const registry = createCommandRegistry()
    registerCoreCommands(registry)
    const kernel = createKernelRuntime({ commandRegistry: registry })
    const stdout = makeBuf()
    const stderr = makeBuf()
    const code = await dispatch(['detach', 'antigravity'], { stdout, stderr, registry, kernel, env })
    assert.equal(code, 0, stderr.text())
    assert.match(stdout.text(), /Detached antigravity/)
    assert.match(
      stdout.text(),
      /This also removed the plugin for antigravity-desktop, which is still recording\. Run 'hyp attach antigravity-desktop' to restore it\./
    )

    // Once the sibling is detached too, there is no one left to warn about.
    await attachAntigravityPlugin({ version: '1.0.0', env, homeDir: home })
    const again = makeBuf()
    assert.equal(await dispatch(['detach', 'antigravity-desktop'], { stdout: again, stderr, registry, kernel, env }), 0, stderr.text())
    assert.match(again.text(), /Detached antigravity-desktop/)
    assert.doesNotMatch(again.text(), /This also removed the plugin/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

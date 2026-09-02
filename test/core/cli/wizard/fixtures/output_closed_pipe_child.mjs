// The driven half of the real-closing-stream test (LLP 0341): runs
// `runInitWizard` on the decline path with the real sync-scope and
// folder-ask lanes and this process's real stdout - a pipe whose read end
// the parent test closes mid-run. The folder-ask confirm handshakes with
// the parent: it signals READY, waits for the parent to close the pipe
// (CLOSED marker), then answers. The next stdout write after that answer
// is the folder-ask receipt, written after the preference was persisted
// and before the config commit - the exact split-state site issue #1151
// reproduced.
import fs from 'node:fs/promises'
import path from 'node:path'

import { runInitWizard } from '../../../../../src/core/cli/wizard/index.js'

const home = process.env.DRIVE_HOME
if (!home) throw new Error('DRIVE_HOME not set')
const READY = path.join(home, 'ready.marker')
const CLOSED = path.join(home, 'closed.marker')
const configPath = path.join(home, 'config.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const descriptors = [{ plugin: '@hypaware/claude', id: 'claude', label: 'Claude Code' }]
const catalog = {
  plugins: new Map(),
  pluginMetadata: new Map(),
  knownDatasets: new Set(),
  clientDescriptors: new Map(),
  pickerDescriptors: new Map([['claude', descriptors[0]]]),
}

const result = await runInitWizard(/** @type {any} */ ({
  stdout: process.stdout,
  stderr: process.stderr,
  env: { HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_NO_TUI: '1' },
  ctx: { commands: { run: async () => 0 } },
  capabilities: { has: () => false },
  catalog,
  finale: {},
  detect: async () => new Set(['claude']),
  gate: async () => ({ action: 'first-run', managed: false, report: {} }),
  fork: async () => 'team',
  join: async () => ({ status: 'ok', lockedSources: [], managed: true }),
  express: async () => 'choose',
  pick: async () => ({
    exitCode: 0,
    configPath,
    config: { version: 2, plugins: [] },
    configPending: true,
    sourcesPicked: ['claude'],
    exportPicked: 'local-parquet',
    clientsPicked: ['claude'],
    retentionDays: 30,
    descriptors,
    previouslyConfigured: [],
    lockedSources: [],
  }),
  // The sync lane's multiselect, scripted: keep 'claude' checked.
  prompt: async () => ['claude'],
  // The folder-ask confirm: handshake with the parent, then answer.
  confirm: async () => {
    await fs.writeFile(READY, '')
    for (let i = 0; i < 500; i += 1) {
      try {
        await fs.access(CLOSED)
        break
      } catch {
        await sleep(10)
      }
    }
    return 'ask'
  },
  configure: async () => ({ results: [] }),
  finaleRunner: async () => ({
    daemonInstall: { skipped: true, dryRun: false },
    globalInstall: { skipped: true, installed: false },
    attach: [],
    skillsInstalled: [],
    agentsInstalled: [],
    daemonRestart: { skipped: true, dryRun: false, ok: false },
    backfill: [],
  }),
}))
await fs.writeFile(path.join(home, 'result.json'), JSON.stringify(result))
process.exit(result.exitCode)

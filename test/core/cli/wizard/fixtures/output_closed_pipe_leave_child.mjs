// The driven half of the disconnect-path closing-stream test (LLP 0341):
// a managed machine reconfiguring, whose real stdout is a pipe the parent
// test closes while the fork question is on screen. The fork then answers
// 'local', which on an enrolled machine opens the disconnect question -
// a question with an acting default whose "yes" runs the real `hyp leave`
// teardown (LLP 0190 #fork-disconnect). Neither may happen on a surface
// nobody can read.
import fs from 'node:fs/promises'
import path from 'node:path'

import { runInitWizard } from '../../../../../src/core/cli/wizard/index.js'

const home = process.env.DRIVE_HOME
if (!home) throw new Error('DRIVE_HOME not set')
const READY = path.join(home, 'ready.marker')
const CLOSED = path.join(home, 'closed.marker')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const catalog = {
  plugins: new Map(),
  pluginMetadata: new Map(),
  knownDatasets: new Set(),
  clientDescriptors: new Map(),
  pickerDescriptors: new Map(),
}

/** What the run did after the pipe closed, for the parent to assert on. */
const acts = []

const result = await runInitWizard(/** @type {any} */ ({
  stdout: process.stdout,
  stderr: process.stderr,
  env: { HOME: home, HYP_HOME: path.join(home, '.hyp'), HYP_NO_TUI: '1' },
  ctx: { commands: { run: async (name) => { acts.push(`ctx.commands.run:${name}`); return 0 } } },
  capabilities: { has: () => false },
  catalog,
  finale: {},
  detect: async () => new Set(),
  // A configured, fleet-managed machine reconfiguring: `enrolled()` is
  // true, so choosing local opens the disconnect question.
  gate: async () => ({ action: 'reconfigure', managed: true, report: {} }),
  fork: async () => {
    // Fill the pipe so the closed read end is reported, then hand over to
    // the parent and wait for it to close: the surface dies while this
    // question is on screen.
    process.stdout.write('fork question frame\n'.repeat(200))
    await fs.writeFile(READY, '')
    for (let i = 0; i < 1000; i += 1) {
      try {
        await fs.access(CLOSED)
        break
      } catch {
        await sleep(10)
      }
    }
    return 'local'
  },
  confirm: async () => { acts.push('disconnect-question-asked'); return 'disconnect' },
  leave: async () => { acts.push('leave-ran'); return 0 },
  express: async () => 'choose',
  pick: async () => ({
    exitCode: 0,
    configPath: path.join(home, 'config.json'),
    config: { version: 2, plugins: [] },
    configPending: true,
    sourcesPicked: [],
    exportPicked: 'local-parquet',
    clientsPicked: [],
    retentionDays: 30,
    descriptors: [],
    previouslyConfigured: [],
    lockedSources: [],
  }),
  prompt: async () => [],
  configure: async () => { acts.push('configure-ran'); return { results: [] } },
  finaleRunner: async () => {
    acts.push('finale-ran')
    return {
      daemonInstall: { skipped: true, dryRun: false },
      globalInstall: { skipped: true, installed: false },
      attach: [],
      skillsInstalled: [],
      agentsInstalled: [],
      daemonRestart: { skipped: true, dryRun: false, ok: false },
      backfill: [],
    }
  },
}))

await fs.writeFile(path.join(home, 'result.json'), JSON.stringify({ result, acts }))
process.exit(result.exitCode)

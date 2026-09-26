// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolveHeapBudgetBytes } from '../../src/core/query/sql.js'
import { resolveProjectionMaxHeapBytes } from '../../hypaware-core/plugins-workspace/context-graph/src/project.js'

// Issue #2216. The projection whose refusal names HYP_GRAPH_PROJECTION_MAX_HEAP_MB
// and that nobody is watching is the scheduled one, running under the installed
// service. `hyp daemon install` writes no environment block into the LaunchAgent
// plist or the systemd unit and no flag sets one, so the budget for that daemon
// is raised only through the environment its supervisor starts it from
// (`launchctl setenv`, `systemctl --user set-environment`), the same mechanism
// `src/core/daemon/launchd_env.js` uses for NODE_USE_SYSTEM_CA.
//
// That reaches the projection today. Two things keep it reaching, and a break in
// either is silent: the projection simply keeps refusing at the default.
//
//  1. Background work runs in a child forked from the service process (LLP
//     0038), so the value has to survive that fork. A curated `env` there, or a
//     read of the variable in the gateway rather than where the projection runs,
//     breaks it with no error anywhere.
//  2. The procedure has to be written down. A runtime string naming a variable
//     is not a procedure, and an operator who exports it in their own shell
//     changes nothing about the service.
//
// @ref LLP 0038#implemented-boundary [tests]: kernel background work runs in a forked child, so the service environment must reach it
// @ref LLP 0097 [tests]: the operator override is an environment variable read by the process doing the work

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATEWAY_URL = pathToFileURL(path.join(REPO_ROOT, 'src', 'core', 'daemon', 'gateway.js')).href
const PROJECT_URL = pathToFileURL(path.join(
  REPO_ROOT, 'hypaware-core', 'plugins-workspace', 'context-graph', 'src', 'project.js'
)).href

const PROJECTION_KNOB = 'HYP_GRAPH_PROJECTION_MAX_HEAP_MB'
const QUERY_KNOB = 'HYP_QUERY_MAX_HEAP_MB'
const DOC = 'docs/TROUBLESHOOTING.md'

// Neither default, so a child that ignored the service environment cannot
// coincide with it.
const SERVICE_MB = 777

/**
 * A probe the processing child loads before `processor.js` does anything, and
 * which reports what the projection's own resolver returns *in that process*.
 * `--import`, not a check in the parent: the whole question is which process
 * the value reaches.
 *
 * @param {string} dir
 * @param {string} resultPath
 * @returns {Promise<string>}
 */
async function writeProcessingProbe(dir, resultPath) {
  const probe = path.join(dir, 'processing-budget-probe.mjs')
  await fs.writeFile(probe, [
    "import fs from 'node:fs'",
    `import { resolveProjectionMaxHeapBytes } from ${JSON.stringify(PROJECT_URL)}`,
    `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({`,
    '  pid: process.pid,',
    `  knob: process.env[${JSON.stringify(PROJECTION_KNOB)}] ?? null,`,
    '  resolvedBytes: resolveProjectionMaxHeapBytes(),',
    '}))',
    '',
  ].join('\n'))
  return probe
}

/**
 * Boot one gateway daemon whose service environment carries the knob, let it
 * fork its processing child, and report how that went.
 *
 * The daemon runs outside the test runner for the reasons
 * `gateway-boot-failure-status` records (#1527): it forks with this process's
 * stdout inherited, and its stop deadline can end the process, either of which
 * turns into a wedged or silently truncated suite inside a `node --test`
 * worker.
 *
 * @param {{ hypHome: string, configPath: string, probe: string, probeResult: string, resultPath: string }} opts
 * @returns {{ childPid: number | null, bootError: string | null, probeSeen: boolean }}
 */
function runGatewayOutsideTestRunner({ hypHome, configPath, probe, probeResult, resultPath }) {
  const scriptPath = path.join(hypHome, 'gateway-budget-run.mjs')
  const errPath = path.join(hypHome, 'gateway-budget-run.err')
  const daemonOpts = {
    hypHome,
    configPath,
    runId: 'daemon-heap-budget-knob-test',
    tickIntervalMs: 0,
    installSignalHandlers: false,
    processingExecArgv: ['--import', pathToFileURL(probe).href],
  }
  writeFileSync(scriptPath, [
    "import fs from 'node:fs'",
    "import { setTimeout as delay } from 'node:timers/promises'",
    `import { runGatewayDaemon } from ${JSON.stringify(GATEWAY_URL)}`,
    'const result = { childPid: null, bootError: null, probeSeen: false }',
    `const record = () => fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result))`,
    'let handle',
    'try {',
    `  handle = await runGatewayDaemon({ ...${JSON.stringify(daemonOpts)}, env: { ...process.env } })`,
    '  result.childPid = handle.snapshot().processes?.processing?.pid ?? null',
    '} catch (error) {',
    '  result.bootError = error instanceof Error ? error.message : String(error)',
    '}',
    // The probe writes as the child starts, so wait for the file rather than
    // for a duration.
    'for (let i = 0; i < 300 && !result.probeSeen; i++) {',
    `  result.probeSeen = fs.existsSync(${JSON.stringify(probeResult)})`,
    '  if (!result.probeSeen) await delay(100)',
    '}',
    // Recorded before the stop, so a stop that never returns still leaves the
    // caller the pids and the probe's verdict.
    'record()',
    // Whatever the test goes on to assert, no run of this file leaves a
    // gateway and its child behind on the machine.
    'if (handle) {',
    '  try {',
    '    await handle.stop()',
    '    await handle.done',
    '  } catch {}',
    '}',
    'process.exit(0)',
    '',
  ].join('\n'))

  // A file, never a pipe: a pipe is the one thing the forked child could still
  // be holding when its parent goes.
  const errFd = openSync(errPath, 'w')
  let run
  try {
    run = spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      // The service environment, which is what `launchctl setenv` and
      // `systemctl --user set-environment` give the started job.
      env: { ...process.env, HOME: hypHome, HYP_HOME: hypHome, [PROJECTION_KNOB]: String(SERVICE_MB) },
      stdio: ['ignore', 'ignore', errFd],
      timeout: 90_000,
    })
  } finally {
    closeSync(errFd)
  }
  const stderr = readFileSync(errPath, 'utf8')
  assert.equal(run.signal, null, `the gateway daemon never ended, so nothing was recorded: ${stderr}`)
  assert.equal(run.status, 0, stderr)
  assert.ok(existsSync(resultPath), `the daemon run recorded nothing: ${stderr}`)
  return JSON.parse(readFileSync(resultPath, 'utf8'))
}

test('the service environment carries the projection budget into the daemon process that runs projections', async () => {
  // Never set here: a value in the runner's own environment would prove
  // nothing about the daemon, and the child must get it from the service
  // environment alone.
  assert.equal(process.env[PROJECTION_KNOB], undefined, 'fixture invariant: the runner must not carry the knob')

  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-daemon-heap-knob-'))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  // No gateway plugin: this is about the half of the daemon that runs
  // background work, and a configured `listen` would bind a port.
  await fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false, plugins: [] }))
  const probeResult = path.join(hypHome, 'processing-budget.json')
  const probe = await writeProcessingProbe(hypHome, probeResult)

  const run = runGatewayOutsideTestRunner({
    hypHome,
    configPath,
    probe,
    probeResult,
    resultPath: path.join(hypHome, 'gateway-budget-run.json'),
  })
  assert.equal(run.bootError, null, 'fixture invariant: the gateway must boot')
  assert.ok(run.childPid, 'the daemon forked a processing child')
  assert.ok(run.probeSeen, 'the processing child reported its budget')

  const observed = JSON.parse(readFileSync(probeResult, 'utf8'))
  assert.equal(
    observed.pid,
    run.childPid,
    'the budget was read in the forked processing child, across the boundary background work runs behind'
  )
  assert.equal(observed.knob, String(SERVICE_MB), 'the service environment reached that child')
  assert.equal(
    observed.resolvedBytes,
    SERVICE_MB * 1024 * 1024,
    'and the projection resolver in that child returns the operator budget, not the default'
  )
})

/**
 * The document's `##` sections, in order, with their body text. Fenced code
 * blocks are skipped when looking for headings: a `#` comment inside one is
 * not a heading.
 *
 * @param {string} text
 * @returns {{ title: string, body: string }[]}
 */
function sections(text) {
  /** @type {{ title: string, body: string[] }[]} */
  const out = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced
    const heading = fenced ? null : /^## +(.*?)\s*$/.exec(line)
    if (heading) out.push({ title: heading[1], body: [] })
    else out.at(-1)?.body.push(line)
  }
  return out.map(s => ({ title: s.title, body: s.body.join('\n') }))
}

/**
 * What the document has to say, all of it in ONE section: an operator
 * following a partial procedure sets a variable that changes nothing.
 * Splitting these across sections passes none of them.
 *
 * Each default is read from the code that applies it, so a changed default
 * cannot leave the document quietly wrong. `resolveHeapBudgetBytes` reads the
 * query knob out of the environment, so the caller clears it first.
 *
 * @returns {{ what: string, holds: (body: string) => boolean }[]}
 */
function documentRequirements() {
  /** @type {[string, number][]} */
  const knobs = [
    [PROJECTION_KNOB, resolveProjectionMaxHeapBytes() / 1048576],
    [QUERY_KNOB, resolveHeapBudgetBytes(undefined) / 1048576],
  ]
  return [
    ...knobs.map(([knob, defaultMb]) => ({
      what: `names ${knob} with the default the code applies (${defaultMb})`,
      holds: (/** @type {string} */ body) =>
        body.split('\n').some(line => line.includes(knob) && line.includes(String(defaultMb))),
    })),
    // The procedure itself: the command that puts the value in the service
    // environment, on each platform the installers support, naming the knob
    // and giving it a value. Prose about `launchctl` with no command, or a
    // command that sets some other variable, is not a procedure.
    {
      what: `gives the launchd (macOS) command that sets ${PROJECTION_KNOB} in the service environment`,
      holds: (/** @type {string} */ body) =>
        new RegExp(`^\\s*launchctl setenv +${PROJECTION_KNOB} +\\S`, 'm').test(body),
    },
    {
      what: `gives the systemd (Linux) command that sets ${PROJECTION_KNOB} in the service environment`,
      holds: (/** @type {string} */ body) =>
        new RegExp(`^\\s*systemctl --user set-environment +${PROJECTION_KNOB}=\\S`, 'm').test(body),
    },
    // Without the restart the procedure silently does nothing: both mechanisms
    // apply only to processes started afterwards.
    {
      what: 'tells the operator to restart the daemon, which is what makes either setting take effect',
      holds: (/** @type {string} */ body) => /^\s*hyp daemon restart\s*$/m.test(body),
    },
  ]
}

test(`${DOC} carries the heap-budget knobs and the per-platform procedure for the installed daemon`, async () => {
  const text = await fs.readFile(path.join(REPO_ROOT, DOC), 'utf8')
  const prev = process.env[QUERY_KNOB]
  delete process.env[QUERY_KNOB]
  /** @type {{ what: string, holds: (body: string) => boolean }[]} */
  let required
  try {
    required = documentRequirements()
  } finally {
    if (prev === undefined) delete process.env[QUERY_KNOB]
    else process.env[QUERY_KNOB] = prev
  }

  const scored = sections(text).map(s => ({ title: s.title, missing: required.filter(r => !r.holds(s.body)) }))
  const complete = scored.filter(s => s.missing.length === 0)
  if (complete.length === 0) {
    // The closest section, so the failure says what to write and where,
    // rather than only that nothing matched.
    const closest = scored.reduce((best, s) => (s.missing.length < best.missing.length ? s : best), scored[0])
    assert.fail(
      `no single section of ${DOC} documents the heap budgets and how to set them for the installed daemon.\n` +
      `Closest section: "${closest?.title ?? '(none)'}", which still needs to be a section that:\n` +
      closest?.missing.map(r => `  - ${r.what}`).join('\n')
    )
  }
})

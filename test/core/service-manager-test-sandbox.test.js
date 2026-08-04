// @ts-check

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runServiceCommand } from '../../src/core/daemon/service_ops.js'

// The rule under test: a temp HOME does not sandbox launchd/systemd, so no
// test may let a real service-manager command run. Before #602 the two attach
// fixtures below dropped a marker under the REAL service label into a temp
// HOME and let `restartServiceDaemon` run, on the assumption that no
// `launchctl` / `systemctl` binary would be reachable. On a developer machine
// one is, and the command that ran was
// `launchctl kickstart -k gui/<uid>/com.hyperparam.hypaware`: the developer's
// own daemon, killed once per `npm test`.
//
// @ref LLP 0181#the-rule [tests]: no test reaches the host's service manager
// @ref LLP 0181#the-guard [tests]: the refusal sits at the single spawn seam

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The guard's home, as a specifier a script written to a temp dir can import. */
const SERVICE_OPS_URL = pathToFileURL(
  path.join(REPO_ROOT, 'src', 'core', 'daemon', 'service_ops.js')
).href

/**
 * The guard's opt-in, spelled out here rather than imported, so this file still
 * loads (and still fails) against a tree that has no guard yet.
 */
const ALLOW_REAL_SERVICE_MANAGER_ENV = 'HYP_ALLOW_REAL_SERVICE_MANAGER'

/**
 * The fixtures that put a real service label on disk and then drive daemon
 * code for real. Add to this list, do not remove from it.
 */
const REAL_LABEL_FIXTURES = [
  'test/core/attach-enable-resume.test.js',
  'test/core/attach-endpoint-fallback.test.js',
]

/** @param {(dir: string) => void} fn */
function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hyp-svc-sandbox-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Put executable `launchctl` and `systemctl` stubs on `PATH` that record every
 * invocation. This is what a developer machine looks like to `spawn`, and what
 * the CI container does not: it is the whole difference between the bug being
 * invisible here and destructive there.
 *
 * @param {string} dir
 * @returns {{ binDir: string, logPath: string, invocations(): string[] }}
 */
function recordingServiceManagers(dir) {
  const binDir = path.join(dir, 'bin')
  const logPath = path.join(dir, 'invocations.log')
  mkdirSync(binDir, { recursive: true })
  for (const name of ['launchctl', 'systemctl']) {
    const stub = path.join(binDir, name)
    writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> '${logPath}'\nexit 0\n`)
    chmodSync(stub, 0o755)
  }
  return {
    binDir,
    logPath,
    invocations() {
      if (!existsSync(logPath)) return []
      return readFileSync(logPath, 'utf8').split('\n').filter((line) => line.length > 0)
    },
  }
}

/**
 * Run `argv` with recording `launchctl` / `systemctl` stubs on `PATH`, and
 * report what it spawned and whether it passed.
 *
 * @param {string[]} argv
 * @returns {{ invocations: string[], status: number | null, output: string }}
 */
function runWithRecordedServiceManagers(argv) {
  /** @type {{ invocations: string[], status: number | null, output: string }} */
  let outcome = { invocations: [], status: null, output: '' }
  withTempDir((dir) => {
    const recorder = recordingServiceManagers(dir)
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, PATH: `${recorder.binDir}${path.delimiter}${process.env.PATH ?? ''}` }
    delete env[ALLOW_REAL_SERVICE_MANAGER_ENV]
    // Inherited from this process, `NODE_TEST_CONTEXT` would both pre-answer
    // the question under test and, for a `--test` child, make it decide it is
    // already inside a test file and skip every one it was handed ("run() is
    // being called recursively"): a clean pass having executed nothing.
    delete env.NODE_TEST_CONTEXT

    const run = spawnSync(process.execPath, argv, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
      timeout: 120_000,
    })
    outcome = {
      invocations: recorder.invocations(),
      status: run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
    }
  })
  return outcome
}

const SPAWNED_THE_HOST =
  'a fixture spawned the host service manager: a temp HOME does not sandbox launchd/systemd, ' +
  'so this command named the developer\'s own daemon (LLP 0181)'

test('the attach fixtures never reach a real service manager, even when one is on PATH', () => {
  const run = runWithRecordedServiceManagers(['--test', ...REAL_LABEL_FIXTURES])
  assert.deepEqual(run.invocations, [], SPAWNED_THE_HOST)
  // And the fixtures still pass with the service manager refused, so the
  // guard did not buy safety by breaking what they assert.
  assert.equal(run.status, 0, run.output)
})

// `node --test` sets `NODE_TEST_CONTEXT` only in the children it forks, so the
// two runs below reach the guard with it unset. Both are ordinary habits: one
// test file at a time while iterating, and the repo's own `npm test --
// --experimental-test-isolation=none`, which `scripts/run-tests.js` forwards
// verbatim. Before the predicate widened, each one ran
// `systemctl --user restart hypaware.service` for real.
test('running a fixture directly, with no --test, still reaches no service manager', () => {
  const run = runWithRecordedServiceManagers([REAL_LABEL_FIXTURES[0]])
  assert.deepEqual(run.invocations, [], SPAWNED_THE_HOST)
  assert.equal(run.status, 0, run.output)
})

test('running the fixtures without test isolation still reaches no service manager', () => {
  const run = runWithRecordedServiceManagers(
    ['--test', '--experimental-test-isolation=none', ...REAL_LABEL_FIXTURES]
  )
  assert.deepEqual(run.invocations, [], SPAWNED_THE_HOST)
  assert.equal(run.status, 0, run.output)
})

test('runServiceCommand refuses to spawn under the test runner', async () => {
  await assert.rejects(
    () => runServiceCommand('launchctl', ['kickstart', '-k', 'gui/501/com.hyperparam.hypaware']),
    (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.name, 'ServiceManagerSandboxError')
      assert.match(err.message, /a temp HOME does not sandbox launchd\/systemd/)
      // The refusal has to say how to get past it, or the next author guesses.
      assert.match(err.message, new RegExp(ALLOW_REAL_SERVICE_MANAGER_ENV))
      return true
    },
  )
})

test('the explicit opt-in still spawns', () => {
  withTempDir((dir) => {
    // In a child, not by setting the opt-in on this process's `env`: that
    // mutation is process-global, so under
    // `--experimental-test-isolation=none` it would disable the guard for
    // every other test sharing the process. The child is named `.test.js` and
    // run with no `--test`, so the guard is live in it (that is the shape the
    // predicate's last arm catches) and only the opt-in lets the spawn out.
    writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    const script = path.join(dir, 'opt-in.test.js')
    writeFileSync(script, [
      `import { runServiceCommand } from ${JSON.stringify(SERVICE_OPS_URL)}`,
      "const res = await runServiceCommand(process.execPath, ['-e', 'process.stdout.write(\"spawned\")'])",
      'process.stdout.write(JSON.stringify(res))',
      '',
    ].join('\n'))

    const run = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, [ALLOW_REAL_SERVICE_MANAGER_ENV]: '1' },
      timeout: 60_000,
    })

    assert.equal(run.status, 0, `${run.stdout ?? ''}${run.stderr ?? ''}`)
    assert.deepEqual(JSON.parse(run.stdout), { exitCode: 0, stdout: 'spawned', stderr: '' })
  })
})

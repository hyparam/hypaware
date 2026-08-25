#!/usr/bin/env node
// @ts-check

import process from 'node:process'

// The two leaf modules the palette needs, imported statically because they
// are pure - no observability, no HYP_HOME, nothing the `__smoke_internal`
// branch below is careful to load late. Everything else here stays a lazy
// dynamic import.
// @ref LLP 0189#choke-point [implements]: the entry's own diagnostics get the same colouring dispatch gives commands
import { ANSI, colorizeStderr, paint } from '../src/core/cli/style.js'
import { useColor } from '../src/core/cli/stdio.js'

const argv = process.argv.slice(2)

const stderr = colorizeStderr(process.stderr, process.env)
const color = useColor(process.stderr, process.env)

// `__smoke_internal <flow>` is the in-process entry the registered
// `smoke` command re-execs us with. It bypasses the dispatcher because
// each smoke owns its own observability lifecycle (DEV_RUN_ID,
// HYP_HOME, and exporters set up by the harness against a fresh
// tmpdir). Routing it through the dispatcher would lock the tracer to
// the parent process's HYP_HOME before the harness can change it.
//
// Users never type `__smoke_internal` directly. They run
// `hyp smoke <flow>`, which goes through the dispatcher and spawns us
// here with a clean process state.
if (argv[0] === '__smoke_internal') {
  const flow = argv[1]
  if (!flow) {
    stderr.write('usage: hyp smoke <flow-name>\n')
    process.exit(2)
  }
  try {
    const { runFlow } = await import('../hypaware-core/smoke/lib/harness.js')
    const harness = await runFlow(flow)
    process.stdout.write(`smoke ${flow}: ok (dev_run_id=${harness.devRunId})\n`)
    process.exit(0)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // `FAIL` is the verdict the eye looks for in a scrollback of smoke runs,
    // and it is not a prefix any severity rule recognizes, so paint it here.
    stderr.write(`smoke ${flow}: ${paint('FAIL', ANSI.red, color)}\n${message}\n`)
    const detail = err && /** @type {{ detail?: string }} */ (err).detail
    if (typeof detail === 'string') stderr.write(`  ${detail}\n`)
    process.exit(1)
  }
}

// The self-update check runs before dispatch (and so before any kernel
// import) for `daemon run` only: a release broken anywhere past this
// point still reaches the check on every service-manager relaunch, so a
// stuck machine jumps forward when a fixed version is published. When
// an update lands, exit through the restart code so the service manager
// relaunches onto the new code instead of booting the old.
// @ref LLP 0309#unstick-from-the-front [implements]: pre-boot lane; only the import-light updater loads before it runs
if (argv[0] === 'daemon' && argv[1] === 'run') {
  try {
    const { runSelfUpdatePass, SELF_UPDATE_RESTART_EXIT_CODE } =
      await import('../src/core/update/self_update.js')
    const result = await runSelfUpdatePass({
      // Routine skips (a dev checkout, auto_update off) stay silent
      // here; only events an operator would act on reach stderr.
      log: (event, fields) => {
        if (event === 'self_update.skipped') return
        try { stderr.write(`${event} ${JSON.stringify(fields ?? {})}\n`) } catch { /* stderr gone */ }
      },
    })
    if (result.action === 'updated') process.exit(SELF_UPDATE_RESTART_EXIT_CODE)
  } catch { /* the updater must never block a boot */ }
}

const { dispatch } = await import('../src/core/cli/dispatch.js')
const { installObservability } = await import('../src/core/observability/index.js')
const { flushStream } = await import('../src/core/cli/flush-streams.js')
const { installStreamErrorHandlers } = await import('../src/core/cli/stream_errors.js')

// Before anything writes: an asynchronous stdout/stderr failure (EPIPE when
// a reader like `head` walks away mid-write) is delivered as an 'error'
// event, which bypasses the try/catch below and every one inside the
// commands. Unlistened, it crashes a run that had already succeeded.
installStreamErrorHandlers([process.stdout, process.stderr], (message) => {
  try { stderr.write(message) } catch { /* the stream is what failed */ }
})

const obs = installObservability()
let exitCode = 1
try {
  exitCode = await dispatch(argv)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  stderr.write(`hyp: ${message}\n`)
  exitCode = 1
} finally {
  await obs.shutdown()
}

// Flush stdout/stderr before exiting: `process.exit()` is synchronous and
// would drop output still buffered in a pipe (the >64KiB truncation).
await Promise.all([flushStream(process.stdout), flushStream(process.stderr)])
process.exit(exitCode)

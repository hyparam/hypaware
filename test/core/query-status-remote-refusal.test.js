// @ts-check

// @ref LLP 0273#evidence [tests]: `hyp query status` reports the local
// cache, so `--remote` is refused rather than ignored. Recorded sessions
// show the silent-ignore failure mode is not theoretical: agents ran
// `hyp query status --remote prod` to "list datasets on the server", got a
// plausible server-shaped local inventory with a zero exit and nothing on
// stderr, and carried on treating it as the server's.

import test from 'node:test'
import assert from 'node:assert/strict'

import { runQueryStatus } from '../../src/core/commands/query.js'

function makeBuf() {
  return {
    value: '',
    /** @param {string} chunk */
    write(chunk) { this.value += String(chunk); return true },
  }
}

/**
 * `runQueryStatus` reaches `ctx.storage.cacheRoot`, `ctx.query.listDatasets()`,
 * and the two stream sinks. The refusal returns before any of the cache work,
 * so a bare cacheRoot that does not exist is enough for the rejection cases.
 */
function ctxFor() {
  const stdout = makeBuf()
  const stderr = makeBuf()
  return {
    stdout,
    stderr,
    ctx: /** @type {any} */ ({
      stdout,
      stderr,
      storage: { cacheRoot: '/nonexistent/hyp/cache' },
      config: { version: 2 },
      query: { listDatasets: () => [] },
      env: {},
      cwd: '/w/project',
    }),
  }
}

test('query status refuses --remote instead of reporting the local cache', async () => {
  const { stdout, stderr, ctx } = ctxFor()
  const code = await runQueryStatus(['--remote', 'prod'], ctx)

  assert.equal(code, 2, 'refusal is a usage error, not a success')
  assert.equal(stdout.value, '', 'no local inventory may be printed under --remote')
  assert.match(stderr.value, /--remote is not supported/)
  assert.match(stderr.value, /local cache/)
  // The refusal names the move that answers the question the caller asked.
  assert.match(stderr.value, /hyp query sql/)
})

test('query status refuses the --remote=<target> spelling too', async () => {
  const { stdout, stderr, ctx } = ctxFor()
  const code = await runQueryStatus(['--remote=hyperparam'], ctx)

  assert.equal(code, 2)
  assert.equal(stdout.value, '')
  assert.match(stderr.value, /--remote is not supported/)
})

test('query status refuses the bare --remote default-target sentinel', async () => {
  const { stdout, stderr, ctx } = ctxFor()
  const code = await runQueryStatus(['--remote'], ctx)

  assert.equal(code, 2)
  assert.equal(stdout.value, '')
  assert.match(stderr.value, /--remote is not supported/)
})

// A typo on the flag the skill docs now tell agents to avoid must not land
// on the answer the refusal exists to withhold: `status` takes no arguments,
// so anything it does not recognize fails loudly rather than printing a
// well-formed inventory of the wrong host.
for (const argv of [['--remot', 'prod'], ['-r', 'prod'], ['--format', 'json'], ['hyperparam']]) {
  test(`query status refuses the near miss \`${argv.join(' ')}\``, async () => {
    const { stdout, stderr, ctx } = ctxFor()
    const code = await runQueryStatus(argv, ctx)

    assert.equal(code, 2, 'an unrecognized argument is a usage error, not a local answer')
    assert.equal(stdout.value, '', 'no local inventory may be printed for an argument status does not take')
    assert.ok(stderr.value.includes(argv[0]), `refusal did not name ${argv[0]}: ${stderr.value}`)
    assert.match(stderr.value, /usage: hyp cache status/)
  })
}

test('query status renders usage for --help without touching the cache', async () => {
  const { stdout, stderr, ctx } = ctxFor()
  const code = await runQueryStatus(['--help'], ctx)

  assert.equal(code, 0)
  assert.match(stdout.value, /usage: hyp cache status/)
  assert.equal(stderr.value, '')
})

test('query status still runs with no args', async () => {
  const { stderr, ctx } = ctxFor()
  const code = await runQueryStatus([], ctx)

  assert.equal(code, 0)
  assert.doesNotMatch(stderr.value, /--remote/)
})

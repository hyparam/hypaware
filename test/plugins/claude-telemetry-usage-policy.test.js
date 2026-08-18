// @ts-check

/**
 * The folder usage policy on the OTEL ingest path: the check that runs before
 * a row exists, rather than the flush-time late drop the proxy path needs.
 *
 * Three outcomes are pinned here: an `ignore` cwd is dropped, a `local-only`
 * or `full` cwd is recorded (its withholding happens at the export and query
 * seams), and a session whose cwd nothing recorded is withheld rather than
 * treated as clean.
 *
 * @ref LLP 0254#policy-inline [tests]: the verdict is in hand before the write,
 *   so the LLP 0085 fail-open window has nothing to reopen
 * @ref LLP 0257#ingest [tests]: S10 - a session with no hook record is
 *   undetermined, not clean
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createUsagePolicyResolver,
  localOnlyListPath,
  writeLocalOnlyEntries,
} from '../../src/core/usage-policy/index.js'
import {
  POLICY_UNDETERMINED,
  partitionByUsagePolicy,
  resolveSessionUsagePolicy,
} from '../../hypaware-core/plugins-workspace/claude/src/telemetry/policy.js'

/**
 * @import { ClaudeTelemetryEvent, SessionContextRecord } from '../../hypaware-core/plugins-workspace/claude/src/types.js'
 */

/**
 * @param {string} name
 * @param {string | undefined} sessionId
 * @param {Record<string, unknown>} [attrs]
 * @returns {ClaudeTelemetryEvent}
 */
function event(name, sessionId, attrs = {}) {
  return {
    name,
    timestamp: '2026-08-17T20:30:24.450Z',
    attributes: {
      ...(sessionId === undefined ? {} : { 'session.id': sessionId }),
      ...attrs,
    },
  }
}

/**
 * @param {string} sessionId
 * @param {string | undefined} cwd
 * @returns {SessionContextRecord}
 */
function hookRecord(sessionId, cwd) {
  return {
    session_id: sessionId,
    transcript_path: undefined,
    cwd,
    git_branch: undefined,
    ts: '2026-08-17T20:30:00.000Z',
  }
}

/** @param {string} prefix */
function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-otel-policy-${prefix}-`))
}

/* ------------------------- resolveSessionUsagePolicy ------------------------ */

test('resolveSessionUsagePolicy: an ancestor .hypignore resolves the session to ignore', async () => {
  const root = await tmpDir('hypignore')
  try {
    const repo = path.join(root, 'secret-repo')
    await fs.mkdir(path.join(repo, 'sub'), { recursive: true })
    const governing = path.join(repo, '.hypignore')
    await fs.writeFile(governing, 'ignore\n')

    const verdict = resolveSessionUsagePolicy({
      record: hookRecord('s1', path.join(repo, 'sub')),
      resolver: createUsagePolicyResolver(),
    })
    assert.equal(verdict.class, 'ignore')
    assert.equal(verdict.governedBy, governing)
    assert.equal(verdict.cwd, path.join(repo, 'sub'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('resolveSessionUsagePolicy: the machine-local list governs a directory with no dotfile', async () => {
  const root = await tmpDir('machine-local')
  try {
    const stateDir = path.join(root, 'hypaware')
    const repo = path.join(root, 'private-repo')
    await fs.mkdir(repo, { recursive: true })
    // The list the picker and `hyp ignore --private` write: no `.hypignore`
    // exists anywhere near this directory, so a dotfile-only view would call
    // it `full`.
    await writeLocalOnlyEntries({ stateDir, entries: [{ dir: repo, class: 'ignore' }] })

    const resolver = createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(stateDir) })
    const verdict = resolveSessionUsagePolicy({ record: hookRecord('s1', repo), resolver })
    assert.equal(verdict.class, 'ignore')
    assert.equal(verdict.governedBy, localOnlyListPath(stateDir))

    // The same session, resolved by a resolver that was never told where the
    // list lives (the per-plugin state dir has no list file), reads clean.
    // That is the failure this wiring exists to prevent.
    const blind = createUsagePolicyResolver({
      localOnlyListPath: localOnlyListPath(path.join(stateDir, 'plugins', '@hypaware/claude')),
    })
    assert.equal(resolveSessionUsagePolicy({ record: hookRecord('s1', repo), resolver: blind }).class, 'full')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('resolveSessionUsagePolicy: no hook record, or a record with no cwd, is undetermined', () => {
  const resolver = createUsagePolicyResolver()
  assert.equal(resolveSessionUsagePolicy({ record: undefined, resolver }).class, POLICY_UNDETERMINED)
  assert.equal(
    resolveSessionUsagePolicy({ record: hookRecord('s1', undefined), resolver }).class,
    POLICY_UNDETERMINED
  )
})

test('resolveSessionUsagePolicy: local-only is not a drop', async () => {
  const root = await tmpDir('local-only')
  try {
    const repo = path.join(root, 'repo')
    await fs.mkdir(repo, { recursive: true })
    await fs.writeFile(path.join(repo, '.hypignore'), 'local-only\n')
    const verdict = resolveSessionUsagePolicy({
      record: hookRecord('s1', repo),
      resolver: createUsagePolicyResolver(),
    })
    assert.equal(verdict.class, 'local-only')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

/* --------------------------- partitionByUsagePolicy -------------------------- */

/** @param {Record<string, 'ignore' | 'local-only' | 'full' | 'undetermined'>} bySession */
function verdictTable(bySession) {
  /** @param {string} sessionId */
  return (sessionId) => {
    const cls = bySession[sessionId] ?? POLICY_UNDETERMINED
    return cls === POLICY_UNDETERMINED
      ? /** @type {const} */ ({ class: POLICY_UNDETERMINED })
      : { class: cls, cwd: `/w/${sessionId}`, governedBy: `/w/${sessionId}/.hypignore`, declared: cls }
  }
}

test('partitionByUsagePolicy: ignored sessions are dropped, everything else is kept', () => {
  const events = [
    event('user_prompt', 'ignored', { prompt: 'secret' }),
    event('api_request_body', 'ignored', { body_ref: '/spool/ignored.json' }),
    event('user_prompt', 'clean'),
    event('user_prompt', 'local'),
  ]
  const split = partitionByUsagePolicy(events, {
    verdictFor: verdictTable({ ignored: 'ignore', clean: 'full', local: 'local-only' }),
  })

  assert.deepEqual(split.kept.map((e) => e.attributes['session.id']), ['clean', 'local'])
  assert.deepEqual([...split.droppedBySession.keys()], ['ignored'])
  assert.equal(split.droppedBySession.get('ignored')?.events.length, 2)
  assert.equal(split.droppedBySession.get('ignored')?.verdict.class, 'ignore')
  assert.equal(split.withheldBySession.size, 0)
})

test('partitionByUsagePolicy: an undetermined session is withheld, not kept', () => {
  const split = partitionByUsagePolicy(
    [event('user_prompt', 'unknown'), event('api_request', 'unknown'), event('user_prompt', 'clean')],
    { verdictFor: verdictTable({ clean: 'full' }) }
  )

  assert.deepEqual(split.kept.map((e) => e.attributes['session.id']), ['clean'])
  assert.equal(split.droppedBySession.size, 0)
  assert.equal(split.withheldBySession.get('unknown')?.events.length, 2)
})

test('partitionByUsagePolicy: an event naming no session is kept', () => {
  const split = partitionByUsagePolicy([event('tool_decision', undefined)], {
    verdictFor: verdictTable({}),
  })
  assert.equal(split.kept.length, 1)
  assert.equal(split.withheldBySession.size, 0)
})

test('partitionByUsagePolicy: each session is resolved once per batch', () => {
  let calls = 0
  const split = partitionByUsagePolicy(
    [event('user_prompt', 's'), event('api_request', 's'), event('assistant_response', 's')],
    {
      verdictFor: (sessionId) => {
        calls += 1
        return verdictTable({ s: 'full' })(sessionId)
      },
    }
  )
  assert.equal(calls, 1)
  assert.equal(split.kept.length, 3)
})

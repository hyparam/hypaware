// @ts-check

import process from 'node:process'

import { Attr, runRoot } from '../../../src/core/observability/index.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'

/**
 * Shared fixtures and CLI plumbing for the paired GitHub smoke flows,
 * `github_local_capture` (the admitted half of the session-evidence
 * inventory) and `github_local_only_withhold` (the withheld half).
 *
 * The pair has to agree on the evidence it seeds and the network it fakes,
 * or the two halves stop testing the same inventory, and a per-flow copy
 * drifts in the direction that keeps passing: add a column to
 * `AI_GATEWAY_SCHEMA_COLUMNS` and only the copy that gets updated tests the
 * current row shape.
 */

/**
 * One `ai_gateway_messages` row of local agent evidence, the only thing that
 * puts a repository in front of the GitHub source. `id` names the session and
 * derives the message and part ids from it, so a flow seeding two rows only
 * has to keep the two ids distinct.
 *
 * @param {{ gatewayId: string, id: string, cwd: string, remote: string }} args
 * @returns {Record<string, unknown>}
 */
export function githubSessionRow({ gatewayId, id, cwd, remote }) {
  const ts = '2026-09-02T12:00:00.000Z'
  return {
    gateway_id: gatewayId,
    schema_version: 1,
    session_id: id,
    conversation_id: id,
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
    message_id: `${id}-message`,
    message_index: 0,
    role: 'user',
    part_type: 'text',
    part_index: 0,
    part_id: `${id}-message#0`,
    content_text: 'test fixture',
    date: '2026-09-02',
  }
}

/**
 * The guard for a flow that withholds no repository: it admits everything its
 * evidence names, so there is nothing to refuse at the network seam. Named,
 * rather than an inline `() => {}`, so a call site tells a flow with nothing
 * to withhold apart from one that lost its guard.
 */
export function noWithheldRepo() {}

/**
 * A deterministic stand-in for the GitHub network client: one open issue on
 * every repository the source asks about, and nothing else.
 *
 * `listViewerRepos` throws because a session-evidence inventory reaching for
 * the viewer's repository list is the failure the pair exists to catch.
 *
 * `assertRepo` is the caller's own guard, so a flow proving a repository is
 * withheld fails at the network seam rather than only in a row count. It runs
 * on every read that names a repository, which is every `GithubClient` method
 * but `listViewerRepos`: guarding only the reads this fixture's pages happen
 * to lead to would leave the seam open on the rest, and `github sync` already
 * calls `listIssueCommentsPage` on every repository it captures.
 *
 * It is required because an omitted guard is lost silently: the seam stops
 * being tested and every other assertion in the flow still passes (issue
 * #1327). A flow with nothing to withhold passes `noWithheldRepo`.
 *
 * @param {{ assertRepo: (owner: string, name: string) => void }} args
 */
export function fakeGithubClient(args) {
  const assertRepo = args?.assertRepo
  if (typeof assertRepo !== 'function') {
    throw new TypeError(
      "fakeGithubClient: assertRepo is required - pass the flow's guard, or noWithheldRepo when the flow withholds no repository"
    )
  }
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
    async listPullRequestFilesPage(owner, name) { assertRepo(owner, name); return { items: [], next: null } },
    async listPullRequestReviewsPage(owner, name) { assertRepo(owner, name); return { items: [], next: null } },
    async listPullRequestCommitsPage(owner, name) { assertRepo(owner, name); return { items: [], next: null } },
    async listCommitsPage(owner, name) { assertRepo(owner, name); return { items: [], next: null } },
    async listCommitFilesPage(owner, name) { assertRepo(owner, name); return { items: [], next: null } },
    async listIssueCommentsPage(owner, name) { assertRepo(owner, name); return { items: [], next: null } },
  }
}

/**
 * Run one CLI command against a kernel lifetime and capture its streams.
 *
 * @param {string[]} argv
 * @param {{ kernel: any, registry: any }} lifetime
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function dispatchText(argv, { kernel, registry }) {
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

/**
 * Run a `select count(*) as n ...` query through the CLI and return the count.
 * Reads with `--include-local-only`, so it counts what is on disk rather than
 * what the caller's query-visibility stance would serve.
 *
 * @param {string} sql
 * @param {{ kernel: any, registry: any }} lifetime
 * @returns {Promise<number>}
 */
export async function sqlCount(sql, lifetime) {
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

/**
 * Build the flow's `step(name, fn)` helper: one root span per smoke step,
 * carrying the harness identity every log-driven smoke is expected to stamp.
 *
 * @param {{ smokeName: string, devRunId: string }} harness
 * @returns {(smokeStep: string, fn: () => Promise<any>) => Promise<any>}
 */
export function makeStep(harness) {
  return function step(smokeStep, fn) {
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

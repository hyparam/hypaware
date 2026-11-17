import assert from 'node:assert/strict'
import test from 'node:test'
import { discover, renderPreview, selectCandidates } from '../../.github/hypaware-pr-context/discovery.mjs'

import { describe, readMessages, renderDraft, updateBody, codeChanges } from '../../.github/hypaware-pr-context/describe.mjs'

const pr = { title: 'Widget sync', headRefName: 'work/widget', isCrossRepository: false, createdAt: '2026-08-25T05:00:00Z', closedAt: '2026-08-25T22:00:00Z' }
function turn(id, role, minute, hints = {}) {
  return { session_id: 'session', message_id: id, role, message_created_at: `2026-08-25T10:${String(minute).padStart(2, '0')}:00Z`,
    date: '2026-08-25', choice_hint: 0, proposal_hint: 0, ...hints }
}

test('pairs a short choice with an earlier options message across an intervening turn', () => {
  const request = turn('request', 'user', 0)
  const options = turn('options', 'assistant', 1, { proposal_hint: 1 })
  const filler = turn('filler', 'assistant', 2)
  const choice = turn('choice', 'user', 3, { choice_hint: 1 })
  const follow = turn('follow', 'assistant', 4)
  const selected = selectCandidates([request, options, filler, choice, { ...choice }, follow])
  assert.deepEqual(selected.map(c => c.turn.message_id), ['request', 'options', 'choice', 'follow'])
})

test('rejects fork branches before querying organization data', async () => {
  await assert.rejects(discover({ ...pr, isCrossRepository: true }, 'org/repo', assert.fail), /same-repository/)
})

test('scope includes pre-branch request and renders capped searches and empty sessions explicitly', async () => {
  const seed = turn('start', 'user', 0)
  const window = [seed, ...Array.from({ length: 80 }, (_, i) => turn('other-' + i, 'assistant', 1))]
  const responses = [[{ session_id: 'x' }, { session_id: 'y' }], [], [seed], window]
  const queries = []
  const result = await discover({ ...pr, headRefName: "dev/o'brien" }, 'org/repo', async sql => {
    queries.push(sql)
    return responses.shift()
  })
  assert.equal(queries.length, 4)
  assert.match(queries[0], /git_branch = 'dev\/o''brien'/)
  for (const sql of queries) {
    assert.match(sql, /date between '2026-08-23' and '2026-08-25'/)
    assert.match(sql, /lower\(git_remote\) in/)
  }
  assert.doesNotMatch(queries[1], /git_branch/)
  const preview = renderPreview(123, result)
  assert.match(preview, /No matching request/)
  assert.match(preview, /row limit reached/)
  assert.match(preview, /sessions\/session\?m=start&d=2026-08-25/)
})

test('only validated link structure and static labels reach the summary', () => {
  const message = turn('id) raw text &', 'user', 0, { session_id: 'a)b', content_text: 'private excerpt' })
  const preview = renderPreview(10, { from: message.date, to: message.date, sessions: [{ count: 1, candidates: selectCandidates([message]) }] })
  assert.match(preview, /a%29b\?m=id%29\+raw\+text\+%26/)
  assert.doesNotMatch(preview, /private excerpt/)
})

const apiPR = {
  title: 'Widget sync', head: { sha: 'head', repo: { full_name: 'contributor/project' }, ref: 'widget' },
  base: { sha: 'base', repo: { full_name: 'team/project' } }, body: 'Author text\r\n',
  state: 'open', created_at: new Date().toISOString(), changed_files: 1,
}
const patchFile = { filename: 'widget.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }

test('updates a fork PR using its own sources and the latest author text, once per distinct result', async () => {
  const request = turn('request', 'user', 0)
  const options = turn('options', 'assistant', 1, { proposal_hint: 1 })
  const reply = turn('reply', 'user', 2, { choice_hint: 1 })
  const turns = [request, options, reply]
  let body = apiPR.body
  let reads = 0
  let writes = 0
  const github = async (path, method, payload) => {
    if (method === 'PATCH') {
      body = payload.body
      writes++
      return { body }
    }
    if (path) return [patchFile]
    if (++reads === 2) body += 'Edited while the model ran.\n'
    return { ...apiPR, body }
  }
  const query = async sql => {
    assert.match(sql, /contributor\/project/)
    assert.doesNotMatch(sql, /team\/project/)
    if (sql.includes('select distinct session_id')) return [{ session_id: 'session' }]
    if (sql.includes('select message_id, message_created_at')) return [request]
    if (sql.includes('choice_hint')) return turns
    return turns.map(t => ({ ...t, part_index: 0, chars: t.message_id.length, text_part: t.message_id }))
  }
  const draft = async (title, messages, patches) => {
    assert.deepEqual(messages.map(m => m.text), ['request', 'options', 'reply'])
    assert.equal(title, apiPR.title)
    assert.equal(patches[0].patch, patchFile.patch)
    return { why: { text: 'Keep widgets in sync.', sources: ['M1'] }, decisions: [
      { label: 'Reuse the timer', text: 'The developer chose the existing timer.', sources: ['M2', 'M3'] },
    ] }
  }
  await describe(apiPR, { github, query, draft })
  await describe(apiPR, { github, query, draft })
  assert.equal(writes, 1)
  assert.match(body, /Agent message 2.*Developer message 3/)
  assert.equal(updateBody(body, ''), 'Author text\r\nEdited while the model ran.\n')
})

test('leaves a new PR untouched without evidence, removes stale generated context, ignores stale revisions', async () => {
  let body = apiPR.body
  let writes = 0
  const github = async (path, method, payload) => {
    assert.equal(path, '')
    if (method === 'PATCH') {
      body = payload.body
      writes++
    }
    return { ...apiPR, body }
  }
  const deps = { github, query: async () => [], draft: assert.fail }
  await describe(apiPR, deps)
  assert.equal(writes, 0)
  body = updateBody(body, 'stale')
  await describe(apiPR, deps)
  assert.equal(writes, 1)
  assert.equal(body, apiPR.body)
  await describe({ ...apiPR, head: { ...apiPR.head, sha: 'old' } }, { ...deps, query: assert.fail })
  assert.equal(writes, 1)
})

test('stops on incomplete patches, conversation parts, unknown citations, and ambiguous body markers', async () => {
  assert.throws(() => codeChanges([{ ...patchFile, additions: 2 }], 1), /incomplete patch/)
  const edited = updateBody('Author text', 'draft').replaceAll('\n', '\r\n')
  assert.equal(updateBody(edited, ''), 'Author text')
  assert.throws(() => updateBody('author\n<!-- hypaware-pr-context:start -->', 'new'), /misplaced/)
  assert.throws(() => renderDraft({ why: { text: 'Widget context', sources: ['M9'] }, decisions: [] }, []), /citation/)
  const request = turn('request', 'user', 0)
  const session = { candidates: [{ turn: request }] }
  await assert.rejects(readMessages({ sessions: [session] }, 'team/project', async () =>
    [{ ...request, part_index: 0, text_part: 'short', chars: 99 }]), /incomplete/)
})

test('recovers a detached worktree only from one exact branch push just before opening', async () => {
  const queries = []
  const request = turn('request', 'user', 0)
  const clarification = turn('clarification', 'user', 1, { topic_hint: 1 })
  const replies = [[], [{ session_id: 'pusher' }], [request], [request, clarification]]
  const result = await discover({ ...pr, headRefName: 'fix/v1.2' }, 'org/repo', async sql => {
    queries.push(sql)
    return replies.shift()
  })
  assert.match(queries[1], /2026-08-25T04:00:00.000Z/)
  assert.match(queries[1], /tool_name in/)
  assert.match(queries[1], /fix\/v1\[\.\]2/)
  assert.match(queries[1], /limit 2/)
  assert.match(queries[2], /claude\.origin\.kind/)
  assert.match(queries[2], /lower\(trim\(content_text\)\) not like '\{%'/)
  assert.deepEqual(result.sessions[0].candidates.map(c => c.turn.message_id), ['request', 'clarification'])

  const ambiguous = [[], [{ session_id: 'one' }, { session_id: 'two' }]]
  const missed = await discover(pr, 'org/repo', async () => ambiguous.shift())
  assert.equal(missed.sessions.length, 0)
})

test('a numbered design title searches the subject words', async () => {
  const queries = []
  const replies = [[{ session_id: 'session' }], []]
  await discover({ ...pr, title: 'LLP 1000-1001: widget sync' }, 'org/repo', async sql => {
    queries.push(sql)
    return replies.shift()
  })
  assert.match(queries[1], /like '%widget%'/)
  assert.doesNotMatch(queries[1], /like '%1000-1001%'/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hash, originalBody, prependContext, sourceLink, evidenceQuery, verifiedEvidence, renderSection, publicEvidence, main } from './run.mjs'

const manifest = JSON.parse(await readFile(new URL('./evidence.json', import.meta.url), 'utf8'))
const rows = manifest.provenance.map(record => ({ ...record }))
const commentBody = 'Decisions on the two blockers:\n\n' + manifest.sources.find(source => source.id === 'S1').reviewed_text + '\n\n' + manifest.sources.find(source => source.id === 'S5').reviewed_text
assert.equal(hash(commentBody), manifest.comment_body_sha256)
const result = { why: { text: 'Unattended installs can stay broken unless they update before startup.', sources: ['S0'] }, claims: [
  { text: '**Respect the off switch.** Read it before the first successful startup.', sources: ['S1'] },
  { text: '**Update before startup.** A broken release can still fetch its fix.', sources: ['S0', 'S3'] },
  { text: '**Update the existing install.** Keep the accepted lock and restart ordering.', sources: ['S2', 'S5'] }
] }
const section = renderSection(result, manifest, 'https://github.com/hyparam/hypaware/actions/runs/1', 'https://github.com/hyparam/hypaware/blob/example/.github/pr-decision-demo/evidence.json')
const START = '<!-- hypaware-decision-demo:start -->'
const END = '<!-- hypaware-decision-demo:end -->'

test('only the captured public PR and maintainer comment identities are admitted', () => {
  assert.deepEqual(verifiedEvidence(manifest, rows), rows)
  for (const key of ['event_id', 'event_type', 'repo', 'actor_login', 'number', 'created_at']) {
    assert.throws(() => verifiedEvidence(manifest, [{ ...rows[0], [key]: 'other' }, ...rows.slice(1)]), /unapproved_evidence/)
  }
  assert.throws(() => verifiedEvidence(manifest, rows.slice(1)), /evidence_count/)
  assert.throws(() => verifiedEvidence(manifest, [rows[0], rows[0]]), /unapproved_evidence/)
})

test('header reruns and legacy footer migration preserve authored bytes', () => {
  for (const body of ['', 'Human description', 'Human description\n', '\nHuman description\n\n']) {
    const top = prependContext(body, section)
    assert.equal(originalBody(top), body)
    assert.equal(prependContext(top, section), top)
    assert.equal(top.split('### Original PR description').length, 2)
    if (body) {
      const oldHeader = `${START}\nOld context\n${END}\n\n${body}`
      assert.equal(prependContext(oldHeader, section), top)
      const footer = `${body}\n\n${section}`
      assert.equal(originalBody(footer), body)
      assert.equal(prependContext(footer, section), top)
    }
  }
})

test('ambiguous or malformed markers are rejected without dropping authored text', () => {
  for (const body of [END, START, END + START, START + START + END, START + END + END, START + END + 'later human text', 'before\n\n' + section + '\n\nafter', 'before' + section]) {
    assert.throws(() => originalBody(body))
  }
})

test('source links go directly to public design notes and the maintainer comment', () => {
  assert.equal(sourceLink(manifest, manifest.sources[1]), 'https://github.com/hyparam/hypaware/pull/1013#issuecomment-5415876485')
  for (const url of ['https://example.com/source', 'https://github.com/hyparam/other/pull/1013', 'https://github.com/hyparam/hypaware/<script>']) {
    assert.throws(() => sourceLink(manifest, { url }), /invalid_source_url/)
  }
})

test('the HypAware query reads only two public GitHub metadata records', () => {
  const sql = evidenceQuery(manifest)
  assert.match(sql, /FROM github_events/)
  assert.equal(/ai_gateway_messages|content_text|tool_args|payload/.test(sql), false)
  for (const record of manifest.provenance) assert.ok(sql.includes(record.event_id))
  assert.match(sql, /created_at >= '2026-08-25T05:47:06.000Z'/)
  assert.match(sql, /LIMIT 3$/)
  assert.match(evidenceQuery({ ...manifest, repository: "repo'quote" }), /repo''quote/)
  assert.throws(() => evidenceQuery({ ...manifest, provenance: [] }), /invalid_evidence_count/)
  assert.throws(() => evidenceQuery({ ...manifest, provenance: [{ ...rows[0], created_at: "2026-08-25' OR 1=1" }] }), /invalid_evidence_date/)
  assert.throws(() => evidenceQuery({ ...manifest, pr_number: '1013 OR 1=1' }), /invalid_pr_number/)
})

test('why comes first, cites the initiating request, and every source is clickable', () => {
  assert.ok(section.indexOf('**Why this PR exists.**') < section.indexOf('- **Respect the off switch.**'))
  for (const id of ['S0', 'S1', 'S2', 'S3', 'S5']) {
    const source = manifest.sources.find(item => item.id === id)
    assert.ok(section.includes(`[${id}](${sourceLink(manifest, source)})`))
    assert.ok(section.includes(`[${id} · ${source.title}](${sourceLink(manifest, source)})`))
  }
  assert.ok(section.includes("Public design notes and Kenny's PR comment"))
  assert.ok(section.includes('[Selected excerpts](https://github.com/'))
  assert.throws(() => renderSection({ ...result, why: { text: 'No origin evidence', sources: ['S3'] } }, manifest, 'run', 'evidence'), /missing_origin_citation/)
  assert.throws(() => renderSection({ ...result, claims: result.claims.map(claim => ({ ...claim, sources: ['S0'] })) }, manifest, 'run', 'evidence'), /missing_maintainer_citation/)
})

test('why and decision claims both require known citations and safe bounded text', () => {
  for (const claim of [undefined, { text: 'Why', sources: [] }, { text: 'Why', sources: ['invented'] }, { text: '<!-- marker -->', sources: ['S0'] }, { text: 'a'.repeat(1001), sources: ['S0'] }, { text: '', sources: ['S0'] }]) {
    assert.throws(() => renderSection({ ...result, why: claim }, manifest, 'run', 'evidence'))
    assert.throws(() => renderSection({ ...result, claims: [claim, result.claims[1]] }, manifest, 'run', 'evidence'))
  }
  for (const claims of [[], [result.claims[0]], Array(4).fill(result.claims[0])]) assert.throws(() => renderSection({ ...result, claims }, manifest, 'run', 'evidence'), /invalid_claim_count/)
})

test('short prose and labels are enforced before rendering', () => {
  assert.throws(() => renderSection({ ...result, why: { text: Array(46).fill('word').join(' '), sources: ['S0'] } }, manifest, 'run', 'evidence'), /text_too_long/)
  const long = { text: '**Short label.** ' + Array(29).fill('word').join(' '), sources: ['S1'] }
  assert.throws(() => renderSection({ ...result, claims: [long, result.claims[1]] }, manifest, 'run', 'evidence'), /text_too_long/)
  assert.throws(() => renderSection({ ...result, claims: [{ text: 'A bullet without a label.', sources: ['S1'] }, result.claims[1]] }, manifest, 'run', 'evidence'), /missing_short_label/)
  const atLimit = { text: '**Short label.** ' + Array(28).fill('word').join(' '), sources: ['S1'] }
  assert.throws(() => renderSection({ why: { text: Array(45).fill('word').join(' '), sources: ['S0'] }, claims: [atLimit, atLimit, atLimit] }, manifest, 'run', 'evidence'), /section_too_long/)
})

test('the generated section ends with a visible original-description boundary', () => {
  assert.ok(section.endsWith(`\n---\n\n### Original PR description\n${END}`))
  assert.equal(/Drafted after merge|Retrospective context|shortened for clarity/.test(section), false)
  const authored = 'The original text\n\n'
  const body = prependContext(authored, section)
  assert.equal(originalBody(body), authored)
  assert.ok(body.endsWith(`${END}\n\n${authored}`))
})

test('complete action fetches reviewed evidence once and replaces the header after one inference', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'hyp-pr-demo-test-'))
  const authored = 'Human description\n\n'
  const before = prependContext(authored, section)
  const fixture = { ...manifest, original_body_sha256: hash(authored) }
  let body = before
  let writes = 0
  let modelCalls = 0
  let evidenceCalls = 0
  let hidePublicExcerpt = false
  let commentFault = null
  const publicCalls = new Map()
  const env = { GITHUB_REPOSITORY: manifest.repository, GITHUB_RUN_ID: 'fixture', GITHUB_SHA: 'b'.repeat(40), GITHUB_TOKEN: 'test-github', HYP_PR_DEMO_QUERY_TOKEN: 'test-query', HYP_PR_DEMO_OPENAI_KEY: 'test-model', RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: join(temp, 'summary.md') }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value
    await rm(temp, { recursive: true, force: true })
  })
  const json = data => Response.json(data)
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    assert.equal(options.redirect, 'error')
    if (url === `https://raw.githubusercontent.com/${manifest.repository}/${manifest.head_sha}/llp/0309-kernel-auto-update.decision.md`) {
      assert.equal(options.headers?.authorization, undefined)
      publicCalls.set(url, (publicCalls.get(url) || 0) + 1)
      return new Response(manifest.sources.filter(source => source.format === 'text' && (!hidePublicExcerpt || source.id !== 'S0')).map(source => source.reviewed_text).join('\n\n'))
    }
    if (url === `https://api.github.com/repos/${manifest.repository}/issues/comments/${manifest.comment_id}`) {
      assert.equal(options.headers?.authorization, undefined)
      publicCalls.set(url, (publicCalls.get(url) || 0) + 1)
      return json({ id: manifest.comment_id, user: { login: commentFault === 'author' ? 'other' : manifest.comment_author }, body: commentFault === 'body' ? 'Edited later' : commentBody, issue_url: `https://api.github.com/repos/${manifest.repository}/issues/${commentFault === 'pr' ? 1 : manifest.pr_number}`, html_url: manifest.sources[1].url })
    }
    if (url === 'https://api.hypaware.ai/v1/mcp') {
      const rpc = JSON.parse(options.body)
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (rpc.method === 'initialize') return json({ jsonrpc: '2.0', id: rpc.id, result: {} })
      assert.equal(rpc.method, 'tools/call')
      assert.equal(rpc.params.name, 'query_sql')
      assert.equal(rpc.params.arguments.sql, evidenceQuery(fixture))
      evidenceCalls++
      return json({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { rows, truncated: false } } })
    }
    if (url === 'https://api.openai.com/v1/responses') {
      modelCalls++
      const request = JSON.parse(options.body)
      const input = JSON.parse(request.input)
      assert.equal(input.description, authored)
      assert.equal(input.evidence.length, 6)
      assert.deepEqual(request.text.format.schema.required, ['why', 'claims'])
      return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }], usage: { input_tokens: 100, output_tokens: 100 } })
    }
    const api = `https://api.github.com/repos/${manifest.repository}/pulls/${manifest.pr_number}`
    if (url === `${api}/files?per_page=100`) return json([{ filename: 'example.js', patch: '+example' }])
    assert.equal(url, api)
    if (options.method === 'PATCH') {
      writes++
      body = JSON.parse(options.body).body
    }
    return json({ head: { sha: manifest.head_sha }, body, changed_files: 1, title: 'Example', html_url: `https://github.com/${manifest.repository}/pull/${manifest.pr_number}` })
  })
  await main(fixture)
  assert.equal(evidenceCalls, 1)
  assert.equal(modelCalls, 1)
  assert.equal(writes, 1)
  assert.equal(publicCalls.size, 2)
  assert.ok([...publicCalls.values()].every(count => count === 1))
  assert.ok(body.startsWith(START))
  assert.equal(body.split(START).length, 2)
  assert.equal(originalBody(body), authored)
  assert.equal(await readFile(join(temp, 'pr-context-before.md'), 'utf8'), before)
  assert.equal(await readFile(join(temp, 'pr-context-after.md'), 'utf8'), body)
  assert.match(await readFile(env.GITHUB_STEP_SUMMARY, 'utf8'), /Generated section at the top/)
  await main(fixture, { provenanceRows: rows, sourceUrl: 'https://github.com/hyparam/hypaware/pull/2994' })
  assert.equal(evidenceCalls, 1)
  assert.equal(modelCalls, 2)
  assert.equal(writes, 2)
  assert.match(body, /\[Action source\]/)
  assert.equal(body.includes('[Action run]'), false)
  assert.equal(originalBody(body), authored)
  hidePublicExcerpt = true
  await assert.rejects(() => main(fixture), /evidence_not_already_public/)
  assert.equal(modelCalls, 2)
  assert.equal(writes, 2)
  hidePublicExcerpt = false
  for (const fault of ['author', 'pr', 'body']) {
    commentFault = fault
    await assert.rejects(() => main(fixture), /public_comment_identity_mismatch|public_comment_changed/)
  }
  assert.equal(modelCalls, 2)
  assert.equal(writes, 2)
})

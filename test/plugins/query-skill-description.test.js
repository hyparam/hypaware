// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Routing-surface tests for the `hypaware-query` skill frontmatter.
 *
 * A skill is only reachable if its `description` reads as trigger vocabulary
 * for what users actually type. Issue #396 recorded a session where ordinary
 * session-search language ("find my most recent Claude session") never
 * selected the skill, and only an explicit "Use HypAware" did. Skill routing
 * is model-mediated, so these tests cannot prove the routing works; they pin
 * the two things that ARE deterministic:
 *
 *   1. both client copies carry byte-identical frontmatter (no drift), and
 *   2. the description names the natural session-search intents alongside the
 *      original product vocabulary.
 */

const WORKSPACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hypaware-core/plugins-workspace'
)

const CLIENTS = ['claude', 'codex']

/**
 * Read the `key: value` frontmatter block of a SKILL.md. Deliberately tiny:
 * the frontmatter these skills use is flat single-line scalars, and the repo
 * has no YAML dependency.
 *
 * @param {string} client
 * @returns {Record<string, string>}
 */
function readFrontmatter(client) {
  const file = path.join(WORKSPACE, client, 'skills/hypaware-query/SKILL.md')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  assert.equal(lines[0], '---', `${file}: expected frontmatter to open on line 1`)
  const end = lines.indexOf('---', 1)
  assert.ok(end > 0, `${file}: unterminated frontmatter`)
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(': ')
    // Skip non-scalar lines (block/list values, folded scalars) instead of
    // asserting on them: this test only makes claims about the flat keys it
    // actually reads, not about the shape of the whole frontmatter block.
    if (at <= 0) continue
    out[line.slice(0, at)] = line.slice(at + 2)
  }
  return out
}

test('hypaware-query frontmatter is identical across both client copies', () => {
  const [claude, codex] = CLIENTS.map(readFrontmatter)
  assert.deepEqual(claude, codex)
  assert.equal(claude.name, 'hypaware-query')
})

test('hypaware-query description names the natural session-search intents', () => {
  // The intents from issue #396, as substrings a user would plausibly type.
  // Matched case-insensitively on intent words, not on any exact sentence, so
  // the description can be reworded without the test dictating its prose.
  /** @type {[string, RegExp][]} */
  const intents = [
    ['a recent session', /most recent|last (claude|codex)/],
    ['sessions as the subject', /session/],
    ['searching recorded conversations', /search/],
    ['conversation history', /conversation/],
    ['tools used in a past session', /tool/],
    ['errors from a past session', /error/],
    ['both clients by name', /claude/],
    ['both clients by name', /codex/],
  ]
  for (const client of CLIENTS) {
    const description = readFrontmatter(client).description.toLowerCase()
    for (const [intent, pattern] of intents) {
      assert.match(description, pattern, `${client}: description does not cover ${intent}`)
    }
  }
})

test('hypaware-query description keeps its original product vocabulary', () => {
  // Widening the routing surface must not drop the SQL/telemetry triggers the
  // description already carried.
  const kept = [/hyp query/, /logs/, /traces/, /metrics/, /ai gateway/, /cache/, /sql/]
  for (const client of CLIENTS) {
    const description = readFrontmatter(client).description.toLowerCase()
    for (const pattern of kept) {
      assert.match(description, pattern, `${client}: description dropped ${pattern}`)
    }
  }
})

test('hypaware-query description stays a single-line scalar within budget', () => {
  for (const client of CLIENTS) {
    const description = readFrontmatter(client).description
    assert.doesNotMatch(description, /\n/)
    // 1024 is the documented Agent Skills maximum for the description field.
    // Claude Code's filesystem loader does not enforce it (this repo ships a
    // 1091-char description in hypaware-ai-usage-report); what it does instead
    // is truncate the combined skill-listing entry at ~1,536 chars by default,
    // configurable via skillListingMaxDescChars. Two different surfaces, both
    // real. We hold to 1024 to stay spec-portable rather than relying on one
    // loader's leniency.
    assert.ok(
      description.length <= 1024,
      `${client}: description is ${description.length} chars, over the 1024-char Agent Skills description maximum`
    )
    // Repo style: no em dashes anywhere, including shipped strings.
    assert.doesNotMatch(description, /\u2014/)
  }
})

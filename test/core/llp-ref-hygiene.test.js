// @ts-check

// The cheap correctness gate LLP 0001 asked for: grep `@ref`, resolve the LLP
// number and the `#anchor`, and fail the suite when the corpus and the
// annotations disagree. The `/ref-check` skill drives the interactive workflow;
// this file is the part that has to hold on every push.
//
// @ref LLP 0001#tooling [implements]: the minimal extractor plus resolver, wired into `npm test`
// @ref LLP 0001#conventions-adopted-spec-faithful [tests]: the spelling is `@ref LLP NNNN#anchor: gloss`, so a gloss separated by anything else is a defect

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LLP_DIR = path.join(REPO_ROOT, 'llp')

/** Text file types that can legitimately carry an annotation. */
const SCANNED_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.md', '.json', '.txt', '.yml', '.yaml', '.css', '.html',
])

// Spelled as an escape so the file that forbids the character does not contain it.
const EM_DASH = '\u2014'

/**
 * Matches the structured prefix of an annotation: `LLP NNNN` or a `*.md` path,
 * plus an optional `#anchor`. Anchors in this corpus are slugs, so the character
 * class deliberately stops before the `:` that opens the gloss.
 */
const REF_PATTERN = /@ref\s+(?:LLP\s+(\d{1,4})|([\w./-]+\.md))(#[A-Za-z0-9_-]+)?/g

// Illustrative annotations inside the LLP tooling's own documentation cite
// deliberately fictional targets: correct as documentation, wrong as data, which
// is why they are marked rather than repointed at a real section or deleted.
const IGNORE_LINE = 'ref-check:ignore'
const IGNORE_START = 'ref-check:ignore-start'
const IGNORE_END = 'ref-check:ignore-end'

/**
 * Broken references this test tolerates because a held pull request already owns
 * them: PR #461 (issue #457) names the `cli` and `reporting` anchors in LLP 0103
 * and rewraps the LLP 0135 line that split `#interactive-walkthrough` across a
 * line break. Entries are tolerated, never required, so pruning them once #461
 * lands is a cleanup and not a failure.
 */
const TOLERATED_BROKEN = new Set([
  'llp/0111-hyp-policy-verb.design.md:21',
  'llp/0111-hyp-policy-verb.design.md:247',
  'llp/0112-hyp-policy-verb.plan.md:42',
  'llp/0112-hyp-policy-verb.plan.md:43',
  'llp/0135-install-experience-overhaul.design.md:959',
  'src/core/commands/clients.js:710',
  'src/core/commands/clients.js:755',
  'src/core/commands/clients.js:891',
  'src/core/commands/clients.js:938',
  'src/core/commands/clients.js:1008',
  'src/core/commands/clients.js:1074',
  'src/core/commands/policy.js:33',
  'src/core/commands/policy.js:218',
  'src/core/commands/policy.js:254',
  'src/core/commands/policy.js:291',
  'src/core/commands/policy.js:338',
])

/**
 * The slug a Markdown renderer gives a heading: lowercase, inline anchor tags
 * off, punctuation stripped while `-` and `_` survive, then every single
 * whitespace character becomes a `-` with no collapsing, so a heading whose
 * words are separated by a stripped dash keeps a double hyphen.
 *
 * @ref LLP 0001#conventions-adopted-spec-faithful [implements]: heading slugs are the default anchor form, so resolving one has to match the renderer
 * @param {string} heading
 * @returns {string}
 */
function headingSlug(heading) {
  return heading
    .replace(/<\/?a\b[^>]*>/g, '')
    .replace(/\{#[^}]+\}/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

/**
 * Every anchor a document defines: heading slugs, explicit `{#slug}` markers on
 * any line (the corpus puts most of them on list items rather than headings),
 * and inline `<a id>`/`<a name>` tags.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function documentAnchors(text) {
  /** @type {Set<string>} */
  const anchors = new Set()
  /** @type {Map<string, number>} */
  const seen = new Map()
  for (const line of text.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (heading) {
      const slug = headingSlug(heading[1])
      if (slug) {
        const n = seen.get(slug) ?? 0
        seen.set(slug, n + 1)
        anchors.add(n === 0 ? slug : `${slug}-${n}`)
      }
    }
    for (const m of line.matchAll(/\{#([^}\s]+)\}/g)) anchors.add(m[1])
    for (const m of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/g)) anchors.add(m[1])
  }
  return anchors
}

/**
 * Extract the annotations from one file's text, honoring the ignore markers.
 *
 * @param {string} relPath
 * @param {string} text
 * @returns {{ file: string, line: number, text: string, llp: string | null, docPath: string | null, anchor: string | null }[]}
 */
function extractRefs(relPath, text) {
  /** @type {{ file: string, line: number, text: string, llp: string | null, docPath: string | null, anchor: string | null }[]} */
  const refs = []
  let ignoring = false
  text.split('\n').forEach((line, index) => {
    if (line.includes(IGNORE_START)) ignoring = true
    else if (line.includes(IGNORE_END)) ignoring = false
    else if (!ignoring && !line.includes(IGNORE_LINE)) {
      for (const m of line.matchAll(REF_PATTERN)) {
        refs.push({
          file: relPath,
          line: index + 1,
          text: line.trim(),
          llp: m[1] ? String(Number(m[1])) : null,
          docPath: m[2] ?? null,
          anchor: m[3] ? m[3].slice(1) : null,
        })
      }
    }
  })
  return refs
}

/**
 * @returns {string[]} repo-relative paths of the tracked files worth scanning
 */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
  return out.split('\0').filter(f => f !== '' && SCANNED_EXTENSIONS.has(path.extname(f)))
}

/**
 * @returns {Map<string, { file: string, anchors: Set<string> }[]>} LLP number to its claimants
 */
function llpIndex() {
  /** @type {Map<string, { file: string, anchors: Set<string> }[]>} */
  const index = new Map()
  /** @param {string} dir */
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const numbered = entry.name.match(/^(\d{4})-.*\.md$/)
      if (!numbered) continue
      const number = String(Number(numbered[1]))
      const claimants = index.get(number) ?? []
      claimants.push({
        file: path.relative(REPO_ROOT, full),
        anchors: documentAnchors(fs.readFileSync(full, 'utf8')),
      })
      index.set(number, claimants)
    }
  }
  walk(LLP_DIR)
  return index
}

const REFS = trackedFiles().flatMap(f => extractRefs(f, fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')))
const INDEX = llpIndex()

test('the scan finds the corpus and its annotations', () => {
  assert.ok(REFS.length > 500, `expected the corpus's annotations, found ${REFS.length}`)
  assert.ok(INDEX.size > 100, `expected the LLP corpus, found ${INDEX.size} numbers`)
})

test('every @ref resolves to a live LLP document and one of its anchors', () => {
  /** @type {string[]} */
  const broken = []
  for (const ref of REFS) {
    const site = `${ref.file}:${ref.line}`
    /** @param {string} why */
    const fail = why => {
      if (!TOLERATED_BROKEN.has(site)) broken.push(`${site}  ${why}\n      ${ref.text}`)
    }
    if (ref.llp !== null) {
      // A number claimed by two documents resolves against either claimant: that
      // ambiguity is a corpus defect in its own right, not a reason to call the
      // annotation broken.
      const claimants = INDEX.get(ref.llp)
      const anchor = ref.anchor
      if (!claimants) fail(`LLP ${ref.llp} does not exist`)
      else if (anchor !== null && !claimants.some(c => c.anchors.has(anchor))) {
        fail(`LLP ${ref.llp} defines no anchor #${anchor}`)
      }
      continue
    }
    if (ref.docPath === null) continue
    const candidates = [
      path.resolve(REPO_ROOT, path.dirname(ref.file), ref.docPath),
      path.resolve(REPO_ROOT, ref.docPath),
    ]
    if (!candidates.some(c => fs.existsSync(c))) fail(`no such file ${ref.docPath}`)
  }
  assert.deepEqual(broken, [], `${broken.length} broken @ref annotations:\n  ${broken.join('\n  ')}`)
})

test('no @ref annotation separates its gloss with an em dash', () => {
  const offenders = REFS
    .filter(ref => ref.text.includes(EM_DASH))
    .map(ref => `${ref.file}:${ref.line}  ${ref.text}`)
  assert.deepEqual(offenders, [], `${offenders.length} annotations carry an em dash:\n  ${offenders.join('\n  ')}`)
})

// The three colliding numbers (0098, 0099, 0111) make `@ref LLP 0111#surface`
// formally ambiguous. Fixing it is a corpus-level choice between renumbering the
// later claimant and adopting a filename-qualified citation form, which issue
// #463 asks to have decided deliberately rather than by whoever touches it
// first. Unskip this once that decision lands.
test('no LLP number is claimed by two documents', { skip: 'issue #463 item 1: renumber vs qualified-citation is an open corpus decision' }, () => {
  const duplicates = [...INDEX.entries()]
    .filter(([, claimants]) => claimants.length > 1)
    .map(([number, claimants]) => `LLP ${number}: ${claimants.map(c => c.file).join(', ')}`)
  assert.deepEqual(duplicates, [])
})

test('the ignore markers hide illustrative annotations without hiding live ones', () => {
  const marked = [
    'live: // @ref LLP 0001#tooling: kept',
    '<!-- ref-check:ignore-start -->',
    'example: // @ref LLP 0042#token-strategy: skipped',
    '<!-- ref-check:ignore-end -->',
    'inline: // @ref LLP 0074#focus-trap: skipped <!-- ref-check:ignore -->',
    'live again: // @ref LLP 0002#decisions: kept',
  ].join('\n')
  assert.deepEqual(
    extractRefs('fixture.md', marked).map(r => `${r.llp}#${r.anchor}`),
    ['1#tooling', '2#decisions'],
  )
})

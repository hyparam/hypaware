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
//
// A marker counts only when it is a comment in the language of the file it sits
// in, and only outside a code sample. Without both conditions the documentation
// that explains the markers activates them, which is the exact failure the marker
// is warned against: a skill whose subject is the annotation syntax has to be
// able to show that syntax. Markdown's only comment is `<!-- -->`; a leading `*`
// is a bullet and a leading `#` is a heading, so a prose list explaining
// `ignore-start` would otherwise open a real region. The gap before the marker
// text is bounded rather than `*`-quantified so that these patterns do not match
// their own source lines.
//
// @ref LLP 0001#illustrative-refs [implements]: a marker is a comment in its file's language, never a code sample, so documenting it cannot arm it
const MARKDOWN_MARKER = /<!--[ \t]{0,8}ref-check:ignore(-start|-end)?\b/g
const CODE_MARKER = /(?:<!--|\/\/|\/\*|\*|#)[ \t]{0,8}ref-check:ignore(-start|-end)?\b/g

/** A fenced code block's opening or closing line, per CommonMark. */
const FENCE_PATTERN = /^ {0,3}(?:`{3,}|~{3,})/

/** Four spaces or a tab opens a CommonMark indented code block. */
const INDENTED_CODE_PATTERN = /^(?: {4,}|\t)/

/**
 * Which suppression marker, if any, a line carries.
 *
 * @param {string} line
 * @param {boolean} markdown whether the file's comment syntax is Markdown's
 * @returns {'start' | 'end' | 'line' | null}
 */
function markerOn(line, markdown) {
  if (markdown && INDENTED_CODE_PATTERN.test(line)) return null
  /** @type {'start' | 'end' | 'line' | null} */
  let found = null
  for (const m of line.replace(/`[^`]*`/g, '').matchAll(markdown ? MARKDOWN_MARKER : CODE_MARKER)) {
    if (m[1] === '-start') return 'start'
    if (m[1] === '-end') return 'end'
    found = 'line'
  }
  return found
}

/**
 * Resolve every line's marker in one pass, carrying the fenced-code state across
 * lines: a marker inside a fence is a sample of the syntax, the multi-line form
 * of the inline code span that `markerOn` already excludes. Fences are tracked
 * only in Markdown, where they are the documented way to show a code sample, so a
 * stray triple backtick in a source comment cannot silence a real marker.
 *
 * Both the extractor and the suppression gate read markers through here, so what
 * the gate polices is exactly what the extractor obeys.
 *
 * @param {string} relPath
 * @param {string[]} lines
 * @returns {('start' | 'end' | 'line' | null)[]}
 */
function markersFor(relPath, lines) {
  const markdown = path.extname(relPath) === '.md'
  let fenced = false
  return lines.map(line => {
    if (markdown && FENCE_PATTERN.test(line)) {
      fenced = !fenced
      return null
    }
    return fenced ? null : markerOn(line, markdown)
  })
}

/**
 * The only files allowed to suppress extraction: the two skills that document
 * the annotation syntax, and this test's own fixture. Enumerated rather than
 * inferred so that a new suppression anywhere else fails until it is added here,
 * which is what makes it visible in a diff instead of silently unchecked.
 */
const MARKED_FILES = new Set([
  '.claude/skills/ref-check/SKILL.md',
  '.claude/skills/ref-story/SKILL.md',
  'test/core/llp-ref-hygiene.test.js',
])

/**
 * Broken references this test tolerates because a held pull request already owns
 * the repair. **Empty, and the empty state is the point**: every reference in the
 * corpus resolves, so the gate has no exceptions to read past. The last entries
 * covered the `cli` and `reporting` anchors in LLP 0103 and the LLP 0135 line that
 * split `#interactive-walkthrough` across a line break; PR #461 (issue #457)
 * landed both repairs and left the entries behind, and issue #639 later read
 * them back out as live breakage. A tolerance outlives its defect
 * silently, so an entry is worth adding only while the pull request that removes
 * it is open, and an entry that has stopped forgiving anything now fails the
 * suite rather than sitting here as the last claim that a live reference is
 * broken.
 *
 * Keyed on the file and what the annotation cites, with how many of them are
 * known, rather than on `file:line`: a line number is not a property of the
 * defect, so an unrelated edit anywhere above one of these sites used to turn a
 * tolerated reference into a suite failure, and the files that carried them were
 * edited routinely. The count is what keeps that from being a loosening. It is a
 * ceiling, so a sixth broken `LLP 0103#cli` under a budget of five is new
 * breakage and still fails.
 *
 * @type {Map<string, number>}
 */
const TOLERATED_BROKEN = new Map()

/**
 * The line-independent identity of an annotation: the file it sits in and the
 * target it cites.
 *
 * @param {{ file: string, llp: string | null, docPath: string | null, anchor: string | null }} ref
 * @returns {string}
 */
function refIdentity(ref) {
  const target = ref.llp === null ? String(ref.docPath) : `LLP ${ref.llp.padStart(4, '0')}`
  return `${ref.file}  ${target}${ref.anchor === null ? '' : `#${ref.anchor}`}`
}

/**
 * A predicate that spends a tolerance budget: the first `n` broken annotations
 * with a given identity are tolerated and every later one is not, so a new
 * occurrence cannot hide behind the known ones.
 *
 * The ledger is the caller's, so a run can be asked afterwards which tolerances
 * it actually needed: an entry nobody spent is a defect that healed without
 * anyone noticing, and the stale entry left behind reads as live breakage.
 *
 * @param {Map<string, number>} budgets
 * @param {Map<string, number>} spent filled in with how much of each budget was used
 * @returns {(ref: { file: string, llp: string | null, docPath: string | null, anchor: string | null }) => boolean}
 */
function toleranceSpender(budgets, spent = new Map()) {
  return ref => {
    const id = refIdentity(ref)
    const used = spent.get(id) ?? 0
    if (used >= (budgets.get(id) ?? 0)) return false
    spent.set(id, used + 1)
    return true
  }
}

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
 * A gloss does not have to fit on one line, so neither can the scan that
 * polices it. Everything from the `@ref` line up to the end of the gloss is one
 * string: the annotation's line plus the wrapped continuation lines under it.
 *
 * A continuation is a line that carries on the same comment or paragraph and
 * says nothing new: not blank, not a fresh `@` tag or a second annotation, not
 * the close of a block comment, and, in Markdown, not the start of a new list
 * item, heading, table row or quote. The stripped shape is what is joined, so
 * the caller sees the gloss and not the comment furniture around it.
 *
 * @param {string[]} lines
 * @param {number} index the `@ref` line
 * @param {boolean} markdown
 * @param {('start' | 'end' | 'line' | null)[]} markers
 * @returns {string}
 */
function glossLines(lines, index, markdown, markers) {
  const strip = (/** @type {string} */ line) =>
    line.replace(/^\s*(?:\/\/+|\*(?!\/)|>)?\s*/, '').trimEnd()
  const parts = [lines[index].trim()]
  for (let i = index + 1; i < lines.length; i++) {
    const raw = lines[i]
    if (markers[i] !== null) break
    if (/^\s*(?:\*\/|\/\*)/.test(raw)) break
    const body = strip(raw)
    if (body === '') break
    if (/^@/.test(body) || body.includes('@ref')) break
    if (markdown && /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\||>)/.test(raw)) break
    // A source line that left the comment behind ends the gloss.
    if (!markdown && !/^\s*(?:\/\/|\*)/.test(raw)) break
    parts.push(body)
  }
  return parts.join(' ')
}

/**
 * Extract the annotations from one file's text, honoring the ignore markers.
 *
 * @param {string} relPath
 * @param {string} text
 * @returns {{ file: string, line: number, text: string, gloss: string, llp: string | null, docPath: string | null, anchor: string | null }[]}
 */
function extractRefs(relPath, text) {
  /** @type {{ file: string, line: number, text: string, gloss: string, llp: string | null, docPath: string | null, anchor: string | null }[]} */
  const refs = []
  let ignoring = false
  const lines = text.split('\n')
  const markdown = path.extname(relPath) === '.md'
  const markers = markersFor(relPath, lines)
  lines.forEach((line, index) => {
    const marker = markers[index]
    if (marker === 'start') ignoring = true
    else if (marker === 'end') ignoring = false
    else if (!ignoring && marker === null) {
      const matches = [...line.matchAll(REF_PATTERN)]
      const gloss = matches.length === 0 ? '' : glossLines(lines, index, markdown, markers)
      for (const m of matches) {
        refs.push({
          file: relPath,
          line: index + 1,
          text: line.trim(),
          gloss,
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

/**
 * Resolve every annotation against the corpus, spending the tolerance budget on
 * the way. Shared so that what the gate reports and what the staleness check
 * reads are the same pass over the same references.
 *
 * @param {Map<string, number>} budgets
 * @param {Map<string, number>} spent filled in with how much of each budget was used
 * @returns {string[]} the unforgiven breakage, formatted for a failure message
 */
function brokenRefs(budgets, spent) {
  /** @type {string[]} */
  const broken = []
  const tolerated = toleranceSpender(budgets, spent)
  for (const ref of REFS) {
    const site = `${ref.file}:${ref.line}`
    /** @param {string} why */
    const fail = why => {
      if (!tolerated(ref)) broken.push(`${site}  ${why}\n      ${ref.text}`)
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
  return broken
}

test('every @ref resolves to a live LLP document and one of its anchors', () => {
  const broken = brokenRefs(TOLERATED_BROKEN, new Map())
  assert.deepEqual(broken, [], `${broken.length} broken @ref annotations:\n  ${broken.join('\n  ')}`)
})

// Issue #639 read the tolerance list as a list of live defects and asked for
// repairs PR #461 had already made. A tolerance is invisible from the outside
// once it stops being fully spent: the suite is green either way, so the
// unspent balance survives as a standing claim that the reference is broken
// by more than it is. Repairs land one reference at a time, not all at once,
// so a budget of five against one remaining break is the exact shape that
// produced the stale list this test exists to catch: it has to expire with
// the defect, at the same rate the defect shrinks, and nothing but a check
// notices when it does not.
test('every tolerated reference forgives no more than is still broken', () => {
  /** @type {Map<string, number>} */
  const spent = new Map()
  brokenRefs(TOLERATED_BROKEN, spent)
  const stale = [...TOLERATED_BROKEN.entries()]
    .filter(([id, budget]) => (spent.get(id) ?? 0) < budget)
    .map(([id, budget]) => `${id}  tolerance forgives ${budget} but only ${spent.get(id) ?? 0} are broken`)
  assert.deepEqual(stale, [], `${stale.length} tolerances forgive more than is still broken:\n  ${stale.join('\n  ')}`)
})

test('a tolerated reference is tolerated only as often as it is listed', () => {
  const tolerated = toleranceSpender(new Map([['a.js  LLP 0103#cli', 2]]))
  /** @param {string | null} anchor */
  const ref = anchor => ({ file: 'a.js', llp: '103', docPath: null, anchor })
  assert.equal(tolerated(ref('cli')), true)
  assert.equal(tolerated(ref('cli')), true)
  // The third is new breakage even though the first two are known.
  assert.equal(tolerated(ref('cli')), false)
  // A different anchor, a different target and a different file are all unlisted.
  assert.equal(tolerated(ref('reporting')), false)
  assert.equal(tolerated(ref(null)), false)
  assert.equal(tolerated({ file: 'b.js', llp: '103', docPath: null, anchor: 'cli' }), false)
})

// The check reads the whole gloss, not the line the `@ref` token happens to sit
// on. Scanning one line left a standing blind spot: a gloss that wrapped could
// carry the character on its second line and no gate saw it, which is how three
// of them survived the sweep that was supposed to remove them.
test('no @ref annotation carries an em dash, on its first line or a later one', () => {
  const offenders = REFS
    .filter(ref => ref.gloss.includes(EM_DASH))
    .map(ref => `${ref.file}:${ref.line}  ${ref.gloss}`)
  assert.deepEqual(offenders, [], `${offenders.length} annotations carry an em dash:\n  ${offenders.join('\n  ')}`)
})

test('a gloss spans its continuation lines, and stops where the gloss stops', () => {
  const gloss = (/** @type {string} */ file, /** @type {string[]} */ lines) =>
    extractRefs(file, lines.join('\n'))[0].gloss
  // A JSDoc gloss wrapped over three lines is one gloss.
  assert.equal(
    gloss('x.js', [' * @ref LLP 0001#tooling: the extractor', ' * plus the resolver,', ' * wired into `npm test`', ' */']),
    '* @ref LLP 0001#tooling: the extractor plus the resolver, wired into `npm test`',
  )
  // It stops at the next tag, at a blank line, and at the end of the comment.
  assert.equal(gloss('x.js', ['// @ref LLP 0001#tooling: short', '// @param {string} x']), '// @ref LLP 0001#tooling: short')
  assert.equal(gloss('x.js', [' * @ref LLP 0001#tooling: short', ' *', ' * unrelated']), '* @ref LLP 0001#tooling: short')
  assert.equal(gloss('x.js', ['// @ref LLP 0001#tooling: short', 'const x = 1']), '// @ref LLP 0001#tooling: short')
  // In Markdown the next bullet is a new thought, not a continuation.
  assert.equal(
    gloss('x.md', ['- @ref LLP 0001#tooling: the extractor', '  plus the resolver', '- something else']),
    '- @ref LLP 0001#tooling: the extractor plus the resolver',
  )
  // The regression the widening exists for: the character on a later line.
  const wrapped = ['// @ref LLP 0001#tooling: the extractor', `// plus the resolver ${EM_DASH} wired in`]
  assert.equal(extractRefs('x.js', wrapped.join('\n'))[0].gloss.includes(EM_DASH), true)
  assert.equal(extractRefs('x.js', wrapped.join('\n'))[0].text.includes(EM_DASH), false)
})

// @ref LLP 0156#renumber [tests]: a collision is repaired by renumbering the later claimant, so every number has exactly one document
test('no LLP number is claimed by two documents', () => {
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

test('documenting a marker does not activate it', () => {
  const prose = [
    'Write `ref-check:ignore-start` to open a region and `ref-check:ignore-end` to close it.',
    'A ref-check:ignore in bare prose is not a marker either.',
    '// @ref LLP 0001#tooling: still checked',
  ].join('\n')
  assert.deepEqual(
    extractRefs('doc.md', prose).map(r => `${r.llp}#${r.anchor}`),
    ['1#tooling'],
  )
})

// Every form below is a way documentation naturally shows the marker, and every
// one of them opened a real suppressed region while the only test was that the
// text sat behind some comment opener: a Markdown bullet and heading start with
// the `*` and `#` that mean "comment" in a source file, and a code sample is
// still a comment as far as a regex is concerned. The marker text is spelled in
// pieces so that these fixtures, several of which deliberately leave a region
// unbalanced, are not markers in this file.
test('a marker shown as documentation or as a code sample does not activate it', () => {
  const marker = 'ref-check:' + 'ignore'
  const live = '// @ref LLP 0001#tooling: still checked'
  /** @param {string[]} lines */
  const kept = lines => extractRefs('doc.md', lines.join('\n')).map(r => `${r.llp}#${r.anchor}`)
  // In Markdown a leading `*` is a bullet and a leading `#` is a heading.
  assert.deepEqual(kept([`* ${marker}-start opens a region`, live]), ['1#tooling'])
  assert.deepEqual(kept([`- ${marker}-start opens a region`, live]), ['1#tooling'])
  assert.deepEqual(kept([`# ${marker}-start`, live]), ['1#tooling'])
  assert.deepEqual(kept([`* ${marker} suppresses one line`, live]), ['1#tooling'])
  // A code sample of the syntax is a sample, fenced or indented.
  assert.deepEqual(kept(['```', `<!-- ${marker}-start -->`, '```', live]), ['1#tooling'])
  assert.deepEqual(kept(['~~~', `<!-- ${marker}-start -->`, '~~~', live]), ['1#tooling'])
  assert.deepEqual(kept([`    <!-- ${marker}-start -->`, live]), ['1#tooling'])
  assert.deepEqual(kept([`\t<!-- ${marker}-start -->`, live]), ['1#tooling'])
  // The intended forms still suppress: an HTML comment in Markdown, a `//`
  // comment in a source file, and a fence sitting inside a region.
  assert.deepEqual(kept([`<!-- ${marker}-start -->`, live, `<!-- ${marker}-end -->`]), [])
  assert.deepEqual(kept([`<!-- ${marker}-start -->`, '```', live, '```', `<!-- ${marker}-end -->`]), [])
  assert.deepEqual(kept([`${live} <!-- ${marker} -->`]), [])
  assert.deepEqual(extractRefs('x.js', [`// ${marker}-start`, live, `// ${marker}-end`].join('\n')), [])
  assert.deepEqual(extractRefs('x.js', [` * ${marker}-start`, live, ` * ${marker}-end`].join('\n')), [])
})

// A suppressed annotation is checked nowhere, so the suppression itself has to
// be as reviewable as the annotation would have been: an unclosed region silently
// unpolices every line after it, and a marker in a file that is not the syntax
// documentation is a broken ref someone gave up on rather than an illustration.
// Every marker has to pair, too: an unbalanced region means the author and the
// extractor disagree about which lines are suppressed, and that disagreement is
// the thing nobody notices.
test('suppression is confined to the syntax documentation and every region closes', () => {
  /** @type {string[]} */
  const offenders = []
  for (const file of trackedFiles()) {
    const lines = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n')
    let openedAt = 0
    markersFor(file, lines).forEach((marker, index) => {
      if (marker === null) return
      if (!MARKED_FILES.has(file)) offenders.push(`${file}:${index + 1}  suppression outside the syntax documentation`)
      if (marker === 'start') {
        if (openedAt !== 0) offenders.push(`${file}:${index + 1}  region opened while the one at ${openedAt} is still open`)
        openedAt = index + 1
      } else if (marker === 'end') {
        if (openedAt === 0) offenders.push(`${file}:${index + 1}  region closed without being opened`)
        openedAt = 0
      }
    })
    if (openedAt !== 0) offenders.push(`${file}:${openedAt}  region opened and never closed`)
  }
  assert.deepEqual(offenders, [], `${offenders.length} suppression defects:\n  ${offenders.join('\n  ')}`)
})

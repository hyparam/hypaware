// @ts-check

/**
 * End-to-end contract for the report renderer, built in a temp tree.
 *
 * @ref LLP 0196#mechanics-as-code [tests]: the verification the skill used to perform as
 * a list of greps is now the renderer's own contract, so it runs every time
 *
 * The shell original could not be covered at all: it is macOS-only and CI is
 * `ubuntu-latest`. These assertions are the skill's step-6 checklist, promoted to code.
 *
 * Rendering is in-process (LLP 0208), so these run everywhere with no skip guard:
 * a renderer with no external dependency has no excuse for untested paths.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { discoverSections, docLabel, masthead, pageTitle, renderReports } from '../../src/core/reports/render.js'

const SLUG = '2026-08-02-usage-review'
const OTHER = '2026-07-21-usage-review'

test('docLabel states the slug\'s date, else the generic wording', () => {
  assert.equal(docLabel(SLUG), 'Internal report · generated 2026-08-02 from HypAware data')
  assert.equal(docLabel('usage-review'), 'Internal report · generated from HypAware data')
})

test('pageTitle takes the first heading, trimmed, else the fallback', () => {
  assert.equal(pageTitle('# Team AI Usage Review\n\nBody.\n', 'fallback'), 'Team AI Usage Review')
  // Trailing spaces on the heading line must not reach the rendered <title>.
  assert.equal(pageTitle('# Padded heading   \n', 'fallback'), 'Padded heading')
  assert.equal(pageTitle('No heading here.\n', 'fallback'), 'fallback')
})

test('masthead carries the brand, the doc label, and the nav slot', () => {
  const html = masthead('<a href="../../index.html">All reports</a>', docLabel(SLUG))
  assert.match(html, /<span class="brand"><span class="brand-mark"><\/span>Hyperparam<\/span>/)
  assert.match(html, /<span class="doc-label">Internal report · generated 2026-08-02 from HypAware data<\/span>/)
  assert.match(html, /<nav class="topnav"><a href="\.\.\/\.\.\/index\.html">All reports<\/a><\/nav>/)
})

test('discoverSections lists a report\'s section files sorted, and nothing without a section dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-render-sections-'))
  fs.mkdirSync(path.join(dir, SLUG))
  fs.writeFileSync(path.join(dir, SLUG, 'trends.md'), '# Trends\n')
  fs.writeFileSync(path.join(dir, SLUG, 'proposed-changes.md'), '# Proposed changes\n')
  fs.writeFileSync(path.join(dir, SLUG, 'notes.txt'), 'not a section')

  assert.deepEqual(discoverSections(dir, SLUG), ['proposed-changes.md', 'trends.md'])
  assert.deepEqual(discoverSections(dir, OTHER), [], 'a report with no section dir has no sections')

  fs.rmSync(dir, { recursive: true, force: true })
})

/** A reports tree with one sectioned report, one flat report, and cross-report links. */
function fixtureTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-render-'))
  fs.writeFileSync(
    path.join(dir, `${SLUG}.md`),
    [
      '# Team AI Usage Review',
      '',
      '**One sentence thesis.**',
      '',
      `See [trends](${SLUG}/trends.md) and [changes](${SLUG}/proposed-changes.md#top).`,
      `Compare with the [previous review](${OTHER}.md).`,
      '',
      `<a class="rec" href="${SLUG}/proposed-changes.md"><h3>Proposed changes</h3></a>`,
      '',
      '[upstream](https://example.com/docs/readme.md)',
      '',
    ].join('\n'),
  )
  fs.mkdirSync(path.join(dir, SLUG))
  fs.writeFileSync(
    path.join(dir, SLUG, 'trends.md'),
    `# Trends\n\n**Thesis.**\n\nBack to [the report](../${SLUG}.md), or [changes](proposed-changes.md).\n`,
  )
  fs.writeFileSync(
    path.join(dir, SLUG, 'proposed-changes.md'),
    `# Proposed changes\n\n**Thesis.**\n\nSee [their trends](../${OTHER}/trends.md).\n`,
  )
  // A flat report: no sibling section directory.
  fs.writeFileSync(path.join(dir, `${OTHER}.md`), '# Previous Review\n\n**Thesis.**\n')
  fs.writeFileSync(path.join(dir, 'README.md'), '# Not a report\n')
  return dir
}

test('renderReports builds every report and no stale output', () => {
  const dir = fixtureTree()
  const result = renderReports({ dir })

  assert.equal(result.reports, 2, 'README.md must not be treated as a report')
  assert.deepEqual(result.slugs.sort(), [OTHER, SLUG].sort())

  assert.ok(fs.existsSync(path.join(dir, 'html', SLUG, 'index.html')))
  assert.ok(fs.existsSync(path.join(dir, 'html', SLUG, 'trends.html')))
  assert.ok(fs.existsSync(path.join(dir, 'html', OTHER, 'index.html')))
  assert.ok(!fs.existsSync(path.join(dir, 'html', 'README')), 'README must not build')

  // html/ is wiped each run, so a removed report leaves nothing behind.
  fs.rmSync(path.join(dir, `${OTHER}.md`))
  renderReports({ dir })
  assert.ok(!fs.existsSync(path.join(dir, 'html', OTHER)), 'a deleted report must leave no stale HTML')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('no built page keeps a .md href', () => {
  const dir = fixtureTree()
  renderReports({ dir })

  for (const file of builtPages(path.join(dir, 'html'))) {
    const html = fs.readFileSync(file, 'utf8')
    const leftover = [...html.matchAll(/href="([^"]*\.md(?:#[^"]*)?)"/g)]
      .map((m) => m[1])
      // Absolute URLs are deliberately untouched.
      .filter((href) => !href.includes('://'))
    assert.deepEqual(leftover, [], `${path.basename(file)} has unrewritten .md links: ${leftover}`)
  }

  fs.rmSync(dir, { recursive: true, force: true })
})

test('every page carries a copy action, and every report a full.md payload', () => {
  const dir = fixtureTree()
  renderReports({ dir })

  for (const file of builtPages(path.join(dir, 'html'))) {
    const html = fs.readFileSync(file, 'utf8')
    assert.match(html, /class="copy-md"/, `${file} is missing its copy action`)
    // The copy button must keep a raw .md target: data-src is not href.
    assert.match(html, /data-src="[^"]+\.md"/, `${file} lost its data-src payload`)
  }

  assert.ok(fs.existsSync(path.join(dir, 'html', SLUG, 'full.md')))
  const full = fs.readFileSync(path.join(dir, 'html', SLUG, 'full.md'), 'utf8')
  assert.match(full, /# Team AI Usage Review/)
  assert.match(full, /# Trends/, 'full.md must concatenate the sections')
  assert.match(full, /\.md\)/, 'the raw payload keeps its .md links on purpose')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('one-pagers link back to the landing page, sections back to their report', () => {
  const dir = fixtureTree()
  renderReports({ dir })

  const index = fs.readFileSync(path.join(dir, 'html', SLUG, 'index.html'), 'utf8')
  assert.match(index, /All reports/)
  assert.match(index, /href="\.\.\/\.\.\/index\.html"/)

  const section = fs.readFileSync(path.join(dir, 'html', SLUG, 'trends.html'), 'utf8')
  assert.match(section, /Back to the report/)
  // The back-reference to its own one-pager flattens to index.html.
  assert.match(section, /href="index\.html"/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('theme.css is created once, never overwritten, and reaches every page', () => {
  // @ref LLP 0196#theme-layer [tests]: the base sheet is the command's and the theme is
  // the user's, which is what removes the "customization or rot?" guess
  const dir = fixtureTree()
  renderReports({ dir })

  const theme = path.join(dir, 'assets', 'theme.css')
  assert.ok(fs.existsSync(theme), 'a starting theme.css is created so the link never dangles')
  assert.match(fs.readFileSync(theme, 'utf8'), /never\s+overwrites it/, 'the stub says whose file it is')

  fs.writeFileSync(theme, ':root { --accent: #ff0000 }')
  renderReports({ dir })

  assert.equal(fs.readFileSync(theme, 'utf8'), ':root { --accent: #ff0000 }', "theme.css is the user's")

  // Every page, not just the landing page: shipping it without linking it is the bug
  // this test exists to catch.
  for (const file of builtPages(path.join(dir, 'html'))) {
    const html = fs.readFileSync(file, 'utf8')
    assert.match(html, /href="assets\/theme\.css"/, `${path.basename(file)} does not link the theme`)
    const base = html.indexOf('assets/style.css')
    assert.ok(base !== -1 && base < html.indexOf('assets/theme.css'), 'the theme must load after the base sheet')
    assert.equal(
      fs.readFileSync(path.join(path.dirname(file), 'assets', 'theme.css'), 'utf8'),
      ':root { --accent: #ff0000 }',
      'the theme must ship beside the page that links it',
    )
  }

  // The base sheet is the command's, so a local edit to it is replaced.
  const base = path.join(dir, 'assets', 'style.css')
  fs.writeFileSync(base, '/* hand-edited */')
  renderReports({ dir })
  assert.ok(fs.readFileSync(base, 'utf8').length > 1000, 'style.css is refreshed from the shipped copy')

  fs.rmSync(dir, { recursive: true, force: true })
})

/** A component block, authored exactly as the vocabulary spells it: raw HTML, indented. */
const COMPONENT_BLOCK = [
  '<div class="metric-grid">',
  '  <div class="metric">',
  '    <span class="metric-value good">1.2M</span>',
  '    <span class="metric-label">Opus output tokens / mo</span>',
  '  </div>',
  '</div>',
].join('\n')

/**
 * One page exercising the authoring vocabulary the renderer has to preserve: a component
 * block, an aligned table, a fenced block with a language, headings carrying `&`, `'` and
 * `/`, and in-page links to the ids those headings mint.
 */
const VOCABULARY = [
  '# Cost & Usage',
  '',
  '**One sentence thesis.**',
  '',
  "Jump to [what's next](#whats-next), the [numbers](#opus-output-tokens--mo), or the [query](#the-hyp-report-render-query).",
  '',
  COMPONENT_BLOCK,
  '',
  '## Opus output tokens / mo',
  '',
  '| Model | Tokens | Share |',
  '| :--- | ---: | :---: |',
  '| Opus | 1,200 | 40% |',
  '',
  "## What's next",
  '',
  '## The `hyp report render` query',
  '',
  '```sql',
  'select count(*) from ai_gateway_messages',
  '```',
  '',
].join('\n')

const VOCAB = 'vocabulary'

/** @returns {string} */
function vocabularyTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-render-vocab-'))
  fs.writeFileSync(path.join(dir, `${VOCAB}.md`), VOCABULARY)
  return dir
}

test('the authoring vocabulary converts to the markup pandoc emitted', () => {
  // @ref LLP 0208#pure-js [tests]: the swap is only safe if the vocabulary converts the
  // same, so the constructs are pinned here rather than left to a browser read-through
  const dir = vocabularyTree()
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', VOCAB, 'index.html'), 'utf8')

  // Component blocks pass through untouched, indentation included. This is the property
  // the whole authoring contract stands on.
  assert.ok(html.includes(COMPONENT_BLOCK), 'the component block must survive byte-for-byte')

  // Column alignment must arrive as an inline style. marked's built-in cell renderer
  // spells it `align="right"`, which loses the cascade to style.css's `th, td` rule, so
  // every numeric column would silently render left-aligned.
  assert.ok(
    html.includes(
      [
        '<thead>',
        '<tr>',
        '<th style="text-align: left;">Model</th>',
        '<th style="text-align: right;">Tokens</th>',
        '<th style="text-align: center;">Share</th>',
        '</tr>',
        '</thead>',
      ].join('\n'),
    ),
    'table headers must carry pandoc\'s inline text-align',
  )
  assert.ok(
    html.includes('<td style="text-align: right;">1,200</td>'),
    'a right-aligned body cell must carry the inline style too',
  )
  assert.doesNotMatch(html, /<t[hd] align=/, 'the presentational align attribute loses to the stylesheet')

  // A fenced block keeps its language class, which is what colour can hang off later.
  assert.ok(
    html.includes('<pre><code class="language-sql">select count(*) from ai_gateway_messages\n</code></pre>'),
    'a fenced block must stay verbatim under its language class',
  )

  // Heading ids are pandoc's, entity-free: `&` drops to nothing between two spaces and
  // both become hyphens, `'` and `/` drop outright.
  assert.ok(html.includes('<h1 id="cost--usage">Cost &amp; Usage</h1>'), 'an `&` heading keeps pandoc\'s double hyphen')
  assert.ok(html.includes('<h2 id="opus-output-tokens--mo">'), 'a `/` heading keeps pandoc\'s double hyphen')
  assert.ok(html.includes('<h2 id="whats-next">'), 'an apostrophe drops rather than leaving its entity digits')
  assert.ok(html.includes('<h2 id="the-hyp-report-render-query">'), 'inline code in a heading contributes its text')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('every in-page anchor resolves to an id on the page', () => {
  // The cheap end-to-end check on the slug rule: an id scheme that drifts from the one
  // that minted the authored anchors is invisible until a reader clicks a dead link.
  const dir = vocabularyTree()
  renderReports({ dir })

  for (const file of builtPages(path.join(dir, 'html'))) {
    const html = fs.readFileSync(file, 'utf8')
    const ids = new Set([...html.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]))
    const dangling = [...html.matchAll(/href="#([^"]+)"/g)]
      .map((m) => m[1])
      .filter((fragment) => !ids.has(fragment))
    assert.deepEqual(dangling, [], `${path.basename(file)} links to ids it does not define: ${dangling}`)
  }

  fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * A minimal single-file reports tree: one report, no sections. Used by the round-2
 * pinning tests below, which each exercise one isolated construct rather than the
 * shared VOCABULARY page.
 *
 * @param {string} slug
 * @param {string} markdown
 * @returns {string} the tree's root dir
 */
function onePageTree(slug, markdown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-render-round2-'))
  fs.writeFileSync(path.join(dir, `${slug}.md`), markdown)
  return dir
}

test('heading ids NFC-normalize and keep combining marks, matching pandoc 3.1.11', () => {
  // Measured against a real pandoc 3.1.11 binary (`-f gfm -t html5`): a heading spelled
  // with a decomposed base letter plus a trailing combining acute mints the SAME id as
  // the precomposed spelling, because pandoc normalizes to NFC before slugging; and
  // Devanagari combining marks (vowel signs, anusvara) survive rather than being
  // stripped as "not a letter or digit", which is what the pre-fix `[^\p{L}\p{N}_\s-]`
  // class did to them.
  const eDecomposed = 'e' + '́' // "e" + COMBINING ACUTE ACCENT, i.e. a decomposed "é"
  const decomposedHeading = 'Caf' + eDecomposed + ' r' + eDecomposed + 'sum' + eDecomposed
  const devanagariWord = 'हिंदी' // हिंदी

  const dir = onePageTree(
    'nfc',
    ['# ' + decomposedHeading, '', '## Devanagari ' + devanagariWord, ''].join('\n'),
  )
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', 'nfc', 'index.html'), 'utf8')

  assert.ok(
    html.includes('<h1 id="café-résumé">'),
    'a decomposed heading must mint the precomposed id pandoc mints, not "cafe-resume"',
  )
  assert.ok(
    html.includes(`<h2 id="devanagari-${devanagariWord}">`),
    'Devanagari combining marks must survive intact, not be stripped down to bare base letters',
  )

  fs.rmSync(dir, { recursive: true, force: true })
})

test('numeric and named HTML entities decode before the slug rule runs, matching pandoc 3.1.11', () => {
  // Each pairing measured against a real pandoc 3.1.11 binary. marked passes any entity
  // it does not itself emit straight through as literal text, so without a general
  // decoder the slug rule keeps the entity's own letters and digits.
  const dir = onePageTree(
    'entities',
    [
      '## Fees &mdash; and more',
      '',
      '## A &nbsp; B',
      '',
      '## 3 &times; 4',
      '',
      '## &#x27;apostrophe&#x27;',
      '',
      '## &#039;padded&#039;',
      '',
      '## Cost &AMP; usage',
      '',
    ].join('\n'),
  )
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', 'entities', 'index.html'), 'utf8')

  assert.ok(html.includes('<h2 id="fees--and-more">'), '&mdash; must decode, leaving pandoc\'s double hyphen')
  assert.ok(html.includes('<h2 id="a---b">'), '&nbsp; must decode to a space pandoc then collapses and re-hyphenates')
  assert.ok(html.includes('<h2 id="3--4">'), '&times; must decode and drop, not survive as the word "times"')
  assert.ok(html.includes('<h2 id="apostrophe">'), '&#x27; (hex numeric) must decode to a quote, not survive as "x27"')
  assert.ok(html.includes('<h2 id="padded">'), '&#039; (decimal numeric) must decode, not survive as "039"')
  assert.ok(html.includes('<h2 id="cost--usage">'), '&AMP; (legacy uppercase alias) must decode like &amp; does')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('an authored &rsquo; heading resolves its own in-page anchor', () => {
  // The finding this pins: `## What&rsquo;s next` next to a hand-written
  // `[link](#whats-next)` used to dangle silently, verbatim the round-1 blocker's
  // symptom, with a narrower trigger (an entity marked does not itself emit).
  const dir = onePageTree(
    'rsquo-anchor',
    ['# Report', '', "Jump to [what's next](#whats-next).", '', "## What&rsquo;s next", ''].join('\n'),
  )
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', 'rsquo-anchor', 'index.html'), 'utf8')

  assert.ok(html.includes('<h2 id="whats-next">'), 'the &rsquo; heading must mint the same id the plain apostrophe link expects')

  const ids = new Set([...html.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]))
  const dangling = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((fragment) => !ids.has(fragment))
  assert.deepEqual(dangling, [], `the in-page link must resolve, not dangle: ${dangling}`)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a heading that reduces to nothing emits no id attribute, matching pandoc 3.1.11', () => {
  // `## <emoji>` measured against pandoc 3.1.11: the first instance carries no id
  // attribute at all; a repeat still gets pandoc's own de-dup counter running against
  // the empty base (id="-1"), since an unauthorable anchor is still worth
  // disambiguating from a real one.
  const dir = onePageTree('emoji', ['# Report', '', '## \u{1F389}', '', '## \u{1F389}', ''].join('\n'))
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', 'emoji', 'index.html'), 'utf8')

  assert.ok(html.includes('<h2>\u{1F389}</h2>'), 'the first empty-slug heading must carry no id attribute at all')
  assert.doesNotMatch(html, /<h2 id="">/, 'an empty id="" attribute must never be emitted')
  assert.ok(html.includes('<h2 id="-1">\u{1F389}</h2>'), 'a repeat of the empty heading still gets the de-dup counter')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('an out-of-range numeric entity in a heading renders instead of crashing, matching pandoc 3.1.11', () => {
  // `String.fromCodePoint` throws above U+10FFFF, and marked's escaper passes numeric
  // references of up to 7 decimal or 6 hex digits through untouched, so the whole
  // `&#x110000;`-`&#xFFFFFF;` / `&#1114112;`-`&#9999999;` window reaches the entity
  // decoder verbatim. Measured against a real pandoc 3.1.11 binary: pandoc substitutes
  // U+FFFD, which the slug rule then strips like any other symbol, so `A &#x110000; B`
  // mints `a--b`, the same id an unrenderable character in that position always minted.
  const dir = onePageTree(
    'out-of-range',
    [
      '# Report',
      '',
      '## A &#x110000; B',
      '',
      '## C &#1114112; D',
      '',
      '## E &#9999999; F',
      '',
      '## G &#xFFFFFF; H',
      '',
      '## I&#x110000;J',
      '',
      '## &#x110000;',
      '',
      '## K &#xD800; L',
      '',
      '## M &#x10FFFF; N',
      '',
    ].join('\n'),
  )
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', 'out-of-range', 'index.html'), 'utf8')

  assert.ok(html.includes('<h2 id="a--b">'), 'a hex out-of-range reference must slug like pandoc, not abort the render')
  assert.ok(html.includes('<h2 id="c--d">'), 'a decimal out-of-range reference must slug like pandoc too')
  assert.ok(html.includes('<h2 id="e--f">'), 'the top of the reachable decimal window must slug like pandoc')
  assert.ok(html.includes('<h2 id="g--h">'), 'the top of the reachable hex window must slug like pandoc')
  assert.ok(html.includes('<h2 id="ij">'), 'with no spaces around it the substituted character leaves no hyphen at all')
  assert.ok(html.includes('<h2>&#x110000;</h2>'), 'a heading of nothing but the reference gets no id, and its text stays verbatim')

  // Lone surrogates were already safe (`fromCodePoint` accepts them and the `/u` strip
  // removes them) and must stay that way, as must the last real codepoint.
  assert.ok(html.includes('<h2 id="k--l">'), 'a lone surrogate must keep slugging to nothing, as pandoc does')
  assert.ok(html.includes('<h2 id="m--n">'), 'U+10FFFF is a real codepoint and must still decode, not be substituted')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('an uppercase hex numeric entity decodes like its lowercase spelling, matching pandoc 3.1.11', () => {
  // HTML and pandoc treat `&#X41;` exactly like `&#x41;`, and marked's escaper passes
  // the uppercase form through untouched (its no-encode pattern spells the prefix
  // `#[Xx]`), so it reaches the decoder verbatim. Every pairing measured against a real
  // pandoc 3.1.11 binary, one heading per document.
  // Each heading uses its own letters so no two share a base and the de-dup counter
  // never masks a divergence.
  const dir = onePageTree(
    'upper-hex',
    [
      '# Report',
      '',
      '## A &#X41; B',
      '',
      '## C &#X26; D',
      '',
      '## E &#XFFFFFF; F',
      '',
      '## G &#X110000; H',
      '',
    ].join('\n'),
  )
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', 'upper-hex', 'index.html'), 'utf8')

  assert.ok(html.includes('<h2 id="a-a-b">'), '&#X41; must decode to "A", not survive as the digits "x41"')
  assert.ok(html.includes('<h2 id="c--d">'), '&#X26; must decode to an `&` that then drops, not survive as "x26"')
  // The out-of-range guard has to cover the uppercase spelling too: both of these are
  // inside the reachable window, so before the fix they leaked their digits into the id
  // instead of substituting U+FFFD, the exact outcome that guard exists to prevent.
  assert.ok(html.includes('<h2 id="e--f">'), 'an out-of-range &#X...; must substitute U+FFFD and slug like pandoc')
  assert.ok(html.includes('<h2 id="g--h">'), 'the bottom of the out-of-range window decodes the same way')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('the HTML5 ASCII-punctuation entity names decode, matching pandoc 3.1.11', () => {
  // `&apos;` is the standard apostrophe reference and the one that actually shows up in
  // authored prose: `## What&apos;s next` minted `whataposs-next` where pandoc mints
  // `whats-next`, silently dangling the anchor while the visible heading rendered fine.
  // The rest of the ASCII-punctuation block is the same class of hole; every pairing
  // below was measured against a real pandoc 3.1.11 binary, one heading per document.
  const names = [
    'excl', 'num', 'dollar', 'percnt', 'lpar', 'rpar', 'ast', 'plus', 'comma', 'period',
    'sol', 'colon', 'semi', 'quest', 'commat', 'lbrack', 'bsol', 'rbrack', 'Hat', 'grave',
    'lbrace', 'verbar', 'rbrace',
  ]
  const dir = onePageTree(
    'ascii-punct',
    [
      '# Report',
      '',
      '## What&apos;s next',
      '',
      '## A &Tab; B',
      '',
      '## C &NewLine; D',
      '',
      '## E &lowbar; F',
      '',
      ...names.flatMap((name) => [`## ${name} &${name}; x`, '']),
    ].join('\n'),
  )
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', 'ascii-punct', 'index.html'), 'utf8')

  assert.ok(html.includes('<h2 id="whats-next">'), '&apos; must decode to a quote, not survive as the word "apos"')
  assert.ok(html.includes('<h2 id="a---b">'), '&Tab; decodes to whitespace, minting its own hyphen like pandoc')
  assert.ok(html.includes('<h2 id="c---d">'), '&NewLine; decodes to whitespace too')
  assert.ok(html.includes('<h2 id="e-_-f">'), '&lowbar; decodes to `_`, which the retained class keeps')
  // Each remaining name decodes to a punctuation character the slug rule then drops, so
  // the id keeps only the literal word before it. Leaving the name undecoded would
  // instead double it into the id (`excl-excl-x`).
  for (const name of names) {
    assert.ok(
      html.includes(`<h2 id="${name.toLowerCase()}--x">`),
      `&${name}; must decode and drop, not survive as the word "${name.toLowerCase()}"`,
    )
  }

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a <br> in a heading yields a space, matching pandoc 3.1.11', () => {
  // pandoc's reader turns `<br>` into a LineBreak and slugs it like any other whitespace
  // token, where stripping it as a tag welds the words on either side together. Every
  // pairing measured against a real pandoc 3.1.11 binary, one heading per document.
  const dir = onePageTree(
    'line-break',
    [
      '# Report',
      '',
      '## Line one<br/>Line two',
      '',
      '## A <br /> B',
      '',
      '## C <br/><br/> D',
      '',
      '## E <br class="x"> F',
      '',
      '## G <BR> H',
      '',
      '## <br>',
      '',
      '## I <span> </span> J',
      '',
      '## <span>tagged</span> text',
      '',
      '## <span>a</span>b',
      '',
      '## A<em>B</em>C',
      '',
    ].join('\n'),
  )
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', 'line-break', 'index.html'), 'utf8')

  assert.ok(html.includes('<h2 id="line-one-line-two">'), 'a <br> between words yields pandoc\'s single hyphen')
  assert.ok(html.includes('<h2 id="a---b">'), 'the <br> space is its own token and must not merge with the spaces around it')
  assert.ok(html.includes('<h2 id="c----d">'), 'two adjacent <br>s yield two separate spaces')
  assert.ok(html.includes('<h2 id="e---f">'), 'a <br> carrying attributes is still a line break')
  assert.ok(html.includes('<h2 id="-">'), 'a <br>-only heading mints pandoc\'s bare `-`, not a missing id')
  // pandoc recognizes only lowercase `br` as a line break and passes `<BR>` through as
  // raw inline HTML contributing nothing, so the uppercase spelling is one hyphen fewer.
  assert.ok(html.includes('<h2 id="g--h">'), 'an uppercase <BR> stays raw HTML and yields no space of its own')
  // A tag's own inner whitespace is its own token to pandoc, which the collapse running
  // ahead of the tag strip is what preserves.
  assert.ok(html.includes('<h2 id="i---j">'), 'the space inside a span pair counts as its own token')
  // Every OTHER tag must still vanish without a trace: a general tag-to-space rule would
  // break all three of these, which is why only the collapse moved ahead of the strip.
  assert.ok(html.includes('<h2 id="tagged-text">'), 'a span still vanishes, keeping only the authored space')
  assert.ok(html.includes('<h2 id="ab">'), 'a span between two letters welds them, as pandoc does')
  assert.ok(html.includes('<h2 id="abc">'), 'emphasis between letters welds them too')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('heading ids do not trim after the punctuation strip, matching pandoc 3.1.11', () => {
  // Every pairing measured against a real pandoc 3.1.11 binary (`-f gfm -t html5`).
  // pandoc does not trim at this stage: the space a dropped leading or trailing
  // character leaves behind becomes a hyphen like any other. Emoji-led headings are
  // ordinary in model-authored reports, so trimming here dangles every pandoc-era
  // `#-rollout-plan` anchor, which is exactly the parity LLP 0208 promises to keep.
  const dir = onePageTree(
    'no-trim',
    [
      '# Report',
      '',
      '## \u{1F680} Rollout plan',
      '',
      '## \u{2705} Done items',
      '',
      '## end &',
      '',
      '## & start',
      '',
      '## Hello &nbsp;',
      '',
      '## ( )',
      '',
      '## \u{1F680} A  B \u{2705}',
      '',
      '##    Padded   ',
      '',
      '## ...',
      '',
    ].join('\n'),
  )
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', 'no-trim', 'index.html'), 'utf8')

  assert.ok(html.includes('<h2 id="-rollout-plan">'), 'an emoji-led heading keeps pandoc\'s leading hyphen')
  assert.ok(html.includes('<h2 id="-done-items">'), 'a check-mark-led heading keeps pandoc\'s leading hyphen')
  assert.ok(html.includes('<h2 id="end-">'), 'a trailing `&` leaves pandoc\'s trailing hyphen')
  assert.ok(html.includes('<h2 id="-start">'), 'a leading `&` leaves pandoc\'s leading hyphen')
  assert.ok(html.includes('<h2 id="hello--">'), 'a trailing &nbsp; decodes to a space that becomes its own hyphen')
  assert.ok(html.includes('<h2 id="-">( )'), 'a heading of nothing but punctuation and a space mints pandoc\'s bare `-`')
  assert.ok(html.includes('<h2 id="-a-b-">'), 'emoji at both ends hyphenate at both ends, inner runs still collapsing to one')

  // The reader has already trimmed the raw heading line, so authored outer whitespace
  // never reaches the slug rule and must not produce a stray hyphen.
  assert.ok(html.includes('<h2 id="padded">'), 'authored outer whitespace is the reader\'s to trim, not the slug rule\'s')
  // A heading that reduces to the truly empty string still gets no id, as before.
  assert.ok(html.includes('<h2>...</h2>'), 'a heading with no retained character at all still carries no id')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a malformed entity in one report does not destroy the pages of the reports after it', () => {
  // The amplifier that made the crash a blocker rather than one bad page: `renderReports`
  // wipes `html/` before building and builds in sorted slug order, so a heading that
  // throws takes out every already-built page from that slug onward AND leaves the
  // landing page stale, with no signal that the tree is now half a build old.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-render-blast-'))
  const write = (/** @type {string} */ slug, /** @type {string} */ body) =>
    fs.writeFileSync(path.join(dir, `${slug}.md`), `# ${slug}\n\n${body}\n`)

  write('aaa-before', 'sorts before the bad report')
  write('mmm-bad', '## A ok B')
  write('zzz-after', 'sorts after the bad report')
  renderReports({ dir })

  // Now the model authors an out-of-range reference into the middle report, and a new
  // report lands after it. Both must survive the next build.
  write('mmm-bad', '## A &#x110000; B')
  write('nnn-new', 'added in the same pass as the bad heading')
  const result = renderReports({ dir })

  assert.deepEqual(result.slugs, ['aaa-before', 'mmm-bad', 'nnn-new', 'zzz-after'], 'every report must still be built')
  for (const slug of result.slugs) {
    assert.ok(fs.existsSync(path.join(dir, 'html', slug, 'index.html')), `${slug} must survive the bad heading`)
  }
  assert.ok(
    fs.readFileSync(path.join(dir, 'index.html'), 'utf8').includes('nnn-new'),
    'the landing page must be regenerated, not left stale at the pre-crash report set',
  )

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a loose task list still loses its bullet, matching pandoc\'s suppressed marker', () => {
  // marked emits two different shapes depending on whether the list is "tight" (no
  // blank line between items: the checkbox is a direct child of li) or "loose" (a
  // blank line between items: each item's content is wrapped in a p, so the checkbox
  // sits at li > p > input instead). The pre-fix selector only matched the tight shape.
  const dir = onePageTree(
    'tasklists',
    ['# Tasks', '', '## Tight', '', '- [ ] tight one', '- [x] tight two', '', '## Loose', '', '- [ ] loose one', '', '- [x] loose two', ''].join(
      '\n',
    ),
  )
  renderReports({ dir })
  const html = fs.readFileSync(path.join(dir, 'html', 'tasklists', 'index.html'), 'utf8')

  assert.ok(
    html.includes('<li><input disabled="" type="checkbox"> tight one</li>'),
    'a tight task list keeps the checkbox as a direct child of li',
  )
  assert.ok(
    html.includes('<li><p><input disabled="" type="checkbox"> loose one</p>'),
    'a loose task list wraps the checkbox in a p, which is the shape the pre-fix selector missed',
  )

  // The stylesheet is what actually suppresses the bullet in a browser (there is no
  // headless-browser layout check in this test tree), so the fix is pinned by asserting
  // its selector reaches both shapes rather than only the tight one.
  const css = fs.readFileSync(path.join(dir, 'html', 'tasklists', 'assets', 'style.css'), 'utf8')
  assert.match(
    css,
    /ul:has\(> li > input\[type="checkbox"\], > li > p > input\[type="checkbox"\]\)/,
    'the :has() selector must reach both the tight and the loose task-list shape',
  )

  fs.rmSync(dir, { recursive: true, force: true })
})

/** @param {string} htmlDir @returns {string[]} */
function builtPages(htmlDir) {
  /** @type {string[]} */
  const out = []
  for (const entry of fs.readdirSync(htmlDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of fs.readdirSync(path.join(htmlDir, entry.name))) {
      if (file.endsWith('.html')) out.push(path.join(htmlDir, entry.name, file))
    }
  }
  return out
}

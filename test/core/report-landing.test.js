// @ts-check

/**
 * Landing-page derivation.
 *
 * @ref LLP 0196#the-inversion [tests]: the landing page is derived output, and these
 * pin what "derived" means, in particular that nothing is invented
 *
 * Before this, the landing page was transcribed by a model from a template on every
 * run, which made it the least reproducible file in the tree: two runs over unchanged
 * reports produced different HTML, and a deleted landing page was simply gone.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { collectCards, extractKicker, extractStats, extractTitle, renderLandingPage } from '../../src/core/reports/landing.js'

const GRID = `<p class="eyebrow">Fleet · prod · 2026-07-05 → 2026-08-01</p>

# Team AI Usage Review

**Thesis.**

<div class="metric-grid">
  <div class="metric">
    <p class="label">Total tokens · 28 days</p>
    <div class="value">9.01<small>B</small></div>
    <p class="note">A note that must not reach the card.</p>
  </div>
  <div class="metric is-warn">
    <p class="label">Latest-week trend</p>
    <div class="value">+142<small>%</small></div>
  </div>
  <div class="metric is-good">
    <p class="label">Cache-read health</p>
    <div class="value">99.69<small>%</small></div>
  </div>
  <div class="metric is-crit">
    <p class="label">Graph staleness</p>
    <div class="value">20<small>days</small></div>
  </div>
  <div class="metric">
    <p class="label">A fifth metric</p>
    <div class="value">5</div>
  </div>
</div>
`

test('extractStats reads every metric, not just the first', () => {
  // Regression: a lazy regex over nested divs stops at the inner </div> and yields one
  // stat per report. That shipped once and produced single-stat cards.
  const stats = extractStats(GRID)
  assert.equal(stats.length, 4, 'default limit is 4, and all four must be found')
  assert.deepEqual(stats.map((s) => s.value), ['9.01B', '+142%', '99.69%', '20days'])
})

test('extractStats keeps each judgment exactly', () => {
  assert.deepEqual(extractStats(GRID).map((s) => s.judgment), ['', 'warn', 'good', 'crit'])
})

test('extractStats keeps labels verbatim rather than rewriting them', () => {
  // Compressing a label to "2-4 plain words" is editorial judgment. A renderer that did
  // it would be writing copy, not deriving it.
  assert.equal(extractStats(GRID)[0].label, 'Total tokens · 28 days')
})

test('extractStats keeps the value markup so a worded unit stays spaced', () => {
  const stat = extractStats(GRID)[3]
  assert.equal(stat.valueHtml, '20<small>days</small>')
  assert.equal(stat.value, '20days')
})

test('extractStats drops notes', () => {
  assert.ok(!JSON.stringify(extractStats(GRID)).includes('must not reach'))
})

test('extractStats returns nothing for a report with no metric grid', () => {
  // A prose-only page gets no stat row rather than invented figures.
  assert.deepEqual(extractStats('# Proposed changes\n\n**Thesis.**\n\nProse only.\n'), [])
})

test('extractKicker prefers the eyebrow, then a Source line, then a subtitle', () => {
  assert.equal(extractKicker(GRID), 'Fleet · prod · 2026-07-05 → 2026-08-01')
  assert.equal(extractKicker('# T\n\n*Source: local logs · Window: 30d*\n'), 'Source: local logs · Window: 30d')
  assert.equal(extractKicker('# T\n\n## hypaware.example · 2026-07\n'), 'hypaware.example · 2026-07')
  assert.equal(extractKicker('# T\n\nNo scope line.\n'), '')
})

test('extractTitle takes the first heading, else the fallback', () => {
  assert.equal(extractTitle(GRID, 'slug'), 'Team AI Usage Review')
  assert.equal(extractTitle('no heading here', 'slug'), 'slug')
})

/** A tree with two reports, one carrying a proposed-changes page. */
function fixtureTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-landing-'))
  fs.writeFileSync(path.join(dir, '2026-08-02-review.md'), GRID)
  fs.mkdirSync(path.join(dir, '2026-08-02-review'))
  fs.writeFileSync(
    path.join(dir, '2026-08-02-review', 'proposed-changes.md'),
    '# Proposed changes\n\n**Five changes.**\n\nProse only.\n',
  )
  fs.writeFileSync(path.join(dir, '2026-07-21-review.md'), '# Older Review\n\n**Thesis.**\n')
  return dir
}

test('cards are newest first, with a companion card for ranked changes', () => {
  const dir = fixtureTree()
  const cards = collectCards(dir, ['2026-07-21-review', '2026-08-02-review'])

  assert.deepEqual(cards.map((c) => c.href), [
    'html/2026-08-02-review/index.html',
    'html/2026-08-02-review/proposed-changes.html',
    'html/2026-07-21-review/index.html',
  ])
  // The companion card sits directly below its report, not at the end of the list.
  assert.equal(cards[1].title, 'Proposed changes')
  assert.equal(cards[1].go, 'open changes →')
  assert.deepEqual(cards[1].stats, [], 'a prose-only changes page gets no invented figures')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('the companion card falls back to the report scope when it has no eyebrow', () => {
  const dir = fixtureTree()
  const cards = collectCards(dir, ['2026-08-02-review'])
  assert.match(cards[1].kicker, /ranked changes$/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('renderLandingPage links explicit index.html, never a bare directory', () => {
  const dir = fixtureTree()
  const html = renderLandingPage(dir, ['2026-07-21-review', '2026-08-02-review'])

  // A trailing-slash directory link relies on server-side index resolution: fine on
  // GitHub Pages, silently broken over file://.
  assert.ok(!/href="html\/[^"]*\/"/.test(html), 'no bare directory links')
  assert.match(html, /href="html\/2026-08-02-review\/index\.html"/)
  // Every report is listed, so none is orphaned.
  assert.match(html, /href="html\/2026-07-21-review\/index\.html"/)
  assert.match(html, /Keep this repository private/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('renderLandingPage links theme.css only when the tree has one', () => {
  const dir = fixtureTree()
  assert.ok(!renderLandingPage(dir, []).includes('theme.css'), 'no dangling stylesheet link')

  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'assets', 'theme.css'), ':root{}')
  assert.match(renderLandingPage(dir, []), /href="assets\/theme\.css"/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('renderLandingPage is reproducible across runs', () => {
  // The property the hand-transcribed page never had.
  const dir = fixtureTree()
  const slugs = ['2026-07-21-review', '2026-08-02-review']
  assert.equal(renderLandingPage(dir, slugs), renderLandingPage(dir, slugs))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('report titles and labels are HTML-escaped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-landing-esc-'))
  fs.writeFileSync(
    path.join(dir, '2026-08-02-x.md'),
    [
      '# Tokens & <Costs>',
      '',
      '**Thesis.**',
      '',
      '<div class="metric-grid">',
      '  <div class="metric">',
      '    <p class="label">Cost & Fees</p>',
      '    <div class="value">5</div>',
      '  </div>',
      '</div>',
      '',
    ].join('\n'),
  )
  const html = renderLandingPage(dir, ['2026-08-02-x'])
  assert.match(html, /<h3>Tokens &amp; &lt;Costs&gt;<\/h3>/)
  // A stat's label reaches the card raw from the report; renderCard must escape it same
  // as the title, or a `&` in a metric label breaks the card markup.
  assert.match(html, /<span>Cost &amp; Fees<\/span>/)
  fs.rmSync(dir, { recursive: true, force: true })
})

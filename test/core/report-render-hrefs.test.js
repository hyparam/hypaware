// @ts-check

/**
 * The `rewrite_hrefs` case table: the specification the Node renderer is ported against.
 *
 * @ref LLP 0197#t12-constraint-inventory [tests]: written before the port, because the
 * shell original has no tests and its failure mode is silent
 *
 * `build.sh` rewrites `.md` hrefs to `.html` on the EMITTED HTML rather than on the
 * Markdown, which is what catches Markdown-syntax links and links inside raw-HTML
 * components (rec cards, callouts) in one uniform pass. It does so with four BSD `sed`
 * expressions applied in sequence, where the order is load-bearing: the own-section
 * rule has to run before the other-report rule or every own-section link acquires a
 * spurious `../<slug>/` prefix.
 *
 * A missed case here does not crash. It ships a page with a dead link that renders
 * perfectly and only fails when a reader clicks it, which is why the cases are pinned
 * before the port rather than after.
 *
 * Two exclusions matter as much as the rewrites:
 *   - `:` is excluded from every character class, so absolute URLs (`https://…/x.md`)
 *     are left alone.
 *   - `data-src` is not `href`, so the "Copy as Markdown" buttons keep pointing at the
 *     raw `.md` sidecars that the renderer deliberately ships next to each page.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { rewriteHrefs } from '../../src/core/reports/render.js'

const SLUG = '2026-08-02-usage-review'
const OTHER = '2026-07-21-usage-review'

/** @type {{ name: string, kind: 'index' | 'section', input: string, want: string }[]} */
const CASES = [
  // ---- one-pager (html/<slug>/index.html), built from <slug>.md ----
  {
    name: 'index: own section flattens, losing the slug directory',
    kind: 'index',
    input: `<a href="${SLUG}/trends.md">trends</a>`,
    want: '<a href="trends.html">trends</a>',
  },
  {
    name: 'index: own section keeps its fragment',
    kind: 'index',
    input: `<a href="${SLUG}/trends.md#weekly">trends</a>`,
    want: '<a href="trends.html#weekly">trends</a>',
  },
  {
    name: 'index: another report\'s section routes up and back down',
    kind: 'index',
    input: `<a href="${OTHER}/trends.md">last time</a>`,
    want: `<a href="../${OTHER}/trends.html">last time</a>`,
  },
  {
    name: 'index: another report\'s one-pager resolves to its index',
    kind: 'index',
    input: `<a href="${OTHER}.md">previous review</a>`,
    want: `<a href="../${OTHER}/index.html">previous review</a>`,
  },
  {
    name: 'index: another report\'s one-pager keeps its fragment',
    kind: 'index',
    input: `<a href="${OTHER}.md#key-metrics">previous</a>`,
    want: `<a href="../${OTHER}/index.html#key-metrics">previous</a>`,
  },

  // ---- section page (html/<slug>/<section>.html), built from <slug>/<section>.md ----
  {
    name: 'section: back-reference to its own one-pager becomes index.html',
    kind: 'section',
    input: `<a href="../${SLUG}.md">back</a>`,
    want: '<a href="index.html">back</a>',
  },
  {
    name: 'section: back-reference keeps its fragment',
    kind: 'section',
    input: `<a href="../${SLUG}.md#key-findings">back</a>`,
    want: '<a href="index.html#key-findings">back</a>',
  },
  {
    name: 'section: another report\'s one-pager resolves to its index',
    kind: 'section',
    input: `<a href="../${OTHER}.md">previous</a>`,
    want: `<a href="../${OTHER}/index.html">previous</a>`,
  },
  {
    name: 'section: another report\'s section keeps its own path',
    kind: 'section',
    input: `<a href="../${OTHER}/trends.md">their trends</a>`,
    want: `<a href="../${OTHER}/trends.html">their trends</a>`,
  },
  {
    name: 'section: a sibling section in the same report stays flat',
    kind: 'section',
    input: '<a href="work-types.md">work types</a>',
    want: '<a href="work-types.html">work types</a>',
  },

  // ---- things that must NOT be rewritten ----
  {
    name: 'index: an absolute URL ending in .md is left alone',
    kind: 'index',
    input: '<a href="https://example.com/docs/readme.md">upstream</a>',
    want: '<a href="https://example.com/docs/readme.md">upstream</a>',
  },
  {
    name: 'section: an absolute URL ending in .md is left alone',
    kind: 'section',
    input: '<a href="https://example.com/docs/readme.md">upstream</a>',
    want: '<a href="https://example.com/docs/readme.md">upstream</a>',
  },
  {
    name: 'index: data-src is not href, so copy buttons keep their raw .md target',
    kind: 'index',
    input: '<a href="#" class="copy-md" data-src="full.md">Copy report as Markdown</a>',
    want: '<a href="#" class="copy-md" data-src="full.md">Copy report as Markdown</a>',
  },
  {
    name: 'section: data-src is not href, so copy buttons keep their raw .md target',
    kind: 'section',
    input: '<a href="#" class="copy-md" data-src="trends.md">Copy page as Markdown</a>',
    want: '<a href="#" class="copy-md" data-src="trends.md">Copy page as Markdown</a>',
  },
  {
    name: 'index: a non-markdown asset link is untouched',
    kind: 'index',
    input: '<link rel="stylesheet" href="assets/style.css">',
    want: '<link rel="stylesheet" href="assets/style.css">',
  },
]

for (const { name, kind, input, want } of CASES) {
  test(`rewriteHrefs ${name}`, () => {
    assert.equal(rewriteHrefs(input, SLUG, kind), want)
  })
}

test('rewriteHrefs rewrites links inside raw-HTML components, not just Markdown links', () => {
  // The whole reason the rewrite runs on emitted HTML: a rec card's href never passed
  // through the Markdown link syntax at all.
  const card = `<a class="rec" href="${SLUG}/proposed-changes.md"><h3>Proposed changes</h3></a>`
  assert.equal(
    rewriteHrefs(card, SLUG, 'index'),
    '<a class="rec" href="proposed-changes.html"><h3>Proposed changes</h3></a>',
  )
})

test('rewriteHrefs handles every occurrence on a line, not just the first', () => {
  const input = `<a href="${SLUG}/a.md">a</a> and <a href="${SLUG}/b.md">b</a>`
  assert.equal(rewriteHrefs(input, SLUG, 'index'), '<a href="a.html">a</a> and <a href="b.html">b</a>')
})

test('rewriteHrefs treats a slug with regex metacharacters literally', () => {
  // Slugs are date-prefixed and dash-separated today, so this is defensive: the shell
  // original interpolated $slug into a regex unescaped.
  const odd = 'report.v2+draft'
  assert.equal(
    rewriteHrefs(`<a href="${odd}/sec.md">s</a>`, odd, 'index'),
    '<a href="sec.html">s</a>',
  )
})

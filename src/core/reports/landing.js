// @ts-check

/**
 * The top-level `index.html` landing page.
 *
 * @ref LLP 0196#the-inversion [implements]: page scaffolding is deterministic and
 * belongs in code; it was the one part of the site a model rebuilt by hand every run
 *
 * `build.sh` never generated this, so the skill transcribed a 50-line template out of
 * `components.md` on every run. That made the landing page the least reproducible file
 * in the tree and the easiest to lose: it is derived output that behaved like a source
 * file, and nothing rebuilt it if it went missing.
 *
 * Everything here is read from the reports themselves. Where a value cannot be derived,
 * it is omitted rather than invented, which is the same rule the report skills are held
 * to ("never invents, recomputes, or reinterprets"). Concretely: a card carries a stat
 * row only if its report actually has a `metric-grid`, so a proposed-changes page made
 * of prose gets a card with no figures instead of figures someone made up.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * @import { LandingCard, LandingStat } from '../../../src/core/reports/types.js'
 */

/** @param {string} text */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Strip tags and collapse whitespace: turns `9.01<small>B</small>` into `9.01B`. */
function plainText(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * The report's own scope line, used as the card's eyebrow. Authors write it as an
 * `eyebrow` paragraph above the title; older reports used an italic `*Source: …*` line
 * or an `## <server> · <window>` subtitle.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function extractKicker(markdown) {
  const eyebrow = markdown.match(/<p class="eyebrow">([\s\S]*?)<\/p>/)
  if (eyebrow) return plainText(eyebrow[1])

  const italic = markdown.match(/^\*(Source:[^*]+)\*\s*$/m)
  if (italic) return plainText(italic[1])

  const subtitle = markdown.match(/^## +(.+·.+)$/m)
  if (subtitle) return plainText(subtitle[1])

  return ''
}

/**
 * The report's title, from its first `# ` heading.
 *
 * Whitespace is collapsed but angle brackets are left alone: a heading is Markdown, not
 * HTML, so a title like `Tokens & <Costs>` is literal text that must survive to be
 * escaped at render. Tag-stripping it here would silently truncate the title instead.
 * Labels and kickers do strip markup, because those are read out of raw-HTML component
 * blocks where any inline tags are decoration a card should not inherit.
 *
 * @param {string} markdown
 * @param {string} fallback
 */
export function extractTitle(markdown, fallback) {
  const match = markdown.match(/^# +(.*)$/m)
  return match ? match[1].replace(/\s+/g, ' ').trim() : fallback
}

/**
 * The report's headline numbers, taken from its `metric-grid` in source order with each
 * value and judgment kept exactly. Labels are used verbatim: compressing them to "2-4
 * plain words" is an editorial judgment, and a renderer that rewrote them would be
 * writing copy rather than deriving it.
 *
 * @param {string} markdown
 * @param {number} limit
 * @returns {LandingStat[]}
 */
export function extractStats(markdown, limit = 4) {
  // Split rather than match: a `metric` block contains a nested `<div class="value">`,
  // so any lazy `[\s\S]*?…</div>` pattern stops at the inner close and yields one stat
  // per report instead of four. Each chunk runs to the next metric, which is all the
  // scope the label and value lookups need.
  const chunks = markdown.split(/<div class="metric(?!-grid)/).slice(1)

  /** @type {LandingStat[]} */
  const stats = []
  for (const chunk of chunks) {
    const classAttr = chunk.slice(0, chunk.indexOf('>'))
    const label = chunk.match(/<p class="label">([\s\S]*?)<\/p>/)
    // `value` holds inline markup only (`9.01<small>B</small>`), never a nested div.
    const value = chunk.match(/<div class="value">([\s\S]*?)<\/div>/)
    if (!label || !value) continue
    stats.push({
      // Both forms: the authored markup renders (a `<small>` unit is spaced by CSS, so
      // flattening it turns "20 days" into "20days"), the plain text is what tests read.
      valueHtml: value[1].trim(),
      value: plainText(value[1]),
      label: plainText(label[1]),
      judgment: (classAttr.match(/is-(crit|warn|good)/) || [])[1] ?? '',
    })
    if (stats.length >= limit) break
  }
  return stats
}

/**
 * One card per report, newest first, plus a companion card for any report carrying a
 * `proposed-changes.md` section page. The ranked changes are a first-class destination,
 * not something reachable only by opening the report first.
 *
 * @param {string} dir
 * @param {string[]} slugs
 * @returns {LandingCard[]}
 */
export function collectCards(dir, slugs) {
  /** @type {LandingCard[]} */
  const cards = []
  // Slugs are `YYYY-MM-DD-…`, so descending string order is newest-first. Undated slugs
  // sort among them rather than being dropped.
  for (const slug of [...slugs].sort().reverse()) {
    const source = fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8')
    cards.push({
      href: `html/${slug}/index.html`,
      kicker: extractKicker(source),
      title: extractTitle(source, slug),
      stats: extractStats(source),
      go: 'open report →',
    })

    const changes = path.join(dir, slug, 'proposed-changes.md')
    if (!fs.existsSync(changes)) continue
    const changesSource = fs.readFileSync(changes, 'utf8')
    cards.push({
      href: `html/${slug}/proposed-changes.html`,
      kicker: extractKicker(changesSource) || `${extractKicker(source)} · ranked changes`,
      title: extractTitle(changesSource, 'Proposed changes'),
      // Often prose-only, in which case it gets no stat row rather than invented ones.
      stats: extractStats(changesSource, 3),
      go: 'open changes →',
    })
  }
  return cards
}

/** @param {LandingCard} card */
function renderCard(card) {
  const stats = card.stats
    .map(
      (stat) =>
        `      <div class="rec-stat${stat.judgment ? ` ${stat.judgment}` : ''}">` +
        `<b>${stat.valueHtml}</b><span>${escapeHtml(stat.label)}</span></div>`,
    )
    .join('\n')

  return [
    `  <a class="rec" href="${card.href}">`,
    card.kicker ? `    <p class="rec-kind">${escapeHtml(card.kicker)}</p>` : '',
    `    <h3>${escapeHtml(card.title)}</h3>`,
    stats ? `    <div class="rec-stats">\n${stats}\n    </div>` : '',
    `    <p class="rec-go">${card.go}</p>`,
    '  </a>',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Render the landing page. Every report is listed, so nothing is orphaned, and each is
 * linked by its explicit `index.html`: a bare directory URL relies on server-side index
 * resolution, which works on GitHub Pages and silently breaks over `file://`.
 *
 * @param {string} dir
 * @param {string[]} slugs
 * @returns {string}
 */
export function renderLandingPage(dir, slugs) {
  const cards = collectCards(dir, slugs)
  // Linked only when it exists: an unconditional link 404s on every tree without one.
  const theme = fs.existsSync(path.join(dir, 'assets', 'theme.css'))
    ? '\n<link rel="stylesheet" href="assets/theme.css">'
    : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HypAware Reports</title>
<link rel="stylesheet" href="assets/style.css">${theme}
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
<link rel="icon" type="image/png" sizes="64x64" href="assets/favicon.png">
</head>
<body>
<header class="masthead">
<span class="brand"><span class="brand-mark"></span>Hyperparam</span>
<span class="doc-label">Internal reports · generated from HypAware data</span>
</header>

<p class="eyebrow">HypAware · fleet analyses</p>
<h1>HypAware Reports</h1>
<p>Fleet analyses generated from HypAware AI-gateway recordings. Each report is self-contained.</p>

<div class="rec-list">
${cards.map(renderCard).join('\n')}
</div>

<div class="callout warn">
  <span class="tag">Internal</span>
  <p class="body">Contains gateway IDs, usernames, repo paths, and token volumes. Keep this repository private.</p>
</div>
</body>
</html>
`
}

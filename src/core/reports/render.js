// @ts-check

/**
 * The HypAware report renderer, ported from `build.sh`.
 *
 * @ref LLP 0193#mechanics-as-code [implements]: rendering is repo-owned, testable code
 * the skill calls, not prose the skill re-derives on every run
 *
 * The shell original is macOS-only (`sed -E -i ''` is the BSD spelling, and `sips`
 * regenerates the PNG favicon), which meant the renderer could not run in CI at all:
 * `.github/workflows/ci.yml` is `ubuntu-latest`. Nothing here shells out to either.
 * pandoc is still a hard dependency (LLP 0193 open question 1, resolved: keep it, and
 * install it in CI).
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import { renderLandingPage } from './landing.js'

/**
 * @import { RenderOptions, RenderResult } from '../../../src/core/reports/types.js'
 */

const ASSET_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'assets')

/** Installed at the tree root. The PNG ships prebuilt, so `sips` is not needed. */
const TREE_ASSETS = ['style.css', 'copy-md.js', 'head.html', 'favicon.svg', 'favicon.png']

/**
 * Copied beside every built page. `head.html` is deliberately absent: pandoc inlines it
 * into each page's `<head>` via `-H`, so shipping it as a page asset would be dead
 * weight in every output directory.
 */
const PAGE_ASSETS = ['style.css', 'favicon.svg', 'favicon.png', 'copy-md.js']

/** @param {string} literal */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rewrite `.md` hrefs to `.html` for the flattened `html/<slug>/` layout.
 *
 * @ref LLP 0194#t12-constraint-inventory [implements]: pinned by the case table in
 * test/core/report-render-hrefs.test.js before this was written
 *
 * Operates on emitted HTML, not Markdown, so Markdown-syntax links and raw-HTML
 * component links (rec cards, callouts) are handled in one pass. The rules apply in
 * sequence and the ORDER IS LOAD-BEARING: on a one-pager, own-section links must be
 * flattened before the general other-report rule runs, or every one of them picks up a
 * spurious `../<slug>/` prefix.
 *
 * `:` is excluded from every character class so absolute URLs are left alone, and only
 * `href` is touched, so the copy buttons' `data-src` keeps pointing at the raw `.md`
 * sidecars.
 *
 * @param {string} html
 * @param {string} slug
 * @param {'index' | 'section'} kind
 * @returns {string}
 */
export function rewriteHrefs(html, slug, kind) {
  const s = escapeRegExp(slug)

  if (kind === 'index') {
    return html
      // own section: <slug>/x.md -> x.html
      .replace(new RegExp(`href="${s}/([^":#]+)\\.md(#[^"]*)?"`, 'g'), (_m, p, frag = '') => `href="${p}.html${frag}"`)
      // another report's section: o/y.md -> ../o/y.html
      .replace(/href="([^"/:#]+)\/([^"/:#]+)\.md(#[^"]*)?"/g, (_m, a, b, frag = '') => `href="../${a}/${b}.html${frag}"`)
      // another report's one-pager: o.md -> ../o/index.html
      .replace(/href="([^"/:#]+)\.md(#[^"]*)?"/g, (_m, a, frag = '') => `href="../${a}/index.html${frag}"`)
  }

  return html
    // back to its own one-pager: ../<slug>.md -> index.html
    .replace(new RegExp(`href="\\.\\./${s}\\.md(#[^"]*)?"`, 'g'), (_m, frag = '') => `href="index.html${frag}"`)
    // another report's one-pager: ../o.md -> ../o/index.html
    .replace(/href="\.\.\/([^"/:#]+)\.md(#[^"]*)?"/g, (_m, a, frag = '') => `href="../${a}/index.html${frag}"`)
    // another report's section: ../o/y.md -> ../o/y.html
    .replace(/href="\.\.\/([^"/:#]+)\/([^"/:#]+)\.md(#[^"]*)?"/g, (_m, a, b, frag = '') => `href="../${a}/${b}.html${frag}"`)
    // a sibling section in the same report: y.md -> y.html
    .replace(/href="([^"/:#]+)\.md(#[^"]*)?"/g, (_m, a, frag = '') => `href="${a}.html${frag}"`)
}

/**
 * The page title: the first `# ` heading, else the fallback.
 *
 * @param {string} markdown
 * @param {string} fallback
 */
export function pageTitle(markdown, fallback) {
  const match = markdown.match(/^# +(.*)$/m)
  return match ? match[1].trim() : fallback
}

/**
 * The masthead doc label. A dated slug states its date, so a reader can tell a generated
 * static report from the HypAware app.
 *
 * @param {string} slug
 */
export function docLabel(slug) {
  return /^\d{4}-\d{2}-\d{2}-/.test(slug)
    ? `Internal report · generated ${slug.slice(0, 10)} from HypAware data`
    : 'Internal report · generated from HypAware data'
}

/**
 * @param {string} nav inner HTML for the right-hand slot
 * @param {string} label
 */
export function masthead(nav, label) {
  return (
    '<header class="masthead">\n' +
    '<span class="brand"><span class="brand-mark"></span>Hyperparam</span>\n' +
    `<span class="doc-label">${label}</span>\n` +
    `<nav class="topnav">${nav}</nav>\n` +
    '</header>\n\n'
  )
}

/**
 * Report slugs in a reports tree: every top-level `<slug>.md` except README.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function discoverReports(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => name.slice(0, -3))
    .sort()
}

/**
 * Section files belonging to a report, in the order the shell glob produced.
 *
 * @param {string} dir
 * @param {string} slug
 * @returns {string[]}
 */
export function discoverSections(dir, slug) {
  const sectionDir = path.join(dir, slug)
  if (!fs.existsSync(sectionDir) || !fs.statSync(sectionDir).isDirectory()) return []
  return fs
    .readdirSync(sectionDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
}

/**
 * @param {string} markdown
 * @param {string} nav
 * @param {string} label
 * @param {string} title
 * @param {string} cwd
 */
function pandocPage(markdown, nav, label, title, cwd) {
  return execFileSync(
    'pandoc',
    [
      '-f', 'gfm',
      '-t', 'html5',
      '-s',
      '--css', 'assets/style.css',
      '-H', 'assets/head.html',
      '--metadata', `pagetitle=${title}`,
    ],
    { cwd, input: masthead(nav, label) + markdown, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
}

/**
 * Build the static site for a reports tree. `html/` is wiped and rebuilt every run, so a
 * deleted or renamed report never leaves stale HTML behind.
 *
 * @param {RenderOptions} options
 * @returns {RenderResult}
 */
export function renderReports(options) {
  const dir = path.resolve(options.dir)

  if (!hasPandoc()) throw new Error('pandoc not found (brew install pandoc / apt-get install pandoc)')

  const assetsDir = path.join(dir, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })
  installAssets(assetsDir, options.refreshAssets !== false)

  const htmlDir = path.join(dir, 'html')
  fs.rmSync(htmlDir, { recursive: true, force: true })
  fs.mkdirSync(htmlDir, { recursive: true })
  fs.writeFileSync(path.join(htmlDir, '.nojekyll'), '')

  const slugs = discoverReports(dir)
  for (const slug of slugs) {
    buildReport(dir, htmlDir, slug)
  }

  // @ref LLP 0193#the-inversion [implements]: the landing page is derived output, so it
  // is rebuilt from the report set every run rather than hand-maintained
  fs.writeFileSync(path.join(dir, 'index.html'), renderLandingPage(dir, slugs))

  return { reports: slugs.length, slugs }
}

/**
 * @ref LLP 0193#theme-layer [implements]: the base sheet is the command's and always
 * refreshed; theme.css is the user's and never touched after it is created
 *
 * Splitting ownership this way removes an undecidable call. The skill used to guess
 * whether a modified `style.css` was a customization or a stale sheet, by looking for a
 * webfont import or a missing rule, which misclassified the most obvious customization
 * (wanting a webfont) as rot. Now the base is unambiguously ours and the theme is
 * unambiguously theirs.
 *
 * @param {string} assetsDir
 * @param {boolean} refresh
 */
function installAssets(assetsDir, refresh) {
  for (const asset of TREE_ASSETS) {
    const dest = path.join(assetsDir, asset)
    if (refresh || !fs.existsSync(dest)) fs.copyFileSync(path.join(ASSET_DIR, asset), dest)
  }

  // Created once, then never written again. It exists even when empty so the stylesheet
  // link in head.html never dangles, and so the extension point is discoverable: a user
  // finds the file rather than having to know overrides are supported.
  const theme = path.join(assetsDir, 'theme.css')
  if (!fs.existsSync(theme)) fs.writeFileSync(theme, THEME_STUB)
}

/**
 * The starting `theme.css`. Comments only, so it changes nothing until edited.
 * Names real custom properties, because a blank file does not tell you what is
 * overridable and the base sheet is 15 KB to read.
 */
const THEME_STUB = `/* Your theme. This file is yours: HypAware creates it once and never
   overwrites it. It loads after the base stylesheet, so anything set here wins.

   Most restyling is a handful of custom properties. The base sheet defines these
   (and more) on :root, with a parallel dark-mode block:

   :root {
     --fg: #191817;          ink
     --bg: #fcfcfb;          page
     --accent: #33465c;      wayfinding, neutral chart fill
     --good: #16691e;        judgment colours, used ONLY on numbers that carry one
     --warn: #8a5a00;
     --crit: #a53125;
     --s1 .. --s4:           chart identity ramp, dark to light
     --body / --display / --mono:  type stacks
     --max: 860px;           content width
   }

   Example:

   :root { --accent: #6b4fa0; --max: 960px; }
   @media (prefers-color-scheme: dark) { :root { --accent: #b9a3e3; } }
*/
`

/** @param {string} dir @param {string} htmlDir @param {string} slug */
function buildReport(dir, htmlDir, slug) {
  const out = path.join(htmlDir, slug)
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true })
  for (const asset of PAGE_ASSETS) {
    fs.copyFileSync(path.join(dir, 'assets', asset), path.join(out, 'assets', asset))
  }
  // Always present after installAssets, and linked from every page by head.html.
  fs.copyFileSync(path.join(dir, 'assets', 'theme.css'), path.join(out, 'assets', 'theme.css'))
  fs.writeFileSync(path.join(out, '.nojekyll'), '')

  const label = docLabel(slug)
  const source = fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8')
  const sections = discoverSections(dir, slug)

  // Raw Markdown beside the built pages: what the masthead copy buttons fetch. These
  // keep their .md links on purpose, so rewriteHrefs never touches them.
  fs.writeFileSync(path.join(out, 'index.md'), source)
  const full = [source, ...sections.map((s) => fs.readFileSync(path.join(dir, slug, s), 'utf8'))]
  fs.writeFileSync(path.join(out, 'full.md'), full.join('\n\n---\n\n'))

  const indexNav =
    '<a href="../../index.html">&#8592; All reports</a> ' +
    '<a href="#" class="copy-md" data-src="full.md">Copy report as Markdown</a>'
  const indexHtml = pandocPage(source, indexNav, label, pageTitle(source, slug), dir)
  fs.writeFileSync(path.join(out, 'index.html'), rewriteHrefs(indexHtml, slug, 'index'))

  for (const section of sections) {
    const base = section.slice(0, -3)
    const text = fs.readFileSync(path.join(dir, slug, section), 'utf8')
    fs.writeFileSync(path.join(out, section), text)
    const nav =
      '<a href="index.html">&#8592; Back to the report</a> ' +
      `<a href="#" class="copy-md" data-src="${base}.md">Copy page as Markdown</a>`
    const html = pandocPage(text, nav, label, pageTitle(text, base), dir)
    fs.writeFileSync(path.join(out, `${base}.html`), rewriteHrefs(html, slug, 'section'))
  }
}

/** @returns {boolean} */
export function hasPandoc() {
  try {
    execFileSync('pandoc', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// @ts-check

/**
 * The HypAware report renderer, ported from `build.sh`.
 *
 * @ref LLP 0196#mechanics-as-code [implements]: rendering is repo-owned, testable code
 * the skill calls, not prose the skill re-derives on every run
 *
 * The shell original is macOS-only (`sed -E -i ''` is the BSD spelling, and `sips`
 * regenerates the PNG favicon), which meant the renderer could not run in CI at all:
 * `.github/workflows/ci.yml` is `ubuntu-latest`. Nothing here shells out to anything:
 * Markdown converts in process via `marked` (LLP 0208, superseding LLP 0196 open
 * question 1's keep-pandoc resolution). The one pandoc property the component
 * vocabulary relied on, gfm passing raw HTML through untouched, is marked's default
 * behavior, measured across a real reports tree before the swap
 * (hypaware-server LLP 0110).
 */

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import { Marked } from 'marked'

import { renderLandingPage } from './landing.js'

/**
 * @import { RenderOptions, RenderResult } from '../../../src/core/reports/types.js'
 */

const ASSET_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'assets')

/** Installed at the tree root. The PNG ships prebuilt, so `sips` is not needed. */
const TREE_ASSETS = ['style.css', 'copy-md.js', 'head.html', 'favicon.svg', 'favicon.png']

/**
 * Copied beside every built page. `head.html` is deliberately absent: it is inlined
 * into each page's `<head>` at render time, so shipping it as a page asset would be
 * dead weight in every output directory.
 */
const PAGE_ASSETS = ['style.css', 'favicon.svg', 'favicon.png', 'copy-md.js']

/** @param {string} literal */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rewrite `.md` hrefs to `.html` for the flattened `html/<slug>/` layout.
 *
 * @ref LLP 0197#t12-constraint-inventory [implements]: pinned by the case table in
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

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * name -> Unicode codepoint, for the named character references pandoc's reader
 * recognizes. This is the classic bounded "HTML4" set (Latin-1, Greek, general
 * punctuation and symbols) PLUS the HTML5 names for ASCII punctuation, not the
 * full ~2200-entry HTML5 spec table, whose remainder is mostly MathML additions
 * nobody hand-types in report prose. The ASCII-punctuation block is the part of
 * HTML5 an author does reach for: `&apos;` is the standard apostrophe reference
 * and lands in `What&apos;s next`, the very heading this decoder exists to slug
 * as pandoc's `whats-next` rather than `whataposs-next`. Matching is
 * case-sensitive against pandoc, checked against pandoc 3.1.11: `&AMP;` decodes
 * (a legacy dual-case alias pandoc's own table carries) but `&MDASH;` and
 * `&RSQUO;` do not, so a blind case-fold would wrongly decode those AND collide
 * distinct entries that only differ by case (`&Alpha;` U+0391 vs `&alpha;`
 * U+03B1). Values are codepoints, not literal characters, so no entity's
 * decoded character needs to appear as a literal in this source file.
 */
const NAMED_ENTITIES = {
  // Latin-1
  nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165, brvbar: 166, sect: 167,
  uml: 168, copy: 169, ordf: 170, laquo: 171, not: 172, shy: 173, reg: 174, macr: 175,
  deg: 176, plusmn: 177, sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182, middot: 183,
  cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188, frac12: 189, frac34: 190, iquest: 191,
  Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197, AElig: 198, Ccedil: 199,
  Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205, Icirc: 206, Iuml: 207,
  ETH: 208, Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214, times: 215,
  Oslash: 216, Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221, THORN: 222, szlig: 223,
  agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228, aring: 229, aelig: 230, ccedil: 231,
  egrave: 232, eacute: 233, ecirc: 234, euml: 235, igrave: 236, iacute: 237, icirc: 238, iuml: 239,
  eth: 240, ntilde: 241, ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246, divide: 247,
  oslash: 248, ugrave: 249, uacute: 250, ucirc: 251, uuml: 252, yacute: 253, thorn: 254, yuml: 255,
  // Greek and symbols
  fnof: 402, Alpha: 913, Beta: 914, Gamma: 915, Delta: 916, Epsilon: 917, Zeta: 918, Eta: 919,
  Theta: 920, Iota: 921, Kappa: 922, Lambda: 923, Mu: 924, Nu: 925, Xi: 926, Omicron: 927,
  Pi: 928, Rho: 929, Sigma: 931, Tau: 932, Upsilon: 933, Phi: 934, Chi: 935, Psi: 936,
  Omega: 937, alpha: 945, beta: 946, gamma: 947, delta: 948, epsilon: 949, zeta: 950, eta: 951,
  theta: 952, iota: 953, kappa: 954, lambda: 955, mu: 956, nu: 957, xi: 958, omicron: 959,
  pi: 960, rho: 961, sigmaf: 962, sigma: 963, tau: 964, upsilon: 965, phi: 966, chi: 967,
  psi: 968, omega: 969, thetasym: 977, upsih: 978, piv: 982, bull: 8226, hellip: 8230, prime: 8242,
  Prime: 8243, oline: 8254, frasl: 8260, weierp: 8472, image: 8465, real: 8476, trade: 8482,
  alefsym: 8501, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629,
  lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660, forall: 8704, part: 8706, exist: 8707,
  empty: 8709, nabla: 8711, isin: 8712, notin: 8713, ni: 8715, prod: 8719, sum: 8721, minus: 8722,
  lowast: 8727, radic: 8730, prop: 8733, infin: 8734, ang: 8736, and: 8743, or: 8744, cap: 8745,
  cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773, asymp: 8776, ne: 8800, equiv: 8801,
  le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836, sube: 8838, supe: 8839, oplus: 8853,
  otimes: 8855, perp: 8869, sdot: 8901, lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971,
  lang: 9001, rang: 9002, loz: 9674, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
  // Typography and legacy uppercase aliases
  quot: 34, amp: 38, lt: 60, gt: 62, OElig: 338, oelig: 339, Scaron: 352, scaron: 353,
  Yuml: 376, circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205,
  lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218,
  ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, permil: 8240, lsaquo: 8249,
  rsaquo: 8250, euro: 8364,
  AMP: 38, LT: 60, GT: 62, QUOT: 34, COPY: 169, REG: 174,
  // ASCII punctuation (HTML5). Every one measured against pandoc 3.1.11: each decodes
  // to its character and then drops under the slug rule, so `A &excl; B` mints `a--b`,
  // where leaving the name intact would have leaked the letters as `a-excl-b`. `&Tab;`
  // and `&NewLine;` decode to whitespace and so mint a hyphen apiece (`a---b`), and
  // `&lowbar;` decodes to `_`, which the retained class keeps (`a-_-b`).
  apos: 39, Tab: 9, NewLine: 10, excl: 33, num: 35, dollar: 36, percnt: 37, lpar: 40,
  rpar: 41, ast: 42, plus: 43, comma: 44, period: 46, sol: 47, colon: 58, semi: 59,
  quest: 63, commat: 64, lbrack: 91, bsol: 92, rbrack: 93, Hat: 94, lowbar: 95,
  grave: 96, lbrace: 123, verbar: 124, rbrace: 125,
}

/**
 * The inverse of the escaping marked's inline parser has already applied by the time
 * a renderer override sees heading text, generalized to every entity form pandoc's
 * reader decodes rather than the five marked itself emits. Without it the slug rule
 * either keeps an entity's letters (`&amp;` -> `cost-amp-usage` for `Cost & Usage`) or,
 * for an entity marked never emits but an author writes by hand (`&rsquo;`, `&#x27;`),
 * lets the whole entity's letters and digits leak into the slug
 * (`what&rsquo;s next` -> `whatrsquos-next` instead of pandoc's `whats-next`).
 *
 * BOTH hex spellings are accepted. HTML and pandoc treat `&#X41;` exactly like
 * `&#x41;`, and marked's escaper passes the uppercase form through untouched
 * (its no-encode pattern spells the prefix `#[Xx]`), so an `x`-only alternative
 * here leaves the uppercase spelling to fall out undecoded and leak its digits:
 * `## A &#X41; B` minted `a-x41-b` where pandoc mints `a-a-b`.
 *
 * @param {string} value
 */
function unescapeHtml(value) {
  return value.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (entity, body) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(codePoint)) return entity
      // Above U+10FFFF is not a codepoint and `String.fromCodePoint` throws on it, which
      // would abort the whole render, not just this heading. The window is reachable:
      // marked's escaper passes numeric references of up to 7 decimal or 6 hex digits
      // through untouched, so every value in `&#x110000;`-`&#xFFFFFF;` (in either hex
      // spelling) and `&#1114112;`-`&#9999999;` arrives here verbatim from an authored
      // heading.
      // pandoc 3.1.11 substitutes U+FFFD, which the slug rule below then strips like any
      // other symbol, so `## A &#x110000; B` mints `a--b`; returning the entity intact
      // would instead leak its digits into the id. Lone surrogates stay on the
      // `fromCodePoint` path: it accepts them and pandoc slugs them to the same nothing.
      return codePoint > 0x10FFFF ? '\uFFFD' : String.fromCodePoint(codePoint)
    }
    const codePoint = NAMED_ENTITIES[body]
    return codePoint === undefined ? entity : String.fromCodePoint(codePoint)
  })
}

/**
 * pandoc-style heading id: lowercased, markup and punctuation stripped, spaces
 * to hyphens. Existing in-page anchors were minted by pandoc, so the slug rule
 * has to keep producing the same ids or every one of them dangles.
 *
 * @ref LLP 0208#heading-id-gaps [constrained-by]: parity is exact except for
 * Unicode separators/BOM and image alt text. The entity spellings of both
 * separators and BOM are reachable here, decoded by unescapeHtml above, and a
 * literal U+FEFF reaches here intact too, so the BOM case is fully fixable in
 * the rule below. The literal U+2028/U+2029 spellings are not: they break ABOVE
 * this function, in marked's block parser, which splits the block so no heading
 * is produced at all, and no rule-only fix can close that half. Image alt text
 * needs token types this function only sees as rendered HTML
 *
 * Every step's order is load-bearing, checked against pandoc 3.1.11 `-f gfm -t html5`:
 * tags come off BEFORE unescaping (or a decoded `<` is eaten by the tag regex);
 * AUTHORED whitespace runs collapse FIRST OF ALL, and so before entities decode,
 * before `<br>` yields its space, and before punctuation is dropped: pandoc's
 * reader collapses adjacent literal space characters, but a decoded entity or an
 * injected `<br>` space never merges with a real space next to it, so
 * `A  &nbsp;  B` (two real spaces on each side) mints `a---b`, three separate
 * hyphens for three separate whitespace tokens (space, the decoded &nbsp;, space),
 * not one. Collapsing before decode is what keeps a multi-word entity name like
 * `&nbsp;` from ever being mistaken for a run of authored spaces: entity
 * references never contain whitespace themselves, so the collapse is safe to run
 * on the pre-decode text. A dropped bare `&` (not an entity) leaves two adjacent
 * spaces where it stood and pandoc emits both hyphens, which is why the final
 * substitution is per space, not per run. text is NFC-normalized BEFORE
 * lowercasing: pandoc normalizes too, so a heading spelled with a decomposed base
 * letter plus combining mark still mints the same id as the precomposed spelling,
 * matching whichever form an authored in-page anchor used. Letters, digits AND
 * combining marks are kept: pandoc keeps `Café résumé`, `日本語`, and
 * Indic/Thai/Arabic/Hebrew/Vietnamese text, whose marks are `\p{M}` codepoints and
 * not decorative, intact; only emoji and ASCII punctuation are dropped. A decoded
 * space-like entity (`&nbsp;`, `&ensp;`, ...) is itself kept by the `\s` branch of
 * the retained class, same as a real space, so it survives to the final
 * per-space-to-hyphen step rather than being silently dropped.
 *
 * `<br>` is the one tag that yields a SPACE instead of vanishing, because pandoc's
 * reader turns it into a LineBreak and slugs that like any other whitespace token:
 * `## Line one<br/>Line two` mints `line-one-line-two`, not `line-oneline-two`, and
 * a `<br>`-only heading mints `-` rather than going without an id. The substitution
 * runs AFTER the collapse for the same reason a decoded entity does: the injected
 * space is its own token and must not merge with the authored spaces around it, so
 * `## A <br /> B` mints `a---b`, three hyphens. The match IS deliberately
 * `<br` PREFIX-matching, and it is deliberately case-SENSITIVE. Both halves are
 * measured, and the prefix half corrects an earlier reading of pandoc that had this
 * regex spelled `<br(?:\s[^>]*)?\/?>` "so it does not swallow `<brand>`": pandoc
 * swallows `<brand>` too. What pandoc's stringify actually keys on is the raw
 * inline's LEADING TEXT, not a parsed tag name, so ANY raw inline HTML token whose
 * text starts with `<br` becomes a space: `## A <brand> B`, `## A <bra> B`,
 * `## A <br-x> B` and `## A <breakfast time> B` all mint `a---b`, and only the open
 * tag counts, so `## A <brand>x</brand> B` mints `a--x-b` (the close tag's text
 * starts `</b`). The case-sensitivity is the other half of the same rule: `<BR>`,
 * `<Br>` and `<bR>` do not start with the lowercase prefix, so they stay raw inline
 * HTML contributing nothing and `## A <BR> B` mints `a--b`, one hyphen fewer. A tag
 * that merely starts with `b` is untouched too: `## A <b> B` and `## A <bold> B`
 * both mint `a--b`. The regex is safe to widen this far because it never sees a
 * string marked did not already accept as a tag: marked escapes invalid tag syntax
 * to entities before this runs (`## A <br@> B` arrives as `A &lt;br@&gt; B`, and
 * pandoc likewise leaves it as text, minting `a-br-b`).
 * Every OTHER tag still vanishes without a trace, which is why the collapse is what
 * moved ahead of the tag strip rather than the strip becoming a space: `<span>a</span>b`
 * must stay `ab` and `A<em>B</em>C` must stay `abc`. Running the collapse first also
 * stops a tag's own inner whitespace from being merged away, matching pandoc, which
 * counts the space inside `A <span> </span> B` as its own token and mints `a---b`.
 *
 * NOTHING TRIMS after the strip, because pandoc does not: the space a dropped
 * leading or trailing character leaves behind becomes a hyphen like any other, so
 * `## 🚀 Rollout plan` mints `-rollout-plan` and `## end &` mints `end-`
 * (both measured). Emoji-led headings are ordinary in model-authored reports, so a
 * trim here would silently dangle every pandoc-era `#-rollout-plan` anchor, which
 * is exactly the parity LLP 0208 promises to keep. A heading whose retained text is
 * all whitespace is not special-cased either: pandoc mints `-` for `## ( )` rather
 * than dropping the id, and only a heading that reduces to the truly empty string
 * (`## 🚀`) goes without one. Markdown's own reader has already trimmed the raw
 * heading line by the time this runs, so no authored outer whitespace survives to
 * be turned into a stray leading hyphen.
 *
 * @param {string} text heading text, possibly carrying inline HTML
 */
function headingId(text) {
  return unescapeHtml(
    text
      .replace(/\s+/g, ' ')
      .replace(/<br[^>]*>/g, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '')
    .replace(/\s/g, '-')
}

/**
 * One converter instance, configured once. gfm is the load-bearing option: it is
 * what passes the component vocabulary's raw HTML through byte-for-byte
 * (measured, indentation included), which is the property the whole authoring
 * contract stands on. The heading renderer adds the ids pandoc generated and
 * marked does not; a repeated heading gets a `-1` suffix like pandoc's. The cell
 * renderer restates column alignment as pandoc did, because marked's built-in
 * spells it `align="right"`, and a presentational attribute loses the cascade to
 * `style.css`'s `th, td { text-align: left }`: every right-aligned number column
 * would silently render left.
 *
 * @ref LLP 0208#pure-js [implements]: gfm to HTML in process, no subprocess, no binary dependency
 */
function createConverter() {
  const marked = new Marked({ gfm: true, breaks: false })
  /** @type {Map<string, number>} */
  const seen = new Map()
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        const base = headingId(inner)
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        const id = n === 0 ? base : `${base}-${n}`
        // A heading that reduces to nothing (an emoji-only heading, or an HTML comment
        // with no other text) mints an empty id. pandoc emits no id attribute at
        // all in that case; only a later duplicate of the same empty heading gets one
        // (pandoc's own de-dup counter running against the empty base, e.g. id="-1"),
        // since an unauthorable anchor is still worth disambiguating from a real one.
        const idAttr = id === '' ? '' : ` id="${id}"`
        return `<h${depth}${idAttr}>${inner}</h${depth}>\n`
      },
      tablecell(token) {
        const content = this.parser.parseInline(token.tokens)
        const tag = token.header ? 'th' : 'td'
        const open = token.align ? `<${tag} style="text-align: ${token.align};">` : `<${tag}>`
        return `${open}${content}</${tag}>\n`
      },
    },
  })
  return marked
}

/**
 * Render one page: masthead plus converted Markdown, wrapped in the standalone
 * document pandoc's `-s` used to emit. The base stylesheet is linked before the
 * inlined `head.html` on purpose: head.html links `theme.css`, and the theme
 * must load after the base sheet so user overrides win (LLP 0196#theme-layer).
 *
 * @param {string} markdown
 * @param {string} nav
 * @param {string} label
 * @param {string} title
 * @param {string} dir the reports tree root, where `assets/head.html` lives
 */
function htmlPage(markdown, nav, label, title, dir) {
  const head = fs.readFileSync(path.join(dir, 'assets', 'head.html'), 'utf8').trimEnd()
  const body = createConverter().parse(masthead(nav, label) + markdown)
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(title)}</title>\n` +
    '<link rel="stylesheet" href="assets/style.css">\n' +
    `${head}\n` +
    '</head>\n<body>\n' +
    body +
    '</body>\n</html>\n'
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

  // @ref LLP 0196#the-inversion [implements]: the landing page is derived output, so it
  // is rebuilt from the report set every run rather than hand-maintained
  fs.writeFileSync(path.join(dir, 'index.html'), renderLandingPage(dir, slugs))

  return { reports: slugs.length, slugs }
}

/**
 * @ref LLP 0196#theme-layer [implements]: the base sheet is the command's and always
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
  const indexHtml = htmlPage(source, indexNav, label, pageTitle(source, slug), dir)
  fs.writeFileSync(path.join(out, 'index.html'), rewriteHrefs(indexHtml, slug, 'index'))

  for (const section of sections) {
    const base = section.slice(0, -3)
    const text = fs.readFileSync(path.join(dir, slug, section), 'utf8')
    fs.writeFileSync(path.join(out, section), text)
    const nav =
      '<a href="index.html">&#8592; Back to the report</a> ' +
      `<a href="#" class="copy-md" data-src="${base}.md">Copy page as Markdown</a>`
    const html = htmlPage(text, nav, label, pageTitle(text, base), dir)
    fs.writeFileSync(path.join(out, `${base}.html`), rewriteHrefs(html, slug, 'section'))
  }
}

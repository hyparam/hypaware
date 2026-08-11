# LLP 0208: The report renderer drops pandoc and converts in process

**Type:** decision
**Status:** Active
**Systems:** Reports, CLI
**Author:** Brendan / Claude
**Date:** 2026-08-10
**Related:** LLP 0196, LLP 0197; hypaware-server LLP 0110, LLP 0112

> Supersedes LLP 0196 open question 1's resolution ("keep pandoc, and install it
> in CI"). That resolution named its own escape hatch: the only pandoc property
> the component vocabulary relies on is gfm passing raw HTML through untouched,
> "so in-process rendering stays available if the dependency ever becomes a
> problem." It has become one.

## Context

The HypAware server now renders reports it generates itself (hypaware-server
LLP 0112), reusing this repo's renderer rather than growing a second one. That
put pandoc's costs on a new surface where they bite harder than they do on a
laptop:

- pandoc would be the server daemon's first non-npm binary dependency, on a
  runtime with a deliberate minimal-dependency posture.
- The renderer invokes it via `execFileSync`, which blocks the event loop of a
  single-threaded process that every customer org shares. Measured at ~40ms per
  page, a 27-page report freezes ingest and query serving for about a second.

hypaware-server LLP 0110 records that side's decision. This document records
this repo's half, because the code lives here and local `hyp report render`
changes with it.

## Decision

<a id="pure-js"></a>**Markdown converts to HTML in process via `marked`, and
pandoc is no longer used, checked for, or documented as a prerequisite.**
`marked` is pinned exact like every other dependency and has zero transitive
dependencies. The swap replaces one function: the standalone-document wrapper
pandoc's `-s` emitted is now an explicit template (charset, viewport, escaped
title, the base stylesheet link, then `assets/head.html` inlined, in that order
so `theme.css` keeps loading after the base sheet per
[LLP 0196#theme-layer](./0196-skills-state-constraints-not-procedures.rfc.md#theme-layer)).
Two renderer overrides restore what marked spells differently: heading ids,
`-1` suffixes on repeats included, so existing in-page anchors keep resolving
(exactly, but for the two narrow classes at [#heading-id-gaps](#heading-id-gaps));
and table cell alignment as pandoc's inline `style="text-align: ..."`, because
marked's built-in emits the presentational `align` attribute, which loses the
cascade to `assets/style.css`'s `th, td { text-align: left }` and would render
every right-aligned number column left.

**The substitution was measured before it was made** (hypaware-server LLP 0110,
`#gt-spike` in their LLP 0113): all 94 files of a real reports tree converted
under both engines; 66 structurally identical, 28 differing only in pandoc's
syntax-highlighting markup, 0 genuine differences. Component blocks survive
byte-for-byte, fenced artifacts stay verbatim with their `language-*` class,
and links match exactly. Table cells match once the alignment override above is
in place: unadorned marked emits `align="right"`, which is the same information
in markup the stylesheet outranks, so the spike's structural comparison rated
those tables equal while a browser would not have.

<a id="highlighting"></a>**Syntax highlighting is the one visible change, and
only in light mode.** pandoc emitted per-token spans; marked emits a plain
`<pre><code class="language-*">` block. The stylesheet's only token rules sit
inside its dark-mode block and flatten pandoc's spans to one colour anyway, so
dark mode is unchanged. The `language-*` class survives, so colour can return
as a stylesheet or renderer choice later without touching the contract.

## Consequences

- The render tests lose their skip guard and run everywhere: a renderer with no
  external dependency has no excuse for untested paths. CI drops its
  `apt-get install pandoc` step.
- `hyp report render` loses its pandoc preflight and error text; the skill's
  Render stage loses the prerequisite.
- The authoring contract's raw-HTML rules (blank-line separation, no Markdown
  inside a block) are gfm semantics, not pandoc quirks, and stand unchanged.
- Output is not byte-identical to pandoc's. Structure and content were measured
  equal; pixel-level review in a browser is part of landing this.
- <a id="footnotes"></a>**Footnotes stop rendering, and that is accepted.**
  pandoc's gfm reader enables its `footnotes` extension by default; marked's
  gfm does not implement footnotes at all, so `A claim.[^1]` now renders the
  literal `[^1]` as body text. The definition line degrades in one of two ways
  depending on its shape. A multi-token definition (`[^1]: some prose about the
  claim.`) is not valid link-reference syntax, so it survives as a literal
  paragraph. A SINGLE-token one (`[^1]: notes.md`) is instead parsed as a link
  reference definition: the definition line disappears from the output entirely
  and the `[^1]` reference becomes a live `<a href="notes.md">^1</a>`, which
  `rewriteHrefs` then rewrites to `notes.html` like any other `.md` link. Both
  shapes are wrong, and neither is worth a workaround here. No skill or
  authoring doc tells a report author to use footnotes and the measured tree
  contained none, so the exposure is a report that has not been written yet. A
  footnote extension is a dependency and a divergence of its own; if an author
  wants one, that is a new request.
- **Task lists keep their bullet unless the stylesheet suppresses it.** pandoc's
  template added a `task-list` class and a rule to hide the marker; marked emits
  a plain `<ul>` whose items start with a checkbox input, in one of two shapes: a
  "tight" list (no blank line between items) puts the checkbox directly in the
  `li`, a "loose" one (a blank line between items) wraps each item's content in a
  `p`, putting the checkbox at `li > p > input` instead. `assets/style.css`
  matches the list by what it contains, both shapes
  (`ul:has(> li > input[type="checkbox"], > li > p > input[type="checkbox"])`)
  rather than by a class the renderer no longer adds, so a checkbox item does not
  render with a bullet as well regardless of which shape it came in as.
- <a id="heading-id-gaps"></a>**Heading-id parity is exact except in two narrow
  classes, both left as they are on purpose.** The slug rule is pinned case by
  case against a real pandoc 3.1.11 binary, one heading per document so no
  de-dup counter drift can make a divergence read as parity. Two classes still
  diverge, and each is deferred because the fix does not live in the slug rule:
  - **Unicode separators and the BOM (U+2028, U+2029, U+FEFF).** JavaScript's
    `\s` matches all three where pandoc treats them as ordinary symbols and
    drops them, so the entity spellings mint one hyphen too many: `## A &#8232; B`
    mints `a---b` against pandoc's `a--b`. Fixing the slug rule would close only
    that half. The literal-authored spellings break further upstream, in marked's
    block parser, before any renderer override can see them: a literal U+2028 or
    U+2029 in a heading line splits the block so no heading (and so no id at all)
    is produced, and a literal U+FEFF welds its neighbours into `k-l`. A half fix
    that made the entity spelling right while the literal spelling still lost its
    heading outright would be worse than the honest gap.
  - **Image alt text.** pandoc slugs a Markdown image's alt text into the id and
    contributes nothing for a raw-HTML `<img>`: `## X ![alt text](i.png) Y` mints
    `x-alt-text-y`, while the same image written as `<img>` mints `x--y`. This
    renderer mints `x--y` for both. It cannot do better at this layer, because
    marked emits BYTE-IDENTICAL HTML for the two forms (`X <img src="i.png"
    alt="alt text"> Y`, measured), so no string-level discriminator exists for
    `headingId` to key on. A correct fix has to read token types in the `heading`
    renderer instead of slugging rendered HTML, which is a larger change than the
    exposure warrants: report headings carrying images are not an authored
    pattern here.

  Both are recorded rather than fixed so that a future in-page anchor that does
  dangle is diagnosable against a known list instead of re-derived from scratch.

## References

- [LLP 0196](./0196-skills-state-constraints-not-procedures.rfc.md) - the resolution this supersedes, and the theme-layer ordering preserved
- hypaware-server LLP 0110 - the server-side decision and the event-loop measurement
- hypaware-server LLP 0113 - the spike evidence (`#gt-spike`)

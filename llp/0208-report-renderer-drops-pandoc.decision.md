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
A renderer override reproduces pandoc's heading ids, `-1` suffixes on repeats
included, so existing in-page anchors keep resolving.

**The substitution was measured before it was made** (hypaware-server LLP 0110,
`#gt-spike` in their LLP 0113): all 94 files of a real reports tree converted
under both engines; 66 structurally identical, 28 differing only in pandoc's
syntax-highlighting markup, 0 genuine differences. Component blocks survive
byte-for-byte, fenced artifacts stay verbatim with their `language-*` class,
tables and links match exactly.

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

## References

- [LLP 0196](./0196-skills-state-constraints-not-procedures.rfc.md) - the resolution this supersedes, and the theme-layer ordering preserved
- hypaware-server LLP 0110 - the server-side decision and the event-loop measurement
- hypaware-server LLP 0113 - the spike evidence (`#gt-spike`)

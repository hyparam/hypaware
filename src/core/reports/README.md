# Report renderer (canonical source)

<!-- @ref LLP 0196#mechanics-as-code [implements]: deterministic steps ship as code the
     skill can call, not as prose the skill has to re-derive -->

This directory owns the static-site renderer for `~/hypaware-reports`: the
script that turns each dated report's Markdown into a browsable HTML site, and
the assets every built page carries.

## Why this exists

`build.sh` used to live **only** in a user's `~/hypaware-reports` working tree,
untracked by this repo. Because it was not versioned with the skill that drove
it, `hypaware-report-to-html/SKILL.md` could not call it and trust it, so it
carried the script's logic as prose plus conditional repair instructions for
copies that predated a feature (`grep -q masthead build.sh`). Roughly 110 of
that skill's 399 lines were a second, prose copy of code that already existed.

Vendoring the script is the fix ([LLP 0196](../../../llp/0196-skills-state-constraints-not-procedures.rfc.md),
[LLP 0197](../../../llp/0197-skills-state-constraints-not-procedures.plan.md) T1).
Both landed: T3 ported it to `render.js`, T5 wired `hyp report render` and
cut the skill from 28 KB to 13 KB (T10 finished the trim).

## Contents

| Path | Role |
| --- | --- |
| `render.js` | **The renderer.** Cross-platform Node port (T3, landed). |
| `landing.js` | The top-level `index.html`, derived from the report set (T4, landed). |
| `types.d.ts` | `RenderOptions` / `RenderResult`. |
| `assets/style.css` | The data-report stylesheet, custom-property driven. Copied into every built page. |
| `assets/copy-md.js` | The "Copy as Markdown" masthead action. |
| `assets/head.html` | Favicon links plus the copy-script tag, inlined into every `<head>` by pandoc's `-H`. Not a page asset. |
| `assets/favicon.svg` | Theme-aware mark. |
| `assets/favicon.png` | 64px fallback, shipped prebuilt so nothing needs `sips`. Safari does not render SVG favicons. |

## Rules

- **These assets live here and nowhere else.** They used to ship a second and
  third time inside the bundled report skills, back when the skill copied the
  stylesheet into the reports tree itself. `hyp report render` installs them
  from this directory, so the skill needs none of them; both copies were
  deleted (64 KB of dead weight in the published package), and
  `test/core/report-assets-canonical.test.js` fails if one comes back. Three
  copies of the same bytes is the shape that drifts, and this set did.
- **The shell original is gone** (deleted in T5, preserved in git history). If
  rendering misbehaves, fix `render.js` and its tests. Restoring `build.sh`
  restores a macOS-only, untested path that CI cannot run, and a test now
  asserts it stays gone.
- **pandoc is still a hard dependency** (LLP 0196 open question 1, resolved:
  keep it, install it in CI). Nothing else shells out: the port dropped the
  BSD-only `sed -E -i ''` and the macOS-only `sips`, which is what let the
  renderer be covered by tests at all, since CI is `ubuntu-latest`.
- **`rewriteHrefs` rule order is load-bearing**, and pinned by
  `test/core/report-render-hrefs.test.js`. Its failure mode is silent: a missed
  case ships a dead link that renders fine and breaks only when clicked. Change
  it against the case table, never by inspection.

## Verifying a change

`test/core/report-render.test.js` builds a fixture tree and asserts the
contract (no leftover `.md` hrefs, a copy action on every page, a `full.md` per
report, back-links, theme survival). For a change to the rendering pipeline
itself, the strongest check is an A/B against a real tree: copy
`~/hypaware-reports` twice, render one with the current code and one with the
change, and diff `html/`. That is how the Node port was accepted against the
shell original (`git show 0f3dce1^:src/core/reports/build.sh` if you need it
back for a comparison), and it came out byte-identical across five reports.

## The landing page is derived, not authored

`index.html` is rebuilt from the report set on every run: one card per report
newest-first, stats hoisted from each report's `metric-grid` with values and
judgments kept exactly, plus a companion card for any `proposed-changes.md`
page. Hand-edits do not survive, which is the point: it used to be transcribed
by a model from a template, so two runs over unchanged reports produced
different HTML and a deleted landing page was simply gone.

**Nothing is invented.** A report with no `metric-grid` gets a card with no stat
row rather than figures nobody computed, and labels are the report's own metric
labels verbatim. Compressing a label is editorial judgment, and a renderer that
did it would be writing copy rather than deriving it.

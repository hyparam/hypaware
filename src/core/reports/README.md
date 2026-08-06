# Report renderer (canonical source)

<!-- @ref LLP 0193#mechanics-as-code [implements]: deterministic steps ship as code the
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

Vendoring the script is the fix ([LLP 0193](../../../llp/0193-skills-state-constraints-not-procedures.rfc.md),
[LLP 0194](../../../llp/0194-skills-state-constraints-not-procedures.plan.md) T1).
The prose copy goes away once T3 and T5 land.

## Contents

| Path | Role |
| --- | --- |
| `render.js` | **The renderer.** Cross-platform Node port (T3, landed). |
| `types.d.ts` | `RenderOptions` / `RenderResult`. |
| `build.sh` | The superseded shell original. Kept only until T5 wires `hyp report render`, because the skill still calls it by name. |
| `assets/style.css` | The data-report stylesheet, custom-property driven. Copied into every built page. |
| `assets/copy-md.js` | The "Copy as Markdown" masthead action. |
| `assets/head.html` | Favicon links plus the copy-script tag, inlined into every `<head>` by pandoc's `-H`. Not a page asset. |
| `assets/favicon.svg` | Theme-aware mark. |
| `assets/favicon.png` | 64px fallback, shipped prebuilt so nothing needs `sips`. Safari does not render SVG favicons. |

## Rules

- **Edit the canonical copy, never a bundled one.** These assets also ship
  inside the claude and codex `hypaware-report-to-html` skills, because an
  installed skill is self-contained and cannot reach back into this repo at
  runtime. `test/core/report-assets-canonical.test.js` holds all three copies
  byte-identical. LLP 0194 T7 removes the need for the skill copies.
- **`build.sh` is frozen.** Fix `render.js` instead. The two are not kept in
  sync, and the shell copy goes away with T5.
- **pandoc is still a hard dependency** (LLP 0193 open question 1, resolved:
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
itself, the strongest check is still an A/B against a real tree: copy
`~/hypaware-reports` twice, build one with `build.sh` and one with
`renderReports`, and diff `html/`. That is how the port was accepted, and it
came out byte-identical across five reports.

## Not yet moved

`build.sh` deliberately does not generate the top-level `index.html` landing
page; today the skill regenerates it from a template on every run. LLP 0194 T4
moves that here, where it is fully deterministic.

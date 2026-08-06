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
| `build.sh` | The renderer. Still the shell original: T3 ports it to Node. |
| `assets/style.css` | The data-report stylesheet, custom-property driven. Copied into every built page. |
| `assets/copy-md.js` | The "Copy as Markdown" masthead action. |
| `assets/head.html` | Favicon links plus the copy-script tag, injected into every `<head>`. |
| `assets/favicon.svg` | Theme-aware mark. |
| `assets/favicon.png` | 64px fallback. Safari does not render SVG favicons. |

## Rules

- **Edit the canonical copy, never a bundled one.** These assets also ship
  inside the claude and codex `hypaware-report-to-html` skills, because an
  installed skill is self-contained and cannot reach back into this repo at
  runtime. `test/core/report-assets-canonical.test.js` holds all three copies
  byte-identical. LLP 0194 T7 removes the need for the skill copies.
- **Do not add features to `build.sh`.** T3 ports it to
  `src/core/reports/render.js`; anything added here has to be ported twice.
- **It is macOS-only today.** `sed -E -i ''` is the BSD spelling and fails on
  GNU sed, and the PNG favicon is regenerated with `sips`. T3 drops both, which
  is what makes the Linux half of the release gate in `CLAUDE.md` pass. T3 can
  drop `sips` outright by shipping `assets/favicon.png` as a static file, which
  is already the case here.
- **pandoc is a hard dependency** and the script exits 1 without it. Whether
  the port keeps it is LLP 0193 open question 1.

## Not yet moved

`build.sh` deliberately does not generate the top-level `index.html` landing
page; today the skill regenerates it from a template on every run. LLP 0194 T4
moves that here, where it is fully deterministic.

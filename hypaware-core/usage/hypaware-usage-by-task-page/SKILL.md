---
name: hypaware-usage-by-task-page
description: Make an HTML page of a person's AI coding usage by task (Claude Code and Codex, from HypAware recordings): one chart of themes, pieces of work and the pull requests each produced, key figures, the prompts behind each piece of work, and any answers already written. Use this only when someone asks for a page, an HTML report, a visual or something to open or share of their usage by task, or asks to "make the page" after seeing the usage-by-task chart in the terminal. For the usual question of what their AI usage went into, use hypaware-usage-by-task, which answers in the chat; this skill builds on it.
---

# HypAware usage by task: the page

Render the usage-by-task view as one self-contained HTML page. This skill only draws. The
window, the digest, the names and groupings, the three questions and any answers all come from
the `hypaware-usage-by-task` skill, installed beside this one at `../hypaware-usage-by-task/`.
Read that skill's `SKILL.md` before doing anything here; its rules on numbers, labels, privacy
and other people's data apply to the page unchanged.

## Scripts

In `scripts/` beside this file. Node 18+, no dependencies.

| Script | What it does | Time |
|---|---|---|
| `render.mjs` | `digest.json` (+ optional `labels.json`) → self-contained HTML | <0.1s |
| `build.mjs` | digest + render with no labelling, for the quickest possible page | ~2.5s |

`render.mjs`: `--digest`, `--labels`, `--out`, `--name <First name>` for a teammate's page.
`build.mjs` takes the digest's `--from`, `--to`, `--remote`, `--attrib-window-min`, and `--out`.
Both import the grouping logic from the other skill's `scripts/model.mjs`, so the page and the
terminal chart always show the same groups and the same numbers. If that import fails, the
other skill is missing or has moved; say so instead of copying its files here.

## Procedure

1. Use this run's work directory: the one you were given when started, or the one the
   `hypaware-usage-by-task` steps already used earlier in this session (default window: the
   last 7 days ending today). Nothing is carried from one run to the next, so do not look for
   files from an earlier run.
   - It has `digest.json` and `labels.json` from earlier in this session: use them as they are.
     Do not relabel and do not re-run the digest unless the person asks for fresh numbers.
   - The window has no sessions (see step 2 of that procedure): do not render a page. Say
     what that step says to say and stop.
   - It has neither, or only a digest: follow steps 1 to 6 of the `hypaware-usage-by-task`
     procedure to make them. Skip its chat chart and its question dialog; the person asked for
     the page.
2. Run `node scripts/render.mjs --digest <work>/digest.json --labels <work>/labels.json --out
   ~/hypaware-reports/<to>-usage-by-task.html` (or the place the person names). Read the stderr
   warnings and fix `labels.json` until there are none, as in the other skill.
3. Open the page (`open <file>` on macOS) and reply with its path and one or two sentences on
   what stands out. When the page shows PRs, say where they came from (HypAware events or `gh`); when it
   shows none, do not remark on it, as the other skill says.
4. Stop there. Questions are asked and answered in the terminal by the other skill, and
   answers stay in the chat; the page does not carry them.

## What the page contains

The chart comes first, directly under the title and lead sentence, with the key figures after
it as share bars (output and sessions by client, output in PR work, PRs with and without a
session, prompt tokens cached and uncached). One chart: themes, the pieces of work under each
(bar = output tokens), and links to the PRs each piece touched (solid line = opened it, dashed =
the PR's link showed up in the session later). The right-hand side is always one dot per
repository, with line thickness for the PR count. Clicking a repository expands it into its
individual PRs inside the chart (a small inline script redraws that side; only one repository is
open at a time), and each piece of work lists its own PRs in its click panel. Clicking a piece
of work opens the prompts behind it in a panel under the chart; there is no separate prompts
section. There is no small print under the chart: kind of work, output per day, models and the
list of unclaimed PRs are left off the page.

Under the chart the page lists the three questions from `labels.json`, each with a Copy button.
The page does not answer anything itself, and answers given in chat are not saved for it.

The page is framed as usage by task, not by PR: the title is "AI usage by task", the lead
sentence names the biggest task and its share, and PRs appear as what each task produced.
Output tokens are the headline measure. Token kinds are never added together.

It is styled as a HypAware report: the masthead, ruled key-figure rows, square bars and
palette of the server's report sheet (`hypaware-server/src/reports/renderer/assets/style.css`),
light and dark. Keep it that way when changing `render.mjs`; do not add tiles, cards or shadows.

## Boundaries

- The page holds the person's own prompts in its click panels. It is a local file; do not
  publish or upload it unless the person asks, and a teammate's page is for the person who
  asked, not for passing around.
- No dollar figures, and no numbers that did not come from the digest.
- Do not edit `digest.json` or change groupings here to make the page look better; groupings
  belong to the other skill's `labels.json` rules.

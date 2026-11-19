# HypAware usage by task: the page

These are the instructions `hyp usage --page` hands to a client. They ship inside the `hyp`
package and are not installed as a skill.

Render the usage-by-task view as one self-contained HTML page. These instructions only draw.
The window, the digest, the names and groupings and the questions all come from the chat
instructions in `../hypaware-usage-by-task/INSTRUCTIONS.md`. Read that file before doing
anything here: its rules on numbers, labels, missing pull requests, privacy and other people's
data apply to the page unchanged.

## Scripts

In `scripts/` beside this file. Node 18+, no dependencies.

| Script | What it does | Time |
|---|---|---|
| `render.mjs` | `digest.json` (+ optional `labels.json`) → self-contained HTML | <0.1s |
| `build.mjs` | digest + render with no labelling, for the quickest possible page | ~4s |

`render.mjs` flags: `--digest`, `--labels`, `--out`, `--name <First name>` for someone else's
page. `build.mjs` takes the digest's `--from`, `--to`, `--remote`, `--attrib-window-min`, and
`--out`.

Both import the grouping logic from `../hypaware-usage-by-task/scripts/model.mjs`, so the page
and the terminal chart always show the same groups and the same numbers. If that import fails,
the chat instructions' folder is missing or has moved. Say so; do not copy its files here.

## Procedure

1. **Use this run's work directory:** the one you were given when started, or the one the chat
   steps already used earlier in this session. The default window is the last 7 days ending
   today. Nothing is carried from one run to the next, so do not look for files from an
   earlier run.
   - It has `digest.json` and `labels.json` from earlier in this session: use them as they
     are. Do not relabel or re-run the digest unless the person asks for fresh numbers.
   - The window has no sessions (step 2 of the chat procedure): do not render a page. Say what
     that step says to say and stop.
   - It has neither file, or only a digest: follow steps 1 to 6 of the chat procedure to make
     them. Skip the chat chart and the suggestions dialog; the person asked for the page.
2. **Render.** Run `node scripts/render.mjs --digest <work>/digest.json --labels
   <work>/labels.json --out ~/hypaware-reports/<to>-usage-by-task.html` (or the place the
   person names). Read the stderr warnings and fix `labels.json` until there are none.
3. **Open the page** (`open <file>` on macOS) and reply with its path and one or two sentences
   on what stands out. When the page shows PRs, say in a few words where they came from. When
   it shows none, do not remark on it.
4. **Stop there.** Suggestions are offered and answered in the terminal, by the chat
   instructions, and answers stay in the chat. The page does not carry them.

## What the page contains

- **The chart comes first,** under the title and lead sentence: themes, the pieces of work
  under each (bar = output tokens), and links to the PRs tied to each piece (solid line = the
  session opened it, dashed = the PR's link showed up in the session later).
- **Repositories on the right.** One dot per repository, with line thickness for the PR count.
  Clicking a repository expands it into its PRs inside the chart, one repository at a time.
- **Prompts behind each piece of work.** Clicking a piece of work opens them in a panel under
  the chart, along with its PRs. There is no separate prompts section.
- **Key figures after the chart,** as share bars: output and sessions by client, output in work
  tied to a PR, PRs with and without a session, prompt tokens cached and uncached.
- **The questions from `labels.json`,** each with a Copy button. The page does not answer them.
- **Left off the page:** kind of work, output per day, models and the list of PRs with no
  session.

The page is framed as usage by task, not by PR. The title is "AI usage by task", the lead
sentence names the biggest task and its share, and PRs appear as what a task produced. Output
tokens are the headline measure, and token kinds are never added together. Without PR data the
page is the task list alone, with no PR wording.

It is styled as a HypAware report: the masthead, ruled key-figure rows, square bars and palette
of the server's report sheet (`hypaware-server/src/reports/renderer/assets/style.css`), light
and dark. Keep it that way when changing `render.mjs`; do not add tiles, cards or shadows.

## Boundaries

- **The page holds the person's own prompts** in its click panels. It is a local file. Do not
  publish or upload it unless the person asks, and someone else's page is for the person who
  asked, not for passing around.
- **No dollar figures,** and no numbers that did not come from the digest.
- **Do not edit `digest.json` or change groupings here** to make the page look better.
  Groupings follow the rules in `../hypaware-usage-by-task/references/labels.md`.

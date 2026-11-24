# labels.json contract

`chart.mjs --labels labels.json` reads this file, and so does the page's `render.mjs`. It
carries names and groupings only. Every token count shown is summed by the script from the slice ids you list, so a wrong id
cannot move numbers around; it is just ignored with a warning on stderr.

There are two levels. A **group** is one piece of work (what a PR or a task was for). A
**theme** is the product area or goal several groups belong to. The chart shows one line per theme, with its
groups as the rows underneath.

```json
{
  "groups": [
    {
      "theme": "Scheduled and custom reports",
      "label": "Purpose and section settings for scheduled reports",
      "category": "feature",
      "slices": ["01a19ea9|2026-11-05"],
      "prs": ["hypaware-server#1645", "hypscope#489"]
    },
    {
      "theme": "Scheduled and custom reports",
      "label": "Checking report generation with the new settings",
      "category": "investigate",
      "slices": ["01a19ea9|2026-11-04"],
      "prs": []
    },
    {
      "theme": "Skills, tooling and one-off lookups",
      "label": "Retried the same hyp query across three sessions",
      "category": "other",
      "slices": ["01a1a84e|2026-11-04", "01a1a84f|2026-11-04", "01a1a854|2026-11-04"],
      "prs": []
    }
  ]
}
```

Fields:

- `theme`: the row this group rolls up into, **42 characters or fewer** (longer is cut off in the chart, and the renderer warns). Groups with the same
  theme string share a row, so spell it identically each time. A group with no theme becomes
  a row of its own.
- `label`: what the piece of work was, in the user's terms, in **44 characters or fewer**. The
  chart cuts anything longer and the renderer warns about it. Write it like a headline: one
  thing, no "and", no trailing clause ("Markdown report export", not "Report export: Markdown
  ZIP and the Export menu it needed"). Name the thing built or asked, not the session.
- `category`: exactly one of `feature`, `fix`, `investigate`, `other`.
  - `feature` new capability or UI;
  - `fix` a defect or broken behaviour;
  - `investigate` analysis, research, questions and data lookups that did not ship code;
  - `other` setup, tooling, running report generators, anything else.
- `slices`: slice ids from the digest (`<session prefix>|<YYYY-MM-DD>`, copied exactly; the prefix is eight characters or longer). A slice goes in
  at most one group.
- `prs`: PR ids from the digest's `prs` map (`repo#number`). Only PRs the user authored in the
  window exist there; anything else is dropped with a warning.

## The three questions

Top-level field beside `groups`, written in the same pass as the labels, from the digest alone:

```json
"questions": [
  "My agents seem to need the same closing steps spelled out in every session that ends in a PR. Using HypAware, check Nov 11 to 17 and draft what I could add to the repo's agent instructions so they do it without being asked.",
  "The same prompts were started again in fresh sessions (installs, report runs, test prompts). Check my HypAware recordings for Nov 11 to 17 and suggest whether a script, a skill or one planned run would save the restarts.",
  "Finding earlier sessions took a few tries this week. Using HypAware, look at Nov 11 to 17 and suggest a quick way to get back to one."
]
```

Three, when the window supports three. A small window (fewer than five sessions) often does
not: write one only for something the digest shows in at least two sessions or in one long
one, and leave the list shorter or empty before padding it. Never more than three. They are offered in the terminal as a pick-one dialog after the chart, and the
page lists them under its chart. Write each so it also works pasted into a new session.

The goal of the questions is to make the person's next week with agents easier. Each one names
a place in the window where the work took extra effort, and its answer is one thing that would
remove that effort in every session from now on. They are offers of help, worded as
`INSTRUCTIONS.md` describes under "How to say it": never an audit, and never a description of the
person. They are not about understanding one task either. A question that could only be
answered with "here is what happened in that conversation" is the wrong question.

- **Open with what happened, with the agent or the work as the subject.** "My agents seem to
  need the same closing steps spelled out", "the same prompt was started again in fresh
  sessions", "finding earlier sessions took a few tries". Say "seem to": the digest shows what
  was typed, not why, and not how the person felt about it. No "I keep", no "habit", nothing
  that reads as a fault.
- **Then ask for what would help, and say what it would save.** "Draft what I could add to the
  repo's agent instructions so they do it without being asked", "suggest a quick way to get
  back to one". The reader should see what they get from picking it.
- **Prefer something that can be set up once.** A section for CLAUDE.md or AGENTS.md, a skill
  or slash command, a hook, a permission, a script. These are fixes the person keeps. Where
  the digest shows them, ask about:
  - instructions the agent needed again: closing steps, base branches, commit rules, the same
    background explained in session after session;
  - go-aheads and status checks: an agent that stopped to be told the next step, or was asked
    whether something merged, ran or passed, which a permission or a standing instruction
    would cover;
  - starting over: the same prompt begun in several fresh sessions, retries, parallel runs
    compared by eye, which a script, a skill or one planned run would cover;
  - keeping track: "where is the session where I...", reopening old work to find where it
    stood, which a note at the end of a session or a naming rule would cover;
  - checking the result: docs, tests or a second repo asked about afterwards, which a
    checklist in the instructions or a hook would cover.
- **One of the three may be about how the work is run**, when the digest shows it and nothing
  to set up would cover it. Read the digest for the shape of the work as well as its openings:
  - planning: a big piece of work begun from a one-line request and reshaped as it went, where
    a plan or a written spec first would have carried it;
  - splitting work: one very long session covering several unrelated goals, or many tiny
    sessions for what was one job; work done one step at a time that could run side by side;
  - which tool for which job: one client or model used for everything, or heavy sessions spent
    on work a smaller, quicker run would do.
  Word these as something to try, with what it would save.
- **Three different kinds of fix.** Try for three that would be fixed in three different
  places (an instruction file, a skill or script, a permission or hook, a way of running the
  work), so the three answers cannot come out as the same advice.
  The same rule holds for all of them: ask only about what the digest shows (session lengths,
  prompt counts, tool names, clients, models, repos), and say what it shows in the question.
- **Let the digest pick the three.** Use one only when the digest shows it (repeated first
  prompts, many short sessions with the same opening, prompts that are corrections or
  lookups), and put what the chart shows in brackets as examples ("installs, report runs, test
  prompts") so the agent knows where to look. Prefer what touches the most sessions
  or output. Do not write a question about something the digest gives no sign of.
- **Make the first question about the work that shipped** (sessions that ended in a PR) when
  there is any, so the first answer applies to the person's normal coding, not to an unusual
  week of test runs.
- **The ask is always for something that would help**: "what I could add to the agent
  instructions", "whether a script, a skill or one planned run would save the restarts", "a
  quick way to get back to one". Not "summarise this", not "break down the tokens", and not
  "where did I go wrong".
- **Name HypAware in every question** ("Using HypAware, check ...", "Check my HypAware
  recordings for ..."). A new session has no reason to open the recordings unless the question says so;
  without it the agent answers from the repo or from memory. The renderer warns when a question
  leaves it out.
- Make it stand alone: give the dates and name the kind of work in plain words, because a new
  session has not seen the chart. No slice ids, file paths or skill names.
- One or two sentences, under 240 characters, in the person's voice ("I", "my").
- Do not ask about customers or other people by name.

## The recommendation

The shape of an answer to one of the three questions, given in chat after reading
`messages.mjs` output. It is not written to `labels.json`: the answer is for the chat, and a
saved one would be stale by the next run. The parts are:

```json
"recommendation": {
  "task": "Scheduled and custom reports",
  "what_happened": "What the recordings show and what it cost, for someone who was not there, with the agent or the work as the subject. Two or three sentences.",
  "what_would_help": "The one thing to set up or try, with the text to add where it is a file, and how to tell it worked.",
  "based_on": ["Counted or dated facts from the messages and the digest, one per line, at most four."],
  "where_else": "The two or three other places in the window where the same kind of setup would have saved effort, what to add for each, and the one thing to do first."
}
```

- Word all of it as `INSTRUCTIONS.md` describes under "How to say it". Say what happened and what it
  cost, then one thing that would help. No list of five tips.
- Where the fix is a file, draft it. Give the lines to add to CLAUDE.md or AGENTS.md, the
  steps of the skill, the permission entry, taken from what the person already told their
  agents. "You gave the commit rule three times, so here it is as a section" is the answer;
  "consider documenting your workflow" is not. Then offer to add it.
- "Where else it would help" is not optional and not a follow-up. A single fix on its own
  reads as a tip. From the wider read, show the same kind of gap in other work from the
  window, each with a count and with what to add for it, so the person sees how far one
  afternoon of setup would reach. Keep it to a short paragraph or three bullets, and write
  its closing line from this person's week, not from a stock sentence.
- A suggestion about how to run the work (plan first, a session per goal) is welcome where the
  messages point to it. Give it as something to try and say what it would save.
- Evidence is counts, times and PR ids. Do not paste the person's messages; a few quoted words
  are enough to show what kind of message you counted.
- Say what you inferred and could not check.

## Choosing themes

The page fails when the top table reads like a session list. Aim for **five to seven themes,
never more than eight** (the renderer warns above eight). That is for a normal week. A window
with fewer than ten sessions, or one where a single job is most of the output, has as many
themes as it had separate goals, even one or two: do not split one job by day or by branch to
reach five.

- Pick themes first, then sort groups into them. Read the PR titles and first prompts, ask
  "what were the handful of things this person was trying to get done?", and write those down
  before assigning anything.
- A theme is a product area or a goal ("Scheduled and custom reports", "Report quality",
  "Agent setup and install"), not a kind of activity. "Investigations" is a weak theme when
  the investigation was about a feature that has its own theme: put it with the feature.
- Follow-up PRs, redesigns after feedback, and server plus dashboard halves of one feature
  belong to one theme.
- Keep two catch-all themes at most: one for looking into other people's or customers' data,
  one for skills, tooling and one-off lookups. Name them by what is in them, not "Misc".
- A theme under about 2% of output tokens should be folded into a neighbour or a catch-all,
  unless it carries a PR that fits nowhere else.
- Assign every slice above a few thousand output tokens to some group, so little is left for the
  "Other sessions" row. That does not mean a group each: see "How many groups" below. The two
  rules do not compete. The size floor there is for groups, not slices: a slice too small to be
  a group joins the nearest group in its theme, or a catch-all group. It is not left out.
- Do not name customers or other people in a theme or label; say "a customer org".

## How many groups

Aim for **two or three groups per theme, about fifteen in the chart**. The chart shows up to
three named rows per theme and folds two or more left over into one "smaller pieces of work"
row (a single one left over is shown as a fourth row), so a fourth and fifth group in a theme
are names nobody will see.

- A group should be at least about 2% of the period's output tokens. Anything smaller joins a
  neighbour in the same theme; do not name an 8K-token session on a 2M-token page.
- One group per conversation is the wrong default. Several conversations on the same goal are
  one group.
- All the no-PR work in a theme (checks, investigations, questions) is normally one group,
  named for what it was looking into, not one group per question.

## Grouping guidance

- Keep groups honest about PRs: a group lists only the PRs its own slices opened. Do not
  merge a no-PR investigation into a PR group to tidy up; put it in the theme's one no-PR
  group instead. The page's "share of output in PR work" is counted per group, so this is what
  keeps that figure true after the roll-up.
- Merge slices that are one piece of work split across sessions, retries, or clients.
- Split a multi-day session by day only when the days were different work; the digest already
  gives you one slice per day, so grouping days back together is a choice, not the default.
- `prs_rule` lists the PRs the scripts tied to a slice; `prs_graph` is the subset HypAware's graph
  confirms (the session was on a commit the PR contains), which is the stronger evidence.
- Keep `prs_rule` attributions unless the prompts clearly contradict them. Add a PR the rule
  missed when the prompt names the work (for example the prompt says "server + hypscope" and
  only the server PR was caught) or when the branch in `branches` matches the PR's title.
- A PR belongs to one group: the one holding the session that opened it. When two slices both
  carry it in `prs_rule`, the one with `prs_graph` evidence wins, then the one with the fewest
  minutes in `prs_seen`. A coordinating session that started the session which opened the PR
  sees its link minutes later and gets it by the rule too; the PR goes with the session that
  did the work, not the one that started it. The same holds for a review agent's session.
- Never attach a PR a session merely read, reviewed or mentioned. `prs_seen` lists every PR link
  with how many minutes after creation it first appeared; large numbers mean "mentioned", small
  numbers mean "opened here".

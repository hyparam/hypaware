# labels.json contract

`chart.mjs --labels labels.json` reads this file, and so does the page skill's `render.mjs`. It
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
- `slices`: slice ids from the digest (`<8-char session prefix>|<YYYY-MM-DD>`). A slice goes in
  at most one group.
- `prs`: PR ids from the digest's `prs` map (`repo#number`). Only PRs the user authored in the
  window exist there; anything else is dropped with a warning.

## The three questions

Top-level field beside `groups`, written in the same pass as the labels, from the digest alone:

```json
"questions": [
  "Using HypAware, look at my coding sessions from Nov 11 to 17 that ended in a PR. Where did I correct the agent or ask the same thing twice, and what could I have said in the first prompt to avoid it?",
  "Check my HypAware recordings for Nov 11 to 17: which prompts did I start again in a fresh session (installs, report runs, test prompts)? For each, should it be a script, a skill, or one planned run?",
  "Using HypAware, find the times from Nov 11 to 17 I asked an agent where an earlier session was or what its status was. What habit would stop me losing track of work between sessions?"
]
```

Exactly three. They are offered in the terminal as a pick-one dialog after the chart, and the
page skill lists them under its chart. Write each so it also works pasted into a new session.

The goal of the questions is to make the person better at coding with agents: each answer should
be one simple habit they can use in every session from now on. They are not about understanding
one task. A question that could only be answered with "here is what happened in that
conversation" is the wrong question.

- **Ask about a working habit, across the whole window.** Each question covers one way of
  steering agents and looks for it in all the sessions where it shows, not in a single
  conversation. Habits worth asking about, when the digest shows them:
  - how requests are opened: corrections, the same thing asked twice, scope that grew mid-way;
  - starting over: the same prompt begun in several fresh sessions, retries, parallel runs
    compared by eye;
  - keeping track: "where is the session where I...", status checks, "is it done?", reopening
    old work to find out where it stood;
  - checking the result: asking afterwards whether docs, tests or a second repo were covered;
  - waiting and handing off: long sessions with few prompts, work moved between clients.
- **Let the digest pick the three.** Use a habit only when the digest shows it (repeated first
  prompts, many short sessions with the same opening, prompts that are corrections or
  lookups), and put what the chart shows in brackets as examples ("installs, report runs, test
  prompts") so the agent knows where to look. Prefer the habit that touches the most sessions
  or output. Do not write a question about a habit the digest gives no sign of.
- **Make the first question about the work that shipped** (sessions that ended in a PR) when
  there is any, so the first answer applies to the person's normal coding, not to an unusual
  week of test runs.
- **End each question by asking for the change**: "what could I have said in the first prompt",
  "should it be a script, a skill, or one planned run", "what habit would stop me". Not
  "summarise this" and not "break down the tokens".
- **Name HypAware in every question** ("Using HypAware, ...", "Check my HypAware recordings
  for ..."). A new session has no reason to open the recordings unless the question says so;
  without it the agent answers from the repo or from memory. The renderer warns when a question
  leaves it out.
- Make it stand alone: give the dates and name the kind of work in plain words, because a new
  session has not seen the chart. No slice ids, file paths or skill names.
- One or two sentences, under 240 characters, in the person's voice ("I", "my").
- Three different habits. Do not ask about customers or other people by name.

## The recommendation

The shape of an answer to one of the three questions, given in chat after reading
`messages.mjs` output. It is not written to `labels.json`: the answer is for the chat, and a
saved one would be stale by the next run. The parts are:

```json
"recommendation": {
  "task": "Scheduled and custom reports",
  "problem": "What happened and what it cost, for someone who was not there. Two or three sentences.",
  "fix": "The concrete change in how to work next time, and how to tell it worked.",
  "evidence": ["Counted or dated facts from the messages and the digest, one per line, at most four."]
}
```

- Name the behaviour and its consequence, then one change. No list of five tips.
- Evidence is counts, times and PR ids. Do not paste the person's messages; a few quoted words
  are enough to show what kind of message you counted.
- Say what you inferred and could not check.

## Choosing themes

The page fails when the top table reads like a session list. Aim for **five to seven themes,
never more than eight** (the renderer warns above eight).

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
  "Other sessions" row. That does not mean a group each: see "How many groups" below.
- Do not name customers or other people in a theme or label; say "a customer org".

## How many groups

Aim for **two or three groups per theme, about fifteen in the chart**. The chart shows at most
three named rows per theme and folds the rest into one "smaller pieces of work" row, so a
fourth and fifth group in a theme are names nobody will see.

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
- Never attach a PR a session merely read, reviewed or mentioned. `prs_seen` lists every PR link
  with how many minutes after creation it first appeared; large numbers mean "mentioned", small
  numbers mean "opened here".

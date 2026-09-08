# LLP 0388: The recommendation ask gathers its evidence before the client starts

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI, Query
**Author:** Brendan / Claude
**Date:** 2026-09-07
**Extends:** LLP 0198 (#first-ask: one suggested question is answered from evidence HypAware gathers; #onboarding-list: that one question starts the client in a HypAware-owned directory rather than the caller's)
**Related:** LLP 0198 (#no-preauth: the launched session is still not pre-authorized), LLP 0140 (the server's report transcript, the same "recorded runs are evidence" stance), LLP 0359 (bounded scheduled work; the gather is bounded the same way)

> Extends [LLP 0198](./0198-setup-ends-on-a-question.decision.md). The
> question list, the launch mechanics, and the empty-cache framing are
> untouched. What changes is one row: a question whose answer is a change,
> answered from files HypAware writes before the client starts, in a
> directory HypAware owns.

## Context {#context}

The suggested questions of LLP 0198 send a cold client at the cache with
a one-sentence prompt and a skill. For "which task took the most tokens"
that works. For "what one change would recover the most wasted effort"
it did not, and the recorded attempts on this machine say why:

- Runs that let the client write its own SQL spent 12 to 28 queries and
  up to 14 minutes and produced convenience answers the user did not act on.
- Runs that handed the client summary tables produced confident answers
  in two minutes, one of which misdescribed a server error it had never
  read, and one of which named a cause the base rate did not support.
- The one run whose answer was acted on read every session opener
  verbatim, clustered them itself, then counted tool commands in the
  matched sessions: 221 KB of evidence, not aggregates.
- A run that was given the right files but not all of them fetched the
  rest itself, one slow query at a time, and slept between them: 22
  minutes, 16 of them waiting.
- Answers written for auditing, with a citation per figure, were correct
  and unreadable. The person this is for will give the first answer ten
  seconds.

Two further facts shaped the design. A session started in the user's
home directory loads no project guide and records a transcript under a
project named for the home directory, which is where three of the five
worst reopened sessions in the record lived. And the cache on machines
that attached after 1.31 carries every Claude Code session twice
(hypaware #1464), so any evidence pulled from it has to exclude the
duplicate lane or every count is a third too high.

## Decision {#decision}

<a id="in-process"></a>**HypAware gathers; the client reads.** For the
recommendation row, `hyp ask` runs the evidence queries itself, through
the same runner the overview uses, and writes the results as files. The
client is told the evidence is in its folder and that it may run no
queries of its own. The model's effort goes to the part only a model can
do: reading the evidence, finding the pattern, writing and testing the
change. This is the split LLP 0140 made for the server's report agents,
applied to the first ask.

<a id="route-rule"></a>**The route is chosen by a stated rule, in code.**
Four signals are measured over the last 30 days, one per kind of change:

| route | signal | floor |
|---|---|---|
| sink | share of all spend, cost-weighted, that is excess on reopened days | 10% |
| skill | most-typed human line, sessions on distinct days | 10 sessions on 5 days |
| subagent | estimated re-sent cost of inline reading on heavy days with no dispatch, priced as cache reads, as a share of all spend, and only when a request or brief recurs in 3+ of those sessions | 10% |
| rule | error head recurring across sessions | 5 sessions |

Both token signals are measured in cost units, fresh input at 1, a cache
read at 0.1, a cache write at 1.25, an output token at 5 (`PRICE_RATIO`),
because a raw count treats a cache read like a fresh token and that is how
an earlier generation of reports fixated on cached tokens. On this
machine the reopened-session excess is 24 percent of tokens and 21
percent of spend, so the finding survives the weighting, but the raw
share is printed beside the cost share in `triage.txt` so a reader can see
when they diverge. The sink and subagent signals share a currency and a floor, so they
compare directly: a count of heavy days does not, and a first version
that scored days against tokens chose delegation on a machine whose
measured loss was the reopened sessions. The subagent route also needs
a recurring task, because when to delegate is the client's decision;
the one lever a person holds is a named worker whose description matches
a request they already make. Each qualifying signal is scored as a multiple of its floor; the largest
wins; any other qualifying route within a fifth of it on that scale runs
too; ties fall to the order above. Below every floor the route is none,
and the answer says what was recorded and that it is not enough yet.

The rule is in `first_ask_evidence.js` and nowhere else, and `triage.txt`
prints it as applied. Two reasons it is not the model's call. The model
picked the wrong route once when told the rule in prose, and could not be
asked why. And the floors are the only tunable in the design: on the
first fleet run two orgs sat at 9.7 and 9.8 percent, which is exactly the
margin a floor exists to draw, and an operator who wants to move it
should find one number.

<a id="human-turns"></a>**User text means human turns, deduplicated.**
Every query excludes `conversation_source = 'claude_code'`, the OTEL lane
that duplicates the transcript lane until #1464 is fixed. Every user-text
query keeps only rows that are not sidechains and whose `user_type` is
null, `external`, or `user`, and drops injected preambles (the AGENTS.md
block Codex prepends, compaction summaries, skill invocations). The first
org run without these filters found "assess the exact planned action
below" typed in 86 sessions: a Codex guardian review, not a person.

<a id="run-directory"></a>**The client starts inside the evidence.** The
files are written to `<HYP_HOME>/ask/`, one folder emptied and rewritten
on every ask, and the client is spawned with that directory as its
working directory. This narrows LLP
0198 #onboarding-list, which chose the caller's directory at the launch
boundary, for this one row only. The reasons are specific to it:

- The prompt says "this folder", and the instructions are in `ASK.md`.
  A prompt that has to carry an absolute path is a prompt that breaks
  when the path has a space in it, and a 6 KB argv is a first user
  message nobody reads.
- The session is about HypAware's own data, not about any project. A
  transcript and a cwd under the user's home, or under whatever repo
  they happened to be in, mislabel the session in the very record the
  answer is drawn from.
- A hook the answer proposes has to be tested against a real transcript
  before it appears. The test writes a file. That file belongs in the
  run directory, not in a repo.

`hyp ask "<question>"` keeps the caller's directory. There is one
folder, not one per run: the files exist so the client can read them
during that session and nothing reads them afterwards, so the folder is
wiped before each gather and never grows. The gather completes, every
file on disk, before the client is spawned, and no evidence means no
launch: a client started on the bare question would answer it the cold
way, so the run says nothing was started and exits non-zero instead.

<a id="answer-shape"></a>**The answer leads with the recommendation.**
Line one is one plain sentence starting with a verb, naming the thing to
add and where it goes. Line two is one plain sentence saying what is
happening. Then two or three bullets, each with at most one number, one
of them a real example in words. Then the file and the block to add.
Then "Apply this now?". Then one line beginning "Sources:" carrying
every file:line, session id, and, for a hook, the test command and its
output. Under 110 words before the block.

Everything the earlier shape verified is still verified. It moved to the
last line. The rules that produce it each close a failure the recorded
runs showed:

- Facts about a command, an error, or a tool come from a file read this
  session, cited, or are written as pointers.
- Any command in the change is run once against a real input, and the
  output is shown.
- The change is a skill, an agent definition, or a CLAUDE.md block, and
  nothing else. Not a hook or a settings entry: those are invisible to
  the person, fragile across client updates, and not something a new
  user reads or maintains, so they are a poor first suggestion however
  well they would work. The on-disk listing the answer consults names the
  installed skills and agents with what each is for, and does not list
  hooks at all.
- If a skill, agent, or CLAUDE.md line on the subject already exists, the
  answer says why it did not work and changes it rather than adding a
  second.
- For the sink route the answer says plainly that a written rule cannot
  stop a person from resuming a session. Its change is a handoff skill
  plus one CLAUDE.md line on when the agent offers it, so that starting
  fresh becomes the cheaper habit.

<a id="one-question"></a>**`hyp ask` asks one question.** The list of
LLP 0198 #first-ask had four rows: token spend, a repeated mistake, a
missing skill, a subagent worth adding. Each sent a cold client at the
cache with a sentence and a skill, and the recorded runs of those rows
are the evidence in the Context above that this does not produce a
change anyone acts on. The four are now the routes the gather chooses
between, with evidence, so there is no question menu at all: `hyp ask`
goes straight from the gather to the launch. The one screen left is the
client pick when two clients could answer, still framed, and cancelling
it is "not now". The printed list in setup and `hyp ask --list` name the
one question. `hyp ask "<question>"` still
skips everything and starts straight on what was typed.

<a id="not-preauthorized"></a>**The launch is still not pre-authorized.**
LLP 0198 #no-preauth stands. The client will ask before its first Bash
command, which is the hook test; reading the evidence files needs no
permission. This is why the gather is in-process: the shell-script
version of this design needed a `sh gather.sh` call the client had to be
allowed to run, and non-interactive runs lost a third of their tool calls
to permission denials.

## Consequences {#consequences}

The gather costs seconds on a warm cache and under two minutes on a cold
one, all before the client starts, and the user sees one line per step.
The answer then takes two to four minutes in a cold client, most of it
the hook test. The earlier shape took the same time and was not read.

The route rule can be wrong for a machine. It is one exported object,
and the applied rule is printed in `triage.txt`, so a user who disagrees
with the route can see exactly which floor decided it.

The server-side, per-org version of this ask exists as operator tooling
outside the product and is not part of this decision. Its findings are
what set the floors.

`SUGGESTED_PROMPTS` holds the one question. Setup's printed list and
`hyp ask --list` show it; only the interactive pick triggers the gather.

## Telemetry

`wizard.first_ask` gains `evidence_routes` (`sink`, `skill+rule`, `none`)
on a recommendation launch, and `evidence_error` when the gather failed
and the launch degraded to the plain prompt. The distribution of routes
across installs is the first fleet-level statement of where wasted effort
goes, and the rate of `none` is how many machines are asked too early.

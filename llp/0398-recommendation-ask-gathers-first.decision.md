# LLP 0398: The recommendation ask gathers its evidence before the client starts

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, CLI, Query
**Author:** Brendan / Claude
**Date:** 2026-09-07
**Extends:** LLP 0198 (#first-ask: one suggested question is answered from evidence HypAware gathers; #onboarding-list: that one question starts the client in a HypAware-owned directory rather than the caller's, so setup offers to run it instead of printing it)
**Related:** LLP 0198 (#no-preauth: the launched session is still not pre-authorized), LLP 0140 (the server's report transcript, the same "recorded runs are evidence" stance), LLP 0359 (bounded scheduled work; the gather is bounded the same way)
**Extended-by:** LLP 0414 (#run-where-typed: `hyp report fix` reuses the launch seams but starts in the caller's directory, since a fix is to a repository)

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
client is told the evidence is in its folder and to run no queries and no
commands at all: the run that fetched its own evidence one slow query at
a time spent 16 of its 22 minutes waiting, and a cap of two only made
that failure smaller. Everything the answer needs is in the three files.
The model's effort goes to the part only a model can do: reading the
evidence, finding the pattern, writing the change. This is the split LLP 0140 made for the server's report agents,
applied to the first ask.

<a id="always-a-skill"></a>**The answer is always one skill.** What the
person is offered is a SKILL.md they can read, trigger by a phrase they
already type, and edit. It goes in the skill tree of the client
that is about to read the folder, taken from that client's descriptor
(`skillDir` / `agentDir`): `hyp ask` starts whichever attached client can
be launched, and Codex and OpenCode do not load `~/.claude/skills`. The
same descriptor decides which trees `on_disk.txt` lists, or the rule that
an existing skill is changed rather than duplicated is answered from a
tree the reader never loads. A skill is the most actionable place to start:
it lands on the first day, it is visible, and it is the person's own.
Hooks and settings entries are invisible and fragile; an agent
definition only matters once the lead picks it; an instruction-file
rule is one more sentence the model may not weigh.

<a id="one-signal"></a>**One signal: what the person types again and
again.** HypAware finds the human lines typed in the most sessions on
the most days, and for each pulls the tool calls that followed it and
the first substantial reply after those calls. That is the whole
evidence: the request as the person makes it, the procedure the agent
reconstructed each time, and what a finished run reported. The skill's
trigger is the line, its steps are the commands, and its report is the
ending.

Two typings are the same line when they agree after normalizing: case
folded, a leading filler ("okay", "now", "please", "can you") dropped,
punctuation and runs of whitespace folded to one space, then the first
36 characters. A person does not retype a request verbatim. The exact
42-character prefix this replaces split "commit on appropriate branch
and make a PR" from "okay commit on appropriate branch and make a PR"
into 4 sessions on 2 days and 3 on 2, each under the cut, on a machine
where the normalized key reads 7 sessions on 3 days; the same machine's
733 sessions went from two candidates, a resume and a check, to four.
The key is the grouping, not the display: each candidate is headed by a
typing as the person wrote it.

A typing that normalizes to nothing is not a candidate at all: typings
with nothing left to group on would pool unrelated sessions into one
candidate that outranks the real ones. A rule of dashes is such a
typing.

What the fold erases is a decision of its own, so the fold is written as
what it keeps. ASCII that is not a letter, a digit or a space folds to a
space, the General Punctuation block folds with it, and every other
character is kept. A first version kept only `a-z0-9`, which erased a
request typed in Cyrillic, CJK or Arabic to the empty key and so gave a
person who types in such a script no candidate at all (hypaware #1884).
Keeping those letters cannot be said as a letter class here: the engine
compiles a `regexp_replace` pattern with `new RegExp(pattern, 'g')` and
no `u` flag, where `\p` is an identity escape and `\p{L}` matches the
four literal characters `p{L}`, so the class names the ranges it keeps
instead. A raw-prefix fallback for the lines
the fold empties was rejected: it brings back the split key this
decision replaced, on the lines least able to afford it.

Two consequences are accepted. General Punctuation is folded so that a
curly quote, an en dash and an ellipsis still fold the way their ASCII
spellings do, but punctuation elsewhere above ASCII (an ideographic full
stop, a guillemet, an Arabic question mark) is part of the key, so a
request retyped with different punctuation of that kind reads as two
lines rather than one. And a typing made only of non-ASCII symbols, an
emoji rule for instance, now keys as itself rather than as nothing, so
it can be counted like any other line. What it no longer does is pool
with every other unrelated typing, which is what the empty-key exclusion
is for.

A first version measured four signals (reopened sessions, a repeated
line, a request that should go to a worker, a recurring mistake) and
chose among them by a rule with floors. It was replaced for three
reasons, each measured on this machine's own record:

- The rule needed five corrections in a week, every one for a false
  signal found by accident: raw token counts, days scored against
  tokens, an eval harness's afternoon outranking a month, permission
  prompts counted as mistakes, a relay header counted as a request. The
  next machine has its own.
- The skill it chose most often, a handoff note for reopened sessions,
  saves the most spend and asks the person to change a habit. The
  repeated line's skill asks nothing: it automates what they already do,
  and it was the one answer the person acted on.
- Handed all four signals with no rule, the model picked one of the two
  real ones both times; forced onto a weak signal alone, it wrote a
  confident skill anyway. So the model can choose among real signals and
  cannot be trusted to say "none". A record floor does that, and needs
  no per-signal tuning.

Timed on the same cache, the one-signal gather answered in 43 and 77
seconds against 80 and 116 for the routed one, with three files read
instead of eight, from 400 lines of code instead of 1,050. The other
signals are not wrong. They are later questions.

<a id="record-floor"></a>**Below the floor the answer says so and stops.**
Fewer than 20 sessions recorded, or no line typed in 5 sessions on 3
days, and the client is told to say how much was recorded and that there
is not enough yet. A skill proposed from three sessions is a guess.

<a id="human-turns"></a>**User text means human turns, deduplicated.**
Every query excludes `conversation_source = 'claude_code'`, which is how
the OTEL lane duplicates the transcript lane (#1464; the cross-lane
settlement landed, but a row that misses the flush-time pass keeps its
twin). The exclusion is null-safe, because a row with no source label is
not a duplicate of anything. It is also wider than its name: the live
gateway stamps `claude_code` on any request whose User-Agent is
`claude-cli/`, so the filter costs real rows on a machine that has no
transcript lane at all. It is kept because the transcript sweep runs by
default beside every Claude attach, and because everything the gather
counts is counted per session (`count(distinct session_id)`, `min(...)`
per session) - the duplicate lane changes only the raw `typed` total and
the 30-call procedure window. A predicate that picks the duplicate rather
than the label both producers share is the better answer and needs a
column neither lane carries today. Every user-text
query keeps only rows that are not sidechains and whose `user_type` is
null, `external`, or `user`, and drops injected preambles (the AGENTS.md
block Codex prepends, compaction summaries, skill invocations). The first
org run without these filters found "assess the exact planned action
below" typed in 86 sessions: a Codex guardian review, not a person.

<a id="run-directory"></a>**The client starts inside the evidence.** The
files are written to `<HYP_HOME>/ask/`, one user-only folder emptied and
rewritten on every ask, and the client is spawned with that directory as
its working directory. The path is fixed, not random: Claude Code asks
once whether to trust a new folder, and a random path would ask on every
run. This narrows LLP 0198 #onboarding-list, which chose the caller's
directory at the launch boundary, for this one row only. The reasons are
specific to it:

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

Under `HYP_HOME` and not the system temp directory, because what the
folder needs is that every parent of it is the person's own. An earlier
revision put it at `<tmpdir>/hypaware-<uid>/ask/` so the session would
land outside the home directory; review showed the cost. On Linux the
temp directory is shared by every account on the host, and a uid is
public, so another account can create `hypaware-<uid>` first and own the
parent from then on. A `0700` folder inside a parent someone else owns is
theirs to rename away and replace between the gather and the launch,
which hands them both the evidence files and the directory the client
starts in, project settings, hooks, and `ASK.md` included. A check on the
parent would close that; a parent that is already the person's own never
opens it. What the temp directory was buying was smaller than it read: a
client's unprompted read surface is its working directory and what lies
below, not the tree above it, so a session in `<HYP_HOME>/ask` reads that
folder and asks for anything else, the cache beside it included. The one
upward look is `CLAUDE.md` discovery in the folder's ancestors, which
loads the person's own files as instructions.

`hyp ask "<question>"` keeps the caller's directory. There is one
folder, not one per run: the files exist so the client can read them
during that session and nothing reads them afterwards, so the folder is
wiped before each gather and never grows. The gather completes, every
file on disk, before the client is spawned, and no evidence means no
launch: a client started on the bare question would answer it the cold
way, so the run says nothing was started and exits non-zero instead.

<a id="answer-shape"></a>**The answer reads like Claude telling you what it
found, not like a report.** It opens by saying what it looked through
and what stood out, gives the recommendation and why in a sentence or
two, then the evidence in prose with one real example told as a story,
then the file and the block to add, then a one-line offer to apply it,
then one "Sources:" line carrying the candidate number and the figures
used. No headings, no bold labels, no file names or session ids in the
text, under 120 words before the block. An
earlier shape with a fixed opening phrase and "Why" and "What I would
add" headings was correct and read as generated; this one is the same
content in a colleague's voice.

The earlier shape's verification moved to the last line, and shrank to
what the gather can stand behind: the candidate number and the figures
the files themselves carry. A citation the reader cannot check against
anything on their screen is decoration, and a session id in the prose is
the thing that made the earlier answers read as generated. The rules that
produce the shape each close a failure the recorded runs showed:

- Every fact in the answer comes from one of the three files, which were
  gathered before the client started. Nothing is fetched, and nothing
  about a command, an error, or a tool is asserted from memory.
- The steps of the skill are the commands the record shows ran, in the
  order it shows them. They are standard commands the person already
  runs, so they are not re-run to be verified: a client that tests its
  own suggestion is a client running commands, which #in-process rules
  out.
- The change is one skill (#always-a-skill). The on-disk listing the
  answer consults names the installed skills and agents with what each is
  for, and does not list hooks at all.
- If a skill on the subject already exists, the answer says why it did
  not do the job and changes it rather than adding a second.

<a id="one-question"></a>**`hyp ask` asks one question.** The list of
LLP 0198 #first-ask had four rows: token spend, a repeated mistake, a
missing skill, a subagent worth adding. Each sent a cold client at the
cache with a sentence and a skill, and the recorded runs of those rows
are the evidence in the Context above that this does not produce a
change anyone acts on. What they asked about is now answered from the
one signal, with evidence, so there is no question menu at all: `hyp ask`
goes straight from the gather to the launch. The one screen left is the
client pick when two clients could answer, still framed, and cancelling
it is "not now". `hyp ask --list` names the one question in plain words,
never the launch prompt, which tells the client to read a folder only the
gather creates. `hyp ask "<question>"` still
skips everything and starts straight on what was typed.

<a id="setup-offer"></a>**Setup offers to run it.** LLP 0198
#onboarding-list ended setup on a printed list because the launch would
have rooted a session in whatever directory `hyp init` was run from. With
#run-directory that reason is gone: the client starts in the run
directory wherever the ask was typed. So setup's last screen is now a
question, "Suggest a new skill?", and a yes runs
`hyp ask` as a child on the same terminal, the way LLP 0203 runs `hyp
sync`. A no, a cancelled prompt, or a run that cannot prompt ends on one
line naming the verb; an empty cache ends on the note that capture starts
now. The list of questions to type later is gone from setup: a sentence to
act on later is the shape the Context above shows nobody acts on, and the
offer is made at the moment the first look has just shown the person their
own rows.

<a id="not-preauthorized"></a>**The launch is still not pre-authorized.**
LLP 0198 #no-preauth stands, and the shipped instructions ask for no
command at all: reading the three evidence files needs no permission, and
writing the SKILL.md happens only after the person says yes. This is why
the gather is in-process: the shell-script
version of this design needed a `sh gather.sh` call the client had to be
allowed to run, and non-interactive runs lost a third of their tool calls
to permission denials.

## Consequences {#consequences}

The gather is five bounded queries, seconds on a warm cache, before the
client starts. Bounded by a ceiling, not only by the 30-day window: the
sessions that typed a candidate line are however many they are, so the
two statements that list rows per session read a newest-first sample of
them, 40 a line and 80 in all, each session from its own trigger onwards
rather than from its first row, under one row budget of twice the
procedure window per trigger read. Per trigger and not per session
because the sample is bounded in triggers: a session that typed two
candidate lines is anchored once but has two procedures inside its
window, and 80 triggers cost the same 4,800 rows whether they fall in 80
sessions or in 40. The total matters as much as the
per-line cap: both statements cost a pass over every named session for
each row they scan, so five lines in disjoint sessions would name 200 and
run slower than the unbounded statement this replaces. One line still
reads its full 40; five share the 80 between them. Anchoring each session is what makes the budget buy
the rows the page is built from; without it the budget is spent on the
calls that ran before the line was typed. The budget is one sum and not
a per-session ceiling, because SQL that says the latter needs a
partitioned window function, which buffers its whole input and gives the
bound back. So a long session can leave a later one unread, and every
count printed beside a step is the count of the sessions that were read,
never the count that was asked for. The example and the ending are the
sample's too. The answer then takes one to two minutes in a cold client:
three file reads and the writing.

The statement that finds the triggers is the one of the five that carries
no `LIMIT`, and the `group by` is its ceiling rather than an omission. It
returns a row a session a candidate line, so it is bounded by the distinct
sessions of a rolling 30-day window over at most `CANDIDATES` lines, the
five `prepareFirstAskEvidence` slices to before it asks, never by
messages: measured through the engine over two thousand such sessions,
one of them typing a second candidate line, five times the typings
returned the same 2,001 rows while the same predicate without the
aggregate returned 10,001. A `LIMIT` would not bound the scan or the
groups, because the streaming aggregate builds every group before it
yields the first row: over three thousand sessions, `limit 500` measured
the same 4.2 s and 210 MB peak as no limit. What a bare `limit` does
bound is the returned array alone, the 0.7 MB of held heap it saved
there, and that array grows with the window's sessions the way the groups
do: at fifty thousand it is the difference between finishing and
exhausting a 96 MB heap. That is the honest shape of the bound, and it is
a rolling window rather than a constant, but fifty thousand sessions in
thirty days is not a shape one machine's history reaches, and buying the
margin would cost an arbitrary set of sessions off an unordered stream.
What a group costs is about 300 bytes, and the scan is what the window
sizes: at a fixed 135,000-row scan, 8 groups against 3,000 held 0.9 MB
against 1.8 MB and took the same 4.0 s. The one form that sizes a sort
buffer, `order by at desc limit N`, is worse than either, because the
groups are all built before anything is sorted and their sort entries are
held on top: it exhausts that same 96 MB heap where the bare `limit`
finishes, and it would take the newest sessions overall, the starvation
the per-line share exists to avoid, paid for a bound that is not there.
So four statements say their bound in SQL and the fifth says it in its
shape, and the sample is what the answer is built from either way.

The floor can be wrong for a machine. It is one exported object,
`RECORD_FLOOR`, and `candidates.md` prints the record size it was judged
against.

The server-side, per-org version of this ask exists as operator tooling
outside the product and is not part of this decision.

`SUGGESTED_PROMPTS` holds the one question. `hyp ask --list` prints it;
setup offers to run it (#setup-offer); only a launch triggers the gather.

## Telemetry

`wizard.suggest_skill` records what setup's offer did: `launched`,
`declined`, `spawn-failed`, `child-failed`, or the skip reason
(`no-rows`, `not-interactive`, `error`), and `wizard.finish` carries the
same value as `suggest_skill` in place of `first_ask`. `launched` against
`declined` is whether the offer is one people take; `no-rows` is the rate
of installs finishing with an empty cache.

`wizard.first_ask` gains `evidence_enough` on a recommendation launch
(false when the record was under the floor) and `evidence_error` when
the gather failed and nothing was started. The rate of `false` is how
many machines are asked too early.

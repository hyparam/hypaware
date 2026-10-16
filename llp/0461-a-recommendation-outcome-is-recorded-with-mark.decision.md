# LLP 0461: A recommendation's outcome is recorded with `hyp report mark`

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Reports
**Author:** Brendan / Claude
**Date:** 2026-10-03
**Extends:** LLP 0414 (#not-yet: the first item, "Record that a recommendation was acted on", is the gap this closes; #list-shows-ids and #page-is-the-brief: the listing and the brief gain the state), LLP 0155 (#core-group: the `report` group gains two server-facing members, `recommend` and `mark`, on the same target and credential resolution; #fail-fast: the state vocabulary and the link grammar are copied for refusal before bytes move, the server stays authoritative)
**Related:** LLP 0225 (#decision: the receipt and the listing are remote text a person reads, so they are escaped; the page tail is the page's own text and is not), LLP 0402 and LLP 0432 in the server corpus (the id this verb takes), the hypaware-server recommendation-status RFC (the states, the status ledger and route, the recommendation index route, and the standalone publish route this decision is the client of)

> LLP 0414 made a recommendation something the CLI can start a client on
> and left one thing undone: nothing recorded whether anyone acted. This
> decision closes that gap with one verb, `hyp report mark <id> <state>`,
> whose states are the server's; puts the state on every line that names a
> recommendation (`hyp report list`, the tail of `hyp report get`); has
> `hyp report fix` tell the client it launches to run the verb when it is
> done; and adds `hyp report recommend <file.md>`, which publishes one
> recommendation page with no report around it.

## Context {#context}

A recommendation is read by id (`hyp report get <id>`) and acted on by id
(`hyp report fix <id>`), but the id carried no outcome. The next report's
follow-up could only compare the recorded transcripts with the page and
guess; a person reading the listing saw the same rows week after week with
nothing to say which were done, which were started, and which the team had
decided against. LLP 0414 #not-yet named the reason it stopped there:
closing the gap "needs a shape neither side has chosen".

The server has now chosen one (its recommendation-status RFC): an
append-only ledger of status events per recommendation, four states, a
`PUT /v1/reports/_recommendations/<id>/status` route that appends one, a
status joined onto every recommendation row the server lists, and a flat
`GET /v1/reports/_recommendations` index across reports. Alongside it a
`POST /v1/reports/_recommendations` route publishes one recommendation page
on its own, for the analysis that ends in a single recommendation rather
than a report. This decision is the CLI's side of that contract and
chooses nothing the server did not.

## Decision {#decision}

<a id="mark"></a>**One verb records the outcome, and the server keeps it.**
`hyp report mark <id> <state> [--reason <text>] [--link <url>]...` sends one
PUT to the status route with `{ state, reason?, links?, via: "cli" }` and
prints the state the server answered with. The id takes the grammar `get`
and `fix` take, the legacy `rec-` form included, and is checked before the
round trip. The CLI keeps nothing: no file under `HYP_HOME` says what was
marked, for the reason LLP 0414 gave against a saved brief, a copy that
serves one machine and drifts from the server every other reader asks.
`--link` is for the pull request that landed the change, so a later reader
goes from the recommendation to the diff in one step. Any state may follow
any state: reopening is the same verb with `open`, not a second verb, and
the ledger, not the CLI, is what remembers the sequence. It is a write, so
it rides the publisher-role path (`write: true`) and names the missing role
when a 401 survives the refresh, as `publish` does.

<a id="states-are-the-servers"></a>**The states are the server's.** `open`,
`in_progress`, `applied`, `dismissed`, spelled as the server's RFC spells
them, and a recommendation that has never been marked has no status at
all, which every reader renders as `open`. The CLI repeats the four in its
argument schema so a typo is refused at the gate with the list in the
message, and nowhere else: a status the server answers with is shown as
spelled, so a client older than a server that grows a fifth state shows
the fifth rather than calling the recommendation open. The grammar for a
link (absolute `http(s)`) is copied on the same terms. Defining a state of
its own, or a local override of the server's, would be the second copy of
the record this verb exists to avoid.

<a id="reason-for-dismissed"></a>**A dismissal carries its reason.** The
server refuses `dismissed` without `reason`; the CLI refuses it first,
before any bytes move, with the sentence that says why: the reason is what
the next reader sees in place of the change. A recommendation marked
applied has a diff to point at; one marked dismissed has only the
sentence, so the sentence is not optional. A blank reason is no reason.
The other states take a reason when the caller has one.

<a id="status-is-visible"></a>**Every line that names a recommendation
names its state.** `hyp report list` prints `[state]` after each
recommendation's id beneath its report, `[open]` for one never marked,
which is also what a server that joins no status lists, so an older server
reads correctly rather than differently. `--recommendations` lists the
recommendations themselves, flat across reports from the server's index,
each with its state and its parent report (`kind/period/id`), and
`--status <a,b>` filters on the server and implies the flat form, since
only that route joins status for a filter to read. The tail `hyp report get
<id>` prints after the citations gains a Status section: the current event
field by field (state, reason, links, by, at, via), then the history one
line per event, oldest first, as the resolve route returns it. The section
is always there, `State: open (never marked)` when the record has no
status, because the reader it serves is the client about to act, and "no
one has touched this" is the fact it needs most. The tail is the page's own
text, read by a model and saved by `--output`, so like the citations it is
not escaped (LLP 0225 escapes where a person reads a line that pairs an id
with a title, which is the listing and the receipt, and those are); a
reason's whitespace is collapsed so one event stays one line.

<a id="fix-asks-for-the-mark"></a>**The launched client is told to close
the loop.** The prompt `hyp report fix` hands its client ends with the two
commands: `hyp report mark <id> applied --reason "<one line>" --link <PR
url>` when the change is landed, `hyp report mark <id> dismissed --reason
"<why>"` when the recommendation should not be done, each carrying the
`--org` and `--remote` the run resolved so the mark reaches the org the
read came from. The `hypaware-reference` skill's "Act on a report
recommendation" entry ends with the same instruction, and says that a
recommendation already applied or dismissed is not redone without the
user's say, so a session that was asked to fix an id directly, without
`fix`, records its outcome the same way and does not repeat work the
Status section already shows done. The client that made the change is the
one that knows what it did; asking it to say so costs one command.

<a id="standalone"></a>**One page is a publish of its own.** `hyp report
recommend <file.md> [--title <t>]` POSTs a single Markdown page to the
server's standalone route as `text/markdown`, with the same
`x-report-content-hash` retry guard `publish` sends, and prints the minted
id and the `hyp report get <id>` that reads it (`published` on 201,
`already published` on 200). The page follows the rules a
`recommendation-<slug>.md` page inside a report follows: the first `# `
heading is the title (`--title` overrides it) and the bold paragraph under
it is the thesis; a page with neither heading nor `--title` is refused
before upload, since the slug derives from the title and the server would
refuse it after. The server wraps the page in a report of kind
`recommendation` whose period is the publish date, so the recommendation
is an ordinary report to every other command (`list`, `get`, `delete`) and
takes `mark` like any other. A report is standalone iff its kind is
`recommendation`; the flat listing prints `standalone` where the parent
report would be named, because naming the wrapper would send a reader to
a report that is the same page. The `hypaware-report` skill offers this
path for the analysis that yields one recommendation rather than a report.

## What this does not do {#not-yet}

- **Mark from the picker.** `hyp report fix` with no id offers a
  recommendation to fix, not a state to set. A `--status` filter on the
  picker's listing would be the natural next step and is not taken here.
- **Tie a mark to a recorded session.** The event says who and when, and
  `via: cli`; it does not name the transcript the change was made in. The
  server's `by` is the credential's subject, which is as far as the
  contract reaches.
- **Verify a link.** A `--link` is checked for shape, not fetched. Whether
  the pull request exists, or landed, is the reader's to check.
- **Choose the standalone slug.** `--title` names the title; the server
  derives the slug from it. A `--slug` would be a second spelling of one
  fact.

## Consequences {#consequences}

- The loop LLP 0414 opened closes: list, get, fix, mark, each taking the
  one id, and the next report's follow-up can read outcomes off the server
  instead of inferring them from transcripts.
- The `report` group's help gains two members and the telemetry command
  vocabulary gains `report mark` and `report recommend`.
- `hyp report list`'s recommendation lines gain a column; scripts that
  split those lines on tabs see the state between the id and the page.
  `--json` is unchanged in shape and carries `status` where the server
  sends it.
- `hyp report get <id>` always ends in a Status section, so the bare page
  is no longer what it prints even for a record with no citations; a
  consumer that wants the page alone has the `<kind> <period> <id> <path>`
  form, which is unchanged.
- The skills teach the mark in both places a session can arrive at a
  recommendation (`fix`'s prompt and a user-named id), and the standalone
  publish where the report skill decides what to publish.

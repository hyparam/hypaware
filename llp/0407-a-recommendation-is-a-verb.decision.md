# LLP 0407: A recommendation is something the CLI can start a client on

**Type:** Decision
**Status:** Draft
**Systems:** CLI, Reports
**Author:** Brendan / Claude
**Date:** 2026-09-14
**Extends:** LLP 0155 (#core-group: the `report` group gains a fifth server-facing member, `fix`, riding the same target and credential resolution), LLP 0398 (#run-directory: the launch mechanics of `hyp ask` are reused; the working directory rule gets its other half)
**Related:** LLP 0198 (#real-launch, #path-probe, #no-preauth: the launch is real, the client must be attached, the session is not pre-authorised), LLP 0402 in the server corpus (the id this verb takes, and the resolve route it calls)

> A published report ranks its recommendations and gives each a page. The
> server now mints an id per page and lists them on the record. This
> decision makes the id a thing to act on: `hyp report list` prints it under
> each report, and `hyp report fix <id>` starts an attached client on that
> one recommendation, in the repository the fix is for.

## Context {#context}

Reports end in recommendations, and until now the loop from a
recommendation to a change in a repository was manual: open the report in
a browser, read the page, open a client, paste. The recorded team-usage
reports on this machine each carry three recommendations, and the follow-up
run a later report performs
([LLP 0327](../../hypaware-server/llp/0327-the-brief-answers-the-previous-review.rfc.md)
on the server) has so far found them restated rather than acted on.

`hyp ask` already owns the mechanics this needs: which clients are attached
and on `PATH`, how to start one on a prompt with the terminal inherited,
which client to ask for when two could start, and what a launch failure is
([LLP 0198](./0198-setup-ends-on-a-question.decision.md)). What it lacks is
a handle for a recommendation. The server supplied one in LLP 0402: a
`rec-` id derived from the report id and the page stem, listed on every
record, resolvable bare through `GET /v1/reports/_recommendations/<id>`
to the report and the page that carry it.

## Decision {#decision}

<a id="id-is-the-handle"></a>**The server-minted id is the only argument.**
`hyp report fix <id>` takes the id `hyp report list` prints and nothing
else. The CLI resolves it through the server's resolve route, which answers
with the report triple and the page stem, then fetches that page from the
report. A kind, period, or report id on the command line would be three
tokens the user has to line up for a fact the server already holds, and
the id was designed to be pasted from a listing or a dashboard as one
token. The grammar is checked before the round trip, as the server checks
it, so a report id or a page name given by mistake is refused with the
shape an id has rather than answered as unknown.

<a id="listing-is-the-picker"></a>**With no id, the listing is the
picker.** On a terminal, `hyp report fix` fetches the same listing
`hyp report list` shows and offers one row per recommendation across it,
labelled by the page's own title and described by the first sentence of
its thesis when the server lists them (server LLP 0416 reads both from the
page at publish), else by the page stem read as words and by id, report
kind and period, and title. The list filters (`--kind`, `--period`, `--limit`)
narrow which reports the rows come from. A piped run with no id is a usage
error naming the listing, not a guess. No second listing shape is
introduced: the picker reads the `recommendations` field the record
already carries, so a report published before the field existed appears
with the ids the server backfills for it.

<a id="page-is-the-brief"></a>**The page is the brief, saved under
`HYP_HOME`.** The recommendation page is fetched as Markdown, or as HTML
when a report was published without the Markdown form, and written to
`<HYP_HOME>/recommendations/<id>.<ext>`. The client is told to read that
file and implement what it describes here. The page is the whole
recommendation as the report author wrote it, evidence, artifact, and
caveats, which is exactly what LLP 0162 put there and nowhere else; a
prompt that restated it would be a second, worse copy. The file lives
under `HYP_HOME` for the reason LLP 0398 gave for the ask's evidence:
every parent of it is then the person's own. It is named by id rather
than by report and page so a second `fix` on the same recommendation
overwrites the same file, and the folder never grows past one file per
distinct recommendation.

<a id="run-where-typed"></a>**The client starts where the command was
typed.** LLP 0398 moved the recommendation ask into a folder HypAware
owns because that session is about HypAware's own data and belongs to no
project. A fix is the opposite case: it is a change to a repository, and
the repository is wherever the person ran the command, the same rule
LLP 0198 chose at the launch boundary and LLP 0398 kept for a free-form
question. The brief is reached by absolute path from the prompt, which
LLP 0398 avoided for its own case because that prompt was six kilobytes;
here it is two sentences and the path is the point.

<a id="same-seams"></a>**Same client rules as `hyp ask`.** Only an
attached client is started, because a session nothing records would be a
fix HypAware cannot later see acted on (LLP 0198 #path-probe). When more
than one attached client is on `PATH` and the run is on a terminal, the
person is asked which; piped, the first is taken, as a named `hyp ask`
does. The launch inherits the terminal and drops the child's exit code
(LLP 0198 #real-launch), and nothing is pre-authorised (LLP 0198
#no-preauth): the client reads the brief and asks for what it needs. The
no-launcher failure prints the same runnable attach hint.

<a id="list-shows-ids"></a>**`hyp report list` prints the ids.** Each
report's line is followed by one indented line per recommendation, id,
page stem, and the page's title when the server lists one, with its thesis
on the line below, in the order the record carries them. The page stem is
the artifact path `hyp report get` takes and the id is what `fix` takes,
so the listing is enough to act from either way. `--json` was already
printing records whole.

## What this does not do {#not-yet}

- **Record that a recommendation was acted on.** The launch is a session
  like any other; whether it changed anything is for the recorded
  transcript and the next report's follow-up to say. LLP 0402 leaves the
  same gap on the server, and closing it needs a shape neither side has
  chosen.
- **Pick a repository.** The person chooses by where they type the
  command. A recommendation that names its repository could one day be
  matched against recorded `cwd` values, but the page format does not
  carry a repository field and inventing one here is not this decision's
  to make.
- **Run the client non-interactively.** The verb starts a session and
  hands over the terminal, as `hyp ask` does. A headless mode is a
  different contract with a different permission story.

## Consequences {#consequences}

- The loop from a report to a change in a repository is two commands, and
  the second takes one token copied from the first.
- The `report` group's help gains one member and the telemetry command
  vocabulary gains `report fix`.
- `attachHint` and the launch seams of `hyp ask` are shared rather than
  copied, so a new client adapter that declares a `launch` block reaches
  both verbs.
- One file per distinct recommendation accumulates under
  `<HYP_HOME>/recommendations/`, bounded by the org's report quota times
  the recommendations per report, and overwritten on repeat.

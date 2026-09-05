# LLP 0387: In the compact join lane, R1a is satisfied by an adjacent pair

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding, Usage-Policy
**Generated-by:** neutral
**Author:** Phil / Claude
**Date:** 2026-09-05
**Extends:** [LLP 0100](./0100-enrollment-privacy-review.spec.md)
(#requirements R1a binds "the forwarding line and the privacy block" to name
the server and to name `hyp remote list`. This decision records how the
compact lane, whose privacy block is one line that does neither on its own,
meets that requirement)
**Related:** LLP 0063 (#d3: the sign-in is the accepting act, so these lines
are consent surfaces rather than prompts), LLP 0101 (#no-release: the hold
runs to its absolute deadline, which is what the compact line states),
LLP 0131 (#attended-only: the compact lane runs only under the wizard, and
only attended), LLP 0135 (the wizard whose join lane asked for compact
output), LLP 0203 (#offer: on the ordinary attended close the send-now
offer, not the narration, carries R1's release verb),
hyparam/hypaware#1422, hyparam/hypaware#391

> `hyp remote login` has two output lanes. The wide lane prints a boxed
> privacy block that names the server and `hyp remote list` inside its own
> rule lines. The compact lane the wizard's join step drives prints one line
> per event, and its whole privacy block is
> `✓ First sync no later than <deadline>; nothing has been uploaded yet`,
> which names neither. This decision records the reading that leaves that
> line alone: in compact, the forwarding line directly above it carries the
> name and the lookup, and the two lines are R1a's destination surface
> together.

## Context {#context}

LLP 0100 R1a binds "the enrolling login's destination surfaces - the
forwarding line and the privacy block" to name the server by its configured
target name, to withhold its URL, and to name the one command that maps the
name back to a URL. The rationale is stated in the requirement itself: the
name shown may be one the user never typed (a bare `hyp remote login`
resolves its target through `effectiveDefaultRemote`), so withholding both
the URL and the way to see it "would make a consent surface unauditable".
R1a is therefore a requirement about a *surface*, and its test is whether a
reader of that surface can get from what they see to the server it names.

When R1a was written there was one lane. `firstSyncHoldMessage` builds a
block set off by rule lines, and its own reasoning says why the lookup
pointer lives inside those lines: the block is deliberately self-contained,
because it is written to stderr while the forwarding line is written to
stdout, and "redirect either and the other must still stand on its own".

The compact lane, added for the wizard's join step, prints one line per
event. It replaces the whole rule-lined block with a single stderr line
carrying the deadline and the hold's guarantee, because the wizard's own
close states the rest of R1 and the block would otherwise say everything
twice in one run. `narratePrivacyIfTeamPath` carries the backfill statement
and the skill hint on every path; the release verb reaches the ordinary
attended close through the send-now offer (LLP 0203) rather than the
narration, which drops its `hyp sync` sentence exactly when that offer
follows, and states it only on the abort path. Neither the narration nor the
offer names the server or `hyp remote list`, so if the compact deadline line
had to satisfy R1a alone, it would fail: it names no server and no lookup
command.

## The pair is the surface {#adjacency}

**In the compact lane the forwarding line and the deadline line jointly
satisfy R1a, and neither is required to satisfy it alone.** The two writes
are consecutive in `runBrowserLogin`, with only comments between them:

```
✓ Forwarding to the 'prod' server (run 'hyp remote list' to see its URL)
✓ First sync no later than <deadline>; nothing has been uploaded yet
```

The first line does everything R1a asks of a destination surface: it names
the server by its configured target name, prints no URL, and names
`hyp remote list` as the command that maps that name back. The second states
what the hold guarantees. Read together, which on an attended terminal is
the only way they can be read, an operator who has just seen the deadline
can see, one line up, which server the deadline is about and how to resolve
it to a URL. R1a's rationale, a consent surface auditable back to a URL, is
met.

Repeating the name and the lookup on the deadline line was rejected. The
compact lane exists because the wizard join is a checklist, and a second
copy of "the 'prod' server (run 'hyp remote list' ...)" one line below the
first is the same restatement the lane was introduced to remove. R1a asks
that the surface be auditable, not that every line of it be independently
auditable.

## The pair is scoped to the attended terminal, and so is the lane {#scope}

The wide block's self-containment argument still holds for the wide block:
its two halves land on different streams, and a `2>log` or `>log` invocation
separates them, so a block that stood only by adjacency would be a block
that a redirect could strip of its name. The compact pair does not clear
that bar. Under `2>log` the deadline line arrives alone.

That is accepted here, because the compact lane cannot be reached by an
invocation where it matters. `compact: true` is passed from exactly one
place, the wizard's join lane, which runs the login over the wizard's own
guarded streams; the wizard itself is attended-only (LLP 0131). A user who
redirects one of the wizard's streams is not reading the checklist the
compact lane was shaped for, and every non-wizard `hyp remote login`,
including every non-TTY one, still gets the self-contained wide block. If
compact output is ever offered on a bare `hyp remote login`, or to a
non-TTY caller, this reading expires with that change: the deadline line
would then have to carry the name and the lookup itself.

## Consequences {#consequences}

- The compact deadline line stays as it is. The finding that produced this
  doc (PR #1375 round 2, issue #1422) is a docs-only gap, and it is closed
  by recording the reading, not by editing the line.
- The compact lane's two lines are one surface for review purposes. Moving
  a write between them, or reordering them, breaks R1a for this lane even
  though neither line changed; the `@ref` on the deadline line points here
  so that a later editor sees the constraint at the site.
- LLP 0100 R1a is unchanged. This is a reading of the requirement against a
  lane that did not exist when it was written, not a relaxation of it: the
  wide lane's obligations, and the "never print the URL" half on both lanes,
  are untouched.

## References

- LLP 0063, LLP 0100, LLP 0101, LLP 0131, LLP 0135, LLP 0203
- hyparam/hypaware#1422, hyparam/hypaware#391, PR #1375
- `src/core/cli/remote_commands.js` (the forwarding line, the compact
  deadline line, and `firstSyncHoldMessage` for the wide block),
  `src/core/cli/wizard/join.js` (`defaultRunLogin`, the one caller that
  passes `compact: true`), `src/core/cli/wizard/index.js`
  (`narratePrivacyIfTeamPath`, the closing narration that carries the
  backfill statement and the skill hint, and names no server),
  `test/core/remote-login-command.test.js` (the compact-lane test that pins
  both lines)

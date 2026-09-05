# LLP 0299: Confirm prompts default to yes

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding
**Author:** Kenny
**Date:** 2026-08-21
**Related:** LLP 0104 (confirm-on-TTY / `--yes` posture, unchanged), LLP 0174 (#prompt/#openclaw: enable-prompt copy, polarity overridden here), LLP 0190 (#fork-disconnect: default overridden here; #eof-everywhere narrowed here for `askYesNo` only), LLP 0203 (#offer: polarity overridden here), LLP 0101 (#no-release: the hold #eof-declines protects)
**Extended-by:** LLP 0203 (#offer, amended 2026-09-05: the wizard's own send-now select is gone, so the second acting-default select this doc names no longer exists in code. `hyp sync`'s `askYesNo` is the only prompt on that path, and it declines at EOF like every other `askYesNo`, so #eof-declines still holds the hold - it just holds it with one prompt instead of two.)

## Context {#context}

The CLI grew a habit of defaulting every confirm to no, justified case by
case as the "safe" answer for anything irreversible. In practice nearly
every prompt sits directly behind a verb the user already chose (`hyp
client attach`, `hyp sync`, picking "Local" at the fork), so the no
default mostly makes the common path slower and punishes a bare enter.

## Decision {#decision}

Yes is the default everywhere, unless a bare enter would destroy data.

- **Default yes (`[Y/n]`, selects with "yes" first):** enabling a client
  adapter, switching to proxy mode, `hyp sync`'s send confirm, the
  wizard's send-now-or-wait offer, and the enrolled fork's disconnect
  question. An explicit `n`/`no` declines.
- **Default no (`[y/N]`), the data-loss carve-out:** `hyp purge` and
  `hyp report delete`. Only an explicit `y`/`yes` proceeds.

The default belongs to the bare enter the suffix advertises and to
nothing else. `y`/`yes` and `n`/`no` are read as themselves, and an
answer that is neither is not rounded to the default: it declines, or is
re-asked once where the prompt's asker can hold the next line. Rounding
was harmless while every prompt was `[y/N]` - the default declined, so a
mistyped "nope" landed where a clean "no" did - but under `[Y/n]` it
reads a typo, a stray keystroke, or a "no thanks" as consent to act. It
is the same reasoning as #eof-declines one step earlier: a default says
what the person at the terminal probably wants, and it may only be taken
by the keypress that means "what you said".

That binds the prompts this decision moves: `askYesNo` and the wizard's
confirm-select gates. The three `[Y/n]` prompts it does not move keep the
rounding they were built with - the config overwrite confirm (LLP 0183
#say-so), the init finale's backfill consent, and Claude Desktop's
install consent - all settled elsewhere, none sending or destroying
anything, and each leaving a backup or an opt-out behind it. Moving them
is a separate request, not a silent consequence of this one.

One `[y/N]` prompt is left where it is for the same reason, and it is the
one exception to the rule at the top of this section: `hyp plugin`'s
install confirm (`src/core/plugin_install/confirm.js`). It destroys
nothing, so "yes unless a bare enter would destroy data" would flip it,
but what it consents to is running third-party code this install has
never seen. That is its own question, answerable on its own evidence,
and not a silent consequence of this one either.

"Irreversible" alone no longer earns a no default; only destruction
does. Sending data off the machine, disconnecting, and config writes
with backups are all default yes.

Everything else about confirms stands: prompt only on a TTY and require
`--yes` elsewhere (LLP 0104). `askYesNo` takes the polarity as a
`defaultYes` option, and the printed `[Y/n]`/`[y/N]` suffix must agree
with it.

<a id="eof-declines"></a>**A stdin that cannot answer declines, whatever
default the prompt printed.** [LLP 0190
§eof-everywhere](./0190-wizard-defaults-gate.decision.md#eof-everywhere)
settled that a spent stdin takes the default it was shown. That was
written when every confirm here was `[y/N]`, so "take the printed
default" and "never proceed on an answer nobody gave" were one sentence.
Defaulting to yes pulls them apart, and where they disagree the second
one wins: a default says what the person at the terminal probably wants,
and EOF is the proof there is no such person. So `askYesNo` reads the
asker's EOF `null` as a decline directly rather than coalescing it into
the empty line. A bare enter is untouched - `[Y/n]` still proceeds on
enter - and `[y/N]` reaches the same decline by a shorter path.

The case that forces it is `hyp sync` inside the first-sync review
window. That confirm is the single gate that clears the hold, the hold is
driver-wide (LLP 0101 #hold), and clearing it forwards the machine's
whole recorded history. LLP 0101 #no-release licenses release by a
"confirmed, attended request", and a dropped ssh session is the one input
that proves nobody was in attendance.

This is a decline, not a cancel: the exit code is unchanged, so an EOF
decline is reported exactly as a typed `n` is. LLP 0190 #eof-everywhere
is narrowed for `src/core/cli/confirm.js` only and stands as written
everywhere else, because every other default there already declines to
act - the wizard fork menu's Quit, `plugin_install`'s `[y/N]`, and
`claude-account login`'s `Code:` paste, which has no default and fails
rather than inventing one. The wizard's `ConfirmSelectQuestion` gates
keep taking their stated default at EOF, because those defaults accept a
stated set of rows and do nothing by themselves.

The exception is a select whose stated default *acts*, and this decision
creates two. The enrolled fork's disconnect question is the plain one:
its yes runs `hyp leave` with no `askYesNo` behind it (LLP 0190
#fork-disconnect), so a spent stdin would disconnect a managed machine
with nobody at the terminal. The wizard's send-now offer is the subtle
one, because its yes looks gated and is not: it spawns `hyp sync` on this
terminal (LLP 0203 #child-process), and the child inherits the terminal
rather than the stream, so it is not asking on the same spent stdin. On a
real tty a ctrl+D is a keypress, not a spent stream; the child asks again
instead of declining. The hold is safe either way - nothing is forwarded
without an answer - but "the terminal gave up" would end with a sync
started rather than with the wait the offer asked for, which is the
outcome this section exists to rule out.

*(Forward-ref, 2026-09-05: LLP 0203 #offer was amended and the wizard's
send-now select was deleted, so only the fork disconnect question carries
an `eofValue` today. The wizard now spawns `hyp sync` with no question of
its own, and the child's `askYesNo` declines at EOF, so this paragraph's
worry is answered by the rule above rather than by a second surface. The
rule itself is unchanged.)*

So a question of that kind names an `eofValue` and the legacy select
returns it instead of coalescing the asker's `null` into the empty line.
The default is still what is printed and what a bare enter takes;
`eofValue` only answers "and if there is no one to press it". A question
that does not name one is unchanged, which is every other gate.

## Consequences {#consequences}

- Overrides the wait-first polarity of LLP 0203 #offer and the
  stay-connected default of LLP 0190 #fork-disconnect (both edited to
  match, still Drafts), and the `[y/N]` copy quoted in LLP 0174/0178.
- A stray enter can now send, enable, or disconnect. Accepted: each of
  those is recoverable, and the sync path still shows its plan first. A
  stray anything-else cannot: only enter carries the default.
- A dropped terminal cannot (#eof-declines). `askLineOnce`'s `null`
  becomes load-bearing at that call site: it is the difference between
  "answered empty" and "cannot answer", so callers there may no longer
  coalesce the two with `?? ''`.

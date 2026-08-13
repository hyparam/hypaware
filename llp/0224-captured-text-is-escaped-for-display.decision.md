# LLP 0224: captured text is escaped where it is rendered for a person, never where it is rendered for a program

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Query, Observability
**Author:** Claude
**Date:** 2026-08-13
**Related:** LLP 0189 (#choke-point: severity colour is applied where stderr is bound, the same one-place-per-stream shape), LLP 0164 (why `sanitizeLabel` strips, and why the zero-width group is in its class), LLP 0054 (the context controls that already clip every cell before it is rendered)

> `hyp query sql` wrote captured bytes straight to `process.stdout`. Every
> string column of every dataset is verbatim captured text, so an `ESC` in a
> prompt, a log body, an HTTP header value or a filename reached the operator's
> terminal and was interpreted: a row could hide itself, overwrite the row above
> it, or reorder what was read. This settles that the *output format* decides
> whether captured text is escaped, that the escape is visible rather than a
> silent strip, and that one character vocabulary serves both this and the
> existing label-stripping policy.

## Context {#context}

`formatCell` returned a string value unchanged, and the `query sql` verb wrote
the rendered table to `process.stdout`, which is not wrapped the way `dispatch`
wraps stderr ([LLP 0189](./0189-cli-severity-colour.decision.md) #choke-point).
`--format markdown` escaped only `|` and newline. `json` and `jsonl`, and the
MCP `query_sql` path, were safe only incidentally, through `JSON.stringify`
([#752](https://github.com/hyparam/hypaware/issues/752)).

Three facts make this worth a decision rather than a patch.

**The data is captured, so there is no upstream to fix.** `content_text` is
prose a model or a user wrote. A `logs` body is whatever the observed process
emitted. `traces` carries HTTP header values and filenames. None of it passes
through a regex or a parser that could have bounded it, and none of it is ours.
The base64 strip marker in the gateway's message projector is how this surfaced
([#748](https://github.com/hyparam/hypaware/pull/748) round 1), and fixing that
regex would have fixed nothing: an `ESC` arrives in a cell with no regex
involved at all.

**The repo already treats this threat as real, one plane over.** `sanitizeLabel`
strips control, bidi and zero-width characters out of status-file labels, and
its doc comment names terminal repainting as the reason. The query plane is
where far more attacker-influenced text reaches a terminal, and it was the plane
with no policy at all.

**The operator reading a doctored table is the person triaging hostile
traffic.** That is exactly who must not be shown a row that lies about itself.

## Decision {#decision}

**A render escapes captured text if and only if a person reads it.**

- `table` and `markdown` go through `formatCell`, which escapes.
- `json` and `jsonl` stay byte-exact, so the data stays extractable and a
  pipeline still receives what was captured.
- The `--output` spill receipt escapes its preview even though the file it
  describes may be `jsonl`: the receipt is a human render in its own right, and
  the file is the machine copy.

**The switch is the format, never `process.stdout.isTTY`.** {#format-not-tty}

A TTY gate was the obvious alternative and is worse. It makes one command print
different bytes depending on whether it is piped, so what an operator saw and
what they saved to a file disagree, and a bug reproduces differently under
redirection. That is a second, invisible mode in a command whose whole job is
reporting what was captured. A format flag is already in the operator's hand,
already documented, and already the thing that decides every other rendering
question; the pipeline that wants exact bytes asks for `--format jsonl` and gets
them on a TTY too.

Doing nothing was the third option (declare `hyp query sql` output untrusted,
like `cat` on a binary file). Rejected: `cat` has no idea what its bytes are,
while this renderer knows every cell it is laying out and has already clipped
each one for context budget. A renderer that structures output into aligned
columns has already promised the columns mean something.

**Escape, do not strip.** {#escape-not-strip}

`sanitizeLabel` drops the bytes because a label *names* a surface and a stripped
name is still a usable name. A rendered cell *is* the payload the operator asked
to see, so dropping bytes silently turns a query into a lie about what was
captured. The row stays honest: an `ESC` that was in the data renders as
`\u001b`, visibly and greppably.

Consequences accepted with this:

- The escape is the familiar JavaScript spelling (`\n`, `\r`, `\t`, `\uXXXX`),
  which is pure ASCII and one column per character, so column widths measured on
  escaped text are still display widths.
- A backslash already present in the value is **not** doubled. Captured data is
  full of Windows paths, regexes and JSON blobs; mangling all of them to
  disambiguate a literal `\n` from an escaped newline would cost far more
  legibility than the ambiguity does. The ambiguity is cosmetic, and neither
  spelling can move a cursor.
- A newline inside a `table` cell now prints as `\n` instead of breaking the
  row. That is a visible change to multi-line prose, and it is the point: a
  newline in a cell is how a captured value forges a row.

**One vocabulary, two policies.** {#one-vocabulary}

The unsafe-character class is *not* duplicated. It is decomposed into three
named groups (terminal control, bidi formatting, invisible formatting) in
`src/core/util/json_util.js`, and both policies are built from those groups in
that one file:

- `sanitizeLabel` strips all three, exactly as before. The recomposed class is
  the same set of code points as the literal it replaces, and a test asserts
  that over the whole BMP so the refactor cannot have quietly widened or
  narrowed it.
- `escapeForDisplay` escapes the first two only.

A second hand-written class somewhere else would be a second chance for the two
to drift apart about what "unsafe" means, which is the failure mode this shape
exists to prevent.

**The display plane escapes control and bidi, not zero-width.** {#escape-class}

| group | in a label | in a cell | why |
| --- | --- | --- | --- |
| C0, DEL, C1, U+2028/2029 | stripped | escaped | moves the cursor, erases lines, opens escape sequences, forges rows |
| bidi marks, embeddings, overrides, isolates | stripped | escaped | reorders text that follows, past the end of the value |
| zero-width and default-ignorable (ZWSP, ZWNJ, ZWJ, word joiner, BOM, soft hyphen, variation selectors) | stripped | **left alone** | see below |

The zero-width group is stripped from a label because a label is a **map key**:
two labels that render identically but compare unequal dilute the entrypoint
tracker's eviction cap. A query cell is not a key, so nothing downstream is
diluted. Against that, ZWJ and the variation selectors are load-bearing inside
ordinary emoji (a family emoji *is* a ZWJ sequence, and U+FE0F is what makes a
heart red), so escaping them would visibly corrupt legitimate captured prose on
a large fraction of real rows, in exchange for defending against a character
that cannot repaint anything.

Confusables remain out of scope on both planes, for the reason already recorded
against the label class: this bounds what a value *does*, not what it looks
like.

## Scope {#scope}

The rule stated above is general. What is *implemented* with this document is
the query plane, which is the whole of `src/core/query/`:

- `format.js`, the renderer behind `hyp query sql`, the `--output` receipt, and
  the `vector-search` plugin's result output.
- `overview.js`, the block behind `hyp query overview` and the wizard's closing
  first look, whose `provider`, `model`, `date`, `tool_name` and `repo_root`
  columns are the same captured strings. Here the escape sits on each captured
  value rather than on the assembled row, because this block paints its own
  bars and headings: a sweep over the finished table would strip the colour
  along with the attack.

Every other CLI surface that prints a captured value is a separate change and
is deliberately not swept in. `hyp graph neighbors` renders node labels lifted
straight off `ai_gateway_messages` (`client_name`, `model`, `tool_name`, a
`file_path` basename out of a `tool_use` block) with a 48-character clamp and no
stripping. `hyp status`, `hyp daemon status`, `hyp purge`, `hyp policy show`,
`hyp session`, `hyp backfill plan` and the client attach adapters each echo
values read back out of files this product does not own. Those are label-plane
surfaces where `sanitizeLabel` is already the established answer, so each needs
its own argument about strip-versus-escape rather than an automatic import of
this one.

## Verification {#verification}

Unit tests, each shown failing against the pre-fix source before being kept:
`ESC` in a `table` cell, `ESC` and bidi in a `markdown` cell, `json`/`jsonl`
byte-exactness, non-ASCII and emoji survival, and column alignment with an
escaped cell.

**Not verified:** no test here renders into a real terminal emulator. The claim
that `\u001b` is inert, and that a raw `ESC` sequence is not, rests on the
escape output being pure printable ASCII rather than on an observed terminal.

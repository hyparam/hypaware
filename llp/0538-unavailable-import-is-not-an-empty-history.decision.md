# LLP 0538: An unavailable import is not an empty history

**Type:** Decision
**Status:** Accepted
**Systems:** Backfill, Onboarding, CLI
**Author:** neutral
**Date:** 2026-10-18
**Extends:** LLP 0437 (#finish: the finish step's import line also speaks for
an import that could not run at all)
**Related:** issue #1160

## Context {#context}

A Desktop-only OpenCode install has no `opencode` on PATH. The OpenCode
provider reads that as an ok run with nothing scanned, so setup and attach
said "nothing to import" and `hyp backfill` printed bare zero counts. That is
the line an empty history gets, and it is false here: nobody read the
history. The person had no way to learn that the import was skipped or how
to run it once PATH was fixed.

## Decision {#note}

A provider may yield a `BackfillEvent` named `import_unavailable` whose
`attributes.note` is a short, person-facing string saying why its import
could not run and how to retry. The run stays ok, so one importer that cannot
run neither fails setup nor stops the providers after it.

The runner keeps only the first such note and caps it in length
(`note` on the provider result). Nothing else of the event stream is kept, so
a provider cannot grow the result by yielding more.

The note reaches every surface that reports the run:

- `hyp backfill` prints a `note:` line and adds `note` to the JSON provider
  entry. Providers without a note get no key.
- The shared result line (setup's finish step and the attach output) says
  `unavailable: <note>` instead of "nothing to import" when the run scanned
  nothing, dry run or not. A failure, or a run that scanned something, keeps
  its own line.
- The finish step prints that line. Per LLP 0437#finish it prints an import
  only when it wrote rows or failed; an unavailable import is now the third
  case, because silence there reads as an empty history.

The OpenCode provider is the first user: on the list command's ENOENT it
says opencode was not found on PATH, that live capture is unaffected, and to
run `hyp backfill opencode` after fixing PATH. Any other failure of that
command still fails the provider. The note names no path.

## Not decided here {#scope}

Missing Claude or Codex transcript locations keep their current lines. They
can adopt the same event later where a note helps; nothing in this decision
requires it.

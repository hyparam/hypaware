# LLP 0299: Confirm prompts default to yes

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Onboarding
**Author:** Kenny
**Date:** 2026-08-21
**Related:** LLP 0104 (confirm-on-TTY / `--yes` posture, unchanged), LLP 0174 (#prompt/#openclaw: enable-prompt copy, polarity overridden here), LLP 0190 (#fork-disconnect: default overridden here; #eof-everywhere unchanged), LLP 0203 (#offer: polarity overridden here)

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
  question. Only an explicit `n`/`no` declines.
- **Default no (`[y/N]`), the data-loss carve-out:** `hyp purge` and
  `hyp report delete`. Only an explicit `y`/`yes` proceeds.

"Irreversible" alone no longer earns a no default; only destruction
does. Sending data off the machine, disconnecting, and config writes
with backups are all default yes.

Everything else about confirms stands: prompt only on a TTY and require
`--yes` elsewhere (LLP 0104), and EOF lands on the printed default
(LLP 0190 #eof-everywhere). `askYesNo` takes the polarity as a
`defaultYes` option, and the printed `[Y/n]`/`[y/N]` suffix must agree
with it.

## Consequences {#consequences}

- Overrides the wait-first polarity of LLP 0203 #offer and the
  stay-connected default of LLP 0190 #fork-disconnect (both edited to
  match, still Drafts), and the `[y/N]` copy quoted in LLP 0174/0178.
- A stray enter can now send, enable, or disconnect. Accepted: each of
  those is recoverable, and the sync path still shows its plan first.

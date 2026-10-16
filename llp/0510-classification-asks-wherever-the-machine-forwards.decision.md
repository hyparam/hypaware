# LLP 0510: The folder ask keys on forwarding, not on enrollment

**Type:** Decision
**Status:** Draft
**Systems:** Onboarding, Usage-Policy, Config
**Author:** Phil / Claude
**Date:** 2026-10-16
**Related:** LLP 0106 (#enrolled-only: the premise this corrects), LLP 0200 (#decision: the opt-in ask, untouched), LLP 0063 (#d4: the enrollment gate, untouched), LLP 0031 (the layered config the daemon boots); hyparam/hypaware#2248, #2208

> Extends [LLP 0106 §enrolled-only](./0106-session-start-classification-hook.decision.md#enrolled-only),
> which gated the session-start classification hook on enrollment because
> "on a never-enrolled box nothing forwards". That premise no longer holds:
> a user can hand-author an `@hypaware/central` sink in their own local
> config, `mergeConfigLayers` boots it, and rows forward to that server with
> no enrollment at all. Everything else in LLP 0106 and LLP 0200 stands.

## Context

The hook read enrollment from the central layer alone (LLP 0063 D4) and
used it as its gate. #2208 widened what the prompt *names* to the effective
config, so an enrolled machine with an extra local sink is told about both
destinations. A machine whose only forwarding sink is its own local one
never reached that copy: it read as unenrolled and was never asked, so a
user who had chosen `ask` got no chance to keep a folder `local-only` while
its sessions left the machine.

## Decision

- **The gate is forwarding** {#predicate}: the hook prompts when the
  effective config the daemon boots has at least one `@hypaware/central`
  destination (the enrollment origins are always counted), the user chose
  `ask`, the session is interactive, and the folder is unclassified.
  "Nothing forwards" is still the reason to stay quiet; it is now tested
  directly instead of through enrollment.
- **One snapshot**: the forwarding answer, the destinations the copy names,
  and the `enrolled` field all come from a single resolution of the layered
  config, by the same resolver the daemon's boot and reload use, so the
  prompt cannot describe a different moment, or a different config, than
  the one the sink forwards from.
- **Enrollment keeps its meaning**: `enrolled` stays the central layer
  alone. Login exclusivity, `readCentralEnrollment`, and `hyp leave`'s
  ownership rules are unchanged; a local sink is never relabelled as a
  managed enrollment.
- **The copy says why it forwards** {#copy}: an enrolled machine keeps its
  pinned "This machine is enrolled" header. A machine forwarding only
  through its own sink is told "This machine is set up to forward" instead,
  and every effective destination is named, deduplicated by display name.
- **Unchanged**: the default `sync` preference and its silence
  (LLP 0200 #decision), non-interactive passthrough, already-classified
  folders, and the fail-soft posture: a config the hook cannot resolve reads
  as not forwarding and never fails the session.

## Alternatives rejected

- **Count a local central sink as enrollment**: would make login reject a
  machine with `hyp leave` advice that cannot clear a sink the user wrote
  (the reason LLP 0063 D4 reads the central layer alone).
- **Two reads (central, then effective)**: the two answers can describe
  different moments, and the non-prompting path would still have no way to
  see a local-only sink without the second read anyway.

## Consequences

- A user who chose `ask` and forwards only through a sink of their own is
  now asked about new folders, as an enrolled user is.
- Every evaluation does exactly one layered-config resolution; the
  prompting path drops from two reads to one.

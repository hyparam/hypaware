---
name: llp-grill
description: Grilling session that stress-tests a plan against the project's LLP corpus (Specs, Decisions, Principles) and Systems vocabulary, then captures crystallised decisions inline by updating, creating, superseding, or tombstoning LLP documents and flagging where code will need @ref annotations. Use when the user wants to challenge a plan against documented LLP decisions before writing code.
---

<what-to-do>

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase or reading an LLP, do that instead of asking.

This is the LLP-aware variant of `grill-with-docs`: the documents you challenge against and update are the numbered LLP documents under `llp/`, not a `CONTEXT.md` glossary and `docs/adr/` tree.

</what-to-do>

<supporting-info>

## LLP awareness

Before grilling, build a map of the existing design rationale.

- Find the `llp/` tree. Read the root document (`LLP 0000`, `**Role:** Root`) for the project overview, the **subsystem map**, and the **Systems vocabulary**.
- Identify the Active LLPs whose `**Systems:**` tags overlap what the plan touches. Read them — these are the decisions the plan has to live with or consciously overturn.
- Note status. Only **Active** LLPs are current guidance. If the plan revives something **Superseded** or **Tombstoned** (under `llp/tombstones/`), surface that explicitly — it may be a sign the decision was already considered and rejected.
- If the project also has a `CONTEXT.md` glossary, treat it as the term authority alongside the `Systems` vocabulary.

If there is no `llp/` tree yet, this is the wrong skill — point the user at `/llp-init` or `/llp-init-retrofit` first, then grill.

## During the session

### Challenge against existing decisions

When the plan contradicts an Active LLP — a Spec's "must", a Decision's chosen option, a Principle's "always/never" — call it out immediately and force the choice:

> "LLP 0014#queryable-sinks says queryability is a property of the writer/destination pair, but your plan assumes any S3 sink is queryable. Either the plan changes, or LLP 0014 does — which?"

Cite the LLP number and section anchor so the conflict is precise. A plan that silently diverges from an Active LLP is the exact failure LLP exists to prevent: the next agent reads the LLP, writes code to it, and contradicts your plan.

### Sharpen terminology against the Systems vocabulary

When the plan uses a term that conflicts with the project's established language, stop and resolve it. Keep `Systems` names consistent — don't let the plan introduce `Auth` when the corpus says `Authentication`, or coin a new system name for something an existing tag already covers. If a new `System` is genuinely needed, name it and note that `LLP 0000`'s vocabulary must be updated.

### Discuss concrete scenarios

Stress-test domain relationships with specific scenarios that probe edge cases and force precision about the boundaries between concepts. Invent the awkward case and make the user commit to how it behaves.

### Cross-reference with code and existing @refs

When the user states how something works, check whether the code agrees. If the relevant code already carries `@ref` annotations, **follow them** to the cited LLP section and check the plan still satisfies that rationale. Surface contradictions:

> "`src/sinks/driver.js` is annotated `@ref LLP 0014#export-contract [implements]`, which says sinks ack per-batch. Your plan acks per-row — that breaks the referenced contract."

### Capture decisions inline — into the LLP corpus

When a decision crystallises, dispose of it **right there**. Don't batch. Unlike ADRs, LLP documents are *living* — you edit, supersede, and delete freely — so the bar to capture is lower, but the discipline is to put each decision in the right place. Use the disposition tree in [DECISION-DISPOSITION.md](./DECISION-DISPOSITION.md):

- **Refines an existing Active LLP** → edit that LLP in place.
- **A new non-obvious decision** → create a new LLP. Use the next available number and the `NNNN-slug.type.md` convention with a full metadata header (follow `/llp-create`). Pick the `Type` deliberately (Decision vs Spec vs Principle).
- **Overrides an Active LLP** → update the LLP to the new decision. If the old framing still has migration value, mark it `Superseded` and write the replacement; otherwise just edit.
- **Retires guidance entirely** → move the LLP to `llp/tombstones/` with `**Status:** Tombstoned`.
- **An implementation constraint, not a standalone decision** → don't write an LLP. Note it as an `@ref` to add when the code lands, pointing at the LLP section that explains the constraint.

Keep each captured LLP edit scoped to the decision — stable heading anchors, tight prose, no implementation dumps.

### Keep the corpus honest

- **Co-evolve.** LLP edits should land with the code change that motivates them, not in a separate doc-only commit. If the plan won't be implemented immediately, it's fine to capture the decision now and let the `@ref`s follow with the code.
- **Validate.** After the session, run `/ref-check` to confirm no `@ref` was orphaned and every new section anchor resolves.
- **Don't over-document.** Apply `LLP 0000`'s bar: capture a decision when an agent might otherwise "simplify" the code in a way that breaks the intent. Skip the obvious.

</supporting-info>

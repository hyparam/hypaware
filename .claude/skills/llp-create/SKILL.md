---
name: llp-create
description: Create a new LLP document in this repo with the next available number, the correct filename convention (NNNN-slug.type.md), and a scaffolded metadata header ready to fill in.
---

# llp-create

Use this skill when the user wants to create a new LLP document. This handles numbering, filename generation, and the initial metadata scaffold so the user can focus on content.

Invoke as `/llp-create <title>` with an optional title, or `/llp-create` and the skill will ask for one.

## Ground rules

- LLP documents live in `llp/` (flat or grouped into subdirectories: see LLP 0000 for filesystem organization rules).
- Filenames follow `NNNN-slug.type.md` where `NNNN` is zero-padded four digits, `slug` is a lowercase kebab-case identifier, and `type` is the lowercased document type.
- Numbers are globally unique across the entire `llp/` tree, including subdirectories and `llp/tombstones/`. Never reuse a number that has ever been assigned.
- Standard types (LLP 0000 §Types): `rfc`, `spec`, `decision`, `plan`, `explainer`, `principle`, `guide`, `issue`, `research`. Projects may define additional types; check the project's root LLP for any local conventions.
- Standard statuses (LLP 0000 §Statuses): `Draft`, `Review`, `Accepted`, `Active`, `Superseded`, `Tombstoned`. New LLPs start as `Draft`.

## Workflow

### 1. Determine the next LLP number

Run `node scripts/llp-numbers.js next` and use what it prints.

**Do not read the number off the tree you have checked out.** The branch you are on is not the corpus: numbers are minted on every branch at once, and a document minted on a branch you cannot see claims its number just as firmly as one on the default branch. Three branches cut from the same master each took `max(llp/) + 1`, each got the same answer, and git reported no conflict because their slugs differed ([issue #907](https://github.com/hyparam/hypaware/issues/907)). LLP 0156 settles the rule: a fresh number sits above the highest claimed **anywhere**, including branches without an open PR, and including `llp/tombstones/`, because a retired number is never reused.

`scripts/llp-numbers.js` is that rule:

- `next` prints the next free number across every ref that could still merge and the working tree, zero-padded. A document you created a minute ago and have not committed claims its number too, so two calls in one session do not collide.
- `check` exits nonzero when a number this branch mints is already claimed elsewhere. It runs in CI (`.github/workflows/llp-check.yml`) and in `npm test`.
- `survey` lists every collision across every ref, including the settled ones stale branches still carry.

Fetch first or the scan only sees the refs you already had: `git fetch --prune --unshallow` on a shallow clone, `git fetch --no-tags --prune origin '+refs/heads/*:refs/remotes/origin/*'` on a complete one (`--unshallow` aborts there). The script warns when it can tell that it is reading a shallow or single-branch checkout, and `check` refuses outright rather than passing on a corpus it never saw.

Fall back to `max(existing) + 1` over `llp/`, **and say that you did so the number is known to be a guess**, in the three cases the script cannot cover: the repository has no `scripts/llp-numbers.js` (it is a HypAware file, not part of LLP itself), the repository is not a git checkout, or LLP documents live somewhere the script does not look. The script scans `llp/` only. If another LLP tree exists in a non-standard location (some projects use `docs/site/content/llp/` or similar), scan it by hand and take the higher of the two answers. Check the project's root LLP or `CLAUDE.md` / `AGENTS.md` for any documented LLP locations.

### 2. Ask the user for the metadata if not provided

Required to produce a useful scaffold:

- **Title**: short, sentence case. If not provided by the slash command argument, ask.
- **Type**, which of the standard types fits best. If the user didn't specify, propose one based on the title and current conversation context, then confirm. Common cues:
  - "How should we..." / "Proposal to..." → `rfc`
  - "What are the requirements..." / "Specification of..." → `spec`
  - "We decided..." / "Chose X over Y" → `decision`
  - "How we'll build..." / "Step-by-step" → `plan`
  - "What is..." / "How ... works" → `explainer`
  - "Always do..." / "Never do..." → `principle`
  - "How to use..." / "Workflow for..." → `guide`
  - "Bug in..." / "Problem with..." → `issue`
  - "Analysis of..." / "Findings from..." → `research`
- **Systems**: one or more system tags relevant to this LLP. Ask if unclear.
- **Related**: existing LLPs worth reading alongside this one. Ask the user or propose based on topic overlap.

### 3. Generate the slug from the title

- Lowercase
- Replace any character that is not `a-z0-9` with `-`
- Collapse repeated `-` into a single `-`
- Trim leading and trailing `-`
- Keep it short: aim for fewer than 6 words. If the title is long, truncate the slug after the meaningful words.

Example: `"Token rotation and session management"` → `token-rotation-and-session-management`. If that feels long, shorten to `token-rotation`.

### 4. Create the file

Write to `llp/NNNN-slug.type.md` (or a project-specific subdirectory if the user indicates one). Do not create the file in `llp/tombstones/` unless explicitly asked.

Scaffold:

```markdown
# LLP NNNN: <Title>

**Type:** <Type>
**Status:** Draft
**Systems:** <Systems>
**Author:** <Author>
**Date:** YYYY-MM-DD
**Related:** <Related, or leave blank>

## Summary

One or two paragraphs that summarize what this document is about and what a reader should come away knowing.

## Motivation

Why does this exist? What problem does it solve?

## Design

The body of the document. Structure this however the type and topic demand - RFCs usually have a Design section with sub-headings; Decisions have Context / Options / Decision / Consequences; Plans have phase breakdowns; etc.

## Open questions

What is not yet decided or needs more work.

## References

- LLPs referenced
- External sources
```

The exact scaffold may be customized per type. For instance:

- **Decision** documents should use the ADR-style `Context / Options considered / Decision / Consequences` structure.
- **Plan** documents should have a `Phases` or `Milestones` section.
- **Principle** documents should use `Principle / Rationale / How to apply` for each principle listed.
- **Research** documents should have `Findings` and `Confidence`.

Ask the user if they want the type-specific scaffold, or just the generic one.

### 5. Help draft content from conversation context

After creating the file, offer to draft initial content based on the current conversation. If the user has been discussing the topic, pull the relevant threads into a first-draft body. If not, leave the scaffold as-is and let the user write the content.

## After creation

- Confirm the file path and the assigned number back to the user.
- Offer to add cross-references from other LLPs that should now link to this one (`llp-related` is a separate skill for this).
- Remind the user that the LLP is `Draft` and will need review before moving to `Active`. Use the `llp-review` skill for that.

## Scope limits

- Do not modify other LLPs without the user's explicit request.
- Do not pick a document type without user confirmation if the choice is ambiguous.
- Do not overwrite existing files. If the chosen filename already exists, bail out and ask the user what to do.
- Do not invent LLP numbers. Always derive from the existing tree.

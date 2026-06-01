---
name: llp-init
description: Add LLP to a new repository by scaffolding the initial llp/ tree, drafting LLP 0000, and setting up agent instructions that keep the system maintained as code is written.
---

# llp-init

Use this skill when the user wants to set up LLP in a fresh repository or very early-stage codebase. This is the greenfield setup flow described in LLP 0001.

Invoke as `/llp-init`.

## Ground rules

- Read [LLP 0000](../../llp/0000-linked-literate-programming.explainer.md) for the core LLP conventions and [LLP 0001](../../llp/0001-greenfield-setup.guide.md) for the greenfield workflow before making changes.
- LLP documents live in `llp/` and use the `NNNN-slug.type.md` naming convention.
- The first document should usually be `LLP 0000`, an `Explainer` with `**Role:** Root`.
- Keep the initial setup lean. The goal is to establish the core loop, not to pre-document speculative design.

## Workflow

### 1. Inspect the repository

Determine whether this is actually a greenfield setup:

- Check whether an `llp/` directory already exists.
- Check for agent instruction files such as `AGENTS.md`, `CLAUDE.md`, or equivalent.
- Read the top-level `README` and repository structure to understand what the project is and how mature it is.

If the repository already has substantial code, substantial documentation, or an existing LLP tree, stop and use `llp-init-retrofit` instead.

### 2. Create the LLP foundation

If LLP is not already present:

- Create `llp/`
- Reserve `LLP 0000` for the root document
- Keep the tree flat initially unless the user already knows they need subsystem subdirectories

Do not create a large initial corpus. Start with the minimum structure that makes the system usable.

### 3. Draft LLP 0000

Create `llp/0000-<project-slug>.explainer.md` as the root document. It should include:

- Title in the form `# LLP 0000: <Project or system name>`
- Metadata header with:
  - `**Type:** Explainer`
  - `**Status:** Draft` or `Active`, depending on the user's preference
  - `**Systems:**` the top-level system name, usually the project name or a small set of initial systems
  - `**Role:** Root`
  - `**Author:**`
  - `**Date:**`
- A concise summary of what the project does
- High-level architecture or major components
- Key constraints or invariants that will matter to future code changes

If the user has already described a design direction, incorporate it into the draft rather than leaving a blank scaffold.

### 4. Set up agent instructions

Add or update `AGENTS.md` (or the repo's existing agent-instructions file) so agents are told:

- LLP documents live in `llp/`
- Read relevant LLPs before making changes in areas they cover
- Add `@ref` annotations when implementing non-obvious documented decisions
- Update LLP documents when the design changes

If the repository already has agent instructions, integrate LLP guidance into the existing file instead of creating competing instructions.

### 5. Suggest the next documents, but don't overbuild

Recommend the smallest sensible follow-on set, typically:

1. `LLP 0000` root explainer
2. One principle, RFC, or decision that captures the first non-obvious architectural choice
3. Additional LLPs only as real decisions arise

Do not create multiple extra LLPs unless the user asks.

### 6. Close with practical next steps

Tell the user:

- What files were created or updated
- What LLP number was assigned to the root document
- What the next high-value step is, usually either refining `LLP 0000` or creating the first substantive subsystem/design LLP

## Scope limits

- Do not perform a retrofit-style codebase survey; that belongs to `llp-init-retrofit`.
- Do not create a large batch of LLPs proactively.
- Do not add `@ref` annotations to volatile early code unless the user explicitly asks.

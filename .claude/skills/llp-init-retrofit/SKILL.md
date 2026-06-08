---
name: llp-init-retrofit
description: Add LLP to an existing repository by surveying the codebase and docs, drafting the root LLP, and proposing a phased adoption and annotation plan.
---

# llp-init-retrofit

Use this skill when the user wants to adopt LLP in an existing repository with meaningful code, documentation, or history. This is the retrofit workflow described in LLP 0002.

Invoke as `/llp-init-retrofit`.

## Ground rules

- Read [LLP 0000](../../llp/0000-linked-literate-programming.explainer.md) for the core LLP conventions and [LLP 0002](../../llp/0002-retrofitting-llp.guide.md) for the retrofit workflow before making changes.
- Existing code and docs are source material. Convert or update valuable rationale; do not discard it casually.
- Retrofitting is phased. The first pass should create orientation and a plan, not attempt to annotate the entire repository.

## Workflow

### 1. Survey the existing repository

Build a high-level map before creating LLPs:

- Read the top-level `README` and notable documentation
- Inspect the directory structure and major packages/modules
- Identify entry points, boundaries, and obvious subsystems
- Check for existing design docs, ADRs, RFCs, wiki exports, or architecture notes
- Optionally inspect recent git history if it helps identify active and stable areas

The output of this step should be a concise architecture summary and an initial subsystem list.

### 2. Check whether LLP already exists

- If an `llp/` tree already exists, do not blindly create a second setup layer
- If partial LLP adoption exists, extend it rather than restarting from scratch
- If agent instructions already mention LLP, update them instead of duplicating guidance

### 3. Draft LLP 0000

Create or revise the root LLP so it acts as the entry point for the codebase:

- Usually `llp/0000-<project-slug>.explainer.md`
- `**Type:** Explainer`
- `**Role:** Root`
- Metadata that matches the current project
- Sections covering:
  - what the system does
  - major subsystems
  - cross-cutting constraints or invariants
  - where a new contributor or agent should look first

This document should reduce cold-start cost for someone reading the repo for the first time.

### 4. Propose the first subsystem LLPs

Identify the 2-5 highest-value follow-on LLPs based on:

- active development
- frequent confusion or bugs
- non-obvious design choices
- cross-cutting invariants

For each proposed LLP, provide:

- provisional title
- likely type
- systems tags
- why it should exist

Only create additional LLPs immediately if the user asks.

### 5. Add or update agent instructions

Add LLP guidance to `AGENTS.md`, `CLAUDE.md`, or the repo's equivalent:

- LLP documents exist and where they live
- agents should read relevant LLPs before modifying covered areas
- add `@ref` annotations when implementing non-obvious documented decisions
- update LLPs when the design evolves
- flag mismatches between code and referenced LLPs

### 6. Recommend an annotation rollout plan

Propose a phased adoption plan:

1. Module-level references for the first few documented subsystems
2. Function-level references for non-obvious design points
3. Ongoing boy-scout-rule maintenance
4. Validation tooling once the corpus is large enough

Do not mass-annotate the whole repository unless the user explicitly asks.

## Scope limits

- Do not treat retrofit as a one-shot conversion of the full history.
- Do not generate rationale from code alone without making it clear where you are inferring.
- Do not overwrite existing docs or instructions without checking whether they already carry useful project-specific guidance.

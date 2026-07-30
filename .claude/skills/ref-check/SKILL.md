---
name: ref-check
description: Extract and validate @ref annotations from source code. Reports broken references (references to LLPs or sections that don't exist), orphaned annotations (references with no matching code construct), and summary statistics. The foundational tool for everything else LLP does with references.
---

# ref-check

Use this skill to validate the `@ref` annotations in a codebase. References are the link between code and LLP design documents, and they go stale silently when either side changes. This skill catches the staleness before it turns into incorrect AI-generated code.

Invoke as:

- `/ref-check`: scan the current working directory for all reference annotations and report problems
- `/ref-check <path>`: scan a specific file or directory
- `/ref-check --fix`: attempt to auto-repair broken references where possible (e.g., LLP moved to a new number but title still matches)

## What a `@ref` annotation looks like

Per LLP 0000, the reference syntax is:

<!-- ref-check:ignore-start illustrative syntax, not live annotations -->

```
@ref LLP NNNN#anchor: gloss
@ref LLP NNNN#anchor [relation]: gloss
@ref LLP NNNN: gloss
@ref path/to/doc.md#anchor: gloss
```

<!-- ref-check:ignore-end -->

Where:

- `NNNN` is a zero-padded four-digit LLP number (or just `NNNN` without padding, e.g. `LLP 42`)
- `#anchor` is an optional section anchor within the document (maps to a heading in the target file)
- `[relation]` is an optional relation type: `implements`, `constrained-by`, `tests`, `explains`, or a project-defined type
- `: gloss` is a short human-readable summary (required per LLP 0000 for readability); the colon separates the structured prefix from the gloss
- The whole thing appears in a language-appropriate comment (`//`, `#`, `/* */`, `--`, etc.)

References are commonly attached to the construct below them: a function, a struct, a block, a variable declaration. Per LLP 0000's attachment semantics, the reference binds to the next named construct.

## Ground rules

- LLP documents live in `llp/` (and any additional directories configured for the project).
- Reference syntax is defined in LLP 0000. If the project has extensions to the syntax, they may be documented in a project-specific LLP; check `llp/` for any that mention reference syntax.
- This skill does **not** modify source files unless `--fix` is provided and the user approves each fix individually.
- All references in all source files are scanned, not just those in files the user mentioned.

## Workflow

### 1. Discover source files

Walk the specified directory (or current directory). By default, include common source file extensions:

- `.rs`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`
- `.py`, `.go`, `.c`, `.cpp`, `.cc`, `.h`, `.hpp`
- `.swift`, `.kt`, `.java`, `.scala`
- `.rb`, `.php`, `.cs`, `.lua`, `.zig`
- `.md`, `.txt` (to catch references in prose too)

Respect `.gitignore`. Skip `node_modules`, `target`, `build`, `dist`, `.git`, and similar noise directories.

If the project has configured explicit paths or exclusions (via a config file or project LLP), honor them.

### 2. Extract references

For each source file, scan for lines containing `@ref` followed by either `LLP <number>` or a markdown path (`LLP 0042#anchor`, `path/to/doc.md#anchor`, etc.).

Capture for each:

- Source file path and line number
- Full raw reference text
- Target: LLP number (if LLP reference) or file path (if path reference)
- Anchor: section name, if any
- Relation: `implements`, `constrained-by`, etc., if any
- Gloss: the human-readable summary, if any

**Skip the annotations that are illustrations rather than data.** Documentation about the annotation syntax (this file, `ref-story`, an LLP that shows the form it is minting) has to spell out `@ref` targets that are deliberately fictional. Extracting them makes the checker permanently non-zero on a clean corpus, which is worse than not checking at all, so two markers suppress extraction:

- `ref-check:ignore` on the line suppresses that one line.
- `ref-check:ignore-start` opens a suppressed region and `ref-check:ignore-end` closes it. The markers go outside the fence when the region is a fenced block, both so they do not render as part of the example and because a marker inside a fence does not count.

A marker counts only when it is **a comment in the language of the file it sits in** and **not inside a code sample**. In Markdown that means an HTML comment, `<!-- ... -->`, invisible in a rendered view; in a source file it means `//`, `/*` or a JSDoc `*` continuation, or `#` where that is the comment. A marker does not count inside an inline code span, inside a fenced block, or on a line indented four spaces or more, all of which are how a document shows a sample rather than makes a statement.

Those conditions are the whole reason this section can explain the mechanism without arming it. Markdown has no comment character other than `<!--`: a leading `*` is a bullet and a leading `#` is a heading, so a prose list that names `ref-check:ignore-start` would otherwise open a real region and quietly unpolice everything down to the next `ignore-end`, which is exactly the failure this marker is warned against.

The markers suppress *extraction*, so a suppressed annotation is reported nowhere and counted nowhere: keep the regions as tight as the examples they cover, or a live annotation will go unchecked. Both citation forms are covered, `LLP NNNN#anchor` and `path/to/doc.md#anchor` alike, because the suppression is keyed on the line and not on the target.

Suppression is itself reviewable: the `llp-ref-hygiene` test fails on a marker in any file outside the enumerated syntax documentation, and on any region that does not pair, whether it is opened and never closed, closed without being opened, or opened while another is still open. A new suppression therefore has to appear in a diff as an edit to that list, not as one quiet line, and the lines a region covers are the same lines its author can see it covering.

### 3. Build the LLP index

Scan `llp/` (and any other configured LLP trees) for all documents. For each, extract:

- LLP number
- Title
- File path
- **Every anchor the document defines.** An LLP names its sections three ways, and all three are anchors a `@ref` may target. Index all of them or you will report resolvable references as broken:
  1. **Heading slugs**, generated the way the Markdown renderer does: lowercase, strip punctuation (keeping `-` and `_`), then replace **each** whitespace character with a `-` (no collapsing). Punctuation *between* two words is stripped while the spaces around it are not, so `part-1--the-client-seam`, with the double hyphen, is the correct slug for a heading that separates `Part 1` from `The client seam` with a long dash. Collapsing runs of whitespace instead breaks every reference into a dash-titled section at once. Two details that are easy to miss:
     - **Strip the inline anchor tags from the heading before slugifying it**, and *only* those: `<a ...>` and `</a>`. A heading may carry its own anchor (`### <a id="memory-invariant"></a>Peak execution memory is budget-bounded`). The renderer slugifies the *rendered* text, so that heading yields both `memory-invariant` (form 3, below) and `peak-execution-memory-is-budget-bounded`. Slugifying the raw line instead yields `a-idmemory-invariantapeak-...`, which resolves nothing. Do **not** strip angle brackets generally: `<target>` in `## D1: Login is a browser mode of \`hyp remote login <target>\`` sits in a code span, so the renderer keeps it as text and the slug ends `...-login-target`.
     - Repeated slugs get the renderer's `-1`, `-2`, ... disambiguation suffix, in document order.

     Verified against GitHub's renderer (`POST /markdown`) over every heading in `llp/`, `tombstones/` included, 1098 headings yielding 1107 ids: the rule above reproduces all 1107 exactly. Both details are load-bearing, not hypothetical. Stripping *all* inline HTML rather than only `<a>` tags misses 4 of them; not stripping at all misses the 9 headings that carry their own anchor.
  2. **Explicit `{#slug}` anchors**, `## The command surface {#surface}`. The `{#...}` marker is the anchor and is not part of the slugified title. Two things to get right:
     - **It is not confined to heading lines.** The corpus's usual placement is a **list item**, one bullet per named proposition: `- **Deadline rule** {#deadline}: the next local 11:59pm ...`. Eight docs place 25 markers that way (LLP 0101, 0105, 0106, 0107, 0122, 0138, 0049, 0001), and 47 references target them. Scan every line for `{#...}`, not just headings, or those 47 report BROKEN.
     - It is a *corpus* convention, not something GitHub's renderer honors. GitHub emits `id="the-command-surface-surface"` for that heading, no `surface` id at all, and nothing for a bullet. Index the marker anyway, because that is what `@ref` annotations target, but do not expect such an anchor to navigate in a rendered view.
  3. **Inline HTML anchors**, `<a id="endpoint-discovery"></a>`, which may sit mid-paragraph, or on a heading line as shown above, rather than alone. This is the corpus's normal way to give **one** section **several** named propositions, which a heading slug cannot express: a decision section that settles three things carries three ids. Do not treat a document with no `{#...}` as a document with no anchors.

  Measured on this corpus (1355 references), indexing only heading slugs reports **632** resolvable references as BROKEN: 366 target a `{#...}` marker, 266 an inline `<a id>`. Getting the whitespace rule wrong on top of that adds 30 more. All of it matters, but the anchor *forms* are by far the larger share, and restricting `{#...}` to heading lines is worth 47 of them on its own. With all three forms indexed as described, **22** references were genuinely broken (issue #457).

  **Every count on this page is a snapshot, taken at commit `79d147c` over 132 files and 129 LLP numbers.** The corpus grows, so a later run's totals will differ and are not evidence of a regression: what a run must reproduce is the *rule*, not the number. The failure this section exists to catch is a reference that the three forms above resolve being reported BROKEN. Re-measure before quoting any figure here as current.

Build a map from `(LLP number) → (file path, title, {anchor: heading text})`.

Also record where the same number is claimed by **more than one** file. A duplicate number makes `@ref LLP NNNN#anchor` ambiguous, and a checker that keeps only the last file it walked will report every reference aimed at the other one as broken. Resolve an anchor against **any** claimant, and report the duplicate itself as a `WARNING` on the corpus.

### 4. Validate each reference

For each reference:

**LLP reference (`@ref LLP 0042#anchor`):** <!-- ref-check:ignore -->

- **Does LLP 0042 exist?** If not, report the reference as `BROKEN: LLP 0042 does not exist`.
- **If an anchor is specified, does the anchor exist in LLP 0042?** If not, report as `BROKEN: LLP 0042 has no section "anchor"`. Include the list of sections that do exist in the error output so the user can pick a replacement.
- **Is the LLP tombstoned?** If yes, report as `WARNING: references tombstoned LLP 0042`. Tombstoned LLPs are not errors, but the user should probably update the reference to a replacement or remove the annotation.
- **Is the LLP superseded?** If yes, report as `WARNING: references superseded LLP 0042 (superseded by LLP NNNN if the header says so)`.
- **Does the gloss match the LLP's actual content?** This is a soft check. If the LLP's section anchor text doesn't resemble the gloss at all, report as `HINT: gloss may be out of date`. Don't block on this; just inform.

**Path reference (`@ref docs/vendor/spec.md#tokens`):** <!-- ref-check:ignore -->

- **Does the file exist?** If not, report as `BROKEN: file docs/vendor/spec.md does not exist`.
- **If an anchor is specified, does the heading exist?** Same check as LLP references.

**Relation validation:**

- If a relation type is used, verify it's one of the standard types (`implements`, `constrained-by`, `tests`, `explains`) or is documented in a project LLP. Otherwise report as `HINT: relation type "foo" is not standard`.

### 5. Report findings

Group the output by severity:

<!-- ref-check:ignore-start illustrative report, not live annotations -->

```
ref-check found 47 references in 23 files.

BROKEN (3), these must be fixed:
  src/auth/tokens.rs:42   @ref LLP 0099   (nonexistent LLP)
  src/ui/modal.ts:15      @ref LLP 0074#focus-trap   (no such section; did you mean "focus-trapping"?)
  src/net/client.go:88    @ref docs/vendor/spec.md#tokens   (file not found)

WARNING (2), references point at deprecated LLPs:
  src/legacy/sync.rs:12   @ref LLP 0009   (tombstoned, no replacement indicated)
  src/db/migrate.rs:55    @ref LLP 0021   (superseded by LLP 0044)

HINT (5), consider updating:
  src/ui/button.ts:33     @ref LLP 0007#layout: gloss "button click handler" does not obviously relate to section "layout"
  ...

Summary:
  Total references: 47
  Broken: 3
  Warnings: 2
  Hints: 5
  Clean: 37
```

<!-- ref-check:ignore-end -->

### 6. Optional: fix mode

If invoked with `--fix`, for each broken reference:

- **LLP moved or renumbered.** If an LLP with a matching title exists at a different number, propose the fix and ask the user to approve.
- **Anchor typo.** If the user said `#focus-trap` but the actual anchor is `#focus-trapping`, propose the fix.
- **Path typo.** If the file doesn't exist but a similarly-named file does, propose the fix.
- **Unfixable.** For truly orphaned references (referenced content genuinely gone), offer to remove the annotation, leave it with a `BROKEN` marker in the comment, or do nothing.

Apply each fix one at a time with the user's approval. Never batch-apply without confirmation.

### 7. Exit status

For scripting (this skill can be invoked from CI):

- Exit 0 if no broken references
- Exit 1 if any broken references
- Warnings and hints do not cause a non-zero exit code

## Output formats

- Plain text (default)
- JSON (`--format=json`): an array of finding objects for programmatic consumption
- SARIF (`--format=sarif`): for integration with CI systems that consume SARIF reports

## Scope limits

- Do not modify source files without explicit approval in `--fix` mode.
- Do not modify LLP documents.
- Do not follow references into unrelated repositories or external URLs.
- Do not attempt to resolve references that use unknown relation types or unknown reference syntax; report them as hints instead.
- Do not assume an LLP moved just because a title matches; always confirm with the user.

## Integration with other skills

- `ref-story` consumes the output of `ref-check` to generate rationale-ordered views of source files.
- `llp-impact` uses the reference map to answer "what code depends on LLP NNNN?"
- `llp-review-pr` uses reference validation to check whether a pull request breaks existing references.

`ref-check` is the foundation. If its output is wrong, everything downstream is wrong. Treat it as the canonical source of "what references exist and which are broken."

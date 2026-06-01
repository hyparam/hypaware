---
name: ref-story
description: Generate a "rationale-order" view of a source file organized by design intent rather than compiler order. Groups code by the @ref annotations pointing to LLP sections, producing a literate-programming-style narrative of why the file exists in the form it does. This is LLP's killer feature — the thing that makes readers actually want to adopt LLP.
---

# ref-story

Use this skill to generate a literate-programming view of a source file. Where the normal view of a file is ordered by language syntax (imports at the top, function definitions in whatever order the author chose), the rationale-order view is ordered by **why** — grouped by the LLP sections that explain each construct, with the relevant prose interleaved between the code fragments.

This is the capability LLP 0000 describes as "annotated source generation" and the README calls "the killer feature." It realizes the promise of literate programming (Knuth) without the maintenance burden of interleaving prose and code in the source file itself — because the prose lives in LLP documents and the code lives in source files, and `@ref` annotations are the bridge.

Invoke as:

- `/ref-story <file>` — generate a rationale-order view of a source file
- `/ref-story <file> --format=markdown` — emit as a markdown document suitable for publishing
- `/ref-story <file> --format=terminal` — emit as terminal-ready text with section dividers
- `/ref-story <file> --output=<path>` — save the generated view to a file

## Ground rules

- Requires `@ref` annotations in the source file. A file without any annotations produces a view that is mostly the "Unreferenced" section at the bottom — which is a useful signal in itself but not interesting to publish.
- Depends on `ref-check` for validation: broken references are highlighted in the output so the user knows something is out of sync.
- LLP section anchors are resolved to heading text from the target LLP. The skill reads both the source file and the LLPs it references.

## Workflow

### 1. Parse the source file

Read the target source file. Identify:

- The file's language (from extension)
- All `@ref` annotations and their attachment points (which construct each annotation binds to)
- Top-level constructs: imports, module-level declarations, type definitions, functions, classes, methods

The attachment rule is: a `@ref` annotation binds to the next named construct following it. If multiple annotations precede a single construct, they all apply to it.

If the language has a nesting structure (nested functions, methods in classes), track the hierarchy. A method inside a class inherits the class's references unless it has its own.

### 2. Resolve references to LLP content

For each unique `(LLP, anchor)` pair referenced in the file:

- Locate the LLP document in `llp/`.
- If the anchor is specified, find the matching heading and extract the section: the heading line plus all content from that heading to the next heading of the same or higher level.
- If no anchor is specified, use the LLP's summary (the content under `## Summary`, or the first paragraph after the metadata header if no Summary section exists).

Build a map from `(LLP, anchor)` to `(heading text, section body)`.

### 3. Group constructs by reference

Walk the file's constructs. For each:

- If it has one or more `@ref` annotations, add it to the group for its primary reference. The primary reference is usually the first `@ref` that appears above the construct, unless the user has a convention for marking primary refs differently.
- If it has no annotations, add it to the "Unreferenced" group.

A construct may appear in multiple groups if it has multiple references — repeat it with a note that this is the same construct seen under a different lens.

### 4. Order the groups

Order the groups to tell a story:

- **Most referenced first.** Sections that explain the most code come first.
- **Within a section, ordered by LLP position.** If LLP 0042 has sections A, B, C in that order and the file has code for sections C, A, B, render them as A, B, C — the LLP's own structure becomes the outline.
- **Unreferenced last.** Helper functions, utility code, and anything not tied to a specific design decision goes at the bottom.

### 5. Render the view

For each group:

- Start with a section divider and the LLP section heading.
- Include the full LLP section text (or summary, if no anchor was specified). Render it as prose.
- Then the code constructs that reference this section, in their source order.
- For each code construct, include a small header identifying the function/type/module name and its original line number in the source file.

Example output (markdown format):

```markdown
# Rationale-order view: src/auth/tokens.rs

This file is the token management implementation. It references 3 LLP
sections. Below is the file organized by design intent rather than source
order.

## LLP 0042#token-strategy — Session tokens must be rotated on privilege escalation

> When a session gains elevated privileges (admin actions, payment
> confirmation, or access to sensitive resources), the session token
> MUST be rotated atomically with the privilege change. A session that
> retains its pre-elevation token across a privilege boundary is a
> vulnerability: if the old token is exfiltrated during the window
> between escalation and rotation, it retains elevated privileges.
>
> Rotation is implemented by issuing a new token and immediately
> invalidating the old one, with the two operations bound in a single
> transactional update.

### `escalate_privilege` (line 42)

```rust
pub fn escalate_privilege(session: &Session) -> Result<Session> {
    // @ref LLP 0042#token-strategy — Session tokens must be rotated on privilege escalation
    let new_token = Token::fresh();
    db.transaction(|tx| {
        tx.invalidate(session.token)?;
        tx.issue(&new_token, session.user_id, ElevatedPrivilege)?;
        Ok(())
    })?;
    Ok(session.with_token(new_token))
}
```

### `rotate_token_on_grant` (line 91)

```rust
pub fn rotate_token_on_grant(session: &Session, grant: Grant) -> Result<Session> {
    // @ref LLP 0042#token-strategy — Same rotation on capability grant
    ...
}
```

---

## LLP 0074#focus-management — Focus trapping, restoration, custom order

> When a modal UI element is presented, focus must be trapped within
> the modal. Tab and Shift-Tab cycle through the focusable elements
> within the modal, looping at the boundaries. When the modal is
> dismissed, focus returns to the element that was focused before the
> modal opened.

### `MOdal::present` (line 133)

```rust
impl Modal {
    // @ref LLP 0074#focus-management — trap focus while modal is presented
    pub fn present(&mut self) -> Result<FocusState> {
        ...
    }
}
```

---

## Unreferenced

The following constructs have no `@ref` annotations. This is not
necessarily wrong — utility functions and straightforward
implementations do not always need references. But if any of these
implement non-obvious design decisions, consider adding a reference.

### `format_timestamp` (line 17)

```rust
fn format_timestamp(ts: SystemTime) -> String {
    ...
}
```

### `internal_helper` (line 201)

```rust
fn internal_helper() {
    ...
}
```

---

## File summary

- 47 constructs
- 12 referenced (25%)
- 35 unreferenced (75%)
- 3 LLP sections cover the referenced constructs
- 0 broken references (ref-check clean)
```

### 6. Flag broken references

If `ref-check` reports broken references in the file, render them in a warning section at the top of the view:

```markdown
> ⚠ This file has 2 broken references. The view below is based on the
> source file as-is; the unresolved references are marked in the
> output. Run `ref-check` for details.
```

And mark the individual constructs with broken refs clearly in-line.

### 7. Output

- **Markdown format** (default): emit the rendered view as a markdown document. Useful for publishing, embedding in docs, or sharing in review tools.
- **Terminal format**: use ANSI dividers and minimal formatting for interactive reading.
- **JSON format**: emit a structured representation for programmatic use (e.g., feeding into a documentation site generator).

If `--output=<path>` is given, save to that path instead of printing. Otherwise print inline.

## Edge cases

- **File with no annotations.** Render a view that is all-Unreferenced, with a note at the top: "This file has no `@ref` annotations. Consider adding some for constructs that implement specific design decisions."
- **Annotations with no matching LLP section.** Render the construct in its own group with the raw annotation text and a `[broken ref]` marker.
- **Multiple annotations on one construct.** Place the construct in the group for its first annotation; include a note "Also referenced under LLP XXXX#anchor" with a link to the other group.
- **Very large files.** If a file has hundreds of constructs, offer a condensed mode (`--condensed`) that shows only signatures instead of full bodies.

## Prior art note

The idea of organizing code by design intent rather than compiler order is literate programming (Donald Knuth, 1984). The distinctive LLP twist is that the prose and code live in separate files and the connection is generated on demand, so the code stays the canonical source of truth (it still has to compile) while the rationale stays in LLP documents (where it can be edited, versioned, and reviewed). `ref-story` is the synthesis step that reconstructs the literate view.

## Scope limits

- Do not modify the source file. This skill is read-only.
- Do not modify LLP documents.
- Do not attempt to "improve" the source file's annotations or structure. Just render the view.
- Do not generate views for files with only trivial references (e.g., a single LLP 0000 reference at the top of every file) — ask the user if they really want the view, since it won't be informative.

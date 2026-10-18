# HypAware upgrade notes

These notes list changes that can break a script, a habit, or an integration
when you upgrade past the named version. Each entry names what was removed or
changed and what to use instead. Command syntax for your installed version is
in the [CLI command reference](CLI_REFERENCE.md).

## v1.40.0

### `hyp report render` was removed

Use `hyp report publish <folder> ...` instead. The server renders the report's
Markdown, so there is no local render step to run first.

### Product telemetry: `report render`

An updated telemetry receiver classifies `report render` command events from
older clients as `unknown`, because the command is no longer part of the
command vocabulary.

## v1.39.0

### `hyp backfill plan` and `hyp client history import` were removed

| Removed | Use instead |
| --- | --- |
| `hyp backfill plan [provider...]` | `hyp backfill <provider> --dry-run` to preview |
| `hyp client history import [provider...]` | `hyp backfill <provider...>` to import |

A removed spelling fails with an error and imports nothing. When you update a
script, replace an old `plan` call with the `--dry-run` form, not with a plain
`hyp backfill`, or the preview becomes a real import.

### Product telemetry: backfill command labels

The `client history import` and `client history plan` command labels became
`backfill`, and `client history providers` became `backfill list`. Only the
labels changed for `client history providers`: that spelling still works on the
command line as an alias of `hyp backfill list`.

### MCP: `graph_neighbors` time-budget refusals

When a `graph_neighbors` traversal exceeds its time budget, the tool now
returns a normal result, `isError: false`, whose `structuredContent` is
`{ "ok": false, "error": ... }`. Before v1.39.0 the same refusal came back as
`isError: true`. The error names the remedy: reduce the depth or narrow the
edge types.

An MCP client must handle both failure forms: a tool result with
`isError: true`, and a result with `isError: false` whose `structuredContent`
has `ok: false`. Don't treat `isError: false` alone as a successful set of
graph results.

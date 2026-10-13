# Recorded text search

`hyp query grep "<text>"` searches recorded messages for a case-insensitive substring. Use `--regex` to interpret the text as a regular expression.

Narrow the search with `--session-id <id>`, `--chain-id <id>`, or `--from`/`--to` dates in YYYY-MM-DD format. `--limit <n>` defaults to 50 and returns at most 1000 hits; larger values are currently reduced to 1000.

Results are newest first, with one row per matched column. Each hit includes `session_id`, `message_id`, and `part_id` for follow-up queries.

Prefer grep for finding mentions of an error message, issue or PR number, filename, or topic, for example: “Have I seen this error before?”, “Which sessions mention PR #123?”, or “Find the chat where we discussed cache freshness.”

- Grep searches `content_text`, `tool_name`, `session_id`, `conversation_id`, `agent_id`, `model`, `cwd`, `git_branch`, and `git_remote`. It does not search system prompts (`system_text`), tool definitions (`tools`), tool arguments (`tool_args`), `attributes`, or `raw_frame`. Use `hyp query sql` to search those columns.
- Read stderr for notices about incomplete results. `more matches exist beyond the limit` means the limit cut the answer: narrow it or raise `--limit`. `the search stopped before covering every file` means files were never read, so a larger `--limit` cannot recover them: narrow the search and rerun. Narrow date ranges to reduce local scan work.
- Local-only rows may be withheld. Use `--include-local-only` only with the user's informed consent.

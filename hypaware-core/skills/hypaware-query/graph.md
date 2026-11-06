# Activity graph

Prefer the graph for skill and program inventories, identities, and relationships. Skills and programs are derived by the graph; do not reconstruct them from message text or tool arguments. Use message text or tool arguments for invocation details, or as a fallback only when the graph is unavailable. Distinguish observed invocations from mere mentions, and disclose fallback coverage limits. Repo keys normalize different remote-URL spellings that a raw `git_remote LIKE` misses, and Skill and Program keys are shared across Claude and Codex. The graph is derived and rebuildable; never hand-edit it to correct captured activity.

- Run `hyp graph project` before querying a local graph. Remote projection is maintained by the server and cannot be run from here.
- If `node`/`edge` or graph commands are unavailable, the graph is not composed on this install: report that limitation rather than treating it as zero activity, use messages where they can answer the question, and tell the user to re-run `hyp setup` to add it.
- Use `hyp query graph neighbors` for connections and paths. Use SQL over `node`/`edge` for counts and rankings.
- Use messages for token totals, tool-call counts, errors, content, event order, and user or gateway rollups. An edge records a relationship, not how many times it occurred.

Read `hyp graph --help` and `hyp query graph neighbors --help` for flags. Nodes use `node_type`, `natural_key`, and `label`; edges use `edge_type`, `src_type`, and `dst_type`.

For Skill edges, `ran` means evidence of a skill relationship, not successful execution. Filter `props.dispatch_tool` or `props.dispatch_slash` for explicit invocation requests. `dispatch_marker` means instructions supplied; `dispatch_file_read` and `dispatch_shell_search` mean file access requested. Legacy `dispatch_shell_read` cannot distinguish reading from searching. Use source messages to verify execution, success, or event counts. Correct historical labels with an explicitly scoped full-source `hyp graph project --refresh`; incremental projection preserves legacy evidence.

Count distinct sessions using `count(distinct src_id)` on session edges: `used` (tool), `used_model` (model), `touched` (file), `ran` (skill), `invoked` (program), `via` (app), `in` (repo), and `at` (commit).

Use the graph to find relevant sessions, then read their messages. A Session node's `natural_key` is the message dataset's `session_id`.

```bash
hyp query graph neighbors <ToolName> --type Tool --direction in --json
hyp query sql "SELECT message_index, tool_name, tool_args FROM ai_gateway_messages
  WHERE session_id='<uuid>' AND part_type='tool_call'" --format json
```

For complete file searches, check both repo-scoped and absolute-path node keys. Empty drill-downs can reflect projection freshness or message retention.

For edge self-joins, resolve seed node IDs first and use literals. If the planner reports a missing column, keep the edge self-join together in a subquery and join node metadata afterward.

Read [github.md](github.md) for questions combining AI sessions and GitHub activity.

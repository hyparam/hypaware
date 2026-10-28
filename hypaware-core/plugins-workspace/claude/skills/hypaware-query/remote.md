# Remote queries

Use `hyp remote list --json` to find configured targets. Add `--remote <target>` to SQL, grep, graph, or schema queries. Bare `--remote` selects the configured default. Remote schema output is complete and accepts `--format` and `--output`, not `--max-bytes`.

- Read stderr for incomplete-result notices. Server result limits cannot be increased from the client.
- `--refresh` and `hyp cache status` (also spelled `hyp query status`) are local-only. Current builds refuse `--remote` on status with exit 2; an older `hyp` silently answers with this machine's datasets, so never present status output as a server's.
- Remote grep requires operator access for `--regex` and does not support `--include-local-only`.
- If a connection fails, retry once, then report the error. `hyp remote list` does not verify connectivity.

If the target's HypAware MCP tools are available directly, you can use them instead of the CLI.

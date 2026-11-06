# NanoClaw capture

**Supported:** Local NanoClaw v2 Claude transcripts. See the
[integration guide](../../../docs/integrations/nanoclaw.md) for setup,
verification, history imports, privacy controls, and limits.

Add this entry to `plugins` in your HypAware configuration, preserving your
existing entries. Set `root` to your NanoClaw installation directory:

```json
{
  "name": "@hypaware/nanoclaw",
  "config": {
    "root": "/absolute/path/to/nanoclaw",
    "backfill": { "window_days": 30 }
  }
}
```

Run `hyp config validate`, then `hyp daemon restart`. Recovery runs every five
minutes. For an immediate import use `hyp backfill nanoclaw --since 2026-10-01`.
Query with `hyp query sql "select * from ai_gateway_messages where client_name = 'nanoclaw' limit 20"`.

This adapter reads NanoClaw v2's local `data/v2.db` group catalog and native
Claude transcripts, including rotated transcripts and subagents. It does not
modify NanoClaw or require an inference proxy. Remote catalogs and other
providers are not supported. Missing or unsupported catalogs fail visibly.
Oversized files and incomplete appends are reported in source health/logs.
Finalized assistant responses are captured without a turn-completion marker,
including subagents and interrupted turns. Response usage stays on the first
native block so later appends cannot double count tokens. Legacy records
without finalized response metadata wait for a later completion boundary.

Put `.hypignore` in the host `groups/<folder>` workspace to apply existing
ignore/local-only policy. `hyp session ignore <native-Claude-session-id>`
persists an exclusion. Disable automatic recovery with
`backfill.on_join: false`; manual imports still apply privacy exclusions.
Remove/disable the plugin to stop capture. Existing recordings are not deleted.

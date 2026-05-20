---
name: hypaware-gascity
description: Query and explore gascity supervisor messages captured by HypAware. Use when investigating sessions, frames, or template filters surfaced by the gascity source.
---

# HypAware: gascity

The `@hypaware/gascity` plugin captures lifecycle and per-session frames from
a gascity supervisor into the `gascity_messages` dataset.

## Common queries

Count attached rows:

```bash
hyp query sql "select count(*) from gascity_messages"
```

Recent frames for a city:

```bash
hyp query sql "select event_time, event_kind, provider_session_id, content_text \
  from gascity_messages where city = 'hyptown' order by event_time desc limit 50"
```

## Attach / detach

```bash
hyp gascity attach <city> [--api-url <url>]
hyp gascity detach <city>
hyp gascity list
```

Attach starts the source on the first call and reloads it on subsequent calls.

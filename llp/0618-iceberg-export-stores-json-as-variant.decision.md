# LLP 0618: The Iceberg export stores JSON as variant

**Type:** Decision
**Status:** Accepted
**Systems:** Sinks, Cache
**Author:** Kenny
**Date:** 2026-11-19
**Related:** LLP 0022, LLP 0029, LLP 0294

> The format-iceberg sink types JSON columns `variant`, the same as the local
> cache. Tables it created earlier keep their `string` JSON columns, and keep
> receiving JSON text, until they are rewritten.

## Context

The local cache has stored JSON columns as Iceberg `variant` since it was
written. The format-iceberg sink, which writes the server archive and any
user export, stored them as canonical-JSON `string`, with a code comment
calling `variant` a later refinement. No document chose the split.

The archive and the cache are two tiers of one dataset, read together through
one union. Two physical types for the same column made that union drop to the
row path, and gave every reader two value shapes for one column: an object
from a cache day, text from an archived day. The archive should hold the
cache's schema.

All export tables are already created at format version 3, so `variant` needs
no format upgrade.

## Decision

### Variant {#variant}

A JSON column maps to `variant` when the sink creates a table or adds the
column to one. Values are written as given, as the cache writes them: an
object stays an object, and a string stays a string.

### Legacy tables {#legacy-tables}

Iceberg cannot promote `string` to `variant` in place. When the sink appends
to a table whose JSON column is already `string`, it keeps that type and
writes JSON text as before, rather than failing the export. Any other type
change is still rejected as `iceberg_schema_incompatible`.

Bringing an existing table to `variant` is a rewrite of the table, done by a
one-off migration script per org against a stopped server, not by the sink.

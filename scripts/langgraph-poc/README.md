# LangGraph capture parity prototype

Throwaway experiment on `codex/langgraph-parity-poc`, not a production adapter.
It asks whether standard LangChain callbacks can preserve local-session-like
content, nested agent relationships, and offline recovery through HypAware.

## Run

Use Node 24 and install the repository's existing dependencies if needed:

```sh
npm install --ignore-scripts --no-package-lock
npm install --prefix /tmp/hypaware-langgraph-poc-deps --ignore-scripts --no-audit --no-fund \
  @langchain/langgraph@1.5.0 @langchain/core@1.2.18 \
  @langchain/openai@1.6.2 @langchain/anthropic@1.5.12 zod@4.6.7
node scripts/langgraph-poc/run.mjs
```

These are temporary experiment dependencies, not additions to HypAware's
runtime dependencies. Set `HYP_LANGGRAPH_POC_DEPS` if installing elsewhere.
The default run makes no external model calls. It exercises real LangGraph and
real OpenAI/Anthropic adapters against synthetic loopback HTTP responses.

For two real models, set `OPENAI_API_KEY` in the environment and run:

```sh
node scripts/langgraph-poc/run.mjs --live
```

This uses `gpt-6.1-sol` and `gpt-6-luna` for both the live nested-agent run and
the collector-outage run. Both use the Responses API, low reasoning effort,
and a 1,024-token output limit per call, including reasoning tokens. The
OpenAI adapter's configured endpoint is used, if any. No LangSmith export is enabled.
All prompts are synthetic arithmetic tasks. Do not repurpose the callback to
record private workloads: it deliberately retains the synthetic message body.

## What runs

1. Start the real HypAware daemon with only `@hypaware/otel`, on a dynamic
   loopback port, using a temporary home and cache.
2. Run a supervisor with researcher and reviewer child graphs. Each child calls
   a model, executes the `add` tool, then calls the model again. The researcher
   is a directly embedded subgraph; the reviewer invokes its subgraph from a
   node, with its own message state and explicitly propagated callback config.
3. Export completed callback spans as OTLP/HTTP JSON to the existing collector.
4. Kill that collector process. Run the same workflow, including a deliberate
   tool failure followed by a successful graph retry. The producer writes its
   completed spans to disk, fails one delivery attempt, and exits.
5. Restart the collector on the same port. Start a fresh exporter process to
   replay the disk queue, then replay again to verify the queue is empty.
6. With `--live`, run the same nested workflow using both real OpenAI models
   again with the collector online. The outage step also uses these models.
7. Put a loopback proxy in front of the collector. Forward a batch, wait for the
   collector's successful response, and drop the connection before forwarding
   its acknowledgement. Retry the retained batch against the collector.
8. Stop the collector, inspect the cache and trace schema, and query the real
   `traces` table via `hyp query sql`. Assert captured content, model usage,
   tool correlation, agent ancestry, errors, and delivery counts.

The script prints the artifact directory and exits nonzero on failure.
`steps.jsonl`, `collector.log`, and `agent.log` identify the broken stage.
`*-expected.json` contains messages returned by the actual adapters.
`captured-rows.json` contains SQL results, and `results.json` summarizes checks.
All files stay in the temporary experiment directory; the normal daemon,
client settings, and normal recordings are untouched.

To inspect the experiment cache, use the printed directory:

```sh
HYP_HOME='<artifact-directory>/home/.hyp' node bin/hypaware.js query sql \
  "select name, traceId, spanId, parentSpanId, attributes from traces" \
  --refresh always --format json --max-cell 0 --max-bytes 0
```

## Boundaries and resource use

The experiment supplies the thread ID and service identity. Graph and model
metadata come from framework callbacks. No HypAware dataset columns or
production configuration keys were added. Rows remain in `traces`; existing
session reports and the activity graph are not wired to this source.
Visible text is retained from Responses content blocks; reasoning items are
excluded from the recorded content. Token counts can include reasoning tokens.

The spool is our prototype feature, not a built-in LangGraph local transcript.
Delivery happens at run completion and during explicit replay, with at most
32 spans per request and a three-second timeout. There is no automatic retry
loop. It persists completed spans before transport; a process killed during an
unfinished span can still lose that span. Power loss, concurrent writers,
rotation, and production disk failures are not covered. Files are deleted only
after an acknowledged successful batch. A lost acknowledgement can duplicate
rows because the current OTEL receiver appends without deduplicating span IDs.

CPU/memory pass: there is no per-token capture or full graph-state snapshot per
step. Limits are 256 active spans, 1,024 completions per producer, 64 KiB per
serialized span, and 16 MiB of spool bytes per producer including existing
pending bytes. This bounds the synthetic experiment, not arbitrary workloads:
serialization happens before size rejection, and model request history is
repeated in each model span. Each completion synchronously flushes a file,
which adds latency and must be redesigned before production use. Directory
enumeration and final SQL verification read the bounded experiment into memory.

## Sources

- [LangGraph JavaScript quickstart](https://docs.langchain.com/oss/javascript/langgraph/quickstart)
- [LangChain message representation](https://docs.langchain.com/oss/python/langchain/messages)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Current OpenAI models and Responses tool-use requirements](https://developers.openai.com/api/docs/guides/latest-model)

Callback argument order was checked against the installed JavaScript manager
implementation. The callback and manager methods have different signatures;
the experiment asserts the resulting parent relationships rather than trusting
the declarations alone. See [RESULTS.md](RESULTS.md) for measured results.

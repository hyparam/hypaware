# LangGraph parity findings, 2026-10-16

Standard framework callbacks preserved the tested conversational data and
nested agent structure through the existing HypAware OTEL collector and local
SQL cache. A small sender-side disk spool recovered every completed span after
collector failure and producer exit. Lost acknowledgements caused duplicates.

## Measured run

Run ID: `langgraph-poc-1792174393333`. Real model counts can vary because tool
selection is model-driven.

| Scenario | Stored rows | Unique spans | Model calls | Tool executions |
| --- | ---: | ---: | ---: | ---: |
| OpenAI + Anthropic protocol fixtures | 24 | 24 | 4 | 2 |
| Collector outage, transient tool failure, fresh-process replay | 26 | 26 | 4 | 3 |
| Live GPT-4.1 mini + GPT-4.1 nano | 25 | 25 | 4 | 3 |
| Collector writes batch but acknowledgement is lost, then retry | 48 | 24 | 4 | 2 |

The live model responses identified `gpt-4.1-mini-2025-04-14` and
`gpt-4.1-nano-2025-04-14`. Four live calls reported 393 input tokens and 71 output
tokens in total. Both agents answered `42`. The nano model requested the add
tool twice in one response, so this run had three successful tool executions.
Anthropic was tested through its actual adapter with fixture HTTP responses,
not through a live Anthropic service; no Anthropic credential was available.

## What survived

- All completed spans in each scenario were found after SQL readback.
- Each scenario had one root trace with valid parent links throughout both
  child graphs. Both directly embedded and invoked subgraphs were captured.
- Model input messages, output content, structured tool calls, returned model
  identity, and usage metadata survived OTLP JSON and cache serialization.
- Tool names, arguments `{a:19,b:23}`, result `42`, and call IDs survived.
- The outage case retained the failed tool span and failed tool-node span,
  followed by the successful retry. These are two error spans for one failure.
- All 26 offline spans survived producer exit and were replayed by a fresh
  process. A second replay sent zero rows after successful acknowledgement.
- Losing a successful collector acknowledgement duplicated all 24 retried
  spans. Plain SQL aggregation would double-count their usage.

## Actual parity gaps

1. **Transport recovery needs an idempotent receiver or materializer.** This
   experiment proves at-least-once recovery, not exactly-once recording. Stable
   span IDs make duplicates detectable, but the existing OTEL receiver stores
   both copies. The spool was custom prototype code, not native LangGraph output.
2. **Usage semantics need translation.** Both fixture adapters returned gross
   input tokens of 15. OpenAI's fixture included 4 cache-read tokens, yielding
   11 uncached input tokens. Anthropic's fixture had 9 ordinary input tokens,
   4 cache-read tokens, and 2 cache-creation tokens; LangChain combined them into
   15 and retained the breakdown. HypAware cannot assume the normalized
   LangChain `input_tokens` value is already net of cache activity.
3. **Session/report integration remains absent.** Trace capture does not add
   rows to `ai_gateway_messages`, project activity-graph entities, or make
   existing session reports understand LangGraph. Thread-to-session mapping,
   repeated prompt history, and identity across resumed runs need design work.
4. **Local coding context is absent.** The experiment supplied a thread ID,
   but did not capture repo, commit, cwd, permissions, files touched, or skills.
   Those need application metadata and tool-specific interpretation.
5. **Coverage is deliberately narrow.** No claim about arbitrary external
   agents, uninstrumented model clients, Python, multimodal payloads, token
   streaming, historical checkpoint import, application checkpoint recovery,
   long-running capture, or process death during an unfinished span. Collector
   recovery is separate from resuming a crashed LangGraph application.

The next production step would be a small source integration with durable,
idempotent event ingestion and an explicit normalization contract. Adding only
OTLP protobuf support would not address these semantic and recovery gaps.

## Validation

- `node scripts/langgraph-poc/run.mjs --live`: passed through the real daemon,
  collector, cache, and CLI SQL path.
- `node scripts/langgraph-poc/run.mjs`: passed again after adding explicit
  single-root, ancestor-branch, and tool-call-ID assertions.
- `npm test`: 8,111 passed, 4 skipped, 1 failure in the existing
  `sandbox-shim-supervisor.test.js` process-replacement timing assertion.
- The entire supervisor test file passed separately: 6 passed, 1 skipped.
  No supervisor code was changed. The full suite was not rerun.
- Syntax checks passed for all three prototype modules. CPU/memory limits and
  prototype-only synchronous disk writes are documented in the README.

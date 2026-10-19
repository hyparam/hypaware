# LangGraph parity findings, 2026-10-16

The prototype now captures normal HypAware session rows as well as traces.
It collects project context and offered tool definitions, and prevents duplicate
messages, usage and traces when completed records are replayed. The earlier
append-only receiver findings below are retained as historical baselines.

## Python bundled-plugin validation

Run ID: `langgraph-production-1792191056289`, using live `gpt-6.1-sol` and
`gpt-6-luna` through Python LangGraph 1.2.16 and LangChain Core 1.6.12.
The Python application ran native async nested agents, including one failed
tool attempt and its successful retry, while the HypAware collector was down.
After the application exited, a fresh daemon recovered all 11 session rows,
including four usage-bearing responses. Replaying the same saved events after
another daemon restart added zero duplicate rows. All seven completed events
were queued with zero drops. SQL assertions checked parent links, model names,
structured tool arguments/results, offered tools, working directory and errors.
Synchronous and native async fixture runs also passed against the real Python
SDK. Python uses the bundled recorder's existing privacy and durable queue;
it starts one private Node helper per open callback and closes it at the end.

The sections below describe the earlier OTLP prototype.

## Session mapping and duplicate protection follow-up

Run ID: `langgraph-poc-1792188004432`, using live `gpt-6.1-sol` and
`gpt-6-luna`. The producer and collector run in separate processes. The
prototype plugin uses HypAware's existing gateway row writer and part dedupe;
the bundled generic OTEL collector was not changed.

| Scenario | Unique spans | Session rows | Usage-bearing rows | Duplicates |
| --- | ---: | ---: | ---: | ---: |
| OpenAI + Anthropic fixtures | 24 | 10 | 4 | 0 |
| Live models offline, tool failure, fresh-process recovery | 26 | 11 | 4 | 0 |
| Live models online | 24 | 10 | 4 | 0 |
| Lost acknowledgement, crash/restart, committed replay, concurrent delivery | 24 | 10 | 4 | 0 |

SQL readback verified both agents' conversations and parent links, stable
predecessors and message positions, tool-call arguments and results, the failed
attempt, and exactly one usage carrier per model response. Cache reads and
writes are removed from gross input before storing HypAware's net input field.

All five project columns were populated automatically: `cwd`, `repo_root`,
`git_remote`, `git_branch`, and `head_sha`. These facts are saved on the producer
at run start and survive delayed replay. Tests also cover non-repository folders,
missing Git, absent remote, detached HEAD, and credential stripping.

Both adapters supplied full offered tool definitions, including an `unused`
tool that was never executed. `system_text` was also preserved. Normal session
rows are queryable with `hyp query sql`; report changes remain deferred.

Deterministic tests cover repeated input history, identical answers from distinct
model calls, deeper graph parent mapping, multi-part response usage, partial
write failure, and replay against spooled and committed data. Receiver logs
confirmed duplicate spans were skipped with zero additional message writes.

Remaining limits: this is still an isolated, synthetic-only plugin, with no
production attach/privacy controls, checkpoint-resume identity across callback
instances, opaque external-agent internals, or live Anthropic verification.
Completed-event transport recovery is tested; recovery of a killed application's
unfinished work is not. See the README for bounds and the CPU/memory review.

Validation: `node scripts/langgraph-poc/run.mjs --live` and the final fixture
smoke passed, including `hyp query sql` readback of both tables. All 10 new
deterministic tests passed. Final `npm test`: 8,122 passed, 4 skipped, no failures.
CPU/memory review found no unbounded retained state in this bounded harness;
spool scans and synchronous producer writes remain prototype limitations.

## Earlier current-model follow-up, before session mapping

Run ID: `langgraph-poc-1792182534856`. Live `gpt-6.1-sol` and `gpt-6-luna`
both passed using the Responses API and low reasoning effort. These models
were listed by the configured account and by the
[current OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model).
The defaults now use this pair instead of GPT-4.1.

| Scenario | Stored rows | Unique spans | Model calls | Tool executions |
| --- | ---: | ---: | ---: | ---: |
| Live GPT-6.1 Sol + GPT-6 Luna, collector online | 24 | 24 | 4 | 2 |
| Same live models, collector offline, failed tool and replay | 26 | 26 | 4 | 3 |
| Lost acknowledgement and retry, protocol fixtures | 48 | 24 | 4 | 2 |

Each live scenario reported 362 input tokens and 52 output tokens. All eight
live calls completed. The visible answer was `42` in both scenarios. The
collector was killed before the offline run; the producer finished and exited,
and a fresh process delivered all 26 saved records after collector restart.

In plain language, we can record what the agents said, which model each used,
what tools they called, what the tools returned, and which agent worked under
which parent. We can save completed records while the collector is unavailable
and send them later. We still need to prevent recording the same event twice,
connect this data to normal HypAware session reports, and add project/file
context. The tested app must enable our recorder; LangGraph does not provide a
universal session file that HypAware can discover after the fact.

The newer API returns content blocks, so the prototype now extracts visible
text and excludes reasoning items from recorded content. This arithmetic task
reported zero reasoning tokens, so the run does not establish coverage of
substantial reasoning or newer built-in tools such as computer use. Anthropic
coverage is still fixture-only. The earlier accounting and duplication findings
remain applicable. No production collector or schema code was changed.

## Original GPT-4.1 baseline

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

## Original parity gaps, before the follow-up above

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

## Earlier validation

- Current `node scripts/langgraph-poc/run.mjs --live`: passed with GPT-6.1 Sol
  and GPT-6 Luna through the real daemon, collector, cache, and CLI SQL path,
  including offline live calls, ancestry, and tool-call-ID assertions.
- Current `npm test`: 8,112 passed, 4 skipped, zero failures.
- The initial GPT-4.1 run had one existing supervisor timing-test failure;
  that file passed separately and the current full suite also passed.
- Syntax checks passed for all three prototype modules. CPU/memory limits and
  prototype-only synchronous disk writes are documented in the README.
- CPU/memory review of the model update found no new unbounded work or retained
  state. Content filtering is linear in the bounded response; spool limits are
  unchanged. Per-call generation is capped at 1,024 tokens.

# LangGraph capture parity prototype

The bundled plugin is in `hypaware-core/plugins-workspace/langgraph`; see the
[customer guide](../../docs/integrations/langgraph.md) for setup.
`node scripts/langgraph-poc/production.mjs [--live]` tests the production recorder,
producer exit, daemon restart and duplicate replay, with SQL and delivery-log
assertions. Required CI runs it for JavaScript, Python sync and Python async
using real SDKs and synthetic responses without provider credentials. Test
dependencies live outside the published package. The original OTLP experiment
is retained below as historical evidence, not the production capture path.
It asks whether standard LangChain callbacks can preserve local-session-like
content, nested agent relationships, and offline recovery through HypAware.

## Python production validation

Install the Python test dependencies into a temporary virtual environment:

```sh
python3.13 -m venv /tmp/hypaware-langgraph-python-deps
/tmp/hypaware-langgraph-python-deps/bin/pip install \
  langgraph==1.2.16 langchain-core==1.6.12 langchain-openai==1.7.2
node scripts/langgraph-poc/production.mjs --python
node scripts/langgraph-poc/production.mjs --python --async
node scripts/langgraph-poc/production.mjs --python --async --live
```

Set `HYP_LANGGRAPH_PYTHON` to use another environment. The first two runs use
real Python LangGraph with a deterministic local model; `--live` uses
`gpt-6.1-sol` and `gpt-6-luna` with the configured OpenAI credential. Both sync
and native async runs exercise nested agents, offered tool definitions, a failed
tool attempt and retry, project context, producer exit while the collector is
down, daemon recovery and duplicate replay after another restart. Assertions
read the normal session table through the real CLI. The Python callback starts
and closes the shared recorder helper automatically. No test dependencies are
added to HypAware's package.

## Original OTLP experiment

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

1. Start the real HypAware daemon with a temporary LangGraph prototype plugin,
   on a dynamic loopback port, using a temporary home and cache. It reuses the
   existing OTLP parser, trace schema, and gateway session writer.
2. Run a supervisor with researcher and reviewer child graphs. Each child calls
   a model, executes the `add` tool, then calls the model again. The researcher
   is a directly embedded subgraph; the reviewer invokes its subgraph from a
   node, with its own message state and explicitly propagated callback config.
3. Capture project context on the producer and tool definitions from model
   callback invocation parameters. Export completed spans and their session
   projections as OTLP/HTTP JSON to the prototype collector.
4. Kill that collector process. Run the same workflow, including a deliberate
   tool failure followed by a successful graph retry. The producer writes its
   completed spans to disk, fails one delivery attempt, and exits.
5. Restart the collector on the same port. Start a fresh exporter process to
   replay the disk queue, then replay again to verify the queue is empty.
6. With `--live`, run the same nested workflow using both real OpenAI models
   again with the collector online. The outage step also uses these models.
7. Put a loopback proxy in front of the collector. Forward a batch, wait for the
   collector's successful response, and drop the connection before forwarding
   its acknowledgement. Kill and restart the collector, then retry the retained
   batch. Restart again after committing the cache and deliver duplicate batches
   concurrently, retrying a refused busy request.
8. Stop the collector, inspect the cache and trace schema, and query the real
   `traces` and `ai_gateway_messages` tables via `hyp query sql`. Assert captured
   content, usage exactly once per response, tool correlation, agent ancestry,
   errors, project context, definitions of an uncalled tool, and no duplicates.
   Assert the receiver telemetry reports the duplicate path was exercised.

The script prints the artifact directory and exits nonzero on failure.
`steps.jsonl`, `collector.log`, and `agent.log` identify the broken stage.
`*-expected.json` contains messages returned by the actual adapters.
`captured-rows.json` and `session-rows.json` contain SQL results, and
`results.json` summarizes checks.
All files stay in the temporary experiment directory; the normal daemon,
client settings, and normal recordings are untouched.

To inspect the experiment cache, use the printed directory:

```sh
HYP_HOME='<artifact-directory>/home/.hyp' node bin/hypaware.js query sql \
  "select session_id, conversation_id, model, tool_name, cwd, git_branch, tools from ai_gateway_messages" \
  --refresh always --format json --max-cell 0 --max-bytes 0
```

## Boundaries and resource use

The experiment supplies the thread ID and service identity. Graph and model
metadata come from framework callbacks. No HypAware dataset columns or
production configuration keys were added. Messages now use the normal
`ai_gateway_messages` columns; callback lifecycle spans also remain in `traces`.
Reports and activity-graph integration are outside this experiment.
Visible text is retained from Responses content blocks; reasoning items are
excluded from the recorded content. Token counts can include reasoning tokens.

The mapping uses one session container and separate conversations for enclosing
graph invocations, with `agent_id` and `parent_thread_id` links. Framework nodes
are still spans, not invented chat messages. Message IDs, predecessor links,
positions and timestamps are fixed on the producer before spooling, so replay
order does not change them. Repeated input history does not add messages or
usage; distinct model calls retain distinct response IDs even for identical
answers. Tool failure attempts remain separate from the eventual result.
Input usage is net of cache reads and writes, matching the existing table.

`cwd`, `repo_root`, `git_remote`, `git_branch` and `head_sha` are collected once
when creating the callback. Missing Git facts stay absent, including branch on
a detached HEAD. Git runs locally with a two-second timeout and bounded output;
remote credentials, query strings and fragments are removed. The callback can
receive a different working directory as its fifth constructor argument.
Context is a run-start snapshot, not tracking every later directory or branch
change. System text and offered tool definitions are captured per model request.

The spool is our prototype feature, not a built-in LangGraph local transcript.
Delivery happens at run completion and during explicit replay, with at most
32 spans per request and a three-second timeout. There is no automatic retry
loop. It persists completed spans before transport; a process killed during an
unfinished span can still lose that span. Power loss, concurrent writers,
rotation, and production disk failures are not covered. Files are deleted only
after an acknowledged successful batch. The prototype collector checks stored
and spooled `(traceId, spanId)` pairs, while the existing gateway writer checks
message part IDs. Message writes precede trace writes; failure between them
can retry without double billing. A deterministic test injects this failure.
Concurrent requests are refused while one is writing, with no retained queue.
The bundled generic OTEL receiver is unchanged and still appends duplicates.

This is not a production plugin: automatic attach, recording opt-out controls,
folder privacy policy integration and checkpoint/resume identity across new
callback instances remain outside the proof. Only use the synthetic harness.

CPU/memory pass: there is no per-token capture or full graph-state snapshot per
step. Limits are 256 active spans, 1,024 completions per producer, 64 KiB per
serialized span, and 16 MiB of spool bytes per producer including existing
pending bytes. Session mapping adds a cap of 256 graph conversations and 4,096
messages per callback, with at most two identity entries per message. The
receiver retains only a batch's span identities and discards gateway writer
state after each batch. Its trace reads are scoped to the batch's trace IDs;
spool scans still grow with pending data, acceptable only for this bounded
experiment. No new runtime dependencies or production hot paths were added.
This bounds the synthetic experiment, not arbitrary workloads:
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

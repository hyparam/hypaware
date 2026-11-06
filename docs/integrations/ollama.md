# Ollama

<!-- @ref LLP 0474#setup [implements]: attended setup discovers the direct service and supplies explicit next-client routes without loading a model -->
<!-- @ref LLP 0475#t5 [implements]: installed client commands replace the disposable developer configuration as the ordinary path -->

Choose **Ollama** in `hyp setup`. On an existing installation, choose
**Reconfigure** to add it beside your current clients. For a fresh unattended
installation that keeps recordings local:

```sh
hyp setup --source ollama --export keep-local
hyp ollama setup
hyp client status ollama
```

To add Ollama on an existing installation while preserving its export choice,
run `hyp setup --source ollama` without `--export`. An explicit `--export` changes
that choice. Other clients are preserved; check `hyp status` to see your sinks. Recorded local inference can leave the host through configured sinks.
Setup checks the service and model inventory without starting Ollama, downloading
or loading a model, or sending inference. Missing executable, unavailable service
and empty model inventory are separate results. SDK use does not need the CLI
executable. Configure or start your direct Ollama service yourself if necessary.

The direct service defaults to `http://127.0.0.1:11434`. To use a custom service:

```sh
hyp ollama setup --upstream http://127.0.0.1:21434
hyp ollama setup
```

This preserves the other upstreams and recording choice. If an endpoint was
saved but its restart or live route is unconfirmed, run `hyp daemon restart`, then
`hyp ollama setup` again. Organization-owned settings can prevent local changes.
Do not point the direct upstream at the collector's own capture host.

## Route a CLI or SDK client

Use the **Capture root (live)** printed by `hyp ollama setup`, including its
`/ollama` suffix. The examples below assume that output is
`http://127.0.0.1:18521/ollama`; replace it with your actual live root.
The supported client versions are **Ollama CLI 0.35.1** and **official Python SDK
0.6.1**. Other versions require checking their request shapes. Native heartbeat,
version, tags, model show, chat and generate calls are forwarded. OpenAI-compatible
routes and model-management commands are outside this capture route.

Replace `gemma3:4b` in every CLI, SDK, verify and direct-recovery example below
with the exact installed model name listed by setup. Start a new CLI at the
printed host:

```sh
OLLAMA_HOST=http://127.0.0.1:18521/ollama ollama run gemma3:4b --think=false
# Or send one prompt:
OLLAMA_HOST=http://127.0.0.1:18521/ollama ollama run gemma3:4b --think=false 'Reply briefly with hello.'
```

Construct the SDK with an explicit host; changing an environment variable does
not reroute an already constructed object:

```python
from ollama import Client

client = Client(host='http://127.0.0.1:18521/ollama')
response = client.chat(
    model='gemma3:4b',
    messages=[{'role': 'user', 'content': 'Reply briefly with hello.'}],
    think=False,
    stream=False,
)
print(response.message.content)
```

`client.generate(model=..., prompt=..., think=False, stream=False)` also records
text. Set `stream=True` for either method and consume the iterator through its
completed response. Setup does not change existing client processes or SDK
objects. Keep the printed **Direct upstream** for recovery if the collector stops.

## Confirm the first saved request

<!-- @ref LLP 0474#diagnostics [implements]: success requires the fresh correlated policy-visible committed request and completed new response -->
<!-- @ref LLP 0476#confirmation [implements]: the bounded read-only reader cannot use receipt, spool or retained status as saved-row proof -->

```sh
hyp ollama verify --model gemma3:4b
hyp client status ollama
hyp status
```

The explicit check discloses and sends the fixed prompt
`Reply with OK. This is a HypAware capture check.` and records its response.
Configured sinks may export both. A **persisted** result names the `request_id`
of a fresh, linked request and completed assistant response visible under your
current query policy. HTTP success or an earlier saved stamp alone cannot pass.
To inspect that check, substitute the returned opaque ID:

```sh
hyp query sql "select request_id, message_index, part_index, role, content_text, model
  from ai_gateway_messages where request_id = 'paste-the-request-id'
  order by message_index, part_index" --refresh never --format json
```

Over MCP, run the same SQL with `query_sql`.

<!-- @ref LLP 0476#cohort [constrained-by]: verification uses ordinary full refresh of the shared current gateway spool and retains its existing hooks/backlog cost -->

Verification requests an ordinary full refresh of the shared gateway spool.
It can process earlier pending rows and other clients' pending rows, and runs
normal storage and sink hooks. Work and memory use depend on that backlog.
Inference has a 30-second limit, followed by a separate total 30-second storage
confirmation limit including startup and at most six serialized reads/settlement
attempts. Its query worker reads committed data without refreshing or migrating
legacy query configuration; normal policy visibility still applies.

<!-- @ref LLP 0476#lifecycle [implements]: caller timeout leaves live service ownership intact while actual collector stop may interrupt confirmation -->

If inference completed but storage confirmation timed out, settings are unchanged
and live collector work may finish. A retry can report busy while that work is
still running. No automatic inference retry occurs. Stopping HypAware or losing
its processor can interrupt confirmation; an unconfirmed check is not proof of
saved data. Resolve the [reported reason](../TROUBLESHOOTING.md#ollama-capture-is-unconfirmed),
then explicitly retry when ready.

Status distinguishes a live ready route with no observed traffic, observed work
awaiting persistence, append-resolved persistence evidence, a finite failure
reason, and off/unconfirmed states. A saved timestamp in an off or stopped
installation is historical; it does not establish current recording or that a
particular response is queryable. Use verify for the fresh committed-pair check.

## Stop and resume Ollama recording

<!-- @ref LLP 0474#recording [implements]: an acknowledged live barrier suppresses old-generation capture while preserving forwarding and other clients -->

```sh
hyp client detach ollama
hyp client status ollama
```

Wait for successful live confirmation. The same running CLI session or SDK object
can keep using the unchanged capture host: inference continues, new Ollama requests
are unrecorded, and saved history remains. Other attached clients keep recording.
An unconfirmed detach is not a completed stop barrier. Follow its recovery message
and retry detach; do not treat a saved preference alone as live confirmation.
Organization policy can refuse detach without changing settings.

To resume explicitly:

```sh
hyp client attach ollama
hyp ollama setup
```

Successful attach starts a new recording generation. Only new requests can be
captured; an older response finishing after detach or reattach is not resumed
history. There is no import of CLI chat history or replay of capture lost during
an outage.

If HypAware itself stops, its capture host stops forwarding. Launch a CLI with
the preserved direct upstream, or create a new SDK object using that root:

```sh
OLLAMA_HOST=http://127.0.0.1:21434 ollama run gemma3:4b --think=false
```

```python
from ollama import Client
client = Client(host='http://127.0.0.1:21434')
```

Replace `21434` with the exact **Direct upstream** printed for your installation,
including a custom path if present. Direct requests are not recorded. This does
not require stopping Ollama or changing its service configuration.

## Text, media and privacy limits

<!-- @ref LLP 0474#projection [implements]: each request is an ordered snapshot and omitted media keeps positional markers without media payloads -->

Chat saves ordered system/user/assistant text plus the newly completed assistant
response. Generate saves explicit system text when present, its prompt and the
new response. Each request is a separate context snapshot: submitted earlier
context appears again, and equal text at different positions remains distinct.
Generate token context is not decoded into invented earlier conversation.
Empty text retains its position with null `content_text`. Only the newly generated
response has usage; model identity comes from this exchange's response when present.

Image bytes, URLs, names and MIME guesses are omitted. Each native image position
becomes an ordered empty image marker after that message's surviving text.
`think=False`, null defaults, empty thinking and empty tools are supported.
Nonempty thinking, tool calls, unknown request/response fields, unsupported audio,
malformed/truncated streams and failed exchanges omit the whole exchange, including
partial text. Unsupported requests can still be forwarded. Load/unload control
traffic is not a saved conversation.

Native observed counts appear in `raw_frame`; normalized usage is in
`attributes.usage` on the new response only. Net input is known only when both
prompt and cache counts are observed. Missing counts remain unknown; zero remains
zero. Invalid counts are omitted without inventing totals.

<!-- @ref LLP 0474#resources [constrained-by]: bounded capture copies and expansion do not establish a process RSS ceiling -->

Capture has byte, concurrency, lifetime and projected-position limits, so a large
or interrupted exchange may be omitted while forwarding continues. These limits
bound capture copies, not total process memory. Check ordinary status and logs for
actionable reasons; [troubleshooting](../TROUBLESHOOTING.md#ollama-capture-is-unconfirmed)
explains the next step.

This API supplies no reliable working directory or repository. Those fields stay
unknown, so directory-based exclusions cannot protect this lane. Normal local-only
and session-purge query visibility still applies. Review privacy settings and
configured exports before routing sensitive requests.

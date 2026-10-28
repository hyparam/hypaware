# LangGraph

**Status:** Beta. **Setup id:** `langgraph`. **Backfill:** No checkpoint or
historical session import; completed events saved by the callback recover after
a collector outage.

HypAware records LangGraph applications written in JavaScript or Python through
callbacks you add to the application. Model requests still go directly to your
provider. No LangSmith account, model proxy or OpenTelemetry exporter is needed.

## What is recorded

Visible prompts and responses, model names, token usage when the provider
supplies it, offered tool definitions, tool arguments/results and errors, and
nested graph conversations with parent links. Records use the normal
`ai_gateway_messages` table. Project context includes the working directory and
available repository root, remote, branch and commit at callback creation.
Missing Git information stays absent; Git remote credentials are removed.

Priced cost is not supplied by this integration. Hidden reasoning, images and
other media, arbitrary graph state, every internal node span and individual
streaming tokens are not recorded. Streaming captures the completed response.
LangChain `create_agent`, Deep Agents and hosted Agent Server deployments have
not been validated separately; this page's tested scope is LangGraph.

## Set it up

Install HypAware with Node.js 22.12 or newer on the same host as your application.
Keep using your application's own LangGraph and model-provider packages.
Python applications additionally need their existing LangChain Core package
and access to the Node executable installed with HypAware.

Run `hyp setup` from your application directory. A direct LangGraph dependency
in `package.json`, `requirements.txt`, or the standard `[project] dependencies`
array in `pyproject.toml` suggests **LangGraph (JavaScript / Python)** in setup.
Detection checks only that directory and reads at most 256 KiB per file. It
does not inspect parent projects, lockfiles, requirement includes, Poetry tables,
or dynamic metadata. Without a matching declaration, choose **Customize** and
select LangGraph explicitly. Detection does not wire your application: you must
still add the callback printed by attach. To add the integration later:

```sh
hyp client attach langgraph
hyp client status langgraph
```

Accept the offer to enable recording if prompted. Attach prints both language
examples with the exact paths for this installation. It creates a managed
module, normally `~/.config/hypaware/langgraph.mjs`; it does not edit your
application. For a fresh unattended local-only installation, use:

```sh
hyp setup --source langgraph --export keep-local
hyp client attach langgraph
```

Attach remembers this installation's HYP_HOME and config path, including custom
locations. Rerun attach after moving the HypAware installation. Use a durable
global installation rather than copying paths from a disposable npx directory.

### JavaScript

Copy the exact import printed by attach. This example shows its shape:

```js
import { createHypAwareCallback } from 'file:///absolute/path/printed/by/attach/langgraph.mjs'

const capture = createHypAwareCallback({ sessionId: 'your-conversation-id' })
const result = await graph.invoke(input, {
  callbacks: [capture],
  configurable: { thread_id: capture.sessionId },
})
console.log(capture.status())
```

### Python

Copy the complete Python example printed by attach, including `sys.path`,
`module_path` and `node_path`. The Python adapter ships inside HypAware; this
integration does not require a separate `pip install hypaware-langgraph`.

```python
import sys
sys.path.insert(0, "/absolute/path/printed/by/attach/python")
from hypaware_langgraph import create_hypaware_callback

with create_hypaware_callback(
    session_id="your-conversation-id",
    module_path="/absolute/path/printed/by/attach/langgraph.mjs",
    node_path="/absolute/path/printed/by/attach/node",
) as capture:
    result = graph.invoke(input, config={
        "callbacks": [capture],
        "configurable": {"thread_id": capture.session_id},
    })
    print(capture.status())
```

For asynchronous graphs, use `await graph.ainvoke(...)` with the same config.
The callback starts one private Node helper automatically, sharing the same
recorder as JavaScript. There is no second service to start. Reuse the callback
across conversation turns, then close it with the context manager above or
`capture.close()`. Each open callback has the memory cost of its Node helper.
Create callbacks inside worker processes; do not share an open callback across
forked Python processes.

### Session identity and nested agents

Use one callback per conversation. Supply a stable session ID and pass the same
value as LangGraph's `thread_id` when resuming a conversation. Omitting the ID
creates a new one; the recorder does not infer it from an arbitrary config.
Pass `cwd` to the factory if the process starts outside the application's project.

Keep propagating the callback config to nested graphs, models and tools. Normal
LangGraph propagation handles this; custom invocations must preserve it.
Tool results with a matching call ID retain the model and definitions that
requested them even when models run concurrently. Correlation keeps at most 64
pending calls; an unmatched explicit ID has unknown model context.

## Verify capture

Run a small application turn, inspect `capture.status()` and check HypAware:

```sh
hyp status
hyp query sql "select session_id, conversation_id, model, role, content_text from ai_gateway_messages where client_name = 'langgraph' limit 20" --refresh always
```

The source initially reports `waiting_for_application`. The callback's `queued`
count means completed events were written to the local queue, not necessarily
collected yet. `dropped`, `policyDrops` and `lastError` identify recording
failures or privacy exclusions. The daemon normally checks the queue every
second and reports pending events, rows written and duplicate rows skipped.

## Remote hosts and HypAware Cloud

Run the application, callback journal and HypAware collector on the same remote
host, under the same OS user. For a containerized application, run them inside
that container. Use the same `HOME`, `HYP_HOME` and any custom `HYP_CONFIG` for
setup, attach, collection and the application. Copy the callback paths printed
on that host into the application; laptop paths do not apply there. Python still
starts its private Node helper automatically.

Use a HypAware build containing the LangGraph plugin. As of 2026-10-20, the
plugin is merged but the published npm latest, 1.43.0, does not contain it. The
remote validation below used a tarball built from merged master. Identify a
prerelease tarball by its source commit rather than its package version alone.

On your signed-in workstation, mint an enrollment token and store the printed
value in the remote job's secret store as `HYP_CI_TOKEN`:

```sh
hyp remote mint --label langgraph-worker
```

On a fresh remote installation, with Node.js 22.12 or newer and a durable
HypAware installation, configure LangGraph and join your team:

```sh
hyp setup --source langgraph --export configure-later --no-backfill --no-daemon
hyp client attach langgraph
printf '%s' "$HYP_CI_TOKEN" | hyp join https://api.hypaware.ai --no-daemon
( rc=75; while [ "$rc" -eq 75 ]; do hyp daemon run && rc=0 || rc=$?; done; exit "$rc" ) &
hyp status
hyp client status langgraph
```

For a self-hosted server, use its base URL in place of `https://api.hypaware.ai`.
An existing installation can add LangGraph with `hyp client attach langgraph`;
preserve its configuration and existing enrollment. The
[headless deployment guide](ci-and-headless.md) covers token expiry, foreground
supervision and long-lived service installation.

Before starting the application, confirm that `hyp status` reports the daemon
running, the LangGraph source ready and the central destination configured.
Organization configuration can request a restart during enrollment; the loop
above handles exit 75. A source waiting for an application is ready to receive
callbacks. Add the [JavaScript](#javascript) or [Python](#python) callback recipe
printed on the remote host, and use a unique session ID for your verification
run. Model credentials stay with the application.

After the application finishes, keep the collector running until its pending
events are drained and the session is queryable locally. Substitute your actual
session ID in both queries below. On the remote host:

```sh
hyp query sql "select session_id, count(*) as rows from ai_gateway_messages where client_name = 'langgraph' and session_id = 'your-verification-session-id' group by session_id" --refresh always
hyp sync --yes
```

Confirm that sync reports a successful upload. Then, on your workstation,
discover your configured query target and query the same session on the server:

```sh
hyp remote list
hyp query sql "select session_id, count(*) as rows from ai_gateway_messages where client_name = 'langgraph' and session_id = 'your-verification-session-id' group by session_id" --remote <target>
```

Replace `<target>` with a name from `hyp remote list`. Matching remote rows
confirm central visibility. Callback `queued` counts and successful remote
execution alone do not confirm upload. Folder, session and client privacy
controls still apply: local-only rows stay on the remote host. Apply the intended
privacy settings before running the application.

**Remote validation, 2026-10-20:** an isolated installed build from master
`4056c359b5fc3398dde5064644c58df5f262de69` passed on a Linux host using real
JavaScript, Python sync and Python async LangGraph SDKs with fixture responses.
Nested agents and tool failure/retry produced 21 completed events while the
collector was stopped. Restart recovered 33 rows, including 12 usage carriers;
replay added zero rows or token usage. The normal enrollment/export path sent
all three sessions to HypAware Cloud, where remote SQL confirmed matching rows
and usage. Fresh live-model requests were blocked by OpenAI credits and
Anthropic HTTP 429 responses, so this run does not establish fresh live-model
compatibility. Systemd/launchd installation and hosted Agent Server deployments
were not exercised.

## Recovery and limits

Completed events are saved under `<HYP_HOME>/hypaware/langgraph/outbox` before
the callback acknowledges them. HypAware drains them when it starts, even if
the application has exited. Replaying the same saved event does not duplicate
rows or token usage. Rerunning the application is new work with new model calls,
not a replay of the same event.

The shared queue holds 256 events of at most 512 KiB each. A full queue or an
oversized event is dropped and reported by the callback; it does not fail the
application. This is bounded recovery of completed callbacks, not unlimited
offline retention, recovery of unfinished calls, or a power-loss guarantee.
Existing checkpoints supplied as context are not imported as new responses or
billed again. There is no `hyp backfill langgraph` provider.

## Privacy, stopping and resuming

[Folder and session privacy controls](../PRIVACY.md) apply before queueing and
again before collection. Local-only rows keep their directory so export rules
withhold them. To stop this integration:

```sh
hyp client detach langgraph
```

Already-loaded callbacks check recording policy again. Detach removes the
managed module; remove or conditionally disable its use in the application
before the next launch, otherwise its import will fail. Reattach and restore
the callback to resume. Detach does not purge already recorded data. Apply
privacy markings before starting a sensitive workload, not after it has run.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Waiting for an application | Add the printed callback, pass its config to the graph, and complete a model or tool call. Attach alone cannot record an application. |
| Events queued, no rows yet | Check `hyp status` and the daemon's error; confirm the application uses the managed module for this installation. Start or restart the collector after fixing its reported issue. |
| `queue_full` / `event_limit` | Restore collector delivery, or reduce the size of the recorded event. Dropped events have no independent historical importer. |
| `policyDrops` increases | Check recording is enabled and inspect folder/session exclusions. Do not remove privacy controls merely to make a test pass. |
| Python `recording_failed` | Check the printed Node and module paths still exist. A dead or unresponsive helper closes after its timeout; close this callback and create a new one after fixing the cause. Already queued events remain recoverable. |
| Missing tokens or model context | The provider must supply usage metadata; models/tools must propagate callbacks and call IDs. Missing values are not estimates. |
| Staging slots remain without events | Staging owned by a dead process can be reclaimed after a day; unknown owners require inspection. Do not delete a slot owned by a live or suspended writer. |

Tested with JavaScript LangGraph 1.5.0 / Core 1.2.18, and Python 3.13 with
LangGraph 1.2.16 / Core 1.6.12 / LangChain OpenAI 1.7.2. Tests include Python
sync and async, nested agents, two live models, tool retries, collector outage
and duplicate replay. These are tested versions, not a blanket guarantee for
every LangChain extension or provider. Reproducible developer commands are in
the [validation harness](../../scripts/langgraph-poc/README.md).

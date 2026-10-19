# LangGraph for HypAware

Customer setup, verification and troubleshooting:
[LangGraph integration guide](../../../docs/integrations/langgraph.md).

Choose **LangGraph (JavaScript / Python)** under **Customize** during setup. If you
already chose **Record everything**, run:

```sh
hyp client attach langgraph
```

Accept the offer to enable it. The command prints an import pointing to a
managed module on your machine and examples for both languages. In JavaScript:

```js
// Use the exact import path printed by attach.
const capture = createHypAwareCallback({ sessionId: 'your-conversation-id' })
await graph.invoke(input, {
  callbacks: [capture],
  configurable: { thread_id: capture.sessionId },
})
```

For Python, copy the printed Python example, including its exact module and
Node paths. The callback uses the LangChain dependency already installed with
your Python LangGraph application:

```python
# Use the sys.path, module_path and node_path values printed by attach.
from hypaware_langgraph import create_hypaware_callback

with create_hypaware_callback(session_id="your-conversation-id",
                             module_path="/path/printed/by/attach/langgraph.mjs",
                             node_path="/path/printed/by/attach/node") as capture:
    result = graph.invoke(input, config={
        "callbacks": [capture],
        "configurable": {"thread_id": capture.session_id},
    })
```

For asynchronous Python applications, use `await graph.ainvoke(...)` with the
same callback configuration. Python starts a private Node helper automatically
to use the same recorder as JavaScript. It is one process per open callback;
reuse the callback across conversation turns and close it when finished, using
`with` as above or `capture.close()`. There is no second service to install.

Use one callback per conversation and the same session ID when resuming it.
Pass `cwd` to the factory if your application starts outside its project.
Keep passing the graph's callback configuration to nested model/tool calls.
Normal LangGraph propagation does this automatically. Streaming records the
completed model response; it does not save each token separately.

Run the application, then `hyp status`. Before any records arrive the source
reports `waiting_for_application`. Inspect `capture.status()` for dropped
records, queue errors and the generated session ID. No LangSmith account,
model proxy or extra runtime dependency is needed.

Records appear in the normal `ai_gateway_messages` table: visible prompts and
responses, models, usage, offered tool definitions, tool arguments/results,
child conversations, and available working-directory/Git information. Git facts
are captured when the callback is created. Providers must expose usage through
their LangChain callbacks for token counts to be available.

Completed events are saved locally while HypAware is stopped and collected when
it restarts, even if the application has exited. Replaying saved events does not
duplicate session rows or token usage. The private queue holds 256 events of at
most 512 KiB each. Oversized events or a full queue drop recording of that event;
they do not fail the application. An application killed during an unfinished
model/tool call cannot supply its result. Disk/policy failures appear in source
status or callback status. Unknown-owner staging slots require manual inspection
if a process dies between reserving a slot and writing its owner marker.

Python allows one event at a time through a bounded pipe to its helper and waits
for the recorder's acknowledgement. A dead or unresponsive helper stops capture
for that callback and reports dropped events through `capture.status()` without
failing the agent. Create a fresh callback to resume recording after a helper
failure. A stopped HypAware collector does not stop the helper or local queue.

Folder ignores, local-only export policy, `hyp session ignore <session-id>`,
and `hyp client detach langgraph` apply. Already-loaded callbacks check recording
policy again before writing. Pending events are checked again before collection.
Detach removes the managed import module; remove its import from your application
before launching that application again. Reattach after moving or removing the
HypAware installation the module points to.

This first version supports JavaScript and Python LangGraph chat-model and tool
callbacks. It does not import old checkpoints, save hidden
reasoning or media, or reconstruct arbitrary graph state and every internal node
span. A callback attached after work has already happened cannot recover that
work. Historical assistant messages supplied as context are not billed again.

Validation:

```sh
npm run smoke -- langgraph_capture
node scripts/langgraph-poc/production.mjs
node scripts/langgraph-poc/production.mjs --live
node scripts/langgraph-poc/production.mjs --python --async --live
```

The production scripts use the separate LangGraph test dependencies described in
`scripts/langgraph-poc/README.md`. Live validation uses synthetic arithmetic
prompts and the configured OpenAI credential. All runs use temporary installs.

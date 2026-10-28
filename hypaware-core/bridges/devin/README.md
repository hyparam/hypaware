# Devin selected-session pilot (HYP-282)

This opt-in Node bridge reads one Devin Cloud session and sends its native
conversation messages and lifecycle snapshots to HypAware's existing OTLP/JSON
`logs` receiver. It is a pilot, validated with a mocked vendor API and a real
HypAware receiver/cache/query path. Real Devin access is pending.

There is no plugin activation, session creation, vendor-wide discovery, new
production configuration or table schema. Normalized `ai_gateway_messages`
projection belongs to HYP-254. Messages are conversation evidence: neither the
API contract nor the mock proves a shell/tool transcript, tool success, model
identity or token usage. ACUs stay ACUs. Incoming automation webhook triggers
are not session exports.

## Run an existing completed session

Use Node 22.12 or newer. First obtain an organization ID (`org-...`), a selected
completed session ID (`devin-...`) and an authorized `cog_` service-user key or
PAT. The principal must belong to the organization and either have created the
session, hold its `session.view` grant, or have `ViewOrgSessions`. Broad admin
access is unnecessary for a granted session. Set `DEVIN_API_KEY` securely in the
local process environment; do not put it in command arguments, tickets or chat.

Use a disposable receiver to keep the pilot separate from the everyday install.
From the repository or installed package root, create a temporary directory and
write this `hypaware-config.json` inside it:

```json
{
  "version": 2,
  "plugins": [
    {
      "name": "@hypaware/otel",
      "config": { "listen_host": "127.0.0.1", "listen_port": 14318 }
    }
  ]
}
```

With `PILOT_HOME` pointing at that directory, start the disposable foreground
daemon in one terminal:

```sh
HYP_HOME="$PILOT_HOME" HYP_CONFIG="$PILOT_HOME/hypaware-config.json" \
  node bin/hypaware.js daemon run
```

In a second terminal with `DEVIN_API_KEY` already available, import the selected
session once. Replace the placeholder IDs. The receiver must be on loopback;
redirects are refused on both connections, and the vendor credential is sent
only to the Devin API.

```sh
node hypaware-core/bridges/devin/index.js \
  --org org-EXAMPLE --session devin-EXAMPLE \
  --state "$PILOT_HOME/devin-checkpoint.json" \
  --endpoint http://127.0.0.1:14318/v1/logs
```

Add `--watch` to poll at 30-second intervals for an already authorized running
session. Polling stops after draining messages when status is `exit`, `error`,
or `suspended`, or status_detail is `finished`, `waiting_for_user`, or
`waiting_for_approval`. Waiting/suspended sessions can be read again later with
the same checkpoint. No vendor session is started, resumed, messaged or changed.
The summary reports native status/detail, pages, delivered records, replayed
messages, received bytes and distinct acknowledged messages. A nonzero exit
means an explicit bound or failure, not successful complete capture.

## Query and reconcile

Run these against the disposable receiver's `HYP_HOME`/`HYP_CONFIG`:

```sql
select timestamp, observedTimestamp, body, attributes
from logs
where serviceName = 'devin'
  and JSON_VALUE(attributes, '$.session_id') = 'devin-EXAMPLE'
order by timestamp
```

```sql
select JSON_VALUE(attributes, '$.event_kind') as kind,
       count(*) as rows,
       count(distinct JSON_VALUE(attributes, '$.event_id')) as distinct_events
from logs
where serviceName = 'devin'
  and JSON_VALUE(attributes, '$.session_id') = 'devin-EXAMPLE'
group by JSON_VALUE(attributes, '$.event_kind')
```

`body` retains all returned vendor fields, including unknown fields, nulls,
message text, source event IDs/times, session status/detail, PR links and ACUs.
`attributes` carries `org_id`, the requested prefixed `session_id`, `event_kind`
(`message` or `session`), and message `event_id`/`source`. The native response
`session_id` is preserved unchanged inside the body even when unprefixed.
`timestamp` derives from message `created_at` or snapshot `updated_at`;
`observedTimestamp` records local receipt time. The pilot expects integer Unix
seconds and refuses missing, invalid or millisecond-scale values instead of
substituting observation time. Verify the unit against a real response and
vendor view during access validation; the public endpoint schemas show integers
without a unit declaration.

For live acceptance, compare both message sources, distinct native event counts,
ordering/time bounds, final status/detail, PR URLs and native usage with the
vendor view. Keep actual content local. Record only redacted samples and
aggregate reconciliation in shared evidence. A returned PR URL is a vendor
claim until corroborated with repository evidence. Conversation-level visibility
meeting the product need remains an open product decision; the repeated-failure
and improvement criterion is unproven from narrative summaries alone.

## Bounds and recovery

Fixed per-invocation ceilings: 100 message pages (100 requested items per page),
64 MiB of received successful response bodies, 2 MiB per response, 8 MiB per
outgoing OTLP envelope, 10 seconds per request, three attempts per request, and
15 minutes total. Retry network/timeouts, 429 and 5xx with 1/2-second backoff;
honor a longer Retry-After up to 30 seconds and refuse longer delays. Other HTTP
errors fail immediately. No prompt/content is truncated to fit a bound.

The checkpoint is capped at 1 MiB and 10,000 distinct message hashes across
restarts. It stores identities, destination, hashes and cursor, without message
text or credentials. It is written atomically with fsync and mode 0600 after
acknowledgement. Reuse the same file and destination after transient failure.
Confirmed event hashes deduplicate overlapping/repeated pages; unchanged session
snapshots are also suppressed. Each poll/restart resumes at the last unfinished
or final-page request cursor, so a null final cursor does not force a whole
history rescan. At most the final page is revisited when caught up. Earlier
history edits or late insertions before that cursor are outside this pilot's
recovery guarantee. Expired/rejected cursors fail visibly rather than silently
resetting progress.

Only one process may hold a checkpoint. Normal failures release its `.lock`;
a crash leaves that lock in place. Once the old process is confirmed stopped,
remove only the `.lock` and rerun with the checkpoint intact. Separate checkpoint
files do not coordinate with each other. Deleting a checkpoint or choosing a
new one reimports records. OTLP has no idempotency acknowledgement: lost HTTP
acknowledgements, partial success, or a crash between receiver acceptance and
checkpoint publication can replay accepted records. Use distinct native event
IDs in reconciliation; this is not exactly-once storage.

CPU/memory review: one bounded response and OTLP batch at a time, one capped
hash set, sequential requests, bounded retries and sleeping polls. Checkpoint
serialization is bounded by 10,000 hashes and runs once per page/snapshot. No
unbounded transcript buffer, busy loop or vendor-wide scan is present.

## Validation and pending access

```sh
node --test test/plugins/devin-bridge.test.js
npm run smoke -- devin_capture
npm run typecheck
```

The smoke uses an isolated home and real OTLP receiver, persistent cache and SQL.
It asserts mock API retry, collector failure/restart, duplicate suppression,
source bodies/IDs/times/status, and content-free diagnostics. Its internal SQL
is the first query above without the session filter. No paid run was performed.

Pending real access: organization ID, one authorized completed session ID, and
an authorized local credential. Read that session first. Before any paid live
run, recheck current pricing, account entitlements, repository permission and an
explicit spend ceiling. The bridge has no purchase or session-creation path.
Public pricing was checked on 2026-10-21; it lists Pro $20/month, Max $200/month
and Teams $80/month plus $40/full developer seat, with plan quotas and optional
extra usage. Those plan figures do not establish this account's API entitlement
or the cost of a particular session. No ACU-to-token conversion is made.

Official contracts revalidated 2026-10-21:

- [Session details](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session)
- [Chronological messages and pagination](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages)
- [Authentication](https://docs.devin.ai/api-reference/authentication)
- [Permissions and organization ID](https://docs.devin.ai/api-reference/v3/overview)
- [Incoming automation triggers](https://docs.devin.ai/product-guides/automations)
- [Current pricing](https://devin.ai/pricing)

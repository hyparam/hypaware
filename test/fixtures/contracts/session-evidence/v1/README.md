# hypaware.session-evidence/1 fixtures

These files are the contract for the `session_evidence` MCP verb, version
`hypaware.session-evidence/1`. The contract's prose lives in LLP 0553
(#contract, #continuation, #deadline, #limits). LLP 0557 sets the request
wire shape: each `sessions` entry travels as one JSON-encoded string.

**The fixtures win over prose.** When an LLP and a fixture disagree, the
fixture is the contract. Fix the prose, or bump the version for a breaking
change. Do not quietly edit a v1 fixture.

`test/session-evidence-contract-fixtures.js` checks every file here against
the shape checker in `test/lib/session-evidence-contract.js`. Editing a
fixture in a way that breaks a contract rule fails CI.

## Files

Each file is one case:

- `case`: the case name.
- `summary`: what the case shows.
- `request`: the `tools/call` arguments for `session_evidence`.
- Exactly one outcome:
  - `response`: the tool result's `structuredContent` on success. The same
    JSON also arrives as text in `content[0].text`.
  - `tool_error`: a whole-request failure the verb refuses. This is an MCP
    tool result with `isError: true` whose text starts with a stable code
    and `: ` (`invalid_request`, `org_read_capacity`,
    `query_deadline_exceeded`).
  - `jsonrpc_error`: a JSON-RPC `-32602` (invalid params) envelope. The MCP
    layer answers with it before the verb runs, when the arguments do not
    fit the advertised schema (an unknown argument, or a `contract` outside
    the advertised `enum`). A client whose contract is missing from the
    `tools/list` enum reads this as unsupported_contract. Otherwise it is a
    client defect. A missing verb is JSON-RPC `-32601`, which means an older
    server. Fall back to `query_sql`.
- `continues` (optional): the fixture whose `next_cursor` this request
  carries.

| File | Case |
| --- | --- |
| `01-ok-minimal.json` | `ok`. Only `session_id` given. Locator bounds and defaults apply. |
| `02-partial-page-1.json` | `partial`. The allowance is reached, and the response has a cursor. |
| `03-partial-continuation.json` | `continuation`. The next page, finishing `ok`. |
| `04-deadline.json` | `deadline`. Rows read so far, plus a cursor. |
| `05-not-found.json` | `not_found`. No bounds known. |
| `06-invalid-cursor.json` | `invalid_cursor` |
| `07-entry-error.json` | `error`. Entry-level `storage_unavailable`. |
| `08-text-truncated.json` | `text_truncated`. A part cut to `max_text_chars`. |
| `09-desc.json` | `desc`. Latest first, filtered to text parts. |
| `10-message-ids.json` | `message_ids`. Exact follow-up by message id. |
| `11-two-sessions.json` | `two_sessions`. Each entry has its own allowance. |
| `12-invalid-request.json` | `invalid_request`. An unparsable entry. |
| `13-unsupported-contract.json` | `unsupported_contract`. The `-32602` envelope. |

All ids and text are synthetic (`fx-` prefixed). The parts come from one
small synthetic corpus, so the same message has the same row in every file.

## Details the fixtures cannot show

These are settled, but the ASCII fixtures cannot demonstrate them (designer,
2026-10-09):

- `max_text_chars` counts UTF-16 code units (JavaScript string length). It
  never splits a surrogate pair: if the cut would land after a high
  surrogate, the text stops one unit earlier. `text_truncated` is true
  whenever anything was cut.
- A `deadline_ms` above the server's live read deadline is lowered to that
  deadline, not refused. `elapsed_ms` shows the real time.

## Fields that vary in a live response

A live server never returns these byte for byte, so a round-trip against a
seeded store compares everything except them:

- `server_version` and `elapsed_ms`
- `coverage.received_through`, which must still be at or after every part's
  `received_at`
- `coverage.read_path` and `fallback_reason`, which say how rows were read.
  Every read path returns the same rows.
- `next_cursor`, which is opaque. Only `null` versus a string is fixed.
  Never parse a cursor, and send one back only with the same entry
  parameters.

## Pinning (HYP-111 and other clients)

Copy this directory into the client's tests at a known server commit, and
record that commit next to the copy. Test the client's request encoder and
response reader against the copied files. To take a contract change, copy
again at the new commit and review the diff. These are a v1 freeze. Additive
response fields can appear without a version bump, so a client must ignore
fields it does not know. Anything that would break a v1 caller ships as
`v2/` under a new contract string.

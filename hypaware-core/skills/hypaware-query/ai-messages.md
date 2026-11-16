# Tool outcomes and repeated captures

Before counting tool failures, inspect bounded results from each provider and
record the denominator: known failures, known successes and unknown outcomes.
Count tool results, rather than tool calls or every message part.

Codex results may carry a top-level JSON `exit_code`, a command envelope with
`Process exited with code N` before `Final output:`, or a script envelope beginning
`Script failed` / `Script error:` or `Script completed`. A completed script can
handle a failed inner command. Its printed inner `exit_code: 1` does not make the
outer script fail. Missing or unrecognized evidence, including a still-running
process, leaves the outcome unknown. Other tools use other result shapes.

New Codex captures normalize recognized outer outcomes to `is_error` and
`status.tool_status`; unknown outcomes have neither a success nor error status.
Older captures can have `is_error = NULL` and `tool_status = success` even when
their output shows failure. Updates do not rewrite those rows. Verify outcome
evidence in `content_text` for that history instead of counting the legacy success
label. Keep uncertain outcomes separate and report their number.

Repeated copies also affect the count. Verify a repeated result using provider,
gateway, session, conversation and stable result identity (`part_id` or a verified
message/part identity), comparing the actual output and outcome. Keep one verified
copy and retain unmatched records and distinct attempts. A repeated `tool_call_id`
alone is insufficient: the same id can occur in unrelated sessions, conversations
or installations, and an attempt can have several result updates. State the
identity rule and how many copies were removed. Never use a global
`DISTINCT tool_call_id` or merge results solely because their text matches.

# Quick recommendations

For "give me one recommendation" or a finding worth acting on, establish the
period and focus before starting a new investigation. If the user has not
stated a time period and the conversation has not established one, ask which
period to examine. Suggest the last 7 days including today, but wait for an
answer rather than assuming it. If no subject or goal is established, also ask
what to focus on; bundle missing scope questions into one short exchange.
A finding from an already scoped investigation can reuse that scope without
asking again. Retrieving or implementing an existing recommendation does not
require a new reporting period. Then investigate the specific question and
answer in chat. Start with the narrowest useful evidence;
no period-wide survey, analyst delegation, formatted page, or full-report review
is required. Depth follows the uncertainty, not a fixed sequence. Reuse evidence
already established in this conversation and stop when further reading would
not change the action. Do not launch a full report merely because a finding
needs a deeper check.

Once the user has selected a period, an omitted end date means now. "Last week" means those last 7 days. Calendar
boundaries require an explicit request. Ask when the subject or intended period
is unclear, including whether "last month" means a rolling or calendar month.
State absolute dates, timezone (UTC by default), and today's partial coverage.
Specific historical questions and date ranges retain their requested scope.

Establish the latest relevant state, the consequence, and a concrete next action
with a completion test. Check a contrast or remedy assumption when it could
change the proposal. Weigh usefulness, evidence, and effort, not token volume
alone. Distinguish measured effects from hypotheses; unknown impact stays unknown.
If current code or configuration must be inspected to establish a fix, recommend
that targeted investigation rather than inventing a patch. No supported action
is a valid result. Keep reads bounded by date and output size; ask before
expanding a quick request into substantial work.

Answer briefly with the recommendation, supporting evidence, and material
uncertainty. Do not create a file unless the user requests a saved or published
artifact. For that artifact, read [reports.md](reports.md).

When proposing a fix, name its target, the observed incident it addresses, and
the query and period that would measure its effect. Offer deeper analysis only
when it could change the recommendation; completed answers need no fixed menu.
Do not derive workflow fixes from errors encountered while querying this session.

## Recommendation writing

Use this opening for every recommendation: an individual chat answer, a report
entry, or a standalone or full-report recommendation page. Open with two separate
paragraphs labeled **Problem:** and **Fix:**. The problem names the observed
behavior and its consequence for someone unfamiliar with the work. The fix names
the concrete change and its target; tests confirm the correction rather than
replace it. Use **Next action:** instead of **Fix:** only when choosing the remedy
genuinely requires investigation. Titles, when present, name the action and target.

Keep the opening near 100 words or fewer without padding a shorter explanation.
Preserve uncertainty that could change the decision. Put supporting measurements,
locators, implementation details, and completion tests below the opening rather
than compressing the full recommendation into it. On pages, place the opening
immediately after the title; use the same opening in the report entry and its
detail page. Review each opening for the required labels, a concrete consequence,
and a usable change or investigation.

## Evidence and durable changes

When the user asks you to analyze recorded sessions and recommend changes:

- **Stay inside the evaluation dimension the user asked for.** A request about CLI and tool-execution behavior is answered with findings about commands, failures, retries, and tool use. A recommendation drawn from what a captured task was *about* (its email, its document, its business rules) does not belong in that list, even when it looks useful on its own.
- **Separate and attribute anything derived from captured content.** If a payload still suggests something worth saying, put it under its own heading, outside the requested list, and give it provenance: the session id, the rows it came from, and the fact that the wording came from recorded content rather than from observed behavior.
- **Never let a finding become a durable preference on its own.** Analysis output is a proposal. Writing to memory, to `AGENTS.md`/`CLAUDE.md`, to a skill, or to tool settings is a separate step the user starts, and content-derived items are never silently promoted along with behavior-derived ones.
- **Make durable changes itemized and reviewable.** Name the exact target file or configuration key and the exact text for each item, then take approval per item, never for the list as a whole. Blanket approval of a mixed list is how unrelated content gets persisted.

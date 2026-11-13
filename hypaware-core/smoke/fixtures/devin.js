// @ts-check

// Synthetic documented v3 shapes. These are not evidence of live Devin access.
export const devinDetail = {
  session_id: 'abc123', org_id: 'org-fixture', status: 'running', status_detail: 'finished',
  created_at: 1792530000, updated_at: 1792530010, acus_consumed: 1.25,
  url: 'https://app.devin.ai/sessions/abc123',
  pull_requests: [{ pr_url: 'https://github.com/example/fixture/pull/1', pr_state: 'open' }],
  tags: [], structured_output: { result: null },
}

export const devinMessages = [
  { event_id: 'event-user', source: 'user', message: 'Inspect the synthetic fixture test.', created_at: 1792530001, username: 'fixture' },
  { event_id: 'event-devin', source: 'devin', message: 'The synthetic fixture test passed.', created_at: 1792530002 },
]

/** @param {string | null} after */
export function devinPage(after) {
  if (!after) return { items: [devinMessages[0]], end_cursor: 'page-two', has_next_page: true, total: 2 }
  // Repeat a boundary event to prove page-overlap deduplication.
  return { items: devinMessages, end_cursor: null, has_next_page: false, total: 2 }
}

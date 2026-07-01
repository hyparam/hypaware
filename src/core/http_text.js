// @ts-check

/**
 * Read a fetch `Response` body as text, returning `''` instead of throwing when
 * the body is absent or unreadable. Both the MCP client and the identity client
 * decode an error body defensively (the response may be empty or already
 * consumed), so the helper has one home rather than a copy in each.
 *
 * @param {{ text(): Promise<string> }} res
 * @returns {Promise<string>}
 */
export async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

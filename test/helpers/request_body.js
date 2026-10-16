/**
 * Read the body a fetch mock received. The central sink streams each chunk
 * (a `ReadableStream`, see `postNdjson` in the central plugin), so a mock
 * that wants the NDJSON text has to drain it; a plain string passes through.
 *
 * @param {unknown} body
 * @returns {Promise<string>}
 */
export async function readRequestBody(body) {
  if (body === undefined || body === null) return ''
  if (typeof body === 'string') return body
  return new Response(/** @type {ReadableStream} */ (body)).text()
}

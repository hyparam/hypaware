// A native Cursor hook process. Standard library only; never boots HypAware.
import { randomUUID } from 'node:crypto'
import http from 'node:http'

const MAX_BYTES = 1024 * 1024
const deadline = setTimeout(() => process.exit(0), 2500)
try {
  const address = process.argv[2]
  const endpoint = new URL(/^127\.0\.0\.1:\d+$/.test(address) ? `http://${address}` : address)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('endpoint')
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_BYTES) throw new Error('payload_limit')
    chunks.push(chunk)
  }
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  // @ref LLP 0399#identity: allocate once before retry; repeated identical
  // file callbacks remain distinct observations.
  const body = JSON.stringify({ delivery_id: randomUUID(), observed_at: new Date().toISOString(), event })
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('payload_limit')
  let ok = false
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    ok = await new Promise((resolve) => {
      const req = http.request(new URL('/hook', endpoint), {
        method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume()
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300)
      })
      req.setTimeout(800, () => req.destroy())
      req.on('error', () => resolve(false))
      req.end(body)
    })
  }
  if (!ok) process.stderr.write('HypAware Cursor capture unavailable; this callback was not confirmed.\n')
} catch {
  process.stderr.write('HypAware Cursor capture skipped an invalid or oversized callback.\n')
} finally {
  clearTimeout(deadline)
}
// No hook response, context injection, permission decision, or raw disk spool.
process.exit(0)

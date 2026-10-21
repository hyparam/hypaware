// Native Factory hook: standard library only, no permissions or context output.
import http from 'node:http'

const deadline = setTimeout(() => process.exit(0), 2500)
try {
  const address = process.argv[2]
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('endpoint')
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 1024 * 1024) throw new Error('payload_limit')
    chunks.push(chunk)
  }
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof event.session_id !== 'string' || typeof event.transcript_path !== 'string') throw new Error('identity')
  // @ref LLP 0551#capture: transmit only a change notification, never tool inputs or outputs
  const body = JSON.stringify({ session_id: event.session_id, transcript_path: event.transcript_path })
  if (Buffer.byteLength(body) > 16 * 1024) throw new Error('payload_limit')
  const ok = await new Promise(resolve => {
    const req = http.request(`http://${address}/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      res.resume()
      resolve(res.statusCode === 200 || res.statusCode === 202)
    })
    req.setTimeout(1800, () => req.destroy())
    req.on('error', () => resolve(false))
    req.end(body)
  })
  if (!ok) process.stderr.write('HypAware Droid capture unavailable; native recovery will retry.\n')
} catch {
  process.stderr.write('HypAware Droid capture skipped an invalid or oversized callback.\n')
} finally { clearTimeout(deadline) }
process.exit(0)

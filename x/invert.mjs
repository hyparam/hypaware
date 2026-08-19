import { Readable, PassThrough } from 'node:stream'
import { askYesNo } from '../src/core/cli/confirm.js'

const mk = (chunks) => {
  const s = Readable.from(chunks)
  Object.defineProperty(s, 'isTTY', { value: true })
  return s
}
const buf = () => { let v=''; return { write(c){ v+=String(c); return true }, text(){return v} } }

for (const [name, chunks] of [
  ['typed n then y', ['n\ny\n']],
  ['typed n then y, 2 chunks', ['n\n','y\n']],
  ['typed y then n', ['y\nn\n']],
  ['typed n, junk no newline', ['n\ny']],
]) {
  const stderr = buf()
  const res = await askYesNo({ stdin: mk(chunks), stderr }, 'Delete everything? [y/N] ')
  console.log(`${name.padEnd(28)} -> askYesNo=${res}`)
}

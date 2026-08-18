import readline from 'node:readline/promises'
import { Readable } from 'node:stream'

const input = Readable.from(['y\n', '3\n'])
const out = { write: () => true }
const rl = readline.createInterface({ input, output: out })
rl.on('line', (l) => console.log('EVENT line:', JSON.stringify(l)))
rl.once('close', () => console.log('EVENT close'))
rl.question('Q? ').then((a) => console.log('EVENT question resolved:', JSON.stringify(a)))
setTimeout(() => { rl.close(); }, 200)

// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import {
  multiselect,
  select,
  text,
} from '../../../../src/core/cli/tui/index.js'

const ERROR_RE = /TUI prompt requires a TTY; got non-TTY stdin\/stdout/

function makeNonTty() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  // isTTY is undefined; runtime should reject before touching the stream.
  return { stdin, stdout }
}

function makeFakeTty() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.defineProperty(stdin, 'isTTY', { value: true })
  Object.defineProperty(stdout, 'isTTY', { value: true })
  // @ts-expect-error: PassThrough does not declare setRawMode.
  stdin.setRawMode = () => {}
  return { stdin, stdout }
}

test('non-TTY stdin rejects multiselect with the documented error', async () => {
  const io = makeNonTty()
  await assert.rejects(
    multiselect({
      title: 'pick',
      options: [{ value: 'a', label: 'A' }],
      stdin: io.stdin,
      stdout: io.stdout,
    }),
    (err) => err instanceof Error && ERROR_RE.test(err.message),
  )
})

test('non-TTY stdin rejects select with the documented error', async () => {
  const io = makeNonTty()
  await assert.rejects(
    select({
      title: 'choose',
      options: [{ value: 'a', label: 'A' }],
      stdin: io.stdin,
      stdout: io.stdout,
    }),
    (err) => err instanceof Error && ERROR_RE.test(err.message),
  )
})

test('non-TTY stdin rejects text with the documented error', async () => {
  const io = makeNonTty()
  await assert.rejects(
    text({
      title: 'name',
      stdin: io.stdin,
      stdout: io.stdout,
    }),
    (err) => err instanceof Error && ERROR_RE.test(err.message),
  )
})


test('HYP_NO_TUI=1 forces the same TTY error even for fake-TTY streams', async () => {
  const io = makeFakeTty()
  const prevFlag = process.env.HYP_NO_TUI
  process.env.HYP_NO_TUI = '1'
  try {
    await assert.rejects(
      multiselect({
        title: 'pick',
        options: [{ value: 'a', label: 'A' }],
        stdin: io.stdin,
        stdout: io.stdout,
      }),
      (err) => err instanceof Error && ERROR_RE.test(err.message),
    )
  } finally {
    if (prevFlag === undefined) delete process.env.HYP_NO_TUI
    else process.env.HYP_NO_TUI = prevFlag
  }
})

test('injected env.HYP_NO_TUI=1 forces the TTY error even when process.env is clean', async () => {
  const io = makeFakeTty()
  const prevFlag = process.env.HYP_NO_TUI
  delete process.env.HYP_NO_TUI
  try {
    await assert.rejects(
      multiselect({
        title: 'pick',
        options: [{ value: 'a', label: 'A' }],
        stdin: io.stdin,
        stdout: io.stdout,
        env: { HYP_NO_TUI: '1' },
      }),
      (err) => err instanceof Error && ERROR_RE.test(err.message),
    )
  } finally {
    if (prevFlag === undefined) delete process.env.HYP_NO_TUI
    else process.env.HYP_NO_TUI = prevFlag
  }
})

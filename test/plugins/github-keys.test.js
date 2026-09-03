// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actorKey,
  commitKey,
  fileKey,
  issueKey,
  normalizeLogin,
  normalizeRelpath,
  pullRequestKey,
  repoKey,
  repoKeyFromRemote,
  reviewKey,
} from '../../hypaware-core/plugins-workspace/github/src/keys.js'

// Key normalization is the contract (LLP 0003 §key-normalization-rules): two
// sources converge only if they normalize identically, so these rules are
// asserted, not left to each toRow.

test('owner / repo / login are lowercased', () => {
  assert.equal(repoKey('Octocat', 'Hello-World'), 'octocat/hello-world')
  assert.equal(repoKey('Octocat/Hello-World'), 'octocat/hello-world')
  assert.equal(actorKey('Octocat'), 'octocat')
  assert.equal(normalizeLogin('MiXeD'), 'mixed')
})

test('GitHub remotes normalize to repo keys without retaining credentials', () => {
  assert.equal(repoKeyFromRemote('git@github.com:Acme/Widgets.git'), 'acme/widgets')
  assert.equal(repoKeyFromRemote('https://github.com/Acme/Widgets.git'), 'acme/widgets')
  assert.equal(repoKeyFromRemote('ssh://git@www.github.com/Acme/Widgets/'), 'acme/widgets')
  assert.equal(repoKeyFromRemote('https://user:secret@github.com/Acme/Widgets.git'), 'acme/widgets')
  assert.equal(repoKeyFromRemote('https://gitlab.com/Acme/Widgets.git'), null)
  assert.equal(repoKeyFromRemote('not-a-remote'), null)
})

test('repoKey rejects malformed owner/repo strings', () => {
  assert.equal(repoKey('no-slash'), null)
  assert.equal(repoKey('/leading'), null)
  assert.equal(repoKey('trailing/'), null)
  assert.equal(repoKey(''), null)
  assert.equal(repoKey(null), null)
})

test('relpath is POSIX: forward slashes, no leading slash or ./', () => {
  assert.equal(normalizeRelpath('src/app.js'), 'src/app.js')
  assert.equal(normalizeRelpath('./src/app.js'), 'src/app.js')
  assert.equal(normalizeRelpath('/src/app.js'), 'src/app.js')
  assert.equal(normalizeRelpath('src\\win\\path.js'), 'src/win/path.js')
  assert.equal(normalizeRelpath('././a'), 'a')
  assert.equal(normalizeRelpath(''), null)
})

test('fileKey is owner/repo:relpath; only the repo half is lowercased', () => {
  // Path case is preserved (a rename/case-change is a new File); repo lowercased.
  assert.equal(fileKey('Octocat/Hello-World', './src/App.js'), 'octocat/hello-world:src/App.js')
  assert.equal(fileKey('o/r', 'a/b/c.txt'), 'o/r:a/b/c.txt')
  assert.equal(fileKey('bad', 'a.txt'), null, 'malformed repo → null')
  assert.equal(fileKey('o/r', ''), null, 'empty path → null')
})

test('commitKey is full 40-hex lowercased', () => {
  assert.equal(
    commitKey('6DCB09B5B57875F334F61AEBED695E2E4193DB5E'),
    '6dcb09b5b57875f334f61aebed695e2e4193db5e',
  )
  assert.equal(commitKey(''), null)
})

test('issue / PR keys are owner/repo#number; review key is review/<id>', () => {
  assert.equal(issueKey('Octocat/Hello-World', 42), 'octocat/hello-world#42')
  assert.equal(pullRequestKey('Octocat/Hello-World', 1347), 'octocat/hello-world#1347')
  // number may arrive as a numeric string.
  assert.equal(issueKey('o/r', '7'), 'o/r#7')
  assert.equal(issueKey('o/r', 1.5), null, 'non-integer number rejected')
  assert.equal(reviewKey(80), 'review/80')
  assert.equal(reviewKey('80'), 'review/80')
  assert.equal(reviewKey('abc'), null)
})


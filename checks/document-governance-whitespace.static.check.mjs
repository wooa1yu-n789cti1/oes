import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkGitDiff } from './document-governance.static.check.mjs'

/** Executes one Git fixture command without shell-dependent quoting. */
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

/** Creates an isolated repository with deterministic author identity. */
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'oes-doc-governance-'))
  git(root, 'init', '--quiet')
  git(root, 'config', 'user.name', 'OES Docs Check')
  git(root, 'config', 'user.email', 'docs-check@example.invalid')
  return root
}

/** Writes, stages, and commits one fixture file. */
function commit(root, path, content, message) {
  writeFileSync(join(root, path), content)
  git(root, 'add', path)
  git(root, 'commit', '--quiet', '-m', message)
}

test('detects whitespace errors committed after a parent commit', () => {
  const root = repository()
  try {
    commit(root, 'fixture.md', 'clean\n', 'baseline')
    commit(root, 'fixture.md', 'committed trailing spaces  \n', 'candidate')
    assert.match(checkGitDiff(root).join('\n'), /GIT_COMMITTED_DIFF_CHECK/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detects whitespace errors in the staged index', () => {
  const root = repository()
  try {
    commit(root, 'fixture.md', 'clean\n', 'baseline')
    writeFileSync(join(root, 'fixture.md'), 'staged trailing spaces  \n')
    git(root, 'add', 'fixture.md')
    assert.match(checkGitDiff(root).join('\n'), /GIT_CACHED_DIFF_CHECK/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checks whitespace in an initial commit without a parent', () => {
  const root = repository()
  try {
    commit(root, 'fixture.md', 'initial trailing spaces  \n', 'initial candidate')
    assert.match(checkGitDiff(root).join('\n'), /GIT_COMMITTED_DIFF_CHECK/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checks a merge candidate against its first parent', () => {
  const root = repository()
  try {
    commit(root, 'base.md', 'base\n', 'baseline')
    git(root, 'checkout', '--quiet', '-b', 'topic')
    commit(root, 'topic.md', 'topic\n', 'topic')
    git(root, 'checkout', '--quiet', '-')
    commit(root, 'main.md', 'main\n', 'main')
    git(root, 'merge', '--quiet', '--no-ff', 'topic', '-m', 'merge candidate')
    writeFileSync(join(root, 'merge.md'), 'merge trailing spaces  \n')
    git(root, 'add', 'merge.md')
    git(root, 'commit', '--quiet', '--amend', '--no-edit')
    assert.match(checkGitDiff(root).join('\n'), /GIT_COMMITTED_DIFF_CHECK/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

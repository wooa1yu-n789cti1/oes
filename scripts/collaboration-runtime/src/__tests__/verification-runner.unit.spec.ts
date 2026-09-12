import assert from 'node:assert/strict'
import test from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runThinVerification } from '../verification-runner.ts'
import { validateJsonSchema } from '../schema-validation.ts'

function command(cwd: string, executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function repositoryFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'oes-thin-verify-test-'))
  const repositoryRoot = join(parent, 'repository')
  command(parent, 'git', ['init', '-q', repositoryRoot])
  command(repositoryRoot, 'git', ['config', 'user.email', 'test@example.com'])
  command(repositoryRoot, 'git', ['config', 'user.name', 'Test'])
  writeFileSync(join(repositoryRoot, 'behavior.txt'), 'baseline\n')
  writeFileSync(join(repositoryRoot, 'removed.txt'), 'restored by rollback\n')
  command(repositoryRoot, 'git', ['add', 'behavior.txt', 'removed.txt'])
  command(repositoryRoot, 'git', ['commit', '-qm', 'baseline'])
  const baselineSha = command(repositoryRoot, 'git', ['rev-parse', 'HEAD'])
  writeFileSync(join(repositoryRoot, 'behavior.txt'), 'modified\n')
  writeFileSync(join(repositoryRoot, 'added.txt'), 'removed by rollback\n')
  command(repositoryRoot, 'git', ['rm', '-q', 'removed.txt'])
  command(repositoryRoot, 'git', ['add', 'behavior.txt', 'added.txt'])
  command(repositoryRoot, 'git', ['commit', '-qm', 'modified'])
  const candidateSha = command(repositoryRoot, 'git', ['rev-parse', 'HEAD'])
  return { parent, repositoryRoot, baselineSha, candidateSha }
}

test('thin verification writes modified artifact, patch, literal record and runnable rollback', () => {
  const fixture = repositoryFixture()
  const result = runThinVerification({
    repositoryRoot: fixture.repositoryRoot,
    baselineSha: fixture.baselineSha,
    candidateSha: fixture.candidateSha,
    formalCandidate: true,
    declaredInputPaths: [],
    commands: [
      {
        id: 'behavior',
        executable: process.execPath,
        args: ['-e', "process.stdout.write('MODIFIED\\n')"],
        coverageIds: ['behavior']
      }
    ],
    packageReference: '/stable/delivery-package.json',
    outputRoot: join(fixture.parent, 'artifacts')
  })
  const schema = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '..', '..', 'schemas', 'thin-verification-result.schema.json'),
      'utf8'
    )
  ) as Record<string, unknown>
  validateJsonSchema(schema, result)
  assert.equal(result.status, 'PASSED')
  for (const path of Object.values(result.artifacts)) assert.equal(existsSync(path), true)
  assert.match(readFileSync(result.artifacts.patch, 'utf8'), /modified/)
  assert.match(readFileSync(result.commands[0].logPath, 'utf8'), /EXIT_STATUS=0/)
  command(fixture.repositoryRoot, process.execPath, [result.artifacts.rollback])
  assert.equal(readFileSync(join(fixture.repositoryRoot, 'behavior.txt'), 'utf8'), 'baseline\n')
  assert.equal(
    readFileSync(join(fixture.repositoryRoot, 'removed.txt'), 'utf8'),
    'restored by rollback\n'
  )
  assert.equal(existsSync(join(fixture.repositoryRoot, 'added.txt')), false)
  command(fixture.repositoryRoot, 'git', ['diff', '--quiet', fixture.baselineSha, '--', '.'])
})

test('temporary verification accepts a dirty declared symlink without weakening formal candidates', () => {
  const fixture = repositoryFixture()
  symlinkSync('behavior.txt', join(fixture.repositoryRoot, 'dependency-link'))
  const result = runThinVerification({
    repositoryRoot: fixture.repositoryRoot,
    baselineSha: fixture.baselineSha,
    candidateSha: fixture.candidateSha,
    formalCandidate: false,
    declaredInputPaths: ['dependency-link'],
    commands: [
      {
        id: 'temporary',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        coverageIds: ['temporary-assembly']
      }
    ],
    packageReference: null,
    outputRoot: join(fixture.parent, 'temporary-artifacts')
  })
  assert.equal(result.declaredInputs[0].kind, 'SYMLINK')
  assert.equal(result.status, 'PASSED')
})

test('temporary verification rejects every undeclared dirty path with one recovery action', () => {
  const fixture = repositoryFixture()
  symlinkSync('behavior.txt', join(fixture.repositoryRoot, 'declared-link'))
  writeFileSync(join(fixture.repositoryRoot, 'UNDECLARED'), 'not part of verification assembly\n')
  assert.throws(
    () =>
      runThinVerification({
        repositoryRoot: fixture.repositoryRoot,
        baselineSha: fixture.baselineSha,
        candidateSha: fixture.candidateSha,
        formalCandidate: false,
        declaredInputPaths: ['declared-link'],
        commands: [
          {
            id: 'temporary',
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            coverageIds: ['temporary-assembly']
          }
        ],
        packageReference: null,
        outputRoot: join(fixture.parent, 'rejected-artifacts')
      }),
    (error: unknown) =>
      error instanceof Error &&
      /THIN_VERIFY_UNDECLARED_DIRTY_PATH/.test(error.message) &&
      (error as { nextAction?: string }).nextAction === 'DECLARE_INPUT_OR_CLEAN_WORKTREE'
  )
})

test('declared directory fingerprint changes when nested content changes', () => {
  const fixture = repositoryFixture()
  const declared = join(fixture.repositoryRoot, 'fixture-input')
  mkdirSync(declared)
  writeFileSync(join(declared, 'value.txt'), 'one\n')
  const input = {
    repositoryRoot: fixture.repositoryRoot,
    baselineSha: fixture.baselineSha,
    candidateSha: fixture.candidateSha,
    formalCandidate: false,
    declaredInputPaths: ['fixture-input'],
    commands: [
      {
        id: 'temporary',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        coverageIds: ['temporary-assembly']
      }
    ],
    packageReference: null
  }
  const first = runThinVerification({ ...input, outputRoot: join(fixture.parent, 'directory-one') })
  writeFileSync(join(declared, 'value.txt'), 'two\n')
  const second = runThinVerification({
    ...input,
    outputRoot: join(fixture.parent, 'directory-two')
  })
  assert.notEqual(first.declaredInputs[0].fingerprint, second.declaredInputs[0].fingerprint)
})

test('formal verification rejects a command that mutates the exact candidate', () => {
  const fixture = repositoryFixture()
  assert.throws(
    () =>
      runThinVerification({
        repositoryRoot: fixture.repositoryRoot,
        baselineSha: fixture.baselineSha,
        candidateSha: fixture.candidateSha,
        formalCandidate: true,
        declaredInputPaths: [],
        commands: [
          {
            id: 'mutator',
            executable: process.execPath,
            args: ['-e', "require('fs').appendFileSync('behavior.txt','forbidden\\n')"],
            coverageIds: ['mutation-guard']
          }
        ],
        packageReference: null,
        outputRoot: join(fixture.parent, 'mutating-artifacts')
      }),
    /THIN_VERIFY_COMMAND_MUTATED_FORMAL_CANDIDATE/
  )
})

test('verification resolves an output symlink physically and rejects repository re-entry', () => {
  const fixture = repositoryFixture()
  const alias = join(fixture.parent, 'repository-alias')
  symlinkSync(fixture.repositoryRoot, alias)
  assert.throws(
    () =>
      runThinVerification({
        repositoryRoot: fixture.repositoryRoot,
        baselineSha: fixture.baselineSha,
        candidateSha: fixture.candidateSha,
        formalCandidate: true,
        declaredInputPaths: [],
        commands: [
          {
            id: 'safe',
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            coverageIds: ['physical-output']
          }
        ],
        packageReference: null,
        outputRoot: join(alias, 'artifacts')
      }),
    /THIN_VERIFY_OUTPUT_INSIDE_REPOSITORY/
  )
})

test('verification command ids cannot escape the output root', () => {
  const fixture = repositoryFixture()
  assert.throws(
    () =>
      runThinVerification({
        repositoryRoot: fixture.repositoryRoot,
        baselineSha: fixture.baselineSha,
        candidateSha: fixture.candidateSha,
        formalCandidate: true,
        declaredInputPaths: [],
        commands: [
          {
            id: '../outside',
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            coverageIds: ['log-containment']
          }
        ],
        packageReference: null,
        outputRoot: join(fixture.parent, 'invalid-id-artifacts')
      }),
    /THIN_VERIFY_COMMAND_ID_INVALID/
  )
})

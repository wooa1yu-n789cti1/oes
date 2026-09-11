import { spawnSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalJson, objectFingerprint, sha256 } from './canonical.ts'
import { fail } from './errors.ts'

export interface VerificationRunCommand {
  id: string
  executable: string
  args: string[]
  coverageIds: string[]
}

export interface VerificationRunInput {
  repositoryRoot: string
  baselineSha: string
  candidateSha: string
  formalCandidate: boolean
  declaredInputPaths: string[]
  commands: VerificationRunCommand[]
  packageReference: string | null
  outputRoot: string
}

export interface VerificationCommandResult {
  id: string
  executable: string
  args: string[]
  coverageIds: string[]
  stdout: string
  stderr: string
  exitCode: number
  logPath: string
}

export interface VerificationRunResult {
  schemaVersion: 1
  kind: 'OES_THIN_VERIFICATION_RESULT'
  status: 'PASSED' | 'FAILED'
  baselineSha: string
  candidateSha: string
  candidateTreeSha: string
  formalCandidate: boolean
  packageReference: string | null
  declaredInputs: Array<{ path: string; kind: string; fingerprint: string }>
  commands: VerificationCommandResult[]
  artifacts: {
    modifiedArtifact: string
    patch: string
    verification: string
    rollback: string
  }
  resultFingerprint: string
}

const SHA = /^[0-9a-f]{40}$/
const COMMAND_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

/** Runs one command without a shell and preserves its literal result. */
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return {
    stdout: result.stdout ?? '',
    stderr: [result.stderr ?? '', result.error?.message ?? ''].filter(Boolean).join('\n'),
    exitCode: result.status ?? 1
  }
}

/** Requires one Git command to succeed and returns its exact stdout. */
function git(cwd: string, args: string[]): string {
  const result = run('git', args, cwd)
  if (result.exitCode !== 0)
    fail('THIN_VERIFY_GIT_FAILED', `${args.join(' ')}:${result.stderr.trim()}`)
  return result.stdout
}

/** Records a declared temporary verification input without treating it as candidate dirtiness. */
function inspectDeclaredInput(repositoryRoot: string, path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail('THIN_VERIFY_DECLARED_INPUT_INVALID', path)
  const absolute = resolve(repositoryRoot, path)
  const stats = lstatSync(absolute)
  const kind = stats.isSymbolicLink()
    ? 'SYMLINK'
    : stats.isFile()
      ? 'FILE'
      : stats.isDirectory()
        ? 'DIRECTORY'
        : 'OTHER'
  const content = stats.isSymbolicLink()
    ? readlinkSync(absolute)
    : stats.isFile()
      ? readFileSync(absolute)
      : stats.isDirectory()
        ? directoryFingerprint(absolute)
        : `${stats.mode}:${stats.size}`
  return { path, kind, fingerprint: sha256(content) }
}

/** Hashes a declared directory by names, entry kinds, link targets, and file bytes. */
function directoryFingerprint(root: string): string {
  const entries: Array<{ path: string; kind: string; fingerprint: string }> = []
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = resolve(directory, name)
      const path = relative(root, absolute)
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink())
        entries.push({ path, kind: 'SYMLINK', fingerprint: sha256(readlinkSync(absolute)) })
      else if (stats.isFile())
        entries.push({ path, kind: 'FILE', fingerprint: sha256(readFileSync(absolute)) })
      else if (stats.isDirectory()) {
        entries.push({ path, kind: 'DIRECTORY', fingerprint: sha256('DIRECTORY') })
        visit(absolute)
      } else
        entries.push({ path, kind: 'OTHER', fingerprint: sha256(`${stats.mode}:${stats.size}`) })
    }
  }
  visit(root)
  return canonicalJson(entries)
}

/** Parses NUL-delimited porcelain v1 output, including both sides of rename/copy records. */
function dirtyPaths(repositoryRoot: string): string[] {
  const records = git(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all'
  ]).split('\0')
  const paths: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.length < 4 || record[2] !== ' ') fail('THIN_VERIFY_STATUS_RECORD_INVALID', record)
    paths.push(record.slice(3))
    if (record[0] === 'R' || record[1] === 'R' || record[0] === 'C' || record[1] === 'C') {
      const original = records[index + 1]
      if (!original) fail('THIN_VERIFY_STATUS_RECORD_INVALID', record)
      paths.push(original)
      index += 1
    }
  }
  return [...new Set(paths)].sort()
}

/** Requires every observed dirty path to equal or be nested beneath one declared input. */
function requireOnlyDeclaredDirtyPaths(repositoryRoot: string, declared: string[]): void {
  const undeclared = dirtyPaths(repositoryRoot).filter(
    (path) => !declared.some((root) => path === root || path.startsWith(`${root}/`))
  )
  if (undeclared.length) fail('THIN_VERIFY_UNDECLARED_DIRTY_PATH', undeclared.join(','))
}

/** Resolves a not-yet-created output directory through its physical parent. */
function physicalOutputRoot(requested: string): string {
  const leaf = basename(requested)
  if (!COMMAND_ID.test(leaf)) fail('THIN_VERIFY_OUTPUT_LEAF_INVALID', requested)
  const parent = realpathSync(dirname(requested))
  const output = resolve(parent, leaf)
  try {
    statSync(output)
    fail('THIN_VERIFY_OUTPUT_ALREADY_EXISTS', output)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return output
}

/** Rechecks that commands did not change the exact candidate or temporary assembly. */
function verifyPostCommandState(
  input: VerificationRunInput,
  repositoryRoot: string,
  candidateSha: string,
  candidateTreeSha: string,
  declaredPaths: string[],
  declaredInputs: VerificationRunResult['declaredInputs']
): void {
  if (
    git(repositoryRoot, ['rev-parse', `${candidateSha}^{tree}`]).trim() !== candidateTreeSha ||
    git(repositoryRoot, ['rev-parse', 'HEAD']).trim() !== candidateSha
  )
    fail('THIN_VERIFY_CANDIDATE_CHANGED_DURING_RUN', candidateSha)
  if (input.formalCandidate) {
    const status = git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all']).trim()
    if (status) fail('THIN_VERIFY_COMMAND_MUTATED_FORMAL_CANDIDATE', status)
    return
  }
  requireOnlyDeclaredDirtyPaths(repositoryRoot, declaredPaths)
  const after = declaredPaths.map((path) => inspectDeclaredInput(repositoryRoot, path))
  if (canonicalJson(after) !== canonicalJson(declaredInputs))
    fail('THIN_VERIFY_DECLARED_INPUT_CHANGED_DURING_RUN', candidateSha)
}

/** Creates a cross-platform Node rollback program for the exact emitted binary patch. */
function rollbackSource(repositoryRoot: string, patchPath: string): string {
  return `import { spawnSync } from 'node:child_process'\nconst result = spawnSync('git', ['apply', '--reverse', '--binary', '--index', ${JSON.stringify(patchPath)}], { cwd: ${JSON.stringify(repositoryRoot)}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })\nprocess.stdout.write(result.stdout ?? '')\nprocess.stderr.write(result.stderr ?? '')\nprocess.exitCode = result.status ?? 1\n`
}

/** Executes the one agent-facing verification path and writes all four delivery artifact roles. */
export function runThinVerification(input: VerificationRunInput): VerificationRunResult {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.repositoryRoot !== 'string' ||
    typeof input.outputRoot !== 'string' ||
    typeof input.baselineSha !== 'string' ||
    typeof input.candidateSha !== 'string' ||
    typeof input.formalCandidate !== 'boolean' ||
    !Array.isArray(input.declaredInputPaths) ||
    input.declaredInputPaths.some((value) => typeof value !== 'string') ||
    !Array.isArray(input.commands) ||
    !input.commands.every(
      (command) =>
        command &&
        typeof command.id === 'string' &&
        typeof command.executable === 'string' &&
        Array.isArray(command.args) &&
        command.args.every((value) => typeof value === 'string') &&
        Array.isArray(command.coverageIds) &&
        command.coverageIds.every((value) => typeof value === 'string')
    ) ||
    (input.packageReference !== null && typeof input.packageReference !== 'string')
  )
    fail('THIN_VERIFY_INPUT_INVALID', 'verification input')
  if (!isAbsolute(input.repositoryRoot) || !isAbsolute(input.outputRoot))
    fail('THIN_VERIFY_ABSOLUTE_PATH_REQUIRED', input.outputRoot)
  const repositoryRoot = realpathSync(input.repositoryRoot)
  const outputRoot = physicalOutputRoot(input.outputRoot)
  const outputRelative = relative(repositoryRoot, outputRoot)
  if (!outputRelative.startsWith(`..${sep}`) && outputRelative !== '..')
    fail('THIN_VERIFY_OUTPUT_INSIDE_REPOSITORY', outputRoot)
  if (!SHA.test(input.baselineSha) || !SHA.test(input.candidateSha))
    fail('THIN_VERIFY_SHA_INVALID', `${input.baselineSha}:${input.candidateSha}`)
  if (!input.commands.length) fail('THIN_VERIFY_COMMANDS_REQUIRED', input.candidateSha)
  const ids = input.commands.map((command) => command.id)
  if (new Set(ids).size !== ids.length) fail('THIN_VERIFY_COMMAND_DUPLICATE', ids.join(','))
  if (ids.some((id) => !COMMAND_ID.test(id))) fail('THIN_VERIFY_COMMAND_ID_INVALID', ids.join(','))
  const baselineSha = git(repositoryRoot, ['rev-parse', `${input.baselineSha}^{commit}`]).trim()
  const candidateSha = git(repositoryRoot, ['rev-parse', `${input.candidateSha}^{commit}`]).trim()
  const candidateTreeSha = git(repositoryRoot, ['rev-parse', `${candidateSha}^{tree}`]).trim()
  if (input.formalCandidate) {
    const head = git(repositoryRoot, ['rev-parse', 'HEAD']).trim()
    if (head !== candidateSha) fail('THIN_VERIFY_FORMAL_HEAD_MISMATCH', `${head}:${candidateSha}`)
    const status = git(repositoryRoot, ['status', '--porcelain']).trim()
    if (status) fail('OWNER_WORKTREE_DIRTY', status)
  } else if (!input.declaredInputPaths.length) {
    fail('THIN_VERIFY_DECLARED_INPUTS_REQUIRED', candidateSha)
  }
  const declaredPaths = [...new Set(input.declaredInputPaths)].sort()
  if (!input.formalCandidate) requireOnlyDeclaredDirtyPaths(repositoryRoot, declaredPaths)
  const declaredInputs = declaredPaths
    .sort()
    .map((path) => inspectDeclaredInput(repositoryRoot, path))
  mkdirSync(outputRoot, { recursive: false })
  const patchPath = resolve(outputRoot, 'change.patch')
  const candidatePath = resolve(outputRoot, 'modified-artifact.json')
  const verificationPath = resolve(outputRoot, 'verification.json')
  const rollbackPath = resolve(outputRoot, 'rollback.mjs')
  writeFileSync(patchPath, git(repositoryRoot, ['diff', '--binary', baselineSha, candidateSha]), {
    flag: 'wx'
  })
  writeFileSync(
    candidatePath,
    `${canonicalJson({ baselineSha, candidateSha, candidateTreeSha, packageReference: input.packageReference })}\n`,
    { flag: 'wx' }
  )
  writeFileSync(rollbackPath, rollbackSource(repositoryRoot, patchPath), { flag: 'wx' })
  const commands: VerificationCommandResult[] = input.commands.map((command) => {
    if (!command.id.trim() || !command.executable.trim() || !command.coverageIds.length)
      fail('THIN_VERIFY_COMMAND_INVALID', command.id)
    const result = run(command.executable, command.args, repositoryRoot)
    const logPath = resolve(outputRoot, `${command.id}.log`)
    if (dirname(logPath) !== outputRoot) fail('THIN_VERIFY_LOG_OUTSIDE_OUTPUT_ROOT', command.id)
    writeFileSync(
      logPath,
      `STDOUT\n${result.stdout}\nSTDERR\n${result.stderr}\nEXIT_STATUS=${result.exitCode}\n`,
      { flag: 'wx' }
    )
    return { ...structuredClone(command), ...result, logPath }
  })
  verifyPostCommandState(
    input,
    repositoryRoot,
    candidateSha,
    candidateTreeSha,
    declaredPaths,
    declaredInputs
  )
  const raw = {
    schemaVersion: 1 as const,
    kind: 'OES_THIN_VERIFICATION_RESULT' as const,
    status: commands.every((command) => command.exitCode === 0)
      ? ('PASSED' as const)
      : ('FAILED' as const),
    baselineSha,
    candidateSha,
    candidateTreeSha,
    formalCandidate: input.formalCandidate,
    packageReference: input.packageReference,
    declaredInputs,
    commands,
    artifacts: {
      modifiedArtifact: candidatePath,
      patch: patchPath,
      verification: verificationPath,
      rollback: rollbackPath
    }
  }
  const value: VerificationRunResult = {
    ...raw,
    resultFingerprint: objectFingerprint(raw as unknown as Record<string, unknown>, '__none__')
  }
  writeFileSync(verificationPath, `${canonicalJson(value)}\n`, { flag: 'wx' })
  return value
}

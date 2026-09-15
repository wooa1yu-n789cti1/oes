import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assessDrift,
  createEvidenceKey,
  validateEvidenceKey,
  type CompleteDriftAssessmentInput,
  type CompleteEvidenceKeyInput
} from '../evidence.ts'
import { validateJsonSchema } from '../schema-validation.ts'
import type { DriftAssessmentInput, EvidenceKeyInput } from '../types.ts'

const hash = (char: string) => char.repeat(64)
const sha = (char: string) => char.repeat(40)
const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'schemas', 'evidence-key.schema.json'), 'utf8')
) as Record<string, unknown>

const input = (candidate = sha('1'), tree = sha('2')): CompleteEvidenceKeyInput => ({
  candidateSha: candidate,
  candidateTreeSha: tree,
  dependencyCandidates: [
    { deliveryKey: 'zeta', candidateSha: sha('3'), candidateTreeSha: sha('4') },
    { deliveryKey: 'alpha', candidateSha: sha('5'), candidateTreeSha: sha('6') }
  ],
  dependencyFingerprint: hash('a'),
  lockfileFingerprint: hash('b'),
  toolchainFingerprint: hash('c'),
  testConfigFingerprint: hash('d'),
  environmentFingerprint: hash('e'),
  literalInputsFingerprint: hash('f'),
  executionProfileFingerprint: hash('7'),
  commandFingerprint: hash('8'),
  commandVersion: 'collaboration-runtime:test@1',
  literalResultFingerprint: hash('9'),
  exitCode: 0,
  coverageIds: ['driver', 'cleanup']
})

const base = (): CompleteDriftAssessmentInput => ({
  previousEvidence: createEvidenceKey(input()),
  nextEvidence: input(),
  changedPaths: [],
  coverage: [
    {
      id: 'driver',
      pathPatterns: ['scripts/collaboration-runtime/src/**'],
      contractSensitive: true
    },
    { id: 'cleanup', pathPatterns: ['docs/runbooks/**'], contractSensitive: false }
  ],
  dependencyChanged: false,
  profileChanged: false,
  commandChanged: false,
  contractChanged: false,
  semanticConflict: false
})

test('complete evidence keys normalize dependency candidates and satisfy the executable schema', () => {
  const sharedInput: EvidenceKeyInput = input()
  const key = createEvidenceKey(input())
  assert.deepEqual(createEvidenceKey(sharedInput), key)
  assert.deepEqual(
    key.dependencyCandidates.map((candidate) => candidate.deliveryKey),
    ['alpha', 'zeta']
  )
  assert.deepEqual(validateEvidenceKey(key), key)
  assert.doesNotThrow(() => validateJsonSchema(schema, key))
})

test('shared public evidence and drift types expose every complete runtime dimension', () => {
  const sharedInput: EvidenceKeyInput = input()
  const sharedDrift: DriftAssessmentInput = base()
  sharedDrift.nextEvidence = sharedInput
  assert.doesNotThrow(() => createEvidenceKey(sharedInput))
  assert.equal(assessDrift(sharedDrift).decision, 'REUSE_EXACT')
})

test('identical complete evidence keys are reused exactly', () => {
  const result = assessDrift(base())
  assert.equal(result.decision, 'REUSE_EXACT')
  assert.deepEqual(result.reusableCoverageIds, ['cleanup', 'driver'])
})

test('governance-only candidate and tree advancement refreshes only the baseline', () => {
  const value = base()
  value.nextEvidence = input(sha('a'), sha('b'))
  value.changedPaths = ['docs/governance/codex-execution-model.md']
  const result = assessDrift(value)
  assert.equal(result.decision, 'REFRESH_BASELINE')
  assert.deepEqual(result.affectedCoverageIds, [])
  assert.deepEqual(result.reusableCoverageIds, ['cleanup', 'driver'])
})

test('intersecting changed paths invalidate only bounded matching coverage', () => {
  const value = base()
  value.nextEvidence = input(sha('a'), sha('b'))
  value.changedPaths = ['scripts/collaboration-runtime/src/remote-driver.ts']
  const result = assessDrift(value)
  assert.equal(result.decision, 'FOCUSED')
  assert.deepEqual(result.affectedCoverageIds, ['driver'])
  assert.deepEqual(result.reusableCoverageIds, ['cleanup'])
})

test('candidate tree drift without a changed-path proof fails to full validation', () => {
  const value = base()
  value.nextEvidence = input(sha('a'), sha('b'))
  const result = assessDrift(value)
  assert.equal(result.decision, 'FULL')
  assert.match(result.reason, /without a changed-path proof/)
})

test('changed-path proof rejects absolute, traversal, empty-segment and directory aliases', () => {
  for (const changedPath of [
    '../scripts/collaboration-runtime/src/evidence.ts',
    '/scripts/collaboration-runtime/src/evidence.ts',
    'scripts/../src/evidence.ts',
    'scripts//src/evidence.ts',
    'scripts/collaboration-runtime/'
  ]) {
    const value = base()
    value.nextEvidence = input(sha('a'), sha('b'))
    value.changedPaths = [changedPath]
    assert.throws(() => assessDrift(value), /EVIDENCE_CHANGED_PATH_INVALID/, changedPath)
  }
})

test('contract, dependency, profile and command signals require full evidence', () => {
  for (const field of [
    'contractChanged',
    'dependencyChanged',
    'profileChanged',
    'commandChanged'
  ] as const) {
    const value = base()
    value[field] = true
    assert.equal(assessDrift(value).decision, 'FULL', field)
  }
})

test('every complete non-baseline identity dimension invalidates all prior coverage', () => {
  const mutations: Array<[string, (value: CompleteEvidenceKeyInput) => void]> = [
    ['dependency candidates', (value) => (value.dependencyCandidates[0].candidateSha = sha('c'))],
    ['dependency fingerprint', (value) => (value.dependencyFingerprint = hash('1'))],
    ['lockfile', (value) => (value.lockfileFingerprint = hash('1'))],
    ['toolchain', (value) => (value.toolchainFingerprint = hash('1'))],
    ['test config', (value) => (value.testConfigFingerprint = hash('1'))],
    ['environment', (value) => (value.environmentFingerprint = hash('1'))],
    ['literal inputs', (value) => (value.literalInputsFingerprint = hash('1'))],
    ['profile', (value) => (value.executionProfileFingerprint = hash('1'))],
    ['command fingerprint', (value) => (value.commandFingerprint = hash('1'))],
    ['command version', (value) => (value.commandVersion = 'collaboration-runtime:test@2')],
    ['literal result', (value) => (value.literalResultFingerprint = hash('1'))],
    ['exit status', (value) => (value.exitCode = 1)]
  ]
  for (const [name, mutate] of mutations) {
    const value = base()
    value.nextEvidence = structuredClone(value.nextEvidence)
    mutate(value.nextEvidence)
    const result = assessDrift(value)
    assert.equal(result.decision, 'FULL', name)
    assert.deepEqual(result.reusableCoverageIds, [], name)
  }
})

test('coverage identity expansion invalidates the prior evidence key', () => {
  const value = base()
  value.coverage.push({ id: 'journey', pathPatterns: ['test/e2e/**'], contractSensitive: true })
  value.nextEvidence = { ...value.nextEvidence, coverageIds: ['driver', 'cleanup', 'journey'] }
  assert.equal(assessDrift(value).decision, 'FULL')
})

test('frozen semantic conflict returns a design gap before any execution reuse', () => {
  const value = base()
  value.semanticConflict = true
  const result = assessDrift(value)
  assert.equal(result.decision, 'DESIGN_GAP')
  assert.deepEqual(result.reusableCoverageIds, [])
})

test('missing prior evidence requires full validation', () => {
  const value = base()
  value.previousEvidence = null
  assert.equal(assessDrift(value).decision, 'FULL')
})

test('tampered, incomplete and non-canonical evidence keys fail closed', () => {
  const value = base()
  if (!value.previousEvidence) throw new Error('fixture missing evidence')
  value.previousEvidence.commandVersion = 'tampered@2'
  assert.throws(() => assessDrift(value), /EVIDENCE_KEY_FINGERPRINT_MISMATCH/)
  const incomplete = input() as unknown as Record<string, unknown>
  delete incomplete.candidateTreeSha
  assert.throws(
    () => createEvidenceKey(incomplete as unknown as CompleteEvidenceKeyInput),
    /EVIDENCE_KEY_INPUT_SHAPE_INVALID/
  )
})

test('duplicate dependency delivery keys and coverage ids fail closed', () => {
  const dependencyDuplicate = input()
  dependencyDuplicate.dependencyCandidates.push({
    deliveryKey: 'alpha',
    candidateSha: sha('a'),
    candidateTreeSha: sha('b')
  })
  assert.throws(
    () => createEvidenceKey(dependencyDuplicate),
    /EVIDENCE_DEPENDENCY_CANDIDATE_DUPLICATE/
  )
  const coverageDuplicate = input()
  coverageDuplicate.coverageIds.push('driver')
  assert.throws(() => createEvidenceKey(coverageDuplicate), /EVIDENCE_COVERAGE_ID_DUPLICATE/)
})

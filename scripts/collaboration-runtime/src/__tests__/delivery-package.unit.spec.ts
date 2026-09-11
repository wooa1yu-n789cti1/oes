import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalJson, objectFingerprint, sha256 } from '../canonical.ts'
import {
  createAggregateDeliveryChildRoster,
  createAggregateDeliveryPackage,
  createAggregateRvInput,
  createDeliveryPackage,
  createPackageEvidenceRecord,
  loadAggregateDeliveryPackageReference,
  loadDeliveryPackageReference,
  planPackageCleanup,
  renderPackagePrSummary,
  validateAggregateDeliveryPackage,
  validateAggregateRvInput,
  validateDeliveryPackage,
  verifyPackageCleanup,
  type AggregateDeliveryPackage,
  type DeliveryPackage
} from '../delivery-package.ts'
import { validateJsonSchema } from '../schema-validation.ts'
import { createReviewSession } from '../review-session.ts'
import { loadOwnerResourceBindingReference, stableOwnerTaskTempLeaf } from '../resource-topology.ts'
import type { OwnerResourceBinding } from '../resource-topology.types.ts'
import {
  deliveryDecisionInput,
  persistTrustedConfirmation
} from './trusted-confirmation-fixture.ts'

const schema = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'schemas', name), 'utf8')
  ) as Record<string, unknown>

const reference = (path: string, fill: string) => ({
  path,
  sha256: fill.repeat(64),
  fingerprint: fill.repeat(64)
})
const pending = () => ({ status: 'PENDING' as const, basisFingerprint: null, evidence: null })
const notApplicable = () => ({
  status: 'NOT_APPLICABLE' as const,
  basisFingerprint: null,
  evidence: null
})

/** Applies process Git overrides for one assertion and restores the exact prior environment. */
function withGitEnvironment(overrides: Record<string, string>, action: () => void): void {
  const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value
    action()
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Writes one typed evidence envelope plus its exact source and returns the envelope reference. */
function persistedEvidence(
  root: string,
  name: string,
  draft: Omit<Parameters<typeof createPackageEvidenceRecord>[0], 'sourceArtifacts'>
) {
  mkdirSync(root, { recursive: true })
  const sourcePath = join(root, `${name}.source.log`)
  const sourceBytes = `${draft.evidenceType}:${draft.result}\n`
  writeFileSync(sourcePath, sourceBytes, { flag: 'wx' })
  const value = createPackageEvidenceRecord({
    ...draft,
    sourceArtifacts: [{ path: sourcePath, sha256: sha256(sourceBytes) }]
  })
  const path = join(root, name)
  const bytes = `${canonicalJson(value)}\n`
  writeFileSync(path, bytes, { flag: 'wx' })
  return { path, sha256: sha256(bytes), fingerprint: value.evidenceFingerprint }
}

/** Persists the stable visible RV subagent identity for one exact reviewed generation. */
function persistedReviewSession(
  root: string,
  name: string,
  deliveryKey: string,
  ownerTaskId: string,
  reviewedSubject: string
) {
  mkdirSync(root, { recursive: true })
  const value = createReviewSession({
    deliveryKey,
    ownerTaskId,
    reviewerAgentId: `${ownerTaskId}/rv`,
    candidateGenerations: [reviewedSubject],
    state: 'ACTIVE'
  })
  const path = join(root, name)
  const bytes = `${canonicalJson(value)}\n`
  writeFileSync(path, bytes, { flag: 'wx' })
  return { path, sha256: sha256(bytes), fingerprint: value.sessionFingerprint }
}

/** Persists and reopens the exact owner binding required by repository package cleanup. */
function persistedOwnerBinding(
  value: DeliveryPackage | AggregateDeliveryPackage,
  repositoryRoot: string
): OwnerResourceBinding {
  const binding: OwnerResourceBinding = {
    schemaVersion: 1,
    kind: 'OES_OWNER_RESOURCE_BINDING',
    bindingFingerprint: '',
    resourceTopologyVersion: 'owner-exclusive-v2',
    ownerTaskId: value.ownerTaskId,
    directParentTaskId: '/root/parent',
    transitionId: 'delivery:cleanup:1',
    repositoryRoot,
    repositoryRemoteUrl: 'https://github.com/example/oes.git',
    ownerClone: repositoryRoot,
    ownerGitDirectory: join(repositoryRoot, '.git'),
    ownerRef:
      value.kind === 'OES_DELIVERY_PACKAGE'
        ? `refs/heads/codex/delivery/${value.deliveryKey}`
        : `refs/heads/codex/coordination/${value.coordinationKey}`,
    artifactRoot: value.artifactRoot,
    taskTempRoot: `/private/tmp/${stableOwnerTaskTempLeaf(value.ownerTaskId)}`,
    deliveryPackagePath: value.packagePath,
    currentEvidenceManifestPath: join(value.artifactRoot, 'current.json'),
    checkpointBundlePath: join(value.artifactRoot, 'checkpoint.json'),
    gitBundlePath: join(value.artifactRoot, 'owner.bundle')
  }
  binding.bindingFingerprint = objectFingerprint(
    binding as unknown as Record<string, unknown>,
    'bindingFingerprint'
  )
  const path = join(value.artifactRoot, 'owner-resource-binding.json')
  const bytes = `${canonicalJson(binding)}\n`
  writeFileSync(path, bytes)
  return loadOwnerResourceBindingReference({
    path,
    sha256: sha256(bytes),
    fingerprint: binding.bindingFingerprint
  })
}

/** Creates one representative repository DP draft. */
function repositoryDraft(): Parameters<typeof createDeliveryPackage>[0] {
  return {
    packageVersion: 1,
    evidenceGeneration: 1,
    deliveryKey: 'runtime',
    ownerTaskId: '/root/do-runtime',
    executionMode: 'REPOSITORY',
    artifactRoot: '/stable/artifacts/do-runtime',
    packagePath: '/stable/artifacts/do-runtime/delivery-package.json',
    activation: {
      confirmation: reference('/stable/authorization/human-confirmation.json', 'a'),
      confirmationFingerprint: 'a'.repeat(64),
      materialDecisionFingerprint: 'b'.repeat(64),
      approvedCiLevel: 'FULL',
      objective: 'Deliver the collaboration runtime',
      scope: ['runtime and schemas'],
      nonGoals: ['merge'],
      acceptance: ['focused checks pass'],
      designReferences: [],
      protectedScope: ['unrelated product code'],
      dependencies: [],
      writeSet: ['scripts/collaboration-runtime/**'],
      risk: { level: 'HIGH', reasons: ['lifecycle contract'] },
      rollback: ['apply the reverse patch']
    },
    execution: {
      slices: [{ sliceId: 'runtime', status: 'COMPLETE' }],
      repository: {
        baseSha: '1'.repeat(40),
        candidateSha: '2'.repeat(40),
        branch: 'codex/delivery/runtime',
        worktree: '/stable/owners/do-runtime/oes',
        pullRequestNumber: 75,
        mergeQueueEntryId: null,
        mergeSha: null
      },
      hostLocal: null,
      selfTest: {
        status: 'PASSED',
        basisFingerprint: null,
        evidence: reference('/stable/artifacts/do-runtime/self-test.json', 'c')
      },
      reviewSession: null,
      reviewerTaskId: null,
      reviewHistory: [],
      rv: pending(),
      ci: pending(),
      postCheck: pending(),
      remainingRisk: [],
      cleanup: 'PENDING'
    }
  }
}

/** Converts a sealed DP back to an update draft without computed fields. */
function deliveryUpdate(value: DeliveryPackage): Parameters<typeof createDeliveryPackage>[0] {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    packageFingerprint: _packageFingerprint,
    activationFingerprint: _activationFingerprint,
    evidenceBasisFingerprint: _evidenceBasisFingerprint,
    invalidatedEvidence: _invalidatedEvidence,
    ...draft
  } = structuredClone(value)
  return draft
}

/** Creates one representative repository ADP draft. */
function aggregateDraft(): Parameters<typeof createAggregateDeliveryPackage>[0] {
  return {
    packageVersion: 1,
    evidenceGeneration: 1,
    coordinationKey: 'release',
    ownerTaskId: '/root/co-release',
    executionMode: 'REPOSITORY',
    artifactRoot: '/stable/artifacts/co-release',
    packagePath: '/stable/artifacts/co-release/aggregate-delivery-package.json',
    confirmation: reference('/stable/authorization/human-confirmation.json', 'd'),
    confirmationFingerprint: 'd'.repeat(64),
    materialDecisionFingerprint: 'e'.repeat(64),
    approvedCiLevel: 'FULL',
    childRoster: reference('/stable/artifacts/co-release/child-roster.json', 'e'),
    deliveryPackages: ['api', 'web'].map((deliveryKey, index) => ({
      deliveryKey,
      ownerTaskId: `/root/co-release/do-${deliveryKey}`,
      packagePath: `/stable/artifacts/do-${deliveryKey}/delivery-package.json`,
      packageSha256: String(index + 3).repeat(64),
      packageFingerprint: String(index + 5).repeat(64),
      acceptedCandidateSha: String(index + 2).repeat(40),
      acceptedOperationFingerprint: null
    })),
    dependencyOrder: ['api', 'web'],
    integrationContract: ['api before web'],
    aggregateAcceptance: ['combined journey passes'],
    execution: {
      repository: {
        baseSha: '1'.repeat(40),
        aggregateCandidateSha: '9'.repeat(40),
        aggregateBranch: 'codex/coordination/release',
        pullRequestNumber: 76,
        mergeQueueEntryId: null,
        mergeSha: null
      },
      hostLocal: null,
      reviewSession: null,
      reviewerTaskId: null,
      reviewHistory: [],
      aggregateRv: pending(),
      aggregateCi: pending(),
      postCheck: pending(),
      remainingRisk: [],
      cleanup: 'PENDING'
    }
  }
}

/** Converts a sealed ADP back to an update draft without computed fields. */
function aggregateUpdate(
  value: AggregateDeliveryPackage
): Parameters<typeof createAggregateDeliveryPackage>[0] {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    packageFingerprint: _packageFingerprint,
    evidenceBasisFingerprint: _evidenceBasisFingerprint,
    invalidatedEvidence: _invalidatedEvidence,
    ...draft
  } = structuredClone(value)
  return draft
}

test('repository DP is stable-artifact state and PR body is only a generated summary', () => {
  const value = validateDeliveryPackage(createDeliveryPackage(repositoryDraft()))
  validateJsonSchema(schema('delivery-package.schema.json'), value)
  assert.equal(value.execution.selfTest.basisFingerprint, value.evidenceBasisFingerprint)
  const summary = renderPackagePrSummary(value)
  const templateHeadings = readFileSync(
    join(import.meta.dirname, '..', '..', '..', '..', '.github', 'pull_request_template.md'),
    'utf8'
  )
    .split('\n')
    .filter((line) => line.startsWith('#'))
  templateHeadings.forEach((heading) => assert.match(summary, new RegExp(`^${heading}$`, 'm')))
  assert.doesNotMatch(summary, /designReferences|evidenceGeneration/)
  assert.doesNotMatch(summary, /\/stable\//)
})

test('v2 active package state requires an explicit cutover instead of silent reinterpretation', () => {
  assert.throws(
    () => validateDeliveryPackage({ schemaVersion: 2, deliveryKey: 'runtime' } as never),
    /V3_PACKAGE_CUTOVER_REQUIRED/
  )
  assert.throws(
    () =>
      validateAggregateDeliveryPackage({ schemaVersion: 2, coordinationKey: 'release' } as never),
    /V3_PACKAGE_CUTOVER_REQUIRED/
  )
})

test('scope, design, dependency, and candidate changes invalidate bound DP evidence', () => {
  const first = createDeliveryPackage(repositoryDraft())
  const nextDraft = deliveryUpdate(first)
  nextDraft.packageVersion += 1
  nextDraft.activation.confirmationFingerprint = 'f'.repeat(64)
  nextDraft.activation.scope = ['runtime, schemas, and docs']
  nextDraft.activation.designReferences = [reference('/stable/design/revised.json', 'e')]
  nextDraft.activation.dependencies = [
    {
      deliveryKey: 'foundation',
      acceptedCandidateSha: '7'.repeat(40),
      acceptedOperationFingerprint: null
    }
  ]
  if (!nextDraft.execution.repository) throw new Error('repository fixture absent')
  nextDraft.execution.repository.candidateSha = '8'.repeat(40)
  const next = createDeliveryPackage(nextDraft, first)
  assert.deepEqual(next.invalidatedEvidence, [
    'SCOPE_CHANGED',
    'DESIGN_CHANGED',
    'DEPENDENCY_CHANGED',
    'CANDIDATE_CHANGED'
  ])
  assert.equal(next.execution.selfTest.status, 'INVALIDATED')
  assert.equal(next.execution.selfTest.evidence, null)
  const unconfirmed = deliveryUpdate(first)
  unconfirmed.packageVersion += 1
  unconfirmed.activation.scope = ['changed without confirmation']
  assert.throws(
    () => createDeliveryPackage(unconfirmed, first),
    /DELIVERY_PACKAGE_ACTIVATION_RECONFIRMATION_REQUIRED/
  )
})

test('host-local DP uses the same schema without Git candidate, PR, Merge Queue, or remote CI', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oes-host-local-package-test-')))
  const draft = repositoryDraft()
  draft.executionMode = 'HOST_LOCAL'
  draft.artifactRoot = join(root, 'artifacts')
  draft.packagePath = join(draft.artifactRoot, 'delivery-package.json')
  draft.activation.writeSet = []
  draft.activation.dependencies = []
  draft.execution.repository = null
  draft.execution.hostLocal = {
    cohesiveOperation: 'refresh one local fixture database',
    operationFingerprint: '8'.repeat(64),
    repositoryModified: false,
    resourceKinds: ['database']
  }
  draft.execution.ci = notApplicable()
  const value = createDeliveryPackage(draft)
  mkdirSync(value.artifactRoot)
  writeFileSync(value.packagePath, `${canonicalJson(value)}\n`)
  validateJsonSchema(schema('delivery-package.schema.json'), value)
  assert.equal(value.execution.repository, null)
  assert.equal(value.execution.ci.status, 'NOT_APPLICABLE')
  assert.deepEqual(planPackageCleanup(value, null), {
    packagePath: value.packagePath,
    decision: 'REMOVE_EXTERNAL_PACKAGE'
  })
  rmSync(value.packagePath)
  assert.equal(verifyPackageCleanup(value, null).status, 'PACKAGE_CLEANUP_VERIFIED')

  const repositoryRoot = join(root, 'repository')
  const repositoryArtifacts = join(repositoryRoot, 'docs')
  mkdirSync(repositoryArtifacts, { recursive: true })
  assert.equal(spawnSync('git', ['init', '-q', repositoryRoot]).status, 0)
  const repositoryDraftValue = repositoryDraft()
  repositoryDraftValue.executionMode = 'HOST_LOCAL'
  repositoryDraftValue.artifactRoot = repositoryArtifacts
  repositoryDraftValue.packagePath = join(repositoryArtifacts, 'delivery-package.json')
  repositoryDraftValue.activation.writeSet = []
  repositoryDraftValue.activation.dependencies = []
  repositoryDraftValue.execution.repository = null
  repositoryDraftValue.execution.hostLocal = structuredClone(draft.execution.hostLocal)
  repositoryDraftValue.execution.ci = notApplicable()
  const repositoryValue = createDeliveryPackage(repositoryDraftValue)
  writeFileSync(repositoryValue.packagePath, `${canonicalJson(repositoryValue)}\n`)
  assert.throws(
    () => planPackageCleanup(repositoryValue, null),
    /HOST_LOCAL_PACKAGE_REPOSITORY_PATH_FORBIDDEN/
  )
  withGitEnvironment({ GIT_CEILING_DIRECTORIES: repositoryRoot }, () => {
    assert.throws(
      () => planPackageCleanup(repositoryValue, null),
      /HOST_LOCAL_PACKAGE_REPOSITORY_PATH_FORBIDDEN/
    )
  })
  const invalid = deliveryUpdate(value)
  if (!invalid.execution.hostLocal) throw new Error('host-local fixture absent')
  ;(invalid.execution.hostLocal as { repositoryModified: boolean }).repositoryModified = true
  assert.throws(() => createDeliveryPackage(invalid), /HOST_LOCAL_PACKAGE_OPERATION_INVALID/)
})

test('ADP binds every DP, dependency order, integration contract, accepted candidates, and exact RV input', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oes-package-rv-test-')))
  const { confirmation, authorizationRoot } = persistTrustedConfirmation(
    deliveryDecisionInput({
      ownerTopology: 'CO_WITH_DOS',
      coupling: 'INDEPENDENT_COORDINATED',
      prTopology: 'ONE_AGGREGATE_CO_PR',
      objective: 'Coordinate api and web delivery',
      scope: ['api', 'web'],
      protectedScope: ['unrelated product code'],
      acceptance: ['combined journey passes'],
      integrationContract: ['api before web'],
      risk: 'HIGH'
    }),
    join(root, 'authorization')
  )
  const childDesigns: { path: string; bytes: string }[] = []
  const childReferences = ['api', 'web'].map((deliveryKey, index) => {
    const draft = repositoryDraft()
    draft.deliveryKey = deliveryKey
    draft.ownerTaskId = `/root/co-release/do-${deliveryKey}`
    draft.artifactRoot = join(root, deliveryKey)
    draft.packagePath = join(draft.artifactRoot, 'delivery-package.json')
    draft.activation.confirmation = confirmation.reference
    draft.activation.confirmationFingerprint = confirmation.receipt.confirmationFingerprint
    draft.activation.materialDecisionFingerprint = confirmation.card.materialDecisionFingerprint
    draft.activation.scope = [deliveryKey]
    draft.activation.acceptance = [...confirmation.card.acceptance]
    mkdirSync(draft.artifactRoot, { recursive: true })
    const designPath = join(draft.artifactRoot, 'design.md')
    const designBytes = `design:${deliveryKey}\n`
    writeFileSync(designPath, designBytes)
    draft.activation.designReferences = [
      { path: designPath, sha256: sha256(designBytes), fingerprint: sha256(designBytes) }
    ]
    childDesigns.push({ path: designPath, bytes: designBytes })
    draft.execution.selfTest = pending()
    if (!draft.execution.repository) throw new Error('repository fixture absent')
    draft.execution.repository.branch = `codex/delivery/${deliveryKey}`
    draft.execution.repository.worktree = join(root, 'owners', deliveryKey, 'oes')
    draft.execution.repository.candidateSha = String(index + 2).repeat(40)
    draft.execution.rv = pending()
    draft.execution.reviewSession = persistedReviewSession(
      draft.artifactRoot,
      'rv-session.json',
      deliveryKey,
      draft.ownerTaskId,
      draft.execution.repository.candidateSha
    )
    draft.execution.reviewerTaskId = `${draft.ownerTaskId}/rv`
    draft.execution.reviewHistory = [draft.execution.repository.candidateSha]
    if (deliveryKey === 'api')
      draft.activation.dependencies = [
        {
          deliveryKey: 'foundation',
          acceptedCandidateSha: '7'.repeat(40),
          acceptedOperationFingerprint: null
        }
      ]
    if (deliveryKey === 'web')
      draft.activation.dependencies = [
        {
          deliveryKey: 'api',
          acceptedCandidateSha: '2'.repeat(40),
          acceptedOperationFingerprint: null
        }
      ]
    const initial = createDeliveryPackage(draft)
    const candidateSha = initial.execution.repository?.candidateSha ?? null
    const update = deliveryUpdate(initial)
    update.packageVersion += 1
    update.execution.selfTest = {
      status: 'PASSED',
      basisFingerprint: null,
      evidence: persistedEvidence(draft.artifactRoot, 'self-test.json', {
        evidenceType: 'SELF_TEST',
        subjectKey: deliveryKey,
        ownerTaskId: draft.ownerTaskId,
        reviewerTaskId: null,
        executionMode: 'REPOSITORY',
        evidenceGeneration: initial.evidenceGeneration,
        basisFingerprint: initial.evidenceBasisFingerprint,
        candidateSha,
        operationFingerprint: null,
        result: 'PASSED'
      })
    }
    update.execution.rv = {
      status: 'PASSED',
      basisFingerprint: null,
      evidence: persistedEvidence(draft.artifactRoot, 'rv.json', {
        evidenceType: 'RV',
        subjectKey: deliveryKey,
        ownerTaskId: draft.ownerTaskId,
        reviewerTaskId: `${draft.ownerTaskId}/rv`,
        executionMode: 'REPOSITORY',
        evidenceGeneration: initial.evidenceGeneration,
        basisFingerprint: initial.evidenceBasisFingerprint,
        candidateSha,
        operationFingerprint: null,
        result: 'PASSED'
      })
    }
    const value = createDeliveryPackage(update, initial)
    const bytes = `${canonicalJson(value)}\n`
    mkdirSync(value.artifactRoot, { recursive: true })
    writeFileSync(value.packagePath, bytes, { flag: 'wx' })
    return {
      deliveryKey,
      ownerTaskId: value.ownerTaskId,
      packagePath: value.packagePath,
      packageSha256: sha256(bytes),
      packageFingerprint: value.packageFingerprint,
      acceptedCandidateSha: value.execution.repository?.candidateSha ?? null,
      acceptedOperationFingerprint: null
    }
  })
  const draft = aggregateDraft()
  draft.artifactRoot = join(root, 'coordination')
  draft.packagePath = join(draft.artifactRoot, 'aggregate-delivery-package.json')
  draft.confirmation = confirmation.reference
  draft.confirmationFingerprint = confirmation.receipt.confirmationFingerprint
  draft.materialDecisionFingerprint = confirmation.card.materialDecisionFingerprint
  draft.integrationContract = [...confirmation.card.integrationContract]
  draft.aggregateAcceptance = [...confirmation.card.acceptance]
  draft.deliveryPackages = childReferences
  const childRoster = createAggregateDeliveryChildRoster({
    confirmationFingerprint: draft.confirmationFingerprint,
    coordinationKey: draft.coordinationKey,
    ownerTaskId: draft.ownerTaskId,
    executionMode: draft.executionMode,
    deliveries: childReferences.map(({ deliveryKey, ownerTaskId }) => ({
      deliveryKey,
      ownerTaskId
    })),
    externalDependencies: [
      {
        deliveryKey: 'foundation',
        acceptedCandidateSha: '7'.repeat(40),
        acceptedOperationFingerprint: null
      }
    ]
  })
  validateJsonSchema(schema('aggregate-delivery-child-roster.schema.json'), childRoster)
  mkdirSync(draft.artifactRoot, { recursive: true })
  const childRosterPath = join(draft.artifactRoot, 'child-roster.json')
  const childRosterBytes = `${canonicalJson(childRoster)}\n`
  writeFileSync(childRosterPath, childRosterBytes, { flag: 'wx' })
  draft.childRoster = {
    path: childRosterPath,
    sha256: sha256(childRosterBytes),
    fingerprint: childRoster.rosterFingerprint
  }
  const value = validateAggregateDeliveryPackage(createAggregateDeliveryPackage(draft))
  validateJsonSchema(schema('aggregate-delivery-package.schema.json'), value)
  const aggregateBytes = `${canonicalJson(value)}\n`
  writeFileSync(value.packagePath, aggregateBytes, { flag: 'wx' })
  const aggregateReference = {
    path: value.packagePath,
    sha256: sha256(aggregateBytes),
    fingerprint: value.packageFingerprint
  }
  const trusted = loadAggregateDeliveryPackageReference(aggregateReference, authorizationRoot)
  assert.throws(
    () => createAggregateRvInput({ ...aggregateReference, sha256: 'f'.repeat(64) }, trusted),
    /AGGREGATE_RV_TRUSTED_PACKAGE_REQUIRED/
  )
  const input = createAggregateRvInput(aggregateReference, trusted)
  validateJsonSchema(schema('aggregate-rv-input.schema.json'), input)
  assert.equal(input.aggregateCandidateSha, '9'.repeat(40))
  assert.doesNotThrow(() => validateAggregateRvInput(input, aggregateReference, trusted))
  const wrongCandidate = { ...input, aggregateCandidateSha: '8'.repeat(40), inputFingerprint: '' }
  wrongCandidate.inputFingerprint = objectFingerprint(
    wrongCandidate as unknown as Record<string, unknown>,
    'inputFingerprint'
  )
  assert.throws(
    () => validateAggregateRvInput(wrongCandidate, aggregateReference, trusted),
    /AGGREGATE_RV_EXACT_INPUT_MISMATCH/
  )

  const changedDraft = aggregateUpdate(value)
  changedDraft.packageVersion += 1
  if (!changedDraft.execution.repository) throw new Error('repository fixture absent')
  changedDraft.execution.repository.aggregateCandidateSha = '8'.repeat(40)
  const changed = createAggregateDeliveryPackage(changedDraft, value)
  assert.equal(changed.execution.aggregateRv.status, 'INVALIDATED')
  assert.throws(
    () => createAggregateRvInput(aggregateReference, changed),
    /AGGREGATE_RV_TRUSTED_PACKAGE_REQUIRED/
  )

  const incompleteRoot = join(root, 'incomplete-aggregate')
  mkdirSync(incompleteRoot)
  const completeRoster = createAggregateDeliveryChildRoster({
    confirmationFingerprint: draft.confirmationFingerprint,
    coordinationKey: draft.coordinationKey,
    ownerTaskId: draft.ownerTaskId,
    executionMode: draft.executionMode,
    deliveries: [
      { deliveryKey: 'core', ownerTaskId: '/root/co-release/do-core' },
      ...childReferences.map(({ deliveryKey, ownerTaskId }) => ({ deliveryKey, ownerTaskId }))
    ],
    externalDependencies: []
  })
  const completeRosterPath = join(incompleteRoot, 'child-roster.json')
  const completeRosterBytes = `${canonicalJson(completeRoster)}\n`
  writeFileSync(completeRosterPath, completeRosterBytes)
  const incompleteDraft = aggregateDraft()
  incompleteDraft.artifactRoot = incompleteRoot
  incompleteDraft.packagePath = join(incompleteRoot, 'aggregate-delivery-package.json')
  incompleteDraft.confirmation = confirmation.reference
  incompleteDraft.confirmationFingerprint = confirmation.receipt.confirmationFingerprint
  incompleteDraft.materialDecisionFingerprint = confirmation.card.materialDecisionFingerprint
  incompleteDraft.integrationContract = [...confirmation.card.integrationContract]
  incompleteDraft.aggregateAcceptance = [...confirmation.card.acceptance]
  incompleteDraft.deliveryPackages = childReferences
  incompleteDraft.childRoster = {
    path: completeRosterPath,
    sha256: sha256(completeRosterBytes),
    fingerprint: completeRoster.rosterFingerprint
  }
  const incomplete = createAggregateDeliveryPackage(incompleteDraft)
  const incompleteBytes = `${canonicalJson(incomplete)}\n`
  writeFileSync(incomplete.packagePath, incompleteBytes)
  assert.throws(
    () =>
      loadAggregateDeliveryPackageReference(
        {
          path: incomplete.packagePath,
          sha256: sha256(incompleteBytes),
          fingerprint: incomplete.packageFingerprint
        },
        authorizationRoot
      ),
    /AGGREGATE_CHILD_ROSTER_COVERAGE_MISMATCH/
  )

  const aggregateEvidenceRoot = join(root, 'aggregate-evidence')
  mkdirSync(aggregateEvidenceRoot)
  const aggregateEvidenceDraft = aggregateDraft()
  aggregateEvidenceDraft.artifactRoot = aggregateEvidenceRoot
  aggregateEvidenceDraft.packagePath = join(
    aggregateEvidenceRoot,
    'aggregate-delivery-package.json'
  )
  aggregateEvidenceDraft.deliveryPackages = childReferences
  aggregateEvidenceDraft.confirmation = confirmation.reference
  aggregateEvidenceDraft.confirmationFingerprint = confirmation.receipt.confirmationFingerprint
  aggregateEvidenceDraft.materialDecisionFingerprint = confirmation.card.materialDecisionFingerprint
  aggregateEvidenceDraft.integrationContract = [...confirmation.card.integrationContract]
  aggregateEvidenceDraft.aggregateAcceptance = [...confirmation.card.acceptance]
  const aggregateEvidenceRosterPath = join(aggregateEvidenceRoot, 'child-roster.json')
  writeFileSync(aggregateEvidenceRosterPath, childRosterBytes)
  aggregateEvidenceDraft.childRoster = {
    path: aggregateEvidenceRosterPath,
    sha256: sha256(childRosterBytes),
    fingerprint: childRoster.rosterFingerprint
  }
  aggregateEvidenceDraft.execution.reviewSession = persistedReviewSession(
    aggregateEvidenceRoot,
    'aggregate-rv-session.json',
    aggregateEvidenceDraft.coordinationKey,
    aggregateEvidenceDraft.ownerTaskId,
    aggregateEvidenceDraft.execution.repository?.aggregateCandidateSha ?? ''
  )
  aggregateEvidenceDraft.execution.reviewerTaskId = `${aggregateEvidenceDraft.ownerTaskId}/rv`
  aggregateEvidenceDraft.execution.reviewHistory = [
    aggregateEvidenceDraft.execution.repository?.aggregateCandidateSha ?? ''
  ]
  const aggregateInitial = createAggregateDeliveryPackage(aggregateEvidenceDraft)
  const wrongAggregateRv = persistedEvidence(aggregateEvidenceRoot, 'wrong-aggregate-rv.json', {
    evidenceType: 'AGGREGATE_RV',
    subjectKey: aggregateInitial.coordinationKey,
    ownerTaskId: aggregateInitial.ownerTaskId,
    reviewerTaskId: `${aggregateInitial.ownerTaskId}/rv`,
    executionMode: 'REPOSITORY',
    evidenceGeneration: aggregateInitial.evidenceGeneration,
    basisFingerprint: aggregateInitial.evidenceBasisFingerprint,
    candidateSha: '8'.repeat(40),
    operationFingerprint: null,
    result: 'PASSED'
  })
  const aggregateEvidenceUpdate = aggregateUpdate(aggregateInitial)
  aggregateEvidenceUpdate.packageVersion += 1
  aggregateEvidenceUpdate.execution.aggregateRv = {
    status: 'PASSED',
    basisFingerprint: null,
    evidence: wrongAggregateRv
  }
  const aggregateWithWrongEvidence = createAggregateDeliveryPackage(
    aggregateEvidenceUpdate,
    aggregateInitial
  )
  const aggregateWithWrongEvidenceBytes = `${canonicalJson(aggregateWithWrongEvidence)}\n`
  writeFileSync(aggregateWithWrongEvidence.packagePath, aggregateWithWrongEvidenceBytes)
  assert.throws(
    () =>
      loadAggregateDeliveryPackageReference(
        {
          path: aggregateWithWrongEvidence.packagePath,
          sha256: sha256(aggregateWithWrongEvidenceBytes),
          fingerprint: aggregateWithWrongEvidence.packageFingerprint
        },
        authorizationRoot
      ),
    /PACKAGE_EVIDENCE_APPLICABILITY_MISMATCH/
  )

  writeFileSync(childDesigns[0].path, 'changed design bytes\n')
  assert.throws(
    () => loadAggregateDeliveryPackageReference(aggregateReference, authorizationRoot),
    /DELIVERY_DESIGN_REFERENCE_SHA_MISMATCH/
  )
  writeFileSync(childDesigns[0].path, childDesigns[0].bytes)

  const firstPackage = JSON.parse(
    readFileSync(childReferences[0].packagePath, 'utf8')
  ) as DeliveryPackage
  const selfTestPath = firstPackage.execution.selfTest.evidence?.path
  if (!selfTestPath) throw new Error('self-test fixture reference absent')
  writeFileSync(selfTestPath, '{}\n')
  assert.throws(
    () => loadAggregateDeliveryPackageReference(aggregateReference, authorizationRoot),
    /PACKAGE_EVIDENCE_REFERENCE_SHA_MISMATCH/
  )
})

test('host-local ADP requires two independent packages plus parallelism or cross-operation integration', () => {
  const draft = aggregateDraft()
  draft.executionMode = 'HOST_LOCAL'
  draft.deliveryPackages = draft.deliveryPackages.map((item, index) => ({
    ...item,
    acceptedCandidateSha: null,
    acceptedOperationFingerprint: String(index + 7).repeat(64)
  }))
  draft.execution.repository = null
  draft.execution.hostLocal = {
    operationSetFingerprint: '9'.repeat(64),
    repositoryModified: false,
    realParallelism: true,
    crossOperationIntegration: false
  }
  draft.execution.aggregateCi = notApplicable()
  const value = createAggregateDeliveryPackage(draft)
  validateJsonSchema(schema('aggregate-delivery-package.schema.json'), value)
  const invalid = aggregateUpdate(value)
  if (!invalid.execution.hostLocal) throw new Error('host-local aggregate fixture absent')
  invalid.execution.hostLocal.realParallelism = false
  assert.throws(
    () => createAggregateDeliveryPackage(invalid),
    /AGGREGATE_HOST_LOCAL_CONTRACT_INVALID/
  )
  const duplicateOwner = aggregateDraft()
  duplicateOwner.deliveryPackages[1].ownerTaskId = duplicateOwner.deliveryPackages[0].ownerTaskId
  assert.throws(
    () => createAggregateDeliveryPackage(duplicateOwner),
    /AGGREGATE_PACKAGE_DP_OWNER_INVALID/
  )
})

test('typed evidence rejects stale failed RV reattachment and wrong evidence types', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oes-package-evidence-test-')))
  const { confirmation, authorizationRoot } = persistTrustedConfirmation(
    deliveryDecisionInput({
      objective: 'Deliver the collaboration runtime',
      scope: ['runtime and schemas'],
      protectedScope: ['unrelated product code'],
      acceptance: ['focused checks pass'],
      risk: 'HIGH'
    }),
    join(root, 'authorization')
  )
  const draft = repositoryDraft()
  draft.artifactRoot = join(root, 'artifacts')
  draft.packagePath = join(draft.artifactRoot, 'delivery-package.json')
  draft.activation.confirmation = confirmation.reference
  draft.activation.confirmationFingerprint = confirmation.receipt.confirmationFingerprint
  draft.activation.materialDecisionFingerprint = confirmation.card.materialDecisionFingerprint
  draft.execution.selfTest = pending()
  draft.execution.rv = pending()
  if (!draft.execution.repository) throw new Error('repository fixture absent')
  draft.execution.repository.worktree = join(root, 'repository')
  draft.execution.reviewSession = persistedReviewSession(
    draft.artifactRoot,
    'rv-session.json',
    draft.deliveryKey,
    draft.ownerTaskId,
    draft.execution.repository.candidateSha ?? ''
  )
  draft.execution.reviewerTaskId = `${draft.ownerTaskId}/rv`
  draft.execution.reviewHistory = [draft.execution.repository.candidateSha ?? '']
  const initial = createDeliveryPackage(draft)
  const oldRv = persistedEvidence(draft.artifactRoot, 'old-rv.json', {
    evidenceType: 'RV',
    subjectKey: draft.deliveryKey,
    ownerTaskId: draft.ownerTaskId,
    reviewerTaskId: `${draft.ownerTaskId}/rv`,
    executionMode: 'REPOSITORY',
    evidenceGeneration: initial.evidenceGeneration,
    basisFingerprint: initial.evidenceBasisFingerprint,
    candidateSha: initial.execution.repository?.candidateSha ?? null,
    operationFingerprint: null,
    result: 'FAILED'
  })
  validateJsonSchema(
    schema('package-evidence.schema.json'),
    JSON.parse(readFileSync(oldRv.path, 'utf8'))
  )
  const changedDraft = deliveryUpdate(initial)
  changedDraft.packageVersion += 1
  if (!changedDraft.execution.repository) throw new Error('repository fixture absent')
  changedDraft.execution.repository.candidateSha = '8'.repeat(40)
  const firstSession = createReviewSession({
    deliveryKey: draft.deliveryKey,
    ownerTaskId: draft.ownerTaskId,
    reviewerAgentId: `${draft.ownerTaskId}/rv`,
    candidateGenerations: ['2'.repeat(40)],
    state: 'ACTIVE'
  })
  const advancedSession = createReviewSession(
    {
      deliveryKey: draft.deliveryKey,
      ownerTaskId: draft.ownerTaskId,
      reviewerAgentId: `${draft.ownerTaskId}/rv`,
      candidateGenerations: ['2'.repeat(40), '8'.repeat(40)],
      state: 'ACTIVE'
    },
    firstSession
  )
  const sessionPath = changedDraft.execution.reviewSession?.path
  if (!sessionPath) throw new Error('review session fixture absent')
  const advancedSessionBytes = `${canonicalJson(advancedSession)}\n`
  writeFileSync(sessionPath, advancedSessionBytes)
  changedDraft.execution.reviewSession = {
    path: sessionPath,
    sha256: sha256(advancedSessionBytes),
    fingerprint: advancedSession.sessionFingerprint
  }
  changedDraft.execution.reviewHistory = ['2'.repeat(40), '8'.repeat(40)]
  const changed = createDeliveryPackage(changedDraft, initial)
  const currentSelfTest = persistedEvidence(draft.artifactRoot, 'current-self-test.json', {
    evidenceType: 'SELF_TEST',
    subjectKey: draft.deliveryKey,
    ownerTaskId: draft.ownerTaskId,
    reviewerTaskId: null,
    executionMode: 'REPOSITORY',
    evidenceGeneration: changed.evidenceGeneration,
    basisFingerprint: changed.evidenceBasisFingerprint,
    candidateSha: changed.execution.repository?.candidateSha ?? null,
    operationFingerprint: null,
    result: 'PASSED'
  })
  const resealDraft = deliveryUpdate(changed)
  resealDraft.packageVersion += 1
  resealDraft.execution.selfTest = {
    status: 'PASSED',
    basisFingerprint: null,
    evidence: currentSelfTest
  }
  resealDraft.execution.rv = { status: 'PASSED', basisFingerprint: null, evidence: oldRv }
  const resealed = createDeliveryPackage(resealDraft, changed)
  const resealedBytes = `${canonicalJson(resealed)}\n`
  writeFileSync(resealed.packagePath, resealedBytes)
  const reference = {
    deliveryKey: resealed.deliveryKey,
    ownerTaskId: resealed.ownerTaskId,
    packagePath: resealed.packagePath,
    packageSha256: sha256(resealedBytes),
    packageFingerprint: resealed.packageFingerprint,
    acceptedCandidateSha: resealed.execution.repository?.candidateSha ?? null,
    acceptedOperationFingerprint: null
  }
  assert.throws(
    () => loadDeliveryPackageReference(reference, 'REPOSITORY', authorizationRoot),
    /PACKAGE_EVIDENCE_APPLICABILITY_MISMATCH/
  )

  const wrongVerdictDraft = deliveryUpdate(changed)
  wrongVerdictDraft.packageVersion += 1
  wrongVerdictDraft.execution.selfTest = resealDraft.execution.selfTest
  wrongVerdictDraft.execution.rv = {
    status: 'PASSED',
    basisFingerprint: null,
    evidence: persistedEvidence(draft.artifactRoot, 'wrong-verdict-rv.json', {
      evidenceType: 'RV',
      subjectKey: draft.deliveryKey,
      ownerTaskId: draft.ownerTaskId,
      reviewerTaskId: `${draft.ownerTaskId}/rv`,
      executionMode: 'REPOSITORY',
      evidenceGeneration: changed.evidenceGeneration,
      basisFingerprint: changed.evidenceBasisFingerprint,
      candidateSha: changed.execution.repository?.candidateSha ?? null,
      operationFingerprint: null,
      result: 'FAILED'
    })
  }
  const wrongVerdict = createDeliveryPackage(wrongVerdictDraft, changed)
  const wrongVerdictBytes = `${canonicalJson(wrongVerdict)}\n`
  writeFileSync(wrongVerdict.packagePath, wrongVerdictBytes)
  assert.throws(
    () =>
      loadDeliveryPackageReference(
        {
          ...reference,
          packageSha256: sha256(wrongVerdictBytes),
          packageFingerprint: wrongVerdict.packageFingerprint
        },
        'REPOSITORY',
        authorizationRoot
      ),
    /PACKAGE_EVIDENCE_APPLICABILITY_MISMATCH/
  )

  const wrongTypeDraft = deliveryUpdate(changed)
  wrongTypeDraft.packageVersion += 1
  wrongTypeDraft.execution.selfTest = resealDraft.execution.selfTest
  wrongTypeDraft.execution.rv = {
    status: 'PASSED',
    basisFingerprint: null,
    evidence: persistedEvidence(draft.artifactRoot, 'wrong-type-rv.json', {
      evidenceType: 'CI',
      subjectKey: draft.deliveryKey,
      ownerTaskId: draft.ownerTaskId,
      reviewerTaskId: null,
      executionMode: 'REPOSITORY',
      evidenceGeneration: changed.evidenceGeneration,
      basisFingerprint: changed.evidenceBasisFingerprint,
      candidateSha: changed.execution.repository?.candidateSha ?? null,
      operationFingerprint: null,
      result: 'PASSED'
    })
  }
  const wrongType = createDeliveryPackage(wrongTypeDraft, changed)
  const wrongTypeBytes = `${canonicalJson(wrongType)}\n`
  writeFileSync(wrongType.packagePath, wrongTypeBytes)
  const wrongTypeReference = {
    ...reference,
    packageSha256: sha256(wrongTypeBytes),
    packageFingerprint: wrongType.packageFingerprint
  }
  assert.throws(
    () => loadDeliveryPackageReference(wrongTypeReference, 'REPOSITORY', authorizationRoot),
    /PACKAGE_EVIDENCE_APPLICABILITY_MISMATCH/
  )

  const wrongReviewerDraft = deliveryUpdate(changed)
  wrongReviewerDraft.packageVersion += 1
  wrongReviewerDraft.execution.selfTest = resealDraft.execution.selfTest
  wrongReviewerDraft.execution.rv = {
    status: 'PASSED',
    basisFingerprint: null,
    evidence: persistedEvidence(draft.artifactRoot, 'wrong-reviewer-rv.json', {
      evidenceType: 'RV',
      subjectKey: draft.deliveryKey,
      ownerTaskId: draft.ownerTaskId,
      reviewerTaskId: `${draft.ownerTaskId}/rv-other`,
      executionMode: 'REPOSITORY',
      evidenceGeneration: changed.evidenceGeneration,
      basisFingerprint: changed.evidenceBasisFingerprint,
      candidateSha: changed.execution.repository?.candidateSha ?? null,
      operationFingerprint: null,
      result: 'PASSED'
    })
  }
  const wrongReviewer = createDeliveryPackage(wrongReviewerDraft, changed)
  const wrongReviewerBytes = `${canonicalJson(wrongReviewer)}\n`
  writeFileSync(wrongReviewer.packagePath, wrongReviewerBytes)
  assert.throws(
    () =>
      loadDeliveryPackageReference(
        {
          ...reference,
          packageSha256: sha256(wrongReviewerBytes),
          packageFingerprint: wrongReviewer.packageFingerprint
        },
        'REPOSITORY',
        authorizationRoot
      ),
    /PACKAGE_RV_REVIEWER_SESSION_MISMATCH/
  )

  const outsidePackage = join(root, 'outside-delivery-package.json')
  writeFileSync(outsidePackage, wrongTypeBytes)
  rmSync(wrongType.packagePath)
  symlinkSync(outsidePackage, wrongType.packagePath)
  assert.throws(
    () => loadDeliveryPackageReference(wrongTypeReference, 'REPOSITORY', authorizationRoot),
    /OWNER_RESOURCE_PHYSICAL_PATH_ALIAS/
  )
})

test('DP keeps one RV path, reviewer, and append-only candidate history even after FAILED RV', () => {
  const draft = repositoryDraft()
  const withoutSession = structuredClone(draft)
  withoutSession.execution.rv = {
    status: 'FAILED',
    basisFingerprint: null,
    evidence: reference('/stable/artifacts/do-runtime/failed-rv.json', 'f')
  }
  assert.throws(() => createDeliveryPackage(withoutSession), /DELIVERY_PACKAGE_RV_SESSION_REQUIRED/)

  draft.execution.reviewSession = reference(
    '/stable/artifacts/do-runtime/runtime.rv-session.json',
    'e'
  )
  draft.execution.reviewerTaskId = '/root/do-runtime/rv'
  draft.execution.reviewHistory = ['2'.repeat(40)]
  const first = createDeliveryPackage(draft)
  const changed = deliveryUpdate(first)
  changed.packageVersion += 1
  changed.execution.reviewSession = reference(
    '/stable/artifacts/do-runtime/replacement.rv-session.json',
    'd'
  )
  changed.execution.reviewHistory = ['2'.repeat(40), '3'.repeat(40)]
  assert.throws(
    () => createDeliveryPackage(changed, first),
    /DELIVERY_PACKAGE_RV_SESSION_IMMUTABLE/
  )

  changed.execution.reviewSession = first.execution.reviewSession
  changed.execution.reviewHistory = ['3'.repeat(40)]
  assert.throws(
    () => createDeliveryPackage(changed, first),
    /DELIVERY_PACKAGE_RV_SESSION_IMMUTABLE/
  )
})

test('package cleanup requires trusted physical repository placement and observed postconditions', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oes-package-cleanup-test-')))
  const repositoryRoot = join(root, 'repository')
  const artifactRoot = join(root, 'artifacts')
  mkdirSync(repositoryRoot)
  mkdirSync(artifactRoot)
  assert.equal(spawnSync('git', ['init', '-q', repositoryRoot]).status, 0)
  const draft = repositoryDraft()
  draft.artifactRoot = artifactRoot
  draft.packagePath = join(artifactRoot, 'delivery-package.json')
  if (!draft.execution.repository) throw new Error('repository fixture absent')
  draft.execution.repository.worktree = repositoryRoot
  const value = createDeliveryPackage(draft)
  writeFileSync(value.packagePath, `${canonicalJson(value)}\n`)
  const binding = persistedOwnerBinding(value, repositoryRoot)
  assert.deepEqual(planPackageCleanup(value, binding), {
    packagePath: value.packagePath,
    decision: 'REMOVE_EXTERNAL_PACKAGE'
  })
  assert.throws(() => planPackageCleanup(value, null), /PACKAGE_CLEANUP_OWNER_BINDING_REQUIRED/)
  rmSync(value.packagePath)
  assert.deepEqual(verifyPackageCleanup(value, binding), {
    packagePath: value.packagePath,
    repositoryDiff: [],
    status: 'PACKAGE_CLEANUP_VERIFIED'
  })
  writeFileSync(join(repositoryRoot, 'unexpected.txt'), 'unexpected repository change\n')
  assert.throws(
    () => verifyPackageCleanup(value, binding),
    /PACKAGE_CLEANUP_REPOSITORY_DIFF_NOT_EMPTY/
  )
  const redirectRepository = join(root, 'redirect-repository')
  mkdirSync(redirectRepository)
  assert.equal(spawnSync('git', ['init', '-q', redirectRepository]).status, 0)
  withGitEnvironment(
    {
      GIT_DIR: join(redirectRepository, '.git'),
      GIT_WORK_TREE: redirectRepository,
      GIT_INDEX_FILE: join(redirectRepository, '.git', 'redirect-index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'status.showUntrackedFiles',
      GIT_CONFIG_VALUE_0: 'no'
    },
    () => {
      assert.throws(
        () => verifyPackageCleanup(value, binding),
        /PACKAGE_CLEANUP_REPOSITORY_DIFF_NOT_EMPTY/
      )
    }
  )
  rmSync(join(repositoryRoot, 'unexpected.txt'))

  const insideRepository = join(repositoryRoot, 'delivery-package.json')
  writeFileSync(insideRepository, '{}\n')
  symlinkSync(insideRepository, value.packagePath)
  assert.throws(() => planPackageCleanup(value, binding), /OWNER_RESOURCE_PHYSICAL_PATH_ALIAS/)
  rmSync(value.packagePath)
  rmSync(insideRepository)
  symlinkSync(join(root, 'missing-package.json'), value.packagePath)
  assert.throws(() => planPackageCleanup(value, binding), /OWNER_RESOURCE_PHYSICAL_PATH_ALIAS/)
  assert.throws(() => verifyPackageCleanup(value, binding), /OWNER_RESOURCE_PHYSICAL_PATH_ALIAS/)
})

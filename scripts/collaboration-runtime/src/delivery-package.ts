import { lstatSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalJson, objectFingerprint, sha256 } from './canonical.ts'
import { loadTrustedDecisionConfirmation, type DecisionCard } from './confirmation.ts'
import { fail } from './errors.ts'
import { validateReviewSession, type ReviewSession } from './review-session.ts'
import {
  physicalIdentityForPotentialPath,
  requireExactPhysicalPath,
  requireTrustedOwnerResourceBinding
} from './resource-topology.ts'
import type { TrustedAuthorizationReference } from './types.ts'
import type { OwnerResourceBinding } from './resource-topology.types.ts'

export type DeliveryExecutionMode = 'REPOSITORY' | 'HOST_LOCAL'
export type DeliveryEvidenceStatus =
  | 'PENDING'
  | 'PASSED'
  | 'FAILED'
  | 'INVALIDATED'
  | 'NOT_APPLICABLE'

export interface DeliveryPackageDependency {
  deliveryKey: string
  acceptedCandidateSha: string | null
  acceptedOperationFingerprint: string | null
}

export interface DeliveryActivation {
  confirmation: TrustedAuthorizationReference
  confirmationFingerprint: string
  materialDecisionFingerprint: string
  approvedCiLevel: 'DOCS' | 'SCOPED' | 'FULL'
  objective: string
  scope: string[]
  nonGoals: string[]
  acceptance: string[]
  designReferences: TrustedAuthorizationReference[]
  protectedScope: string[]
  dependencies: DeliveryPackageDependency[]
  writeSet: string[]
  risk: { level: 'LOW' | 'MEDIUM' | 'HIGH'; reasons: string[] }
  rollback: string[]
}

export interface DeliveryEvidence {
  status: DeliveryEvidenceStatus
  basisFingerprint: string | null
  evidence: TrustedAuthorizationReference | null
}

export type PackageEvidenceType =
  | 'SELF_TEST'
  | 'RV'
  | 'CI'
  | 'POST_CHECK'
  | 'AGGREGATE_RV'
  | 'AGGREGATE_CI'
  | 'AGGREGATE_POST_CHECK'

export interface PackageEvidenceArtifact {
  path: string
  sha256: string
}

export interface PackageEvidenceRecord {
  schemaVersion: 2
  kind: 'OES_PACKAGE_EVIDENCE'
  evidenceFingerprint: string
  evidenceType: PackageEvidenceType
  subjectKey: string
  ownerTaskId: string
  reviewerTaskId: string | null
  executionMode: DeliveryExecutionMode
  evidenceGeneration: number
  basisFingerprint: string
  candidateSha: string | null
  operationFingerprint: string | null
  result: 'PASSED' | 'FAILED'
  sourceArtifacts: PackageEvidenceArtifact[]
}

export interface RepositoryDeliveryState {
  baseSha: string
  candidateSha: string | null
  branch: string
  worktree: string
  pullRequestNumber: number | null
  mergeQueueEntryId: string | null
  mergeSha: string | null
}

export interface HostLocalDeliveryState {
  cohesiveOperation: string
  operationFingerprint: string
  repositoryModified: false
  resourceKinds: string[]
}

export interface DeliveryExecution {
  slices: { sliceId: string; status: 'PENDING' | 'COMPLETE' }[]
  repository: RepositoryDeliveryState | null
  hostLocal: HostLocalDeliveryState | null
  selfTest: DeliveryEvidence
  reviewSession: TrustedAuthorizationReference | null
  reviewerTaskId: string | null
  reviewHistory: string[]
  rv: DeliveryEvidence
  ci: DeliveryEvidence
  postCheck: DeliveryEvidence
  remainingRisk: string[]
  cleanup: 'PENDING' | 'VERIFIED'
}

export interface DeliveryPackage {
  schemaVersion: 3
  kind: 'OES_DELIVERY_PACKAGE'
  packageFingerprint: string
  packageVersion: number
  evidenceGeneration: number
  invalidatedEvidence: string[]
  deliveryKey: string
  ownerTaskId: string
  executionMode: DeliveryExecutionMode
  artifactRoot: string
  packagePath: string
  activationFingerprint: string
  evidenceBasisFingerprint: string
  activation: DeliveryActivation
  execution: DeliveryExecution
}

export interface DeliveryPackageReference {
  deliveryKey: string
  ownerTaskId: string
  packagePath: string
  packageSha256: string
  packageFingerprint: string
  acceptedCandidateSha: string | null
  acceptedOperationFingerprint: string | null
}

export interface AggregateRepositoryState {
  baseSha: string
  aggregateCandidateSha: string | null
  aggregateBranch: string
  pullRequestNumber: number | null
  mergeQueueEntryId: string | null
  mergeSha: string | null
}

export interface AggregateHostLocalState {
  operationSetFingerprint: string
  repositoryModified: false
  realParallelism: boolean
  crossOperationIntegration: boolean
}

export interface AggregateExecution {
  repository: AggregateRepositoryState | null
  hostLocal: AggregateHostLocalState | null
  reviewSession: TrustedAuthorizationReference | null
  reviewerTaskId: string | null
  reviewHistory: string[]
  aggregateRv: DeliveryEvidence
  aggregateCi: DeliveryEvidence
  postCheck: DeliveryEvidence
  remainingRisk: string[]
  cleanup: 'PENDING' | 'VERIFIED'
}

export interface AggregateDeliveryPackage {
  schemaVersion: 3
  kind: 'OES_AGGREGATE_DELIVERY_PACKAGE'
  packageFingerprint: string
  packageVersion: number
  evidenceGeneration: number
  invalidatedEvidence: string[]
  coordinationKey: string
  ownerTaskId: string
  executionMode: DeliveryExecutionMode
  artifactRoot: string
  packagePath: string
  confirmation: TrustedAuthorizationReference
  confirmationFingerprint: string
  materialDecisionFingerprint: string
  approvedCiLevel: 'DOCS' | 'SCOPED' | 'FULL'
  childRoster: TrustedAuthorizationReference
  deliveryPackages: DeliveryPackageReference[]
  dependencyOrder: string[]
  integrationContract: string[]
  aggregateAcceptance: string[]
  evidenceBasisFingerprint: string
  execution: AggregateExecution
}

export interface AggregateDeliveryChild {
  deliveryKey: string
  ownerTaskId: string
}

export interface AggregateDeliveryChildRoster {
  schemaVersion: 2
  kind: 'OES_AGGREGATE_DELIVERY_CHILD_ROSTER'
  rosterFingerprint: string
  confirmationFingerprint: string
  coordinationKey: string
  ownerTaskId: string
  executionMode: DeliveryExecutionMode
  deliveries: AggregateDeliveryChild[]
  externalDependencies: DeliveryPackageDependency[]
}

export interface AggregateRvInput {
  schemaVersion: 2
  kind: 'OES_AGGREGATE_RV_INPUT'
  inputFingerprint: string
  aggregatePackage: TrustedAuthorizationReference
  executionMode: DeliveryExecutionMode
  aggregateCandidateSha: string | null
  aggregateOperationSetFingerprint: string | null
}

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SHA = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/
const TASK = /^(?:\/[A-Za-z0-9][A-Za-z0-9_-]*){2,}$/
const REPOSITORY_BRANCH = /^codex\/delivery\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const AGGREGATE_BRANCH = /^codex\/coordination\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const EVIDENCE_NAMES = ['selfTest', 'rv', 'ci', 'postCheck'] as const
const AGGREGATE_EVIDENCE_NAMES = ['aggregateRv', 'aggregateCi', 'postCheck'] as const
const trustedAggregatePackages = new WeakMap<object, string>()
const EVIDENCE_TYPES: Record<string, PackageEvidenceType> = {
  selfTest: 'SELF_TEST',
  rv: 'RV',
  ci: 'CI',
  postCheck: 'POST_CHECK',
  aggregateRv: 'AGGREGATE_RV',
  aggregateCi: 'AGGREGATE_CI',
  aggregatePostCheck: 'AGGREGATE_POST_CHECK'
}

/** Seals one DO Delivery Package and invalidates evidence affected by changed control inputs. */
export function createDeliveryPackage(
  draft: Omit<
    DeliveryPackage,
    | 'schemaVersion'
    | 'kind'
    | 'packageFingerprint'
    | 'activationFingerprint'
    | 'evidenceBasisFingerprint'
    | 'invalidatedEvidence'
  >,
  previous: DeliveryPackage | null = null
): DeliveryPackage {
  if (previous) validateDeliveryPackage(previous)
  if (
    (previous === null && (draft.packageVersion !== 1 || draft.evidenceGeneration !== 1)) ||
    (previous !== null &&
      (draft.packageVersion !== previous.packageVersion + 1 ||
        draft.evidenceGeneration !== previous.evidenceGeneration))
  )
    fail('DELIVERY_PACKAGE_VERSION_TRANSITION_INVALID', draft.deliveryKey)
  if (
    previous &&
    (draft.deliveryKey !== previous.deliveryKey ||
      draft.ownerTaskId !== previous.ownerTaskId ||
      draft.artifactRoot !== previous.artifactRoot ||
      draft.packagePath !== previous.packagePath)
  )
    fail('DELIVERY_PACKAGE_IDENTITY_IMMUTABLE', draft.deliveryKey)
  if (
    previous?.execution.reviewSession &&
    (draft.execution.reviewSession?.path !== previous.execution.reviewSession.path ||
      draft.execution.reviewerTaskId !== previous.execution.reviewerTaskId ||
      canonicalJson(
        draft.execution.reviewHistory.slice(0, previous.execution.reviewHistory.length)
      ) !== canonicalJson(previous.execution.reviewHistory))
  )
    fail('DELIVERY_PACKAGE_RV_SESSION_IMMUTABLE', draft.deliveryKey)
  const activationFingerprint = objectFingerprint(
    draft.activation as unknown as Record<string, unknown>,
    '__none__'
  )
  const evidenceBasisFingerprint = deliveryEvidenceBasis(
    draft.executionMode,
    activationFingerprint,
    draft.execution
  )
  const invalidation = previous
    ? deliveryInvalidationReasons(previous, draft, activationFingerprint, evidenceBasisFingerprint)
    : []
  if (
    previous &&
    activationMaterialControlFingerprint(previous.activation) !==
      activationMaterialControlFingerprint(draft.activation) &&
    previous.activation.confirmationFingerprint === draft.activation.confirmationFingerprint
  )
    fail('DELIVERY_PACKAGE_ACTIVATION_RECONFIRMATION_REQUIRED', draft.deliveryKey)
  const execution = clone(draft.execution)
  if (invalidation.length) invalidateEvidence(execution, EVIDENCE_NAMES, evidenceBasisFingerprint)
  else normalizeEvidenceBasis(execution, EVIDENCE_NAMES, evidenceBasisFingerprint)
  const raw: Omit<DeliveryPackage, 'packageFingerprint'> = {
    schemaVersion: 3,
    kind: 'OES_DELIVERY_PACKAGE',
    packageVersion: draft.packageVersion,
    evidenceGeneration: draft.evidenceGeneration + (invalidation.length ? 1 : 0),
    invalidatedEvidence: invalidation,
    deliveryKey: draft.deliveryKey,
    ownerTaskId: draft.ownerTaskId,
    executionMode: draft.executionMode,
    artifactRoot: draft.artifactRoot,
    packagePath: draft.packagePath,
    activationFingerprint,
    evidenceBasisFingerprint,
    activation: clone(draft.activation),
    execution
  }
  return validateDeliveryPackage({
    ...raw,
    packageFingerprint: objectFingerprint(raw as unknown as Record<string, unknown>, '__none__')
  })
}

/** Validates the closed DP contract for repository and host-local execution modes. */
export function validateDeliveryPackage(value: DeliveryPackage): DeliveryPackage {
  if ((value as { schemaVersion?: number })?.schemaVersion === 2)
    fail('V3_PACKAGE_CUTOVER_REQUIRED', value.deliveryKey ?? 'delivery')
  requireExactKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'packageFingerprint',
      'packageVersion',
      'evidenceGeneration',
      'invalidatedEvidence',
      'deliveryKey',
      'ownerTaskId',
      'executionMode',
      'artifactRoot',
      'packagePath',
      'activationFingerprint',
      'evidenceBasisFingerprint',
      'activation',
      'execution'
    ],
    'deliveryPackage'
  )
  if (
    value.schemaVersion !== 3 ||
    value.kind !== 'OES_DELIVERY_PACKAGE' ||
    !Number.isSafeInteger(value.packageVersion) ||
    value.packageVersion < 1 ||
    !Number.isSafeInteger(value.evidenceGeneration) ||
    value.evidenceGeneration < 1 ||
    !Array.isArray(value.invalidatedEvidence) ||
    value.invalidatedEvidence.some((item) => typeof item !== 'string' || item.length === 0) ||
    new Set(value.invalidatedEvidence).size !== value.invalidatedEvidence.length ||
    !KEY.test(value.deliveryKey) ||
    !TASK.test(value.ownerTaskId) ||
    !['REPOSITORY', 'HOST_LOCAL'].includes(value.executionMode)
  )
    fail('DELIVERY_PACKAGE_ENVELOPE_INVALID', value.deliveryKey)
  validatePackagePath(value.artifactRoot, value.packagePath, 'delivery-package.json')
  validateActivation(value.activation, value.executionMode)
  const activationFingerprint = objectFingerprint(
    value.activation as unknown as Record<string, unknown>,
    '__none__'
  )
  if (value.activationFingerprint !== activationFingerprint)
    fail('DELIVERY_PACKAGE_ACTIVATION_FINGERPRINT_MISMATCH', value.deliveryKey)
  validateDeliveryExecution(value.execution, value.executionMode, value.deliveryKey)
  const basis = deliveryEvidenceBasis(value.executionMode, activationFingerprint, value.execution)
  if (value.evidenceBasisFingerprint !== basis)
    fail('DELIVERY_PACKAGE_EVIDENCE_BASIS_MISMATCH', value.deliveryKey)
  validateEvidenceBindings(value.execution, EVIDENCE_NAMES, basis)
  validateFingerprint(value.packageFingerprint, 'deliveryPackage.packageFingerprint')
  if (
    value.packageFingerprint !==
    objectFingerprint(value as unknown as Record<string, unknown>, 'packageFingerprint')
  )
    fail('DELIVERY_PACKAGE_FINGERPRINT_MISMATCH', value.deliveryKey)
  return value
}

/** Seals one CO Aggregate Delivery Package and invalidates aggregate evidence on binding drift. */
export function createAggregateDeliveryPackage(
  draft: Omit<
    AggregateDeliveryPackage,
    | 'schemaVersion'
    | 'kind'
    | 'packageFingerprint'
    | 'evidenceBasisFingerprint'
    | 'invalidatedEvidence'
  >,
  previous: AggregateDeliveryPackage | null = null
): AggregateDeliveryPackage {
  if (previous) validateAggregateDeliveryPackage(previous)
  if (
    (previous === null && (draft.packageVersion !== 1 || draft.evidenceGeneration !== 1)) ||
    (previous !== null &&
      (draft.packageVersion !== previous.packageVersion + 1 ||
        draft.evidenceGeneration !== previous.evidenceGeneration))
  )
    fail('AGGREGATE_PACKAGE_VERSION_TRANSITION_INVALID', draft.coordinationKey)
  if (
    previous &&
    (draft.coordinationKey !== previous.coordinationKey ||
      draft.ownerTaskId !== previous.ownerTaskId ||
      draft.artifactRoot !== previous.artifactRoot ||
      draft.packagePath !== previous.packagePath)
  )
    fail('AGGREGATE_PACKAGE_IDENTITY_IMMUTABLE', draft.coordinationKey)
  if (
    previous?.execution.reviewSession &&
    (draft.execution.reviewSession?.path !== previous.execution.reviewSession.path ||
      draft.execution.reviewerTaskId !== previous.execution.reviewerTaskId ||
      canonicalJson(
        draft.execution.reviewHistory.slice(0, previous.execution.reviewHistory.length)
      ) !== canonicalJson(previous.execution.reviewHistory))
  )
    fail('AGGREGATE_PACKAGE_RV_SESSION_IMMUTABLE', draft.coordinationKey)
  const evidenceBasisFingerprint = aggregateEvidenceBasis(draft)
  const invalidation = previous
    ? aggregateInvalidationReasons(previous, draft, evidenceBasisFingerprint)
    : []
  const controlChanged =
    previous !== null &&
    canonicalJson({
      childRoster: previous.childRoster,
      dependencyOrder: previous.dependencyOrder,
      integrationContract: previous.integrationContract,
      aggregateAcceptance: previous.aggregateAcceptance,
      materialDecisionFingerprint: previous.materialDecisionFingerprint,
      approvedCiLevel: previous.approvedCiLevel
    }) !==
      canonicalJson({
        childRoster: draft.childRoster,
        dependencyOrder: draft.dependencyOrder,
        integrationContract: draft.integrationContract,
        aggregateAcceptance: draft.aggregateAcceptance,
        materialDecisionFingerprint: draft.materialDecisionFingerprint,
        approvedCiLevel: draft.approvedCiLevel
      })
  if (controlChanged && previous?.confirmationFingerprint === draft.confirmationFingerprint)
    fail('AGGREGATE_PACKAGE_RECONFIRMATION_REQUIRED', draft.coordinationKey)
  const execution = clone(draft.execution)
  if (invalidation.length)
    invalidateEvidence(execution, AGGREGATE_EVIDENCE_NAMES, evidenceBasisFingerprint)
  else normalizeEvidenceBasis(execution, AGGREGATE_EVIDENCE_NAMES, evidenceBasisFingerprint)
  const raw: Omit<AggregateDeliveryPackage, 'packageFingerprint'> = {
    schemaVersion: 3,
    kind: 'OES_AGGREGATE_DELIVERY_PACKAGE',
    packageVersion: draft.packageVersion,
    evidenceGeneration: draft.evidenceGeneration + (invalidation.length ? 1 : 0),
    invalidatedEvidence: invalidation,
    coordinationKey: draft.coordinationKey,
    ownerTaskId: draft.ownerTaskId,
    executionMode: draft.executionMode,
    artifactRoot: draft.artifactRoot,
    packagePath: draft.packagePath,
    confirmation: clone(draft.confirmation),
    confirmationFingerprint: draft.confirmationFingerprint,
    materialDecisionFingerprint: draft.materialDecisionFingerprint,
    approvedCiLevel: draft.approvedCiLevel,
    childRoster: clone(draft.childRoster),
    deliveryPackages: clone(draft.deliveryPackages),
    dependencyOrder: [...draft.dependencyOrder],
    integrationContract: [...draft.integrationContract],
    aggregateAcceptance: [...draft.aggregateAcceptance],
    evidenceBasisFingerprint,
    execution
  }
  return validateAggregateDeliveryPackage({
    ...raw,
    packageFingerprint: objectFingerprint(raw as unknown as Record<string, unknown>, '__none__')
  })
}

/** Seals the Human-confirmed complete CO child set and its explicitly external dependencies. */
export function createAggregateDeliveryChildRoster(
  draft: Omit<AggregateDeliveryChildRoster, 'schemaVersion' | 'kind' | 'rosterFingerprint'>
): AggregateDeliveryChildRoster {
  const raw: Omit<AggregateDeliveryChildRoster, 'rosterFingerprint'> = {
    schemaVersion: 2,
    kind: 'OES_AGGREGATE_DELIVERY_CHILD_ROSTER',
    confirmationFingerprint: draft.confirmationFingerprint,
    coordinationKey: draft.coordinationKey,
    ownerTaskId: draft.ownerTaskId,
    executionMode: draft.executionMode,
    deliveries: clone(draft.deliveries),
    externalDependencies: clone(draft.externalDependencies)
  }
  return validateAggregateDeliveryChildRoster({
    ...raw,
    rosterFingerprint: objectFingerprint(raw as unknown as Record<string, unknown>, '__none__')
  })
}

/** Validates one closed CO child roster before an ADP can bind it. */
export function validateAggregateDeliveryChildRoster(
  value: AggregateDeliveryChildRoster
): AggregateDeliveryChildRoster {
  requireExactKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'rosterFingerprint',
      'confirmationFingerprint',
      'coordinationKey',
      'ownerTaskId',
      'executionMode',
      'deliveries',
      'externalDependencies'
    ],
    'aggregateDeliveryChildRoster'
  )
  if (
    value.schemaVersion !== 2 ||
    value.kind !== 'OES_AGGREGATE_DELIVERY_CHILD_ROSTER' ||
    !DIGEST.test(value.confirmationFingerprint) ||
    !KEY.test(value.coordinationKey) ||
    !TASK.test(value.ownerTaskId) ||
    !['REPOSITORY', 'HOST_LOCAL'].includes(value.executionMode) ||
    !Array.isArray(value.deliveries) ||
    value.deliveries.length < 2 ||
    !Array.isArray(value.externalDependencies)
  )
    fail('AGGREGATE_CHILD_ROSTER_INVALID', value.coordinationKey)
  const deliveryKeys = new Set<string>()
  const owners = new Set<string>()
  for (const delivery of value.deliveries) {
    requireExactKeys(delivery, ['deliveryKey', 'ownerTaskId'], 'aggregateChildRoster.delivery')
    if (
      !KEY.test(delivery.deliveryKey) ||
      deliveryKeys.has(delivery.deliveryKey) ||
      !TASK.test(delivery.ownerTaskId) ||
      owners.has(delivery.ownerTaskId) ||
      !delivery.ownerTaskId.startsWith(`${value.ownerTaskId}/`)
    )
      fail('AGGREGATE_CHILD_ROSTER_DELIVERY_INVALID', delivery.deliveryKey)
    deliveryKeys.add(delivery.deliveryKey)
    owners.add(delivery.ownerTaskId)
  }
  const externalKeys = new Set<string>()
  for (const dependency of value.externalDependencies) {
    validateDependency(dependency, value.executionMode, 'aggregateChildRoster.externalDependency')
    if (deliveryKeys.has(dependency.deliveryKey) || externalKeys.has(dependency.deliveryKey))
      fail('AGGREGATE_CHILD_ROSTER_EXTERNAL_DEPENDENCY_INVALID', dependency.deliveryKey)
    externalKeys.add(dependency.deliveryKey)
  }
  if (
    !DIGEST.test(value.rosterFingerprint) ||
    value.rosterFingerprint !==
      objectFingerprint(value as unknown as Record<string, unknown>, 'rosterFingerprint')
  )
    fail('AGGREGATE_CHILD_ROSTER_FINGERPRINT_MISMATCH', value.coordinationKey)
  return value
}

/** Validates the closed ADP contract and its complete ordered DP set. */
export function validateAggregateDeliveryPackage(
  value: AggregateDeliveryPackage
): AggregateDeliveryPackage {
  if ((value as { schemaVersion?: number })?.schemaVersion === 2)
    fail('V3_PACKAGE_CUTOVER_REQUIRED', value.coordinationKey ?? 'aggregate')
  requireExactKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'packageFingerprint',
      'packageVersion',
      'evidenceGeneration',
      'invalidatedEvidence',
      'coordinationKey',
      'ownerTaskId',
      'executionMode',
      'artifactRoot',
      'packagePath',
      'confirmation',
      'confirmationFingerprint',
      'materialDecisionFingerprint',
      'approvedCiLevel',
      'childRoster',
      'deliveryPackages',
      'dependencyOrder',
      'integrationContract',
      'aggregateAcceptance',
      'evidenceBasisFingerprint',
      'execution'
    ],
    'aggregateDeliveryPackage'
  )
  validateReference(value.confirmation, 'aggregateDeliveryPackage.confirmation')
  if (
    value.schemaVersion !== 3 ||
    value.kind !== 'OES_AGGREGATE_DELIVERY_PACKAGE' ||
    !Number.isSafeInteger(value.packageVersion) ||
    value.packageVersion < 1 ||
    !Number.isSafeInteger(value.evidenceGeneration) ||
    value.evidenceGeneration < 1 ||
    !Array.isArray(value.invalidatedEvidence) ||
    value.invalidatedEvidence.some((item) => typeof item !== 'string' || item.length === 0) ||
    new Set(value.invalidatedEvidence).size !== value.invalidatedEvidence.length ||
    !KEY.test(value.coordinationKey) ||
    !TASK.test(value.ownerTaskId) ||
    !DIGEST.test(value.confirmationFingerprint) ||
    !DIGEST.test(value.materialDecisionFingerprint) ||
    !['DOCS', 'SCOPED', 'FULL'].includes(value.approvedCiLevel) ||
    !['REPOSITORY', 'HOST_LOCAL'].includes(value.executionMode) ||
    !Array.isArray(value.deliveryPackages) ||
    value.deliveryPackages.length < 2 ||
    !nonEmptyStrings(value.integrationContract) ||
    !nonEmptyStrings(value.aggregateAcceptance)
  )
    fail('AGGREGATE_PACKAGE_ENVELOPE_INVALID', value.coordinationKey)
  validatePackagePath(value.artifactRoot, value.packagePath, 'aggregate-delivery-package.json')
  validateReference(value.childRoster, 'aggregateDeliveryPackage.childRoster')
  const keys = new Set<string>()
  const owners = new Set<string>()
  for (const item of value.deliveryPackages) {
    validatePackageReference(item, value.executionMode)
    if (keys.has(item.deliveryKey)) fail('AGGREGATE_PACKAGE_DUPLICATE_DP', item.deliveryKey)
    if (owners.has(item.ownerTaskId) || !item.ownerTaskId.startsWith(`${value.ownerTaskId}/`))
      fail('AGGREGATE_PACKAGE_DP_OWNER_INVALID', item.deliveryKey)
    keys.add(item.deliveryKey)
    owners.add(item.ownerTaskId)
  }
  if (
    value.dependencyOrder.length !== keys.size ||
    new Set(value.dependencyOrder).size !== keys.size ||
    value.dependencyOrder.some((key) => !keys.has(key))
  )
    fail('AGGREGATE_PACKAGE_DEPENDENCY_ORDER_INVALID', value.coordinationKey)
  validateAggregateExecution(value.execution, value.executionMode, value.coordinationKey)
  const basis = aggregateEvidenceBasis(value)
  if (value.evidenceBasisFingerprint !== basis)
    fail('AGGREGATE_PACKAGE_EVIDENCE_BASIS_MISMATCH', value.coordinationKey)
  validateEvidenceBindings(value.execution, AGGREGATE_EVIDENCE_NAMES, basis)
  validateFingerprint(value.packageFingerprint, 'aggregatePackage.packageFingerprint')
  if (
    value.packageFingerprint !==
    objectFingerprint(value as unknown as Record<string, unknown>, 'packageFingerprint')
  )
    fail('AGGREGATE_PACKAGE_FINGERPRINT_MISMATCH', value.coordinationKey)
  return value
}

/** Reopens an exact DP reference and checks its owner, mode, and accepted candidate identity. */
export function loadDeliveryPackageReference(
  reference: DeliveryPackageReference,
  executionMode: DeliveryExecutionMode,
  authorizationRoot: string
): DeliveryPackage {
  validatePackageReference(reference, executionMode)
  const bytes = readFileSync(reference.packagePath)
  if (sha256(bytes) !== reference.packageSha256)
    fail('DELIVERY_PACKAGE_REFERENCE_SHA_MISMATCH', reference.deliveryKey)
  const value = validateDeliveryPackage(JSON.parse(bytes.toString('utf8')) as DeliveryPackage)
  validatePackageArtifactIdentity(value.artifactRoot, value.packagePath, value.deliveryKey)
  reopenDeliveryConfirmation(value, authorizationRoot)
  reopenDesignReferences(value.activation.designReferences, value.deliveryKey)
  if (
    value.deliveryKey !== reference.deliveryKey ||
    value.ownerTaskId !== reference.ownerTaskId ||
    value.executionMode !== executionMode ||
    value.packagePath !== reference.packagePath ||
    value.packageFingerprint !== reference.packageFingerprint ||
    (executionMode === 'REPOSITORY'
      ? value.execution.repository?.candidateSha !== reference.acceptedCandidateSha
      : value.execution.hostLocal?.operationFingerprint !==
        reference.acceptedOperationFingerprint) ||
    value.execution.selfTest.status !== 'PASSED' ||
    value.execution.rv.status !== 'PASSED'
  )
    fail('DELIVERY_PACKAGE_REFERENCE_BINDING_MISMATCH', reference.deliveryKey)
  reopenCompletedEvidence({
    execution: value.execution,
    names: EVIDENCE_NAMES,
    subjectKey: value.deliveryKey,
    ownerTaskId: value.ownerTaskId,
    artifactRoot: value.artifactRoot,
    executionMode: value.executionMode,
    evidenceGeneration: value.evidenceGeneration,
    basisFingerprint: value.evidenceBasisFingerprint,
    candidateSha: value.execution.repository?.candidateSha ?? null,
    operationFingerprint: value.execution.hostLocal?.operationFingerprint ?? null,
    aggregate: false
  })
  if (value.execution.rv.status === 'PASSED') {
    const session = reopenReviewSession(
      value.execution.reviewSession,
      value.deliveryKey,
      value.ownerTaskId,
      value.artifactRoot,
      value.execution.repository?.candidateSha ??
        value.execution.hostLocal?.operationFingerprint ??
        null,
      value.execution.reviewerTaskId,
      value.execution.reviewHistory
    )
    requireRvEvidenceReviewer(value.execution.rv.evidence, session, value.deliveryKey)
  }
  return deepFreeze(value)
}

/** Reopens an ADP and every exact accepted DP before it may drive Aggregate RV. */
export function loadAggregateDeliveryPackageReference(
  reference: TrustedAuthorizationReference,
  authorizationRoot: string
): AggregateDeliveryPackage {
  validateReference(reference, 'aggregateDeliveryPackageReference')
  const bytes = readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256)
    fail('AGGREGATE_PACKAGE_REFERENCE_SHA_MISMATCH', reference.path)
  const value = validateAggregateDeliveryPackage(
    JSON.parse(bytes.toString('utf8')) as AggregateDeliveryPackage
  )
  validatePackageArtifactIdentity(value.artifactRoot, value.packagePath, value.coordinationKey)
  const aggregateCard = reopenAggregateConfirmation(value, authorizationRoot)
  if (value.packagePath !== reference.path || value.packageFingerprint !== reference.fingerprint)
    fail('AGGREGATE_PACKAGE_REFERENCE_BINDING_MISMATCH', value.coordinationKey)
  const childRoster = loadAggregateDeliveryChildRoster(value.childRoster, value)
  const packages = new Map(
    value.deliveryPackages.map((item) => [
      item.deliveryKey,
      loadDeliveryPackageReference(item, value.executionMode, authorizationRoot)
    ])
  )
  validateAggregateMaterialConfirmation(value, aggregateCard, childRoster, packages)
  validateLoadedDependencyOrder(value, packages, childRoster)
  reopenCompletedEvidence({
    execution: value.execution,
    names: AGGREGATE_EVIDENCE_NAMES,
    subjectKey: value.coordinationKey,
    ownerTaskId: value.ownerTaskId,
    artifactRoot: value.artifactRoot,
    executionMode: value.executionMode,
    evidenceGeneration: value.evidenceGeneration,
    basisFingerprint: value.evidenceBasisFingerprint,
    candidateSha: value.execution.repository?.aggregateCandidateSha ?? null,
    operationFingerprint: value.execution.hostLocal?.operationSetFingerprint ?? null,
    aggregate: true
  })
  if (value.execution.aggregateRv.status === 'PASSED') {
    const session = reopenReviewSession(
      value.execution.reviewSession,
      value.coordinationKey,
      value.ownerTaskId,
      value.artifactRoot,
      value.execution.repository?.aggregateCandidateSha ??
        value.execution.hostLocal?.operationSetFingerprint ??
        null,
      value.execution.reviewerTaskId,
      value.execution.reviewHistory
    )
    requireRvEvidenceReviewer(value.execution.aggregateRv.evidence, session, value.coordinationKey)
  }
  const frozen = deepFreeze(value)
  trustedAggregatePackages.set(frozen, canonicalJson(reference))
  return frozen
}

/** Creates the exact ADP-plus-candidate input that Aggregate RV must review. */
export function createAggregateRvInput(
  aggregatePackage: TrustedAuthorizationReference,
  valueInput: AggregateDeliveryPackage
): AggregateRvInput {
  const value = validateAggregateDeliveryPackage(valueInput)
  if (trustedAggregatePackages.get(valueInput) !== canonicalJson(aggregatePackage))
    fail('AGGREGATE_RV_TRUSTED_PACKAGE_REQUIRED', value.coordinationKey)
  validateReference(aggregatePackage, 'aggregateRv.aggregatePackage')
  if (
    aggregatePackage.path !== value.packagePath ||
    aggregatePackage.fingerprint !== value.packageFingerprint
  )
    fail('AGGREGATE_RV_PACKAGE_REFERENCE_MISMATCH', value.coordinationKey)
  const raw: Omit<AggregateRvInput, 'inputFingerprint'> = {
    schemaVersion: 2,
    kind: 'OES_AGGREGATE_RV_INPUT',
    aggregatePackage: clone(aggregatePackage),
    executionMode: value.executionMode,
    aggregateCandidateSha: value.execution.repository?.aggregateCandidateSha ?? null,
    aggregateOperationSetFingerprint: value.execution.hostLocal?.operationSetFingerprint ?? null
  }
  if (value.executionMode === 'REPOSITORY' && raw.aggregateCandidateSha === null)
    fail('AGGREGATE_RV_CANDIDATE_REQUIRED', value.coordinationKey)
  return {
    ...raw,
    inputFingerprint: objectFingerprint(raw as unknown as Record<string, unknown>, '__none__')
  }
}

/** Revalidates an Aggregate RV input against the exact current ADP and candidate identity. */
export function validateAggregateRvInput(
  input: AggregateRvInput,
  aggregatePackage: TrustedAuthorizationReference,
  valueInput: AggregateDeliveryPackage
): AggregateRvInput {
  const expected = createAggregateRvInput(aggregatePackage, valueInput)
  if (canonicalJson(input) !== canonicalJson(expected))
    fail('AGGREGATE_RV_EXACT_INPUT_MISMATCH', valueInput.coordinationKey)
  return input
}

/** Renders only the PR-facing summary derived from a DP or ADP, never the active package state. */
export function renderPackagePrSummary(value: DeliveryPackage | AggregateDeliveryPackage): string {
  if (value.kind === 'OES_DELIVERY_PACKAGE') {
    validateDeliveryPackage(value)
    return [
      '# Summary',
      value.activation.objective,
      '',
      `- Delivery Package: \`${value.deliveryKey}\``,
      `- Candidate: \`${value.execution.repository?.candidateSha ?? 'host-local'}\``,
      `- DP fingerprint: \`${value.packageFingerprint}\``,
      '',
      '## Scope',
      `- Included: ${value.activation.scope.join('; ')}`,
      `- Excluded: ${value.activation.nonGoals.length ? value.activation.nonGoals.join('; ') : 'None'}`,
      `- Protected: ${value.activation.protectedScope.join('; ')}`,
      '',
      '## Architecture Boundary',
      `- Owner task: \`${value.ownerTaskId}\``,
      `- Write set: ${value.activation.writeSet.length ? value.activation.writeSet.join('; ') : 'Host-local; repository write set is empty'}`,
      `- Bound design sources: ${value.activation.designReferences.length ? `${value.activation.designReferences.length} hash-verified reference(s)` : 'No stable-boundary change declared'}`,
      '',
      '## Tenant, Permission, And Audit Impact',
      `- Control impact is bounded by the confirmed scope and protected scope above; risk level is **${value.activation.risk.level}**.`,
      `- Risk reasons: ${value.activation.risk.reasons.length ? value.activation.risk.reasons.join('; ') : 'No additional control impact declared'}`,
      '',
      '## Verification',
      `- Acceptance: ${value.activation.acceptance.join('; ')}`,
      `- Self-test: **${value.execution.selfTest.status}**; RV: **${value.execution.rv.status}**; CI: **${value.execution.ci.status}**; post-check: **${value.execution.postCheck.status}**.`,
      '',
      '## Reviewer Notes',
      `- Remaining risk: ${value.execution.remainingRisk.length ? value.execution.remainingRisk.join('; ') : 'None recorded'}`,
      `- Rollback: ${value.activation.rollback.join('; ')}`
    ].join('\n')
  }
  validateAggregateDeliveryPackage(value)
  return [
    '# Summary',
    `Coordinate the complete confirmed delivery set for \`${value.coordinationKey}\`.`,
    '',
    `- Aggregate candidate: \`${value.execution.repository?.aggregateCandidateSha ?? 'host-local'}\``,
    `- ADP fingerprint: \`${value.packageFingerprint}\``,
    '',
    '## Scope',
    `- Delivery Packages: ${value.dependencyOrder.map((key) => `\`${key}\``).join(', ')}`,
    `- Integration contract: ${value.integrationContract.join('; ')}`,
    '',
    '## Architecture Boundary',
    `- Coordination owner: \`${value.ownerTaskId}\``,
    `- Confirmed child roster fingerprint: \`${value.childRoster.fingerprint}\``,
    '',
    '## Tenant, Permission, And Audit Impact',
    '- Aggregate impact is the union of the exact reopened child packages and the integration contract above.',
    '',
    '## Verification',
    `- Aggregate acceptance: ${value.aggregateAcceptance.join('; ')}`,
    `- Aggregate RV: **${value.execution.aggregateRv.status}**; aggregate CI: **${value.execution.aggregateCi.status}**; post-check: **${value.execution.postCheck.status}**.`,
    '',
    '## Reviewer Notes',
    `- Remaining risk: ${value.execution.remainingRisk.length ? value.execution.remainingRisk.join('; ') : 'None recorded'}`,
    `- Dependency order: ${value.dependencyOrder.join(' → ')}`
  ].join('\n')
}

/** Plans disposal only after reopening the exact owner binding and physical package placement. */
export function planPackageCleanup(
  value: DeliveryPackage | AggregateDeliveryPackage,
  ownerBinding: OwnerResourceBinding | null
): { packagePath: string; decision: 'REMOVE_EXTERNAL_PACKAGE' } {
  validatePackageCleanupPlacement(value, ownerBinding)
  return { packagePath: value.packagePath, decision: 'REMOVE_EXTERNAL_PACKAGE' }
}

/** Verifies actual package absence and an observed empty repository diff after disposal. */
export function verifyPackageCleanup(
  value: DeliveryPackage | AggregateDeliveryPackage,
  ownerBinding: OwnerResourceBinding | null
): { packagePath: string; repositoryDiff: []; status: 'PACKAGE_CLEANUP_VERIFIED' } {
  const placement = validatePackageCleanupPlacement(value, ownerBinding)
  if (pathEntryExists(value.packagePath))
    fail('PACKAGE_CLEANUP_ABSENCE_NOT_VERIFIED', value.packagePath)
  if (placement.repositoryPhysical && placement.gitDirectoryPhysical)
    verifyObservedRepositoryClean(placement.repositoryPhysical, placement.gitDirectoryPhysical)
  return { packagePath: value.packagePath, repositoryDiff: [], status: 'PACKAGE_CLEANUP_VERIFIED' }
}

/** Validates activation-fixed control fields shared by repository and host-local deliveries. */
function validateActivation(value: DeliveryActivation, mode: DeliveryExecutionMode): void {
  requireExactKeys(
    value,
    [
      'confirmation',
      'confirmationFingerprint',
      'materialDecisionFingerprint',
      'approvedCiLevel',
      'objective',
      'scope',
      'nonGoals',
      'acceptance',
      'designReferences',
      'protectedScope',
      'dependencies',
      'writeSet',
      'risk',
      'rollback'
    ],
    'deliveryActivation'
  )
  validateReference(value.confirmation, 'activation.confirmation')
  validateFingerprint(value.confirmationFingerprint, 'activation.confirmationFingerprint')
  validateFingerprint(value.materialDecisionFingerprint, 'activation.materialDecisionFingerprint')
  if (!['DOCS', 'SCOPED', 'FULL'].includes(value.approvedCiLevel))
    fail('DELIVERY_PACKAGE_CI_LEVEL_INVALID', value.objective)
  if (
    !value.objective ||
    !nonEmptyStrings(value.scope) ||
    !nonEmptyStrings(value.acceptance) ||
    !nonEmptyStrings(value.protectedScope) ||
    !nonEmptyStrings(value.rollback) ||
    !Array.isArray(value.nonGoals) ||
    !Array.isArray(value.designReferences) ||
    !Array.isArray(value.dependencies) ||
    !Array.isArray(value.writeSet)
  )
    fail('DELIVERY_PACKAGE_ACTIVATION_INVALID', value.objective)
  if (mode === 'REPOSITORY' && value.writeSet.length === 0)
    fail('DELIVERY_PACKAGE_REPOSITORY_WRITE_SET_REQUIRED', value.objective)
  if (mode === 'HOST_LOCAL' && value.writeSet.length !== 0)
    fail('HOST_LOCAL_PACKAGE_REPOSITORY_WRITE_FORBIDDEN', value.objective)
  value.designReferences.forEach((item) => validateReference(item, 'activation.designReference'))
  const dependencyKeys = new Set<string>()
  for (const dependency of value.dependencies) {
    validateDependency(dependency, mode, 'activation.dependency')
    if (dependencyKeys.has(dependency.deliveryKey))
      fail('DELIVERY_PACKAGE_DEPENDENCY_INVALID', dependency.deliveryKey)
    dependencyKeys.add(dependency.deliveryKey)
  }
  requireExactKeys(value.risk, ['level', 'reasons'], 'activation.risk')
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(value.risk.level) || !Array.isArray(value.risk.reasons))
    fail('DELIVERY_PACKAGE_RISK_INVALID', value.objective)
}

/** Validates one exact internal or explicitly external delivery dependency identity. */
function validateDependency(
  dependency: DeliveryPackageDependency,
  mode: DeliveryExecutionMode,
  field: string
): void {
  requireExactKeys(
    dependency,
    ['deliveryKey', 'acceptedCandidateSha', 'acceptedOperationFingerprint'],
    field
  )
  if (!KEY.test(dependency.deliveryKey))
    fail('DELIVERY_PACKAGE_DEPENDENCY_INVALID', dependency.deliveryKey)
  if (mode === 'REPOSITORY') {
    if (!dependency.acceptedCandidateSha || !SHA.test(dependency.acceptedCandidateSha))
      fail('DELIVERY_PACKAGE_DEPENDENCY_CANDIDATE_REQUIRED', dependency.deliveryKey)
    if (dependency.acceptedOperationFingerprint !== null)
      fail('DELIVERY_PACKAGE_DEPENDENCY_MODE_MISMATCH', dependency.deliveryKey)
  } else if (
    dependency.acceptedCandidateSha !== null ||
    !dependency.acceptedOperationFingerprint ||
    !DIGEST.test(dependency.acceptedOperationFingerprint)
  ) {
    fail('DELIVERY_PACKAGE_DEPENDENCY_OPERATION_REQUIRED', dependency.deliveryKey)
  }
}

/** Keeps the full candidate history beside the mutable canonical RV session reference. */
function validateReviewHistory(
  history: string[],
  session: TrustedAuthorizationReference | null,
  key: string
): void {
  if (
    !Array.isArray(history) ||
    new Set(history).size !== history.length ||
    history.some((subject) => !SHA.test(subject) && !DIGEST.test(subject)) ||
    (session === null ? history.length !== 0 : history.length === 0)
  )
    fail('PACKAGE_RV_SESSION_HISTORY_INVALID', key)
}

/** Enforces mutually exclusive repository and host-local execution state. */
function validateDeliveryExecution(
  value: DeliveryExecution,
  mode: DeliveryExecutionMode,
  key: string
): void {
  requireExactKeys(
    value,
    [
      'slices',
      'repository',
      'hostLocal',
      'selfTest',
      'reviewSession',
      'reviewerTaskId',
      'reviewHistory',
      'rv',
      'ci',
      'postCheck',
      'remainingRisk',
      'cleanup'
    ],
    'deliveryExecution'
  )
  if (!Array.isArray(value.slices) || !Array.isArray(value.remainingRisk))
    fail('DELIVERY_PACKAGE_EXECUTION_INVALID', key)
  if (value.reviewSession !== null)
    validateReference(value.reviewSession, 'deliveryExecution.reviewSession')
  if ((value.reviewSession === null) !== (value.reviewerTaskId === null))
    fail('DELIVERY_PACKAGE_RV_SESSION_IDENTITY_INCOMPLETE', key)
  validateReviewHistory(value.reviewHistory, value.reviewSession, key)
  if (value.reviewerTaskId !== null && !TASK.test(value.reviewerTaskId))
    fail('DELIVERY_PACKAGE_RV_REVIEWER_INVALID', key)
  if (['PASSED', 'FAILED'].includes(value.rv.status) && value.reviewSession === null)
    fail('DELIVERY_PACKAGE_RV_SESSION_REQUIRED', key)
  const slices = new Set<string>()
  for (const slice of value.slices) {
    requireExactKeys(slice, ['sliceId', 'status'], 'deliveryExecution.slice')
    if (
      !slice.sliceId ||
      slices.has(slice.sliceId) ||
      !['PENDING', 'COMPLETE'].includes(slice.status)
    )
      fail('DELIVERY_PACKAGE_SLICE_INVALID', slice.sliceId)
    slices.add(slice.sliceId)
  }
  if (!['PENDING', 'VERIFIED'].includes(value.cleanup))
    fail('DELIVERY_PACKAGE_CLEANUP_STATE_INVALID', key)
  if (mode === 'REPOSITORY') {
    if (!value.repository || value.hostLocal !== null)
      fail('DELIVERY_PACKAGE_REPOSITORY_STATE_REQUIRED', key)
    validateRepositoryState(value.repository, key)
    if (value.ci.status === 'NOT_APPLICABLE') fail('DELIVERY_PACKAGE_REPOSITORY_CI_REQUIRED', key)
  } else {
    if (!value.hostLocal || value.repository !== null)
      fail('HOST_LOCAL_PACKAGE_STATE_REQUIRED', key)
    validateHostLocalState(value.hostLocal, key)
    if (value.ci.status !== 'NOT_APPLICABLE' || value.ci.evidence !== null)
      fail('HOST_LOCAL_PACKAGE_REMOTE_CI_FORBIDDEN', key)
  }
}

/** Validates repository-only DP execution identity. */
function validateRepositoryState(value: RepositoryDeliveryState, key: string): void {
  requireExactKeys(
    value,
    [
      'baseSha',
      'candidateSha',
      'branch',
      'worktree',
      'pullRequestNumber',
      'mergeQueueEntryId',
      'mergeSha'
    ],
    'deliveryExecution.repository'
  )
  if (
    !SHA.test(value.baseSha) ||
    (value.candidateSha !== null && !SHA.test(value.candidateSha)) ||
    !REPOSITORY_BRANCH.test(value.branch) ||
    value.branch !== `codex/delivery/${key}` ||
    !isAbsolute(value.worktree) ||
    (value.pullRequestNumber !== null &&
      (!Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber < 1)) ||
    (value.mergeQueueEntryId !== null && !value.mergeQueueEntryId) ||
    (value.mergeSha !== null && !SHA.test(value.mergeSha))
  )
    fail('DELIVERY_PACKAGE_REPOSITORY_STATE_INVALID', key)
}

/** Validates repository-free host-local DP execution identity. */
function validateHostLocalState(value: HostLocalDeliveryState, key: string): void {
  requireExactKeys(
    value,
    ['cohesiveOperation', 'operationFingerprint', 'repositoryModified', 'resourceKinds'],
    'deliveryExecution.hostLocal'
  )
  if (
    !value.cohesiveOperation ||
    !DIGEST.test(value.operationFingerprint) ||
    value.repositoryModified !== false ||
    !nonEmptyStrings(value.resourceKinds)
  )
    fail('HOST_LOCAL_PACKAGE_OPERATION_INVALID', key)
}

/** Validates mutually exclusive repository and host-local ADP aggregate state. */
function validateAggregateExecution(
  value: AggregateExecution,
  mode: DeliveryExecutionMode,
  key: string
): void {
  requireExactKeys(
    value,
    [
      'repository',
      'hostLocal',
      'reviewSession',
      'reviewerTaskId',
      'reviewHistory',
      'aggregateRv',
      'aggregateCi',
      'postCheck',
      'remainingRisk',
      'cleanup'
    ],
    'aggregateExecution'
  )
  if (!Array.isArray(value.remainingRisk) || !['PENDING', 'VERIFIED'].includes(value.cleanup))
    fail('AGGREGATE_PACKAGE_EXECUTION_INVALID', key)
  if (value.reviewSession !== null)
    validateReference(value.reviewSession, 'aggregateExecution.reviewSession')
  if ((value.reviewSession === null) !== (value.reviewerTaskId === null))
    fail('AGGREGATE_PACKAGE_RV_SESSION_IDENTITY_INCOMPLETE', key)
  validateReviewHistory(value.reviewHistory, value.reviewSession, key)
  if (value.reviewerTaskId !== null && !TASK.test(value.reviewerTaskId))
    fail('AGGREGATE_PACKAGE_RV_REVIEWER_INVALID', key)
  if (['PASSED', 'FAILED'].includes(value.aggregateRv.status) && value.reviewSession === null)
    fail('AGGREGATE_PACKAGE_RV_SESSION_REQUIRED', key)
  if (mode === 'REPOSITORY') {
    if (!value.repository || value.hostLocal !== null)
      fail('AGGREGATE_PACKAGE_REPOSITORY_STATE_REQUIRED', key)
    requireExactKeys(
      value.repository,
      [
        'baseSha',
        'aggregateCandidateSha',
        'aggregateBranch',
        'pullRequestNumber',
        'mergeQueueEntryId',
        'mergeSha'
      ],
      'aggregateExecution.repository'
    )
    if (
      !SHA.test(value.repository.baseSha) ||
      (value.repository.aggregateCandidateSha !== null &&
        !SHA.test(value.repository.aggregateCandidateSha)) ||
      value.repository.aggregateBranch !== `codex/coordination/${key}` ||
      !AGGREGATE_BRANCH.test(value.repository.aggregateBranch) ||
      (value.repository.pullRequestNumber !== null &&
        (!Number.isSafeInteger(value.repository.pullRequestNumber) ||
          value.repository.pullRequestNumber < 1)) ||
      (value.repository.mergeSha !== null && !SHA.test(value.repository.mergeSha))
    )
      fail('AGGREGATE_PACKAGE_REPOSITORY_STATE_INVALID', key)
    if (value.aggregateCi.status === 'NOT_APPLICABLE')
      fail('AGGREGATE_PACKAGE_REPOSITORY_CI_REQUIRED', key)
  } else {
    if (!value.hostLocal || value.repository !== null)
      fail('AGGREGATE_HOST_LOCAL_STATE_REQUIRED', key)
    requireExactKeys(
      value.hostLocal,
      [
        'operationSetFingerprint',
        'repositoryModified',
        'realParallelism',
        'crossOperationIntegration'
      ],
      'aggregateExecution.hostLocal'
    )
    if (
      !DIGEST.test(value.hostLocal.operationSetFingerprint) ||
      value.hostLocal.repositoryModified !== false ||
      (!value.hostLocal.realParallelism && !value.hostLocal.crossOperationIntegration) ||
      value.aggregateCi.status !== 'NOT_APPLICABLE' ||
      value.aggregateCi.evidence !== null
    )
      fail('AGGREGATE_HOST_LOCAL_CONTRACT_INVALID', key)
  }
}

/** Validates one immutable DP reference included by an ADP. */
function validatePackageReference(
  value: DeliveryPackageReference,
  mode: DeliveryExecutionMode
): void {
  requireExactKeys(
    value,
    [
      'deliveryKey',
      'ownerTaskId',
      'packagePath',
      'packageSha256',
      'packageFingerprint',
      'acceptedCandidateSha',
      'acceptedOperationFingerprint'
    ],
    'aggregateDeliveryPackage.deliveryPackage'
  )
  if (
    !KEY.test(value.deliveryKey) ||
    !TASK.test(value.ownerTaskId) ||
    !isAbsolute(value.packagePath) ||
    resolve(value.packagePath) !== value.packagePath ||
    !DIGEST.test(value.packageSha256) ||
    !DIGEST.test(value.packageFingerprint)
  )
    fail('AGGREGATE_PACKAGE_DP_REFERENCE_INVALID', value.deliveryKey)
  if (
    (mode === 'REPOSITORY' &&
      (!value.acceptedCandidateSha ||
        !SHA.test(value.acceptedCandidateSha) ||
        value.acceptedOperationFingerprint !== null)) ||
    (mode === 'HOST_LOCAL' &&
      (value.acceptedCandidateSha !== null ||
        !value.acceptedOperationFingerprint ||
        !DIGEST.test(value.acceptedOperationFingerprint)))
  )
    fail('AGGREGATE_PACKAGE_DP_MODE_MISMATCH', value.deliveryKey)
}

/** Reopens the exact confirmed CO child roster and checks it covers every ADP child once. */
function loadAggregateDeliveryChildRoster(
  reference: TrustedAuthorizationReference,
  aggregate: AggregateDeliveryPackage
): AggregateDeliveryChildRoster {
  validateReference(reference, 'aggregateDeliveryPackage.childRoster')
  if (!isWithin(aggregate.artifactRoot, reference.path))
    fail('AGGREGATE_CHILD_ROSTER_OUTSIDE_ARTIFACT_ROOT', aggregate.coordinationKey)
  const rosterPhysical = requireExactPhysicalPath(
    reference.path,
    'aggregateDeliveryPackage.childRoster.path',
    physicalIdentityForPotentialPath
  )
  const artifactPhysical = requireExactPhysicalPath(
    aggregate.artifactRoot,
    'aggregateDeliveryPackage.artifactRoot',
    physicalIdentityForPotentialPath
  )
  if (!isWithin(artifactPhysical, rosterPhysical))
    fail('AGGREGATE_CHILD_ROSTER_OUTSIDE_ARTIFACT_ROOT', aggregate.coordinationKey)
  const bytes = readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256)
    fail('AGGREGATE_CHILD_ROSTER_SHA_MISMATCH', aggregate.coordinationKey)
  const roster = validateAggregateDeliveryChildRoster(
    JSON.parse(bytes.toString('utf8')) as AggregateDeliveryChildRoster
  )
  if (
    roster.rosterFingerprint !== reference.fingerprint ||
    roster.confirmationFingerprint !== aggregate.confirmationFingerprint ||
    roster.coordinationKey !== aggregate.coordinationKey ||
    roster.ownerTaskId !== aggregate.ownerTaskId ||
    roster.executionMode !== aggregate.executionMode
  )
    fail('AGGREGATE_CHILD_ROSTER_BINDING_MISMATCH', aggregate.coordinationKey)
  const expected = [...roster.deliveries]
    .map((item) => `${item.deliveryKey}:${item.ownerTaskId}`)
    .sort()
  const actual = [...aggregate.deliveryPackages]
    .map((item) => `${item.deliveryKey}:${item.ownerTaskId}`)
    .sort()
  if (expected.length !== actual.length || expected.some((item, index) => item !== actual[index]))
    fail('AGGREGATE_CHILD_ROSTER_COVERAGE_MISMATCH', aggregate.coordinationKey)
  return roster
}

/** Verifies each internal DP dependency is present earlier and bound to the accepted identity. */
function validateLoadedDependencyOrder(
  aggregate: AggregateDeliveryPackage,
  packages: Map<string, DeliveryPackage>,
  roster: AggregateDeliveryChildRoster
): void {
  const positions = new Map(aggregate.dependencyOrder.map((key, index) => [key, index]))
  const references = new Map(aggregate.deliveryPackages.map((item) => [item.deliveryKey, item]))
  const external = new Map(roster.externalDependencies.map((item) => [item.deliveryKey, item]))
  for (const [deliveryKey, value] of packages) {
    const position = positions.get(deliveryKey)
    if (position === undefined) fail('AGGREGATE_PACKAGE_DEPENDENCY_ORDER_INVALID', deliveryKey)
    for (const dependency of value.activation.dependencies) {
      const dependencyPosition = positions.get(dependency.deliveryKey)
      if (dependencyPosition === undefined) {
        const accepted = external.get(dependency.deliveryKey)
        if (
          !accepted ||
          dependency.acceptedCandidateSha !== accepted.acceptedCandidateSha ||
          dependency.acceptedOperationFingerprint !== accepted.acceptedOperationFingerprint
        )
          fail(
            'AGGREGATE_PACKAGE_UNDECLARED_EXTERNAL_DEPENDENCY',
            `${deliveryKey}:${dependency.deliveryKey}`
          )
        continue
      }
      const reference = references.get(dependency.deliveryKey)
      if (
        dependencyPosition >= position ||
        !reference ||
        dependency.acceptedCandidateSha !== reference.acceptedCandidateSha ||
        dependency.acceptedOperationFingerprint !== reference.acceptedOperationFingerprint
      )
        fail(
          'AGGREGATE_PACKAGE_LOADED_DEPENDENCY_MISMATCH',
          `${deliveryKey}:${dependency.deliveryKey}`
        )
    }
  }
}

/** Computes the evidence binding for one DP without including evidence outputs. */
function deliveryEvidenceBasis(
  mode: DeliveryExecutionMode,
  activationFingerprint: string,
  execution: DeliveryExecution
): string {
  return objectFingerprint(
    {
      mode,
      activationFingerprint,
      candidateSha: execution.repository?.candidateSha ?? null,
      operationFingerprint: execution.hostLocal?.operationFingerprint ?? null,
      reviewSessionPath: execution.reviewSession?.path ?? null,
      reviewerTaskId: execution.reviewerTaskId,
      reviewHistory: execution.reviewHistory
    },
    '__none__'
  )
}

/** Computes the evidence binding for one ADP without including evidence outputs. */
function aggregateEvidenceBasis(
  value: Pick<
    AggregateDeliveryPackage,
    | 'executionMode'
    | 'childRoster'
    | 'deliveryPackages'
    | 'dependencyOrder'
    | 'integrationContract'
    | 'aggregateAcceptance'
    | 'approvedCiLevel'
    | 'execution'
  >
): string {
  return objectFingerprint(
    {
      executionMode: value.executionMode,
      childRoster: value.childRoster,
      deliveryPackages: value.deliveryPackages,
      dependencyOrder: value.dependencyOrder,
      integrationContract: value.integrationContract,
      aggregateAcceptance: value.aggregateAcceptance,
      approvedCiLevel: value.approvedCiLevel,
      reviewSessionPath: value.execution.reviewSession?.path ?? null,
      reviewerTaskId: value.execution.reviewerTaskId,
      reviewHistory: value.execution.reviewHistory,
      aggregateCandidateSha: value.execution.repository?.aggregateCandidateSha ?? null,
      aggregateOperationSetFingerprint: value.execution.hostLocal?.operationSetFingerprint ?? null
    },
    '__none__'
  )
}

/** Returns precise DP invalidation reasons for activation or candidate drift. */
function deliveryInvalidationReasons(
  previous: DeliveryPackage,
  next: Pick<DeliveryPackage, 'activation' | 'executionMode' | 'execution'>,
  activationFingerprint: string,
  basis: string
): string[] {
  const reasons: string[] = []
  if (
    canonicalJson(previous.activation.scope) !== canonicalJson(next.activation.scope) ||
    canonicalJson(previous.activation.protectedScope) !==
      canonicalJson(next.activation.protectedScope)
  )
    reasons.push('SCOPE_CHANGED')
  if (
    canonicalJson(previous.activation.designReferences) !==
    canonicalJson(next.activation.designReferences)
  )
    reasons.push('DESIGN_CHANGED')
  if (
    canonicalJson(previous.activation.dependencies) !== canonicalJson(next.activation.dependencies)
  )
    reasons.push('DEPENDENCY_CHANGED')
  if (
    previous.executionMode !== next.executionMode ||
    previous.execution.repository?.candidateSha !== next.execution.repository?.candidateSha ||
    previous.execution.hostLocal?.operationFingerprint !==
      next.execution.hostLocal?.operationFingerprint
  )
    reasons.push('CANDIDATE_CHANGED')
  if (previous.activationFingerprint !== activationFingerprint && reasons.length === 0)
    reasons.push('ACTIVATION_CHANGED')
  if (previous.evidenceBasisFingerprint !== basis && reasons.length === 0)
    reasons.push('EVIDENCE_BASIS_CHANGED')
  return reasons
}

/** Hashes only activation fields that represent a new Human decision rather than evidence repair. */
function activationMaterialControlFingerprint(value: DeliveryActivation): string {
  return objectFingerprint(
    {
      materialDecisionFingerprint: value.materialDecisionFingerprint,
      approvedCiLevel: value.approvedCiLevel,
      objective: value.objective,
      scope: value.scope,
      acceptance: value.acceptance,
      protectedScope: value.protectedScope,
      riskLevel: value.risk.level
    },
    '__none__'
  )
}

/** Returns precise ADP invalidation reasons for DP, order, integration, or aggregate drift. */
function aggregateInvalidationReasons(
  previous: AggregateDeliveryPackage,
  next: Pick<
    AggregateDeliveryPackage,
    | 'deliveryPackages'
    | 'childRoster'
    | 'dependencyOrder'
    | 'integrationContract'
    | 'aggregateAcceptance'
    | 'executionMode'
    | 'approvedCiLevel'
    | 'execution'
  >,
  basis: string
): string[] {
  const reasons: string[] = []
  if (canonicalJson(previous.childRoster) !== canonicalJson(next.childRoster))
    reasons.push('CHILD_ROSTER_CHANGED')
  if (canonicalJson(previous.deliveryPackages) !== canonicalJson(next.deliveryPackages))
    reasons.push('DELIVERY_PACKAGE_SET_CHANGED')
  if (canonicalJson(previous.dependencyOrder) !== canonicalJson(next.dependencyOrder))
    reasons.push('DEPENDENCY_ORDER_CHANGED')
  if (canonicalJson(previous.integrationContract) !== canonicalJson(next.integrationContract))
    reasons.push('INTEGRATION_CONTRACT_CHANGED')
  if (previous.approvedCiLevel !== next.approvedCiLevel) reasons.push('CI_LEVEL_CHANGED')
  if (
    previous.executionMode !== next.executionMode ||
    previous.execution.repository?.aggregateCandidateSha !==
      next.execution.repository?.aggregateCandidateSha ||
    previous.execution.hostLocal?.operationSetFingerprint !==
      next.execution.hostLocal?.operationSetFingerprint
  )
    reasons.push('AGGREGATE_CANDIDATE_CHANGED')
  if (previous.evidenceBasisFingerprint !== basis && reasons.length === 0)
    reasons.push('AGGREGATE_EVIDENCE_BASIS_CHANGED')
  return reasons
}

/** Reopens the Human receipt that activated one DP and rejects a caller-computed card hash. */
function reopenDeliveryConfirmation(value: DeliveryPackage, authorizationRoot: string): void {
  const confirmation = loadTrustedDecisionConfirmation(
    value.activation.confirmation,
    authorizationRoot
  )
  const card = confirmation.card
  if (
    confirmation.receipt.confirmationFingerprint !== value.activation.confirmationFingerprint ||
    card.materialDecisionFingerprint !== value.activation.materialDecisionFingerprint ||
    card.decisionKind !== 'DELIVERY' ||
    card.executionMode !== value.executionMode ||
    card.approvedCiLevel !== value.activation.approvedCiLevel ||
    !['ONE_DO', 'CO_WITH_DOS'].includes(card.ownerTopology) ||
    canonicalJson([...card.protectedScope].sort()) !==
      canonicalJson([...value.activation.protectedScope].sort()) ||
    riskOrdinal(value.activation.risk.level) > riskOrdinal(card.risk) ||
    (card.ownerTopology === 'ONE_DO'
      ? card.objective !== value.activation.objective ||
        canonicalJson([...card.scope].sort()) !==
          canonicalJson([...value.activation.scope].sort()) ||
        canonicalJson([...card.acceptance].sort()) !==
          canonicalJson([...value.activation.acceptance].sort())
      : value.activation.scope.some((item) => !card.scope.includes(item)) ||
        value.activation.acceptance.some((item) => !card.acceptance.includes(item)))
  )
    fail('DELIVERY_PACKAGE_CONFIRMATION_BINDING_MISMATCH', value.deliveryKey)
}

/** Reopens the Human receipt that authorized the exact CO topology and CI ceiling. */
function reopenAggregateConfirmation(
  value: AggregateDeliveryPackage,
  authorizationRoot: string
): DecisionCard {
  const confirmation = loadTrustedDecisionConfirmation(value.confirmation, authorizationRoot)
  const card = confirmation.card
  if (
    confirmation.receipt.confirmationFingerprint !== value.confirmationFingerprint ||
    card.materialDecisionFingerprint !== value.materialDecisionFingerprint ||
    card.decisionKind !== 'DELIVERY' ||
    card.ownerTopology !== 'CO_WITH_DOS' ||
    card.executionMode !== value.executionMode ||
    card.approvedCiLevel !== value.approvedCiLevel
  )
    fail('AGGREGATE_PACKAGE_CONFIRMATION_BINDING_MISMATCH', value.coordinationKey)
  return card
}

/** Binds the reopened CO card to the complete roster, aggregate controls, and child scope union. */
function validateAggregateMaterialConfirmation(
  value: AggregateDeliveryPackage,
  card: DecisionCard,
  roster: AggregateDeliveryChildRoster,
  packages: Map<string, DeliveryPackage>
): void {
  const loadedScope = [
    ...new Set([...packages.values()].flatMap((delivery) => delivery.activation.scope))
  ].sort()
  if (
    roster.confirmationFingerprint !== value.confirmationFingerprint ||
    canonicalJson([...value.integrationContract].sort()) !==
      canonicalJson([...card.integrationContract].sort()) ||
    canonicalJson([...value.aggregateAcceptance].sort()) !==
      canonicalJson([...card.acceptance].sort()) ||
    loadedScope.some((item) => !card.scope.includes(item))
  )
    fail('AGGREGATE_PACKAGE_MATERIAL_DECISION_MISMATCH', value.coordinationKey)
}

/** Orders risk levels so child packages may narrow but never exceed the confirmed aggregate risk. */
function riskOrdinal(value: 'LOW' | 'MEDIUM' | 'HIGH'): number {
  return ['LOW', 'MEDIUM', 'HIGH'].indexOf(value)
}

/** Reopens the one visible RV subagent identity and binds its latest generation to the reviewed subject. */
function reopenReviewSession(
  reference: TrustedAuthorizationReference | null,
  subjectKey: string,
  ownerTaskId: string,
  artifactRoot: string,
  reviewedSubject: string | null,
  reviewerTaskId: string | null,
  reviewHistory: string[]
): ReviewSession {
  if (!reference || !reviewedSubject) fail('PACKAGE_RV_SESSION_EXACT_SUBJECT_REQUIRED', subjectKey)
  validateReference(reference, 'reviewSessionReference')
  if (!isWithin(artifactRoot, reference.path))
    fail('PACKAGE_RV_SESSION_OUTSIDE_ARTIFACT_ROOT', subjectKey)
  const artifactPhysical = requireExactPhysicalPath(
    artifactRoot,
    'reviewSession.artifactRoot',
    physicalIdentityForPotentialPath
  )
  const sessionPhysical = requireExactPhysicalPath(
    reference.path,
    'reviewSession.path',
    physicalIdentityForPotentialPath
  )
  if (!isWithin(artifactPhysical, sessionPhysical))
    fail('PACKAGE_RV_SESSION_OUTSIDE_ARTIFACT_ROOT', subjectKey)
  const bytes = readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256) fail('PACKAGE_RV_SESSION_SHA_MISMATCH', subjectKey)
  const session = validateReviewSession(JSON.parse(bytes.toString('utf8')) as ReviewSession)
  if (
    session.sessionFingerprint !== reference.fingerprint ||
    session.deliveryKey !== subjectKey ||
    session.ownerTaskId !== ownerTaskId ||
    session.reviewerAgentId !== reviewerTaskId ||
    canonicalJson(session.candidateGenerations) !== canonicalJson(reviewHistory) ||
    session.candidateGenerations.at(-1) !== reviewedSubject
  )
    fail('PACKAGE_RV_SESSION_BINDING_MISMATCH', subjectKey)
  return session
}

/** Binds an accepted RV evidence record to the exact visible reviewer session identity. */
function requireRvEvidenceReviewer(
  reference: TrustedAuthorizationReference | null,
  session: ReviewSession,
  subjectKey: string
): void {
  if (!reference) fail('PACKAGE_RV_EVIDENCE_REFERENCE_REQUIRED', subjectKey)
  const bytes = readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256) fail('PACKAGE_RV_EVIDENCE_SHA_MISMATCH', subjectKey)
  const evidence = validatePackageEvidenceRecord(
    JSON.parse(bytes.toString('utf8')) as PackageEvidenceRecord
  )
  if (
    evidence.evidenceFingerprint !== reference.fingerprint ||
    evidence.reviewerTaskId !== session.reviewerAgentId
  )
    fail('PACKAGE_RV_REVIEWER_SESSION_MISMATCH', subjectKey)
}

/** Marks previously applicable evidence invalid and binds its replacement slot to the new basis. */
function invalidateEvidence(execution: object, names: readonly string[], basis: string): void {
  const record = execution as Record<string, unknown>
  for (const name of names) {
    const evidence = record[name] as DeliveryEvidence
    if (evidence.status === 'NOT_APPLICABLE') continue
    record[name] = { status: 'INVALIDATED', basisFingerprint: basis, evidence: null }
  }
}

/** Fills pending evidence slots with the exact current basis without altering completed evidence. */
function normalizeEvidenceBasis(execution: object, names: readonly string[], basis: string): void {
  const record = execution as Record<string, unknown>
  for (const name of names) {
    const evidence = record[name] as DeliveryEvidence
    if (evidence.status !== 'NOT_APPLICABLE' && evidence.basisFingerprint === null)
      evidence.basisFingerprint = basis
  }
}

/** Validates evidence state, reference shape, and exact current basis. */
function validateEvidenceBindings(
  execution: object,
  names: readonly string[],
  basis: string
): void {
  const record = execution as Record<string, unknown>
  for (const name of names) {
    const value = record[name] as DeliveryEvidence
    requireExactKeys(value, ['status', 'basisFingerprint', 'evidence'], `evidence.${name}`)
    if (!['PENDING', 'PASSED', 'FAILED', 'INVALIDATED', 'NOT_APPLICABLE'].includes(value.status))
      fail('PACKAGE_EVIDENCE_STATUS_INVALID', name)
    if (value.status === 'NOT_APPLICABLE') {
      if (value.basisFingerprint !== null || value.evidence !== null)
        fail('PACKAGE_EVIDENCE_NOT_APPLICABLE_INVALID', name)
      continue
    }
    if (value.basisFingerprint !== basis) fail('PACKAGE_EVIDENCE_BASIS_MISMATCH', name)
    if (['PASSED', 'FAILED'].includes(value.status)) {
      if (!value.evidence) fail('PACKAGE_EVIDENCE_REFERENCE_REQUIRED', name)
      validateReference(value.evidence, `evidence.${name}`)
    } else if (value.evidence !== null) {
      fail('PACKAGE_EVIDENCE_REFERENCE_FORBIDDEN', name)
    }
  }
}

/** Seals a typed evidence record that binds verdict and artifacts to one exact package basis. */
export function createPackageEvidenceRecord(
  draft: Omit<PackageEvidenceRecord, 'schemaVersion' | 'kind' | 'evidenceFingerprint'>
): PackageEvidenceRecord {
  const raw: Omit<PackageEvidenceRecord, 'evidenceFingerprint'> = {
    schemaVersion: 2,
    kind: 'OES_PACKAGE_EVIDENCE',
    evidenceType: draft.evidenceType,
    subjectKey: draft.subjectKey,
    ownerTaskId: draft.ownerTaskId,
    reviewerTaskId: draft.reviewerTaskId,
    executionMode: draft.executionMode,
    evidenceGeneration: draft.evidenceGeneration,
    basisFingerprint: draft.basisFingerprint,
    candidateSha: draft.candidateSha,
    operationFingerprint: draft.operationFingerprint,
    result: draft.result,
    sourceArtifacts: clone(draft.sourceArtifacts)
  }
  return validatePackageEvidenceRecord({
    ...raw,
    evidenceFingerprint: objectFingerprint(raw as unknown as Record<string, unknown>, '__none__')
  })
}

/** Validates and rehashes one typed package evidence record and all of its source artifacts. */
export function validatePackageEvidenceRecord(value: PackageEvidenceRecord): PackageEvidenceRecord {
  requireExactKeys(
    value,
    [
      'schemaVersion',
      'kind',
      'evidenceFingerprint',
      'evidenceType',
      'subjectKey',
      'ownerTaskId',
      'reviewerTaskId',
      'executionMode',
      'evidenceGeneration',
      'basisFingerprint',
      'candidateSha',
      'operationFingerprint',
      'result',
      'sourceArtifacts'
    ],
    'packageEvidenceRecord'
  )
  const rvEvidence = ['RV', 'AGGREGATE_RV'].includes(value.evidenceType)
  if (
    value.schemaVersion !== 2 ||
    value.kind !== 'OES_PACKAGE_EVIDENCE' ||
    !Object.values(EVIDENCE_TYPES).includes(value.evidenceType) ||
    !KEY.test(value.subjectKey) ||
    !TASK.test(value.ownerTaskId) ||
    (rvEvidence
      ? !value.reviewerTaskId ||
        !TASK.test(value.reviewerTaskId) ||
        value.reviewerTaskId === value.ownerTaskId
      : value.reviewerTaskId !== null) ||
    !['REPOSITORY', 'HOST_LOCAL'].includes(value.executionMode) ||
    !Number.isSafeInteger(value.evidenceGeneration) ||
    value.evidenceGeneration < 1 ||
    !DIGEST.test(value.basisFingerprint) ||
    !['PASSED', 'FAILED'].includes(value.result) ||
    !Array.isArray(value.sourceArtifacts) ||
    value.sourceArtifacts.length === 0
  )
    fail('PACKAGE_EVIDENCE_RECORD_INVALID', value.subjectKey)
  if (
    (value.executionMode === 'REPOSITORY' &&
      (!value.candidateSha ||
        !SHA.test(value.candidateSha) ||
        value.operationFingerprint !== null)) ||
    (value.executionMode === 'HOST_LOCAL' &&
      (value.candidateSha !== null ||
        !value.operationFingerprint ||
        !DIGEST.test(value.operationFingerprint)))
  )
    fail('PACKAGE_EVIDENCE_IDENTITY_INVALID', value.subjectKey)
  const paths = new Set<string>()
  for (const artifact of value.sourceArtifacts) {
    requireExactKeys(artifact, ['path', 'sha256'], 'packageEvidence.sourceArtifact')
    if (
      !isAbsolute(artifact.path) ||
      resolve(artifact.path) !== artifact.path ||
      !DIGEST.test(artifact.sha256) ||
      paths.has(artifact.path)
    )
      fail('PACKAGE_EVIDENCE_SOURCE_INVALID', artifact.path)
    const bytes = readFileSync(artifact.path)
    if (sha256(bytes) !== artifact.sha256)
      fail('PACKAGE_EVIDENCE_SOURCE_SHA_MISMATCH', artifact.path)
    paths.add(artifact.path)
  }
  if (
    !DIGEST.test(value.evidenceFingerprint) ||
    value.evidenceFingerprint !==
      objectFingerprint(value as unknown as Record<string, unknown>, 'evidenceFingerprint')
  )
    fail('PACKAGE_EVIDENCE_REFERENCE_FINGERPRINT_MISMATCH', value.subjectKey)
  return value
}

interface EvidenceReopenContext {
  execution: object
  names: readonly string[]
  subjectKey: string
  ownerTaskId: string
  artifactRoot: string
  executionMode: DeliveryExecutionMode
  evidenceGeneration: number
  basisFingerprint: string
  candidateSha: string | null
  operationFingerprint: string | null
  aggregate: boolean
}

/** Reopens every completed typed evidence record and checks exact package applicability. */
function reopenCompletedEvidence(context: EvidenceReopenContext): void {
  const record = context.execution as Record<string, unknown>
  for (const name of context.names) {
    const evidence = record[name] as DeliveryEvidence
    if (!['PASSED', 'FAILED'].includes(evidence.status) || !evidence.evidence) continue
    const reference = evidence.evidence
    if (!isWithin(context.artifactRoot, reference.path))
      fail('PACKAGE_EVIDENCE_OUTSIDE_ARTIFACT_ROOT', `${context.subjectKey}:${name}`)
    const artifactPhysical = requireExactPhysicalPath(
      context.artifactRoot,
      'packageEvidence.artifactRoot',
      physicalIdentityForPotentialPath
    )
    const evidencePhysical = requireExactPhysicalPath(
      reference.path,
      'packageEvidence.path',
      physicalIdentityForPotentialPath
    )
    if (!isWithin(artifactPhysical, evidencePhysical))
      fail('PACKAGE_EVIDENCE_OUTSIDE_ARTIFACT_ROOT', `${context.subjectKey}:${name}`)
    const bytes = readFileSync(reference.path)
    if (sha256(bytes) !== reference.sha256)
      fail('PACKAGE_EVIDENCE_REFERENCE_SHA_MISMATCH', `${context.subjectKey}:${name}`)
    const parsed = JSON.parse(bytes.toString('utf8')) as PackageEvidenceRecord
    if (
      !Array.isArray(parsed.sourceArtifacts) ||
      parsed.sourceArtifacts.some(
        (artifact) =>
          !artifact ||
          typeof artifact.path !== 'string' ||
          !isWithin(context.artifactRoot, artifact.path)
      )
    )
      fail('PACKAGE_EVIDENCE_SOURCE_OUTSIDE_ARTIFACT_ROOT', `${context.subjectKey}:${name}`)
    for (const source of parsed.sourceArtifacts) {
      const sourcePhysical = requireExactPhysicalPath(
        source.path,
        'packageEvidence.sourceArtifact.path',
        physicalIdentityForPotentialPath
      )
      if (!isWithin(artifactPhysical, sourcePhysical))
        fail('PACKAGE_EVIDENCE_SOURCE_OUTSIDE_ARTIFACT_ROOT', `${context.subjectKey}:${name}`)
    }
    const value = validatePackageEvidenceRecord(parsed)
    const expectedType =
      context.aggregate && name === 'postCheck' ? 'AGGREGATE_POST_CHECK' : EVIDENCE_TYPES[name]
    if (
      value.evidenceFingerprint !== reference.fingerprint ||
      value.evidenceType !== expectedType ||
      value.subjectKey !== context.subjectKey ||
      value.ownerTaskId !== context.ownerTaskId ||
      value.executionMode !== context.executionMode ||
      value.evidenceGeneration !== context.evidenceGeneration ||
      value.basisFingerprint !== context.basisFingerprint ||
      value.candidateSha !== context.candidateSha ||
      value.operationFingerprint !== context.operationFingerprint ||
      value.result !== evidence.status
    )
      fail('PACKAGE_EVIDENCE_APPLICABILITY_MISMATCH', `${context.subjectKey}:${name}`)
  }
}

/** Binds package cleanup to the trusted owner and rejects every physical repository alias. */
function validatePackageCleanupPlacement(
  value: DeliveryPackage | AggregateDeliveryPackage,
  ownerBinding: OwnerResourceBinding | null
): { repositoryPhysical: string | null; gitDirectoryPhysical: string | null } {
  if (value.kind === 'OES_DELIVERY_PACKAGE') validateDeliveryPackage(value)
  else validateAggregateDeliveryPackage(value)
  const { artifactPhysical, packagePhysical } = validatePackageArtifactIdentity(
    value.artifactRoot,
    value.packagePath,
    value.kind === 'OES_DELIVERY_PACKAGE' ? value.deliveryKey : value.coordinationKey
  )
  if (value.executionMode === 'HOST_LOCAL') {
    if (ownerBinding !== null)
      fail('HOST_LOCAL_PACKAGE_REPOSITORY_BINDING_FORBIDDEN', value.ownerTaskId)
    requireRepositoryFreeArtifactRoot(artifactPhysical)
    return { repositoryPhysical: null, gitDirectoryPhysical: null }
  }
  if (!ownerBinding) fail('PACKAGE_CLEANUP_OWNER_BINDING_REQUIRED', value.ownerTaskId)
  requireTrustedOwnerResourceBinding(ownerBinding)
  const repositoryPhysical = requireExactPhysicalPath(
    ownerBinding.repositoryRoot,
    'ownerBinding.repositoryRoot',
    physicalIdentityForPotentialPath
  )
  const gitDirectoryPhysical = requireExactPhysicalPath(
    ownerBinding.ownerGitDirectory,
    'ownerBinding.ownerGitDirectory',
    physicalIdentityForPotentialPath
  )
  if (
    ownerBinding.ownerTaskId !== value.ownerTaskId ||
    ownerBinding.artifactRoot !== value.artifactRoot ||
    ownerBinding.deliveryPackagePath !== value.packagePath
  )
    fail('PACKAGE_CLEANUP_OWNER_BINDING_MISMATCH', value.ownerTaskId)
  if (isWithin(repositoryPhysical, packagePhysical))
    fail('PACKAGE_CLEANUP_REPOSITORY_PATH_FORBIDDEN', value.packagePath)
  verifyBoundRepositoryIdentity(repositoryPhysical, gitDirectoryPhysical)
  return { repositoryPhysical, gitDirectoryPhysical }
}

/** Reopens every design source byte before completed DP evidence may be accepted. */
function reopenDesignReferences(
  references: TrustedAuthorizationReference[],
  deliveryKey: string
): void {
  const paths = new Set<string>()
  for (const reference of references) {
    if (paths.has(reference.path)) fail('DELIVERY_DESIGN_REFERENCE_DUPLICATE', deliveryKey)
    requireExactPhysicalPath(
      reference.path,
      'activation.designReference.path',
      physicalIdentityForPotentialPath
    )
    let bytes: Buffer
    try {
      bytes = readFileSync(reference.path)
    } catch {
      fail('DELIVERY_DESIGN_REFERENCE_ABSENT', reference.path)
    }
    if (sha256(bytes) !== reference.sha256)
      fail('DELIVERY_DESIGN_REFERENCE_SHA_MISMATCH', reference.path)
    paths.add(reference.path)
  }
}

/** Rejects a host-local artifact root that is inside any Git worktree or repository. */
function requireRepositoryFreeArtifactRoot(artifactRoot: string): void {
  const cwd = nearestExistingDirectory(artifactRoot)
  const result = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd,
    encoding: 'utf8',
    env: controlledGitEnvironment()
  })
  if (result.error) fail('PACKAGE_CLEANUP_GIT_OBSERVATION_FAILED', result.error.message)
  if (result.status === 0) fail('HOST_LOCAL_PACKAGE_REPOSITORY_PATH_FORBIDDEN', artifactRoot)
  if (result.status !== 128 || !result.stderr.includes('not a git repository'))
    fail('PACKAGE_CLEANUP_GIT_OBSERVATION_FAILED', `${result.status}:${result.stderr.trim()}`)
}

/** Confirms that controlled Git resolves the explicitly bound worktree and Git directory identities. */
function verifyBoundRepositoryIdentity(repositoryRoot: string, gitDirectory: string): void {
  const result = spawnSync(
    'git',
    [
      `--git-dir=${gitDirectory}`,
      `--work-tree=${repositoryRoot}`,
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--absolute-git-dir'
    ],
    { encoding: 'utf8', env: controlledGitEnvironment() }
  )
  if (result.error || result.status !== 0)
    fail(
      'PACKAGE_CLEANUP_GIT_OBSERVATION_FAILED',
      result.error?.message ?? `${result.status}:${result.stderr.trim()}`
    )
  const lines = result.stdout.trimEnd().split('\n')
  if (lines.length !== 2)
    fail('PACKAGE_CLEANUP_GIT_IDENTITY_MISMATCH', JSON.stringify(result.stdout))
  const observedRepository = requireExactPhysicalPath(
    resolve(lines[0]),
    'gitObservation.repositoryRoot',
    physicalIdentityForPotentialPath
  )
  const observedGitDirectory = requireExactPhysicalPath(
    resolve(lines[1]),
    'gitObservation.gitDirectory',
    physicalIdentityForPotentialPath
  )
  if (observedRepository !== repositoryRoot || observedGitDirectory !== gitDirectory)
    fail('PACKAGE_CLEANUP_GIT_IDENTITY_MISMATCH', `${observedRepository}:${observedGitDirectory}`)
}

/** Observes the explicitly bound repository and requires a byte-empty porcelain result. */
function verifyObservedRepositoryClean(repositoryRoot: string, gitDirectory: string): void {
  const result = spawnSync(
    'git',
    [
      `--git-dir=${gitDirectory}`,
      `--work-tree=${repositoryRoot}`,
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all'
    ],
    { encoding: 'utf8', env: controlledGitEnvironment() }
  )
  if (result.error || result.status !== 0)
    fail(
      'PACKAGE_CLEANUP_GIT_OBSERVATION_FAILED',
      result.error?.message ?? `${result.status}:${result.stderr.trim()}`
    )
  if (result.stdout.length !== 0)
    fail('PACKAGE_CLEANUP_REPOSITORY_DIFF_NOT_EMPTY', JSON.stringify(result.stdout))
}

/** Supplies only deterministic process inputs and excludes inherited Git discovery/config overrides. */
function controlledGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '0'
  }
}

/** Finds the nearest real directory from which repository membership can be observed. */
function nearestExistingDirectory(path: string): string {
  let current = path
  while (!pathEntryExists(current)) {
    const parent = dirname(current)
    if (parent === current) fail('PACKAGE_CLEANUP_PHYSICAL_PARENT_ABSENT', path)
    current = parent
  }
  const stats = lstatSync(current)
  if (stats.isSymbolicLink()) fail('OWNER_RESOURCE_PHYSICAL_PATH_ALIAS', 'package.artifactRoot')
  return stats.isDirectory() ? current : dirname(current)
}

/** Returns whether one filesystem entry exists without following dangling symlinks. */
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    fail('PACKAGE_CLEANUP_PATH_OBSERVATION_FAILED', path)
  }
}

/** Reopens one package and stable root as exact physical identities. */
function validatePackageArtifactIdentity(
  artifactRoot: string,
  packagePath: string,
  subjectKey: string
): { artifactPhysical: string; packagePhysical: string } {
  const artifactPhysical = requireExactPhysicalPath(
    artifactRoot,
    'package.artifactRoot',
    physicalIdentityForPotentialPath
  )
  const packagePhysical = requireExactPhysicalPath(
    packagePath,
    'package.packagePath',
    physicalIdentityForPotentialPath
  )
  if (!isWithin(artifactPhysical, packagePhysical))
    fail('PACKAGE_ARTIFACT_BINDING_MISMATCH', subjectKey)
  return { artifactPhysical, packagePhysical }
}

/** Validates one package's absolute external artifact location. */
function validatePackagePath(root: string, path: string, filename: string): void {
  requireAbsolute(root, 'artifactRoot')
  requireAbsolute(path, 'packagePath')
  if (!isWithin(root, path) || !path.endsWith(`/${filename}`))
    fail('PACKAGE_PATH_NOT_STABLE_ARTIFACT', path)
}

/** Returns whether a path is equal to or nested beneath one root. */
function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !child.startsWith(sep))
}

/** Requires one absolute canonical path. */
function requireAbsolute(value: string, field: string): void {
  if (!isAbsolute(value) || resolve(value) !== value) fail('PACKAGE_PATH_INVALID', field)
}

/** Validates one trusted evidence reference shape. */
function validateReference(value: TrustedAuthorizationReference, field: string): void {
  requireExactKeys(value, ['path', 'sha256', 'fingerprint'], field)
  if (
    !isAbsolute(value.path) ||
    resolve(value.path) !== value.path ||
    !DIGEST.test(value.sha256) ||
    !DIGEST.test(value.fingerprint)
  )
    fail('PACKAGE_REFERENCE_INVALID', field)
}

/** Requires a lowercase SHA-256 fingerprint. */
function validateFingerprint(value: string, field: string): void {
  if (!DIGEST.test(value)) fail('PACKAGE_FINGERPRINT_INVALID', field)
}

/** Returns true for a nonempty unique string list. */
function nonEmptyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0) &&
    new Set(value).size === value.length
  )
}

/** Requires an object to contain exactly the declared fields. */
function requireExactKeys(value: unknown, allowed: string[], field: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('PACKAGE_OBJECT_INVALID', field)
  const keys = Object.keys(value).sort()
  if (canonicalJson(keys) !== canonicalJson([...allowed].sort()))
    fail('PACKAGE_OBJECT_SHAPE_INVALID', field)
}

/** Produces a detached JSON-compatible copy for deterministic sealing. */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Deep-freezes a reopened package so its trust mark cannot survive mutation. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

import { readFileSync } from 'node:fs'
import { objectFingerprint, sha256 } from './canonical.ts'
import {
  loadDeliveryPackageReference,
  type DeliveryExecutionMode,
  type DeliveryPackageReference
} from './delivery-package.ts'
import { fail } from './errors.ts'
import { validateReviewSession, type ReviewSession } from './review-session.ts'
import { verifyTrustedReference } from './trusted-reference.ts'
import { loadOwnerResourceBindingReference } from './resource-topology.ts'
import type { RemoteTrustRoots, TrustedAuthorizationReference } from './types.ts'

export interface DeliveryLifecycleInput {
  deliveryPackage: DeliveryPackageReference | null
  executionMode: DeliveryExecutionMode
  cleanupResult: TrustedAuthorizationReference | null
}

export interface DeliveryLifecycleCleanupResult {
  schemaVersion: 1
  kind: 'OES_DELIVERY_LIFECYCLE_CLEANUP_RESULT'
  deliveryKey: string
  ownerTaskId: string
  executionMode: DeliveryExecutionMode
  terminalPackageFingerprint: string
  reviewSessionFingerprint: string
  reviewerTaskId: string
  reviewSessionState: 'TERMINAL'
  packagePath: string
  resourceCleanup: 'VERIFIED'
  repositoryDiff: []
  resultFingerprint: string
}

export interface DeliveryLifecyclePlan {
  status: 'WAITING' | 'ACTION_READY' | 'COMPLETE'
  action:
    | 'WAIT_DELIVERY_TERMINAL'
    | 'TERMINATE_RV_SUBAGENT'
    | 'RUN_EXACT_RESOURCE_CLEANUP'
    | 'ARCHIVE_DO'
    | 'NONE'
  confirmationRequired: false
  nextAction: string
  ownerTaskId: string
}

/** Seals a controller-issued exact cleanup result for post-removal lifecycle readback. */
export function createDeliveryLifecycleCleanupResult(
  input: Omit<
    DeliveryLifecycleCleanupResult,
    | 'schemaVersion'
    | 'kind'
    | 'reviewSessionState'
    | 'resourceCleanup'
    | 'repositoryDiff'
    | 'resultFingerprint'
  >
): DeliveryLifecycleCleanupResult {
  const raw = {
    schemaVersion: 1 as const,
    kind: 'OES_DELIVERY_LIFECYCLE_CLEANUP_RESULT' as const,
    ...structuredClone(input),
    reviewSessionState: 'TERMINAL' as const,
    resourceCleanup: 'VERIFIED' as const,
    repositoryDiff: [] as []
  }
  return {
    ...raw,
    resultFingerprint: objectFingerprint(raw as unknown as Record<string, unknown>, '__none__')
  }
}

/** Plans single-DO disposal from reopened exact package/session/cleanup references. */
export function planDeliveryLifecycle(
  input: DeliveryLifecycleInput,
  trust: RemoteTrustRoots
): DeliveryLifecyclePlan {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('DELIVERY_LIFECYCLE_FIELDS_INVALID', 'UNKNOWN')
  if (!['REPOSITORY', 'HOST_LOCAL'].includes(input.executionMode))
    fail('DELIVERY_LIFECYCLE_FIELDS_INVALID', String(input.executionMode))
  if (input.cleanupResult) {
    const result = loadCleanupResult(input.cleanupResult, trust.authorizationRoot)
    const ownerBinding = trust.ownerResourceBinding
      ? loadOwnerResourceBindingReference(trust.ownerResourceBinding)
      : null
    if (
      result.executionMode !== input.executionMode ||
      result.ownerTaskId !== trust.ownerTaskId ||
      (ownerBinding !== null &&
        (ownerBinding.ownerTaskId !== result.ownerTaskId ||
          ownerBinding.deliveryPackagePath !== result.packagePath))
    )
      fail('DELIVERY_LIFECYCLE_CLEANUP_MODE_MISMATCH', result.deliveryKey)
    return {
      status: 'COMPLETE',
      action: 'ARCHIVE_DO',
      confirmationRequired: false,
      nextAction: 'ARCHIVE_CURRENT_DO',
      ownerTaskId: result.ownerTaskId
    }
  }
  if (!input.deliveryPackage)
    fail('DELIVERY_LIFECYCLE_PACKAGE_REFERENCE_REQUIRED', input.executionMode)
  const delivery = loadDeliveryPackageReference(
    input.deliveryPackage,
    input.executionMode,
    trust.authorizationRoot
  )
  if (delivery.ownerTaskId !== trust.ownerTaskId)
    fail('DELIVERY_LIFECYCLE_PROFILE_OWNER_MISMATCH', delivery.ownerTaskId)
  const terminal =
    delivery.execution.postCheck.status === 'PASSED' &&
    (delivery.executionMode === 'HOST_LOCAL' || delivery.execution.repository?.mergeSha !== null)
  if (!terminal)
    return {
      status: 'WAITING',
      action: 'WAIT_DELIVERY_TERMINAL',
      confirmationRequired: false,
      nextAction: 'CONTINUE_CURRENT_DELIVERY',
      ownerTaskId: delivery.ownerTaskId
    }
  const session = reopenSession(delivery.execution.reviewSession)
  if (session.state === 'ACTIVE')
    return {
      status: 'ACTION_READY',
      action: 'TERMINATE_RV_SUBAGENT',
      confirmationRequired: false,
      nextAction: 'READ_RV_TERMINAL_RESULT',
      ownerTaskId: delivery.ownerTaskId
    }
  return {
    status: 'ACTION_READY',
    action: 'RUN_EXACT_RESOURCE_CLEANUP',
    confirmationRequired: false,
    nextAction: 'VERIFY_TASK_OWNED_RESOURCES_ABSENT_AND_ISSUE_CLEANUP_RESULT',
    ownerTaskId: delivery.ownerTaskId
  }
}

/** Reopens the exact session already bound and verified by the Delivery Package loader. */
function reopenSession(reference: TrustedAuthorizationReference | null): ReviewSession {
  if (!reference) fail('DELIVERY_LIFECYCLE_RV_SESSION_REQUIRED', 'delivery')
  const bytes = readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256)
    fail('DELIVERY_LIFECYCLE_RV_SESSION_SHA_MISMATCH', reference.path)
  const session = validateReviewSession(JSON.parse(bytes.toString('utf8')) as ReviewSession)
  if (session.sessionFingerprint !== reference.fingerprint)
    fail('DELIVERY_LIFECYCLE_RV_SESSION_FINGERPRINT_MISMATCH', reference.path)
  return session
}

/** Reopens the controller-owned proof used after the package itself has been removed. */
function loadCleanupResult(
  reference: TrustedAuthorizationReference,
  authorizationRoot: string
): DeliveryLifecycleCleanupResult {
  const value = verifyTrustedReference(
    reference,
    authorizationRoot,
    'resultFingerprint'
  ) as unknown as DeliveryLifecycleCleanupResult
  if (
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          'schemaVersion',
          'kind',
          'deliveryKey',
          'ownerTaskId',
          'executionMode',
          'terminalPackageFingerprint',
          'reviewSessionFingerprint',
          'reviewerTaskId',
          'reviewSessionState',
          'packagePath',
          'resourceCleanup',
          'repositoryDiff',
          'resultFingerprint'
        ].sort()
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'OES_DELIVERY_LIFECYCLE_CLEANUP_RESULT' ||
    !['REPOSITORY', 'HOST_LOCAL'].includes(value.executionMode) ||
    value.reviewSessionState !== 'TERMINAL' ||
    value.resourceCleanup !== 'VERIFIED' ||
    value.repositoryDiff.length !== 0 ||
    !value.deliveryKey ||
    !value.ownerTaskId ||
    !value.reviewerTaskId ||
    !value.packagePath ||
    !/^[0-9a-f]{64}$/.test(value.terminalPackageFingerprint) ||
    !/^[0-9a-f]{64}$/.test(value.reviewSessionFingerprint)
  )
    fail('DELIVERY_LIFECYCLE_CLEANUP_RESULT_INVALID', reference.path)
  return value
}

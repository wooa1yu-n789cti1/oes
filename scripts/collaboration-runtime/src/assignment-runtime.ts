import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson, objectFingerprint, sha256 } from './canonical.ts'
import { fail } from './errors.ts'
import {
  ASSIGNMENT_CHILD_KINDS,
  DELIVERY_TOPOLOGY_INVALIDATION_CONDITIONS,
  type ActiveChildAssignment,
  type AssignmentResult,
  type AssignmentResultArtifactPayload,
  type AssignmentResultArtifactPayloadInput,
  type AssignmentResultArtifactRootIdentity,
  type AssignmentResultInput,
  type AssignmentResultReceipt,
  type AssignmentRuntimeInitialization,
  type AssignmentRuntimeState,
  type AssignmentWipCeiling,
  type AssignmentWipSnapshot,
  type ChildAssignmentRequest,
  type CompletedSliceBinding,
  type DeliveryOwnerResources,
  type DeliveryTopologyDecision,
  type DeliveryTopologyRequest,
  type DeliveryTopologyRequestInput,
  type DeliveryTopologySibling,
  type DeliveryTopologySiblingInput,
  type DeliveryWipSnapshot,
  type CoordinationWipAuthorityBinding
} from './assignment-runtime.types.ts'

const FINGERPRINT = /^[0-9a-f]{64}$/
const GIT_SHA = /^[0-9a-f]{40}$/
const DELIVERY_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const ACTION = /^[A-Z][A-Z0-9_]*$/
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/
const REPOSITORY_WRITE_RANGE = /^[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*(?:\/\*\*)?$/
const CANONICAL_MAXIMUMS: AssignmentWipCeiling = {
  maxActiveDeliveryOwners: 3,
  maxActiveBoundedHelpersPerDelivery: 3,
  maxActiveReviewVerifiersPerDelivery: 1
}

/** Requires an object to contain exactly the declared runtime fields. */
function requireExactKeys(
  value: unknown,
  allowed: string[],
  field: string
): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('ASSIGNMENT_INVALID_OBJECT', field)
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  const missing = allowed.filter((key) => !(key in value))
  if (extra.length || missing.length)
    fail(
      'ASSIGNMENT_OBJECT_KEYS_MISMATCH',
      `${field}:extra=${extra.sort().join(',')};missing=${missing.sort().join(',')}`
    )
}

/** Requires one non-empty stable identifier token. */
function requireToken(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail('ASSIGNMENT_INVALID_TOKEN', field)
}

/** Requires one lowercase SHA-256 fingerprint. */
function requireFingerprint(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !FINGERPRINT.test(value))
    fail('ASSIGNMENT_INVALID_FINGERPRINT', field)
}

/** Requires one full Git object id. */
function requireGitSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !GIT_SHA.test(value)) fail('ASSIGNMENT_INVALID_GIT_SHA', field)
}

/** Requires one positive integer state version. */
function requireStateVersion(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1) fail('ASSIGNMENT_INVALID_STATE_VERSION', field)
}

/** Requires one delivery or Coordination key. */
function requireDeliveryKey(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !DELIVERY_KEY.test(value))
    fail('ASSIGNMENT_INVALID_DELIVERY_KEY', field)
}

/** Requires one explicit next action without embedding an interpreter payload. */
function requireAction(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !ACTION.test(value)) fail('ASSIGNMENT_INVALID_ACTION', field)
}

/** Requires one normalized absolute artifact path. */
function requireCanonicalAbsolutePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value)
    fail('ASSIGNMENT_RESULT_ARTIFACT_PATH_INVALID', field)
}

/** Returns whether a physical path is a strict descendant of a bound root. */
function isStrictlyWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== '' && !child.startsWith(`..${sep}`) && child !== '..' && !child.startsWith(sep)
}

/** Validates one portable, persisted filesystem object identity. */
function validateResultArtifactRootIdentity(
  value: AssignmentResultArtifactRootIdentity,
  field: string
): AssignmentResultArtifactRootIdentity {
  requireExactKeys(value, ['physicalPath', 'device', 'inode', 'fileType'], field)
  requireCanonicalAbsolutePath(value.physicalPath, `${field}.physicalPath`)
  if (typeof value.device !== 'string' || !UNSIGNED_INTEGER.test(value.device))
    fail('ASSIGNMENT_RESULT_ARTIFACT_ROOT_DEVICE_INVALID', field)
  if (typeof value.inode !== 'string' || !UNSIGNED_INTEGER.test(value.inode))
    fail('ASSIGNMENT_RESULT_ARTIFACT_ROOT_INODE_INVALID', field)
  if (value.fileType !== 'DIRECTORY') fail('ASSIGNMENT_RESULT_ARTIFACT_ROOT_TYPE_INVALID', field)
  return value
}

interface OpenedResultArtifactRoot {
  descriptor: number
  identity: AssignmentResultArtifactRootIdentity
}

/** Opens one configured result root without following a replacement and captures its object identity. */
function openResultArtifactRoot(path: string): OpenedResultArtifactRoot {
  requireCanonicalAbsolutePath(path, 'resultArtifactRoot')
  let descriptor: number
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0)
    )
  } catch {
    fail('ASSIGNMENT_RESULT_ARTIFACT_ROOT_ABSENT', path)
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isDirectory()) fail('ASSIGNMENT_RESULT_ARTIFACT_ROOT_NOT_DIRECTORY', path)
    let physical: string
    let current
    try {
      physical = resolve(realpathSync(path))
      current = lstatSync(path, { bigint: true })
    } catch {
      fail('ASSIGNMENT_RESULT_ARTIFACT_ROOT_IDENTITY_CHANGED', path)
    }
    if (
      physical !== path ||
      !current.isDirectory() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      fail(
        physical !== path
          ? 'ASSIGNMENT_RESULT_ARTIFACT_ROOT_ALIAS'
          : 'ASSIGNMENT_RESULT_ARTIFACT_ROOT_IDENTITY_CHANGED',
        path
      )
    return {
      descriptor,
      identity: {
        physicalPath: physical,
        device: opened.dev.toString(10),
        inode: opened.ino.toString(10),
        fileType: 'DIRECTORY'
      }
    }
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

/** Captures and closes one dispatch-time result-root identity. */
function captureResultArtifactRootIdentity(path: string): AssignmentResultArtifactRootIdentity {
  const opened = openResultArtifactRoot(path)
  try {
    return opened.identity
  } finally {
    closeSync(opened.descriptor)
  }
}

/** Rechecks that the pathname and held descriptor still select the exact bound root object. */
function requireSameResultArtifactRoot(
  path: string,
  opened: OpenedResultArtifactRoot,
  expected: AssignmentResultArtifactRootIdentity
): void {
  let current
  try {
    current = lstatSync(path, { bigint: true })
  } catch {
    fail('ASSIGNMENT_RESULT_ARTIFACT_ROOT_IDENTITY_MISMATCH', path)
  }
  const held = fstatSync(opened.descriptor, { bigint: true })
  const actual = opened.identity
  if (
    canonicalJson(actual) !== canonicalJson(expected) ||
    !current.isDirectory() ||
    current.dev !== held.dev ||
    current.ino !== held.ino ||
    current.dev.toString(10) !== expected.device ||
    current.ino.toString(10) !== expected.inode
  )
    fail('ASSIGNMENT_RESULT_ARTIFACT_ROOT_IDENTITY_MISMATCH', path)
}

/** Normalizes a non-empty unique string list for stable fingerprints. */
function normalizeStrings(values: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0))
    fail('ASSIGNMENT_INVALID_STRING_LIST', field)
  if (values.some((value) => typeof value !== 'string' || value.length === 0))
    fail('ASSIGNMENT_INVALID_STRING_LIST', field)
  const normalized = [...new Set(values as string[])].sort()
  if (normalized.length !== values.length) fail('ASSIGNMENT_DUPLICATE_STRING', field)
  return normalized
}

/** Normalizes one conservative literal repository path or terminal recursive range. */
function normalizeWriteRanges(values: unknown, field: string, allowEmpty = false): string[] {
  const normalized = normalizeStrings(values, field, allowEmpty)
  for (const value of normalized) {
    const segments = value.replace(/\/\*\*$/, '').split('/')
    if (
      !REPOSITORY_WRITE_RANGE.test(value) ||
      segments.some((segment) => ['.', '..'].includes(segment))
    )
      fail('DELIVERY_TOPOLOGY_WRITE_RANGE_INVALID', `${field}:${value}`)
  }
  return normalized
}

/** Validates a configured ceiling against the frozen canonical maxima. */
function validateCeiling(ceiling: AssignmentWipCeiling): AssignmentWipCeiling {
  requireExactKeys(
    ceiling,
    [
      'maxActiveDeliveryOwners',
      'maxActiveBoundedHelpersPerDelivery',
      'maxActiveReviewVerifiersPerDelivery'
    ],
    'ceiling'
  )
  if (
    !Number.isInteger(ceiling.maxActiveDeliveryOwners) ||
    ceiling.maxActiveDeliveryOwners < 1 ||
    ceiling.maxActiveDeliveryOwners > CANONICAL_MAXIMUMS.maxActiveDeliveryOwners ||
    !Number.isInteger(ceiling.maxActiveBoundedHelpersPerDelivery) ||
    ceiling.maxActiveBoundedHelpersPerDelivery < 1 ||
    ceiling.maxActiveBoundedHelpersPerDelivery >
      CANONICAL_MAXIMUMS.maxActiveBoundedHelpersPerDelivery ||
    ceiling.maxActiveReviewVerifiersPerDelivery !== 1
  )
    fail('ASSIGNMENT_WIP_CEILING_INVALID', canonicalJson(ceiling))
  return { ...ceiling }
}

/** Derives the complete WIP snapshot from active assignments only. */
export function deriveAssignmentWip(assignments: ActiveChildAssignment[]): AssignmentWipSnapshot {
  const byDelivery = new Map<string, DeliveryWipSnapshot>()
  let activeDeliveryOwners = 0
  for (const assignment of assignments) {
    if (assignment.childKind === 'DO') {
      activeDeliveryOwners += 1
      continue
    }
    const current = byDelivery.get(assignment.deliveryKey) ?? {
      deliveryKey: assignment.deliveryKey,
      activeBoundedHelpers: 0,
      activeReviewVerifiers: 0
    }
    if (assignment.childKind === 'BOUNDED_HELPER') current.activeBoundedHelpers += 1
    if (assignment.childKind === 'RV') current.activeReviewVerifiers += 1
    byDelivery.set(assignment.deliveryKey, current)
  }
  return {
    activeDeliveryOwners,
    deliveries: [...byDelivery.values()].sort((left, right) =>
      left.deliveryKey.localeCompare(right.deliveryKey)
    )
  }
}

/** Fails before persistence when any derived WIP count exceeds its ceiling. */
function requireWipWithinCeiling(wip: AssignmentWipSnapshot, ceiling: AssignmentWipCeiling): void {
  if (wip.activeDeliveryOwners > ceiling.maxActiveDeliveryOwners)
    fail('ASSIGNMENT_DO_WIP_EXCEEDED', String(wip.activeDeliveryOwners))
  for (const delivery of wip.deliveries) {
    if (delivery.activeBoundedHelpers > ceiling.maxActiveBoundedHelpersPerDelivery)
      fail(
        'ASSIGNMENT_BOUNDED_HELPER_WIP_EXCEEDED',
        `${delivery.deliveryKey}:${delivery.activeBoundedHelpers}`
      )
    if (delivery.activeReviewVerifiers > ceiling.maxActiveReviewVerifiersPerDelivery)
      fail(
        'ASSIGNMENT_RV_WIP_EXCEEDED',
        `${delivery.deliveryKey}:${delivery.activeReviewVerifiers}`
      )
  }
}

/** Returns the one RV identity retained across every candidate generation in a delivery state. */
function stableRvChildTaskId(state: AssignmentRuntimeState): string | null {
  const identities = new Set(
    [
      ...state.activeAssignments,
      ...state.resultTombstones.map((tombstone) => tombstone.assignment)
    ]
      .filter((assignment) => assignment.childKind === 'RV')
      .map((assignment) => assignment.childTaskId)
  )
  if (identities.size > 1) fail('ASSIGNMENT_RV_IDENTITY_CHANGED', state.deliveryKey)
  return identities.values().next().value ?? null
}

/** Verifies one persisted active assignment and its immutable route. */
function validateActiveAssignment(assignment: ActiveChildAssignment): void {
  requireExactKeys(
    assignment,
    [
      'assignmentId',
      'requestFingerprint',
      'parentTaskId',
      'childTaskId',
      'childKind',
      'deliveryKey',
      'transitionId',
      'dispatchStateVersion',
      'expectedTypedResult',
      'nextLegalActionOnResult',
      'scopeFingerprint',
      'resultArtifactRoot',
      'resultArtifactRootIdentity'
    ],
    'activeAssignment'
  )
  requireFingerprint(assignment.assignmentId, 'activeAssignment.assignmentId')
  requireFingerprint(assignment.requestFingerprint, 'activeAssignment.requestFingerprint')
  requireToken(assignment.parentTaskId, 'activeAssignment.directParent')
  requireToken(assignment.childTaskId, 'activeAssignment.childTaskId')
  if (!ASSIGNMENT_CHILD_KINDS.includes(assignment.childKind))
    fail('ASSIGNMENT_CHILD_ROLE_INVALID', String(assignment.childKind))
  requireDeliveryKey(assignment.deliveryKey, 'activeAssignment.deliveryKey')
  requireToken(assignment.transitionId, 'activeAssignment.transitionId')
  requireStateVersion(assignment.dispatchStateVersion, 'activeAssignment.dispatchStateVersion')
  requireToken(assignment.expectedTypedResult, 'activeAssignment.expectedTypedResult')
  requireAction(assignment.nextLegalActionOnResult, 'activeAssignment.nextLegalActionOnResult')
  requireFingerprint(assignment.scopeFingerprint, 'activeAssignment.scopeFingerprint')
  requireCanonicalAbsolutePath(assignment.resultArtifactRoot, 'activeAssignment.resultArtifactRoot')
  validateResultArtifactRootIdentity(
    assignment.resultArtifactRootIdentity,
    'activeAssignment.resultArtifactRootIdentity'
  )
  if (assignment.resultArtifactRootIdentity.physicalPath !== assignment.resultArtifactRoot)
    fail('ASSIGNMENT_RESULT_ARTIFACT_ROOT_PATH_MISMATCH', assignment.resultArtifactRoot)
  const actual = objectFingerprint(assignment as unknown as Record<string, unknown>, 'assignmentId')
  if (actual !== assignment.assignmentId)
    fail('ASSIGNMENT_ID_FINGERPRINT_MISMATCH', assignment.assignmentId)
  const requestFingerprint = objectFingerprint(
    {
      expectedStateVersion: assignment.dispatchStateVersion - 1,
      childTaskId: assignment.childTaskId,
      childKind: assignment.childKind,
      deliveryKey: assignment.deliveryKey,
      expectedTypedResult: assignment.expectedTypedResult,
      nextLegalActionOnResult: assignment.nextLegalActionOnResult,
      scopeFingerprint: assignment.scopeFingerprint,
      resultArtifactRoot: assignment.resultArtifactRoot
    },
    '__none__'
  )
  if (requestFingerprint !== assignment.requestFingerprint)
    fail('ASSIGNMENT_REQUEST_FINGERPRINT_MISMATCH', assignment.assignmentId)
}

/** Rejects self-routes and duplicate active Delivery Ownership before state is trusted. */
function validateActiveOwnerRoutes(state: AssignmentRuntimeState): void {
  if (state.activeAssignments.some((assignment) => assignment.childTaskId === state.owner.taskId))
    fail('ASSIGNMENT_SELF_CHILD_ROUTE', state.owner.taskId)
  const deliveryKeys = state.activeAssignments
    .filter((assignment) => assignment.childKind === 'DO')
    .map((assignment) => assignment.deliveryKey)
  if (new Set(deliveryKeys).size !== deliveryKeys.length)
    fail('ASSIGNMENT_DUPLICATE_ACTIVE_DO', state.coordinationKey)
}

/** Verifies one immutable result receipt retained for transition-local idempotency. */
function validateReceipt(receipt: AssignmentResultReceipt): void {
  requireExactKeys(
    receipt,
    [
      'schemaVersion',
      'kind',
      'assignmentId',
      'resultFingerprint',
      'appliedStateVersion',
      'remainingAssignments',
      'wip',
      'nextLegalAction'
    ],
    'resultReceipt'
  )
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'OES_ASSIGNMENT_RESULT_RECEIPT')
    fail('ASSIGNMENT_RESULT_RECEIPT_INVALID', receipt.kind)
  requireFingerprint(receipt.assignmentId, 'resultReceipt.assignmentId')
  requireFingerprint(receipt.resultFingerprint, 'resultReceipt.resultFingerprint')
  requireStateVersion(receipt.appliedStateVersion, 'resultReceipt.appliedStateVersion')
  if (!Number.isInteger(receipt.remainingAssignments) || receipt.remainingAssignments < 0)
    fail('ASSIGNMENT_RESULT_RECEIPT_INVALID', 'remainingAssignments')
  validateWipSnapshot(receipt.wip, 'resultReceipt.wip')
  requireAction(receipt.nextLegalAction, 'resultReceipt.nextLegalAction')
}

/** Reopens and validates every invariant of a persisted runtime state. */
export function validateAssignmentRuntimeState(
  state: AssignmentRuntimeState
): AssignmentRuntimeState {
  requireExactKeys(
    state,
    [
      'schemaVersion',
      'kind',
      'recordFingerprint',
      'owner',
      'coordinationKey',
      'deliveryKey',
      'transitionId',
      'scopeFingerprint',
      'stateVersion',
      'status',
      'ceiling',
      'activeAssignments',
      'resultTombstones',
      'wip',
      'deliveryTopology',
      'nextLegalAction'
    ],
    'runtimeState'
  )
  if (state.schemaVersion !== 1 || state.kind !== 'OES_ASSIGNMENT_RUNTIME_STATE')
    fail('ASSIGNMENT_STATE_KIND_INVALID', state.kind)
  requireFingerprint(state.recordFingerprint, 'runtimeState.recordFingerprint')
  const stateFingerprint = objectFingerprint(
    state as unknown as Record<string, unknown>,
    'recordFingerprint'
  )
  if (stateFingerprint !== state.recordFingerprint)
    fail('ASSIGNMENT_STATE_FINGERPRINT_MISMATCH', stateFingerprint)
  requireExactKeys(state.owner, ['role', 'taskId', 'parentTaskId'], 'owner')
  if (!['CO', 'DO'].includes(state.owner.role))
    fail('ASSIGNMENT_OWNER_ROLE_INVALID', state.owner.role)
  requireToken(state.owner.taskId, 'owner.taskId')
  requireToken(state.owner.parentTaskId, 'owner.parentTaskId')
  requireDeliveryKey(state.coordinationKey, 'runtimeState.coordinationKey')
  requireDeliveryKey(state.deliveryKey, 'runtimeState.deliveryKey')
  requireToken(state.transitionId, 'runtimeState.transitionId')
  requireFingerprint(state.scopeFingerprint, 'runtimeState.scopeFingerprint')
  requireStateVersion(state.stateVersion, 'runtimeState.stateVersion')
  if (!['ACTIVE', 'WAITING_ON_CHILD', 'DELIVERY_TOPOLOGY_REQUIRED'].includes(state.status))
    fail('ASSIGNMENT_STATE_STATUS_INVALID', state.status)
  validateCeiling(state.ceiling)
  if (!Array.isArray(state.activeAssignments) || !Array.isArray(state.resultTombstones))
    fail('ASSIGNMENT_STATE_COLLECTION_INVALID', 'assignments/results')
  for (const assignment of state.activeAssignments) {
    validateActiveAssignment(assignment)
    if (
      assignment.parentTaskId !== state.owner.taskId ||
      assignment.transitionId !== state.transitionId
    )
      fail('ASSIGNMENT_STATE_ROUTE_MISMATCH', assignment.assignmentId)
    if (
      (state.owner.role === 'CO' && assignment.childKind !== 'DO') ||
      (state.owner.role === 'DO' && assignment.childKind === 'DO')
    )
      fail('ASSIGNMENT_OWNER_CHILD_ROUTE_INVALID', assignment.childKind)
    if (state.owner.role === 'DO' && assignment.deliveryKey !== state.deliveryKey)
      fail('ASSIGNMENT_DO_SCOPE_MISMATCH', assignment.deliveryKey)
    if (assignment.dispatchStateVersion > state.stateVersion)
      fail('ASSIGNMENT_DISPATCH_VERSION_FUTURE', assignment.assignmentId)
  }
  const assignmentIds = state.activeAssignments.map((assignment) => assignment.assignmentId)
  if (new Set(assignmentIds).size !== assignmentIds.length)
    fail('ASSIGNMENT_DUPLICATE_ACTIVE_ID', state.deliveryKey)
  const activeChildren = state.activeAssignments.map((assignment) => assignment.childTaskId)
  if (new Set(activeChildren).size !== activeChildren.length)
    fail('ASSIGNMENT_DUPLICATE_ACTIVE_CHILD', state.deliveryKey)
  const activeRequests = state.activeAssignments.map((assignment) => assignment.requestFingerprint)
  if (new Set(activeRequests).size !== activeRequests.length)
    fail('ASSIGNMENT_DUPLICATE_ACTIVE_REQUEST', state.deliveryKey)
  validateActiveOwnerRoutes(state)
  for (const tombstone of state.resultTombstones) {
    requireExactKeys(tombstone, ['assignment', 'resultFingerprint', 'receipt'], 'resultTombstone')
    validateActiveAssignment(tombstone.assignment)
    if (
      tombstone.assignment.parentTaskId !== state.owner.taskId ||
      tombstone.assignment.transitionId !== state.transitionId ||
      tombstone.assignment.dispatchStateVersion > state.stateVersion
    )
      fail('ASSIGNMENT_TOMBSTONE_ROUTE_MISMATCH', tombstone.assignment.assignmentId)
    if (
      (state.owner.role === 'CO' && tombstone.assignment.childKind !== 'DO') ||
      (state.owner.role === 'DO' &&
        (tombstone.assignment.childKind === 'DO' ||
          tombstone.assignment.deliveryKey !== state.deliveryKey))
    )
      fail('ASSIGNMENT_TOMBSTONE_OWNER_SCOPE_MISMATCH', tombstone.assignment.assignmentId)
    requireFingerprint(tombstone.resultFingerprint, 'resultTombstone.resultFingerprint')
    validateReceipt(tombstone.receipt)
    if (
      tombstone.receipt.assignmentId !== tombstone.assignment.assignmentId ||
      tombstone.receipt.resultFingerprint !== tombstone.resultFingerprint
    )
      fail('ASSIGNMENT_TOMBSTONE_RECEIPT_MISMATCH', tombstone.assignment.assignmentId)
    const receiptWipCount =
      tombstone.receipt.wip.activeDeliveryOwners +
      tombstone.receipt.wip.deliveries.reduce(
        (total, delivery) => total + delivery.activeBoundedHelpers + delivery.activeReviewVerifiers,
        0
      )
    if (receiptWipCount !== tombstone.receipt.remainingAssignments)
      fail('ASSIGNMENT_TOMBSTONE_RECEIPT_WIP_MISMATCH', tombstone.assignment.assignmentId)
    requireWipWithinCeiling(tombstone.receipt.wip, state.ceiling)
    if (
      tombstone.receipt.appliedStateVersion > state.stateVersion ||
      tombstone.receipt.appliedStateVersion <= tombstone.assignment.dispatchStateVersion
    )
      fail('ASSIGNMENT_TOMBSTONE_RECEIPT_FUTURE', tombstone.assignment.assignmentId)
  }
  const completedIds = state.resultTombstones.map((entry) => entry.assignment.assignmentId)
  const completedRequests = state.resultTombstones.map(
    (entry) => entry.assignment.requestFingerprint
  )
  if (
    new Set(completedIds).size !== completedIds.length ||
    completedIds.some((id) => assignmentIds.includes(id))
  )
    fail('ASSIGNMENT_TOMBSTONE_ID_CONFLICT', state.deliveryKey)
  if (new Set(completedRequests).size !== completedRequests.length)
    fail('ASSIGNMENT_TOMBSTONE_REQUEST_CONFLICT', state.deliveryKey)
  if (completedRequests.some((request) => activeRequests.includes(request)))
    fail('ASSIGNMENT_ACTIVE_COMPLETED_REQUEST_CONFLICT', state.deliveryKey)
  stableRvChildTaskId(state)
  if (
    [...assignmentIds].sort().join() !== assignmentIds.join() ||
    [...completedIds].sort().join() !== completedIds.join()
  )
    fail('ASSIGNMENT_STATE_COLLECTION_ORDER_INVALID', state.deliveryKey)
  const derived = deriveAssignmentWip(state.activeAssignments)
  if (canonicalJson(derived) !== canonicalJson(state.wip))
    fail('ASSIGNMENT_WIP_SNAPSHOT_MISMATCH', state.deliveryKey)
  requireWipWithinCeiling(derived, state.ceiling)
  requireAction(state.nextLegalAction, 'runtimeState.nextLegalAction')
  if (state.deliveryTopology !== null) {
    requireExactKeys(
      state.deliveryTopology,
      ['decision', 'requestFingerprint', 'decisionFingerprint'],
      'deliveryTopology'
    )
    if (
      !['DELIVERY_TOPOLOGY_REQUIRED', 'ATOMIC_CONTINUATION'].includes(
        state.deliveryTopology.decision
      )
    )
      fail('DELIVERY_TOPOLOGY_DECISION_INVALID', state.deliveryTopology.decision)
    requireFingerprint(
      state.deliveryTopology.requestFingerprint,
      'deliveryTopology.requestFingerprint'
    )
    requireFingerprint(
      state.deliveryTopology.decisionFingerprint,
      'deliveryTopology.decisionFingerprint'
    )
  }
  const expectedStatus =
    state.deliveryTopology?.decision === 'DELIVERY_TOPOLOGY_REQUIRED'
      ? 'DELIVERY_TOPOLOGY_REQUIRED'
      : state.activeAssignments.length
        ? 'WAITING_ON_CHILD'
        : 'ACTIVE'
  if (state.status !== expectedStatus)
    fail('ASSIGNMENT_STATE_MARKER_MISMATCH', `${state.status}/${expectedStatus}`)
  if (
    state.status === 'DELIVERY_TOPOLOGY_REQUIRED' &&
    ![
      'RETURN_DELIVERY_TOPOLOGY_REQUIRED_TO_OWNER',
      'RETURN_DELIVERY_TOPOLOGY_REQUIRED_TO_DA'
    ].includes(state.nextLegalAction)
  )
    fail('ASSIGNMENT_NEXT_ACTION_STATE_MISMATCH', state.nextLegalAction)
  return state
}

/** Builds one canonical result artifact payload independently of its outer envelope. */
export function createAssignmentResultArtifact(
  input: AssignmentResultArtifactPayloadInput
): AssignmentResultArtifactPayload {
  requireExactKeys(
    input,
    [
      'assignmentId',
      'parentTaskId',
      'childTaskId',
      'transitionId',
      'dispatchStateVersion',
      'typedResult',
      'scopeFingerprint'
    ],
    'assignmentResultArtifactInput'
  )
  const base = {
    schemaVersion: 1 as const,
    kind: 'OES_ASSIGNMENT_RESULT_ARTIFACT' as const,
    ...input
  }
  return validateAssignmentResultArtifact({
    ...base,
    artifactFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  })
}

/** Validates one exact typed result artifact payload and its self-fingerprint. */
export function validateAssignmentResultArtifact(
  artifact: AssignmentResultArtifactPayload
): AssignmentResultArtifactPayload {
  requireExactKeys(
    artifact,
    [
      'schemaVersion',
      'kind',
      'artifactFingerprint',
      'assignmentId',
      'parentTaskId',
      'childTaskId',
      'transitionId',
      'dispatchStateVersion',
      'typedResult',
      'scopeFingerprint'
    ],
    'assignmentResultArtifact'
  )
  if (artifact.schemaVersion !== 1 || artifact.kind !== 'OES_ASSIGNMENT_RESULT_ARTIFACT')
    fail('ASSIGNMENT_RESULT_ARTIFACT_KIND_INVALID', artifact.kind)
  requireFingerprint(artifact.artifactFingerprint, 'assignmentResultArtifact.artifactFingerprint')
  requireFingerprint(artifact.assignmentId, 'assignmentResultArtifact.assignmentId')
  requireToken(artifact.parentTaskId, 'assignmentResultArtifact.parentTaskId')
  requireToken(artifact.childTaskId, 'assignmentResultArtifact.childTaskId')
  requireToken(artifact.transitionId, 'assignmentResultArtifact.transitionId')
  requireStateVersion(
    artifact.dispatchStateVersion,
    'assignmentResultArtifact.dispatchStateVersion'
  )
  requireToken(artifact.typedResult, 'assignmentResultArtifact.typedResult')
  requireFingerprint(artifact.scopeFingerprint, 'assignmentResultArtifact.scopeFingerprint')
  const actual = objectFingerprint(
    artifact as unknown as Record<string, unknown>,
    'artifactFingerprint'
  )
  if (actual !== artifact.artifactFingerprint)
    fail('ASSIGNMENT_RESULT_ARTIFACT_FINGERPRINT_MISMATCH', actual)
  return artifact
}

/** Builds and fingerprints one bounded assignment result envelope. */
export function createAssignmentResult(input: AssignmentResultInput): AssignmentResult {
  requireExactKeys(
    input,
    [
      'assignmentId',
      'parentTaskId',
      'childTaskId',
      'transitionId',
      'dispatchStateVersion',
      'typedResult',
      'resultArtifact'
    ],
    'assignmentResultInput'
  )
  const base = {
    schemaVersion: 1 as const,
    kind: 'OES_ASSIGNMENT_RESULT' as const,
    ...input
  }
  const result = {
    ...base,
    resultFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
  return validateAssignmentResult(result)
}

/** Validates the self-hash and exact fields of one direct child result. */
export function validateAssignmentResult(result: AssignmentResult): AssignmentResult {
  requireExactKeys(
    result,
    [
      'schemaVersion',
      'kind',
      'resultFingerprint',
      'assignmentId',
      'parentTaskId',
      'childTaskId',
      'transitionId',
      'dispatchStateVersion',
      'typedResult',
      'resultArtifact'
    ],
    'assignmentResult'
  )
  if (result.schemaVersion !== 1 || result.kind !== 'OES_ASSIGNMENT_RESULT')
    fail('ASSIGNMENT_RESULT_KIND_INVALID', result.kind)
  requireFingerprint(result.resultFingerprint, 'assignmentResult.resultFingerprint')
  requireFingerprint(result.assignmentId, 'assignmentResult.assignmentId')
  requireToken(result.parentTaskId, 'assignmentResult.directParent')
  requireToken(result.childTaskId, 'assignmentResult.childTaskId')
  requireToken(result.transitionId, 'assignmentResult.transitionId')
  requireStateVersion(result.dispatchStateVersion, 'assignmentResult.dispatchStateVersion')
  requireToken(result.typedResult, 'assignmentResult.typedResult')
  requireExactKeys(result.resultArtifact, ['path', 'sha256', 'fingerprint'], 'resultArtifact')
  requireCanonicalAbsolutePath(result.resultArtifact.path, 'resultArtifact.path')
  requireFingerprint(result.resultArtifact.sha256, 'resultArtifact.sha256')
  requireFingerprint(result.resultArtifact.fingerprint, 'resultArtifact.fingerprint')
  const actual = objectFingerprint(
    result as unknown as Record<string, unknown>,
    'resultFingerprint'
  )
  if (actual !== result.resultFingerprint) fail('ASSIGNMENT_RESULT_FINGERPRINT_MISMATCH', actual)
  return result
}

/** Reopens and authenticates the bound result bytes before an assignment may release WIP. */
function reopenAssignmentResultArtifact(
  assignment: ActiveChildAssignment,
  result: AssignmentResult
): AssignmentResultArtifactPayload {
  const root = openResultArtifactRoot(assignment.resultArtifactRoot)
  let bytes: Buffer
  try {
    requireSameResultArtifactRoot(
      assignment.resultArtifactRoot,
      root,
      assignment.resultArtifactRootIdentity
    )
    const physicalRoot = root.identity.physicalPath
    let physicalPath: string
    try {
      physicalPath = resolve(realpathSync(result.resultArtifact.path))
    } catch {
      fail('ASSIGNMENT_RESULT_ARTIFACT_ABSENT', result.resultArtifact.path)
    }
    if (!isStrictlyWithin(physicalRoot, physicalPath))
      fail('ASSIGNMENT_RESULT_ARTIFACT_OUTSIDE_BOUND_ROOT', physicalPath)
    if (physicalPath !== result.resultArtifact.path)
      fail('ASSIGNMENT_RESULT_ARTIFACT_PHYSICAL_ALIAS', result.resultArtifact.path)
    let descriptor: number
    try {
      descriptor = openSync(
        result.resultArtifact.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      )
    } catch {
      fail('ASSIGNMENT_RESULT_ARTIFACT_REOPEN_FAILED', result.resultArtifact.path)
    }
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile()) fail('ASSIGNMENT_RESULT_ARTIFACT_NOT_FILE', result.resultArtifact.path)
      let reopenedPath: string
      let current
      try {
        reopenedPath = resolve(realpathSync(result.resultArtifact.path))
        current = statSync(result.resultArtifact.path)
      } catch {
        fail('ASSIGNMENT_RESULT_ARTIFACT_IDENTITY_CHANGED', result.resultArtifact.path)
      }
      if (
        reopenedPath !== physicalPath ||
        !isStrictlyWithin(physicalRoot, reopenedPath) ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      )
        fail('ASSIGNMENT_RESULT_ARTIFACT_IDENTITY_CHANGED', result.resultArtifact.path)
      requireSameResultArtifactRoot(
        assignment.resultArtifactRoot,
        root,
        assignment.resultArtifactRootIdentity
      )
      bytes = readFileSync(descriptor)
      requireSameResultArtifactRoot(
        assignment.resultArtifactRoot,
        root,
        assignment.resultArtifactRootIdentity
      )
    } finally {
      closeSync(descriptor)
    }
  } finally {
    closeSync(root.descriptor)
  }
  if (sha256(bytes) !== result.resultArtifact.sha256)
    fail('ASSIGNMENT_RESULT_ARTIFACT_SHA_MISMATCH', result.resultArtifact.path)
  let parsed: AssignmentResultArtifactPayload
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as AssignmentResultArtifactPayload
  } catch {
    fail('ASSIGNMENT_RESULT_ARTIFACT_JSON_INVALID', result.resultArtifact.path)
  }
  const artifact = validateAssignmentResultArtifact(parsed)
  if (bytes.toString('utf8') !== `${canonicalJson(artifact)}\n`)
    fail('ASSIGNMENT_RESULT_ARTIFACT_BYTES_NOT_CANONICAL', result.resultArtifact.path)
  if (artifact.artifactFingerprint !== result.resultArtifact.fingerprint)
    fail('ASSIGNMENT_RESULT_ARTIFACT_REFERENCE_MISMATCH', result.resultArtifact.path)
  const exactBinding = {
    assignmentId: assignment.assignmentId,
    parentTaskId: assignment.parentTaskId,
    childTaskId: assignment.childTaskId,
    transitionId: assignment.transitionId,
    dispatchStateVersion: assignment.dispatchStateVersion,
    typedResult: assignment.expectedTypedResult,
    scopeFingerprint: assignment.scopeFingerprint
  }
  const artifactBinding = {
    assignmentId: artifact.assignmentId,
    parentTaskId: artifact.parentTaskId,
    childTaskId: artifact.childTaskId,
    transitionId: artifact.transitionId,
    dispatchStateVersion: artifact.dispatchStateVersion,
    typedResult: artifact.typedResult,
    scopeFingerprint: artifact.scopeFingerprint
  }
  if (canonicalJson(artifactBinding) !== canonicalJson(exactBinding))
    fail('ASSIGNMENT_RESULT_ARTIFACT_ASSIGNMENT_MISMATCH', assignment.assignmentId)
  const envelopeBinding = {
    assignmentId: result.assignmentId,
    parentTaskId: result.parentTaskId,
    childTaskId: result.childTaskId,
    transitionId: result.transitionId,
    dispatchStateVersion: result.dispatchStateVersion,
    typedResult: result.typedResult
  }
  const artifactEnvelopeBinding = {
    assignmentId: artifact.assignmentId,
    parentTaskId: artifact.parentTaskId,
    childTaskId: artifact.childTaskId,
    transitionId: artifact.transitionId,
    dispatchStateVersion: artifact.dispatchStateVersion,
    typedResult: artifact.typedResult
  }
  if (canonicalJson(artifactEnvelopeBinding) !== canonicalJson(envelopeBinding))
    fail('ASSIGNMENT_RESULT_ARTIFACT_ENVELOPE_MISMATCH', assignment.assignmentId)
  return artifact
}

/** Builds a normalized sibling extraction binding and its scope fingerprint. */
export function createDeliveryTopologySibling(
  input: DeliveryTopologySiblingInput
): DeliveryTopologySibling {
  requireExactKeys(
    input,
    [
      'deliveryKey',
      'objective',
      'scope',
      'protectedScope',
      'writeSet',
      'dependencies',
      'acceptance',
      'requiredCapabilityFingerprint',
      'independenceProof'
    ],
    'deliveryTopologySiblingInput'
  )
  requireDeliveryKey(input.deliveryKey, 'sibling.deliveryKey')
  if (typeof input.objective !== 'string' || input.objective.length === 0)
    fail('DELIVERY_TOPOLOGY_OBJECTIVE_INVALID', input.deliveryKey)
  requireFingerprint(input.requiredCapabilityFingerprint, 'sibling.requiredCapabilityFingerprint')
  requireExactKeys(
    input.independenceProof,
    [
      'independentCandidate',
      'independentReviewVerification',
      'independentPullRequest',
      'safeIndependentMainMerge'
    ],
    'sibling.independenceProof'
  )
  if (Object.values(input.independenceProof).some((value) => typeof value !== 'boolean'))
    fail('DELIVERY_TOPOLOGY_PROOF_INVALID', input.deliveryKey)
  const core = {
    deliveryKey: input.deliveryKey,
    objective: input.objective,
    scope: normalizeStrings(input.scope, 'sibling.scope'),
    protectedScope: normalizeStrings(input.protectedScope, 'sibling.protectedScope'),
    writeSet: normalizeWriteRanges(input.writeSet, 'sibling.writeSet'),
    dependencies: normalizeStrings(input.dependencies, 'sibling.dependencies', true),
    acceptance: normalizeStrings(input.acceptance, 'sibling.acceptance'),
    requiredCapabilityFingerprint: input.requiredCapabilityFingerprint,
    independenceProof: { ...input.independenceProof }
  }
  return {
    ...core,
    scopeFingerprint: objectFingerprint(core as unknown as Record<string, unknown>, '__none__')
  }
}

/** Extracts an exact self-hashed Coordination WIP authority from one validated coordination-owned state. */
export function createCoordinationWipAuthorityBinding(
  coordinationState: AssignmentRuntimeState
): CoordinationWipAuthorityBinding {
  validateAssignmentRuntimeState(coordinationState)
  if (coordinationState.owner.role !== 'CO')
    fail('DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_ROLE_INVALID', coordinationState.owner.role)
  const deliveryAssignments = coordinationState.activeAssignments.filter(
    (assignment) => assignment.childKind === 'DO'
  )
  const activeDeliveryKeys = deliveryAssignments
    .map((assignment) => assignment.deliveryKey)
    .sort((left, right) => left.localeCompare(right))
  if (
    deliveryAssignments.length !== coordinationState.wip.activeDeliveryOwners ||
    new Set(activeDeliveryKeys).size !== activeDeliveryKeys.length
  )
    fail('DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_WIP_INVALID', coordinationState.coordinationKey)
  const base = {
    schemaVersion: 1 as const,
    kind: 'OES_COORDINATION_WIP_AUTHORITY_BINDING' as const,
    coordinationOwnerTaskId: coordinationState.owner.taskId,
    coordinationKey: coordinationState.coordinationKey,
    transitionId: coordinationState.transitionId,
    coordinationStateVersion: coordinationState.stateVersion,
    coordinationStateFingerprint: coordinationState.recordFingerprint,
    activeDeliveryOwners: coordinationState.wip.activeDeliveryOwners,
    activeDeliveryKeys,
    ceiling: { ...coordinationState.ceiling }
  }
  return {
    ...base,
    authorityFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
}

/** Reopens the exact Coordination WIP authority binding and its self-hash. */
function validateCoordinationWipAuthorityBinding(
  authority: CoordinationWipAuthorityBinding
): CoordinationWipAuthorityBinding {
  requireExactKeys(
    authority,
    [
      'schemaVersion',
      'kind',
      'authorityFingerprint',
      'coordinationOwnerTaskId',
      'coordinationKey',
      'transitionId',
      'coordinationStateVersion',
      'coordinationStateFingerprint',
      'activeDeliveryOwners',
      'activeDeliveryKeys',
      'ceiling'
    ],
    'coordinationWipAuthority'
  )
  if (authority.schemaVersion !== 1 || authority.kind !== 'OES_COORDINATION_WIP_AUTHORITY_BINDING')
    fail('DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_KIND_INVALID', authority.kind)
  requireFingerprint(
    authority.authorityFingerprint,
    'coordinationWipAuthority.authorityFingerprint'
  )
  requireToken(
    authority.coordinationOwnerTaskId,
    'coordinationWipAuthority.coordinationOwnerTaskId'
  )
  requireDeliveryKey(authority.coordinationKey, 'coordinationWipAuthority.coordinationKey')
  requireToken(authority.transitionId, 'coordinationWipAuthority.transitionId')
  requireStateVersion(
    authority.coordinationStateVersion,
    'coordinationWipAuthority.coordinationStateVersion'
  )
  requireFingerprint(
    authority.coordinationStateFingerprint,
    'coordinationWipAuthority.coordinationStateFingerprint'
  )
  if (!Number.isInteger(authority.activeDeliveryOwners) || authority.activeDeliveryOwners < 1)
    fail('DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_WIP_INVALID', authority.coordinationKey)
  const activeDeliveryKeys = normalizeStrings(
    authority.activeDeliveryKeys,
    'coordinationWipAuthority.activeDeliveryKeys'
  )
  activeDeliveryKeys.forEach((key) =>
    requireDeliveryKey(key, 'coordinationWipAuthority.activeDeliveryKey')
  )
  if (activeDeliveryKeys.length !== authority.activeDeliveryOwners)
    fail('DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_WIP_INVALID', authority.coordinationKey)
  validateCeiling(authority.ceiling)
  if (authority.activeDeliveryOwners > authority.ceiling.maxActiveDeliveryOwners)
    fail('DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_WIP_INVALID', authority.coordinationKey)
  const actual = objectFingerprint(
    authority as unknown as Record<string, unknown>,
    'authorityFingerprint'
  )
  if (actual !== authority.authorityFingerprint)
    fail('DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_FINGERPRINT_MISMATCH', authority.coordinationKey)
  return authority
}

/** Authenticates one persisted authority against the exact coordination-owned runtime state. */
export function verifyCoordinationWipAuthorityBinding(
  authorityInput: CoordinationWipAuthorityBinding,
  exactCoordinationState: AssignmentRuntimeState
): CoordinationWipAuthorityBinding {
  const authority = validateCoordinationWipAuthorityBinding(authorityInput)
  const expected = createCoordinationWipAuthorityBinding(exactCoordinationState)
  if (canonicalJson(authority) !== canonicalJson(expected))
    fail('DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_NOT_EXACT_STATE', authority.coordinationKey)
  return authority
}

/** Validates one normalized sibling and its complete extraction fingerprint. */
function validateDeliveryTopologySibling(
  sibling: DeliveryTopologySibling
): DeliveryTopologySibling {
  requireExactKeys(
    sibling,
    [
      'deliveryKey',
      'objective',
      'scope',
      'protectedScope',
      'writeSet',
      'dependencies',
      'acceptance',
      'requiredCapabilityFingerprint',
      'independenceProof',
      'scopeFingerprint'
    ],
    'deliveryTopologySibling'
  )
  const { scopeFingerprint, ...input } = sibling
  const recreated = createDeliveryTopologySibling(input)
  requireFingerprint(sibling.scopeFingerprint, 'sibling.scopeFingerprint')
  if (recreated.scopeFingerprint !== scopeFingerprint)
    fail('DELIVERY_TOPOLOGY_SIBLING_FINGERPRINT_MISMATCH', sibling.deliveryKey)
  return sibling
}

/** Validates a WIP snapshot used as an exact topology binding. */
function validateWipSnapshot(wip: AssignmentWipSnapshot, field: string): AssignmentWipSnapshot {
  requireExactKeys(wip, ['activeDeliveryOwners', 'deliveries'], field)
  if (!Number.isInteger(wip.activeDeliveryOwners) || wip.activeDeliveryOwners < 0)
    fail('ASSIGNMENT_WIP_SNAPSHOT_INVALID', `${field}.activeDeliveryOwners`)
  if (!Array.isArray(wip.deliveries)) fail('ASSIGNMENT_WIP_SNAPSHOT_INVALID', `${field}.deliveries`)
  for (const delivery of wip.deliveries) {
    requireExactKeys(
      delivery,
      ['deliveryKey', 'activeBoundedHelpers', 'activeReviewVerifiers'],
      `${field}.delivery`
    )
    requireDeliveryKey(delivery.deliveryKey, `${field}.deliveryKey`)
    if (
      !Number.isInteger(delivery.activeBoundedHelpers) ||
      delivery.activeBoundedHelpers < 0 ||
      !Number.isInteger(delivery.activeReviewVerifiers) ||
      delivery.activeReviewVerifiers < 0
    )
      fail('ASSIGNMENT_WIP_SNAPSHOT_INVALID', delivery.deliveryKey)
  }
  const keys = wip.deliveries.map((delivery) => delivery.deliveryKey)
  if (new Set(keys).size !== keys.length || [...keys].sort().join() !== keys.join())
    fail('ASSIGNMENT_WIP_DELIVERY_ORDER_INVALID', field)
  return wip
}

/** Normalizes one completed-slice evidence binding. */
function normalizeCompletedSlice(slice: CompletedSliceBinding): CompletedSliceBinding {
  requireExactKeys(
    slice,
    ['sliceId', 'commitSha', 'candidateSha', 'evidenceFingerprints'],
    'completedSlice'
  )
  requireToken(slice.sliceId, 'completedSlice.sliceId')
  requireGitSha(slice.commitSha, 'completedSlice.commitSha')
  if (slice.candidateSha !== null) requireGitSha(slice.candidateSha, 'completedSlice.candidateSha')
  const evidenceFingerprints = normalizeStrings(
    slice.evidenceFingerprints,
    'completedSlice.evidenceFingerprints',
    true
  )
  evidenceFingerprints.forEach((value) =>
    requireFingerprint(value, 'completedSlice.evidenceFingerprint')
  )
  return { ...slice, evidenceFingerprints }
}

/** Validates one exact owner resource set without mutating any referenced locator. */
function validateResources(resources: DeliveryOwnerResources): DeliveryOwnerResources {
  requireExactKeys(
    resources,
    ['ownerRef', 'ownerClone', 'taskTemp', 'deliveryPackagePath'],
    'resources'
  )
  for (const [key, value] of Object.entries(resources))
    if (typeof value !== 'string' || value.length === 0)
      fail('DELIVERY_TOPOLOGY_RESOURCE_INVALID', key)
  return { ...resources }
}

/** Builds a complete exact Delivery topology decision request. */
export function createDeliveryTopologyRequest(
  input: DeliveryTopologyRequestInput
): DeliveryTopologyRequest {
  requireExactKeys(
    input,
    [
      'coordinationOwnerTaskId',
      'deliveryOwnerTaskId',
      'coordinationKey',
      'deliveryKey',
      'transitionId',
      'stateVersion',
      'scopeFingerprint',
      'rootAuthorizationFingerprint',
      'coordinationWipAuthority',
      'oldTopology',
      'delegationCeiling',
      'retainedWriteSet',
      'currentResources',
      'completedSlices',
      'proposedSiblings'
    ],
    'deliveryTopologyRequestInput'
  )
  requireToken(input.coordinationOwnerTaskId, 'request.coordinationOwnerTaskId')
  requireToken(input.deliveryOwnerTaskId, 'request.deliveryOwnerTaskId')
  requireDeliveryKey(input.coordinationKey, 'request.coordinationKey')
  requireDeliveryKey(input.deliveryKey, 'request.deliveryKey')
  requireToken(input.transitionId, 'request.transitionId')
  requireStateVersion(input.stateVersion, 'request.stateVersion')
  requireFingerprint(input.scopeFingerprint, 'request.scopeFingerprint')
  requireFingerprint(input.rootAuthorizationFingerprint, 'request.rootAuthorizationFingerprint')
  const coordinationWipAuthority = validateCoordinationWipAuthorityBinding(
    input.coordinationWipAuthority
  )
  const oldTopology = validateWipSnapshot(input.oldTopology, 'request.oldTopology')
  const delegationCeiling = validateCeiling(input.delegationCeiling)
  const retainedWriteSet = normalizeWriteRanges(
    input.retainedWriteSet,
    'request.retainedWriteSet',
    true
  )
  if (
    coordinationWipAuthority.coordinationOwnerTaskId !== input.coordinationOwnerTaskId ||
    coordinationWipAuthority.coordinationKey !== input.coordinationKey ||
    coordinationWipAuthority.transitionId !== input.transitionId ||
    coordinationWipAuthority.activeDeliveryOwners !== oldTopology.activeDeliveryOwners ||
    canonicalJson(coordinationWipAuthority.ceiling) !== canonicalJson(delegationCeiling) ||
    !coordinationWipAuthority.activeDeliveryKeys.includes(input.deliveryKey)
  )
    fail('DELIVERY_TOPOLOGY_COORDINATION_AUTHORITY_MISMATCH', input.deliveryKey)
  requireWipWithinCeiling(oldTopology, delegationCeiling)
  if (oldTopology.activeDeliveryOwners < 1)
    fail('DELIVERY_TOPOLOGY_ORIGINAL_DELIVERY_MISSING', input.deliveryKey)
  const currentResources = validateResources(input.currentResources)
  if (!Array.isArray(input.completedSlices) || !Array.isArray(input.proposedSiblings))
    fail('DELIVERY_TOPOLOGY_COLLECTION_INVALID', input.deliveryKey)
  const completedSlices = input.completedSlices
    .map(normalizeCompletedSlice)
    .sort((left, right) => left.sliceId.localeCompare(right.sliceId))
  const completedIds = completedSlices.map((slice) => slice.sliceId)
  if (new Set(completedIds).size !== completedIds.length)
    fail('DELIVERY_TOPOLOGY_DUPLICATE_SLICE', input.deliveryKey)
  const proposedSiblings = input.proposedSiblings
    .map(validateDeliveryTopologySibling)
    .sort((left, right) => left.deliveryKey.localeCompare(right.deliveryKey))
  const siblingKeys = proposedSiblings.map((sibling) => sibling.deliveryKey)
  if (new Set(siblingKeys).size !== siblingKeys.length || siblingKeys.includes(input.deliveryKey))
    fail('DELIVERY_TOPOLOGY_DUPLICATE_DELIVERY', input.deliveryKey)
  const base = {
    schemaVersion: 1 as const,
    kind: 'OES_DELIVERY_TOPOLOGY_REQUEST' as const,
    coordinationOwnerTaskId: input.coordinationOwnerTaskId,
    deliveryOwnerTaskId: input.deliveryOwnerTaskId,
    coordinationKey: input.coordinationKey,
    deliveryKey: input.deliveryKey,
    transitionId: input.transitionId,
    stateVersion: input.stateVersion,
    scopeFingerprint: input.scopeFingerprint,
    rootAuthorizationFingerprint: input.rootAuthorizationFingerprint,
    coordinationWipAuthority,
    oldTopology,
    delegationCeiling,
    retainedWriteSet,
    currentResources,
    completedSlices,
    proposedSiblings,
    invalidationConditions: [...DELIVERY_TOPOLOGY_INVALIDATION_CONDITIONS]
  }
  return {
    ...base,
    requestFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
}

/** Recomputes every nested fingerprint of one persisted replan request. */
export function validateDeliveryTopologyRequest(
  request: DeliveryTopologyRequest
): DeliveryTopologyRequest {
  requireExactKeys(
    request,
    [
      'schemaVersion',
      'kind',
      'requestFingerprint',
      'coordinationOwnerTaskId',
      'deliveryOwnerTaskId',
      'coordinationKey',
      'deliveryKey',
      'transitionId',
      'stateVersion',
      'scopeFingerprint',
      'rootAuthorizationFingerprint',
      'coordinationWipAuthority',
      'oldTopology',
      'delegationCeiling',
      'retainedWriteSet',
      'currentResources',
      'completedSlices',
      'proposedSiblings',
      'invalidationConditions'
    ],
    'deliveryTopologyRequest'
  )
  if (request.schemaVersion !== 1 || request.kind !== 'OES_DELIVERY_TOPOLOGY_REQUEST')
    fail('DELIVERY_TOPOLOGY_REQUEST_KIND_INVALID', request.kind)
  requireFingerprint(request.requestFingerprint, 'request.requestFingerprint')
  if (
    canonicalJson(request.invalidationConditions) !==
    canonicalJson(DELIVERY_TOPOLOGY_INVALIDATION_CONDITIONS)
  )
    fail('DELIVERY_TOPOLOGY_INVALIDATION_SET_MISMATCH', request.deliveryKey)
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    requestFingerprint: _requestFingerprint,
    invalidationConditions: _invalidationConditions,
    ...input
  } = request
  const recreated = createDeliveryTopologyRequest(input)
  if (recreated.requestFingerprint !== request.requestFingerprint)
    fail('DELIVERY_TOPOLOGY_REQUEST_FINGERPRINT_MISMATCH', request.deliveryKey)
  return request
}

/** Maps one write expression to a conservative repository range root. */
function writeRangeRoot(value: string): string {
  return value.replace(/\/\*\*$/, '')
}

/** Returns whether two sibling write ranges can select a common path. */
function writeRangesOverlap(left: string, right: string): boolean {
  const a = writeRangeRoot(left)
  const b = writeRangeRoot(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/** Produces the bounded automatic replan or atomic-continuation decision. */
export function decideDeliveryTopology(
  request: DeliveryTopologyRequest,
  exactCoordinationState: AssignmentRuntimeState
): DeliveryTopologyDecision {
  validateDeliveryTopologyRequest(request)
  verifyCoordinationWipAuthorityBinding(request.coordinationWipAuthority, exactCoordinationState)
  const independent =
    request.proposedSiblings.length > 0 &&
    request.proposedSiblings.every((sibling) =>
      Object.values(sibling.independenceProof).every((value) => value === true)
    )
  if (independent) {
    const newActiveDeliveryOwners =
      request.oldTopology.activeDeliveryOwners + request.proposedSiblings.length
    if (newActiveDeliveryOwners > request.delegationCeiling.maxActiveDeliveryOwners)
      fail('DELIVERY_TOPOLOGY_WIP_CEILING_EXCEEDED', String(newActiveDeliveryOwners))
    for (let left = 0; left < request.proposedSiblings.length; left += 1)
      for (let right = left + 1; right < request.proposedSiblings.length; right += 1)
        if (
          request.proposedSiblings[left].writeSet.some((a) =>
            request.proposedSiblings[right].writeSet.some((b) => writeRangesOverlap(a, b))
          )
        )
          fail(
            'DELIVERY_TOPOLOGY_WRITE_SET_CONFLICT',
            `${request.proposedSiblings[left].deliveryKey}/${request.proposedSiblings[right].deliveryKey}`
          )
    for (const sibling of request.proposedSiblings)
      if (
        sibling.writeSet.some((extracted) =>
          request.retainedWriteSet.some((retained) => writeRangesOverlap(extracted, retained))
        )
      )
        fail('DELIVERY_TOPOLOGY_RETAINED_WRITE_SET_CONFLICT', sibling.deliveryKey)
  }
  const base = {
    schemaVersion: 1 as const,
    kind: 'OES_DELIVERY_TOPOLOGY_DECISION' as const,
    decision: independent
      ? ('DELIVERY_TOPOLOGY_REQUIRED' as const)
      : ('ATOMIC_CONTINUATION' as const),
    request,
    newTopology: {
      activeDeliveryOwners:
        request.oldTopology.activeDeliveryOwners +
        (independent ? request.proposedSiblings.length : 0),
      deliveries: request.oldTopology.deliveries.map((delivery) => ({ ...delivery }))
    },
    nextLegalAction: independent
      ? ('RETURN_DELIVERY_TOPOLOGY_REQUIRED_TO_DA' as const)
      : ('CONTINUE_ORIGINAL_DELIVERY_WITH_BOUNDED_HELPERS' as const),
    reason: independent
      ? 'all sibling deliveries are independently candidateable, reviewable, publishable, safely mergeable, and within the frozen ceiling'
      : 'the current slices remain one atomic delivery under the original Delivery Owner'
  }
  return {
    ...base,
    decisionFingerprint: objectFingerprint(base as unknown as Record<string, unknown>, '__none__')
  }
}

/** Revalidates one decision against the exact current request binding. */
export function validateDeliveryTopologyDecision(
  decision: DeliveryTopologyDecision,
  currentRequest: DeliveryTopologyRequest,
  exactCoordinationState: AssignmentRuntimeState
): DeliveryTopologyDecision {
  requireExactKeys(
    decision,
    [
      'schemaVersion',
      'kind',
      'decisionFingerprint',
      'decision',
      'request',
      'newTopology',
      'nextLegalAction',
      'reason'
    ],
    'deliveryTopologyDecision'
  )
  if (decision.schemaVersion !== 1 || decision.kind !== 'OES_DELIVERY_TOPOLOGY_DECISION')
    fail('DELIVERY_TOPOLOGY_DECISION_KIND_INVALID', decision.kind)
  requireFingerprint(decision.decisionFingerprint, 'decision.decisionFingerprint')
  validateDeliveryTopologyRequest(decision.request)
  validateDeliveryTopologyRequest(currentRequest)
  if (decision.request.requestFingerprint !== currentRequest.requestFingerprint)
    fail('DELIVERY_TOPOLOGY_DECISION_INVALIDATED', currentRequest.requestFingerprint)
  const recreated = decideDeliveryTopology(decision.request, exactCoordinationState)
  if (
    recreated.decisionFingerprint !== decision.decisionFingerprint ||
    canonicalJson(recreated) !== canonicalJson(decision)
  )
    fail('DELIVERY_TOPOLOGY_DECISION_FINGERPRINT_MISMATCH', decision.decisionFingerprint)
  return decision
}

/** Owns one exact persisted assignment state; it never discovers other owners. */
export class AssignmentRuntimeStore {
  readonly artifactRoot: string
  readonly deliveryKey: string
  readonly statePath: string

  constructor(artifactRoot: string, deliveryKey: string) {
    requireDeliveryKey(deliveryKey, 'store.deliveryKey')
    this.artifactRoot = resolve(artifactRoot)
    this.deliveryKey = deliveryKey
    this.statePath = join(this.artifactRoot, 'assignment-runtime', `${deliveryKey}.sqlite`)
  }

  /** Initializes one immutable owner binding or idempotently reopens the exact existing state. */
  initialize(input: AssignmentRuntimeInitialization): AssignmentRuntimeState {
    this.validateInitialization(input)
    return this.withWriteTransaction((database) => {
      const existing = this.selectState(database)
      if (existing) {
        const immutable = {
          owner: existing.owner,
          coordinationKey: existing.coordinationKey,
          deliveryKey: existing.deliveryKey,
          transitionId: existing.transitionId,
          scopeFingerprint: existing.scopeFingerprint,
          ceiling: existing.ceiling
        }
        const requested = {
          owner: input.owner,
          coordinationKey: input.coordinationKey,
          deliveryKey: input.deliveryKey,
          transitionId: input.transitionId,
          scopeFingerprint: input.scopeFingerprint,
          ceiling: input.ceiling
        }
        if (canonicalJson(immutable) !== canonicalJson(requested))
          fail('ASSIGNMENT_STATE_BINDING_CONFLICT', this.statePath)
        return existing
      }
      const state = this.persistState(
        database,
        {
          schemaVersion: 1,
          kind: 'OES_ASSIGNMENT_RUNTIME_STATE',
          recordFingerprint: '',
          owner: { ...input.owner },
          coordinationKey: input.coordinationKey,
          deliveryKey: input.deliveryKey,
          transitionId: input.transitionId,
          scopeFingerprint: input.scopeFingerprint,
          stateVersion: 1,
          status: 'ACTIVE',
          ceiling: { ...input.ceiling },
          activeAssignments: [],
          resultTombstones: [],
          wip: { activeDeliveryOwners: 0, deliveries: [] },
          deliveryTopology: null,
          nextLegalAction: input.nextLegalAction
        },
        null
      )
      return state
    })
  }

  /** Loads the exact current state after fingerprint and invariant validation. */
  load(): AssignmentRuntimeState {
    if (!existsSync(this.statePath)) fail('ASSIGNMENT_STATE_NOT_FOUND', this.statePath)
    const database = this.openDatabase()
    try {
      const state = this.selectState(database)
      if (!state) fail('ASSIGNMENT_STATE_NOT_FOUND', this.statePath)
      return state
    } finally {
      database.close()
    }
  }

  /** Persists one child assignment with a state-version CAS and WIP enforcement. */
  dispatchChild(request: ChildAssignmentRequest): AssignmentRuntimeState {
    this.validateChildRequest(request)
    const requestFingerprint = objectFingerprint(
      request as unknown as Record<string, unknown>,
      '__none__'
    )
    return this.withWriteTransaction((database) => {
      const state = this.requireSelectedState(database)
      if (
        state.activeAssignments.some(
          (assignment) => assignment.requestFingerprint === requestFingerprint
        ) ||
        state.resultTombstones.some(
          (tombstone) => tombstone.assignment.requestFingerprint === requestFingerprint
        )
      )
        return state
      if (state.stateVersion !== request.expectedStateVersion)
        fail(
          'ASSIGNMENT_STATE_VERSION_MISMATCH',
          `${request.expectedStateVersion}/${state.stateVersion}`
        )
      if (state.status === 'DELIVERY_TOPOLOGY_REQUIRED')
        fail('ASSIGNMENT_DISPATCH_AFTER_DELIVERY_TOPOLOGY', request.childTaskId)
      if (
        (state.owner.role === 'CO' && request.childKind !== 'DO') ||
        (state.owner.role === 'DO' && request.childKind === 'DO')
      )
        fail('ASSIGNMENT_OWNER_CHILD_ROUTE_INVALID', request.childKind)
      if (state.owner.role === 'DO' && request.deliveryKey !== state.deliveryKey)
        fail('ASSIGNMENT_DO_SCOPE_MISMATCH', request.deliveryKey)
      if (
        state.activeAssignments.some((assignment) => assignment.childTaskId === request.childTaskId)
      )
        fail('ASSIGNMENT_CHILD_ALREADY_ACTIVE', request.childTaskId)
      if (request.childTaskId === state.owner.taskId)
        fail('ASSIGNMENT_SELF_CHILD_ROUTE', request.childTaskId)
      if (
        request.childKind === 'RV' &&
        state.activeAssignments.some(
          (assignment) =>
            assignment.childKind === 'RV' && assignment.deliveryKey === request.deliveryKey
        )
      )
        fail('ASSIGNMENT_RV_WIP_EXCEEDED', request.deliveryKey)
      const boundRvChildTaskId = stableRvChildTaskId(state)
      if (
        request.childKind === 'RV' &&
        boundRvChildTaskId !== null &&
        request.childTaskId !== boundRvChildTaskId
      )
        fail('ASSIGNMENT_RV_IDENTITY_CHANGED', boundRvChildTaskId)
      if (
        request.childKind === 'DO' &&
        state.activeAssignments.some(
          (assignment) =>
            assignment.childKind === 'DO' && assignment.deliveryKey === request.deliveryKey
        )
      )
        fail('ASSIGNMENT_DUPLICATE_ACTIVE_DO', request.deliveryKey)
      const dispatchStateVersion = state.stateVersion + 1
      const resultArtifactRootIdentity = captureResultArtifactRootIdentity(
        request.resultArtifactRoot
      )
      const base = {
        requestFingerprint,
        parentTaskId: state.owner.taskId,
        childTaskId: request.childTaskId,
        childKind: request.childKind,
        deliveryKey: request.deliveryKey,
        transitionId: state.transitionId,
        dispatchStateVersion,
        expectedTypedResult: request.expectedTypedResult,
        nextLegalActionOnResult: request.nextLegalActionOnResult,
        scopeFingerprint: request.scopeFingerprint,
        resultArtifactRoot: request.resultArtifactRoot,
        resultArtifactRootIdentity
      }
      const assignment: ActiveChildAssignment = {
        assignmentId: objectFingerprint(base as unknown as Record<string, unknown>, '__none__'),
        ...base
      }
      const activeAssignments = [...state.activeAssignments, assignment].sort((left, right) =>
        left.assignmentId.localeCompare(right.assignmentId)
      )
      const wip = deriveAssignmentWip(activeAssignments)
      requireWipWithinCeiling(wip, state.ceiling)
      return this.persistState(
        database,
        {
          ...state,
          stateVersion: dispatchStateVersion,
          status: 'WAITING_ON_CHILD',
          activeAssignments,
          wip,
          deliveryTopology: null,
          nextLegalAction: 'CONSUME_DIRECT_ASSIGNMENT_RESULT'
        },
        state.stateVersion
      )
    })
  }

  /** Applies an exact direct child result once and returns the stable original receipt on replay. */
  consumeResult(input: AssignmentResult): AssignmentResultReceipt {
    const result = validateAssignmentResult(input)
    return this.withWriteTransaction((database) => {
      const state = this.requireSelectedState(database)
      const completed = state.resultTombstones.find(
        (tombstone) => tombstone.assignment.assignmentId === result.assignmentId
      )
      if (completed) {
        if (completed.resultFingerprint !== result.resultFingerprint)
          fail('ASSIGNMENT_RESULT_CONFLICT', result.assignmentId)
        return completed.receipt
      }
      const assignment = state.activeAssignments.find(
        (candidate) => candidate.assignmentId === result.assignmentId
      )
      if (!assignment) fail('ASSIGNMENT_RESULT_STALE_OR_UNKNOWN', result.assignmentId)
      if (result.parentTaskId !== state.owner.taskId)
        fail('ASSIGNMENT_RESULT_WRONG_PARENT', result.parentTaskId)
      if (result.childTaskId !== assignment.childTaskId)
        fail('ASSIGNMENT_RESULT_WRONG_CHILD', result.childTaskId)
      if (result.transitionId !== state.transitionId)
        fail('ASSIGNMENT_RESULT_WRONG_TRANSITION', result.transitionId)
      if (result.dispatchStateVersion !== assignment.dispatchStateVersion)
        fail('ASSIGNMENT_RESULT_STALE_STATE', String(result.dispatchStateVersion))
      if (result.typedResult !== assignment.expectedTypedResult)
        fail('ASSIGNMENT_RESULT_UNEXPECTED_TYPE', result.typedResult)
      reopenAssignmentResultArtifact(assignment, result)
      const activeAssignments = state.activeAssignments.filter(
        (candidate) => candidate.assignmentId !== assignment.assignmentId
      )
      const wip = deriveAssignmentWip(activeAssignments)
      requireWipWithinCeiling(wip, state.ceiling)
      const appliedStateVersion = state.stateVersion + 1
      const receipt: AssignmentResultReceipt = {
        schemaVersion: 1,
        kind: 'OES_ASSIGNMENT_RESULT_RECEIPT',
        assignmentId: assignment.assignmentId,
        resultFingerprint: result.resultFingerprint,
        appliedStateVersion,
        remainingAssignments: activeAssignments.length,
        wip,
        nextLegalAction: assignment.nextLegalActionOnResult
      }
      const resultTombstones = [
        ...state.resultTombstones,
        {
          assignment,
          resultFingerprint: result.resultFingerprint,
          receipt
        }
      ].sort((left, right) =>
        left.assignment.assignmentId.localeCompare(right.assignment.assignmentId)
      )
      const replanInvalidated = state.deliveryTopology !== null
      this.persistState(
        database,
        {
          ...state,
          stateVersion: appliedStateVersion,
          status: activeAssignments.length ? 'WAITING_ON_CHILD' : 'ACTIVE',
          activeAssignments,
          resultTombstones,
          wip,
          deliveryTopology: null,
          nextLegalAction: replanInvalidated
            ? 'REEVALUATE_DELIVERY_TOPOLOGY'
            : activeAssignments.length
              ? 'CONSUME_DIRECT_ASSIGNMENT_RESULT'
              : assignment.nextLegalActionOnResult
        },
        state.stateVersion
      )
      return receipt
    })
  }

  /** Evaluates and persists one exact bounded topology decision for this Delivery Owner. */
  recordDeliveryTopologyDecision(
    request: DeliveryTopologyRequest,
    exactCoordinationState: AssignmentRuntimeState
  ): DeliveryTopologyDecision {
    const decision = decideDeliveryTopology(request, exactCoordinationState)
    return this.withWriteTransaction((database) => {
      const state = this.requireSelectedState(database)
      if (
        state.deliveryTopology?.decisionFingerprint === decision.decisionFingerprint &&
        state.stateVersion === request.stateVersion + 1
      )
        return decision
      if (state.deliveryTopology?.decision === 'DELIVERY_TOPOLOGY_REQUIRED')
        fail('DELIVERY_TOPOLOGY_ALREADY_RECORDED', state.deliveryTopology.decisionFingerprint)
      if (state.owner.role !== 'DO') fail('DELIVERY_TOPOLOGY_OWNER_ROLE_INVALID', state.owner.role)
      if (
        request.deliveryOwnerTaskId !== state.owner.taskId ||
        request.coordinationOwnerTaskId !== state.owner.parentTaskId
      )
        fail('DELIVERY_TOPOLOGY_ROUTE_MISMATCH', request.deliveryOwnerTaskId)
      if (
        request.coordinationKey !== state.coordinationKey ||
        request.deliveryKey !== state.deliveryKey ||
        request.transitionId !== state.transitionId ||
        request.scopeFingerprint !== state.scopeFingerprint
      )
        fail('DELIVERY_TOPOLOGY_BINDING_MISMATCH', request.requestFingerprint)
      if (request.stateVersion !== state.stateVersion)
        fail('DELIVERY_TOPOLOGY_STATE_VERSION_MISMATCH', String(request.stateVersion))
      if (canonicalJson(request.delegationCeiling) !== canonicalJson(state.ceiling))
        fail('DELIVERY_TOPOLOGY_CEILING_MISMATCH', request.deliveryKey)
      const storedDelivery = state.wip.deliveries.find(
        (delivery) => delivery.deliveryKey === state.deliveryKey
      ) ?? {
        deliveryKey: state.deliveryKey,
        activeBoundedHelpers: 0,
        activeReviewVerifiers: 0
      }
      const requestedDelivery = request.oldTopology.deliveries.find(
        (delivery) => delivery.deliveryKey === state.deliveryKey
      ) ?? {
        deliveryKey: state.deliveryKey,
        activeBoundedHelpers: 0,
        activeReviewVerifiers: 0
      }
      if (canonicalJson(storedDelivery) !== canonicalJson(requestedDelivery))
        fail('DELIVERY_TOPOLOGY_TOPOLOGY_MISMATCH', request.deliveryKey)
      const deliveryTopology = {
        decision: decision.decision,
        requestFingerprint: request.requestFingerprint,
        decisionFingerprint: decision.decisionFingerprint
      }
      const waiting = state.activeAssignments.length > 0
      this.persistState(
        database,
        {
          ...state,
          stateVersion: state.stateVersion + 1,
          status:
            decision.decision === 'DELIVERY_TOPOLOGY_REQUIRED'
              ? 'DELIVERY_TOPOLOGY_REQUIRED'
              : waiting
                ? 'WAITING_ON_CHILD'
                : 'ACTIVE',
          deliveryTopology,
          nextLegalAction:
            decision.decision === 'DELIVERY_TOPOLOGY_REQUIRED'
              ? decision.nextLegalAction
              : waiting
                ? 'CONSUME_DIRECT_ASSIGNMENT_RESULT'
                : decision.nextLegalAction
        },
        state.stateVersion
      )
      return decision
    })
  }

  /** Validates immutable initialization values before creating any state bytes. */
  private validateInitialization(input: AssignmentRuntimeInitialization): void {
    requireExactKeys(
      input,
      [
        'owner',
        'coordinationKey',
        'deliveryKey',
        'transitionId',
        'scopeFingerprint',
        'ceiling',
        'nextLegalAction'
      ],
      'initialization'
    )
    requireExactKeys(input.owner, ['role', 'taskId', 'parentTaskId'], 'owner')
    if (!['CO', 'DO'].includes(input.owner.role))
      fail('ASSIGNMENT_OWNER_ROLE_INVALID', input.owner.role)
    requireToken(input.owner.taskId, 'owner.taskId')
    requireToken(input.owner.parentTaskId, 'owner.parentTaskId')
    requireDeliveryKey(input.coordinationKey, 'initialization.coordinationKey')
    requireDeliveryKey(input.deliveryKey, 'initialization.deliveryKey')
    if (input.deliveryKey !== this.deliveryKey)
      fail('ASSIGNMENT_STORE_DELIVERY_MISMATCH', input.deliveryKey)
    requireToken(input.transitionId, 'initialization.transitionId')
    requireFingerprint(input.scopeFingerprint, 'initialization.scopeFingerprint')
    validateCeiling(input.ceiling)
    requireAction(input.nextLegalAction, 'initialization.nextLegalAction')
  }

  /** Validates an exact dispatch request before taking the state lock. */
  private validateChildRequest(request: ChildAssignmentRequest): void {
    requireExactKeys(
      request,
      [
        'expectedStateVersion',
        'childTaskId',
        'childKind',
        'deliveryKey',
        'expectedTypedResult',
        'nextLegalActionOnResult',
        'scopeFingerprint',
        'resultArtifactRoot'
      ],
      'childAssignmentRequest'
    )
    requireStateVersion(request.expectedStateVersion, 'request.expectedStateVersion')
    requireToken(request.childTaskId, 'request.childTaskId')
    if (!ASSIGNMENT_CHILD_KINDS.includes(request.childKind))
      fail('ASSIGNMENT_CHILD_ROLE_INVALID', request.childKind)
    requireDeliveryKey(request.deliveryKey, 'request.deliveryKey')
    requireToken(request.expectedTypedResult, 'request.expectedTypedResult')
    requireAction(request.nextLegalActionOnResult, 'request.nextLegalActionOnResult')
    requireFingerprint(request.scopeFingerprint, 'request.scopeFingerprint')
    requireCanonicalAbsolutePath(request.resultArtifactRoot, 'request.resultArtifactRoot')
  }

  /** Opens the single task-owned SQLite state file with immediate contention failure. */
  private openDatabase(): DatabaseSync {
    mkdirSync(dirname(this.statePath), { recursive: true })
    const database = new DatabaseSync(this.statePath)
    database.exec('PRAGMA busy_timeout = 0')
    return database
  }

  /** Runs one crash-safe SQLite mutation transaction without background retry. */
  private withWriteTransaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.openDatabase()
    let transactionActive = false
    try {
      database.exec('BEGIN IMMEDIATE')
      transactionActive = true
      database.exec(
        'CREATE TABLE IF NOT EXISTS assignment_runtime_state (' +
          'delivery_key TEXT PRIMARY KEY NOT NULL, ' +
          'state_version INTEGER NOT NULL, ' +
          'record_json TEXT NOT NULL)'
      )
      const result = operation(database)
      database.exec('COMMIT')
      transactionActive = false
      return result
    } catch (error) {
      if (transactionActive)
        try {
          database.exec('ROLLBACK')
        } catch {}
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const message = error instanceof Error ? error.message : String(error)
      if (code.includes('BUSY') || /database is locked/i.test(message))
        fail('ASSIGNMENT_STATE_BUSY', this.statePath)
      throw error
    } finally {
      database.close()
    }
  }

  /** Selects and validates the one exact delivery row from the task-owned database. */
  private selectState(database: DatabaseSync): AssignmentRuntimeState | null {
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assignment_runtime_state'"
      )
      .get() as { name: string } | undefined
    if (!table) return null
    const row = database
      .prepare(
        'SELECT state_version AS stateVersion, record_json AS recordJson ' +
          'FROM assignment_runtime_state WHERE delivery_key = ?'
      )
      .get(this.deliveryKey) as { stateVersion: number; recordJson: string } | undefined
    if (!row) return null
    const state = validateAssignmentRuntimeState(
      JSON.parse(row.recordJson) as AssignmentRuntimeState
    )
    if (state.deliveryKey !== this.deliveryKey || state.stateVersion !== row.stateVersion)
      fail('ASSIGNMENT_SQLITE_ROW_BINDING_MISMATCH', this.deliveryKey)
    return state
  }

  /** Requires the initialized exact delivery row inside a mutation transaction. */
  private requireSelectedState(database: DatabaseSync): AssignmentRuntimeState {
    const state = this.selectState(database)
    if (!state) fail('ASSIGNMENT_STATE_NOT_FOUND', this.statePath)
    return state
  }

  /** Normalizes, fingerprints, compare-and-swaps, and reopens one current state row. */
  private persistState(
    database: DatabaseSync,
    state: AssignmentRuntimeState,
    expectedPreviousStateVersion: number | null
  ): AssignmentRuntimeState {
    const normalized: AssignmentRuntimeState = {
      ...state,
      activeAssignments: [...state.activeAssignments].sort((left, right) =>
        left.assignmentId.localeCompare(right.assignmentId)
      ),
      resultTombstones: [...state.resultTombstones].sort((left, right) =>
        left.assignment.assignmentId.localeCompare(right.assignment.assignmentId)
      ),
      wip: deriveAssignmentWip(state.activeAssignments),
      recordFingerprint: ''
    }
    normalized.recordFingerprint = objectFingerprint(
      normalized as unknown as Record<string, unknown>,
      'recordFingerprint'
    )
    validateAssignmentRuntimeState(normalized)
    const recordJson = canonicalJson(normalized)
    const result =
      expectedPreviousStateVersion === null
        ? database
            .prepare(
              'INSERT INTO assignment_runtime_state(delivery_key, state_version, record_json) ' +
                'VALUES (?, ?, ?)'
            )
            .run(this.deliveryKey, normalized.stateVersion, recordJson)
        : database
            .prepare(
              'UPDATE assignment_runtime_state SET state_version = ?, record_json = ? ' +
                'WHERE delivery_key = ? AND state_version = ?'
            )
            .run(
              normalized.stateVersion,
              recordJson,
              this.deliveryKey,
              expectedPreviousStateVersion
            )
    if (Number(result.changes) !== 1) fail('ASSIGNMENT_STATE_VERSION_CAS_FAILED', this.deliveryKey)
    const reopened = this.requireSelectedState(database)
    if (canonicalJson(reopened) !== canonicalJson(normalized))
      fail('ASSIGNMENT_STATE_TRANSACTION_READBACK_MISMATCH', this.statePath)
    return reopened
  }
}

export const ASSIGNMENT_CHILD_KINDS = ['DO', 'BOUNDED_HELPER', 'RV'] as const
export type AssignmentChildKind = (typeof ASSIGNMENT_CHILD_KINDS)[number]

export type AssignmentOwnerRole = 'CO' | 'DO'

export interface AssignmentOwnerBinding {
  role: AssignmentOwnerRole
  taskId: string
  parentTaskId: string
}

export interface AssignmentWipCeiling {
  maxActiveDeliveryOwners: number
  maxActiveBoundedHelpersPerDelivery: number
  maxActiveReviewVerifiersPerDelivery: 1
}

export interface DeliveryWipSnapshot {
  deliveryKey: string
  activeBoundedHelpers: number
  activeReviewVerifiers: number
}

export interface AssignmentWipSnapshot {
  activeDeliveryOwners: number
  deliveries: DeliveryWipSnapshot[]
}

export interface CoordinationWipAuthorityBinding {
  schemaVersion: 1
  kind: 'OES_COORDINATION_WIP_AUTHORITY_BINDING'
  authorityFingerprint: string
  coordinationOwnerTaskId: string
  coordinationKey: string
  transitionId: string
  coordinationStateVersion: number
  coordinationStateFingerprint: string
  activeDeliveryOwners: number
  activeDeliveryKeys: string[]
  ceiling: AssignmentWipCeiling
}

export interface AssignmentRuntimeInitialization {
  owner: AssignmentOwnerBinding
  coordinationKey: string
  deliveryKey: string
  transitionId: string
  scopeFingerprint: string
  ceiling: AssignmentWipCeiling
  nextLegalAction: string
}

export interface ChildAssignmentRequest {
  expectedStateVersion: number
  childTaskId: string
  childKind: AssignmentChildKind
  deliveryKey: string
  expectedTypedResult: string
  nextLegalActionOnResult: string
  scopeFingerprint: string
  resultArtifactRoot: string
}

export interface AssignmentResultArtifactRootIdentity {
  physicalPath: string
  device: string
  inode: string
  fileType: 'DIRECTORY'
}

export interface ActiveChildAssignment {
  assignmentId: string
  requestFingerprint: string
  parentTaskId: string
  childTaskId: string
  childKind: AssignmentChildKind
  deliveryKey: string
  transitionId: string
  dispatchStateVersion: number
  expectedTypedResult: string
  nextLegalActionOnResult: string
  scopeFingerprint: string
  resultArtifactRoot: string
  resultArtifactRootIdentity: AssignmentResultArtifactRootIdentity
}

export interface AssignmentResultArtifact {
  path: string
  sha256: string
  fingerprint: string
}

export interface AssignmentResultArtifactPayloadInput {
  assignmentId: string
  parentTaskId: string
  childTaskId: string
  transitionId: string
  dispatchStateVersion: number
  typedResult: string
  scopeFingerprint: string
}

export interface AssignmentResultArtifactPayload extends AssignmentResultArtifactPayloadInput {
  schemaVersion: 1
  kind: 'OES_ASSIGNMENT_RESULT_ARTIFACT'
  artifactFingerprint: string
}

export interface AssignmentResultInput {
  assignmentId: string
  parentTaskId: string
  childTaskId: string
  transitionId: string
  dispatchStateVersion: number
  typedResult: string
  resultArtifact: AssignmentResultArtifact
}

export interface AssignmentResult extends AssignmentResultInput {
  schemaVersion: 1
  kind: 'OES_ASSIGNMENT_RESULT'
  resultFingerprint: string
  assignmentId: string
  parentTaskId: string
  childTaskId: string
  transitionId: string
  dispatchStateVersion: number
  typedResult: string
  resultArtifact: AssignmentResultArtifact
}

export interface AssignmentResultReceipt {
  schemaVersion: 1
  kind: 'OES_ASSIGNMENT_RESULT_RECEIPT'
  assignmentId: string
  resultFingerprint: string
  appliedStateVersion: number
  remainingAssignments: number
  wip: AssignmentWipSnapshot
  nextLegalAction: string
}

export interface AssignmentResultTombstone {
  assignment: ActiveChildAssignment
  resultFingerprint: string
  receipt: AssignmentResultReceipt
}

export type AssignmentRuntimeStatus = 'ACTIVE' | 'WAITING_ON_CHILD' | 'DELIVERY_TOPOLOGY_REQUIRED'

export interface DeliveryTopologyStateMarker {
  decision: DeliveryTopologyDecisionKind
  requestFingerprint: string
  decisionFingerprint: string
}

export interface AssignmentRuntimeState {
  schemaVersion: 1
  kind: 'OES_ASSIGNMENT_RUNTIME_STATE'
  recordFingerprint: string
  owner: AssignmentOwnerBinding
  coordinationKey: string
  deliveryKey: string
  transitionId: string
  scopeFingerprint: string
  stateVersion: number
  status: AssignmentRuntimeStatus
  ceiling: AssignmentWipCeiling
  activeAssignments: ActiveChildAssignment[]
  resultTombstones: AssignmentResultTombstone[]
  wip: AssignmentWipSnapshot
  deliveryTopology: DeliveryTopologyStateMarker | null
  nextLegalAction: string
}

export interface IndependentDeliveryProof {
  independentCandidate: boolean
  independentReviewVerification: boolean
  independentPullRequest: boolean
  safeIndependentMainMerge: boolean
}

export interface DeliveryTopologySiblingInput {
  deliveryKey: string
  objective: string
  scope: string[]
  protectedScope: string[]
  writeSet: string[]
  dependencies: string[]
  acceptance: string[]
  requiredCapabilityFingerprint: string
  independenceProof: IndependentDeliveryProof
}

export interface DeliveryTopologySibling extends DeliveryTopologySiblingInput {
  scopeFingerprint: string
}

export interface CompletedSliceBinding {
  sliceId: string
  commitSha: string
  candidateSha: string | null
  evidenceFingerprints: string[]
}

export interface DeliveryOwnerResources {
  ownerRef: string
  ownerClone: string
  taskTemp: string
  deliveryPackagePath: string
}

export const DELIVERY_TOPOLOGY_INVALIDATION_CONDITIONS = [
  'OWNER_OR_PARENT_CHANGED',
  'COORDINATION_OR_DELIVERY_KEY_CHANGED',
  'TRANSITION_OR_STATE_VERSION_CHANGED',
  'SCOPE_OR_PROTECTED_SCOPE_CHANGED',
  'ROOT_AUTHORIZATION_CHANGED',
  'TOPOLOGY_OR_CEILING_CHANGED',
  'SIBLING_BINDING_CHANGED',
  'COMPLETED_WORK_OR_EVIDENCE_CHANGED',
  'RESOURCE_BINDING_CHANGED'
] as const
export type DeliveryTopologyInvalidationCondition =
  (typeof DELIVERY_TOPOLOGY_INVALIDATION_CONDITIONS)[number]

export interface DeliveryTopologyRequestInput {
  coordinationOwnerTaskId: string
  deliveryOwnerTaskId: string
  coordinationKey: string
  deliveryKey: string
  transitionId: string
  stateVersion: number
  scopeFingerprint: string
  rootAuthorizationFingerprint: string
  coordinationWipAuthority: CoordinationWipAuthorityBinding
  oldTopology: AssignmentWipSnapshot
  delegationCeiling: AssignmentWipCeiling
  retainedWriteSet: string[]
  currentResources: DeliveryOwnerResources
  completedSlices: CompletedSliceBinding[]
  proposedSiblings: DeliveryTopologySibling[]
}

export interface DeliveryTopologyRequest extends DeliveryTopologyRequestInput {
  schemaVersion: 1
  kind: 'OES_DELIVERY_TOPOLOGY_REQUEST'
  requestFingerprint: string
  invalidationConditions: DeliveryTopologyInvalidationCondition[]
}

export type DeliveryTopologyDecisionKind = 'DELIVERY_TOPOLOGY_REQUIRED' | 'ATOMIC_CONTINUATION'

export interface DeliveryTopologyDecision {
  schemaVersion: 1
  kind: 'OES_DELIVERY_TOPOLOGY_DECISION'
  decisionFingerprint: string
  decision: DeliveryTopologyDecisionKind
  request: DeliveryTopologyRequest
  newTopology: AssignmentWipSnapshot
  nextLegalAction:
    | 'RETURN_DELIVERY_TOPOLOGY_REQUIRED_TO_OWNER'
    | 'RETURN_DELIVERY_TOPOLOGY_REQUIRED_TO_DA'
    | 'CONTINUE_ORIGINAL_DELIVERY_WITH_BOUNDED_HELPERS'
  reason: string
}

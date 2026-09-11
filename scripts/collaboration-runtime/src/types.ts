export const REMOTE_ACTIONS = [
  'preflight',
  'publish-pr',
  'verify-pr',
  'merge-pr',
  'verify-main'
] as const
export type RemoteAction = (typeof REMOTE_ACTIONS)[number]

export const REMOTE_PHASES = [
  'REMOTE_PREFLIGHT_VERIFIED',
  'REMOTE_MUTATION_RECORDED',
  'REMOTE_VERIFICATION_PENDING',
  'REMOTE_VERIFIED'
] as const
export type RemotePhase = (typeof REMOTE_PHASES)[number]

export interface RemoteOwner {
  role: 'DA' | 'UD' | 'DO' | 'CO' | 'RV'
  taskId: string
}

export interface PullRequestBinding {
  baseRef: 'main'
  draft: boolean
  number: number | null
  requiredChecks: string[]
  title: string
  body: string
}

export interface RemoteAdmissionBinding {
  mode: 'merge-queue'
  lockPath: string | null
  mergeGroupSha: string | null
  mergeGroupBaseSha: string | null
}

export interface TrustedAuthorizationReference {
  path: string
  sha256: string
  fingerprint: string
}

export interface RemoteTrustRoots {
  projectKey: string
  authorizationRoot: string
  admissionRoot: string
  profilePath: string
  profileSha256: string
  ownerTaskId: string
  profileTransitionId: string
  profileExpectedState: EffectiveProfileReport['expectedState']
}

export interface RemoteAuthorizationRoot {
  schemaVersion: 2
  kind: 'OES_REMOTE_AUTHORIZATION_ROOT'
  recordFingerprint: string
  status: 'ACTIVE'
  issuerTaskId: string
  owner: RemoteOwner
  expectedState: string
  stateVersion: number
  transitionId: string
  decisionConfirmation: TrustedAuthorizationReference
  rootConfirmationFingerprint: string
  scopeFingerprint: string
  truthBaseline: string
  repositoryRoot: string
  repositorySlug: string
  artifactRoot: string
  allowedActions: RemoteAction[]
  mergeAuthorizationFingerprint?: string
  cleanupAuthorizationFingerprint?: string
}

export interface RemoteActionAuthorization {
  schemaVersion: 2
  kind: 'OES_REMOTE_ACTION_AUTHORIZATION'
  authorizationFingerprint: string
  status: 'ISSUED'
  issuedBeforeRemoteMutation: true
  issuerTaskId: string
  rootAuthorization: TrustedAuthorizationReference
  owner: RemoteOwner
  expectedState: string
  stateVersion: number
  transitionId: string
  decisionConfirmation: TrustedAuthorizationReference
  rootConfirmationFingerprint: string
  scopeFingerprint: string
  truthBaseline: string
  integrationBase: string
  candidateSha: string
  allowedAction: RemoteAction
  repositoryRoot: string
  repositorySlug: string
  artifactRoot: string
  headRef: string
  baseRef: 'main'
  singleUseNonce: string
  resourceSetFingerprint: string
  postcondition: string
  mergeAuthorizationFingerprint?: string
  cleanupAuthorizationFingerprint?: string
}

export interface RemoteDriverBinding {
  schemaVersion: 1
  kind: 'OES_REMOTE_DRIVER_BINDING'
  bindingFingerprint: string
  authorization: TrustedAuthorizationReference
  action: RemoteAction
  owner: RemoteOwner
  expectedState: string
  stateVersion: number
  transitionId: string
  scopeFingerprint: string
  truthBaseline: string
  integrationBase: string
  candidateSha: string
  repositoryRoot: string
  repositorySlug: string
  artifactRoot: string
  checkpointPath: string
  resultPath: string
  invalidationPath: string
  singleUseNonce: string
  headRef: string
  baseRef: 'main'
  pullRequest: PullRequestBinding
  mergeMethod: 'merge'
  expectedMergeSha?: string
  admission?: RemoteAdmissionBinding
  mergeAuthorizationFingerprint?: string
  cleanupAuthorizationFingerprint?: string
}

export interface PullRequestTruth {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  baseRef: string
  headRef: string
  headSha: string
  mergeCommitSha: string | null
  title: string
  body: string
}

export interface RequiredCheckTruth {
  sha: string
  name: string
  status: string
  conclusion: string | null
  id: number
  startedAt?: string
  completedAt?: string | null
}

export interface RemoteTruth {
  branchHead: string | null
  mergeQueueEntry: {
    id: string
    position: number | null
    state: string
    baseSha: string
    headSha: string
  } | null
  mainHead: string
  pullRequest: PullRequestTruth | null
  requiredChecks: RequiredCheckTruth[]
  mainParents: string[]
  pullMergeParents: string[]
  reviewGate: {
    annotations: number
    issueComments: number
    reviewComments: number
    blockingReviews: number
    unresolvedThreads: number
  }
}

export interface RemoteReceipt {
  action: RemoteAction
  mutationPerformed: boolean
  recoveredFromRemoteTruth: boolean
  branchHead: string | null
  pullRequestNumber: number | null
  mergeCommitSha: string | null
  mergeGroupBaseSha?: string | null
  mergeGroupHeadSha?: string | null
}

export interface RemoteVerification {
  passed: boolean
  status: string
  literalResult: unknown
}

export interface RemoteCheckpoint {
  schemaVersion: 1
  kind: 'OES_REMOTE_DRIVER_CHECKPOINT'
  bindingFingerprint: string
  action: RemoteAction
  singleUseNonce: string
  phase: RemotePhase
  receipt: RemoteReceipt | null
  remoteTruthFingerprint: string
  updatedAt: string
}

export interface RemoteDriverResult {
  schemaVersion: 1
  kind: 'OES_REMOTE_DRIVER_RESULT'
  bindingFingerprint: string
  action: RemoteAction
  ownerTaskId: string
  singleUseNonce: string
  status: 'REMOTE_VERIFICATION_PENDING' | 'REMOTE_VERIFIED'
  phase: RemotePhase
  receipt: RemoteReceipt
  verification: RemoteVerification
  remoteTruth: RemoteTruth
  remoteMutation: boolean
}

export const CAPABILITY_NAMES = [
  'filesystemWrite',
  'gitSwitchAddCommit',
  'standardBuildTest',
  'taskOwnedDatabase',
  'localhostBind',
  'approvedNetworkRead',
  'credentialReference',
  'approvalTelemetry'
] as const
export type CapabilityName = (typeof CAPABILITY_NAMES)[number]

export interface CapabilityObservation {
  name: CapabilityName
  command: string
  literalOutput: string
  exitCode: number
  evidencePath: string
  evidenceSha256: string
  result: 'PASS' | 'FAIL'
}

export const APPROVAL_MODES = ['ON_REQUEST_AUTO_REVIEW', 'NEVER_USER'] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]
export type ApprovalPolicy = 'on-request' | 'never'
export type ApprovalsReviewer = 'auto_review' | 'user'

export interface EffectivePermissionContext {
  ordinal: number
  turnId: string
  approvalPolicy: ApprovalPolicy
  approvalsReviewer: ApprovalsReviewer
  permissionProfileType: string
  sandboxPolicyType: string
  fileSystemSandboxPolicyKind: string
  activePermissionProfileId: string | null
  permissionSandboxFingerprint: string
}

export interface ApprovalTelemetry {
  eventSource: string
  eventSourceSha256: string
  eventSourceFingerprint?: string
  snapshotRecord?: TrustedAuthorizationReference
  probeAttemptId?: string
  probeDraftFingerprint?: string
  probeRequestFingerprint?: string
  rolloutSessionId?: string
  completedTurnId?: string
  approvalPolicy: ApprovalPolicy
  approvalsReviewer: ApprovalsReviewer
  approvalEventCount: number
  normalPermissionPromptCount: number
  approvalMode?: ApprovalMode
  effectivePermissionSandboxFingerprint?: string
  contexts?: EffectivePermissionContext[]
}

export interface ApprovalTelemetrySnapshotRecord {
  schemaVersion: 1
  kind: 'OES_APPROVAL_TELEMETRY_SNAPSHOT_RECORD'
  snapshotRecordFingerprint: string
  ownerTaskId: string
  transitionId: string
  profileGeneration: number
  launchReceiptFingerprint: string
  probeAttemptFingerprint: string
  probeAttemptId: string
  probeDraftFingerprint: string
  probeRequestFingerprint: string
  rolloutSessionId: string
  completedTurnId: string
  snapshot: TrustedAuthorizationReference
}

export interface ProfileProbeAttemptRecord {
  schemaVersion: 1
  kind: 'OES_PROFILE_PROBE_ATTEMPT'
  probeAttemptFingerprint: string
  status: 'ISSUED'
  issuedBeforeProbe: true
  issuerTaskId: string
  ownerTaskId: string
  transitionId: string
  profileGeneration: number
  launchReceiptFingerprint: string
  probeAttemptId: string
  expectedRolloutSessionId: string
  requestContractFingerprint: string
  snapshotRecordPath: string
}

export interface ProfileLaunchReceipt {
  schemaVersion: 1
  kind: 'OES_PROFILE_LAUNCH_RECEIPT'
  receiptFingerprint: string
  ownerTaskId: string
  transitionId: string
  profileGeneration: number
  predecessorLaunchReceipt: TrustedAuthorizationReference | null
  approvalMode: ApprovalMode
  approvalPolicy: ApprovalPolicy
  approvalsReviewer: ApprovalsReviewer
  installedProfile: {
    path: string
    sha256: string
  }
  expectedEffectivePermissionSandboxFingerprint: string
  resourceTopology: import('./resource-topology.types.ts').EffectiveOwnerResourceTopology
}

export interface EffectiveProfileReport {
  schemaVersion: 1 | 2
  kind: 'OES_EFFECTIVE_PROFILE_REPORT'
  ownerTaskId: string
  transitionId: string
  expectedState: 'HANDOFF_PENDING' | 'DELIVERY_ACTIVE'
  declaredCapabilities: CapabilityName[]
  profile: {
    name: string
    permission: string
    path: string
    sha256: string
  }
  observations: CapabilityObservation[]
  credentialReference: {
    reference: string
    keys: string[]
    secretValuesRecorded: false
  }
  telemetry: ApprovalTelemetry
  approvalMode?: ApprovalMode
  launchReceipt?: TrustedAuthorizationReference
  effectivePermissionSandboxFingerprint?: string
  probeAttempt?: TrustedAuthorizationReference
}

export interface EvidenceKeyInput {
  candidateSha: string
  candidateTreeSha: string
  dependencyCandidates: DependencyCandidate[]
  dependencyFingerprint: string
  lockfileFingerprint: string
  toolchainFingerprint: string
  testConfigFingerprint: string
  environmentFingerprint: string
  literalInputsFingerprint: string
  executionProfileFingerprint: string
  commandFingerprint: string
  commandVersion: string
  literalResultFingerprint: string
  exitCode: number
  coverageIds: string[]
}

/** Identifies one exact dependency candidate included in an evidence execution. */
export interface DependencyCandidate {
  deliveryKey: string
  candidateSha: string
  candidateTreeSha: string
}

export interface EvidenceKey extends EvidenceKeyInput {
  schemaVersion: 1
  kind: 'OES_TEST_EVIDENCE_KEY'
  evidenceFingerprint: string
}

export interface RiskCoverage {
  id: string
  pathPatterns: string[]
  contractSensitive: boolean
}

export interface DriftAssessmentInput {
  previousEvidence: EvidenceKey | null
  nextEvidence: EvidenceKeyInput
  changedPaths: string[]
  coverage: RiskCoverage[]
  dependencyChanged: boolean
  profileChanged: boolean
  commandChanged: boolean
  contractChanged: boolean
  semanticConflict: boolean
}

export interface DriftAssessment {
  decision: 'REUSE_EXACT' | 'REFRESH_BASELINE' | 'FOCUSED' | 'FULL' | 'DESIGN_GAP'
  affectedCoverageIds: string[]
  reusableCoverageIds: string[]
  reason: string
}

export interface CoordinationCleanupResource {
  kind: 'remote-branch' | 'local-branch' | 'worktree' | 'task-temp' | 'delivery-package'
  path: string
  expectedSha: string | null
}

export interface TerminalDeliveryCleanup {
  deliveryKey: string
  ownerTaskId: string
  terminalState: 'MERGED' | 'ABANDONED'
  candidateSha: string
  mergeSha: string | null
  ownerResourceBinding: import('./resource-topology.types.ts').OwnerResourceReference
  resources: CoordinationCleanupResource[]
}

export interface TerminalCoordinationCleanup {
  ownerTaskId: string
  terminalState: 'MERGED' | 'ABANDONED'
  candidateSha: string
  mergeSha: string | null
  ownerResourceBinding: import('./resource-topology.types.ts').OwnerResourceReference
  resources: CoordinationCleanupResource[]
}

export interface CoordinationCleanupAuthorization {
  schemaVersion: 2
  kind: 'OES_COORDINATION_CLEANUP_AUTHORIZATION'
  authorizationFingerprint: string
  status: 'ISSUED'
  expectedState: 'COORDINATION_CLEANUP_AUTHORIZED'
  stateVersion: number
  coordinationKey: string
  coordinationOwnerTaskId: string
  transitionId: string
  confirmationFingerprint: string
  terminalDeliveries: TerminalDeliveryCleanup[]
  coordinationOwner: TerminalCoordinationCleanup
}

export interface CoordinationChildCleanupAuthorization {
  schemaVersion: 2
  kind: 'OES_COORDINATION_CHILD_CLEANUP_AUTHORIZATION'
  authorizationFingerprint: string
  status: 'ISSUED'
  rootAuthorization: TrustedAuthorizationReference
  expectedState: 'COORDINATION_CLEANUP_AUTHORIZED'
  stateVersion: number
  coordinationKey: string
  coordinationOwnerTaskId: string
  ownerTaskId: string
  transitionId: string
  confirmationFingerprint: string
  ownerResourceBinding: import('./resource-topology.types.ts').OwnerResourceReference
  resources: CoordinationCleanupResource[]
  postcondition: 'CHILD_SELF_CLEANUP'
}

export interface CoordinationCleanupCurrentAuthorization {
  schemaVersion: 2
  kind: 'OES_COORDINATION_CLEANUP_CURRENT_AUTHORIZATION'
  recordFingerprint: string
  status: 'ACTIVE' | 'INVALIDATED' | 'COMPLETED'
  purpose: 'CHILD_SELF_CLEANUP' | 'COORDINATION_CLEANUP_VERIFY'
  rootAuthorization: TrustedAuthorizationReference
  childAuthorization: TrustedAuthorizationReference | null
  coordinationKey: string
  coordinationOwnerTaskId: string
  ownerTaskId: string
  expectedState: 'COORDINATION_CLEANUP_AUTHORIZED'
  stateVersion: number
  transitionId: string
  confirmationFingerprint: string
  postcondition: 'CURRENT_COORDINATION_CLEANUP'
}

export interface ObservedCleanupResource extends CoordinationCleanupResource {
  exists: boolean
  clean: boolean
  actualSha: string | null
}

export interface CleanupResourceDecision {
  resource: CoordinationCleanupResource
  decision: 'REMOVE' | 'ALREADY_ABSENT' | 'PRESERVE_FAILURE' | 'SKIP_COMPLETED'
  reason: string
  observedBefore: ObservedCleanupResource | null
  observedAfter: ObservedCleanupResource | null
  completionFingerprint?: string
}

export interface CompletedCleanupResource {
  resource: CoordinationCleanupResource
  observedAfter: ObservedCleanupResource
  completionFingerprint: string
}

export interface CleanupDiffEntry {
  status: 'A' | 'C' | 'D' | 'M' | 'R' | 'T' | 'U' | 'X' | 'B'
  path: string
}

export interface CoordinationCleanupResultSet {
  schemaVersion: 2
  kind: 'OES_COORDINATION_CLEANUP_RESULT_SET'
  resultSetFingerprint: string
  coordinationKey: string
  coordinationOwnerTaskId: string
  transitionId: string
  coordinationCleanupAuthorizationFingerprint: string
  resultsByOwner: Record<string, CleanupResourceDecision[]>
  repositoryDiff: CleanupDiffEntry[]
}

export interface CoordinationDeliveryCandidate {
  order: number
  deliveryKey: string
  ownerTaskId: string
  baseSha: string
  candidateSha: string
  patchFingerprint: string
  contentFingerprint: string
  dependencies: string[]
  scopedRv: TrustedAuthorizationReference
  independentlyReleasable: boolean
}

export interface CoordinationScopedRvResult {
  schemaVersion: 2
  kind: 'OES_COORDINATION_SCOPED_RV_RESULT'
  resultFingerprint: string
  status: 'PASSED'
  coordinationKey: string
  deliveryKey: string
  deliveryOwnerTaskId: string
  reviewerTaskId: string
  candidateSha: string
  patchFingerprint: string
  contentFingerprint: string
}

export interface CoordinationIntegrationAuthorization {
  schemaVersion: 2
  kind: 'OES_COORDINATION_INTEGRATION_AUTHORIZATION'
  authorizationFingerprint: string
  status: 'ISSUED'
  expectedState: 'COORDINATION_INTEGRATION_AUTHORIZED'
  stateVersion: number
  coordinationKey: string
  coordinationOwnerTaskId: string
  transitionId: string
  confirmationFingerprint: string
  baseSha: string
  aggregateBranch: string
  prTopology: 'AGGREGATE' | 'INDEPENDENT'
  independentPrExceptionConfirmed: boolean
  orderedSetFingerprint: string
  items: CoordinationDeliveryCandidate[]
}

export interface CoordinationIntegrationItemResult {
  order: number
  deliveryKey: string
  candidateSha: string
  state: 'PENDING' | 'FAILED' | 'INTEGRATED_VERIFIED'
  integratedSha: string | null
  failureCode: string | null
}

export interface CoordinationIntegrationResultSet {
  schemaVersion: 2
  kind: 'OES_COORDINATION_INTEGRATION_RESULT_SET'
  resultSetFingerprint: string
  authorizationFingerprint: string
  coordinationKey: string
  coordinationOwnerTaskId: string
  transitionId: string
  results: CoordinationIntegrationItemResult[]
}

export interface CoordinationIntegrationPlan {
  status:
    | 'INTEGRATE_NEXT'
    | 'STOPPED_FAILURE'
    | 'AGGREGATE_CANDIDATE_READY'
    | 'INDEPENDENT_PRS_READY'
  integratedPrefix: string[]
  nextItem: CoordinationDeliveryCandidate | null
  blockedSuffix: string[]
  aggregateBranch: string
  pullRequestCount: 1 | number
  failure: CoordinationIntegrationItemResult | null
}

export type CoordinationLifecycleTaskKind = 'BOUNDED_HELPER' | 'RV' | 'DO' | 'CO'

export interface CoordinationLifecycleTask {
  taskId: string
  taskKind: CoordinationLifecycleTaskKind
  ownerTaskId: string | null
  state: 'TERMINAL' | 'ACTIVE' | 'UNKNOWN'
}

export interface CoordinationLifecycleCreatedTask {
  taskId: string
  taskKind: CoordinationLifecycleTaskKind
  ownerTaskId: string | null
  creationReceiptFingerprint: string
}

export interface CoordinationLifecycleRosterAuthority {
  schemaVersion: 2
  kind: 'OES_COORDINATION_LIFECYCLE_ROSTER_AUTHORITY'
  authorityFingerprint: string
  coordinationKey: string
  coordinationOwnerTaskId: string
  transitionId: string
  coordinationCleanupAuthorizationFingerprint: string
  source: 'TASK_NATIVE_CREATION_RECEIPTS' | 'EXECUTION_NATIVE_CREATION_RECEIPTS'
  createdRoster: CoordinationLifecycleCreatedTask[]
}

export interface CoordinationLifecycleInventory {
  schemaVersion: 2
  kind: 'OES_COORDINATION_LIFECYCLE_INVENTORY'
  inventoryFingerprint: string
  coordinationKey: string
  coordinationOwnerTaskId: string
  transitionId: string
  coordinationCleanupAuthorizationFingerprint: string
  cleanupIntentDetected: true
  coordinationExit: 'PASSED' | 'PENDING' | 'FAILED'
  resourceCleanup: 'PENDING' | 'VERIFIED' | 'PARTIAL_FAILURE'
  cleanupResult: TrustedAuthorizationReference | null
  rosterAuthorityFingerprint: string
  taskReadbackSource: 'CODEX_TASK_NATIVE' | 'CODEX_EXECUTION_NATIVE'
  readbackRosterFingerprint: string
  readbackRoster: CoordinationLifecycleTask[]
  terminalTaskIds: string[]
}

export interface CoordinationArchiveResult {
  taskId: string
  taskKind: CoordinationLifecycleTaskKind
  state: 'ARCHIVED' | 'FAILED'
  inventoryFingerprint: string
  taskNativeReadbackFingerprint: string
  resultFingerprint: string
}

export interface CoordinationArchiveResultSet {
  schemaVersion: 2
  kind: 'OES_COORDINATION_ARCHIVE_RESULT_SET'
  resultSetFingerprint: string
  coordinationKey: string
  coordinationOwnerTaskId: string
  transitionId: string
  coordinationCleanupAuthorizationFingerprint: string
  inventoryFingerprint: string
  results: CoordinationArchiveResult[]
}

export interface CoordinationArchiveDecision {
  taskId: string
  taskKind: CoordinationLifecycleTaskKind
  decision: 'ARCHIVE' | 'SKIP_ARCHIVED' | 'SKIP_TERMINATED_SUBAGENT' | 'PRESERVE_BLOCKED'
  reason: string
}

export interface CoordinationLifecyclePlan {
  status:
    | 'WAIT_COORDINATION_EXIT'
    | 'WAIT_TERMINAL_ROSTER'
    | 'WAIT_RESOURCE_CLEANUP'
    | 'ARCHIVE_READY'
    | 'ARCHIVE_PARTIAL_FAILURE'
    | 'COMPLETE'
  decisions: CoordinationArchiveDecision[]
}

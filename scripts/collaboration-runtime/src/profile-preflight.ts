import {
  chmodSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import {
  assertPathWithin,
  canonicalJson,
  objectFingerprint,
  readJson,
  sha256,
  writeJsonAtomic
} from './canonical.ts'
import { validateProfileReportEnvelope, verifyTrustedReference } from './binding.ts'
import { fail } from './errors.ts'
import {
  approvalPair,
  loadProfileLaunchReceipt,
  readInstalledProfilePolicy
} from './profile-policy.ts'
import { readInstalledProfileResourceTopology } from './resource-topology.ts'
import {
  CAPABILITY_NAMES,
  type ApprovalMode,
  type ApprovalTelemetry,
  type ApprovalTelemetrySnapshotRecord,
  type CapabilityName,
  type CapabilityObservation,
  type EffectivePermissionContext,
  type EffectiveProfileReport,
  type ProfileProbeAttemptRecord,
  type RemoteTrustRoots,
  type TrustedAuthorizationReference
} from './types.ts'

export type CapabilityFailureRoute =
  | 'EXECUTION_ENVIRONMENT_NOT_READY'
  | 'EXECUTION_PROFILE_DEFECT'
  | 'PERMISSION_EXPANSION_REQUIRED'

export interface CapabilityIssue {
  expectedState: 'HANDOFF_PENDING' | 'DELIVERY_ACTIVE'
  capabilityDeclared: boolean
  operation: string
  literalFailure: string
}

export interface ProfileRepairPlan {
  route: CapabilityFailureRoute
  preserveOwner: boolean
  sameTransitionRetry: boolean
  additions: { filesystemRoots: string[]; networkDomains: string[]; allowLocalBinding: boolean }
  retainedDenies: string[]
}

export interface PreflightProbeAdapter {
  observe(
    name: CapabilityName,
    telemetryExpectation?: ApprovalTelemetryExpectation,
    telemetryEventSource?: string
  ): Promise<CapabilityObservation>
  credentialReference(): Promise<EffectiveProfileReport['credentialReference']>
  approvalTelemetry(
    expectation: ApprovalTelemetryExpectation,
    telemetryEventSource?: string
  ): Promise<ApprovalTelemetry>
}

export interface PreflightRequest {
  ownerTaskId: string
  transitionId: string
  approvalMode: ApprovalMode
  launchReceipt: TrustedAuthorizationReference
  expectedState: EffectiveProfileReport['expectedState']
  declaredCapabilities: CapabilityName[]
  profile: EffectiveProfileReport['profile']
  resultPath: string
}

export interface EffectiveProfileProbeDraft {
  schemaVersion: 1
  kind: 'OES_EFFECTIVE_PROFILE_PROBE_DRAFT'
  draftFingerprint: string
  requestFingerprint: string
  probeAttemptFingerprint: string
  probeAttemptId: string
  ownerTaskId: string
  transitionId: string
  declaredCapabilities: CapabilityName[]
  observations: CapabilityObservation[]
  credentialReference: EffectiveProfileReport['credentialReference']
}

export interface ApprovalTelemetryExpectation {
  approvalMode: ApprovalMode
  expectedEffectivePermissionSandboxFingerprint: string
  expectedActivePermissionProfileId: string
  trustedAuthorizationRoot: string
}

interface PreparedProfilePreflight {
  telemetryExpectation: ApprovalTelemetryExpectation
  probeAttempt: ProfileProbeAttemptRecord
  probeAttemptReference: TrustedAuthorizationReference
}

export interface SystemProbeOptions {
  repositoryRoot: string
  smokeRoot: string
  telemetryEventSource?: string
  git?: string
  node?: string
}

interface InstalledProfileIdentity {
  ownerTaskId: string
  transitionId: string
}

interface InstalledProfileRuntimeAuthority {
  defaultPermissionProfileId: string
  trustedAuthorizationRoot: string
}

const ACCEPTED_RUNTIME_SANDBOX_POLICY_TYPES = new Set(['workspace-write'])
const CURRENT_PROFILE_PROBE_ATTEMPT = 'current-profile-probe-attempt.json'
const PROBE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u

/** Reads the profile-sealed permission identity and issuer-owned telemetry trust root. */
function readInstalledProfileRuntimeAuthority(
  profilePath: string
): InstalledProfileRuntimeAuthority {
  const profile = readFileSync(profilePath, 'utf8')
  let section = ''
  let defaultPermissionProfileId = ''
  let trustedAuthorizationRoot = ''
  for (const rawLine of profile.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1]
      continue
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")$/u.exec(line)
    if (!assignment) continue
    if (section === '' && assignment[1] === 'default_permissions') {
      if (defaultPermissionProfileId) fail('PROFILE_DEFAULT_PERMISSION_DUPLICATE', profilePath)
      defaultPermissionProfileId = JSON.parse(assignment[2]) as string
    }
    if (section === 'collaboration_runtime' && assignment[1] === 'trusted_authorization_root') {
      if (trustedAuthorizationRoot) fail('PROFILE_AUTHORIZATION_ROOT_DUPLICATE', profilePath)
      trustedAuthorizationRoot = JSON.parse(assignment[2]) as string
    }
  }
  if (!defaultPermissionProfileId.trim() || !isAbsolute(trustedAuthorizationRoot))
    fail('PROFILE_RUNTIME_AUTHORITY_INVALID', profilePath)
  return { defaultPermissionProfileId, trustedAuthorizationRoot }
}

/** Binds one telemetry source to its issuer-owned path and exact bytes. */
function telemetrySourceFingerprint(eventSource: string, eventSourceSha256: string): string {
  return sha256(canonicalJson({ eventSource, eventSourceSha256 }))
}

/** Hashes the exact pre-authorized probe contract independently of its output location. */
export function profilePreflightRequestContractFingerprint(request: PreflightRequest): string {
  return sha256(
    canonicalJson({
      ownerTaskId: request.ownerTaskId,
      transitionId: request.transitionId,
      approvalMode: request.approvalMode,
      launchReceipt: request.launchReceipt,
      expectedState: request.expectedState,
      declaredCapabilities: request.declaredCapabilities,
      profile: request.profile
    })
  )
}

/** Binds request semantics to one issuer-issued probe attempt. */
export function profilePreflightRequestFingerprint(
  request: PreflightRequest,
  probeAttemptFingerprint: string
): string {
  return sha256(
    canonicalJson({
      requestContractFingerprint: profilePreflightRequestContractFingerprint(request),
      probeAttemptFingerprint
    })
  )
}

/** Validates that one issuer snapshot contains the exact completed rollout session and turn. */
function verifyTelemetrySnapshotIdentity(
  bytes: Buffer,
  rolloutSessionId: string,
  completedTurnId: string
): void {
  let sessionMatched = false
  let contextMatched = false
  let lastCompletedTurnId = ''
  for (const line of bytes.toString('utf8').split(/\r?\n/u)) {
    if (!line) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : undefined
    if (event.type === 'session_meta' && payload) {
      const identity = String(payload.session_id ?? payload.id ?? event.id ?? '')
      if (identity && identity !== rolloutSessionId)
        fail('APPROVAL_TELEMETRY_SESSION_MISMATCH', identity)
      if (identity === rolloutSessionId) sessionMatched = true
    }
    if (event.type === 'turn_context' && String(payload?.turn_id ?? '') === completedTurnId)
      contextMatched = true
    if (event.type === 'event_msg' && payload?.type === 'task_complete')
      lastCompletedTurnId = String(payload.turn_id ?? '')
  }
  if (!sessionMatched) fail('APPROVAL_TELEMETRY_SESSION_MISSING', rolloutSessionId)
  if (!contextMatched) fail('APPROVAL_TELEMETRY_COMPLETED_TURN_CONTEXT_MISSING', completedTurnId)
  if (lastCompletedTurnId !== completedTurnId)
    fail('APPROVAL_TELEMETRY_TASK_COMPLETE_MISMATCH', lastCompletedTurnId || completedTurnId)
}

/** Reopens telemetry only from the profile-sealed, read-only authorization root. */
function readTrustedTelemetrySource(
  eventSource: string,
  trustedAuthorizationRoot: string
): { bytes: Buffer; fingerprint: string } {
  if (!isAbsolute(eventSource)) fail('APPROVAL_TELEMETRY_SOURCE_NOT_ABSOLUTE', eventSource)
  assertPathWithin(trustedAuthorizationRoot, eventSource)
  assertPathWithin(realpathSync(trustedAuthorizationRoot), realpathSync(eventSource))
  const bytes = readFileSync(eventSource)
  const digest = sha256(bytes)
  return { bytes, fingerprint: telemetrySourceFingerprint(eventSource, digest) }
}

/** Reads the issuer-sealed owner and transition from the installed profile bytes. */
function readInstalledProfileIdentity(profilePath: string): InstalledProfileIdentity {
  const profile = readFileSync(profilePath, 'utf8')
  let section = ''
  const values = new Map<string, string>()
  for (const rawLine of profile.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1]
      continue
    }
    if (section !== 'collaboration_runtime') continue
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")$/u.exec(line)
    if (!assignment || !['owner_task_id', 'transition_id'].includes(assignment[1])) continue
    if (values.has(assignment[1])) fail('PROFILE_IDENTITY_FIELD_DUPLICATE', assignment[1])
    values.set(assignment[1], JSON.parse(assignment[2]) as string)
  }
  const ownerTaskId = values.get('owner_task_id') ?? ''
  const transitionId = values.get('transition_id') ?? ''
  if (!ownerTaskId.trim() || !transitionId.trim())
    fail('PROFILE_OWNER_TRANSITION_REQUIRED', profilePath)
  return { ownerTaskId, transitionId }
}

/** Routes a capability failure without converting an existing authorization into a new gate. */
export function classifyCapabilityIssue(issue: CapabilityIssue): CapabilityFailureRoute {
  if (!issue.capabilityDeclared) return 'PERMISSION_EXPANSION_REQUIRED'
  return issue.expectedState === 'HANDOFF_PENDING'
    ? 'EXECUTION_ENVIRONMENT_NOT_READY'
    : 'EXECUTION_PROFILE_DEFECT'
}

/** Produces a minimal same-transition repair while retaining protected denies. */
export function planProfileRepair(
  issue: CapabilityIssue,
  requested: { filesystemRoots?: string[]; networkDomains?: string[]; allowLocalBinding?: boolean }
): ProfileRepairPlan {
  const route = classifyCapabilityIssue(issue)
  const roots = [...new Set(requested.filesystemRoots ?? [])]
  const domains = [...new Set(requested.networkDomains ?? [])]
  if (
    roots.some((root) => root === '/' || root.includes('**')) ||
    domains.some((domain) => domain === '*')
  )
    fail('UNBOUNDED_PROFILE_REPAIR_REJECTED', issue.operation)
  return {
    route,
    preserveOwner: issue.expectedState === 'DELIVERY_ACTIVE',
    sameTransitionRetry: route !== 'PERMISSION_EXPANSION_REQUIRED',
    additions: {
      filesystemRoots: roots.sort(),
      networkDomains: domains.sort(),
      allowLocalBinding: requested.allowLocalBinding === true
    },
    retainedDenies: [
      'secret values',
      'private keys',
      'production/shared data',
      'cross-owner resources',
      'host/system privilege'
    ]
  }
}

/** Extracts credential field names while discarding all credential values. */
export function credentialReferenceKeys(output: string): string[] {
  const approved = new Set(['username', 'password'])
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.split('=', 1)[0])
        .filter((key) => approved.has(key))
    )
  ].sort()
}

/** Removes only launcher-generated prompt filenames while preserving every exact parent root. */
function normalizedPermissionState(value: unknown): unknown {
  const normalized = structuredClone(value)
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'path' && typeof child === 'string')
        (node as Record<string, unknown>)[key] = child.replace(
          /\/tmp\/arg0\/codex-arg0[^/]+$/u,
          '/tmp/arg0/<CODEX_ARG0>'
        )
      else visit(child)
    }
  }
  visit(normalized)
  return normalized
}

/** Hashes the authority-bearing effective permission/sandbox state of one turn context. */
export function effectivePermissionSandboxFingerprint(payload: Record<string, unknown>): string {
  return sha256(
    canonicalJson({
      permissionProfile: normalizedPermissionState(payload.permission_profile ?? null),
      sandboxPolicy: normalizedPermissionState(payload.sandbox_policy ?? null),
      fileSystemSandboxPolicy: normalizedPermissionState(
        payload.file_system_sandbox_policy ?? null
      ),
      activePermissionProfile: normalizedPermissionState(payload.active_permission_profile ?? null)
    })
  )
}

/** Reads every Codex turn context and enforces either frozen v1 or exact v2 telemetry. */
export function readApprovalTelemetry(
  eventSource: string,
  expectation?: ApprovalTelemetryExpectation
): ApprovalTelemetry {
  const trusted = expectation
    ? readTrustedTelemetrySource(eventSource, expectation.trustedAuthorizationRoot)
    : null
  const bytes = trusted?.bytes ?? readFileSync(eventSource)
  let approvalEventCount = 0
  let normalPermissionPromptCount = 0
  const contexts: EffectivePermissionContext[] = []
  const observedPairs: { approvalPolicy: string; approvalsReviewer: string }[] = []
  const turnFingerprints = new Map<string, string>()
  let contextIndex = 0
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (!line) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : undefined
    if (event.type === 'turn_context' && payload) {
      const approvalPolicy = String(payload.approval_policy)
      const approvalsReviewer = String(payload.approvals_reviewer)
      observedPairs.push({ approvalPolicy, approvalsReviewer })
      if (expectation) {
        const permissionProfile =
          payload.permission_profile && typeof payload.permission_profile === 'object'
            ? (payload.permission_profile as Record<string, unknown>)
            : null
        const sandboxPolicy =
          payload.sandbox_policy && typeof payload.sandbox_policy === 'object'
            ? (payload.sandbox_policy as Record<string, unknown>)
            : null
        const fileSystemSandboxPolicy =
          payload.file_system_sandbox_policy &&
          typeof payload.file_system_sandbox_policy === 'object'
            ? (payload.file_system_sandbox_policy as Record<string, unknown>)
            : null
        const activePermissionProfile =
          payload.active_permission_profile && typeof payload.active_permission_profile === 'object'
            ? (payload.active_permission_profile as Record<string, unknown>)
            : null
        const permissionProfileType = String(permissionProfile?.type ?? '')
        const permissionFileSystem =
          permissionProfile?.file_system && typeof permissionProfile.file_system === 'object'
            ? (permissionProfile.file_system as Record<string, unknown>)
            : null
        const sandboxPolicyType = String(sandboxPolicy?.type ?? '')
        const fileSystemSandboxPolicyKind = String(fileSystemSandboxPolicy?.kind ?? '')
        const activePermissionProfileId = activePermissionProfile
          ? String(activePermissionProfile.id ?? '') || null
          : null
        if (
          permissionProfileType !== 'managed' ||
          String(permissionFileSystem?.type ?? '') !== 'restricted' ||
          !ACCEPTED_RUNTIME_SANDBOX_POLICY_TYPES.has(sandboxPolicyType) ||
          fileSystemSandboxPolicyKind !== 'restricted' ||
          activePermissionProfileId !== expectation.expectedActivePermissionProfileId
        )
          fail(
            'EFFECTIVE_PERMISSION_SANDBOX_UNMANAGED',
            `${permissionProfileType}/${String(permissionFileSystem?.type ?? '')}/${sandboxPolicyType}/${fileSystemSandboxPolicyKind}/${activePermissionProfileId ?? 'none'}`
          )
        const fingerprint = effectivePermissionSandboxFingerprint(payload)
        const turnId = String(payload.turn_id ?? '')
        if (!turnId) fail('TURN_CONTEXT_ID_REQUIRED', String(contextIndex))
        const prior = turnFingerprints.get(turnId)
        if (prior && prior !== fingerprint) fail('TURN_CONTEXT_PERMISSION_DRIFT', turnId)
        turnFingerprints.set(turnId, fingerprint)
        contexts.push({
          ordinal: Number.isSafeInteger(event.ordinal) ? Number(event.ordinal) : contextIndex,
          turnId,
          approvalPolicy: approvalPolicy as EffectivePermissionContext['approvalPolicy'],
          approvalsReviewer: approvalsReviewer as EffectivePermissionContext['approvalsReviewer'],
          permissionProfileType,
          sandboxPolicyType,
          fileSystemSandboxPolicyKind,
          activePermissionProfileId,
          permissionSandboxFingerprint: fingerprint
        })
      }
      contextIndex += 1
    }
    const payloadType = payload?.type
    if (
      ['exec_approval_request', 'apply_patch_approval_request', 'mcp_approval_request'].includes(
        String(payloadType)
      )
    )
      approvalEventCount += 1
    if (['request_user_input', 'user_approval_request'].includes(String(payloadType)))
      normalPermissionPromptCount += 1
  }
  if (!observedPairs.length) fail('APPROVAL_TELEMETRY_CONTEXT_MISSING', eventSource)
  const pair = expectation
    ? approvalPair(expectation.approvalMode)
    : { approvalPolicy: 'on-request' as const, approvalsReviewer: 'auto_review' as const }
  const mismatch = observedPairs.find(
    (context) =>
      context.approvalPolicy !== pair.approvalPolicy ||
      context.approvalsReviewer !== pair.approvalsReviewer
  )
  if (mismatch)
    fail(
      'APPROVAL_TELEMETRY_PROFILE_MISMATCH',
      `${mismatch.approvalPolicy}/${mismatch.approvalsReviewer}`
    )
  const base: ApprovalTelemetry = {
    eventSource,
    eventSourceSha256: sha256(bytes),
    approvalPolicy: pair.approvalPolicy,
    approvalsReviewer: pair.approvalsReviewer,
    approvalEventCount,
    normalPermissionPromptCount
  }
  if (!expectation) return base
  if (!contexts.length) fail('EFFECTIVE_PERMISSION_CONTEXT_MISSING', eventSource)
  const drift = contexts.find(
    (context) =>
      context.permissionSandboxFingerprint !==
      expectation.expectedEffectivePermissionSandboxFingerprint
  )
  if (drift)
    fail('EFFECTIVE_PERMISSION_SANDBOX_FINGERPRINT_MISMATCH', drift.permissionSandboxFingerprint)
  if (expectation.approvalMode === 'NEVER_USER' && approvalEventCount !== 0)
    fail('NEVER_USER_APPROVAL_EVENT_FORBIDDEN', String(approvalEventCount))
  return {
    ...base,
    eventSourceFingerprint: trusted?.fingerprint,
    approvalMode: expectation.approvalMode,
    effectivePermissionSandboxFingerprint:
      expectation.expectedEffectivePermissionSandboxFingerprint,
    contexts
  }
}

/** Strictly compares one persisted observation evidence record to its report entry. */
function verifyObservationEvidence(observation: CapabilityObservation): void {
  const allowed = [
    'name',
    'command',
    'literalOutput',
    'exitCode',
    'result',
    'evidencePath',
    'evidenceSha256'
  ]
  const extras = Object.keys(observation).filter((key) => !allowed.includes(key))
  if (extras.length) fail('UNDECLARED_CAPABILITY_OBSERVATION_FIELD', extras.join(','))
  const bytes = readFileSync(observation.evidencePath)
  if (sha256(bytes) !== observation.evidenceSha256)
    fail('CAPABILITY_EVIDENCE_SHA_MISMATCH', observation.name)
  const persisted = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  const expected = {
    name: observation.name,
    command: observation.command,
    literalOutput: observation.literalOutput,
    exitCode: observation.exitCode,
    result: observation.result
  }
  if (canonicalJson(persisted) !== canonicalJson(expected))
    fail('CAPABILITY_EVIDENCE_READBACK_MISMATCH', observation.name)
}

/** Validates exact probes, persisted evidence, profile bytes, credential keys and telemetry. */
export function verifyEffectiveProfileReport(
  input: EffectiveProfileReport
): EffectiveProfileReport {
  const report = validateProfileReportEnvelope(input)
  if (sha256(readFileSync(report.profile.path)) !== report.profile.sha256)
    fail('PROFILE_BYTES_SHA_MISMATCH', report.profile.path)
  const installedIdentity = readInstalledProfileIdentity(report.profile.path)
  if (
    report.ownerTaskId !== installedIdentity.ownerTaskId ||
    report.transitionId !== installedIdentity.transitionId
  )
    fail(
      'PROFILE_OWNER_TRANSITION_READBACK_MISMATCH',
      `${report.ownerTaskId}:${report.transitionId}`
    )
  const installedTopology = readInstalledProfileResourceTopology(report.profile.path)
  if (report.resourceTopology === undefined)
    fail('V2_PROFILE_REPORT_TOPOLOGY_MISSING', report.ownerTaskId)
  else if (canonicalJson(report.resourceTopology) !== canonicalJson(installedTopology))
    fail('PROFILE_RESOURCE_TOPOLOGY_READBACK_MISMATCH', report.ownerTaskId)
  const declared = new Set(report.declaredCapabilities)
  const observed = new Map<CapabilityName, CapabilityObservation>()
  for (const observation of report.observations) {
    if (!CAPABILITY_NAMES.includes(observation.name)) fail('UNKNOWN_CAPABILITY', observation.name)
    if (observed.has(observation.name)) fail('DUPLICATE_CAPABILITY_OBSERVATION', observation.name)
    verifyObservationEvidence(observation)
    observed.set(observation.name, observation)
  }
  for (const capability of declared) {
    const observation = observed.get(capability)
    if (!observation) fail('CAPABILITY_OBSERVATION_MISSING', capability)
    if (observation.exitCode !== 0 || observation.result !== 'PASS')
      fail('DECLARED_CAPABILITY_FAILED', `${capability}: ${observation.literalOutput}`)
  }
  if (observed.size !== declared.size)
    fail('UNDECLARED_CAPABILITY_OBSERVATION', String(observed.size))
  const credentialKeys = [...report.credentialReference.keys].sort()
  const credentialExtras = Object.keys(report.credentialReference).filter(
    (key) => !['reference', 'keys', 'secretValuesRecorded'].includes(key)
  )
  if (
    credentialExtras.length ||
    report.credentialReference.secretValuesRecorded !== false ||
    canonicalJson(credentialKeys) !== canonicalJson(['password', 'username'])
  )
    fail('CREDENTIAL_REFERENCE_INVALID', report.credentialReference.reference)
  let telemetryExpectation: ApprovalTelemetryExpectation | undefined
  let reconstructedRequest: PreflightRequest | undefined
  let prepared: PreparedProfilePreflight | undefined
  if (report.schemaVersion === 2) {
    if (
      !report.approvalMode ||
      !report.launchReceipt ||
      !report.effectivePermissionSandboxFingerprint ||
      !report.probeAttempt
    )
      fail('PROFILE_V2_BINDING_REQUIRED', report.ownerTaskId)
    const receipt = loadProfileLaunchReceipt(report.launchReceipt)
    const installedPolicy = readInstalledProfilePolicy(report.profile.path)
    if (
      receipt.ownerTaskId !== report.ownerTaskId ||
      receipt.transitionId !== report.transitionId ||
      receipt.approvalMode !== report.approvalMode ||
      receipt.installedProfile.path !== report.profile.path ||
      receipt.installedProfile.sha256 !== report.profile.sha256 ||
      receipt.expectedEffectivePermissionSandboxFingerprint !==
        report.effectivePermissionSandboxFingerprint ||
      installedPolicy.approvalMode !== report.approvalMode ||
      installedPolicy.expectedEffectivePermissionSandboxFingerprint !==
        report.effectivePermissionSandboxFingerprint ||
      canonicalJson(receipt.resourceTopology) !== canonicalJson(installedTopology)
    )
      fail('PROFILE_V2_INSTALLED_LAUNCH_EFFECTIVE_DRIFT', report.ownerTaskId)
    reconstructedRequest = {
      ownerTaskId: report.ownerTaskId,
      transitionId: report.transitionId,
      approvalMode: report.approvalMode,
      launchReceipt: report.launchReceipt,
      expectedState: report.expectedState,
      declaredCapabilities: report.declaredCapabilities,
      profile: report.profile,
      resultPath: ''
    }
    prepared = prepareProfilePreflight(reconstructedRequest)
    if (canonicalJson(report.probeAttempt) !== canonicalJson(prepared.probeAttemptReference))
      fail('PROFILE_V2_CURRENT_PROBE_ATTEMPT_MISMATCH', report.ownerTaskId)
    telemetryExpectation = prepared.telemetryExpectation
  }
  const actualTelemetry = readApprovalTelemetry(report.telemetry.eventSource, telemetryExpectation)
  if (report.schemaVersion === 2 && telemetryExpectation && reconstructedRequest && prepared) {
    const reference = report.telemetry.snapshotRecord
    if (
      !reference ||
      !report.telemetry.probeAttemptId ||
      !report.telemetry.probeDraftFingerprint ||
      !report.telemetry.probeRequestFingerprint ||
      !report.telemetry.rolloutSessionId ||
      !report.telemetry.completedTurnId ||
      !report.launchReceipt ||
      !report.approvalMode
    )
      fail('PROFILE_V2_TELEMETRY_SNAPSHOT_BINDING_REQUIRED', report.ownerTaskId)
    const snapshot = loadApprovalTelemetrySnapshotRecord(
      reconstructedRequest,
      {
        draftFingerprint: report.telemetry.probeDraftFingerprint,
        requestFingerprint: report.telemetry.probeRequestFingerprint
      },
      prepared
    )
    const record = snapshot.record
    if (
      canonicalJson(reference) !== canonicalJson(snapshot.reference) ||
      report.telemetry.probeAttemptId !== prepared.probeAttempt.probeAttemptId
    )
      fail('PROFILE_V2_TELEMETRY_SNAPSHOT_BINDING_MISMATCH', report.ownerTaskId)
    Object.assign(actualTelemetry, {
      snapshotRecord: reference,
      probeAttemptId: record.probeAttemptId,
      probeDraftFingerprint: record.probeDraftFingerprint,
      probeRequestFingerprint: record.probeRequestFingerprint,
      rolloutSessionId: record.rolloutSessionId,
      completedTurnId: record.completedTurnId
    })
  }
  const telemetryExtras = Object.keys(report.telemetry).filter(
    (key) =>
      !(
        report.schemaVersion === 2
          ? [
              'eventSource',
              'eventSourceSha256',
              'eventSourceFingerprint',
              'approvalPolicy',
              'approvalsReviewer',
              'approvalEventCount',
              'normalPermissionPromptCount',
              'approvalMode',
              'effectivePermissionSandboxFingerprint',
              'contexts',
              'snapshotRecord',
              'probeAttemptId',
              'probeDraftFingerprint',
              'probeRequestFingerprint',
              'rolloutSessionId',
              'completedTurnId'
            ]
          : [
              'eventSource',
              'eventSourceSha256',
              'approvalPolicy',
              'approvalsReviewer',
              'approvalEventCount',
              'normalPermissionPromptCount'
            ]
      ).includes(key)
  )
  if (
    telemetryExtras.length ||
    canonicalJson(actualTelemetry) !== canonicalJson(report.telemetry) ||
    report.telemetry.normalPermissionPromptCount !== 0
  )
    fail('APPROVAL_TELEMETRY_INVALID', String(report.telemetry.normalPermissionPromptCount))
  return report
}

/** Proves the current owner process cannot replace the installed profile or its trust directory. */
function requireProfileReadOnlyControl(profilePath: string, authorizationRoot: string): void {
  assertPathWithin(dirname(profilePath), authorizationRoot)
  assertPathWithin(realpathSync(dirname(profilePath)), realpathSync(authorizationRoot))
  let fileWritable = false
  try {
    const fd = openSync(profilePath, constants.O_WRONLY | constants.O_APPEND)
    closeSync(fd)
    fileWritable = true
  } catch {}
  if (fileWritable) fail('INSTALLED_PROFILE_CALLER_WRITABLE', profilePath)

  let metadataWritable = false
  try {
    chmodSync(profilePath, statSync(profilePath).mode)
    metadataWritable = true
  } catch {}
  if (metadataWritable) fail('INSTALLED_PROFILE_CALLER_CONTROLLED', profilePath)

  const probe = join(dirname(profilePath), `.oes-runtime-trust-probe-${process.pid}`)
  let directoryWritable = false
  try {
    const fd = openSync(probe, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    closeSync(fd)
    directoryWritable = true
  } catch {}
  if (directoryWritable) {
    try {
      unlinkSync(probe)
    } catch {}
    fail('INSTALLED_PROFILE_DIRECTORY_CALLER_WRITABLE', dirname(profilePath))
  }

  const authorizationProbe = join(
    authorizationRoot,
    `.oes-authorization-write-probe-${process.pid}`
  )
  let authorizationWritable = false
  try {
    const fd = openSync(
      authorizationProbe,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    )
    closeSync(fd)
    authorizationWritable = true
  } catch {}
  if (authorizationWritable) {
    try {
      unlinkSync(authorizationProbe)
    } catch {}
    fail('AUTHORIZATION_ROOT_CALLER_WRITABLE', authorizationRoot)
  }

  let authorizationMetadataWritable = false
  try {
    chmodSync(authorizationRoot, statSync(authorizationRoot).mode)
    authorizationMetadataWritable = true
  } catch {}
  if (authorizationMetadataWritable) fail('AUTHORIZATION_ROOT_CALLER_CONTROLLED', authorizationRoot)
}

/** Loads remote trust roots only from a hash-verified installed effective profile. */
export function loadRemoteTrustRootsFromProfileReport(
  input: EffectiveProfileReport
): RemoteTrustRoots {
  const report = verifyEffectiveProfileReport(input)
  const installedTopology = readInstalledProfileResourceTopology(report.profile.path)
  if (
    report.expectedState !== 'DELIVERY_ACTIVE' ||
    canonicalJson([...report.declaredCapabilities].sort()) !==
      canonicalJson([...CAPABILITY_NAMES].sort())
  )
    fail('REMOTE_RUNTIME_PROFILE_NOT_FULLY_ACCEPTED', report.ownerTaskId)
  const profileText = readFileSync(report.profile.path, 'utf8')
  let section = ''
  const collaboration = new Map<string, string>()
  const permissions = new Map<string, string>()
  for (const rawLine of profileText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1]
      continue
    }
    const assignment =
      /^("(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")$/.exec(line)
    if (!assignment) continue
    const key = assignment[1].startsWith('"') ? JSON.parse(assignment[1]) : assignment[1]
    const value = JSON.parse(assignment[2]) as string
    if (section === 'collaboration_runtime') {
      if (collaboration.has(key)) fail('DUPLICATE_RUNTIME_TRUST_SETTING', key)
      collaboration.set(key, value)
    }
    if (section.endsWith('.filesystem')) permissions.set(key, value)
  }
  const authorizationRoot = collaboration.get('trusted_authorization_root') ?? ''
  const admissionRoot = collaboration.get('serial_admission_root') ?? ''
  const projectKey = collaboration.get('project_key') ?? ''
  const installedIdentity = readInstalledProfileIdentity(report.profile.path)
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(projectKey) ||
    !isAbsolute(authorizationRoot) ||
    !isAbsolute(admissionRoot)
  )
    fail('INSTALLED_RUNTIME_TRUST_ROOT_INVALID', report.profile.path)
  if (
    authorizationRoot === admissionRoot ||
    permissions.get(authorizationRoot) !== 'read' ||
    permissions.get(admissionRoot) !== 'write'
  )
    fail('INSTALLED_RUNTIME_TRUST_PERMISSION_INVALID', report.profile.path)
  if (profileText.includes(`${JSON.stringify(authorizationRoot)} = true`))
    fail('AUTHORIZATION_ROOT_MUST_NOT_BE_WORKSPACE_ROOT', authorizationRoot)
  requireProfileReadOnlyControl(report.profile.path, authorizationRoot)
  return {
    projectKey,
    authorizationRoot,
    admissionRoot,
    profilePath: report.profile.path,
    profileSha256: report.profile.sha256,
    ownerTaskId: installedIdentity.ownerTaskId,
    profileTransitionId: installedIdentity.transitionId,
    profileExpectedState: report.expectedState,
    resourceTopologyVersion: installedTopology.resourceTopologyVersion,
    ownerResourceBinding: installedTopology.ownerResourceBinding
  }
}

/** Reopens the issuer-controlled current probe-attempt pointer at its profile-derived path. */
function loadCurrentProfileProbeAttempt(
  request: PreflightRequest,
  trustedAuthorizationRoot: string
): {
  record: ProfileProbeAttemptRecord
  reference: TrustedAuthorizationReference
} {
  const path = join(trustedAuthorizationRoot, CURRENT_PROFILE_PROBE_ATTEMPT)
  const bytes = readFileSync(path)
  const untrusted = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  const fingerprint = String(untrusted.probeAttemptFingerprint ?? '')
  const reference = { path, sha256: sha256(bytes), fingerprint }
  const raw = verifyTrustedReference(reference, trustedAuthorizationRoot, 'probeAttemptFingerprint')
  const keys = [
    'schemaVersion',
    'kind',
    'probeAttemptFingerprint',
    'status',
    'issuedBeforeProbe',
    'issuerTaskId',
    'ownerTaskId',
    'transitionId',
    'profileGeneration',
    'launchReceiptFingerprint',
    'probeAttemptId',
    'expectedRolloutSessionId',
    'requestContractFingerprint',
    'snapshotRecordPath'
  ]
  if (canonicalJson(Object.keys(raw).sort()) !== canonicalJson(keys.sort()))
    fail('PROFILE_PROBE_ATTEMPT_FIELDS_INVALID', path)
  const record = raw as unknown as ProfileProbeAttemptRecord
  const receipt = loadProfileLaunchReceipt(request.launchReceipt)
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'OES_PROFILE_PROBE_ATTEMPT' ||
    record.status !== 'ISSUED' ||
    record.issuedBeforeProbe !== true ||
    typeof record.issuerTaskId !== 'string' ||
    !record.issuerTaskId.trim() ||
    typeof record.probeAttemptId !== 'string' ||
    !PROBE_ATTEMPT_ID.test(record.probeAttemptId) ||
    typeof record.expectedRolloutSessionId !== 'string' ||
    !record.expectedRolloutSessionId.trim() ||
    record.ownerTaskId !== request.ownerTaskId ||
    record.transitionId !== request.transitionId ||
    record.profileGeneration !== receipt.profileGeneration ||
    record.launchReceiptFingerprint !== receipt.receiptFingerprint ||
    record.requestContractFingerprint !== profilePreflightRequestContractFingerprint(request) ||
    record.snapshotRecordPath !==
      join(
        trustedAuthorizationRoot,
        'profile-probe-attempts',
        record.probeAttemptId,
        'snapshot-record.json'
      )
  )
    fail('PROFILE_PROBE_ATTEMPT_BINDING_MISMATCH', path)
  return { record, reference }
}

/** Reopens launch and current-attempt bindings and derives the telemetry expectation. */
function prepareProfilePreflight(request: PreflightRequest): PreparedProfilePreflight {
  const receipt = loadProfileLaunchReceipt(request.launchReceipt)
  const runtimeAuthority = readInstalledProfileRuntimeAuthority(request.profile.path)
  if (
    receipt.ownerTaskId !== request.ownerTaskId ||
    receipt.transitionId !== request.transitionId ||
    receipt.approvalMode !== request.approvalMode ||
    receipt.installedProfile.path !== request.profile.path ||
    receipt.installedProfile.sha256 !== request.profile.sha256
  )
    fail('PROFILE_PREFLIGHT_LAUNCH_BINDING_MISMATCH', request.ownerTaskId)
  const currentAttempt = loadCurrentProfileProbeAttempt(
    request,
    runtimeAuthority.trustedAuthorizationRoot
  )
  return {
    telemetryExpectation: {
      approvalMode: request.approvalMode,
      expectedEffectivePermissionSandboxFingerprint:
        receipt.expectedEffectivePermissionSandboxFingerprint,
      expectedActivePermissionProfileId: runtimeAuthority.defaultPermissionProfileId,
      trustedAuthorizationRoot: runtimeAuthority.trustedAuthorizationRoot
    },
    probeAttempt: currentAttempt.record,
    probeAttemptReference: currentAttempt.reference
  }
}

/** Reopens the issuer record that binds one exact probe draft to one completed rollout snapshot. */
function loadApprovalTelemetrySnapshotRecord(
  request: PreflightRequest,
  binding: { draftFingerprint: string; requestFingerprint: string },
  prepared: PreparedProfilePreflight
): {
  record: ApprovalTelemetrySnapshotRecord
  reference: TrustedAuthorizationReference
} {
  const path = prepared.probeAttempt.snapshotRecordPath
  const bytes = readFileSync(path)
  const untrusted = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  const reference = {
    path,
    sha256: sha256(bytes),
    fingerprint: String(untrusted.snapshotRecordFingerprint ?? '')
  }
  const raw = verifyTrustedReference(
    reference,
    prepared.telemetryExpectation.trustedAuthorizationRoot,
    'snapshotRecordFingerprint'
  )
  const keys = [
    'schemaVersion',
    'kind',
    'snapshotRecordFingerprint',
    'ownerTaskId',
    'transitionId',
    'profileGeneration',
    'launchReceiptFingerprint',
    'probeAttemptFingerprint',
    'probeAttemptId',
    'probeDraftFingerprint',
    'probeRequestFingerprint',
    'rolloutSessionId',
    'completedTurnId',
    'snapshot'
  ]
  if (canonicalJson(Object.keys(raw).sort()) !== canonicalJson(keys.sort()))
    fail('APPROVAL_TELEMETRY_SNAPSHOT_RECORD_FIELDS_INVALID', reference.path)
  const record = raw as unknown as ApprovalTelemetrySnapshotRecord
  const receipt = loadProfileLaunchReceipt(request.launchReceipt)
  if (
    typeof record.rolloutSessionId !== 'string' ||
    typeof record.completedTurnId !== 'string' ||
    !record.snapshot ||
    typeof record.snapshot.path !== 'string' ||
    typeof record.snapshot.sha256 !== 'string' ||
    typeof record.snapshot.fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(record.snapshot.sha256) ||
    !/^[0-9a-f]{64}$/u.test(record.snapshot.fingerprint) ||
    record.schemaVersion !== 1 ||
    record.kind !== 'OES_APPROVAL_TELEMETRY_SNAPSHOT_RECORD' ||
    record.ownerTaskId !== request.ownerTaskId ||
    record.transitionId !== request.transitionId ||
    record.profileGeneration !== receipt.profileGeneration ||
    record.launchReceiptFingerprint !== receipt.receiptFingerprint ||
    record.probeAttemptFingerprint !== prepared.probeAttempt.probeAttemptFingerprint ||
    record.probeAttemptId !== prepared.probeAttempt.probeAttemptId ||
    record.probeDraftFingerprint !== binding.draftFingerprint ||
    record.probeRequestFingerprint !== binding.requestFingerprint ||
    record.probeRequestFingerprint !==
      profilePreflightRequestFingerprint(request, prepared.probeAttempt.probeAttemptFingerprint) ||
    record.rolloutSessionId !== prepared.probeAttempt.expectedRolloutSessionId
  )
    fail('APPROVAL_TELEMETRY_SNAPSHOT_RECORD_BINDING_MISMATCH', reference.path)
  if (!record.rolloutSessionId.trim() || !record.completedTurnId.trim())
    fail('APPROVAL_TELEMETRY_SNAPSHOT_IDENTITY_REQUIRED', reference.path)
  if (
    !record.snapshot ||
    canonicalJson(Object.keys(record.snapshot).sort()) !==
      canonicalJson(['path', 'sha256', 'fingerprint'].sort())
  )
    fail('APPROVAL_TELEMETRY_SNAPSHOT_REFERENCE_INVALID', reference.path)
  const trusted = readTrustedTelemetrySource(
    record.snapshot.path,
    prepared.telemetryExpectation.trustedAuthorizationRoot
  )
  if (
    sha256(trusted.bytes) !== record.snapshot.sha256 ||
    trusted.fingerprint !== record.snapshot.fingerprint
  )
    fail('APPROVAL_TELEMETRY_SNAPSHOT_REFERENCE_MISMATCH', record.snapshot.path)
  verifyTelemetrySnapshotIdentity(trusted.bytes, record.rolloutSessionId, record.completedTurnId)
  return { record, reference }
}

/** Reopens and validates one exact completed probe phase before telemetry finalization. */
function loadEffectiveProfileProbeDraft(
  draftPath: string,
  request: PreflightRequest,
  probeAttempt: ProfileProbeAttemptRecord
): EffectiveProfileProbeDraft {
  const draft = readJson<EffectiveProfileProbeDraft>(draftPath)
  const keys = [
    'schemaVersion',
    'kind',
    'draftFingerprint',
    'requestFingerprint',
    'probeAttemptFingerprint',
    'probeAttemptId',
    'ownerTaskId',
    'transitionId',
    'declaredCapabilities',
    'observations',
    'credentialReference'
  ]
  if (
    !draft ||
    typeof draft !== 'object' ||
    canonicalJson(Object.keys(draft).sort()) !== canonicalJson(keys.sort()) ||
    draft.schemaVersion !== 1 ||
    draft.kind !== 'OES_EFFECTIVE_PROFILE_PROBE_DRAFT' ||
    draft.draftFingerprint !==
      objectFingerprint(draft as unknown as Record<string, unknown>, 'draftFingerprint') ||
    draft.requestFingerprint !==
      profilePreflightRequestFingerprint(request, probeAttempt.probeAttemptFingerprint) ||
    draft.probeAttemptFingerprint !== probeAttempt.probeAttemptFingerprint ||
    draft.probeAttemptId !== probeAttempt.probeAttemptId ||
    draft.ownerTaskId !== request.ownerTaskId ||
    draft.transitionId !== request.transitionId ||
    canonicalJson(draft.declaredCapabilities) !== canonicalJson(request.declaredCapabilities)
  )
    fail('PROFILE_PROBE_DRAFT_BINDING_INVALID', draftPath)
  const expected = request.declaredCapabilities.filter((name) => name !== 'approvalTelemetry')
  if (
    canonicalJson(draft.observations.map(({ name }) => name)) !== canonicalJson(expected) ||
    draft.observations.some(({ name }) => name === 'approvalTelemetry')
  )
    fail('PROFILE_PROBE_DRAFT_CAPABILITIES_INVALID', draftPath)
  for (const observation of draft.observations) {
    verifyObservationEvidence(observation)
    if (observation.exitCode !== 0 || observation.result !== 'PASS')
      fail('PROFILE_PROBE_DRAFT_CAPABILITY_FAILED', observation.name)
  }
  return draft
}

/** Executes all non-telemetry capabilities in the target turn and seals a resumable draft. */
export async function runEffectiveProfileProbePhase(
  request: PreflightRequest,
  adapter: PreflightProbeAdapter,
  draftPath: string
): Promise<EffectiveProfileProbeDraft> {
  const prepared = prepareProfilePreflight(request)
  const observations: CapabilityObservation[] = []
  for (const capability of request.declaredCapabilities) {
    if (capability !== 'approvalTelemetry') observations.push(await adapter.observe(capability))
  }
  const draft: EffectiveProfileProbeDraft = {
    schemaVersion: 1,
    kind: 'OES_EFFECTIVE_PROFILE_PROBE_DRAFT',
    draftFingerprint: '',
    requestFingerprint: profilePreflightRequestFingerprint(
      request,
      prepared.probeAttempt.probeAttemptFingerprint
    ),
    probeAttemptFingerprint: prepared.probeAttempt.probeAttemptFingerprint,
    probeAttemptId: prepared.probeAttempt.probeAttemptId,
    ownerTaskId: request.ownerTaskId,
    transitionId: request.transitionId,
    declaredCapabilities: [...request.declaredCapabilities],
    observations,
    credentialReference: await adapter.credentialReference()
  }
  draft.draftFingerprint = objectFingerprint(
    draft as unknown as Record<string, unknown>,
    'draftFingerprint'
  )
  writeJsonAtomic(draftPath, draft)
  return loadEffectiveProfileProbeDraft(draftPath, request, prepared.probeAttempt)
}

/** Finalizes an earlier target-turn probe after the issuer seals that completed turn's telemetry. */
export async function finalizeEffectiveProfilePreflight(
  request: PreflightRequest,
  adapter: PreflightProbeAdapter,
  draftPath: string
): Promise<EffectiveProfileReport> {
  const prepared = prepareProfilePreflight(request)
  const telemetryExpectation = prepared.telemetryExpectation
  const draft = loadEffectiveProfileProbeDraft(draftPath, request, prepared.probeAttempt)
  const snapshot = loadApprovalTelemetrySnapshotRecord(
    request,
    { draftFingerprint: draft.draftFingerprint, requestFingerprint: draft.requestFingerprint },
    prepared
  )
  const snapshotRecord = snapshot.record
  const telemetryEventSource = snapshotRecord.snapshot.path
  const observations = [...draft.observations]
  if (request.declaredCapabilities.includes('approvalTelemetry'))
    observations.push(
      await adapter.observe('approvalTelemetry', telemetryExpectation, telemetryEventSource)
    )
  const telemetry = await adapter.approvalTelemetry(telemetryExpectation, telemetryEventSource)
  Object.assign(telemetry, {
    snapshotRecord: snapshot.reference,
    probeAttemptId: prepared.probeAttempt.probeAttemptId,
    probeDraftFingerprint: draft.draftFingerprint,
    probeRequestFingerprint: draft.requestFingerprint,
    rolloutSessionId: snapshotRecord.rolloutSessionId,
    completedTurnId: snapshotRecord.completedTurnId
  })
  const report: EffectiveProfileReport = {
    schemaVersion: 2,
    kind: 'OES_EFFECTIVE_PROFILE_REPORT',
    ownerTaskId: request.ownerTaskId,
    transitionId: request.transitionId,
    expectedState: request.expectedState,
    declaredCapabilities: [...request.declaredCapabilities],
    profile: request.profile,
    observations,
    credentialReference: draft.credentialReference,
    telemetry,
    resourceTopology: readInstalledProfileResourceTopology(request.profile.path),
    approvalMode: request.approvalMode,
    launchReceipt: request.launchReceipt,
    probeAttempt: prepared.probeAttemptReference,
    effectivePermissionSandboxFingerprint:
      telemetryExpectation.expectedEffectivePermissionSandboxFingerprint
  }
  verifyEffectiveProfileReport(report)
  writeJsonAtomic(request.resultPath, report)
  return verifyEffectiveProfileReport(report)
}

/** Executes the canonical harmless capability smoke with literal persisted evidence. */
export class SystemPreflightProbeAdapter implements PreflightProbeAdapter {
  readonly options: Required<Omit<SystemProbeOptions, 'telemetryEventSource'>> &
    Pick<SystemProbeOptions, 'telemetryEventSource'>
  private credentialKeys: string[] | null = null

  constructor(options: SystemProbeOptions) {
    this.options = { ...options, git: options.git ?? 'git', node: options.node ?? process.execPath }
  }

  async observe(
    name: CapabilityName,
    telemetryExpectation?: ApprovalTelemetryExpectation,
    telemetryEventSource?: string
  ): Promise<CapabilityObservation> {
    await mkdir(this.options.smokeRoot, { recursive: true })
    try {
      let command = ''
      let literalOutput = ''
      if (name === 'filesystemWrite') {
        const path = join(this.options.smokeRoot, 'filesystem-probe.txt')
        command = `write-read ${path}`
        await writeFile(path, 'OES_PROFILE_FILESYSTEM_PASS\n')
        literalOutput = readFileSync(path, 'utf8').trim()
      } else if (name === 'gitSwitchAddCommit') {
        const clone = await mkdtemp(join(this.options.smokeRoot, 'git-probe-'))
        command = 'git init; switch; add; commit'
        this.run(this.options.git, ['init'], clone)
        this.run(this.options.git, ['switch', '-c', 'codex/runtime-profile-probe'], clone)
        this.run(this.options.git, ['config', 'user.name', 'OES Runtime Probe'], clone)
        this.run(this.options.git, ['config', 'user.email', 'runtime-probe@oes.local'], clone)
        writeFileSync(join(clone, 'runtime-profile-probe.txt'), 'probe\n')
        this.run(this.options.git, ['add', 'runtime-profile-probe.txt'], clone)
        this.run(this.options.git, ['commit', '-m', 'test: runtime profile git probe'], clone)
        literalOutput = `commit=${this.run(this.options.git, ['rev-parse', 'HEAD'], clone).trim()};status=${JSON.stringify(this.run(this.options.git, ['status', '--porcelain'], clone))}`
      } else if (name === 'standardBuildTest') {
        command = 'node tsc --noEmit; node profile-preflight.unit.spec.ts; node ci.static.check.mjs'
        const outputs = [
          this.run(
            this.options.node,
            [
              'node_modules/typescript/bin/tsc',
              '-p',
              'scripts/collaboration-runtime/tsconfig.json',
              '--noEmit'
            ],
            this.options.repositoryRoot
          ),
          this.run(
            this.options.node,
            [
              '--experimental-strip-types',
              '--test',
              'scripts/collaboration-runtime/src/__tests__/profile-preflight.unit.spec.ts'
            ],
            this.options.repositoryRoot
          ),
          this.run(
            this.options.node,
            ['--test', 'scripts/collaboration-runtime/test/static/ci.static.check.mjs'],
            this.options.repositoryRoot
          )
        ]
        literalOutput = outputs.map((output) => output.trim()).join('\n---\n')
      } else if (name === 'taskOwnedDatabase') {
        const path = join(this.options.smokeRoot, 'profile-probe.sqlite')
        command = `node:sqlite task-owned ${path}`
        const db = new DatabaseSync(path)
        db.exec("CREATE TABLE probe(value TEXT NOT NULL); INSERT INTO probe VALUES ('PASS')")
        literalOutput = String(
          (db.prepare('SELECT value FROM probe').get() as { value: string }).value
        )
        db.close()
      } else if (name === 'localhostBind') {
        command = 'listen 127.0.0.1:0'
        literalOutput = await new Promise<string>((resolve, reject) => {
          const server = createServer()
          server.once('error', reject)
          server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            server.close((error) =>
              error
                ? reject(error)
                : resolve(`127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
            )
          })
        })
      } else if (name === 'approvedNetworkRead') {
        command = 'git ls-remote --heads origin refs/heads/main'
        literalOutput = this.run(
          this.options.git,
          ['ls-remote', '--heads', 'origin', 'refs/heads/main'],
          this.options.repositoryRoot
        ).trim()
      } else if (name === 'credentialReference') {
        command = 'git credential fill (keys only)'
        this.credentialKeys = this.readCredentialKeys()
        literalOutput = `keys=${this.credentialKeys.join(',')};valuesRecorded=false`
      } else {
        const eventSource = this.telemetryEventSource(telemetryEventSource)
        command = `read telemetry ${eventSource}`
        if (!telemetryExpectation) fail('PROFILE_V2_TELEMETRY_EXPECTATION_REQUIRED', name)
        const telemetry = readApprovalTelemetry(eventSource, telemetryExpectation)
        literalOutput = `policy=${telemetry.approvalPolicy};reviewer=${telemetry.approvalsReviewer};normalPermissionPromptCount=${telemetry.normalPermissionPromptCount}`
      }
      return this.persistObservation({ name, command, literalOutput, exitCode: 0, result: 'PASS' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.persistObservation({
        name,
        command: `probe ${name}`,
        literalOutput: message,
        exitCode: 1,
        result: 'FAIL'
      })
    }
  }

  async credentialReference(): Promise<EffectiveProfileReport['credentialReference']> {
    const keys = this.credentialKeys ?? this.readCredentialKeys()
    return { reference: 'git-credential:https://github.com', keys, secretValuesRecorded: false }
  }

  async approvalTelemetry(
    expectation: ApprovalTelemetryExpectation,
    telemetryEventSource?: string
  ): Promise<ApprovalTelemetry> {
    return readApprovalTelemetry(this.telemetryEventSource(telemetryEventSource), expectation)
  }

  /** Resolves telemetry only from the finalizer-supplied issuer record in production. */
  private telemetryEventSource(explicit?: string): string {
    const eventSource = explicit ?? this.options.telemetryEventSource
    if (!eventSource) fail('APPROVAL_TELEMETRY_SOURCE_REQUIRED', this.options.smokeRoot)
    return eventSource
  }

  /** Executes one exact subprocess and returns combined non-secret output. */
  private run(command: string, args: string[], cwd: string): string {
    const result = spawnSync(
      '/bin/sh',
      ['-c', 'exec "$@"', 'oes-profile-command', command, ...args],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const literalOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    if (result.status !== 0)
      throw new Error(`${command} ${args.join(' ')} [${result.status ?? 1}] ${literalOutput}`)
    return `${result.stdout ?? ''}${result.stderr ?? ''}`
  }

  /** Keeps credential values inside a POSIX child shell and returns only approved reference keys. */
  private readCredentialKeys(): string[] {
    const result = spawnSync(
      '/bin/sh',
      [
        '-c',
        `credential_output=$(printf 'protocol=https\\nhost=github.com\\n\\n' | "$1" credential fill 2>/dev/null) || exit $?
printf '%s\\n' "$credential_output" | sed 's/=.*//'`,
        'oes-credential-probe',
        this.options.git
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    if (result.status !== 0) throw new Error(`git credential fill [${result.status ?? 1}]`)
    return credentialReferenceKeys(result.stdout ?? '')
  }

  /** Writes and hashes one literal observation before returning it. */
  private persistObservation(
    base: Omit<CapabilityObservation, 'evidencePath' | 'evidenceSha256'>
  ): CapabilityObservation {
    const evidencePath = join(this.options.smokeRoot, `${base.name}.json`)
    const bytes = `${canonicalJson(base)}\n`
    writeFileSync(evidencePath, bytes, { mode: 0o600 })
    return { ...base, evidencePath, evidenceSha256: sha256(bytes) }
  }
}

/** Provides the full default capability set used by root delivery handoff smoke. */
export function defaultDeliveryCapabilities(): CapabilityName[] {
  return [...CAPABILITY_NAMES]
}

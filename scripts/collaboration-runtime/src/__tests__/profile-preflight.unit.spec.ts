import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  canonicalJson,
  objectFingerprint,
  readJson,
  sha256,
  writeJsonAtomic
} from '../canonical.ts'
import { validateJsonSchema } from '../schema-validation.ts'
import {
  classifyCapabilityIssue,
  credentialReferenceKeys,
  defaultDeliveryCapabilities,
  effectivePermissionSandboxFingerprint,
  finalizeEffectiveProfilePreflight,
  loadRemoteTrustRootsFromProfileReport,
  planProfileRepair,
  profilePreflightRequestContractFingerprint,
  readApprovalTelemetry,
  runEffectiveProfileProbePhase,
  SystemPreflightProbeAdapter,
  verifyEffectiveProfileReport,
  type ApprovalTelemetryExpectation,
  type PreflightProbeAdapter
} from '../profile-preflight.ts'
import {
  approvalPair,
  renderOwnerProfileLaunch,
  type OwnerProfileRenderRequest,
  type OwnerProfileRenderResult
} from '../profile-policy.ts'
import type {
  ApprovalMode,
  ApprovalTelemetry,
  ApprovalTelemetrySnapshotRecord,
  CapabilityName,
  CapabilityObservation,
  EffectiveProfileReport,
  ProfileLaunchReceipt,
  ProfileProbeAttemptRecord,
  TrustedAuthorizationReference
} from '../types.ts'
import type { EffectiveProfileProbeDraft, PreflightRequest } from '../profile-preflight.ts'

const effectiveProfileSchema = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'schemas', 'effective-profile-report.schema.json'),
    'utf8'
  )
) as Record<string, unknown>
const profileLaunchReceiptSchema = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'schemas', 'profile-launch-receipt.schema.json'),
    'utf8'
  )
) as Record<string, unknown>

class PassingProbe implements PreflightProbeAdapter {
  readonly root: string
  readonly telemetryPath: string

  constructor(root: string, telemetryPath: string) {
    this.root = root
    this.telemetryPath = telemetryPath
  }

  async observe(name: CapabilityName): Promise<CapabilityObservation> {
    const base = {
      name,
      command: `probe ${name}`,
      literalOutput: 'PASS',
      exitCode: 0,
      result: 'PASS' as const
    }
    const evidencePath = join(this.root, `${name}.json`)
    const bytes = `${canonicalJson(base)}\n`
    writeFileSync(evidencePath, bytes)
    return { ...base, evidencePath, evidenceSha256: sha256(bytes) }
  }

  async credentialReference(): Promise<EffectiveProfileReport['credentialReference']> {
    return {
      reference: 'git-credential:https://github.com',
      keys: ['username', 'password'],
      secretValuesRecorded: false
    }
  }

  async approvalTelemetry(
    expectation: ApprovalTelemetryExpectation,
    telemetryEventSource?: string
  ): Promise<ApprovalTelemetry> {
    return readApprovalTelemetry(telemetryEventSource ?? this.telemetryPath, expectation)
  }
}

const MANAGED_PERMISSION = {
  permission_profile: {
    type: 'managed',
    name: 'oes-project-owner',
    file_system: { type: 'restricted', entries: [] },
    network: 'restricted'
  },
  sandbox_policy: { type: 'workspace-write' },
  file_system_sandbox_policy: { kind: 'restricted', entries: [] },
  active_permission_profile: { id: 'oes-project-owner' }
}

/** Returns the mode-independent managed/restricted permission fingerprint used by fixtures. */
function managedFingerprint(): string {
  return effectivePermissionSandboxFingerprint(MANAGED_PERMISSION)
}

/** Returns the complete v2 expectation bound to one issuer-owned telemetry root. */
function approvalExpectation(
  trustedAuthorizationRoot: string,
  approvalMode: ApprovalMode = 'ON_REQUEST_AUTO_REVIEW'
): ApprovalTelemetryExpectation {
  return {
    approvalMode,
    expectedEffectivePermissionSandboxFingerprint: managedFingerprint(),
    expectedActivePermissionProfileId: 'oes-project-owner',
    trustedAuthorizationRoot
  }
}

/** Persists complete rollout contexts for one closed approval mode. */
function telemetry(root: string, approvalMode: ApprovalMode = 'ON_REQUEST_AUTO_REVIEW'): string {
  const path = join(root, 'rollout.jsonl')
  const pair = approvalPair(approvalMode)
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-1', session_id: 'session-1' }
      }),
      JSON.stringify({
        ordinal: 1,
        type: 'turn_context',
        payload: {
          turn_id: 'turn-2',
          approval_policy: pair.approvalPolicy,
          approvals_reviewer: pair.approvalsReviewer,
          ...MANAGED_PERMISSION
        }
      }),
      JSON.stringify({
        ordinal: 2,
        type: 'turn_context',
        payload: {
          turn_id: 'turn-2',
          approval_policy: pair.approvalPolicy,
          approvals_reviewer: pair.approvalsReviewer,
          ...MANAGED_PERMISSION
        }
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-2' }
      })
    ].join('\n')
  )
  return path
}

/** Emulates the issuer's pre-probe atomic current-attempt record. */
function issueProbeAttempt(
  request: PreflightRequest,
  probeAttemptId = `attempt-${sha256(request.transitionId).slice(0, 16)}`,
  expectedRolloutSessionId = 'session-1'
): ProfileProbeAttemptRecord {
  const receipt = readJson<ProfileLaunchReceipt>(request.launchReceipt.path)
  const authorizationRoot = join(dirname(request.profile.path), 'trusted-authorizations')
  const snapshotRecordPath = join(
    authorizationRoot,
    'profile-probe-attempts',
    probeAttemptId,
    'snapshot-record.json'
  )
  mkdirSync(dirname(snapshotRecordPath), { recursive: true })
  const record: ProfileProbeAttemptRecord = {
    schemaVersion: 1,
    kind: 'OES_PROFILE_PROBE_ATTEMPT',
    probeAttemptFingerprint: '',
    status: 'ISSUED',
    issuedBeforeProbe: true,
    issuerTaskId: '/root/issuer',
    ownerTaskId: request.ownerTaskId,
    transitionId: request.transitionId,
    profileGeneration: receipt.profileGeneration,
    launchReceiptFingerprint: receipt.receiptFingerprint,
    probeAttemptId,
    expectedRolloutSessionId,
    requestContractFingerprint: profilePreflightRequestContractFingerprint(request),
    snapshotRecordPath
  }
  record.probeAttemptFingerprint = objectFingerprint(
    record as unknown as Record<string, unknown>,
    'probeAttemptFingerprint'
  )
  writeJsonAtomic(join(authorizationRoot, 'current-profile-probe-attempt.json'), record)
  return record
}

/** Emulates the external issuer by sealing one immutable draft/session/turn snapshot record. */
function sealSnapshotRecord(
  request: PreflightRequest,
  draft: EffectiveProfileProbeDraft,
  snapshotPath: string,
  rolloutSessionId = 'session-1',
  completedTurnId = 'turn-2'
): TrustedAuthorizationReference {
  const receipt = readJson<ProfileLaunchReceipt>(request.launchReceipt.path)
  const attempt = readJson<ProfileProbeAttemptRecord>(
    join(
      dirname(request.profile.path),
      'trusted-authorizations',
      'current-profile-probe-attempt.json'
    )
  )
  const snapshotSha256 = sha256(readFileSync(snapshotPath))
  const snapshot = {
    path: snapshotPath,
    sha256: snapshotSha256,
    fingerprint: sha256(
      canonicalJson({ eventSource: snapshotPath, eventSourceSha256: snapshotSha256 })
    )
  }
  const record: ApprovalTelemetrySnapshotRecord = {
    schemaVersion: 1,
    kind: 'OES_APPROVAL_TELEMETRY_SNAPSHOT_RECORD',
    snapshotRecordFingerprint: '',
    ownerTaskId: request.ownerTaskId,
    transitionId: request.transitionId,
    profileGeneration: receipt.profileGeneration,
    launchReceiptFingerprint: receipt.receiptFingerprint,
    probeAttemptFingerprint: attempt.probeAttemptFingerprint,
    probeAttemptId: attempt.probeAttemptId,
    probeDraftFingerprint: draft.draftFingerprint,
    probeRequestFingerprint: draft.requestFingerprint,
    rolloutSessionId,
    completedTurnId,
    snapshot
  }
  record.snapshotRecordFingerprint = objectFingerprint(
    record as unknown as Record<string, unknown>,
    'snapshotRecordFingerprint'
  )
  const path = attempt.snapshotRecordPath
  writeJsonAtomic(path, record)
  return {
    path,
    sha256: sha256(readFileSync(path)),
    fingerprint: record.snapshotRecordFingerprint
  }
}

/** Runs the production two-phase protocol for compact unit fixtures. */
async function runTwoPhaseFixture(
  request: PreflightRequest,
  adapter: PassingProbe
): Promise<EffectiveProfileReport> {
  const draftPath = join(
    dirname(request.resultPath),
    `draft-${request.transitionId.replace(/[^a-z0-9]/giu, '-')}.json`
  )
  issueProbeAttempt(request)
  const draft = await runEffectiveProfileProbePhase(request, adapter, draftPath)
  sealSnapshotRecord(request, draft, adapter.telemetryPath)
  return finalizeEffectiveProfilePreflight(request, adapter, draftPath)
}

/** Renders one complete v2 installed profile and launch receipt fixture. */
function renderedProfile(
  root: string,
  ownerTaskId: string,
  transitionId: string,
  approvalMode: ApprovalMode = 'ON_REQUEST_AUTO_REVIEW',
  profileGeneration = 1,
  predecessorLaunchReceipt: OwnerProfileRenderResult['launchReceipt'] | null = null
): OwnerProfileRenderResult {
  root = realpathSync(root)
  const installedRoot = join(root, 'installed')
  const values = {
    PROJECT_KEY: 'oes',
    OWNER_PATH: join(root, 'owner'),
    ARTIFACT_PATH: join(root, 'artifacts'),
    TASK_TEMP_PATH: join(root, 'task-temp'),
    REPOSITORY_ROOT: process.cwd(),
    TRUSTED_AUTHORIZATION_ROOT: join(installedRoot, 'trusted-authorizations'),
    SERIAL_ADMISSION_ROOT: join(root, 'serial-admission'),
    OWNER_GIT_DIRECTORY: join(root, 'owner', '.git'),
    USER_GIT_CONFIG: join(root, 'user.gitconfig'),
    CREDENTIAL_STORE_PATH: join(root, 'credential-store'),
    PACKAGE_CACHE_PATH: join(root, 'package-cache'),
    RESOURCE_TOPOLOGY_VERSION: 'owner-exclusive-v2',
    OWNER_RESOURCE_BINDING_PATH: '',
    OWNER_RESOURCE_BINDING_SHA256: '',
    OWNER_RESOURCE_BINDING_FINGERPRINT: ''
  }
  for (const value of [
    values.OWNER_PATH,
    values.ARTIFACT_PATH,
    values.TASK_TEMP_PATH,
    values.CREDENTIAL_STORE_PATH,
    values.TRUSTED_AUTHORIZATION_ROOT,
    values.SERIAL_ADMISSION_ROOT,
    values.PACKAGE_CACHE_PATH
  ])
    mkdirSync(value, { recursive: true })
  writeFileSync(values.USER_GIT_CONFIG, '[credential]\n\thelper =\n')
  const ownerBinding = {
    schemaVersion: 1 as const,
    kind: 'OES_OWNER_RESOURCE_BINDING' as const,
    bindingFingerprint: '',
    resourceTopologyVersion: 'owner-exclusive-v2' as const,
    ownerTaskId,
    directParentTaskId: '/root/parent',
    transitionId,
    repositoryRoot: values.OWNER_PATH,
    repositoryRemoteUrl: 'https://github.com/example/oes.git',
    ownerClone: values.OWNER_PATH,
    ownerGitDirectory: values.OWNER_GIT_DIRECTORY,
    ownerRef: 'refs/heads/codex/delivery/profile',
    artifactRoot: values.ARTIFACT_PATH,
    taskTempRoot: `/private/tmp/oes-owner-${sha256(ownerTaskId)}`,
    deliveryPackagePath: join(values.ARTIFACT_PATH, 'delivery-package.json'),
    currentEvidenceManifestPath: join(values.ARTIFACT_PATH, 'current.json'),
    checkpointBundlePath: join(values.ARTIFACT_PATH, 'checkpoint.json'),
    gitBundlePath: join(values.ARTIFACT_PATH, 'owner.bundle')
  }
  ownerBinding.bindingFingerprint = objectFingerprint(
    ownerBinding as unknown as Record<string, unknown>,
    'bindingFingerprint'
  )
  const bindingBytes = `${canonicalJson(ownerBinding)}\n`
  const bindingPath = join(values.ARTIFACT_PATH, 'owner-resource-binding.json')
  writeFileSync(bindingPath, bindingBytes)
  values.OWNER_RESOURCE_BINDING_PATH = bindingPath
  values.OWNER_RESOURCE_BINDING_SHA256 = sha256(bindingBytes)
  values.OWNER_RESOURCE_BINDING_FINGERPRINT = ownerBinding.bindingFingerprint
  return renderOwnerProfileLaunch({
    approvalMode,
    ownerTaskId,
    transitionId,
    profileGeneration,
    predecessorLaunchReceipt,
    expectedEffectivePermissionSandboxFingerprint: managedFingerprint(),
    templatePath: join(import.meta.dirname, '..', '..', 'profile', 'oes-project-owner.config.toml'),
    installedProfilePath: join(installedRoot, `profile-${profileGeneration}.toml`),
    launchReceiptPath: join(installedRoot, `launch-receipt-${profileGeneration}.json`),
    templateValues: values
  })
}

/** Writes the issuer snapshot beneath the profile-sealed authorization root. */
function trustedTelemetry(
  rendered: OwnerProfileRenderResult,
  approvalMode: ApprovalMode = 'ON_REQUEST_AUTO_REVIEW'
): string {
  return telemetry(
    join(dirname(rendered.installedProfile.path), 'trusted-authorizations'),
    approvalMode
  )
}

test('actual probe adapter records and verifies every delivery capability with zero normal prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-profile-test-'))
  const rendered = renderedProfile(root, '/root/do', 'handoff:1')
  const telemetryPath = trustedTelemetry(rendered)
  const report = await runTwoPhaseFixture(
    {
      ownerTaskId: '/root/do',
      transitionId: 'handoff:1',
      approvalMode: 'ON_REQUEST_AUTO_REVIEW',
      launchReceipt: rendered.launchReceipt,
      expectedState: 'HANDOFF_PENDING',
      declaredCapabilities: defaultDeliveryCapabilities(),
      profile: {
        name: 'oes-profile',
        permission: 'oes-owner',
        path: rendered.installedProfile.path,
        sha256: rendered.installedProfile.sha256
      },
      resultPath: join(root, 'profile-report.json')
    },
    new PassingProbe(root, telemetryPath)
  )
  assert.equal(report.observations.length, 8)
  assert.equal(verifyEffectiveProfileReport(report).telemetry.normalPermissionPromptCount, 0)
  for (const changed of [
    { ...report, ownerTaskId: '/root/do/rebound' },
    { ...report, transitionId: 'handoff:stale' }
  ])
    assert.throws(
      () => verifyEffectiveProfileReport(changed),
      /PROFILE_OWNER_TRANSITION_READBACK_MISMATCH/
    )
})

test('v2 writer supports NEVER_USER with zero approval events and executable schema readback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-profile-never-test-'))
  const rendered = renderedProfile(root, '/root/do', 'handoff:never', 'NEVER_USER')
  const telemetryPath = trustedTelemetry(rendered, 'NEVER_USER')
  const report = await runTwoPhaseFixture(
    {
      ownerTaskId: '/root/do',
      transitionId: 'handoff:never',
      approvalMode: 'NEVER_USER',
      launchReceipt: rendered.launchReceipt,
      expectedState: 'HANDOFF_PENDING',
      declaredCapabilities: ['filesystemWrite'],
      profile: {
        name: 'oes-profile',
        permission: 'oes-owner',
        path: rendered.installedProfile.path,
        sha256: rendered.installedProfile.sha256
      },
      resultPath: join(root, 'profile-report.json')
    },
    new PassingProbe(root, telemetryPath)
  )
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.approvalMode, 'NEVER_USER')
  assert.equal(report.telemetry.approvalPolicy, 'never')
  assert.equal(report.telemetry.approvalsReviewer, 'user')
  assert.equal(report.telemetry.approvalEventCount, 0)
  assert.equal(report.telemetry.contexts?.length, 2)
  validateJsonSchema(effectiveProfileSchema, report)
})

test('all v2 contexts reject permission drift, unmanaged access, and NEVER_USER approval events', () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-profile-context-drift-test-'))
  const pair = approvalPair('NEVER_USER')
  const base = {
    approval_policy: pair.approvalPolicy,
    approvals_reviewer: pair.approvalsReviewer,
    ...MANAGED_PERMISSION
  }
  const expectation = approvalExpectation(root, 'NEVER_USER')
  const driftPath = join(root, 'drift.jsonl')
  writeFileSync(
    driftPath,
    [
      JSON.stringify({ ordinal: 1, type: 'turn_context', payload: { turn_id: 'a', ...base } }),
      JSON.stringify({
        ordinal: 2,
        type: 'turn_context',
        payload: {
          turn_id: 'b',
          ...base,
          active_permission_profile: { id: 'drifted-profile' }
        }
      })
    ].join('\n')
  )
  assert.throws(
    () => readApprovalTelemetry(driftPath, expectation),
    /EFFECTIVE_PERMISSION_SANDBOX_UNMANAGED/
  )

  const unmanagedPath = join(root, 'unmanaged.jsonl')
  writeFileSync(
    unmanagedPath,
    JSON.stringify({
      ordinal: 1,
      type: 'turn_context',
      payload: {
        turn_id: 'a',
        ...base,
        permission_profile: { type: 'disabled' },
        sandbox_policy: { type: 'danger-full-access' }
      }
    })
  )
  assert.throws(
    () => readApprovalTelemetry(unmanagedPath, expectation),
    /EFFECTIVE_PERMISSION_SANDBOX_UNMANAGED/
  )

  const approvalPath = telemetry(root, 'NEVER_USER')
  writeFileSync(
    approvalPath,
    `${readFileSync(approvalPath, 'utf8')}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'exec_approval_request' } })}`
  )
  assert.throws(
    () => readApprovalTelemetry(approvalPath, expectation),
    /NEVER_USER_APPROVAL_EVENT_FORBIDDEN/
  )
})

test('v2 preflight rejects unrestricted effective filesystem telemetry end to end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-profile-unrestricted-test-'))
  const rendered = renderedProfile(root, '/root/do', 'handoff:unrestricted', 'NEVER_USER')
  const eventSource = join(
    dirname(rendered.installedProfile.path),
    'trusted-authorizations',
    'unrestricted.jsonl'
  )
  writeFileSync(
    eventSource,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'session-1' } }),
      JSON.stringify({
        ordinal: 1,
        type: 'turn_context',
        payload: {
          turn_id: 'turn-2',
          approval_policy: 'never',
          approvals_reviewer: 'user',
          ...MANAGED_PERMISSION,
          file_system_sandbox_policy: { kind: 'unrestricted' }
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-2' }
      })
    ].join('\n')
  )

  await assert.rejects(
    runTwoPhaseFixture(
      {
        ownerTaskId: '/root/do',
        transitionId: 'handoff:unrestricted',
        approvalMode: 'NEVER_USER',
        launchReceipt: rendered.launchReceipt,
        expectedState: 'HANDOFF_PENDING',
        declaredCapabilities: ['filesystemWrite'],
        profile: {
          name: 'oes-profile',
          permission: 'oes-owner',
          path: rendered.installedProfile.path,
          sha256: rendered.installedProfile.sha256
        },
        resultPath: join(root, 'profile-report.json')
      },
      new PassingProbe(root, eventSource)
    ),
    /EFFECTIVE_PERMISSION_SANDBOX_UNMANAGED/
  )
})

test('effective fingerprint normalizes only the launcher arg0 filename', () => {
  const withPrompt = (path: string) => ({
    ...MANAGED_PERMISSION,
    permission_profile: {
      ...MANAGED_PERMISSION.permission_profile,
      file_system: {
        type: 'restricted',
        entries: [
          { access: 'read', path: { type: 'path', path } },
          { access: 'write', path: { type: 'path', path: '/owner' } }
        ]
      }
    },
    file_system_sandbox_policy: {
      kind: 'restricted',
      entries: [{ access: 'read', path: { type: 'path', path } }]
    }
  })
  assert.equal(
    effectivePermissionSandboxFingerprint(withPrompt('/codex-home/tmp/arg0/codex-arg0AAA')),
    effectivePermissionSandboxFingerprint(withPrompt('/codex-home/tmp/arg0/codex-arg0BBB'))
  )
  assert.notEqual(
    effectivePermissionSandboxFingerprint(withPrompt('/codex-home/tmp/other/codex-arg0AAA')),
    effectivePermissionSandboxFingerprint(withPrompt('/codex-home/tmp/other/codex-arg0BBB'))
  )
})

test('renderer derives pairs atomically and enforces monotonic same-owner successors', () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-profile-successor-test-'))
  const first = renderedProfile(root, '/root/do', 'profile:1')
  const second = renderedProfile(
    root,
    '/root/do',
    'profile:2',
    'NEVER_USER',
    2,
    first.launchReceipt
  )
  validateJsonSchema(
    profileLaunchReceiptSchema,
    JSON.parse(readFileSync(second.launchReceipt.path, 'utf8'))
  )
  assert.equal(second.approvalPolicy, 'never')
  assert.equal(second.approvalsReviewer, 'user')
  const invariantLines = (path: string) =>
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(
        (line) =>
          !/^(approval_policy|approvals_reviewer|transition_id|approval_mode|owner_resource_binding_sha256|owner_resource_binding_fingerprint)\s*=/.test(
            line.trim()
          )
      )
  assert.deepEqual(
    invariantLines(first.installedProfile.path),
    invariantLines(second.installedProfile.path)
  )
  assert.throws(
    () => renderedProfile(root, '/root/do', 'profile:4', 'NEVER_USER', 4, first.launchReceipt),
    /PROFILE_RENDER_SUCCESSOR_NOT_MONOTONIC/
  )
  const invalidRequest = {
    approvalMode: 'NEVER_USER',
    ownerTaskId: '/root/do',
    transitionId: 'profile:3',
    profileGeneration: 3,
    predecessorLaunchReceipt: second.launchReceipt,
    expectedEffectivePermissionSandboxFingerprint: managedFingerprint(),
    templatePath: join(import.meta.dirname, '..', '..', 'profile', 'oes-project-owner.config.toml'),
    installedProfilePath: join(root, 'installed', 'profile-3.toml'),
    launchReceiptPath: join(root, 'installed', 'launch-receipt-3.json'),
    templateValues: {},
    approvalPolicy: 'never'
  } as unknown as OwnerProfileRenderRequest
  assert.throws(
    () => renderOwnerProfileLaunch(invalidRequest),
    /PROFILE_RENDER_REQUEST_FIELDS_INVALID/
  )
})

test('profile verification reopens evidence, profile bytes, and telemetry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-profile-reopen-test-'))
  const rendered = renderedProfile(root, '/root/do', 'handoff:2')
  const telemetryPath = trustedTelemetry(rendered)
  const report = await runTwoPhaseFixture(
    {
      ownerTaskId: '/root/do',
      transitionId: 'handoff:2',
      approvalMode: 'ON_REQUEST_AUTO_REVIEW',
      launchReceipt: rendered.launchReceipt,
      expectedState: 'HANDOFF_PENDING',
      declaredCapabilities: ['filesystemWrite'],
      profile: {
        name: 'oes-profile',
        permission: 'oes-owner',
        path: rendered.installedProfile.path,
        sha256: rendered.installedProfile.sha256
      },
      resultPath: join(root, 'report.json')
    },
    new PassingProbe(root, telemetryPath)
  )
  writeFileSync(report.telemetry.eventSource, '')
  assert.throws(() => verifyEffectiveProfileReport(report), /APPROVAL_TELEMETRY_CONTEXT_MISSING/)
})

test('effective profile schema pairs stable topology with one sealed owner binding', () => {
  const value = {
    schemaVersion: 1,
    kind: 'OES_EFFECTIVE_PROFILE_REPORT',
    ownerTaskId: '/root/do',
    transitionId: 'handoff:stable',
    expectedState: 'HANDOFF_PENDING',
    declaredCapabilities: ['filesystemWrite'],
    profile: { name: 'profile', permission: 'owner', path: '/profile', sha256: 'a'.repeat(64) },
    observations: [
      {
        name: 'filesystemWrite',
        command: 'probe',
        literalOutput: 'PASS',
        exitCode: 0,
        result: 'PASS',
        evidencePath: '/evidence',
        evidenceSha256: 'b'.repeat(64)
      }
    ],
    credentialReference: {
      reference: 'git',
      keys: ['username', 'password'],
      secretValuesRecorded: false
    },
    telemetry: {
      eventSource: '/telemetry',
      eventSourceSha256: 'c'.repeat(64),
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      approvalEventCount: 0,
      normalPermissionPromptCount: 0
    },
    resourceTopology: {
      resourceTopologyVersion: 'owner-exclusive-v2',
      ownerResourceBinding: {
        path: '/owner-binding.json',
        sha256: 'd'.repeat(64),
        fingerprint: 'e'.repeat(64)
      }
    }
  }
  validateJsonSchema(effectiveProfileSchema, value)
  ;(value.resourceTopology as { ownerResourceBinding: unknown }).ownerResourceBinding = null
  assert.throws(() => validateJsonSchema(effectiveProfileSchema, value), /type|required/)
})

test('failure routing distinguishes handoff, active-owner profile defect, and genuine expansion', () => {
  assert.equal(
    classifyCapabilityIssue({
      expectedState: 'HANDOFF_PENDING',
      capabilityDeclared: true,
      operation: 'git',
      literalFailure: 'EPERM'
    }),
    'EXECUTION_ENVIRONMENT_NOT_READY'
  )
  assert.equal(
    classifyCapabilityIssue({
      expectedState: 'DELIVERY_ACTIVE',
      capabilityDeclared: true,
      operation: 'git',
      literalFailure: 'EPERM'
    }),
    'EXECUTION_PROFILE_DEFECT'
  )
  assert.equal(
    classifyCapabilityIssue({
      expectedState: 'DELIVERY_ACTIVE',
      capabilityDeclared: false,
      operation: 'host privilege',
      literalFailure: 'denied'
    }),
    'PERMISSION_EXPANSION_REQUIRED'
  )
})

test('repair plans remain bounded and preserve the active owner', () => {
  const plan = planProfileRepair(
    {
      expectedState: 'DELIVERY_ACTIVE',
      capabilityDeclared: true,
      operation: 'localhost',
      literalFailure: 'EPERM'
    },
    { networkDomains: ['127.0.0.1'], allowLocalBinding: true }
  )
  assert.equal(plan.route, 'EXECUTION_PROFILE_DEFECT')
  assert.equal(plan.preserveOwner, true)
  assert.throws(
    () =>
      planProfileRepair(
        {
          expectedState: 'DELIVERY_ACTIVE',
          capabilityDeclared: true,
          operation: 'filesystem',
          literalFailure: 'EPERM'
        },
        { filesystemRoots: ['/'] }
      ),
    /UNBOUNDED_PROFILE_REPAIR_REJECTED/
  )
})

test('telemetry is derived from persisted context and credential output retains keys only', () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-telemetry-test-'))
  const path = telemetry(root)
  assert.equal(readApprovalTelemetry(path).normalPermissionPromptCount, 0)
  assert.deepEqual(credentialReferenceKeys('username=alice\npassword=sensitive\n'), [
    'password',
    'username'
  ])
})

test('system adapter consumes issuer-owned telemetry and detects a late approval event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-telemetry-snapshot-test-'))
  const trustedRoot = join(root, 'trusted-authorizations')
  mkdirSync(trustedRoot, { recursive: true })
  const issuerSnapshot = telemetry(trustedRoot, 'NEVER_USER')
  const adapter = new SystemPreflightProbeAdapter({
    repositoryRoot: process.cwd(),
    smokeRoot: root,
    telemetryEventSource: issuerSnapshot
  })
  const expectation = approvalExpectation(trustedRoot, 'NEVER_USER')
  const sealed = await adapter.approvalTelemetry(expectation)
  assert.equal(sealed.eventSource, issuerSnapshot)
  assert.equal(
    sealed.eventSourceFingerprint,
    sha256(
      canonicalJson({
        eventSource: issuerSnapshot,
        eventSourceSha256: sealed.eventSourceSha256
      })
    )
  )
  appendFileSync(
    issuerSnapshot,
    `\n${JSON.stringify({ type: 'event_msg', payload: { type: 'exec_approval_request' } })}\n`
  )
  assert.throws(
    () => readApprovalTelemetry(sealed.eventSource, expectation),
    /NEVER_USER_APPROVAL_EVENT_FORBIDDEN/
  )

  const callerPath = telemetry(root, 'NEVER_USER')
  const callerAdapter = new SystemPreflightProbeAdapter({
    repositoryRoot: process.cwd(),
    smokeRoot: root,
    telemetryEventSource: callerPath
  })
  await assert.rejects(
    callerAdapter.approvalTelemetry(expectation),
    /ARTIFACT_PATH_OUTSIDE_BOUND_ROOT/
  )
})

test('two-phase preflight finalizes only after the completed target turn is issuer-sealed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-profile-two-phase-test-'))
  const rendered = renderedProfile(root, '/root/do', 'handoff:two-phase', 'NEVER_USER')
  const issuerSnapshot = trustedTelemetry(rendered, 'NEVER_USER')
  const request = {
    ownerTaskId: '/root/do',
    transitionId: 'handoff:two-phase',
    approvalMode: 'NEVER_USER' as const,
    launchReceipt: rendered.launchReceipt,
    expectedState: 'HANDOFF_PENDING' as const,
    declaredCapabilities: ['filesystemWrite', 'approvalTelemetry'] as CapabilityName[],
    profile: {
      name: 'oes-profile',
      permission: 'oes-owner',
      path: rendered.installedProfile.path,
      sha256: rendered.installedProfile.sha256
    },
    resultPath: join(root, 'profile-report.json')
  }
  const draftPath = join(root, 'probe-draft.json')
  issueProbeAttempt(request)
  const draft = await runEffectiveProfileProbePhase(
    request,
    new PassingProbe(root, issuerSnapshot),
    draftPath
  )
  assert.deepEqual(
    draft.observations.map(({ name }) => name),
    ['filesystemWrite']
  )
  sealSnapshotRecord(request, draft, issuerSnapshot)

  const report = await finalizeEffectiveProfilePreflight(
    request,
    new PassingProbe(root, issuerSnapshot),
    draftPath
  )
  assert.deepEqual(
    report.observations.map(({ name }) => name),
    ['filesystemWrite', 'approvalTelemetry']
  )
  assert.equal(report.telemetry.eventSource, issuerSnapshot)
  issueProbeAttempt(request, 'attempt-successor-current')
  assert.throws(
    () => verifyEffectiveProfileReport(report),
    /PROFILE_V2_CURRENT_PROBE_ATTEMPT_MISMATCH/
  )

  const changed = JSON.parse(readFileSync(draftPath, 'utf8')) as Record<string, unknown>
  changed.transitionId = 'handoff:rebound'
  writeFileSync(draftPath, `${canonicalJson(changed)}\n`)
  await assert.rejects(
    finalizeEffectiveProfilePreflight(request, new PassingProbe(root, issuerSnapshot), draftPath),
    /PROFILE_PROBE_DRAFT_BINDING_INVALID/
  )
})

test('finalizer rejects an older safe snapshot record and inspects the bad current turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-profile-snapshot-replay-test-'))
  const rendered = renderedProfile(root, '/root/do', 'handoff:snapshot-replay', 'NEVER_USER')
  const authorizationRoot = join(dirname(rendered.installedProfile.path), 'trusted-authorizations')
  const generated = telemetry(authorizationRoot, 'NEVER_USER')
  const safeSnapshot = join(authorizationRoot, 'older-safe.jsonl')
  writeFileSync(safeSnapshot, readFileSync(generated))
  const badSnapshot = join(authorizationRoot, 'current-bad.jsonl')
  writeFileSync(badSnapshot, readFileSync(generated))
  appendFileSync(
    badSnapshot,
    `\n${JSON.stringify({ type: 'event_msg', payload: { type: 'exec_approval_request' } })}\n`
  )
  const request: PreflightRequest = {
    ownerTaskId: '/root/do',
    transitionId: 'handoff:snapshot-replay',
    approvalMode: 'NEVER_USER',
    launchReceipt: rendered.launchReceipt,
    expectedState: 'HANDOFF_PENDING',
    declaredCapabilities: ['filesystemWrite', 'approvalTelemetry'],
    profile: {
      name: 'oes-profile',
      permission: 'oes-owner',
      path: rendered.installedProfile.path,
      sha256: rendered.installedProfile.sha256
    },
    resultPath: join(root, 'profile-report.json')
  }
  const identicalSmoke = join(root, 'identical-smoke')
  mkdirSync(identicalSmoke)
  const oldDraftPath = join(root, 'old-draft.json')
  const currentDraftPath = join(root, 'current-draft.json')
  issueProbeAttempt(request, 'attempt-identical-output')
  const oldDraft = await runEffectiveProfileProbePhase(
    request,
    new PassingProbe(identicalSmoke, safeSnapshot),
    oldDraftPath
  )
  const oldRecord = sealSnapshotRecord(request, oldDraft, safeSnapshot)
  const currentDraft = await runEffectiveProfileProbePhase(
    request,
    new PassingProbe(identicalSmoke, badSnapshot),
    currentDraftPath
  )
  assert.equal(currentDraft.draftFingerprint, oldDraft.draftFingerprint)
  const currentRecord = sealSnapshotRecord(request, currentDraft, badSnapshot)
  assert.notEqual(currentRecord.sha256, oldRecord.sha256)

  const untrustedCallerSelectedRecord = finalizeEffectiveProfilePreflight as unknown as (
    ...args: unknown[]
  ) => Promise<EffectiveProfileReport>
  assert.equal(finalizeEffectiveProfilePreflight.length, 3)
  await assert.rejects(
    untrustedCallerSelectedRecord(
      request,
      new PassingProbe(identicalSmoke, safeSnapshot),
      currentDraftPath,
      oldRecord
    ),
    /NEVER_USER_APPROVAL_EVENT_FORBIDDEN/
  )
})

test('system adapter performs actual filesystem, SQLite, and telemetry probes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-system-probe-test-'))
  const trustedRoot = join(root, 'trusted-authorizations')
  mkdirSync(trustedRoot, { recursive: true })
  const adapter = new SystemPreflightProbeAdapter({
    repositoryRoot: process.cwd(),
    smokeRoot: root,
    telemetryEventSource: telemetry(trustedRoot)
  })
  for (const capability of [
    'filesystemWrite',
    'taskOwnedDatabase',
    'approvalTelemetry'
  ] as CapabilityName[]) {
    const observation = await adapter.observe(capability, approvalExpectation(trustedRoot))
    assert.equal(observation.result, 'PASS')
    assert.equal(observation.exitCode, 0)
    assert.equal(sha256(readFileSync(observation.evidencePath)), observation.evidenceSha256)
  }
})

test('standard git credential fill keeps only approved reference keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-credential-system-test-'))
  const fakeGit = join(root, 'git')
  writeFileSync(
    fakeGit,
    '#!/bin/sh\ncat >/dev/null\nprintf "protocol=https\\nhost=github.com\\nusername=fixture\\npassword=redacted\\n"\nprintf "password=stderr-secret\\n" >&2\n'
  )
  chmodSync(fakeGit, 0o700)
  const adapter = new SystemPreflightProbeAdapter({
    repositoryRoot: process.cwd(),
    smokeRoot: root,
    telemetryEventSource: telemetry(root),
    git: fakeGit
  })
  const observation = await adapter.observe('credentialReference')
  assert.equal(observation.result, 'PASS')
  assert.doesNotMatch(observation.literalOutput, /fixture|redacted|stderr-secret/)
  assert.deepEqual((await adapter.credentialReference()).keys, ['password', 'username'])
})

test('credential reference preserves helper failure without recording secret values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-credential-failure-test-'))
  const fakeGit = join(root, 'git')
  writeFileSync(
    fakeGit,
    '#!/bin/sh\ncat >/dev/null\nprintf "username=fixture\\npassword=redacted\\n"\nprintf "password=stderr-secret\\n" >&2\nexit 7\n'
  )
  chmodSync(fakeGit, 0o700)
  const adapter = new SystemPreflightProbeAdapter({
    repositoryRoot: process.cwd(),
    smokeRoot: root,
    telemetryEventSource: telemetry(root),
    git: fakeGit
  })
  const observation = await adapter.observe('credentialReference')
  assert.equal(observation.result, 'FAIL')
  assert.equal(observation.exitCode, 1)
  assert.match(observation.literalOutput, /git credential fill \[7\]/)
  assert.doesNotMatch(observation.literalOutput, /fixture|redacted|stderr-secret/)
})

test('failed system probes preserve combined stdout and stderr diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-probe-diagnostics-test-'))
  const fakeNode = join(root, 'node')
  writeFileSync(
    fakeNode,
    '#!/bin/sh\nprintf "STDOUT_DIAGNOSTIC\\n"\nprintf "STDERR_DIAGNOSTIC\\n" >&2\nexit 7\n'
  )
  chmodSync(fakeNode, 0o700)
  const adapter = new SystemPreflightProbeAdapter({
    repositoryRoot: process.cwd(),
    smokeRoot: root,
    telemetryEventSource: telemetry(root),
    node: fakeNode
  })
  const observation = await adapter.observe('standardBuildTest')
  assert.equal(observation.result, 'FAIL')
  assert.match(observation.literalOutput, /STDOUT_DIAGNOSTIC/)
  assert.match(observation.literalOutput, /STDERR_DIAGNOSTIC/)
  assert.match(observation.literalOutput, /\[7\]/)
})

test('caller-writable profile reports cannot select remote trust roots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oes-runtime-trust-profile-test-'))
  const rendered = renderedProfile(root, '/root/do', 'delivery:1')
  const telemetryPath = trustedTelemetry(rendered)
  const report = await runTwoPhaseFixture(
    {
      ownerTaskId: '/root/do',
      transitionId: 'delivery:1',
      approvalMode: 'ON_REQUEST_AUTO_REVIEW',
      launchReceipt: rendered.launchReceipt,
      expectedState: 'DELIVERY_ACTIVE',
      declaredCapabilities: defaultDeliveryCapabilities(),
      profile: {
        name: 'installed',
        permission: 'owner',
        path: rendered.installedProfile.path,
        sha256: rendered.installedProfile.sha256
      },
      resultPath: join(root, 'report.json')
    },
    new PassingProbe(root, telemetryPath)
  )
  for (const changed of [
    { ...report, ownerTaskId: '/root/do/rebound' },
    { ...report, transitionId: 'delivery:stale' }
  ])
    assert.throws(
      () => loadRemoteTrustRootsFromProfileReport(changed),
      /PROFILE_OWNER_TRANSITION_READBACK_MISMATCH/
    )
  process.env.OES_REMOTE_AUTHORIZATION_ROOT = join(root, 'caller-selected')
  try {
    assert.throws(
      () => loadRemoteTrustRootsFromProfileReport(report),
      /INSTALLED_PROFILE_CALLER_WRITABLE|INSTALLED_PROFILE_CALLER_CONTROLLED/
    )
  } finally {
    delete process.env.OES_REMOTE_AUTHORIZATION_ROOT
  }
})

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { canonicalJson, objectFingerprint, readJson, sha256, writeJsonAtomic } from './canonical.ts'
import { fail } from './errors.ts'
import { readInstalledProfileResourceTopology } from './resource-topology.ts'
import {
  APPROVAL_MODES,
  type ApprovalMode,
  type ApprovalPolicy,
  type ApprovalsReviewer,
  type ProfileLaunchReceipt,
  type TrustedAuthorizationReference
} from './types.ts'

export const APPROVAL_MODE_PAIRS: Readonly<
  Record<ApprovalMode, { approvalPolicy: ApprovalPolicy; approvalsReviewer: ApprovalsReviewer }>
> = Object.freeze({
  ON_REQUEST_AUTO_REVIEW: Object.freeze({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review'
  }),
  NEVER_USER: Object.freeze({ approvalPolicy: 'never', approvalsReviewer: 'user' })
})

const PROFILE_TEMPLATE_KEYS = [
  'PROJECT_KEY',
  'OWNER_PATH',
  'ARTIFACT_PATH',
  'TASK_TEMP_PATH',
  'REPOSITORY_ROOT',
  'TRUSTED_AUTHORIZATION_ROOT',
  'SERIAL_ADMISSION_ROOT',
  'OWNER_GIT_DIRECTORY',
  'USER_GIT_CONFIG',
  'CREDENTIAL_STORE_PATH',
  'PACKAGE_CACHE_PATH',
  'RESOURCE_TOPOLOGY_VERSION',
  'OWNER_RESOURCE_BINDING_PATH',
  'OWNER_RESOURCE_BINDING_SHA256',
  'OWNER_RESOURCE_BINDING_FINGERPRINT'
] as const

type ProfileTemplateKey = (typeof PROFILE_TEMPLATE_KEYS)[number]

export interface OwnerProfileRenderRequest {
  approvalMode: ApprovalMode
  ownerTaskId: string
  transitionId: string
  profileGeneration: number
  predecessorLaunchReceipt: TrustedAuthorizationReference | null
  expectedEffectivePermissionSandboxFingerprint: string
  templatePath: string
  installedProfilePath: string
  launchReceiptPath: string
  templateValues: Record<ProfileTemplateKey, string>
}

export interface OwnerProfileRenderResult {
  approvalMode: ApprovalMode
  approvalPolicy: ApprovalPolicy
  approvalsReviewer: ApprovalsReviewer
  installedProfile: { path: string; sha256: string }
  launchReceipt: TrustedAuthorizationReference
}

/** Requires one exact absolute SHA/fingerprint reference without following it. */
function validateReferenceShape(
  value: TrustedAuthorizationReference,
  field: string
): TrustedAuthorizationReference {
  if (
    !value ||
    typeof value !== 'object' ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(['path', 'sha256', 'fingerprint'].sort()) ||
    !isAbsolute(value.path) ||
    !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    !/^[0-9a-f]{64}$/u.test(value.fingerprint)
  )
    fail('PROFILE_REFERENCE_INVALID', field)
  return value
}

/** Resolves the only supported approval pair from one closed mode discriminant. */
export function approvalPair(mode: ApprovalMode): {
  approvalPolicy: ApprovalPolicy
  approvalsReviewer: ApprovalsReviewer
} {
  if (!APPROVAL_MODES.includes(mode)) fail('APPROVAL_MODE_INVALID', String(mode))
  return APPROVAL_MODE_PAIRS[mode]
}

/** Reads the installed profile's mode, derived pair, and expected effective fingerprint. */
export function readInstalledProfilePolicy(profilePath: string): {
  approvalMode: ApprovalMode
  approvalPolicy: ApprovalPolicy
  approvalsReviewer: ApprovalsReviewer
  expectedEffectivePermissionSandboxFingerprint: string
} {
  const text = readFileSync(profilePath, 'utf8')
  let section = ''
  const top = new Map<string, string>()
  const collaboration = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1]
      continue
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*")$/u.exec(line)
    if (!assignment) continue
    const target = section === '' ? top : section === 'collaboration_runtime' ? collaboration : null
    if (!target) continue
    if (target.has(assignment[1])) fail('PROFILE_POLICY_FIELD_DUPLICATE', assignment[1])
    target.set(assignment[1], JSON.parse(assignment[2]) as string)
  }
  const approvalMode = collaboration.get('approval_mode') as ApprovalMode
  const approvalPolicy = top.get('approval_policy') as ApprovalPolicy
  const approvalsReviewer = top.get('approvals_reviewer') as ApprovalsReviewer
  const expectedEffectivePermissionSandboxFingerprint =
    collaboration.get('expected_effective_permission_sandbox_fingerprint') ?? ''
  const pair = approvalPair(approvalMode)
  if (approvalPolicy !== pair.approvalPolicy || approvalsReviewer !== pair.approvalsReviewer)
    fail(
      'INSTALLED_PROFILE_APPROVAL_PAIR_MISMATCH',
      `${approvalMode}:${approvalPolicy}/${approvalsReviewer}`
    )
  if (!/^[0-9a-f]{64}$/u.test(expectedEffectivePermissionSandboxFingerprint))
    fail('INSTALLED_PROFILE_EFFECTIVE_FINGERPRINT_INVALID', profilePath)
  return {
    approvalMode,
    approvalPolicy,
    approvalsReviewer,
    expectedEffectivePermissionSandboxFingerprint
  }
}

/** Reopens and validates one issuer-sealed launch receipt reference. */
export function loadProfileLaunchReceipt(
  reference: TrustedAuthorizationReference
): ProfileLaunchReceipt {
  validateReferenceShape(reference, 'launchReceipt')
  const bytes = readFileSync(reference.path)
  if (sha256(bytes) !== reference.sha256)
    fail('PROFILE_LAUNCH_RECEIPT_SHA_MISMATCH', reference.path)
  const receipt = readJson<ProfileLaunchReceipt>(reference.path)
  const keys = [
    'schemaVersion',
    'kind',
    'receiptFingerprint',
    'ownerTaskId',
    'transitionId',
    'profileGeneration',
    'predecessorLaunchReceipt',
    'approvalMode',
    'approvalPolicy',
    'approvalsReviewer',
    'installedProfile',
    'expectedEffectivePermissionSandboxFingerprint',
    'resourceTopology'
  ]
  if (canonicalJson(Object.keys(receipt).sort()) !== canonicalJson(keys.sort()))
    fail('PROFILE_LAUNCH_RECEIPT_FIELDS_INVALID', reference.path)
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'OES_PROFILE_LAUNCH_RECEIPT')
    fail('PROFILE_LAUNCH_RECEIPT_KIND_INVALID', reference.path)
  const fingerprint = objectFingerprint(
    receipt as unknown as Record<string, unknown>,
    'receiptFingerprint'
  )
  if (fingerprint !== receipt.receiptFingerprint || fingerprint !== reference.fingerprint)
    fail('PROFILE_LAUNCH_RECEIPT_FINGERPRINT_MISMATCH', reference.path)
  const pair = approvalPair(receipt.approvalMode)
  if (
    receipt.approvalPolicy !== pair.approvalPolicy ||
    receipt.approvalsReviewer !== pair.approvalsReviewer
  )
    fail('PROFILE_LAUNCH_RECEIPT_PAIR_MISMATCH', receipt.approvalMode)
  if (!Number.isSafeInteger(receipt.profileGeneration) || receipt.profileGeneration < 1)
    fail('PROFILE_LAUNCH_RECEIPT_GENERATION_INVALID', reference.path)
  if (receipt.profileGeneration === 1 && receipt.predecessorLaunchReceipt !== null)
    fail('PROFILE_LAUNCH_RECEIPT_INITIAL_PREDECESSOR_FORBIDDEN', reference.path)
  if (receipt.profileGeneration > 1 && receipt.predecessorLaunchReceipt === null)
    fail('PROFILE_LAUNCH_RECEIPT_PREDECESSOR_REQUIRED', reference.path)
  if (receipt.predecessorLaunchReceipt !== null)
    validateReferenceShape(receipt.predecessorLaunchReceipt, 'predecessorLaunchReceipt')
  if (
    !receipt.installedProfile ||
    typeof receipt.installedProfile !== 'object' ||
    canonicalJson(Object.keys(receipt.installedProfile).sort()) !==
      canonicalJson(['path', 'sha256'].sort())
  )
    fail('PROFILE_LAUNCH_RECEIPT_INSTALLED_PROFILE_INVALID', reference.path)
  if (
    !receipt.ownerTaskId.trim() ||
    !receipt.transitionId.trim() ||
    !isAbsolute(receipt.installedProfile.path) ||
    !/^[0-9a-f]{64}$/u.test(receipt.installedProfile.sha256) ||
    !/^[0-9a-f]{64}$/u.test(receipt.expectedEffectivePermissionSandboxFingerprint)
  )
    fail('PROFILE_LAUNCH_RECEIPT_BINDING_INVALID', reference.path)
  if (
    !receipt.resourceTopology ||
    typeof receipt.resourceTopology !== 'object' ||
    canonicalJson(Object.keys(receipt.resourceTopology).sort()) !==
      canonicalJson(['resourceTopologyVersion', 'ownerResourceBinding'].sort()) ||
    receipt.resourceTopology.resourceTopologyVersion !== 'owner-exclusive-v2' ||
    receipt.resourceTopology.ownerResourceBinding === null
  )
    fail('PROFILE_LAUNCH_RECEIPT_TOPOLOGY_INVALID', reference.path)
  if (receipt.resourceTopology.ownerResourceBinding)
    validateReferenceShape(receipt.resourceTopology.ownerResourceBinding, 'ownerResourceBinding')
  return receipt
}

/** Atomically renders one installed profile and seals its launch receipt from the mode only. */
export function renderOwnerProfileLaunch(
  request: OwnerProfileRenderRequest
): OwnerProfileRenderResult {
  const requestKeys = [
    'approvalMode',
    'ownerTaskId',
    'transitionId',
    'profileGeneration',
    'predecessorLaunchReceipt',
    'expectedEffectivePermissionSandboxFingerprint',
    'templatePath',
    'installedProfilePath',
    'launchReceiptPath',
    'templateValues'
  ]
  if (canonicalJson(Object.keys(request).sort()) !== canonicalJson(requestKeys.sort()))
    fail('PROFILE_RENDER_REQUEST_FIELDS_INVALID', request.ownerTaskId)
  if (!request.ownerTaskId.trim() || !request.transitionId.trim())
    fail('PROFILE_RENDER_OWNER_TRANSITION_REQUIRED', request.ownerTaskId)
  if (!Number.isSafeInteger(request.profileGeneration) || request.profileGeneration < 1)
    fail('PROFILE_RENDER_GENERATION_INVALID', request.ownerTaskId)
  if (
    !isAbsolute(request.templatePath) ||
    !isAbsolute(request.installedProfilePath) ||
    !isAbsolute(request.launchReceiptPath)
  )
    fail('PROFILE_RENDER_PATH_NOT_ABSOLUTE', request.ownerTaskId)
  if (!/^[0-9a-f]{64}$/u.test(request.expectedEffectivePermissionSandboxFingerprint))
    fail('PROFILE_RENDER_EFFECTIVE_FINGERPRINT_INVALID', request.ownerTaskId)
  const suppliedKeys = Object.keys(request.templateValues).sort()
  if (canonicalJson(suppliedKeys) !== canonicalJson([...PROFILE_TEMPLATE_KEYS].sort()))
    fail('PROFILE_RENDER_TEMPLATE_VALUES_INVALID', suppliedKeys.join(','))

  const pair = approvalPair(request.approvalMode)
  if (request.profileGeneration === 1) {
    if (request.predecessorLaunchReceipt !== null)
      fail('PROFILE_RENDER_INITIAL_PREDECESSOR_FORBIDDEN', request.ownerTaskId)
  } else {
    if (request.predecessorLaunchReceipt === null)
      fail('PROFILE_RENDER_PREDECESSOR_REQUIRED', request.ownerTaskId)
    const predecessor = loadProfileLaunchReceipt(request.predecessorLaunchReceipt)
    if (
      predecessor.ownerTaskId !== request.ownerTaskId ||
      predecessor.profileGeneration + 1 !== request.profileGeneration ||
      predecessor.transitionId === request.transitionId
    )
      fail('PROFILE_RENDER_SUCCESSOR_NOT_MONOTONIC', request.ownerTaskId)
  }
  const replacements: Record<string, string> = {
    ...request.templateValues,
    OWNER_TASK_ID: request.ownerTaskId,
    TRANSITION_ID: request.transitionId,
    APPROVAL_MODE: request.approvalMode,
    APPROVAL_POLICY: pair.approvalPolicy,
    APPROVALS_REVIEWER: pair.approvalsReviewer,
    EXPECTED_EFFECTIVE_PERMISSION_SANDBOX_FINGERPRINT:
      request.expectedEffectivePermissionSandboxFingerprint
  }
  let rendered = readFileSync(request.templatePath, 'utf8')
  for (const [name, value] of Object.entries(replacements)) {
    const token = `{{${name}}}`
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    if (!rendered.includes(token)) fail('PROFILE_RENDER_TEMPLATE_TOKEN_MISSING', name)
    rendered = rendered.replaceAll(token, escaped)
  }
  const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/gu)
  if (unresolved?.length) fail('PROFILE_RENDER_TEMPLATE_UNRESOLVED', unresolved.join(','))
  mkdirSync(dirname(request.installedProfilePath), { recursive: true })
  const temporaryProfile = join(
    dirname(request.installedProfilePath),
    `.${process.pid}.${Date.now()}.profile.tmp`
  )
  writeFileSync(temporaryProfile, rendered, { mode: 0o600 })
  renameSync(temporaryProfile, request.installedProfilePath)
  const profileBytes = readFileSync(request.installedProfilePath)
  const installedProfile = { path: request.installedProfilePath, sha256: sha256(profileBytes) }
  const installedPolicy = readInstalledProfilePolicy(request.installedProfilePath)
  if (
    installedPolicy.approvalMode !== request.approvalMode ||
    installedPolicy.expectedEffectivePermissionSandboxFingerprint !==
      request.expectedEffectivePermissionSandboxFingerprint
  )
    fail('PROFILE_RENDER_POLICY_READBACK_MISMATCH', request.ownerTaskId)
  const receipt: ProfileLaunchReceipt = {
    schemaVersion: 1,
    kind: 'OES_PROFILE_LAUNCH_RECEIPT',
    receiptFingerprint: '',
    ownerTaskId: request.ownerTaskId,
    transitionId: request.transitionId,
    profileGeneration: request.profileGeneration,
    predecessorLaunchReceipt: request.predecessorLaunchReceipt,
    approvalMode: request.approvalMode,
    approvalPolicy: pair.approvalPolicy,
    approvalsReviewer: pair.approvalsReviewer,
    installedProfile,
    expectedEffectivePermissionSandboxFingerprint:
      request.expectedEffectivePermissionSandboxFingerprint,
    resourceTopology: readInstalledProfileResourceTopology(request.installedProfilePath)
  }
  receipt.receiptFingerprint = objectFingerprint(
    receipt as unknown as Record<string, unknown>,
    'receiptFingerprint'
  )
  writeJsonAtomic(request.launchReceiptPath, receipt)
  const receiptBytes = readFileSync(request.launchReceiptPath)
  const launchReceipt = {
    path: request.launchReceiptPath,
    sha256: sha256(receiptBytes),
    fingerprint: receipt.receiptFingerprint
  }
  loadProfileLaunchReceipt(launchReceipt)
  return {
    approvalMode: request.approvalMode,
    approvalPolicy: pair.approvalPolicy,
    approvalsReviewer: pair.approvalsReviewer,
    installedProfile,
    launchReceipt
  }
}

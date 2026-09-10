import { randomUUID } from 'node:crypto'
import { ExecutionTokenSigningPort } from '../../domain/ports/execution-token-signing.port'
import { ExecutionTokenRegistry } from '../../domain/services/execution-token-registry'
import {
  HumanOboSubjectScope,
  requireHumanOboSubjectScope
} from '../../domain/services/human-obo-subject-scope'

export interface VerifiedExecutionWorkload {
  readonly spiffeId: string
  readonly certificateThumbprint: string
}

export interface TrustedExecutionContext {
  readonly subject: string
  readonly principalType: 'HUMAN' | 'MACHINE' | 'DELEGATED'
  readonly scopeLevel?: 'SYSTEM' | 'TENANT'
  readonly tenantId?: string
  readonly orgId?: string
  /** @deprecated Legacy context field retained only for compile compatibility; the signing gate never reads it. */
  readonly permissionCodes?: readonly string[]
  readonly sessionId?: string
  readonly sessionTerminal?: string
  readonly delegationId?: string
  readonly actor?: unknown
  readonly sourceTokenId?: string
  readonly sourceAudience?: string
  readonly sourceExpiresAt?: number
  /** Reopens the exact actor policy already selected by the strict prior-hop subject verifier. */
  readonly actorWorkloadSpiffeId?: string
  readonly actorTargetAudience?: string
  readonly requestId?: string
  readonly traceId?: string
  readonly spanId?: string
}

/** Carries only Permission's authoritative, request-bound issuance upper bound into the signing gate. */
export interface ExecutionTokenAuthorizationDecision {
  readonly allowed: boolean
  readonly kind: 'BUSINESS' | 'INTERNAL' | 'SELF_SERVICE'
  readonly grantedPermissionCodes: readonly string[]
  readonly deniedPermissionCodes: readonly string[]
  readonly principalType: 'HUMAN' | 'MACHINE' | 'DELEGATED'
  readonly principalId: string
  readonly scopeLevel: 'SYSTEM' | 'TENANT'
  readonly tenantId?: string
  readonly orgId?: string
  readonly targetAudience: string
  readonly originalWorkloadSpiffeId?: string
  readonly requestedPermissionCodes: readonly string[]
  readonly decisionReference: string
  readonly authzVersion: string
}

export interface ExchangeExecutionTokenInput {
  readonly targetAudience: string
  readonly requestedPermissionCodes: readonly string[]
  readonly workloadIdentity: VerifiedExecutionWorkload
  readonly execution: TrustedExecutionContext
  readonly authorizationDecision: ExecutionTokenAuthorizationDecision
}

export interface IssuedExecutionToken {
  readonly accessToken: string
  readonly tokenType: 'Bearer'
  readonly expiresAtUnixSeconds: number
  readonly expiresInSeconds: number
  readonly kid: string
  readonly grantedPermissionCodes: readonly string[]
  readonly grantedAudience: string
}

/** Issues a five-minute ES256 at+jwt only from transport-verified execution context and immutable registry facts. */
export class ExecutionTokenExchangeService {
  static readonly MAX_TTL_SECONDS = 300
  static readonly JWKS_CACHE_SECONDS = 300

  constructor(
    private readonly registry: ExecutionTokenRegistry,
    private readonly signer: ExecutionTokenSigningPort,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
    private readonly audit?: {
      appendOboLink(input: {
        sourceTokenId: string
        targetTokenId: string
        subject: string
        subjectScope: 'SYSTEM' | 'TENANT'
        tenantId?: string
        actor: unknown
        workload: string
        audience: string
        decisionReference: string
        requestId: string
        traceId: string
        spanId: string
      }): Promise<void>
    }
  ) {}

  /** Signs one exact-audience, certificate-bound credential after rejecting caller-selected trust and privilege expansion. */
  async exchange(input: ExchangeExecutionTokenInput): Promise<IssuedExecutionToken> {
    const permissions = normalizePermissionCodes(input.requestedPermissionCodes)
    const now = this.now()
    const humanOboScope = this.assertTrustedContext(input, permissions, now)
    const signingKey = await this.signer.currentSigningKey()
    assertSigningKeyEligible(signingKey, now)

    const expiresAtUnixSeconds = Math.min(
      now + ExecutionTokenExchangeService.MAX_TTL_SECONDS,
      input.execution.sourceExpiresAt ?? Number.MAX_SAFE_INTEGER
    )
    const header = encodeSegment({ alg: 'ES256', kid: signingKey.kid, typ: 'at+jwt' })
    const targetTokenId = randomUUID()
    const claims = encodeSegment({
      iss: this.registry.issuer,
      aud: input.targetAudience,
      sub: input.execution.subject,
      principal_type: input.execution.principalType,
      client_id: input.workloadIdentity.spiffeId,
      ...(input.execution.tenantId === undefined ? {} : { tenant_id: input.execution.tenantId }),
      ...(input.execution.orgId === undefined ? {} : { org_id: input.execution.orgId }),
      scope: permissions.join(' '),
      jti: targetTokenId,
      iat: now,
      nbf: now,
      exp: expiresAtUnixSeconds,
      cnf: { 'x5t#S256': input.workloadIdentity.certificateThumbprint },
      ...(input.execution.sessionId === undefined ? {} : { session_id: input.execution.sessionId }),
      ...(input.execution.sessionTerminal === undefined
        ? {}
        : { session_terminal: input.execution.sessionTerminal }),
      ...(input.execution.delegationId === undefined
        ? {}
        : { delegation_id: input.execution.delegationId }),
      ...(input.execution.actor === undefined ? {} : { act: input.execution.actor }),
      authz_version: input.authorizationDecision.authzVersion
    })
    const signingInput = `${header}.${claims}`
    const signature = await this.signer.sign(signingKey.kid, Buffer.from(signingInput, 'utf8'))
    if (input.execution.sourceTokenId) {
      if (!input.execution.actor || !humanOboScope || !this.audit)
        throw new Error('execution token OBO audit is unavailable')
      await this.audit.appendOboLink({
        sourceTokenId: input.execution.sourceTokenId,
        targetTokenId,
        subject: input.execution.subject,
        subjectScope: humanOboScope.subjectScope,
        ...(humanOboScope.optionalTenantId === undefined
          ? {}
          : { tenantId: humanOboScope.optionalTenantId }),
        actor: input.execution.actor,
        workload: input.workloadIdentity.spiffeId,
        audience: input.targetAudience,
        decisionReference: input.authorizationDecision.decisionReference,
        requestId: input.execution.requestId as string,
        traceId: input.execution.traceId as string,
        spanId: input.execution.spanId as string
      })
    }

    return Object.freeze({
      accessToken: `${signingInput}.${Buffer.from(signature).toString('base64url')}`,
      tokenType: 'Bearer',
      expiresAtUnixSeconds,
      expiresInSeconds: expiresAtUnixSeconds - now,
      kid: signingKey.kid,
      grantedPermissionCodes: permissions,
      grantedAudience: input.targetAudience
    })
  }

  /** Validates the transport facts and Permission-owned upper bound before the signing port is reachable. */
  private assertTrustedContext(
    input: ExchangeExecutionTokenInput,
    permissionCodes: readonly string[],
    now: number
  ): HumanOboSubjectScope | undefined {
    if (
      !input.workloadIdentity.spiffeId.startsWith('spiffe://') ||
      !isThumbprint(input.workloadIdentity.certificateThumbprint) ||
      !input.execution.subject ||
      !authorizationDecisionMatches(input, permissionCodes)
    ) {
      throw new Error('execution token exchange lacks an authoritative Permission decision')
    }
    let humanOboScope: HumanOboSubjectScope | undefined
    if (input.execution.sourceTokenId !== undefined) {
      let expectedActorId: string
      try {
        humanOboScope = requireHumanOboSubjectScope(
          input.execution.scopeLevel,
          input.execution.tenantId
        )
        const actorPolicyWorkload =
          input.execution.actorWorkloadSpiffeId ?? input.workloadIdentity.spiffeId
        const actorPolicyTarget = input.execution.actorTargetAudience ?? input.targetAudience
        expectedActorId = this.registry.resolveHumanOboActor(
          actorPolicyWorkload,
          input.execution.sourceAudience as string,
          actorPolicyTarget
        ).actorMachinePrincipalId
      } catch {
        throw new Error('execution token HUMAN OBO context is invalid')
      }
      if (
        !isExact(input.execution.sourceTokenId) ||
        !isExact(input.execution.sourceAudience) ||
        input.execution.principalType !== 'HUMAN' ||
        !isExact(input.execution.sessionId) ||
        !isDirectSystemMachineActor(input.execution.actor, expectedActorId) ||
        !Number.isInteger(input.execution.sourceExpiresAt) ||
        (input.execution.sourceExpiresAt as number) <= now ||
        !isExact(input.execution.requestId) ||
        !isTraceId(input.execution.traceId) ||
        !isSpanId(input.execution.spanId) ||
        !oboActorPolicyReferenceIsComplete(input.execution) ||
        !this.audit
      ) {
        throw new Error('execution token HUMAN OBO context is invalid')
      }
    } else if (
      input.execution.sourceAudience !== undefined ||
      input.execution.sourceExpiresAt !== undefined
    ) {
      throw new Error('execution token HUMAN OBO context is invalid')
    }
    if (input.authorizationDecision.kind === 'SELF_SERVICE' && permissionCodes.length === 0) {
      this.registry.assertSelfIssuanceAllowed(input.workloadIdentity.spiffeId, input.targetAudience)
    } else {
      this.registry.assertIssuanceAllowed(input.workloadIdentity.spiffeId, input.targetAudience)
    }
    return humanOboScope
  }
}

/** Accepts either the direct exchange pair or both verifier-retained actor-policy coordinates. */
function oboActorPolicyReferenceIsComplete(execution: TrustedExecutionContext): boolean {
  const workload = execution.actorWorkloadSpiffeId
  const audience = execution.actorTargetAudience
  return (
    (workload === undefined && audience === undefined) || (isExact(workload) && isExact(audience))
  )
}

/** Accepts only one direct registry-selected SYSTEM MACHINE actor and no caller-built actor chain. */
function isDirectSystemMachineActor(actor: unknown, expectedActorId: string): boolean {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return false
  const value = actor as Record<string, unknown>
  return (
    Object.keys(value).length === 3 &&
    value.sub === expectedActorId &&
    value.principal_type === 'MACHINE' &&
    value.scope_level === 'SYSTEM'
  )
}

/** Requires requested Codes to be a true subset of Permission's bound authoritative grant. */
function authorizationDecisionMatches(
  input: ExchangeExecutionTokenInput,
  requestedPermissionCodes: readonly string[]
): boolean {
  const decision = input.authorizationDecision
  const granted = canonicalDecisionCodes(decision?.grantedPermissionCodes)
  const denied = canonicalDecisionCodes(decision?.deniedPermissionCodes)
  const requested = [...requestedPermissionCodes]
  if (
    !decision?.allowed ||
    !isExact(decision.decisionReference) ||
    !isExact(decision.authzVersion) ||
    decision.principalType !== input.execution.principalType ||
    decision.principalId !== input.execution.subject ||
    decision.scopeLevel !== input.execution.scopeLevel ||
    decision.tenantId !== input.execution.tenantId ||
    decision.orgId !== input.execution.orgId ||
    decision.targetAudience !== input.targetAudience ||
    !sameCodes(decision.requestedPermissionCodes, requested) ||
    granted === undefined ||
    denied === undefined ||
    requested.some((code) => !granted.includes(code) || denied.includes(code))
  ) {
    return false
  }
  if (decision.kind === 'SELF_SERVICE') {
    return (
      requested.length === 0 && granted.length === 0 && input.execution.principalType === 'HUMAN'
    )
  }
  if (requested.length === 0) return false
  return (
    decision.kind === 'BUSINESS' ||
    (decision.kind === 'INTERNAL' &&
      decision.originalWorkloadSpiffeId === input.workloadIdentity.spiffeId)
  )
}

/** Accepts only exact, unique, canonically sorted Code arrays from the decision boundary. */
function canonicalDecisionCodes(
  codes: readonly string[] | undefined
): readonly string[] | undefined {
  if (!Array.isArray(codes) || codes.some((code) => !isExact(code))) return undefined
  const canonical = [...new Set(codes)].sort()
  return sameCodes(codes, canonical) ? canonical : undefined
}

/** Compares two already-bounded Code lists without treating either list as authority by itself. */
function sameCodes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((code, index) => code === right[index])
}

/** Requires a non-empty exact string for stable decision references and authorization versions. */
function isExact(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

/** Requires an exact canonical request while reserving the empty set for the later SELF_SERVICE gate. */
function normalizePermissionCodes(permissionCodes: readonly string[]): readonly string[] {
  if (
    new Set(permissionCodes).size !== permissionCodes.length ||
    permissionCodes.some((code, index) => !code || code !== [...permissionCodes].sort()[index])
  ) {
    throw new Error('execution token permissions must be unique and canonical')
  }
  return Object.freeze([...permissionCodes])
}

/** Guarantees the active key was published for the full verifier cache period before Auth uses it for signing. */
function assertSigningKeyEligible(
  key: Awaited<ReturnType<ExecutionTokenSigningPort['currentSigningKey']>>,
  now: number
): void {
  if (
    !key.kid ||
    key.publishNotBeforeUnixSeconds + ExecutionTokenExchangeService.JWKS_CACHE_SECONDS >
      key.signingNotBeforeUnixSeconds ||
    key.signingNotBeforeUnixSeconds > now ||
    key.retireAfterUnixSeconds <= now
  ) {
    throw new Error('execution token signing key is not eligible')
  }
}

/** Encodes a controlled JWS JSON segment without accepting caller-controlled serialization. */
function encodeSegment(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** Validates the standard SHA-256 base64url certificate-thumbprint representation. */
function isThumbprint(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}

/** Validates the canonical lowercase-or-uppercase 128-bit W3C trace identifier. */
function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value) && !/^0{32}$/.test(value)
}

/** Validates the canonical lowercase-or-uppercase 64-bit W3C span identifier. */
function isSpanId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value) && !/^0{16}$/.test(value)
}

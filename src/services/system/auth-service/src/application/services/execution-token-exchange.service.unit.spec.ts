import { generateKeyPairSync, sign, verify } from 'node:crypto'
import {
  ExchangeExecutionTokenInput,
  ExecutionTokenExchangeService
} from './execution-token-exchange.service'
import {
  ExecutionTokenSigningKey,
  ExecutionTokenSigningPort
} from '../../domain/ports/execution-token-signing.port'
import { ExecutionTokenRegistry } from '../../domain/services/execution-token-registry'

/** Provides isolated P-256 signing material so the exchange test covers Auth's KMS/HSM boundary contract. */
class FakeExecutionTokenSigningPort implements ExecutionTokenSigningPort {
  readonly pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  readonly key: ExecutionTokenSigningKey = {
    kid: 'auth-2026-07-01',
    publicJwk: this.pair.publicKey.export({ format: 'jwk' }),
    publishNotBeforeUnixSeconds: 1_700_000_000,
    signingNotBeforeUnixSeconds: 1_700_000_300,
    retireAfterUnixSeconds: 1_700_000_660
  }

  async currentSigningKey(): Promise<ExecutionTokenSigningKey> {
    return this.key
  }

  async publishedKeys(): Promise<readonly ExecutionTokenSigningKey[]> {
    return [this.key]
  }

  async sign(kid: string, input: Uint8Array): Promise<Uint8Array> {
    if (kid !== this.key.kid) {
      throw new Error('unexpected signing key')
    }
    return sign('sha256', input, { key: this.pair.privateKey, dsaEncoding: 'ieee-p1363' })
  }
}

const REQUEST_ID = 'request-system-obo-1'
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN_ID = '00f067aa0ba902b7'
const GATEWAY_SELF_AUDIENCE = 'urn:oes:service:api-gateway'
const MES_SELF_AUDIENCE = 'urn:oes:service:mes-service'

/** Builds one immutable registry whose HUMAN OBO selector is independently enforced again at signing. */
function oboRegistry(input: {
  spiffeId: string
  selfAudience: string
  targetAudience: string
  actorMachinePrincipalId: string
}): ExecutionTokenRegistry {
  return new ExecutionTokenRegistry({
    issuer: 'https://auth.local.oes.example',
    workloadPolicies: [
      {
        spiffeId: input.spiffeId,
        audiences: [input.targetAudience],
        humanObo: {
          selfAudience: input.selfAudience,
          actorMachinePrincipalId: input.actorMachinePrincipalId,
          actorBindingId: `binding-${input.actorMachinePrincipalId}`,
          actorBindingVersion: '1',
          targetAudiences: [input.targetAudience]
        }
      }
    ]
  })
}

/** Builds the canonical tenantless SYSTEM HUMAN OBO signing input for focused mutation tests. */
function systemOboInput(): ExchangeExecutionTokenInput {
  return {
    targetAudience: 'urn:oes:service:permission-service',
    requestedPermissionCodes: ['permission.internal.account_access_summary.resolve'],
    workloadIdentity: {
      spiffeId: 'spiffe://local.oes/gateway',
      certificateThumbprint: 'A'.repeat(43)
    },
    execution: {
      subject: 'system-account-1',
      principalType: 'HUMAN',
      scopeLevel: 'SYSTEM',
      sessionId: 'system-session-1',
      sessionTerminal: 'WEB',
      actor: {
        sub: 'machine-gateway',
        principal_type: 'MACHINE',
        scope_level: 'SYSTEM'
      },
      sourceTokenId: 'system-subject-jti',
      sourceAudience: GATEWAY_SELF_AUDIENCE,
      sourceExpiresAt: 1_700_000_420,
      requestId: REQUEST_ID,
      traceId: TRACE_ID,
      spanId: SPAN_ID
    },
    authorizationDecision: {
      allowed: true,
      kind: 'INTERNAL',
      grantedPermissionCodes: ['permission.internal.account_access_summary.resolve'],
      deniedPermissionCodes: [],
      principalType: 'HUMAN',
      principalId: 'system-account-1',
      scopeLevel: 'SYSTEM',
      targetAudience: 'urn:oes:service:permission-service',
      originalWorkloadSpiffeId: 'spiffe://local.oes/gateway',
      requestedPermissionCodes: ['permission.internal.account_access_summary.resolve'],
      decisionReference: 'decision-system-obo-1',
      authzVersion: 'authz-system-obo-1'
    }
  }
}

/** Proves Auth issues only one registered, ES256, certificate-bound access token from trusted execution facts. */
describe('ExecutionTokenExchangeService', () => {
  it('issues and audits a tenantless SYSTEM HUMAN OBO token', async () => {
    const signer = new FakeExecutionTokenSigningPort()
    const audit = { appendOboLink: jest.fn().mockResolvedValue(undefined) }
    const service = new ExecutionTokenExchangeService(
      oboRegistry({
        spiffeId: 'spiffe://local.oes/gateway',
        selfAudience: GATEWAY_SELF_AUDIENCE,
        targetAudience: 'urn:oes:service:permission-service',
        actorMachinePrincipalId: 'machine-gateway'
      }),
      signer,
      () => 1_700_000_300,
      audit
    )
    const input = systemOboInput()
    const result = await service.exchange(input)

    const claims = JSON.parse(
      Buffer.from(result.accessToken.split('.')[1], 'base64url').toString('utf8')
    )
    expect(claims).toMatchObject({
      sub: 'system-account-1',
      principal_type: 'HUMAN',
      act: input.execution.actor,
      scope: 'permission.internal.account_access_summary.resolve'
    })
    expect(claims).not.toHaveProperty('tenant_id')
    expect(claims).not.toHaveProperty('scope_level')
    expect(audit.appendOboLink).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTokenId: 'system-subject-jti',
        subject: 'system-account-1',
        subjectScope: 'SYSTEM',
        actor: input.execution.actor,
        decisionReference: 'decision-system-obo-1',
        requestId: REQUEST_ID,
        traceId: TRACE_ID,
        spanId: SPAN_ID
      })
    )
  })

  it('retains the verified originating actor policy while Auth issues the principal-decision bootstrap token', async () => {
    const signer = new FakeExecutionTokenSigningPort()
    const audit = { appendOboLink: jest.fn().mockResolvedValue(undefined) }
    const collaborationSpiffeId = 'spiffe://local.oes/collaboration-service'
    const authSpiffeId = 'spiffe://local.oes/auth-service'
    const identityAudience = 'urn:oes:service:identity-service'
    const permissionAudience = 'urn:oes:service:permission-service'
    const service = new ExecutionTokenExchangeService(
      new ExecutionTokenRegistry({
        issuer: 'https://auth.local.oes.example',
        workloadPolicies: [
          {
            spiffeId: collaborationSpiffeId,
            audiences: [identityAudience],
            humanObo: {
              selfAudience: 'urn:oes:service:collaboration-service',
              actorMachinePrincipalId: 'machine-collaboration',
              actorBindingId: 'binding-machine-collaboration',
              actorBindingVersion: '1',
              targetAudiences: [identityAudience]
            }
          },
          { spiffeId: authSpiffeId, audiences: [permissionAudience] }
        ]
      }),
      signer,
      () => 1_700_000_300,
      audit
    )

    const result = await service.exchange({
      targetAudience: permissionAudience,
      requestedPermissionCodes: ['permission.internal.principal_authorization.resolve'],
      workloadIdentity: {
        spiffeId: authSpiffeId,
        certificateThumbprint: 'D'.repeat(43)
      },
      execution: {
        subject: 'account-1',
        principalType: 'HUMAN',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        sessionTerminal: 'WEB',
        actor: {
          sub: 'machine-collaboration',
          principal_type: 'MACHINE',
          scope_level: 'SYSTEM'
        },
        sourceTokenId: 'collaboration-subject-jti',
        sourceAudience: 'urn:oes:service:collaboration-service',
        sourceExpiresAt: 1_700_000_420,
        actorWorkloadSpiffeId: collaborationSpiffeId,
        actorTargetAudience: identityAudience,
        requestId: 'request-nested-bootstrap-1',
        traceId: TRACE_ID,
        spanId: SPAN_ID
      },
      authorizationDecision: {
        allowed: true,
        kind: 'INTERNAL',
        grantedPermissionCodes: ['permission.internal.principal_authorization.resolve'],
        deniedPermissionCodes: [],
        principalType: 'HUMAN',
        principalId: 'account-1',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        targetAudience: permissionAudience,
        originalWorkloadSpiffeId: authSpiffeId,
        requestedPermissionCodes: ['permission.internal.principal_authorization.resolve'],
        decisionReference: 'decision-nested-bootstrap-1',
        authzVersion: 'authz-nested-bootstrap-1'
      }
    })

    const claims = JSON.parse(
      Buffer.from(result.accessToken.split('.')[1], 'base64url').toString('utf8')
    )
    expect(claims).toMatchObject({
      client_id: authSpiffeId,
      aud: permissionAudience,
      sub: 'account-1',
      act: { sub: 'machine-collaboration', principal_type: 'MACHINE', scope_level: 'SYSTEM' },
      exp: 1_700_000_420
    })
    expect(audit.appendOboLink).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTokenId: 'collaboration-subject-jti',
        workload: authSpiffeId,
        audience: permissionAudience
      })
    )
  })

  it.each([
    [
      'TENANT without tenant',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        execution: { ...input.execution, scopeLevel: 'TENANT' as const },
        authorizationDecision: { ...input.authorizationDecision, scopeLevel: 'TENANT' as const }
      })
    ],
    [
      'SYSTEM with tenant',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        execution: { ...input.execution, tenantId: 'tenant-1' },
        authorizationDecision: { ...input.authorizationDecision, tenantId: 'tenant-1' }
      })
    ],
    [
      'wrong tenant decision',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        execution: { ...input.execution, scopeLevel: 'TENANT' as const, tenantId: 'tenant-1' },
        authorizationDecision: {
          ...input.authorizationDecision,
          scopeLevel: 'TENANT' as const,
          tenantId: 'tenant-2'
        }
      })
    ],
    [
      'actor shape mismatch',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        execution: {
          ...input.execution,
          actor: { ...(input.execution.actor as object), tenant_id: 'tenant-1' }
        }
      })
    ],
    [
      'registry actor identity mismatch',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        execution: {
          ...input.execution,
          actor: {
            sub: 'machine-not-registry-selected',
            principal_type: 'MACHINE',
            scope_level: 'SYSTEM'
          }
        }
      })
    ],
    [
      'source audience mismatch',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        execution: { ...input.execution, sourceAudience: 'urn:oes:service:other-service' }
      })
    ],
    [
      'subject mismatch',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        authorizationDecision: { ...input.authorizationDecision, principalId: 'other-account' }
      })
    ],
    [
      'scope mismatch',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        authorizationDecision: { ...input.authorizationDecision, scopeLevel: 'TENANT' as const }
      })
    ],
    [
      'target mismatch',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        authorizationDecision: {
          ...input.authorizationDecision,
          targetAudience: 'urn:oes:service:other-service'
        }
      })
    ],
    [
      'workload mismatch',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        authorizationDecision: {
          ...input.authorizationDecision,
          originalWorkloadSpiffeId: 'spiffe://local.oes/other-service'
        }
      })
    ],
    [
      'missing correlation',
      (input: ExchangeExecutionTokenInput) => ({
        ...input,
        execution: {
          ...input.execution,
          requestId: undefined,
          traceId: undefined,
          spanId: undefined
        }
      })
    ]
  ])('rejects %s before signer invocation', async (_label, mutate) => {
    const signer = new FakeExecutionTokenSigningPort()
    const signSpy = jest.spyOn(signer, 'sign')
    const service = new ExecutionTokenExchangeService(
      oboRegistry({
        spiffeId: 'spiffe://local.oes/gateway',
        selfAudience: GATEWAY_SELF_AUDIENCE,
        targetAudience: 'urn:oes:service:permission-service',
        actorMachinePrincipalId: 'machine-gateway'
      }),
      signer,
      () => 1_700_000_300,
      { appendOboLink: jest.fn().mockResolvedValue(undefined) }
    )

    await expect(service.exchange(mutate(systemOboInput()))).rejects.toThrow()
    expect(signSpy).not.toHaveBeenCalled()
  })

  it('issues a registered ES256 at+jwt bound to the verified workload certificate', async () => {
    const signer = new FakeExecutionTokenSigningPort()
    const service = new ExecutionTokenExchangeService(
      new ExecutionTokenRegistry({
        issuer: 'https://auth.local.oes.example',
        workloadPolicies: [
          {
            spiffeId: 'spiffe://local.oes/gateway',
            audiences: ['urn:oes:service:permission-service']
          }
        ]
      }),
      signer,
      () => 1_700_000_300
    )

    const result = await service.exchange({
      targetAudience: 'urn:oes:service:permission-service',
      requestedPermissionCodes: ['AUTH.READ'],
      workloadIdentity: {
        spiffeId: 'spiffe://local.oes/gateway',
        certificateThumbprint: 'A'.repeat(43)
      },
      execution: {
        subject: 'account-1',
        principalType: 'HUMAN',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        sessionTerminal: 'WEB'
      },
      authorizationDecision: {
        allowed: true,
        kind: 'BUSINESS',
        grantedPermissionCodes: ['AUTH.READ'],
        deniedPermissionCodes: [],
        principalType: 'HUMAN',
        principalId: 'account-1',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        targetAudience: 'urn:oes:service:permission-service',
        requestedPermissionCodes: ['AUTH.READ'],
        decisionReference: 'decision-1',
        authzVersion: 'authz-1'
      }
    })

    const [encodedHeader, encodedClaims, encodedSignature] = result.accessToken.split('.')
    expect(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))).toEqual({
      alg: 'ES256',
      kid: 'auth-2026-07-01',
      typ: 'at+jwt'
    })
    expect(JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'))).toEqual(
      expect.objectContaining({
        iss: 'https://auth.local.oes.example',
        aud: 'urn:oes:service:permission-service',
        client_id: 'spiffe://local.oes/gateway',
        cnf: { 'x5t#S256': 'A'.repeat(43) },
        scope: 'AUTH.READ',
        exp: 1_700_000_600,
        session_terminal: 'WEB'
      })
    )
    expect(
      verify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: signer.pair.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(encodedSignature, 'base64url')
      )
    ).toBe(true)
    expect(result).toMatchObject({
      tokenType: 'Bearer',
      expiresAtUnixSeconds: 1_700_000_600,
      expiresInSeconds: 300,
      kid: 'auth-2026-07-01',
      grantedAudience: 'urn:oes:service:permission-service',
      grantedPermissionCodes: ['AUTH.READ']
    })
  })

  it('rejects a requested Code outside the authoritative Permission decision even when execution mirrors the request', async () => {
    const signer = new FakeExecutionTokenSigningPort()
    const signSpy = jest.spyOn(signer, 'sign')
    const service = new ExecutionTokenExchangeService(
      new ExecutionTokenRegistry({
        issuer: 'https://auth.local.oes.example',
        workloadPolicies: [
          {
            spiffeId: 'spiffe://local.oes/gateway',
            audiences: ['urn:oes:service:permission-service']
          }
        ]
      }),
      signer,
      () => 1_700_000_300
    )

    await expect(
      service.exchange({
        targetAudience: 'urn:oes:service:permission-service',
        requestedPermissionCodes: ['AUTH.READ', 'AUTH.WRITE'],
        workloadIdentity: {
          spiffeId: 'spiffe://local.oes/gateway',
          certificateThumbprint: 'A'.repeat(43)
        },
        execution: {
          subject: 'account-1',
          principalType: 'HUMAN',
          scopeLevel: 'TENANT',
          tenantId: 'tenant-1'
        },
        authorizationDecision: {
          allowed: true,
          kind: 'BUSINESS',
          grantedPermissionCodes: ['AUTH.READ'],
          deniedPermissionCodes: [],
          principalType: 'HUMAN',
          principalId: 'account-1',
          scopeLevel: 'TENANT',
          tenantId: 'tenant-1',
          targetAudience: 'urn:oes:service:permission-service',
          requestedPermissionCodes: ['AUTH.READ', 'AUTH.WRITE'],
          decisionReference: 'decision-1',
          authzVersion: 'authz-1'
        }
      } as any)
    ).rejects.toThrow('authoritative Permission decision')
    expect(signSpy).not.toHaveBeenCalled()
  })

  it('issues the canonical empty SELF_SERVICE scope only from a verified HUMAN session decision', async () => {
    const service = new ExecutionTokenExchangeService(
      new ExecutionTokenRegistry({
        issuer: 'https://auth.local.oes.example',
        workloadPolicies: [
          {
            spiffeId: 'spiffe://local.oes/gateway',
            audiences: ['urn:oes:service:asset-service']
          }
        ]
      }),
      new FakeExecutionTokenSigningPort(),
      () => 1_700_000_300
    )

    const result = await service.exchange({
      targetAudience: 'urn:oes:service:asset-service',
      requestedPermissionCodes: [],
      workloadIdentity: {
        spiffeId: 'spiffe://local.oes/gateway',
        certificateThumbprint: 'A'.repeat(43)
      },
      execution: {
        subject: 'account-1',
        principalType: 'HUMAN',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        sessionTerminal: 'BROWSER_EXTENSION'
      },
      authorizationDecision: {
        allowed: true,
        kind: 'SELF_SERVICE',
        grantedPermissionCodes: [],
        deniedPermissionCodes: [],
        principalType: 'HUMAN',
        principalId: 'account-1',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        targetAudience: 'urn:oes:service:asset-service',
        requestedPermissionCodes: [],
        decisionReference: 'self-service-session:session-1',
        authzVersion: 'session:session-1'
      }
    })

    const claims = JSON.parse(
      Buffer.from(result.accessToken.split('.')[1], 'base64url').toString('utf8')
    )
    expect(result.grantedPermissionCodes).toEqual([])
    expect(claims.scope).toBe('')
    expect(claims.session_terminal).toBe('BROWSER_EXTENSION')
  })

  it('issues one expiry-capped HUMAN OBO token and durably links subject jti to target jti', async () => {
    const signer = new FakeExecutionTokenSigningPort()
    const audit = { appendOboLink: jest.fn().mockResolvedValue(undefined) }
    const service = new ExecutionTokenExchangeService(
      oboRegistry({
        spiffeId: 'spiffe://local.oes/mes-service',
        selfAudience: MES_SELF_AUDIENCE,
        targetAudience: 'urn:oes:service:item-master-service',
        actorMachinePrincipalId: 'machine-mes'
      }),
      signer,
      () => 1_700_000_300,
      audit
    )
    const actor = {
      sub: 'machine-mes',
      principal_type: 'MACHINE',
      scope_level: 'SYSTEM'
    }
    const result = await service.exchange({
      targetAudience: 'urn:oes:service:item-master-service',
      requestedPermissionCodes: ['item_master.internal.manufacturable_item.resolve'],
      workloadIdentity: {
        spiffeId: 'spiffe://local.oes/mes-service',
        certificateThumbprint: 'C'.repeat(43)
      },
      execution: {
        subject: 'account-1',
        principalType: 'HUMAN',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        sessionTerminal: 'WEB',
        actor,
        sourceTokenId: 'subject-jti',
        sourceAudience: MES_SELF_AUDIENCE,
        sourceExpiresAt: 1_700_000_420,
        requestId: 'request-tenant-obo-1',
        traceId: TRACE_ID,
        spanId: SPAN_ID
      },
      authorizationDecision: {
        allowed: true,
        kind: 'INTERNAL',
        grantedPermissionCodes: ['item_master.internal.manufacturable_item.resolve'],
        deniedPermissionCodes: [],
        principalType: 'HUMAN',
        principalId: 'account-1',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        targetAudience: 'urn:oes:service:item-master-service',
        originalWorkloadSpiffeId: 'spiffe://local.oes/mes-service',
        requestedPermissionCodes: ['item_master.internal.manufacturable_item.resolve'],
        decisionReference: 'decision-obo-1',
        authzVersion: 'authz-obo-1'
      }
    })

    const claims = JSON.parse(
      Buffer.from(result.accessToken.split('.')[1], 'base64url').toString('utf8')
    )
    expect(claims).toMatchObject({
      sub: 'account-1',
      principal_type: 'HUMAN',
      tenant_id: 'tenant-1',
      session_id: 'session-1',
      session_terminal: 'WEB',
      client_id: 'spiffe://local.oes/mes-service',
      cnf: { 'x5t#S256': 'C'.repeat(43) },
      act: actor,
      exp: 1_700_000_420
    })
    expect(result.expiresInSeconds).toBe(120)
    expect(audit.appendOboLink).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTokenId: 'subject-jti',
        targetTokenId: claims.jti,
        subjectScope: 'TENANT',
        tenantId: 'tenant-1',
        actor,
        audience: 'urn:oes:service:item-master-service',
        decisionReference: 'decision-obo-1',
        requestId: 'request-tenant-obo-1',
        traceId: TRACE_ID,
        spanId: SPAN_ID
      })
    )
  })

  it('fails closed when OBO audit persistence fails', async () => {
    const signer = new FakeExecutionTokenSigningPort()
    const service = new ExecutionTokenExchangeService(
      oboRegistry({
        spiffeId: 'spiffe://local.oes/mes-service',
        selfAudience: MES_SELF_AUDIENCE,
        targetAudience: 'urn:oes:service:item-master-service',
        actorMachinePrincipalId: 'machine-mes'
      }),
      signer,
      () => 1_700_000_300,
      { appendOboLink: jest.fn().mockRejectedValue(new Error('audit unavailable')) }
    )
    const input = {
      targetAudience: 'urn:oes:service:item-master-service',
      requestedPermissionCodes: ['item_master.internal.manufacturable_item.resolve'],
      workloadIdentity: {
        spiffeId: 'spiffe://local.oes/mes-service',
        certificateThumbprint: 'C'.repeat(43)
      },
      execution: {
        subject: 'account-1',
        principalType: 'HUMAN',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        actor: { sub: 'machine-mes', principal_type: 'MACHINE', scope_level: 'SYSTEM' },
        sourceTokenId: 'subject-jti',
        sourceAudience: MES_SELF_AUDIENCE,
        sourceExpiresAt: 1_700_000_420,
        requestId: 'request-tenant-obo-1',
        traceId: TRACE_ID,
        spanId: SPAN_ID
      },
      authorizationDecision: {
        allowed: true,
        kind: 'INTERNAL',
        grantedPermissionCodes: ['item_master.internal.manufacturable_item.resolve'],
        deniedPermissionCodes: [],
        principalType: 'HUMAN',
        principalId: 'account-1',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        targetAudience: 'urn:oes:service:item-master-service',
        originalWorkloadSpiffeId: 'spiffe://local.oes/mes-service',
        requestedPermissionCodes: ['item_master.internal.manufacturable_item.resolve'],
        decisionReference: 'decision-obo-1',
        authzVersion: 'authz-obo-1'
      }
    } as const

    await expect(service.exchange(input)).rejects.toThrow('audit unavailable')
  })
})

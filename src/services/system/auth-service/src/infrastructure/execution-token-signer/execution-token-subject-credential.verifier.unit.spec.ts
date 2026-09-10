import { generateKeyPairSync, sign } from 'node:crypto'
import { ExecutionTokenRegistry } from '../../domain/services/execution-token-registry'
import { ExecutionTokenSubjectCredentialVerifier } from './execution-token-subject-credential.verifier'

const WORKLOAD = {
  spiffeId: 'spiffe://oes/mes-service',
  certificateThumbprint: 'A'.repeat(43)
}
const TARGET = 'urn:oes:service:item-master-service'
const CORRELATION = Object.freeze({
  requestId: 'request-1',
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
})

/** Builds one real Auth-signed, MES-audience HUMAN subject ET and its frozen OBO dependencies. */
function fixture(overrides: Record<string, unknown> = {}, identityOverrides = {}) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const key = {
    kid: 'kid-1',
    publicJwk: pair.publicKey.export({ format: 'jwk' }),
    publishNotBeforeUnixSeconds: 1,
    signingNotBeforeUnixSeconds: 1,
    retireAfterUnixSeconds: 9_999_999_999
  }
  const identity = {
    resolveMachinePrincipalForAuth: jest.fn(async () => ({
      allowed: true,
      principalId: 'machine-mes',
      principalType: 'MACHINE',
      principalLifecycleStatus: 'ACTIVE',
      bindingId: 'binding-mes',
      bindingVersion: BigInt(1),
      bindingStatus: 'ACTIVE',
      workloadSpiffeId: WORKLOAD.spiffeId,
      scopeLevel: 'SYSTEM',
      ...identityOverrides
    }))
  }
  const registry = new ExecutionTokenRegistry({
    issuer: 'https://auth.example',
    workloadPolicies: [
      {
        spiffeId: WORKLOAD.spiffeId,
        audiences: [TARGET],
        humanObo: {
          selfAudience: 'urn:oes:service:mes-service',
          actorMachinePrincipalId: 'machine-mes',
          actorBindingId: 'binding-mes',
          actorBindingVersion: '1',
          targetAudiences: [TARGET]
        }
      }
    ]
  })
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: 'kid-1' })
  ).toString('base64url')
  const claims = Buffer.from(
    JSON.stringify({
      iss: registry.issuer,
      aud: 'urn:oes:service:mes-service',
      sub: 'account-1',
      principal_type: 'HUMAN',
      client_id: WORKLOAD.spiffeId,
      cnf: { 'x5t#S256': WORKLOAD.certificateThumbprint },
      scope: 'mes.production.read',
      tenant_id: 'tenant-1',
      session_id: 'session-1',
      session_terminal: 'WEB',
      jti: 'subject-jti',
      iat: 100,
      nbf: 100,
      exp: 400,
      ...overrides
    })
  ).toString('base64url')
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: pair.privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url')
  return {
    identity,
    registry,
    token: `${header}.${claims}.${signature}`,
    verifier: new ExecutionTokenSubjectCredentialVerifier(
      { publishedKeys: async () => [key] } as never,
      identity as never,
      registry,
      () => 200
    )
  }
}

/** Verifies one fixture token with the required trusted request/trace correlation by default. */
function verifySubject(
  current: ReturnType<typeof fixture>,
  token = current.token,
  correlation: typeof CORRELATION | undefined = CORRELATION
) {
  return current.verifier.verify(token, WORKLOAD, TARGET, correlation)
}

describe('ExecutionTokenSubjectCredentialVerifier', () => {
  it('derives SYSTEM from an absent tenant claim and preserves the tenantless subject', async () => {
    const current = fixture({ tenant_id: undefined })
    const result = await current.verifier.verify(current.token, WORKLOAD, TARGET, {
      requestId: 'request-system-1',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    })

    expect(current.identity.resolveMachinePrincipalForAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-system-1',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
      })
    )
    expect(result).toMatchObject({
      subject: 'account-1',
      principalType: 'HUMAN',
      scopeLevel: 'SYSTEM',
      sessionId: 'session-1',
      sessionTerminal: 'WEB',
      sourceTokenId: 'subject-jti',
      sourceExpiresAt: 400,
      actorWorkloadSpiffeId: WORKLOAD.spiffeId,
      actorTargetAudience: TARGET,
      requestId: 'request-system-1',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      actor: { sub: 'machine-mes', principal_type: 'MACHINE', scope_level: 'SYSTEM' }
    })
    expect(result).not.toHaveProperty('tenantId')
  })

  it('preserves HUMAN tenant/session and resolves the exact tenantless SYSTEM actor', async () => {
    const current = fixture()
    const result = await verifySubject(current)

    expect(current.identity.resolveMachinePrincipalForAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        machinePrincipalId: 'machine-mes',
        bindingId: 'binding-mes',
        bindingVersion: BigInt(1),
        workloadSpiffeId: WORKLOAD.spiffeId
      })
    )
    expect(result).toMatchObject({
      subject: 'account-1',
      principalType: 'HUMAN',
      scopeLevel: 'TENANT',
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      sessionTerminal: 'WEB',
      sourceTokenId: 'subject-jti',
      sourceExpiresAt: 400,
      actorWorkloadSpiffeId: WORKLOAD.spiffeId,
      actorTargetAudience: TARGET,
      actor: { sub: 'machine-mes', principal_type: 'MACHINE', scope_level: 'SYSTEM' }
    })
  })

  it.each([
    ['expired', { exp: 200 }],
    ['not active', { nbf: 201 }],
    ['nbf before iat', { iat: 150, nbf: 149 }],
    ['exp equal to iat', { iat: 300, nbf: 300, exp: 300 }],
    ['overlong lifetime', { iat: 100, nbf: 100, exp: 401 }],
    ['MACHINE subject', { principal_type: 'MACHINE' }],
    ['missing subject', { sub: undefined }],
    ['missing client', { client_id: undefined }],
    ['malformed client', { client_id: 'other-service' }],
    ['missing certificate binding', { cnf: undefined }],
    ['malformed certificate binding', { cnf: { 'x5t#S256': 'not-a-thumbprint' } }],
    [
      'extended certificate binding',
      { cnf: { 'x5t#S256': WORKLOAD.certificateThumbprint, caller: 'spoofed' } }
    ],
    ['scope-level value in JWT scope', { scope: 'SYSTEM' }],
    ['non-canonical Permission scope', { scope: 'mes.write mes.read' }],
    ['duplicate Permission scope', { scope: 'mes.read mes.read' }],
    ['explicit scope_level claim', { scope_level: 'SYSTEM' }],
    ['blank tenant', { tenant_id: '' }],
    ['wildcard tenant', { tenant_id: '*' }],
    ['blank session', { session_id: '' }],
    ['missing session', { session_id: undefined }],
    ['invalid terminal', { session_terminal: 'web' }],
    ['invalid security version', { authz_version: { caller: 'spoofed' } }],
    [
      'existing direct actor',
      { act: { sub: 'machine-old', principal_type: 'MACHINE', scope_level: 'SYSTEM' } }
    ],
    ['malformed existing actor', { act: 'machine-old' }],
    [
      'recursive existing actor',
      {
        act: {
          sub: 'machine-old',
          principal_type: 'MACHINE',
          scope_level: 'SYSTEM',
          act: { sub: 'machine-older' }
        }
      }
    ]
  ])('rejects a %s subject before Identity actor resolution', async (_label, claims) => {
    const current = fixture(claims)
    await expect(verifySubject(current)).rejects.toThrow('SUBJECT_INVALID')
    expect(current.identity.resolveMachinePrincipalForAuth).not.toHaveBeenCalled()
  })

  it('preserves a locally verified prior-hop binding while the registry binds the current exchanger actor', async () => {
    const current = fixture({
      client_id: 'spiffe://oes/api-gateway',
      cnf: { 'x5t#S256': 'B'.repeat(43) }
    })

    await expect(verifySubject(current)).resolves.toMatchObject({
      subject: 'account-1',
      sourceAudience: 'urn:oes:service:mes-service',
      actor: { sub: 'machine-mes', principal_type: 'MACHINE', scope_level: 'SYSTEM' }
    })
    expect(current.identity.resolveMachinePrincipalForAuth).toHaveBeenCalledWith(
      expect.objectContaining({ workloadSpiffeId: WORKLOAD.spiffeId })
    )
  })

  it('rejects a wrong current-service audience before Identity actor resolution', async () => {
    const current = fixture({ aud: 'urn:oes:service:wms-service' })
    await expect(verifySubject(current)).rejects.toThrow('not permitted')
    expect(current.identity.resolveMachinePrincipalForAuth).not.toHaveBeenCalled()
  })

  it.each([
    ['stale binding', { bindingVersion: BigInt(2) }],
    ['wrong workload', { workloadSpiffeId: 'spiffe://oes/wms-service' }],
    ['tenant-bearing actor', { tenantId: 'tenant-1' }],
    ['non-SYSTEM actor', { scopeLevel: 'TENANT' }],
    ['inactive principal', { principalLifecycleStatus: 'DISABLED' }],
    ['disabled actor', { allowed: false }]
  ])('rejects a %s Identity decision', async (_label, decision) => {
    const current = fixture({}, decision)
    await expect(verifySubject(current)).rejects.toThrow('ACTOR_INVALID')
  })

  it('propagates Identity outage and never returns execution facts', async () => {
    const current = fixture()
    current.identity.resolveMachinePrincipalForAuth.mockRejectedValueOnce(
      new Error('identity unavailable') as never
    )
    await expect(verifySubject(current)).rejects.toThrow('identity unavailable')
  })

  it('rejects malformed and wrongly signed subjects before actor resolution', async () => {
    const current = fixture()
    await expect(verifySubject(current, 'bad')).rejects.toThrow('SUBJECT_INVALID')
    const tampered = `${current.token.slice(0, -2)}aa`
    await expect(verifySubject(current, tampered)).rejects.toThrow('SUBJECT_INVALID')
    expect(current.identity.resolveMachinePrincipalForAuth).not.toHaveBeenCalled()
  })

  it('rejects missing correlation before Identity actor resolution', async () => {
    const current = fixture()
    await expect(
      current.verifier.verify(current.token, WORKLOAD, TARGET, undefined)
    ).rejects.toThrow('CORRELATION_REQUIRED')
    expect(current.identity.resolveMachinePrincipalForAuth).not.toHaveBeenCalled()
  })
})

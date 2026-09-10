import { Metadata } from '@grpc/grpc-js'
import { VerifiedExecutionTokenContextProvider } from './verified-execution-token-context.provider'

const WORKLOAD_IDENTITY = {
  spiffeId: 'spiffe://local.oes.internal/ns/oes/sa/api-gateway',
  certificateThumbprint: 'A'.repeat(43)
}

/** Builds only metadata emitted by the current transport-private source-credential carrier. */
function carrierMetadata(): Metadata {
  const metadata = new Metadata()
  metadata.set('authorization', 'Bearer verified.session.access-token')
  metadata.set('x-request-id', 'request-1')
  metadata.set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
  return metadata
}

/** Proves STS composes source verification, Permission authority, and mTLS without legacy reconstruction. */
describe('VerifiedExecutionTokenContextProvider', () => {
  const workload = {
    getVerifiedWorkloadIdentity: jest.fn().mockResolvedValue(WORKLOAD_IDENTITY)
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses the carrier bearer and authoritative Permission decision instead of mirrored request or legacy roles', async () => {
    const sourceCredentialVerifier = {
      verify: jest.fn().mockResolvedValue({
        subject: 'account-1',
        principalType: 'HUMAN',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        sessionTerminal: 'WEB'
      })
    }
    const permissionDecisionResolver = {
      resolve: jest.fn().mockResolvedValue({
        allowed: false,
        kind: 'BUSINESS',
        grantedPermissionCodes: ['AUTH.READ'],
        deniedPermissionCodes: ['AUTH.WRITE'],
        principalType: 'HUMAN',
        principalId: 'account-1',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        targetAudience: 'urn:oes:service:permission-service',
        requestedPermissionCodes: ['AUTH.READ', 'AUTH.WRITE'],
        decisionReference: 'decision-1',
        authzVersion: 'authz-1'
      })
    }
    const provider = new VerifiedExecutionTokenContextProvider(
      workload,
      sourceCredentialVerifier,
      permissionDecisionResolver
    )

    const result = await provider.resolve(
      {
        metadata: carrierMetadata(),
        request: {
          permissionCodes: ['AUTH.READ', 'AUTH.WRITE'],
          __oesOperatorContext: {
            operatorContext: {
              operator_id: 'legacy-account',
              tenant_id: 'legacy-tenant',
              operator_roles: ['AUTH.READ', 'AUTH.WRITE']
            }
          }
        }
      },
      {
        targetAudience: 'urn:oes:service:permission-service',
        requestedPermissionCodes: ['AUTH.READ', 'AUTH.WRITE']
      }
    )

    expect(sourceCredentialVerifier.verify).toHaveBeenCalledWith(
      'verified.session.access-token',
      WORKLOAD_IDENTITY,
      {
        requestId: 'request-1',
        targetAudience: 'urn:oes:service:permission-service',
        requestedPermissionCodes: ['AUTH.READ', 'AUTH.WRITE'],
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
      }
    )
    expect(permissionDecisionResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({ subject: 'account-1', tenantId: 'tenant-1' }),
        request: {
          targetAudience: 'urn:oes:service:permission-service',
          requestedPermissionCodes: ['AUTH.READ', 'AUTH.WRITE']
        },
        requestId: 'request-1',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
      })
    )
    expect(result.authorizationDecision.grantedPermissionCodes).toEqual(['AUTH.READ'])
    expect(result.execution).not.toHaveProperty('permissionCodes')
  })

  it('treats a transport-injected empty optional tracestate as absent', async () => {
    const sourceCredentialVerifier = {
      verify: jest.fn().mockResolvedValue({
        subject: 'account-1',
        principalType: 'HUMAN',
        scopeLevel: 'TENANT',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        sessionTerminal: 'WEB'
      })
    }
    const permissionDecisionResolver = {
      resolve: jest.fn().mockResolvedValue({ allowed: true })
    }
    const provider = new VerifiedExecutionTokenContextProvider(
      workload,
      sourceCredentialVerifier,
      permissionDecisionResolver
    )
    const metadata = carrierMetadata()
    metadata.set('tracestate', '')

    await provider.resolve(
      { metadata },
      {
        targetAudience: 'urn:oes:service:permission-service',
        requestedPermissionCodes: ['AUTH.READ']
      }
    )

    expect(sourceCredentialVerifier.verify).toHaveBeenCalledWith(
      'verified.session.access-token',
      WORKLOAD_IDENTITY,
      {
        requestId: 'request-1',
        targetAudience: 'urn:oes:service:permission-service',
        requestedPermissionCodes: ['AUTH.READ'],
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
      }
    )
  })

  it('fails closed without carrier authority even when legacy operator facts mirror the request', async () => {
    const metadata = carrierMetadata()
    metadata.remove('authorization')
    const sourceCredentialVerifier = { verify: jest.fn() }
    const permissionDecisionResolver = { resolve: jest.fn() }
    const provider = new VerifiedExecutionTokenContextProvider(
      workload,
      sourceCredentialVerifier,
      permissionDecisionResolver
    )

    await expect(
      provider.resolve(
        {
          metadata,
          request: {
            __oesOperatorContext: {
              operatorContext: {
                operator_id: 'legacy-account',
                tenant_id: 'legacy-tenant',
                operator_roles: ['AUTH.READ']
              }
            }
          }
        },
        {
          targetAudience: 'urn:oes:service:permission-service',
          requestedPermissionCodes: ['AUTH.READ']
        }
      )
    ).rejects.toThrow('source credential is required')
    expect(sourceCredentialVerifier.verify).not.toHaveBeenCalled()
    expect(permissionDecisionResolver.resolve).not.toHaveBeenCalled()
  })

  it('fails closed before credential or Permission resolution when mTLS peer verification fails', async () => {
    const sourceCredentialVerifier = { verify: jest.fn() }
    const permissionDecisionResolver = { resolve: jest.fn() }
    const provider = new VerifiedExecutionTokenContextProvider(
      {
        getVerifiedWorkloadIdentity: jest
          .fn()
          .mockRejectedValue(new Error('gRPC workload identity is unavailable'))
      },
      sourceCredentialVerifier,
      permissionDecisionResolver
    )

    await expect(
      provider.resolve(
        { metadata: carrierMetadata() },
        {
          targetAudience: 'urn:oes:service:permission-service',
          requestedPermissionCodes: ['AUTH.READ']
        }
      )
    ).rejects.toThrow('workload identity')
    expect(sourceCredentialVerifier.verify).not.toHaveBeenCalled()
    expect(permissionDecisionResolver.resolve).not.toHaveBeenCalled()
  })

  it('stops before Permission when the registry-selected OBO actor is stale', async () => {
    const sourceCredentialVerifier = {
      verify: jest.fn().mockRejectedValue(new Error('EXECUTION_HUMAN_OBO_ACTOR_INVALID'))
    }
    const permissionDecisionResolver = { resolve: jest.fn() }
    const provider = new VerifiedExecutionTokenContextProvider(
      workload,
      sourceCredentialVerifier,
      permissionDecisionResolver
    )

    await expect(
      provider.resolve(
        { metadata: carrierMetadata() },
        {
          targetAudience: 'urn:oes:service:item-master-service',
          requestedPermissionCodes: ['item_master.internal.manufacturable_item.resolve']
        }
      )
    ).rejects.toThrow('ACTOR_INVALID')
    expect(permissionDecisionResolver.resolve).not.toHaveBeenCalled()
  })
})

import { HrQueryService } from '../../src/application/services'
import { HrQueryGrpcController } from '../../src/interfaces/grpc/hr-query.grpc.controller'
import {
  attachOperatorContext,
  attachVerifiedExecution,
  GrpcRequestContextInterceptor
} from '@oes/common/authorization'
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants'

/** Attaches the verified tenant scope normally installed by the trusted execution guard. */
function withTenantContext<T extends object>(request: T): T {
  attachOperatorContext(request, {
    operator_id: 'operator-1',
    operator_type: 'HUMAN',
    tenant_id: 'tenant-1',
    issued_at: '2026-05-04T00:00:00.000Z',
    expires_at: '2026-05-04T00:05:00.000Z',
    issuer: 'api-gateway',
    signature: 'verified'
  })
  attachVerifiedExecution(request, {
    verifiedExecutionToken: {
      issuer: 'auth-service',
      audience: 'urn:oes:service:hr-service',
      subject: 'operator-1',
      principalType: 'HUMAN',
      clientId: 'spiffe://local/ns/oes/sa/api-gateway',
      tenantId: 'tenant-1',
      permissionCodes: [],
      tokenId: 'token-1',
      issuedAt: 1,
      notBefore: 1,
      expiresAt: 2,
      certificateThumbprint: 'A'.repeat(43),
      sessionId: 'session-1',
      sessionTerminal: 'WEB'
    },
    verifiedWorkloadIdentity: {
      spiffeId: 'spiffe://local/ns/oes/sa/api-gateway',
      certificateThumbprint: 'A'.repeat(43)
    }
  })
  return request
}

/** createHrQueryServiceMock builds the application query service double for gRPC mapping tests. */
function createHrQueryServiceMock() {
  return {
    listEmployees: jest.fn(),
    getEmployeeById: jest.fn(),
    getEmployeeByTenantPartyId: jest.fn(),
    resolveActiveEmployeeByCode: jest.fn(),
    getActiveEmployment: jest.fn(),
    listEmployments: jest.fn(),
    getLatestOnboardingAccess: jest.fn()
  }
}

describe('HrQueryGrpcController Contract', () => {
  it('installs the request-context interceptor for every HR query RPC', () => {
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, HrQueryGrpcController)).toContain(
      GrpcRequestContextInterceptor
    )
  })

  it('ResolveActiveEmployeeByCode / should map active employee and employment without account or PIN facts', async () => {
    const service = createHrQueryServiceMock()
    service.resolveActiveEmployeeByCode.mockResolvedValue({
      employee: {
        id: 'employee-1',
        tenantId: 'tenant-1',
        tenantPartyId: 'tenant-party-1',
        employeeCode: 'EMP-0AF-0001',
        lifecycleStatus: 'ACTIVE',
        officialPhotoAssetId: 'asset-1',
        officialPhotoUrl: 'https://assets.example.com/photo.webp'
      },
      activeEmployment: {
        id: 'employment-1',
        tenantId: 'tenant-1',
        employeeId: 'employee-1',
        orgUnitId: 'org-1',
        status: 'ACTIVE',
        effectiveFrom: new Date('2026-04-23T00:00:00.000Z'),
        effectiveTo: null,
        endedReason: null
      }
    })
    const controller = new HrQueryGrpcController(service as unknown as HrQueryService)

    const result = await (controller as any).resolveActiveEmployeeByCode({
      tenantId: 'tenant-1',
      employeeCode: 'EMP-0AF-0001'
    })

    expect(service.resolveActiveEmployeeByCode).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      employeeCode: 'EMP-0AF-0001'
    })
    expect(result.employee?.employeeCode).toBe('EMP-0AF-0001')
    expect(result.employee?.officialPhotoAssetId).toBe('asset-1')
    expect(result.employee?.officialPhotoUrl).toBe('https://assets.example.com/photo.webp')
    expect(result.activeEmployment?.orgUnitId).toBe('org-1')
    expect(result.employee).not.toHaveProperty('accountId')
    expect(result).not.toHaveProperty('pin')
    expect(result).not.toHaveProperty('loginMethods')
  })

  it('GetActiveEmployment / should expose Employment -> OrgUnit as HR truth without account-org fields', async () => {
    const service = createHrQueryServiceMock()
    service.getActiveEmployment.mockResolvedValue({
      id: 'employment-1',
      tenantId: 'tenant-1',
      employeeId: 'employee-1',
      orgUnitId: 'org-1',
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-04-23T00:00:00.000Z'),
      effectiveTo: null,
      endedReason: null
    })
    const controller = new HrQueryGrpcController(service as unknown as HrQueryService)

    const result = await controller.getActiveEmployment({ employeeId: 'employee-1' })

    expect(result.employment?.orgUnitId).toBe('org-1')
    expect(result.employment).not.toHaveProperty('accountOrgMembershipId')
    expect(result.employment).not.toHaveProperty('accountId')
  })

  it('ListEmployees / should expose tenant-scoped employee directory rows without account-owned fields', async () => {
    const service = createHrQueryServiceMock()
    service.listEmployees.mockResolvedValue({
      items: [
        {
          id: 'employee-1',
          tenantId: 'tenant-1',
          tenantPartyId: 'tenant-party-1',
          employeeCode: 'EMP-0AF-0001',
          lifecycleStatus: 'ACTIVE',
          officialPhotoAssetId: null,
          officialPhotoUrl: null
        }
      ],
      page: 2,
      pageSize: 10,
      total: 1
    })
    const controller = new HrQueryGrpcController(service as unknown as HrQueryService)

    const result = await controller.listEmployees(
      withTenantContext({
        keyword: 'EMP',
        lifecycleStatus: 2,
        page: 2,
        pageSize: 10,
        tenantId: 'tenant-1'
      })
    )

    expect(service.listEmployees).toHaveBeenCalledWith({
      keyword: 'EMP',
      lifecycleStatus: 'ACTIVE',
      page: 2,
      pageSize: 10,
      tenantId: 'tenant-1'
    })
    expect(result.items?.[0]?.employeeCode).toBe('EMP-0AF-0001')
    expect(result.items?.[0]?.officialPhotoAssetId).toBe('')
    expect(result.items?.[0]?.officialPhotoUrl).toBe('')
    expect(result.items?.[0]).not.toHaveProperty('accountId')
    expect(result.total).toBe(1)
  })

  it('GetEmployeeById / should expose HR official photo fields without account-owned avatar fields', async () => {
    const service = createHrQueryServiceMock()
    service.getEmployeeById.mockResolvedValue({
      id: 'employee-1',
      tenantId: 'tenant-1',
      tenantPartyId: 'tenant-party-1',
      employeeCode: 'EMP-0AF-0001',
      lifecycleStatus: 'ACTIVE',
      officialPhotoAssetId: 'asset-1',
      officialPhotoUrl: 'https://assets.example.com/photo.webp'
    })
    const controller = new HrQueryGrpcController(service as unknown as HrQueryService)

    const result = await controller.getEmployeeById({ employeeId: 'employee-1' })

    expect(result.employee?.officialPhotoAssetId).toBe('asset-1')
    expect(result.employee?.officialPhotoUrl).toBe('https://assets.example.com/photo.webp')
    expect(result.employee).not.toHaveProperty('accountAvatarUrl')
  })

  it('GetLatestOnboardingAccess / should expose HR-owned access compensation state without granting account truth ownership to HR', async () => {
    const service = createHrQueryServiceMock()
    service.getLatestOnboardingAccess.mockResolvedValue({
      id: 'process-1',
      tenantId: 'tenant-1',
      employeeId: 'employee-1',
      employmentId: 'employment-1',
      accountId: 'account-1',
      status: 'ACCESS_GRANT_PENDING',
      grantIdempotencyKey: 'grant-key-1',
      failureReason: 'permission.onboarding.account_not_found: account not found'
    })
    const controller = new HrQueryGrpcController(service as unknown as HrQueryService)

    const result = await controller.getLatestOnboardingAccess(
      withTenantContext({
        tenantId: 'tenant-1',
        employeeId: 'employee-1'
      })
    )

    expect(service.getLatestOnboardingAccess).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      employeeId: 'employee-1'
    })
    expect(result.process).toEqual({
      id: 'process-1',
      tenantId: 'tenant-1',
      employeeId: 'employee-1',
      employmentId: 'employment-1',
      accountId: 'account-1',
      status: 2,
      grantIdempotencyKey: 'grant-key-1',
      failureReason: 'permission.onboarding.account_not_found: account not found'
    })
    expect(result.process).not.toHaveProperty('loginMethods')
    expect(result.process).not.toHaveProperty('roles')
  })
})

import { CommonJwtService } from '@oes/common/auth'
import { inboundExecutionTokenCredentialScope } from '@oes/common/authorization'
import { SessionStatus } from '@oes/common/constants'
import { ExceptionFactory, INTERNAL_SERVICE_UNAVAILABLE } from '@oes/common/exceptions'
import { AUTH_TENANT_NOT_ACTIVE } from '../../../common/constants/exception-enums'
import { Session } from '../../../domain/aggregates/usersession.aggregate'
import { TrustedDeviceService } from '../../services/trusted-device.service'
import { ValidateAccessTokenHandler } from './validate-access-token.handler'
import { ValidateAccessTokenQuery } from './validate-access-token.query'

// Creates session fixtures that mirror persisted session truth for access-token validation tests.
function createSessionFixture(input: {
  id: string
  userId: string
  accountId: string
  tenantId?: string
  scopeLevel?: 'SYSTEM' | 'TENANT'
  status?: SessionStatus
  expiresAt?: string
  terminal?: string
  terminalDeviceId?: string
  deviceBoundTenantId?: string
  displayName?: string
  loginFlow?: string
}): Session {
  return Session.fromRedis({
    id: input.id,
    userId: input.userId,
    accountId: input.accountId,
    scopeLevel: input.scopeLevel ?? 'TENANT',
    tenantId: input.tenantId,
    terminal: input.terminal,
    terminalDeviceId: input.terminalDeviceId,
    deviceBoundTenantId: input.deviceBoundTenantId,
    displayName: input.displayName,
    loginFlow: input.loginFlow,
    refreshToken: `${input.id}-refresh`,
    status: input.status ?? SessionStatus.ACTIVE,
    deviceInfo: {
      deviceId: `${input.id}-device`,
      deviceName: `${input.id}-device-name`,
      userAgent: 'jest',
      ipAddress: '127.0.0.1'
    },
    createdAt: '2026-04-08T00:00:00.000Z',
    lastActiveAt: '2026-04-08T12:00:00.000Z',
    expiresAt: input.expiresAt ?? '2099-04-10T00:00:00.000Z',
    refreshExpiresAt: '2099-04-11T00:00:00.000Z',
    metadata: {
      loginMethod: 'email-password',
      loginFlow: input.loginFlow,
      terminal: input.terminal,
      terminalDeviceId: input.terminalDeviceId,
      deviceBoundTenantId: input.deviceBoundTenantId,
      displayName: input.displayName
    },
    isAdminControlled: false
  })
}

describe('ValidateAccessTokenHandler', () => {
  it('rejects a token whose tenant selector differs from persisted session truth before lifecycle lookup', async () => {
    const session = createSessionFixture({
      id: 'session-1',
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: 'tenant-1'
    })
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        aid: 'account-1',
        tid: 'tenant-other',
        sid: 'session-1',
        scopeLevel: 'TENANT',
        tokenType: 'access'
      })
    } as unknown as CommonJwtService
    const sessionRepository = {
      findById: jest.fn().mockResolvedValue(session),
      save: jest.fn(),
      delete: jest.fn()
    } as any
    const tenantSessionAccessService = {
      assertSessionCanContinue: jest.fn()
    }
    const handler = new ValidateAccessTokenHandler(
      jwtService,
      sessionRepository,
      { markTrustedDeviceSeen: jest.fn() } as unknown as TrustedDeviceService,
      tenantSessionAccessService as any
    )

    await expect(
      runFromGateway(() => handler.execute(new ValidateAccessTokenQuery('token-mismatch')))
    ).rejects.toBeDefined()

    expect(tenantSessionAccessService.assertSessionCanContinue).not.toHaveBeenCalled()
    expect(sessionRepository.save).not.toHaveBeenCalled()
  })

  it('rejects access tokens for tenant-scope sessions when the tenant is no longer active', async () => {
    const session = createSessionFixture({
      id: 'session-1',
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: 'tenant-1',
      displayName: 'Tenant Account'
    })
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        aid: 'account-1',
        tid: 'tenant-1',
        sid: 'session-1',
        scopeLevel: 'TENANT',
        roles: ['role-1'],
        tokenType: 'access'
      })
    } as unknown as CommonJwtService
    const sessionRepository = {
      findById: jest.fn().mockResolvedValue(session),
      save: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined)
    } as any
    const tenantSessionAccessService = {
      assertSessionCanContinue: jest
        .fn()
        .mockRejectedValue(ExceptionFactory.domain(AUTH_TENANT_NOT_ACTIVE))
    }
    const handler = new ValidateAccessTokenHandler(
      jwtService,
      sessionRepository,
      {
        markTrustedDeviceSeen: jest.fn()
      } as unknown as TrustedDeviceService,
      tenantSessionAccessService as any
    )

    await expect(
      runFromGateway(() => handler.execute(new ValidateAccessTokenQuery('token-1')))
    ).rejects.toThrow(AUTH_TENANT_NOT_ACTIVE.message)

    expect(tenantSessionAccessService.assertSessionCanContinue).toHaveBeenCalledWith({
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      scopeLevel: 'TENANT'
    })
    expect(sessionRepository.delete).toHaveBeenCalledWith('session-1')
    expect(sessionRepository.save).not.toHaveBeenCalled()
  })

  it('preserves the session when tenant lifecycle lookup fails unexpectedly', async () => {
    const session = createSessionFixture({
      id: 'session-1',
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: 'tenant-1'
    })
    const lifecycleError = ExceptionFactory.infrastructure(INTERNAL_SERVICE_UNAVAILABLE)
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        aid: 'account-1',
        tid: 'tenant-1',
        sid: 'session-1',
        scopeLevel: 'TENANT',
        tokenType: 'access'
      })
    } as unknown as CommonJwtService
    const sessionRepository = {
      findById: jest.fn().mockResolvedValue(session),
      save: jest.fn(),
      delete: jest.fn()
    } as any
    const handler = new ValidateAccessTokenHandler(
      jwtService,
      sessionRepository,
      { markTrustedDeviceSeen: jest.fn() } as unknown as TrustedDeviceService,
      {
        assertSessionCanContinue: jest.fn().mockRejectedValue(lifecycleError)
      } as any
    )

    await expect(
      runFromGateway(() => handler.execute(new ValidateAccessTokenQuery('token-1')))
    ).rejects.toBe(lifecycleError)

    expect(sessionRepository.delete).not.toHaveBeenCalled()
    expect(sessionRepository.save).not.toHaveBeenCalled()
  })

  it('accepts active access tokens that still point at a live session', async () => {
    const session = createSessionFixture({
      id: 'session-1',
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: 'tenant-1',
      displayName: 'Tenant Account'
    })
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        aid: 'account-1',
        tid: 'tenant-1',
        sid: 'session-1',
        scopeLevel: 'TENANT',
        passwordSetupRequired: true,
        roles: ['role-1'],
        tokenType: 'access'
      })
    } as unknown as CommonJwtService
    const sessionRepository = {
      findById: jest.fn().mockResolvedValue(session),
      save: jest.fn().mockImplementation(async (savedSession: Session) => savedSession)
    } as any
    const trustedDeviceService = {
      markTrustedDeviceSeen: jest.fn().mockResolvedValue(undefined)
    } as unknown as TrustedDeviceService
    const handler = new ValidateAccessTokenHandler(
      jwtService,
      sessionRepository,
      trustedDeviceService,
      {
        assertSessionCanContinue: jest.fn().mockResolvedValue(undefined)
      } as any
    )

    await expect(
      runFromGateway(() => handler.execute(new ValidateAccessTokenQuery('token-1')))
    ).resolves.toEqual({
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      scopeLevel: 'TENANT',
      terminal: 'WEB',
      allowedTerminals: [],
      passwordSetupRequired: true,
      roleIds: ['role-1'],
      displayName: 'Tenant Account',
      terminalDeviceId: undefined,
      deviceBoundTenantId: undefined,
      loginFlow: 'email-password'
    })
    expect(sessionRepository.save).toHaveBeenCalledWith(session)
    expect(trustedDeviceService.markTrustedDeviceSeen).toHaveBeenCalledWith({
      userId: 'user-1',
      scopeLevel: 'TENANT',
      tenantId: 'tenant-1',
      deviceId: 'session-1-device',
      deviceName: 'session-1-device-name',
      userAgent: 'jest',
      ipAddress: '127.0.0.1',
      observedAt: session.getLastActiveAt()
    })
  })

  it('returns PDA terminal device context from persisted session truth', async () => {
    const session = createSessionFixture({
      id: 'session-1',
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: 'tenant-1',
      terminal: 'PDA',
      terminalDeviceId: 'terminal-device-1',
      deviceBoundTenantId: 'tenant-1',
      loginFlow: 'EMAIL_PASSWORD'
    })
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        aid: 'account-1',
        tid: 'tenant-1',
        sid: 'session-1',
        scopeLevel: 'TENANT',
        terminal: 'PDA',
        allowedTerminals: ['PDA'],
        tokenType: 'access'
      })
    } as unknown as CommonJwtService
    const handler = new ValidateAccessTokenHandler(
      jwtService,
      {
        findById: jest.fn().mockResolvedValue(session),
        save: jest.fn().mockResolvedValue(session)
      } as any,
      { markTrustedDeviceSeen: jest.fn().mockResolvedValue(undefined) } as any,
      { assertSessionCanContinue: jest.fn().mockResolvedValue(undefined) } as any
    )

    await expect(
      runFromGateway(() => handler.execute(new ValidateAccessTokenQuery('token-1')))
    ).resolves.toEqual(
      expect.objectContaining({
        terminal: 'PDA',
        allowedTerminals: ['PDA'],
        terminalDeviceId: 'terminal-device-1',
        deviceBoundTenantId: 'tenant-1',
        loginFlow: 'EMAIL_PASSWORD'
      })
    )
  })

  it('rejects tokens whose session has already been removed', async () => {
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        aid: 'account-1',
        tid: 'tenant-1',
        sid: 'session-revoked',
        scopeLevel: 'TENANT',
        roles: ['role-1'],
        tokenType: 'access'
      })
    } as unknown as CommonJwtService
    const sessionRepository = {
      findById: jest.fn().mockResolvedValue(null)
    } as any
    const trustedDeviceService = {
      markTrustedDeviceSeen: jest.fn()
    } as unknown as TrustedDeviceService
    const handler = new ValidateAccessTokenHandler(
      jwtService,
      sessionRepository,
      trustedDeviceService,
      {
        assertSessionCanContinue: jest.fn()
      } as any
    )

    await expect(
      runFromGateway(() => handler.execute(new ValidateAccessTokenQuery('token-1')))
    ).rejects.toBeDefined()
    expect(trustedDeviceService.markTrustedDeviceSeen).not.toHaveBeenCalled()
  })
})

/** Mirrors the guard/interceptor boundary required by the public session-validation RPC. */
function runFromGateway<T>(callback: () => T): T {
  const data = {}
  inboundExecutionTokenCredentialScope.preparePublicCorrelation(data, {
    requestId: 'request-validate-access',
    traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'
  })
  return inboundExecutionTokenCredentialScope.runPrepared(data, callback)
}

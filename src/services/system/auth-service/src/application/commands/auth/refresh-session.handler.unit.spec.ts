import { ConfigService } from '@nestjs/config'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { CommonJwtService } from '@oes/common/auth'
import { LoginMethodEnum, SessionStatus } from '@oes/common/constants'
import { ExceptionFactory, INTERNAL_SERVICE_UNAVAILABLE } from '@oes/common/exceptions'
import { AUTH_TENANT_NOT_ACTIVE } from '../../../common/constants/exception-enums'
import { Session } from '../../../domain/aggregates/usersession.aggregate'
import { AuthAuditService } from '../../services/auth-audit.service'
import { PasswordSetupRequirementService } from '../../services/password-setup-requirement.service'
import { TrustedDeviceService } from '../../services/trusted-device.service'
import { RefreshSessionCommand } from './refresh-session.command'
import { RefreshSessionHandler } from './refresh-session.handler'

// Creates a persisted session fixture for refresh-token rotation tests.
function createSessionFixture(input: {
  id: string
  userId: string
  accountId: string
  tenantId?: string
  refreshToken: string
  terminal?: string
  terminalDeviceId?: string
  deviceBoundTenantId?: string
}): Session {
  return Session.fromRedis({
    id: input.id,
    userId: input.userId,
    accountId: input.accountId,
    tenantId: input.tenantId,
    terminal: input.terminal,
    terminalDeviceId: input.terminalDeviceId,
    deviceBoundTenantId: input.deviceBoundTenantId,
    refreshToken: input.refreshToken,
    status: SessionStatus.ACTIVE,
    deviceInfo: {
      deviceId: `${input.id}-device`,
      deviceName: `${input.id}-device-name`,
      userAgent: 'Mozilla/5.0 Chrome/123.0',
      ipAddress: '127.0.0.1'
    },
    createdAt: '2099-04-08T00:00:00.000Z',
    lastActiveAt: '2099-04-08T12:00:00.000Z',
    expiresAt: '2099-04-10T00:00:00.000Z',
    refreshExpiresAt: '2099-04-11T00:00:00.000Z',
    metadata: {
      loginMethod: LoginMethodEnum.EmailPassword,
      scopeLevel: input.tenantId ? 'TENANT' : 'SYSTEM'
    },
    isAdminControlled: false
  })
}

describe('RefreshSessionHandler', () => {
  it('rejects refresh and deletes the session when terminal access is no longer allowed', async () => {
    const existingRefreshToken = 'refresh-token-terminal-denied'
    const session = createSessionFixture({
      id: 'session-terminal-denied',
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: 'tenant-1',
      refreshToken: existingRefreshToken,
      terminal: 'PDA',
      terminalDeviceId: 'terminal-device-1',
      deviceBoundTenantId: 'tenant-1'
    })
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sid: 'session-terminal-denied',
        tokenType: 'refresh'
      }),
      signAccessToken: jest.fn(),
      signRefreshToken: jest.fn()
    } as unknown as CommonJwtService
    const permissionService = {
      resolveAccountTerminalAccess: jest.fn().mockResolvedValue({
        allowed: false,
        reasonCode: 'TERMINAL_ACCESS_DENIED',
        effectiveAllowedTerminals: ['WEB'],
        resolutionSource: 'ACCOUNT_OVERRIDE',
        matchedRoleIds: []
      }),
      getAccountAuthorizationSummary: jest.fn()
    }
    const sessionRepository = {
      findById: jest.fn().mockResolvedValue(session),
      findByRefreshToken: jest.fn().mockResolvedValue(session),
      save: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined)
    }
    const handler = new RefreshSessionHandler(
      jwtService,
      { get: jest.fn().mockReturnValue({}) } as unknown as ConfigService,
      permissionService as any,
      {
        userRequiresPasswordSetup: jest.fn()
      } as unknown as PasswordSetupRequirementService,
      sessionRepository as any,
      new AuthAuditService({ emit: jest.fn() } as unknown as EventEmitter2),
      {
        markTrustedDeviceSeen: jest.fn()
      } as unknown as TrustedDeviceService,
      {
        assertSessionCanContinue: jest.fn().mockResolvedValue(undefined)
      } as any
    )

    await expect(handler.execute(new RefreshSessionCommand(existingRefreshToken))).rejects.toThrow(
      'Terminal access denied'
    )

    expect(permissionService.resolveAccountTerminalAccess).toHaveBeenCalledWith({
      accountId: 'account-1',
      tenantId: 'tenant-1',
      scopeLevel: 'TENANT',
      terminal: 'PDA'
    })
    expect(sessionRepository.delete).toHaveBeenCalledWith('session-terminal-denied')
    expect(sessionRepository.save).not.toHaveBeenCalled()
    expect((jwtService as any).signAccessToken).not.toHaveBeenCalled()
  })

  it('rejects refresh for a tenant-scope session when the tenant is no longer active', async () => {
    const existingRefreshToken = 'refresh-token-tenant'
    const session = createSessionFixture({
      id: 'session-tenant',
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: 'tenant-1',
      refreshToken: existingRefreshToken
    })
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sid: 'session-tenant',
        tokenType: 'refresh'
      }),
      signAccessToken: jest.fn(),
      signRefreshToken: jest.fn()
    } as unknown as CommonJwtService
    const sessionRepository = {
      findById: jest.fn().mockResolvedValue(session),
      findByRefreshToken: jest.fn().mockResolvedValue(session),
      save: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined)
    }
    const tenantSessionAccessService = {
      assertSessionCanContinue: jest
        .fn()
        .mockRejectedValue(ExceptionFactory.domain(AUTH_TENANT_NOT_ACTIVE))
    }
    const handler = new RefreshSessionHandler(
      jwtService,
      { get: jest.fn().mockReturnValue({}) } as unknown as ConfigService,
      {
        getAccountAuthorizationSummary: jest.fn(),
        resolveAccountTerminalAccess: jest.fn()
      } as any,
      {
        userRequiresPasswordSetup: jest.fn()
      } as unknown as PasswordSetupRequirementService,
      sessionRepository as any,
      new AuthAuditService({ emit: jest.fn() } as unknown as EventEmitter2),
      {
        markTrustedDeviceSeen: jest.fn()
      } as unknown as TrustedDeviceService,
      tenantSessionAccessService as any
    )

    await expect(handler.execute(new RefreshSessionCommand(existingRefreshToken))).rejects.toThrow(
      AUTH_TENANT_NOT_ACTIVE.message
    )

    expect(tenantSessionAccessService.assertSessionCanContinue).toHaveBeenCalledWith({
      sessionId: 'session-tenant',
      tenantId: 'tenant-1',
      scopeLevel: 'TENANT'
    })
    expect(sessionRepository.delete).toHaveBeenCalledWith('session-tenant')
    expect(sessionRepository.save).not.toHaveBeenCalled()
    expect((jwtService as any).signAccessToken).not.toHaveBeenCalled()
  })

  it('preserves the session when tenant lifecycle lookup fails unexpectedly', async () => {
    const existingRefreshToken = 'refresh-token-tenant-unavailable'
    const session = createSessionFixture({
      id: 'session-tenant-unavailable',
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: 'tenant-1',
      refreshToken: existingRefreshToken
    })
    const lifecycleError = ExceptionFactory.infrastructure(INTERNAL_SERVICE_UNAVAILABLE)
    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sid: 'session-tenant-unavailable',
        tokenType: 'refresh'
      }),
      signAccessToken: jest.fn(),
      signRefreshToken: jest.fn()
    } as unknown as CommonJwtService
    const sessionRepository = {
      findById: jest.fn().mockResolvedValue(session),
      findByRefreshToken: jest.fn().mockResolvedValue(session),
      save: jest.fn(),
      delete: jest.fn()
    }
    const handler = new RefreshSessionHandler(
      jwtService,
      { get: jest.fn().mockReturnValue({}) } as unknown as ConfigService,
      {
        getAccountAuthorizationSummary: jest.fn(),
        resolveAccountTerminalAccess: jest.fn()
      } as any,
      {
        userRequiresPasswordSetup: jest.fn()
      } as unknown as PasswordSetupRequirementService,
      sessionRepository as any,
      new AuthAuditService({ emit: jest.fn() } as unknown as EventEmitter2),
      { markTrustedDeviceSeen: jest.fn() } as unknown as TrustedDeviceService,
      {
        assertSessionCanContinue: jest.fn().mockRejectedValue(lifecycleError)
      } as any
    )

    await expect(handler.execute(new RefreshSessionCommand(existingRefreshToken))).rejects.toBe(
      lifecycleError
    )

    expect(sessionRepository.delete).not.toHaveBeenCalled()
    expect(sessionRepository.save).not.toHaveBeenCalled()
    expect((jwtService as any).signAccessToken).not.toHaveBeenCalled()
  })

  it('reissues access and refresh tokens with role ids resolved from permission-service', async () => {
    const existingRefreshToken = 'refresh-token-1'
    const session = createSessionFixture({
      id: 'session-1',
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: undefined,
      refreshToken: existingRefreshToken
    })

    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sid: 'session-1',
        tokenType: 'refresh'
      }),
      signAccessToken: jest.fn().mockReturnValue('next-access-token'),
      signRefreshToken: jest.fn().mockReturnValue('next-refresh-token')
    } as unknown as CommonJwtService
    const configService = {
      get: jest.fn().mockReturnValue({
        accessTokenValidity: 900,
        refreshTokenValidity: 604800,
        issuer: 'oes',
        audience: 'tenant-web'
      })
    } as unknown as ConfigService
    const permissionService = {
      resolveAccountTerminalAccess: jest.fn().mockResolvedValue({
        allowed: true,
        reasonCode: 'ALLOWED',
        effectiveAllowedTerminals: ['WEB'],
        resolutionSource: 'ROLE_UNION',
        matchedRoleIds: ['role-system-admin']
      }),
      getAccountAuthorizationSummary: jest.fn().mockResolvedValue({
        accountId: 'account-1',
        roleIds: ['role-system-admin'],
        roleCodes: ['system.admin'],
        permissionCodes: ['auth.session.admin.view']
      })
    }
    const sessionRepository = {
      findById: jest.fn().mockResolvedValue(session),
      findByRefreshToken: jest.fn().mockResolvedValue(session),
      save: jest.fn().mockImplementation(async (savedSession: Session) => savedSession),
      delete: jest.fn().mockResolvedValue(undefined)
    }
    const authAuditService = new AuthAuditService({
      emit: jest.fn()
    } as unknown as EventEmitter2)
    const emitSessionRefreshedSpy = jest.spyOn(authAuditService, 'emitSessionRefreshed')
    const trustedDeviceService = {
      markTrustedDeviceSeen: jest.fn().mockResolvedValue(undefined)
    } as unknown as TrustedDeviceService

    const handler = new RefreshSessionHandler(
      jwtService,
      configService,
      permissionService as any,
      {
        userRequiresPasswordSetup: jest.fn().mockResolvedValue(true)
      } as unknown as PasswordSetupRequirementService,
      sessionRepository as any,
      authAuditService,
      trustedDeviceService,
      {
        assertSessionCanContinue: jest.fn().mockResolvedValue(undefined)
      } as any
    )

    const result = await handler.execute(new RefreshSessionCommand(existingRefreshToken))

    expect(permissionService.getAccountAuthorizationSummary).toHaveBeenCalledWith({
      accountId: 'account-1',
      tenantId: undefined,
      scopeLevel: 'SYSTEM'
    })
    expect((jwtService as any).signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        aid: 'account-1',
        terminal: 'WEB',
        allowedTerminals: ['WEB'],
        passwordSetupRequired: true,
        roles: ['role-system-admin'],
        tokenType: 'access'
      }),
      expect.any(Object)
    )
    expect((jwtService as any).signRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        aid: 'account-1',
        terminal: 'WEB',
        allowedTerminals: ['WEB'],
        passwordSetupRequired: true,
        roles: ['role-system-admin'],
        tokenType: 'refresh'
      }),
      expect.any(Object)
    )
    expect(sessionRepository.save).toHaveBeenCalledTimes(1)
    expect(trustedDeviceService.markTrustedDeviceSeen).toHaveBeenCalledWith({
      userId: 'user-1',
      scopeLevel: 'SYSTEM',
      tenantId: undefined,
      deviceId: 'session-1-device',
      deviceName: 'session-1-device-name',
      userAgent: 'Mozilla/5.0 Chrome/123.0',
      ipAddress: '127.0.0.1',
      observedAt: session.getLastActiveAt()
    })
    expect(emitSessionRefreshedSpy).toHaveBeenCalledWith(expect.any(Session))
    expect(result).toEqual({
      sessionId: 'session-1',
      terminal: 'WEB',
      allowedTerminals: ['WEB'],
      accessToken: 'next-access-token',
      refreshToken: 'next-refresh-token',
      expiresIn: 900
    })
  })

  it('rotates PDA sessions with the short PDA refresh window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-18T08:00:00.000Z'))
    const existingRefreshToken = 'refresh-token-pda'
    const session = createSessionFixture({
      id: 'session-pda',
      userId: 'user-1',
      accountId: 'account-1',
      tenantId: 'tenant-1',
      refreshToken: existingRefreshToken,
      terminal: 'PDA',
      terminalDeviceId: 'terminal-device-1',
      deviceBoundTenantId: 'tenant-1'
    })

    const jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sid: 'session-pda',
        tokenType: 'refresh'
      }),
      signAccessToken: jest.fn().mockReturnValue('next-access-token'),
      signRefreshToken: jest.fn().mockReturnValue('next-refresh-token')
    } as unknown as CommonJwtService
    const sessionRepository = {
      findById: jest.fn().mockResolvedValue(session),
      findByRefreshToken: jest.fn().mockResolvedValue(session),
      save: jest.fn().mockImplementation(async (savedSession: Session) => savedSession),
      delete: jest.fn().mockResolvedValue(undefined)
    }
    const handler = new RefreshSessionHandler(
      jwtService,
      {
        get: jest.fn().mockReturnValue({
          accessTokenValidity: 900,
          refreshTokenValidity: 604800,
          issuer: '',
          audience: ''
        })
      } as unknown as ConfigService,
      {
        resolveAccountTerminalAccess: jest.fn().mockResolvedValue({
          allowed: true,
          reasonCode: 'ALLOWED',
          effectiveAllowedTerminals: ['PDA'],
          resolutionSource: 'ACCOUNT_OVERRIDE',
          matchedRoleIds: []
        }),
        getAccountAuthorizationSummary: jest.fn().mockResolvedValue({
          accountId: 'account-1',
          roleIds: ['role-1'],
          roleCodes: ['pda.operator'],
          permissionCodes: []
        })
      } as any,
      {
        userRequiresPasswordSetup: jest.fn().mockResolvedValue(false)
      } as unknown as PasswordSetupRequirementService,
      sessionRepository as any,
      new AuthAuditService({ emit: jest.fn() } as unknown as EventEmitter2),
      {
        markTrustedDeviceSeen: jest.fn().mockResolvedValue(undefined)
      } as unknown as TrustedDeviceService,
      {
        assertSessionCanContinue: jest.fn().mockResolvedValue(undefined)
      } as any
    )

    const result = await handler.execute(new RefreshSessionCommand(existingRefreshToken))

    expect(result.expiresIn).toBe(900)
    expect(session.getRemainingTime()).toBe(900)
    expect(session.getRefreshRemainingTime()).toBe(1200)
    expect((jwtService as any).signAccessToken).toHaveBeenCalledWith(expect.any(Object), {
      expiresIn: 900
    })
    expect((jwtService as any).signRefreshToken).toHaveBeenCalledWith(expect.any(Object), {
      expiresIn: 1200
    })
    expect((jwtService as any).signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalDeviceId: 'terminal-device-1',
        deviceBoundTenantId: 'tenant-1'
      }),
      expect.any(Object)
    )
    expect((jwtService as any).signRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalDeviceId: 'terminal-device-1',
        deviceBoundTenantId: 'tenant-1'
      }),
      expect.any(Object)
    )
    jest.useRealTimers()
  })
})

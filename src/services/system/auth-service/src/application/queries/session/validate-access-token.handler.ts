import { Inject } from '@nestjs/common'
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs'
import { CommonJwtService } from '@oes/common/auth'
import { inboundExecutionTokenCredentialScope } from '@oes/common/authorization'
import { ExceptionFactory, OESExceptionBase } from '@oes/common/exceptions'
import { REPO } from '../../../common/constants'
import {
  AUTH_ACCESS_TOKEN_INVALID,
  AUTH_TENANT_NOT_ACTIVE
} from '../../../common/constants/exception-enums'
import { IUserSessionRepository } from '../../../domain/repositories/user-session.repository'
import { Session } from '../../../domain/aggregates/usersession.aggregate'
import { TenantSessionAccessService } from '../../services/tenant-session-access.service'
import { TrustedDeviceService } from '../../services/trusted-device.service'
import { ValidateAccessTokenQuery } from './validate-access-token.query'

export interface ValidateAccessTokenResult {
  userId: string
  accountId: string
  tenantId?: string
  sessionId: string
  scopeLevel: 'SYSTEM' | 'TENANT'
  terminal: string
  allowedTerminals: string[]
  passwordSetupRequired: boolean
  roleIds: string[]
  displayName?: string
  terminalDeviceId?: string
  deviceBoundTenantId?: string
  loginFlow?: string
}

// Validates an access token against the persisted session truth before gateway requests continue.
@QueryHandler(ValidateAccessTokenQuery)
export class ValidateAccessTokenHandler implements IQueryHandler<
  ValidateAccessTokenQuery,
  ValidateAccessTokenResult
> {
  constructor(
    private readonly jwtService: CommonJwtService,
    @Inject(REPO.SESSION)
    private readonly sessionRepository: IUserSessionRepository,
    private readonly trustedDeviceService: TrustedDeviceService,
    private readonly tenantSessionAccessService: TenantSessionAccessService
  ) {}

  async execute(query: ValidateAccessTokenQuery): Promise<ValidateAccessTokenResult> {
    const payload = await this.verifyAccessToken(query.accessToken)
    const sessionId = this.requireText(payload.sid)
    const session = sessionId ? await this.sessionRepository.findById(sessionId) : null

    if (!session || !session.isActive() || session.isExpired()) {
      throw ExceptionFactory.domain(AUTH_ACCESS_TOKEN_INVALID, {
        sessionId
      })
    }

    const userId = this.requireText(payload.sub) ?? this.requireText(payload.userId)
    if (!userId || userId !== session.getUserId()) {
      throw ExceptionFactory.domain(AUTH_ACCESS_TOKEN_INVALID, {
        sessionId,
        userId
      })
    }

    const accountId = this.requireText(payload.aid) ?? this.requireText(payload.holderId)
    if (!accountId || accountId !== session.getAccountId()) {
      throw ExceptionFactory.domain(AUTH_ACCESS_TOKEN_INVALID, {
        sessionId,
        accountId
      })
    }

    const tenantId = this.requireText(payload.tid) ?? this.requireText(payload.tenantId)
    const sessionTenantId = session.getTenantId()
    if ((sessionTenantId ?? '') !== (tenantId ?? '')) {
      throw ExceptionFactory.domain(AUTH_ACCESS_TOKEN_INVALID, {
        sessionId,
        tenantId
      })
    }

    const scopeLevel = payload.scopeLevel === 'SYSTEM' ? 'SYSTEM' : 'TENANT'
    if (scopeLevel !== session.getScopeLevel()) {
      throw ExceptionFactory.domain(AUTH_ACCESS_TOKEN_INVALID, {
        sessionId,
        scopeLevel
      })
    }

    await inboundExecutionTokenCredentialScope.runVerifiedSessionSource(query.accessToken, () =>
      this.assertTenantSessionCanContinue(session)
    )

    session.touch()
    await this.sessionRepository.save(session)
    await this.trustedDeviceService.markTrustedDeviceSeen({
      userId,
      scopeLevel: session.getScopeLevel(),
      tenantId: session.getTenantId(),
      deviceId: session.getDeviceInfo().deviceId,
      deviceName: session.getDeviceInfo().deviceName,
      userAgent: session.getDeviceInfo().userAgent,
      ipAddress: session.getDeviceInfo().ipAddress,
      observedAt: session.getLastActiveAt()
    })

    return {
      userId,
      accountId,
      tenantId: sessionTenantId,
      sessionId: session.getId(),
      scopeLevel: session.getScopeLevel(),
      terminal: session.getTerminal(),
      allowedTerminals: this.normalizeStringArray(payload.allowedTerminals),
      passwordSetupRequired: Boolean(payload.passwordSetupRequired),
      roleIds: this.normalizeRoleIds(payload.roles),
      displayName: session.getDisplayName(),
      terminalDeviceId: session.getTerminalDeviceId(),
      deviceBoundTenantId: session.getDeviceBoundTenantId(),
      loginFlow: session.getLoginFlow()
    }
  }

  private async verifyAccessToken(accessToken: string): Promise<Record<string, any>> {
    try {
      const payload = await this.jwtService.verifyAsync<Record<string, any>>(accessToken)
      if (payload.tokenType !== 'access') {
        throw ExceptionFactory.domain(AUTH_ACCESS_TOKEN_INVALID)
      }

      return payload
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === AUTH_ACCESS_TOKEN_INVALID.code
      ) {
        throw error
      }

      throw ExceptionFactory.domain(AUTH_ACCESS_TOKEN_INVALID)
    }
  }

  private requireText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  }

  private normalizeRoleIds(value: unknown): string[] {
    return this.normalizeStringArray(value)
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return []
    }

    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  }

  /** assertTenantSessionCanContinue blocks access-token validation when tenant lifecycle no longer allows session use. */
  private async assertTenantSessionCanContinue(session: Session): Promise<void> {
    if (session.getScopeLevel() === 'SYSTEM') {
      return
    }

    try {
      await this.tenantSessionAccessService.assertSessionCanContinue({
        sessionId: session.getId(),
        tenantId: session.getTenantId(),
        scopeLevel: session.getScopeLevel()
      })
    } catch (error) {
      if (error instanceof OESExceptionBase && error.getCode() === AUTH_TENANT_NOT_ACTIVE.code) {
        await this.sessionRepository.delete(session.getId())
      }
      throw error
    }
  }
}

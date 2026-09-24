import { CommandHandler, ICommandHandler } from '@nestjs/cqrs'
import { Inject } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { CommonJwtService, ITokenConfig, TokenConfigName } from '@oes/common/auth'
import { PERMISSION_SERVICE } from '@oes/common/constants'
import { REPO } from '../../../common/constants'
import { ExceptionFactory, OESExceptionBase } from '@oes/common/exceptions'
import {
  AUTH_REFRESH_TOKEN_INVALID,
  AUTH_REFRESH_TOKEN_REPLAY_DETECTED,
  AUTH_TENANT_NOT_ACTIVE,
  AUTH_TERMINAL_ACCESS_DENIED
} from '../../../common/constants/exception-enums'
import { IPermissionServicePort } from '../../ports'
import { AuthAuditService } from '../../services/auth-audit.service'
import { PasswordSetupRequirementService } from '../../services/password-setup-requirement.service'
import { TenantSessionAccessService } from '../../services/tenant-session-access.service'
import { resolveTerminalSessionLifetime } from '../../services/terminal-session-lifetime'
import { TrustedDeviceService } from '../../services/trusted-device.service'
import { IUserSessionRepository } from '../../../domain/repositories/user-session.repository'
import { Session } from '../../../domain/aggregates/usersession.aggregate'
import { RefreshSessionCommand } from './refresh-session.command'

export interface RefreshSessionResult {
  sessionId: string
  terminal: string
  allowedTerminals: string[]
  accessToken: string
  refreshToken: string
  expiresIn: number
}

@CommandHandler(RefreshSessionCommand)
export class RefreshSessionHandler
  implements ICommandHandler<RefreshSessionCommand, RefreshSessionResult>
{
  constructor(
    private readonly jwtService: CommonJwtService,
    private readonly configService: ConfigService,
    @Inject(PERMISSION_SERVICE)
    private readonly permissionService: IPermissionServicePort,
    private readonly passwordSetupRequirementService: PasswordSetupRequirementService,
    @Inject(REPO.SESSION)
    private readonly sessionRepository: IUserSessionRepository,
    private readonly authAuditService: AuthAuditService,
    private readonly trustedDeviceService: TrustedDeviceService,
    private readonly tenantSessionAccessService: TenantSessionAccessService
  ) {}

  async execute(command: RefreshSessionCommand): Promise<RefreshSessionResult> {
    const tokenConfig = this.getTokenConfig()
    const payload = await this.verifyRefreshToken(command.refreshToken)
    const sessionId = String(payload.sid ?? '')

    if (!sessionId) {
      throw ExceptionFactory.domain(AUTH_REFRESH_TOKEN_INVALID)
    }

    const session = await this.sessionRepository.findById(sessionId)
    const indexedSession = await this.sessionRepository.findByRefreshToken(command.refreshToken)

    if (session && indexedSession && indexedSession.getId() !== session.getId()) {
      this.authAuditService.emitRefreshTokenReplayDetected(session)
      await this.sessionRepository.delete(sessionId)
      throw ExceptionFactory.domain(AUTH_REFRESH_TOKEN_REPLAY_DETECTED, {
        sessionId
      })
    }

    if (!session) {
      throw ExceptionFactory.domain(AUTH_REFRESH_TOKEN_INVALID, {
        sessionId
      })
    }

    if (!indexedSession || !session.validateRefreshToken(command.refreshToken)) {
      this.authAuditService.emitRefreshTokenReplayDetected(session)
      await this.sessionRepository.delete(sessionId)
      throw ExceptionFactory.domain(AUTH_REFRESH_TOKEN_REPLAY_DETECTED, {
        sessionId
      })
    }

    await this.assertTenantSessionCanContinue(session)
    const terminalAccess = await this.assertTerminalAccessCanContinue(session)
    const tokenWindow = resolveTerminalSessionLifetime(session.getTerminal(), tokenConfig)

    const signOptions = {
      ...(tokenConfig.issuer ? { issuer: tokenConfig.issuer } : {}),
      ...(tokenConfig.audience ? { audience: tokenConfig.audience } : {})
    }
    const roleIds = await this.resolveRoleIds(session.getAccountId(), session.getTenantId(), session.getScopeLevel())
    const passwordSetupRequired = await this.passwordSetupRequirementService.userRequiresPasswordSetup(
      session.getUserId()
    )

    const accessToken = this.jwtService.signAccessToken(
      this.buildTokenClaims(
        session.getUserId(),
        session.getId(),
        session.getAccountId(),
        session.getTenantId(),
        session.getScopeLevel(),
        session.getTerminal(),
        terminalAccess.effectiveAllowedTerminals,
        roleIds,
        'access',
        passwordSetupRequired,
        session.getTerminalDeviceId(),
        session.getDeviceBoundTenantId()
      ),
      {
        ...signOptions,
        expiresIn: tokenWindow.accessTokenValidity
      }
    )

    const nextRefreshToken = this.jwtService.signRefreshToken(
      this.buildTokenClaims(
        session.getUserId(),
        session.getId(),
        session.getAccountId(),
        session.getTenantId(),
        session.getScopeLevel(),
        session.getTerminal(),
        terminalAccess.effectiveAllowedTerminals,
        roleIds,
        'refresh',
        passwordSetupRequired,
        session.getTerminalDeviceId(),
        session.getDeviceBoundTenantId()
      ),
      {
        ...signOptions,
        expiresIn: tokenWindow.refreshTokenValidity
      }
    )

    session.activateTokenWindow(
      nextRefreshToken,
      tokenWindow.accessTokenValidity,
      tokenWindow.refreshTokenValidity
    )
    await this.sessionRepository.save(session)
    await this.trustedDeviceService.markTrustedDeviceSeen({
      userId: session.getUserId(),
      scopeLevel: session.getScopeLevel(),
      tenantId: session.getTenantId(),
      deviceId: session.getDeviceInfo().deviceId,
      deviceName: session.getDeviceInfo().deviceName,
      userAgent: session.getDeviceInfo().userAgent,
      ipAddress: session.getDeviceInfo().ipAddress,
      observedAt: session.getLastActiveAt()
    })

    const result = {
      sessionId: session.getId(),
      terminal: session.getTerminal(),
      allowedTerminals: terminalAccess.effectiveAllowedTerminals,
      accessToken,
      refreshToken: nextRefreshToken,
      expiresIn: tokenWindow.accessTokenValidity
    }

    this.authAuditService.emitSessionRefreshed(session)
    return result
  }

  /** assertTerminalAccessCanContinue blocks refresh when the session-bound terminal is no longer allowed. */
  private async assertTerminalAccessCanContinue(session: Session) {
    const terminalAccess = await this.permissionService.resolveAccountTerminalAccess({
      accountId: session.getAccountId(),
      tenantId: session.getTenantId(),
      scopeLevel: session.getScopeLevel(),
      terminal: session.getTerminal()
    })

    if (!terminalAccess.allowed) {
      this.authAuditService.emitTerminalAccessDenied({
        accountId: session.getAccountId(),
        userId: session.getUserId(),
        tenantId: session.getTenantId(),
        scopeLevel: session.getScopeLevel(),
        terminal: session.getTerminal(),
        reasonCode: terminalAccess.reasonCode,
        phase: 'REFRESH',
        sessionId: session.getId()
      })
      await this.sessionRepository.delete(session.getId())
      throw ExceptionFactory.domain(AUTH_TERMINAL_ACCESS_DENIED, {
        sessionId: session.getId(),
        accountId: session.getAccountId(),
        tenantId: session.getTenantId(),
        scopeLevel: session.getScopeLevel(),
        terminal: session.getTerminal(),
        reasonCode: terminalAccess.reasonCode
      })
    }

    return terminalAccess
  }

  /** assertTenantSessionCanContinue blocks refresh token rotation when tenant lifecycle no longer allows session use. */
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

  private getTokenConfig(): ITokenConfig {
    const config = this.configService.get<ITokenConfig>(TokenConfigName)
    const issuer = typeof config?.issuer === 'string' ? config.issuer : ''
    const audience = typeof config?.audience === 'string' ? config.audience : ''

    return {
      accessTokenValidity: config?.accessTokenValidity || 900,
      refreshTokenValidity: config?.refreshTokenValidity || 604800,
      issuer,
      audience
    }
  }

  private async verifyRefreshToken(refreshToken: string): Promise<Record<string, any>> {
    try {
      const payload = await this.jwtService.verifyAsync<Record<string, any>>(refreshToken)
      if (payload.tokenType !== 'refresh') {
        throw ExceptionFactory.domain(AUTH_REFRESH_TOKEN_INVALID)
      }
      return payload
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === AUTH_REFRESH_TOKEN_INVALID.code
      ) {
        throw error
      }

      throw ExceptionFactory.domain(AUTH_REFRESH_TOKEN_INVALID)
    }
  }

  // Resolves the effective role ids for the refreshed account context before reissuing JWT claims.
  private async resolveRoleIds(
    accountId: string,
    tenantId: string | null,
    scopeLevel: 'SYSTEM' | 'TENANT'
  ): Promise<string[]> {
    const summary = await this.permissionService.getAccountAuthorizationSummary({
      accountId,
      tenantId,
      scopeLevel
    })

    return summary.roleIds
  }

  // Builds the normalized JWT claims shared by refreshed access and refresh tokens.
  private buildTokenClaims(
    userId: string,
    sessionId: string,
    accountId: string,
    tenantId: string | null,
    scopeLevel: 'SYSTEM' | 'TENANT',
    terminal: string,
    allowedTerminals: string[],
    roleIds: string[],
    tokenType: 'access' | 'refresh',
    passwordSetupRequired: boolean,
    terminalDeviceId?: string,
    deviceBoundTenantId?: string
  ): Record<string, unknown> {
    return {
      sub: userId,
      sid: sessionId,
      aid: accountId,
      ...(tenantId ? { tid: tenantId } : {}),
      scopeLevel,
      terminal,
      ...(terminalDeviceId ? { terminalDeviceId } : {}),
      ...(deviceBoundTenantId ? { deviceBoundTenantId } : {}),
      allowedTerminals,
      passwordSetupRequired,
      roles: roleIds,
      tokenType
    }
  }
}

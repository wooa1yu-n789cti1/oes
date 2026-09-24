import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ExceptionFactory } from '@oes/common/exceptions'
import { Permission } from '../../../domain/aggregates/permission.aggregate'
import { Role } from '../../../domain/aggregates/role.aggregate'
import { AccountType } from '../../../domain/enums/account-type.enum'
import { RoleKind } from '../../../domain/enums/role-kind.enum'
import { ScopeLevel } from '../../../domain/enums/scope-level.enum'
import { RoleRepository } from '../../../domain/repositories/role.repository'
import { AccountRole } from '../../../domain/vo/account-role.value-object'
import { Prisma } from '../../../../prisma/generated/prisma'
import { PermissionMapper } from '../../mappers/permission.mapper'
import { RoleMapper } from '../../mappers/role.mapper'
import { PrismaService } from '../../prisma/prisma.service'
import { ACCOUNT_ROLE_ALREADY_ASSIGNED } from '../../../common/constants/exception-enums'

const ROLE_INCLUDE = {
  permissions: { include: { permission: true } }
} as const

function buildActivePrincipalRoleBindingWhere(now: Date): Prisma.PrincipalRoleBindingWhereInput {
  return {
    AND: [
      { revokedAt: null },
      {
        OR: [{ effectiveAt: null }, { effectiveAt: { lte: now } }]
      },
      {
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      }
    ]
  } as const
}

@Injectable()
export class PrismaRoleRepository implements RoleRepository {
  private readonly logger = new Logger(PrismaRoleRepository.name)

  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Role | null> {
    const found = await this.prisma.role.findUnique({
      where: { id },
      include: ROLE_INCLUDE
    })
    return found ? RoleMapper.toDomain(found) : null
  }

  async findByCode(code: string): Promise<Role | null> {
    const found = await this.prisma.role.findFirst({
      where: { code },
      include: ROLE_INCLUDE
    })
    return found ? RoleMapper.toDomain(found) : null
  }

  async findByScopeAndCode(scopeKey: string, code: string): Promise<Role | null> {
    const found = await this.prisma.role.findFirst({
      where: { scopeKey, code },
      include: ROLE_INCLUDE
    })
    return found ? RoleMapper.toDomain(found) : null
  }

  async findByScopeKindAndCode(
    scopeKey: string,
    kind: RoleKind,
    code: string
  ): Promise<Role | null> {
    const found = await this.prisma.role.findFirst({
      where: { scopeKey, kind, code },
      include: ROLE_INCLUDE
    })
    return found ? RoleMapper.toDomain(found) : null
  }

  async findAll(): Promise<Role[]> {
    const records = await this.prisma.role.findMany({ include: ROLE_INCLUDE })
    return records.map(RoleMapper.toDomain)
  }

  async findRoleInstances(query: {
    page: number
    pageSize: number
    tenantId?: string
    scopeLevel?: ScopeLevel
    keyword?: string
  }): Promise<{ roles: Role[]; total: number; page: number; pageSize: number }> {
    const page = query.page
    const pageSize = query.pageSize
    const skip = (page - 1) * pageSize
    const keyword = query.keyword?.trim()

    const where = {
      kind: query.scopeLevel
        ? query.scopeLevel === ScopeLevel.SYSTEM
          ? RoleKind.SYSTEM_INSTANCE
          : RoleKind.TENANT_INSTANCE
        : {
            in: [RoleKind.SYSTEM_INSTANCE, RoleKind.TENANT_INSTANCE]
          },
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword, mode: 'insensitive' as const } },
              { code: { contains: keyword, mode: 'insensitive' as const } }
            ]
          }
        : {})
    }

    const [records, total] = await this.prisma.$transaction([
      this.prisma.role.findMany({
        where,
        include: ROLE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize
      }),
      this.prisma.role.count({ where })
    ])

    return {
      roles: records.map(RoleMapper.toDomain),
      total,
      page,
      pageSize
    }
  }

  async findRoleTemplates(query: {
    page: number
    pageSize: number
    keyword?: string
  }): Promise<{ roles: Role[]; total: number; page: number; pageSize: number }> {
    const page = query.page
    const pageSize = query.pageSize
    const skip = (page - 1) * pageSize
    const keyword = query.keyword?.trim()

    const where = {
      kind: RoleKind.SYSTEM_TEMPLATE,
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword, mode: 'insensitive' as const } },
              { code: { contains: keyword, mode: 'insensitive' as const } }
            ]
          }
        : {})
    }

    const [records, total] = await this.prisma.$transaction([
      this.prisma.role.findMany({
        where,
        include: ROLE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize
      }),
      this.prisma.role.count({ where })
    ])

    return {
      roles: records.map(RoleMapper.toDomain),
      total,
      page,
      pageSize
    }
  }

  async save(role: Role): Promise<Role> {
    const data = RoleMapper.toPersistent(role)

    await this.prisma.$transaction(async (tx) => {
      await tx.role.upsert({
        where: { id: role.id },
        update: {
          name: data.name,
          code: data.code,
          tenantId: data.tenantId,
          scopeKey: data.scopeKey,
          kind: data.kind,
          templateRoleId: data.templateRoleId,
          allowTenantPermissionOverride: data.allowTenantPermissionOverride,
          isProtected: data.isProtected,
          isEnabled: data.isEnabled,
          description: data.description
        } as any,
        create: {
          ...data
        } as any
      })

      const existingRPs = await tx.rolePermission.findMany({
        where: { roleId: role.id }
      })
      const currentIds = new Set(role.permissions.map((p) => p.permissionId))
      const existingIds = new Set(existingRPs.map((rp) => rp.permissionId))

      const toDelete = existingRPs.filter((rp) => !currentIds.has(rp.permissionId))
      if (toDelete.length > 0) {
        await tx.rolePermission.deleteMany({
          where: { id: { in: toDelete.map((rp) => rp.id) } }
        })
      }

      const toCreate = role.permissions.filter((p) => !existingIds.has(p.permissionId))
      if (toCreate.length > 0) {
        await tx.rolePermission.createMany({
          data: toCreate.map((p) => ({
            roleId: role.id,
            permissionId: p.permissionId
          }))
        })
      }
    })

    return (await this.findById(role.id))!
  }

  async delete(id: string): Promise<Role | null> {
    const deleted = await this.prisma.role.delete({ where: { id } })
    return deleted ? RoleMapper.toDomain(deleted) : null
  }

  async hasAssignedAccounts(roleId: string): Promise<boolean> {
    const count = await this.prisma.principalRoleBinding.count({ where: { roleId } })
    return count > 0
  }

  async hasAssignedPermissions(roleId: string): Promise<boolean> {
    const count = await this.prisma.rolePermission.count({ where: { roleId } })
    return count > 0
  }

  async hasTemplateInstances(roleTemplateId: string): Promise<boolean> {
    const count = await this.prisma.role.count({
      where: {
        templateRoleId: roleTemplateId,
        kind: { in: [RoleKind.SYSTEM_INSTANCE, RoleKind.TENANT_INSTANCE] }
      }
    })
    return count > 0
  }

  async findOwnPermissions(roleId: string): Promise<Permission[]> {
    const rps = await this.prisma.rolePermission.findMany({
      where: { roleId },
      include: { permission: true }
    })
    return rps.map((rp) => PermissionMapper.toDomain(rp.permission))
  }

  async findRolesByPermissionId(permissionId: string): Promise<Role[]> {
    const records = await this.prisma.role.findMany({
      where: {
        permissions: {
          some: {
            permissionId
          }
        }
      },
      include: ROLE_INCLUDE
    })

    return records.map(RoleMapper.toDomain)
  }

  async findRolesForAccountId(accountId: string): Promise<Role[]> {
    const now = new Date()
    const accountRoles = await this.prisma.principalRoleBinding.findMany({
      where: {
        principalType: 'HUMAN',
        principalId: accountId,
        ...buildActivePrincipalRoleBindingWhere(now),
        role: {
          isEnabled: true
        }
      },
      include: { role: { include: ROLE_INCLUDE } }
    })
    return accountRoles.map((ar) =>
      RoleMapper.toDomain(
        (
          ar as Prisma.PrincipalRoleBindingGetPayload<{
            include: { role: { include: typeof ROLE_INCLUDE } }
          }>
        ).role
      )
    )
  }

  /** Resolves current tenant-machine grant rows for application-layer snapshot eligibility. */
  async resolveExternalMachineAuthorizationSnapshot(input: {
    principalId: string
    tenantId: string
  }) {
    const bindings = await this.prisma.principalRoleBinding.findMany({
      where: {
        principalType: 'MACHINE',
        principalId: input.principalId,
        tenantId: input.tenantId,
        scopeLevel: ScopeLevel.TENANT,
        ...buildActivePrincipalRoleBindingWhere(new Date()),
        role: { isEnabled: true, kind: RoleKind.TENANT_INSTANCE, tenantId: input.tenantId }
      },
      include: { role: { include: { permissions: { include: { permission: true } } } } }
    })
    if (bindings.length === 0) return null
    const permissionsByCode = new Map<string, Permission>()
    for (const binding of bindings) {
      for (const rolePermission of binding.role.permissions) {
        const permission = PermissionMapper.toDomain(rolePermission.permission)
        permissionsByCode.set(permission.code, permission)
      }
    }
    const authzVersion = bindings
      .map(
        (binding) =>
          `${binding.id}:${binding.createdAt.toISOString()}:${binding.role.updatedAt.toISOString()}`
      )
      .sort()
      .join('|')
    return {
      permissions: [...permissionsByCode.values()].sort((left, right) =>
        left.code.localeCompare(right.code)
      ),
      authzVersion,
      decisionReference: `permission-snapshot:${input.principalId}:${authzVersion}`
    }
  }

  async assignAccountRole(
    accountId: string,
    roleId: string,
    tenantId: string | null,
    scopeLevel: ScopeLevel,
    accountType: AccountType,
    effectiveAt?: Date | null,
    expiresAt?: Date | null,
    auditContext?: {
      operatorId: string
      requestId?: string
      traceId?: string
      bindingId?: string
    }
  ): Promise<AccountRole> {
    try {
      const binding = await this.prisma.principalRoleBinding.create({
        data: {
          id: auditContext?.bindingId,
          principalType: accountType === AccountType.SERVICE ? 'MACHINE' : 'HUMAN',
          principalId: accountId,
          roleId,
          tenantId,
          scopeLevel,
          effectiveAt: effectiveAt ?? new Date(),
          expiresAt: expiresAt ?? null,
          createdByOperatorId: auditContext?.operatorId ?? null,
          createdRequestId: auditContext?.requestId ?? null,
          createdTraceId: auditContext?.traceId ?? null,
          grantAuditEventId: randomUUID()
        }
      })

      return toAccountRole(binding)
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002' && auditContext?.bindingId) {
        const existing = await this.prisma.principalRoleBinding.findUnique({
          where: { id: auditContext.bindingId }
        })
        if (
          existing &&
          existing.principalId === accountId &&
          existing.roleId === roleId &&
          existing.scopeLevel === scopeLevel &&
          existing.tenantId === tenantId &&
          existing.principalType === (accountType === AccountType.SERVICE ? 'MACHINE' : 'HUMAN')
        ) {
          return toAccountRole(existing)
        }
      }
      if (isBindingOverlapError(error)) {
        throw ExceptionFactory.domain(ACCOUNT_ROLE_ALREADY_ASSIGNED, {
          principalId: accountId,
          roleId,
          scopeLevel,
          tenantId
        })
      }
      throw error
    }
  }

  /** revokeAccountRole intentionally refuses legacy selectors after canonical cutover. */
  async revokeAccountRole(_accountId: string, _roleId: string): Promise<void> {
    throw new Error('PRINCIPAL_ROLE_BINDING_ID_REQUIRED')
  }

  /** revokePrincipalRoleBinding atomically records or replays the first revoke facts. */
  async revokePrincipalRoleBinding(input: {
    bindingId: string
    revokedAt: Date
    revokedByOperatorId: string
    reason: string
    auditEventId: string
  }) {
    return this.prisma.$transaction(async (tx) => {
      const update = await tx.principalRoleBinding.updateMany({
        where: { id: input.bindingId, revokedAt: null },
        data: {
          revokedAt: input.revokedAt,
          revokedByOperatorId: input.revokedByOperatorId,
          revokeReason: input.reason,
          revokeAuditEventId: input.auditEventId
        }
      })

      const binding = await tx.principalRoleBinding.findUnique({
        where: { id: input.bindingId }
      })

      if (!binding) {
        const tombstone = await tx.principalRoleBindingRevokeTombstone.upsert({
          where: { bindingId: input.bindingId },
          update: {},
          create: {
            bindingId: input.bindingId,
            revokedAt: input.revokedAt,
            revokedByOperatorId: input.revokedByOperatorId,
            reason: input.reason,
            opaqueRevokeOutcomeId: input.auditEventId
          }
        })
        return {
          bindingId: tombstone.bindingId,
          revokedAt: tombstone.revokedAt,
          revokedByOperatorId: tombstone.revokedByOperatorId,
          reason: tombstone.reason,
          auditEventId: tombstone.opaqueRevokeOutcomeId,
          revokedNow: false
        }
      }

      return {
        bindingId: binding.id,
        revokedAt: binding.revokedAt!,
        revokedByOperatorId: binding.revokedByOperatorId!,
        reason: binding.revokeReason ?? '',
        auditEventId: binding.revokeAuditEventId!,
        revokedNow: update.count === 1
      }
    })
  }

  /** findPrincipalRoleBindings returns active HUMAN binding facts for compatibility-facing account reads. */
  async findPrincipalRoleBindings(
    principalId: string,
    tenantId?: string | null,
    scopeLevel: ScopeLevel = tenantId ? ScopeLevel.TENANT : ScopeLevel.SYSTEM
  ): Promise<AccountRole[]> {
    const records = await this.prisma.principalRoleBinding.findMany({
      where: {
        principalType: 'HUMAN',
        principalId,
        scopeLevel,
        ...(scopeLevel === ScopeLevel.SYSTEM ? { tenantId: null } : { tenantId: tenantId! }),
        ...buildActivePrincipalRoleBindingWhere(new Date())
      }
    })
    return records.map(toAccountRole)
  }

  async findAccountRoles(
    accountId: string,
    tenantId?: string | null,
    scopeLevel: ScopeLevel = tenantId ? ScopeLevel.TENANT : ScopeLevel.SYSTEM
  ): Promise<Role[]> {
    const now = new Date()
    const accountRoles = await this.prisma.principalRoleBinding.findMany({
      where: {
        principalType: 'HUMAN',
        principalId: accountId,
        scopeLevel,
        ...(scopeLevel === ScopeLevel.SYSTEM ? { tenantId: null } : { tenantId: tenantId! }),
        ...buildActivePrincipalRoleBindingWhere(now),
        role: {
          isEnabled: true
        }
      },
      include: { role: { include: ROLE_INCLUDE } }
    })

    const roles = accountRoles.map((ar) =>
      RoleMapper.toDomain(
        (
          ar as Prisma.PrincipalRoleBindingGetPayload<{
            include: { role: { include: typeof ROLE_INCLUDE } }
          }>
        ).role
      )
    )

    const repositoryMessage = `findAccountRoles: accountId=${accountId}; tenantId=${tenantId ?? ''}; scopeLevel=${scopeLevel}; bindings=${
      accountRoles.length
    }; roles=${roles.map((role) => `${role.code}[${role.permissions.length}]`).join(',')}`

    if (roles.some((role) => role.permissions.length === 0)) {
      this.logger.warn(repositoryMessage)
    } else {
      this.logger.debug(repositoryMessage)
    }

    return roles
  }

  async findTenantRoles(tenantId: string): Promise<Role[]> {
    const records = await this.prisma.role.findMany({
      where: {
        tenantId,
        kind: RoleKind.TENANT_INSTANCE,
        isEnabled: true
      },
      include: ROLE_INCLUDE,
      orderBy: { name: 'asc' }
    })

    return records.map(RoleMapper.toDomain)
  }

  async findSystemRoles(): Promise<Role[]> {
    const records = await this.prisma.role.findMany({
      where: {
        tenantId: null,
        kind: RoleKind.SYSTEM_INSTANCE,
        isEnabled: true
      },
      include: ROLE_INCLUDE,
      orderBy: { name: 'asc' }
    })

    return records.map(RoleMapper.toDomain)
  }

  async findRoleTemplateById(id: string): Promise<Role | null> {
    const found = await this.prisma.role.findFirst({
      where: {
        id,
        kind: RoleKind.SYSTEM_TEMPLATE
      },
      include: ROLE_INCLUDE
    })

    return found ? RoleMapper.toDomain(found) : null
  }

  async findRoleAccounts(roleId: string): Promise<AccountRole[]> {
    const now = new Date()
    const accountRoles = await this.prisma.principalRoleBinding.findMany({
      where: {
        principalType: 'HUMAN',
        roleId,
        ...buildActivePrincipalRoleBindingWhere(now)
      }
    })

    return accountRoles.map((accountRole) => toAccountRole(accountRole))
  }

  async replaceAccountRoles(
    accountId: string,
    tenantId: string | null,
    scopeLevel: ScopeLevel,
    accountType: AccountType,
    roleIds: string[],
    auditContext?: {
      operatorId: string
      requestId?: string
      traceId?: string
    }
  ): Promise<{ roles: Role[]; bindings: AccountRole[] }> {
    const uniqueRoleIds = [...new Set(roleIds)]

    await this.prisma.$transaction(async (tx) => {
      const now = new Date()
      const existing = await tx.principalRoleBinding.findMany({
        where: {
          principalType: accountType === AccountType.SERVICE ? 'MACHINE' : 'HUMAN',
          principalId: accountId,
          scopeLevel,
          ...(scopeLevel === ScopeLevel.SYSTEM ? { tenantId: null } : { tenantId: tenantId! }),
          ...buildActivePrincipalRoleBindingWhere(now)
        }
      })
      const existingRoleIds = new Set(existing.map((item) => item.roleId))
      const targetRoleIds = new Set(uniqueRoleIds)

      const bindingsToRevoke = existing.filter((item) => !targetRoleIds.has(item.roleId))

      for (const binding of bindingsToRevoke) {
        await tx.principalRoleBinding.update({
          where: { id: binding.id },
          data: {
            revokedAt: now,
            revokedByOperatorId: auditContext?.operatorId ?? 'system',
            revokeReason: 'ACCOUNT_ROLE_SET_REPLACED',
            revokeAuditEventId: randomUUID()
          }
        })
      }

      const roleIdsToCreate = uniqueRoleIds.filter((roleId) => !existingRoleIds.has(roleId))

      if (roleIdsToCreate.length > 0) {
        await tx.principalRoleBinding.createMany({
          data: roleIdsToCreate.map((roleId) => ({
            principalType: accountType === AccountType.SERVICE ? 'MACHINE' : 'HUMAN',
            principalId: accountId,
            tenantId,
            scopeLevel,
            roleId,
            effectiveAt: now,
            createdByOperatorId: auditContext?.operatorId ?? 'system',
            createdRequestId: auditContext?.requestId ?? null,
            createdTraceId: auditContext?.traceId ?? null,
            grantAuditEventId: randomUUID()
          }))
        })
      }
    })

    const [roles, bindings] = await Promise.all([
      this.findAccountRoles(accountId, tenantId, scopeLevel),
      this.findPrincipalRoleBindings(accountId, tenantId, scopeLevel)
    ])
    return { roles, bindings }
  }
}

/** toAccountRole maps canonical persistence into the compatibility-facing binding value object. */
function toAccountRole(binding: {
  id: string
  principalType: string
  principalId: string
  roleId: string
  tenantId: string | null
  scopeLevel: string
  effectiveAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  revokedByOperatorId: string | null
  revokeReason: string | null
  revokeAuditEventId: string | null
  grantAuditEventId?: string | null
}): AccountRole {
  return new AccountRole(
    binding.principalType === 'MACHINE' ? AccountType.SERVICE : AccountType.USER,
    binding.principalId,
    binding.roleId,
    binding.tenantId,
    binding.scopeLevel as ScopeLevel,
    binding.effectiveAt,
    binding.expiresAt,
    binding.id,
    binding.revokedAt,
    binding.revokedByOperatorId,
    binding.revokeReason,
    binding.revokeAuditEventId,
    binding.grantAuditEventId ?? null
  )
}

/** isBindingOverlapError recognizes PostgreSQL exclusion violations surfaced by Prisma. */
function isBindingOverlapError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string; meta?: { constraint?: string } }
  return (
    candidate?.meta?.constraint === 'principal_role_binding_non_overlapping_window' ||
    candidate?.message?.includes('principal_role_binding_non_overlapping_window') === true ||
    candidate?.code === 'P2004' ||
    candidate?.code === 'P2002'
  )
}

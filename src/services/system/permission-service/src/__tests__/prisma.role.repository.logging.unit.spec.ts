import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { RoleKind } from '../domain/enums/role-kind.enum'
import { ScopeLevel } from '../domain/enums/scope-level.enum'
import { PrismaRoleRepository } from '../infrastructure/repositories/prisma/prisma.role.repository'

afterEach(() => {
  jest.restoreAllMocks()
})

/** Verifies normal role lookups stay at debug while malformed role grants remain warnings. */
describe('PrismaRoleRepository findAccountRoles logging', () => {
  it.each([
    ['no active bindings', []],
    ['active roles with permissions', [principalRoleBinding(['permission.read'])]]
  ])('logs %s at debug level', async (_scenario, records) => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined)
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const repository = repositoryWith(records)

    await repository.findAccountRoles('account-1', null, ScopeLevel.SYSTEM)

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('findAccountRoles: accountId=account-1')
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns when an active role unexpectedly has no permissions', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined)
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const repository = repositoryWith([principalRoleBinding([])])

    await repository.findAccountRoles('account-1', 'tenant-1', ScopeLevel.TENANT)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('roles=operator[0]'))
    expect(debug).not.toHaveBeenCalled()
  })
})

/** Creates the smallest Prisma repository double needed by findAccountRoles. */
function repositoryWith(records: unknown[]) {
  return new PrismaRoleRepository({
    principalRoleBinding: {
      findMany: jest.fn().mockResolvedValue(records)
    }
  } as never)
}

/** Creates one active binding payload in the shape consumed by RoleMapper. */
function principalRoleBinding(permissionCodes: string[]) {
  return {
    role: {
      id: 'role-1',
      name: 'Operator',
      code: 'operator',
      tenantId: null,
      kind: RoleKind.SYSTEM_INSTANCE,
      isEnabled: true,
      permissions: permissionCodes.map((code, index) => ({
        roleId: 'role-1',
        permissionId: `permission-${index + 1}`,
        permission: { code }
      }))
    }
  }
}

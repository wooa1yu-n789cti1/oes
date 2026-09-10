import { RoleKind } from '../../prisma/generated/prisma'
import {
  deterministicRoleInstanceBaselinePermissionId,
  rollbackBuiltInRoleInstanceBaselinePermissions,
  syncBuiltInRoleInstanceBaselines
} from '../scripts/role-instance-foundation'

describe('role instance foundation sync', () => {
  it('backfills missing baseline permissions onto built-in tenant admin instances', async () => {
    const prisma = {
      role: {
        findMany: jest.fn().mockImplementation((args) =>
          args.where.OR?.some((item: { code?: string }) => item.code === 'tenant.admin')
            ? Promise.resolve([
                { id: 'tenant-admin-role-1', kind: RoleKind.TENANT_INSTANCE },
                { id: 'tenant-admin-role-2', kind: RoleKind.TENANT_INSTANCE }
              ])
            : Promise.resolve([])
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 2 })
      },
      rolePermission: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { roleId: 'tenant-admin-role-1', permissionId: 'perm-view-role-instance' }
          ]),
        createMany: jest.fn().mockResolvedValue({ count: 3 })
      },
      roleNavigationVisibility: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      roleLandingPolicy: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 })
      }
    } as any

    const createdCount = await syncBuiltInRoleInstanceBaselines(
      prisma,
      new Map([
        ['permission.role_instance.list', 'perm-view-role-instance'],
        ['permission.account.get_roles', 'perm-view-account-role'],
        ['identity.account.list', 'perm-identity-list-account'],
        ['tenant_org.org_unit.list_tree', 'perm-list-org-tree']
      ])
    )

    expect(prisma.role.findMany).toHaveBeenCalledWith({
      where: {
        kind: {
          in: [RoleKind.SYSTEM_INSTANCE, RoleKind.TENANT_INSTANCE]
        },
        OR: [{ code: 'tenant.admin' }, { templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001' }]
      },
      select: {
        id: true,
        kind: true
      }
    })
    expect(prisma.role.updateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: ['tenant-admin-role-1', 'tenant-admin-role-2']
        }
      },
      data: {
        allowTenantPermissionOverride: false,
        isProtected: true
      }
    })
    expect(prisma.rolePermission.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-1',
            'perm-view-account-role'
          ),
          permissionId: 'perm-view-account-role',
          roleId: 'tenant-admin-role-1'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-1',
            'perm-identity-list-account'
          ),
          permissionId: 'perm-identity-list-account',
          roleId: 'tenant-admin-role-1'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-1',
            'perm-list-org-tree'
          ),
          permissionId: 'perm-list-org-tree',
          roleId: 'tenant-admin-role-1'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-2',
            'perm-view-role-instance'
          ),
          permissionId: 'perm-view-role-instance',
          roleId: 'tenant-admin-role-2'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-2',
            'perm-view-account-role'
          ),
          permissionId: 'perm-view-account-role',
          roleId: 'tenant-admin-role-2'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-2',
            'perm-identity-list-account'
          ),
          permissionId: 'perm-identity-list-account',
          roleId: 'tenant-admin-role-2'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-2',
            'perm-list-org-tree'
          ),
          permissionId: 'perm-list-org-tree',
          roleId: 'tenant-admin-role-2'
        }
      ],
      skipDuplicates: true
    })
    expect(createdCount).toBe(7)
  })

  it('rolls back only deterministic seed-owned edges and preserves pre-existing grants', async () => {
    const permissionId = 'perm-collaboration-task-create'
    const seedOwnedId = deterministicRoleInstanceBaselinePermissionId(
      'tenant-admin-role-1',
      permissionId
    )
    const prisma = {
      permission: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ code: 'collaboration.task.create', id: permissionId }])
      },
      role: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'tenant-admin-role-1' },
            { id: 'tenant-admin-role-with-pre-existing-grant' }
          ])
      },
      rolePermission: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: seedOwnedId,
            permissionId,
            roleId: 'tenant-admin-role-1'
          }
        ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    } as any

    const result = await rollbackBuiltInRoleInstanceBaselinePermissions(
      prisma,
      ['collaboration.task.create'],
      true
    )

    expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            id: seedOwnedId,
            permissionId,
            roleId: 'tenant-admin-role-1'
          }
        ]
      }
    })
    expect(result).toEqual({
      deletedCount: 1,
      deletedRolePermissionIds: [seedOwnedId],
      identityMismatchIds: [],
      missingPermissionCodes: [],
      mode: 'apply',
      requestedPermissionCodes: ['collaboration.task.create'],
      seedOwnedMatchCount: 1,
      unmatchedPermissionCodes: []
    })
  })

  it('round-trips a new baseline grant while retaining the same pre-existing grant', async () => {
    const permissionId = 'perm-collaboration-task-create'
    const roleIds = ['tenant-admin-role-new-grant', 'tenant-admin-role-pre-existing']
    let rows = [
      {
        id: 'pre-existing-role-permission-id',
        permissionId,
        roleId: 'tenant-admin-role-pre-existing'
      }
    ]
    const prisma = {
      permission: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ code: 'collaboration.task.create', id: permissionId }])
      },
      role: {
        findMany: jest.fn().mockImplementation((args) =>
          args.where.OR?.some((item: { code?: string }) => item.code === 'tenant.admin')
            ? Promise.resolve(
                roleIds.map((id) => ({
                  id,
                  kind: RoleKind.TENANT_INSTANCE
                }))
              )
            : Promise.resolve([])
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 2 })
      },
      rolePermission: {
        findMany: jest.fn().mockImplementation((args) => {
          if (args.where.id?.in) {
            return Promise.resolve(rows.filter((row) => args.where.id.in.includes(row.id)))
          }
          return Promise.resolve(
            rows.filter(
              (row) =>
                args.where.roleId.in.includes(row.roleId) &&
                args.where.permissionId.in.includes(row.permissionId)
            )
          )
        }),
        createMany: jest.fn().mockImplementation(({ data }) => {
          rows = [...rows, ...data]
          return Promise.resolve({ count: data.length })
        }),
        deleteMany: jest.fn().mockImplementation(({ where }) => {
          const deletedIds = new Set(where.OR.map((item: { id: string }) => item.id))
          const priorCount = rows.length
          rows = rows.filter((row) => !deletedIds.has(row.id))
          return Promise.resolve({ count: priorCount - rows.length })
        })
      },
      roleNavigationVisibility: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      roleLandingPolicy: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 })
      }
    } as any

    expect(
      await syncBuiltInRoleInstanceBaselines(
        prisma,
        new Map([['collaboration.task.create', permissionId]])
      )
    ).toBe(1)
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          id: 'pre-existing-role-permission-id',
          permissionId,
          roleId: 'tenant-admin-role-pre-existing'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-new-grant',
            permissionId
          ),
          permissionId,
          roleId: 'tenant-admin-role-new-grant'
        }
      ])
    )

    const rollback = await rollbackBuiltInRoleInstanceBaselinePermissions(
      prisma,
      ['collaboration.task.create'],
      true
    )

    expect(rollback.deletedCount).toBe(1)
    expect(rows).toEqual([
      {
        id: 'pre-existing-role-permission-id',
        permissionId,
        roleId: 'tenant-admin-role-pre-existing'
      }
    ])
  })

  it('reports seed-owned matches without deleting them in rollback dry-run mode', async () => {
    const permissionId = 'perm-collaboration-task-create'
    const seedOwnedId = deterministicRoleInstanceBaselinePermissionId(
      'tenant-admin-role-1',
      permissionId
    )
    const prisma = {
      permission: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ code: 'collaboration.task.create', id: permissionId }])
      },
      role: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tenant-admin-role-1' }])
      },
      rolePermission: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: seedOwnedId,
            permissionId,
            roleId: 'tenant-admin-role-1'
          }
        ]),
        deleteMany: jest.fn()
      }
    } as any

    const result = await rollbackBuiltInRoleInstanceBaselinePermissions(prisma, [
      'collaboration.task.create'
    ])

    expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled()
    expect(result.mode).toBe('dry-run')
    expect(result.seedOwnedMatchCount).toBe(1)
    expect(result.deletedCount).toBe(0)
  })

  it('fails closed before deletion when a deterministic id belongs to a different edge', async () => {
    const permissionId = 'perm-collaboration-task-create'
    const seedOwnedId = deterministicRoleInstanceBaselinePermissionId(
      'tenant-admin-role-1',
      permissionId
    )
    const prisma = {
      permission: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ code: 'collaboration.task.create', id: permissionId }])
      },
      role: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tenant-admin-role-1' }])
      },
      rolePermission: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: seedOwnedId,
            permissionId: 'different-permission',
            roleId: 'tenant-admin-role-1'
          }
        ]),
        deleteMany: jest.fn()
      }
    } as any

    await expect(
      rollbackBuiltInRoleInstanceBaselinePermissions(prisma, ['collaboration.task.create'], true)
    ).rejects.toThrow('Role-instance baseline rollback identity checks failed')
    expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled()
  })

  it('backfills missing baseline navigation onto built-in tenant role instances without removing custom entries', async () => {
    const prisma = {
      role: {
        findMany: jest.fn().mockImplementation((args) =>
          args.where.OR?.some(
            (item: { code?: string }) => item.code === 'item_master.product_data_manager'
          )
            ? Promise.resolve([
                {
                  id: 'item-role-1',
                  kind: RoleKind.TENANT_INSTANCE
                }
              ])
            : Promise.resolve([])
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      rolePermission: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      roleNavigationVisibility: {
        findMany: jest.fn().mockResolvedValue([
          {
            entryKey: 'master-data.item-management',
            roleId: 'item-role-1',
            terminal: 'DEFAULT'
          },
          {
            entryKey: 'custom.local-dashboard',
            roleId: 'item-role-1',
            terminal: 'DEFAULT'
          }
        ]),
        createMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      roleLandingPolicy: {
        findMany: jest.fn().mockResolvedValue([
          {
            defaultEntryKey: 'workbench.home',
            roleId: 'item-role-1',
            terminal: 'DEFAULT'
          }
        ]),
        createMany: jest.fn().mockResolvedValue({ count: 0 })
      }
    } as any

    await syncBuiltInRoleInstanceBaselines(
      prisma,
      new Map([
        ['item_master.item.list', 'perm-list-item'],
        ['item_master.item_category.list', 'perm-list-item-category'],
        ['item_master.attribute.list', 'perm-list-attribute'],
        ['item_master.packaging.list', 'perm-list-packaging'],
        ['item_master.bom.list', 'perm-list-bom']
      ])
    )

    expect(prisma.roleNavigationVisibility.createMany).toHaveBeenCalledWith({
      data: [
        {
          enabled: true,
          entryKey: 'workbench.home',
          roleId: 'item-role-1',
          terminal: 'DEFAULT'
        },
        {
          enabled: true,
          entryKey: 'master-data.item-category-management',
          roleId: 'item-role-1',
          terminal: 'DEFAULT'
        },
        {
          enabled: true,
          entryKey: 'master-data.item-attribute-management',
          roleId: 'item-role-1',
          terminal: 'DEFAULT'
        },
        {
          enabled: true,
          entryKey: 'master-data.item-packaging-management',
          roleId: 'item-role-1',
          terminal: 'DEFAULT'
        },
        {
          enabled: true,
          entryKey: 'master-data.item-bom-management',
          roleId: 'item-role-1',
          terminal: 'DEFAULT'
        }
      ],
      skipDuplicates: true
    })
    expect(prisma.roleLandingPolicy.createMany).not.toHaveBeenCalled()
  })
})

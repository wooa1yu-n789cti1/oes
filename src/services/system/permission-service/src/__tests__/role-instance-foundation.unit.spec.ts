import { RoleKind } from '../../prisma/generated/prisma'
import {
  deterministicRoleInstanceBaselinePermissionId,
  rollbackBuiltInRoleInstanceBaselinePermissions,
  syncBuiltInRoleInstanceBaselines
} from '../scripts/role-instance-foundation'

describe('role instance foundation sync', () => {
  it('backfills missing baseline permissions onto built-in tenant admin instances', async () => {
    let rolePermissionRows = [
      {
        id: 'pre-existing-role-permission',
        roleId: 'tenant-admin-role-1',
        permissionId: 'perm-view-role-instance'
      }
    ]
    const prisma = {
      role: {
        findMany: jest.fn().mockImplementation((args) =>
          args.where.OR?.some((item: { code?: string }) => item.code === 'tenant.admin')
            ? Promise.resolve([
                {
                  code: 'tenant.admin',
                  id: 'tenant-admin-role-1',
                  kind: RoleKind.TENANT_INSTANCE,
                  templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
                },
                {
                  code: 'tenant.admin',
                  id: 'tenant-admin-role-2',
                  kind: RoleKind.TENANT_INSTANCE,
                  templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
                }
              ])
            : Promise.resolve([])
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 2 })
      },
      rolePermission: {
        findMany: jest.fn().mockImplementation((args) => {
          if (args.where.id?.in) {
            return Promise.resolve(
              rolePermissionRows.filter((row) => args.where.id.in.includes(row.id))
            )
          }
          return Promise.resolve(
            rolePermissionRows.filter(
              (row) =>
                args.where.roleId.in.includes(row.roleId) &&
                args.where.permissionId.in.includes(row.permissionId)
            )
          )
        }),
        createMany: jest.fn().mockImplementation(({ data }) => {
          rolePermissionRows = [...rolePermissionRows, ...data]
          return Promise.resolve({ count: data.length })
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
        code: true,
        id: true,
        kind: true,
        templateRoleId: true
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
            'permission.account.get_roles'
          ),
          permissionId: 'perm-view-account-role',
          roleId: 'tenant-admin-role-1'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-1',
            'identity.account.list'
          ),
          permissionId: 'perm-identity-list-account',
          roleId: 'tenant-admin-role-1'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-1',
            'tenant_org.org_unit.list_tree'
          ),
          permissionId: 'perm-list-org-tree',
          roleId: 'tenant-admin-role-1'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-2',
            'permission.role_instance.list'
          ),
          permissionId: 'perm-view-role-instance',
          roleId: 'tenant-admin-role-2'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-2',
            'permission.account.get_roles'
          ),
          permissionId: 'perm-view-account-role',
          roleId: 'tenant-admin-role-2'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-2',
            'identity.account.list'
          ),
          permissionId: 'perm-identity-list-account',
          roleId: 'tenant-admin-role-2'
        },
        {
          id: deterministicRoleInstanceBaselinePermissionId(
            'tenant-admin-role-2',
            'tenant_org.org_unit.list_tree'
          ),
          permissionId: 'perm-list-org-tree',
          roleId: 'tenant-admin-role-2'
        }
      ]
    })
    expect(createdCount).toBe(7)
  })

  it('rolls back only deterministic seed-owned edges and preserves pre-existing grants', async () => {
    const permissionId = 'perm-collaboration-task-create'
    const seedOwnedId = deterministicRoleInstanceBaselinePermissionId(
      'tenant-admin-role-1',
      'collaboration.task.create'
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
            {
              code: 'tenant.admin',
              id: 'tenant-admin-role-1',
              kind: RoleKind.TENANT_INSTANCE,
              templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
            },
            {
              code: 'tenant.admin',
              id: 'tenant-admin-role-with-pre-existing-grant',
              kind: RoleKind.TENANT_INSTANCE,
              templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
            }
          ])
      },
      rolePermission: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: seedOwnedId,
              permissionId,
              roleId: 'tenant-admin-role-1'
            }
          ])
          .mockResolvedValueOnce([]),
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
            roleId: 'tenant-admin-role-1',
            permission: { is: { code: 'collaboration.task.create' } },
            role: {
              is: {
                kind: { in: [RoleKind.SYSTEM_INSTANCE, RoleKind.TENANT_INSTANCE] },
                OR: [
                  { code: 'tenant.admin' },
                  { templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001' }
                ]
              }
            }
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
        findMany: jest.fn().mockImplementation((args) => {
          const roles = roleIds.map((id) => ({
            code: 'tenant.admin',
            id,
            kind: RoleKind.TENANT_INSTANCE,
            templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
          }))
          return args.where?.OR?.some((item: { code?: string }) => item.code === 'tenant.admin') ||
            args.where === undefined
            ? Promise.resolve(roles)
            : Promise.resolve([])
        }),
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
            'collaboration.task.create'
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
      'collaboration.task.create'
    )
    const prisma = {
      permission: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ code: 'collaboration.task.create', id: permissionId }])
      },
      role: {
        findMany: jest.fn().mockResolvedValue([
          {
            code: 'tenant.admin',
            id: 'tenant-admin-role-1',
            kind: RoleKind.TENANT_INSTANCE,
            templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
          }
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
      'collaboration.task.create'
    )
    const prisma = {
      permission: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ code: 'collaboration.task.create', id: permissionId }])
      },
      role: {
        findMany: jest.fn().mockResolvedValue([
          {
            code: 'tenant.admin',
            id: 'tenant-admin-role-1',
            kind: RoleKind.TENANT_INSTANCE,
            templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
          }
        ])
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

  it('fails closed when a deterministic id is occupied before forward insert', async () => {
    const permissionCode = 'collaboration.task.create'
    const permissionId = 'perm-collaboration-task-create'
    const deterministicId = deterministicRoleInstanceBaselinePermissionId(
      'tenant-admin-role-1',
      permissionCode
    )
    const prisma = {
      role: {
        findMany: jest.fn().mockImplementation((args) =>
          args.where.OR?.some((item: { code?: string }) => item.code === 'tenant.admin')
            ? Promise.resolve([
                {
                  code: 'tenant.admin',
                  id: 'tenant-admin-role-1',
                  kind: RoleKind.TENANT_INSTANCE,
                  templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
                }
              ])
            : Promise.resolve([])
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      rolePermission: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { id: deterministicId, permissionId: 'foreign-permission', roleId: 'foreign-role' }
          ]),
        createMany: jest.fn()
      },
      roleNavigationVisibility: {
        findMany: jest.fn(),
        createMany: jest.fn()
      },
      roleLandingPolicy: {
        findMany: jest.fn(),
        createMany: jest.fn()
      }
    } as any

    await expect(
      syncBuiltInRoleInstanceBaselines(prisma, new Map([[permissionCode, permissionId]]))
    ).rejects.toThrow('Role-instance baseline deterministic ids are already occupied')
    expect(prisma.rolePermission.createMany).not.toHaveBeenCalled()
  })

  it('fails closed when forward insertion reports a different count', async () => {
    const prisma = {
      role: {
        findMany: jest.fn().mockImplementation((args) =>
          args.where.OR?.some((item: { code?: string }) => item.code === 'tenant.admin')
            ? Promise.resolve([
                {
                  code: 'tenant.admin',
                  id: 'tenant-admin-role-1',
                  kind: RoleKind.TENANT_INSTANCE,
                  templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
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
        findMany: jest.fn(),
        createMany: jest.fn()
      },
      roleLandingPolicy: {
        findMany: jest.fn(),
        createMany: jest.fn()
      }
    } as any

    await expect(
      syncBuiltInRoleInstanceBaselines(
        prisma,
        new Map([['collaboration.task.create', 'perm-collaboration-task-create']])
      )
    ).rejects.toThrow('Role-instance baseline insert count mismatch: expected=1 actual=0')
  })

  it('fails closed when a seed-owned edge role identity has drifted', async () => {
    const permissionCode = 'collaboration.task.create'
    const permissionId = 'perm-collaboration-task-create'
    const seedOwnedId = deterministicRoleInstanceBaselinePermissionId(
      'tenant-admin-role-1',
      permissionCode
    )
    const prisma = {
      permission: {
        findMany: jest.fn().mockResolvedValue([{ code: permissionCode, id: permissionId }])
      },
      role: {
        findMany: jest.fn().mockResolvedValue([
          {
            code: 'tenant.viewer',
            id: 'tenant-admin-role-1',
            kind: RoleKind.TENANT_INSTANCE,
            templateRoleId: null
          }
        ])
      },
      rolePermission: {
        findMany: jest.fn().mockResolvedValue([
          { id: seedOwnedId, permissionId, roleId: 'tenant-admin-role-1' }
        ]),
        deleteMany: jest.fn()
      }
    } as any

    await expect(
      rollbackBuiltInRoleInstanceBaselinePermissions(prisma, [permissionCode], true)
    ).rejects.toThrow('Role-instance baseline rollback identity checks failed')
    expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled()
  })

  it('fails closed when a seed-owned edge permission identity has drifted', async () => {
    const permissionCode = 'collaboration.task.create'
    const priorPermissionId = 'perm-collaboration-task-create-prior'
    const currentPermissionId = 'perm-collaboration-task-create-current'
    const seedOwnedId = deterministicRoleInstanceBaselinePermissionId(
      'tenant-admin-role-1',
      permissionCode
    )
    const prisma = {
      permission: {
        findMany: jest.fn().mockResolvedValue([
          { code: permissionCode, id: currentPermissionId },
          { code: 'collaboration.task.create.renamed', id: priorPermissionId }
        ])
      },
      role: {
        findMany: jest.fn().mockResolvedValue([
          {
            code: 'tenant.admin',
            id: 'tenant-admin-role-1',
            kind: RoleKind.TENANT_INSTANCE,
            templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
          }
        ])
      },
      rolePermission: {
        findMany: jest.fn().mockResolvedValue([
          { id: seedOwnedId, permissionId: priorPermissionId, roleId: 'tenant-admin-role-1' }
        ]),
        deleteMany: jest.fn()
      }
    } as any

    await expect(
      rollbackBuiltInRoleInstanceBaselinePermissions(prisma, [permissionCode], true)
    ).rejects.toThrow('Role-instance baseline rollback identity checks failed')
    expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled()
  })

  it('fails closed when exact rollback deletion count changes', async () => {
    const permissionCode = 'collaboration.task.create'
    const permissionId = 'perm-collaboration-task-create'
    const seedOwnedId = deterministicRoleInstanceBaselinePermissionId(
      'tenant-admin-role-1',
      permissionCode
    )
    const prisma = {
      permission: {
        findMany: jest.fn().mockResolvedValue([{ code: permissionCode, id: permissionId }])
      },
      role: {
        findMany: jest.fn().mockResolvedValue([
          {
            code: 'tenant.admin',
            id: 'tenant-admin-role-1',
            kind: RoleKind.TENANT_INSTANCE,
            templateRoleId: '2cf72f72-e04a-4946-b8c0-22f120f82001'
          }
        ])
      },
      rolePermission: {
        findMany: jest.fn().mockResolvedValue([
          { id: seedOwnedId, permissionId, roleId: 'tenant-admin-role-1' }
        ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 })
      }
    } as any

    await expect(
      rollbackBuiltInRoleInstanceBaselinePermissions(prisma, [permissionCode], true)
    ).rejects.toThrow('Role-instance baseline rollback delete count mismatch: expected=1 actual=0')
  })

  it('backfills missing baseline navigation onto built-in tenant role instances without removing custom entries', async () => {
    let rolePermissionRows: Array<{ id: string; permissionId: string; roleId: string }> = []
    const prisma = {
      role: {
        findMany: jest.fn().mockImplementation((args) =>
          args.where.OR?.some(
            (item: { code?: string }) => item.code === 'item_master.product_data_manager'
          )
            ? Promise.resolve([
                {
                  code: 'item_master.product_data_manager',
                  id: 'item-role-1',
                  kind: RoleKind.TENANT_INSTANCE,
                  templateRoleId: null
                }
              ])
            : Promise.resolve([])
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      rolePermission: {
        findMany: jest.fn().mockImplementation((args) => {
          if (args.where.id?.in) {
            return Promise.resolve(
              rolePermissionRows.filter((row) => args.where.id.in.includes(row.id))
            )
          }
          return Promise.resolve([])
        }),
        createMany: jest.fn().mockImplementation(({ data }) => {
          rolePermissionRows = [...rolePermissionRows, ...data]
          return Promise.resolve({ count: data.length })
        })
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

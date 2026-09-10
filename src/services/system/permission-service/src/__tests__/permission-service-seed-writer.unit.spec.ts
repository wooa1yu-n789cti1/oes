import {
  buildPermissionServiceSeed,
  renderPermissionServiceSeedDryRunSummary
} from '../scripts/permission-service-seed'
import {
  applyPermissionServiceSeed,
  buildPermissionServiceSeedExecutionPlan,
  deterministicPermissionSeedId,
  parsePermissionServiceSeedArgs
} from '../scripts/permission-service-seed-writer'

// Verifies the permission-service seed writer is safe-by-default and requires explicit apply.
describe('permission service seed writer', () => {
  it('derives stable distinct permission identifiers from canonical codes', () => {
    expect(deterministicPermissionSeedId('permission.read')).toBe(
      deterministicPermissionSeedId('permission.read')
    )
    expect(deterministicPermissionSeedId('permission.read')).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
    )
    expect(deterministicPermissionSeedId('permission.read')).not.toBe(
      deterministicPermissionSeedId('permission.write')
    )
  })

  it('defaults to dry-run mode unless --apply is provided', () => {
    expect(parsePermissionServiceSeedArgs([])).toEqual({ apply: false })
    expect(parsePermissionServiceSeedArgs(['--dry-run'])).toEqual({ apply: false })
    expect(parsePermissionServiceSeedArgs(['--apply'])).toEqual({ apply: true })
  })

  it('builds an auditable execution plan from the consolidated seed', () => {
    const seed = buildPermissionServiceSeed()

    expect(buildPermissionServiceSeedExecutionPlan(seed, { apply: false })).toEqual({
      mode: 'dry-run',
      writesDatabase: false,
      summary: renderPermissionServiceSeedDryRunSummary(seed),
      validationErrors: []
    })
    expect(buildPermissionServiceSeedExecutionPlan(seed, { apply: true })).toMatchObject({
      mode: 'apply',
      writesDatabase: true,
      validationErrors: []
    })
  })

  it('replaces seed-owned role navigation rows instead of leaving stale visibility behind', async () => {
    const seed = buildPermissionServiceSeed()
    const calls: string[] = []
    const permissionIdByCode = new Map(
      seed.permissionCodes.map((permission) => [permission.code, `perm:${permission.code}`])
    )
    const prisma = {
      permission: {
        upsert: jest.fn(async ({ create }: any) => ({
          id: permissionIdByCode.get(create.code),
          code: create.code
        }))
      },
      role: {
        upsert: jest.fn(async () => ({})),
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({}))
      },
      rolePermission: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({})),
        createMany: jest.fn(async () => ({}))
      },
      navigationEntry: {
        upsert: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({}))
      },
      roleNavigationVisibility: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => {
          calls.push('roleNavigationVisibility.deleteMany')
          return {}
        }),
        createMany: jest.fn(async () => {
          calls.push('roleNavigationVisibility.createMany')
          return {}
        }),
        updateMany: jest.fn(async () => ({}))
      },
      roleLandingPolicy: {
        deleteMany: jest.fn(async () => {
          calls.push('roleLandingPolicy.deleteMany')
          return {}
        }),
        findMany: jest.fn(async () => []),
        createMany: jest.fn(async () => {
          calls.push('roleLandingPolicy.createMany')
          return {}
        }),
        updateMany: jest.fn(async () => ({}))
      },
      roleTerminalAccess: {
        upsert: jest.fn(async () => ({}))
      },
      policyInstance: {
        deleteMany: jest.fn(async () => ({})),
        createMany: jest.fn(async () => ({}))
      }
    }

    await applyPermissionServiceSeed(prisma as any, seed)

    expect(prisma.permission.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          id: deterministicPermissionSeedId(seed.permissionCodes[0].code)
        })
      })
    )

    expect(prisma.roleNavigationVisibility.deleteMany).toHaveBeenCalledWith({
      where: { roleId: { in: seed.roles.map((role) => role.id) } }
    })
    expect(prisma.roleLandingPolicy.deleteMany).toHaveBeenCalledWith({
      where: { roleId: { in: seed.roles.map((role) => role.id) } }
    })
    expect(calls.indexOf('roleNavigationVisibility.deleteMany')).toBeLessThan(
      calls.indexOf('roleNavigationVisibility.createMany')
    )
    expect(calls.indexOf('roleLandingPolicy.deleteMany')).toBeLessThan(
      calls.indexOf('roleLandingPolicy.createMany')
    )
    expect(prisma.policyInstance.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: seed.policyInstances.map((policy) => policy.id) } }
    })
    expect(prisma.policyInstance.createMany).not.toHaveBeenCalled()
  })

  it('upserts authoritative INTERNAL metadata and never includes it in a role binding', async () => {
    const seed = buildPermissionServiceSeed()
    const internal = seed.permissionCodes.find(
      (item) => item.code === 'auth.internal.external_api_key.verifier_version.compromise'
    )!
    const prisma = {
      permission: {
        upsert: jest.fn(async ({ create }: any) => ({
          id: `perm:${create.code}`,
          code: create.code
        }))
      },
      role: {
        upsert: jest.fn(async () => ({})),
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({}))
      },
      rolePermission: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({})),
        createMany: jest.fn(async () => ({}))
      },
      navigationEntry: { upsert: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({})) },
      roleNavigationVisibility: {
        findMany: jest.fn(async () => []),
        deleteMany: jest.fn(async () => ({})),
        createMany: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({}))
      },
      roleLandingPolicy: {
        deleteMany: jest.fn(async () => ({})),
        findMany: jest.fn(async () => []),
        createMany: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({}))
      },
      roleTerminalAccess: { upsert: jest.fn(async () => ({})) },
      policyInstance: {
        deleteMany: jest.fn(async () => ({})),
        createMany: jest.fn(async () => ({}))
      }
    }

    await applyPermissionServiceSeed(prisma as any, seed)

    expect(prisma.permission.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          code: internal.code,
          kind: 'INTERNAL',
          externalApiEligible: false
        }),
        update: expect.objectContaining({ kind: 'INTERNAL', externalApiEligible: false })
      })
    )
    expect(JSON.stringify(prisma.rolePermission.createMany.mock.calls)).not.toContain(internal.code)
  })

  it('backfills built-in tenant role instance navigation during seed apply', async () => {
    const seed = buildPermissionServiceSeed()
    let rolePermissionSequence = 0
    let rolePermissionRows: Array<{ id: string; permissionId: string; roleId: string }> = []
    const permissionIdByCode = new Map(
      seed.permissionCodes.map((permission) => [permission.code, `perm:${permission.code}`])
    )
    const prisma = {
      permission: {
        upsert: jest.fn(async ({ create }: any) => ({
          id: permissionIdByCode.get(create.code),
          code: create.code
        }))
      },
      role: {
        upsert: jest.fn(async () => ({})),
        findMany: jest.fn(async (args: any) =>
          args.where.OR?.some(
            (item: { code?: string }) => item.code === 'item_master.product_data_manager'
          )
            ? [
                {
                  code: 'item_master.product_data_manager',
                  id: 'item-role-1',
                  kind: 'TENANT_INSTANCE',
                  templateRoleId: null
                }
              ]
            : []
        ),
        updateMany: jest.fn(async () => ({}))
      },
      rolePermission: {
        deleteMany: jest.fn(async () => ({})),
        findMany: jest.fn(async (args: any) => {
          if (args.where.id?.in) {
            return rolePermissionRows.filter((row) => args.where.id.in.includes(row.id))
          }
          if (args.where.roleId?.in && args.where.permissionId?.in) {
            return rolePermissionRows.filter(
              (row) =>
                args.where.roleId.in.includes(row.roleId) &&
                args.where.permissionId.in.includes(row.permissionId)
            )
          }
          return []
        }),
        createMany: jest.fn(async ({ data }: any) => {
          const rows = data.map((row: any) => ({
            ...row,
            id: row.id ?? `template-role-permission-${(rolePermissionSequence += 1)}`
          }))
          rolePermissionRows = [...rolePermissionRows, ...rows]
          return { count: rows.length }
        })
      },
      navigationEntry: {
        upsert: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({}))
      },
      roleNavigationVisibility: {
        deleteMany: jest.fn(async () => ({})),
        findMany: jest.fn(async () => [
          {
            entryKey: 'master-data.item-management',
            roleId: 'item-role-1',
            terminal: 'DEFAULT'
          }
        ]),
        createMany: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({}))
      },
      roleLandingPolicy: {
        deleteMany: jest.fn(async () => ({})),
        findMany: jest.fn(async () => [
          {
            defaultEntryKey: 'workbench.home',
            roleId: 'item-role-1',
            terminal: 'DEFAULT'
          }
        ]),
        createMany: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({}))
      },
      roleTerminalAccess: {
        upsert: jest.fn(async () => ({}))
      },
      policyInstance: {
        deleteMany: jest.fn(async () => ({})),
        createMany: jest.fn(async () => ({}))
      }
    }

    await applyPermissionServiceSeed(prisma as any, seed)

    expect(prisma.roleNavigationVisibility.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          entryKey: 'master-data.item-bom-management',
          roleId: 'item-role-1',
          terminal: 'DEFAULT'
        })
      ]),
      skipDuplicates: true
    })
  })
})

import { PrismaClient, RoleKind } from '../../prisma/generated/prisma'
import {
  buildNavigationFoundationLandingSeeds,
  buildNavigationFoundationVisibilitySeeds
} from './navigation-foundation'
import { BUILT_IN_ROLE_TEMPLATES } from './role-foundation'
import { deterministicSeedId } from './deterministic-seed-id'

type PermissionCodeMap = ReadonlyMap<string, string>

export type RoleInstanceBaselineRollbackResult = {
  deletedCount: number
  deletedRolePermissionIds: string[]
  identityMismatchIds: string[]
  missingPermissionCodes: string[]
  mode: 'apply' | 'dry-run'
  requestedPermissionCodes: string[]
  seedOwnedMatchCount: number
  unmatchedPermissionCodes: string[]
}

/** Builds a stable identifier that marks a role-permission edge created by managed baseline backfill. */
export function deterministicRoleInstanceBaselinePermissionId(
  roleId: string,
  permissionCode: string
): string {
  return deterministicSeedId(
    `oes.role-instance-baseline:permission-code:${roleId}:${permissionCode}`
  )
}

type ManagedRoleIdentity = {
  code: string
  id: string
  kind: RoleKind
  templateRoleId: string | null
}

type SeedOwnedRolePermissionEdge = {
  id: string
  permissionCode: string
  permissionId: string
  roleId: string
}

/** Returns whether a current role identity is still managed by a template that owns the permission. */
function isManagedRoleIdentityForPermission(
  role: ManagedRoleIdentity,
  permissionCode: string
): boolean {
  return BUILT_IN_ROLE_TEMPLATES.some(
    (template) =>
      template.permissionCodes.includes(permissionCode) &&
      (role.code === template.code || role.templateRoleId === template.id)
  )
}

// Ensures built-in role instances keep the minimum baseline permissions and navigation defined by their managed templates.
export async function syncBuiltInRoleInstanceBaselines(
  prisma: Pick<
    PrismaClient,
    'role' | 'roleLandingPolicy' | 'roleNavigationVisibility' | 'rolePermission'
  >,
  permissionIdByCode: PermissionCodeMap
): Promise<number> {
  let createdCount = 0

  for (const template of BUILT_IN_ROLE_TEMPLATES) {
    const baselinePermissions = template.permissionCodes
      .map((code) => ({ code, id: permissionIdByCode.get(code) }))
      .filter((permission): permission is { code: string; id: string } => Boolean(permission.id))
    const baselinePermissionIds = baselinePermissions.map((permission) => permission.id)

    if (baselinePermissionIds.length === 0) {
      continue
    }

    const managedInstances = await prisma.role.findMany({
      where: {
        kind: {
          in: [RoleKind.SYSTEM_INSTANCE, RoleKind.TENANT_INSTANCE]
        },
        OR: [{ code: template.code }, { templateRoleId: template.id }]
      },
      select: {
        code: true,
        id: true,
        kind: true,
        templateRoleId: true
      }
    })

    if (managedInstances.length === 0) {
      continue
    }

    const roleIds = managedInstances.map((role) => role.id)
    await prisma.role.updateMany({
      where: {
        id: {
          in: roleIds
        }
      },
      data: {
        allowTenantPermissionOverride: template.allowTenantPermissionOverride,
        isProtected: template.isProtected
      } as any
    })

    if (baselinePermissionIds.length > 0) {
      const existingPermissions = await prisma.rolePermission.findMany({
        where: {
          roleId: { in: roleIds },
          permissionId: { in: baselinePermissionIds }
        },
        select: {
          roleId: true,
          permissionId: true
        }
      })

      const existingPairs = new Set(
        existingPermissions.map((item) => `${item.roleId}:${item.permissionId}`)
      )
      const missingPairs = roleIds.flatMap((roleId) =>
        baselinePermissions
          .filter((permission) => !existingPairs.has(`${roleId}:${permission.id}`))
          .map((permission) => ({
            id: deterministicRoleInstanceBaselinePermissionId(roleId, permission.code),
            permissionCode: permission.code,
            permissionId: permission.id,
            roleId
          }))
      )

      if (missingPairs.length > 0) {
        const occupiedIds = await prisma.rolePermission.findMany({
          where: { id: { in: missingPairs.map((pair) => pair.id) } },
          select: { id: true, permissionId: true, roleId: true }
        })
        if (occupiedIds.length > 0) {
          throw new Error(
            `Role-instance baseline deterministic ids are already occupied: ${occupiedIds
              .map((edge) => edge.id)
              .sort()
              .join(',')}`
          )
        }

        const inserted = await prisma.rolePermission.createMany({
          data: missingPairs.map(({ id, permissionId, roleId }) => ({
            id,
            roleId,
            permissionId
          }))
        })
        if (inserted.count !== missingPairs.length) {
          throw new Error(
            `Role-instance baseline insert count mismatch: expected=${missingPairs.length} actual=${inserted.count}`
          )
        }

        const persisted = await prisma.rolePermission.findMany({
          where: { id: { in: missingPairs.map((pair) => pair.id) } },
          select: { id: true, permissionId: true, roleId: true }
        })
        const persistedById = new Map(persisted.map((edge) => [edge.id, edge]))
        const unverifiedIds = missingPairs
          .filter((expected) => {
            const edge = persistedById.get(expected.id)
            return edge?.permissionId !== expected.permissionId || edge.roleId !== expected.roleId
          })
          .map((edge) => edge.id)
          .sort()
        if (persisted.length !== missingPairs.length || unverifiedIds.length > 0) {
          throw new Error(
            `Role-instance baseline inserted edge verification failed: ${unverifiedIds.join(',')}`
          )
        }
        createdCount += inserted.count
      }
    }

    const templateVisibility = buildNavigationFoundationVisibilitySeeds([template])
    await backfillRoleNavigationVisibility(prisma, managedInstances, templateVisibility)
    await backfillRoleLandingPolicies(prisma, managedInstances, template)
  }

  return createdCount
}

/** Removes only baseline role-permission edges whose deterministic ids prove seed ownership. */
export async function rollbackBuiltInRoleInstanceBaselinePermissions(
  prisma: Pick<PrismaClient, 'permission' | 'role' | 'rolePermission'>,
  permissionCodes: readonly string[],
  apply = false
): Promise<RoleInstanceBaselineRollbackResult> {
  const requestedPermissionCodes = [...new Set(permissionCodes)].sort()
  const matchedPermissionCodes = new Set(
    BUILT_IN_ROLE_TEMPLATES.flatMap((template) => template.permissionCodes).filter((code) =>
      requestedPermissionCodes.includes(code)
    )
  )
  const roles =
    requestedPermissionCodes.length === 0
      ? []
      : ((await prisma.role.findMany({
          select: { code: true, id: true, kind: true, templateRoleId: true }
        })) as ManagedRoleIdentity[])
  const expectedCoordinates = roles.flatMap((role) =>
    requestedPermissionCodes.map((permissionCode) => ({
      id: deterministicRoleInstanceBaselinePermissionId(role.id, permissionCode),
      permissionCode,
      roleId: role.id
    }))
  )
  const coordinateById = new Map<string, (typeof expectedCoordinates)[number]>()
  for (const coordinate of expectedCoordinates) {
    const previous = coordinateById.get(coordinate.id)
    if (
      previous &&
      (previous.permissionCode !== coordinate.permissionCode || previous.roleId !== coordinate.roleId)
    ) {
      throw new Error(`Role-instance baseline deterministic id collision: ${coordinate.id}`)
    }
    coordinateById.set(coordinate.id, coordinate)
  }
  const existingEdges =
    expectedCoordinates.length === 0
      ? []
      : await prisma.rolePermission.findMany({
          where: { id: { in: expectedCoordinates.map((edge) => edge.id) } },
          select: { id: true, permissionId: true, roleId: true }
        })
  const candidatePermissionIds = [...new Set(existingEdges.map((edge) => edge.permissionId))]
  const permissions = await prisma.permission.findMany({
    where: {
      OR: [
        { code: { in: requestedPermissionCodes } },
        { id: { in: candidatePermissionIds } }
      ]
    },
    select: { code: true, id: true }
  })
  const permissionByCode = new Map(permissions.map((item) => [item.code, item.id]))
  const permissionById = new Map(permissions.map((item) => [item.id, item.code]))
  const roleById = new Map(roles.map((role) => [role.id, role]))
  const seedOwnedEdges: SeedOwnedRolePermissionEdge[] = []
  const identityMismatchIds: string[] = []

  for (const edge of existingEdges) {
    const coordinate = coordinateById.get(edge.id)
    const role = coordinate ? roleById.get(coordinate.roleId) : undefined
    const permissionCode = coordinate?.permissionCode
    if (
      !coordinate ||
      !role ||
      edge.roleId !== coordinate.roleId ||
      !permissionCode ||
      !isManagedRoleIdentityForPermission(role, permissionCode) ||
      permissionByCode.get(permissionCode) !== edge.permissionId ||
      permissionById.get(edge.permissionId) !== permissionCode
    ) {
      identityMismatchIds.push(edge.id)
      continue
    }
    seedOwnedEdges.push({
      id: edge.id,
      permissionCode,
      permissionId: edge.permissionId,
      roleId: edge.roleId
    })
  }

  identityMismatchIds.sort()
  const missingPermissionCodes = requestedPermissionCodes.filter(
    (code) => !permissionByCode.has(code)
  )
  const unmatchedPermissionCodes = requestedPermissionCodes.filter(
    (code) => !matchedPermissionCodes.has(code)
  )

  let deletedCount = 0
  if (
    apply &&
    (missingPermissionCodes.length > 0 ||
      unmatchedPermissionCodes.length > 0 ||
      identityMismatchIds.length > 0)
  ) {
    throw new Error('Role-instance baseline rollback identity checks failed')
  }
  if (apply && seedOwnedEdges.length > 0) {
    const deleted = await prisma.rolePermission.deleteMany({
      where: {
        OR: seedOwnedEdges.map((edge) => ({
          id: edge.id,
          permissionId: edge.permissionId,
          roleId: edge.roleId,
          permission: { is: { code: edge.permissionCode } },
          role: {
            is: {
              kind: { in: [RoleKind.SYSTEM_INSTANCE, RoleKind.TENANT_INSTANCE] },
              OR: BUILT_IN_ROLE_TEMPLATES.filter((template) =>
                template.permissionCodes.includes(edge.permissionCode)
              ).flatMap((template) => [
                { code: template.code },
                { templateRoleId: template.id }
              ])
            }
          }
        }))
      }
    })
    deletedCount = deleted.count
    if (deletedCount !== seedOwnedEdges.length) {
      throw new Error(
        `Role-instance baseline rollback delete count mismatch: expected=${seedOwnedEdges.length} actual=${deletedCount}`
      )
    }
    const residue = await prisma.rolePermission.findMany({
      where: { id: { in: seedOwnedEdges.map((edge) => edge.id) } },
      select: { id: true, permissionId: true, roleId: true }
    })
    if (residue.length > 0) {
      throw new Error(
        `Role-instance baseline rollback residue detected: ${residue
          .map((edge) => edge.id)
          .sort()
          .join(',')}`
      )
    }
  }

  return {
    deletedCount,
    deletedRolePermissionIds: seedOwnedEdges.map((edge) => edge.id).sort(),
    identityMismatchIds,
    missingPermissionCodes,
    mode: apply ? 'apply' : 'dry-run',
    requestedPermissionCodes,
    seedOwnedMatchCount: seedOwnedEdges.length,
    unmatchedPermissionCodes
  }
}

/** backfillRoleNavigationVisibility adds template baseline navigation entries without deleting tenant custom entries. */
async function backfillRoleNavigationVisibility(
  prisma: Pick<PrismaClient, 'roleNavigationVisibility'>,
  managedInstances: Array<{ id: string; kind: RoleKind }>,
  templateVisibility: ReturnType<typeof buildNavigationFoundationVisibilitySeeds>
): Promise<void> {
  if (managedInstances.length === 0 || templateVisibility.length === 0) {
    return
  }

  const roleIds = managedInstances.map((role) => role.id)
  const existingVisibility = await prisma.roleNavigationVisibility.findMany({
    where: {
      roleId: { in: roleIds },
      entryKey: { in: templateVisibility.map((item) => item.entryKey) },
      terminal: { in: templateVisibility.map((item) => item.terminal) }
    },
    select: {
      roleId: true,
      entryKey: true,
      terminal: true
    }
  })
  const existingKeys = new Set(
    existingVisibility.map((item) => `${item.roleId}:${item.terminal}:${item.entryKey}`)
  )
  const missingVisibility = managedInstances.flatMap((role) =>
    templateVisibility
      .filter((item) => !existingKeys.has(`${role.id}:${item.terminal}:${item.entryKey}`))
      .map((item) => ({
        roleId: role.id,
        entryKey: item.entryKey,
        terminal: item.terminal,
        enabled: item.enabled
      }))
  )

  if (missingVisibility.length > 0) {
    await prisma.roleNavigationVisibility.createMany({
      data: missingVisibility,
      skipDuplicates: true
    })
  }
}

/** backfillRoleLandingPolicies adds missing default-entry policies for managed role instances. */
async function backfillRoleLandingPolicies(
  prisma: Pick<PrismaClient, 'roleLandingPolicy'>,
  managedInstances: Array<{ id: string; kind: RoleKind }>,
  template: (typeof BUILT_IN_ROLE_TEMPLATES)[number]
): Promise<void> {
  if (managedInstances.length === 0) {
    return
  }

  const roleLandingPolicies = managedInstances.flatMap((role) =>
    buildNavigationFoundationLandingSeeds([
      {
        code: template.code,
        id: role.id,
        kind: role.kind
      }
    ])
  )
  const existingLandingPolicies = await prisma.roleLandingPolicy.findMany({
    where: {
      roleId: { in: managedInstances.map((role) => role.id) },
      terminal: { in: roleLandingPolicies.map((item) => item.terminal) },
      defaultEntryKey: { in: roleLandingPolicies.map((item) => item.defaultEntryKey) }
    },
    select: {
      roleId: true,
      terminal: true,
      defaultEntryKey: true
    }
  })
  const existingKeys = new Set(
    existingLandingPolicies.map((item) => `${item.roleId}:${item.terminal}:${item.defaultEntryKey}`)
  )
  const missingLandingPolicies = roleLandingPolicies.filter(
    (item) => !existingKeys.has(`${item.roleId}:${item.terminal}:${item.defaultEntryKey}`)
  )

  if (missingLandingPolicies.length > 0) {
    await prisma.roleLandingPolicy.createMany({
      data: missingLandingPolicies,
      skipDuplicates: true
    })
  }
}

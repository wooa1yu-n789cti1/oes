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
  permissionId: string
): string {
  return deterministicSeedId(`oes.role-instance-baseline:${roleId}:${permissionId}`)
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
    const baselinePermissionIds = template.permissionCodes
      .map((code) => permissionIdByCode.get(code))
      .filter((permissionId): permissionId is string => Boolean(permissionId))

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
        id: true,
        kind: true
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
        baselinePermissionIds
          .filter((permissionId) => !existingPairs.has(`${roleId}:${permissionId}`))
          .map((permissionId) => ({
            id: deterministicRoleInstanceBaselinePermissionId(roleId, permissionId),
            roleId,
            permissionId
          }))
      )

      if (missingPairs.length > 0) {
        await prisma.rolePermission.createMany({
          data: missingPairs,
          skipDuplicates: true
        })
        createdCount += missingPairs.length
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
  const permissions =
    requestedPermissionCodes.length === 0
      ? []
      : await prisma.permission.findMany({
          where: { code: { in: requestedPermissionCodes } },
          select: { code: true, id: true }
        })
  const permissionByCode = new Map(permissions.map((item) => [item.code, item.id]))
  const expectedEdges: Array<{ id: string; permissionId: string; roleId: string }> = []
  const matchedPermissionCodes = new Set<string>()

  for (const template of BUILT_IN_ROLE_TEMPLATES) {
    const matchedCodes = template.permissionCodes.filter(
      (code) => requestedPermissionCodes.includes(code) && permissionByCode.has(code)
    )
    matchedCodes.forEach((code) => matchedPermissionCodes.add(code))
    const permissionIds = matchedCodes
      .map((code) => permissionByCode.get(code))
      .filter((permissionId): permissionId is string => Boolean(permissionId))

    if (permissionIds.length === 0) {
      continue
    }

    const managedInstances = await prisma.role.findMany({
      where: {
        kind: { in: [RoleKind.SYSTEM_INSTANCE, RoleKind.TENANT_INSTANCE] },
        OR: [{ code: template.code }, { templateRoleId: template.id }]
      },
      select: { id: true }
    })

    for (const role of managedInstances) {
      for (const permissionId of permissionIds) {
        expectedEdges.push({
          id: deterministicRoleInstanceBaselinePermissionId(role.id, permissionId),
          permissionId,
          roleId: role.id
        })
      }
    }
  }

  const existingEdges =
    expectedEdges.length === 0
      ? []
      : await prisma.rolePermission.findMany({
          where: { id: { in: expectedEdges.map((edge) => edge.id) } },
          select: { id: true, permissionId: true, roleId: true }
        })
  const expectedById = new Map(expectedEdges.map((edge) => [edge.id, edge]))
  const seedOwnedEdges = existingEdges.filter((edge) => {
    const expected = expectedById.get(edge.id)
    return expected?.permissionId === edge.permissionId && expected.roleId === edge.roleId
  })
  const identityMismatchIds = existingEdges
    .filter((edge) => !seedOwnedEdges.some((seedOwnedEdge) => seedOwnedEdge.id === edge.id))
    .map((edge) => edge.id)
    .sort()
  const missingPermissionCodes = requestedPermissionCodes.filter(
    (code) => !permissionByCode.has(code)
  )
  const unmatchedPermissionCodes = requestedPermissionCodes.filter(
    (code) => permissionByCode.has(code) && !matchedPermissionCodes.has(code)
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
          roleId: edge.roleId
        }))
      }
    })
    deletedCount = deleted.count
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

import { Prisma, PrismaClient } from '../../prisma/generated/prisma'
import {
  PermissionServiceSeed,
  PermissionServiceSeedDryRunSummary,
  buildPermissionServiceSeed,
  renderPermissionServiceSeedDryRunSummary,
  validatePermissionServiceSeed
} from './permission-service-seed'
import { PolicyTemplateInstanceMapper } from '../infrastructure/mappers/policy-template-instance.mapper'
import { deterministicSeedId } from './deterministic-seed-id'
import { syncBuiltInRoleInstanceBaselines } from './role-instance-foundation'

export type PermissionServiceSeedWriterOptions = {
  apply: boolean
}

export type PermissionServiceSeedExecutionPlan = {
  mode: 'apply' | 'dry-run'
  summary: PermissionServiceSeedDryRunSummary
  validationErrors: string[]
  writesDatabase: boolean
}

/** Builds a stable RFC-4122-shaped identifier for one canonical permission code. */
export function deterministicPermissionSeedId(code: string): string {
  return deterministicSeedId(`oes.permission.seed:${code}`)
}

/** parsePermissionServiceSeedArgs keeps seed writes opt-in through an explicit --apply flag. */
export function parsePermissionServiceSeedArgs(args: string[]): PermissionServiceSeedWriterOptions {
  return {
    apply: args.includes('--apply')
  }
}

/** buildPermissionServiceSeedExecutionPlan renders an auditable plan before any optional DB writes. */
export function buildPermissionServiceSeedExecutionPlan(
  seed: PermissionServiceSeed,
  options: PermissionServiceSeedWriterOptions
): PermissionServiceSeedExecutionPlan {
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    writesDatabase: options.apply,
    summary: renderPermissionServiceSeedDryRunSummary(seed),
    validationErrors: validatePermissionServiceSeed(seed)
  }
}

/** applyPermissionServiceSeed writes permission-service-owned foundation data into its own database. */
export async function applyPermissionServiceSeed(
  prisma: PrismaClient,
  seed: PermissionServiceSeed
): Promise<PermissionServiceSeedDryRunSummary> {
  const permissionIdByCode = new Map<string, string>()
  const permissionByCode = new Map(seed.permissionCodes.map((item) => [item.code, item]))

  for (const item of seed.permissionCodes) {
    const permission = await prisma.permission.upsert({
      where: { code: item.code },
      create: {
        id: deterministicPermissionSeedId(item.code),
        code: item.code,
        module: item.module,
        description: item.description,
        kind: item.kind,
        externalApiEligible: item.externalApiEligible,
        allowedScopeLevels: item.allowedScopeLevels,
        definitionFingerprint: item.definitionFingerprint
      },
      update: {
        module: item.module,
        description: item.description,
        kind: item.kind,
        externalApiEligible: item.externalApiEligible,
        allowedScopeLevels: item.allowedScopeLevels,
        definitionFingerprint: item.definitionFingerprint
      }
    })
    permissionIdByCode.set(permission.code, permission.id)
  }

  for (const roleSeed of seed.roles) {
    await prisma.role.upsert({
      where: {
        scopeKey_kind_code: {
          scopeKey: roleSeed.scopeKey,
          kind: roleSeed.kind,
          code: roleSeed.code
        }
      },
      create: {
        id: roleSeed.id,
        tenantId: roleSeed.tenantId,
        scopeKey: roleSeed.scopeKey,
        code: roleSeed.code,
        name: roleSeed.name,
        kind: roleSeed.kind,
        templateRoleId: null,
        allowTenantPermissionOverride: roleSeed.allowTenantPermissionOverride,
        isProtected: roleSeed.isProtected,
        isEnabled: roleSeed.isEnabled,
        description: roleSeed.description
      } as any,
      update: {
        tenantId: roleSeed.tenantId,
        scopeKey: roleSeed.scopeKey,
        name: roleSeed.name,
        kind: roleSeed.kind,
        templateRoleId: null,
        allowTenantPermissionOverride: roleSeed.allowTenantPermissionOverride,
        isProtected: roleSeed.isProtected,
        isEnabled: roleSeed.isEnabled,
        description: roleSeed.description
      } as any
    })
  }

  for (const roleSeed of seed.roles) {
    const permissionIds = roleSeed.permissionCodes
      .filter((permissionCode) => permissionByCode.get(permissionCode)?.kind !== 'INTERNAL')
      .map((permissionCode) => permissionIdByCode.get(permissionCode))
      .filter((permissionId): permissionId is string => Boolean(permissionId))

    await prisma.rolePermission.deleteMany({
      where: {
        roleId: roleSeed.id,
        ...(permissionIds.length > 0 ? { permissionId: { notIn: permissionIds } } : {})
      }
    })

    if (permissionIds.length > 0) {
      await prisma.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({
          roleId: roleSeed.id,
          permissionId
        })),
        skipDuplicates: true
      })
    }
  }

  for (const entry of seed.navigationEntries) {
    await prisma.navigationEntry.upsert({
      where: { entryKey: entry.entryKey },
      create: entry,
      update: entry
    })
  }

  if (seed.deprecatedNavigationEntryKeys.length > 0) {
    await prisma.navigationEntry.updateMany({
      where: {
        enabled: true,
        entryKey: { in: [...seed.deprecatedNavigationEntryKeys] }
      },
      data: { enabled: false }
    })
    await prisma.roleNavigationVisibility.updateMany({
      where: {
        enabled: true,
        entryKey: { in: [...seed.deprecatedNavigationEntryKeys] }
      },
      data: { enabled: false }
    })
    await prisma.roleLandingPolicy.updateMany({
      where: {
        enabled: true,
        defaultEntryKey: { in: [...seed.deprecatedNavigationEntryKeys] }
      },
      data: { enabled: false }
    })
  }

  const roleIds = new Set(seed.roles.map((role) => role.id))
  const roleIdList = [...roleIds]
  await prisma.roleNavigationVisibility.deleteMany({
    where: {
      roleId: { in: roleIdList }
    }
  })
  await prisma.roleNavigationVisibility.createMany({
    data: seed.roleNavigationVisibility.filter((item) => roleIds.has(item.roleId)),
    skipDuplicates: true
  })

  await prisma.roleLandingPolicy.deleteMany({
    where: {
      roleId: { in: roleIdList }
    }
  })
  if (seed.roleLandingPolicies.length > 0) {
    await prisma.roleLandingPolicy.createMany({
      data: seed.roleLandingPolicies.filter((item) => roleIds.has(item.roleId)),
      skipDuplicates: true
    })
  }

  await syncBuiltInRoleInstanceBaselines(prisma, permissionIdByCode)

  for (const roleTerminalAccess of seed.roleTerminalAccess) {
    await prisma.roleTerminalAccess.upsert({
      where: { roleId: roleTerminalAccess.roleId },
      create: {
        roleId: roleTerminalAccess.roleId,
        allowedTerminals: roleTerminalAccess.allowedTerminals
      },
      update: {
        allowedTerminals: roleTerminalAccess.allowedTerminals
      }
    })
  }

  const policyInstanceIds = seed.policyInstances.map((policyInstance) => policyInstance.id)
  await prisma.policyInstance.deleteMany({
    where: {
      id: { in: policyInstanceIds }
    }
  })
  if (seed.policyInstances.length > 0) {
    await prisma.policyInstance.createMany({
      data: seed.policyInstances.map((policyInstance) => {
        const data = PolicyTemplateInstanceMapper.toPersistent(policyInstance)
        return {
          ...data,
          params: data.params as Prisma.InputJsonValue
        }
      }),
      skipDuplicates: true
    })
  }

  return renderPermissionServiceSeedDryRunSummary(seed)
}

/** main executes a safe-by-default permission-service seed writer CLI. */
async function main(): Promise<void> {
  const options = parsePermissionServiceSeedArgs(process.argv.slice(2))
  const seed = buildPermissionServiceSeed()
  const plan = buildPermissionServiceSeedExecutionPlan(seed, options)

  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)

  if (plan.validationErrors.length > 0) {
    process.exitCode = 1
    return
  }

  if (!options.apply) {
    return
  }

  const prisma = new PrismaClient()
  try {
    await applyPermissionServiceSeed(prisma, seed)
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  })
}

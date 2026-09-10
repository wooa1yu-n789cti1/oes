import { PrismaClient } from '../../prisma/generated/prisma'
import { rollbackBuiltInRoleInstanceBaselinePermissions } from './role-instance-foundation'

export type RoleInstanceFoundationRollbackOptions = {
  apply: boolean
  permissionCodes: string[]
}

/** Parses an opt-in rollback command with one or more explicitly named permission codes. */
export function parseRoleInstanceFoundationRollbackArgs(
  args: readonly string[]
): RoleInstanceFoundationRollbackOptions {
  const permissionCodes: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--permission-code') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--permission-code requires a value')
      }
      permissionCodes.push(value)
      index += 1
      continue
    }
    if (argument.startsWith('--permission-code=')) {
      const value = argument.slice('--permission-code='.length)
      if (!value) {
        throw new Error('--permission-code requires a value')
      }
      permissionCodes.push(value)
      continue
    }
    if (argument !== '--apply' && argument !== '--') {
      throw new Error(`Unsupported argument: ${argument}`)
    }
  }

  const uniquePermissionCodes = [...new Set(permissionCodes)].sort()
  if (uniquePermissionCodes.length === 0) {
    throw new Error('At least one --permission-code is required')
  }

  return {
    apply: args.includes('--apply'),
    permissionCodes: uniquePermissionCodes
  }
}

/** Executes a dry-run by default and applies exact seed-owned edge deletion only with --apply. */
async function main(): Promise<void> {
  const options = parseRoleInstanceFoundationRollbackArgs(process.argv.slice(2))
  const prisma = new PrismaClient()

  try {
    const result = await prisma.$transaction((transaction) =>
      rollbackBuiltInRoleInstanceBaselinePermissions(
        transaction,
        options.permissionCodes,
        options.apply
      )
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

    if (
      result.missingPermissionCodes.length > 0 ||
      result.unmatchedPermissionCodes.length > 0 ||
      result.identityMismatchIds.length > 0
    ) {
      process.exitCode = 1
    }
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

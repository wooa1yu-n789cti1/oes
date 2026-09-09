#!/usr/bin/env node

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { verifySystemAdminSeedRuntimeBinding } from '../local-runtime/src/bootstrap.mjs'

const require = createRequire(import.meta.url)

const DEFAULT_DATABASE_URLS = {
  identityService: 'postgres://imkgsam:imkgsam@localhost:5432/identitydb',
  authService: 'postgres://imkgsam:imkgsam@localhost:5432/authdb',
  permissionService: 'postgres://imkgsam:imkgsam@localhost:5432/permissiondb'
}

const DATABASE_TARGETS = {
  identityService: {
    envKeys: ['OES_IDENTITY_DATABASE_URL', 'IDENTITY_DATABASE_URL'],
    expectedDatabase: 'identitydb',
    label: 'identity-service'
  },
  authService: {
    envKeys: ['OES_AUTH_DATABASE_URL', 'AUTH_DATABASE_URL'],
    expectedDatabase: 'authdb',
    label: 'auth-service'
  },
  permissionService: {
    envKeys: ['OES_PERMISSION_DATABASE_URL', 'PERMISSION_DATABASE_URL'],
    expectedDatabase: 'permissiondb',
    label: 'permission-service'
  }
}

const SERVICE_ORDER = [
  'identity-service',
  'auth-service',
  'permission-service'
]

export const SYSTEM_ADMIN_SEED = {
  identity: {
    username: 'sysadmin',
    email: 'sysadmin@oes.local',
    phone: null,
    accountDisplayName: 'tth',
    accountScopeLevel: 'SYSTEM',
    accountContextKey: 'SYSTEM'
  },
  auth: {
    loginMethodType: 'EMAIL',
    verified: true,
    enabled: true,
    createsPasswordCredential: false
  },
  permission: {
    roleCode: 'system.admin',
    roleKind: 'SYSTEM_INSTANCE',
    roleScopeKey: '__SYSTEM__',
    accountType: 'USER',
    scopeLevel: 'SYSTEM',
    tenantId: null
  }
}

/** parseSystemAdminSeedArgs keeps system-admin writes opt-in through an explicit --apply flag. */
export function parseSystemAdminSeedArgs(args) {
  const options = {
    apply: args.includes('--apply'),
    validate: args.includes('--validate'),
    help: args.includes('--help') || args.includes('-h')
  }
  if (options.apply && options.validate) throw new Error('SYSTEM_ADMIN_SEED_MODE_CONFLICT')
  return options
}

/** buildSystemAdminSeedConfig resolves local database targets and static seed values without opening connections. */
export function buildSystemAdminSeedConfig(env = process.env) {
  const manifestPath = env.OES_RUNTIME_MANIFEST?.trim()
  const serializedBinding = env.OES_SYSTEM_ADMIN_SEED_BINDING?.trim()
  if (Boolean(manifestPath) !== Boolean(serializedBinding)) throw new Error('SYSTEM_ADMIN_SEED_MANIFEST_BINDING_REQUIRED')
  const runtime = manifestPath
    ? verifySystemAdminSeedRuntimeBinding(manifestPath, serializedBinding, env)
    : null
  const databaseUrls = runtime?.databaseUrls || Object.fromEntries(
    Object.entries(DATABASE_TARGETS).map(([key, target]) => [
      key,
      target.envKeys.map((envKey) => env[envKey]).find(Boolean) ?? DEFAULT_DATABASE_URLS[key]
    ])
  )

  return {
    databaseUrls,
    runtimeBinding: runtime?.binding || null,
    seed: {
      ...SYSTEM_ADMIN_SEED,
      identity: {
        ...SYSTEM_ADMIN_SEED.identity,
        email: normalizeEmail(SYSTEM_ADMIN_SEED.identity.email)
      }
    }
  }
}

/** buildSystemAdminSeedExecutionPlan renders the exact dry-run/apply target plan before any optional writes. */
export function buildSystemAdminSeedExecutionPlan(config, options) {
  return {
    mode: options.validate ? 'validate' : options.apply ? 'apply' : 'dry-run',
    writesDatabase: Boolean(options.apply),
    authority: config.runtimeBinding
      ? {
          mode: 'launcher-manifest',
          manifest: config.runtimeBinding.manifest,
          taskKey: config.runtimeBinding.taskKey,
          runId: config.runtimeBinding.runId,
          bindingFingerprint: config.runtimeBinding.bindingFingerprint,
          targets: config.runtimeBinding.targets
        }
      : { mode: 'legacy-fixed-database-boundary' },
    serviceOrder: SERVICE_ORDER,
    targets: Object.fromEntries(
      Object.entries(config.databaseUrls).map(([key, url]) => [
        key,
        {
          database: getDatabaseName(url),
          url: maskDatabaseUrl(url)
        }
      ])
    ),
    seed: {
      identity: config.seed.identity,
      auth: config.seed.auth,
      permission: config.seed.permission
    }
  }
}

/** validateAppliedSystemAdminSeed reads the four service stores and reports whether the seed is consistent. */
export async function validateAppliedSystemAdminSeed(clients, config) {
  const errors = []
  const state = {
    identity: {},
    auth: {},
    permission: {}
  }

  const user = await clients.identity.user.findUnique({
    where: {
      email: config.seed.identity.email
    }
  })

  if (!user) {
    errors.push('identity-service: missing sysadmin User')
  } else {
    state.identity = {
      userId: user.id,
      username: user.username,
      email: user.email,
      isActive: user.isActive
    }

    if (user.username !== config.seed.identity.username) {
      errors.push(`identity-service: expected username ${config.seed.identity.username}`)
    }
    if (!user.isActive) {
      errors.push('identity-service: expected User.isActive true')
    }
  }

  const account =
    user &&
    (await clients.identity.userAccount.findUnique({
      where: {
        userId_scopeLevel_contextKey: {
          userId: user.id,
          scopeLevel: config.seed.identity.accountScopeLevel,
          contextKey: config.seed.identity.accountContextKey
        }
      }
    }))

  if (!account) {
    errors.push('identity-service: missing sysadmin SYSTEM UserAccount')
  } else {
    state.identity = {
      ...state.identity,
      accountId: account.id,
      accountScopeLevel: account.scopeLevel,
      accountContextKey: account.contextKey,
      accountDisplayName: account.displayName,
      accountEnabled: account.isEnable,
      tenantId: account.tenantId
    }

    if (account.tenantId !== null) {
      errors.push('identity-service: expected system UserAccount.tenantId null')
    }
    if (account.displayName !== config.seed.identity.accountDisplayName) {
      errors.push(`identity-service: expected account displayName ${config.seed.identity.accountDisplayName}`)
    }
    if (!account.isEnable) {
      errors.push('identity-service: expected UserAccount.isEnable true')
    }
  }

  const loginMethod = await clients.auth.loginMethod.findUnique({
    where: {
      type_identifier: {
        type: config.seed.auth.loginMethodType,
        identifier: config.seed.identity.email
      }
    }
  })
  const passwordCredentialCount = loginMethod
    ? await clients.auth.credential.count({
        where: {
          loginMethodId: loginMethod.id,
          credentialType: 'PASSWORD'
        }
      })
    : 0

  if (!loginMethod) {
    errors.push('auth-service: missing sysadmin EMAIL LoginMethod')
  } else {
    state.auth = {
      loginMethodId: loginMethod.id,
      userId: loginMethod.userId,
      verified: loginMethod.verified,
      enabled: loginMethod.enabled,
      passwordCredentialCount
    }

    if (user?.id && loginMethod.userId !== user.id) {
      errors.push('auth-service: LoginMethod.userId does not match identity-service User.id')
    }
    if (!loginMethod.verified) {
      errors.push('auth-service: expected LoginMethod.verified true')
    }
    if (!loginMethod.enabled) {
      errors.push('auth-service: expected LoginMethod.enabled true')
    }
  }

  const role = await clients.permission.role.findUnique({
    where: {
      scopeKey_kind_code: {
        scopeKey: config.seed.permission.roleScopeKey,
        kind: config.seed.permission.roleKind,
        code: config.seed.permission.roleCode
      }
    }
  })

  if (!role) {
    errors.push('permission-service: missing system.admin Role')
  } else if (!role.isEnabled) {
    errors.push('permission-service: expected system.admin Role.isEnabled true')
  }

  const accountRole =
    account &&
    role &&
    (await clients.permission.accountRole.findUnique({
      where: {
        accountId_roleId: {
          accountId: account.id,
          roleId: role.id
        }
      }
    }))

  if (!accountRole) {
    errors.push('permission-service: missing sysadmin AccountRole(system.admin)')
  } else {
    state.permission = {
      accountRoleId: accountRole.id,
      roleId: role.id,
      roleCode: role.code,
      accountId: accountRole.accountId,
      accountType: accountRole.accountType,
      scopeLevel: accountRole.scopeLevel,
      tenantId: accountRole.tenantId
    }

    if (accountRole.accountType !== config.seed.permission.accountType) {
      errors.push(`permission-service: expected AccountRole.accountType ${config.seed.permission.accountType}`)
    }
    if (accountRole.scopeLevel !== config.seed.permission.scopeLevel) {
      errors.push(`permission-service: expected AccountRole.scopeLevel ${config.seed.permission.scopeLevel}`)
    }
    if (accountRole.tenantId !== null) {
      errors.push('permission-service: expected AccountRole.tenantId null')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    state
  }
}

/** validateSystemAdminSeedConfig prevents this local seed from accidentally writing production-like targets. */
export function validateSystemAdminSeedConfig(config) {
  const errors = []

  for (const [key, url] of Object.entries(config.databaseUrls)) {
    const target = DATABASE_TARGETS[key]
    const parsed = parseDatabaseUrl(url)

    if (!parsed) {
      errors.push(`${target.label} DATABASE_URL is not a valid PostgreSQL URL`)
      continue
    }

    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
      errors.push(`${target.label} DATABASE_URL must target localhost, got ${parsed.hostname}`)
    }

    const expectedDatabase = config.runtimeBinding?.targets?.[key]?.database ?? target.expectedDatabase
    if (parsed.database !== expectedDatabase) {
      errors.push(
        `${target.label} DATABASE_URL must target database ${expectedDatabase}, got ${parsed.database || '(empty)'}`
      )
    }

    const runtimeTarget = config.runtimeBinding?.targets?.[key]
    if (runtimeTarget && parsed.username !== runtimeTarget.runtime) {
      errors.push(`${target.label} DATABASE_URL must use runtime owner ${runtimeTarget.runtime}`)
    }
    if (runtimeTarget && (parsed.port || '5432') !== config.runtimeBinding.postgres.port) {
      errors.push(`${target.label} DATABASE_URL port must match manifest port ${config.runtimeBinding.postgres.port}`)
    }
    if (runtimeTarget && parsed.hostname !== config.runtimeBinding.postgres.host) {
      errors.push(`${target.label} DATABASE_URL host must match manifest host ${config.runtimeBinding.postgres.host}`)
    }
  }

  if (config.seed.auth.createsPasswordCredential) {
    errors.push('system admin seed must not create a password credential')
  }

  return errors
}

/** applySystemAdminSeed performs the bounded upserts through each service-owned Prisma client. */
export async function applySystemAdminSeed(clients, config) {
  const identity = await upsertSystemAdminIdentity(clients.identity, config.seed)
  const auth = await upsertSystemAdminAuthLoginMethod(clients.auth, config.seed, identity.userId)
  const permission = await upsertSystemAdminPermissionBinding(
    clients.permission,
    config.seed,
    identity.accountId
  )

  return {
    identity,
    auth,
    permission
  }
}

/** createSystemAdminSeedClients loads the service-generated Prisma clients with isolated datasource URLs. */
export function createSystemAdminSeedClients(config) {
  const { PrismaClient: IdentityPrismaClient } = require('../../src/services/system/identity-service/prisma/generated/prisma')
  const { PrismaClient: AuthPrismaClient } = require('../../src/services/system/auth-service/prisma/generated/prisma')
  const { PrismaClient: PermissionPrismaClient } = require('../../src/services/system/permission-service/prisma/generated/prisma')

  return {
    identity: new IdentityPrismaClient({
      datasources: { db: { url: config.databaseUrls.identityService } }
    }),
    auth: new AuthPrismaClient({
      datasources: { db: { url: config.databaseUrls.authService } }
    }),
    permission: new PermissionPrismaClient({
      datasources: { db: { url: config.databaseUrls.permissionService } }
    })
  }
}

/** disconnectSystemAdminSeedClients closes all Prisma connections opened by the seed orchestrator. */
export async function disconnectSystemAdminSeedClients(clients) {
  await Promise.all(
    Object.values(clients)
      .filter((client) => typeof client?.$disconnect === 'function')
      .map((client) => client.$disconnect())
  )
}

/** upsertSystemAdminIdentity creates or refreshes one system-scope identity account without binding a Party. */
async function upsertSystemAdminIdentity(identityClient, seed) {
  const existingUser = await identityClient.user.findUnique({
    where: { email: seed.identity.email }
  })
  const user = await identityClient.user.upsert({
    where: { email: seed.identity.email },
    create: {
      username: seed.identity.username,
      email: seed.identity.email,
      phone: seed.identity.phone,
      isActive: true
    },
    update: {
      username: seed.identity.username,
      phone: seed.identity.phone,
      isActive: true
    }
  })

  const accountWhere = {
    userId_scopeLevel_contextKey: {
      userId: user.id,
      scopeLevel: seed.identity.accountScopeLevel,
      contextKey: seed.identity.accountContextKey
    }
  }
  const existingAccount = await identityClient.userAccount.findUnique({
    where: accountWhere
  })
  const account = await identityClient.userAccount.upsert({
    where: accountWhere,
    create: {
      tenantId: null,
      userId: user.id,
      scopeLevel: seed.identity.accountScopeLevel,
      contextKey: seed.identity.accountContextKey,
      displayName: seed.identity.accountDisplayName,
      isEnable: true
    },
    update: {
      tenantId: null,
      displayName: seed.identity.accountDisplayName,
      isEnable: true
    }
  })

  return {
    userOperation: existingUser ? 'updated' : 'created',
    accountOperation: existingAccount ? 'updated' : 'created',
    userId: user.id,
    accountId: account.id
  }
}

/** upsertSystemAdminAuthLoginMethod creates only a verified email login method, leaving password setup to recovery flow. */
async function upsertSystemAdminAuthLoginMethod(authClient, seed, userId) {
  const where = {
    type_identifier: {
      type: seed.auth.loginMethodType,
      identifier: seed.identity.email
    }
  }
  const existingLoginMethod = await authClient.loginMethod.findUnique({ where })
  const loginMethod = await authClient.loginMethod.upsert({
    where,
    create: {
      userId,
      type: seed.auth.loginMethodType,
      identifier: seed.identity.email,
      verified: seed.auth.verified,
      enabled: seed.auth.enabled
    },
    update: {
      userId,
      verified: seed.auth.verified,
      enabled: seed.auth.enabled
    }
  })

  return {
    operation: existingLoginMethod ? 'updated' : 'created',
    loginMethodId: loginMethod.id,
    createsPasswordCredential: false
  }
}

/** upsertSystemAdminPermissionBinding binds the system account to the protected system.admin instance role. */
async function upsertSystemAdminPermissionBinding(permissionClient, seed, accountId) {
  const role = await permissionClient.role.findUnique({
    where: {
      scopeKey_kind_code: {
        scopeKey: seed.permission.roleScopeKey,
        kind: seed.permission.roleKind,
        code: seed.permission.roleCode
      }
    }
  })

  if (!role) {
    throw new Error(
      `Missing permission role ${seed.permission.roleCode}; run pnpm backend:foundation:sync first.`
    )
  }

  const where = {
    accountId_roleId: {
      accountId,
      roleId: role.id
    }
  }
  const existingAccountRole = await permissionClient.accountRole.findUnique({ where })
  const accountRole = await permissionClient.accountRole.upsert({
    where,
    create: {
      accountType: seed.permission.accountType,
      accountId,
      roleId: role.id,
      tenantId: seed.permission.tenantId,
      scopeLevel: seed.permission.scopeLevel,
      effectiveAt: null,
      expiresAt: null
    },
    update: {
      accountType: seed.permission.accountType,
      tenantId: seed.permission.tenantId,
      scopeLevel: seed.permission.scopeLevel,
      effectiveAt: null,
      expiresAt: null
    }
  })

  return {
    operation: existingAccountRole ? 'updated' : 'created',
    accountRoleId: accountRole.id,
    roleCode: seed.permission.roleCode,
    roleId: role.id
  }
}

/** maskDatabaseUrl redacts credentials while keeping the target database auditable in dry-run output. */
export function maskDatabaseUrl(value) {
  const parsed = parseDatabaseUrl(value)
  if (!parsed) {
    return '(invalid-url)'
  }

  const auth = parsed.username ? '***@' : ''
  const port = parsed.port ? `:${parsed.port}` : ''
  return `${parsed.protocol}://${auth}${parsed.hostname}${port}/${parsed.database}`
}

/** getDatabaseName extracts the database name from a PostgreSQL URL for target audits. */
export function getDatabaseName(value) {
  return parseDatabaseUrl(value)?.database ?? ''
}

/** normalizeEmail applies the auth/identity email normalization expected by login and lookup paths. */
function normalizeEmail(value) {
  return value.trim().toLowerCase()
}

/** parseDatabaseUrl safely decodes the local PostgreSQL URLs used by seed scripts. */
function parseDatabaseUrl(value) {
  try {
    const url = new URL(value)
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      return null
    }

    return {
      protocol: url.protocol.replace(':', ''),
      hostname: url.hostname.replace(/^\[|\]$/gu, '').toLowerCase(),
      port: url.port,
      username: decodeURIComponent(url.username),
      database: url.pathname.replace(/^\//, '')
    }
  } catch {
    return null
  }
}

/** printHelp explains the local-only contract for the system admin seed script. */
function printHelp() {
  console.log(`Usage: node scripts/local/seed-system-admin.mjs [--apply | --validate]

Seeds the local system admin account across identity, auth, and permission stores.

Default mode is dry-run. Use --apply to write and --validate to read-check:
  identity-service   User + UserAccount(SYSTEM)
  auth-service       LoginMethod.EMAIL only; no password credential
  permission-service AccountRole(system.admin)

This direct entry retains only the legacy fixed-database boundary. For V2 manifests use:
  pnpm runtime:seed:system-admin -- --manifest /ABSOLUTE/RUN/manifest.json [--apply | --validate]

Legacy database URL overrides:
  OES_IDENTITY_DATABASE_URL
  OES_AUTH_DATABASE_URL
  OES_PERMISSION_DATABASE_URL
`)
}

/** main runs the seed script as a CLI while keeping dry-run as the safe default. */
async function main() {
  const options = parseSystemAdminSeedArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const config = buildSystemAdminSeedConfig(process.env)
  const validationErrors = validateSystemAdminSeedConfig(config)
  const plan = buildSystemAdminSeedExecutionPlan(config, options)

  console.log(JSON.stringify({ plan, validationErrors }, null, 2))

  if (validationErrors.length > 0) {
    process.exitCode = 1
    return
  }

  if (!options.apply) {
    if (options.validate) {
      const clients = createSystemAdminSeedClients(config)
      try {
        const validation = await validateAppliedSystemAdminSeed(clients, config)
        console.log(JSON.stringify({ validation }, null, 2))
        if (!validation.valid) {
          process.exitCode = 1
        }
      } finally {
        await disconnectSystemAdminSeedClients(clients)
      }
      return
    }

    console.log('Dry-run only. Re-run with --apply to write local seed data.')
    return
  }

  const clients = createSystemAdminSeedClients(config)
  try {
    const result = await applySystemAdminSeed(clients, config)
    console.log(JSON.stringify({ applied: true, result }, null, 2))
  } finally {
    await disconnectSystemAdminSeedClients(clients)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

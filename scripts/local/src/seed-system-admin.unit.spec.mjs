import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSystemAdminSeedInvocation } from '../../local-runtime/src/bootstrap.mjs'
import { createSystemAdminSeedManifestFixture } from '../../local-runtime/src/__tests__/system-admin-seed-test-fixture.mjs'

import {
  applySystemAdminSeed,
  buildSystemAdminSeedConfig,
  buildSystemAdminSeedExecutionPlan,
  classifySystemAdminPermissionBindings,
  parseSystemAdminSeedArgs,
  validateAppliedSystemAdminSeed,
  validateSystemAdminSeedConfig
} from '../seed-system-admin.mjs'

const NOW = new Date('2026-09-10T01:00:00.000Z')

/** buildCompleteSeedClients supplies canonical in-memory records without emulating a removed Prisma delegate. */
function buildCompleteSeedClients(config, bindings) {
  return {
    identity: {
      user: {
        findUnique: async () => ({
          id: 'user-1',
          username: config.seed.identity.username,
          email: config.seed.identity.email,
          isActive: true
        })
      },
      userAccount: {
        findUnique: async () => ({
          id: 'account-1',
          userId: 'user-1',
          tenantId: null,
          scopeLevel: 'SYSTEM',
          contextKey: 'SYSTEM',
          displayName: config.seed.identity.accountDisplayName,
          isEnable: true
        })
      }
    },
    auth: {
      loginMethod: {
        findUnique: async () => ({
          id: 'login-method-1',
          userId: 'user-1',
          type: 'EMAIL',
          identifier: config.seed.identity.email,
          verified: true,
          enabled: true
        })
      },
      credential: { count: async () => 1 }
    },
    permission: {
      role: {
        findUnique: async () => ({
          id: 'system-admin-role-1',
          code: 'system.admin',
          kind: 'SYSTEM_INSTANCE',
          scopeKey: '__SYSTEM__',
          tenantId: null,
          isEnabled: true
        })
      },
      principalRoleBinding: { findMany: async () => bindings }
    }
  }
}

/** canonicalBinding creates one current HUMAN/SYSTEM binding fixture. */
function canonicalBinding(overrides = {}) {
  return {
    id: 'principal-role-binding-1',
    principalType: 'HUMAN',
    principalId: 'account-1',
    roleId: 'system-admin-role-1',
    tenantId: null,
    scopeLevel: 'SYSTEM',
    effectiveAt: new Date('2026-09-10T00:00:00.000Z'),
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date('2026-09-10T00:00:00.000Z'),
    ...overrides
  }
}

test('system admin seed defaults to dry-run and masks local database passwords', () => {
  const options = parseSystemAdminSeedArgs([])
  const config = buildSystemAdminSeedConfig({})
  const plan = buildSystemAdminSeedExecutionPlan(config, options)

  assert.equal(plan.mode, 'dry-run')
  assert.equal(plan.writesDatabase, false)
  assert.deepEqual(plan.serviceOrder, ['identity-service', 'auth-service', 'permission-service'])
  assert.equal(plan.seed.auth.createsPasswordCredential, false)
  assert.equal(plan.seed.identity.loginIdentifierConfigured, true)
  assert.equal(plan.seed.identity.email, undefined)
  assert.equal(plan.seed.identity.username, undefined)
  assert.equal(plan.targets.partyService, undefined)
  assert.doesNotMatch(JSON.stringify(plan), /imkgsam:imkgsam/)
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(config.seed.identity.email, 'u'))
})

test('system admin seed rejects non-local or unexpected database targets', () => {
  const config = buildSystemAdminSeedConfig({
    OES_IDENTITY_DATABASE_URL: 'postgres://imkgsam:imkgsam@localhost:5432/not_identitydb'
  })

  const errors = validateSystemAdminSeedConfig(config)

  assert.match(errors.join('\n'), /identity-service DATABASE_URL must target database identitydb/)
})

test('system admin seed accepts exact manifest-bound dynamic databases and keeps legacy fixed', () => {
  const fixture = createSystemAdminSeedManifestFixture()
  const invocation = buildSystemAdminSeedInvocation(fixture.file, {
    root: '/repo',
    mode: 'dry-run'
  })
  const config = buildSystemAdminSeedConfig(invocation.environment)
  const plan = buildSystemAdminSeedExecutionPlan(config, parseSystemAdminSeedArgs([]))
  assert.deepEqual(validateSystemAdminSeedConfig(config), [])
  assert.equal(plan.authority.mode, 'launcher-manifest')
  assert.equal(plan.authority.taskKey, fixture.taskKey)
  assert.equal(
    plan.targets.identityService.database,
    fixture.resources.find((resource) => resource.owner === 'identity-service').database
  )
  for (const secret of fixture.secrets)
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(secret, 'u'))

  const legacyDynamic = buildSystemAdminSeedConfig({
    OES_IDENTITY_DATABASE_URL: invocation.environment.OES_IDENTITY_DATABASE_URL
  })
  assert.match(
    validateSystemAdminSeedConfig(legacyDynamic).join('\n'),
    /must target database identitydb/u
  )
})

test('system admin seed rejects incomplete manifest authority and revalidates dynamic target identity', () => {
  const fixture = createSystemAdminSeedManifestFixture()
  assert.throws(
    () => buildSystemAdminSeedConfig({ OES_RUNTIME_MANIFEST: fixture.file }),
    /SYSTEM_ADMIN_SEED_MANIFEST_BINDING_REQUIRED/u
  )
  const invocation = buildSystemAdminSeedInvocation(fixture.file, {
    root: '/repo',
    mode: 'dry-run'
  })
  const config = buildSystemAdminSeedConfig(invocation.environment)
  config.databaseUrls.identityService = config.databaseUrls.authService
  const errors = validateSystemAdminSeedConfig(config).join('\n')
  assert.match(
    errors,
    new RegExp(
      `identity-service DATABASE_URL must target database ${config.runtimeBinding.targets.identityService.database}`,
      'u'
    )
  )
  assert.match(
    errors,
    new RegExp(
      `identity-service DATABASE_URL must use runtime owner ${config.runtimeBinding.targets.identityService.runtime}`,
      'u'
    )
  )
})

test('system admin seed rejects contradictory apply and validate modes', () => {
  assert.throws(
    () => parseSystemAdminSeedArgs(['--apply', '--validate']),
    /SYSTEM_ADMIN_SEED_MODE_CONFLICT/u
  )
})

test('validateAppliedSystemAdminSeed reports a consistent cross-service system admin seed', async () => {
  const config = buildSystemAdminSeedConfig({})
  const clients = buildCompleteSeedClients(config, [canonicalBinding()])

  const result = await validateAppliedSystemAdminSeed(clients, config, NOW)

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
  assert.equal(result.state.identity.accountId, 'account-1')
  assert.equal(result.state.auth.passwordCredentialCount, 1)
  assert.equal(result.state.permission.principalRoleBindingId, 'principal-role-binding-1')
  assert.equal(result.state.permission.activeBindingCount, 1)
})

test('validateAppliedSystemAdminSeed classifies missing, drifted, revoked, expired, future, and duplicate active bindings', async (t) => {
  const config = buildSystemAdminSeedConfig({})
  const cases = [
    { name: 'missing', bindings: [], error: /missing active/u },
    {
      name: 'drifted',
      bindings: [canonicalBinding({ principalType: 'MACHINE' })],
      error: /coordinate drift/u
    },
    {
      name: 'revoked',
      bindings: [canonicalBinding({ revokedAt: new Date('2026-09-10T00:30:00.000Z') })],
      error: /is revoked/u
    },
    {
      name: 'expired',
      bindings: [canonicalBinding({ expiresAt: new Date('2026-09-10T00:30:00.000Z') })],
      error: /is expired/u
    },
    {
      name: 'future',
      bindings: [canonicalBinding({ effectiveAt: new Date('2026-09-10T02:00:00.000Z') })],
      error: /not yet effective/u
    },
    {
      name: 'duplicate active',
      bindings: [canonicalBinding(), canonicalBinding({ id: 'principal-role-binding-2' })],
      error: /duplicate active/u
    }
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const result = await validateAppliedSystemAdminSeed(
        buildCompleteSeedClients(config, fixture.bindings),
        config,
        NOW
      )
      assert.equal(result.valid, false)
      assert.match(result.errors.join('\n'), fixture.error)
    })
  }
})

test('classifySystemAdminPermissionBindings ignores revoked history after one current replacement exists', () => {
  const config = buildSystemAdminSeedConfig({})
  const result = classifySystemAdminPermissionBindings(
    [
      canonicalBinding({ id: 'revoked-binding', revokedAt: new Date('2026-09-09T23:00:00.000Z') }),
      canonicalBinding({ id: 'active-binding' })
    ],
    config.seed.permission,
    'account-1',
    'system-admin-role-1',
    NOW
  )

  assert.equal(result.activeCanonical.length, 1)
  assert.equal(result.revokedCanonical.length, 1)
})

test('applySystemAdminSeed upserts system admin records across service-owned stores', async () => {
  const operations = []
  const config = buildSystemAdminSeedConfig({})
  const clients = {
    identity: {
      user: {
        findUnique: async (args) => {
          operations.push(['identity.user.findUnique', args])
          return null
        },
        upsert: async (args) => {
          operations.push(['identity.user.upsert', args])
          return { id: 'user-1' }
        }
      },
      userAccount: {
        findUnique: async (args) => {
          operations.push(['identity.userAccount.findUnique', args])
          return null
        },
        upsert: async (args) => {
          operations.push(['identity.userAccount.upsert', args])
          return { id: 'account-1' }
        }
      }
    },
    auth: {
      loginMethod: {
        findUnique: async (args) => {
          operations.push(['auth.loginMethod.findUnique', args])
          return null
        },
        upsert: async (args) => {
          operations.push(['auth.loginMethod.upsert', args])
          return { id: 'login-method-1' }
        }
      }
    },
    permission: {
      role: {
        findUnique: async (args) => {
          operations.push(['permission.role.findUnique', args])
          return { id: 'system-admin-role-1', tenantId: null, isEnabled: true }
        }
      },
      principalRoleBinding: {
        findMany: async (args) => {
          operations.push(['permission.principalRoleBinding.findMany', args])
          return []
        },
        create: async (args) => {
          operations.push(['permission.principalRoleBinding.create', args])
          return { id: 'principal-role-binding-1' }
        }
      }
    }
  }

  const result = await applySystemAdminSeed(clients, config)

  assert.deepEqual(
    operations.map(([operation]) => operation),
    [
      'identity.user.findUnique',
      'identity.user.upsert',
      'identity.userAccount.findUnique',
      'identity.userAccount.upsert',
      'auth.loginMethod.findUnique',
      'auth.loginMethod.upsert',
      'permission.role.findUnique',
      'permission.principalRoleBinding.findMany',
      'permission.principalRoleBinding.create'
    ]
  )
  assert.equal(result.identity.userId, 'user-1')
  assert.equal(result.identity.accountId, 'account-1')
  assert.equal(result.auth.createsPasswordCredential, false)
  assert.equal(result.permission.roleCode, 'system.admin')
  assert.equal(result.permission.principalRoleBindingId, 'principal-role-binding-1')

  const authUpsert = operations.find(([operation]) => operation === 'auth.loginMethod.upsert')?.[1]
  assert.equal(authUpsert.create.verified, true)
  assert.equal(authUpsert.create.enabled, true)
  assert.equal(authUpsert.create.identifier, config.seed.identity.email)
  const bindingCreate = operations.find(
    ([operation]) => operation === 'permission.principalRoleBinding.create'
  )?.[1]
  assert.equal(bindingCreate.data.principalType, 'HUMAN')
  assert.equal(bindingCreate.data.principalId, 'account-1')
  assert.equal(bindingCreate.data.scopeLevel, 'SYSTEM')
  assert.equal(bindingCreate.data.tenantId, null)
  assert.equal(bindingCreate.data.revokedAt, null)
  assert.equal(bindingCreate.data.createdByOperatorId, 'system-admin-seed')
  assert.ok(bindingCreate.data.grantAuditEventId)
})

test('applySystemAdminSeed reuses one active canonical binding without creating a duplicate', async () => {
  const config = buildSystemAdminSeedConfig({})
  const clients = buildCompleteSeedClients(config, [canonicalBinding()])
  clients.identity.user.findUnique = async () => ({ id: 'user-1' })
  clients.identity.user.upsert = async () => ({ id: 'user-1' })
  clients.identity.userAccount.upsert = async () => ({ id: 'account-1' })
  clients.auth.loginMethod.upsert = async () => ({ id: 'login-method-1' })
  clients.permission.principalRoleBinding.create = async () => {
    throw new Error('unexpected duplicate create')
  }

  const result = await applySystemAdminSeed(clients, config, NOW)

  assert.equal(result.permission.operation, 'unchanged')
  assert.equal(result.permission.principalRoleBindingId, 'principal-role-binding-1')
})

test('applySystemAdminSeed accepts the later concurrent winner using a fresh recovery time', async () => {
  const config = buildSystemAdminSeedConfig({})
  const winnerTime = new Date('2026-09-10T01:00:00.010Z')
  const recoveryTime = new Date('2026-09-10T01:00:00.020Z')
  const concurrentWinner = canonicalBinding({
    id: 'concurrent-winner',
    effectiveAt: winnerTime,
    createdAt: winnerTime
  })
  const clients = buildCompleteSeedClients(config, [])
  clients.identity.user.findUnique = async () => ({ id: 'user-1' })
  clients.identity.user.upsert = async () => ({ id: 'user-1' })
  clients.identity.userAccount.upsert = async () => ({ id: 'account-1' })
  clients.auth.loginMethod.upsert = async () => ({ id: 'login-method-1' })
  let reads = 0
  clients.permission.principalRoleBinding.findMany = async () => {
    reads += 1
    return reads === 1 ? [] : [concurrentWinner]
  }
  clients.permission.principalRoleBinding.create = async () => {
    const error = new Error('principal_role_binding_non_overlapping_window')
    error.code = 'P2004'
    error.meta = { constraint: 'principal_role_binding_non_overlapping_window' }
    throw error
  }

  const result = await applySystemAdminSeed(clients, config, NOW, () => recoveryTime)

  assert.equal(reads, 2)
  assert.equal(result.permission.operation, 'unchanged')
  assert.equal(result.permission.principalRoleBindingId, 'concurrent-winner')
})

test('applySystemAdminSeed keeps a post-conflict scheduled binding fail-closed', async () => {
  const config = buildSystemAdminSeedConfig({})
  const scheduled = canonicalBinding({
    id: 'scheduled-binding',
    effectiveAt: new Date('2026-09-10T02:00:00.000Z'),
    createdAt: new Date('2026-09-10T01:00:00.010Z')
  })
  const clients = buildCompleteSeedClients(config, [])
  clients.identity.user.findUnique = async () => ({ id: 'user-1' })
  clients.identity.user.upsert = async () => ({ id: 'user-1' })
  clients.identity.userAccount.upsert = async () => ({ id: 'account-1' })
  clients.auth.loginMethod.upsert = async () => ({ id: 'login-method-1' })
  let reads = 0
  clients.permission.principalRoleBinding.findMany = async () => {
    reads += 1
    return reads === 1 ? [] : [scheduled]
  }
  clients.permission.principalRoleBinding.create = async () => {
    const error = new Error('principal_role_binding_non_overlapping_window')
    error.code = 'P2004'
    throw error
  }

  await assert.rejects(
    () =>
      applySystemAdminSeed(
        clients,
        config,
        NOW,
        () => new Date('2026-09-10T01:00:00.020Z')
      ),
    /SYSTEM_ADMIN_SEED_FUTURE_PRINCIPAL_ROLE_BINDING/u
  )
  assert.equal(reads, 2)
})

test('applySystemAdminSeed fails closed for active coordinate drift, duplicate active grants, and future overlap', async (t) => {
  const config = buildSystemAdminSeedConfig({})
  const cases = [
    {
      name: 'active drift',
      bindings: [canonicalBinding({ scopeLevel: 'TENANT', tenantId: 'tenant-1' })],
      error: /SYSTEM_ADMIN_SEED_PRINCIPAL_ROLE_BINDING_DRIFT/u
    },
    {
      name: 'duplicate active',
      bindings: [canonicalBinding(), canonicalBinding({ id: 'principal-role-binding-2' })],
      error: /SYSTEM_ADMIN_SEED_DUPLICATE_ACTIVE_PRINCIPAL_ROLE_BINDING/u
    },
    {
      name: 'future overlap',
      bindings: [canonicalBinding({ effectiveAt: new Date('2026-09-10T02:00:00.000Z') })],
      error: /SYSTEM_ADMIN_SEED_FUTURE_PRINCIPAL_ROLE_BINDING/u
    }
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const clients = buildCompleteSeedClients(config, fixture.bindings)
      clients.identity.user.findUnique = async () => ({ id: 'user-1' })
      clients.identity.user.upsert = async () => ({ id: 'user-1' })
      clients.identity.userAccount.upsert = async () => ({ id: 'account-1' })
      clients.auth.loginMethod.upsert = async () => ({ id: 'login-method-1' })
      clients.permission.principalRoleBinding.create = async () => {
        throw new Error('unexpected create')
      }

      await assert.rejects(() => applySystemAdminSeed(clients, config, NOW), fixture.error)
    })
  }
})

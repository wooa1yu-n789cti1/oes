import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSystemAdminSeedInvocation } from '../../local-runtime/src/bootstrap.mjs'
import { createSystemAdminSeedManifestFixture } from '../../local-runtime/src/__tests__/system-admin-seed-test-fixture.mjs'

import {
  applySystemAdminSeed,
  buildSystemAdminSeedConfig,
  buildSystemAdminSeedExecutionPlan,
  parseSystemAdminSeedArgs,
  validateAppliedSystemAdminSeed,
  validateSystemAdminSeedConfig
} from '../seed-system-admin.mjs'

test('system admin seed defaults to dry-run and masks local database passwords', () => {
  const options = parseSystemAdminSeedArgs([])
  const config = buildSystemAdminSeedConfig({})
  const plan = buildSystemAdminSeedExecutionPlan(config, options)

  assert.equal(plan.mode, 'dry-run')
  assert.equal(plan.writesDatabase, false)
  assert.deepEqual(plan.serviceOrder, [
    'identity-service',
    'auth-service',
    'permission-service'
  ])
  assert.equal(plan.seed.auth.createsPasswordCredential, false)
  assert.equal(plan.targets.partyService, undefined)
  assert.doesNotMatch(JSON.stringify(plan), /imkgsam:imkgsam/)
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
  const invocation = buildSystemAdminSeedInvocation(fixture.file, { root: '/repo', mode: 'dry-run' })
  const config = buildSystemAdminSeedConfig(invocation.environment)
  const plan = buildSystemAdminSeedExecutionPlan(config, parseSystemAdminSeedArgs([]))
  assert.deepEqual(validateSystemAdminSeedConfig(config), [])
  assert.equal(plan.authority.mode, 'launcher-manifest')
  assert.equal(plan.authority.taskKey, fixture.taskKey)
  assert.equal(plan.targets.identityService.database, fixture.resources.find((resource) => resource.owner === 'identity-service').database)
  for (const secret of fixture.secrets) assert.doesNotMatch(JSON.stringify(plan), new RegExp(secret, 'u'))

  const legacyDynamic = buildSystemAdminSeedConfig({ OES_IDENTITY_DATABASE_URL: invocation.environment.OES_IDENTITY_DATABASE_URL })
  assert.match(validateSystemAdminSeedConfig(legacyDynamic).join('\n'), /must target database identitydb/u)
})

test('system admin seed rejects incomplete manifest authority and revalidates dynamic target identity', () => {
  const fixture = createSystemAdminSeedManifestFixture()
  assert.throws(() => buildSystemAdminSeedConfig({ OES_RUNTIME_MANIFEST: fixture.file }), /SYSTEM_ADMIN_SEED_MANIFEST_BINDING_REQUIRED/u)
  const invocation = buildSystemAdminSeedInvocation(fixture.file, { root: '/repo', mode: 'dry-run' })
  const config = buildSystemAdminSeedConfig(invocation.environment)
  config.databaseUrls.identityService = config.databaseUrls.authService
  const errors = validateSystemAdminSeedConfig(config).join('\n')
  assert.match(errors, new RegExp(`identity-service DATABASE_URL must target database ${config.runtimeBinding.targets.identityService.database}`, 'u'))
  assert.match(errors, new RegExp(`identity-service DATABASE_URL must use runtime owner ${config.runtimeBinding.targets.identityService.runtime}`, 'u'))
})

test('system admin seed rejects contradictory apply and validate modes', () => {
  assert.throws(() => parseSystemAdminSeedArgs(['--apply', '--validate']), /SYSTEM_ADMIN_SEED_MODE_CONFLICT/u)
})

test('validateAppliedSystemAdminSeed reports a consistent cross-service system admin seed', async () => {
  const config = buildSystemAdminSeedConfig({})
  const clients = {
    identity: {
      user: {
        findUnique: async () => ({
          id: 'user-1',
          username: 'sysadmin',
          email: 'sysadmin@oes.local',
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
          displayName: 'tth',
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
          identifier: 'sysadmin@oes.local',
          verified: true,
          enabled: true
        })
      },
      credential: {
        count: async () => 1
      }
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
      accountRole: {
        findUnique: async () => ({
          id: 'account-role-1',
          accountType: 'USER',
          accountId: 'account-1',
          roleId: 'system-admin-role-1',
          tenantId: null,
          scopeLevel: 'SYSTEM'
        })
      }
    }
  }

  const result = await validateAppliedSystemAdminSeed(clients, config)

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
  assert.equal(result.state.identity.accountId, 'account-1')
  assert.equal(result.state.auth.passwordCredentialCount, 1)
  assert.equal(result.state.permission.accountRoleId, 'account-role-1')
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
          return { id: 'system-admin-role-1' }
        }
      },
      accountRole: {
        findUnique: async (args) => {
          operations.push(['permission.accountRole.findUnique', args])
          return null
        },
        upsert: async (args) => {
          operations.push(['permission.accountRole.upsert', args])
          return { id: 'account-role-1' }
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
      'permission.accountRole.findUnique',
      'permission.accountRole.upsert'
    ]
  )
  assert.equal(result.identity.userId, 'user-1')
  assert.equal(result.identity.accountId, 'account-1')
  assert.equal(result.auth.createsPasswordCredential, false)
  assert.equal(result.permission.roleCode, 'system.admin')
  assert.equal(result.permission.accountRoleId, 'account-role-1')

  const authUpsert = operations.find(([operation]) => operation === 'auth.loginMethod.upsert')?.[1]
  assert.equal(authUpsert.create.verified, true)
  assert.equal(authUpsert.create.enabled, true)
  assert.equal(authUpsert.create.identifier, 'sysadmin@oes.local')
})

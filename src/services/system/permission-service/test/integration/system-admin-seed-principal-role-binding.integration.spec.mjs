import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'

import {
  applySystemAdminSeed,
  buildSystemAdminSeedConfig,
  validateAppliedSystemAdminSeed
} from '../../../../../../scripts/local/seed-system-admin.mjs'

const require = createRequire(import.meta.url)
const { PrismaClient } = require('../../prisma/generated/prisma')
const NOW = new Date('2026-09-10T01:00:00.000Z')
const PREFIX = `system_admin_seed_${process.pid}_${randomUUID().replaceAll('-', '')}`

let prisma
let role
let createdRole = false

/** buildPartialStateClients models the observed Identity/Auth-complete state while using the real Permission client. */
function buildPartialStateClients(accountId) {
  const config = buildSystemAdminSeedConfig({})
  const user = {
    id: `${accountId}_user`,
    username: config.seed.identity.username,
    email: config.seed.identity.email,
    isActive: true
  }
  const account = {
    id: accountId,
    userId: user.id,
    tenantId: null,
    scopeLevel: config.seed.identity.accountScopeLevel,
    contextKey: config.seed.identity.accountContextKey,
    displayName: config.seed.identity.accountDisplayName,
    isEnable: true
  }
  const loginMethod = {
    id: `${accountId}_login`,
    userId: user.id,
    type: config.seed.auth.loginMethodType,
    identifier: config.seed.identity.email,
    verified: true,
    enabled: true
  }
  return {
    config,
    clients: {
      identity: {
        user: { findUnique: async () => user, upsert: async () => user },
        userAccount: { findUnique: async () => account, upsert: async () => account }
      },
      auth: {
        loginMethod: {
          findUnique: async () => loginMethod,
          upsert: async () => loginMethod
        },
        credential: { count: async () => 0 }
      },
      permission: prisma
    }
  }
}

/** removeTestBindings deletes only this test process's uniquely prefixed principal rows. */
async function removeTestBindings() {
  await prisma.principalRoleBinding.deleteMany({
    where: { principalId: { startsWith: PREFIX } }
  })
}

/** createBinding inserts one test-owned system-admin binding with explicit canonical defaults. */
async function createBinding(principalId, overrides = {}) {
  return prisma.principalRoleBinding.create({
    data: {
      principalType: 'HUMAN',
      principalId,
      roleId: role.id,
      tenantId: null,
      scopeLevel: 'SYSTEM',
      effectiveAt: new Date('2026-09-10T00:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      createdByOperatorId: 'system-admin-seed-integration',
      grantAuditEventId: randomUUID(),
      ...overrides
    }
  })
}

before(async () => {
  const databaseUrl = process.env.OES_INTEGRATION_DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('TASK_OWNED_PERMISSION_DATABASE_REQUIRED')
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  assert.equal(prisma.accountRole, undefined)
  assert.equal(typeof prisma.principalRoleBinding.findMany, 'function')
  await prisma.$connect()
  role = await prisma.role.findUnique({
    where: {
      scopeKey_kind_code: {
        scopeKey: '__SYSTEM__',
        kind: 'SYSTEM_INSTANCE',
        code: 'system.admin'
      }
    }
  })
  if (!role) {
    role = await prisma.role.create({
      data: {
        tenantId: null,
        scopeKey: '__SYSTEM__',
        code: 'system.admin',
        name: 'System Administrator',
        kind: 'SYSTEM_INSTANCE',
        isProtected: true,
        isEnabled: true
      }
    })
    createdRole = true
  }
  assert.equal(role.tenantId, null)
  assert.equal(role.isEnabled, true)
})

after(async () => {
  if (!prisma) return
  await removeTestBindings()
  if (createdRole) await prisma.role.delete({ where: { id: role.id } })
  await prisma.$disconnect()
})

test('real generated Permission client converges partial apply, validates, and reuses one active binding', async () => {
  await removeTestBindings()
  const accountId = `${PREFIX}_partial`
  const { clients, config } = buildPartialStateClients(accountId)

  const first = await applySystemAdminSeed(clients, config, NOW)
  const firstValidation = await validateAppliedSystemAdminSeed(clients, config, NOW)
  const second = await applySystemAdminSeed(clients, config, NOW)
  const secondValidation = await validateAppliedSystemAdminSeed(clients, config, NOW)
  const bindings = await prisma.principalRoleBinding.findMany({
    where: {
      principalType: 'HUMAN',
      principalId: accountId,
      roleId: role.id,
      tenantId: null,
      scopeLevel: 'SYSTEM',
      revokedAt: null
    }
  })

  assert.equal(first.permission.operation, 'created')
  assert.equal(firstValidation.valid, true)
  assert.equal(second.permission.operation, 'unchanged')
  assert.equal(secondValidation.valid, true)
  assert.equal(bindings.length, 1)
  assert.equal(bindings[0]?.grantAuditEventId?.length > 0, true)
})

test('real Permission boundary reports missing, drifted, revoked, expired, and future bindings', async (t) => {
  const cases = [
    {
      name: 'missing',
      arrange: async () => undefined,
      error: /missing active/u
    },
    {
      name: 'drifted',
      arrange: async (accountId) =>
        createBinding(accountId, { scopeLevel: 'TENANT', tenantId: `${PREFIX}_tenant` }),
      error: /coordinate drift/u,
      applyError: /SYSTEM_ADMIN_SEED_PRINCIPAL_ROLE_BINDING_DRIFT/u
    },
    {
      name: 'revoked',
      arrange: async (accountId) =>
        createBinding(accountId, {
          revokedAt: new Date('2026-09-10T00:30:00.000Z'),
          revokedByOperatorId: 'integration-reviewer',
          revokeReason: 'integration lifecycle fixture',
          revokeAuditEventId: randomUUID()
        }),
      error: /is revoked/u
    },
    {
      name: 'expired',
      arrange: async (accountId) =>
        createBinding(accountId, { expiresAt: new Date('2026-09-10T00:30:00.000Z') }),
      error: /is expired/u
    },
    {
      name: 'future',
      arrange: async (accountId) =>
        createBinding(accountId, { effectiveAt: new Date('2026-09-10T02:00:00.000Z') }),
      error: /not yet effective/u,
      applyError: /SYSTEM_ADMIN_SEED_FUTURE_PRINCIPAL_ROLE_BINDING/u
    }
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await removeTestBindings()
      const accountId = `${PREFIX}_${fixture.name}`
      const { clients, config } = buildPartialStateClients(accountId)
      await fixture.arrange(accountId)
      const validation = await validateAppliedSystemAdminSeed(clients, config, NOW)
      assert.equal(validation.valid, false)
      assert.match(validation.errors.join('\n'), fixture.error)
      if (fixture.applyError) {
        await assert.rejects(() => applySystemAdminSeed(clients, config, NOW), fixture.applyError)
      }
    })
  }
})

test('real Permission exclusion constraint rejects a duplicate active canonical binding', async () => {
  await removeTestBindings()
  const accountId = `${PREFIX}_duplicate`
  await createBinding(accountId)

  await assert.rejects(() => createBinding(accountId))

  const count = await prisma.principalRoleBinding.count({
    where: { principalId: accountId, roleId: role.id }
  })
  assert.equal(count, 1)
})

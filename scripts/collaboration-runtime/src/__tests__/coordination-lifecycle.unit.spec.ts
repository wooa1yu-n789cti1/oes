import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, objectFingerprint, sha256 } from '../canonical.ts'
import {
  loadTrustedCoordinationLifecycleInventory,
  loadTrustedCoordinationLifecycleRosterAuthority,
  planCoordinationLifecycle,
  validateCoordinationLifecycleInventory,
  validateCoordinationLifecycleRosterAuthority
} from '../coordination-lifecycle.ts'
import { createCoordinationCleanupResultSet, planChildSelfCleanup } from '../cleanup.ts'
import { validateJsonSchema } from '../schema-validation.ts'
import { cleanupTrust, trustedCleanupAuthorization } from './helpers.ts'
import type {
  CoordinationLifecycleCreatedTask,
  CoordinationLifecycleRosterAuthority,
  CoordinationLifecycleTask
} from '../types.ts'

const fingerprint = 'a'.repeat(64)
const schema = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'schemas', name), 'utf8')
  ) as Record<string, unknown>

function authority(): CoordinationLifecycleRosterAuthority {
  const createdRoster: CoordinationLifecycleCreatedTask[] = [
    {
      taskId: '/root/co',
      taskKind: 'CO',
      ownerTaskId: null,
      creationReceiptFingerprint: fingerprint
    },
    {
      taskId: '/root/co/do-a',
      taskKind: 'DO',
      ownerTaskId: '/root/co',
      creationReceiptFingerprint: fingerprint
    },
    {
      taskId: '/root/co/do-b',
      taskKind: 'DO',
      ownerTaskId: '/root/co',
      creationReceiptFingerprint: fingerprint
    },
    {
      taskId: '/root/co/do-a/rv',
      taskKind: 'RV',
      ownerTaskId: '/root/co/do-a',
      creationReceiptFingerprint: fingerprint
    },
    {
      taskId: '/root/co/do-b/rv',
      taskKind: 'RV',
      ownerTaskId: '/root/co/do-b',
      creationReceiptFingerprint: fingerprint
    },
    {
      taskId: '/root/co/rv',
      taskKind: 'RV',
      ownerTaskId: '/root/co',
      creationReceiptFingerprint: fingerprint
    },
    {
      taskId: '/root/co/do-a/helper',
      taskKind: 'BOUNDED_HELPER',
      ownerTaskId: '/root/co/do-a',
      creationReceiptFingerprint: fingerprint
    }
  ]
  const value = {
    schemaVersion: 2 as const,
    kind: 'OES_COORDINATION_LIFECYCLE_ROSTER_AUTHORITY' as const,
    authorityFingerprint: '',
    coordinationKey: 'release',
    coordinationOwnerTaskId: '/root/co',
    transitionId: 'coordination:cleanup:1',
    coordinationCleanupAuthorizationFingerprint: 'b'.repeat(64),
    source: 'EXECUTION_NATIVE_CREATION_RECEIPTS' as const,
    createdRoster
  }
  return {
    ...value,
    authorityFingerprint: objectFingerprint(
      value as unknown as Record<string, unknown>,
      'authorityFingerprint'
    )
  }
}

test('closed coordination topology requires two DOs, each scoped RV, and one aggregate RV', () => {
  const value = authority()
  validateCoordinationLifecycleRosterAuthority(value)
  validateJsonSchema(schema('coordination-lifecycle-roster-authority.schema.json'), value)
  const missing = authority()
  missing.createdRoster = missing.createdRoster.filter((task) => task.taskId !== '/root/co/rv')
  missing.authorityFingerprint = objectFingerprint(
    missing as unknown as Record<string, unknown>,
    'authorityFingerprint'
  )
  assert.throws(() => validateCoordinationLifecycleRosterAuthority(missing), /AGGREGATE_RV_MISSING/)
})

test('archive planning reopens the exact complete cleanup result set before ARCHIVE_READY', () => {
  const cleanup = trustedCleanupAuthorization()
  const trust = cleanupTrust(cleanup)
  const persist = <T extends Record<string, unknown>>(
    value: T,
    field: keyof T & string,
    name: string
  ) => {
    value[field] = objectFingerprint(value, field) as T[keyof T & string]
    const path = join(trust.authorizationRoot, name)
    const bytes = `${canonicalJson(value)}\n`
    writeFileSync(path, bytes)
    return { path, sha256: sha256(bytes), fingerprint: String(value[field]) }
  }
  const results = Object.fromEntries([
    ...cleanup.terminalDeliveries.map((delivery) => [
      delivery.ownerTaskId,
      planChildSelfCleanup(
        cleanup,
        delivery.ownerTaskId,
        delivery.resources.map((resource) => ({
          ...resource,
          exists: false,
          clean: true,
          actualSha: null
        }))
      )
    ]),
    [
      cleanup.coordinationOwner.ownerTaskId,
      planChildSelfCleanup(
        cleanup,
        cleanup.coordinationOwner.ownerTaskId,
        cleanup.coordinationOwner.resources.map((resource) => ({
          ...resource,
          exists: false,
          clean: true,
          actualSha: null
        }))
      )
    ]
  ])
  const cleanupResult = createCoordinationCleanupResultSet(cleanup, results, [])
  const cleanupResultReference = persist(
    cleanupResult as unknown as Record<string, unknown>,
    'resultSetFingerprint',
    'cleanup-result.json'
  )
  const createdRoster: CoordinationLifecycleCreatedTask[] = [
    {
      taskId: '/root/co',
      taskKind: 'CO',
      ownerTaskId: null,
      creationReceiptFingerprint: fingerprint
    },
    ...cleanup.terminalDeliveries.flatMap((delivery) => [
      {
        taskId: delivery.ownerTaskId,
        taskKind: 'DO' as const,
        ownerTaskId: '/root/co',
        creationReceiptFingerprint: fingerprint
      },
      {
        taskId: `${delivery.ownerTaskId}/rv`,
        taskKind: 'RV' as const,
        ownerTaskId: delivery.ownerTaskId,
        creationReceiptFingerprint: fingerprint
      }
    ]),
    {
      taskId: '/root/co/rv',
      taskKind: 'RV',
      ownerTaskId: '/root/co',
      creationReceiptFingerprint: fingerprint
    }
  ]
  const roster = {
    schemaVersion: 2 as const,
    kind: 'OES_COORDINATION_LIFECYCLE_ROSTER_AUTHORITY' as const,
    authorityFingerprint: '',
    coordinationKey: cleanup.coordinationKey,
    coordinationOwnerTaskId: cleanup.coordinationOwnerTaskId,
    transitionId: cleanup.transitionId,
    coordinationCleanupAuthorizationFingerprint: cleanup.authorizationFingerprint,
    source: 'EXECUTION_NATIVE_CREATION_RECEIPTS' as const,
    createdRoster
  }
  const trustedRoster = loadTrustedCoordinationLifecycleRosterAuthority(
    persist(roster, 'authorityFingerprint', 'lifecycle-roster.json'),
    cleanup,
    trust
  )
  const readbackRoster = createdRoster.map(({ creationReceiptFingerprint: _, ...task }) => ({
    ...task,
    state: 'TERMINAL' as const
  }))
  const inventory = {
    schemaVersion: 2 as const,
    kind: 'OES_COORDINATION_LIFECYCLE_INVENTORY' as const,
    inventoryFingerprint: '',
    coordinationKey: cleanup.coordinationKey,
    coordinationOwnerTaskId: cleanup.coordinationOwnerTaskId,
    transitionId: cleanup.transitionId,
    coordinationCleanupAuthorizationFingerprint: cleanup.authorizationFingerprint,
    cleanupIntentDetected: true as const,
    coordinationExit: 'PASSED' as const,
    resourceCleanup: 'VERIFIED' as const,
    cleanupResult: cleanupResultReference,
    rosterAuthorityFingerprint: trustedRoster.authorityFingerprint,
    taskReadbackSource: 'CODEX_EXECUTION_NATIVE' as const,
    readbackRosterFingerprint: objectFingerprint(
      readbackRoster as unknown as Record<string, unknown>,
      '__none__'
    ),
    readbackRoster,
    terminalTaskIds: readbackRoster.map((task) => task.taskId)
  }
  const trustedInventory = loadTrustedCoordinationLifecycleInventory(
    persist(inventory, 'inventoryFingerprint', 'lifecycle-inventory.json'),
    trustedRoster,
    cleanup,
    trust
  )
  const lifecycle = planCoordinationLifecycle(trustedRoster, trustedInventory)
  assert.equal(lifecycle.status, 'ARCHIVE_READY')
  assert.equal(
    lifecycle.decisions
      .filter((decision) => decision.taskKind === 'RV')
      .every((decision) => decision.decision === 'SKIP_TERMINATED_SUBAGENT'),
    true
  )

  const missingProof = { ...inventory, cleanupResult: null, inventoryFingerprint: '' }
  missingProof.inventoryFingerprint = objectFingerprint(
    missingProof as unknown as Record<string, unknown>,
    'inventoryFingerprint'
  )
  assert.throws(
    () => validateCoordinationLifecycleInventory(trustedRoster, missingProof),
    /COORDINATION_LIFECYCLE_INVENTORY_INVALID/
  )
})

test('inventory binds every terminal task to the immutable creation roster', () => {
  const auth = authority()
  const readbackRoster: CoordinationLifecycleTask[] = auth.createdRoster.map(
    ({ creationReceiptFingerprint: _, ...task }) => ({ ...task, state: 'TERMINAL' })
  )
  const value = {
    schemaVersion: 2 as const,
    kind: 'OES_COORDINATION_LIFECYCLE_INVENTORY' as const,
    inventoryFingerprint: '',
    coordinationKey: auth.coordinationKey,
    coordinationOwnerTaskId: auth.coordinationOwnerTaskId,
    transitionId: auth.transitionId,
    coordinationCleanupAuthorizationFingerprint: auth.coordinationCleanupAuthorizationFingerprint,
    cleanupIntentDetected: true as const,
    coordinationExit: 'PASSED' as const,
    resourceCleanup: 'VERIFIED' as const,
    cleanupResult: {
      path: '/stable/authorization/cleanup-result.json',
      sha256: 'c'.repeat(64),
      fingerprint: 'd'.repeat(64)
    },
    rosterAuthorityFingerprint: auth.authorityFingerprint,
    taskReadbackSource: 'CODEX_EXECUTION_NATIVE' as const,
    readbackRosterFingerprint: objectFingerprint(
      readbackRoster as unknown as Record<string, unknown>,
      '__none__'
    ),
    readbackRoster,
    terminalTaskIds: readbackRoster.map((task) => task.taskId)
  }
  const inventory = {
    ...value,
    inventoryFingerprint: objectFingerprint(
      value as unknown as Record<string, unknown>,
      'inventoryFingerprint'
    )
  }
  validateCoordinationLifecycleInventory(auth, inventory)
  validateJsonSchema(schema('coordination-lifecycle-inventory.schema.json'), inventory)
  validateJsonSchema(schema('coordination-archive-result-set.schema.json'), {
    schemaVersion: 2,
    kind: 'OES_COORDINATION_ARCHIVE_RESULT_SET',
    resultSetFingerprint: 'c'.repeat(64),
    coordinationKey: auth.coordinationKey,
    coordinationOwnerTaskId: auth.coordinationOwnerTaskId,
    transitionId: auth.transitionId,
    coordinationCleanupAuthorizationFingerprint: auth.coordinationCleanupAuthorizationFingerprint,
    inventoryFingerprint: inventory.inventoryFingerprint,
    results: [
      {
        taskId: '/root/co/do-a/helper',
        taskKind: 'BOUNDED_HELPER',
        state: 'ARCHIVED',
        inventoryFingerprint: inventory.inventoryFingerprint,
        taskNativeReadbackFingerprint: 'd'.repeat(64),
        resultFingerprint: 'e'.repeat(64)
      }
    ]
  })
})

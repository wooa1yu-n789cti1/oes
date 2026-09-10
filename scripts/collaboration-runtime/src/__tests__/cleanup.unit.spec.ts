import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCoordinationCleanupAuthorization } from '../cleanup-binding.ts'
import {
  createCoordinationCleanupResultSet,
  planChildSelfCleanup,
  validateCoordinationCleanupResultSet,
  verifyChildCleanupResults,
  verifyCleanupProducesNoRepositoryDiff
} from '../cleanup.ts'
import { validateJsonSchema } from '../schema-validation.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cleanupAuthorization,
  trustedChildCleanupAuthorization,
  trustedCleanupAuthorization
} from './helpers.ts'
import { objectFingerprint } from '../canonical.ts'

const schema = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      'schemas',
      'coordination-cleanup-authorization.schema.json'
    ),
    'utf8'
  )
) as Record<string, unknown>
const resultSchema = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'schemas', 'coordination-cleanup-result-set.schema.json'),
    'utf8'
  )
) as Record<string, unknown>
const observation = (
  resource: ReturnType<
    typeof cleanupAuthorization
  >['terminalDeliveries'][number]['resources'][number],
  exists = true
) => ({ ...resource, exists, clean: true, actualSha: exists ? resource.expectedSha : null })

test('V2 cleanup authorization is terminal, owner-bound, and schema-valid', () => {
  const value = trustedCleanupAuthorization()
  validateCoordinationCleanupAuthorization(value)
  validateJsonSchema(schema, value)
})

test('child cleanup narrows to one exact DO and preserves dirty resources', () => {
  const value = trustedCleanupAuthorization()
  const delivery = value.terminalDeliveries[0]
  const observed = delivery.resources.map((resource) => observation(resource))
  observed[2].clean = false
  const plan = planChildSelfCleanup(value, delivery.ownerTaskId, observed)
  assert.equal(plan.filter((item) => item.decision === 'REMOVE').length, 4)
  assert.equal(plan.find((item) => item.resource.kind === 'worktree')?.decision, 'PRESERVE_FAILURE')
})

test('cleanup structurally permits no repository-content diff', () => {
  const value = trustedCleanupAuthorization()
  verifyCleanupProducesNoRepositoryDiff(value, [])
  assert.throws(
    () => verifyCleanupProducesNoRepositoryDiff(value, [{ status: 'D', path: 'docs/anything.md' }]),
    /CLEANUP_REPOSITORY_MUTATION_FORBIDDEN/
  )
})

test('coordination verification requires every child resource to be observed absent', () => {
  const value = trustedCleanupAuthorization()
  const results = Object.fromEntries([
    ...value.terminalDeliveries.map((delivery) => [
      delivery.ownerTaskId,
      planChildSelfCleanup(
        value,
        delivery.ownerTaskId,
        delivery.resources.map((resource) => observation(resource, false))
      )
    ]),
    [
      value.coordinationOwner.ownerTaskId,
      planChildSelfCleanup(
        value,
        value.coordinationOwner.ownerTaskId,
        value.coordinationOwner.resources.map((resource) => observation(resource, false))
      )
    ]
  ])
  verifyChildCleanupResults(value, results)
  results[value.terminalDeliveries[0].ownerTaskId][0].decision = 'PRESERVE_FAILURE'
  assert.throws(
    () => verifyChildCleanupResults(value, results),
    /COORDINATION_CLEANUP_PARTIAL_FAILURE/
  )
})

test('cleanup planning rejects a caller-resealed untrusted authorization', () => {
  const value = cleanupAuthorization()
  const delivery = value.terminalDeliveries[0]
  assert.throws(
    () =>
      planChildSelfCleanup(
        value,
        delivery.ownerTaskId,
        delivery.resources.map((resource) => observation(resource, false))
      ),
    /COORDINATION_CLEANUP_TRUSTED_AUTHORIZATION_REQUIRED/
  )
})

test('child cleanup reopens the exact current root, confirmation, and closed child envelope', () => {
  const trusted = trustedChildCleanupAuthorization()
  assert.equal(trusted.child.ownerTaskId, trusted.root.terminalDeliveries[0].ownerTaskId)
  assert.equal(trusted.child.confirmationFingerprint, trusted.root.confirmationFingerprint)

  assert.throws(
    () =>
      trustedChildCleanupAuthorization(cleanupAuthorization(), (child) => {
        child.rootAuthorization.fingerprint = 'f'.repeat(64)
      }),
    /COORDINATION_CHILD_CLEANUP_BINDING_MISMATCH/
  )
  assert.throws(
    () =>
      trustedChildCleanupAuthorization(cleanupAuthorization(), (child) => {
        child.confirmationFingerprint = 'f'.repeat(64)
      }),
    /COORDINATION_CHILD_CLEANUP_BINDING_MISMATCH/
  )
  assert.throws(
    () =>
      trustedChildCleanupAuthorization(cleanupAuthorization(), (child) => {
        ;(child as unknown as Record<string, unknown>).undeclared = true
      }),
    /CLEANUP_OBJECT_SHAPE_INVALID/
  )
})

test('trusted owner binding defeats /etc, arbitrary temp, aliases, and forged nested fingerprints', () => {
  for (const path of ['/etc', '/var/tmp/unrelated-cleanup']) {
    const value = cleanupAuthorization()
    const delivery = value.terminalDeliveries[0]
    const resource = delivery.resources.find(
      (item) => item.kind === (path === '/etc' ? 'worktree' : 'task-temp')
    )
    if (!resource) throw new Error('cleanup fixture resource absent')
    resource.path = path
    value.authorizationFingerprint = objectFingerprint(
      value as unknown as Record<string, unknown>,
      'authorizationFingerprint'
    )
    assert.throws(
      () => trustedCleanupAuthorization(value),
      /COORDINATION_CLEANUP_RESOURCE_NOT_OWNER_BOUND/
    )
  }

  const alias = cleanupAuthorization()
  const worktree = alias.terminalDeliveries[0].resources.find((item) => item.kind === 'worktree')
  if (!worktree) throw new Error('worktree fixture absent')
  worktree.path = `${worktree.path}/../owner`
  alias.authorizationFingerprint = objectFingerprint(
    alias as unknown as Record<string, unknown>,
    'authorizationFingerprint'
  )
  assert.throws(() => trustedCleanupAuthorization(alias), /CLEANUP_PATH_NOT_CANONICAL/)

  const forged = cleanupAuthorization()
  forged.terminalDeliveries[0].ownerResourceBinding.fingerprint = 'e'.repeat(64)
  forged.authorizationFingerprint = objectFingerprint(
    forged as unknown as Record<string, unknown>,
    'authorizationFingerprint'
  )
  assert.throws(
    () => trustedCleanupAuthorization(forged),
    /OWNER_RESOURCE_BINDING_REFERENCE_MISMATCH/
  )
})

test('cleanup verification requires the complete CO aggregate resource result set', () => {
  const value = trustedCleanupAuthorization()
  const results = Object.fromEntries(
    value.terminalDeliveries.map((delivery) => [
      delivery.ownerTaskId,
      planChildSelfCleanup(
        value,
        delivery.ownerTaskId,
        delivery.resources.map((resource) => observation(resource, false))
      )
    ])
  )
  assert.throws(
    () => verifyChildCleanupResults(value, results),
    /COORDINATION_CLEANUP_CHILD_SET_MISMATCH/
  )
})

test('cleanup loader rejects a bound owner target replaced by a physical symlink alias', () => {
  const value = cleanupAuthorization()
  const worktree = value.terminalDeliveries[0].resources.find((item) => item.kind === 'worktree')
  if (!worktree) throw new Error('worktree fixture absent')
  mkdirSync(join(worktree.path, '..'), { recursive: true })
  const nonOwnerRoot = mkdtempSync(join(tmpdir(), 'oes-cleanup-non-owner-'))
  try {
    symlinkSync(nonOwnerRoot, worktree.path)
    assert.throws(() => trustedCleanupAuthorization(value), /OWNER_RESOURCE_PHYSICAL_PATH_ALIAS/)
  } finally {
    rmSync(nonOwnerRoot, { recursive: true, force: true })
  }

  const loaded = trustedCleanupAuthorization()
  const delivery = loaded.terminalDeliveries[0]
  const loadedWorktree = delivery.resources.find((item) => item.kind === 'worktree')
  if (!loadedWorktree) throw new Error('loaded worktree fixture absent')
  mkdirSync(join(loadedWorktree.path, '..'), { recursive: true })
  const lateAliasRoot = mkdtempSync(join(tmpdir(), 'oes-cleanup-late-alias-'))
  try {
    symlinkSync(lateAliasRoot, loadedWorktree.path)
    assert.throws(
      () =>
        planChildSelfCleanup(
          loaded,
          delivery.ownerTaskId,
          delivery.resources.map((resource) => observation(resource))
        ),
      /OWNER_RESOURCE_PHYSICAL_PATH_ALIAS/
    )
  } finally {
    rmSync(lateAliasRoot, { recursive: true, force: true })
  }
})

test('cleanup result set seals the exact child-plus-CO absence and zero-diff proof', () => {
  const value = trustedCleanupAuthorization()
  const results = Object.fromEntries([
    ...value.terminalDeliveries.map((delivery) => [
      delivery.ownerTaskId,
      planChildSelfCleanup(
        value,
        delivery.ownerTaskId,
        delivery.resources.map((resource) => observation(resource, false))
      )
    ]),
    [
      value.coordinationOwner.ownerTaskId,
      planChildSelfCleanup(
        value,
        value.coordinationOwner.ownerTaskId,
        value.coordinationOwner.resources.map((resource) => observation(resource, false))
      )
    ]
  ])
  const result = createCoordinationCleanupResultSet(value, results, [])
  validateCoordinationCleanupResultSet(value, result)
  validateJsonSchema(resultSchema, result)
  const missingOwner = structuredClone(result)
  delete missingOwner.resultsByOwner[value.coordinationOwner.ownerTaskId]
  missingOwner.resultSetFingerprint = objectFingerprint(
    missingOwner as unknown as Record<string, unknown>,
    'resultSetFingerprint'
  )
  assert.throws(
    () => validateCoordinationCleanupResultSet(value, missingOwner),
    /COORDINATION_CLEANUP_CHILD_SET_MISMATCH/
  )
})

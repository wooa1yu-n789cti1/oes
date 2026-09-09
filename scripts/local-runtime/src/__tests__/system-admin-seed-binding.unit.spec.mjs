import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson, fingerprint } from '../canonical.mjs'
import {
  buildSystemAdminSeedInvocation,
  buildSystemAdminSeedRuntimeBinding,
  runSystemAdminSeed,
  verifySystemAdminSeedRuntimeBinding
} from '../bootstrap.mjs'
import { createSystemAdminSeedManifestFixture, SYSTEM_ADMIN_FIXTURE_TARGETS } from './system-admin-seed-test-fixture.mjs'

test('system-admin binding derives exact dynamic runtime owners without embedding credential values', () => {
  const fixture = createSystemAdminSeedManifestFixture()
  const resolved = buildSystemAdminSeedRuntimeBinding(fixture.file)
  assert.equal(resolved.binding.taskKey, fixture.taskKey)
  assert.equal(resolved.binding.runId, fixture.runId)
  assert.equal(resolved.binding.postgres.port, '35432')
  for (const [key, target] of Object.entries(SYSTEM_ADMIN_FIXTURE_TARGETS)) {
    assert.equal(resolved.binding.targets[key].owner, target.owner)
    assert.equal(resolved.binding.targets[key].database, fixture.resources.find((resource) => resource.owner === target.owner).database)
    assert.equal(resolved.binding.targets[key].credentialReference.owner, target.owner)
    assert.equal(resolved.binding.targets[key].credentialReference.path, fixture.credentialReference.path)
  }
  for (const secret of fixture.secrets) assert.doesNotMatch(canonicalJson(resolved.binding), new RegExp(secret, 'u'))
})

test('system-admin binding reopens DEV runtime credentials and allocations only through Stack manifest authority', () => {
  const fixture = createSystemAdminSeedManifestFixture({ profile: 'DEV', taskKey: 'system_admin_dev_task', runId: 'system_admin_dev_run' })
  const resolved = buildSystemAdminSeedRuntimeBinding(fixture.file)
  assert.equal(resolved.binding.profile, 'DEV')
  assert.equal(resolved.binding.postgres.source, 'STACK')
  assert.equal(resolved.binding.targets.identityService.credentialReference.path, fixture.credentialReference.path)
  assert.match(resolved.binding.targets.identityService.database, /^oes_[a-f0-9]{12}_identity_service$/u)
  for (const secret of fixture.secrets) assert.doesNotMatch(canonicalJson(resolved.binding), new RegExp(secret, 'u'))
})

test('system-admin binding rejects forged values, task drift, port drift, and owner/database crossover', () => {
  const fixture = createSystemAdminSeedManifestFixture()
  const invocation = buildSystemAdminSeedInvocation(fixture.file, { root: '/repo', mode: 'dry-run' })
  const supplied = JSON.parse(invocation.environment.OES_SYSTEM_ADMIN_SEED_BINDING)
  assert.equal(verifySystemAdminSeedRuntimeBinding(fixture.file, supplied, invocation.environment).binding.bindingFingerprint, supplied.bindingFingerprint)

  const forged = structuredClone(supplied)
  forged.targets.identityService.database = 'oes_forged_identity_service'
  forged.bindingFingerprint = fingerprint(forged, 'bindingFingerprint')
  assert.throws(() => verifySystemAdminSeedRuntimeBinding(fixture.file, forged, invocation.environment), /SYSTEM_ADMIN_SEED_BINDING_MANIFEST_MISMATCH/u)

  assert.throws(
    () => verifySystemAdminSeedRuntimeBinding(fixture.file, supplied, { ...invocation.environment, OES_TASK_KEY: 'different_task' }),
    /SYSTEM_ADMIN_SEED_TASK_IDENTITY_MISMATCH key=OES_TASK_KEY/u
  )
  assert.throws(
    () => verifySystemAdminSeedRuntimeBinding(fixture.file, supplied, { ...invocation.environment, OES_IDENTITY_DATABASE_URL: invocation.environment.OES_IDENTITY_DATABASE_URL.replace(':35432/', ':45432/') }),
    /SYSTEM_ADMIN_SEED_DATABASE_BINDING_MISMATCH owner=identity-service/u
  )
  assert.throws(
    () => verifySystemAdminSeedRuntimeBinding(fixture.file, supplied, { ...invocation.environment, OES_IDENTITY_DATABASE_URL: invocation.environment.OES_AUTH_DATABASE_URL }),
    /SYSTEM_ADMIN_SEED_DATABASE_BINDING_MISMATCH owner=identity-service/u
  )
})

test('system-admin binding rejects a manifest-derived non-loopback PostgreSQL endpoint', () => {
  const fixture = createSystemAdminSeedManifestFixture({ host: 'db.example.invalid' })
  assert.throws(() => buildSystemAdminSeedRuntimeBinding(fixture.file), /SYSTEM_ADMIN_SEED_POSTGRES_ENDPOINT_INVALID/u)
})

test('system-admin binding recomputes V2 logical identity instead of trusting manifest owner labels', () => {
  const fixture = createSystemAdminSeedManifestFixture({ logicalIdentityMismatchOwner: 'identity-service' })
  assert.throws(() => buildSystemAdminSeedRuntimeBinding(fixture.file), /SYSTEM_ADMIN_SEED_LOGICAL_IDENTITY_MISMATCH owner=identity-service/u)
})

test('apply and validate invocations share one manifest authority and keep secrets out of results', () => {
  const fixture = createSystemAdminSeedManifestFixture()
  const calls = []
  const runner = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0, stdout: '{"sanitized":true}\n', stderr: '' }
  }
  const apply = runSystemAdminSeed(fixture.file, { root: '/repo', mode: 'apply', runner })
  const validate = runSystemAdminSeed(fixture.file, { root: '/repo', mode: 'validate', runner })
  assert.deepEqual(calls.map(({ args }) => args), [
    ['scripts/local/seed-system-admin.mjs', '--apply'],
    ['scripts/local/seed-system-admin.mjs', '--validate']
  ])
  assert.equal(apply.manifest.fingerprint, validate.manifest.fingerprint)
  assert.equal(apply.bindingFingerprint, validate.bindingFingerprint)
  assert.equal(calls[0].options.env.OES_SYSTEM_ADMIN_SEED_BINDING, calls[1].options.env.OES_SYSTEM_ADMIN_SEED_BINDING)
  for (const secret of fixture.secrets) assert.doesNotMatch(JSON.stringify({ apply, validate }), new RegExp(secret, 'u'))
})

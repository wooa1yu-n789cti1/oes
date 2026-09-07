import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { integrationCapabilities, integrationEnvironmentForOwner, resolveIntegrationTaskKey, selectDeclaredRuntimeOwners, withIntegrationRuntime } from './integration-runtime.mjs'

const root = path.resolve(import.meta.dirname, '../../..')

test('integration task identity never reads a worktree dotenv file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-integration-owner-'))
  fs.writeFileSync(path.join(directory, '.env'), 'OES_TASK_KEY=foreign_worktree_owner\n')
  assert.equal(resolveIntegrationTaskKey(directory, 'ci_owner', 'fallback'), 'ci_owner')
  assert.equal(resolveIntegrationTaskKey(directory, undefined, 'fallback'), 'fallback')
})

test('integration capability planning is explicit and owner-derived', () => {
  assert.deepEqual(integrationCapabilities(['permission-service']), [])
  assert.deepEqual(integrationCapabilities(['notification-service', 'collaboration-service']), ['events', 'network-trust'])
  assert.deepEqual(integrationCapabilities(['asset-service']), ['object-store'])
})

test('integration runtime excludes package-only owners and runs their tests without infrastructure', async () => {
  const declarations = { owners: { 'permission-service': {}, 'notification-service': {}, 'collaboration-service': {} } }
  assert.deepEqual(selectDeclaredRuntimeOwners(['@oes/pda-web', 'permission-service', '@oes/pda-web'], declarations), ['permission-service'])
  assert.deepEqual(selectDeclaredRuntimeOwners(['notification-service'], declarations), ['collaboration-service', 'notification-service'])
  let runtimeCalled = false
  const result = await withIntegrationRuntime({
    root,
    ownerNames: ['@oes/meilong-ceramics-site'],
    taskKey: 'fixture_task',
    runTests: async (environmentForOwner) => {
      assert.deepEqual(environmentForOwner('@oes/meilong-ceramics-site'), {})
      return [0]
    },
    adapters: {
      declarations,
      withRuntime() { runtimeCalled = true }
    }
  })
  assert.deepEqual(result, [0])
  assert.equal(runtimeCalled, false)
})

test('notification Integration gets its consumer identity plus one explicit Collaboration publisher fixture', () => {
  const reference = { path: '/fixture/nats.json' }
  const manifest = {
    profile: 'CI',
    taskKey: 'fixture_task',
    runId: 'run_fixture',
    devStackId: 'machine_fixture',
    owners: ['collaboration-service', 'notification-service'],
    endpoints: [{ provider: 'nats', owners: ['collaboration-service', 'notification-service'], environment: { NATS_URL: 'nats://127.0.0.1:4222' }, credentialReference: reference }]
  }
  const environment = integrationEnvironmentForOwner(manifest, 'notification-service', (_reference, owner) => owner === 'notification-service'
    ? { NATS_USER: 'notification', NATS_PASSWORD: 'consumer-password', NATS_NOTIFICATION_USER: 'notification', NATS_NOTIFICATION_PASSWORD: 'consumer-password' }
    : { NATS_USER: 'collaboration', NATS_PASSWORD: 'publisher-password', NATS_COLLABORATION_USER: 'collaboration', NATS_COLLABORATION_PASSWORD: 'publisher-password' })
  assert.equal(environment.NATS_USER, 'notification')
  assert.equal(environment.NATS_PASSWORD, 'consumer-password')
  assert.equal(environment.NATS_COLLABORATION_USER, 'collaboration')
  assert.equal(environment.NATS_COLLABORATION_PASSWORD, 'publisher-password')
})

test('integration runtime uses the unified core, minimal owner environments and abnormal reconciliation', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-integration-runtime-'))
  const failure = new Error('test failure sentinel')
  let migrationManifest
  await assert.rejects(withIntegrationRuntime({
    root,
    ownerNames: ['permission-service'],
    taskKey: 'fixture_task',
    runTests: async (environmentForOwner) => {
      const environment = environmentForOwner('permission-service')
      assert.equal(environment.OES_TASK_KEY, 'fixture_task')
      assert.equal(environment.OES_RUN_ID, 'run_fixture')
      assert.equal(environment.OES_POSTGRES_CREDENTIAL.startsWith('secret-'), true)
      assert.equal(environment.NATS_PASSWORD, undefined)
      throw failure
    },
    adapters: {
      profile: 'LOCAL_INTEGRATION',
      stateRoot,
      runId: 'run_fixture',
      driver: 'simulation',
      applyCommittedMigrations(manifestPath) { migrationManifest = manifestPath }
    }
  }), failure)
  assert.equal(migrationManifest.endsWith('/manifest.json'), true)
  const cleanup = JSON.parse(fs.readFileSync(path.join(path.dirname(migrationManifest), 'cleanup.json'), 'utf8'))
  assert.equal(cleanup.result, 'RECONCILED')
})

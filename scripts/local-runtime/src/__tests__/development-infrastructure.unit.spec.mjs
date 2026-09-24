import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ensureDevelopmentInfrastructure,
  inspectDevInfrastructureContainers
} from '../../ensure-dev-infrastructure.mjs'
import { assertAllocationContainer } from '../development-backup.mjs'

const labels = {
  'oes.runtime.version': '2',
  'oes.runtime.stack-key': 'oes-local-fixture',
  'oes.runtime.dev-stack-id': 'fixture',
  'oes.runtime.scope': 'SHARED',
  'oes.runtime.pool': 'dev',
  'oes.runtime.provider': 'postgres'
}

const container = {
  provider: 'postgres',
  pool: 'dev',
  scope: 'SHARED',
  kind: 'container',
  name: 'oes-fixture-postgres',
  objectId: 'a'.repeat(64),
  labels
}

const database = {
  provider: 'postgres',
  pool: 'dev',
  scope: 'SHARED',
  containerScope: 'SHARED',
  kind: 'database',
  containerName: container.name,
  containerObjectId: container.objectId
}

const resolveManifestResources = () => [container, database]
const observed = (running = true) => ({
  Id: container.objectId,
  Name: `/${container.name}`,
  Config: { Labels: labels },
  State: { Running: running }
})

function missingContainer(reference) {
  const error = new Error('missing')
  error.status = 1
  error.stderr = `Error: No such container: ${reference}`
  return error
}

test('same-ID stopped DEV containers are classified for recovery instead of reuse', () => {
  assert.deepEqual(
    inspectDevInfrastructureContainers({ pool: 'dev' }, {
      resolveManifestResources,
      inspectContainer: () => observed(false)
    }),
    {
      status: 'STOPPED',
      containerCount: 1,
      stoppedProviders: ['postgres']
    }
  )
})

test('wrong-ID and missing DEV containers fail closed', () => {
  assert.throws(
    () => inspectDevInfrastructureContainers({ pool: 'dev' }, {
      resolveManifestResources,
      inspectContainer: (reference) => {
        if (reference === container.objectId) throw missingContainer(reference)
        return { ...observed(), Id: 'b'.repeat(64) }
      }
    }),
    /DEV_INFRA_CONTAINER_IDENTITY_MISMATCH provider=postgres/u
  )

  assert.throws(
    () => inspectDevInfrastructureContainers({ pool: 'dev' }, {
      resolveManifestResources,
      inspectContainer: (reference) => { throw missingContainer(reference) }
    }),
    /DEV_INFRA_CONTAINER_MISSING provider=postgres/u
  )
})

function startedFixture({ ready = true } = {}) {
  const releases = []
  return {
    releases,
    started: {
      file: '/state/new/manifest.json',
      manifest: {
        manifestFingerprint: 'new-fingerprint',
        plan: { providers: ['postgres'] },
        endpoints: [{ provider: 'postgres', allocationProvider: 'postgres', ready }]
      },
      context: {},
      releaseSlot: () => releases.push('slot'),
      releaseRunLock: () => releases.push('run'),
      releaseDevLock: () => releases.push('dev')
    }
  }
}

test('stopped recovery failure and unready provisioning never produce INFRA_READY', async () => {
  const previous = { manifest: {}, manifestPath: '/state/old/manifest.json' }
  await assert.rejects(
    ensureDevelopmentInfrastructure({
      rootDirectory: '/repo',
      stateRoot: '/state',
      owners: ['postgres-owner'],
      findRegistered: () => previous,
      inspectContainers: () => ({ status: 'STOPPED', stoppedProviders: ['postgres'] }),
      start: async () => { throw new Error('fixture restart failed') },
      retire: () => assert.fail('failed recovery must not retire the previous registration')
    }),
    /fixture restart failed/u
  )

  const unready = startedFixture({ ready: false })
  await assert.rejects(
    ensureDevelopmentInfrastructure({
      rootDirectory: '/repo',
      stateRoot: '/state',
      owners: ['postgres-owner'],
      findRegistered: () => previous,
      inspectContainers: () => ({ status: 'STOPPED', stoppedProviders: ['postgres'] }),
      start: async () => unready.started,
      retire: () => assert.fail('unready replacement must not retire the previous registration')
    }),
    /DEV_INFRA_PROVIDER_NOT_READY provider=postgres/u
  )
  assert.deepEqual(unready.releases, ['slot', 'run', 'dev'])
})

test('same-ID stopped registration is recovered through normal provider provisioning', async () => {
  const previous = { manifest: {}, manifestPath: '/state/old/manifest.json' }
  const replacement = startedFixture()
  let retired = false
  const result = await ensureDevelopmentInfrastructure({
    rootDirectory: '/repo',
    stateRoot: '/state',
    owners: ['postgres-owner'],
    findRegistered: () => previous,
    inspectContainers: () => ({ status: 'STOPPED', stoppedProviders: ['postgres'] }),
    start: async (intent) => {
      assert.equal(intent.driver, 'docker')
      assert.equal(intent.profile, 'DEV')
      return replacement.started
    },
    retire: () => { retired = true }
  })
  assert.equal(result.reused, true)
  assert.equal(result.recovered, true)
  assert.deepEqual(result.recoveredProviders, ['postgres'])
  assert.equal(retired, true)
  assert.deepEqual(replacement.releases, ['slot', 'run', 'dev'])
})

test('active registration is revalidated and reused only after all providers report ready', async () => {
  const previous = { manifest: {}, manifestPath: '/state/old/manifest.json' }
  const active = startedFixture()
  let retired = false
  const progress = []
  const result = await ensureDevelopmentInfrastructure({
    rootDirectory: '/repo',
    stateRoot: '/state',
    owners: ['postgres-owner'],
    findRegistered: () => previous,
    inspectContainers: () => ({ status: 'ACTIVE', stoppedProviders: [] }),
    start: async (_intent, adapters) => {
      await adapters.afterProgressPublished({ provider: 'postgres' })
      return active.started
    },
    retire: (selected, replacement) => {
      assert.equal(selected, previous)
      assert.equal(replacement, active.started)
      retired = true
    },
    onProgress: (event) => progress.push(event)
  })
  assert.equal(result.reused, true)
  assert.equal(result.recovered, false)
  assert.deepEqual(result.providers, ['postgres'])
  assert.equal(retired, true)
  assert.deepEqual(active.releases, ['slot', 'run', 'dev'])
  assert.deepEqual(progress.map((event) => event.stage), [
    'INFRASTRUCTURE_REVALIDATE',
    'PROVIDER_READY'
  ])
})

test('backup container errors distinguish identity drift, stopped state, and absence', () => {
  assert.throws(
    () => assertAllocationContainer(database, {
      inspectContainer: () => ({ ...observed(), Id: 'b'.repeat(64) })
    }),
    /DEV_BACKUP_CONTAINER_IDENTITY_MISMATCH kind=database/u
  )
  assert.throws(
    () => assertAllocationContainer(database, {
      inspectContainer: () => observed(false)
    }),
    /DEV_BACKUP_CONTAINER_NOT_RUNNING kind=database/u
  )
  assert.throws(
    () => assertAllocationContainer(database, {
      inspectContainer: (reference) => { throw missingContainer(reference) }
    }),
    /DEV_BACKUP_CONTAINER_MISSING kind=database/u
  )
})

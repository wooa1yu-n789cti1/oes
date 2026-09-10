import assert from 'node:assert/strict'
import test from 'node:test'
import { assertDockerIdentity, canRecoverMissingSharedTestContainer, isMissingDockerObject, runtimeLabels, sharedResourceName, validateSharedContainerAuthority } from '../docker-driver.mjs'

/** Builds canonical shared TEST identity plus its sealed Stack authority for focused drift tests. */
function sharedTestFixture(provider = 'postgres') {
  const context = { profile: 'LOCAL_INTEGRATION', pool: 'test', stackKey: 'oes-local-0123456789abcdef', devStackId: 'machine_0123456789abcdef_fixture' }
  const labels = runtimeLabels(context, 'SHARED', provider)
  const name = sharedResourceName(context.devStackId, context.pool, provider)
  const identity = {
    cleanup: 'PRESERVE_SHARED',
    kind: 'container',
    labels,
    name,
    objectId: 'a'.repeat(64),
    provider,
    publishedPorts: { 5432: 35432 },
    scope: 'SHARED',
    volume: { createdAt: '2026-09-11T00:00:00Z', driver: 'local', labels: structuredClone(labels), name: `${name}-data`, objectId: 'b'.repeat(64), scope: 'local' }
  }
  const stackManifest = { lifecycle: 'REGISTERED', stackKey: context.stackKey, devStackId: context.devStackId, resources: [{ ...structuredClone(identity), pool: context.pool, allocationProvider: provider }] }
  return { context, identity, stackManifest }
}

test('shared provider absence recovery is limited to exact LOCAL_INTEGRATION test containers', () => {
  const missing = Object.assign(new Error('COMMAND_FAILED command=docker exit=1'), {
    status: 1,
    stderr: 'Error response from daemon: No such container: fixture-test-postgres\n'
  })

  assert.equal(isMissingDockerObject(missing, 'container'), true)
  assert.equal(canRecoverMissingSharedTestContainer({ profile: 'LOCAL_INTEGRATION', pool: 'test' }, missing), true)
  assert.equal(canRecoverMissingSharedTestContainer({ profile: 'DEV', pool: 'dev' }, missing), false)
  assert.equal(canRecoverMissingSharedTestContainer({ profile: 'LOCAL_INTEGRATION', pool: 'test' }, Object.assign(new Error('daemon unavailable'), { status: 1, stderr: 'Cannot connect to the Docker daemon' })), false)
})

test('missing Docker volume recognition does not accept identity drift', () => {
  const missing = Object.assign(new Error('COMMAND_FAILED command=docker exit=1'), {
    status: 1,
    stderr: 'Error response from daemon: get fixture-test-postgres-data: no such volume\n'
  })

  assert.equal(isMissingDockerObject(missing, 'volume'), true)
  assert.equal(isMissingDockerObject(Object.assign(new Error('legacy text'), { status: 1, stderr: 'Error response from daemon: No such volume: fixture-test-postgres-data\n' }), 'volume'), true)
  assert.equal(isMissingDockerObject(Object.assign(new Error('drift'), { status: 1, stderr: 'volume identity mismatch' }), 'volume'), false)
})

test('shared container authority accepts only the exact canonical identity joined to current Stack truth', () => {
  const { context, identity, stackManifest } = sharedTestFixture()
  assert.deepEqual(validateSharedContainerAuthority(context, 'postgres', identity, stackManifest, { ports: [5432], volumeTarget: '/var/lib/postgresql/data' }), identity)
})

test('shared container authority rejects every tampered top-level identity field before Docker access', () => {
  const cases = [
    ['name', 'foreign-container'],
    ['provider', 'minio'],
    ['scope', 'RUN'],
    ['kind', 'volume'],
    ['cleanup', 'DELETE_EXACT'],
    ['objectId', 'not-a-docker-id']
  ]
  for (const [field, value] of cases) {
    const { context, identity, stackManifest } = sharedTestFixture()
    identity[field] = value
    assert.throws(() => validateSharedContainerAuthority(context, 'postgres', identity, stackManifest, { ports: [5432], volumeTarget: '/data' }), /SHARED_CONTAINER_(?:IDENTITY|OBJECT_ID)_INVALID/u, field)
  }
  const { context, identity, stackManifest } = sharedTestFixture()
  identity.unsealed = true
  assert.throws(() => validateSharedContainerAuthority(context, 'postgres', identity, stackManifest, { ports: [5432], volumeTarget: '/data' }), /SHARED_CONTAINER_IDENTITY_SHAPE_INVALID/u)
})

test('shared container authority rejects incomplete, foreign, and extra context labels', () => {
  for (const mutate of [
    (labels) => { delete labels['oes.runtime.stack-key'] },
    (labels) => { labels['oes.runtime.pool'] = 'dev' },
    (labels) => { labels['oes.runtime.unsealed'] = 'true' }
  ]) {
    const { context, identity, stackManifest } = sharedTestFixture()
    mutate(identity.labels)
    assert.throws(() => validateSharedContainerAuthority(context, 'postgres', identity, stackManifest, { ports: [5432], volumeTarget: '/data' }), /SHARED_CONTAINER_LABELS_INVALID/u)
  }
})

test('shared container authority rejects non-canonical volume identity and volume shape', () => {
  const cases = [
    (volume) => { volume.name = 'foreign-volume' },
    (volume) => { volume.objectId = 'not-a-volume-fingerprint' },
    (volume) => { volume.labels['oes.runtime.provider'] = 'minio' },
    (volume) => { volume.driver = 'foreign-driver' },
    (volume) => { volume.unsealed = true }
  ]
  for (const mutate of cases) {
    const { context, identity, stackManifest } = sharedTestFixture()
    mutate(identity.volume)
    assert.throws(() => validateSharedContainerAuthority(context, 'postgres', identity, stackManifest, { ports: [5432], volumeTarget: '/data' }), /SHARED_CONTAINER_VOLUME_IDENTITY_INVALID/u)
  }
  {
    const { context, identity, stackManifest } = sharedTestFixture()
    identity.volume = null
    assert.throws(() => validateSharedContainerAuthority(context, 'postgres', identity, stackManifest, { ports: [5432], volumeTarget: '/data' }), /SHARED_CONTAINER_VOLUME_IDENTITY_INVALID/u)
  }
  {
    const { context, identity, stackManifest } = sharedTestFixture()
    assert.throws(() => validateSharedContainerAuthority(context, 'postgres', identity, stackManifest, { ports: [5432] }), /SHARED_CONTAINER_VOLUME_UNEXPECTED/u)
  }
})

test('shared container authority rejects identity-to-Stack drift and ambiguous authority', () => {
  for (const mutate of [
    (resource) => { resource.objectId = 'c'.repeat(64) },
    (resource) => { resource.name = 'foreign-container' },
    (resource) => { resource.volume.objectId = 'd'.repeat(64) }
  ]) {
    const { context, identity, stackManifest } = sharedTestFixture()
    mutate(stackManifest.resources[0])
    assert.throws(() => validateSharedContainerAuthority(context, 'postgres', identity, stackManifest, { ports: [5432], volumeTarget: '/data' }), /SHARED_CONTAINER_STACK_AUTHORITY_MISMATCH/u)
  }
  {
    const { context, identity, stackManifest } = sharedTestFixture()
    stackManifest.resources.push(structuredClone(stackManifest.resources[0]))
    assert.throws(() => validateSharedContainerAuthority(context, 'postgres', identity, stackManifest, { ports: [5432], volumeTarget: '/data' }), /SHARED_CONTAINER_STACK_AUTHORITY_INVALID/u)
  }
  {
    const { context, identity, stackManifest } = sharedTestFixture()
    stackManifest.devStackId = 'machine_foreign'
    assert.throws(() => validateSharedContainerAuthority(context, 'postgres', identity, stackManifest, { ports: [5432], volumeTarget: '/data' }), /SHARED_CONTAINER_STACK_IDENTITY_INVALID/u)
  }
})

test('Docker identity reopens by sealed object ID and treats rename drift as non-recoverable', () => {
  const { context, identity } = sharedTestFixture()
  let inspected
  const renamed = assert.throws(() => assertDockerIdentity(identity, (selector) => {
    inspected = selector
    return { Id: identity.objectId, Name: '/renamed-but-still-present', Config: { Labels: { ...identity.labels, 'image.vendor': 'fixture' } } }
  }), /RESOURCE_NAME_MISMATCH/u)
  assert.equal(inspected, identity.objectId)
  assert.equal(canRecoverMissingSharedTestContainer(context, renamed), false)

  const observed = assertDockerIdentity(identity, (selector) => ({ Id: selector, Name: `/${identity.name}`, Config: { Labels: { ...identity.labels, 'image.vendor': 'fixture' } } }))
  assert.equal(observed.Id, identity.objectId)
})

test('Docker identity requires the complete exact runtime label set after object-ID reopen', () => {
  const { identity } = sharedTestFixture()
  assert.throws(() => assertDockerIdentity(identity, (selector) => ({ Id: selector, Name: `/${identity.name}`, Config: { Labels: { ...identity.labels, 'oes.runtime.unsealed': 'true' } } })), /RESOURCE_LABEL_MISMATCH/u)
})

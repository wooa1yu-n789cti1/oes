import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fingerprint, sha256, writeAtomic } from '../canonical.mjs'
import { publishStackManifest, reopenCurrentStackManifest } from '../manifest.mjs'
import { activateStagedState, canonicalHostBindSource, inventoryStateLayout, migrationReplacementName, planStateLayoutMigration, recoverStateLayout, reopenJournal, rollbackCommittedState, sealProviderHostnameDependencies, stageStateLayoutMigration, verifyProviderDependencyProjection } from '../state-migration.mjs'
import { resolveRuntimeLayout } from '../state-layout.mjs'
import { trustedProcessEnvironment } from '../trusted-runtime-config.mjs'

const seed = '0'.repeat(64)
const hostBinding = { kind: 'fixture-v1', value: 'migration-host' }
const providerLifecycle = {
  activate: (binds, { journal }) => binds.map((bind) => {
    const labels = { 'oes.runtime.version': '2', 'oes.runtime.stack-key': journal.stackKey, 'oes.runtime.dev-stack-id': journal.devStackId, 'oes.runtime.scope': 'SHARED', 'oes.runtime.pool': 'test', 'oes.runtime.provider': 'postgres' }
    return { oldObjectId: bind.objectId, newObjectId: 'object-b', oldName: bind.name, newName: migrationReplacementName(journal.devStackId, 'test', 'postgres'), backupName: 'postgres-retained', provider: 'postgres', pool: 'test', labels, networks: [], dependencyAliases: [], binds: [{ oldSource: bind.source, source: bind.nextSource, destination: bind.destination }], observedWasRunning: false, restoreWasRunning: true, replacementWasRunning: true, disposition: 'FIXTURE_RESTARTED' }
  }),
  stop: () => {},
  restart: () => {}
}
const zeroQuiescence = () => ({ activeRunCount: 0, activeStackLeaseCount: 0, runningDevProcessCount: 0, semaphoreTicketCount: 0, controlLockCount: 0, allocationAdmissionCount: 0, runningBindCount: 0 })
const skipProviderDependencyReopen = () => true

function fixture({ pool = 'test', volume = null, createPlan = true } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-state-migration-'))
  const stateRoot = path.join(parent, 'runtime-v2')
  const provider = path.join(stateRoot, 'shared', 'fixture_machine', 'postgres')
  fs.mkdirSync(provider, { recursive: true })
  writeAtomic(path.join(stateRoot, 'machine', 'dev-stack.json'), { schemaVersion: 2, devStackId: 'fixture_machine' })
  const labels = { 'oes.runtime.version': '2', 'oes.runtime.dev-stack-id': 'fixture_machine', 'oes.runtime.scope': 'SHARED', 'oes.runtime.pool': pool, 'oes.runtime.provider': 'postgres' }
  writeAtomic(path.join(provider, 'identity.json'), { provider: 'postgres', kind: 'container', scope: 'SHARED', name: 'postgres-a', objectId: 'object-a', labels, ...(volume ? { volume } : {}) })
  if (pool === 'dev') writeAtomic(path.join(provider, 'owners', 'owner-a.json'), { database: 'service_dev', migrator: 'fixture_migrator', migratorPassword: 'fixture', runtime: 'fixture_runtime', runtimePassword: 'fixture' }, 0o600)
  writeAtomic(path.join(stateRoot, 'restore', 'restore-confirmation.json'), { kind: 'OES_DEV_RESTORE_CONFIRMATION', status: 'CONFIRMED' })
  const dockerObjects = [
    { objectId: 'object-a', name: 'postgres-a', running: false, labels, mounts: [{ Type: 'bind', Source: path.join(provider, 'data'), Destination: '/data' }, ...(volume ? [{ Type: 'volume', Name: volume.name, Destination: '/var/lib/postgresql/data' }] : [])] },
    ...(volume ? [{ type: 'volume', objectId: volume.objectId, name: volume.name, labels: volume.labels, mounts: [] }] : [])
  ]
  const inventory = inventoryStateLayout({ stateRoot, dockerObjects })
  const providerSnapshots = [{ resource: { provider: 'postgres', kind: 'container', scope: 'SHARED', pool, objectId: 'object-a', name: 'postgres-a', labels, ...(volume ? { volume } : {}) }, endpoint: { provider: 'postgres', pool, ready: true, authority: 'docker:object-a:5432/tcp', environment: { OES_POSTGRES_PORT: '5432' } } }]
  const plan = createPlan ? planStateLayoutMigration(inventory, { providerSnapshots }) : null
  return { stateRoot, inventory, plan, providerSnapshots, dockerObjects }
}

/** Builds two SHARED providers with one exact container-environment hostname dependency. */
function dependencyFixture({ hostname = 'postgres-a', dependentEnvironment = null, targetNetworks = ['fixture-network'], dependentNetworks = ['fixture-network'], extraTargets = [] } = {}) {
  const base = fixture({ createPlan: false })
  const network = (name, aliases = []) => ({ name, aliases })
  base.dockerObjects[0].networks = targetNetworks.map((name) => network(name, ['postgres']))
  const dependentLabels = { 'oes.runtime.version': '2', 'oes.runtime.dev-stack-id': 'fixture_machine', 'oes.runtime.scope': 'SHARED', 'oes.runtime.pool': 'test', 'oes.runtime.provider': 'nacos' }
  const dependentRoot = path.join(base.stateRoot, 'shared', 'fixture_machine', 'nacos')
  writeAtomic(path.join(dependentRoot, 'identity.json'), { provider: 'nacos', kind: 'container', scope: 'SHARED', name: 'nacos-a', objectId: 'nacos-a', labels: dependentLabels })
  const dependent = { objectId: 'nacos-a', name: 'nacos-a', running: true, labels: dependentLabels, mounts: [], networks: dependentNetworks.map((name) => network(name, ['nacos'])), environment: dependentEnvironment || [`DATABASE_HOST=${hostname}`] }
  const providerSnapshots = [...base.providerSnapshots, { resource: { provider: 'nacos', kind: 'container', scope: 'SHARED', pool: 'test', objectId: 'nacos-a', name: 'nacos-a', labels: dependentLabels }, endpoint: { provider: 'nacos', pool: 'test', ready: true, authority: 'docker:nacos-a:8848/tcp', environment: { NACOS_SERVER: '127.0.0.1:8848' } } }]
  const dockerObjects = [...base.dockerObjects, dependent]
  for (const target of extraTargets) {
    const targetRoot = path.join(base.stateRoot, 'shared', 'fixture_machine', target.provider)
    writeAtomic(path.join(targetRoot, 'identity.json'), { provider: target.provider, kind: 'container', scope: 'SHARED', name: target.name, objectId: target.objectId, labels: target.labels })
    dockerObjects.push(target.object)
    providerSnapshots.push({ resource: { provider: target.provider, kind: 'container', scope: 'SHARED', pool: 'test', objectId: target.objectId, name: target.name, labels: target.labels }, endpoint: { provider: target.provider, pool: 'test', ready: true, authority: `docker:${target.objectId}:1234/tcp`, environment: {} } })
  }
  const inventory = inventoryStateLayout({ stateRoot: base.stateRoot, dockerObjects })
  return { ...base, inventory, dockerObjects, providerSnapshots, plan: planStateLayoutMigration(inventory, { providerSnapshots }) }
}

function confirmation(kind, journal) {
  const raw = { schemaVersion: 3, kind, status: 'CONFIRMED', journalFingerprint: journal.journalFingerprint }
  return { ...raw, confirmationFingerprint: fingerprint(raw) }
}

test('Darwin canonicalization covers every exact Docker Desktop host-mount alias and preserves raw evidence', () => {
  const base = fixture({ createPlan: false })
  const provider = path.join(base.stateRoot, 'shared', 'fixture_machine', 'postgres')
  const mounts = Array.from({ length: 7 }, (_, index) => {
    const source = path.join(provider, `bind-${index}`)
    fs.mkdirSync(source)
    return { Type: 'bind', Source: [2, 6].includes(index) ? `/host_mnt${source}` : source, Destination: `/fixture-${index}` }
  })
  const dockerObjects = [{ ...base.dockerObjects[0], mounts }]
  const inventory = inventoryStateLayout({ stateRoot: base.stateRoot, dockerObjects, hostPlatform: 'darwin' })
  const plan = planStateLayoutMigration(inventory, { providerSnapshots: base.providerSnapshots })
  assert.equal(plan.coverage.bindCount, 7)
  assert.equal(plan.binds.length, 7)
  assert.deepEqual(plan.binds.map((bind) => bind.source), mounts.map((mount) => canonicalHostBindSource(mount.Source, { platform: 'darwin' })))
  assert.deepEqual(inventory.dockerObjects[0].mounts.filter((mount) => mount.SourceRepresentation === 'DOCKER_DESKTOP_HOST_MNT').map((mount) => mount.RawSource), [mounts[2].Source, mounts[6].Source])
})

test('Linux keeps /host_mnt literal while retaining ordinary bind-source behavior', () => {
  const base = fixture({ createPlan: false })
  const direct = path.join(base.stateRoot, 'shared', 'fixture_machine', 'postgres', 'data')
  const alias = `/host_mnt${direct}`
  const dockerObjects = [{ ...base.dockerObjects[0], mounts: [{ Type: 'bind', Source: `${direct}/`, Destination: '/direct' }, { Type: 'bind', Source: alias, Destination: '/literal-host-mnt' }] }]
  const inventory = inventoryStateLayout({ stateRoot: base.stateRoot, dockerObjects, hostPlatform: 'linux' })
  assert.equal(canonicalHostBindSource(alias, { platform: 'linux' }), path.resolve(alias))
  assert.deepEqual(inventory.binds.map((bind) => bind.destination), ['/direct'])
  assert.equal(inventory.dockerObjects[0].mounts.find((mount) => mount.Destination === '/direct').SourceRepresentation, 'HOST_PATH')
  assert.equal(inventory.dockerObjects[0].mounts.find((mount) => mount.Destination === '/literal-host-mnt').Source, path.resolve(alias))
  assert.equal(inventory.dockerObjects[0].mounts.find((mount) => mount.Destination === '/literal-host-mnt').SourceRepresentation, 'HOST_PATH')
})

test('Darwin ambiguous or unmappable host-mount aliases fail closed with the raw source', () => {
  const base = fixture({ createPlan: false })
  const existing = path.join(base.stateRoot, 'shared', 'fixture_machine', 'postgres')
  for (const source of ['/host_mnt', '/host_mnt/', '/host_mnt/Users/../private', `/host_mnt${existing}/`, `/host_mnt${path.join(os.tmpdir(), `oes-missing-${crypto.randomUUID()}`)}`]) {
    assert.throws(() => canonicalHostBindSource(source, { platform: 'darwin', requireExisting: true }), (error) => /STATE_MIGRATION_BIND_SOURCE_(?:AMBIGUOUS|UNMAPPABLE)/u.test(error.message) && error.message.includes(JSON.stringify(source)))
  }
  const canonical = canonicalHostBindSource(`/host_mnt${existing}`, { platform: 'darwin', requireExisting: true })
  assert.equal(canonicalHostBindSource(canonical, { platform: 'darwin', requireExisting: true }), canonical)
  const dockerObjects = [{ ...base.dockerObjects[0], mounts: [{ Type: 'bind', Source: '/host_mnt/Users/../private', Destination: '/data' }] }]
  assert.throws(() => inventoryStateLayout({ stateRoot: base.stateRoot, dockerObjects, hostPlatform: 'darwin' }), /rawSource="\/host_mnt\/Users\/\.\.\/private"/u)
})

test('controlled rename windows retain sealed Darwin alias identity without requiring the old source to exist', () => {
  const base = fixture({ createPlan: false })
  const oldSource = path.join(base.stateRoot, 'shared', 'fixture_machine', 'postgres', 'removed-data')
  const rawSource = `/host_mnt${oldSource}`
  const dockerObjects = [{ ...base.dockerObjects[0], mounts: [{ Type: 'bind', Source: rawSource, Destination: '/data' }] }]
  assert.throws(() => inventoryStateLayout({ stateRoot: base.stateRoot, dockerObjects, hostPlatform: 'darwin' }), /STATE_MIGRATION_BIND_SOURCE_UNMAPPABLE/u)
  const lifecycleInventory = inventoryStateLayout({ stateRoot: base.stateRoot, dockerObjects, hostPlatform: 'darwin', requireBindSourceExisting: false })
  assert.deepEqual(lifecycleInventory.binds, [{ objectId: 'object-a', name: 'postgres-a', running: false, source: oldSource, destination: '/data' }])
  assert.equal(lifecycleInventory.dockerObjects[0].mounts[0].RawSource, rawSource)
})

test('Darwin alias identity remains exact through activation, committed recovery, and rollback records', async () => {
  const base = fixture({ createPlan: false })
  const provider = path.join(base.stateRoot, 'shared', 'fixture_machine', 'postgres')
  const oldSource = path.join(provider, 'data')
  fs.mkdirSync(oldSource)
  const dockerObjects = [{ ...base.dockerObjects[0], mounts: [{ Type: 'bind', Source: `/host_mnt${oldSource}`, Destination: '/data' }] }]
  const inventory = inventoryStateLayout({ stateRoot: base.stateRoot, dockerObjects, hostPlatform: 'darwin' })
  const plan = planStateLayoutMigration(inventory, { providerSnapshots: base.providerSnapshots })
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  const events = []
  const lifecycle = {
    activate: (binds, { journal }) => binds.map((bind) => {
      assert.equal(bind.source, oldSource)
      assert.equal(bind.nextSource, path.join(journal.oldRoot, 'stacks', journal.stackKey, 'providers', 'test', 'postgres', 'data'))
      const labels = { 'oes.runtime.version': '2', 'oes.runtime.stack-key': journal.stackKey, 'oes.runtime.dev-stack-id': journal.devStackId, 'oes.runtime.scope': 'SHARED', 'oes.runtime.pool': 'test', 'oes.runtime.provider': 'postgres' }
      return { oldObjectId: bind.objectId, newObjectId: 'object-b', oldName: bind.name, newName: migrationReplacementName(journal.devStackId, 'test', 'postgres'), backupName: 'postgres-retained', provider: 'postgres', pool: 'test', labels, networks: [], dependencyAliases: [], binds: [{ oldSource: bind.source, source: bind.nextSource, destination: bind.destination }], observedWasRunning: false, restoreWasRunning: true, replacementWasRunning: true, disposition: 'FIXTURE_RESTARTED' }
    }),
    stop: (records) => events.push({ operation: 'stop', binds: records.flatMap((record) => record.binds) }),
    restart: (records) => events.push({ operation: 'restart', binds: records.flatMap((record) => record.binds) })
  }
  const committed = activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), verifyProviderReadiness: () => true, verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: zeroQuiescence, providerLifecycle: lifecycle })
  assert.equal(recoverStateLayout({ journalPath: staged.journalPath, verifyProviderReadiness: () => true, verifyProviderMappings: () => true, verifyProviderDependencyIdentities: skipProviderDependencyReopen, providerLifecycle: lifecycle }).authority, 'NEW')
  const rolledBack = rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: zeroQuiescence, providerLifecycle: lifecycle })
  assert.equal(rolledBack.state, 'ROLLED_BACK')
  assert.deepEqual(events.map((event) => event.operation), ['stop', 'restart'])
  assert.equal(events.every((event) => event.binds.every((bind) => bind.oldSource === oldSource && bind.source.startsWith(`${base.stateRoot}${path.sep}`))), true)
})

test('planning seals exact inter-provider hostnames and journals the replacement alias contract', async () => {
  const migrated = dependencyFixture()
  assert.deepEqual(migrated.plan.providerDependencies, [{
    dependentObjectId: 'nacos-a',
    dependentName: 'nacos-a',
    dependentProvider: 'nacos',
    dependentPool: 'test',
    dependentWasRunning: true,
    environmentKey: 'DATABASE_HOST',
    hostname: 'postgres-a',
    targetObjectId: 'object-a',
    targetName: 'postgres-a',
    targetProvider: 'postgres',
    targetPool: 'test',
    networks: ['fixture-network']
  }])
  assert.equal(migrated.plan.coverage.providerDependencyCount, 1)
  const staged = await stageStateLayoutMigration(migrated.plan, migrated.inventory, { identitySeed: seed, hostBinding })
  assert.deepEqual(staged.journal.providerDependencies, migrated.plan.providerDependencies)
  const authorities = []
  const lifecycle = {
    activate: (binds, { journal }) => binds.map((bind) => ({
      oldObjectId: bind.objectId,
      newObjectId: 'object-b',
      oldName: bind.name,
      newName: migrationReplacementName(journal.devStackId, 'test', 'postgres'),
      backupName: 'postgres-retained',
      provider: 'postgres',
      pool: 'test',
      labels: { ...migrated.providerSnapshots[0].resource.labels, 'oes.runtime.stack-key': journal.stackKey },
      networks: [{ network: 'fixture-network', aliases: ['postgres', 'postgres-a'] }],
      dependencyAliases: [{ network: 'fixture-network', hostname: 'postgres-a', dependentObjectId: 'nacos-a', environmentKey: 'DATABASE_HOST' }],
      binds: [{ oldSource: bind.source, source: bind.nextSource, destination: bind.destination }],
      observedWasRunning: false,
      restoreWasRunning: true,
      replacementWasRunning: true
    })),
    stop: () => {},
    restart: () => {}
  }
  const verifyProviderDependencyIdentities = (_journal, authority) => { authorities.push(authority); return true }
  const committed = activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), verifyProviderReadiness: () => true, verifyProviderDependencyIdentities, observeQuiescence: zeroQuiescence, providerLifecycle: lifecycle })
  assert.equal(recoverStateLayout({ journalPath: staged.journalPath, verifyProviderReadiness: () => true, verifyProviderMappings: () => true, verifyProviderDependencyIdentities, providerLifecycle: lifecycle }).authority, 'NEW')
  assert.equal(rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), verifyProviderDependencyIdentities, observeQuiescence: zeroQuiescence, providerLifecycle: lifecycle }).state, 'ROLLED_BACK')
  assert.deepEqual(authorities, ['OLD', 'NEW', 'NEW', 'NEW', 'OLD'])
})

test('provider hostname planning fails closed for ambiguous, unmapped, conflicting, or stale scans', () => {
  const labels = { 'oes.runtime.version': '2', 'oes.runtime.dev-stack-id': 'fixture_machine', 'oes.runtime.scope': 'SHARED', 'oes.runtime.pool': 'test', 'oes.runtime.provider': 'mysql-shadow' }
  const shadow = { provider: 'mysql-shadow', name: 'shadow-a', objectId: 'shadow-a', labels, object: { objectId: 'shadow-a', name: 'shadow-a', running: false, labels, mounts: [], networks: [{ name: 'fixture-network', aliases: ['postgres-a'] }], environment: [] } }
  assert.throws(() => dependencyFixture({ extraTargets: [shadow] }), /STATE_MIGRATION_PROVIDER_DEPENDENCY_AMBIGUOUS/u)
  assert.throws(() => dependencyFixture({ dependentNetworks: ['other-network'] }), /STATE_MIGRATION_PROVIDER_DEPENDENCY_UNMAPPED/u)
  assert.throws(() => dependencyFixture({ dependentEnvironment: ['DATABASE_HOST=postgres-a', 'DATABASE_HOST=postgres'] }), /STATE_MIGRATION_PROVIDER_DEPENDENCY_CONFLICT/u)
  const stale = dependencyFixture()
  delete stale.inventory.providerDependencyScanVersion
  delete stale.inventory.inventoryFingerprint
  stale.inventory.inventoryFingerprint = fingerprint(stale.inventory)
  assert.throws(() => planStateLayoutMigration(stale.inventory, { providerSnapshots: stale.providerSnapshots }), /STATE_MIGRATION_PROVIDER_DEPENDENCY_SCAN_REQUIRED/u)
  const projectionDrift = dependencyFixture()
  projectionDrift.inventory.providerDependencies = []
  delete projectionDrift.inventory.inventoryFingerprint
  projectionDrift.inventory.inventoryFingerprint = fingerprint(projectionDrift.inventory)
  assert.throws(() => planStateLayoutMigration(projectionDrift.inventory, { providerSnapshots: projectionDrift.providerSnapshots }), /STATE_MIGRATION_PROVIDER_DEPENDENCY_SCAN_STALE/u)
})

test('dependency inventory is secret-free and live projection freshness is exact', async () => {
  const migrated = dependencyFixture({ dependentEnvironment: ['DATABASE_HOST=postgres-a', 'DATABASE_PASSWORD=secret-value'] })
  const sealedDependent = migrated.inventory.providerDependencyObjects.find((object) => object.objectId === 'nacos-a')
  assert.deepEqual(sealedDependent.environment, ['DATABASE_HOST=postgres-a'])
  assert.equal(JSON.stringify(migrated.inventory).includes('secret-value'), false)
  const staged = await stageStateLayoutMigration(migrated.plan, migrated.inventory, { identitySeed: seed, hostBinding })
  assert.equal(verifyProviderDependencyProjection(staged.journal, 'OLD', migrated.dockerObjects), true)
  const liveDrift = structuredClone(migrated.dockerObjects)
  liveDrift.find((object) => object.objectId === 'nacos-a').environment.push('SECONDARY_HOST=postgres-a')
  assert.throws(() => verifyProviderDependencyProjection(staged.journal, 'OLD', liveDrift), /STATE_MIGRATION_PROVIDER_DEPENDENCY_SCAN_STALE/u)
  const runningDrift = structuredClone(migrated.dockerObjects)
  runningDrift.find((object) => object.objectId === 'nacos-a').running = false
  assert.throws(() => verifyProviderDependencyProjection(staged.journal, 'OLD', runningDrift), /STATE_MIGRATION_PROVIDER_DEPENDENCY_REOPEN_MISMATCH/u)
})

test('dependency discovery rejects self and same-provider per-network alias owners', () => {
  const migrated = dependencyFixture()
  const selfAlias = structuredClone(migrated.dockerObjects)
  selfAlias.find((object) => object.objectId === 'nacos-a').networks[0].aliases.push('postgres-a')
  assert.throws(() => sealProviderHostnameDependencies(selfAlias), /STATE_MIGRATION_PROVIDER_DEPENDENCY_AMBIGUOUS/u)
  const sameProviderLabels = { ...migrated.dockerObjects.find((object) => object.objectId === 'object-a').labels }
  const sameProvider = { objectId: 'postgres-shadow', name: 'postgres-shadow', running: false, labels: sameProviderLabels, mounts: [], networks: [{ name: 'fixture-network', aliases: ['postgres-a'] }], environment: [] }
  assert.throws(() => sealProviderHostnameDependencies([...migrated.dockerObjects, sameProvider]), /STATE_MIGRATION_PROVIDER_DEPENDENCY_AMBIGUOUS/u)
})

test('staging creates a sibling canonical Stack, invalidates restore binding, and leaves old root byte-exact', async () => {
  const { stateRoot, inventory, plan } = fixture()
  const before = inventory.sourceTreeFingerprint
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  assert.equal(inventoryStateLayout({ stateRoot }).sourceTreeFingerprint, before)
  assert.equal(staged.journal.state, 'PREPARED')
  assert.equal(path.dirname(plan.stagedRoot), path.dirname(stateRoot))
  assert.equal(fs.existsSync(path.join(staged.layout.stackRoot, 'providers', 'test', 'postgres', 'identity.json')), true)
  assert.equal(fs.existsSync(path.join(staged.layout.stackRoot, 'restore', 'restore-confirmation.json')), false)
  assert.equal(fs.existsSync(path.join(staged.layout.stackRoot, 'restore', 'invalidated', 'restore-confirmation.json')), true)
})

test('fault after OLD_MOVED recovers old authority and quarantines the staged tree', async () => {
  const { stateRoot, inventory, plan } = fixture()
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  const approved = confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal)
  assert.throws(() => activateStagedState({ journalPath: staged.journalPath, confirmation: approved, faultAt: 'after-old-moved', verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: zeroQuiescence }), /STATE_MIGRATION_FAULT_AFTER_OLD_MOVED/)
  assert.equal(reopenJournal(staged.journalPath).state, 'OLD_MOVED')
  const recovered = recoverStateLayout({ journalPath: staged.journalPath, verifyProviderDependencyIdentities: skipProviderDependencyReopen })
  assert.equal(recovered.authority, 'OLD')
  assert.equal(fs.existsSync(path.join(stateRoot, 'machine', 'dev-stack.json')), true)
  assert.equal(fs.existsSync(recovered.quarantine), true)
  assert.equal(recoverStateLayout({ journalPath: staged.journalPath, verifyProviderDependencyIdentities: skipProviderDependencyReopen }).state, 'RECOVERED_OLD')
})

test('recovery closes both rename-before-journal crash windows idempotently', async () => {
  for (const crashWindow of ['OLD_RENAME_ONLY', 'BOTH_RENAMES']) {
    const { stateRoot, inventory, plan } = fixture()
    const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
    fs.renameSync(stateRoot, plan.rollbackRoot)
    if (crashWindow === 'BOTH_RENAMES') fs.renameSync(plan.stagedRoot, stateRoot)
    const recovered = recoverStateLayout({ journalPath: staged.journalPath, verifyProviderDependencyIdentities: skipProviderDependencyReopen })
    assert.equal(recovered.authority, 'OLD')
    assert.equal(fs.existsSync(path.join(stateRoot, 'machine', 'dev-stack.json')), true)
    assert.equal(fs.existsSync(recovered.quarantine), true)
    assert.equal(recoverStateLayout({ journalPath: staged.journalPath, verifyProviderDependencyIdentities: skipProviderDependencyReopen }).state, 'RECOVERED_OLD')
  }
})

test('COMMITTED activation keeps new authority and confirmed rollback restores the old tree', async () => {
  const { stateRoot, inventory, plan } = fixture()
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  const durability = []
  const committed = activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), verifyNewRoot: (root) => fs.existsSync(path.join(root, 'stack-registry.json')), verifyProviderReadiness: () => true, verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: zeroQuiescence, providerLifecycle, onDurabilityStep: (step) => { assert.equal(reopenJournal(staged.journalPath).state, 'NEW_PLACED'); durability.push(step) } })
  assert.equal(committed.state, 'COMMITTED')
  assert.deepEqual(durability, ['RELOCATED_POINTER_DIRECTORY_SYNCED', 'MANIFEST_DIRECTORY_SYNCED', 'STACK_POINTER_DIRECTORY_SYNCED', 'STACK_PUBLICATION_REOPENED'])
  assert.throws(() => recoverStateLayout({ journalPath: staged.journalPath, verifyProviderReadiness: () => true, verifyProviderMappings: () => false, verifyProviderDependencyIdentities: skipProviderDependencyReopen }), /STATE_MIGRATION_COMMITTED_PROVIDER_VERIFICATION_FAILED/)
  assert.equal(recoverStateLayout({ journalPath: staged.journalPath, verifyProviderReadiness: () => true, verifyProviderMappings: () => true, verifyProviderDependencyIdentities: skipProviderDependencyReopen }).authority, 'NEW')
  const activatedStackRoot = path.join(stateRoot, 'stacks', staged.layout.stackKey)
  const current = reopenCurrentStackManifest(activatedStackRoot).manifest
  const laterDraft = { ...current }
  for (const key of ['schemaVersion', 'kind', 'generation', 'stackManifestFingerprint']) delete laterDraft[key]
  const later = publishStackManifest(activatedStackRoot, laterDraft)
  assert.equal(Number(later.manifest.generation) > Number(committed.activatedStackManifestReference.generation), true)
  assert.equal(recoverStateLayout({ journalPath: staged.journalPath, verifyProviderReadiness: () => true, verifyProviderMappings: () => true, verifyProviderDependencyIdentities: skipProviderDependencyReopen }).authority, 'NEW')
  const rolledBack = rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: zeroQuiescence, providerLifecycle })
  assert.equal(rolledBack.state, 'ROLLED_BACK')
  assert.equal(fs.existsSync(path.join(stateRoot, 'machine', 'dev-stack.json')), true)
  assert.equal(fs.existsSync(rolledBack.retainedNewRoot), true)
  assert.equal(rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: zeroQuiescence, providerLifecycle }).state, 'ROLLED_BACK')
})

test('failure after bind-provider activation stops it before root rollback and restarts retained old identity', async () => {
  const { stateRoot, inventory, plan } = fixture()
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  const events = []
  const lifecycle = {
    activate: (binds) => { events.push('activate'); return binds.map((bind) => ({ objectId: bind.objectId, source: bind.nextSource, destination: bind.destination })) },
    stop: () => events.push('stop'),
    restart: () => events.push('restart')
  }
  assert.throws(() => activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), faultAt: 'after-provider-activation', verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: zeroQuiescence, providerLifecycle: lifecycle }), /STATE_MIGRATION_FAULT_AFTER_PROVIDER_ACTIVATION/)
  const recovered = recoverStateLayout({ journalPath: staged.journalPath, verifyProviderDependencyIdentities: skipProviderDependencyReopen, providerLifecycle: lifecycle })
  assert.equal(recovered.authority, 'OLD')
  assert.deepEqual(events, ['activate', 'stop', 'restart'])
  assert.equal(fs.existsSync(path.join(stateRoot, 'machine', 'dev-stack.json')), true)
})

test('active leases and running old-root binds block staging before any sibling tree exists', async () => {
  const { stateRoot, providerSnapshots, dockerObjects } = fixture()
  writeAtomic(path.join(stateRoot, 'leases', 'fixture_machine', 'active.json'), { taskKey: 'task_a' })
  dockerObjects[0].running = true
  const inventory = inventoryStateLayout({ stateRoot, dockerObjects })
  const plan = planStateLayoutMigration(inventory, { providerSnapshots })
  assert.equal(plan.quiescence.activeStackLeaseCount, 1)
  assert.equal(plan.quiescence.runningBindCount, 1)
  await assert.rejects(stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding }), /STATE_MIGRATION_QUIESCENCE_REQUIRED/)
  assert.equal(fs.existsSync(plan.stagedRoot), false)
})

test('DEV data requires an external byte-reopenable snapshot before planning', () => {
  const volumeLabels = { 'oes.runtime.version': '2', 'oes.runtime.dev-stack-id': 'fixture_machine', 'oes.runtime.scope': 'SHARED', 'oes.runtime.pool': 'dev', 'oes.runtime.provider': 'postgres' }
  const volume = { name: 'postgres-data', objectId: 'volume-a', labels: volumeLabels }
  const { stateRoot, inventory, providerSnapshots: baseSnapshots, dockerObjects } = fixture({ pool: 'dev', volume, createPlan: false })
  const providerSnapshots = [...baseSnapshots, { resource: { provider: 'postgres', kind: 'database', scope: 'SHARED', pool: 'dev', database: 'service_dev', containerName: 'postgres-a', containerObjectId: 'object-a' } }]
  assert.throws(() => planStateLayoutMigration(inventory, { providerSnapshots }), /STATE_MIGRATION_DEV_BACKUP_REFERENCE_INVALID/)
  const archive = path.join(path.dirname(stateRoot), 'service_dev.dump')
  fs.writeFileSync(archive, 'fixture-backup')
  const raw = { schemaVersion: 3, kind: 'OES_DEV_STATE_BACKUP', devStackId: 'fixture_machine', sourcesPreserved: true, backups: [{ kind: 'database', database: 'service_dev', containerName: 'postgres-a', containerObjectId: 'object-a', file: archive, sha256: sha256(fs.readFileSync(archive)) }] }
  const record = { ...raw, backupFingerprint: fingerprint(raw) }
  const recordPath = path.join(path.dirname(stateRoot), 'backup-record.json')
  writeAtomic(recordPath, record)
  const bytes = fs.readFileSync(recordPath)
  const reference = { type: 'OES_DEV_STATE_BACKUP', path: recordPath, sha256: sha256(bytes), fingerprint: record.backupFingerprint }
  const planned = planStateLayoutMigration(inventory, { providerSnapshots, devBackupReference: reference })
  assert.equal(planned.devBackupReference.fingerprint, record.backupFingerprint)
  assert.deepEqual(planned.devDataCarriers, [{ provider: 'postgres', kind: 'database', logicalName: 'service_dev', containerName: 'postgres-a', containerObjectId: 'object-a' }])
  writeAtomic(path.join(stateRoot, 'shared', 'fixture_machine', 'postgres', 'owners', 'owner-b.json'), { database: 'second_dev', migrator: 'fixture_migrator_b', migratorPassword: 'fixture', runtime: 'fixture_runtime_b', runtimePassword: 'fixture' }, 0o600)
  const expandedInventory = inventoryStateLayout({ stateRoot, dockerObjects })
  assert.throws(() => planStateLayoutMigration(expandedInventory, { providerSnapshots, devBackupReference: reference }), /STATE_MIGRATION_DEV_DATA_CARRIER_SNAPSHOT_COVERAGE_MISMATCH/)
})

test('planning rejects unknown root entries and provider trees without exact snapshot coverage', () => {
  const unknown = fixture()
  fs.writeFileSync(path.join(unknown.stateRoot, 'unmapped-important.json'), '{}')
  const unknownInventory = inventoryStateLayout({ stateRoot: unknown.stateRoot, dockerObjects: unknown.dockerObjects })
  assert.throws(() => planStateLayoutMigration(unknownInventory, { providerSnapshots: unknown.providerSnapshots }), /STATE_MIGRATION_UNRESOLVED_ENTRY/)

  const uncovered = fixture()
  assert.throws(() => planStateLayoutMigration(uncovered.inventory, { providerSnapshots: [] }), /STATE_MIGRATION_PROVIDER_SNAPSHOT_COVERAGE_REQUIRED/)
  assert.throws(() => planStateLayoutMigration(uncovered.inventory, { providerSnapshots: uncovered.providerSnapshots.map(({ resource }) => ({ resource })) }), /STATE_MIGRATION_PROVIDER_ENDPOINT_COVERAGE_REQUIRED/)
})

test('migration planning preserves distinct Redis ACL users through the shared Stack identity contract', () => {
  const migrated = fixture()
  const acl = (user, objectId) => ({ resource: { provider: 'redis', kind: 'acl-user', scope: 'SHARED', pool: 'test', user, namespace: `oes:${user}`, objectId } })
  const plan = planStateLayoutMigration(migrated.inventory, { providerSnapshots: [...migrated.providerSnapshots, acl('user_alpha', 'acl-alpha'), acl('user_beta', 'acl-beta')] })
  assert.deepEqual(plan.providerSnapshots.filter((snapshot) => snapshot.resource?.kind === 'acl-user').map((snapshot) => snapshot.resource.user), ['user_alpha', 'user_beta'])
  assert.throws(() => planStateLayoutMigration(migrated.inventory, { providerSnapshots: [...migrated.providerSnapshots, acl('user_alpha', 'acl-alpha'), acl('user_alpha', 'acl-beta')] }), /STATE_MIGRATION_PROVIDER_RESOURCE_DUPLICATE/)
})

test('inventory preserves non-bind Docker objects and planning requires their exact coverage', () => {
  const base = fixture()
  const labels = base.providerSnapshots[0].resource.labels
  const dockerObjects = [...base.dockerObjects, { type: 'network', objectId: 'orphan-network', name: 'orphan-network', labels }, { type: 'volume', objectId: 'orphan-volume', name: 'orphan-volume', labels }]
  const inventory = inventoryStateLayout({ stateRoot: base.stateRoot, dockerObjects })
  assert.deepEqual(inventory.dockerObjects.map((object) => object.objectId).sort(), ['object-a', 'orphan-network', 'orphan-volume'])
  assert.throws(() => planStateLayoutMigration(inventory, { providerSnapshots: base.providerSnapshots }), /STATE_MIGRATION_DOCKER_OBJECT_COVERAGE_REQUIRED/)
})

test('planning requires complete SHARED V2 labels and reopens retired credential bytes', () => {
  const missingLabels = fixture()
  const invalidSnapshots = structuredClone(missingLabels.providerSnapshots)
  delete invalidSnapshots[0].resource.labels['oes.runtime.provider']
  assert.throws(() => planStateLayoutMigration(missingLabels.inventory, { providerSnapshots: invalidSnapshots }), /STATE_MIGRATION_REQUIRED_LABEL_MISMATCH/)

  const credentialFixture = fixture()
  const credentialPath = path.join(credentialFixture.stateRoot, 'shared', 'fixture_machine', 'postgres', 'credentials.json')
  const credentialRaw = { schemaVersion: 2, provider: 'postgres', ownerEnvironments: { 'owner-a': { DATABASE_URL: 'postgresql://fixture' } } }
  const credential = { ...credentialRaw, credentialFingerprint: fingerprint(credentialRaw) }
  writeAtomic(credentialPath, credential, 0o600)
  const credentialBytes = fs.readFileSync(credentialPath)
  const providerSnapshots = structuredClone(credentialFixture.providerSnapshots)
  providerSnapshots[0].endpoint.owners = ['owner-a']
  providerSnapshots[0].endpoint.credentialReference = { path: credentialPath, sha256: sha256(credentialBytes), fingerprint: credential.credentialFingerprint }
  const inventory = inventoryStateLayout({ stateRoot: credentialFixture.stateRoot, dockerObjects: credentialFixture.dockerObjects })
  const plan = planStateLayoutMigration(inventory, { providerSnapshots })
  assert.equal(plan.coverage.retiredConsumerCredentialReferences[0].sha256, sha256(credentialBytes))
  const bad = structuredClone(providerSnapshots)
  bad[0].endpoint.credentialReference.sha256 = 'f'.repeat(64)
  assert.throws(() => planStateLayoutMigration(inventory, { providerSnapshots: bad }), /STATE_MIGRATION_CREDENTIAL_REFERENCE_SHA_MISMATCH/)
})

test('process-runtime key becomes Stack credential material with exact bytes and mode', async () => {
  const { stateRoot, providerSnapshots, dockerObjects } = fixture()
  const stableSecret = Buffer.alloc(32, 7).toString('base64')
  const key = path.join(stateRoot, 'shared', 'fixture_machine', 'process-runtime', 'notification-delivery-payload.key')
  fs.mkdirSync(path.dirname(key), { recursive: true })
  fs.writeFileSync(key, stableSecret, { mode: 0o600 })
  const inventory = inventoryStateLayout({ stateRoot, dockerObjects })
  const plan = planStateLayoutMigration(inventory, { providerSnapshots })
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  const target = path.join(staged.layout.stackRoot, 'credentials', 'process-runtime', 'notification-delivery-payload.key')
  assert.equal(fs.readFileSync(target, 'utf8'), stableSecret)
  assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(path.join(staged.layout.stackRoot, 'providers', 'dev', 'process-runtime')), false)
  const mtlsBundle = path.join(staged.layout.stackRoot, 'credentials', 'test-mtls.json')
  writeAtomic(mtlsBundle, { ownerEnvironments: { 'notification-service': { OES_GRPC_TLS_CA_PATH: '/fixture/ca.pem' } } })
  const manifest = { profile: 'DEV', stackRoot: staged.layout.stackRoot, endpoints: [{ provider: 'mtls', source: 'RUN', ready: true, authority: 'filesystem:fixture', owners: ['notification-service'], credentialReference: { path: mtlsBundle } }] }
  const environment = trustedProcessEnvironment({ root: path.resolve(import.meta.dirname, '../../../..'), manifest, owner: 'notification-service', issuerPort: 12345 })
  assert.equal(environment.NOTIFICATION_DELIVERY_PAYLOAD_KEY, stableSecret)
  assert.equal(fs.readFileSync(target, 'utf8'), stableSecret)
})

test('ordinary post-migration resolution reopens the preserved immutable devStackId', async () => {
  const { stateRoot, inventory, plan } = fixture()
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), verifyProviderReadiness: () => true, verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: zeroQuiescence, providerLifecycle })
  const reopened = await resolveRuntimeLayout({ stateRoot, profile: 'LOCAL_INTEGRATION', taskKey: 'ordinary_task', runId: 'ordinary_run', hostBinding })
  assert.equal(reopened.devStackId, 'fixture_machine')
  const identity = JSON.parse(fs.readFileSync(path.join(reopened.stackRoot, 'providers', 'test', 'postgres', 'identity.json'), 'utf8'))
  assert.equal(identity.objectId, 'object-b')
  assert.equal(identity.name, migrationReplacementName('fixture_machine', 'test', 'postgres'))
  assert.equal(identity.labels['oes.runtime.stack-key'], reopened.stackKey)
})

test('rollback rechecks live quiescence before provider or root mutation', async () => {
  const { stateRoot, inventory, plan } = fixture()
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  const committed = activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), verifyProviderReadiness: () => true, verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: zeroQuiescence, providerLifecycle })
  let stopped = false
  const lifecycle = { ...providerLifecycle, stop: () => { stopped = true } }
  assert.throws(() => rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: () => ({ activeRunCount: 1 }), providerLifecycle: lifecycle }), /STATE_MIGRATION_QUIESCENCE_REQUIRED/)
  assert.equal(stopped, false)
  assert.equal(fs.existsSync(path.join(stateRoot, 'stack-registry.json')), true)
})

test('rollback discounts only sealed replacement binds, stops them, then requires strict zero binds', async () => {
  const { stateRoot, inventory, plan } = fixture()
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  const committed = activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), verifyProviderReadiness: () => true, verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence: zeroQuiescence, providerLifecycle })
  const events = []
  let stopped = false
  const lifecycle = { ...providerLifecycle, stop: () => { events.push('stop'); stopped = true } }
  const observeQuiescence = (_journal, { allowedRunningObjectIds }) => {
    events.push(allowedRunningObjectIds.length ? `observe-allow:${allowedRunningObjectIds.join(',')}` : 'observe-strict')
    return { ...zeroQuiescence(), runningBindCount: stopped || allowedRunningObjectIds.includes('object-b') ? 0 : 1 }
  }
  const rolledBack = rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), verifyProviderDependencyIdentities: skipProviderDependencyReopen, observeQuiescence, providerLifecycle: lifecycle })
  assert.equal(rolledBack.state, 'ROLLED_BACK')
  assert.deepEqual(events, ['observe-allow:object-b', 'stop', 'observe-strict'])
})

test('necessary provider replacement uses the frozen digest-bearing shared name', () => {
  const name = migrationReplacementName('fixture_machine', 'test', 'postgres')
  assert.match(name, /^oes-v2-[a-z0-9-]+-test-postgres$/u)
  assert.notEqual(name, 'postgres-a')
  assert.throws(() => migrationReplacementName('fixture_machine', 'test', 'provider-name-that-exceeds-the-frozen-docker-name-boundary-by-a-large-margin'), /STATE_MIGRATION_REPLACEMENT_NAME_INVALID/)
})

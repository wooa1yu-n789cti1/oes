import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fingerprint, sha256, writeAtomic } from '../canonical.mjs'
import { activateStagedState, inventoryStateLayout, migrationReplacementName, planStateLayoutMigration, recoverStateLayout, reopenJournal, rollbackCommittedState, stageStateLayoutMigration } from '../state-migration.mjs'
import { resolveRuntimeLayout } from '../state-layout.mjs'
import { trustedProcessEnvironment } from '../trusted-runtime-config.mjs'

const seed = '0'.repeat(64)
const hostBinding = { kind: 'fixture-v1', value: 'migration-host' }
const providerLifecycle = { activate: (binds) => binds.map((bind) => ({ objectId: bind.objectId, source: bind.nextSource, destination: bind.destination, disposition: 'FIXTURE_RESTARTED' })), stop: () => {}, restart: () => {} }
const zeroQuiescence = () => ({ activeRunCount: 0, activeStackLeaseCount: 0, runningDevProcessCount: 0, semaphoreTicketCount: 0, controlLockCount: 0, allocationAdmissionCount: 0, runningBindCount: 0 })

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-state-migration-'))
  const stateRoot = path.join(parent, 'runtime-v2')
  const provider = path.join(stateRoot, 'shared', 'fixture_machine', 'postgres')
  fs.mkdirSync(provider, { recursive: true })
  writeAtomic(path.join(stateRoot, 'machine', 'dev-stack.json'), { schemaVersion: 2, devStackId: 'fixture_machine' })
  const labels = { 'oes.runtime.version': '2', 'oes.runtime.dev-stack-id': 'fixture_machine', 'oes.runtime.scope': 'SHARED', 'oes.runtime.pool': 'test', 'oes.runtime.provider': 'postgres' }
  writeAtomic(path.join(provider, 'identity.json'), { provider: 'postgres', kind: 'container', scope: 'SHARED', name: 'postgres-a', objectId: 'object-a', labels })
  writeAtomic(path.join(stateRoot, 'restore', 'restore-confirmation.json'), { kind: 'OES_DEV_RESTORE_CONFIRMATION', status: 'CONFIRMED' })
  const dockerObjects = [{ objectId: 'object-a', name: 'postgres-a', running: false, labels, mounts: [{ Type: 'bind', Source: path.join(provider, 'data'), Destination: '/data' }] }]
  const inventory = inventoryStateLayout({ stateRoot, dockerObjects })
  const providerSnapshots = [{ resource: { provider: 'postgres', kind: 'container', scope: 'SHARED', pool: 'test', objectId: 'object-a', name: 'postgres-a', labels }, endpoint: { provider: 'postgres', pool: 'test', ready: true, authority: 'docker:object-a:5432/tcp', environment: { OES_POSTGRES_PORT: '5432' } } }]
  const plan = planStateLayoutMigration(inventory, { providerSnapshots })
  return { stateRoot, inventory, plan, providerSnapshots, dockerObjects }
}

function confirmation(kind, journal) {
  const raw = { schemaVersion: 3, kind, status: 'CONFIRMED', journalFingerprint: journal.journalFingerprint }
  return { ...raw, confirmationFingerprint: fingerprint(raw) }
}

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
  assert.throws(() => activateStagedState({ journalPath: staged.journalPath, confirmation: approved, faultAt: 'after-old-moved', observeQuiescence: zeroQuiescence }), /STATE_MIGRATION_FAULT_AFTER_OLD_MOVED/)
  assert.equal(reopenJournal(staged.journalPath).state, 'OLD_MOVED')
  const recovered = recoverStateLayout({ journalPath: staged.journalPath })
  assert.equal(recovered.authority, 'OLD')
  assert.equal(fs.existsSync(path.join(stateRoot, 'machine', 'dev-stack.json')), true)
  assert.equal(fs.existsSync(recovered.quarantine), true)
  assert.equal(recoverStateLayout({ journalPath: staged.journalPath }).state, 'RECOVERED_OLD')
})

test('recovery closes both rename-before-journal crash windows idempotently', async () => {
  for (const crashWindow of ['OLD_RENAME_ONLY', 'BOTH_RENAMES']) {
    const { stateRoot, inventory, plan } = fixture()
    const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
    fs.renameSync(stateRoot, plan.rollbackRoot)
    if (crashWindow === 'BOTH_RENAMES') fs.renameSync(plan.stagedRoot, stateRoot)
    const recovered = recoverStateLayout({ journalPath: staged.journalPath })
    assert.equal(recovered.authority, 'OLD')
    assert.equal(fs.existsSync(path.join(stateRoot, 'machine', 'dev-stack.json')), true)
    assert.equal(fs.existsSync(recovered.quarantine), true)
    assert.equal(recoverStateLayout({ journalPath: staged.journalPath }).state, 'RECOVERED_OLD')
  }
})

test('COMMITTED activation keeps new authority and confirmed rollback restores the old tree', async () => {
  const { stateRoot, inventory, plan } = fixture()
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  const committed = activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), verifyNewRoot: (root) => fs.existsSync(path.join(root, 'stack-registry.json')), verifyProviderReadiness: () => true, observeQuiescence: zeroQuiescence, providerLifecycle })
  assert.equal(committed.state, 'COMMITTED')
  assert.throws(() => recoverStateLayout({ journalPath: staged.journalPath, verifyProviderReadiness: () => true, verifyProviderMappings: () => false }), /STATE_MIGRATION_COMMITTED_PROVIDER_VERIFICATION_FAILED/)
  assert.equal(recoverStateLayout({ journalPath: staged.journalPath, verifyProviderReadiness: () => true, verifyProviderMappings: () => true }).authority, 'NEW')
  const rolledBack = rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), observeQuiescence: zeroQuiescence, providerLifecycle })
  assert.equal(rolledBack.state, 'ROLLED_BACK')
  assert.equal(fs.existsSync(path.join(stateRoot, 'machine', 'dev-stack.json')), true)
  assert.equal(fs.existsSync(rolledBack.retainedNewRoot), true)
  assert.equal(rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), observeQuiescence: zeroQuiescence, providerLifecycle }).state, 'ROLLED_BACK')
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
  assert.throws(() => activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), faultAt: 'after-provider-activation', observeQuiescence: zeroQuiescence, providerLifecycle: lifecycle }), /STATE_MIGRATION_FAULT_AFTER_PROVIDER_ACTIVATION/)
  const recovered = recoverStateLayout({ journalPath: staged.journalPath, providerLifecycle: lifecycle })
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
  const { stateRoot, inventory, providerSnapshots: baseSnapshots } = fixture()
  const providerSnapshots = [...baseSnapshots, { resource: { provider: 'postgres', kind: 'database', scope: 'SHARED', pool: 'dev', database: 'service_dev' }, endpoint: { provider: 'postgres', pool: 'dev', ready: true, authority: 'docker:object-a:5432/tcp' } }]
  assert.throws(() => planStateLayoutMigration(inventory, { providerSnapshots }), /STATE_MIGRATION_DEV_BACKUP_REFERENCE_INVALID/)
  const archive = path.join(path.dirname(stateRoot), 'service_dev.dump')
  fs.writeFileSync(archive, 'fixture-backup')
  const raw = { schemaVersion: 3, kind: 'OES_DEV_STATE_BACKUP', devStackId: 'fixture_machine', sourcesPreserved: true, backups: [{ kind: 'database', database: 'service_dev', file: archive, sha256: sha256(fs.readFileSync(archive)) }] }
  const record = { ...raw, backupFingerprint: fingerprint(raw) }
  const recordPath = path.join(path.dirname(stateRoot), 'backup-record.json')
  writeAtomic(recordPath, record)
  const bytes = fs.readFileSync(recordPath)
  const reference = { type: 'OES_DEV_STATE_BACKUP', path: recordPath, sha256: sha256(bytes), fingerprint: record.backupFingerprint }
  assert.equal(planStateLayoutMigration(inventory, { providerSnapshots, devBackupReference: reference }).devBackupReference.fingerprint, record.backupFingerprint)
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

test('process-runtime key becomes Stack credential material with exact bytes and mode', async () => {
  const { stateRoot, providerSnapshots, dockerObjects } = fixture()
  const key = path.join(stateRoot, 'shared', 'fixture_machine', 'process-runtime', 'notification-delivery-payload.key')
  fs.mkdirSync(path.dirname(key), { recursive: true })
  fs.writeFileSync(key, 'stable-secret', { mode: 0o600 })
  const inventory = inventoryStateLayout({ stateRoot, dockerObjects })
  const plan = planStateLayoutMigration(inventory, { providerSnapshots })
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  const target = path.join(staged.layout.stackRoot, 'credentials', 'process-runtime', 'notification-delivery-payload.key')
  assert.equal(fs.readFileSync(target, 'utf8'), 'stable-secret')
  assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(path.join(staged.layout.stackRoot, 'providers', 'dev', 'process-runtime')), false)
  const mtlsBundle = path.join(staged.layout.stackRoot, 'credentials', 'test-mtls.json')
  writeAtomic(mtlsBundle, { ownerEnvironments: { 'notification-service': { OES_GRPC_TLS_CA_PATH: '/fixture/ca.pem' } } })
  const manifest = { stackRoot: staged.layout.stackRoot, endpoints: [{ provider: 'mtls', source: 'RUN', ready: true, authority: 'filesystem:fixture', owners: ['notification-service'], credentialReference: { path: mtlsBundle } }] }
  const environment = trustedProcessEnvironment({ root: path.resolve(import.meta.dirname, '../../../..'), manifest, owner: 'notification-service', issuerPort: 12345 })
  assert.equal(environment.NOTIFICATION_DELIVERY_PAYLOAD_KEY, 'stable-secret')
  assert.equal(fs.readFileSync(target, 'utf8'), 'stable-secret')
})

test('ordinary post-migration resolution reopens the preserved immutable devStackId', async () => {
  const { stateRoot, inventory, plan } = fixture()
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), verifyProviderReadiness: () => true, observeQuiescence: zeroQuiescence, providerLifecycle })
  const reopened = await resolveRuntimeLayout({ stateRoot, profile: 'LOCAL_INTEGRATION', taskKey: 'ordinary_task', runId: 'ordinary_run', hostBinding })
  assert.equal(reopened.devStackId, 'fixture_machine')
})

test('rollback rechecks live quiescence before provider or root mutation', async () => {
  const { stateRoot, inventory, plan } = fixture()
  const staged = await stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding })
  const committed = activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), verifyProviderReadiness: () => true, observeQuiescence: zeroQuiescence, providerLifecycle })
  let stopped = false
  const lifecycle = { ...providerLifecycle, stop: () => { stopped = true } }
  assert.throws(() => rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), observeQuiescence: () => ({ activeRunCount: 1 }), providerLifecycle: lifecycle }), /STATE_MIGRATION_QUIESCENCE_REQUIRED/)
  assert.equal(stopped, false)
  assert.equal(fs.existsSync(path.join(stateRoot, 'stack-registry.json')), true)
})

test('necessary provider replacement uses the frozen digest-bearing shared name', () => {
  const name = migrationReplacementName('fixture_machine', 'test', 'postgres')
  assert.match(name, /^oes-v2-[a-z0-9-]+-test-postgres$/u)
  assert.notEqual(name, 'postgres-a')
  assert.throws(() => migrationReplacementName('fixture_machine', 'test', 'provider-name-that-exceeds-the-frozen-docker-name-boundary-by-a-large-margin'), /STATE_MIGRATION_REPLACEMENT_NAME_INVALID/)
})

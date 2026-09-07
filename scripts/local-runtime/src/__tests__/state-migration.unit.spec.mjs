import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fingerprint, sha256, writeAtomic } from '../canonical.mjs'
import { activateStagedState, inventoryStateLayout, planStateLayoutMigration, recoverStateLayout, reopenJournal, rollbackCommittedState, stageStateLayoutMigration } from '../state-migration.mjs'

const seed = '0'.repeat(64)
const hostBinding = { kind: 'fixture-v1', value: 'migration-host' }
const providerLifecycle = { activate: (binds) => binds.map((bind) => ({ objectId: bind.objectId, source: bind.nextSource, destination: bind.destination, disposition: 'FIXTURE_RESTARTED' })), stop: () => {}, restart: () => {} }

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-state-migration-'))
  const stateRoot = path.join(parent, 'runtime-v2')
  const provider = path.join(stateRoot, 'shared', 'fixture_machine', 'postgres')
  fs.mkdirSync(provider, { recursive: true })
  writeAtomic(path.join(stateRoot, 'machine', 'dev-stack.json'), { schemaVersion: 2, devStackId: 'fixture_machine' })
  writeAtomic(path.join(provider, 'identity.json'), { provider: 'postgres', objectId: 'object-a', labels: { 'oes.runtime.pool': 'test' } })
  writeAtomic(path.join(stateRoot, 'restore', 'restore-confirmation.json'), { kind: 'OES_DEV_RESTORE_CONFIRMATION', status: 'CONFIRMED' })
  const inventory = inventoryStateLayout({ stateRoot, dockerObjects: [{ objectId: 'object-a', running: false, mounts: [{ Type: 'bind', Source: path.join(provider, 'data'), Destination: '/data' }] }] })
  const providerSnapshots = [{ resource: { provider: 'postgres', kind: 'container', scope: 'SHARED', objectId: 'object-a', name: 'postgres-a' }, endpoint: { provider: 'postgres', ready: true, authority: 'docker:object-a:5432/tcp', environment: { OES_POSTGRES_PORT: '5432' } } }]
  const plan = planStateLayoutMigration(inventory, { providerSnapshots })
  return { stateRoot, inventory, plan }
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
  assert.throws(() => activateStagedState({ journalPath: staged.journalPath, confirmation: approved, faultAt: 'after-old-moved' }), /STATE_MIGRATION_FAULT_AFTER_OLD_MOVED/)
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
  const committed = activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), verifyNewRoot: (root) => fs.existsSync(path.join(root, 'stack-registry.json')), verifyProviderReadiness: () => true, providerLifecycle })
  assert.equal(committed.state, 'COMMITTED')
  assert.equal(recoverStateLayout({ journalPath: staged.journalPath }).authority, 'NEW')
  const rolledBack = rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), providerLifecycle })
  assert.equal(rolledBack.state, 'ROLLED_BACK')
  assert.equal(fs.existsSync(path.join(stateRoot, 'machine', 'dev-stack.json')), true)
  assert.equal(fs.existsSync(rolledBack.retainedNewRoot), true)
  assert.equal(rollbackCommittedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ROLLBACK_CONFIRMATION', committed), providerLifecycle }).state, 'ROLLED_BACK')
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
  assert.throws(() => activateStagedState({ journalPath: staged.journalPath, confirmation: confirmation('OES_RUNTIME_STATE_LAYOUT_ACTIVATION_CONFIRMATION', staged.journal), faultAt: 'after-provider-activation', providerLifecycle: lifecycle }), /STATE_MIGRATION_FAULT_AFTER_PROVIDER_ACTIVATION/)
  const recovered = recoverStateLayout({ journalPath: staged.journalPath, providerLifecycle: lifecycle })
  assert.equal(recovered.authority, 'OLD')
  assert.deepEqual(events, ['activate', 'stop', 'restart'])
  assert.equal(fs.existsSync(path.join(stateRoot, 'machine', 'dev-stack.json')), true)
})

test('active leases and running old-root binds block staging before any sibling tree exists', async () => {
  const { stateRoot } = fixture()
  writeAtomic(path.join(stateRoot, 'leases', 'fixture_machine', 'active.json'), { taskKey: 'task_a' })
  const inventory = inventoryStateLayout({ stateRoot, dockerObjects: [{ objectId: 'object-a', running: true, mounts: [{ Type: 'bind', Source: path.join(stateRoot, 'shared', 'fixture_machine', 'postgres'), Destination: '/data' }] }] })
  const plan = planStateLayoutMigration(inventory, { providerSnapshots: [] })
  assert.equal(plan.quiescence.activeStackLeaseCount, 1)
  assert.equal(plan.quiescence.runningBindCount, 1)
  await assert.rejects(stageStateLayoutMigration(plan, inventory, { identitySeed: seed, hostBinding }), /STATE_MIGRATION_QUIESCENCE_REQUIRED/)
  assert.equal(fs.existsSync(plan.stagedRoot), false)
})

test('DEV data requires an external byte-reopenable snapshot before planning', () => {
  const { stateRoot, inventory } = fixture()
  const providerSnapshots = [{ resource: { provider: 'postgres', kind: 'database', scope: 'SHARED', pool: 'dev', database: 'service_dev' }, endpoint: { provider: 'postgres', pool: 'dev', ready: true, authority: 'docker:object-a:5432/tcp' } }]
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

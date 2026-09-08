import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveCredentialReference } from '../credentials.mjs'
import { environmentForOwner, resolveResources } from '../manifest.mjs'
import { fingerprint, writeAtomic } from '../canonical.mjs'
import { cleanupRunPrivateFiles, reconcileRuntime, startRuntime, withRuntime } from '../orchestrator.mjs'
import { cleanupSimulatedResource } from '../simulation-driver.mjs'
import { acquireMigrationBarrier, activeRuntimeAdmissions, resolveRuntimeLayout } from '../state-layout.mjs'
import { stackLeasePath } from '../stack-lease.mjs'

const root = path.resolve(import.meta.dirname, '../../../..')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function intent(stateRoot, taskKey, runId) { return { root, stateRoot, profile: 'LOCAL_INTEGRATION', testClass: 'integration', owners: ['permission-service'], capabilities: [], taskKey, runId, devStackId: 'fixture_machine', driver: 'simulation', concurrency: 2 } }
function devIntent(stateRoot, taskKey, runId) { return { root, stateRoot, profile: 'DEV', testClass: 'integration', owners: ['permission-service'], capabilities: [], taskKey, runId, devStackId: 'fixture_machine', driver: 'simulation', concurrency: 2, devLockTimeoutMs: 2000 } }
function physical(manifest) { return resolveResources(manifest, { includeStack: true }).find((resource) => resource.kind === 'simulated-provider' && resource.provider === 'postgres') }

test('two runs share physical TEST provider but receive isolated logical allocations and credentials', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-two-run-'))
  let releaseA
  const gateA = new Promise((resolve) => { releaseA = resolve })
  const observed = {}
  const runA = withRuntime(intent(stateRoot, 'task_a', 'run_a'), async (manifest) => {
    observed.a = manifest
    await gateA
  })
  const runB = withRuntime(intent(stateRoot, 'task_b', 'run_b'), async (manifest) => {
    observed.b = manifest
    const envA = environmentForOwner(observed.a, 'permission-service', resolveCredentialReference)
    const envB = environmentForOwner(manifest, 'permission-service', resolveCredentialReference)
    assert.notEqual(envA.OES_POSTGRES_CREDENTIAL, envB.OES_POSTGRES_CREDENTIAL)
    assert.equal(physical(observed.a).objectId, physical(manifest).objectId)
    releaseA()
    await delay(25)
    assert.equal(fs.existsSync(physical(observed.a).path), true)
  })
  await Promise.all([runA, runB])
  assert.equal(fs.existsSync(physical(observed.a).path), true)
  assert.ok(observed.a.resources.every((resource) => !resource.path || !fs.existsSync(resource.path)))
  assert.ok(observed.b.resources.every((resource) => !resource.path || !fs.existsSync(resource.path)))
})

test('real-resource FIFO semaphore limits concurrent runs to two', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-fifo-'))
  let active = 0
  let maximum = 0
  await Promise.all(['a', 'b', 'c'].map((suffix) => withRuntime(intent(stateRoot, `task_${suffix}`, `run_${suffix}`), async () => { active += 1; maximum = Math.max(maximum, active); await delay(80); active -= 1 })))
  assert.equal(maximum, 2)
})

test('delimiter-bearing task and run identities allocate distinct leases and reconcile without FIFO residue', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-lease-injective-'))
  const first = await startRuntime(intent(stateRoot, 'aa--bb', 'cc'))
  const second = await startRuntime(intent(stateRoot, 'aa', 'bb--cc'))
  assert.notEqual(stackLeasePath(first.context.stackRoot, 'aa--bb', 'cc'), stackLeasePath(second.context.stackRoot, 'aa', 'bb--cc'))
  assert.equal(fs.readdirSync(path.join(first.context.stackRoot, 'leases')).filter((entry) => entry.endsWith('.json')).length, 2)
  reconcileRuntime({ manifestPath: first.file, cleanupResource: first.cleanup, releaseSlot: first.releaseSlot, releaseRunLock: first.releaseRunLock, releaseDevLock: first.releaseDevLock })
  reconcileRuntime({ manifestPath: second.file, cleanupResource: second.cleanup, releaseSlot: second.releaseSlot, releaseRunLock: second.releaseRunLock, releaseDevLock: second.releaseDevLock })
  assert.deepEqual(fs.readdirSync(path.join(first.context.stackRoot, 'leases')), [])
  assert.deepEqual(fs.readdirSync(path.join(stateRoot, 'semaphores', 'queue')), [])
})

test('one atomic Run claim rejects a concurrent duplicate before provider mutation without altering the winner', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-run-claim-'))
  let announceFirst
  let releaseFirst
  const firstEntered = new Promise((resolve) => { announceFirst = resolve })
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  let firstProviderCalls = 0
  let secondProviderCalls = 0
  const cleanupResource = () => ({ disposition: 'NOT_APPLICABLE', exitStatus: 0 })
  const firstStart = startRuntime({ ...intent(stateRoot, 'same_task', 'same_run'), runLockTimeoutMs: 1000 }, {
    provisionProvider: async () => {
      firstProviderCalls += 1
      if (firstProviderCalls === 1) { announceFirst(); await firstGate }
      return { resources: [], endpoints: [] }
    },
    cleanupResource
  })
  await firstEntered
  await assert.rejects(startRuntime({ ...intent(stateRoot, 'same_task', 'same_run'), runLockTimeoutMs: 100 }, {
    provisionProvider: async () => { secondProviderCalls += 1; return { resources: [], endpoints: [] } },
    cleanupResource
  }), /RUNTIME_LOCK_TIMEOUT/u)
  assert.equal(secondProviderCalls, 0)
  releaseFirst()
  const winner = await firstStart
  assert.equal(firstProviderCalls > 0, true)
  assert.equal(fs.existsSync(winner.file), true)
  assert.equal(fs.existsSync(stackLeasePath(winner.context.stackRoot, 'same_task', 'same_run')), true)
  assert.equal(fs.readdirSync(path.join(stateRoot, 'semaphores', 'queue')).filter((entry) => entry.endsWith('.json')).length, 1)
  reconcileRuntime({ manifestPath: winner.file, cleanupResource: winner.cleanup, releaseSlot: winner.releaseSlot, releaseRunLock: winner.releaseRunLock, releaseDevLock: winner.releaseDevLock })
  assert.deepEqual(fs.readdirSync(path.join(winner.context.stackRoot, 'leases')), [])
  assert.deepEqual(fs.readdirSync(path.join(stateRoot, 'semaphores', 'queue')), [])
})

test('pre-transaction lease publication failure removes its FIFO ticket and owner-only Run directory', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-partial-start-'))
  const taskKey = 'task_partial'
  const runId = 'run_partial'
  const layout = await resolveRuntimeLayout({ stateRoot, profile: 'LOCAL_INTEGRATION', taskKey, runId, explicitDevStackId: 'fixture_machine' })
  const queue = path.join(stateRoot, 'semaphores', 'queue')
  const blocker = path.join(queue, '0000000000000000-blocker.json')
  writeAtomic(blocker, { pid: process.pid, taskKey: 'blocker_task', runId: 'blocker_run', runDirectory: stateRoot })
  let providerCalls = 0
  const starting = startRuntime({ ...intent(stateRoot, taskKey, runId), concurrency: 1 }, {
    provisionProvider: async () => { providerCalls += 1; return { resources: [], endpoints: [] } },
    cleanupResource: () => ({ disposition: 'NOT_APPLICABLE', exitStatus: 0 })
  })
  let targetTickets = []
  for (let attempt = 0; attempt < 200; attempt += 1) {
    targetTickets = fs.readdirSync(queue).filter((entry) => entry.endsWith('.json')).filter((entry) => {
      const value = JSON.parse(fs.readFileSync(path.join(queue, entry), 'utf8'))
      return value.taskKey === taskKey && value.runId === runId
    })
    if (fs.existsSync(path.join(layout.runRoot, 'run-owner.json')) && targetTickets.length === 1) break
    await delay(10)
  }
  assert.equal(fs.existsSync(path.join(layout.runRoot, 'run-owner.json')), true)
  assert.equal(targetTickets.length, 1)
  fs.rmdirSync(path.join(layout.stackRoot, 'leases'))
  fs.writeFileSync(path.join(layout.stackRoot, 'leases'), 'blocked')
  fs.unlinkSync(blocker)
  await assert.rejects(starting, /EEXIST|ENOTDIR/u)
  assert.equal(providerCalls, 0)
  assert.equal(fs.existsSync(layout.runRoot), false)
  const tickets = fs.existsSync(queue) ? fs.readdirSync(queue).filter((entry) => entry.endsWith('.json')) : []
  assert.deepEqual(tickets, [])
  assert.deepEqual(activeRuntimeAdmissions(stateRoot), [])
  assert.equal(fs.existsSync(path.join(stateRoot, 'locks', 'runs', layout.stackKey, taskKey, `${runId}.lock`)), false)
  assert.equal(fs.readFileSync(path.join(layout.stackRoot, 'leases'), 'utf8'), 'blocked')
})

test('DEV devStack lease admits only one complete stack for the full process lifetime', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-dev-exclusive-'))
  let active = 0
  let maximum = 0
  const adapters = {
    provisionProvider: async () => ({ resources: [], endpoints: [] }),
    cleanupResource: () => ({ disposition: 'NOT_APPLICABLE', exitStatus: 0 })
  }

  await Promise.all(['a', 'b'].map((suffix) => withRuntime(devIntent(stateRoot, `task_${suffix}`, `run_${suffix}`), async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await delay(80)
    active -= 1
  }, adapters)))

  assert.equal(maximum, 1)
  assert.equal(fs.existsSync(path.join(stateRoot, 'locks', 'stacks')), true)
  assert.equal(fs.readdirSync(path.join(stateRoot, 'locks', 'stacks')).length, 0)
})

test('machine migration barrier rejects launcher allocation before schema, Stack, or Run publication', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-migration-admission-'))
  const stateRoot = path.join(parent, 'runtime-v2')
  const barrier = acquireMigrationBarrier(stateRoot, { operation: 'FIXTURE_ACTIVATION' })
  try {
    await assert.rejects(startRuntime(intent(stateRoot, 'task_blocked', 'run_blocked')), /STATE_MIGRATION_LOCK_HELD/)
    assert.equal(fs.existsSync(stateRoot), false)
  } finally { barrier.release() }
})

test('abnormal callback failure still reconciles exact run resources', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-abnormal-'))
  const sentinel = new Error('abnormal sentinel')
  let runDirectory
  await assert.rejects(withRuntime(intent(stateRoot, 'task_abnormal', 'run_abnormal'), async (manifest) => { runDirectory = manifest.runDirectory; throw sentinel }), sentinel)
  const cleanup = JSON.parse(fs.readFileSync(path.join(runDirectory, 'cleanup.json'), 'utf8'))
  assert.equal(cleanup.result, 'RECONCILED')
  assert.equal(cleanup.sharedLeaseCount, 0)
  assert.equal(fs.existsSync(path.join(runDirectory, 'credentials')), false)
  assert.equal(cleanup.cleanupResults.at(-1).resource.kind, 'run-private-files')
})

test('run-private cleanup removes CA, bootstrap, policy and credential files behind the exact owner marker', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-private-files-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const directory = path.join(stateRoot, 'stacks', stackKey, 'runs', 'task_private', 'run_private')
  const markerRaw = { schemaVersion: 3, kind: 'OES_RUNTIME_RUN_OWNER', path: directory, stackKey, taskKey: 'task_private', runId: 'run_private' }
  writeAtomic(path.join(directory, 'run-owner.json'), { ...markerRaw, markerFingerprint: fingerprint(markerRaw) })
  for (const file of ['provider/mtls/ca.key', 'provider/postgres-bootstrap.json', 'provider/minio-policy.json', 'credentials/mtls.json']) {
    const target = path.join(directory, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'fixture-secret')
  }

  const result = cleanupRunPrivateFiles({ stateRoot, stackKey, runDirectory: directory, taskKey: 'task_private', runId: 'run_private' })

  assert.equal(result.disposition, 'DELETED_EXACT')
  assert.equal(result.deleted.length, 4)
  assert.equal(fs.existsSync(path.join(directory, 'provider')), false)
  assert.equal(fs.existsSync(path.join(directory, 'credentials')), false)
})

test('unready provider fails before manifest publication and reconciles partial state', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-unready-'))
  let runDirectory
  await assert.rejects(startRuntime(intent(stateRoot, 'task_unready', 'run_unready'), { provisionProvider: async (_provider, context) => { runDirectory = context.runDirectory; const owned = path.join(runDirectory, 'owned'); fs.writeFileSync(owned, '{}'); return { resources: [{ kind: 'simulated-logical', scope: 'RUN', provider: 'postgres', objectId: 'x', path: owned, cleanup: 'DELETE_EXACT' }], endpoints: [{ provider: 'postgres', ready: false, authority: '', owners: ['permission-service'], environment: {}, credentialReference: null }] } }, cleanupResource: cleanupSimulatedResource }), /MANIFEST_ENDPOINT_UNREADY/)
  assert.equal(fs.existsSync(path.join(runDirectory, 'manifest.json')), false)
  assert.equal(fs.existsSync(path.join(runDirectory, 'failed-cleanup.json')), true)
})

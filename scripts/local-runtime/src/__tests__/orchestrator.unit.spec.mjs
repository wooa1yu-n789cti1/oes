import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveCredentialReference } from '../credentials.mjs'
import { logicalResourceIdentity, REDIS_RUNTIME_ACL_COMMAND_RULES } from '../docker-driver.mjs'
import { environmentForOwner, resolveResources } from '../manifest.mjs'
import { fingerprint, sha256, writeAtomic } from '../canonical.mjs'
import { cleanupRunPrivateFiles, reconcileRuntime, startRuntime, withRuntime } from '../orchestrator.mjs'
import { cleanupSimulatedResource } from '../simulation-driver.mjs'
import { acquireMigrationBarrier, activeRuntimeAdmissions, resolveRuntimeLayout } from '../state-layout.mjs'
import { stackLeasePath } from '../stack-lease.mjs'

const root = path.resolve(import.meta.dirname, '../../../..')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function intent(stateRoot, taskKey, runId) { return { root, stateRoot, profile: 'LOCAL_INTEGRATION', testClass: 'integration', owners: ['permission-service'], capabilities: [], taskKey, runId, devStackId: 'fixture_machine', driver: 'simulation', concurrency: 2 } }
function devIntent(stateRoot, taskKey, runId) { return { root, stateRoot, profile: 'DEV', testClass: 'integration', owners: ['permission-service'], capabilities: [], taskKey, runId, devStackId: 'fixture_machine', driver: 'simulation', concurrency: 2, devLockTimeoutMs: 2000 } }
function physical(manifest) { return resolveResources(manifest, { includeStack: true }).find((resource) => resource.kind === 'simulated-provider' && resource.provider === 'postgres') }

/** Captures file content and directory shape without relying on mutable timestamps. */
function snapshotTree(target) {
  if (!fs.existsSync(target)) return null
  const output = {}
  const walk = (current) => {
    const relative = path.relative(target, current) || '.'
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) { output[relative] = `link:${fs.readlinkSync(current)}`; return }
    if (stat.isFile()) { output[relative] = `file:${fs.readFileSync(current).toString('base64')}`; return }
    output[relative] = 'directory'
    for (const entry of fs.readdirSync(current).sort()) walk(path.join(current, entry))
  }
  walk(target)
  return output
}

/** Starts a separate simulator owner and resolves once its exact manifest is durable. */
function spawnRuntimeOwner(stateRoot, taskKey, runId, waitForCleanup) {
  const script = `
    import { reconcileRuntime, startRuntime } from './scripts/local-runtime/src/orchestrator.mjs'
    const started = await startRuntime({ root: process.env.FIXTURE_ROOT, stateRoot: process.env.FIXTURE_STATE_ROOT, profile: 'LOCAL_INTEGRATION', testClass: 'integration', owners: ['permission-service'], capabilities: [], taskKey: process.env.FIXTURE_TASK_KEY, runId: process.env.FIXTURE_RUN_ID, devStackId: 'fixture_machine', driver: 'simulation', concurrency: 2 })
    process.stdout.write(JSON.stringify({ file: started.file }) + '\\n')
    if (process.env.FIXTURE_WAIT === 'true') {
      await new Promise((resolve) => process.stdin.once('data', resolve))
      reconcileRuntime({ manifestPath: started.file, cleanupResource: started.cleanup, releaseSlot: started.releaseSlot, releaseRunLock: started.releaseRunLock, releaseDevLock: started.releaseDevLock })
    }
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    env: { ...process.env, FIXTURE_ROOT: root, FIXTURE_STATE_ROOT: stateRoot, FIXTURE_TASK_KEY: taskKey, FIXTURE_RUN_ID: runId, FIXTURE_WAIT: String(waitForCleanup) },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let output = ''
  let errorOutput = ''
  child.stderr.on('data', (chunk) => { errorOutput += chunk })
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk
      const newline = output.indexOf('\n')
      if (newline !== -1) resolve(JSON.parse(output.slice(0, newline)))
    })
    child.once('error', reject)
    child.once('exit', (code) => { if (!output.includes('\n')) reject(new Error(`fixture owner exited code=${code} stderr=${errorOutput}`)) })
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, stderr: errorOutput })))
  return { child, ready, exited }
}

/** Leaves one sealed allocation transaction behind after its first owned resource publication. */
async function interruptedTransactionFixture(stateRoot, taskKey, runId) {
  const script = `
    import path from 'node:path'
    import { sha256, writeAtomic } from './scripts/local-runtime/src/canonical.mjs'
    import { startRuntime } from './scripts/local-runtime/src/orchestrator.mjs'
    let calls = 0
    await startRuntime({ root: process.env.FIXTURE_ROOT, stateRoot: process.env.FIXTURE_STATE_ROOT, profile: 'LOCAL_INTEGRATION', testClass: 'integration', owners: ['auth-service'], capabilities: ['cache', 'network-trust'], taskKey: process.env.FIXTURE_TASK_KEY, runId: process.env.FIXTURE_RUN_ID, devStackId: 'fixture_machine', driver: 'simulation', concurrency: 2 }, {
      provisionProvider: async (provider, context) => {
        calls += 1
        if (calls === 1) {
          const owner = context.providerOwners[provider][0]
          const suffix = sha256([context.taskKey, context.runId, owner, provider].join(':')).slice(0, 12)
          const target = path.join(context.runDirectory, 'provider', provider, 'simulation', suffix + '.json')
          writeAtomic(target, { owner: 'fixture' })
          return { resources: [{ provider, kind: 'simulated-logical', scope: 'RUN', owner, objectId: sha256(target), path: target, cleanup: 'DELETE_EXACT' }], endpoints: [] }
        }
        process.stdout.write(JSON.stringify({ transactionPath: path.join(context.runDirectory, 'transaction.json') }) + '\\n')
        await new Promise(() => { setInterval(() => {}, 1000) })
      },
      cleanupResource: () => ({ disposition: 'NOT_APPLICABLE', exitStatus: 0 })
    })
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    env: { ...process.env, FIXTURE_ROOT: root, FIXTURE_STATE_ROOT: stateRoot, FIXTURE_TASK_KEY: taskKey, FIXTURE_RUN_ID: runId },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk
      const newline = output.indexOf('\n')
      if (newline !== -1) resolve(JSON.parse(output.slice(0, newline)))
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`interrupted fixture exited early code=${code} stderr=${stderr}`)))
  })
  child.kill('SIGKILL')
  const terminal = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, stderr })))
  assert.equal(terminal.signal, 'SIGKILL')
  return { ...ready, transaction: JSON.parse(fs.readFileSync(ready.transactionPath, 'utf8')) }
}

/** Leaves one production-shaped Docker logical allocation transaction behind without contacting Docker. */
async function interruptedLogicalTransactionFixture(stateRoot, profile, provider, owner, capability, taskKey, runId) {
  const script = `
    import fs from 'node:fs'
    import path from 'node:path'
    import { sha256, writeAtomic } from './scripts/local-runtime/src/canonical.mjs'
    import { logicalResourceIdentity, runtimeLabels } from './scripts/local-runtime/src/docker-driver.mjs'
    import { startRuntime } from './scripts/local-runtime/src/orchestrator.mjs'
    const profile = process.env.FIXTURE_PROFILE
    const targetProvider = process.env.FIXTURE_PROVIDER
    const owner = process.env.FIXTURE_OWNER
    await startRuntime({ root: process.env.FIXTURE_ROOT, stateRoot: process.env.FIXTURE_STATE_ROOT, profile, testClass: profile === 'DEV' ? 'integration' : 'contract', owners: [owner], capabilities: [process.env.FIXTURE_CAPABILITY], taskKey: process.env.FIXTURE_TASK_KEY, runId: process.env.FIXTURE_RUN_ID, devStackId: 'fixture_machine', concurrency: 2, ciJobIdentity: profile === 'CI' ? 'fixture-ci-job' : undefined }, {
      provisionProvider: async (provider, context) => {
        if (provider !== targetProvider) return { resources: [], endpoints: [] }
        const scope = profile === 'DEV' ? 'SHARED' : profile === 'CI' ? 'CI' : 'RUN'
        const containerScope = profile === 'DEV' ? 'SHARED' : profile === 'LOCAL_INTEGRATION' && ['postgres', 'minio'].includes(provider) ? 'SHARED' : scope
        const containerName = 'fixture-' + provider + '-' + context.runId
        const containerObjectId = sha256(containerName)
        const container = { provider, kind: 'container', scope: containerScope, name: containerName, objectId: containerObjectId, labels: runtimeLabels(context, containerScope, provider), cleanup: containerScope === 'SHARED' ? 'PRESERVE_SHARED' : 'DELETE_EXACT' }
        const logical = { provider, scope, owner, ...logicalResourceIdentity(context, provider, owner), containerName, containerObjectId, containerScope, cleanup: scope === 'SHARED' ? 'PRESERVE_SHARED' : provider === 'postgres' ? 'DROP_EXACT' : provider === 'minio' ? 'DELETE_LOGICAL_EXACT' : 'DELETED_WITH_OWNED_CONTAINER' }
        delete logical.suffix
        delete logical.eventScope
        if (provider === 'postgres') logical.kind = 'database'
        if (provider === 'minio') logical.kind = 'bucket'
        if (provider === 'redis') logical.kind = 'acl-user'
        if (['postgres', 'minio'].includes(provider)) {
          const referencePath = containerScope === 'SHARED' ? path.join(context.stackRoot, 'credentials', context.pool, provider, 'bootstrap.json') : path.join(context.runDirectory, 'provider', provider + '-bootstrap.json')
          writeAtomic(referencePath, { fixture: true })
          const reference = { path: referencePath, sha256: sha256(fs.readFileSync(referencePath)) }
          if (provider === 'postgres') logical.rootCredentialReference = reference
          else logical.adminCredentialReference = reference
        }
        return { resources: [container, logical], endpoints: [] }
      },
      afterProgressPublished: async ({ provider, transactionPath }) => {
        if (provider !== targetProvider) return
        process.stdout.write(JSON.stringify({ transactionPath }) + '\\n')
        await new Promise(() => { setInterval(() => {}, 1000) })
      },
      cleanupResource: () => ({ disposition: 'NOT_APPLICABLE', exitStatus: 0 })
    })
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    env: { ...process.env, FIXTURE_ROOT: root, FIXTURE_STATE_ROOT: stateRoot, FIXTURE_PROFILE: profile, FIXTURE_PROVIDER: provider, FIXTURE_OWNER: owner, FIXTURE_CAPABILITY: capability, FIXTURE_TASK_KEY: taskKey, FIXTURE_RUN_ID: runId },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk
      const newline = output.indexOf('\n')
      if (newline !== -1) resolve(JSON.parse(output.slice(0, newline)))
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`logical fixture exited early code=${code} stderr=${stderr}`)))
  })
  child.kill('SIGKILL')
  const terminal = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, stderr })))
  assert.equal(terminal.signal, 'SIGKILL')
  return { ...ready, transaction: JSON.parse(fs.readFileSync(ready.transactionPath, 'utf8')) }
}

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

test('standalone reconciliation preserves a live foreign Run and its exact root and Stack state', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-live-reconcile-'))
  const owner = spawnRuntimeOwner(stateRoot, 'task_live', 'run_live', true)
  let manifestPath
  try {
    manifestPath = (await owner.ready).file
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const before = snapshotTree(stateRoot)
    assert.doesNotThrow(() => process.kill(owner.child.pid, 0))
    assert.throws(() => reconcileRuntime({ manifestPath, cleanupResource: cleanupSimulatedResource }), /RUNTIME_RUN_ACTIVE/u)
    assert.doesNotThrow(() => process.kill(owner.child.pid, 0))
    assert.deepEqual(snapshotTree(stateRoot), before)
    assert.equal(fs.existsSync(manifest.runLockLease.lockDirectory), true)
    assert.equal(fs.existsSync(stackLeasePath(manifest.stackRoot, manifest.taskKey, manifest.runId)), true)
    assert.equal(fs.readdirSync(path.join(stateRoot, 'semaphores', 'queue')).filter((entry) => entry.endsWith('.json')).length, 1)
    for (const resource of manifest.resources.filter((entry) => entry.path)) assert.equal(fs.existsSync(resource.path), true)
    owner.child.stdin.end('reconcile\n')
    const terminal = await owner.exited
    assert.deepEqual(terminal, { code: 0, signal: null, stderr: '' })
    const cleanup = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), 'cleanup.json'), 'utf8'))
    assert.equal(cleanup.result, 'RECONCILED')
    assert.equal(fs.existsSync(manifest.runLockLease.lockDirectory), false)
    assert.equal(fs.existsSync(stackLeasePath(manifest.stackRoot, manifest.taskKey, manifest.runId)), false)
    assert.deepEqual(fs.readdirSync(path.join(stateRoot, 'semaphores', 'queue')), [])
  } finally {
    if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGKILL')
  }
})

test('standalone reconciliation atomically claims and cleans one stale foreign Run', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-stale-reconcile-'))
  const owner = spawnRuntimeOwner(stateRoot, 'task_stale', 'run_stale', false)
  const manifestPath = (await owner.ready).file
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const terminal = await owner.exited
  assert.deepEqual(terminal, { code: 0, signal: null, stderr: '' })
  assert.equal(fs.existsSync(manifest.runLockLease.lockDirectory), true)
  const cleanup = reconcileRuntime({ manifestPath, cleanupResource: cleanupSimulatedResource })
  assert.equal(cleanup.result, 'RECONCILED')
  assert.equal(fs.existsSync(manifest.runLockLease.lockDirectory), false)
  assert.equal(fs.existsSync(stackLeasePath(manifest.stackRoot, manifest.taskKey, manifest.runId)), false)
  assert.deepEqual(fs.readdirSync(path.join(stateRoot, 'semaphores', 'queue')), [])
  for (const resource of manifest.resources.filter((entry) => entry.path && entry.cleanup !== 'PRESERVE_SHARED')) assert.equal(fs.existsSync(resource.path), false)
})

test('transaction recovery rejects every unsealed or noncanonical authority before any mutation', async (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-transaction-authority-'))
  const fixture = await interruptedTransactionFixture(stateRoot, 'task_authority', 'run_authority')
  const originalTransaction = fs.readFileSync(fixture.transactionPath)
  const ownerPath = path.join(fixture.transaction.runDirectory, 'run-owner.json')
  const originalOwner = fs.readFileSync(ownerPath)
  const outsideTarget = path.join(stateRoot, 'forged-target.json')
  writeAtomic(outsideTarget, { preserve: true })
  const siblingRunRoot = path.join(fixture.transaction.stackRoot, 'runs', 'task_victim', 'run_victim')
  const siblingTarget = path.join(siblingRunRoot, 'provider', 'postgres', 'simulation', '0123456789ab.json')
  writeAtomic(siblingTarget, { bytes: 'PRESERVE', owner: 'victim' })
  const siblingAllocationTarget = path.join(path.dirname(fixture.transaction.resources[0].path), 'abcdefabcdef.json')
  writeAtomic(siblingAllocationTarget, { bytes: 'PRESERVE', owner: 'sibling-allocation' })
  const seal = (value) => { value.transactionFingerprint = fingerprint(value, 'transactionFingerprint'); writeAtomic(fixture.transactionPath, value) }
  const cases = [
    ['noncanonical filename', () => { const source = path.join(fixture.transaction.runDirectory, 'forged-transaction.json'); fs.writeFileSync(source, originalTransaction); return source }],
    ['wrong kind', () => { const value = JSON.parse(originalTransaction); value.kind = 'NOT_A_RUNTIME_TRANSACTION'; seal(value); return fixture.transactionPath }],
    ['wrong schema', () => { const value = JSON.parse(originalTransaction); value.schemaVersion = 2; seal(value); return fixture.transactionPath }],
    ['wrong transaction fingerprint', () => { const value = JSON.parse(originalTransaction); value.transactionFingerprint = '0'.repeat(64); writeAtomic(fixture.transactionPath, value); return fixture.transactionPath }],
    ['mismatched Stack root', () => { const value = JSON.parse(originalTransaction); value.stackRoot = path.join(stateRoot, 'stacks', 'foreign-stack'); seal(value); return fixture.transactionPath }],
    ['mismatched Run root', () => { const value = JSON.parse(originalTransaction); value.runDirectory = path.dirname(value.runDirectory); seal(value); return fixture.transactionPath }],
    ['corrupt Run owner marker', () => { const marker = JSON.parse(originalOwner); marker.taskKey = 'foreign_task'; marker.markerFingerprint = fingerprint(marker, 'markerFingerprint'); writeAtomic(ownerPath, marker); return fixture.transactionPath }],
    ['resource outside exact Stack', () => { const value = JSON.parse(originalTransaction); value.resources[0].path = outsideTarget; value.resources[0].objectId = sha256(outsideTarget); seal(value); return fixture.transactionPath }],
    ['resource inside sibling Run', () => { const value = JSON.parse(originalTransaction); const logical = value.resources.find((resource) => resource.kind === 'simulated-logical'); logical.path = siblingTarget; logical.objectId = sha256(siblingTarget); seal(value); return fixture.transactionPath }],
    ['resource uses sibling logical allocation', () => { const value = JSON.parse(originalTransaction); const logical = value.resources.find((resource) => resource.kind === 'simulated-logical'); logical.path = siblingAllocationTarget; logical.objectId = sha256(siblingAllocationTarget); seal(value); return fixture.transactionPath }]
  ]
  for (const [name, prepare] of cases) await t.test(name, () => {
    fs.writeFileSync(fixture.transactionPath, originalTransaction)
    fs.writeFileSync(ownerPath, originalOwner)
    const noncanonical = path.join(fixture.transaction.runDirectory, 'forged-transaction.json')
    fs.rmSync(noncanonical, { force: true })
    const source = prepare()
    const before = snapshotTree(stateRoot)
    let cleanupCalls = 0
    assert.throws(() => reconcileRuntime({ transactionPath: source, cleanupResource: (resource) => { cleanupCalls += 1; return cleanupSimulatedResource(resource) } }), /RUNTIME_/u)
    assert.equal(cleanupCalls, 0)
    assert.deepEqual(snapshotTree(stateRoot), before)
    assert.equal(fs.existsSync(outsideTarget), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(siblingTarget, 'utf8')), { bytes: 'PRESERVE', owner: 'victim' })
    assert.deepEqual(JSON.parse(fs.readFileSync(siblingAllocationTarget, 'utf8')), { bytes: 'PRESERVE', owner: 'sibling-allocation' })
  })
  fs.rmSync(path.join(fixture.transaction.runDirectory, 'forged-transaction.json'), { force: true })
  fs.rmSync(siblingAllocationTarget)
  fs.writeFileSync(fixture.transactionPath, originalTransaction)
  fs.writeFileSync(ownerPath, originalOwner)
  const cleanup = reconcileRuntime({ transactionPath: fixture.transactionPath, cleanupResource: cleanupSimulatedResource })
  assert.equal(cleanup.result, 'RECONCILED')
  assert.equal(fs.existsSync(fixture.transaction.runLockLease.lockDirectory), false)
  fs.rmSync(outsideTarget)
  fs.rmSync(siblingRunRoot, { recursive: true, force: true })
})

test('transaction recovery rejects cross-Run database and bucket identities before cleanup', async (t) => {
  const cases = [
    { provider: 'postgres', owner: 'permission-service', capability: 'database', fields: ['database', 'migrator', 'runtime'] },
    { provider: 'minio', owner: 'asset-service', capability: 'object-store', fields: ['bucket', 'accessKey', 'policy'] }
  ]
  for (const selected of cases) await t.test(selected.provider, async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `oes-runtime-logical-${selected.provider}-`))
    const fixture = await interruptedLogicalTransactionFixture(stateRoot, 'LOCAL_INTEGRATION', selected.provider, selected.owner, selected.capability, `task_${selected.provider}`, `run_${selected.provider}`)
    const original = fs.readFileSync(fixture.transactionPath)
    const value = JSON.parse(original)
    const logical = value.resources.find((resource) => resource.provider === selected.provider && resource.owner === selected.owner)
    const victim = logicalResourceIdentity({ ...value, taskKey: 'task_victim', runId: 'run_victim' }, selected.provider, selected.owner)
    for (const field of selected.fields) logical[field] = victim[field]
    value.transactionFingerprint = fingerprint(value, 'transactionFingerprint')
    writeAtomic(fixture.transactionPath, value)
    const before = snapshotTree(stateRoot)
    let cleanupCalls = 0
    assert.throws(() => reconcileRuntime({ transactionPath: fixture.transactionPath, cleanupResource: () => { cleanupCalls += 1; return { disposition: 'DELETED_EXACT', exitStatus: 0 } } }), /RUNTIME_TRANSACTION_LOGICAL_RESOURCE_IDENTITY_INVALID/u)
    assert.equal(cleanupCalls, 0)
    assert.deepEqual(snapshotTree(stateRoot), before)

    fs.writeFileSync(fixture.transactionPath, original)
    const duplicate = JSON.parse(original)
    const duplicateLogical = duplicate.resources.find((resource) => resource.provider === selected.provider && resource.owner === selected.owner)
    duplicate.resources.push({ ...duplicateLogical, duplicateProbe: true })
    duplicate.transactionFingerprint = fingerprint(duplicate, 'transactionFingerprint')
    writeAtomic(fixture.transactionPath, duplicate)
    cleanupCalls = 0
    assert.throws(() => reconcileRuntime({ transactionPath: fixture.transactionPath, cleanupResource: () => { cleanupCalls += 1; return { disposition: 'DELETED_EXACT', exitStatus: 0 } } }), /RUNTIME_TRANSACTION_LOGICAL_RESOURCE_DUPLICATE/u)
    assert.equal(cleanupCalls, 0)

    fs.writeFileSync(fixture.transactionPath, original)
    const cleanup = reconcileRuntime({ transactionPath: fixture.transactionPath, cleanupResource: (resource) => ({ resource, disposition: resource.cleanup === 'PRESERVE_SHARED' ? 'PRESERVED_SHARED' : 'DELETED_EXACT', exitStatus: 0 }) })
    assert.equal(cleanup.result, 'RECONCILED')
  })
})

test('production-shaped Redis ACL allocation reopens for DEV, LOCAL_INTEGRATION and CI recovery', async (t) => {
  for (const profile of ['DEV', 'LOCAL_INTEGRATION', 'CI']) await t.test(profile, async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `oes-runtime-redis-${profile.toLowerCase()}-`))
    const fixture = await interruptedLogicalTransactionFixture(stateRoot, profile, 'redis', 'auth-service', 'cache', `task_redis_${profile.toLowerCase()}`, `run_redis_${profile.toLowerCase()}`)
    const logical = fixture.transaction.resources.find((resource) => resource.kind === 'acl-user')
    const expected = logicalResourceIdentity(fixture.transaction, 'redis', 'auth-service')
    assert.equal(logical.owner, 'auth-service')
    assert.equal(logical.containerScope, profile === 'DEV' ? 'SHARED' : profile === 'CI' ? 'CI' : 'RUN')
    assert.equal(logical.user, expected.user)
    assert.equal(logical.namespace, expected.namespace)
    let cleanupCalls = 0
    const cleanup = reconcileRuntime({ transactionPath: fixture.transactionPath, cleanupResource: (resource) => { cleanupCalls += 1; return { resource, disposition: resource.cleanup === 'PRESERVE_SHARED' ? 'PRESERVED_SHARED' : 'DELETED_EXACT', exitStatus: 0 } } })
    assert.equal(cleanup.result, 'RECONCILED')
    assert.equal(cleanupCalls, 2)
    assert.equal(fs.existsSync(fixture.transaction.runLockLease.lockDirectory), false)
    assert.equal(fs.existsSync(stackLeasePath(fixture.transaction.stackRoot, fixture.transaction.taskKey, fixture.transaction.runId)), false)
    assert.deepEqual(fs.readdirSync(path.join(stateRoot, 'semaphores', 'queue')), [])
  })
})

test('runtime Redis ACL grants bounded transaction completion without admin or dangerous categories', () => {
  assert.deepEqual(REDIS_RUNTIME_ACL_COMMAND_RULES, [
    '+@read', '+@write', '+ping', '+publish', '+subscribe', '+unsubscribe',
    '-@admin', '-@dangerous', '+multi', '+exec', '+discard'
  ])
})

test('transaction recovery reopens and rejects a sealed source replacement before cleanup', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-transaction-replace-'))
  const fixture = await interruptedTransactionFixture(stateRoot, 'task_replace', 'run_replace')
  const originalTransaction = fs.readFileSync(fixture.transactionPath)
  const leasePath = stackLeasePath(fixture.transaction.stackRoot, fixture.transaction.taskKey, fixture.transaction.runId)
  const leaseBytes = fs.readFileSync(leasePath)
  const fifoBefore = snapshotTree(path.join(stateRoot, 'semaphores', 'queue'))
  const resourcePath = fixture.transaction.resources[0].path
  const resourceBytes = fs.readFileSync(resourcePath)
  let cleanupCalls = 0
  const readFileSync = fs.readFileSync
  let sourceReads = 0
  fs.readFileSync = function readFileSyncWithSealedReplacement(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(fixture.transactionPath)) {
      sourceReads += 1
      if (sourceReads === 2) {
        const value = JSON.parse(readFileSync.call(fs, file, 'utf8'))
        value.replacementProbe = 'sealed-after-initial-reopen'
        value.transactionFingerprint = fingerprint(value, 'transactionFingerprint')
        writeAtomic(fixture.transactionPath, value)
      }
    }
    return readFileSync.call(fs, file, ...args)
  }
  try {
    assert.throws(() => reconcileRuntime({ transactionPath: fixture.transactionPath, cleanupResource: (resource) => { cleanupCalls += 1; return cleanupSimulatedResource(resource) } }), /RUNTIME_RECONCILE_SOURCE_CHANGED/u)
  } finally {
    fs.readFileSync = readFileSync
  }
  assert.equal(sourceReads >= 2, true)
  assert.equal(cleanupCalls, 0)
  assert.deepEqual(fs.readFileSync(leasePath), leaseBytes)
  assert.deepEqual(snapshotTree(path.join(stateRoot, 'semaphores', 'queue')), fifoBefore)
  assert.deepEqual(fs.readFileSync(resourcePath), resourceBytes)
  assert.equal(fs.existsSync(fixture.transaction.runLockLease.lockDirectory), false)
  fs.writeFileSync(fixture.transactionPath, originalTransaction)
  const cleanup = reconcileRuntime({ transactionPath: fixture.transactionPath, cleanupResource: cleanupSimulatedResource })
  assert.equal(cleanup.result, 'RECONCILED')
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

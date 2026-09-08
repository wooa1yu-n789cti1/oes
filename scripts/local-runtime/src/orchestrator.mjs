import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { acquireExclusiveLease, acquireExclusiveLeaseSync, acquireFifoSlot, releaseExclusiveLease, releaseFifoIdentity } from './locks.mjs'
import { fingerprint, readJson, redact, sha256, writeAtomic } from './canonical.mjs'
import { loadRuntimeConfig } from './config.mjs'
import { planRuntime } from './planner.mjs'
import { artifactReference, publishManifest, reopenManifest, reopenStackManifest, runDirectory, updateStackManifest } from './manifest.mjs'
import { acquireRuntimeAdmission, assertNoSymlink, resolveRuntimeLayout, runClaimLockPath } from './state-layout.mjs'
import { cleanupDockerResource, provisionDockerProvider } from './docker-driver.mjs'
import { cleanupSimulatedResource, provisionSimulatedProvider } from './simulation-driver.mjs'
import { removeStackLease, reopenStackLease, reopenStackLeases, stackLeasePath } from './stack-lease.mjs'
import { sharedResourceIdentity } from './stack-resource.mjs'

const ID = /^[a-z0-9][a-z0-9_-]{1,79}$/u

/** Validates an accountable runtime identity that is independent of repository paths. */
function exactId(value, name) {
  if (!ID.test(value || '')) throw new Error(`RUNTIME_ID_INVALID key=${name}`)
  return value
}

/** Records one secret-free exact runtime event for later evidence reopening. */
function appendEvent(directory, event) {
  const file = path.join(directory, 'events.ndjson')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.appendFileSync(file, `${JSON.stringify(redact({ at: new Date().toISOString(), ...event }))}\n`, { mode: 0o600 })
  return file
}

/** Returns value-free references for every exact active Stack lease. */
function activeLeaseReferences(context) {
  return reopenStackLeases(context.stackRoot, { stackKey: context.stackKey, devStackId: context.devStackId }).map((lease) => ({ ...artifactReference(lease.path, lease, 'OES_RUNTIME_STACK_LEASE'), lifecycle: 'ACTIVE' }))
}

/** Derives shared-provider reference count from exact Stack lease files. */
function sharedLeaseCount(context) { return activeLeaseReferences(context).length }

/** Merges shared resource truth by exact semantic identity without copying it to Runs. */
function mergedSharedResources(previous, additions) {
  const output = new Map()
  for (const [source, resources] of [['previous', previous], ['additions', additions]]) {
    const seen = new Set()
    for (const value of resources) {
      const key = sharedResourceIdentity(value)
      if (seen.has(key)) throw new Error(`STACK_SHARED_RESOURCE_DUPLICATE source=${source} identity=${key}`)
      seen.add(key)
      output.set(key, value)
    }
  }
  return [...output.values()]
}

/** Reopens, merges, and publishes shared Stack truth in one serializable transaction. */
export function publishStackState(context, resources = [], endpoints = []) {
  return updateStackManifest(context.stackRoot, (current) => {
    const previous = current || { resources: [], endpoints: [] }
    const mergedResources = mergedSharedResources(previous.resources || [], resources.filter((resource) => resource.scope === 'SHARED'))
    const endpointMap = new Map((previous.endpoints || []).map((endpoint) => [`${endpoint.pool || context.pool}:${endpoint.provider}`, endpoint]))
    for (const endpoint of endpoints) {
      const hasShared = resources.some((resource) => resource.provider === endpoint.provider && resource.scope === 'SHARED' && (resource.pool || context.pool) === (endpoint.pool || context.pool))
      if (!hasShared) continue
      const sharedEndpoint = { ...endpoint }
      if (context.profile !== 'DEV') delete sharedEndpoint.credentialReference
      endpointMap.set(`${endpoint.pool || context.pool}:${endpoint.provider}`, sharedEndpoint)
    }
    return {
      lifecycle: 'REGISTERED',
      stackKey: context.stackKey,
      devStackId: context.devStackId,
      identityKind: context.identityKind,
      pools: [...new Set(mergedResources.map((resource) => resource.pool || resource.labels?.['oes.runtime.pool']).filter(Boolean).concat(context.pool))].sort(),
      jobFingerprint: context.jobFingerprint,
      resources: mergedResources,
      endpoints: [...endpointMap.values()],
      leases: activeLeaseReferences(context),
      evidenceReferences: previous.evidenceReferences || []
    }
  })
}

/** Converts provider results into Run-owned truth plus reference-only shared bindings. */
function runTruth(context, resources, endpoints) {
  const runResources = resources.filter((resource) => resource.scope !== 'SHARED')
  const runEndpoints = endpoints.map((endpoint) => {
    const shared = resources.some((resource) => resource.provider === endpoint.provider && resource.scope === 'SHARED' && resource.pool === endpoint.pool)
    if (!shared) return { ...endpoint, source: context.profile === 'CI' ? 'CI' : 'RUN' }
    return {
      provider: endpoint.provider,
      pool: endpoint.pool,
      source: 'STACK',
      ready: endpoint.ready,
      owners: endpoint.owners,
      ...(context.profile === 'DEV' || !endpoint.credentialReference ? {} : { credentialReference: endpoint.credentialReference })
    }
  })
  return { runResources, runEndpoints }
}

/** Removes every Run-private provider, orchestration, and credential file behind its exact owner marker. */
export function cleanupRunPrivateFiles(context) {
  const expectedRunDirectory = path.resolve(runDirectory(context.stateRoot, context.stackKey, context.taskKey, context.runId))
  if (path.resolve(context.runDirectory) !== expectedRunDirectory) throw new Error('RUN_PRIVATE_DIRECTORY_IDENTITY_MISMATCH')
  const markerPath = path.join(expectedRunDirectory, 'run-owner.json')
  const marker = readJson(markerPath)
  if (marker.markerFingerprint !== fingerprint(marker, 'markerFingerprint') || marker.path !== expectedRunDirectory || marker.stackKey !== context.stackKey || marker.taskKey !== context.taskKey || marker.runId !== context.runId) throw new Error('RUN_PRIVATE_OWNER_MARKER_MISMATCH')
  const deleted = []
  const walk = (current) => {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`RUN_PRIVATE_SYMLINK_PRESERVED path=${current}`)
    if (stat.isFile()) {
      deleted.push({ path: path.relative(expectedRunDirectory, current), sha256: sha256(fs.readFileSync(current)), mode: stat.mode & 0o777 })
      return
    }
    for (const entry of fs.readdirSync(current)) walk(path.join(current, entry))
  }
  for (const name of ['provider', 'credentials', 'orchestration']) {
    const target = path.join(expectedRunDirectory, name)
    if (!fs.existsSync(target)) continue
    walk(target)
    fs.rmSync(target, { recursive: true })
    if (fs.existsSync(target)) throw new Error(`RUN_PRIVATE_DIRECTORY_REMAINS path=${target}`)
  }
  return { resource: { kind: 'run-private-files', scope: 'RUN', runDirectory: expectedRunDirectory }, disposition: deleted.length ? 'DELETED_EXACT' : 'ALREADY_ABSENT', deleted, exitStatus: 0 }
}

/** Removes an owner-only Run directory created by an allocation that failed before transaction publication. */
function removeIncompleteRunOwner(context) {
  const expectedRunDirectory = path.resolve(runDirectory(context.stateRoot, context.stackKey, context.taskKey, context.runId))
  if (path.resolve(context.runDirectory) !== expectedRunDirectory) throw new Error('RUN_INCOMPLETE_DIRECTORY_IDENTITY_MISMATCH')
  const markerPath = path.join(expectedRunDirectory, 'run-owner.json')
  const marker = readJson(markerPath)
  if (marker.markerFingerprint !== fingerprint(marker, 'markerFingerprint') || marker.path !== expectedRunDirectory || marker.stackKey !== context.stackKey || marker.taskKey !== context.taskKey || marker.runId !== context.runId) throw new Error('RUN_INCOMPLETE_OWNER_MARKER_MISMATCH')
  const entries = fs.readdirSync(expectedRunDirectory)
  if (entries.length !== 1 || entries[0] !== 'run-owner.json') throw new Error(`RUN_INCOMPLETE_RESIDUE_PRESERVED path=${expectedRunDirectory}`)
  fs.unlinkSync(markerPath)
  fs.rmdirSync(expectedRunDirectory)
}

/** Reopens the exact marker that authorizes one canonical Run directory. */
function reopenRunOwner(value, expectedRunDirectory) {
  const markerPath = path.join(expectedRunDirectory, 'run-owner.json')
  const marker = readJson(markerPath)
  if (marker.schemaVersion !== 3 || marker.kind !== 'OES_RUNTIME_RUN_OWNER' || marker.markerFingerprint !== fingerprint(marker, 'markerFingerprint')) throw new Error('RUNTIME_RUN_OWNER_MARKER_INVALID')
  if (marker.path !== expectedRunDirectory || marker.stackKey !== value.stackKey || marker.taskKey !== value.taskKey || marker.runId !== value.runId) throw new Error('RUNTIME_RUN_OWNER_MARKER_MISMATCH')
  return marker
}

/** Requires an allocation-transaction filesystem reference to remain inside its exact Stack. */
function assertTransactionPath(value, selected, key) {
  if (typeof selected !== 'string' || !path.isAbsolute(selected) || path.resolve(selected) !== selected) throw new Error(`RUNTIME_TRANSACTION_PATH_INVALID key=${key}`)
  const stackRoot = path.resolve(value.stackRoot)
  if (selected !== stackRoot && !selected.startsWith(`${stackRoot}${path.sep}`)) throw new Error(`RUNTIME_TRANSACTION_PATH_OUTSIDE_STACK key=${key}`)
  assertNoSymlink(value.stateRoot, selected)
  return selected
}

/** Validates one closed-world allocation resource before a recovery adapter can observe it. */
function assertTransactionResource(value, resource) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw new Error('RUNTIME_TRANSACTION_RESOURCE_INVALID')
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(resource.provider || '') || !value.plan.providers.includes(resource.allocationProvider || resource.provider)) throw new Error('RUNTIME_TRANSACTION_RESOURCE_PROVIDER_INVALID')
  if (!['SHARED', 'RUN', 'CI'].includes(resource.scope) || resource.pool !== value.pool) throw new Error('RUNTIME_TRANSACTION_RESOURCE_SCOPE_INVALID')
  if ((value.profile === 'DEV' && resource.scope !== 'SHARED') || (value.profile === 'CI' && resource.scope !== 'CI')) throw new Error('RUNTIME_TRANSACTION_RESOURCE_PROFILE_SCOPE_INVALID')
  const cleanupByKind = {
    container: resource.scope === 'SHARED' ? 'PRESERVE_SHARED' : 'DELETE_EXACT',
    network: resource.scope === 'SHARED' ? 'PRESERVE_SHARED' : 'DELETE_EXACT',
    database: resource.scope === 'SHARED' ? 'PRESERVE_SHARED' : 'DROP_EXACT',
    bucket: resource.scope === 'SHARED' ? 'PRESERVE_SHARED' : 'DELETE_LOGICAL_EXACT',
    'acl-user': resource.scope === 'SHARED' ? 'PRESERVE_SHARED' : 'DELETED_WITH_OWNED_CONTAINER',
    certificate: resource.scope === 'SHARED' ? 'PRESERVE_SHARED' : 'DELETE_FILES_EXACT',
    'simulated-provider': resource.scope === 'SHARED' ? 'PRESERVE_SHARED' : 'DELETE_EXACT',
    'simulated-logical': resource.scope === 'SHARED' ? 'PRESERVE_SHARED' : 'DELETE_EXACT'
  }
  if (!cleanupByKind[resource.kind] || resource.cleanup !== cleanupByKind[resource.kind]) throw new Error('RUNTIME_TRANSACTION_RESOURCE_CLEANUP_INVALID')
  if (resource.path) assertTransactionPath(value, resource.path, 'resource.path')
  for (const key of ['marker', 'ca', 'cert', 'key']) if (resource[key]) assertTransactionPath(value, resource[key], key)
  for (const referenceKey of ['rootCredentialReference', 'adminCredentialReference']) {
    const reference = resource[referenceKey]
    if (reference && (!/^[a-f0-9]{64}$/u.test(reference.sha256 || '') || assertTransactionPath(value, reference.path, `${referenceKey}.path`) !== reference.path)) throw new Error(`RUNTIME_TRANSACTION_RESOURCE_REFERENCE_INVALID key=${referenceKey}`)
  }
  if (resource.files) {
    if (resource.kind !== 'certificate' || resource.files.length !== 4 || resource.files.some((file) => !/^[a-f0-9]{64}$/u.test(file.sha256 || '') || assertTransactionPath(value, file.path, 'files.path') !== file.path)) throw new Error('RUNTIME_TRANSACTION_RESOURCE_FILES_INVALID')
  }
  if (['simulated-provider', 'simulated-logical'].includes(resource.kind) && (!resource.path || !/^[a-f0-9]{64}$/u.test(resource.objectId || ''))) throw new Error('RUNTIME_TRANSACTION_SIMULATION_RESOURCE_INVALID')
  if (['container', 'network'].includes(resource.kind)) {
    if (typeof resource.name !== 'string' || typeof resource.objectId !== 'string' || !resource.labels || typeof resource.labels !== 'object') throw new Error('RUNTIME_TRANSACTION_DOCKER_RESOURCE_INVALID')
    const expectedLabels = { 'oes.runtime.version': '2', 'oes.runtime.stack-key': value.stackKey, 'oes.runtime.dev-stack-id': value.devStackId, 'oes.runtime.scope': resource.scope, 'oes.runtime.pool': value.pool, 'oes.runtime.provider': resource.provider }
    if (['RUN', 'CI'].includes(resource.scope)) Object.assign(expectedLabels, { 'oes.runtime.task-key': value.taskKey, 'oes.runtime.run-id': value.runId })
    for (const [key, expected] of Object.entries(expectedLabels)) if (resource.labels[key] !== expected) throw new Error(`RUNTIME_TRANSACTION_RESOURCE_LABEL_INVALID key=${key}`)
  }
  if (resource.kind === 'database' && (![resource.database, resource.migrator, resource.runtime, resource.containerName, resource.containerObjectId].every((entry) => typeof entry === 'string') || !resource.rootCredentialReference)) throw new Error('RUNTIME_TRANSACTION_DATABASE_RESOURCE_INVALID')
  if (resource.kind === 'bucket' && (![resource.bucket, resource.accessKey, resource.policy, resource.containerName, resource.containerObjectId].every((entry) => typeof entry === 'string') || !resource.adminCredentialReference)) throw new Error('RUNTIME_TRANSACTION_BUCKET_RESOURCE_INVALID')
  if (resource.kind === 'acl-user' && ![resource.user, resource.namespace, resource.containerName, resource.containerObjectId].every((entry) => typeof entry === 'string')) throw new Error('RUNTIME_TRANSACTION_ACL_RESOURCE_INVALID')
}

/** Seals and atomically writes mutable allocation progress after every state change. */
function publishAllocationTransaction(file, transaction) {
  transaction.transactionFingerprint = fingerprint(transaction, 'transactionFingerprint')
  writeAtomic(file, transaction)
  return transaction
}

/** Reopens one sealed allocation transaction only from its canonical Run authority path. */
function reopenAllocationTransaction(file) {
  const absolute = path.resolve(file)
  const value = readJson(absolute)
  if (value.schemaVersion !== 3 || value.kind !== 'OES_RUNTIME_ALLOCATION_TRANSACTION' || !['ALLOCATING', 'RECONCILING_AFTER_FAILURE'].includes(value.lifecycle) || value.transactionFingerprint !== fingerprint(value, 'transactionFingerprint')) throw new Error(`RUNTIME_TRANSACTION_FINGERPRINT_MISMATCH path=${absolute}`)
  if (!path.isAbsolute(value.stateRoot || '') || path.resolve(value.stateRoot) !== value.stateRoot || !path.isAbsolute(value.stackRoot || '') || path.resolve(value.stackRoot) !== value.stackRoot) throw new Error('RUNTIME_TRANSACTION_ROOT_INVALID')
  const expectedPool = value.profile === 'DEV' ? 'dev' : value.profile === 'CI' ? 'ci' : value.profile === 'LOCAL_INTEGRATION' ? 'test' : null
  if (!expectedPool || value.pool !== expectedPool) throw new Error('RUNTIME_TRANSACTION_PROFILE_POOL_INVALID')
  exactId(value.devStackId, 'devStackId')
  const expectedRunDirectory = runDirectory(value.stateRoot, value.stackKey, value.taskKey, value.runId)
  const expectedStackRoot = path.dirname(path.dirname(path.dirname(expectedRunDirectory)))
  if (value.stackRoot !== expectedStackRoot || value.runDirectory !== expectedRunDirectory || absolute !== path.join(expectedRunDirectory, 'transaction.json')) throw new Error('RUNTIME_TRANSACTION_DIRECTORY_MISMATCH')
  assertNoSymlink(value.stateRoot, absolute)
  reopenRunOwner(value, expectedRunDirectory)
  const stack = readJson(path.join(expectedStackRoot, 'stack.json'))
  if (stack.schemaVersion !== 3 || stack.kind !== 'OES_RUNTIME_STACK' || stack.stackFingerprint !== fingerprint(stack, 'stackFingerprint') || stack.stackKey !== value.stackKey || stack.devStackId !== value.devStackId) throw new Error('RUNTIME_TRANSACTION_STACK_MISMATCH')
  if (!value.plan || value.plan.schemaVersion !== 2 || value.plan.profile !== value.profile || value.plan.planFingerprint !== fingerprint(value.plan, 'planFingerprint') || !Array.isArray(value.plan.providers) || new Set(value.plan.providers).size !== value.plan.providers.length || value.plan.providers.some((provider) => !/^[a-z0-9][a-z0-9-]*$/u.test(provider)) || !Array.isArray(value.plan.owners) || !Array.isArray(value.plan.capabilities) || !value.plan.providerOwners || typeof value.plan.providerOwners !== 'object' || Array.isArray(value.plan.providerOwners)) throw new Error('RUNTIME_TRANSACTION_PLAN_INVALID')
  if (fingerprint(value.owners) !== fingerprint(value.plan.owners) || fingerprint(value.capabilities) !== fingerprint(value.plan.capabilities) || fingerprint(value.providerOwners) !== fingerprint(value.plan.providerOwners)) throw new Error('RUNTIME_TRANSACTION_PLAN_CONTEXT_MISMATCH')
  if (!Array.isArray(value.resources) || !Array.isArray(value.endpoints)) throw new Error('RUNTIME_TRANSACTION_PROGRESS_INVALID')
  const claimPath = runClaimLockPath(value.stateRoot, value.stackKey, value.taskKey, value.runId)
  const claimOwner = value.runLockLease?.owner
  if (value.runLockLease?.lockDirectory !== claimPath || !claimOwner || claimOwner.kind !== 'RUN' || claimOwner.stackKey !== value.stackKey || claimOwner.devStackId !== value.devStackId || claimOwner.taskKey !== value.taskKey || claimOwner.runId !== value.runId || !Number.isInteger(claimOwner.pid) || typeof claimOwner.leaseId !== 'string') throw new Error('RUNTIME_TRANSACTION_RUN_CLAIM_INVALID')
  if (value.profile === 'DEV') {
    const devOwner = value.devLockLease?.owner
    const devPath = path.join(value.stateRoot, 'locks', 'stacks', `${value.stackKey}.lock`)
    if (value.devLockLease?.lockDirectory !== devPath || !devOwner || devOwner.kind !== 'DEV_STACK' || devOwner.stackKey !== value.stackKey || devOwner.devStackId !== value.devStackId || devOwner.taskKey !== value.taskKey || devOwner.runId !== value.runId || !Number.isInteger(devOwner.pid) || typeof devOwner.leaseId !== 'string') throw new Error('RUNTIME_TRANSACTION_DEV_CLAIM_INVALID')
  } else if (value.devLockLease !== null) throw new Error('RUNTIME_TRANSACTION_DEV_CLAIM_UNEXPECTED')
  const leasePath = stackLeasePath(value.stackRoot, value.taskKey, value.runId)
  if (fs.existsSync(leasePath)) reopenStackLease(leasePath, { stackRoot: value.stackRoot, stackKey: value.stackKey, devStackId: value.devStackId, taskKey: value.taskKey, runId: value.runId })
  const resourceFingerprints = new Set()
  for (const resource of value.resources) {
    assertTransactionResource(value, resource)
    const resourceFingerprint = fingerprint(resource)
    if (resourceFingerprints.has(resourceFingerprint)) throw new Error('RUNTIME_TRANSACTION_RESOURCE_DUPLICATE')
    resourceFingerprints.add(resourceFingerprint)
  }
  for (const endpoint of value.endpoints) {
    if (!endpoint || typeof endpoint !== 'object' || !/^[a-z0-9][a-z0-9-]*$/u.test(endpoint.provider || '') || !value.plan.providers.includes(endpoint.allocationProvider || endpoint.provider) || endpoint.pool !== value.pool || !Array.isArray(endpoint.owners) || typeof endpoint.ready !== 'boolean' || typeof endpoint.authority !== 'string') throw new Error('RUNTIME_TRANSACTION_ENDPOINT_INVALID')
    if (endpoint.credentialReference) {
      if (!/^[a-f0-9]{64}$/u.test(endpoint.credentialReference.sha256 || '') || !/^[a-f0-9]{64}$/u.test(endpoint.credentialReference.fingerprint || '')) throw new Error('RUNTIME_TRANSACTION_ENDPOINT_REFERENCE_INVALID')
      assertTransactionPath(value, endpoint.credentialReference.path, 'endpoint.credentialReference.path')
    }
  }
  return value
}

/** Reopens and validates the exact machine-global Run claim recorded by one Run source. */
function reopenRunClaim(value) {
  const lockDirectory = runClaimLockPath(value.stateRoot, value.stackKey, value.taskKey, value.runId)
  const ownerPath = path.join(lockDirectory, 'owner.json')
  if (!fs.existsSync(ownerPath)) return { lockDirectory, owner: null, live: false }
  const owner = readJson(ownerPath)
  const identity = { kind: 'RUN', stackKey: value.stackKey, devStackId: value.devStackId, taskKey: value.taskKey, runId: value.runId }
  for (const [key, expected] of Object.entries(identity)) if (owner[key] !== expected) throw new Error(`RUNTIME_RUN_CLAIM_IDENTITY_MISMATCH key=${key}`)
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.leaseId !== 'string') throw new Error('RUNTIME_RUN_CLAIM_OWNER_INVALID')
  if (value.runLockLease) {
    if (path.resolve(value.runLockLease.lockDirectory) !== path.resolve(lockDirectory)) throw new Error('RUNTIME_RUN_CLAIM_PATH_MISMATCH')
    if (fingerprint(value.runLockLease.owner) !== fingerprint(owner)) throw new Error('RUNTIME_RUN_CLAIM_OWNER_MISMATCH')
  }
  let live = true
  try { process.kill(owner.pid, 0) } catch (error) { if (error.code === 'ESRCH') live = false }
  return { lockDirectory, owner, live }
}

/** Verifies an in-process Run claim or atomically acquires a dead/absent claim for standalone recovery. */
function claimRunForReconciliation(value, releaseRunLock) {
  const observed = reopenRunClaim(value)
  if (releaseRunLock) {
    if (!observed.owner || !observed.live || observed.owner.pid !== process.pid) throw new Error(`RUNTIME_RUN_CLAIM_NOT_OWNED taskKey=${value.taskKey} runId=${value.runId}`)
    return { release: releaseRunLock }
  }
  if (observed.live) throw new Error(`RUNTIME_RUN_ACTIVE taskKey=${value.taskKey} runId=${value.runId}`)
  return acquireExclusiveLeaseSync(observed.lockDirectory, { kind: 'RUN', stackKey: value.stackKey, devStackId: value.devStackId, taskKey: value.taskKey, runId: value.runId })
}

/** Requires a Run source reopened after claim acquisition to retain the same exact identity. */
function assertReconciliationIdentity(initial, value) {
  for (const key of ['stateRoot', 'stackRoot', 'stackKey', 'devStackId', 'taskKey', 'runId']) {
    if (value[key] !== initial[key]) throw new Error(`RUNTIME_RECONCILE_IDENTITY_CHANGED key=${key}`)
  }
}

/** Starts one exact runtime allocation and publishes Stack then Run authority only after readiness. */
export async function startRuntime(intent, adapters = {}) {
  const root = path.resolve(intent.root)
  const taskKey = exactId(intent.taskKey, 'taskKey')
  const runId = exactId(intent.runId || `run_${crypto.randomUUID().replaceAll('-', '')}`, 'runId')
  const config = loadRuntimeConfig({ root, profile: intent.profile, explicit: { concurrency: intent.concurrency, logLevel: intent.logLevel }, machineConfigPath: intent.machineConfigPath, stateRoot: intent.stateRoot })
  const plan = planRuntime({ root, profile: intent.profile, testClass: intent.testClass, owners: intent.owners, capabilities: intent.capabilities })
  const admission = await acquireRuntimeAdmission(config.stateRoot, { taskKey, runId, profile: intent.profile }, { timeoutMs: intent.admissionTimeoutMs || 30000 })
  let layout
  let runLock = { lease: null, release: () => {} }
  let devLock = { lease: null, release: () => {} }
  let leasePath
  let leaseOwned = false
  let releaseSlot = () => {}
  let slotAcquired = false
  let context
  let runOwnerCreated = false
  let transactionPublished = false
  try {
    layout = await resolveRuntimeLayout({ stateRoot: config.stateRoot, profile: intent.profile, taskKey, runId, explicitDevStackId: intent.devStackId, identitySeed: intent.identitySeed, ciSeed: intent.ciSeed, hostBinding: intent.hostBinding, ciJobIdentity: intent.ciJobIdentity })
    runLock = await acquireExclusiveLease(runClaimLockPath(config.stateRoot, layout.stackKey, taskKey, runId), { kind: 'RUN', stackKey: layout.stackKey, devStackId: layout.devStackId, taskKey, runId }, { timeoutMs: intent.runLockTimeoutMs || 30000 })
    devLock = intent.profile === 'DEV'
      ? await acquireExclusiveLease(path.join(config.stateRoot, 'locks', 'stacks', `${layout.stackKey}.lock`), { kind: 'DEV_STACK', stackKey: layout.stackKey, devStackId: layout.devStackId, taskKey, runId }, { timeoutMs: intent.devLockTimeoutMs || 30000 })
      : devLock
    const directory = layout.runRoot
    leasePath = stackLeasePath(layout.stackRoot, taskKey, runId)
    if (fs.existsSync(leasePath)) throw new Error(`STACK_LEASE_ALREADY_EXISTS path=${leasePath}`)
    if (['manifest.json', 'transaction.json', 'failed-cleanup.json', 'cleanup.json'].some((name) => fs.existsSync(path.join(directory, name)))) throw new Error(`RUNTIME_RUN_ALREADY_REGISTERED taskKey=${taskKey} runId=${runId}`)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const markerRaw = { schemaVersion: 3, kind: 'OES_RUNTIME_RUN_OWNER', path: directory, stackKey: layout.stackKey, taskKey, runId }
    writeAtomic(path.join(directory, 'run-owner.json'), { ...markerRaw, markerFingerprint: fingerprint(markerRaw) })
    runOwnerCreated = true
    const pool = intent.profile === 'DEV' ? 'dev' : intent.profile === 'CI' ? 'ci' : 'test'
    context = { root, stateRoot: config.stateRoot, stackRoot: layout.stackRoot, runDirectory: directory, profile: intent.profile, pool, taskKey, runId, stackKey: layout.stackKey, devStackId: layout.devStackId, identityKind: layout.identityKind, jobFingerprint: layout.jobFingerprint, jobIdentity: layout.jobIdentity, owners: plan.owners, capabilities: plan.capabilities, providerOwners: plan.providerOwners }
    if (plan.realInfrastructure) {
      releaseSlot = await acquireFifoSlot(config.stateRoot, config.concurrency, { stackKey: layout.stackKey, taskKey, runId, runDirectory: directory })
      slotAcquired = true
    }
    const leaseRaw = { schemaVersion: 3, kind: 'OES_RUNTIME_STACK_LEASE', stackKey: layout.stackKey, devStackId: layout.devStackId, taskKey, runId, profile: intent.profile, planFingerprint: plan.planFingerprint, pid: process.pid, createdAt: new Date().toISOString() }
    writeAtomic(leasePath, { ...leaseRaw, leaseFingerprint: fingerprint(leaseRaw) })
    leaseOwned = true
    const transaction = { schemaVersion: 3, kind: 'OES_RUNTIME_ALLOCATION_TRANSACTION', lifecycle: 'ALLOCATING', ...context, plan, config: redact(config), runLockLease: runLock.lease, devLockLease: devLock.lease, resources: [], endpoints: [] }
    const transactionPath = path.join(directory, 'transaction.json')
    publishAllocationTransaction(transactionPath, transaction)
    transactionPublished = true
    appendEvent(directory, { event: 'ALLOCATION_STARTED', stackKey: layout.stackKey, taskKey, runId, profile: intent.profile, planFingerprint: plan.planFingerprint })
    admission.release()
    const provision = adapters.provisionProvider || (intent.driver === 'simulation' ? provisionSimulatedProvider : provisionDockerProvider)
    const cleanup = adapters.cleanupResource || (intent.driver === 'simulation' ? cleanupSimulatedResource : cleanupDockerResource)
    try {
      for (const provider of plan.providers) {
        const result = await provision(provider, context)
        const resources = result.resources.map((resource) => ({ ...resource, pool: resource.pool || context.pool, allocationProvider: provider }))
        const endpoints = result.endpoints.map((endpoint) => ({ ...endpoint, pool: endpoint.pool || context.pool, allocationProvider: provider }))
        transaction.resources.push(...resources)
        transaction.endpoints.push(...endpoints)
        publishAllocationTransaction(transactionPath, transaction)
        appendEvent(directory, { event: 'PROVIDER_READY', provider, resources: result.resources.map((resource) => ({ kind: resource.kind, objectId: resource.objectId, scope: resource.scope })) })
      }
      transaction.lifecycle = 'REGISTERED'
      const stackPublished = publishStackState(context, transaction.resources, transaction.endpoints)
      const { runResources, runEndpoints } = runTruth(context, transaction.resources, transaction.endpoints)
      const runDraft = {
        ...transaction,
        resources: runResources,
        endpoints: runEndpoints,
        stackManifestReference: stackPublished.reference,
        sharedLeaseCount: sharedLeaseCount(context),
        evidenceReference: { type: 'OES_RUNTIME_RUN_EVENTS', path: path.join(directory, 'events.ndjson') }
      }
      delete runDraft.transactionFingerprint
      const published = publishManifest(directory, runDraft)
      fs.rmSync(transactionPath)
      appendEvent(directory, { event: 'MANIFEST_PUBLISHED', stackGeneration: stackPublished.manifest.generation, manifestFingerprint: published.manifest.manifestFingerprint, manifestSha256: published.sha256 })
      return { ...published, releaseSlot, releaseRunLock: runLock.release, releaseDevLock: devLock.release, cleanup, context }
    } catch (primary) {
      transaction.lifecycle = 'RECONCILING_AFTER_FAILURE'
      publishAllocationTransaction(transactionPath, transaction)
      const readyProviders = new Set(transaction.endpoints.filter((endpoint) => endpoint.ready && endpoint.authority).map((endpoint) => endpoint.allocationProvider || endpoint.provider))
      const readySharedResources = transaction.resources.filter((resource) => resource.scope === 'SHARED' && readyProviders.has(resource.allocationProvider || resource.provider))
      if (readySharedResources.length) publishStackState(context, readySharedResources, transaction.endpoints.filter((endpoint) => readyProviders.has(endpoint.allocationProvider || endpoint.provider)))
      const cleanupResults = []
      for (const resource of [...transaction.resources].reverse()) cleanupResults.push(cleanup(resource, context))
      cleanupResults.push(cleanupResults.some((result) => result.exitStatus !== 0)
        ? { resource: { kind: 'run-private-files', scope: 'RUN', runDirectory: context.runDirectory }, disposition: 'PRESERVED_DEPENDENT_CLEANUP_FAILURE', exitStatus: 1 }
        : cleanupRunPrivateFiles(context))
      writeAtomic(path.join(directory, 'failed-cleanup.json'), { schemaVersion: 3, taskKey, runId, cleanupResults: redact(cleanupResults), primaryFailure: primary.message })
      if (fs.existsSync(leasePath)) removeStackLease(leasePath, { stackRoot: context.stackRoot, stackKey: context.stackKey, devStackId: context.devStackId, taskKey, runId })
      if (fs.existsSync(path.join(context.stackRoot, 'current-manifest.json'))) publishStackState(context)
      releaseSlot()
      throw primary
    }
  } catch (error) {
    admission.release()
    const cleanupErrors = []
    if (leaseOwned && leasePath && fs.existsSync(leasePath)) {
      try { removeStackLease(leasePath, { stackRoot: layout.stackRoot, stackKey: layout.stackKey, devStackId: layout.devStackId, taskKey, runId }) } catch (cleanupError) { cleanupErrors.push(cleanupError) }
    }
    if (slotAcquired) {
      try { releaseSlot(); releaseFifoIdentity(config.stateRoot, taskKey, runId) } catch (cleanupError) { cleanupErrors.push(cleanupError) }
    }
    if (runOwnerCreated && !transactionPublished && context) {
      try { removeIncompleteRunOwner(context) } catch (cleanupError) { cleanupErrors.push(cleanupError) }
    }
    devLock.release()
    runLock.release()
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'RUNTIME_START_AND_PARTIAL_CLEANUP_FAILED')
    throw error
  }
}

/** Reconciles a registered or interrupted Run using only exact Run/Stack manifest truth. */
export function reconcileRuntime({ manifestPath, transactionPath, cleanupResource, releaseSlot = () => {}, releaseRunLock, releaseDevLock }) {
  if (Boolean(manifestPath) === Boolean(transactionPath)) throw new Error('RUNTIME_RECONCILE_EXACTLY_ONE_SOURCE_REQUIRED')
  const source = manifestPath || transactionPath
  if (!fs.existsSync(source)) throw new Error(`RUNTIME_RECONCILE_SOURCE_MISSING path=${source}`)
  const reopenSource = manifestPath ? reopenManifest : reopenAllocationTransaction
  const initial = reopenSource(source)
  const runClaim = claimRunForReconciliation(initial, releaseRunLock)
  try {
    const value = reopenSource(source)
    assertReconciliationIdentity(initial, value)
    if ((initial.manifestFingerprint || initial.transactionFingerprint) !== (value.manifestFingerprint || value.transactionFingerprint)) throw new Error('RUNTIME_RECONCILE_SOURCE_CHANGED')
    const directory = path.dirname(source)
    const context = { root: value.root, stateRoot: value.stateRoot, stackRoot: value.stackRoot, runDirectory: directory, profile: value.profile, pool: value.pool, taskKey: value.taskKey, runId: value.runId, stackKey: value.stackKey, devStackId: value.devStackId, identityKind: value.identityKind, jobFingerprint: value.jobFingerprint, jobIdentity: value.jobIdentity, owners: value.owners || value.plan.owners, capabilities: value.capabilities || value.plan.capabilities, providerOwners: value.providerOwners || value.plan.providerOwners }
    const cleanup = cleanupResource || cleanupDockerResource
    const cleanupResults = []
    for (const resource of [...value.resources].reverse()) cleanupResults.push(cleanup(resource, context))
    cleanupResults.push(cleanupResults.some((result) => result.exitStatus !== 0)
      ? { resource: { kind: 'run-private-files', scope: 'RUN', runDirectory: directory }, disposition: 'PRESERVED_DEPENDENT_CLEANUP_FAILURE', exitStatus: 1 }
      : cleanupRunPrivateFiles(context))
    const failures = cleanupResults.filter((result) => result.exitStatus !== 0)
    const leasePath = stackLeasePath(value.stackRoot, value.taskKey, value.runId)
    if (fs.existsSync(leasePath)) removeStackLease(leasePath, { stackRoot: value.stackRoot, stackKey: value.stackKey, devStackId: value.devStackId, taskKey: value.taskKey, runId: value.runId })
    releaseSlot()
    releaseFifoIdentity(value.stateRoot, value.taskKey, value.runId)
    if (releaseDevLock) releaseDevLock()
    else if (value.devLockLease) releaseExclusiveLease(value.devLockLease)
    const record = { schemaVersion: 3, kind: 'OES_RUNTIME_RUN_CLEANUP', stackKey: value.stackKey, taskKey: value.taskKey, runId: value.runId, sourceFingerprint: value.manifestFingerprint || fingerprint(value), cleanupResults: redact(cleanupResults), sharedLeaseCount: sharedLeaseCount(context), result: failures.length ? 'PRESERVED_WITH_FINDINGS' : 'RECONCILED' }
    record.recordFingerprint = fingerprint(record)
    writeAtomic(path.join(directory, 'cleanup.json'), record)
    appendEvent(directory, { event: 'RUN_RECONCILED', result: record.result, sharedLeaseCount: record.sharedLeaseCount })
    if (value.stackManifestReference) {
      const stack = reopenStackManifest(value.stackManifestReference, { stackKey: value.stackKey, devStackId: value.devStackId })
      publishStackState(context, stack.resources, stack.endpoints)
    }
    return record
  } finally { runClaim.release() }
}

/** Runs a callback against one Run manifest and always reconciles exact owned resources. */
export async function withRuntime(intent, callback, adapters = {}) {
  const started = await startRuntime(intent, adapters)
  let primary
  try { return await callback(started.manifest, started.file) } catch (error) { primary = error; throw error } finally {
    try { reconcileRuntime({ manifestPath: started.file, cleanupResource: started.cleanup, releaseSlot: started.releaseSlot, releaseRunLock: started.releaseRunLock, releaseDevLock: started.releaseDevLock }) } catch (cleanupError) {
      if (primary) throw new AggregateError([primary, cleanupError], 'RUNTIME_EXECUTION_AND_RECONCILIATION_FAILED')
      throw cleanupError
    }
  }
}

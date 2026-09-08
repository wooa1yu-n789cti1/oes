#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { fingerprint, writeAtomic } from './src/canonical.mjs'
import { resolveCredentialReference } from './src/credentials.mjs'
import { environmentForOwner, reopenManifest, resolveResources } from './src/manifest.mjs'
import { reconcileRuntime, startRuntime, withRuntime } from './src/orchestrator.mjs'
import { cleanupDockerResource, observeDockerResourceResidue, provisionDockerProvider } from './src/docker-driver.mjs'
import { cleanupSimulatedResource, provisionSimulatedProvider } from './src/simulation-driver.mjs'
import { stackLeasePath } from './src/stack-lease.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const IMAGES = Object.freeze({
  minioClient: 'minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3',
  natsBox: 'natsio/nats-box:0.14.5@sha256:0784ab710aefaf6ef037ed797ee7dcde613c6ad208c4dbff1945fc7c1b5b5375'
})

/** Parses A0's small explicit option surface, including pnpm's standalone separator. */
export function parseA0Options(argv) {
  const output = {}
  const allowed = new Set(['driver', 'scenario', 'batch', 'state-root', 'output'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') continue
    if (!token.startsWith('--')) throw new Error(`A0_ARGUMENT_INVALID value=${token}`)
    const [key, inline] = token.slice(2).split('=', 2)
    const following = argv[index + 1]
    if (!key || inline === '' || (inline === undefined && (!following || following.startsWith('--')))) throw new Error(`A0_OPTION_VALUE_REQUIRED option=${token}`)
    output[key] = inline ?? argv[++index]
  }
  const unknown = Object.keys(output).filter((key) => !allowed.has(key))
  if (unknown.length) throw new Error(`A0_OPTION_INVALID options=${unknown.join(',')}`)
  return output
}

/** Requires one acceptance assertion and names the exact failed invariant. */
function invariant(value, name) { if (!value) throw new Error(`A0_INVARIANT_FAILED name=${name}`) }

/** Returns provider resource records without credential material. */
function resources(manifest, provider, kind) { return resolveResources(manifest, { includeStack: true }).filter((resource) => resource.provider === provider && (!kind || resource.kind === kind)) }

/** Locates one exact Run directory beneath the single matching Stack. */
function findRunDirectory(stateRoot, taskKey, runId) {
  const stacks = path.join(stateRoot, 'stacks')
  const matches = fs.existsSync(stacks) ? fs.readdirSync(stacks).map((stackKey) => path.join(stacks, stackKey, 'runs', taskKey, runId)).filter((candidate) => fs.existsSync(candidate)) : []
  if (matches.length !== 1) throw new Error(`A0_RUN_DIRECTORY_NOT_EXACT taskKey=${taskKey} runId=${runId}`)
  return matches[0]
}

/** Returns one provider's physical resource across Docker and simulation drivers. */
function physicalResource(manifest, provider) { return resources(manifest, provider).find((resource) => ['container', 'simulated-provider'].includes(resource.kind)) }

/** Reopens exact owner credentials without recording their values. */
function ownerEnvironment(manifest, owner) { return environmentForOwner(manifest, owner, resolveCredentialReference) }

/** Redacts known secret values while preserving literal provider output. */
function scrub(value, secrets) {
  let output = String(value || '')
  for (const secret of secrets.filter((entry) => entry && entry.length >= 6).sort((a, b) => b.length - a.length)) output = output.replaceAll(secret, '<redacted>')
  return output
}

/** Executes one provider probe and records a placeholder command with literal redacted output/status. */
function probe(commandLog, { name, template, executable, args, secrets = [], expect }) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 120000 })
  const record = { name, command: template, stdout: scrub(result.stdout, secrets), stderr: scrub(result.stderr, secrets), exitStatus: result.status ?? 128, signal: result.signal || null }
  record.observed = expect(record)
  invariant(record.observed, name)
  commandLog.push(record)
  return record
}

/** Returns all secret values that a provider probe must redact. */
function secretValues(...environments) {
  const values = []
  for (const environment of environments) for (const [key, value] of Object.entries(environment)) {
    if (/(?:PASSWORD|SECRET|KEY)$/u.test(key)) values.push(String(value))
    if (/_URL$/u.test(key)) { try { const parsed = new URL(value); if (parsed.password) values.push(decodeURIComponent(parsed.password)) } catch {} }
  }
  return values
}

/** Lists files beneath one path without following symlinks. */
function listFiles(root) {
  if (!fs.existsSync(root)) return []
  const output = []
  const visit = (current) => {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || stat.isFile()) { output.push(current); return }
    for (const entry of fs.readdirSync(current)) visit(path.join(current, entry))
  }
  visit(root)
  return output
}

/** Reopens every run-owned residue surface after reconciliation. */
function observeRunResidue({ stateRoot, driver, manifest }) {
  const runDirectory = manifest.runDirectory
  const privateFiles = ['provider', 'credentials', 'orchestration'].flatMap((name) => listFiles(path.join(runDirectory, name))).map((file) => path.relative(runDirectory, file))
  const leasePath = stackLeasePath(manifest.stackRoot, manifest.taskKey, manifest.runId)
  const queue = path.join(stateRoot, 'semaphores', 'queue')
  const fifoTickets = fs.existsSync(queue) ? fs.readdirSync(queue).filter((entry) => entry.endsWith('.json')).filter((entry) => {
    try { const value = JSON.parse(fs.readFileSync(path.join(queue, entry), 'utf8')); return value.taskKey === manifest.taskKey && value.runId === manifest.runId } catch { return false }
  }) : []
  const dockerObjects = []
  if (driver === 'docker') for (const [kind, args] of Object.entries({
    container: ['ps', '-aq'],
    volume: ['volume', 'ls', '-q'],
    network: ['network', 'ls', '-q']
  })) {
    const result = spawnSync('docker', [...args, '--filter', 'label=oes.runtime.version=2', '--filter', `label=oes.runtime.task-key=${manifest.taskKey}`, '--filter', `label=oes.runtime.run-id=${manifest.runId}`], { encoding: 'utf8', timeout: 30000 })
    invariant(result.status === 0, `residue-${kind}-inspection-${manifest.runId}`)
    dockerObjects.push({ kind, objectIds: result.stdout.trim().split(/\s+/u).filter(Boolean), exitStatus: result.status, stdout: result.stdout, stderr: result.stderr })
  }
  const logicalResources = manifest.resources.filter((resource) => ['RUN', 'CI'].includes(resource.scope)).map((resource) => driver === 'docker'
    ? observeDockerResourceResidue(resource)
    : { key: `${resource.provider}:${resource.kind}:${resource.objectId}`, applicable: true, present: Boolean(resource.path && fs.existsSync(resource.path)), observation: resource.path || 'NO_FILESYSTEM_SURFACE' })
  const normalCleanupPath = path.join(runDirectory, 'cleanup.json')
  const cleanupPath = fs.existsSync(normalCleanupPath) ? normalCleanupPath : path.join(runDirectory, 'failed-cleanup.json')
  const cleanup = JSON.parse(fs.readFileSync(cleanupPath, 'utf8'))
  const cleanupResult = cleanup.result || (cleanup.cleanupResults?.every((entry) => entry.exitStatus === 0) ? 'RECONCILED_AFTER_FAILURE' : 'PRESERVED_WITH_FINDINGS')
  const observation = { runId: manifest.runId, privateFiles, leasePresent: fs.existsSync(leasePath), fifoTickets, dockerObjects, logicalResources, cleanupPath, cleanupResult }
  invariant(privateFiles.length === 0, `residue-private-files-${manifest.runId}`)
  invariant(!observation.leasePresent, `residue-lease-${manifest.runId}`)
  invariant(fifoTickets.length === 0, `residue-fifo-${manifest.runId}`)
  invariant(dockerObjects.every((entry) => entry.objectIds.length === 0), `residue-docker-${manifest.runId}`)
  invariant(logicalResources.every((entry) => !entry.present), `residue-logical-${manifest.runId}`)
  invariant(['RECONCILED', 'RECONCILED_AFTER_FAILURE'].includes(cleanupResult), `residue-cleanup-record-${manifest.runId}`)
  return observation
}

/** Forces one partial allocation failure and proves exact rollback plus residue closure. */
async function rollbackDrill({ stateRoot, driver, batch }) {
  const runId = `a0_${batch}_rollback`
  const baseProvision = driver === 'docker' ? provisionDockerProvider : provisionSimulatedProvider
  const cleanupResource = driver === 'docker' ? cleanupDockerResource : cleanupSimulatedResource
  let completedProviders = 0
  let primaryFailureObserved = false
  try {
    await startRuntime({ root, profile: 'LOCAL_INTEGRATION', testClass: 'integration', owners: ['auth-service'], capabilities: ['cache', 'network-trust'], taskKey: 'local_runtime_a0', runId, stateRoot, driver }, {
      provisionProvider: async (provider, context) => {
        if (completedProviders === 1) throw new Error('A0_ROLLBACK_SENTINEL')
        const result = await baseProvision(provider, context)
        completedProviders += 1
        return result
      },
      cleanupResource
    })
  } catch (error) { primaryFailureObserved = /A0_ROLLBACK_SENTINEL/u.test(String(error)) }
  invariant(primaryFailureObserved, 'rollback-primary-failure-preserved')
  const runDirectory = findRunDirectory(stateRoot, 'local_runtime_a0', runId)
  const transactionPath = path.join(runDirectory, 'transaction.json')
  const failedCleanupPath = path.join(runDirectory, 'failed-cleanup.json')
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'))
  const failedCleanup = JSON.parse(fs.readFileSync(failedCleanupPath, 'utf8'))
  invariant(failedCleanup.cleanupResults.every((entry) => entry.exitStatus === 0), 'rollback-cleanup-exit-status')
  const manifest = { ...transaction, lifecycle: 'REGISTERED', manifestFingerprint: fingerprint({ ...transaction, lifecycle: 'REGISTERED' }) }
  const residue = observeRunResidue({ stateRoot, driver, manifest: { ...manifest, resources: transaction.resources } })
  return { runId, primaryFailureObserved, completedProviders, transactionPath, failedCleanupPath, cleanupExitStatuses: failedCleanup.cleanupResults.map((entry) => entry.exitStatus), residue, result: 'PASSED' }
}

/** Starts two local runs concurrently and retains both exact cleanup closures. */
async function startPair({ stateRoot, driver, batch, round }) {
  const base = { root, profile: 'LOCAL_INTEGRATION', testClass: 'integration', owners: ['asset-service', 'auth-service'], capabilities: ['object-store', 'cache', 'events', 'network-trust'], taskKey: 'local_runtime_a0', stateRoot, driver }
  const settled = await Promise.allSettled(['a', 'b'].map((side) => startRuntime({ ...base, runId: `a0_${batch}_${round}_${side}` })))
  const failed = settled.find((item) => item.status === 'rejected')
  if (failed) {
    for (const item of settled) if (item.status === 'fulfilled') reconcileRuntime({ manifestPath: item.value.file, cleanupResource: item.value.cleanup, releaseSlot: item.value.releaseSlot, releaseRunLock: item.value.releaseRunLock })
    throw failed.reason
  }
  return settled.map((item) => item.value)
}

/** Verifies cross-service and cross-run provider denials with real provider commands. */
function verifyDenials(a, b, commandLog) {
  const assetA = ownerEnvironment(a.manifest, 'asset-service')
  const authA = ownerEnvironment(a.manifest, 'auth-service')
  const assetB = ownerEnvironment(b.manifest, 'asset-service')
  const authB = ownerEnvironment(b.manifest, 'auth-service')
  const secrets = secretValues(assetA, authA, assetB, authB)

  invariant(!Object.keys(authA).some((key) => key.startsWith('ASSET_S3_') || key.startsWith('NATS_')), 'minimal-env-auth-no-asset-nats')
  invariant(!Object.keys(assetA).some((key) => key.startsWith('REDIS_')), 'minimal-env-asset-no-redis')

  const assetUrl = new URL(assetA.DATABASE_URL)
  const authUrl = new URL(authA.DATABASE_URL)
  const postgres = resources(a.manifest, 'postgres', 'container')[0]
  probe(commandLog, {
    name: 'postgres-cross-service-denied',
    template: ['docker', 'exec', '-e', 'PGPASSWORD=<ASSET_RUNTIME_PASSWORD>', '<SHARED_POSTGRES_ID>', 'psql', '-U', '<ASSET_RUNTIME_USER>', '-d', '<AUTH_DATABASE>', '-c', 'SELECT 1'],
    executable: 'docker',
    args: ['exec', '-e', `PGPASSWORD=${decodeURIComponent(assetUrl.password)}`, postgres.name, 'psql', '-h', '127.0.0.1', '-p', '5432', '-U', decodeURIComponent(assetUrl.username), '-d', authUrl.pathname.slice(1), '-c', 'SELECT 1'],
    secrets,
    expect: (record) => record.exitStatus !== 0 && /permission denied for database/iu.test(`${record.stdout}\n${record.stderr}`)
  })

  const minio = resources(b.manifest, 'minio', 'container')[0]
  probe(commandLog, {
    name: 'minio-cross-run-denied',
    template: ['docker', 'run', '--rm', '--network', 'container:<SHARED_MINIO_ID>', 'mc', 'ls', '<RUN_B_BUCKET>', 'using <RUN_A_CREDENTIAL>'],
    executable: 'docker',
    args: ['run', '--rm', '--network', `container:${minio.name}`, '--env', `A_KEY=${assetA.ASSET_S3_ACCESS_KEY_ID}`, '--env', `A_SECRET=${assetA.ASSET_S3_SECRET_ACCESS_KEY}`, '--env', `B_BUCKET=${assetB.ASSET_S3_BUCKET}`, '--entrypoint', 'sh', IMAGES.minioClient, '-ec', 'mc alias set -- a http://127.0.0.1:9000 "$A_KEY" "$A_SECRET" >/dev/null && mc ls "a/$B_BUCKET"'],
    secrets,
    expect: (record) => record.exitStatus !== 0 && /access denied|forbidden/iu.test(`${record.stdout}\n${record.stderr}`)
  })

  const redisB = resources(b.manifest, 'redis', 'container')[0]
  probe(commandLog, {
    name: 'redis-cross-run-denied',
    template: ['docker', 'exec', '<RUN_B_REDIS_ID>', 'redis-cli', '--user', '<RUN_A_USER>', 'GET', '<RUN_B_NAMESPACE>:probe'],
    executable: 'docker',
    args: ['exec', '-e', `REDISCLI_AUTH=${authA.REDIS_PASSWORD}`, redisB.name, 'redis-cli', '--user', authA.REDIS_USERNAME, 'GET', `${authB.OES_REDIS_NAMESPACE}:probe`],
    secrets,
    expect: (record) => /WRONGPASS|AUTH failed|NOPERM/iu.test(`${record.stdout}\n${record.stderr}`)
  })

  const natsB = resources(b.manifest, 'nats', 'container')[0]
  probe(commandLog, {
    name: 'nats-cross-run-denied',
    template: ['docker', 'run', '--rm', '--network', 'container:<RUN_B_NATS_ID>', 'nats', 'pub', '<FROZEN_ASSET_SUBJECT>', 'using <RUN_A_CREDENTIAL>'],
    executable: 'docker',
    args: ['run', '--rm', '--network', `container:${natsB.name}`, IMAGES.natsBox, 'nats', '--server', 'nats://127.0.0.1:4222', '--user', assetA.NATS_USER, '--password', assetA.NATS_PASSWORD, 'pub', 'oes.events.asset.site-media.availability.changed', '{}'],
    secrets,
    expect: (record) => record.exitStatus !== 0 && /authorization violation|authentication|authorization/iu.test(`${record.stdout}\n${record.stderr}`)
  })

  probe(commandLog, {
    name: 'mtls-cross-run-denied',
    template: ['openssl', 'verify', '-CAfile', '<RUN_B_CA>', '<RUN_A_CERT>'],
    executable: 'openssl',
    args: ['verify', '-CAfile', assetB.OES_GRPC_TLS_CA_PATH, assetA.OES_GRPC_TLS_CERT_PATH],
    secrets,
    expect: (record) => record.exitStatus !== 0 && /verification failed|unable to get local issuer/iu.test(`${record.stdout}\n${record.stderr}`)
  })
  return { minimalEnvironment: { assetKeys: Object.keys(assetA).sort(), authKeys: Object.keys(authA).sort() }, denialCount: 5 }
}

/** Asserts B remains live and authorized after A's exact reconciliation. */
function verifyRunBStillLive(b, commandLog) {
  for (const resource of b.manifest.resources.filter((entry) => entry.kind === 'container' && ['RUN', 'CI'].includes(entry.scope))) {
    const result = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', resource.objectId], { encoding: 'utf8' })
    invariant(result.status === 0 && result.stdout.trim() === 'true', `run-b-live-${resource.provider}`)
  }
  const environment = ownerEnvironment(b.manifest, 'auth-service')
  const url = new URL(environment.DATABASE_URL)
  const postgres = resources(b.manifest, 'postgres', 'container')[0]
  probe(commandLog, {
    name: 'run-b-postgres-still-authorized',
    template: ['docker', 'exec', '<SHARED_POSTGRES_ID>', 'psql', '-U', '<RUN_B_AUTH_USER>', '-d', '<RUN_B_AUTH_DATABASE>', '-c', 'SELECT 1'],
    executable: 'docker',
    args: ['exec', '-e', `PGPASSWORD=${decodeURIComponent(url.password)}`, postgres.name, 'psql', '-h', '127.0.0.1', '-p', '5432', '-U', decodeURIComponent(url.username), '-d', url.pathname.slice(1), '-c', 'SELECT 1'],
    secrets: secretValues(environment),
    expect: (record) => record.exitStatus === 0 && /\(1 row\)/u.test(record.stdout)
  })
}

/** Starts and reconciles one temporary provider smoke through the same core. */
async function providerSmoke({ capability, owner, runId, stateRoot, driver }) {
  const started = await startRuntime({ root, profile: 'LOCAL_INTEGRATION', testClass: 'contract', owners: [owner], capabilities: [capability], taskKey: 'local_runtime_a0', runId, stateRoot, driver })
  const reopened = reopenManifest(started.file, { taskKey: 'local_runtime_a0', runId })
  const cleanup = reconcileRuntime({ manifestPath: started.file, cleanupResource: started.cleanup, releaseSlot: started.releaseSlot, releaseRunLock: started.releaseRunLock })
  return { runId, manifestPath: started.file, manifestFingerprint: reopened.manifestFingerprint, providers: reopened.endpoints.map((entry) => entry.provider), cleanup }
}

/** Runs one shortcut scenario used by compatibility smoke scripts. */
async function runScenario({ scenario, stateRoot, driver, batch, output }) {
  const mapping = { events: ['events', 'asset-service'], otel: ['trace-specific', 'api-gateway'], nacos: ['nacos-specific', 'api-gateway'] }
  const selected = mapping[scenario]
  if (!selected) throw new Error(`A0_SCENARIO_UNKNOWN scenario=${scenario}`)
  const smoke = await providerSmoke({ capability: selected[0], owner: selected[1], runId: `a0_${batch}_${scenario}`, stateRoot, driver })
  const raw = { schemaVersion: 2, kind: 'OES_LOCAL_RUNTIME_A0', scenario, driver, stateRoot, smoke, exitStatus: 0 }
  const report = { ...raw, reportFingerprint: fingerprint(raw) }
  writeAtomic(output, report)
  return report
}

/** Executes the complete business-neutral A0 acceptance. */
async function runFull({ stateRoot, driver, batch, output }) {
  const commandLog = []
  const reconciled = new Set()
  const all = []
  const cleanup = (started, reason) => {
    if (!started || reconciled.has(started.file)) return null
    const record = reconcileRuntime({ manifestPath: started.file, cleanupResource: started.cleanup, releaseSlot: started.releaseSlot, releaseRunLock: started.releaseRunLock })
    reconciled.add(started.file)
    return { reason, manifestPath: started.file, record }
  }
  try {
    const [a1, b1] = await startPair({ stateRoot, driver, batch, round: 'r1' })
    all.push(a1, b1)
    const a1Manifest = reopenManifest(a1.file, { taskKey: 'local_runtime_a0', runId: a1.manifest.runId })
    const b1Manifest = reopenManifest(b1.file, { taskKey: 'local_runtime_a0', runId: b1.manifest.runId })
    for (const provider of ['postgres', 'minio']) invariant(physicalResource(a1Manifest, provider).objectId === physicalResource(b1Manifest, provider).objectId, `shared-${provider}-physical-id`)
    for (const provider of ['postgres', 'minio']) {
      const aLogical = resources(a1Manifest, provider).filter((entry) => !['container', 'simulated-provider'].includes(entry.kind)).map((entry) => entry.database || entry.bucket || entry.objectId)
      const bLogical = resources(b1Manifest, provider).filter((entry) => !['container', 'simulated-provider'].includes(entry.kind)).map((entry) => entry.database || entry.bucket || entry.objectId)
      invariant(aLogical.every((value) => !bLogical.includes(value)), `isolated-${provider}-logical-id`)
    }
    const ports = [...a1Manifest.endpoints, ...b1Manifest.endpoints].filter((entry) => !['postgres', 'minio', 'mtls'].includes(entry.provider)).map((entry) => entry.port)
    invariant(new Set(ports).size === ports.length, 'ephemeral-dynamic-port-collision')
    const permission = driver === 'docker' ? verifyDenials(a1, b1, commandLog) : { minimalEnvironment: true, denialCount: 'simulation-not-applicable' }
    const cleanupA = cleanup(a1, 'normal-run-a')
    if (driver === 'docker') verifyRunBStillLive(b1, commandLog)
    const cleanupB = cleanup(b1, 'normal-run-b-after-a-isolation-proof')

    let abnormalObserved = false
    const abnormalRunId = `a0_${batch}_abnormal`
    try {
      await withRuntime({ root, profile: 'LOCAL_INTEGRATION', testClass: 'integration', owners: ['auth-service'], capabilities: ['cache', 'network-trust'], taskKey: 'local_runtime_a0', runId: abnormalRunId, stateRoot, driver }, async () => { throw new Error('A0_ABNORMAL_SENTINEL') })
    } catch (error) { abnormalObserved = /A0_ABNORMAL_SENTINEL/u.test(String(error)) }
    invariant(abnormalObserved, 'abnormal-primary-failure-preserved')
    const abnormalRunDirectory = findRunDirectory(stateRoot, 'local_runtime_a0', abnormalRunId)
    const abnormalCleanup = JSON.parse(fs.readFileSync(path.join(abnormalRunDirectory, 'cleanup.json'), 'utf8'))
    invariant(abnormalCleanup.result === 'RECONCILED', 'abnormal-exact-cleanup')

    const nacos = await providerSmoke({ capability: 'nacos-specific', owner: 'api-gateway', runId: `a0_${batch}_nacos`, stateRoot, driver })
    const otel = await providerSmoke({ capability: 'trace-specific', owner: 'api-gateway', runId: `a0_${batch}_otel`, stateRoot, driver })

    const ciStateRoot = `${stateRoot}-ci-${batch}`
    const ci = await startRuntime({ root, profile: 'CI', testClass: 'integration', owners: ['asset-service', 'auth-service'], capabilities: ['object-store', 'cache', 'events', 'network-trust'], taskKey: 'local_runtime_a0', runId: `a0_${batch}_ci`, stateRoot: ciStateRoot, driver })
    all.push(ci)
    invariant(ci.manifest.resources.filter((entry) => entry.kind === 'container').every((entry) => entry.scope === 'CI'), 'ci-job-private-physical-scope')
    const ciCleanup = cleanup(ci, 'ci-job-private-reproduction')

    const [a2, b2] = await startPair({ stateRoot, driver, batch, round: 'r2' })
    all.push(a2, b2)
    for (const provider of ['postgres', 'minio']) {
      const initial = physicalResource(a1Manifest, provider).objectId
      invariant(physicalResource(a2.manifest, provider).objectId === initial && physicalResource(b2.manifest, provider).objectId === initial, `stable-rerun-${provider}`)
    }
    const cleanupA2 = cleanup(a2, 'stable-rerun-a')
    const cleanupB2 = cleanup(b2, 'stable-rerun-b')

    const rollback = await rollbackDrill({ stateRoot, driver, batch })
    const reconciledManifests = [
      a1Manifest,
      b1Manifest,
      reopenManifest(path.join(abnormalRunDirectory, 'manifest.json'), { taskKey: 'local_runtime_a0', runId: abnormalRunId }),
      reopenManifest(nacos.manifestPath, { taskKey: 'local_runtime_a0', runId: nacos.runId }),
      reopenManifest(otel.manifestPath, { taskKey: 'local_runtime_a0', runId: otel.runId }),
      ci.manifest,
      a2.manifest,
      b2.manifest
    ]
    const residue = reconciledManifests.map((manifest) => observeRunResidue({ stateRoot: manifest.profile === 'CI' ? ciStateRoot : stateRoot, driver, manifest }))
    const raw = {
      schemaVersion: 2,
      kind: 'OES_LOCAL_RUNTIME_A0',
      scenario: 'full',
      driver,
      stateRoot,
      batch,
      plannerInputs: { profile: 'LOCAL_INTEGRATION', testClass: 'integration', owners: ['asset-service', 'auth-service'], capabilities: ['object-store', 'cache', 'events', 'network-trust'] },
      pair: {
        round1: { a: { runId: a1Manifest.runId, manifestPath: a1.file, manifestFingerprint: a1Manifest.manifestFingerprint }, b: { runId: b1Manifest.runId, manifestPath: b1.file, manifestFingerprint: b1Manifest.manifestFingerprint }, cleanupA, cleanupB },
        round2: { a: { runId: a2.manifest.runId, manifestPath: a2.file, manifestFingerprint: a2.manifest.manifestFingerprint }, b: { runId: b2.manifest.runId, manifestPath: b2.file, manifestFingerprint: b2.manifest.manifestFingerprint }, cleanupA2, cleanupB2 }
      },
      permission,
      abnormal: { runId: abnormalRunId, cleanup: abnormalCleanup },
      temporaryProviders: { nacos, otel },
      ci: { runId: ci.manifest.runId, manifestPath: ci.file, manifestFingerprint: ci.manifest.manifestFingerprint, cleanup: ciCleanup },
      commandLog,
      residue,
      rollback,
      sharedProvidersPreserved: ['postgres', 'minio'],
      exitStatus: 0
    }
    const report = { ...raw, reportFingerprint: fingerprint(raw) }
    writeAtomic(output, report)
    return report
  } finally {
    for (const started of all.reverse()) {
      try { cleanup(started, 'failure-finalizer') } catch {}
    }
  }
}

/** Selects a shortcut or complete A0 execution and prints its exact report reference. */
async function main(argv = process.argv.slice(2)) {
  const input = parseA0Options(argv)
  const driver = input.driver || 'docker'
  if (!['docker', 'simulation'].includes(driver)) throw new Error(`A0_DRIVER_INVALID driver=${driver}`)
  const scenario = input.scenario || 'full'
  const batch = input.batch || Date.now().toString(36)
  const stateRoot = path.resolve(input['state-root'] || path.join(process.env.HOME, '.local/state/oes/runtime-v2-a0'))
  const output = path.resolve(input.output || path.join(stateRoot, `a0-${batch}-${scenario}.json`))
  const report = scenario === 'full' ? await runFull({ stateRoot, driver, batch, output }) : await runScenario({ scenario, stateRoot, driver, batch, output })
  process.stdout.write(`${JSON.stringify({ status: 'A0_PASSED', scenario, driver, output, reportFingerprint: report.reportFingerprint, exitStatus: report.exitStatus }, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error.stack || error.message || error}\n`); process.exitCode = 1 })

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import test from 'node:test'
import { sha256, writeAtomic } from '../canonical.mjs'
import { writeCredentialBundle } from '../credentials.mjs'
import { exactResourceToken, exactRunIdentity, isPublishedPortCollision, runtimeLabels } from '../docker-driver.mjs'
import { publishManifest, publishStackManifest, reopenCurrentStackManifest } from '../manifest.mjs'
import { classifyRuntimeObject, reopenOperatorAuthority } from '../operator-status.mjs'
import { cleanupRuntimeDirectory, downstreamEnvironment, endpointEnvironment, gatewayReadinessEnvironment, publishDevelopmentProcessManifest, reservePort, signerSourceHash, signerWorkDirectory } from '../process-runtime.mjs'
import { bindHumanOboPolicies, loadMachineSelectors, loadWorkloadPolicies, selectorEnvironment, trustedProcessEnvironment } from '../trusted-runtime-config.mjs'

const root = path.resolve(import.meta.dirname, '../../../..')

test('long run identities retain distinct Docker resource tokens after readable truncation', () => {
  const left = exactResourceToken('a0_candidate_precommit_01_r1_a')
  const right = exactResourceToken('a0_candidate_precommit_01_r1_b')
  assert.notEqual(left, right)
  assert.equal(left.length, 24)
  assert.equal(right.length, 24)
})

test('run resource identity includes taskKey when two accountable tasks reuse one runId', () => {
  const left = exactRunIdentity({ taskKey: 'task_alpha', runId: 'shared_run' })
  const right = exactRunIdentity({ taskKey: 'task_beta', runId: 'shared_run' })
  assert.notEqual(left, right)
  assert.notEqual(exactResourceToken(left), exactResourceToken(right))
})

test('shared-provider restart recovery only classifies explicit host-port collisions', () => {
  assert.equal(isPublishedPortCollision({ stderr: 'Bind for 127.0.0.1:43123 failed: port is already allocated' }), true)
  assert.equal(isPublishedPortCollision({ stderr: 'permission denied while opening volume' }), false)
})

test('host-process ports remain reserved until explicit child handoff', async () => {
  const reservation = await reservePort()
  const competing = net.createServer()
  await assert.rejects(new Promise((resolve, reject) => {
    competing.once('error', reject)
    competing.listen(reservation.port, '127.0.0.1', resolve)
  }), { code: 'EADDRINUSE' })
  await reservation.release()

  const rebound = net.createServer()
  await new Promise((resolve, reject) => {
    rebound.once('error', reject)
    rebound.listen(reservation.port, '127.0.0.1', resolve)
  })
  await new Promise((resolve, reject) => rebound.close((error) => error ? reject(error) : resolve()))
})

function manifestFixture(directory, owners = ['auth-service', 'api-gateway', 'permission-service']) {
  const reference = writeCredentialBundle(directory, 'mtls', Object.fromEntries(owners.map((owner) => [owner, {
    OES_GRPC_TLS_CA_PATH: path.join(directory, 'ca.pem'),
    OES_GRPC_TLS_CERT_PATH: path.join(directory, owner, 'cert.pem'),
    OES_GRPC_TLS_KEY_PATH: path.join(directory, owner, 'key.pem'),
    OES_WORKLOAD_SPIFFE_ID: `spiffe://local.oes.internal/ns/oes/sa/${owner}`
  }])))
  return { profile: 'DEV', stateRoot: directory, stackRoot: directory, runDirectory: directory, stackKey: 'oes-local-0123456789abcdef', devStackId: 'machine_fixture', pool: 'dev', taskKey: 'task_fixture', runId: 'run_fixture', owners, endpoints: [{ provider: 'mtls', owners, credentialReference: reference }] }
}

const declarations = { owners: {
  'api-gateway': { downstreams: ['auth-service', 'permission-service'] },
  'auth-service': { downstreams: ['auth-service', 'permission-service'] },
  'permission-service': { downstreams: ['auth-service'] }
} }

test('endpoint projection covers every supported dynamic URL alias without fixed ports', () => {
  assert.deepEqual(endpointEnvironment('permission-service', 43123), {
    GRPC_SERVICE_PERMISSION_URL: 'permission-service.localhost:43123',
    PERMISSION_GRPC_URL: 'permission-service.localhost:43123',
    PERMISSION_SERVICE_GRPC_URL: 'permission-service.localhost:43123',
    PERMISSION_SERVICE_HOST: 'permission-service.localhost',
    PERMISSION_SERVICE_PORT: '43123'
  })
  const projected = downstreamEnvironment('auth-service', { 'auth-service': 41001, 'permission-service': 41002, 'api-gateway': 41003 }, declarations)
  assert.equal(projected.AUTH_SERVICE_PORT, '41001')
  assert.equal(projected.GRPC_SERVICE_PERMISSION_URL, 'permission-service.localhost:41002')
  assert.equal(projected.API_GATEWAY_SERVICE_PORT, undefined)
  assert.deepEqual(gatewayReadinessEnvironment({ 'auth-service': 41001, 'permission-service': 41002 }, declarations), { GATEWAY_READINESS_TARGETS: 'auth-service=grpcs://auth-service.localhost:41001,permission-service=grpcs://permission-service.localhost:41002' })
})

test('versioned policies bind Human-OBO only to exact provisioned selector facts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-trusted-config-'))
  const selectorsPath = path.join(directory, 'selectors.json')
  const selector = (owner) => ({ inventoryEntryKey: owner, machinePrincipalId: `${owner}-principal`, machineWorkloadBindingId: `${owner}-binding`, machineWorkloadBindingVersion: '1' })
  fs.writeFileSync(selectorsPath, JSON.stringify({ selectors: ['api-gateway', 'auth-service', 'collaboration-service', 'public-entry-service'].map(selector) }))
  const selectors = loadMachineSelectors(selectorsPath)
  const { auth } = loadWorkloadPolicies(root)
  const bound = bindHumanOboPolicies(auth, selectors)
  const gateway = bound.find((entry) => entry.spiffeId.endsWith('/api-gateway'))
  assert.equal(gateway.humanObo.actorMachinePrincipalId, 'api-gateway-principal')
  assert.equal(gateway.audiences.includes('urn:oes:service:tenant-org-service'), true)
  assert.deepEqual(selectorEnvironment('auth-service', selectors), {
    AUTH_FOUNDATION_MACHINE_PRINCIPAL_ID: 'auth-service-principal',
    AUTH_FOUNDATION_MACHINE_WORKLOAD_BINDING_ID: 'auth-service-binding',
    AUTH_FOUNDATION_MACHINE_WORKLOAD_BINDING_VERSION: '1',
    AUTH_NOTIFICATION_MACHINE_PRINCIPAL_ID: 'auth-service-principal',
    AUTH_NOTIFICATION_MACHINE_WORKLOAD_BINDING_ID: 'auth-service-binding',
    AUTH_NOTIFICATION_MACHINE_WORKLOAD_BINDING_VERSION: '1'
  })
})

test('trusted process environment carries references and policies without signer key material', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-trusted-env-'))
  const manifest = manifestFixture(directory)
  const environment = trustedProcessEnvironment({ root, manifest, owner: 'auth-service', issuerPort: 45123 })
  assert.equal(environment.AUTH_EXECUTION_ISSUER, 'https://issuer.local.oes.internal:45123')
  assert.equal(environment.NODE_EXTRA_CA_CERTS, path.join(directory, 'ca.pem'))
  assert.equal(JSON.parse(environment.AUTH_EXECUTION_WORKLOAD_POLICIES).length > 0, true)
  assert.equal(Object.keys(environment).some((key) => /SIGNER|KMS|PASSWORD|SECRET/u.test(key)), false)
})

test('signer source hash and work directory are deterministic while exact cleanup rejects marker drift', () => {
  assert.match(signerSourceHash(root), /^[a-f0-9]{64}$/u)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-signer-resource-'))
  const manifest = { stateRoot: directory, taskKey: 'task_a', runId: 'run_a' }
  assert.equal(signerWorkDirectory(manifest), signerWorkDirectory(manifest))
  const work = path.join(directory, 'owned')
  fs.mkdirSync(work)
  const labels = { 'oes.runtime.version': '2', 'oes.runtime.task-key': 'task_a' }
  const marker = path.join(work, '.oes-runtime-resource.json')
  writeAtomic(marker, { schemaVersion: 2, path: work, labels })
  const resource = { marker, path: work, labels, objectId: sha256(fs.readFileSync(marker)) }
  fs.writeFileSync(path.join(work, 'child'), 'owned')
  assert.equal(cleanupRuntimeDirectory(resource).disposition, 'DELETED_EXACT')
  assert.equal(fs.existsSync(work), false)

  fs.mkdirSync(work)
  writeAtomic(marker, { schemaVersion: 2, path: work, labels })
  const drifted = { ...resource, objectId: sha256(fs.readFileSync(marker)) }
  fs.appendFileSync(marker, ' ')
  assert.throws(() => cleanupRuntimeDirectory(drifted), /MARKER_MISMATCH/u)
  assert.equal(fs.existsSync(work), true)
})

test('Auth process publication keeps signer image in Stack truth and only exact signer resources in Run truth', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-signer-publication-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const stackRoot = path.join(stateRoot, 'stacks', stackKey)
  const runRoot = path.join(stackRoot, 'runs', 'task_auth', 'run_auth')
  const baseStack = publishStackManifest(stackRoot, { lifecycle: 'REGISTERED', stackKey, devStackId: 'machine_fixture', identityKind: 'LOCAL', pools: ['dev'], resources: [], endpoints: [], leases: [], evidenceReferences: [] })
  const baseRun = publishManifest(runRoot, { lifecycle: 'REGISTERED', profile: 'DEV', stateRoot, stackRoot, runDirectory: runRoot, stackKey, devStackId: 'machine_fixture', pool: 'dev', taskKey: 'task_auth', runId: 'run_auth', owners: ['auth-service'], resources: [], endpoints: [], stackManifestReference: baseStack.reference })
  const context = baseRun.manifest
  const sharedLabels = runtimeLabels(context, 'SHARED', 'execution-token-signer')
  const runLabels = runtimeLabels(context, 'RUN', 'execution-token-signer')
  const signer = {
    resources: [
      { provider: 'execution-token-signer', pool: 'dev', scope: 'SHARED', kind: 'image', name: 'signer-image', objectId: 'signer-image-id', labels: sharedLabels },
      { provider: 'execution-token-signer', pool: 'dev', scope: 'RUN', kind: 'directory', objectId: 'signer-directory-id', labels: runLabels },
      { provider: 'execution-token-signer', pool: 'dev', scope: 'RUN', kind: 'container', name: 'signer-container', objectId: 'signer-container-id', labels: runLabels }
    ],
    endpoint: { provider: 'execution-token-signer', authority: 'unix:/tmp/signer.sock', ready: true, owners: ['auth-service'], environment: {}, credentialReference: null }
  }
  const published = publishDevelopmentProcessManifest(baseRun.file, { signer })
  assert.deepEqual(published.manifest.resources.map((resource) => resource.scope), ['RUN', 'RUN'])
  assert.equal(published.manifest.stackManifestReference.generation, '000000000002')
  assert.equal(reopenCurrentStackManifest(stackRoot).manifest.resources.some((resource) => resource.objectId === 'signer-image-id'), true)
  assert.deepEqual(Object.keys(runLabels).sort(), ['oes.runtime.dev-stack-id', 'oes.runtime.pool', 'oes.runtime.provider', 'oes.runtime.run-id', 'oes.runtime.scope', 'oes.runtime.stack-key', 'oes.runtime.task-key', 'oes.runtime.version'])
  const authority = reopenOperatorAuthority({ stackReferences: [published.manifest.stackManifestReference], runManifestPaths: [published.file], leasePaths: [] })
  assert.equal(classifyRuntimeObject({ objectId: 'signer-container-id', labels: runLabels }, authority).status, 'RUN')
})

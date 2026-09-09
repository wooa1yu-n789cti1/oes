import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { sha256, writeAtomic } from '../canonical.mjs'
import { writeCredentialBundle } from '../credentials.mjs'
import { exactResourceToken, exactRunIdentity, isPublishedPortCollision, runtimeLabels } from '../docker-driver.mjs'
import { publishManifest, publishStackManifest, reopenCurrentStackManifest } from '../manifest.mjs'
import { classifyRuntimeObject, reopenOperatorAuthority } from '../operator-status.mjs'
import { cleanupRuntimeDirectory, downstreamEnvironment, endpointEnvironment, gatewayReadinessEnvironment, inspectProtectedSignerContainer, monitorProtectedSigner, probeProtectedSigner, publishDevelopmentProcessManifest, reservePort, signerSourceHash, signerWorkDirectory, waitForProtectedSignerReadiness } from '../process-runtime.mjs'
import { bindHumanOboPolicies, loadMachineSelectors, loadWorkloadPolicies, selectorEnvironment, trustedProcessEnvironment } from '../trusted-runtime-config.mjs'
import { startUdsDockerProxy } from '../uds-docker-proxy.mjs'

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
  assert.equal(cleanupRuntimeDirectory(resource).disposition, 'ALREADY_ABSENT')

  fs.symlinkSync(path.join(directory, 'missing-owned-target'), work)
  assert.throws(() => cleanupRuntimeDirectory(resource), /DIRECTORY_RESOURCE_TYPE_MISMATCH/u)
  assert.equal(fs.lstatSync(work).isSymbolicLink(), true)
  fs.unlinkSync(work)

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

test('protected signer readiness performs and locally verifies the real ES256 protocol operation', async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicJwk = pair.publicKey.export({ format: 'jwk' })
  const methods = []
  const call = async (_socket, method, params) => {
    methods.push(method)
    if (method === 'GetActiveKey') return { kid: 'fixture-kid', publicJwk }
    const input = Buffer.from(params.signingInputBase64url, 'base64url')
    return { signatureBase64url: sign('sha256', input, { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }
  }
  const evidence = await probeProtectedSigner('/tmp/fixture.sock', 'pkcs11:fixture', { call, now: () => new Date('2026-09-09T00:00:00Z'), randomBytes: () => Buffer.alloc(32, 7) })
  assert.deepEqual(methods, ['GetActiveKey', 'SignEs256'])
  assert.equal(evidence.operation, 'GetActiveKey+SignEs256+local-verify')
  assert.match(evidence.evidenceFingerprint, /^[a-f0-9]{64}$/u)
  assert.equal(JSON.stringify(evidence).includes('pkcs11:fixture'), false)

  await assert.rejects(
    probeProtectedSigner('/tmp/fixture.sock', 'pkcs11:fixture', { call: async (_socket, method) => method === 'GetActiveKey' ? { kid: 'fixture-kid', publicJwk } : { signatureBase64url: Buffer.alloc(64).toString('base64url') } }),
    /SIGNER_FUNCTIONAL_SIGNATURE_INVALID/u
  )
})

test('protected signer readiness retries only transient transport failures within the exact boundary', async () => {
  let attempts = 0
  const result = await waitForProtectedSignerReadiness('/tmp/fixture.sock', 'pkcs11:fixture', {
    attempts: 3,
    delayMs: 0,
    probe: async () => {
      attempts += 1
      if (attempts < 3) throw new Error('SIGNER_FUNCTIONAL_PROTOCOL_UNAVAILABLE')
      return { status: 'ready' }
    }
  })
  assert.deepEqual(result, { status: 'ready' })
  assert.equal(attempts, 3)

  attempts = 0
  await assert.rejects(waitForProtectedSignerReadiness('/tmp/fixture.sock', 'pkcs11:fixture', {
    attempts: 3,
    delayMs: 0,
    probe: async () => { attempts += 1; throw new Error('SIGNER_FUNCTIONAL_SIGNATURE_INVALID') }
  }), /SIGNER_FUNCTIONAL_SIGNATURE_INVALID/u)
  assert.equal(attempts, 1)
})

test('protected signer monitor fails for proxy, container, Docker, and functional liveness loss', async () => {
  const fixture = (overrides = {}) => {
    const proxyChild = new EventEmitter()
    proxyChild.exitCode = null
    const monitor = monitorProtectedSigner({
      proxyChild,
      containerResource: { name: 'fixture', objectId: 'fixture', labels: {} },
      socketPath: '/tmp/fixture.sock',
      keyReference: 'pkcs11:fixture',
      intervalMs: 60_000,
      inspect: () => ({}),
      probe: async () => ({}),
      ...overrides
    })
    return { proxyChild, monitor }
  }

  const proxy = fixture()
  proxy.proxyChild.exitCode = 19
  proxy.proxyChild.emit('exit', 19)
  await assert.rejects(proxy.monitor.failure, /SIGNER_PROXY_EXITED exit=19/u)

  for (const expected of ['SIGNER_CONTAINER_EXITED exit=137', 'SIGNER_DOCKER_UNAVAILABLE']) {
    const current = fixture({ inspect: () => { throw new Error(expected) } })
    await current.monitor.check()
    await assert.rejects(current.monitor.failure, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }

  const functional = fixture({ probe: async () => { throw new Error('SIGNER_FUNCTIONAL_PROTOCOL_UNAVAILABLE') } })
  await functional.monitor.check()
  await assert.rejects(functional.monitor.failure, /SIGNER_FUNCTIONAL_PROBE_FAILED/u)
})

test('protected signer container inspection distinguishes identity, exit, and Docker availability', () => {
  const resource = { name: 'fixture', objectId: 'container-id', labels: { owner: 'fixture' } }
  const response = (value) => () => ({ stdout: JSON.stringify([value]) })
  assert.equal(inspectProtectedSignerContainer(resource, response({ Id: 'container-id', Config: { Labels: { owner: 'fixture' } }, State: { Running: true, ExitCode: 0 } })).Id, 'container-id')
  assert.throws(() => inspectProtectedSignerContainer(resource, response({ Id: 'other', Config: { Labels: { owner: 'fixture' } }, State: { Running: true } })), /SIGNER_CONTAINER_IDENTITY_MISMATCH/u)
  assert.throws(() => inspectProtectedSignerContainer(resource, response({ Id: 'container-id', Config: { Labels: { owner: 'fixture' } }, State: { Running: false, ExitCode: 137 } })), /SIGNER_CONTAINER_EXITED exit=137/u)
  assert.throws(() => inspectProtectedSignerContainer(resource, () => { throw new Error('daemon restarting') }), /SIGNER_DOCKER_UNAVAILABLE/u)
})

test('UDS Docker proxy reuses one bridge and fails closed when that bridge exits', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-signer-proxy-'))
  const socketPath = path.join(directory, 'proxy.sock')
  const exits = []
  const failures = []
  let spawnCount = 0
  let bridge
  const spawnBridge = () => {
    spawnCount += 1
    bridge = new EventEmitter()
    bridge.exitCode = null
    bridge.stdin = new PassThrough()
    bridge.stdout = new PassThrough()
    bridge.kill = () => { bridge.exitCode = 0; bridge.emit('exit', 0) }
    let input = ''
    bridge.stdin.on('data', (chunk) => {
      input += chunk.toString('utf8')
      let newline = input.indexOf('\n')
      while (newline !== -1) {
        const request = JSON.parse(input.slice(0, newline))
        input = input.slice(newline + 1)
        bridge.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { method: request.method } })}\n`)
        newline = input.indexOf('\n')
      }
    })
    queueMicrotask(() => bridge.emit('spawn'))
    return bridge
  }
  const proxy = startUdsDockerProxy({ OES_PROXY_SOCKET_PATH: socketPath, OES_PROXY_CONTAINER_NAME: 'oes-v2-fixture-execution-signer' }, { spawnBridge, exit: (status) => exits.push(status), logFailure: (code) => failures.push(code) })
  while (!fs.existsSync(socketPath)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  const call = (id, method) => new Promise((resolvePromise, reject) => {
    const client = net.createConnection(socketPath)
    let response = ''
    client.once('error', reject)
    client.on('data', (chunk) => { response += chunk })
    client.once('end', () => resolvePromise(JSON.parse(response)))
    client.once('connect', () => client.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`))
  })
  assert.deepEqual(await Promise.all([call(1, 'GetActiveKey'), call(2, 'SignEs256')]), [
    { jsonrpc: '2.0', id: 1, result: { method: 'GetActiveKey' } },
    { jsonrpc: '2.0', id: 2, result: { method: 'SignEs256' } }
  ])
  assert.equal(spawnCount, 1)
  bridge.exitCode = 1
  bridge.emit('exit', 1)
  while (!exits.length) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  assert.deepEqual(exits, [1])
  assert.deepEqual(failures, ['UDS_DOCKER_PROXY_BRIDGE_EXITED'])
  assert.equal(fs.existsSync(socketPath), false)
  proxy.stop()
})

test('UDS Docker proxy preserves an identity-substituted socket path and fails closed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-signer-proxy-substitution-'))
  const socketPath = path.join(directory, 'proxy.sock')
  const exits = []
  const failures = []
  const bridge = new EventEmitter()
  bridge.exitCode = null
  bridge.stdin = new PassThrough()
  bridge.stdout = new PassThrough()
  bridge.kill = () => { bridge.exitCode = 0; bridge.emit('exit', 0) }
  const proxy = startUdsDockerProxy(
    { OES_PROXY_SOCKET_PATH: socketPath, OES_PROXY_CONTAINER_NAME: 'oes-v2-fixture-execution-signer' },
    {
      spawnBridge: () => { queueMicrotask(() => bridge.emit('spawn')); return bridge },
      exit: (status) => exits.push(status),
      logFailure: (code) => failures.push(code)
    }
  )
  while (!fs.existsSync(socketPath)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  fs.unlinkSync(socketPath)
  fs.writeFileSync(socketPath, 'foreign-identity')
  proxy.stop()
  while (!exits.length) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  assert.deepEqual(exits, [1])
  assert.deepEqual(failures, ['UDS_DOCKER_PROXY_SOCKET_IDENTITY_MISMATCH'])
  assert.equal(fs.readFileSync(socketPath, 'utf8'), 'foreign-identity')
  fs.rmSync(directory, { recursive: true, force: true })
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fingerprint, writeAtomic } from '../canonical.mjs'
import { writeCredentialBundle, resolveCredentialReference } from '../credentials.mjs'
import { environmentForOwner, publishManifest, publishStackManifest, reopenCurrentStackManifest, reopenManifest } from '../manifest.mjs'
import { publishStackState } from '../orchestrator.mjs'
import { reopenStackLease } from '../stack-lease.mjs'

test('manifest publication is readiness-gated, atomic and value-free', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-manifest-'))
  assert.throws(() => publishManifest(stateRoot, { lifecycle: 'ALLOCATING', endpoints: [] }), /MANIFEST_NOT_READY/)
  const stackRoot = path.join(stateRoot, 'stacks', 'oes-local-0123456789abcdef')
  const directory = path.join(stackRoot, 'runs', 'task_a', 'run_a')
  const reference = writeCredentialBundle(directory, 'postgres', { 'owner-a': { DATABASE_URL: 'postgresql://secret' } })
  const stack = publishStackManifest(stackRoot, { lifecycle: 'REGISTERED', stackKey: 'oes-local-0123456789abcdef', devStackId: 'machine_a', resources: [{ provider: 'postgres', scope: 'SHARED', kind: 'container', objectId: 'abc' }], endpoints: [{ provider: 'postgres', ready: true, authority: 'docker:abc:5432/tcp', environment: { OES_POSTGRES_PORT: '31000' } }], leases: [] })
  const published = publishManifest(directory, { lifecycle: 'REGISTERED', profile: 'LOCAL_INTEGRATION', stateRoot, stackRoot, runDirectory: directory, stackKey: 'oes-local-0123456789abcdef', devStackId: 'machine_a', taskKey: 'task_a', runId: 'run_a', owners: ['owner-a'], resources: [], stackManifestReference: stack.reference, endpoints: [{ provider: 'postgres', source: 'STACK', ready: true, owners: ['owner-a'], credentialReference: reference }] })
  assert.equal(fs.existsSync(`${published.file}.tmp`), false)
  assert.doesNotMatch(fs.readFileSync(published.file, 'utf8'), /postgresql:\/\/secret/u)
  const reopened = reopenManifest(published.file, { taskKey: 'task_a', runId: 'run_a' })
  assert.deepEqual(environmentForOwner(reopened, 'owner-a', resolveCredentialReference), { NODE_ENV: 'test', OES_TASK_KEY: 'task_a', OES_RUN_ID: 'run_a', OES_DEV_STACK_ID: 'machine_a', OES_STACK_KEY: 'oes-local-0123456789abcdef', OES_POSTGRES_PORT: '31000', DATABASE_URL: 'postgresql://secret' })
  assert.equal(reopened.resources.length, 0)
  assert.equal(reopened.endpoints[0].authority, undefined)
  assert.throws(() => environmentForOwner(reopened, 'owner-b', resolveCredentialReference), /MANIFEST_OWNER_UNDECLARED/)
})

test('concurrent Stack publishers allocate distinct immutable generations', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-manifest-concurrent-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const stackRoot = path.join(stateRoot, 'stacks', stackKey)
  const moduleUrl = new URL('../manifest.mjs', import.meta.url).href
  const script = `import { publishStackManifest } from ${JSON.stringify(moduleUrl)}; const result = publishStackManifest(${JSON.stringify(stackRoot)}, { lifecycle: 'REGISTERED', stackKey: ${JSON.stringify(stackKey)}, devStackId: 'machine_a', resources: [], endpoints: [], leases: [] }); process.stdout.write(result.manifest.generation)`
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`publisher exit=${code} stderr=${stderr}`)))
  })
  const generations = await Promise.all(Array.from({ length: 8 }, run))
  assert.equal(new Set(generations).size, 8)
  assert.deepEqual(generations.sort(), Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(12, '0')))
  for (const generation of generations) assert.equal(fs.existsSync(path.join(stackRoot, 'manifests', `${generation}.json`)), true)
})

test('concurrent same-provider Stack updates preserve both Redis ACL users and the complete active lease set', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-stack-update-concurrent-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const stackRoot = path.join(stateRoot, 'stacks', stackKey)
  publishStackManifest(stackRoot, { lifecycle: 'REGISTERED', stackKey, devStackId: 'machine_a', identityKind: 'LOCAL', pools: ['dev'], resources: [], endpoints: [], leases: [], evidenceReferences: [] })
  for (const side of ['a', 'b']) {
    const raw = { schemaVersion: 3, kind: 'OES_RUNTIME_STACK_LEASE', stackKey, devStackId: 'machine_a', taskKey: `task_${side}`, runId: `run_${side}` }
    writeAtomic(path.join(stackRoot, 'leases', `task_${side}--run_${side}.json`), { ...raw, leaseFingerprint: fingerprint(raw) })
  }
  const moduleUrl = new URL('../orchestrator.mjs', import.meta.url).href
  const run = (side) => new Promise((resolve, reject) => {
    const context = { stackRoot, stackKey, devStackId: 'machine_a', identityKind: 'LOCAL', profile: 'DEV', pool: 'dev' }
    const resource = { provider: 'redis', pool: 'dev', scope: 'SHARED', kind: 'acl-user', user: `u_${side}`, namespace: `oes:${side}`, objectId: `object_${side}` }
    const endpoint = { provider: 'redis', pool: 'dev', ready: true, authority: `fixture:${side}`, owners: [], environment: {} }
    const script = `import { publishStackState } from ${JSON.stringify(moduleUrl)}; const result = publishStackState(${JSON.stringify(context)}, [${JSON.stringify(resource)}], [${JSON.stringify(endpoint)}]); process.stdout.write(result.manifest.generation)`
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`publisher exit=${code} stderr=${stderr}`)))
  })
  const generations = await Promise.all([run('a'), run('b')])
  assert.equal(new Set(generations).size, 2)
  const current = reopenCurrentStackManifest(stackRoot).manifest
  assert.deepEqual(current.resources.map((resource) => resource.objectId).sort(), ['object_a', 'object_b'])
  assert.deepEqual(current.resources.map((resource) => resource.user).sort(), ['u_a', 'u_b'])
  assert.deepEqual(current.endpoints.map((endpoint) => endpoint.provider), ['redis'])
  assert.deepEqual(current.leases.map((lease) => lease.lifecycle), ['ACTIVE', 'ACTIVE'])
})

test('Stack publication rejects a corrupted active lease instead of referencing it', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-stack-lease-invalid-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const stackRoot = path.join(stateRoot, 'stacks', stackKey)
  const lease = { schemaVersion: 3, kind: 'OES_RUNTIME_STACK_LEASE', stackKey, devStackId: 'machine_a', taskKey: 'task_a', runId: 'run_a', leaseFingerprint: 'corrupt' }
  writeAtomic(path.join(stackRoot, 'leases', 'task_a--run_a.json'), lease)
  assert.throws(() => publishStackState({ stackRoot, stackKey, devStackId: 'machine_a', identityKind: 'LOCAL', profile: 'DEV', pool: 'dev' }), /STACK_LEASE_FINGERPRINT_MISMATCH/)
})

test('one Stack update preserves distinct Redis ACL users and rejects duplicate semantic identities', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-stack-resource-identity-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const stackRoot = path.join(stateRoot, 'stacks', stackKey)
  const context = { stackRoot, stackKey, devStackId: 'machine_a', identityKind: 'LOCAL', profile: 'DEV', pool: 'dev' }
  const acl = (user, objectId) => ({ provider: 'redis', pool: 'dev', scope: 'SHARED', kind: 'acl-user', user, namespace: `oes:${user}`, objectId })
  const published = publishStackState(context, [acl('u_alpha', 'object_a'), acl('u_beta', 'object_b')])
  assert.deepEqual(published.manifest.resources.map((resource) => resource.user), ['u_alpha', 'u_beta'])
  assert.throws(() => publishStackState(context, [acl('u_alpha', 'replacement_a'), acl('u_alpha', 'replacement_b')]), /STACK_SHARED_RESOURCE_DUPLICATE/)
})

test('exact Stack lease reopen rejects foreign identity, noncanonical path, and invalid task or run keys', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-runtime-stack-lease-semantics-'))
  const stackKey = 'oes-local-0123456789abcdef'
  const stackRoot = path.join(stateRoot, 'stacks', stackKey)
  const writeLease = (file, overrides = {}) => {
    const raw = { schemaVersion: 3, kind: 'OES_RUNTIME_STACK_LEASE', stackKey, devStackId: 'machine_a', taskKey: 'task_a', runId: 'run_a', ...overrides }
    writeAtomic(file, { ...raw, leaseFingerprint: fingerprint(raw) })
  }
  const expected = { stackRoot, stackKey, devStackId: 'machine_a' }
  const canonical = path.join(stackRoot, 'leases', 'task_a--run_a.json')
  writeLease(canonical, { devStackId: 'machine_foreign' })
  assert.throws(() => reopenStackLease(canonical, expected), /STACK_LEASE_IDENTITY_MISMATCH key=devStackId/)
  writeLease(path.join(stackRoot, 'leases', 'noncanonical.json'))
  assert.throws(() => reopenStackLease(path.join(stackRoot, 'leases', 'noncanonical.json'), expected), /STACK_LEASE_PATH_MISMATCH/)
  writeLease(path.join(stackRoot, 'leases', 'x--run_a.json'), { taskKey: 'x' })
  assert.throws(() => reopenStackLease(path.join(stackRoot, 'leases', 'x--run_a.json'), expected), /STATE_PATH_KEY_INVALID key=taskKey/)
  const outside = path.join(stateRoot, 'outside', 'task_a--run_a.json')
  writeLease(outside)
  assert.throws(() => reopenStackLease(outside, expected), /STATE_PATH_ESCAPE/)
})
